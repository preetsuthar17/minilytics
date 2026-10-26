import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(__dirname, '..', 'public', 'js', 'script.js'), 'utf8');

function browser(href: string) {
  const sent: Record<string, any>[] = [];
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const on = (t: string, f: (e: any) => void) => (listeners[t] ||= []).push(f);
  let cookies = '';
  const loc = new URL(href);
  const location = {
    get href() { return loc.href; },
    get pathname() { return loc.pathname; },
    get search() { return loc.search; },
    get hostname() { return loc.hostname; },
    get protocol() { return loc.protocol; },
  };
  const history = {
    pushState: (_s: unknown, _t: string, url: string) => { loc.href = new URL(url, loc.href).href; },
    replaceState: (_s: unknown, _t: string, url: string) => { loc.href = new URL(url, loc.href).href; },
  };
  const timers: (() => void)[] = [];
  const document = {
    currentScript: { src: 'https://stats.example.com/js/script.js', getAttribute: (n: string) => (n === 'data-website-id' ? 'site0001' : null), hasAttribute: () => false },
    get cookie() { return cookies; },
    set cookie(v: string) { const [kv] = v.split(';'); if (!/max-age=0/.test(v)) cookies = (cookies ? cookies + '; ' : '') + kv; },
    referrer: '',
    visibilityState: 'visible',
    readyState: 'complete',
    addEventListener: on,
    querySelectorAll: () => [],
    documentElement: {},
  };
  const window: Record<string, any> = {
    location, history, document,
    navigator: {},
    screen: { width: 1440 },
    addEventListener: on,
    fetch: (_u: string, o: { body: string }) => (sent.push(JSON.parse(o.body)), Promise.resolve()),
    setTimeout: (f: () => void) => timers.push(f),
    setInterval: () => 0,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URL, URLSearchParams, JSON, Date, Math, String, Object, RegExp, Blob,
  };
  window.window = window;
  runInNewContext(source, window);
  const flush = () => { while (timers.length) timers.shift()!(); };
  const fire = (t: string, e: any = {}) => (listeners[t] || []).forEach((f) => f(e));
  return { sent, history, flush, fire, views: () => sent.filter((b) => b.t === 'pageview') };
}

describe('tracker', () => {
  it('does not log a second view when replaceState only strips the query', () => {
    const b = browser('https://example.com/thanks?payment_id=pay_123&status=ok');
    b.history.replaceState(null, '', '/thanks');
    b.flush();
    expect(b.views()).toHaveLength(1);
    b.history.pushState(null, '', '/pricing');
    b.flush();
    expect(b.views()).toHaveLength(2);
  });

  it('counts a back/forward cache restore as a new view', () => {
    const b = browser('https://example.com/');
    b.fire('pageshow', { persisted: false });
    expect(b.views()).toHaveLength(1);
    b.fire('pageshow', { persisted: true });
    expect(b.views()).toHaveLength(2);
  });

  it('strips private params and the hash from the sent URL', () => {
    const b = browser('https://example.com/join?invite=abc&otp=1&sig=x&signature=y&jwt=z&claim=c&utm_source=x#access_token=secret');
    expect(b.views()[0].u).toBe('https://example.com/join?utm_source=x');
  });
});
