import type { Context } from 'hono';
import type { AppEnv, Site } from './env';
import { bucketLabels, bucketSql, previousRange, resolveRange, tzOffset, type Range } from './lib/time';
import { currencyDecimals } from './payments';

/** Filters that live on the session row (clicking a row in the dashboard adds one of these). */
const SESSION_FILTERS = [
  'channel',
  'source',
  'referrer',
  'referrer_domain',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device',
  'entry_page',
  'exit_page',
  'hostname',
] as const;

export type Filters = Partial<Record<(typeof SESSION_FILTERS)[number] | 'page' | 'goal', string>>;

export function parseFilters(raw: string | undefined): Filters {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    const out: Filters = {};
    for (const k of [...SESSION_FILTERS, 'page', 'goal'] as const) {
      if (typeof obj[k] === 'string') out[k] = obj[k].slice(0, 500);
    }
    return out;
  } catch {
    return {};
  }
}

/** SQL + params restricting sessions `s` by the dashboard filters (not by time). */
function filterSql(f: Filters): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const k of SESSION_FILTERS) {
    const v = f[k];
    if (v === undefined) continue;
    if (v === '') parts.push(`s.${k} IS NULL`);
    else {
      parts.push(`s.${k} = ?`);
      params.push(v);
    }
  }
  if (f.page) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'pageview' AND fe.path = ?)`);
    params.push(f.page);
  }
  if (f.goal) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'goal' AND fe.name = ?)`);
    params.push(f.goal);
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

const hasFilters = (f: Filters) => Object.keys(f).length > 0;

interface Ctx {
  db: D1Database;
  site: Site;
  range: Range;
  filters: Filters;
  offset: number;
  /** When the range was resolved; a range ending here is still running. */
  now: number;
}

export function makeCtx(c: Context<AppEnv>): Ctx {
  const site = c.get('site');
  const q = c.req.query();
  const now = Date.now();
  const range = resolveRange(q, site.timezone, site.created_at, now);
  return { db: c.env.DB, site, range, filters: parseFilters(q.filters), offset: tzOffset(site.timezone, range.to), now };
}

