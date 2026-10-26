import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { agentDomain, CATEGORY_HINTS, CATEGORY_LABELS, KIND_LABELS, KNOWN_AGENTS, OPERATOR_SOURCE, type RequestKind } from '../../shared/agents';
import { navigate } from '../App';
import { Favicon, Flag } from '../components/Icons';
import { Modal } from '../components/Modal';
import { Panel } from '../components/Panel';
import { PromptMonitor } from '../components/PromptMonitor';
import { Toolbar } from '../components/Toolbar';
import { qs, type AgentCategory, type AiHit, type AiOverview, type AiRow, type BreakdownRow, type Overview, type Query, type Site } from '../lib/api';
import { DashContext, type Dash } from '../lib/context';
import { bucketLabel, fmtAgo, fmtDateTime, fmtMoney, fmtNumber } from '../lib/format';
import { prefetch, useApi } from '../lib/useApi';
import { useQueryState } from '../lib/useQueryState';

const CATEGORIES: AgentCategory[] = ['assistant', 'search', 'training', 'coding', 'agent', 'other'];
export const CATEGORY_COLORS: Record<AgentCategory, string> = {
  assistant: '#8b5cf6',
  search: '#8dbdf0',
  training: '#c4b5a5',
  coding: '#34d399',
  agent: '#f59e0b',
  other: '#e7e5e4',
};
const CATEGORY_EMOJI: Record<AgentCategory, string> = { assistant: '💬', search: '🔎', training: '🧠', coding: '⌨️', agent: '🖱️', other: '🤖' };

const FILTER_LABELS: Record<string, string> = { agent: 'Agent', operator: 'Company', category: 'Type', kind: 'Request', path: 'Page' };

const OPERATOR_DOMAIN: Record<string, string> = Object.fromEntries(KNOWN_AGENTS.map((a) => [a.operator, a.domain]).reverse());
OPERATOR_DOMAIN.OpenAI = 'openai.com';
OPERATOR_DOMAIN.Anthropic = 'anthropic.com';
OPERATOR_DOMAIN.Google = 'google.com';

