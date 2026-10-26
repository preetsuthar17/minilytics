import Anthropic from '@anthropic-ai/sdk';
import { isAdminEmail, isHosted } from './auth';
import type { Env, Site } from './env';

/**
 * Prompt monitoring: ask AI assistants (with web search on, like their apps) the questions your customers ask,
 * and record whether the answer mentions your brand and cites your site.
 * Each engine runs when its API key is set as a Worker secret.
 */

export type EngineId = 'chatgpt' | 'claude' | 'perplexity' | 'gemini';

export interface Citation {
  url: string;
  title?: string;
}

export interface EngineAnswer {
  model: string;
  answer: string;
  citations: Citation[];
}

interface Engine {
  id: EngineId;
  label: string;
  domain: string;
  secret: keyof Env;
  model: (env: Env) => string;
  run: (env: Env, prompt: string, fetcher: typeof fetch) => Promise<EngineAnswer>;
}

const TIMEOUT_MS = 120_000;

async function postJson(fetcher: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = data?.error?.message ?? data?.error ?? data?.message ?? text.slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`.slice(0, 400));
  }
  if (data === null) throw new Error('response was not JSON');
  return data;
}

const dedupe = (cs: Citation[]) => {
  const seen = new Set<string>();
  return cs.filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));
};

/** OpenAI Responses API with the web_search tool (what ChatGPT search uses). */
const chatgpt: Engine = {
  id: 'chatgpt',
  label: 'ChatGPT',
  domain: 'chatgpt.com',
  secret: 'OPENAI_API_KEY',
  model: (env) => env.OPENAI_MODEL || 'gpt-6-astra',
  async run(env, prompt, fetcher) {
    const model = this.model(env);
    const data = await postJson(
      fetcher,
      'https://api.openai.com/v1/responses',
      { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      { model, input: prompt, tools: [{ type: 'web_search' }], max_output_tokens: 16000 },
    );
    const items: any[] = Array.isArray(data) ? data : (data.output ?? []);
    let answer = '';
    const citations: Citation[] = [];
    for (const item of items) {
      if (item?.type !== 'message') continue;
      for (const part of item.content ?? []) {
        if (part?.type !== 'output_text') continue;
        answer += (answer ? '\n\n' : '') + (part.text ?? '');
        for (const a of part.annotations ?? []) if (a?.type === 'url_citation' && a.url) citations.push({ url: a.url, title: a.title });
      }
    }
    return { model: data.model ?? model, answer, citations: dedupe(citations) };
  },
};

/** Claude with the server-side web search tool. */
const claude: Engine = {
  id: 'claude',
  label: 'Claude',
  domain: 'claude.ai',
  secret: 'ANTHROPIC_API_KEY',
  model: (env) => env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  async run(env, prompt, fetcher) {
    const model = this.model(env);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, fetch: fetcher, timeout: TIMEOUT_MS, maxRetries: 1 });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
    let answer = '';
    const cited: Citation[] = [];
    const consulted: Citation[] = [];
    let served = model;
    // A long search turn can pause; resume it by sending the paused turn back (a few times at most).
    for (let i = 0; i < 4; i++) {
      const res = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        messages,
      });
      served = res.model;
      if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer this prompt');
      for (const block of res.content) {
        if (block.type === 'text') {
          answer += block.text;
          for (const c of block.citations ?? []) {
            if (c.type === 'web_search_result_location' && c.url) cited.push({ url: c.url, title: c.title ?? undefined });
          }
        } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === 'web_search_result') consulted.push({ url: r.url, title: r.title });
        }
      }
      if (res.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: res.content });
    }
    return { model: served, answer: answer.trim(), citations: dedupe(cited.length ? cited : consulted) };
  },
};

/** Perplexity Agent API (Sonar chat completions were retired in September 2026). */
const perplexity: Engine = {
  id: 'perplexity',
  label: 'Perplexity',
  domain: 'perplexity.ai',
  secret: 'PERPLEXITY_API_KEY',
  model: (env) => env.PERPLEXITY_MODEL || 'default',
  async run(env, prompt, fetcher) {
    const body: Record<string, unknown> = { input: prompt, effort: 'fast' };
    if (env.PERPLEXITY_MODEL) body.model = env.PERPLEXITY_MODEL;
    const data = await postJson(fetcher, 'https://api.perplexity.ai/v1/agent', { authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, body);
    const items: any[] = data.output ?? [];
    let answer = typeof data.output_text === 'string' ? data.output_text : '';
    const results: (Citation & { id?: unknown })[] = [];
    const annotated: Citation[] = [];
    for (const item of items) {
      if (item?.type === 'search_results') {
        for (const r of item.results ?? []) if (r?.url) results.push({ id: r.id, url: r.url, title: r.title });
      } else if (item?.type === 'message' && !answer) {
        for (const part of item.content ?? []) {
          if (typeof part?.text === 'string') answer += part.text;
          for (const a of part?.annotations ?? []) if (a?.url) annotated.push({ url: a.url, title: a.title });
        }
      }
    }
    // Sources are referenced inline as [1][3]; keep the ones the answer actually cites when it says so.
    const refs = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => m[1]));
    const citedResults = refs.size ? results.filter((r, i) => refs.has(String(r.id ?? i + 1))) : results;
    const citations = annotated.length ? annotated : citedResults.length ? citedResults : results;
    return { model: data.model ?? this.model(env), answer, citations: dedupe(citations.map(({ url, title }) => ({ url, title }))) };
  },
};

/** Gemini with Grounding with Google Search. */
const gemini: Engine = {
  id: 'gemini',
  label: 'Gemini',
  domain: 'gemini.google.com',
  secret: 'GEMINI_API_KEY',
  model: (env) => env.GEMINI_MODEL || 'gemini-3.8-flash',
  async run(env, prompt, fetcher) {
    const model = this.model(env);
    const data = await postJson(
      fetcher,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': String(env.GEMINI_API_KEY) },
      { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] },
    );
    const cand = data.candidates?.[0];
    const answer = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('');
    const meta = cand?.groundingMetadata ?? {};
    const chunks: Citation[] = (meta.groundingChunks ?? []).map((c: any) => ({ url: c?.web?.uri ?? '', title: c?.web?.title }));
    // groundingSupports tie sentences of the answer to chunks; prefer the chunks that back the answer.
    const used = new Set<number>();
    for (const s of meta.groundingSupports ?? []) for (const i of s?.groundingChunkIndices ?? []) used.add(i);
    const citations = used.size ? chunks.filter((_, i) => used.has(i)) : chunks;
    return { model: data.modelVersion ?? model, answer, citations: dedupe(citations) };
  },
};

export const ENGINES: Engine[] = [chatgpt, claude, perplexity, gemini];

export function configuredEngines(env: Env) {
  return ENGINES.filter((e) => !!env[e.secret]);
}

export function engineInfo(env: Env) {
  return ENGINES.map((e) => ({ id: e.id, label: e.label, domain: e.domain, configured: !!env[e.secret], secret: e.secret, model: e.model(env) }));
}

// ---------- reading an answer

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Names that count as a mention: the saved brand terms, else the site name and the domain without its TLD. */
export function brandTerms(site: Pick<Site, 'name' | 'domain'> & { ai_brand_terms?: string | null }): string[] {
  const saved = (site.ai_brand_terms ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (saved.length) return saved;
  const root = site.domain.replace(/^www\./, '').split('.')[0];
  const out: string[] = [];
  for (const t of [site.name, root]) if (t && squash(t).length >= 3 && !out.some((o) => squash(o) === squash(t))) out.push(t);
  return out;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isOwn(c: Citation, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '');
  const owns = (h: string | null | undefined) => !!h && (h === d || h.endsWith('.' + d));
  // Gemini links go through a Google redirect, but the title is the publisher's domain.
  return owns(hostOf(c.url)) || owns(c.title?.toLowerCase().trim().replace(/^www\./, ''));
}

/** Did the answer mention the brand, cite the site, and where did the site rank among the sources? */
export function analyzeAnswer(answer: string, citations: Citation[], terms: string[], domain: string) {
  const text = squash(answer);
  const mentioned = terms.some((t) => squash(t).length >= 3 && text.includes(squash(t))) || answer.toLowerCase().includes(domain.toLowerCase());
  // Rank by distinct source sites, so three links to one competitor count as one place.
  const sites: string[] = [];
  let position: number | null = null;
  for (const c of citations) {
    const host = hostOf(c.url);
    const redirect = !host || host.endsWith('vertexaisearch.cloud.google.com');
    const key = isOwn(c, domain) ? '__own__' : ((redirect ? c.title?.toLowerCase() : host) ?? c.url);
    if (!sites.includes(key)) sites.push(key);
    if (key === '__own__' && position === null) position = sites.length;
  }
  return { mentioned, cited: position !== null, position };
}

// ---------- running prompts

/** Hosted mode: the API keys are the operator's, so only the operator's own sites are monitored. */
export function monitorAllowed(env: Env, site: Site & { owner_email?: string | null }) {
  return !isHosted(env) || !site.owner_id || isAdminEmail(env, site.owner_email);
}

export interface RunResult {
  engine: EngineId;
  model: string | null;
  mentioned: boolean;
  cited: boolean;
  position: number | null;
  error: string | null;
}

/** Ask one prompt on the given engines and store the answers. */
export async function runPrompt(
  db: D1Database,
  env: Env,
  site: Site & { ai_brand_terms?: string | null },
  prompt: { id: string; prompt: string },
  engines = configuredEngines(env),
  now = () => Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<RunResult[]> {
  const terms = brandTerms(site);
  return Promise.all(
    engines.map(async (e): Promise<RunResult> => {
      let row: RunResult;
      let answer: string | null = null;
      let citations: Citation[] = [];
      try {
        const r = await e.run(env, prompt.prompt, fetcher);
        answer = r.answer;
        citations = r.citations.slice(0, 50);
        const a = analyzeAnswer(r.answer, citations, terms, site.domain);
        row = { engine: e.id, model: r.model, ...a, error: null };
      } catch (err) {
        row = { engine: e.id, model: e.model(env), mentioned: false, cited: false, position: null, error: String((err as Error)?.message ?? err).slice(0, 500) };
      }
      await db
        .prepare(
          `INSERT INTO ai_prompt_runs (site_id, prompt_id, engine, model, ts, mentioned, cited, position, answer, citations, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          site.id,
          prompt.id,
          e.id,
          row.model,
          now(),
          row.mentioned ? 1 : 0,
          row.cited ? 1 : 0,
          row.position,
          answer?.slice(0, 20_000) ?? null,
          JSON.stringify(citations),
          row.error,
        )
        .run();
      return row;
    }),
  );
}

