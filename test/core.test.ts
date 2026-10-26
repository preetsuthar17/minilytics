import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/shared/sources';
import { belongsTo, normalizePath } from '../src/worker/collect';
import { verifyStandardWebhook } from '../src/worker/lib/crypto';
import { bucketLabels, previousRange, resolveRange, startOfDay, tzOffset } from '../src/worker/lib/time';
import { isBot, parseUA } from '../src/worker/lib/ua';
import { purgeOldData, retentionCutoff, retentionDays } from '../src/worker/retention';

describe('classify', () => {
  it('maps t.co to X / social', () => {
    expect(classify({ referrerDomain: 't.co' })).toMatchObject({ source: 'X', channel: 'Organic Social' });
  });
  it('maps Google to organic search', () => {
    expect(classify({ referrerDomain: 'google.co.in' })).toMatchObject({ source: 'Google', channel: 'Organic Search' });
  });
  it('recognises AI assistants, including utm_source=chatgpt.com', () => {
    expect(classify({ referrerDomain: null, utmSource: 'chatgpt.com' })).toMatchObject({ source: 'ChatGPT', channel: 'AI' });
  });
  it('lets ref/utm tags win over the referrer', () => {
    expect(classify({ referrerDomain: 'google.com', ref: 'producthunt' })).toMatchObject({ source: 'Product Hunt' });
    expect(classify({ referrerDomain: null, ref: 'my-newsletter-42' })).toMatchObject({ source: 'my-newsletter-42', channel: 'Referral' });
  });
  it('detects paid and email by medium', () => {
    expect(classify({ referrerDomain: 'google.com', utmMedium: 'cpc' }).channel).toBe('Paid');
    expect(classify({ referrerDomain: null, utmSource: 'buttondown', utmMedium: 'email' }).channel).toBe('Email');
  });
  it('falls back to Direct', () => {
    expect(classify({ referrerDomain: null })).toMatchObject({ source: 'Direct/None', channel: 'Direct' });
  });
  it('does not confuse mail.google.com with Google search', () => {
    expect(classify({ referrerDomain: 'mail.google.com' })).toMatchObject({ source: 'Gmail', channel: 'Email' });
  });
});

describe('user agents', () => {
  it('parses common browsers', () => {
    expect(parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'Mobile Safari', os: 'iOS', device: 'Mobile' });
    expect(parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toEqual({ browser: 'Edge', os: 'Windows', device: 'Desktop' });
    expect(parseUA('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36').browser).toBe('Chrome');
  });
  it('flags bots', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBot('Mozilla/5.0 HeadlessChrome/120')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36')).toBe(false);
  });
});

describe('domains and paths', () => {
  it('accepts subdomains only', () => {
    expect(belongsTo('app.shipkit.dev', 'shipkit.dev')).toBe(true);
    expect(belongsTo('www.shipkit.dev', 'shipkit.dev')).toBe(true);
    expect(belongsTo('evilshipkit.dev', 'shipkit.dev')).toBe(false);
  });
  it('normalises paths', () => {
    expect(normalizePath('/pricing/')).toBe('/pricing');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/caf%C3%A9')).toBe('/café');
  });
});

