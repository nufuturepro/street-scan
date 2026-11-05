'use client';

import type { Job, RouteSegment, Detection } from '@/lib/types';
import { GRADE_COLOR, GRADE_LABEL } from '@/lib/rqsi';
import { SEVERITY_COLORS } from './mask';

/**
 * The dashboard's pictures.
 *
 * Deliberately no chart library: three shapes over data the API already sends
 * (a trend line, a ribbon of graded stretches, two bar series) do not justify a
 * dependency, a bundle and someone else's dark-mode defaults. Every number here
 * comes from a real audit - nothing is smoothed, sampled or invented, because a
 * dashboard that lies about its own data is worse than a table.
 */

/** A quiet trend line for the KPI cards. Values are drawn as-is; a flat series is a flat line. */
export function Sparkline({
  values,
  color = 'var(--accent)',
  height = 30,
}: {
  values: number[];
  color?: string;
  height?: number;
}) {
  if (values.length < 2) {
    return <div style={{ height }} className="w-full rounded bg-[rgb(255_255_255/0.03)]" />;
  }
  const w = 100;
  const max = Math.max(...values);
  const min = Math.min(...values);
  // A series that never moves draws down the middle rather than dividing by zero.
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const id = `spark-${color.replace(/[^a-z0-9]/gi, '')}-${values.length}-${Math.round(max)}`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts.join(' ')} ${w},${height}`} fill={`url(#${id})`} />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** One KPI tile: a label, a big number, a footnote and a small trend. */
export function KpiCard({
  label,
  value,
  unit,
  sub,
  valueColor,
  children,
  href,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sub?: React.ReactNode;
  valueColor?: string;
  children?: React.ReactNode;
  href?: string;
}) {
  return (
    <div className="panel px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="label">{label}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="num text-2xl font-semibold leading-none" style={valueColor ? { color: valueColor } : undefined}>
              {value}
            </span>
            {unit && <span className="text-xs text-muted">{unit}</span>}
          </div>
        </div>
        <div className="w-20 shrink-0">{children}</div>
      </div>
      {sub && <div className="mt-2 text-[11px] leading-relaxed text-muted">{sub}</div>}
      {href && <div className="mt-1 text-[11px] text-accent/80">open breakdown →</div>}
    </div>
  );
}

/**
 * The route as a ribbon of graded stretches.
 *
 * Width is the stretch's real length in metres, height its RQSI, colour its
 * grade - so the wide gaps are the long straights and the tall ones are the
 * stretches a crew should see first. Clicking a stretch selects it, the same
 * selection the map and the Route quality card drive.
 */
export function RouteProfile({
  segments,
  selectedKey,
  onSelect,
  height = 96,
}: {
  segments: RouteSegment[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  height?: number;
}) {
  if (segments.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted">
        No graded route yet — this audit has no GPS track to walk.
      </p>
    );
  }
  return (
    <div>
      {/* Clip it: a route long enough to overflow this column must not paint
          its bars across the two charts beside it. */}
      <div className="relative flex items-end gap-px overflow-hidden" style={{ height }}>
        {[0, 25, 50, 75].map((pct) => (
          <div
            key={pct}
            className="pointer-events-none absolute inset-x-0 border-t border-[rgb(255_255_255/0.05)]"
            style={{ bottom: `${pct}%` }}
          />
        ))}
        {segments.map((s) => {
          const key = `${s.jobId}:${s.index}`;
          const on = key === selectedKey;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              title={`${GRADE_LABEL[s.grade]} · RQSI ${s.rqsi} · ${s.lengthM} m · ${s.defectCount} defect${
                s.defectCount === 1 ? '' : 's'
              }`}
              className={`relative rounded-t-[2px] transition-[filter,opacity] hover:brightness-125 ${
                on ? 'ring-1 ring-white/70' : ''
              }`}
              style={{
                flexGrow: Math.max(1, s.lengthM),
                flexBasis: 0,
                minWidth: 2,
                height: `${Math.max(6, s.rqsi)}%`,
                background: `linear-gradient(180deg, ${GRADE_COLOR[s.grade]}, ${GRADE_COLOR[s.grade]}88)`,
                opacity: selectedKey && !on ? 0.55 : 1,
              }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-muted">
        {(['green', 'yellow', 'red'] as const).map((g) => (
          <span key={g} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: GRADE_COLOR[g] }} />
            {GRADE_LABEL[g]}
          </span>
        ))}
        <span className="ml-auto tabular-nums">{segments.length} stretches</span>
      </div>
    </div>
  );
}

/** Spend per audit, as bars. Clicking one filters the whole page to that audit. */
export function SpendBars({
  jobs,
  detections,
  activeJob,
  onPick,
  height = 96,
}: {
  jobs: Job[];
  detections: Detection[];
  activeJob: string;
  onPick: (jobId: string) => void;
  height?: number;
}) {
  // Oldest on the left, newest on the right, the way the KPI trends read.
  const rows = jobs
    .map((j) => ({ job: j, hazards: detections.filter((d) => d.jobId === j.id).length }))
    .filter((r) => r.hazards > 0 || r.job.costEstimateUsd > 0)
    .slice(0, 12)
    .reverse();
  if (rows.length === 0) {
    return <p className="py-6 text-center text-xs text-muted">No audits billed yet.</p>;
  }
  const max = Math.max(...rows.map((r) => r.job.costEstimateUsd), 0.01);
  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {rows.map((r) => {
          const on = activeJob === String(r.job.id);
          return (
            <button
              key={r.job.id}
              type="button"
              onClick={() => onPick(on ? 'all' : String(r.job.id))}
              title={`#${r.job.id} ${r.job.name} — $${r.job.costEstimateUsd.toFixed(2)} · ${r.hazards} hazards`}
              className="group relative flex flex-1 flex-col justify-end rounded-t-[3px]"
              style={{ height: '100%' }}
            >
              <span
                className="w-full rounded-t-[3px] transition-[filter] group-hover:brightness-125"
                style={{
                  height: `${Math.max(4, (r.job.costEstimateUsd / max) * 100)}%`,
                  background: on
                    ? 'linear-gradient(180deg, var(--accent), rgb(255 46 99 / 0.45))'
                    : 'linear-gradient(180deg, var(--gold), rgb(245 166 35 / 0.35))',
                }}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1.5 text-[10px] text-muted-2">
        {rows.map((r) => (
          <span key={r.job.id} className="flex-1 text-center tabular-nums">
            #{r.job.id}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Severity 1-5 counts, as five columns. */
export function SeverityMix({
  counts,
  height = 96,
  onPick,
  active,
}: {
  counts: Record<number, number>;
  height?: number;
  onPick?: (severity: string) => void;
  active?: string;
}) {
  const max = Math.max(...[1, 2, 3, 4, 5].map((s) => counts[s] ?? 0), 1);
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }}>
        {[1, 2, 3, 4, 5].map((s) => {
          const n = counts[s] ?? 0;
          const on = active === String(s);
          return (
            <button
              key={s}
              type="button"
              disabled={!onPick}
              onClick={() => onPick?.(on ? '1' : String(s))}
              title={`${n} hazard${n === 1 ? '' : 's'} at severity ${s}`}
              className="group flex h-full flex-1 flex-col justify-end"
            >
              <span
                className="num mb-1 text-center text-[10px] text-muted group-hover:text-ink"
                style={{ opacity: n ? 1 : 0.35 }}
              >
                {n}
              </span>
              <span
                className="w-full rounded-t-[3px] transition-[filter] group-hover:brightness-125"
                style={{
                  height: `${Math.max(3, (n / max) * 100)}%`,
                  background: SEVERITY_COLORS[s],
                  opacity: active && !on ? 0.45 : 1,
                  outline: on ? '1px solid rgb(255 255 255 / 0.5)' : undefined,
                }}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-2 text-[10px] text-muted-2">
        {[1, 2, 3, 4, 5].map((s) => (
          <span key={s} className="flex-1 text-center">
            S{s}
          </span>
        ))}
      </div>
    </div>
  );
}
