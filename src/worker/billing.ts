import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { isHosted } from './auth';
import { forgetAllSites, type AppEnv, type Env } from './env';
import { verifyStandardWebhook } from './lib/crypto';

const DAY = 86_400_000;
// A few days of slack after a renewal date, so a late renewal webhook never cuts anyone off.
const GRACE_MS = 3 * DAY;

/** Public plan info for the landing/pricing page. */
export async function planInfo(env: Env) {
  const hosted = isHosted(env);
  const spots = Number(env.PLAN_SPOTS) || 0;
  let taken = 0;
  if (hosted && spots) {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE paid_at IS NOT NULL').first<{ n: number }>();
    taken = r?.n ?? 0;
  }
  return {
    hosted,
    price: env.PLAN_PRICE || '$29',
    interval: env.PLAN_INTERVAL || 'lifetime',
    spots,
    spotsLeft: spots ? Math.max(0, spots - taken) : null,
    nextPrice: env.PLAN_NEXT_PRICE || null,
    checkout: !!env.PLAN_CHECKOUT_URL,
    supportEmail: env.SUPPORT_EMAIL || null,
  };
}

/** GET /api/billing/checkout: send the signed-in user to the Dodo payment link, tagged with their account. */
export function checkout(c: Context<AppEnv>) {
  const user = c.get('user');
  if (!c.env.PLAN_CHECKOUT_URL) return c.json({ error: 'Billing is not configured yet' }, 503);
  const url = new URL(c.env.PLAN_CHECKOUT_URL);
  url.searchParams.set('metadata_user_id', user.id);
  if (user.email) {
    url.searchParams.set('email', user.email);
    url.searchParams.set('metadata_user_email', user.email);
  }
  // If this site tracks itself with Minilytics, credit the purchase to the visit that led to it.
  // (The checkout link is a server redirect, so the tracker can't tag it in the browser.)
  const vid = getCookie(c, 'ml_vid');
  const sid = getCookie(c, 'ml_sid');
  if (vid) url.searchParams.set('metadata_ml_visitor_id', vid);
  if (sid) url.searchParams.set('metadata_ml_session_id', sid);
  // Dodo adds ?payment_id=… here; the tracker on that page links the payment to the visitor even without metadata.
  url.searchParams.set('redirect_url', `${new URL(c.req.url).origin}/billing?paid=1`);
  return c.redirect(url.toString());
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** POST /api/billing/webhook: Dodo events for your own plan product turn access on and off. */
export async function billingWebhook(c: Context<AppEnv>) {
  if (!c.env.BILLING_WEBHOOK_SECRET) return c.json({ error: 'BILLING_WEBHOOK_SECRET is not set' }, 503);
  const body = await c.req.text();
  const ok = await verifyStandardWebhook(
    c.env.BILLING_WEBHOOK_SECRET,
    {
      id: c.req.header('webhook-id') ?? null,
      timestamp: c.req.header('webhook-timestamp') ?? null,
      signature: c.req.header('webhook-signature') ?? null,
    },
    body,
  );
  if (!ok) return c.json({ error: 'invalid signature' }, 401);

  const event = JSON.parse(body) as { type: string; data: Record<string, any> };
  const d = event.data ?? {};
  const productIds: string[] = [
    ...(Array.isArray(d.product_cart) ? d.product_cart.map((p: any) => p?.product_id) : []),
    d.product_id,
  ].filter(Boolean);
  // Refunds don't say which product they were for, so they're matched by the plan payment they refund.
  if (event.type === 'refund.succeeded') {
    if (!d.is_partial && str(d.payment_id)) {
      await c.env.DB.prepare(`UPDATE users SET plan_status = 'refunded', plan_until = ? WHERE dodo_payment_id = ?`)
        .bind(Date.now(), d.payment_id)
        .run();
      forgetAllSites();
    }
    return c.json({ ok: true });
  }
  // The same Dodo account may sell other products (your apps); only the plan product matters here.
  if (c.env.PLAN_PRODUCT_ID && !productIds.includes(c.env.PLAN_PRODUCT_ID)) return c.json({ ok: true, ignored: 'other product' });

  const meta = { ...(d.customer?.metadata ?? {}), ...(d.metadata ?? {}) } as Record<string, unknown>;
  const email = (str(d.customer?.email) ?? str(meta.user_email))?.toLowerCase() ?? null;
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ? OR (email IS NOT NULL AND email = ?) LIMIT 1')
    .bind(str(meta.user_id) ?? '', email ?? '')
    .first<{ id: string }>();
  if (!user) return c.json({ ok: true, ignored: 'no matching account' });

  const now = Date.now();
  const nextBilling = Date.parse(d.next_billing_date ?? '');
  const until = Number.isFinite(nextBilling) ? nextBilling + GRACE_MS : null;
  const subId = str(d.subscription_id);
  const customerId = str(d.customer?.customer_id);

  let sql: string | null = null;
  let params: unknown[] = [];
  switch (event.type) {
    case 'payment.succeeded':
      // One-time payment = lifetime access (plan_until NULL). Subscription payments get a month until the
      // subscription webhook says otherwise.
      sql = `UPDATE users SET plan_status = 'active', paid_at = COALESCE(paid_at, ?),
               plan_until = CASE WHEN ? IS NULL THEN NULL ELSE MAX(COALESCE(plan_until, 0), ?) END,
               dodo_customer_id = COALESCE(?, dodo_customer_id), dodo_subscription_id = COALESCE(?, dodo_subscription_id),
               dodo_payment_id = ?
             WHERE id = ?`;
      params = [now, subId, now + 31 * DAY + GRACE_MS, customerId, subId, str(d.payment_id), user.id];
      break;
    case 'subscription.active':
    case 'subscription.renewed':
    case 'subscription.updated':
    case 'subscription.plan_changed':
    case 'subscription.unpaused':
      if (d.status && d.status !== 'active') break;
      sql = `UPDATE users SET plan_status = 'active', paid_at = COALESCE(paid_at, ?), plan_until = COALESCE(?, plan_until),
               dodo_customer_id = COALESCE(?, dodo_customer_id), dodo_subscription_id = COALESCE(?, dodo_subscription_id)
             WHERE id = ?`;
      params = [now, until, customerId, subId, user.id];
      break;
    case 'subscription.cancelled':
      // Cancelled subscriptions keep access until the end of the period they paid for.
      sql = `UPDATE users SET plan_status = 'cancelled', plan_until = COALESCE(?, plan_until, ?) WHERE id = ?`;
      params = [until, now, user.id];
      break;
    case 'subscription.expired':
    case 'subscription.failed':
    case 'subscription.on_hold':
    case 'subscription.paused':
      sql = `UPDATE users SET plan_status = ?, plan_until = ? WHERE id = ?`;
      params = [event.type.split('.')[1], now, user.id];
      break;
  }
  if (sql) {
    await c.env.DB.prepare(sql).bind(...params).run();
    forgetAllSites();
  }
  return c.json({ ok: true });
}
