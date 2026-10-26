import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type EngineId, type PromptRun, type PromptsData, type Site } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';
import { Favicon } from './Icons';
import { Modal } from './Modal';

const ENGINE_COLORS: Record<EngineId, string> = { chatgpt: '#10a37f', claude: '#d97757', perplexity: '#20808d', gemini: '#4285f4' };
const DAYS = [
  { value: 1, label: 'Every day' },
  { value: 3, label: 'Every 3 days' },
  { value: 7, label: 'Every week' },
  { value: 14, label: 'Every 2 weeks' },
  { value: 30, label: 'Every month' },
  { value: 0, label: 'Only when I click Run' },
];

function hostOf(c: { url: string; title?: string }) {
  try {
    const h = new URL(c.url).hostname.replace(/^www\./, '');
    // Gemini links go through a Google redirect; the title holds the publisher's domain.
    return h.endsWith('vertexaisearch.cloud.google.com') ? (c.title ?? h).toLowerCase().replace(/^www\./, '') : h;
  } catch {
    return c.title ?? c.url;
  }
}

function ownHost(h: string, domain: string) {
  return h === domain || h.endsWith('.' + domain);
}

/** One answer's result in a table cell. */
function ResultCell({ run, busy }: { run?: PromptRun; busy: boolean }) {
  if (busy) return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-stone-300 border-t-ink" />;
  if (!run) return <span className="text-stone-300">—</span>;
  if (run.error)
    return (
      <span className="cursor-help text-red-500" title={run.error}>
        Error
      </span>
    );
  if (run.cited)
    return (
      <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700" title={`Cited as source #${run.position}${run.mentioned ? ' and mentioned by name' : ''}`}>
        Cited #{run.position}
      </span>
    );
  if (run.mentioned)
    return (
      <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700" title="Mentioned by name, but your site wasn't one of the sources">
        Mentioned
      </span>
    );
  return <span className="text-xs text-stone-400">Not mentioned</span>;
}

