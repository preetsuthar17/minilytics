import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { handleEvent } from './collect';
import { forgetSite, getSite, type AppEnv, type Site } from './env';
import { clearSession, currentUser, googleCallback, googleStart, isHosted, requireUser, setSession, siteAccessSql } from './auth';
import { billingWebhook, checkout, planInfo } from './billing';
import { passwordsMatch, randomId } from './lib/crypto';
import { handleDodoWebhook, handleGoalApi, handlePaymentApi, rematchPayments } from './payments';
import { aiBreakdown, aiOverview, aiRecent, handleAgentApi, parseHitFilters, refreshIpLists } from './agents';
import { engineInfo, monitorAllowed, runDuePrompts, runPrompt, ENGINES, configuredEngines, type EngineId } from './monitor';
import { purgeAgentHits, purgeOldData } from './retention';
import { breakdown, customers, funnel, makeCtx, overview, realtime, visitorProfile, visitors, type FunnelStep } from './stats';

const app = new Hono<AppEnv>();
const DAILY_CRON = '17 3 * * *';
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;

// ---------- public: tracking, webhooks, server-side API

app.use('/api/event', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], maxAge: 86400 }));
app.post('/api/event', handleEvent);
app.post('/api/webhooks/dodo/:siteId', handleDodoWebhook);
app.post('/api/v1/payments', handlePaymentApi);
app.post('/api/v1/goals', handleGoalApi);
app.post('/api/v1/agents', handleAgentApi);

// ---------- login

app.post('/api/auth/login', async (c) => {
  if (isHosted(c.env)) return c.json({ error: 'Use "Continue with Google".' }, 400);
  if (!c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) {
    return c.json({ error: 'Set ADMIN_PASSWORD and SESSION_SECRET (see README).' }, 500);
  }
  // Lock an IP out after too many wrong passwords, so a public dashboard can't be brute-forced.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const now = Date.now();
  const recent = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND ts > ?')
    .bind(ip, now - LOCKOUT_MS)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_FAILURES) {
    return c.json({ error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
  }
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!password || !passwordsMatch(password, c.env.ADMIN_PASSWORD)) {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO login_failures (ip, ts) VALUES (?, ?)').bind(ip, now),
      c.env.DB.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - LOCKOUT_MS),
    ]);
    await new Promise((r) => setTimeout(r, 500));
    return c.json({ error: 'Wrong password' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
  await setSession(c, 'admin');
  return c.json({ ok: true });
});

app.get('/api/auth/google', googleStart);
app.get('/api/auth/google/callback', googleCallback);

app.post('/api/auth/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const user = await currentUser(c);
  return c.json({ loggedIn: !!user, hosted: isHosted(c.env), user });
});

// ---------- billing (hosted mode)

app.get('/api/public/plan', async (c) => c.json(await planInfo(c.env)));
app.post('/api/billing/webhook', billingWebhook);
app.get('/api/billing/checkout', requireUser, checkout);

// ---------- dashboard API (login required)

app.use('/api/sites', requireUser);
app.use('/api/sites/*', requireUser);

// Runs after requireAuth. Stats reads use the per-isolate site cache (up to 60s stale in other isolates);
// settings reads and every write read the row fresh, so a save is never shown or applied on stale data.
const loadSite = async (c: Context<AppEnv>, next: Next) => {
  const id = c.req.param('id')!;
  // '/api/sites/:id/*' also matches '/api/sites/:id', so this can run twice for one request.
  if (c.get('site')?.id === id) return next();
  const fresh = c.req.method !== 'GET' || /^\/api\/sites\/[^/]+\/?$/.test(c.req.path);
  let site: Site | null;
  if (isHosted(c.env)) {
    // Hosted mode: every read checks that the signed-in account owns the site.
    const access = siteAccessSql(c.env, c.get('user'));
    site = await c.env.DB.prepare(`SELECT s.* FROM sites s WHERE s.id = ? AND ${access.sql}`)
      .bind(id, ...access.params)
      .first<Site>();
  } else {
    site = fresh ? await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<Site>() : await getSite(c.env.DB, id);
  }
  if (!site) return c.json({ error: 'site not found' }, 404);
  c.set('site', site);
  await next();
};
app.use('/api/sites/:id', loadSite);
app.use('/api/sites/:id/*', loadSite);