function sessionsWhere(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  const f = filterSql(ctx.filters);
  return {
    sql: `s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

/** Payments in the period; with filters, only those credited to a matching visit. */
function paymentsFrom(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  if (!hasFilters(ctx.filters)) {
    return { sql: `payments p WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?`, params: [ctx.site.id, from, to] };
  }
  const f = filterSql(ctx.filters);
  return {
    sql: `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
          WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

const KPI_SQL = (where: string) => `
  SELECT COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, COALESCE(SUM(s.pageviews), 0) AS pageviews,
         COALESCE(SUM(CASE WHEN s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END), 0) AS bounces,
         COALESCE(AVG(s.duration), 0) AS avg_duration
  FROM sessions s WHERE ${where}`;

/**
 * Amounts are stored in minor units of their own currency, so only payments in the site currency are added up
 * (Dodo payments are stored converted to it whenever Dodo settled in it). Other currencies still count as payments.
 */
function revenueSum(site: Site, alias = 'p') {
  const currency = /^[A-Z]{3}$/.test(site.currency) ? site.currency : 'USD';
  return `SUM(CASE WHEN ${alias}.currency = '${currency}' THEN ${alias}.amount ELSE 0 END)`;
}

const REVENUE_SQL = (site: Site, from: string) => `
  SELECT COALESCE(${revenueSum(site)}, 0) AS revenue,
         COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.id) END) AS customers,
         COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END), 0) AS payments
  FROM ${from}`;

interface KpiRow {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  avg_duration: number;
}
interface RevRow {
  revenue: number;
  customers: number;
  payments: number;
}

function kpis(k: KpiRow, r: RevRow) {
  return {
    visitors: k.visitors,
    sessions: k.sessions,
    pageviews: k.pageviews,
    bounceRate: k.sessions ? k.bounces / k.sessions : 0,
    avgDuration: Math.round(k.avg_duration),
    revenue: r.revenue,
    payments: r.payments,
    customers: r.customers,
    conversionRate: k.visitors ? r.customers / k.visitors : 0,
    revenuePerVisitor: k.visitors ? r.revenue / k.visitors : 0,
  };
}

/** Top numbers + chart. */
export async function overview(ctx: Ctx) {
  const { db, range, site } = ctx;
  const before = previousRange(range, site.timezone, ctx.now);
  const cur = sessionsWhere(ctx);
  const prev = sessionsWhere(ctx, before.from, before.to);
  const curPay = paymentsFrom(ctx);
  const prevPay = paymentsFrom(ctx, before.from, before.to);
  const sb = bucketSql('s.started_at', range.granularity, ctx.offset);
  const pb = bucketSql('p.ts', range.granularity, ctx.offset);
  const now = ctx.now;

  const [k1, k0, r1, r0, online, ts, tr] = await db.batch([
    db.prepare(KPI_SQL(cur.sql)).bind(...cur.params),
    db.prepare(KPI_SQL(prev.sql)).bind(...prev.params),
    db.prepare(REVENUE_SQL(site, curPay.sql)).bind(...curPay.params),
    db.prepare(REVENUE_SQL(site, prevPay.sql)).bind(...prevPay.params),
    db
      .prepare('SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE site_id = ? AND started_at > ? AND last_seen_at > ?')
      .bind(site.id, now - 6 * 3_600_000, now - 5 * 60_000),
    db
      .prepare(
        `SELECT ${sb} AS b, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews
         FROM sessions s WHERE ${cur.sql} GROUP BY b`,
      )
      .bind(...cur.params),
    db
      .prepare(
        `SELECT ${pb} AS b, ${revenueSum(site)} AS revenue, SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END) AS payments
         FROM ${curPay.sql} GROUP BY b`,
      )
      .bind(...curPay.params),
  ]);

  const visitorsBy = new Map((ts.results as any[]).map((r) => [r.b, r]));
  const revenueBy = new Map((tr.results as any[]).map((r) => [r.b, r]));
  const labels = bucketLabels(range, ctx.offset);
  const series = labels.map((b) => ({
    bucket: b,
    visitors: visitorsBy.get(b)?.visitors ?? 0,
    pageviews: visitorsBy.get(b)?.pageviews ?? 0,
    revenue: revenueBy.get(b)?.revenue ?? 0,
    payments: revenueBy.get(b)?.payments ?? 0,
  }));

  return {
    range,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
    current: kpis(k1.results[0] as KpiRow, r1.results[0] as RevRow),
    previous: kpis(k0.results[0] as KpiRow, r0.results[0] as RevRow),
    online: (online.results[0] as { n: number }).n,
    series,
  };
}

/** Session dimensions, keyed by the name the dashboard asks for. */
const SESSION_DIMS: Record<string, string> = {
  channel: 's.channel',
  source: 's.source',
  campaign: 's.utm_campaign',
  keyword: 's.utm_term',
  utm_source: 's.utm_source',
  utm_medium: 's.utm_medium',
  utm_content: 's.utm_content',
  ref: 's.ref',
  country: 's.country',
  region: 's.region',
  city: 's.city',
  browser: 's.browser',
  os: 's.os',
  device: 's.device',
  entry_page: 's.entry_page',
  exit_page: 's.exit_page',
  hostname: 's.hostname',
  referrer: 's.referrer',
};

export interface BreakdownRow {
  label: string | null;
  visitors: number;
  pageviews?: number;
  revenue: number;
  customers: number;
  icon?: string | null;
  extra?: string | null;
}

export async function breakdown(ctx: Ctx, dim: string, limit = 100): Promise<BreakdownRow[]> {
  const { db } = ctx;
  const lim = Math.max(1, Math.min(500, limit));

  if (SESSION_DIMS[dim]) {
    const col = SESSION_DIMS[dim];
    const w = sessionsWhere(ctx);
    const pay = paymentsFrom(ctx);
    // Payments need the session columns even without filters.
    const payJoin = hasFilters(ctx.filters)
      ? pay
      : {
          sql: `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?`,
          params: pay.params,
        };
    const extraCol =
      dim === 'source' || dim === 'referrer' ? 'MAX(s.referrer_domain)' : dim === 'region' || dim === 'city' ? 'MAX(s.country)' : 'NULL';
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT ${col} AS label, COUNT(DISTINCT s.visitor_id) AS visitors, SUM(s.pageviews) AS pageviews, ${extraCol} AS extra
           FROM sessions s WHERE ${w.sql} GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...w.params),
      db
        .prepare(
          `SELECT ${col} AS label, ${revenueSum(ctx.site)} AS revenue,
                  COUNT(DISTINCT CASE WHEN p.kind = 'payment' THEN COALESCE(p.visitor_id, p.id) END) AS customers
           FROM ${payJoin.sql} GROUP BY label`,
        )
        .bind(...payJoin.params),
    ]);
    return merge(v.results as any[], r.results as any[]);
  }

  if (dim === 'page') {
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${f.sql}`;
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT e.path AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
           GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...params),
      // Revenue from customers who viewed the page during the period.
      revenueByEvent(ctx, 'e.path', base, params),
    ]);
    return merge(v.results as any[], r.results as any[]);
  }

  if (dim === 'exit_link' || dim === 'goal') {
    const type = dim === 'goal' ? 'goal' : 'outbound';
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, type, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = ? AND e.ts >= ? AND e.ts < ?${f.sql}`;
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT e.name AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
           GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...params),
      revenueByEvent(ctx, 'e.name', base, params),
    ]);
    return merge(v.results as any[], r.results as any[]);
  }

  throw new Error(`unknown dimension ${dim}`);
}