function Change({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return <span className="text-xs text-stone-500">—</span>;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (!Number.isFinite(pct)) return null;
  if (pct === 0) return <span className="text-xs text-stone-500">0%</span>;
  return <span className={`text-xs ${pct > 0 ? 'text-emerald-600' : 'text-red-500'}`}>{Math.abs(pct)}% {pct > 0 ? '↑' : '↓'}</span>;
}

/** How each AI dimension's label is shown. */
function aiLabel(dim: string, r: Pick<AiRow, 'label' | 'extra'>): ReactNode {
  const l = r.label;
  const text = (s: ReactNode) => <span className="truncate">{s}</span>;
  switch (dim) {
    case 'agent':
      return (
        <>
          <Favicon domain={agentDomain(l) ?? OPERATOR_DOMAIN[r.extra ?? '']} fallback="🤖" />
          {text(l)}
          {r.extra && r.extra !== 'Unknown' && r.extra !== l && <span className="shrink-0 text-xs text-stone-400">{r.extra}</span>}
        </>
      );
    case 'operator':
      return (
        <>
          <Favicon domain={OPERATOR_DOMAIN[l ?? '']} fallback="🤖" />
          {text(l)}
        </>
      );
    case 'category':
      return (
        <>
          <Favicon fallback={CATEGORY_EMOJI[l as AgentCategory] ?? '🤖'} />
          {text(CATEGORY_LABELS[l as AgentCategory] ?? l)}
        </>
      );
    case 'kind':
      return text(KIND_LABELS[l as RequestKind] ?? l);
    case 'country':
      return (
        <>
          <Flag cc={l} />
          {text(l ?? 'Unknown')}
        </>
      );
    default:
      return (
        <>
          {text(l ?? '(none)')}
          {r.extra && <span className="shrink-0 text-xs text-stone-400">{r.extra}</span>}
        </>
      );
  }
}

function VerifiedBadge({ r }: { r: Pick<AiRow, 'verified' | 'spoofed' | 'hits'> }) {
  if (r.spoofed > 0)
    return (
      <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-600" title="Claimed to be this bot, but came from an IP outside its published ranges (likely a scraper in disguise)">
        {fmtNumber(r.spoofed)} fake
      </span>
    );
  if (r.verified > 0 && r.verified === r.hits)
    return (
      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700" title="Every request came from the operator's published IP ranges">
        ✓ verified
      </span>
    );
  return null;
}

interface AiTab {
  label: string;
  dim: string;
  scope?: string;
  /** Filter added when a row is clicked. */
  filter?: string;
  empty?: ReactNode;
}

function AiPanel({ tabs, siteId, q, reloadKey, onFilter, title }: { tabs: AiTab[]; siteId: string; q: Query; reloadKey: number; onFilter: (k: string, v: string) => void; title?: ReactNode }) {
  const [active, setActive] = useState(0);
  const [details, setDetails] = useState(false);
  const tab = tabs[active];
  const urlFor = (t: AiTab) => `/api/sites/${siteId}/ai/breakdown?${qs(q, { dim: t.dim, ...(t.scope ? { scope: t.scope } : {}) })}`;
  const { data, stale, loading, error } = useApi<AiRow[]>(urlFor(tab), reloadKey);
  const max = Math.max(1, ...(data ?? []).map((r) => r.hits));
  const pick = (r: AiRow) => {
    if (!tab.filter || r.label === null) return;
    setDetails(false);
    onFilter(tab.filter, r.label);
  };
  const row = (r: AiRow, i: number) => (
    <div key={`${r.label}-${i}`} className="group relative flex h-10 items-center rounded-lg">
      <div className="absolute inset-y-0 left-0 rounded-lg bg-violet-50 transition-all" style={{ width: `${(r.hits / max) * 100}%`, minWidth: 4 }} />
      <div className="absolute inset-0 hidden rounded-lg ring-1 ring-stone-300/70 group-hover:block" />
      {tab.filter && <button type="button" className="absolute inset-0 w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-stone-400" onClick={() => pick(r)} aria-label={`Filter by ${r.label}`} />}
      <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2.5 px-3 text-[15px]">
        {aiLabel(tab.dim, r)}
        {tab.dim === 'agent' && <VerifiedBadge r={r} />}
      </div>
      <div className="pointer-events-none relative shrink-0 pr-3 text-[15px] font-medium">{fmtNumber(r.hits)}</div>
      <div className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden w-60 -translate-x-1/2 rounded-xl bg-ink px-3 py-2 text-xs text-white shadow-lg group-hover:block">
        <div className="mb-1 truncate font-medium">{r.label ?? '(none)'}</div>
        <div className="flex justify-between"><span className="text-stone-400">Requests</span>{fmtNumber(r.hits)}</div>
        {tab.dim !== 'path' && <div className="flex justify-between"><span className="text-stone-400">Different pages</span>{fmtNumber(r.pages)}</div>}
        {tab.dim !== 'agent' && <div className="flex justify-between"><span className="text-stone-400">Agents</span>{fmtNumber(r.agents)}</div>}
        {r.verified > 0 && <div className="flex justify-between"><span className="text-stone-400">Verified by IP</span>{fmtNumber(r.verified)}</div>}
        {r.spoofed > 0 && <div className="flex justify-between"><span className="text-stone-400">Fake (wrong IP)</span>{fmtNumber(r.spoofed)}</div>}
        <div className="flex justify-between"><span className="text-stone-400">Last seen</span>{fmtAgo(Date.now() - r.last)} ago</div>
        {tab.filter && <div className="mt-1 text-stone-400">Click to filter</div>}
      </div>
    </div>
  );
  return (
    <div className="card flex min-w-0 flex-col p-3 lg:min-h-[538px]">
      <div className="flex min-w-0 items-center justify-between gap-2 pb-3">
        <div className="tabs min-w-0 overflow-x-auto" role="tablist">
          {tabs.map((t, i) => (
            <button key={t.label} type="button" role="tab" aria-selected={i === active} className={`tab whitespace-nowrap ${i === active ? 'tab-active' : ''}`} onPointerEnter={() => prefetch(urlFor(t), reloadKey)} onClick={() => setActive(i)}>
              {t.label}
            </button>
          ))}
        </div>
        {title && <span className="shrink-0 px-2 text-sm font-medium text-stone-600">{title}</span>}
      </div>
      <div className={`flex-1 transition-opacity ${loading && !data ? 'animate-pulse' : ''} ${stale ? 'opacity-50' : ''}`}>
        {error && <p className="p-3 text-sm text-red-600">{error}</p>}
        {data && data.length === 0 && <p className="p-6 text-center text-sm text-stone-500">{tab.empty ?? 'Nothing in this period'}</p>}
        {data && <div className="space-y-1">{data.slice(0, 10).map(row)}</div>}
      </div>
      {data && data.length > 10 && (
        <button className="mx-auto mt-3 text-xs font-semibold uppercase tracking-wider text-stone-500 hover:text-ink" onClick={() => setDetails(true)}>
          ⛶ Details
        </button>
      )}
      <Modal open={details} onClose={() => setDetails(false)} title={tab.label} width="max-w-3xl">
        <div className="space-y-1">{data?.map(row)}</div>
      </Modal>
    </div>
  );
}

function AiChart({ data, human }: { data: AiOverview; human: Overview | null }) {
  const [hidden, setHidden] = useState<Partial<Record<AgentCategory | 'visitors', boolean>>>({ other: true });
  const g = data.range.granularity;
  const humanBy = new Map((human?.series ?? []).map((s) => [s.bucket, s.visitors]));
  const series = data.series.map((s) => ({ ...s, visitors: humanBy.get(s.bucket) ?? 0 }));
  const toggle = (k: AgentCategory | 'visitors') => setHidden((h) => ({ ...h, [k]: !h[k] }));
  return (
    <>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-5 pt-4 text-sm">
        {CATEGORIES.map((c) => (
          <button key={c} className={`flex items-center gap-1.5 ${hidden[c] ? 'text-stone-400' : 'text-stone-600'}`} onClick={() => toggle(c)} title={CATEGORY_HINTS[c]}>
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: CATEGORY_COLORS[c], opacity: hidden[c] ? 0.3 : 1 }} />
            {CATEGORY_LABELS[c]}
          </button>
        ))}
        <button className={`flex items-center gap-1.5 ${hidden.visitors ? 'text-stone-400' : 'text-stone-600'}`} onClick={() => toggle('visitors')}>
          <span className="h-0.5 w-3 rounded bg-revenue" style={{ opacity: hidden.visitors ? 0.3 : 1 }} />
          Visitors from AI
        </button>
      </div>
      <div className="h-[300px] px-2 pb-3 pt-4 sm:px-4">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#efedea" strokeDasharray="4 4" />
            <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(b, g)} tick={{ fill: '#78716c', fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={24} />
            <YAxis yAxisId="h" tick={{ fill: '#78716c', fontSize: 12 }} axisLine={false} tickLine={false} width={44} allowDecimals={false} tickFormatter={(v) => fmtNumber(v)} />
            <YAxis yAxisId="v" orientation="right" hide />
            <Tooltip
              cursor={{ fill: '#f5f5f4' }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="rounded-xl bg-ink px-3 py-2 text-xs text-white shadow-lg">
                    <div className="mb-1 font-medium">{bucketLabel(String(label), g, true)}</div>
                    {payload.map((p) => (
                      <div key={String(p.dataKey)} className="flex justify-between gap-6">
                        <span className="text-stone-400">{p.dataKey === 'visitors' ? 'Visitors from AI' : CATEGORY_LABELS[p.dataKey as AgentCategory]}</span>
                        {fmtNumber(Number(p.value))}
                      </div>
                    ))}
                  </div>
                ) : null
              }
            />
            {CATEGORIES.filter((c) => !hidden[c]).map((c, i, arr) => (
              <Bar key={c} yAxisId="h" dataKey={c} stackId="a" fill={CATEGORY_COLORS[c]} radius={i === arr.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={36} />
            ))}
            {!hidden.visitors && <Line yAxisId="v" dataKey="visitors" stroke="#e07b5f" strokeWidth={2} dot={false} type="monotone" />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

/** Crawls and reads per AI company next to the people it sent back. */
function CrawlToRefer({ siteId, q, humanQ, reloadKey }: { siteId: string; q: Query; humanQ: Query; reloadKey: number }) {
  const { data: ops } = useApi<AiRow[]>(`/api/sites/${siteId}/ai/breakdown?${qs(q, { dim: 'operator', scope: 'crawlers_and_answers' })}`, reloadKey);
  const { data: sources } = useApi<BreakdownRow[]>(`/api/sites/${siteId}/breakdown?${qs(humanQ, { dim: 'source' })}`, reloadKey);
  const rows = useMemo(() => {
    if (!ops) return [];
    const sent = new Map((sources ?? []).map((s) => [s.label, s.visitors]));
    return ops
      .filter((o) => o.label && o.label !== 'Unknown')
      .map((o) => ({ operator: o.label!, hits: o.hits, visitors: sent.get(OPERATOR_SOURCE[o.label!] ?? '') ?? 0 }))
      .slice(0, 8);
  }, [ops, sources]);
  return (
    <div className="card p-5">
      <h3 className="font-semibold">Crawl-to-visit ratio</h3>
      <p className="mt-1 text-sm text-stone-500">How many requests each AI company made for every visitor it sent you. Lower is a better deal.</p>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-stone-500">No AI company crawled the site in this period</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-stone-500">
              <th className="pb-2 font-medium">Company</th>
              <th className="pb-2 text-right font-medium">Requests</th>
              <th className="pb-2 text-right font-medium">Visitors sent</th>
              <th className="pb-2 text-right font-medium">Requests / visitor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.operator} className="border-t border-stone-100">
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <Favicon domain={OPERATOR_DOMAIN[r.operator]} fallback="🤖" /> {r.operator}
                  </div>
                </td>
                <td className="py-2 text-right">{fmtNumber(r.hits)}</td>
                <td className="py-2 text-right">{fmtNumber(r.visitors)}</td>
                <td className="py-2 text-right font-medium">{r.visitors ? fmtNumber(Math.round(r.hits / r.visitors)) + ':1' : '∞'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RecentHits({ siteId, q, reloadKey, tz }: { siteId: string; q: Query; reloadKey: number; tz: string }) {
  const { data } = useApi<AiHit[]>(`/api/sites/${siteId}/ai/recent?${qs(q)}`, reloadKey);
  return (
    <div className="card flex min-w-0 flex-col p-5 lg:max-h-[538px]">
      <h3 className="font-semibold">Latest requests</h3>
      <div className="-mx-2 mt-3 flex-1 overflow-y-auto">
        {data?.length === 0 && <p className="py-6 text-center text-sm text-stone-500">Nothing yet</p>}
        {data?.map((h, i) => (
          <div key={i} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-stone-50">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: CATEGORY_COLORS[h.category] }} title={CATEGORY_LABELS[h.category]} />
            <Favicon domain={agentDomain(h.agent) ?? OPERATOR_DOMAIN[h.operator]} fallback="🤖" size={16} />
            <span className="w-32 shrink-0 truncate font-medium">{h.agent}</span>
            <span className="min-w-0 flex-1 truncate text-stone-600" title={h.path}>
              {h.path}
            </span>
            {h.kind !== 'page' && <span className="shrink-0 rounded bg-stone-100 px-1.5 text-[11px] text-stone-600">{KIND_LABELS[h.kind as RequestKind] ?? h.kind}</span>}
            {h.verified === 1 && <span className="shrink-0 text-emerald-600" title="Verified by IP">✓</span>}
            {h.verified === 0 && <span className="shrink-0 text-red-500" title="IP is outside the operator's published ranges">✕</span>}
            {h.signed === 1 && <span className="shrink-0 text-xs text-stone-500" title="Signed with Web Bot Auth">🔏</span>}
            <span className="w-24 shrink-0 text-right text-xs text-stone-400" title={fmtDateTime(h.ts, tz)}>
              {fmtAgo(Date.now() - h.ts)} ago
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AiPage({ siteId }: { siteId: string }) {
  const [q, update] = useQueryState();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: sites } = useApi<Site[]>('/api/sites');
  const site = sites?.find((s) => s.id === siteId);
  const { data: ov, stale, loading } = useApi<AiOverview>(site ? `/api/sites/${siteId}/ai/overview?${qs(q)}` : null, reloadKey);
  // People who came from an AI assistant: the regular stats, filtered to the AI channel.
  const humanQ: Query = useMemo(() => ({ ...q, filters: { channel: 'AI' } }), [q]);
  const { data: human } = useApi<Overview>(site ? `/api/sites/${siteId}/overview?${qs(humanQ)}` : null, reloadKey);

  const addFilter = useCallback((key: string, value: string) => update({ filters: { ...q.filters, [key]: value } }), [q.filters, update]);
  const removeFilter = (key: string) => {
    const { [key]: _, ...rest } = q.filters;
    update({ filters: rest });
  };

  // The visitor panels reuse the main dashboard's Panel; clicking a row opens the main dashboard filtered to it.
  const dash: Dash | null = useMemo(() => {
    if (!site) return null;
    const decimals = human?.decimals ?? 2;
    return {
      site,
      q: humanQ,
      reloadKey,
      decimals,
      money: (minor, compact) => fmtMoney(minor, site.currency, decimals, compact),
      addFilter: (key, value) => {
        const p = new URLSearchParams(qs({ ...humanQ, filters: { channel: 'AI', [key]: value } }));
        navigate(`/site/${site.id}?${p}`);
      },
      openVisitor: () => {},
    };
  }, [site, humanQ, reloadKey, human?.decimals]);

  if (sites && !site) {
    return (
      <div className="p-10 text-center">
        Site not found.{' '}
        <button className="underline" onClick={() => navigate('/')}>
          Back to websites
        </button>
      </div>
    );
  }
  if (!site || !dash) return null;

  const c = ov?.current;
  const p = ov?.previous;
  const hc = human?.current;
  const hp = human?.previous;
  const tiles: { label: string; hint: string; value: string; cur: number; prev: number; dot?: string; sub?: string }[] =
    c && p
      ? [
          { label: 'AI answers', hint: CATEGORY_HINTS.assistant, value: fmtNumber(c.assistant), cur: c.assistant, prev: p.assistant, dot: CATEGORY_COLORS.assistant, sub: `${fmtNumber(c.pages_read)} pages read` },
          { label: 'AI crawls', hint: 'Search indexing and training crawlers.', value: fmtNumber(c.search + c.training), cur: c.search + c.training, prev: p.search + p.training, dot: CATEGORY_COLORS.search },
          { label: 'Coding agents', hint: CATEGORY_HINTS.coding, value: fmtNumber(c.coding), cur: c.coding, prev: p.coding, dot: CATEGORY_COLORS.coding },
          { label: 'Browser agents', hint: CATEGORY_HINTS.agent, value: fmtNumber(c.agent), cur: c.agent, prev: p.agent, dot: CATEGORY_COLORS.agent },
          { label: 'Visitors from AI', hint: 'People who clicked through from ChatGPT, Claude, Perplexity, Gemini and other assistants.', value: fmtNumber(hc?.visitors ?? 0), cur: hc?.visitors ?? 0, prev: hp?.visitors ?? 0 },
          { label: 'Revenue from AI', hint: 'Payments credited to visits that came from an AI assistant.', value: dash.money(hc?.revenue ?? 0, true), cur: hc?.revenue ?? 0, prev: hp?.revenue ?? 0 },
        ]
      : [];
  const listsOk = ov?.ipLists.filter((l) => l.count > 0 && !l.error).length ?? 0;
  const listErrors = ov?.ipLists.filter((l) => l.error) ?? [];

  return (
    <DashContext.Provider value={dash}>
      <div className="mx-auto max-w-[1480px] px-3 py-6 sm:px-6 lg:py-10">
        <Toolbar site={site} sites={sites!} q={q} update={update} overview={ov ?? null} onRefresh={() => setReloadKey((k) => k + 1)} loading={loading} section="ai" />

        {Object.keys(q.filters).length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {Object.entries(q.filters).map(([k, v]) => (
              <span key={k} className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white py-1 pl-3 pr-1 text-sm shadow-card">
                <span className="text-stone-500">{FILTER_LABELS[k] ?? k} is</span>
                <span className="font-medium">{k === 'category' ? CATEGORY_LABELS[v as AgentCategory] ?? v : k === 'kind' ? KIND_LABELS[v as RequestKind] ?? v : v}</span>
                <button className="rounded-lg px-1.5 text-stone-400 hover:bg-stone-100 hover:text-ink" onClick={() => removeFilter(k)} aria-label="Remove filter">
                  ✕
                </button>
              </span>
            ))}
            <button className="text-sm text-stone-500 underline-offset-2 hover:underline" onClick={() => update({ filters: {} })}>
              Clear all
            </button>
          </div>
        )}

        {ov && !ov.serverConnected && (
          <div className="card mt-5 flex flex-wrap items-center justify-between gap-3 border-violet-200 bg-gradient-to-br from-violet-50 to-white p-5">
            <div className="max-w-2xl">
              <div className="font-semibold">Connect your site to see AI crawlers and assistants</div>
              <p className="mt-1 text-sm text-stone-600">
                ChatGPT, Claude, Perplexity and AI crawlers fetch your pages without running JavaScript, so the tracking script never sees them. A few
                lines of middleware on your server report them here. Visitors who come <i>from</i> AI tools are already counted below.
              </p>
            </div>
            <button className="btn-dark" onClick={() => navigate(`/site/${site.id}/settings#ai-tracking`)}>
              Set up AI tracking →
            </button>
          </div>
        )}

        <div className={`card mt-5 overflow-hidden transition-opacity ${stale ? 'opacity-50' : ''}`}>
          <div className="grid grid-cols-2 border-b border-stone-100 sm:grid-cols-3 lg:grid-cols-6">
            {tiles.map((t) => (
              <div key={t.label} className="border-stone-100 px-5 py-4 lg:border-r lg:last:border-r-0" title={t.hint}>
                <div className="flex items-center gap-1.5 text-sm text-stone-500">
                  {t.dot && <span className="h-2.5 w-2.5 rounded-sm" style={{ background: t.dot }} />}
                  {t.label}
                </div>
                <div className="mt-1 text-[28px] font-semibold leading-tight tracking-tight">{t.value}</div>
                <div className="flex items-center gap-2">
                  <Change cur={t.cur} prev={t.prev} />
                  {t.sub && <span className="truncate text-xs text-stone-400">{t.sub}</span>}
                </div>
              </div>
            ))}
            {!ov && <div className="col-span-full h-[98px] animate-pulse bg-stone-50" />}
          </div>
          {ov && <AiChart data={ov} human={human} />}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <AiPanel
            siteId={siteId}
            q={q}
            reloadKey={reloadKey}
            onFilter={addFilter}
            title="Requests"
            tabs={[
              { label: 'Agents', dim: 'agent', filter: 'agent', empty: 'No AI agents in this period' },
              { label: 'Companies', dim: 'operator', filter: 'operator' },
              { label: 'Type', dim: 'category', filter: 'category' },
              { label: 'Country', dim: 'country' },
            ]}
          />
          <AiPanel
            siteId={siteId}
            q={q}
            reloadKey={reloadKey}
            onFilter={addFilter}
            title="Requests"
            tabs={[
              { label: 'Read in AI answers', dim: 'path', scope: 'answers', filter: 'path', empty: 'No assistant fetched a page live in this period' },
              { label: 'Crawled pages', dim: 'path', scope: 'crawlers', filter: 'path' },
              { label: 'Component installs', dim: 'path', scope: 'installs', filter: 'path', empty: 'No registry items (/r/*.json) were fetched in this period' },
              { label: 'llms.txt & Markdown', dim: 'path', scope: 'docs', filter: 'path' },
              { label: 'Request type', dim: 'kind', filter: 'kind' },
            ]}
          />
          <Panel
            tabs={[
              { label: 'Visitors from AI', dim: 'source', filter: 'source' },
              { label: 'AI landing pages', dim: 'entry_page', filter: 'entry_page' },
              { label: 'Country', dim: 'country', filter: 'country' },
            ]}
          />
          <RecentHits siteId={siteId} q={q} reloadKey={reloadKey} tz={site.timezone} />
        </div>

        <div className="mt-5">
          <CrawlToRefer siteId={siteId} q={q} humanQ={humanQ} reloadKey={reloadKey} />
        </div>

        <div className="mt-5">
          <PromptMonitor site={site} />
        </div>

        <p className="mt-8 text-center text-xs text-stone-500">
          {ov && (
            <>
              {listsOk ? `Bots verified against ${listsOk} published IP lists` : 'IP lists not loaded yet'}
              {ov.ipLists[0] && ` (updated ${fmtAgo(Date.now() - Math.min(...ov.ipLists.map((l) => l.fetched_at)))} ago)`}
              {listErrors.length > 0 && <span title={listErrors.map((l) => `${l.list}: ${l.error}`).join('\n')}> · {listErrors.length} failed</span>} ·{' '}
            </>
          )}
          <button className="underline-offset-2 hover:underline" onClick={() => navigate(`/site/${site.id}/settings#ai-tracking`)}>
            AI tracking setup
          </button>
        </p>
      </div>
    </DashContext.Provider>
  );
}