describe('time ranges', () => {
  const now = Date.UTC(2026, 9, 23, 12, 0); // 23 Oct 2026 12:00 UTC
  it('computes timezone offsets', () => {
    expect(tzOffset('Asia/Kolkata', now)).toBe(330 * 60_000);
    expect(tzOffset('UTC', now)).toBe(0);
  });
  it('starts "today" at local midnight', () => {
    const r = resolveRange({ period: 'today' }, 'Asia/Kolkata', 0, now);
    expect(r.from).toBe(Date.UTC(2026, 9, 22, 18, 30));
    expect(r.granularity).toBe('hour');
  });
  it('last 30 days covers 30 local days', () => {
    const r = resolveRange({ period: '30d' }, 'UTC', 0, now);
    expect(r.from).toBe(startOfDay(now, 'UTC') - 29 * 86_400_000);
    expect(bucketLabels(r, 0)).toHaveLength(30);
  });
  it('custom ranges include the whole last day', () => {
    const r = resolveRange({ period: 'custom', from: '2026-10-01', to: '2026-10-07' }, 'UTC', 0, now);
    expect(r.to - r.from).toBe(7 * 86_400_000);
  });
  it('compares a running "today" with the same hours of yesterday', () => {
    const at = Date.UTC(2026, 9, 23, 3, 38);
    const r = resolveRange({ period: 'today' }, 'UTC', 0, at);
    expect(previousRange(r, 'UTC', at)).toEqual({ from: Date.UTC(2026, 9, 22, 0, 0), to: Date.UTC(2026, 9, 22, 3, 38) });
  });
  it('compares a running 7 days with the same stretch a week earlier', () => {
    const at = Date.UTC(2026, 9, 23, 3, 38);
    const r = resolveRange({ period: '7d' }, 'UTC', 0, at);
    expect(previousRange(r, 'UTC', at)).toEqual({ from: r.from - 7 * 86_400_000, to: at - 7 * 86_400_000 });
  });
  it('compares 24h and finished periods with the period right before', () => {
    const at = Date.UTC(2026, 9, 23, 3, 38);
    const h = resolveRange({ period: '24h' }, 'UTC', 0, at);
    expect(previousRange(h, 'UTC', at)).toEqual({ from: at - 48 * 3_600_000, to: at - 24 * 3_600_000 });
    const y = resolveRange({ period: 'yesterday' }, 'UTC', 0, at);
    expect(previousRange(y, 'UTC', at)).toEqual({ from: Date.UTC(2026, 9, 21), to: Date.UTC(2026, 9, 22) });
  });
  it('keeps local midnights across a daylight saving change', () => {
    const at = Date.UTC(2026, 2, 9, 12, 0);
    const r = resolveRange({ period: 'today' }, 'America/New_York', 0, at);
    const prev = previousRange(r, 'America/New_York', at);
    expect(prev.from).toBe(Date.UTC(2026, 2, 8, 5, 0));
    expect(prev.to - prev.from).toBe(r.to - r.from);
  });
  it('honours hourly for ranges up to a month', () => {
    const r = resolveRange({ period: '30d', granularity: 'hour' }, 'UTC', 0, now);
    expect(r.granularity).toBe('hour');
    expect(bucketLabels(r, 0)).toHaveLength(29 * 24 + 12);
    expect(resolveRange({ period: '7d', granularity: 'hour' }, 'UTC', 0, now).granularity).toBe('hour');
    expect(resolveRange({ period: '90d', granularity: 'hour' }, 'UTC', 0, now).granularity).toBe('day');
  });
  it('weekly buckets start on Monday', () => {
    const r = resolveRange({ period: '30d', granularity: 'week' }, 'UTC', 0, now);
    for (const l of bucketLabels(r, 0)) expect(new Date(l + 'T00:00:00Z').getUTCDay()).toBe(1);
  });
});

describe('Standard Webhooks (Dodo)', () => {
  const key = Buffer.from('super-secret-key-bytes');
  const secret = 'whsec_' + key.toString('base64');
  const body = '{"type":"payment.succeeded"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
  it('accepts a valid signature (also among several)', async () => {
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body)).toBe(true);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,old v1,${sig}` }, body)).toBe(true);
  });
  it('rejects tampering and stale timestamps', async () => {
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body + ' ')).toBe(false);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: String(Number(ts) - 3600), signature: `v1,${sig}` }, body)).toBe(false);
  });
});

describe('retention', () => {
  it('only turns on for a positive whole number of days', () => {
    expect(retentionDays(undefined)).toBeNull();
    expect(retentionDays('')).toBeNull();
    expect(retentionDays('0')).toBeNull();
    expect(retentionDays('-5')).toBeNull();
    expect(retentionDays('7.5')).toBeNull();
    expect(retentionDays('761')).toBe(761);
  });

  it('computes the cutoff in days', () => {
    expect(retentionCutoff(2, 5 * 86_400_000)).toBe(3 * 86_400_000);
  });

  it('runs every cleanup statement with the cutoff, and nothing when unset', async () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    let batches = 0;
    const db = {
      prepare: (sql: string) => ({ bind: (...args: unknown[]) => (calls.push({ sql, args }), { sql, args }) }),
      batch: async () => {
        batches++;
        return [];
      },
    } as unknown as D1Database;
    expect(await purgeOldData(db, undefined, 10 * 86_400_000)).toBeNull();
    expect(batches).toBe(0);
    const cutoff = await purgeOldData(db, '761', 1000 * 86_400_000);
    expect(cutoff).toBe(239 * 86_400_000);
    expect(batches).toBe(1);
    expect(calls.map((c) => c.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'DELETE FROM events',
      'DELETE FROM sessions',
      'DELETE FROM visitors',
      'UPDATE payments SET',
      'DELETE FROM payment_claims',
      'DELETE FROM login_failures',
    ]);
    expect(calls.every((c) => c.args[0] === cutoff)).toBe(true);
  });
});
