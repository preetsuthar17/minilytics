import type { Context } from 'hono';
import {
  detectAgent,
  IP_LISTS,
  ipInRanges,
  parseCidrs,
  requestKind,
  type AgentCategory,
  type AgentMatch,
  type RequestKind,
} from '../shared/agents';
import { siteOwnerActive } from './auth';
import { normalizePath } from './collect';
import { getSite, type AppEnv, type Site } from './env';
import { bucketLabels, bucketSql, previousRange } from './lib/time';
import type { Ctx } from './stats';

const MAX_BATCH = 50;
const CATEGORIES: AgentCategory[] = ['assistant', 'search', 'training', 'coding', 'agent', 'other'];

/** One request seen by the middleware on the site. */
export interface RawHit {
  url?: string;
  path?: string;
  host?: string;
  method?: string;
  ua?: string;
  ip?: string;
  accept?: string;
  status?: number;
  signature_agent?: string;
  country?: string;
  referer?: string;
  ts?: number;
}

const clip = (s: unknown, n: number): string | null => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null);

// ---------- site lookup by API key (the middleware calls on every bot request, so it's cached per isolate)

const keyCache = new Map<string, { id: string | null; at: number }>();

async function siteForKey(c: Context<AppEnv>): Promise<Site | null> {
  const key = c.req.header('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (!key || !/^ml_[\w-]{8,64}$/.test(key)) return null;
  const hit = keyCache.get(key);
  let id = hit && Date.now() - hit.at < 60_000 ? hit.id : undefined;
  if (id === undefined) {
    const row = await c.env.DB.prepare('SELECT id FROM sites WHERE api_key = ?').bind(key).first<{ id: string }>();
    id = row?.id ?? null;
    if (keyCache.size > 500) keyCache.clear();
    keyCache.set(key, { id, at: Date.now() });
  }
  if (!id) return null;
  const site = await getSite(c.env.DB, id);
  // Hosted mode: stop recording when the owner's plan has ended.
  if (!site || !siteOwnerActive(c.env, site)) return null;
  return site;
}

/**
 * POST /api/v1/agents  Authorization: Bearer <site api key>
 * Body: one request `{ url, ua, ip, accept, status, signature_agent, country }` or `{ hits: [...] }` (up to 50).
 * Requests from regular browsers are ignored, so the middleware can send anything it isn't sure about.
 */
export async function handleAgentApi(c: Context<AppEnv>) {
  const site = await siteForKey(c);
  if (!site) return c.json({ error: 'invalid api key' }, 401);
  const raw = await c.req.text();
  if (raw.length > 64_000) return c.json({ error: 'too large' }, 413);
  let body: RawHit | { hits?: RawHit[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const hits = (Array.isArray((body as { hits?: RawHit[] }).hits) ? (body as { hits: RawHit[] }).hits : [body as RawHit]).slice(0, MAX_BATCH);
  const recorded = await recordHits(c.env.DB, site, hits, 'server', Date.now());
  if (recorded) c.executionCtx.waitUntil(refreshIpListsIfStale(c.env.DB).catch(() => {}));
  return c.json({ ok: true, recorded }, 202);
}

/** Classify and store hits. Returns how many were AI/agent traffic. */
export async function recordHits(
  db: D1Database,
  site: Site,
  hits: RawHit[],
  via: 'server' | 'script',
  now: number,
  /** Used when the user agent doesn't identify the agent (an automated browser that ran the script). */
  fallback?: AgentMatch,
): Promise<number> {
  const rows: { hit: RawHit; m: AgentMatch; kind: RequestKind; path: string; host: string | null; ts: number }[] = [];
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object') continue;
    let path = clip(hit.path, 1000);
    let host = clip(hit.host, 200)?.toLowerCase().replace(/^www\./, '') ?? null;
    if (hit.url) {
      try {
        const u = new URL(hit.url);
        path = u.pathname;
        host = u.hostname.toLowerCase().replace(/^www\./, '');
      } catch {}
    }
    if (!path) continue;
    path = normalizePath(path.split('?')[0]);
    const kind = requestKind(path, hit.accept);
    const m = detectAgent({ ua: String(hit.ua ?? ''), signatureAgent: hit.signature_agent, kind }) ?? fallback;
    if (!m) continue;
    // Accept a timestamp from batched senders, but never one from the future or more than a day old.
    const ts = typeof hit.ts === 'number' && hit.ts <= now && hit.ts > now - 86_400_000 ? Math.round(hit.ts) : now;
    rows.push({ hit, m, kind, path, host, ts });
  }
  if (!rows.length) return 0;

  const stmts: D1PreparedStatement[] = [];
  for (const { hit, m, kind, path, host, ts } of rows) {
    const ip = clip(hit.ip, 64)?.split(',')[0].trim() ?? null;
    let verified: number | null = null;
    if (m.ips && ip) {
      const cidrs = await rangesFor(db, m.ips);
      if (cidrs.length) verified = ipInRanges(ip, cidrs) ? 1 : 0;
    }
    let referrerDomain: string | null = null;
    try {
      referrerDomain = hit.referer ? new URL(hit.referer).hostname.replace(/^www\./, '').toLowerCase() : null;
    } catch {}
    const status = Number.isInteger(hit.status) && hit.status! >= 100 && hit.status! < 600 ? hit.status! : null;
    const country = clip(hit.country, 2)?.toUpperCase() ?? null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO agent_hits (site_id, ts, agent, operator, category, kind, path, hostname, status, verified, signed, via, country, referrer_domain)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(site.id, ts, m.name, m.operator, m.category, kind, path, host, status, verified, m.signed ? 1 : 0, via, country === 'XX' || country === 'T1' ? null : country, referrerDomain),
    );
  }
  await db.batch(stmts);
  return stmts.length;
}

// ---------- IP verification

const rangeCache = new Map<string, { cidrs: string[]; at: number }>();
const RANGE_TTL = 3_600_000;

async function rangesFor(db: D1Database, list: string): Promise<string[]> {
  const hit = rangeCache.get(list);
  if (hit && Date.now() - hit.at < RANGE_TTL) return hit.cidrs;
  const res = await db.prepare('SELECT cidr FROM agent_ip_ranges WHERE list = ?').bind(list).all<{ cidr: string }>();
  const cidrs = res.results.map((r) => r.cidr);
  rangeCache.set(list, { cidrs, at: Date.now() });
  return cidrs;
}

let lastStaleCheck = 0;

/** Lists are refreshed by the daily cron; this also fills them on a fresh install without waiting a day. */
export async function refreshIpListsIfStale(db: D1Database, now = Date.now()) {
  if (now - lastStaleCheck < RANGE_TTL) return;
  lastStaleCheck = now;
  const row = await db
    .prepare('SELECT COUNT(*) AS n, MIN(fetched_at) AS oldest FROM agent_ip_lists')
    .first<{ n: number; oldest: number | null }>();
  if ((row?.n ?? 0) < Object.keys(IP_LISTS).length || (row?.oldest ?? 0) < now - 26 * 3_600_000) await refreshIpLists(db, now);
}

/** Download every operator's published IP ranges. A list that fails keeps its previous ranges. */
export async function refreshIpLists(db: D1Database, now = Date.now(), fetcher: typeof fetch = fetch) {
  const out: Record<string, number | string> = {};
  await Promise.all(
    Object.entries(IP_LISTS).map(async ([list, urls]) => {
      try {
        const cidrs = new Set<string>();
        for (const url of urls) {
          const res = await fetcher(url, { headers: { accept: 'application/json', 'user-agent': 'Minilytics (+https://github.com/surendrapandar/minilytics)' } });
          if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
          for (const c of parseCidrs(await res.text())) cidrs.add(c);
        }
        if (!cidrs.size) throw new Error('no ranges found');
        const all = [...cidrs];
        const stmts = [db.prepare('DELETE FROM agent_ip_ranges WHERE list = ?').bind(list)];
        // 40 rows per statement keeps us well under D1's bound-parameter limit.
        for (let i = 0; i < all.length; i += 40) {
          const chunk = all.slice(i, i + 40);
          stmts.push(
            db
              .prepare(`INSERT OR IGNORE INTO agent_ip_ranges (list, cidr) VALUES ${chunk.map(() => '(?, ?)').join(', ')}`)
              .bind(...chunk.flatMap((c) => [list, c])),
          );
        }
        stmts.push(
          db
            .prepare('INSERT OR REPLACE INTO agent_ip_lists (list, fetched_at, count, error) VALUES (?, ?, ?, NULL)')
            .bind(list, now, all.length),
        );
        await db.batch(stmts);
        rangeCache.delete(list);
        out[list] = all.length;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        await db
          .prepare(
            `INSERT INTO agent_ip_lists (list, fetched_at, count, error) VALUES (?, ?, 0, ?)
             ON CONFLICT (list) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error`,
          )
          .bind(list, now, msg)
          .run();
        out[list] = msg;
      }
    }),
  );
  return out;
}

// ---------- stats for the AI page

/** Filters that apply to agent hits (from the AI page). */
const HIT_FILTERS = ['agent', 'operator', 'category', 'kind', 'path'] as const;

export function parseHitFilters(raw: string | undefined): Partial<Record<(typeof HIT_FILTERS)[number], string>> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    const out: Partial<Record<(typeof HIT_FILTERS)[number], string>> = {};
    for (const k of HIT_FILTERS) if (typeof obj[k] === 'string') out[k] = obj[k].slice(0, 500);
    return out;
  } catch {
    return {};
  }
}

