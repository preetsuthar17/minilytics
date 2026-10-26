export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: init?.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    window.dispatchEvent(new Event('ml:logout'));
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export interface Site {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  currency: string;
  api_key: string;
  dodo_webhook_secret: string | null;
  dodo_brand_id: string | null;
  dodo_product_ids?: string | null;
  ai_brand_terms?: string | null;
  ai_monitor_days?: number;
  created_at: number;
  visitors24h?: number;
  online?: number;
}

export interface Kpis {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounceRate: number;
  avgDuration: number;
  revenue: number;
  payments: number;
  customers: number;
  conversionRate: number;
  revenuePerVisitor: number;
}

export interface Overview {
  range: { from: number; to: number; granularity: 'hour' | 'day' | 'week' | 'month' };
  currency: string;
  decimals: number;
  current: Kpis;
  previous: Kpis;
  online: number;
  series: { bucket: string; visitors: number; pageviews: number; revenue: number; payments: number }[];
}

export interface BreakdownRow {
  label: string | null;
  visitors: number;
  pageviews?: number;
  revenue: number;
  customers: number;
  extra?: string | null;
}

export type Filters = Record<string, string>;

export interface Query {
  period: string;
  from?: string;
  to?: string;
  granularity?: string;
  filters: Filters;
}

export function qs(q: Query, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams();
  p.set('period', q.period);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.granularity) p.set('granularity', q.granularity);
  if (Object.keys(q.filters).length) p.set('filters', JSON.stringify(q.filters));
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

export interface Me {
  loggedIn: boolean;
  hosted: boolean;
  user: {
    id: string;
    email: string | null;
    name: string | null;
    avatar: string | null;
    admin: boolean;
    paid: boolean;
    plan_status: string;
    plan_until: number | null;
  } | null;
}

export interface PlanInfo {
  hosted: boolean;
  price: string;
  interval: string;
  spots: number;
  spotsLeft: number | null;
  nextPrice: string | null;
  checkout: boolean;
  supportEmail: string | null;
}

// ---------- AI section

export type AgentCategory = 'assistant' | 'search' | 'training' | 'coding' | 'agent' | 'other';
export type AiTotals = Record<AgentCategory, number> & { total: number; agents: number; spoofed: number; pages_read: number };

export interface AiOverview {
  range: Overview['range'];
  current: AiTotals;
  previous: AiTotals;
  series: ({ bucket: string } & Record<AgentCategory, number>)[];
  lastHit: number | null;
  serverConnected: boolean;
  ipLists: { list: string; fetched_at: number; count: number; error: string | null }[];
}

export interface AiRow {
  label: string | null;
  hits: number;
  pages: number;
  agents: number;
  verified: number;
  spoofed: number;
  last: number;
  extra: string | null;
}

export interface AiHit {
  ts: number;
  agent: string;
  operator: string;
  category: AgentCategory;
  kind: string;
  path: string;
  status: number | null;
  verified: number | null;
  signed: number;
  via: 'server' | 'script';
  country: string | null;
}

export type EngineId = 'chatgpt' | 'claude' | 'perplexity' | 'gemini';

export interface Citation {
  url: string;
  title?: string;
}

export interface PromptRun {
  id: number;
  prompt_id?: string;
  engine: EngineId;
  model: string | null;
  ts: number;
  mentioned: number;
  cited: number;
  position: number | null;
  error: string | null;
  citations: Citation[];
  answer?: string | null;
}

export interface PromptsData {
  engines: { id: EngineId; label: string; domain: string; configured: boolean; secret: string; model: string }[];
  allowed: boolean;
  brandTerms: string | null;
  days: number;
  prompts: { id: string; prompt: string; created_at: number }[];
  latest: PromptRun[];
  history: { day: string; engine: EngineId; runs: number; mentioned: number; cited: number }[];
}
