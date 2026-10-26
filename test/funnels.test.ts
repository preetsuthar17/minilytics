import { describe, expect, it } from 'vitest';
import type { Site } from '../src/worker/env';
import worker from '../src/worker/index';
import { signToken } from '../src/worker/lib/crypto';
import { funnel } from '../src/worker/stats';
import { testDb } from './d1';

const T0 = Date.UTC(2026, 9, 10, 12, 0);
const site = { id: 'site0001', domain: 'example.com', timezone: 'UTC', currency: 'USD', created_at: 0 } as Site;

function seed() {
  const { d1, raw } = testDb();
  const session = (vid: string, sid: string, ts: number, source: string) =>
    raw
      .prepare(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, source, channel) VALUES (?, ?, ?, ?, ?, 1, ?, 'Referral')`)
      .run(site.id, sid, vid, ts, ts, source);
  const event = (vid: string, sid: string, ts: number, type: string, path: string, name: string | null = null) =>
    raw.prepare(`INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(site.id, sid, vid, ts, type, name, path);
  const payment = (id: string, vid: string | null, sid: string | null, ts: number, amount: number, currency = 'USD', kind = 'payment') =>
    raw
      .prepare(`INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES (?, ?, 'dodo', ?, ?, ?, ?, ?, ?)`)
      .run(id, site.id, ts, amount, kind, currency, vid, sid);

  session('v1', 's1', T0, 'X');
  event('v1', 's1', T0, 'pageview', '/pricing');
  event('v1', 's1', T0 + 1, 'goal', '/pricing', 'checkout_started');
  payment('p1', 'v1', 's1', T0 + 10, 5000);
  payment('p1b', 'v1', 's1', T0 + 20, 3000);
  session('v2', 's2', T0, 'Reddit');
  event('v2', 's2', T0, 'pageview', '/pricing');
  event('v2', 's2', T0 + 1, 'goal', '/pricing', 'checkout_started');
  payment('p2', 'v2', 's2', T0 + 10, 9900, 'EUR');
  session('v3', 's3', T0, 'Google');
  payment('p3', 'v3', 's3', T0 - 5, 4000);
  event('v3', 's3', T0, 'pageview', '/pricing');
  event('v3', 's3', T0 + 1, 'goal', '/pricing', 'checkout_started');
  payment('r3', 'v3', 's3', T0 + 10, -4000, 'USD', 'refund');
  session('v4', 's4', T0, 'X');
  event('v4', 's4', T0, 'pageview', '/pricing');
  event('v4', 's4', T0 + 1, 'goal', '/pricing', 'checkout_started');
  payment('p4', 'v4', 's4', T0 + 2 * 86_400_000, 1000);
  return { d1 };
}

const ctxOf = (d1: D1Database) => ({ db: d1, site, range: { from: T0 - 86_400_000, to: T0 + 86_400_000, granularity: 'hour' as const }, filters: {}, offset: 0, now: T0 + 86_400_000 });
const steps = [
  { type: 'page' as const, value: '/pricing' },
  { type: 'goal' as const, value: 'checkout_started' },
  { type: 'payment' as const, value: '' },
];

describe('funnel payment step', () => {
  it('counts a payment only after the previous step, in range, and not refunds', async () => {
    const { d1 } = seed();
    const rows = await funnel(ctxOf(d1), steps);
    expect(rows.map((r) => r.visitors)).toEqual([4, 4, 2]);
    expect(rows[2]).toMatchObject({ type: 'payment', visitors: 2, revenue: 5000 });
    expect(rows[0]).not.toHaveProperty('revenue');
  });

  it('applies session filters to payments', async () => {
    const { d1 } = seed();
    const rows = await funnel({ ...ctxOf(d1), filters: { source: 'X' } }, steps);
    expect(rows.map((r) => r.visitors)).toEqual([2, 2, 1]);
    expect(rows[2]).toMatchObject({ revenue: 5000 });
  });

  it('works with a payment-only step list', async () => {
    const { d1 } = seed();
    const rows = await funnel(ctxOf(d1), [{ type: 'payment', value: '' }, { type: 'payment', value: '' }]);
    expect(rows.map((r) => r.visitors)).toEqual([3, 1]);
    expect(rows[1]).toMatchObject({ revenue: 3000 });
  });
});

describe('funnel routes', () => {
  const { d1, raw } = testDb();
  raw.prepare("INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES ('fsite001', 'F', 'example.com', 'UTC', 'USD', 'ml_k', 0)").run();
  const env = { DB: d1, SESSION_SECRET: 'test-secret', ADMIN_PASSWORD: 'pw', ASSETS: { fetch: async () => new Response('') } };
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const call = async (path: string, init: RequestInit = {}) => {
    const cookie = `ml_auth=${await signToken('test-secret', `admin.${Date.now() + 60_000}`)}`;
    return worker.fetch(new Request('http://localhost' + path, { ...init, headers: { cookie, 'content-type': 'application/json' } }), env as never, ctx);
  };
  const post = (body: unknown) => call('/api/sites/fsite001/funnels', { method: 'POST', body: JSON.stringify(body) });

  it('accepts payment steps without a value and stores them empty', async () => {
    const res = await post({ name: 'Buy', steps: [{ type: 'page', value: ' /pricing ' }, { type: 'payment', value: 'ignored' }] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).steps).toEqual([
      { type: 'page', value: '/pricing' },
      { type: 'payment', value: '' },
    ]);
  });

  it('rejects unknown types, empty values and more than 10 steps', async () => {
    expect(await (await post({ name: 'x', steps: [{ type: 'page', value: '/' }, { type: 'click', value: 'a' }] })).json()).toEqual({ error: 'Step 2 needs a type and a value' });
    expect((await post({ name: 'x', steps: [{ type: 'goal', value: ' ' }, { type: 'payment' }] })).status).toBe(400);
    expect((await post({ name: 'x', steps: Array.from({ length: 11 }, () => ({ type: 'payment' })) })).status).toBe(400);
    expect((await post({ name: 'x', steps: [{ type: 'payment' }] })).status).toBe(400);
  });
});
