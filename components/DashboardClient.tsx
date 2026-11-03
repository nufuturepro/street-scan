'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import VideoPane from './VideoPane';
import WorkOrderPanel from './WorkOrderPanel';
import type { Detection, HazardGroup, Job, JobProgress, RouteSegment } from '@/lib/types';
import { GRADE_COLOR, GRADE_LABEL, summarize } from '@/lib/rqsi';
import { SEVERITY_COLORS } from './mask';
import StillPopup from './StillPopup';
import { usd } from '@/lib/cost';
import { SAM_USD_PER_1000_FRAMES } from '@/lib/config';

const HazardMap = dynamic(() => import('./HazardMap'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-zinc-900" />,
});

const TYPES = ['pothole', 'cave_in', 'crack', 'blocked_lane', 'debris'] as const;
const STATUSES = ['detected', 'verified', 'filed'] as const;

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
  /** `${jobId}:${index}` of the stretch the Route quality card is detailing; null = whole route. */
  const [segmentKey, setSegmentKey] = useState<string | null>(null);
  const [hazards, setHazards] = useState<HazardGroup[]>([]);
  // The scan queue's live snapshot - which jobs are running or waiting, and
  // how far along each is, without a page open on any of them.
  const [scanning, setScanning] = useState<Array<{ jobId: number; progress: JobProgress }>>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [surface, setSurface] = useState('all');
  const [minSeverity, setMinSeverity] = useState('1');
  const [jobId, setJobId] = useState('all');
  const [reviewOnly, setReviewOnly] = useState(false);
  // 'live' | 'fixture' - a fixture run bills $0, so its export row shows what
  // the audit would have cost rather than pretending it was free.
  const [mode, setMode] = useState('live');
  const [error, setError] = useState<string | null>(null);
  // Bumped on every selection, even one that repeats the hazard already on
  // screen: "jump to this one" has to mean it. Keying the seek on activeId
  // alone meant a reviewer who scrubbed elsewhere, then asked for the same
  // hazard again, was left where they had scrubbed to.
  const [seekToken, setSeekToken] = useState(0);
  // Work-order footage expands here instead of navigating to /inspect, which
  // is what used to take the whole queue off screen.
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // The queue row under the pointer, and where it sits in the viewport - the
  // still popup hangs off that rectangle. The rectangle is captured once at
  // hover time rather than measured on render: rows scroll, and a popup that
  // tracked them would slide around while you were trying to read it.
  const [preview, setPreview] = useState<{
    id: number;
    rect: { left: number; top: number; width: number };
  } | null>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        jobs: Job[];
        detections: Detection[];
        segments?: RouteSegment[];
        hazards?: HazardGroup[];
        mode?: string;
        active?: Array<{ jobId: number; progress: JobProgress }>;
      };
      setJobs(data.jobs);
      setMode(data.mode ?? 'live');
      setScanning(data.active ?? []);
      setDetections(data.detections);
      // Absent only if an older server is answering; the map then draws no route.
      setSegments(data.segments ?? []);
      setHazards(data.hazards ?? []);
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
      // 'street' is the default view: sidewalk findings are kept and shown,
      // but they are a different work queue, so they do not crowd the one
      // for moving traffic unless asked for.
      if (surface === 'street' && d.surface === 'sidewalk') return false;
      if (surface === 'sidewalk' && d.surface !== 'sidewalk') return false;
      if (d.severity < minSev) return false;
      if (jobId !== 'all' && d.jobId !== Number(jobId)) return false;
      if (reviewOnly && !d.needsReview) return false;
      return true;
    });
  }, [detections, type, status, surface, minSeverity, jobId, reviewOnly]);

  const setActive = (id: number) => {
    setActiveId(id);
    setSeekToken((t) => t + 1);
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
  //
  // Deferred until the 300ms grid-rows expansion has finished: while the
  // wrapper is still 0fr it has no height, and scrollIntoView on a zero-height
  // box at the bottom edge of the viewport scrolls exactly nothing - which is
  // why opening a hazard used to leave the footage a screenful below the fold.
  // The panel now sits in the map's slot, so on a wide screen it is already in
  // view and this is a no-op; on a narrow one it does the only scroll needed.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(
      () => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
      320
    );
    return () => clearTimeout(t);
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
  const activeJobNames = new Map(
    scanning.map((a) => [a.jobId, jobs.find((j) => j.id === a.jobId)?.name ?? `#${a.jobId}`])
  );
  // Sidewalk counts are kept beside the street ones rather than merged in:
  // "4 sidewalk" on its own line is the difference between a finding someone
  // can act on and one that looks like a street pothole that isn't there.
  const sidewalkCount = filtered.filter((d) => d.surface === 'sidewalk').length;
  const streetCount = filtered.length - sidewalkCount;
  // The Route quality card grades every street detection regardless of the
  // filters, so its sidewalk line reads from the same full set.
  const sidewalkTotal = detections.filter((d) => d.surface === 'sidewalk').length;
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
    jobId === 'all'
      ? segments
      : segments.filter((s) => s.jobIds.includes(Number(jobId)));
  const route = summarize(visibleSegments);
  // Keyed, not held as an object: the 5s poll hands down a fresh segments
  // array every time, so a reference would go stale while the same stretch
  // simply re-arrived. The lookup finds it in the current array instead.
  const selectedSegment = segmentKey
    ? visibleSegments.find((s) => `${s.jobId}:${s.index}` === segmentKey) ?? null
    : null;
  // Position along this audit's route: the type keeps order (index) and
  // length, not absolute offsets, so the start is the sum of what precedes.
  const segStartM = selectedSegment
    ? visibleSegments
        .filter(
          (x) =>
            x.jobId === selectedSegment.jobId && x.index < selectedSegment.index
        )
        .reduce((sum, x) => sum + x.lengthM, 0)
    : 0;

  // Which physical hazard each row belongs to, so a detection a second audit
  // also saw can say so in the queue. Not a useMemo: `hazards` is reassigned by
  // the 5s poll like `detections` is, and React Compiler drops a memo keyed on
  // a value that changes identity every five seconds.
  const hazardOf = new Map<number, HazardGroup>();
  for (const g of hazards) for (const id of g.detectionIds) hazardOf.set(id, g);

  const corroborated = hazards.filter((g) => g.state === 'corroborated').length;
  const disputedHazards = hazards.filter((g) => g.state === 'disputed').length;
  const sharedStretches = visibleSegments.filter((s) => s.passes > 1).length;
  const disagreeingStretches = visibleSegments.filter((s) => s.disagree).length;
  const passesInView = new Set(visibleSegments.flatMap((s) => s.jobIds)).size;

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
            label="surface"
            value={surface}
            onChange={setSurface}
            options={[
              { value: 'all', label: 'Everywhere' },
              { value: 'street', label: 'Street only' },
              { value: 'sidewalk', label: 'Sidewalk' },
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
      </div>        {error && (
          <div className="mb-4 rounded border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/*
          Scanning: what the queue is doing right now. This is the answer to
          "can I upload several videos at once" - each row is a job running
          or waiting in the background, and none of them needed a page open.
        */}
        {scanning.length > 0 && (
          <div className="mb-4 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2.5">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-amber-500/80">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 pulse-soft" />
              Scanning
              <span className="text-amber-600/80 normal-case tracking-normal">
                {scanning.length} in the queue
              </span>
            </div>
            <ul className="mt-2 space-y-2">
              {scanning.map(({ jobId, progress }) => (
                <li key={jobId}>
                  <Link
                    href={`/inspect/${jobId}`}
                    className="flex items-center gap-3 rounded px-1 py-0.5 hover:bg-amber-950/40"
                  >
                    <span className="w-16 shrink-0 truncate text-xs text-zinc-400" title={activeJobNames.get(jobId)}>
                      {activeJobNames.get(jobId)}
                    </span>
                    <span className="w-40 shrink-0 truncate text-xs text-amber-200/90">
                      {progress.position > 0
                        ? `queued · position ${progress.position}`
                        : progress.message}
                    </span>
                    {progress.total > 0 && progress.position === 0 && (
                      <span className="h-1 w-32 shrink-0 overflow-hidden rounded-full bg-zinc-800">
                        <span
                          className="block h-full bg-amber-400 transition-[width] duration-500"
                          style={{
                            width: `${Math.min(100, (progress.done / progress.total) * 100)}%`,
                          }}
                        />
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-zinc-500">
                      {progress.position === 0 && progress.total > 0
                        ? `${progress.done}/${progress.total}`
                        : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

      {/*
        Two columns: the road on the left, the queue on the right. The footage
        opens *in the left column, in the map's own slot* - so the queue never
        moves, nothing scrolls, and closing brings the map back where it was.
        Opening it below this grid, as this used to, put the video past the
        fold: reaching it meant scrolling past the queue, which is what made
        the queue look like it had vanished.

        minmax(0, …) rather than bare fr: an fr track's automatic minimum is
        its content's min-content width, and the Open311 <pre> below is
        white-space:pre - about 1,080px of it. Left to itself the grid measured
        105px for the video and 1,101px for the payload, which is why the
        footage used to render as a stamp. The <pre> has overflow-auto, so it
        scrolls inside its column instead of dictating the split.
      */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className={`flex flex-col ${open ? 'gap-4' : ''}`}>
          <div
            className={`h-[440px] overflow-hidden rounded-lg border border-zinc-800 ${
              open ? 'hidden' : ''
            }`}
          >
            <HazardMap
              detections={filtered}
              segments={visibleSegments}
              hazards={hazards}
              activeId={activeId}
              onSelect={setActive}
              selectedKey={segmentKey}
              onSelectSegment={(s) => {
                const k = `${s.jobId}:${s.index}`;
                setSegmentKey((prev) => (prev === k ? null : k));
              }}
              visible={!open}
            />
          </div>

          {/*
            Footage opens here rather than on /inspect, and in the map's slot
            rather than under the page: the queue and the map stay where they
            are, and the height animates instead of swapping pages.
            grid-template-rows 0fr -> 1fr grows to the content's auto height, so
            the video's aspect-video box decides how far it extends - no
            max-height to guess at and clip against.
          */}
          <div
            ref={panelRef}
            className={`grid transition-[grid-template-rows] duration-300 ease-out ${
              open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            }`}
          >
            {/*
              Collapsed, this wrapper is 0px tall and clipped - but its children
              were still focusable, so a keyboard user tabbed into an invisible
              video player and invisible buttons. inert takes them out of the tab
              order and the accessibility tree while they are off screen.
            */}
            <div className="overflow-hidden" inert={!open}>
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

                  {/* Stacked, not side by side: at this column's width a
                      payload panel beside the video squeezed the video back to
                      the stamp it used to be, and the JSON reads better full
                      width anyway. */}
                  <div className="mt-3 flex flex-col gap-4">
                    <VideoPane
                      src={playback}
                      detections={jobDetections}
                      activeId={activeId}
                      seekToken={seekToken}
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
              {filtered.map((d) => {
                const group = hazardOf.get(d.id!);
                return (
                <li
                  key={d.id}
                  className={`flex items-center gap-2 py-2 ${
                    d.id === activeId ? 'bg-zinc-800/60 -mx-1 px-1 rounded' : ''
                  }`}
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setPreview({
                      id: d.id!,
                      rect: { left: r.left, top: r.top, width: r.width },
                    });
                  }}
                  onMouseLeave={() => setPreview((p) => (p?.id === d.id ? null : p))}
                  onFocus={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setPreview({
                      id: d.id!,
                      rect: { left: r.left, top: r.top, width: r.width },
                    });
                  }}
                >
                  <span
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold text-zinc-950"
                    style={{ background: SEVERITY_COLORS[d.severity] }}
                    title={`severity ${d.severity}`}
                  >
                    {d.severity}
                  </span>
                  {/*
                    The frame the hazard was found on, cut on demand and cached
                    server-side. lazy is load-bearing: 57 rows would otherwise
                    ask for 57 ffmpeg passes on the first paint, when only the
                    half-dozen rows actually on screen are ever going to be seen.
                  */}
                  <img
                    src={`/api/detections/${d.id}/still`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-6 w-10 shrink-0 rounded border border-zinc-800 bg-zinc-900 object-cover"
                    onError={(e) => {
                      // No playback yet for this audit - an empty box reads
                      // better than a broken-image glyph in a list of 57.
                      e.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                  <button
                    onClick={() => {
                      setActive(d.id!);
                      setOpen(true);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-1.5 truncate text-sm capitalize">
                      {d.hazardType.replace('_', '-')}
                      {d.surface === 'sidewalk' && (
                        <span
                          className="rounded border border-sky-700 bg-sky-950 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-300"
                          title="on the sidewalk - not part of the street grade"
                        >
                          walk
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {[d.street, d.crossStreet].filter(Boolean).join(' @ ') ||
                        'location not placed'}
                    </div>
                  </button>
                  {group && group.passes > 1 && (
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                        group.state === 'disputed'
                          ? 'border-amber-700 bg-amber-950 text-amber-300'
                          : 'border-emerald-700 bg-emerald-950 text-emerald-300'
                      }`}
                      title={
                        group.state === 'disputed'
                          ? `${group.passes} passes saw this spot and disagreed on what it is`
                          : `${group.passes} independent passes agree on this hazard`
                      }
                    >
                      {group.state === 'disputed' ? 'disputed' : `${group.passes} passes`}
                    </span>
                  )}
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
                  {/*
                    Rendered inside the row, not beside it: as a DOM child the
                    popup stays open while the pointer is over it (mouseleave
                    does not fire for a descendant), which is what makes the
                    Review button clickable.
                  */}
                  {preview && preview.id === d.id && (
                    <StillPopup
                      detection={d}
                      rect={preview.rect}
                      onReview={(id) => {
                        setActive(id);
                        setOpen(true);
                        setPreview(null);
                      }}
                    />
                  )}
                </li>
                );
              })}
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
            {sidewalkCount > 0 && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-sky-400">
                <span className="inline-block h-2 w-2 rounded-full border border-sky-400 bg-sky-950" />
                {streetCount} street · {sidewalkCount} on sidewalk
              </p>
            )}
            {unplaced.length > 0 && (
              <p className="mt-2 text-xs text-amber-400">
                {unplaced.length} without a GPS fix — open the footage to place them.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Route quality
              </h2>
              {selectedSegment && (
                <button
                  type="button"
                  onClick={() => setSegmentKey(null)}
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                  title="back to the whole-route summary"
                >
                  whole route ✕
                </button>
              )}
            </div>
            {visibleSegments.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-500">
                No GPS route to grade yet — segments need a track from the audit.
              </p>
            ) : (
              <>
                {selectedSegment ? (
                  <div>
                    <div className="mt-2 text-[10px] uppercase tracking-wider text-zinc-600">
                      Segment {selectedSegment.index + 1} of{' '}
                      {
                        visibleSegments.filter(
                          (x) => x.jobId === selectedSegment.jobId
                        ).length
                      }{' '}
                      · audit #{selectedSegment.jobId}
                    </div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span
                        className="text-3xl font-semibold tabular-nums"
                        style={{ color: GRADE_COLOR[selectedSegment.grade] }}
                      >
                        {selectedSegment.rqsi}
                      </span>
                      <span className="text-xs text-zinc-500">
                        RQSI · {GRADE_LABEL[selectedSegment.grade]} ·{' '}
                        {selectedSegment.lengthM} m
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <span className="rounded border border-zinc-700 px-2 py-1">
                        {selectedSegment.defectCount} defect
                        {selectedSegment.defectCount === 1 ? '' : 's'}
                      </span>
                      {selectedSegment.defectCount > 0 && (
                        <span className="rounded border border-zinc-700 px-2 py-1">
                          worst severity {selectedSegment.worstSeverity}
                        </span>
                      )}
                      <span className="rounded border border-zinc-700 px-2 py-1">
                        density {selectedSegment.density}/100 m
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] text-zinc-500">
                      {Math.round(segStartM)}–
                      {Math.round(segStartM + selectedSegment.lengthM)} m along
                      the route
                      {selectedSegment.offRoute > 0
                        ? ` · ${selectedSegment.offRoute} placed off-track`
                        : ''}
                    </p>
                    {selectedSegment.passes > 1 && (
                      <p className="mt-1 text-[11px] text-zinc-400">
                        {selectedSegment.passes} passes{' '}
                        {selectedSegment.disagree
                          ? 'grade it differently'
                          : 'agree on the grade'}{' '}
                        · jobs{' '}
                        {selectedSegment.jobIds.map((id) => `#${id}`).join(', ')}
                      </p>
                    )}
                    <p className="mt-2 text-[11px] text-zinc-500">
                      Whole route:{' '}
                      <span className="tabular-nums text-zinc-400">
                        {route.rqsi} RQSI
                      </span>{' '}
                      · {route.counts.green} green · {route.counts.yellow}{' '}
                      yellow · {route.counts.red} red
                    </p>
                  </div>
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
                          {GRADE_LABEL[g]}{' '}
                          <span className="text-zinc-500">{route.counts[g]}</span>
                        </span>
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] text-zinc-600">
                      Click any stretch on the map for its own grade.
                    </p>
                  </>
                )}
                {corroborated + disputedHazards + sharedStretches > 0 && (
                  <p className="mt-2 text-[11px] text-zinc-500">
                    {corroborated} corroborated · {disputedHazards} disputed hazard
                    {corroborated + disputedHazards === 1 ? '' : 's'}
                    {passesInView > 1
                      ? ` · ${sharedStretches} shared stretch${sharedStretches === 1 ? '' : 'es'} across ${passesInView} passes`
                      : ''}
                  </p>
                )}
                {disagreeingStretches > 0 && (
                  <p className="mt-1 text-[11px] text-amber-400">
                    {disagreeingStretches} stretch
                    {disagreeingStretches === 1 ? '' : 'es'} graded differently by
                    different runs
                  </p>
                )}
                {!selectedSegment && route.worst && (
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
                  Grades use every <em className="not-italic text-zinc-400">street</em>{' '}
                  detection in the audit — sidewalk findings are graded apart.
                </p>
                {sidewalkTotal > 0 && (
                  <p className="mt-1 flex items-center gap-1.5 text-[11px] text-sky-400">
                    <span className="inline-block h-2 w-2 rounded-full border border-sky-400 bg-sky-950" />
                    {sidewalkTotal} sidewalk finding
                    {sidewalkTotal === 1 ? '' : 's'} kept out of this grade
                  </p>
                )}
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
                  <Link
                    href={`/costs#job-${j.id}`}
                    className="rounded border border-emerald-800/60 bg-emerald-950/50 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-emerald-400 hover:border-emerald-600 hover:text-emerald-300"
                    title={`what this audit cost - SAM ${usd(SAM_USD_PER_1000_FRAMES, 2)} per 1k frames, plus Muse Spark classification. Opens the expense breakdown.`}
                  >
                    {mode === 'fixture' ? '(simulated) ' : ''}
                    {usd(j.costEstimateUsd ?? 0, 2)} →
                  </Link>
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
    </div>
  );
}