function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const publicSite = (s: Site) => ({ ...s, dodo_webhook_secret: s.dodo_webhook_secret ? '••••••••' : null });

app.get('/api/sites', async (c) => {
  const now = Date.now();
  const access = siteAccessSql(c.env, c.get('user'));
  const [sites, stats] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT s.* FROM sites s WHERE ${access.sql} ORDER BY s.created_at`).bind(...access.params),
    c.env.DB.prepare(
      `SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(DISTINCT CASE WHEN last_seen_at > ? THEN visitor_id END) AS online
       FROM sessions WHERE started_at > ? GROUP BY site_id`,
    ).bind(now - 5 * 60_000, now - 86_400_000),
  ]);
  const by = new Map((stats.results as any[]).map((r) => [r.site_id, r]));
  return c.json(
    (sites.results as unknown as Site[]).map((s) => ({
      ...publicSite(s),
      visitors24h: by.get(s.id)?.visitors ?? 0,
      online: by.get(s.id)?.online ?? 0,
    })),
  );
});

app.post('/api/sites', async (c) => {
  const user = c.get('user');
  if (isHosted(c.env) && !user.paid) return c.json({ error: 'Choose a plan to add websites.' }, 402);
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const domain = cleanDomain(b.domain ?? '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return c.json({ error: 'Enter a domain like example.com' }, 400);
  const tz = b.timezone && validTimezone(b.timezone) ? b.timezone : 'UTC';
  const site: Site = {
    id: randomId(8),
    name: (b.name || domain).slice(0, 100),
    domain,
    timezone: tz,
    currency: (b.currency || 'USD').toUpperCase().slice(0, 3),
    api_key: 'ml_' + randomId(16),
    dodo_webhook_secret: null,
    dodo_brand_id: null,
    created_at: Date.now(),
  };
  await c.env.DB.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, dodo_webhook_secret, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, null, site.created_at, isHosted(c.env) ? user.id : null)
    .run();
  return c.json(publicSite(site));
});

app.get('/api/sites/:id', (c) => c.json(publicSite(c.get('site'))));

app.patch('/api/sites/:id', async (c) => {
  const site = c.get('site');
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const next = { ...site };
  if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 100);
  if (typeof b.domain === 'string') {
    const d = cleanDomain(b.domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return c.json({ error: 'Enter a domain like example.com' }, 400);
    next.domain = d;
  }
  if (typeof b.timezone === 'string') {
    if (!validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
    next.timezone = b.timezone;
  }
  if (typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency)) next.currency = b.currency.toUpperCase();
  if (typeof b.dodo_webhook_secret === 'string' && !b.dodo_webhook_secret.includes('•')) {
    next.dodo_webhook_secret = b.dodo_webhook_secret.trim() || null;
  }
  if (typeof b.dodo_brand_id === 'string') next.dodo_brand_id = b.dodo_brand_id.trim().slice(0, 100) || null;
  if (typeof b.dodo_product_ids === 'string') {
    const ids = b.dodo_product_ids.split(/[\s,]+/).filter((x) => /^pdt_[\w-]+$/.test(x));
    next.dodo_product_ids = ids.join(',') || null;
  }
  if (typeof b.ai_brand_terms === 'string') {
    const terms = b.ai_brand_terms.split(',').map((t) => t.trim().slice(0, 60)).filter(Boolean).slice(0, 10);
    next.ai_brand_terms = terms.join(', ') || null;
  }
  if (typeof b.ai_monitor_days === 'number' && [0, 1, 3, 7, 14, 30].includes(b.ai_monitor_days)) next.ai_monitor_days = b.ai_monitor_days;
  await c.env.DB.prepare(
    `UPDATE sites SET name = ?, domain = ?, timezone = ?, currency = ?, dodo_webhook_secret = ?, dodo_brand_id = ?, dodo_product_ids = ?,
       ai_brand_terms = ?, ai_monitor_days = ? WHERE id = ?`,
  )
    .bind(
      next.name,
      next.domain,
      next.timezone,
      next.currency,
      next.dodo_webhook_secret,
      next.dodo_brand_id,
      next.dodo_product_ids ?? null,
      next.ai_brand_terms ?? null,
      next.ai_monitor_days ?? 7,
      site.id,
    )
    .run();
  forgetSite(site.id);
  return c.json(publicSite(next));
});

app.post('/api/sites/:id/rotate-key', async (c) => {
  const key = 'ml_' + randomId(16);
  await c.env.DB.prepare('UPDATE sites SET api_key = ? WHERE id = ?').bind(key, c.get('site').id).run();
  forgetSite(c.get('site').id);
  return c.json({ api_key: key });
});

app.delete('/api/sites/:id', async (c) => {
  const id = c.get('site').id;
  await c.env.DB.batch(
    ['events', 'sessions', 'visitors', 'payments', 'funnels', 'agent_hits', 'ai_prompts', 'ai_prompt_runs'].map((t) =>
      c.env.DB.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(id),
    ).concat(c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id)),
  );
  forgetSite(id);
  return c.json({ ok: true });
});

// ---------- stats

app.get('/api/sites/:id/overview', async (c) => c.json(await overview(makeCtx(c))));

// Cheap change detector for the live dashboard: the version only moves when new data lands.
app.get('/api/sites/:id/pulse', async (c) => {
  const id = c.get('site').id;
  const now = Date.now();
  const [ev, pay, on] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT MAX(ts) AS t, COUNT(*) AS n FROM events WHERE site_id = ? AND ts > ?').bind(id, now - 3_600_000),
    c.env.DB.prepare('SELECT MAX(ts) AS t, COUNT(*) AS n, COUNT(visitor_id) AS m FROM payments WHERE site_id = ? AND ts > ?').bind(id, now - 86_400_000),
    c.env.DB.prepare(
      'SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE site_id = ? AND started_at > ? AND last_seen_at > ?',
    ).bind(id, now - 6 * 3_600_000, now - 5 * 60_000),
  ]);
  const e = ev.results[0] as { t: number | null; n: number };
  const p = pay.results[0] as { t: number | null; n: number; m: number };
  c.header('Cache-Control', 'no-store');
  return c.json({ v: `${e.t ?? 0}.${e.n}.${p.t ?? 0}.${p.n}.${p.m}`, online: (on.results[0] as { n: number }).n });
});

app.get('/api/sites/:id/breakdown', async (c) => {
  try {
    return c.json(await breakdown(makeCtx(c), c.req.query('dim') ?? 'source', Number(c.req.query('limit')) || 100));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post('/api/sites/:id/rematch', async (c) => c.json(await rematchPayments(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/realtime', async (c) => c.json(await realtime(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/customers', async (c) => c.json(await customers(makeCtx(c))));
app.get('/api/sites/:id/visitors', async (c) => c.json(await visitors(makeCtx(c))));
app.get('/api/sites/:id/visitors/:vid', async (c) =>
  c.json(await visitorProfile(c.env.DB, c.get('site'), c.req.param('vid'))),
);

app.get('/api/sites/:id/funnels', async (c) => {
  const res = await c.env.DB.prepare('SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all();
  return c.json(res.results.map((f: any) => ({ ...f, steps: JSON.parse(f.steps) })));
});

app.post('/api/sites/:id/funnels', async (c) => {
  const b = await c.req.json<{ name?: string; steps?: FunnelStep[] }>().catch(() => ({}) as { name?: string; steps?: FunnelStep[] });
  const raw = Array.isArray(b.steps) ? b.steps : [];
  if (raw.length > 10) return c.json({ error: 'A funnel can have at most 10 steps' }, 400);
  const bad = raw.findIndex(
    (s) => !s || !['page', 'goal', 'payment'].includes(s.type) || (s.type !== 'payment' && !(typeof s.value === 'string' && s.value.trim())),
  );
  if (bad >= 0) return c.json({ error: `Step ${bad + 1} needs a type and a value` }, 400);
  const steps = raw.map((s) => ({ type: s.type, value: s.type === 'payment' ? '' : s.value.trim().slice(0, 200) }));
  if (!b.name?.trim() || steps.length < 2) return c.json({ error: 'A funnel needs a name and at least 2 steps' }, 400);
  const id = randomId(8);
  await c.env.DB.prepare('INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('site').id, b.name.trim().slice(0, 100), JSON.stringify(steps), Date.now())
    .run();
  return c.json({ id, name: b.name.trim(), steps });
});

app.delete('/api/sites/:id/funnels/:fid', async (c) => {
  await c.env.DB.prepare('DELETE FROM funnels WHERE id = ? AND site_id = ?').bind(c.req.param('fid'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/funnels/:fid/stats', async (c) => {
  const f = await c.env.DB.prepare('SELECT * FROM funnels WHERE id = ? AND site_id = ?')
    .bind(c.req.param('fid'), c.get('site').id)
    .first<{ steps: string }>();
  if (!f) return c.json({ error: 'funnel not found' }, 404);
  return c.json(await funnel(makeCtx(c), JSON.parse(f.steps)));
});

// ---------- AI: crawlers, assistants and agents

app.get('/api/sites/:id/ai/overview', async (c) => c.json(await aiOverview(makeCtx(c), parseHitFilters(c.req.query('filters')))));
app.get('/api/sites/:id/ai/breakdown', async (c) => {
  try {
    const ctx = makeCtx(c);
    return c.json(await aiBreakdown(ctx, parseHitFilters(c.req.query('filters')), c.req.query('dim') ?? 'agent', c.req.query('scope'), Number(c.req.query('limit')) || 100));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.get('/api/sites/:id/ai/recent', async (c) => c.json(await aiRecent(makeCtx(c), parseHitFilters(c.req.query('filters')))));
app.post('/api/sites/:id/ai/refresh-ips', async (c) => c.json(await refreshIpLists(c.env.DB)));

// ---------- AI: prompt monitoring

const MAX_PROMPTS = 50;

async function ownerEmail(db: D1Database, site: Site) {
  if (!site.owner_id) return null;
  return (await db.prepare('SELECT email FROM users WHERE id = ?').bind(site.owner_id).first<{ email: string }>())?.email ?? null;
}

app.get('/api/sites/:id/ai/prompts', async (c) => {
  const site = c.get('site');
  const [prompts, latest, history] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, prompt, created_at FROM ai_prompts WHERE site_id = ? ORDER BY created_at').bind(site.id),
    // The newest answer per prompt and engine.
    c.env.DB.prepare(
      `SELECT r.id, r.prompt_id, r.engine, r.model, r.ts, r.mentioned, r.cited, r.position, r.error, r.citations
       FROM ai_prompt_runs r
       JOIN (SELECT prompt_id, engine, MAX(ts) AS ts FROM ai_prompt_runs WHERE site_id = ? GROUP BY prompt_id, engine) l
         ON l.prompt_id = r.prompt_id AND l.engine = r.engine AND l.ts = r.ts
       WHERE r.site_id = ?`,
    ).bind(site.id, site.id),
    // Visibility over time: share of answers (per day) that mention or cite the site.
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, engine, COUNT(*) AS runs, SUM(mentioned) AS mentioned, SUM(cited) AS cited
       FROM ai_prompt_runs WHERE site_id = ? AND error IS NULL AND ts > ? GROUP BY day, engine ORDER BY day`,
    ).bind(site.id, Date.now() - 180 * 86_400_000),
  ]);
  const env = c.env;
  return c.json({
    engines: engineInfo(env),
    allowed: monitorAllowed(env, { ...site, owner_email: await ownerEmail(c.env.DB, site) }),
    brandTerms: site.ai_brand_terms ?? null,
    days: site.ai_monitor_days ?? 7,
    prompts: prompts.results,
    latest: (latest.results as Record<string, unknown>[]).map((r) => ({ ...r, citations: JSON.parse(String(r.citations ?? '[]')) })),
    history: history.results,
  });
});

