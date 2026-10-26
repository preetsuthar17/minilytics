// AI crawlers, AI assistants and agents. Shared by the worker (to classify requests) and the dashboard (labels, icons).

export type AgentCategory = 'assistant' | 'search' | 'training' | 'coding' | 'agent' | 'other';

export const CATEGORY_LABELS: Record<AgentCategory, string> = {
  assistant: 'AI answers',
  search: 'AI search indexing',
  training: 'AI training',
  coding: 'Coding agents',
  agent: 'Browser agents',
  other: 'Scripts & scrapers',
};

/** One line on what each category means, shown in the dashboard. */
export const CATEGORY_HINTS: Record<AgentCategory, string> = {
  assistant: 'An assistant fetched the page live while answering someone — your site was read for (and usually cited in) an answer.',
  search: 'Crawled into an AI search index, so assistants can find and cite it later.',
  training: 'Crawled to train AI models.',
  coding: 'Coding agents and CLIs (Claude Code, Cursor, Codex, shadcn…) reading docs or installing components.',
  agent: 'Agents driving a real browser on someone’s behalf.',
  other: 'Generic HTTP clients, headless browsers and unknown tools.',
};

export interface KnownAgent {
  name: string;
  operator: string;
  domain: string; // for the favicon
  category: AgentCategory;
  match: RegExp; // tested against the user agent
  /** Published IP list used to verify the request really comes from the operator (see IP_LISTS). */
  ips?: string;
}

