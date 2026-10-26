import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { navigate } from '../App';
import type { Overview, Query, Site } from '../lib/api';
import { dayInTz } from '../lib/format';
import { Favicon } from './Icons';

export const PERIODS: { value: string; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '48h', label: 'Last 2 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];

const SHORTCUTS: Record<string, string> = { t: 'today', y: 'yesterday', '7': '7d', '3': '30d', a: 'all' };
const HINTS = Object.fromEntries(Object.entries(SHORTCUTS).map(([k, v]) => [v, k.toUpperCase()]));

/** Mirrors MAX_HOURLY_SPAN in the worker: longer ranges can't be shown hourly. */
const MAX_HOURLY_SPAN = 31 * 86_400_000 + 2 * 3_600_000;

const GRANULARITIES = [
  { value: 'hour', label: 'Hourly' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

export function Dropdown({
  button,
  children,
  align = 'left',
  onOpen,
}: {
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      if (ref.current?.contains(document.activeElement)) ref.current.querySelector<HTMLElement>('button')?.focus();
    };
    document.addEventListener('mousedown', on);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', on);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const toggle = () => {
    if (!open) onOpen?.();
    setOpen(!open);
  };
  return (
    <div className="relative flex" ref={ref}>
      <div className="flex" onClick={toggle}>
        {isValidElement(button) ? cloneElement(button as ReactElement<{ 'aria-expanded'?: boolean }>, { 'aria-expanded': open }) : button}
      </div>
      {open && (
        <div className={`card absolute top-full z-40 mt-2 min-w-[200px] max-w-[calc(100vw-2rem)] overflow-hidden p-1 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const Chevron = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

function itemCls(active: boolean) {
  return `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-stone-100 ${active ? 'font-medium text-ink' : 'text-stone-600'}`;
}

export function Toolbar({
  site,
  sites,
  q,
  update,
  overview,
  onRefresh,
  onLive,
  loading,
}: {
  site: Site;
  sites: Site[];
  q: Query;
  update: (p: Partial<Query>) => void;
  overview: Overview | null;
  onRefresh: () => void;
  onLive: () => void;
  loading: boolean;
}) {
  const [from, setFrom] = useState(q.from ?? '');
  const [to, setTo] = useState(q.to ?? '');

  const label =
    q.period === 'custom'
      ? q.from === q.to
        ? new Date(q.from + 'T00:00:00Z').toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        : `${q.from} → ${q.to}`
      : PERIODS.find((p) => p.value === q.period)?.label ?? 'Last 30 days';

  function shift(dir: -1 | 1) {
    if (!overview) return;
    const { from, to } = overview.range;
    const span = Math.max(to - from, 86_400_000);
    const nf = from + dir * span;
    const nt = nf + span - 1;
    if (nf > Date.now()) return;
    update({ period: 'custom', from: dayInTz(nf, site.timezone), to: dayInTz(Math.min(nt, Date.now()), site.timezone) });
  }
  const canForward = overview ? overview.range.to < Date.now() - 60_000 : false;

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('[aria-modal="true"]')) return;
    const period = SHORTCUTS[e.key.toLowerCase()];
    if (period) {
      e.preventDefault();
      update({ period, granularity: undefined });
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      shift(-1);
    } else if (e.key === 'ArrowRight' && canForward) {
      e.preventDefault();
      shift(1);
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dropdown
        button={
          <button className="btn h-11 px-4 text-base">
            <Favicon domain={site.domain} size={22} />
            <span className="max-w-[180px] truncate font-semibold">{site.name}</span>
            <Chevron />
          </button>
        }
      >
        {(close) => (
          <>
            {sites.map((s) => (
              <button
                key={s.id}
                className={itemCls(s.id === site.id)}
                onClick={() => {
                  close();
                  navigate(`/site/${s.id}${window.location.search}`);
                }}
              >
                <Favicon domain={s.domain} size={16} /> {s.name}
              </button>
            ))}
            <div className="my-1 border-t border-stone-100" />
            <button className={itemCls(false)} onClick={() => navigate(`/site/${site.id}/settings`)}>
              ⚙️ Site settings & install
            </button>
            <button className={itemCls(false)} onClick={() => navigate('/')}>
              ＋ All websites
            </button>
          </>
        )}
      </Dropdown>

      <div className="flex h-11 items-stretch rounded-xl border border-stone-200 bg-white shadow-card">
        <button className="rounded-l-xl px-3 text-xl text-stone-500 hover:bg-stone-50" onClick={() => shift(-1)} aria-label="Previous period" title="Previous period (←)">
          ‹
        </button>
        <Dropdown
          button={
            <button className="flex h-full items-center gap-2 border-x border-stone-200 px-4 text-base font-medium hover:bg-stone-50">
              {label} <Chevron />
            </button>
          }
          onOpen={() => {
            setFrom(q.from ?? '');
            setTo(q.to ?? '');
          }}
        >
          {(close) => (
            <>
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  className={itemCls(q.period === p.value)}
                  onClick={() => {
                    close();
                    update({ period: p.value, granularity: undefined });
                  }}
                >
                  {p.label}
                  {HINTS[p.value] && <kbd className="ml-auto hidden rounded border border-stone-200 px-1.5 font-sans text-[11px] leading-4 text-stone-500 sm:block">{HINTS[p.value]}</kbd>}
                </button>
              ))}
              <div className="my-1 border-t border-stone-100" />
              <form
                className="space-y-2 p-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!from || !to) return;
                  close();
                  update({ period: 'custom', from, to: to < from ? from : to, granularity: undefined });
                }}
              >
                <div className="text-xs font-medium text-stone-500">Custom range</div>
                <input type="date" className="input py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} />
                <input type="date" className="input py-1.5" value={to} onChange={(e) => setTo(e.target.value)} />
                <button className="btn-dark w-full py-1.5">Apply</button>
              </form>
            </>
          )}
        </Dropdown>
        <button
          className="rounded-r-xl px-3 text-xl text-stone-500 hover:bg-stone-50 disabled:opacity-30"
          onClick={() => shift(1)}
          disabled={!canForward}
          aria-label="Next period"
          title="Next period (→)"
        >
          ›
        </button>
      </div>

      <Dropdown
        align="right"
        button={
          <button className="btn h-11 px-4 text-base">
            {GRANULARITIES.find((g) => g.value === (overview?.range.granularity ?? q.granularity))?.label ?? 'Daily'} <Chevron />
          </button>
        }
      >
        {(close) =>
          GRANULARITIES.map((g) => {
            const tooLong = g.value === 'hour' && !!overview && overview.range.to - overview.range.from > MAX_HOURLY_SPAN;
            return (
              <button
                key={g.value}
                className={`${itemCls((overview?.range.granularity ?? q.granularity) === g.value)} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
                disabled={tooLong}
                title={tooLong ? 'Hourly is available for ranges up to 31 days' : undefined}
                onClick={() => {
                  close();
                  update({ granularity: g.value });
                }}
              >
                {g.label}
              </button>
            );
          })
        }
      </Dropdown>

      <button className="btn h-11 px-4 text-base" onClick={onLive} title="Live map (M)">
        <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" /> Live
      </button>

      <button className="btn h-11 w-11 px-0" onClick={onRefresh} aria-label="Refresh">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? 'animate-spin' : ''}>
          <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>
    </div>
  );
}