/**
 * Revenue per page/goal/link from the visitors who paid in the period and had that event in the period.
 * Starts from the (few) paying visitors and looks up their events by visitor, instead of scanning every event.
 */
function revenueByEvent(ctx: Ctx, labelCol: string, eventsFrom: string, eventsParams: unknown[]) {
  return ctx.db
    .prepare(
      `WITH payers AS (
         SELECT p.visitor_id, ${revenueSum(ctx.site)} AS revenue FROM payments p
         WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND p.visitor_id IS NOT NULL GROUP BY p.visitor_id
       ),
       seen AS (SELECT DISTINCT ${labelCol} AS label, e.visitor_id ${eventsFrom} AND e.visitor_id IN (SELECT visitor_id FROM payers))
       SELECT seen.label, SUM(payers.revenue) AS revenue, COUNT(*) AS customers
       FROM seen JOIN payers ON payers.visitor_id = seen.visitor_id
       GROUP BY seen.label ORDER BY seen.label`,
    )
    .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...eventsParams);
}

function merge(visits: any[], revenue: any[]): BreakdownRow[] {
  const rev = new Map(revenue.map((r) => [r.label, r]));
  const rows: BreakdownRow[] = visits.map((v) => ({
    label: v.label,
    visitors: v.visitors,
    pageviews: v.pageviews ?? undefined,
    revenue: rev.get(v.label)?.revenue ?? 0,
    customers: rev.get(v.label)?.customers ?? 0,
    extra: v.extra ?? null,
  }));
  // Sources that made money but had no visits in this period (paid later) still show up.
  const seen = new Set(visits.map((v) => v.label));
  for (const r of revenue) if (!seen.has(r.label)) rows.push({ label: r.label, visitors: 0, revenue: r.revenue, customers: r.customers });
  return rows;
}

/** Customers in the period, with where they came from (the "Journey" tab). */
export async function customers(ctx: Ctx) {
  const { db, site, range } = ctx;
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN' : 'LEFT JOIN';
  const res = await db
    .prepare(
      `SELECT p.id, p.ts, p.amount, p.currency, p.renewal, p.matched_by, p.email AS pay_email, p.name AS pay_name, p.visitor_id, p.session_id,
              v.first_seen, v.name, v.email, v.user_id,
              s.source, s.channel, s.referrer_domain, s.utm_campaign, s.ref, s.country, s.city, s.device, s.os, s.browser, s.entry_page,
              (SELECT COUNT(*) FROM sessions s2 WHERE s2.site_id = p.site_id AND s2.visitor_id = p.visitor_id AND s2.started_at <= p.ts) AS visits
       FROM payments p
       LEFT JOIN visitors v ON v.site_id = p.site_id AND v.id = p.visitor_id
       ${join} sessions s ON s.site_id = p.site_id AND s.id = p.session_id
       WHERE p.site_id = ? AND p.kind = 'payment' AND p.ts >= ? AND p.ts < ?${f.sql}
       ORDER BY p.ts DESC LIMIT 200`,
    )
    .bind(site.id, range.from, range.to, ...f.params)
    .all();
  return res.results;
}