// Order matters: more specific tokens first (Claude Code's fetches say "Claude-User (claude-code/…)").
export const KNOWN_AGENTS: KnownAgent[] = [
  // ---- coding agents & CLIs
  { name: 'Claude Code', operator: 'Anthropic', domain: 'claude.ai', category: 'coding', match: /claude-code|claude-cli/i },
  { name: 'Codex', operator: 'OpenAI', domain: 'openai.com', category: 'coding', match: /codex_cli|codex[-_ ]?(cli|exec|vscode)|\bCodex\//i },
  { name: 'Cursor', operator: 'Cursor', domain: 'cursor.com', category: 'coding', match: /\bCursor\/|cursor-agent/i },
  { name: 'Gemini CLI', operator: 'Google', domain: 'gemini.google.com', category: 'coding', match: /gemini[-_]?cli/i },
  { name: 'GitHub Copilot', operator: 'GitHub', domain: 'github.com', category: 'coding', match: /GitHub-?Copilot|copilot-(chat|agent|cli)/i },
  { name: 'Windsurf', operator: 'Windsurf', domain: 'windsurf.com', category: 'coding', match: /windsurf|codeium/i },
  { name: 'opencode', operator: 'opencode', domain: 'opencode.ai', category: 'coding', match: /opencode/i },
  { name: 'Cline', operator: 'Cline', domain: 'cline.bot', category: 'coding', match: /\bcline\b|roo-?code|kilo-?code/i },
  { name: 'Aider', operator: 'Aider', domain: 'aider.chat', category: 'coding', match: /\baider\b/i },
  { name: 'Devin', operator: 'Cognition', domain: 'devin.ai', category: 'coding', match: /\bDevin\b/i },
  { name: 'v0', operator: 'Vercel', domain: 'v0.dev', category: 'coding', match: /\bv0bot|v0\.dev/i },
  { name: 'shadcn CLI', operator: 'shadcn', domain: 'ui.shadcn.com', category: 'coding', match: /shadcn/i },

  // ---- assistants fetching a page live for a user's question
  { name: 'ChatGPT', operator: 'OpenAI', domain: 'chatgpt.com', category: 'assistant', match: /ChatGPT-User/i, ips: 'openai-user' },
  { name: 'Claude', operator: 'Anthropic', domain: 'claude.ai', category: 'assistant', match: /Claude-User/i, ips: 'anthropic' },
  { name: 'Perplexity', operator: 'Perplexity', domain: 'perplexity.ai', category: 'assistant', match: /Perplexity-User/i, ips: 'perplexity-user' },
  { name: 'Gemini', operator: 'Google', domain: 'gemini.google.com', category: 'assistant', match: /GoogleAgent-URLContext|Google-Gemini|Google-NotebookLM/i, ips: 'google-user' },
  { name: 'Mistral Le Chat', operator: 'Mistral', domain: 'mistral.ai', category: 'assistant', match: /MistralAI-User/i },
  { name: 'DuckDuckGo AI', operator: 'DuckDuckGo', domain: 'duckduckgo.com', category: 'assistant', match: /DuckAssistBot/i },
  { name: 'Meta AI', operator: 'Meta', domain: 'meta.ai', category: 'assistant', match: /meta-externalfetcher/i },
  { name: 'Amazon AI', operator: 'Amazon', domain: 'amazon.com', category: 'assistant', match: /Amzn-User/i },
  { name: 'Kagi Assistant', operator: 'Kagi', domain: 'kagi.com', category: 'assistant', match: /kagi-fetcher/i },
  { name: 'Kimi', operator: 'Moonshot', domain: 'kimi.com', category: 'assistant', match: /Kimi-User/i },
  { name: 'Cohere', operator: 'Cohere', domain: 'cohere.com', category: 'assistant', match: /cohere-ai/i },

  // ---- agents driving a browser
  { name: 'Google Agent', operator: 'Google', domain: 'google.com', category: 'agent', match: /Google-Agent|GoogleAgent-Mariner/i, ips: 'google-user' },
  { name: 'Manus', operator: 'Manus', domain: 'manus.im', category: 'agent', match: /Manus-User|ManusBot/i },
  { name: 'Amazon Nova Act', operator: 'Amazon', domain: 'amazon.com', category: 'agent', match: /NovaAct/i },

  // ---- AI search indexes
  { name: 'OAI-SearchBot', operator: 'OpenAI', domain: 'openai.com', category: 'search', match: /OAI-SearchBot/i, ips: 'openai-search' },
  { name: 'Claude-SearchBot', operator: 'Anthropic', domain: 'claude.ai', category: 'search', match: /Claude-SearchBot/i, ips: 'anthropic' },
  { name: 'PerplexityBot', operator: 'Perplexity', domain: 'perplexity.ai', category: 'search', match: /PerplexityBot/i, ips: 'perplexity-bot' },
  { name: 'MistralAI-Index', operator: 'Mistral', domain: 'mistral.ai', category: 'search', match: /MistralAI-Index/i },
  { name: 'Meta WebIndexer', operator: 'Meta', domain: 'meta.ai', category: 'search', match: /meta-webindexer/i },
  { name: 'Applebot', operator: 'Apple', domain: 'apple.com', category: 'search', match: /Applebot/i, ips: 'applebot' },
  { name: 'Amzn-SearchBot', operator: 'Amazon', domain: 'amazon.com', category: 'search', match: /Amzn-SearchBot/i },
  { name: 'Kimi-SearchBot', operator: 'Moonshot', domain: 'kimi.com', category: 'search', match: /Kimi-SearchBot/i },
  { name: 'Bravebot', operator: 'Brave', domain: 'search.brave.com', category: 'search', match: /Bravebot/i },
  { name: 'ExaBot', operator: 'Exa', domain: 'exa.ai', category: 'search', match: /ExaBot/i },
  { name: 'YouBot', operator: 'You.com', domain: 'you.com', category: 'search', match: /YouBot/i },
  { name: 'PhindBot', operator: 'Phind', domain: 'phind.com', category: 'search', match: /PhindBot/i },

  // ---- training crawlers
  { name: 'GPTBot', operator: 'OpenAI', domain: 'openai.com', category: 'training', match: /GPTBot/i, ips: 'openai-gptbot' },
  { name: 'ClaudeBot', operator: 'Anthropic', domain: 'claude.ai', category: 'training', match: /ClaudeBot|anthropic-ai|Claude-Web/i, ips: 'anthropic' },
  { name: 'CCBot', operator: 'Common Crawl', domain: 'commoncrawl.org', category: 'training', match: /CCBot/i, ips: 'ccbot' },
  { name: 'Google-CloudVertexBot', operator: 'Google', domain: 'cloud.google.com', category: 'training', match: /Google-CloudVertexBot/i },
  { name: 'Meta-ExternalAgent', operator: 'Meta', domain: 'meta.ai', category: 'training', match: /meta-externalagent|FacebookBot/i },
  { name: 'Bytespider', operator: 'ByteDance', domain: 'bytedance.com', category: 'training', match: /Bytespider|TikTokSpider/i },
  { name: 'Amazonbot', operator: 'Amazon', domain: 'amazon.com', category: 'training', match: /Amazonbot/i },
  { name: 'MistralAI', operator: 'Mistral', domain: 'mistral.ai', category: 'training', match: /MistralAI/i },
  { name: 'Cohere crawler', operator: 'Cohere', domain: 'cohere.com', category: 'training', match: /cohere-training-data-crawler/i },
  { name: 'DeepSeekBot', operator: 'DeepSeek', domain: 'deepseek.com', category: 'training', match: /DeepSeekBot/i },
  { name: 'GrokBot', operator: 'xAI', domain: 'x.ai', category: 'training', match: /GrokBot|xAI-Grok|Grok-/i },
  { name: 'QwenBot', operator: 'Alibaba', domain: 'qwen.ai', category: 'training', match: /QwenBot/i },
  { name: 'PanguBot', operator: 'Huawei', domain: 'huawei.com', category: 'training', match: /PanguBot/i },
  { name: 'AI2Bot', operator: 'Allen AI', domain: 'allenai.org', category: 'training', match: /AI2Bot/i },
  { name: 'Diffbot', operator: 'Diffbot', domain: 'diffbot.com', category: 'training', match: /Diffbot/i },
  { name: 'Timpibot', operator: 'Timpi', domain: 'timpi.io', category: 'training', match: /Timpibot/i },
  { name: 'omgili', operator: 'Webz.io', domain: 'webz.io', category: 'training', match: /omgili/i },
  { name: 'ImagesiftBot', operator: 'ImageSift', domain: 'imagesift.com', category: 'training', match: /ImagesiftBot/i },
];

/** Generic clients: what an agent framework or scraper usually looks like when it doesn't name itself. */
const GENERIC_CLIENTS: [RegExp, string][] = [
  [/HeadlessChrome|Puppeteer|Playwright|PhantomJS|Selenium|chrome-lighthouse/i, 'Headless browser'],
  [/python-requests|python-httpx|aiohttp|python-urllib|Python\/|Scrapy|httpx\//i, 'Python client'],
  [/node-fetch|undici|axios|got \(|\bnode\b|Node\.js|bun\/|Deno\//i, 'Node.js client'],
  [/^curl\//i, 'curl'],
  [/^Wget/i, 'wget'],
  [/Go-http-client/i, 'Go client'],
  [/okhttp|Java\/|Apache-HttpClient/i, 'Java client'],
  [/^Ruby|Faraday/i, 'Ruby client'],
  [/reqwest|rust/i, 'Rust client'],
];

/** Published IP ranges. Each list is fetched daily and used to mark hits as verified. */
export const IP_LISTS: Record<string, string[]> = {
  'openai-gptbot': ['https://openai.com/gptbot.json'],
  'openai-search': ['https://openai.com/searchbot.json'],
  'openai-user': ['https://openai.com/chatgpt-user.json'],
  anthropic: ['https://claude.com/crawling/bots.json'],
  'perplexity-bot': ['https://www.perplexity.com/perplexitybot.json'],
  'perplexity-user': ['https://www.perplexity.com/perplexity-user.json'],
  'google-user': [
    'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers.json',
    'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json',
    'https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json',
  ],
  applebot: ['https://search.developer.apple.com/applebot.json'],
  ccbot: ['https://index.commoncrawl.org/ccbot.json'],
};

/** Which human-traffic source (see sources.ts) belongs to each AI company, for the crawl-to-refer ratio. */
export const OPERATOR_SOURCE: Record<string, string> = {
  OpenAI: 'ChatGPT',
  Anthropic: 'Claude',
  Perplexity: 'Perplexity',
  Google: 'Gemini',
  Microsoft: 'Copilot',
  xAI: 'Grok',
  DeepSeek: 'DeepSeek',
  Mistral: 'Mistral',
  Meta: 'Meta AI',
  Moonshot: 'Kimi',
};

export type RequestKind = 'page' | 'markdown' | 'llms_txt' | 'robots' | 'sitemap' | 'registry' | 'feed' | 'api' | 'asset';

export const KIND_LABELS: Record<RequestKind, string> = {
  page: 'Pages',
  markdown: 'Markdown',
  llms_txt: 'llms.txt',
  robots: 'robots.txt',
  sitemap: 'Sitemap',
  registry: 'Component registry',
  feed: 'Feeds',
  api: 'API',
  asset: 'Files & images',
};

/** What kind of resource was requested. Coding agents ask for markdown (Accept: text/markdown or .md URLs). */
export function requestKind(path: string, accept?: string | null): RequestKind {
  const p = path.toLowerCase().split('?')[0];
  if (p === '/robots.txt') return 'robots';
  if (/^\/llms(-full|-small)?\.txt$|\/llms\.txt$/.test(p)) return 'llms_txt';
  if (/sitemap[\w-]*\.xml$/.test(p)) return 'sitemap';
  // shadcn-style registries: /r/button.json, /registry.json, /r/styles/new-york/button.json
  if (/^\/r\/.+\.json$|(^|\/)registry(\.json|\/)/.test(p)) return 'registry';
  if (/\.(md|mdx|markdown)$/.test(p) || /text\/markdown/i.test(accept ?? '')) return 'markdown';
  if (/(^|\/)(feed|rss)(\.xml)?$|\.(rss|atom)$|atom\.xml$/.test(p)) return 'feed';
  if (/^\/api\//.test(p)) return 'api';
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|otf|mp4|webm|pdf|zip|json|xml|txt)$/.test(p)) return 'asset';
  return 'page';
}

export interface AgentMatch {
  name: string;
  operator: string;
  domain: string | null;
  category: AgentCategory;
  ips?: string;
  signed: boolean;
}

/**
 * Who made this request? `null` means it looks like a regular person's browser (those are counted by the script).
 * `signatureAgent` is the Web Bot Auth `Signature-Agent` header (ChatGPT agent and other signed agents send it).
 */
export function detectAgent(input: { ua: string; signatureAgent?: string | null; kind?: RequestKind }): AgentMatch | null {
  const ua = input.ua ?? '';
  const sig = input.signatureAgent?.replace(/^"|"$/g, '').trim();
  if (sig) {
    let host = sig;
    try {
      host = new URL(sig).hostname;
    } catch {}
    host = host.replace(/^www\./, '').toLowerCase();
    if (host === 'chatgpt.com' || host === 'openai.com') {
      return { name: 'ChatGPT agent', operator: 'OpenAI', domain: 'chatgpt.com', category: 'agent', signed: true };
    }
    if (/(^|\.)bot\.goog$|google/.test(host)) return { name: 'Google Agent', operator: 'Google', domain: 'google.com', category: 'agent', signed: true };
    return { name: host.slice(0, 60), operator: host.slice(0, 60), domain: host, category: 'agent', signed: true };
  }

  const known = KNOWN_AGENTS.find((a) => a.match.test(ua));
  if (known) return { name: known.name, operator: known.operator, domain: known.domain, category: known.category, ips: known.ips, signed: false };

  if (!ua.trim()) return { name: 'No user agent', operator: 'Unknown', domain: null, category: 'other', signed: false };
  const generic = GENERIC_CLIENTS.find(([re]) => re.test(ua));
  if (generic) {
    // A plain Node/Python fetch of a registry item is almost always the shadcn CLI or an agent installing a component.
    const category: AgentCategory = input.kind === 'registry' || input.kind === 'markdown' || input.kind === 'llms_txt' ? 'coding' : 'other';
    return { name: generic[1], operator: 'Unknown', domain: null, category, signed: false };
  }
  // Something that isn't a browser and isn't in the list: other bots (SEO tools, uptime monitors...) are not AI, so skip them,
  // unless it fetched something only agents ask for.
  const browserish = /^Mozilla\/5\.0 \(/.test(ua) && !/bot|crawl|spider|slurp|fetch/i.test(ua);
  if (!browserish && (input.kind === 'markdown' || input.kind === 'llms_txt')) {
    return { name: ua.split(/[\s/;(]/)[0].slice(0, 40) || 'Unknown client', operator: 'Unknown', domain: null, category: 'other', signed: false };
  }
  return null;
}

/** Category to show for a known agent name (dashboard helper). */
export function agentDomain(name: string | null | undefined): string | null {
  if (!name) return null;
  return KNOWN_AGENTS.find((a) => a.name === name)?.domain ?? (name === 'ChatGPT agent' ? 'chatgpt.com' : null);
}

// ---------- IP ranges

/** Pull every CIDR out of a vendor's JSON file, whatever its exact shape. */
export function parseCidrs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/"((?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}|[0-9a-fA-F:]+:[0-9a-fA-F:]*\/\d{1,3})"/g)) out.add(m[1].toLowerCase());
  // Bare IPs (some lists don't use CIDR notation).
  for (const m of text.matchAll(/"((?:\d{1,3}\.){3}\d{1,3})"/g)) out.add(m[1] + '/32');
  return [...out];
}

function ipv4ToBig(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d{1,3}$/.test(p) || v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function ipv6ToBig(ip: string): bigint | null {
  if (!ip.includes(':')) return null;
  let [head, tail] = ip.split('::') as [string, string | undefined];
  if (ip.split('::').length > 2) return null;
  // IPv4-mapped tail (::ffff:1.2.3.4)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  let extra: string[] = [];
  if (v4) {
    const n = ipv4ToBig(v4[1]);
    if (n === null) return null;
    extra = [((n >> 16n) & 0xffffn).toString(16), (n & 0xffffn).toString(16)];
    if (tail !== undefined) tail = tail.slice(0, -v4[1].length).replace(/:$/, '');
    else head = head.slice(0, -v4[1].length).replace(/:$/, '');
  }
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? [...h, ...extra] : [...h, ...Array(8 - h.length - t.length - extra.length).fill('0'), ...t, ...extra];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Is `ip` inside one of the CIDR ranges? Handles IPv4 and IPv6. */
export function ipInRanges(ip: string, cidrs: string[]): boolean {
  const v6 = ip.includes(':');
  const addr = v6 ? ipv6ToBig(ip) : ipv4ToBig(ip);
  if (addr === null) return false;
  const bits = v6 ? 128n : 32n;
  for (const c of cidrs) {
    const [base, lenStr] = c.split('/');
    if (base.includes(':') !== v6) continue;
    const b = v6 ? ipv6ToBig(base) : ipv4ToBig(base);
    const len = BigInt(Number(lenStr));
    if (b === null || len > bits) continue;
    const shift = bits - len;
    if (addr >> shift === b >> shift) return true;
  }
  return false;
}
