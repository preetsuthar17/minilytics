// Shared by the worker (to classify traffic) and the dashboard (to show icons).

export type Channel =
  | 'Direct'
  | 'Organic Search'
  | 'Organic Social'
  | 'AI'
  | 'Referral'
  | 'Email'
  | 'Paid';

interface KnownSource {
  name: string;
  domain: string; // used for the favicon
  channel: Channel;
  match: RegExp; // tested against referrer hostname, utm_source and ref
}

export const KNOWN_SOURCES: KnownSource[] = [
  { name: 'X', domain: 'x.com', channel: 'Organic Social', match: /^(t\.co|(.*\.)?(x|twitter)\.com|x|twitter|tw)$/ },
  { name: 'Google', domain: 'google.com', channel: 'Organic Search', match: /^((www\.)?google\.[a-z.]+|google)$/ },
  { name: 'Bing', domain: 'bing.com', channel: 'Organic Search', match: /^(?!edgeservices\.)((.*\.)?bing\.com|bing)$/ },
  { name: 'DuckDuckGo', domain: 'duckduckgo.com', channel: 'Organic Search', match: /^((.*\.)?duckduckgo\.com|duckduckgo|ddg)$/ },
  { name: 'Yahoo', domain: 'yahoo.com', channel: 'Organic Search', match: /^((.*\.)?yahoo\.[a-z.]+|yahoo)$/ },
  { name: 'Yandex', domain: 'yandex.com', channel: 'Organic Search', match: /^((.*\.)?yandex\.[a-z.]+|yandex)$/ },
  { name: 'Baidu', domain: 'baidu.com', channel: 'Organic Search', match: /^((.*\.)?baidu\.com|baidu)$/ },
  { name: 'Ecosia', domain: 'ecosia.org', channel: 'Organic Search', match: /^((.*\.)?ecosia\.org|ecosia)$/ },
  { name: 'Brave Search', domain: 'search.brave.com', channel: 'Organic Search', match: /^(search\.brave\.com)$/ },
  { name: 'ChatGPT', domain: 'chatgpt.com', channel: 'AI', match: /^((.*\.)?(chatgpt\.com|openai\.com)|chatgpt|chatgpt\.com|openai)$/ },
  { name: 'Claude', domain: 'claude.ai', channel: 'AI', match: /^((.*\.)?claude\.ai|claude)$/ },
  { name: 'Perplexity', domain: 'perplexity.ai', channel: 'AI', match: /^((.*\.)?perplexity\.(ai|com)|perplexity)$/ },
  { name: 'Gemini', domain: 'gemini.google.com', channel: 'AI', match: /^(gemini\.google\.com|gemini|bard\.google\.com)$/ },
  { name: 'Copilot', domain: 'copilot.microsoft.com', channel: 'AI', match: /^(copilot\.microsoft\.com|(www\.)?copilot\.com|edgeservices\.bing\.com|copilot)$/ },
  { name: 'DeepSeek', domain: 'deepseek.com', channel: 'AI', match: /^((.*\.)?deepseek\.com|deepseek)$/ },
  { name: 'Grok', domain: 'grok.com', channel: 'AI', match: /^((.*\.)?grok\.com|grok)$/ },
  { name: 'Mistral', domain: 'chat.mistral.ai', channel: 'AI', match: /^(chat\.mistral\.ai|mistral|lechat)$/ },
  { name: 'Meta AI', domain: 'meta.ai', channel: 'AI', match: /^((.*\.)?meta\.ai|metaai|meta-ai)$/ },
  { name: 'Kimi', domain: 'kimi.com', channel: 'AI', match: /^((.*\.)?kimi\.(com|ai)|kimi\.moonshot\.cn|kimi)$/ },
  { name: 'Qwen', domain: 'chat.qwen.ai', channel: 'AI', match: /^(chat\.qwen\.ai|tongyi\.aliyun\.com|qwen)$/ },
  { name: 'Poe', domain: 'poe.com', channel: 'AI', match: /^((.*\.)?poe\.com|poe)$/ },
  { name: 'You.com', domain: 'you.com', channel: 'AI', match: /^((.*\.)?you\.com|youcom)$/ },
  { name: 'Phind', domain: 'phind.com', channel: 'AI', match: /^((.*\.)?phind\.com|phind)$/ },
  { name: 'NotebookLM', domain: 'notebooklm.google.com', channel: 'AI', match: /^(notebooklm\.google(\.com)?|notebooklm)$/ },
  { name: 'Manus', domain: 'manus.im', channel: 'AI', match: /^((.*\.)?manus\.im|manus)$/ },
  { name: 'Devin', domain: 'devin.ai', channel: 'AI', match: /^((.*\.)?devin\.ai)$/ },
  { name: 'v0', domain: 'v0.dev', channel: 'AI', match: /^((.*\.)?v0\.(dev|app)|v0)$/ },
  { name: 'Cursor', domain: 'cursor.com', channel: 'AI', match: /^((.*\.)?cursor\.(com|sh)|cursor)$/ },
  { name: 'YouTube', domain: 'youtube.com', channel: 'Organic Social', match: /^((.*\.)?(youtube\.com|youtu\.be)|youtube|yt)$/ },
  { name: 'LinkedIn', domain: 'linkedin.com', channel: 'Organic Social', match: /^((.*\.)?(linkedin\.com|lnkd\.in)|linkedin)$/ },
  { name: 'Reddit', domain: 'reddit.com', channel: 'Organic Social', match: /^((.*\.)?reddit\.com|reddit)$/ },
  { name: 'Facebook', domain: 'facebook.com', channel: 'Organic Social', match: /^((.*\.)?(facebook\.com|fb\.com|fb\.me)|facebook|fb)$/ },
  { name: 'Instagram', domain: 'instagram.com', channel: 'Organic Social', match: /^((.*\.)?instagram\.com|instagram|ig)$/ },
  { name: 'Threads', domain: 'threads.net', channel: 'Organic Social', match: /^((.*\.)?threads\.(net|com)|threads)$/ },
  { name: 'TikTok', domain: 'tiktok.com', channel: 'Organic Social', match: /^((.*\.)?tiktok\.com|tiktok)$/ },
  { name: 'Pinterest', domain: 'pinterest.com', channel: 'Organic Social', match: /^((.*\.)?pinterest\.[a-z.]+|pinterest)$/ },
  { name: 'Bluesky', domain: 'bsky.app', channel: 'Organic Social', match: /^((.*\.)?bsky\.app|bluesky|bsky)$/ },
  { name: 'Mastodon', domain: 'mastodon.social', channel: 'Organic Social', match: /^((.*\.)?mastodon\.[a-z.]+|mastodon)$/ },
  { name: 'Hacker News', domain: 'news.ycombinator.com', channel: 'Organic Social', match: /^(news\.ycombinator\.com|hackernews|hn)$/ },
  { name: 'Product Hunt', domain: 'producthunt.com', channel: 'Referral', match: /^((.*\.)?producthunt\.com|producthunt|ph)$/ },
  { name: 'Medium', domain: 'medium.com', channel: 'Referral', match: /^((.*\.)?medium\.com|medium)$/ },
  { name: 'Substack', domain: 'substack.com', channel: 'Referral', match: /^((.*\.)?substack\.com|substack)$/ },
  { name: 'Dev.to', domain: 'dev.to', channel: 'Referral', match: /^(dev\.to|devto)$/ },
  { name: 'Indie Hackers', domain: 'indiehackers.com', channel: 'Referral', match: /^((.*\.)?indiehackers\.com|indiehackers)$/ },
  { name: 'GitHub', domain: 'github.com', channel: 'Referral', match: /^((.*\.)?github\.com|github)$/ },
  { name: 'Gmail', domain: 'mail.google.com', channel: 'Email', match: /^(mail\.google\.com|gmail)$/ },
  { name: 'Outlook', domain: 'outlook.com', channel: 'Email', match: /^((.*\.)?(outlook\.(com|live\.com)|outlook\.office\.com))$/ },
  { name: 'Newsletter', domain: '', channel: 'Email', match: /^(newsletter|email|mail)$/ },
];

