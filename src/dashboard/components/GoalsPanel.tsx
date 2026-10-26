import { useEffect, useState } from 'react';
import { api, qs, type BreakdownRow } from '../lib/api';
import { useDash } from '../lib/context';
import { countryName, fmtAgo, fmtDateTime, fmtDuration, fmtNumber, fmtPct, shortId } from '../lib/format';
import { prefetch, useApi } from '../lib/useApi';
import { Avatar, BrowserIcon, DeviceIcon, Flag, OSIcon, SourceIcon } from './Icons';

type Tab = 'goal' | 'user' | 'journey';

export function GoalsPanel({ totalVisitors }: { totalVisitors: number }) {
  const [tab, setTab] = useState<Tab>('journey');
  const [search, setSearch] = useState('');
  const { site, q, reloadKey } = useDash();
  const warm = (t: Tab) => {
    if (t === 'goal') prefetch(`/api/sites/${site.id}/breakdown?${qs(q, { dim: 'goal' })}`, reloadKey);
    if (t === 'user') prefetch(`/api/sites/${site.id}/customers?${qs(q)}`, reloadKey);
    if (t === 'journey') prefetch(`/api/sites/${site.id}/visitors?${qs(q)}`, reloadKey);
  };
  const warmKey = `${site.id}|${qs(q)}|${reloadKey}`;
  useEffect(() => {
    const id = setTimeout(() => (['goal', 'user', 'journey'] as const).forEach(warm), 1500);
    return () => clearTimeout(id);
  }, [warmKey]);
  return (
    <div className="card min-w-0 p-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 pb-3">
        <div className="tabs min-w-0 max-w-full overflow-x-auto" role="tablist">
          {(['goal', 'user', 'journey'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab whitespace-nowrap capitalize ${tab === t ? 'tab-active' : ''}`} onPointerEnter={() => warm(t)} onClick={() => setTab(t)}>
              {t === 'journey' ? 'Journey' : t === 'user' ? 'Users' : 'Goals'}
            </button>
          ))}
        </div>
        {(tab === 'user' || tab === 'journey') && (
          <input className="input max-w-[240px] py-1.5" placeholder="🔍 Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        )}
      </div>
      {tab === 'goal' && <Goals totalVisitors={totalVisitors} />}
      {tab === 'user' && <Users search={search} />}
      {tab === 'journey' && <Journey search={search} />}
    </div>
  );
}

function Goals({ totalVisitors }: { totalVisitors: number }) {
  const { site, q, reloadKey, money, addFilter } = useDash();
  const { data } = useApi<BreakdownRow[]>(`/api/sites/${site.id}/breakdown?${qs(q, { dim: 'goal' })}`, reloadKey);
  if (!data) return <div className="h-40 animate-pulse" />;
  if (!data.length)
    return (
      <div className="p-8 text-center text-sm text-stone-500">
        No goals yet. Add <code className="rounded bg-stone-100 px-1">data-ml-goal="signup_click"</code> to any button, or call{' '}
        <code className="rounded bg-stone-100 px-1">window.minilytics('goal', 'signup')</code>.
      </div>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-stone-500">
            <th className="px-3 pb-2 font-medium">Goal</th>
            <th className="pb-2 text-right font-medium">Visitors</th>
            <th className="pb-2 text-right font-medium">Completions</th>
            <th className="pb-2 text-right font-medium">Conversion</th>
            <th className="px-3 pb-2 text-right font-medium">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {data.map((g) => (
            <tr key={g.label} className="cursor-pointer border-t border-stone-100 hover:bg-stone-50" onClick={() => addFilter('goal', g.label ?? '')} title="Filter by visitors who completed this goal">
              <td className="px-3 py-2.5 font-medium">🎯 {g.label}</td>
              <td className="py-2.5 text-right">{fmtNumber(g.visitors)}</td>
              <td className="py-2.5 text-right">{fmtNumber(g.pageviews ?? 0)}</td>
              <td className="py-2.5 text-right">{totalVisitors ? fmtPct(g.visitors / totalVisitors, 1) : '—'}</td>
              <td className="px-3 py-2.5 text-right">{money(g.revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VisitorCell({ id, name, email, country, city, device, os, browser, badge }: Record<string, any>) {
  return (
    <div className="flex items-center gap-3">
      <Avatar id={id} size={44} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{name || email || `Visitor ${shortId(id)}`}</span>
          {badge}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-stone-500">
          <span className="flex items-center gap-1">
            <Flag cc={country} size={15} /> {city ? `${city}, ` : ''}
            {countryName(country)}
          </span>
          <span className="flex items-center gap-1">
            <DeviceIcon name={device} size={15} /> {device}
          </span>
          <span className="flex items-center gap-1">
            <OSIcon name={os} size={15} /> {os}
          </span>
          <span className="flex items-center gap-1">
            <BrowserIcon name={browser} size={15} /> {browser}
          </span>
        </div>
      </div>
    </div>
  );
}

function matches(r: Record<string, any>, search: string) {
  if (!search) return true;
  const s = search.toLowerCase();
  return ['name', 'email', 'pay_email', 'pay_name', 'source', 'country', 'city', 'visitor_id', 'utm_campaign', 'ref'].some((k) =>
    String(r[k] ?? '').toLowerCase().includes(s),
  );
}

function ShowAll({ total, shown, onClick }: { total: number; shown: number; onClick: () => void }) {
  if (total <= shown) return null;
  return (
    <button className="mx-auto mt-3 block text-xs font-semibold uppercase tracking-wider text-stone-500 hover:text-ink" onClick={onClick}>
      Show all {total}
    </button>
  );
}

const MATCH_LABELS: Record<string, string> = {
  return_page: 'return page',
  customer: 'earlier payment',
  email: 'email',
  timing: 'checkout click timing',
};

function Journey({ search }: { search: string }) {
  const { site, q, reloadKey, money, openVisitor } = useDash();
  const [all, setAll] = useState(false);
  const [version, setVersion] = useState(0);
  const [rematch, setRematch] = useState<string | null>(null);
  const [rematchError, setRematchError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<{ id: string; name: string | null; matched: boolean; reason: string | null }[]>([]);
  const { data } = useApi<any[]>(`/api/sites/${site.id}/customers?${qs(q)}`, reloadKey + version);
  if (!data) return <div className="h-40 animate-pulse" />;
  if (!data.length)
    return <div className="p-8 text-center text-sm text-stone-500">No payments in this period. Connect Dodo Payments in site settings to see who paid and where they came from.</div>;
  const unmatched = data.filter((r) => !r.visitor_id).length;
  return (
    <div className="overflow-x-auto">
      {unmatched > 0 && (
        <div className="mx-3 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>
            {unmatched} payment{unmatched > 1 ? 's' : ''} not linked to a visitor yet.{' '}
            <a className="underline" href={`/site/${site.id}/settings`}>
              Why?
            </a>
          </span>
          <button
            className="btn py-1.5"
            disabled={rematch === 'working'}
            onClick={async () => {
              setRematch('working');
              setRematchError(null);
              let result: string | null = null;
              try {
                const r = await api<{ matched: number; checked: number; details: typeof reasons }>(`/api/sites/${site.id}/rematch`, {
                  method: 'POST',
                });
                result = `Matched ${r.matched} of ${r.checked}`;
                setReasons(r.details ?? []);
                setVersion((v) => v + 1);
              } catch (e) {
                setRematchError(`Matching failed: ${(e as Error).message}`);
              } finally {
                setRematch(result);
              }
            }}
          >
            {rematch === 'working' ? 'Matching…' : rematch ?? 'Try matching again'}
          </button>
          {rematchError && (
            <p className="w-full text-xs text-red-600" role="alert">
              {rematchError}
            </p>
          )}
          {reasons.length > 0 && (
            <ul className="w-full space-y-1 border-t border-amber-200 pt-2 text-xs">
              {reasons.map((r) => (
                <li key={r.id}>
                  <b>{r.name ?? r.id}</b>: {r.matched ? '✓ matched' : '✗ not matched'}
                  {r.reason ? ` · ${r.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <table className="w-full min-w-[760px] text-[15px]">
        <thead>
          <tr className="text-left text-sm text-stone-500">
            <th className="px-3 pb-3 font-medium">Visitor</th>
            <th className="pb-3 font-medium">Source</th>
            <th className="pb-3 font-medium">Spent</th>
            <th className="pb-3 font-medium">Time to complete</th>
            <th className="pb-3 font-medium">Completed at</th>
          </tr>
        </thead>
        <tbody>
          {data
            .filter((r) => matches(r, search))
            .slice(0, all || search ? undefined : 10)
            .map((r) => (
              <tr
                key={r.id}
                className={`border-t border-stone-100 ${r.visitor_id ? 'cursor-pointer hover:bg-stone-50' : ''}`}
                onClick={() => r.visitor_id && openVisitor(r.visitor_id)}
              >
                <td className="px-3 py-4">
                  <VisitorCell
                    id={r.visitor_id ?? r.id}
                    name={r.name ?? r.pay_name}
                    email={r.email ?? r.pay_email}
                    country={r.country}
                    city={null}
                    device={r.device}
                    os={r.os}
                    browser={r.browser}
                    badge={
                      <span className="rounded-md border border-revenue/30 bg-revenueSoft/50 px-1.5 py-0.5 text-xs text-revenue">
                        {r.renewal ? 'Returning' : 'Customer'}
                      </span>
                    }
                  />
                </td>
                <td className="py-4">
                  {r.session_id ? (
                    <div className="flex items-center gap-2">
                      <SourceIcon source={r.source} domain={r.referrer_domain} />
                      <div>
                        <div>{r.source}</div>
                        {(r.utm_campaign || r.ref) && <div className="text-xs text-stone-500">{r.utm_campaign || r.ref}</div>}
                        {r.matched_by && r.matched_by !== 'metadata' && (
                          <div className="text-xs text-stone-500" title="How this payment was linked to the visitor">
                            matched by {MATCH_LABELS[r.matched_by] ?? r.matched_by}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span className="text-stone-500" title="No visitor id in the payment metadata, and no return-page, email or timing match">
                      Not attributed
                    </span>
                  )}
                </td>
                <td className="py-4 font-medium">{money(r.amount)}</td>
                <td className="py-4">
                  {r.first_seen ? fmtAgo(r.ts - r.first_seen) : '—'}
                  {r.visits > 0 && <div className="text-xs text-stone-500">{r.visits} visit{r.visits > 1 ? 's' : ''}</div>}
                </td>
                <td className="py-4">{fmtDateTime(r.ts, site.timezone)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {!search && <ShowAll total={data.length} shown={all ? data.length : 10} onClick={() => setAll(true)} />}
    </div>
  );
}

function Users({ search }: { search: string }) {
  const { site, q, reloadKey, money, openVisitor } = useDash();
  const [all, setAll] = useState(false);
  const { data } = useApi<any[]>(`/api/sites/${site.id}/visitors?${qs(q)}`, reloadKey);
  if (!data) return <div className="h-40 animate-pulse" />;
  if (!data.length) return <div className="p-8 text-center text-sm text-stone-500">No visitors in this period.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-[15px]">
        <thead>
          <tr className="text-left text-sm text-stone-500">
            <th className="px-3 pb-3 font-medium">Visitor</th>
            <th className="pb-3 font-medium">Source</th>
            <th className="pb-3 text-right font-medium">Visits</th>
            <th className="pb-3 text-right font-medium">Pages</th>
            <th className="pb-3 text-right font-medium">Time</th>
            <th className="pb-3 text-right font-medium">Spent</th>
            <th className="px-3 pb-3 text-right font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {data
            .filter((r) => matches(r, search))
            .slice(0, all || search ? undefined : 10)
            .map((r) => (
              <tr key={r.visitor_id} className="cursor-pointer border-t border-stone-100 hover:bg-stone-50" onClick={() => openVisitor(r.visitor_id)}>
                <td className="px-3 py-3">
                  <VisitorCell
                    id={r.visitor_id}
                    name={r.name}
                    email={r.email}
                    country={r.country}
                    city={r.city}
                    device={r.device}
                    os={r.os}
                    browser={r.browser}
                    badge={r.spent > 0 ? <span className="rounded-md border border-revenue/30 bg-revenueSoft/50 px-1.5 py-0.5 text-xs text-revenue">Customer</span> : null}
                  />
                </td>
                <td className="py-3">
                  <div className="flex items-center gap-2">
                    <SourceIcon source={r.source} domain={r.referrer_domain} /> {r.source}
                  </div>
                </td>
                <td className="py-3 text-right">{r.sessions}</td>
                <td className="py-3 text-right">{r.pageviews}</td>
                <td className="py-3 text-right">{fmtDuration(r.duration)}</td>
                <td className="py-3 text-right">{r.spent ? money(r.spent) : '—'}</td>
                <td className="px-3 py-3 text-right text-stone-500">{fmtAgo(Date.now() - r.last_seen)} ago</td>
              </tr>
            ))}
        </tbody>
      </table>
      {!search && <ShowAll total={data.length} shown={all ? data.length : 10} onClick={() => setAll(true)} />}
    </div>
  );
}
