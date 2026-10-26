import { describe, expect, it } from 'vitest';
import { detectAgent, ipInRanges, parseCidrs, requestKind } from '../src/shared/agents';
import { classify } from '../src/shared/sources';
import { aiBreakdown, aiOverview, recordHits, refreshIpLists } from '../src/worker/agents';
import type { Site } from '../src/worker/env';
import worker from '../src/worker/index';
import { analyzeAnswer, brandTerms, runDuePrompts, runPrompt, ENGINES } from '../src/worker/monitor';
import { testDb } from './d1';

const site = { id: 'site0001', name: 'HextaUI', domain: 'hextaui.com', timezone: 'UTC', currency: 'USD', api_key: 'ml_testkey123', created_at: 0 } as Site;
const T0 = Date.UTC(2026, 9, 20, 12);
const ctxOf = (d1: D1Database) => ({ db: d1, site, range: { from: T0 - 86_400_000, to: T0 + 86_400_000, granularity: 'day' as const }, filters: {}, offset: 0, now: T0 + 86_400_000 });

const UA = {
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  claudeCode: 'Claude-User (claude-code/2.1.0; +https://support.anthropic.com/)',
  claudeUser: 'Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

describe('agent detection', () => {
  it('names AI crawlers, assistants and coding agents', () => {
    expect(detectAgent({ ua: UA.chatgptUser })).toMatchObject({ name: 'ChatGPT', operator: 'OpenAI', category: 'assistant', ips: 'openai-user' });
    expect(detectAgent({ ua: UA.gptbot })).toMatchObject({ name: 'GPTBot', category: 'training' });
    expect(detectAgent({ ua: UA.claudeCode })).toMatchObject({ name: 'Claude Code', category: 'coding' });
    expect(detectAgent({ ua: UA.claudeUser })).toMatchObject({ name: 'Claude', category: 'assistant' });
    expect(detectAgent({ ua: 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)' })).toMatchObject({ name: 'OAI-SearchBot', category: 'search' });
    expect(detectAgent({ ua: 'Mozilla/5.0 (compatible; PerplexityBot/1.0)' })).toMatchObject({ name: 'PerplexityBot', category: 'search' });
    expect(detectAgent({ ua: 'Perplexity-User/1.0' })).toMatchObject({ name: 'Perplexity', category: 'assistant' });
  });

  it('treats signed requests as agents and ignores people and ordinary search bots', () => {
    expect(detectAgent({ ua: UA.chrome, signatureAgent: '"https://chatgpt.com"' })).toMatchObject({ name: 'ChatGPT agent', category: 'agent', signed: true });
    expect(detectAgent({ ua: UA.chrome })).toBeNull();
    expect(detectAgent({ ua: UA.googlebot })).toBeNull();
  });

  it('counts plain HTTP clients, and registry fetches by them as coding tools', () => {
    expect(detectAgent({ ua: 'node', kind: 'registry' })).toMatchObject({ name: 'Node.js client', category: 'coding' });
    expect(detectAgent({ ua: 'python-requests/2.32' })).toMatchObject({ name: 'Python client', category: 'other' });
    expect(detectAgent({ ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/141.0 Safari/537.36' })).toMatchObject({ name: 'Headless browser' });
  });

  it('knows what was requested', () => {
    expect(requestKind('/llms.txt')).toBe('llms_txt');
    expect(requestKind('/robots.txt')).toBe('robots');
    expect(requestKind('/r/button.json')).toBe('registry');
    expect(requestKind('/docs/button.md')).toBe('markdown');
    expect(requestKind('/docs/button', 'text/markdown, text/html;q=0.5')).toBe('markdown');
    expect(requestKind('/sitemap.xml')).toBe('sitemap');
    expect(requestKind('/og.png')).toBe('asset');
    expect(requestKind('/docs/button')).toBe('page');
  });

  it('matches IPv4 and IPv6 ranges', () => {
    const cidrs = parseCidrs('{"prefixes":[{"ipv4Prefix":"23.98.142.176/28"},{"ipv6Prefix":"2001:4860:4801:10::/64"}]}');
    expect(cidrs).toEqual(['23.98.142.176/28', '2001:4860:4801:10::/64']);
    expect(ipInRanges('23.98.142.180', cidrs)).toBe(true);
    expect(ipInRanges('23.98.142.200', cidrs)).toBe(false);
    expect(ipInRanges('2001:4860:4801:10::abcd', cidrs)).toBe(true);
    expect(ipInRanges('2001:4860:4801:11::1', cidrs)).toBe(false);
    expect(ipInRanges('not-an-ip', cidrs)).toBe(false);
  });

  it('classifies visits from more AI assistants as the AI channel', () => {
    for (const host of ['chat.mistral.ai', 'perplexity.com', 'copilot.com', 'edgeservices.bing.com', 'meta.ai', 'kimi.com']) {
      expect(classify({ referrerDomain: host }).channel).toBe('AI');
    }
    expect(classify({ referrerDomain: 'www.bing.com' }).source).toBe('Bing');
  });
});

describe('recording and verifying hits', () => {
  async function withRanges() {
    const { d1 } = testDb();
    const fake = (async (url: string) =>
      new Response(String(url).includes('chatgpt-user') ? '{"prefixes":[{"ipv4Prefix":"23.98.142.176/28"}]}' : '{"prefixes":[]}')) as unknown as typeof fetch;
    const out = await refreshIpLists(d1, T0, fake);
    return { d1, out };
  }

  it('stores AI hits, verifies them against published ranges and skips people', async () => {
    const { d1, out } = await withRanges();
    expect(out['openai-user']).toBe(1);
    expect(out.anthropic).toBe('no ranges found');
    const n = await recordHits(
      d1,
      site,
      [
        { url: 'https://hextaui.com/docs/button?x=1', ua: UA.chatgptUser, ip: '23.98.142.177' },
        { url: 'https://hextaui.com/docs/input', ua: UA.chatgptUser, ip: '1.2.3.4' },
        { path: '/r/button.json', ua: 'node' },
        { path: '/', ua: UA.chrome },
        { path: '/llms.txt', ua: UA.claudeCode },
      ],
      'server',
      T0,
    );
    expect(n).toBe(4);
    const rows = (await d1.prepare('SELECT agent, category, kind, path, verified FROM agent_hits ORDER BY id').all()).results;
    expect(rows).toEqual([
      { agent: 'ChatGPT', category: 'assistant', kind: 'page', path: '/docs/button', verified: 1 },
      { agent: 'ChatGPT', category: 'assistant', kind: 'page', path: '/docs/input', verified: 0 },
      { agent: 'Node.js client', category: 'coding', kind: 'registry', path: '/r/button.json', verified: null },
      { agent: 'Claude Code', category: 'coding', kind: 'llms_txt', path: '/llms.txt', verified: null },
    ]);

    const ov = await aiOverview(ctxOf(d1), {});
    expect(ov.current).toMatchObject({ assistant: 2, coding: 2, total: 4, spoofed: 1, pages_read: 2 });
    expect(ov.serverConnected).toBe(true);
    const agents = await aiBreakdown(ctxOf(d1), {}, 'agent', undefined);
    expect(agents[0]).toMatchObject({ label: 'ChatGPT', hits: 2, verified: 1, spoofed: 1, extra: 'OpenAI' });
    const installs = await aiBreakdown(ctxOf(d1), {}, 'path', 'installs');
    expect(installs).toMatchObject([{ label: '/r/button.json', hits: 1, extra: 'Node.js client' }]);
    const answers = await aiBreakdown(ctxOf(d1), { agent: 'ChatGPT' }, 'path', 'answers');
    expect(answers.map((r) => r.label).sort()).toEqual(['/docs/button', '/docs/input']);
  });
});

describe('agent endpoints', () => {
  function app() {
    const { d1, raw } = testDb();
    raw
      .prepare("INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES ('site0001', 'HextaUI', 'hextaui.com', 'UTC', 'USD', 'ml_testkey123', 0)")
      .run();
    const env = { DB: d1, SESSION_SECRET: 's', ADMIN_PASSWORD: 'pw', ASSETS: { fetch: async () => new Response('') } };
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p.catch(() => {})), passThroughOnException() {} } as unknown as ExecutionContext;
    const call = (path: string, init: RequestInit) => worker.fetch(new Request('http://localhost' + path, init), env as never, ctx);
    return { call, d1 };
  }

  it('accepts hits from the middleware with the site API key', async () => {
    const a = app();
    const bad = await a.call('/api/v1/agents', { method: 'POST', headers: { authorization: 'Bearer ml_wrongkey00' }, body: '{}' });
    expect(bad.status).toBe(401);
    const res = await a.call('/api/v1/agents', {
      method: 'POST',
      headers: { authorization: 'Bearer ml_testkey123' },
      body: JSON.stringify({ hits: [{ url: 'https://hextaui.com/docs', ua: UA.gptbot }, { url: 'https://hextaui.com/', ua: UA.chrome }] }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, recorded: 1 });
  });

  it('sends automated browsers and AI bots running the script to the AI section, not visitor stats', async () => {
    const a = app();
    const post = (body: object, ua: string, extra: Record<string, string> = {}) =>
      a.call('/api/event', { method: 'POST', headers: { 'user-agent': ua, ...extra }, body: JSON.stringify({ w: 'site0001', ...body }) });
    expect((await post({ t: 'agent', u: 'https://hextaui.com/pricing' }, UA.chrome)).status).toBe(202);
    expect((await post({ t: 'pageview', u: 'https://hextaui.com/', vid: 'visitor0001', sid: 'session0001' }, UA.chrome, { 'signature-agent': '"https://chatgpt.com"' })).status).toBe(202);
    expect((await post({ t: 'pageview', u: 'https://hextaui.com/', vid: 'visitor0002', sid: 'session0002' }, UA.googlebot)).status).toBe(202);
    expect((await post({ t: 'agent', u: 'https://evil.com/' }, UA.chrome)).status).toBe(403);
    const hits = (await a.d1.prepare('SELECT agent, category, via, signed FROM agent_hits ORDER BY id').all()).results;
    expect(hits).toEqual([
      { agent: 'Automated browser', category: 'agent', via: 'script', signed: 0 },
      { agent: 'ChatGPT agent', category: 'agent', via: 'script', signed: 1 },
    ]);
    expect((await a.d1.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())?.n).toBe(0);
  });
});

describe('prompt monitoring', () => {
  it('detects mentions and ranks the site among cited sources', () => {
    const terms = brandTerms({ ...site, ai_brand_terms: null });
    expect(terms).toEqual(['HextaUI']);
    const cites = [
      { url: 'https://ui.shadcn.com/docs', title: 'shadcn' },
      { url: 'https://ui.shadcn.com/blocks', title: 'shadcn blocks' },
      { url: 'https://www.hextaui.com/docs/button', title: 'Button' },
    ];
    expect(analyzeAnswer('Try Hexta UI or shadcn/ui.', cites, terms, 'hextaui.com')).toEqual({ mentioned: true, cited: true, position: 2 });
    expect(analyzeAnswer('Use shadcn/ui.', cites.slice(0, 1), terms, 'hextaui.com')).toEqual({ mentioned: false, cited: false, position: null });
    // Gemini: redirect links, publisher domain in the title.
    expect(analyzeAnswer('x', [{ url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'hextaui.com' }], terms, 'hextaui.com').cited).toBe(true);
  });

  it('asks every configured assistant and stores what each said', async () => {
    const { d1 } = testDb();
    await d1.prepare("INSERT INTO ai_prompts (id, site_id, prompt, created_at) VALUES ('p1', 'site0001', 'best react ui library', 0)").run();
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
      if (url.includes('api.openai.com')) {
        expect(JSON.parse(String(init?.body)).tools).toEqual([{ type: 'web_search' }]);
        return json({ model: 'gpt-test', output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: 'HextaUI is great', annotations: [{ type: 'url_citation', url: 'https://hextaui.com/', title: 'HextaUI' }] }] }] });
      }
      if (url.includes('api.anthropic.com')) {
        const body = JSON.parse(String(init?.body));
        expect(body.tools[0].type).toBe('web_search_20260209');
        expect(body.fallbacks).toBe('default');
        return json({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          content: [
            { type: 'web_search_tool_result', tool_use_id: 't', content: [{ type: 'web_search_result', url: 'https://ui.shadcn.com/', title: 'shadcn' }] },
            { type: 'text', text: 'Consider shadcn/ui.', citations: [{ type: 'web_search_result_location', url: 'https://ui.shadcn.com/', title: 'shadcn', cited_text: 'x', encrypted_index: 'e' }] },
          ],
        });
      }
      if (url.includes('api.perplexity.ai')) {
        return json({ model: 'sonar', output: [{ type: 'search_results', results: [{ id: 1, url: 'https://a.com', title: 'A' }, { id: 2, url: 'https://hextaui.com/x', title: 'H' }] }, { type: 'message', content: [{ type: 'output_text', text: 'See hexta-ui [2].' }] }] });
      }
      return new Response('{"error":{"message":"quota"}}', { status: 429 });
    }) as unknown as typeof fetch;
    const env = { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', PERPLEXITY_API_KEY: 'k', GEMINI_API_KEY: 'k' } as never;
    const results = await runPrompt(d1, env, site, { id: 'p1', prompt: 'best react ui library' }, ENGINES, () => T0, fake);
    expect(results.map(({ engine, mentioned, cited, position, error }) => ({ engine, mentioned, cited, position, error: !!error }))).toEqual([
      { engine: 'chatgpt', mentioned: true, cited: true, position: 1, error: false },
      { engine: 'claude', mentioned: false, cited: false, position: null, error: false },
      { engine: 'perplexity', mentioned: true, cited: true, position: 1, error: false },
      { engine: 'gemini', mentioned: false, cited: false, position: null, error: true },
    ]);
    const stored = await d1.prepare('SELECT engine, citations, error FROM ai_prompt_runs ORDER BY engine').all<{ engine: string; citations: string; error: string | null }>();
    expect(stored.results.find((r) => r.engine === 'gemini')?.error).toContain('HTTP 429: quota');
    expect(JSON.parse(stored.results.find((r) => r.engine === 'perplexity')!.citations)).toEqual([{ url: 'https://hextaui.com/x', title: 'H' }]);
  });

  it('only re-asks prompts that are due', async () => {
    const { d1 } = testDb();
    await d1
      .prepare("INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, ai_monitor_days) VALUES ('site0001', 'HextaUI', 'hextaui.com', 'UTC', 'USD', 'k', 0, 7)")
      .run();
    await d1.prepare("INSERT INTO ai_prompts (id, site_id, prompt, created_at) VALUES ('p1', 'site0001', 'q1', 0), ('p2', 'site0001', 'q2', 0)").run();
    await d1.prepare("INSERT INTO ai_prompt_runs (site_id, prompt_id, engine, ts) VALUES ('site0001', 'p1', 'chatgpt', ?)").bind(T0 - 86_400_000).run();
    expect(await runDuePrompts(d1, {} as never, 6, T0)).toBe(0); // no API keys: nothing to do
    const asked: string[] = [];
    const env = { OPENAI_API_KEY: 'k' } as never;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      asked.push(JSON.parse(String(init.body)).input);
      return new Response(JSON.stringify({ output: [] }));
    }) as never;
    try {
      expect(await runDuePrompts(d1, env, 6, T0)).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(asked).toEqual(['q2']);
  });
});