function AnswersModal({ siteId, prompt, domain, onClose }: { siteId: string; prompt: { id: string; prompt: string } | null; domain: string; onClose: () => void }) {
  const { data } = useApi<PromptRun[]>(prompt ? `/api/sites/${siteId}/ai/prompts/${prompt.id}/runs` : null);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [prompt?.id]);
  const run = data?.[i];
  return (
    <Modal open={!!prompt} onClose={onClose} title={prompt?.prompt} width="max-w-3xl">
      {!data && <div className="h-40 animate-pulse rounded-xl bg-stone-50" />}
      {data?.length === 0 && <p className="text-sm text-stone-500">Not asked yet. Click Run.</p>}
      {data && data.length > 0 && (
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="flex shrink-0 flex-row gap-1 overflow-x-auto sm:w-48 sm:flex-col">
            {data.map((r, j) => (
              <button key={r.id} className={`rounded-lg px-2.5 py-1.5 text-left text-sm ${j === i ? 'bg-stone-100 font-medium' : 'hover:bg-stone-50'}`} onClick={() => setI(j)}>
                <div className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="h-2 w-2 rounded-full" style={{ background: ENGINE_COLORS[r.engine] }} />
                  {r.engine === 'chatgpt' ? 'ChatGPT' : r.engine[0].toUpperCase() + r.engine.slice(1)}
                  {r.cited ? <span className="text-emerald-600">✓</span> : r.mentioned ? <span className="text-amber-600">~</span> : null}
                </div>
                <div className="whitespace-nowrap text-xs text-stone-400">{fmtAgo(Date.now() - r.ts)} ago</div>
              </button>
            ))}
          </div>
          {run && (
            <div className="min-w-0 flex-1">
              <div className="mb-2 text-xs text-stone-500">
                {run.model} · {fmtDateTime(run.ts, Intl.DateTimeFormat().resolvedOptions().timeZone)}
              </div>
              {run.error ? (
                <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{run.error}</p>
              ) : (
                <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-xl bg-stone-50 p-4 text-sm leading-relaxed">{run.answer || '(empty answer)'}</div>
              )}
              {run.citations.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wider text-stone-500">Sources</div>
                  <ol className="space-y-1 text-sm">
                    {run.citations.map((c, k) => {
                      const h = hostOf(c);
                      return (
                        <li key={k} className={`flex items-center gap-2 ${ownHost(h, domain) ? 'font-medium text-emerald-700' : ''}`}>
                          <span className="w-5 shrink-0 text-right text-xs text-stone-400">{k + 1}</span>
                          <Favicon domain={h} size={14} />
                          <a href={c.url} target="_blank" rel="noopener noreferrer" className="truncate hover:underline">
                            {c.title && c.title !== h ? `${c.title} — ${h}` : h}
                          </a>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function PromptMonitor({ site }: { site: Site }) {
  const [reload, setReload] = useState(0);
  const { data, setData } = useApi<PromptsData>(`/api/sites/${site.id}/ai/prompts`, reload);
  const [draft, setDraft] = useState('');
  const [terms, setTerms] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<{ id: string; prompt: string } | null>(null);
  const domain = site.domain.replace(/^www\./, '');

  // Assistants that can run now, plus any that answered before (their key may have been removed since).
  const engines = data?.engines.filter((e) => e.configured || data.latest.some((r) => r.engine === e.id)) ?? [];
  const canRun = !!data?.engines.some((e) => e.configured);
  const latest = useMemo(() => {
    const m = new Map<string, PromptRun>();
    for (const r of data?.latest ?? []) m.set(`${r.prompt_id}|${r.engine}`, r);
    return m;
  }, [data]);

  // Visibility: share of the latest answers (one per prompt and assistant) that mention or cite the site.
  const score = useMemo(() => {
    const ok = (data?.latest ?? []).filter((r) => !r.error);
    const per = Object.fromEntries(
      (data?.engines ?? []).map((e) => {
        const rs = ok.filter((r) => r.engine === e.id);
        return [e.id, { runs: rs.length, mentioned: rs.filter((r) => r.mentioned || r.cited).length, cited: rs.filter((r) => r.cited).length }];
      }),
    );
    return { runs: ok.length, mentioned: ok.filter((r) => r.mentioned || r.cited).length, cited: ok.filter((r) => r.cited).length, per };
  }, [data]);

  // The sites assistants cite most for your prompts: your competition for the answer.
  const competitors = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of data?.latest ?? []) {
      const seen = new Set<string>();
      for (const c of r.citations) {
        const h = hostOf(c);
        if (seen.has(h)) continue;
        seen.add(h);
        count.set(h, (count.get(h) ?? 0) + 1);
      }
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [data]);

  const trend = useMemo(() => {
    const byDay = new Map<string, { day: string; runs: number; mentioned: number }>();
    for (const h of data?.history ?? []) {
      const d = byDay.get(h.day) ?? { day: h.day, runs: 0, mentioned: 0 };
      d.runs += h.runs;
      d.mentioned += Math.max(h.mentioned, h.cited);
      byDay.set(h.day, d);
    }
    return [...byDay.values()].map((d) => ({ day: d.day, rate: d.runs ? d.mentioned / d.runs : 0 }));
  }, [data]);

  async function add() {
    const prompts = draft.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!prompts.length) return;
    setError('');
    try {
      await api(`/api/sites/${site.id}/ai/prompts`, { method: 'POST', json: { prompts } });
      setDraft('');
      setReload((r) => r + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function run(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    setError('');
    try {
      await api(`/api/sites/${site.id}/ai/prompts/${id}/run`, { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy((b) => ({ ...b, [id]: false }));
    setReload((r) => r + 1);
  }

  async function runAll() {
    for (const p of data?.prompts ?? []) await run(p.id);
  }

  async function remove(id: string) {
    if (!confirm('Delete this prompt and its answers?')) return;
    await api(`/api/sites/${site.id}/ai/prompts/${id}`, { method: 'DELETE' });
    setData((d) => (d ? { ...d, prompts: d.prompts.filter((p) => p.id !== id) } : d));
  }

  async function saveSettings(patch: { ai_brand_terms?: string; ai_monitor_days?: number }) {
    setError('');
    try {
      const s = await api<Site>(`/api/sites/${site.id}`, { method: 'PATCH', json: patch });
      setData((d) => (d ? { ...d, brandTerms: s.ai_brand_terms ?? null, days: s.ai_monitor_days ?? d.days } : d));
      setTerms(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const anyBusy = Object.values(busy).some(Boolean);

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3 className="text-lg font-semibold">Prompt monitoring</h3>
          <p className="mt-1 text-sm text-stone-500">
            Asks AI assistants (with web search on, like their apps) the questions your customers ask, and checks whether the answer names{' '}
            {site.name} and cites {domain}.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {data?.engines.map((e) => (
            <span
              key={e.id}
              className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${e.configured ? 'border-stone-200 bg-white' : 'border-dashed border-stone-300 text-stone-400'}`}
              title={e.configured ? `Model: ${e.model}` : `Not set up: npx wrangler secret put ${e.secret}`}
            >
              <Favicon domain={e.domain} size={14} />
              {e.label}
              {!e.configured && <span>off</span>}
            </span>
          ))}
        </div>
      </div>

      {data && !canRun && (
        <div className="mt-4 rounded-xl bg-stone-50 p-4 text-sm text-stone-600">
          Add at least one assistant's API key as a Worker secret, then redeploy:
          <code className="code mt-2">{`npx wrangler secret put OPENAI_API_KEY      # ChatGPT
npx wrangler secret put ANTHROPIC_API_KEY   # Claude
npx wrangler secret put PERPLEXITY_API_KEY  # Perplexity
npx wrangler secret put GEMINI_API_KEY      # Gemini`}</code>
        </div>
      )}
      {data && !data.allowed && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Prompt monitoring isn't available for this site.</p>}

      {data && score.runs > 0 && (
        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-stone-100 p-4">
            <div className="text-sm text-stone-500">Visibility</div>
            <div className="mt-1 text-[28px] font-semibold leading-tight">{fmtPct(score.mentioned / score.runs)}</div>
            <div className="text-xs text-stone-500">
              of answers mention you · cited in {fmtPct(score.cited / score.runs)}
            </div>
            <div className="mt-3 space-y-1.5">
              {engines.map((e) => {
                const s = score.per[e.id];
                return (
                  <div key={e.id} className="flex items-center gap-2 text-sm">
                    <span className="w-20 shrink-0 text-stone-600">{e.label}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
                      <div className="h-full rounded-full" style={{ width: s?.runs ? `${(s.mentioned / s.runs) * 100}%` : 0, background: ENGINE_COLORS[e.id] }} />
                    </div>
                    <span className="w-10 shrink-0 text-right text-xs text-stone-500">{s?.runs ? fmtPct(s.mentioned / s.runs) : '—'}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="rounded-xl border border-stone-100 p-4">
            <div className="text-sm text-stone-500">Mention rate over time</div>
            <div className="mt-2 h-[150px]">
              {trend.length > 1 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="#efedea" strokeDasharray="4 4" />
                    <XAxis dataKey="day" tick={{ fill: '#78716c', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(d) => String(d).slice(5)} minTickGap={20} />
                    <YAxis domain={[0, 1]} tick={{ fill: '#78716c', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtPct(v)} />
                    <Tooltip formatter={(v) => fmtPct(Number(v))} labelClassName="text-xs" />
                    <Line dataKey="rate" stroke="#8b5cf6" strokeWidth={2} dot={false} type="monotone" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <p className="pt-10 text-center text-xs text-stone-400">Shows up after a few days of answers</p>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-stone-100 p-4">
            <div className="text-sm text-stone-500">Most cited sites for your prompts</div>
            <div className="mt-2 space-y-1">
              {competitors.map(([h, n]) => (
                <div key={h} className={`flex items-center gap-2 text-sm ${ownHost(h, domain) ? 'font-semibold text-emerald-700' : ''}`}>
                  <Favicon domain={h} size={14} />
                  <span className="min-w-0 flex-1 truncate">{h}</span>
                  <span className="text-xs text-stone-500">{n}</span>
                </div>
              ))}
              {!competitors.length && <p className="text-xs text-stone-400">No sources cited yet</p>}
            </div>
          </div>
        </div>
      )}

      {data && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-stone-500">
                <th className="pb-2 font-medium">Prompt</th>
                {engines.map((e) => (
                  <th key={e.id} className="pb-2 text-center font-medium">
                    {e.label}
                  </th>
                ))}
                <th className="pb-2 text-right font-medium">
                  {data.prompts.length > 0 && canRun && (
                    <button className="text-xs font-medium text-violet-700 hover:underline disabled:opacity-40" onClick={runAll} disabled={anyBusy}>
                      Run all
                    </button>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.prompts.map((p) => {
                const last = Math.max(0, ...engines.map((e) => latest.get(`${p.id}|${e.id}`)?.ts ?? 0));
                return (
                  <tr key={p.id} className="group border-t border-stone-100">
                    <td className="max-w-[420px] py-2.5 pr-3">
                      <button className="text-left hover:underline" onClick={() => setViewing(p)} title="See the answers">
                        {p.prompt}
                      </button>
                      <div className="text-xs text-stone-400">{last ? `Asked ${fmtAgo(Date.now() - last)} ago` : 'Not asked yet'}</div>
                    </td>
                    {engines.map((e) => (
                      <td key={e.id} className="py-2.5 text-center">
                        <ResultCell run={latest.get(`${p.id}|${e.id}`)} busy={!!busy[p.id]} />
                      </td>
                    ))}
                    <td className="whitespace-nowrap py-2.5 text-right">
                      <button className="btn px-2.5 py-1 text-xs" onClick={() => run(p.id)} disabled={!!busy[p.id] || !canRun || !data.allowed}>
                        Run
                      </button>
                      <button className="ml-1 rounded-lg px-2 py-1 text-xs text-stone-400 hover:bg-stone-100 hover:text-red-600" onClick={() => remove(p.id)} aria-label="Delete prompt">
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.prompts.length === 0 && <p className="py-4 text-center text-sm text-stone-500">No prompts yet. Add the questions people ask when they could find you.</p>}
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <label className="label">Add prompts (one per line)</label>
          <textarea
            className="input min-h-[84px]"
            placeholder={`best React component library for dashboards\nshadcn alternatives with animations\nfree Tailwind UI components for SaaS`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
            }}
          />
          <button className="btn-dark mt-2" onClick={add} disabled={!draft.trim()}>
            Add prompts
          </button>
        </div>
        {data && (
          <div className="space-y-3">
            <div>
              <label className="label">Brand names that count as a mention</label>
              <div className="flex gap-2">
                <input className="input" placeholder={`${site.name}, ${domain}`} value={terms ?? data.brandTerms ?? ''} onChange={(e) => setTerms(e.target.value)} />
                {terms !== null && (
                  <button className="btn-dark" onClick={() => saveSettings({ ai_brand_terms: terms })}>
                    Save
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-stone-500">Comma-separated. Empty uses “{site.name}”. Spacing and case don't matter.</p>
            </div>
            <div>
              <label className="label">Ask again</label>
              <select className="input" value={data.days} onChange={(e) => saveSettings({ ai_monitor_days: Number(e.target.value) })}>
                {DAYS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-stone-500">Each prompt costs one paid API call per assistant every time it's asked.</p>
            </div>
          </div>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <AnswersModal siteId={site.id} prompt={viewing} domain={domain} onClose={() => setViewing(null)} />
    </div>
  );
}