app.post('/api/sites/:id/ai/prompts', async (c) => {
  const site = c.get('site');
  const b = await c.req.json<{ prompt?: string; prompts?: string[] }>().catch(() => ({}) as { prompt?: string; prompts?: string[] });
  const list = (b.prompts ?? [b.prompt ?? '']).map((p) => String(p).trim().slice(0, 500)).filter((p) => p.length >= 3);
  if (!list.length) return c.json({ error: 'Write a question, e.g. "best React component library for dashboards"' }, 400);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_prompts WHERE site_id = ?').bind(site.id).first<{ n: number }>();
  if ((count?.n ?? 0) + list.length > MAX_PROMPTS) return c.json({ error: `A site can have at most ${MAX_PROMPTS} prompts` }, 400);
  const now = Date.now();
  const rows = list.map((prompt, i) => ({ id: randomId(8), prompt, created_at: now + i }));
  await c.env.DB.batch(
    rows.map((r) => c.env.DB.prepare('INSERT INTO ai_prompts (id, site_id, prompt, created_at) VALUES (?, ?, ?, ?)').bind(r.id, site.id, r.prompt, r.created_at)),
  );
  return c.json(rows);
});

app.delete('/api/sites/:id/ai/prompts/:pid', async (c) => {
  const site = c.get('site');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM ai_prompt_runs WHERE site_id = ? AND prompt_id = ?').bind(site.id, c.req.param('pid')),
    c.env.DB.prepare('DELETE FROM ai_prompts WHERE site_id = ? AND id = ?').bind(site.id, c.req.param('pid')),
  ]);
  return c.json({ ok: true });
});

