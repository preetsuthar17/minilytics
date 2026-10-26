import { describe, expect, it } from 'vitest';
import type { Site } from '../src/worker/env';
import { breakdown, customers, overview } from '../src/worker/stats';
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
  event('v1', 's1', T0, 'pageview', '/');
  event('v1', 's1', T0 + 1, 'pageview', '/pricing');
  event('v1', 's1', T0 + 2, 'pageview', '/pricing');
  event('v1', 's1', T0 + 3, 'goal', '/pricing', 'checkout');
  session('v2', 's2', T0, 'Reddit');
  event('v2', 's2', T0, 'pageview', '/pricing');
  session('v3', 's3', T0, 'Google');
  event('v3', 's3', T0, 'pageview', '/');
  payment('p1', 'v1', 's1', T0 + 10, 5000);
  payment('p2', 'v1', 's1', T0 + 20, 3000);
  payment('r1', 'v1', 's1', T0 + 30, -1000, 'USD', 'refund');
  payment('p3', 'v2', 's2', T0 + 10, 2000);
  payment('p4', 'v2', 's2', T0 + 15, 9900, 'EUR');
  payment('p5', null, null, T0 + 10, 700);
  return { d1, raw };
}

const ctxOf = (d1: D1Database) => ({ db: d1, site, range: { from: T0 - 86_400_000, to: T0 + 86_400_000, granularity: 'hour' as const }, filters: {}, offset: 0, now: T0 + 86_400_000 });

describe('revenue by page and goal', () => {
  it('sums the revenue of paying visitors who saw each page, once per visitor', async () => {
    const { d1 } = seed();
    const rows = await breakdown(ctxOf(d1), 'page');
    const by = Object.fromEntries(rows.map((r) => [r.label, { revenue: r.revenue, customers: r.customers, visitors: r.visitors }]));
    expect(by['/']).toEqual({ revenue: 7000, customers: 1, visitors: 2 });
    expect(by['/pricing']).toEqual({ revenue: 9000, customers: 2, visitors: 2 });
    const goals = await breakdown(ctxOf(d1), 'goal');
    expect(goals).toEqual([{ label: 'checkout', visitors: 1, pageviews: 1, revenue: 7000, customers: 1, extra: null }]);
  });

  it('keeps filters on the events side', async () => {
    const { d1 } = seed();
    const rows = await breakdown({ ...ctxOf(d1), filters: { source: 'Reddit' } }, 'page');
    expect(rows).toEqual([{ label: '/pricing', visitors: 1, pageviews: 1, revenue: 2000, customers: 1, extra: null }]);
  });
});

describe('mixed currencies', () => {
  it('only adds up amounts in the site currency', async () => {
    const { d1 } = seed();
    const o = await overview(ctxOf(d1));
    expect(o.current.revenue).toBe(5000 + 3000 - 1000 + 2000 + 700);
    expect(o.current.payments).toBe(5);
    expect(o.series.reduce((a, b) => a + b.revenue, 0)).toBe(9700);
    const src = await breakdown(ctxOf(d1), 'source');
    expect(src.find((r) => r.label === 'Reddit')).toMatchObject({ revenue: 2000, customers: 1 });
  });
});

describe('journey', () => {
  it('counts visits up to the payment', async () => {
    const { d1 } = seed();
    const rows = (await customers(ctxOf(d1))) as Record<string, any>[];
    expect(rows.find((r) => r.id === 'p1')).toMatchObject({ visits: 1, source: 'X' });
  });
});
