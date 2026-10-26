import { createHmac, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv, Site } from '../src/worker/env';
import { ingest } from '../src/worker/collect';
import { handleDodoWebhook, rematchPayments } from '../src/worker/payments';
import { testDb } from './d1';

const key = Buffer.from('payments-test-secret');
const secret = 'whsec_' + key.toString('base64');
const T0 = Date.UTC(2026, 9, 1, 12, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function setup(over: Partial<Site> = {}) {
  const { d1, raw } = testDb();
  const site: Site = {
    id: 'site' + randomUUID().slice(0, 8),
    name: 'Test',
    domain: 'example.com',
    timezone: 'UTC',
    currency: 'USD',
    api_key: 'ml_test',
    dodo_webhook_secret: secret,
    dodo_brand_id: null,
    created_at: 0,
    ...over,
  };
  raw
    .prepare('INSERT INTO sites (id, name, domain, timezone, currency, api_key, dodo_webhook_secret, dodo_brand_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, site.dodo_webhook_secret, site.dodo_brand_id, site.created_at);

  async function webhook(type: string, data: Record<string, unknown>) {
    const body = JSON.stringify({ type, timestamp: iso(T0), data });
    const id = 'msg_' + randomUUID();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
    const headers: Record<string, string> = { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` };
    const c = {
      env: { DB: d1 },
      req: { param: () => site.id, text: async () => body, header: (n: string) => headers[n] },
      json: (o: unknown, status = 200) => ({ status, body: o }),
    } as unknown as Context<AppEnv>;
    return (await handleDodoWebhook(c)) as unknown as { status: number; body: Record<string, unknown> };
  }

  function session(vid: string, sid: string, startedAt: number, channel = 'Direct', source = 'Direct/None') {
    raw
      .prepare(
        `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(site.id, sid, vid, startedAt, startedAt, source, channel);
  }

  const payments = () =>
    raw.prepare('SELECT * FROM payments WHERE site_id = ? ORDER BY ts, id').all(site.id) as unknown as Record<string, any>[];

  return { d1, raw, site, webhook, session, payments };
}

const pay = (id: string, extra: Record<string, unknown> = {}) => ({
  payment_id: id,
  total_amount: 4900,
  currency: 'USD',
  created_at: iso(T0),
  customer: { customer_id: 'cus_1', email: 'a@b.com', name: 'A' },
  ...extra,
});

describe('Dodo webhook: shared business', () => {
  it('ignores refunds of payments this site never recorded', async () => {
    const t = setup();
    const r = await t.webhook('refund.succeeded', { payment_id: 'pay_other_product', refund_id: 'ref_1', amount: 1000, currency: 'USD' });
    expect(r.body).toMatchObject({ skipped: 'unknown payment' });
    expect(t.payments()).toHaveLength(0);
  });

  it('records refunds of known payments as negative amounts', async () => {
    const t = setup();
    await t.webhook('payment.succeeded', pay('pay_1'));
    await t.webhook('refund.succeeded', { payment_id: 'pay_1', refund_id: 'ref_1', amount: 4900, currency: 'USD' });
    expect(t.payments().map((p) => [p.kind, p.amount])).toEqual([
      ['payment', 4900],
      ['refund', -4900],
    ]);
  });

  it('with a brand set, drops payments from other brands and payments with no brand', async () => {
    const t = setup({ dodo_brand_id: 'bnd_mine' });
    expect((await t.webhook('payment.succeeded', pay('pay_a', { brand_id: 'bnd_other' }))).body).toMatchObject({ skipped: 'other brand' });
    expect((await t.webhook('payment.succeeded', pay('pay_b'))).body).toMatchObject({ skipped: 'other brand' });
    await t.webhook('payment.succeeded', pay('pay_c', { brand_id: 'bnd_mine' }));
    expect(t.payments().map((p) => p.id)).toEqual(['pay_c']);
  });
});

describe('renewals', () => {
  const DAY = 86_400_000;

  it('marks renewals of unmatched subscriptions without timing-matching them to a random visitor', async () => {
    const t = setup();
    await t.webhook('payment.succeeded', pay('pay_first', { subscription_id: 'sub_1', customer: { customer_id: 'cus_9' } }));
    const later = T0 + 30 * DAY;
    t.session('visitor-x', 'session-x', later - 60_000, 'Referral', 'example.org');
    t.raw
      .prepare(`INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path) VALUES (?, 'session-x', 'visitor-x', ?, 'outbound', 'https://checkout.dodopayments.com/buy/pdt_1', '/')`)
      .run(t.site.id, later - 30_000);
    await t.webhook('payment.succeeded', pay('pay_renew', { subscription_id: 'sub_1', created_at: iso(later), customer: { customer_id: 'cus_9' } }));
    const renew = t.payments().find((p) => p.id === 'pay_renew')!;
    expect(renew).toMatchObject({ renewal: 1, visitor_id: null, matched_by: null });
  });

  it('recognises a renewal by customer id alone', async () => {
    const t = setup();
    await t.webhook('payment.succeeded', pay('pay_1', { customer: { customer_id: 'cus_7' } }));
    await t.webhook('payment.succeeded', pay('pay_2', { created_at: iso(T0 + DAY), customer: { customer_id: 'cus_7' } }));
    expect(t.payments().map((p) => [p.id, p.renewal])).toEqual([
      ['pay_1', 0],
      ['pay_2', 1],
    ]);
  });

  it('credits a renewal to the visit that won the first payment', async () => {
    const t = setup();
    t.session('visitor-1', 'session-tweet', T0 - DAY, 'Organic Social', 'X');
    await t.webhook('payment.succeeded', pay('pay_1', { subscription_id: 'sub_2', metadata: { ml_visitor_id: 'visitor-1' } }));
    t.session('visitor-1', 'session-reddit', T0 + 20 * DAY, 'Organic Social', 'Reddit');
    await t.webhook('payment.succeeded', pay('pay_2', { subscription_id: 'sub_2', created_at: iso(T0 + 30 * DAY), metadata: { ml_visitor_id: 'visitor-1' } }));
    expect(t.payments().map((p) => [p.id, p.session_id, p.renewal])).toEqual([
      ['pay_1', 'session-tweet', 0],
      ['pay_2', 'session-tweet', 1],
    ]);
  });
});

describe('refunds', () => {
  it('stores refunds converted like their payment', async () => {
    const t = setup({ currency: 'EUR' });
    const usd = { currency: 'USD', total_amount: 4900, settlement_amount: 4500, settlement_currency: 'EUR' };
    await t.webhook('payment.succeeded', pay('pay_1', usd));
    await t.webhook('payment.succeeded', pay('pay_2', usd));
    await t.webhook('refund.succeeded', { payment_id: 'pay_1', refund_id: 'ref_full', amount: 4900, currency: 'USD', is_partial: false });
    await t.webhook('refund.succeeded', { payment_id: 'pay_2', refund_id: 'ref_part', amount: 1000, currency: 'USD', is_partial: true });
    expect(t.payments().map((p) => [p.id, p.amount, p.currency, p.refund_of])).toEqual([
      ['pay_1', 4500, 'EUR', null],
      ['pay_2', 4500, 'EUR', null],
      ['ref_full', -4500, 'EUR', 'pay_1'],
      ['ref_part', -1000, 'USD', 'pay_2'],
    ]);
  });

  it('follows its payment when the return page links it later', async () => {
    const t = setup();
    await t.webhook('payment.succeeded', pay('pay_late', { customer: { customer_id: 'cus_late' } }));
    await t.webhook('refund.succeeded', { payment_id: 'pay_late', refund_id: 'ref_late', amount: 4900, currency: 'USD' });
    expect(t.payments().find((p) => p.id === 'ref_late')).toMatchObject({ visitor_id: null });
    const geo = { country: null, region: null, city: null, lat: null, lon: null };
    const url = new URL('https://example.com/thanks?payment_id=pay_late');
    await ingest(t.d1, t.site, { w: t.site.id, t: 'pageview', u: url.href, vid: 'visitor-late', sid: 'session-late' }, url, 'Mozilla/5.0 Chrome/129', geo, T0 + 60_000);
    const rows = t.payments();
    expect(rows.find((p) => p.id === 'pay_late')).toMatchObject({ visitor_id: 'visitor-late', session_id: 'session-late', matched_by: 'return_page' });
    expect(rows.find((p) => p.id === 'ref_late')).toMatchObject({ visitor_id: 'visitor-late', session_id: 'session-late', matched_by: 'return_page' });
  });

  it('follows its payment when a rematch links it', async () => {
    const t = setup();
    await t.webhook('payment.succeeded', pay('pay_r', { customer: { customer_id: 'cus_r', email: 'r@example.com' } }));
    await t.webhook('refund.succeeded', { payment_id: 'pay_r', refund_id: 'ref_r', amount: 4900, currency: 'USD' });
    t.raw.prepare('INSERT INTO visitors (site_id, id, first_seen, email) VALUES (?, ?, ?, ?)').run(t.site.id, 'visitor-r', T0 - 1000, 'r@example.com');
    t.session('visitor-r', 'session-r', T0 - 1000, 'Referral', 'example.org');
    expect((await rematchPayments(t.d1, t.site)).matched).toBe(1);
    expect(t.payments().find((p) => p.id === 'ref_r')).toMatchObject({ visitor_id: 'visitor-r', session_id: 'session-r', matched_by: 'email' });
  });
});