/** Recent visitors in the period (the "Users" tab). */
export async function visitors(ctx: Ctx) {
  const w = sessionsWhere(ctx);
  const res = await ctx.db
    .prepare(
      `SELECT t.*, v.name, v.email, v.user_id, v.first_seen,
              (SELECT COALESCE(${revenueSum(ctx.site)}, 0) FROM payments p WHERE p.site_id = t.site_id AND p.visitor_id = t.visitor_id) AS spent
       FROM (
         SELECT s.site_id, s.visitor_id, MAX(s.last_seen_at) AS last_seen, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews,
                SUM(s.duration) AS duration, s.source, s.referrer_domain, s.country, s.city, s.device, s.os, s.browser
         FROM sessions s WHERE ${w.sql} GROUP BY s.visitor_id ORDER BY last_seen DESC LIMIT 200
       ) t LEFT JOIN visitors v ON v.site_id = t.site_id AND v.id = t.visitor_id
       ORDER BY t.last_seen DESC`,
    )
    .bind(...w.params)
    .all();
  return res.results;
}

/** Everything one visitor did: visits, pages, clicks, payments. */
export async function visitorProfile(db: D1Database, site: Site, vid: string) {
  const [v, s, e, p] = await db.batch([
    db.prepare('SELECT * FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid),
    db.prepare('SELECT * FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 100').bind(site.id, vid),
    db
      .prepare('SELECT session_id, ts, type, name, path, props FROM events WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC LIMIT 1000')
      .bind(site.id, vid),
    db.prepare('SELECT * FROM payments WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC').bind(site.id, vid),
  ]);
  return {
    visitor: v.results[0] ?? null,
    sessions: s.results,
    events: e.results,
    payments: p.results,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
  };
}

export interface FunnelStep {
  type: 'page' | 'goal' | 'payment';
  value: string; // page paths support * wildcards, e.g. /blog/*; empty for payment steps
  label?: string;
}

type FunnelRow = { v: string; ts: number; type: string; name: string | null; path: string | null; amount?: number; currency?: string };

/** Visitors who completed each step, in order, within the period. A payment step is a positive payment (not a refund). */
export async function funnel(ctx: Ctx, steps: FunnelStep[]) {
  if (!steps.length) return [];
  const f = filterSql(ctx.filters);
  const filtered = hasFilters(ctx.filters);
  const join = filtered ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
  const conds: string[] = [];
  const params: unknown[] = [];
  for (const st of steps) {
    if (st.type === 'goal') {
      conds.push(`(e.type = 'goal' AND e.name = ?)`);
      params.push(st.value);
    } else if (st.type === 'page') {
      conds.push(`(e.type = 'pageview' AND e.path GLOB ?)`);
      params.push(st.value);
    }
  }
  const queries: Promise<FunnelRow[]>[] = [];
  if (conds.length) {
    queries.push(
      ctx.db
        .prepare(
          `SELECT e.visitor_id AS v, e.ts, e.type, e.name, e.path FROM events e ${join}
           WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND (${conds.join(' OR ')})${f.sql}
           ORDER BY e.ts LIMIT 100000`,
        )
        .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...params, ...f.params)
        .all<FunnelRow>()
        .then((r) => r.results),
    );
  }
  if (steps.some((st) => st.type === 'payment')) {
    const payJoin = filtered ? 'JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id' : '';
    queries.push(
      ctx.db
        .prepare(
          `SELECT p.visitor_id AS v, p.ts, 'payment' AS type, NULL AS name, NULL AS path, p.amount, p.currency FROM payments p ${payJoin}
           WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND p.visitor_id IS NOT NULL AND p.kind = 'payment' AND p.amount > 0${f.sql}
           ORDER BY p.ts LIMIT 100000`,
        )
        .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...f.params)
        .all<FunnelRow>()
        .then((r) => r.results),
    );
  }
  const rows = (await Promise.all(queries)).flat().sort((a, b) => a.ts - b.ts);

  const matchers = steps.map((st) => {
    if (st.type === 'payment') return (r: FunnelRow) => r.type === 'payment';
    if (st.type === 'goal') return (r: FunnelRow) => r.type === 'goal' && r.name === st.value;
    const re = new RegExp('^' + st.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return (r: FunnelRow) => r.type === 'pageview' && re.test(r.path ?? '');
  });
  const currency = /^[A-Z]{3}$/.test(ctx.site.currency) ? ctx.site.currency : 'USD';
  const revenue = steps.map(() => 0);
  const progress = new Map<string, number>();
  for (const r of rows) {
    const at = progress.get(r.v) ?? 0;
    if (at < steps.length && matchers[at](r)) {
      progress.set(r.v, at + 1);
      if (r.type === 'payment' && r.currency === currency) revenue[at] += r.amount ?? 0;
    }
  }
  const counts = steps.map(() => 0);
  for (const reached of progress.values()) for (let i = 0; i < reached; i++) counts[i]++;
  return steps.map((st, i) => (st.type === 'payment' ? { ...st, visitors: counts[i], revenue: revenue[i] } : { ...st, visitors: counts[i] }));
}

