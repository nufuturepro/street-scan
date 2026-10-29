'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import VideoPane from './VideoPane';
import WorkOrderPanel from './WorkOrderPanel';
import type { Detection, Job, RouteSegment } from '@/lib/types';
import { GRADE_COLOR, GRADE_LABEL, summarize } from '@/lib/rqsi';

const HazardMap = dynamic(() => import('./HazardMap'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-zinc-900" />,
});

const TYPES = ['pothole', 'cave_in', 'crack', 'blocked_lane', 'debris'] as const;
const STATUSES = ['detected', 'verified', 'filed'] as const;

const SEVERITY_COLORS: Record<number, string> = {
  1: '#71717a',
  2: '#0ea5e9',
  3: '#f59e0b',
  4: '#f97316',
  5: '#ef4444',
};

function Select({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-400">
      <span className="uppercase tracking-wide text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Dispatch dashboard: where the hazards are, what state each work order is in,
 * and the export that hands it to a real crew.
 */
export default function DashboardClient() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [segments, setSegments] = useState<RouteSegment[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [minSeverity, setMinSeverity] = useState('1');
  const [jobId, setJobId] = useState('all');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Work-order footage expands here instead of navigating to /inspect, which
  // is what used to take the whole queue off screen.
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        jobs: Job[];
        detections: Detection[];
        segments?: RouteSegment[];
      };
      setJobs(data.jobs);
      setDetections(data.detections);
      // Absent only if an older server is answering; the map then draws no route.
      setSegments(data.segments ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    // Deferred so the first fetch does not cascade a render during commit.
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 5000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
    const minSev = Number(minSeverity);
    return detections.filter((d) => {
      if (type !== 'all' && d.hazardType !== type) return false;
      if (status !== 'all' && d.reviewStatus !== status) return false;
      if (d.severity < minSev) return false;
      if (jobId !== 'all' && d.jobId !== Number(jobId)) return false;
      if (reviewOnly && !d.needsReview) return false;
      return true;
    });
  }, [detections, type, status, minSeverity, jobId, reviewOnly]);

  const setActive = async (id: number) => {
    setActiveId(id);
  };

  const patch = async (
    detectionId: number,
    body: { lat?: number; lon?: number; street?: string }
  ) => {
    await fetch(`/api/detections/${detectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    await load();
  };

  // Bring the panel into view when it opens; collapsing must not scroll, or
  // closing it yanks the queue out from under the cursor.
  useEffect(() => {
    if (open) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [open]);

  const cycleStatus = async (d: Detection) => {
    const next =
      d.reviewStatus === 'detected' ? 'verified' : d.reviewStatus === 'verified' ? 'filed' : 'detected';
    await fetch(`/api/detections/${d.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    }).catch(() => undefined);
    await load();
  };

  const unplaced = filtered.filter((d) => d.lat == null || d.lon == null);
  const byType = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const d of filtered) acc[d.hazardType] = (acc[d.hazardType] ?? 0) + 1;
    return acc;
  }, [filtered]);

  const jobsWithDetections = jobs.filter((j) => detections.some((d) => d.jobId === j.id));

  // Route grades come from every detection in an audit - a street's condition
  // does not depend on which boxes are ticked above - but the job select still
  // picks which route you are reading. Deliberately not a useMemo, for the same
  // React Compiler reason as jobDetections below.
  const visibleSegments =
    jobId === 'all' ? segments : segments.filter((s) => s.jobId === Number(jobId));
  const route = summarize(visibleSegments);

  const active = detections.find((d) => d.id === activeId) ?? null;
  const activeJob = active ? (jobs.find((j) => j.id === active.jobId) ?? null) : null;
  const activeJobId = active?.jobId ?? null;
  const playback = activeJob?.playbackPath ? `/api/files/${activeJob.id}/playback.mp4` : null;
  // Only this audit's detections - otherwise the timeline ticks and painted
  // masks would be drawn from every job at once. Deliberately not a useMemo:
  // React Compiler cannot preserve a memo keyed on `detections` (the 5s poll
  // reassigns it) and skips the whole component, and this is a filter over a
  // few dozen rows.
  const jobDetections =
    activeJobId == null ? [] : detections.filter((d) => d.jobId === activeJobId);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Dispatch</h1>
        <span className="text-xs text-zinc-500">
          {filtered.length} of {detections.length} hazards
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <Select
            label="job"
            value={jobId}
            onChange={setJobId}
            options={[
              { value: 'all', label: 'All audits' },
              ...jobs.map((j) => ({ value: String(j.id), label: `#${j.id} ${j.name}` })),
            ]}
          />
          <Select
            label="type"
            value={type}
            onChange={setType}
            options={[
              { value: 'all', label: 'All types' },
              ...TYPES.map((t) => ({ value: t, label: t.replace('_', '-') })),
            ]}
          />
          <Select
            label="severity ≥"
            value={minSeverity}
            onChange={setMinSeverity}
            options={['1', '2', '3', '4', '5'].map((s) => ({ value: s, label: s }))}
          />
          <Select
            label="status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'Any' },
              ...STATUSES.map((s) => ({ value: s, label: s })),
            ]}
          />
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={reviewOnly}
              onChange={(e) => setReviewOnly(e.target.checked)}
              className="accent-amber-500"
            />
            needs review
          </label>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="h-[440px] overflow-hidden rounded-lg border border-zinc-800">
          <HazardMap
            detections={filtered}
            segments={visibleSegments}
            activeId={activeId}
            onSelect={setActive}
          />
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Queue
            </h2>
            <ul className="mt-2 max-h-72 divide-y divide-zinc-800 overflow-y-auto">
              {filtered.length === 0 && (
                <li className="py-6 text-center text-sm text-zinc-500">
                  Nothing matches these filters.
                </li>
              )}
              {filtered.map((d) => (
                <li
                  key={d.id}
                  className={`flex items-center gap-2 py-2 ${
                    d.id === activeId ? 'bg-zinc-800/60 -mx-1 px-1 rounded' : ''
                  }`}
                >
                  <span
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold text-zinc-950"
                    style={{ background: SEVERITY_COLORS[d.severity] }}
                    title={`severity ${d.severity}`}
                  >
                    {d.severity}
                  </span>
                  <button
                    onClick={() => {
                      setActive(d.id!);
                      setOpen(true);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-sm capitalize">
                      {d.hazardType.replace('_', '-')}
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {[d.street, d.crossStreet].filter(Boolean).join(' @ ') ||
                        'location not placed'}
                    </div>
                  </button>
                  <button
                    onClick={() => cycleStatus(d)}
                    className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                      d.reviewStatus === 'filed'
                        ? 'border-emerald-700 bg-emerald-950 text-emerald-300'
                        : d.reviewStatus === 'verified'
                          ? 'border-sky-700 bg-sky-950 text-sky-300'
                          : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                    }`}
                    title="click to advance status"
                  >
                    {d.reviewStatus}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Breakdown
            </h2>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {Object.entries(byType).map(([k, n]) => (
                <span key={k} className="rounded border border-zinc-700 px-2 py-1 capitalize">
                  {k.replace('_', '-')} <span className="text-zinc-500">{n}</span>
                </span>
              ))}
              {Object.keys(byType).length === 0 && (
                <span className="text-zinc-500">No hazards in view.</span>
              )}
            </div>
            {unplaced.length > 0 && (
              <p className="mt-2 text-xs text-amber-400">
                {unplaced.length} without a GPS fix — open the footage to place them.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Route quality
            </h2>
            {visibleSegments.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-500">
                No GPS route to grade yet — segments need a track from the audit.
              </p>
            ) : (
              <>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-semibold tabular-nums text-zinc-100">
                    {route.rqsi}
                  </span>
                  <span className="text-xs text-zinc-500">
                    RQSI · {Math.round(route.totalLengthM)} m graded
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {(['green', 'yellow', 'red'] as const).map((g) => (
                    <span
                      key={g}
                      className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1"
                    >
                      <span
                        className="inline-block h-2 w-4 rounded-sm"
                        style={{ background: GRADE_COLOR[g] }}
                      />
                      {GRADE_LABEL[g]} <span className="text-zinc-500">{route.counts[g]}</span>
                    </span>
                  ))}
                </div>
                {route.worst && (
                  <p className="mt-2 text-xs text-zinc-400">
                    Worst: segment {route.worst.index + 1} ·{' '}
                    <span style={{ color: GRADE_COLOR[route.worst.grade] }}>
                      {GRADE_LABEL[route.worst.grade]}
                    </span>{' '}
                    · RQSI {route.worst.rqsi} · {route.worst.defectCount} defect
                    {route.worst.defectCount === 1 ? '' : 's'}
                  </p>
                )}
                <p className="mt-1.5 text-[11px] text-zinc-500">
                  Grades use every detection in the audit, not just the filtered view.
                </p>
              </>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Export
            </h2>
            <ul className="mt-2 space-y-1.5 text-xs">
              {jobsWithDetections.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-zinc-400">#{j.id} {j.name}</span>
                  <a className="text-amber-400 hover:underline" href={`/api/jobs/${j.id}/export?format=csv`}>
                    CSV
                  </a>
                  <a className="text-amber-400 hover:underline" href={`/api/jobs/${j.id}/export?format=geojson`}>
                    GeoJSON
                  </a>
                  <a className="text-amber-400 hover:underline" href={`/api/jobs/${j.id}/export?format=open311`}>
                    Open311
                  </a>
                  <a className="text-amber-400 hover:underline" href={`/api/jobs/${j.id}/export?format=rqsi`}>
                    RQSI
                  </a>
                </li>
              ))}
              {jobsWithDetections.length === 0 && (
                <li className="text-zinc-500">Run an audit first.</li>
              )}
            </ul>
          </div>
        </div>
      </div>

      {/*
        Footage opens here rather than on /inspect: the map and the queue stay
        where they are, and the height animates instead of swapping pages.
        grid-template-rows 0fr -> 1fr grows to the content's auto height, so the
        video's aspect-video box decides how far it extends - no max-height to
        guess at and clip against.
      */}
      <div
        ref={panelRef}
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          open ? 'mt-5 grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {active && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  Footage
                </h2>
                <span className="truncate text-xs capitalize text-zinc-400">
                  {active.hazardType.replace('_', '-')} ·{' '}
                  {[active.street, active.crossStreet].filter(Boolean).join(' @ ') ||
                    'location not placed'}
                </span>
                <div className="ml-auto flex items-center gap-3">
                  {activeJobId != null && (
                    <Link
                      href={`/inspect/${activeJobId}`}
                      className="text-[11px] text-zinc-500 hover:text-amber-400"
                      title="open the dedicated footage page"
                    >
                      full page ↗
                    </Link>
                  )}
                  <button
                    onClick={() => setOpen(false)}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500"
                    title="collapse back to the queue"
                  >
                    ✕ Close
                  </button>
                </div>
              </div>

              <div className="mt-3 grid gap-4 lg:grid-cols-[1.7fr_1fr]">
                <VideoPane
                  src={playback}
                  detections={jobDetections}
                  activeId={activeId}
                  onSelect={setActive}
                />
                <WorkOrderPanel
                  key={active?.id ?? 'none'}
                  detection={active}
                  onPatch={patch}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
