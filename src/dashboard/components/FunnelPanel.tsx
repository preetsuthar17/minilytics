import { useId, useRef, useState } from 'react';
import { api, qs, type BreakdownRow } from '../lib/api';
import { useDash } from '../lib/context';
import { fmtNumber, fmtPct } from '../lib/format';
import { suggestFunnels, type FunnelStepDef, type FunnelSuggestion, type StepType } from '../lib/funnelSuggest';
import { useApi } from '../lib/useApi';
import { PERIODS } from './Toolbar';
import { useUrlParam } from '../lib/useQueryState';

interface FunnelDef {
  id: string;
  name: string;
  steps: FunnelStepDef[];
}
type StepStat = FunnelStepDef & { visitors: number; revenue?: number };

const MAX_STEPS = 10;
const ICON: Record<StepType, string> = { page: '', goal: '🎯 ', payment: '💳 ' };
const TYPE_NAME: Record<StepType, string> = { page: 'Page', goal: 'Goal', payment: 'Payment' };
const stepText = (s: FunnelStepDef) => (s.type === 'payment' ? 'Payment' : s.value);

export function FunnelPanel() {
  const { site, q, reloadKey } = useDash();
  const [selected, setSelected] = useUrlParam('funnel');
  const [draft, setDraft] = useState<FunnelSuggestion | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const { data: funnels, setData: setFunnels } = useApi<FunnelDef[]>(`/api/sites/${site.id}/funnels`);
  const current = funnels?.find((f) => f.id === selected) ?? funnels?.[0];
  const empty = funnels?.length === 0;
  const editing = creating || draft !== null;
  const { data: stats, stale } = useApi<StepStat[]>(current && !editing ? `/api/sites/${site.id}/funnels/${current.id}/stats?${qs(q)}` : null, reloadKey);
  const needData = !!funnels && (empty || editing);
  const { data: pages } = useApi<BreakdownRow[]>(needData ? `/api/sites/${site.id}/breakdown?${qs(q, { dim: 'page' })}` : null, reloadKey);
  const { data: goals } = useApi<BreakdownRow[]>(needData ? `/api/sites/${site.id}/breakdown?${qs(q, { dim: 'goal' })}` : null, reloadKey);

  const saved = (f: FunnelDef) => {
    setFunnels((prev) => [...(prev ?? []), f]);
    setSelected(f.id);
    setDraft(null);
    setCreating(false);
  };
  const quickCreate = async (s: FunnelSuggestion) => {
    setError('');
    try {
      saved(await api<FunnelDef>(`/api/sites/${site.id}/funnels`, { method: 'POST', json: s }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const cancel = () => {
    setDraft(null);
    setCreating(false);
  };

  return (
    <section className="card min-w-0 p-3" aria-labelledby="funnel-title">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-1 pb-3">
        <div className="min-w-0">
          <h2 id="funnel-title" className="text-sm font-semibold">
            Funnel
          </h2>
          <p className="text-xs text-stone-500">Where visitors drop off on the way to paying</p>
        </div>
        {!!funnels?.length && !editing && current && (
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <select className="input min-w-0 flex-1 py-1.5 sm:w-auto sm:max-w-[240px] sm:flex-none" aria-label="Funnel" value={current.id} onChange={(e) => setSelected(e.target.value)}>
              {funnels.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <button className="btn shrink-0 py-1.5" onClick={() => setCreating(true)}>
              <span>
                + New<span className="hidden sm:inline"> funnel</span>
              </span>
            </button>
            <button
              className="btn shrink-0 py-1.5 text-red-600"
              onClick={async () => {
                if (!confirm(`Delete funnel "${current.name}"?`)) return;
                await api(`/api/sites/${site.id}/funnels/${current.id}`, { method: 'DELETE' });
                setFunnels((prev) => (prev ?? []).filter((f) => f.id !== current.id));
                setSelected(null);
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {!funnels ? (
        <div className="h-72 animate-pulse rounded-xl bg-stone-50" />
      ) : editing ? (
        <FunnelForm key={draft?.name ?? 'new'} initial={draft} pages={pages ?? []} goals={goals ?? []} onSaved={saved} onCancel={cancel} />
      ) : empty ? (
        <Starter
          suggestions={pages && goals ? suggestFunnels(pages, goals) : null}
          error={error}
          onCreate={quickCreate}
          onEdit={(s) => setDraft(s)}
          onCustom={() => setCreating(true)}
        />
      ) : stats ? (
        <div className={`px-1 transition-opacity ${stale ? 'opacity-50' : ''}`}>
          <FunnelChart stats={stats} />
        </div>
      ) : (
        <div className="h-72 animate-pulse rounded-xl bg-stone-50" />
      )}
    </section>
  );
}

function StepChips({ steps }: { steps: FunnelStepDef[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs">
      {steps.map((s, i) => (
        <li key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <span className="text-stone-400">→</span>}
          <span className={`truncate rounded-md px-1.5 py-0.5 ${s.type === 'payment' ? 'bg-revenueSoft/60 text-revenue' : 'bg-stone-100 text-stone-700'}`}>
            {ICON[s.type]}
            {stepText(s)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Starter({
  suggestions,
  error,
  onCreate,
  onEdit,
  onCustom,
}: {
  suggestions: FunnelSuggestion[] | null;
  error: string;
  onCreate: (s: FunnelSuggestion) => Promise<void>;
  onEdit: (s: FunnelSuggestion) => void;
  onCustom: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  return (
    <div className="px-1 pb-1">
      <p className="mb-3 text-sm text-stone-500">
        {suggestions && !suggestions.length
          ? 'No funnel yet. Suggestions appear once pages and goals are tracked in this period.'
          : 'No funnel yet. Start from one built from your traffic in this period, or build your own.'}
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {!suggestions
          ? [0, 1].map((i) => <div key={i} className="h-32 animate-pulse rounded-xl bg-stone-50" />)
          : suggestions.map((s, i) => (
              <div key={s.name} className="flex min-w-0 flex-col gap-2 rounded-xl border border-stone-200 p-3">
                <div className="text-sm font-medium">{s.name}</div>
                <StepChips steps={s.steps} />
                <div className="mt-auto flex gap-2 pt-1">
                  <button
                    className={i === 0 ? 'btn-dark py-1.5' : 'btn py-1.5'}
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(i);
                      await onCreate(s);
                      setBusy(null);
                    }}
                  >
                    {busy === i ? 'Creating…' : 'Create funnel'}
                  </button>
                  <button className="btn py-1.5" onClick={() => onEdit(s)}>
                    Edit first
                  </button>
                </div>
              </div>
            ))}
        <button
          className="flex min-h-[8rem] flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-stone-300 p-3 text-sm text-stone-500 transition hover:border-stone-400 hover:text-ink"
          onClick={onCustom}
        >
          <span className="text-lg leading-none">+</span>
          Build your own
        </button>
      </div>
      {error && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const pctLabel = (n: number) => (n >= 0.01 || n === 0 ? fmtPct(n, n === 1 || n === 0 ? 0 : 1) : fmtPct(n));

const CHART_ICON: Record<StepType, string> = { page: '📄 ', goal: '🎯 ', payment: '💰 ' };
const BAND_MAX = 88;
const BAND_MIN = 1.4;
const HALO = 2.6;

function bandPath(hs: number[], extra: number) {
  const n = hs.length;
  const top = hs.map((h) => 50 - h / 2 - extra);
  const bot = hs.map((h) => 50 + h / 2 + extra);
  let d = `M0 ${top[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const x = i * 100;
    d += ` L${x + 10} ${top[i]} C${x + 55} ${top[i]} ${x + 55} ${top[i + 1]} ${x + 100} ${top[i + 1]}`;
  }
  d += ` L${n * 100} ${top[n - 1]} L${n * 100} ${bot[n - 1]}`;
  for (let i = n - 2; i >= 0; i--) {
    const x = i * 100;
    d += ` L${x + 100} ${bot[i + 1]} C${x + 55} ${bot[i + 1]} ${x + 55} ${bot[i]} ${x + 10} ${bot[i]}`;
  }
  return `${d} L0 ${bot[0]} Z`;
}

function FunnelChart({ stats }: { stats: StepStat[] }) {
  const { money, q } = useDash();
  const uid = useId().replace(/:/g, '');
  const n = stats.length;
  const top = stats[0]?.visitors || 0;
  const last = stats[n - 1]?.visitors ?? 0;
  const hs = stats.map((s) => (top ? Math.max(BAND_MIN, (s.visitors / top) * BAND_MAX) : BAND_MIN));
  const main = bandPath(hs, 0);
  const halo = bandPath(hs, HALO);
  const alpha = (i: number) => (n === 1 ? 0.35 : 0.1 + (0.55 * i) / (n - 1));
  const period = q.from && q.to ? `${q.from} – ${q.to}` : PERIODS.find((p) => p.value === q.period)?.label ?? '';

  return (
    <div className="relative">
      <div className="pointer-events-none absolute right-3 top-2 z-20 text-right">
        <div className="text-[15px] font-semibold tracking-tight">{top && n > 1 ? `${pctLabel(last / top)} conversion rate` : top ? `${fmtNumber(top)} visitors` : 'No visitors yet'}</div>
        <div className="text-sm text-stone-500">{period}</div>
      </div>
      <div className="-mx-3 overflow-x-auto">
        <div className="relative grid h-[400px] grid-flow-col" style={{ gridAutoColumns: 'minmax(132px, 1fr)', minWidth: '100%' }}>
          <svg className="pointer-events-none absolute inset-x-0 top-0 h-[310px] w-full" viewBox={`0 0 ${n * 100} 100`} preserveAspectRatio="none" aria-hidden>
            <defs>
              {stats.map((_, i) => (
                <clipPath key={i} id={`${uid}c${i}`}>
                  <rect x={i * 100} y="0" width="100" height="100" />
                </clipPath>
              ))}
            </defs>
            {stats.map((_, i) => (
              <g key={i} clipPath={`url(#${uid}c${i})`}>
                <path d={halo} fill={`rgba(96,165,250,${alpha(i) * 0.4})`} style={{ transition: 'd 500ms cubic-bezier(0.23,1,0.32,1)' }} />
                <path d={main} fill={`rgba(96,165,250,${alpha(i)})`} style={{ transition: 'd 500ms cubic-bezier(0.23,1,0.32,1)' }} />
              </g>
            ))}
          </svg>
          {stats.map((s, i) => {
            const prev = i ? stats[i - 1].visitors : s.visitors;
            const lost = prev - s.visitors;
            const pay = s.type === 'payment';
            const next = stats[i + 1];
            const drop = next && s.visitors ? 1 - next.visitors / s.visitors : null;
            const align = n === 1 ? 'left-1/2 -translate-x-1/2' : i === 0 ? 'left-3' : i === n - 1 ? 'right-3' : 'left-1/2 -translate-x-1/2';
            return (
              <div key={i} className={`group relative flex min-w-0 flex-col justify-end px-4 pb-4 transition-colors hover:bg-stone-900/[0.015] ${i ? 'border-l border-stone-100' : ''}`}>
                <div className="relative z-10 min-w-0">
                  <div className="text-[15px] font-semibold tracking-tight">
                    {fmtNumber(s.visitors)} {s.visitors === 1 ? 'visitor' : 'visitors'}
                  </div>
                  {pay && <div className="text-sm font-medium text-revenue">{money(s.revenue ?? 0)}</div>}
                  <div className="truncate text-[15px] text-stone-600" title={stepText(s)}>
                    {i === 0 && s.type === 'page' ? '👋 ' : CHART_ICON[s.type]}
                    {stepText(s)}
                  </div>
                </div>
                {next && (
                  <div className="absolute right-0 top-[155px] z-10 -translate-y-1/2 translate-x-1/2 whitespace-nowrap rounded-full bg-white/85 px-2 py-0.5 text-xs font-medium text-stone-600 shadow-sm ring-1 ring-stone-200/80 backdrop-blur-sm">
                    {drop === null ? '—' : `−${pctLabel(drop)}`} →
                  </div>
                )}
                <div className={`pointer-events-none absolute top-16 z-30 hidden w-52 rounded-xl bg-ink px-3 py-2 text-xs text-white shadow-lg group-hover:block ${align}`}>
                  <div className="mb-1 truncate font-medium">
                    {i + 1}. {TYPE_NAME[s.type]}
                    {pay ? '' : ` ${s.value}`}
                  </div>
                  <div className="flex justify-between"><span className="text-stone-400">Visitors</span>{fmtNumber(s.visitors)}</div>
                  {pay && <div className="flex justify-between"><span className="text-stone-400">Revenue</span>{money(s.revenue ?? 0)}</div>}
                  {i > 0 && <div className="flex justify-between"><span className="text-stone-400">From previous</span>{prev ? pctLabel(s.visitors / prev) : '—'}</div>}
                  {i > 0 && <div className="flex justify-between"><span className="text-stone-400">Dropped off</span>{fmtNumber(lost)}{prev ? ` (${pctLabel(lost / prev)})` : ''}</div>}
                  <div className="flex justify-between"><span className="text-stone-400">From start</span>{top ? pctLabel(s.visitors / top) : '—'}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type DraftStep = FunnelStepDef & { key: number };

function validate(name: string, steps: FunnelStepDef[]) {
  const stepErrors = steps.map((s) => {
    if (s.type === 'payment') return '';
    if (!s.value.trim()) return s.type === 'page' ? 'Enter a page path, like /pricing' : 'Enter a goal name';
    if (s.type === 'page' && !/^[/*]/.test(s.value.trim())) return 'Page paths start with /';
    return '';
  });
  return {
    name: name.trim() ? '' : 'Give the funnel a name',
    steps: stepErrors,
    count: steps.length < 2 ? 'Add at least 2 steps' : '',
    any: !name.trim() || steps.length < 2 || stepErrors.some(Boolean),
  };
}

function FunnelForm({
  initial,
  pages,
  goals,
  onSaved,
  onCancel,
}: {
  initial: FunnelSuggestion | null;
  pages: BreakdownRow[];
  goals: BreakdownRow[];
  onSaved: (f: FunnelDef) => void;
  onCancel: () => void;
}) {
  const { site } = useDash();
  const ids = useId();
  const nextKey = useRef(0);
  const withKey = (s: FunnelStepDef): DraftStep => ({ ...s, key: nextKey.current++ });
  const [name, setName] = useState(initial?.name ?? 'New funnel');
  const [steps, setSteps] = useState<DraftStep[]>(() =>
    (initial?.steps ?? [
      { type: 'page', value: '/' },
      { type: 'page', value: '' },
    ]).map(withKey),
  );
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const errors = validate(name, steps);
  const show = (msg: string) => (tried ? msg : '');
  const set = (i: number, patch: Partial<FunnelStepDef>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((s) => {
      const out = [...s];
      [out[i], out[i + d]] = [out[i + d], out[i]];
      return out;
    });
  const pageList = `${ids}-pages`;
  const goalList = `${ids}-goals`;

  return (
    <form
      className="max-w-2xl space-y-3 px-1 pb-1"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setTried(true);
        setServerError('');
        if (errors.any) return;
        setSaving(true);
        try {
          onSaved(
            await api<FunnelDef>(`/api/sites/${site.id}/funnels`, {
              method: 'POST',
              json: { name, steps: steps.map(({ type, value }) => ({ type, value })) },
            }),
          );
        } catch (err) {
          setServerError((err as Error).message);
          setSaving(false);
        }
      }}
    >
      <p className="text-sm text-stone-500">
        Steps are counted in order per visitor. Page paths support wildcards like <code>/blog/*</code>. Payment counts a visitor's first payment after the previous step.
      </p>
      <div>
        <label className="label" htmlFor={`${ids}-name`}>
          Name
        </label>
        <input
          id={`${ids}-name`}
          className={`input ${show(errors.name) ? 'border-red-300' : ''}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!!show(errors.name)}
          maxLength={100}
        />
        {show(errors.name) && <p className="mt-1 text-xs text-red-600">{errors.name}</p>}
      </div>
      <ol className="space-y-2">
        {steps.map((s, i) => {
          const err = show(errors.steps[i]);
          return (
            <li key={s.key}>
              <div className="flex items-center gap-1.5">
                <span className="hidden h-6 w-6 shrink-0 place-items-center rounded-md bg-stone-100 text-xs text-stone-500 sm:grid">{i + 1}</span>
                <select
                  className="input w-[104px] shrink-0 px-2"
                  aria-label={`Step ${i + 1} type`}
                  value={s.type}
                  onChange={(e) => set(i, { type: e.target.value as StepType, value: '' })}
                >
                  <option value="page">Page</option>
                  <option value="goal">Goal</option>
                  <option value="payment">Payment</option>
                </select>
                {s.type === 'payment' ? (
                  <div className="flex min-w-0 flex-1 items-center self-stretch truncate rounded-xl border border-stone-200 bg-stone-50 px-2.5 text-sm text-stone-500">Any payment</div>
                ) : (
                  <input
                    className={`input min-w-0 flex-1 ${err ? 'border-red-300' : ''}`}
                    aria-label={`Step ${i + 1} ${s.type === 'page' ? 'page path' : 'goal name'}`}
                    aria-invalid={!!err}
                    list={s.type === 'page' ? pageList : goalList}
                    value={s.value}
                    onChange={(e) => set(i, { value: e.target.value })}
                    placeholder={s.type === 'page' ? '/pricing' : 'checkout_started'}
                    autoComplete="off"
                    maxLength={200}
                  />
                )}
                <button type="button" className="btn h-9 w-8 shrink-0 px-0 py-0" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="btn h-9 w-8 shrink-0 px-0 py-0" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  className="btn h-9 w-8 shrink-0 px-0 py-0"
                  aria-label={`Remove step ${i + 1}`}
                  disabled={steps.length <= 2}
                  onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
              {err && <p className="mt-1 text-xs text-red-600 sm:pl-[30px]">{err}</p>}
            </li>
          );
        })}
      </ol>
      <datalist id={pageList}>
        {pages.slice(0, 50).map((p) => p.label && <option key={p.label} value={p.label} />)}
      </datalist>
      <datalist id={goalList}>
        {goals.slice(0, 50).map((g) => g.label && <option key={g.label} value={g.label} />)}
      </datalist>
      {show(errors.count) && <p className="text-xs text-red-600">{errors.count}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={() => setSteps((s) => [...s, withKey({ type: 'page', value: '' })])} disabled={steps.length >= MAX_STEPS}>
          + Add step
        </button>
        <span className="text-xs text-stone-500">
          {steps.length}/{MAX_STEPS}
        </span>
        <div className="ml-auto flex gap-2">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-dark" disabled={saving}>
            {saving ? 'Saving…' : 'Save funnel'}
          </button>
        </div>
      </div>
      {serverError && (
        <p className="text-sm text-red-600" role="alert">
          {serverError}
        </p>
      )}
    </form>
  );
}