const PAID_MEDIUM = /^(cpc|ppc|cpm|paid|paid[_-]?social|paidsearch|ads?|display|retargeting|sponsored)$/i;
const EMAIL_MEDIUM = /^(e-?mail|newsletter)$/i;
const SOCIAL_MEDIUM = /^(social|social[_-]?media|sm)$/i;

export function findKnownSource(key: string | null | undefined): KnownSource | undefined {
  if (!key) return undefined;
  const k = key.toLowerCase().trim();
  return KNOWN_SOURCES.find((s) => s.match.test(k));
}

export function domainForSource(name: string): string | undefined {
  return KNOWN_SOURCES.find((s) => s.name === name)?.domain || undefined;
}

/**
 * Checkout and sign-in pages send people back to your site, but they are a step in a visit, not where it came from.
 * A return from one of these counts as no referrer, so it never takes the credit from the visit that brought the buyer.
 * Payment hosts only appear in the middle of a purchase, so the whole domain is ignored. Hosts that also link to
 * sites for real (github.com, x.com, facebook.com, ...) are only ignored on their login/OAuth paths.
 */
const PAYMENT_OR_AUTH_HOST =
  /^(([\w-]+\.)*dodopayments\.com|(?!www\.)[\w-]+\.stripe\.com|([\w-]+\.)*paypal\.(com|me)|(?!www\.)[\w-]+\.lemonsqueezy\.com|[\w-]+\.paddle\.com|([\w-]+\.)*paddle\.io|accounts\.google\.[a-z.]+|accounts\.youtube\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|([\w-]+\.)*auth0\.com|([\w-]+\.)*clerk\.accounts\.dev|accounts\.clerk\.com|([\w-]+\.)*okta\.com|([\w-]+\.)*workos\.com|([\w-]+\.)*stytch\.com)$/;
