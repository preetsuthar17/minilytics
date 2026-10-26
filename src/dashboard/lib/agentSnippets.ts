/**
 * Server-side snippets that report AI crawlers, assistants and agents (they don't run JavaScript, so the script
 * never sees them). The filter here is deliberately loose; the Minilytics server decides what's actually AI.
 */

export function trackAgentFile(origin: string): string {
  return `// lib/minilytics-agents.ts — reports AI crawlers, assistants and agents to Minilytics.
// They don't run JavaScript, so this runs on the server. Never blocks or slows the response.
const ENDPOINT = '${origin}/api/v1/agents';

// Anything that isn't plainly a person's browser, plus files only agents ask for. Minilytics sorts out the rest.
const MAYBE_AGENT = /bot|crawl|spider|agent|fetch|-user|claude|openai|gpt|perplexity|gemini|cursor|codex|copilot|headless|python|node|curl|wget|go-http|java|okhttp|axios|undici|ruby|rust|scrapy/i;
const AGENT_PATH = /^\\/(llms(-full)?\\.txt|robots\\.txt|r\\/.+\\.json)$|\\.mdx?$/;

export function trackAgent(
  request: Request,
  waitUntil: (p: Promise<unknown>) => void,
  apiKey: string | undefined,
  status?: number,
) {
  if (!apiKey) return;
  const h = request.headers;
  const ua = h.get('user-agent') ?? '';
  const accept = h.get('accept') ?? '';
  const signature = h.get('signature-agent');
  const path = new URL(request.url).pathname;
  if (!signature && !MAYBE_AGENT.test(ua) && ua.startsWith('Mozilla/') && !AGENT_PATH.test(path) && !accept.includes('text/markdown')) return;
  waitUntil(
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: \`Bearer \${apiKey}\`, 'content-type': 'application/json' },
      body: JSON.stringify({
        url: request.url,
        ua,
        accept,
        status,
        signature_agent: signature,
        ip: h.get('cf-connecting-ip') ?? h.get('x-real-ip') ?? h.get('x-forwarded-for'),
        country: h.get('cf-ipcountry') ?? h.get('x-vercel-ip-country'),
        referer: h.get('referer'),
      }),
    }).catch(() => {}),
  );
}`;
}

export function nextMiddleware(): string {
  return `// middleware.ts (proxy.ts on Next.js 16) — works on Cloudflare (OpenNext), Vercel and Node.
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { trackAgent } from './lib/minilytics-agents';

export function middleware(request: NextRequest, event: NextFetchEvent) {
  trackAgent(request, (p) => event.waitUntil(p), process.env.MINILYTICS_API_KEY);
  return NextResponse.next();
}

// Run on pages, markdown, llms.txt, robots.txt and the registry, not on build assets.
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };

// Already have a middleware? Keep it and add the trackAgent(...) line at the top of it.`;
}

export function workerWrapper(): string {
  return `// Any app on Cloudflare Workers (TanStack Start, Remix, Astro, Hono…): wrap the worker's fetch.
// Point "main" in wrangler.jsonc at this file. This version also records the response status.
import app from './server'; // your current entry (TanStack Start: '@tanstack/react-start/server-entry')
import { trackAgent } from './lib/minilytics-agents';

export default {
  async fetch(request: Request, env: { MINILYTICS_API_KEY?: string }, ctx: ExecutionContext) {
    const response = await app.fetch(request, env, ctx);
    trackAgent(request, (p) => ctx.waitUntil(p), env.MINILYTICS_API_KEY, response.status);
    return response;
  },
};`;
}

/** Instructions for the owner's coding AI (appended to the setup prompt). */
export function agentPromptTask(origin: string): string {
  return `## Task 5 — Report AI crawlers, assistants and agents (server-side)
ChatGPT, Claude, Perplexity, AI crawlers (GPTBot, ClaudeBot…) and coding agents fetch pages without running JavaScript, so the script can't see them. Add this server-side hook so Minilytics can show which AI tools read the site:
1. Create this file (adjust the path to the project's conventions):
${trackAgentFile(origin)}
2. Call trackAgent(request, waitUntil, process.env.MINILYTICS_API_KEY) for every request that isn't a build asset:
   - Next.js (any host, including Cloudflare via OpenNext): in middleware.ts / proxy.ts (merge into an existing middleware if there is one):
${nextMiddleware()}
   - Other frameworks on Cloudflare Workers (e.g. TanStack Start): wrap the worker entry's fetch:
${workerWrapper()}
   - Plain Node servers (Express/Fastify): call it in a middleware with waitUntil = (p) => p.
3. Add MINILYTICS_API_KEY to .env.example (and env typings) with an empty value. The real key is in Minilytics → Settings → "Server-side API"; I'll set it as a secret myself. Never commit it.
Static files served straight from a CDN (robots.txt, llms.txt in /public) may skip middleware; that's fine, but if they're routed through the app they'll be counted too.`;
}
