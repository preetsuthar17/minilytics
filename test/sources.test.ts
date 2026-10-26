import { describe, expect, it } from 'vitest';
import { classify, isPaymentOrAuthReferrer } from '../src/shared/sources';
import type { Site } from '../src/worker/env';
import { ingest } from '../src/worker/collect';
import { testDb } from './d1';

describe('payment and sign-in referrers', () => {
  it('treats checkout and auth hosts as no referrer', () => {
    for (const host of [
      'checkout.dodopayments.com',
      'test.checkout.dodopayments.com',
      'dodopayments.com',
      'checkout.stripe.com',
      'billing.stripe.com',
      'www.paypal.com',
      'myshop.lemonsqueezy.com',
      'checkout.paddle.com',
      'pay.paddle.io',
      'accounts.google.com',
      'appleid.apple.com',
    ]) {
      expect(isPaymentOrAuthReferrer(host), host).toBe(true);
      expect(classify({ referrerDomain: host }), host).toMatchObject({ source: 'Direct/None', channel: 'Direct', referrerDomain: null });
    }
  });
  it('keeps the marketing sites of those companies as referrals', () => {
    expect(isPaymentOrAuthReferrer('stripe.com')).toBe(false);
    expect(isPaymentOrAuthReferrer('lemonsqueezy.com')).toBe(false);
    expect(isPaymentOrAuthReferrer('paddle.com')).toBe(false);
    expect(isPaymentOrAuthReferrer('google.com')).toBe(false);
  });
  it('keeps github.com a referral except its login/OAuth pages', () => {
    expect(classify({ referrerDomain: 'github.com' })).toMatchObject({ source: 'GitHub', channel: 'Referral' });
    expect(classify({ referrerDomain: 'github.com', referrerPath: '/acme/repo' })).toMatchObject({ source: 'GitHub' });
    expect(classify({ referrerDomain: 'github.com', referrerPath: '/login/oauth/authorize' })).toMatchObject({ channel: 'Direct' });
    expect(classify({ referrerDomain: 'github.com', referrerPath: '/login' })).toMatchObject({ channel: 'Direct' });
    expect(classify({ referrerDomain: 'github.com', referrerPath: '/loginator' })).toMatchObject({ source: 'GitHub' });
  });
  it('still lets explicit tags win', () => {
    expect(classify({ referrerDomain: 'checkout.dodopayments.com', ref: 'launch-tweet' })).toMatchObject({ source: 'launch-tweet' });
  });

  it('stores a session back from checkout as Direct with no referrer', async () => {
    const { d1, raw } = testDb();
    const site = { id: 'site0001', domain: 'example.com', currency: 'USD' } as Site;
    const geo = { country: null, region: null, city: null, lat: null, lon: null };
    const ua = 'Mozilla/5.0 (Macintosh) Chrome/129 Safari/537.36';
    const body = (sid: string, r: string) => ({ w: site.id, t: 'pageview', u: 'https://example.com/thanks', r, vid: 'visitor-1', sid });
    await ingest(d1, site, body('session-1', 'https://checkout.dodopayments.com/session/abc'), new URL('https://example.com/thanks'), ua, geo, 1);
    await ingest(d1, site, body('session-2', 'https://github.com/login/oauth/authorize?x=1'), new URL('https://example.com/app'), ua, geo, 2);
    await ingest(d1, site, body('session-3', 'https://github.com/acme/repo'), new URL('https://example.com/'), ua, geo, 3);
    expect(raw.prepare('SELECT id, channel, referrer, referrer_domain FROM sessions ORDER BY id').all()).toEqual([
      { id: 'session-1', channel: 'Direct', referrer: null, referrer_domain: null },
      { id: 'session-2', channel: 'Direct', referrer: null, referrer_domain: null },
      { id: 'session-3', channel: 'Referral', referrer: 'github.com/acme/repo', referrer_domain: 'github.com' },
    ]);
  });
});