/**
 * Cron: re-ask prompts whose last answer is older than the site's interval, a few at a time so a run
 * stays well inside the Worker's limits. Anything left over is picked up by the next hourly run.
 */
export async function runDuePrompts(db: D1Database, env: Env, maxPrompts = 6, now = Date.now()) {
  const engines = configuredEngines(env);
  if (!engines.length) return 0;
  const rows = await db
    .prepare(
      `SELECT p.id, p.prompt, p.site_id, s.ai_monitor_days AS days,
              (SELECT MAX(r.ts) FROM ai_prompt_runs r WHERE r.site_id = p.site_id AND r.prompt_id = p.id) AS last
       FROM ai_prompts p JOIN sites s ON s.id = p.site_id
       WHERE s.ai_monitor_days > 0
       ORDER BY last IS NOT NULL, last
       LIMIT 200`,
    )
    .all<{ id: string; prompt: string; site_id: string; days: number; last: number | null }>();
  const due = rows.results.filter((r) => !r.last || r.last < now - r.days * 86_400_000 + 3_600_000).slice(0, maxPrompts);
  let ran = 0;
  for (const p of due) {
    const site = await db
      .prepare('SELECT s.*, u.email AS owner_email FROM sites s LEFT JOIN users u ON u.id = s.owner_id WHERE s.id = ?')
      .bind(p.site_id)
      .first<Site & { ai_brand_terms: string | null; owner_email: string | null }>();
    if (!site || !monitorAllowed(env, site)) continue;
    await runPrompt(db, env, site, p, engines);
    ran++;
  }
  return ran;
}