// Ask now, on every configured assistant (or just one with ?engine=claude). Takes up to a minute or two.
app.post('/api/sites/:id/ai/prompts/:pid/run', async (c) => {
  const site = c.get('site');
  const p = await c.env.DB.prepare('SELECT id, prompt FROM ai_prompts WHERE site_id = ? AND id = ?')
    .bind(site.id, c.req.param('pid'))
    .first<{ id: string; prompt: string }>();
  if (!p) return c.json({ error: 'prompt not found' }, 404);
  if (!monitorAllowed(c.env, { ...site, owner_email: await ownerEmail(c.env.DB, site) })) return c.json({ error: 'Prompt monitoring is not available on this plan' }, 403);
  const only = c.req.query('engine') as EngineId | undefined;
  const engines = configuredEngines(c.env).filter((e) => !only || e.id === only);
  if (!engines.length) {
    return c.json({ error: `Add an API key first: ${ENGINES.map((e) => e.secret).join(', ')} (wrangler secret put …)` }, 400);
  }
  return c.json(await runPrompt(c.env.DB, c.env, site, p, engines));
});

// A prompt's past answers, newest first (for the answer viewer).
app.get('/api/sites/:id/ai/prompts/:pid/runs', async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT id, engine, model, ts, mentioned, cited, position, answer, citations, error FROM ai_prompt_runs
     WHERE site_id = ? AND prompt_id = ? ORDER BY ts DESC LIMIT 40`,
  )
    .bind(c.get('site').id, c.req.param('pid'))
    .all<Record<string, unknown>>();
  return c.json(res.results.map((r) => ({ ...r, citations: JSON.parse(String(r.citations ?? '[]')) })));
});

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// Everything else is the dashboard (static files).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // Crons in wrangler.jsonc. Daily: cleanup (raw analytics only when RETENTION_DAYS is set) and fresh AI IP ranges.
  // Hourly: prompt monitoring, a few prompts at a time.
  scheduled(controller: ScheduledController, env: AppEnv['Bindings'], ctx: ExecutionContext) {
    if (controller.cron === DAILY_CRON) {
      ctx.waitUntil(purgeOldData(env.DB, env.RETENTION_DAYS));
      ctx.waitUntil(purgeAgentHits(env.DB, env.AGENT_RETENTION_DAYS, env.RETENTION_DAYS));
      ctx.waitUntil(refreshIpLists(env.DB).catch(() => {}));
    } else {
      ctx.waitUntil(runDuePrompts(env.DB, env));
    }
  },
} satisfies ExportedHandler<AppEnv['Bindings']>;
