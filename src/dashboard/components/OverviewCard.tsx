import { useMemo, useState } from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { type Kpis, type Overview } from '../lib/api';
import { useDash } from '../lib/context';
import { bucketLabel, fmtDuration, fmtNumber, fmtPct } from '../lib/format';

type Metric = 'visitors' | 'revenue';

function Change({ cur, prev, invert = false }: { cur: number; prev: number; invert?: boolean }) {
  if (!prev) return <span className="text-xs text-stone-500">—</span>;
  const pct = (cur - prev) / prev;
  if (!Number.isFinite(pct)) return null;
  const rounded = Math.round(pct * 100);
  if (rounded === 0) return <span className="inline-flex items-center text-xs text-stone-500">0%</span>;
  const up = rounded > 0;
  const good = invert ? !up : up;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs ${good ? 'text-emerald-600' : 'text-red-500'}`}>
      {Math.abs(rounded)}% {up ? '↑' : '↓'}
    </span>
  );
}

const TICK = { fill: '#78716c', fontSize: 12 };

export function OverviewCard({ data, online, live }: { data: Overview | null; online?: number; live?: boolean }) {
  const { money } = useDash();
  const [hidden, setHidden] = useState<Record<Metric, boolean>>({ visitors: false, revenue: false });
  const c = data?.current;
  const p = data?.previous;

  const kpis: { key: keyof Kpis | 'online'; label: string; value: string; invert?: boolean; metric?: Metric; dot?: string }[] = c
    ? [
        { key: 'visitors', label: 'Visitors', value: fmtNumber(c.visitors), metric: 'visitors', dot: 'bg-visitors' },
        { key: 'revenue', label: 'Revenue', value: money(c.revenue, true), metric: 'revenue', dot: 'bg-revenue' },
        { key: 'conversionRate', label: 'Conversion rate', value: fmtPct(c.conversionRate, c.conversionRate >= 0.1 ? 0 : 2) },
        { key: 'revenuePerVisitor', label: 'Revenue/visitor', value: money(c.revenuePerVisitor) },
        { key: 'bounceRate', label: 'Bounce rate', value: fmtPct(c.bounceRate), invert: true },
        { key: 'avgDuration', label: 'Session time', value: fmtDuration(c.avgDuration) },
      ]
    : [];

  const g = data?.range.granularity ?? 'day';
  const series = useMemo(() => {
    if (!data) return [];
    const n = data.series.length;
    const live = n > 1 && data.range.to >= Date.now() - 5 * 60_000;
    return data.series.map((d, i) => ({ ...d, solid: live && i === n - 1 ? null : d.visitors, live: live && i >= n - 2 ? d.visitors : null }));
  }, [data]);

  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-2 border-b border-stone-100 sm:grid-cols-4 lg:grid-cols-7">
        {kpis.map((k) => {
          const body = (
            <>
              <div className="flex items-center gap-1.5 text-sm text-stone-500">
                {k.dot && <span className={`h-2.5 w-2.5 rounded-sm ${k.dot} ${hidden[k.metric!] ? 'opacity-25' : ''}`} />}
                {k.label}
              </div>
              <div className="mt-1 text-[28px] font-semibold leading-tight tracking-tight">
                <span key={k.value} className="tick-in inline-block">{k.value}</span>
              </div>
              <Change cur={c![k.key as keyof Kpis]} prev={p![k.key as keyof Kpis]} invert={k.invert} />
            </>
          );
          const metric = k.metric;
          return metric ? (
            <button
              key={k.key}
              type="button"
              className="border-stone-100 px-5 py-4 text-left hover:bg-stone-50 lg:border-r"
              onClick={() => setHidden((h) => ({ ...h, [metric]: !h[metric] }))}
              title="Show/hide on chart"
              aria-pressed={!hidden[metric]}
            >
              {body}
            </button>
          ) : (
            <div key={k.key} className="border-stone-100 px-5 py-4 lg:border-r">
              {body}
            </div>
          );
        })}
        {data && (
          <div className="px-5 py-4">
            <div className="flex items-center gap-1.5 text-sm text-stone-500">
              Online <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
              {live && (
                <span className="ml-auto rounded-full bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-green-700" title="Updates automatically as new visits and payments arrive">
                  Live
                </span>
              )}
            </div>
            <div className="mt-1 text-[28px] font-semibold leading-tight" aria-live="polite"><span key={online ?? data.online} className="tick-in inline-block">{online ?? data.online}</span></div>
          </div>
        )}
        {!data && <div className="col-span-full h-[98px] animate-pulse bg-stone-50" />}
      </div>

      <div className="h-[340px] px-2 pb-3 pt-6 sm:px-4">
        {data && (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="vis" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8dbdf0" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#8dbdf0" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#efedea" strokeDasharray="4 4" />
              <XAxis
                dataKey="bucket"
                tickFormatter={(b) => bucketLabel(b, g)}
                tick={TICK}
                axisLine={false}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                yAxisId="v"
                tick={TICK}
                axisLine={false}
                tickLine={false}
                width={44}
                allowDecimals={false}
                tickFormatter={(v) => fmtNumber(v)}
              />
              <YAxis
                yAxisId="r"
                orientation="right"
                tick={TICK}
                axisLine={false}
                tickLine={false}
                width={56}
                tickFormatter={(v) => money(v, true)}
                hide={hidden.revenue}
                // Headroom keeps revenue bars in the lower part of the chart, under the visitors line.
                domain={[0, (max: number) => Math.max(1, Math.ceil(max * 1.6))]}
              />
              <Tooltip
                cursor={{ fill: 'rgba(28,25,23,0.03)' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as Overview['series'][0];
                  return (
                    <div className="card min-w-[180px] px-4 py-3 text-sm">
                      <div className="mb-2 font-medium">{bucketLabel(d.bucket, g, true)}</div>
                      <Row color="bg-visitors" label="Visitors" value={fmtNumber(d.visitors)} />
                      <Row color="bg-stone-300" label="Pageviews" value={fmtNumber(d.pageviews)} />
                      <Row color="bg-revenue" label="Revenue" value={money(d.revenue)} />
                      {d.payments > 0 && <Row color="bg-revenueSoft" label="Payments" value={String(d.payments)} />}
                    </div>
                  );
                }}
              />
              {!hidden.revenue && (
                <Bar yAxisId="r" dataKey="revenue" fill="#e07b5f" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
              )}
              {!hidden.visitors && (
                <Area
                  yAxisId="v"
                  type="monotone"
                  dataKey="solid"
                  stroke="#7cb1ea"
                  strokeWidth={2.5}
                  fill="url(#vis)"
                  dot={false}
                  activeDot={{ r: 4, fill: '#7cb1ea', stroke: '#fff', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              )}
              {!hidden.visitors && (
                <Area
                  yAxisId="v"
                  type="linear"
                  dataKey="live"
                  stroke="#7cb1ea"
                  strokeWidth={2.5}
                  strokeDasharray="5 5"
                  fill="url(#vis)"
                  fillOpacity={0.5}
                  dot={false}
                  activeDot={{ r: 4, fill: '#7cb1ea', stroke: '#fff', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function Row({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 py-0.5">
      <span className="flex items-center gap-2 text-stone-500">
        <span className={`h-2.5 w-2.5 rounded-sm ${color}`} />
        {label}
      </span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