/** Everything the live globe needs: who is on the site right now, and what happened in the last 30 minutes. */
export async function realtime(db: D1Database, site: Site, now = Date.now()) {
  const ACTIVE_MS = 5 * 60_000;
  const FEED_MS = 30 * 60_000;
  const [visitors, events, payments] = await db.batch([
    db
      .prepare(
        `SELECT s.visitor_id, s.id AS session_id, s.lat, s.lon, s.country, s.region, s.city, s.device, s.browser, s.os,
                s.source, s.referrer_domain, s.exit_page AS page, s.started_at, s.last_seen_at, s.pageviews,
                v.name, v.email,
                (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = s.site_id AND p.visitor_id = s.visitor_id) AS spent
         FROM sessions s LEFT JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         WHERE s.site_id = ? AND s.started_at > ? AND s.last_seen_at > ?
         ORDER BY s.last_seen_at DESC LIMIT 500`,
      )
      .bind(site.id, now - 6 * 3_600_000, now - ACTIVE_MS),
    db
      .prepare(
        `SELECT e.id, e.ts, e.type, e.name, e.path, e.visitor_id, s.country, s.lat, s.lon, v.name AS vname, v.email AS vemail
         FROM events e
         LEFT JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id
         LEFT JOIN visitors v ON v.site_id = e.site_id AND v.id = e.visitor_id
         WHERE e.site_id = ? AND e.ts > ? AND e.type IN ('pageview', 'goal')
         ORDER BY e.ts DESC LIMIT 100`,
      )
      .bind(site.id, now - FEED_MS),
    db
      .prepare(
        `SELECT p.id, p.ts, p.amount, p.kind, p.visitor_id, p.name, p.email, s.country, s.lat, s.lon
         FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE p.site_id = ? AND p.ts > ?
         ORDER BY p.ts DESC LIMIT 50`,
      )
      .bind(site.id, now - FEED_MS),
  ]);

  // One marker per visitor (their most recent visit).
  const seen = new Set<string>();
  const active = (visitors.results as any[]).filter((v) => !seen.has(v.visitor_id) && seen.add(v.visitor_id));

  const feed = [
    ...(events.results as any[]).map((e) => ({
      id: `e${e.id}`,
      ts: e.ts,
      type: e.type as 'pageview' | 'goal',
      label: e.type === 'goal' ? e.name : e.path,
      visitor_id: e.visitor_id,
      name: e.vname ?? e.vemail ?? null,
      country: e.country,
      lat: e.lat,
      lon: e.lon,
    })),
    ...(payments.results as any[]).map((p) => ({
      id: `p${p.id}`,
      ts: p.ts,
      type: (p.kind === 'refund' ? 'refund' : 'payment') as 'payment' | 'refund',
      amount: p.amount,
      visitor_id: p.visitor_id,
      name: p.name ?? p.email ?? null,
      country: p.country,
      lat: p.lat,
      lon: p.lon,
    })),
  ].sort((a, b) => b.ts - a.ts);

  return { now, currency: site.currency, decimals: currencyDecimals(site.currency), domain: site.domain, visitors: active, feed };
}