const AUTH_PATH: Record<string, RegExp> = {
  'github.com': /^\/(login|session|sessions)(\/|$)/,
  'gitlab.com': /^\/(users\/sign_in|oauth)(\/|$)/,
  'x.com': /^\/(i\/oauth2|oauth)(\/|$)/,
  'twitter.com': /^\/(i\/oauth2|oauth)(\/|$)/,
  'api.twitter.com': /^\/oauth(\/|$)/,
  'facebook.com': /^\/(v[\d.]+\/)?dialog\/oauth(\/|$)|^\/login(\/|$)/,
  'discord.com': /^\/(oauth2|login)(\/|$)/,
  'linkedin.com': /^\/(oauth|uas\/login|login)(\/|$)/,
};

/** Was this referrer a checkout or sign-in page? `path` is optional; without it only payment/auth-only hosts match. */
export function isPaymentOrAuthReferrer(domain: string | null | undefined, path?: string | null): boolean {
  if (!domain) return false;
  const host = domain.toLowerCase().replace(/^www\./, '');
  if (PAYMENT_OR_AUTH_HOST.test(host)) return true;
  const authPath = AUTH_PATH[host];
  return !!(authPath && path && authPath.test(path));
}

export interface Attribution {
  source: string;
  channel: Channel;
  referrerDomain: string | null;
}

/**
 * Decide where a visit came from. An explicit `ref` / `utm_source` wins over the HTTP referrer,
 * because that's how you tag a specific tweet or article ("?ref=launch-tweet").
 */
export function classify(input: {
  referrerDomain: string | null;
  referrerPath?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  ref?: string | null;
}): Attribution {
  const { utmSource, utmMedium, ref } = input;
  const referrerDomain = isPaymentOrAuthReferrer(input.referrerDomain, input.referrerPath) ? null : input.referrerDomain;
  const tag = utmSource || ref || null;
  const known = findKnownSource(tag) ?? findKnownSource(referrerDomain);

  let source: string;
  if (known) source = known.name;
  else if (tag) source = tag;
  else if (referrerDomain) source = referrerDomain;
  else source = 'Direct/None';

  let channel: Channel;
  if (utmMedium && PAID_MEDIUM.test(utmMedium)) channel = 'Paid';
  else if (utmMedium && EMAIL_MEDIUM.test(utmMedium)) channel = 'Email';
  else if (known) channel = known.channel;
  else if (utmMedium && SOCIAL_MEDIUM.test(utmMedium)) channel = 'Organic Social';
  else if (tag || referrerDomain) channel = 'Referral';
  else channel = 'Direct';

  return { source, channel, referrerDomain };
}