function hitsWhere(ctx: Ctx, f: ReturnType<typeof parseHitFilters>, from = ctx.range.from, to = ctx.range.to) {
  const parts = ['h.site_id = ?', 'h.ts >= ?', 'h.ts < ?'];
  const params: unknown[] = [ctx.site.id, from, to];
  for (const k of HIT_FILTERS) {
    if (f[k] === undefined) continue;
    parts.push(`h.${k === 'agent' ? 'agent' : k} = ?`);
    params.push(f[k]);
  }
  return { sql: parts.join(' AND '), params };
}

const TOTALS_SQL = (where: string) => `
  SELECT ${CATEGORIES.map((c) => `COALESCE(SUM(CASE WHEN h.category = '${c}' THEN 1 ELSE 0 END), 0) AS ${c}`).join(', ')},
         COUNT(*) AS total, COUNT(DISTINCT h.agent) AS agents,
         COALESCE(SUM(CASE WHEN h.verified = 0 THEN 1 ELSE 0 END), 0) AS spoofed,
         COUNT(DISTINCT CASE WHEN h.category = 'assistant' AND h.kind IN ('page', 'markdown') THEN h.path END) AS pages_read
  FROM agent_hits h WHERE ${where}`;

export async function aiOverview(ctx: Ctx, filters: ReturnType<typeof parseHitFilters>) {
  const { db, range, site } = ctx;
  const before = previousRange(range, site.timezone, ctx.now);
  const cur = hitsWhere(ctx, filters);
  const prev = hitsWhere(ctx, filters, before.from, before.to);
  const b = bucketSql('h.ts', range.granularity, ctx.offset);
  const [t1, t0, ts, ever, lists] = await db.batch([
    db.prepare(TOTALS_SQL(cur.sql)).bind(...cur.params),
    db.prepare(TOTALS_SQL(prev.sql)).bind(...prev.params),
    db
      .prepare(`SELECT ${b} AS b, h.category AS category, COUNT(*) AS n FROM agent_hits h WHERE ${cur.sql} GROUP BY b, h.category`)
      .bind(...cur.params),
    db.prepare('SELECT MAX(ts) AS last, SUM(CASE WHEN via = \'server\' THEN 1 ELSE 0 END) AS server FROM agent_hits WHERE site_id = ?').bind(site.id),
    db.prepare('SELECT list, fetched_at, count, error FROM agent_ip_lists ORDER BY list'),
  ]);
  const byBucket = new Map<string, Record<string, number>>();
  for (const r of ts.results as { b: string; category: string; n: number }[]) {
    const row = byBucket.get(r.b) ?? {};
    row[r.category] = r.n;
    byBucket.set(r.b, row);
  }
  const series = bucketLabels(range, ctx.offset).map((bucket) => {
    const row = byBucket.get(bucket) ?? {};
    return { bucket, ...Object.fromEntries(CATEGORIES.map((c) => [c, row[c] ?? 0])) };
  });
  const e = ever.results[0] as { last: number | null; server: number | null };
  return {
    range,
    current: t1.results[0],
    previous: t0.results[0],
    series,
    lastHit: e.last,
    serverConnected: (e.server ?? 0) > 0,
    ipLists: lists.results,
  };
}

