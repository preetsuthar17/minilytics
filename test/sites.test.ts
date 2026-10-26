import { describe, expect, it } from 'vitest';
import { getSite } from '../src/worker/env';
import worker from '../src/worker/index';
import { signToken } from '../src/worker/lib/crypto';
import { testDb } from './d1';

function app() {
  const { d1, raw } = testDb();
  raw
    .prepare("INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES ('cachesite1', 'C', 'example.com', 'UTC', 'USD', 'ml_k', 0)")
    .run();
  let siteReads = 0;
  const db = new Proxy(d1, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => (/FROM sites\b[\s\S]*WHERE (s\.)?id = \?/.test(sql) && siteReads++, target.prepare(sql));
      return Reflect.get(target, prop);
    },
  });
  const env = { DB: db, SESSION_SECRET: 'test-secret', ADMIN_PASSWORD: 'pw', ASSETS: { fetch: async () => new Response('') } };
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const call = async (path: string, init: RequestInit = {}, auth = true) => {
    const cookie = auth ? `ml_auth=${await signToken('test-secret', `admin.${Date.now() + 60_000}`)}` : '';
    return worker.fetch(new Request('http://localhost' + path, { ...init, headers: { cookie, 'content-type': 'application/json' } }), env as never, ctx);
  };
  return { call, reads: () => siteReads, d1 };
}

describe('site lookup', () => {
  it('serves stats reads from the cache but still needs login', async () => {
    const a = app();
    expect((await a.call('/api/sites/cachesite1/overview?period=today')).status).toBe(200);
    expect((await a.call('/api/sites/cachesite1/customers?period=today')).status).toBe(200);
    expect(a.reads()).toBe(1);
    expect((await a.call('/api/sites/cachesite1/overview?period=today', {}, false)).status).toBe(401);
  });

  it('reads settings and writes fresh and drops the cache after a change', async () => {
    const a = app();
    await a.call('/api/sites/cachesite1/overview?period=today');
    const before = a.reads();
    expect(((await (await a.call('/api/sites/cachesite1')).json()) as { name: string }).name).toBe('C');
    await a.call('/api/sites/cachesite1', { method: 'PATCH', body: JSON.stringify({ timezone: 'Asia/Kolkata' }) });
    expect(a.reads()).toBe(before + 2);
    expect((await getSite(a.d1, 'cachesite1'))?.timezone).toBe('Asia/Kolkata');
  });

  it('does not cache unknown sites', async () => {
    const a = app();
    expect((await a.call('/api/sites/nosuchsite/overview')).status).toBe(404);
    expect((await a.call('/api/sites/nosuchsite/overview')).status).toBe(404);
    expect(a.reads()).toBe(2);
  });
});