const HIT_DIMS: Record<string, string> = {
  agent: 'h.agent',
  operator: 'h.operator',
  category: 'h.category',
  kind: 'h.kind',
  path: 'h.path',
  country: 'h.country',
  hostname: 'h.hostname',
};

export interface AiRow {
  label: string | null;
  hits: number;
  pages: number;
  agents: number;
  verified: number;
  spoofed: number;
  last: number;
  extra: string | null;
}

/**
 * Hits grouped by a dimension. `scope` narrows to one slice of the AI page:
 * answers (assistant fetches), installs (registry), docs (markdown + llms.txt).
 */
export async function aiBreakdown(ctx: Ctx, filters: ReturnType<typeof parseHitFilters>, dim: string, scope: string | undefined, limit = 100): Promise<AiRow[]> {
  const col = HIT_DIMS[dim];
  if (!col) throw new Error(`unknown dimension ${dim}`);
  const w = hitsWhere(ctx, filters);
  let scopeSql = '';
  if (scope === 'answers') scopeSql = ` AND h.category = 'assistant'`;
  else if (scope === 'crawlers') scopeSql = ` AND h.category IN ('search', 'training')`;
  else if (scope === 'crawlers_and_answers') scopeSql = ` AND h.category IN ('search', 'training', 'assistant')`;
  else if (scope === 'installs') scopeSql = ` AND h.kind = 'registry'`;
  else if (scope === 'docs') scopeSql = ` AND h.kind IN ('markdown', 'llms_txt')`;
  else if (scope === 'pages') scopeSql = ` AND h.kind IN ('page', 'markdown')`;
  // extra: the operator for agents (icon), the busiest agent for everything else.
  const extra =
    dim === 'agent'
      ? 'MAX(h.operator)'
      : dim === 'operator' || dim === 'category'
        ? 'NULL'
        : `(SELECT h2.agent FROM agent_hits h2 WHERE h2.site_id = h.site_id AND h2.ts >= ? AND h2.ts < ? AND h2.${dim} = ${col}${scopeSql.replaceAll('h.', 'h2.')}
           GROUP BY h2.agent ORDER BY COUNT(*) DESC LIMIT 1)`;
  const extraParams = extra.startsWith('(SELECT') ? [ctx.range.from, ctx.range.to] : [];
  const lim = Math.max(1, Math.min(500, limit));
  const res = await ctx.db
    .prepare(
      `SELECT ${col} AS label, COUNT(*) AS hits, COUNT(DISTINCT h.path) AS pages, COUNT(DISTINCT h.agent) AS agents,
              COALESCE(SUM(CASE WHEN h.verified = 1 THEN 1 ELSE 0 END), 0) AS verified,
              COALESCE(SUM(CASE WHEN h.verified = 0 THEN 1 ELSE 0 END), 0) AS spoofed,
              MAX(h.ts) AS last, ${extra} AS extra
       FROM agent_hits h WHERE ${w.sql}${scopeSql} GROUP BY label ORDER BY hits DESC LIMIT ${lim}`,
    )
    .bind(...extraParams, ...w.params)
    .all<AiRow>();
  return res.results;
}

/** The latest hits, newest first, for the activity feed. */
export async function aiRecent(ctx: Ctx, filters: ReturnType<typeof parseHitFilters>, limit = 50) {
  const w = hitsWhere(ctx, filters);
  const res = await ctx.db
    .prepare(
      `SELECT h.ts, h.agent, h.operator, h.category, h.kind, h.path, h.status, h.verified, h.signed, h.via, h.country
       FROM agent_hits h WHERE ${w.sql} ORDER BY h.ts DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
    )
    .bind(...w.params)
    .all();
  return res.results;
}
