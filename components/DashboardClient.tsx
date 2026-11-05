'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import VideoPane from './VideoPane';
import WorkOrderPanel from './WorkOrderPanel';
import Uploader from './Uploader';
import { KpiCard, RouteProfile, SeverityMix, Sparkline, SpendBars } from './charts';
import type {
  Detection,
  HazardGroup,
  Job,
  JobProgress,
  RouteCrossing,
  RouteSegment,
  RqsiGrade,
} from '@/lib/types';
import { GRADE_COLOR, GRADE_LABEL, summarize } from '@/lib/rqsi';
import { SEVERITY_COLORS } from './mask';
import StillPopup from './StillPopup';
import { usd } from '@/lib/cost';
import { MIN_MASK_WIDTH_FRAC, SAM_USD_PER_1000_FRAMES } from '@/lib/config';

const HazardMap = dynamic(() => import('./HazardMap'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-surface2" />,
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
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="uppercase tracking-wide text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-line bg-surface2 px-2 py-1 text-xs text-ink"
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

/** ms → "1:33", for the watch links on an intersection. */
function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Dispatch dashboard: where the hazards are, what state each work order is in,
 * and the export that hands it to a real crew.
 */
/**
 * One predicate, two windows: the queue and map apply every filter (activeType
 * set), the breakdown counts with the type filter lifted (activeType null) so
 * its pills keep all their counts - and stay clickable - while one is active.
 */
function passFilters(
  d: Detection,
  f: {
    status: string;
    surface: string;
    minSeverity: string;
    jobId: string;
    reviewOnly: boolean;
    showTiny: boolean;
  },
  activeType: string | null
): boolean {
  const minSev = Number(f.minSeverity);
  // A rejected entry is out of the work queue entirely - it is not a hazard,
  // so it must not be counted, mapped or filed. It stays visible (and
  // restorable) on its own audit page, which is where the verdict was made.
  if (d.reviewStatus === 'rejected') return false;
  // Too small to judge (lib/scale.ts): hidden unless the reviewer asks for
  // them, because a 13-pixel mask cannot support a work order - but never
  // deleted, so the call stays auditable.
  if (d.tooSmall && !f.showTiny) return false;
  if (activeType && d.hazardType !== activeType) return false;
  if (f.status !== 'all' && d.reviewStatus !== f.status) return false;
  // 'street' is the default view: sidewalk findings are kept and shown,
  // but they are a different work queue, so they do not crowd the one
  // for moving traffic unless asked for.
  if (f.surface === 'street' && d.surface === 'sidewalk') return false;
  if (f.surface === 'sidewalk' && d.surface !== 'sidewalk') return false;
  if (d.severity < minSev) return false;
  if (f.jobId !== 'all' && d.jobId !== Number(f.jobId)) return false;
  if (f.reviewOnly && !d.needsReview) return false;
  return true;
}

export default function DashboardClient() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [segments, setSegments] = useState<RouteSegment[]>([]);
  /** `${jobId}:${index}` of the stretch the Route quality card is detailing; null = whole route. */
  const [segmentKey, setSegmentKey] = useState<string | null>(null);
  const [hazards, setHazards] = useState<HazardGroup[]>([]);
  // Where two audits' routes meet - the Intersections card's rows, each with
  // a link into every pass's footage at that spot.
  const [crossings, setCrossings] = useState<RouteCrossing[]>([]);
  /** Map legend grade filter: null = draw every grade. */
  const [gradeFilter, setGradeFilter] = useState<RqsiGrade | null>(null);
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
  // Reveal the masks the size gate hid. Off by default: the queue is a work
  // list, and a speck is not work until someone says it is.
  const [showTiny, setShowTiny] = useState(false);
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
  // Uploading lives on this page now, in a drawer over it: a scan can start
  // without leaving the queue you were reading, and the new row appears in the
  // audits table below as the queue picks it up.
  const [newOpen, setNewOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // The queue row under the pointer, and where it sits in the viewport - the
  // still popup hangs off that rectangle. The rectangle is captured once at
  // hover time rather than measured on render: rows scroll, and a popup that
  // tracked them would slide around while you were trying to read it.
  const [preview, setPreview] = useState<{
    id: number;
    rect: { left: number; top: number; width: number };
  } | null>(null);
  // The queue list itself, so the stretch strip can scroll a member row into
  // view: the map knows which hazards a stretch holds, and the list has to
  // show them without the user hunting through 63 rows.
  const queueRef = useRef<HTMLUListElement>(null);
  const scrollToStretchMember = () => {
    queueRef.current
      ?.querySelector('[data-seg-member]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const load = async () => {
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        jobs: Job[];
        detections: Detection[];
        segments?: RouteSegment[];
        hazards?: HazardGroup[];
        crossings?: RouteCrossing[];
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
      setCrossings(data.crossings ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // /?new=1 (the rail's "new audit" affordance) opens the drawer on arrival,
  // then drops the flag so a refresh does not reopen it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('new')) return;
    url.searchParams.delete('new');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    // Opened on the tick after mount, not during it: the server sends the
    // drawer closed, so flipping it inside the first commit is a hydration
    // mismatch - React would then throw the server markup away.
    const t = setTimeout(() => setNewOpen(true), 0);
    return () => clearTimeout(t);
  }, []);

  // Escape closes the drawer, the way a modal is expected to behave.
  useEffect(() => {
    if (!newOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNewOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newOpen]);

  useEffect(() => {
    // Deferred so the first fetch does not cascade a render during commit.
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 5000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(
    () =>
      detections.filter((d) =>
        passFilters(
          d,
          { status, surface, minSeverity, jobId, reviewOnly, showTiny },
          type === 'all' ? null : type
        )
      ),
    [detections, type, status, surface, minSeverity, jobId, reviewOnly, showTiny]
  );

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

  // Masks the size gate is holding back, counted over every detection so the
  // number does not move when an unrelated filter changes.
  const tinyCount = detections.filter(
    (d) => d.tooSmall && d.reviewStatus !== 'rejected'
  ).length;

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
    for (const d of detections) {
      if (
        !passFilters(
          d,
          { status, surface, minSeverity, jobId, reviewOnly, showTiny },
          null
        )
      )
        continue;
      acc[d.hazardType] = (acc[d.hazardType] ?? 0) + 1;
    }
    return acc;
  }, [detections, status, surface, minSeverity, jobId, reviewOnly, showTiny]);

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
  // What the selected stretch contains: the queue highlights these rows so
  // "the red bit over there" becomes "these hazards", in the list.
  const segmentIds = new Set(selectedSegment?.detectionIds ?? []);
  const segmentMembers = segmentIds.size
    ? detections.filter((d) => segmentIds.has(d.id!))
    : [];
  const visibleIds = new Set(filtered.map((d) => d.id));
  const segmentVisible = segmentMembers.filter((d) => visibleIds.has(d.id)).length;
  const segmentTypeSummary = Object.entries(
    segmentMembers.reduce<Record<string, number>>((acc, d) => {
      acc[d.hazardType] = (acc[d.hazardType] ?? 0) + 1;
      return acc;
    }, {})
  )
    .map(([k, n]) => `${n} ${k.replace('_', ' ')}`)
    .join(' · ');
  // The strip under Queue: a button when there is something to scroll to,
  // plain text when there is nothing (no members, or all of them filtered out).
  const stretchText =
    segmentMembers.length === 0
      ? null
      : `${segmentMembers.length} in this stretch: ${segmentTypeSummary}${
          segmentVisible < segmentMembers.length
            ? ` · ${segmentMembers.length - segmentVisible} hidden by filters`
            : ''
        }`;

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

  /* ---- dashboard numbers ----
     All read from the same fetch the rest of the page uses, so a KPI and the
     queue can never disagree about how many hazards there are. */
  const reviewedCount = detections.filter(
    (d) => d.reviewStatus === 'verified' || d.reviewStatus === 'filed'
  ).length;
  const severityCounts: Record<number, number> = {};
  for (const d of filtered) severityCounts[d.severity] = (severityCounts[d.severity] ?? 0) + 1;
  // Oldest → newest, so the trend reads left to right like every other chart.
  const chronological = [...jobs].sort((a, b) => a.id - b.id).slice(-10);
  const hazardSeries = chronological.map((j) => detections.filter((d) => d.jobId === j.id).length);
  const spendSeries = chronological.map((j) => j.costEstimateUsd ?? 0);
  const spendTotal = jobs.reduce((sum, j) => sum + (j.costEstimateUsd ?? 0), 0);
  const auditsWithHazards = jobs.filter((j) => detections.some((d) => d.jobId === j.id));
  const routeColor =
    route.rqsi >= 75 ? 'var(--good)' : route.rqsi >= 50 ? 'var(--gold)' : 'var(--bad)';
  // The route profile is one route, not ten stacked: a ribbon of 254 stretches
  // is a barcode, and "the route" only means something per audit. With no audit
  // picked it reads the newest one that has a track, and says which.
  const profileJob =
    jobId === 'all'
      ? (jobs.find((j) => segments.some((s) => s.jobIds.includes(j.id))) ?? null)
      : (jobs.find((j) => String(j.id) === jobId) ?? null);
  const profileSegments = profileJob
    ? segments.filter((s) => s.jobIds.includes(profileJob.id))
    : visibleSegments;
  const profileRoute = summarize(profileSegments);
  const profileColor =
    profileRoute.rqsi >= 75
      ? 'var(--good)'
      : profileRoute.rqsi >= 50
        ? 'var(--gold)'
        : 'var(--bad)';
  // Live progress for the audits table's status cell.
  const progressByJob = new Map(scanning.map((s) => [s.jobId, s.progress]));

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
    <div className="mx-auto max-w-[1440px] px-4 py-5">
      {/* Title row: where you are, what is at stake, and the one action. */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dispatch</h1>
          <p className="mt-0.5 text-xs text-muted">
            {detections.length} hazard{detections.length === 1 ? '' : 's'} across {jobs.length} audit
            {jobs.length === 1 ? '' : 's'}
            {scanning.length > 0 && (
              <span className="text-gold"> · {scanning.length} scanning now</span>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/costs" className="control">
            Costs
          </Link>
          <button
            type="button"
            onClick={() => setNewOpen(true)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white shadow-[0_6px_18px_rgb(255_46_99/0.35)] transition-colors hover:bg-accentdim"
          >
            + New audit
          </button>
        </div>
      </div>

      {/* Four numbers, then the three pictures behind them. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Hazards in view"
          value={filtered.length}
          sub={
            <>
              {detections.length} on file
              {tinyCount > 0 && <span className="text-gold/80"> · {tinyCount} too small</span>}
            </>
          }
        >
          <Sparkline values={hazardSeries} />
        </KpiCard>
        <KpiCard
          label="Route quality"
          value={route.rqsi}
          unit="RQSI"
          valueColor={routeColor}
          sub={`${route.counts.green} smooth · ${route.counts.yellow} caution · ${route.counts.red} hazardous · ${Math.round(route.totalLengthM)} m`}
        >
          <Sparkline
            values={chronological.map(
              (j) => summarize(segments.filter((s) => s.jobIds.includes(j.id))).rqsi
            )}
            color="var(--good)"
          />
        </KpiCard>
        <KpiCard
          label="Reviewed"
          value={`${reviewedCount}/${detections.length}`}
          sub={`${corroborated} corroborated · ${disputedHazards} disputed`}
        >
          {/* A bar would be 5% wide on a real dataset - a dot pretending to be a
              chart. The percentage says the same thing without the pretence. */}
          <div className="text-right text-[11px] leading-none text-muted">
            <span className="num text-sm font-semibold text-ink">
              {detections.length ? Math.round((reviewedCount / detections.length) * 100) : 0}%
            </span>
            <div className="mt-1">of hazards</div>
          </div>
        </KpiCard>
        <KpiCard
          label="Spend (estimate)"
          value={`$${spendTotal.toFixed(2)}`}
          unit="of $150"
          sub={
            <Link href="/costs" className="text-accent/80 hover:text-accent">
              {auditsWithHazards.length} billed audit{auditsWithHazards.length === 1 ? '' : 's'} · open the ledger →
            </Link>
          }
        >
          <Sparkline values={spendSeries} color="var(--gold)" />
        </KpiCard>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="panel p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="label">Route profile</h2>
            <span className="text-[11px] text-muted">
              {profileJob ? `#${profileJob.id}` : 'no route'}
              {profileSegments.length > 0 && (
                <>
                  {' · '}
                  <span className="num font-semibold" style={{ color: profileColor }}>
                    {profileRoute.rqsi}
                  </span>{' '}
                  RQSI · {Math.round(profileRoute.totalLengthM)} m
                </>
              )}
            </span>
          </div>
          <div className="mt-3">
            <RouteProfile
              segments={profileSegments}
              selectedKey={segmentKey}
              onSelect={(k) => setSegmentKey((prev) => (prev === k ? null : k))}
            />
          </div>
          {jobId === 'all' && profileJob && (
            <p className="mt-2 text-[10px] text-muted2">
              newest route — pick an audit in Filters to profile another
            </p>
          )}
        </div>

        <div className="panel p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="label">Spend by audit</h2>
            <span className="text-[11px] text-muted">USD, estimated</span>
          </div>
          <div className="mt-3">
            <SpendBars jobs={jobs} detections={detections} activeJob={jobId} onPick={setJobId} />
          </div>
        </div>

        <div className="panel p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="label">Severity mix</h2>
            <span className="text-[11px] text-muted">severity ≥ {minSeverity}</span>
          </div>
          <div className="mt-3">
            <SeverityMix counts={severityCounts} active={minSeverity} onPick={setMinSeverity} />
          </div>
        </div>
      </div>

      {/* Filters sit in one bar under the charts: they narrow everything below. */}
      <div className="panel mt-3 flex flex-wrap items-center gap-3 px-3 py-2.5">
        <span className="label">Filters</span>
        {/*
          The size gate's bill of lading. Hidden by default, one click to see
          them, never deleted: a reviewer can decide a speck is real.
        */}
        {tinyCount > 0 && (
          <button
            onClick={() => setShowTiny((v) => !v)}
            title={`masks under ${Math.round(MIN_MASK_WIDTH_FRAC * 100)}% of the frame across - too small to judge`}
            className={`rounded border px-2 py-0.5 text-[11px] ${
              showTiny
                ? 'border-gold/40 bg-gold/10 text-gold'
                : 'border-line text-muted hover:border-raised hover:text-ink/90'
            }`}
          >
            {showTiny ? `hide ${tinyCount} too small` : `${tinyCount} too small · show`}
          </button>
        )}

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
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={reviewOnly}
              onChange={(e) => setReviewOnly(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            needs review
          </label>
        </div>
      </div>        {error && (
          <div className="mb-4 rounded border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </div>
        )}

        {/*
          Scanning: what the queue is doing right now. This is the answer to
          "can I upload several videos at once" - each row is a job running
          or waiting in the background, and none of them needed a page open.
        */}
        {scanning.length > 0 && (
          <div className="mb-4 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2.5">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-gold/80">
              <span className="h-1.5 w-1.5 rounded-full bg-gold pulse-soft" />
              Scanning
              <span className="text-gold/70 normal-case tracking-normal">
                {scanning.length} in the queue
              </span>
            </div>
            <ul className="mt-2 space-y-2">
              {scanning.map(({ jobId, progress }) => (
                <li key={jobId}>
                  <Link
                    href={`/inspect/${jobId}`}
                    className="flex items-center gap-3 rounded px-1 py-0.5 hover:bg-gold/10"
                  >
                    <span className="w-16 shrink-0 truncate text-xs text-muted" title={activeJobNames.get(jobId)}>
                      {activeJobNames.get(jobId)}
                    </span>
                    <span className="w-40 shrink-0 truncate text-xs text-gold/90">
                      {progress.position > 0
                        ? `queued · position ${progress.position}`
                        : progress.message}
                    </span>
                    {progress.total > 0 && progress.position === 0 && (
                      <span className="h-1 w-32 shrink-0 overflow-hidden rounded-full bg-surface2">
                        <span
                          className="block h-full bg-gold transition-[width] duration-500"
                          style={{
                            width: `${Math.min(100, (progress.done / progress.total) * 100)}%`,
                          }}
                        />
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-muted">
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
            className={`h-[440px] overflow-hidden panel ${
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
              gradeFilter={gradeFilter}
              onGradeFilter={setGradeFilter}
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
                <div className="panel p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="label">
                      Footage
                    </h2>
                    <span className="truncate text-xs capitalize text-muted">
                      {active.hazardType.replace('_', '-')} ·{' '}
                      {[active.street, active.crossStreet].filter(Boolean).join(' @ ') ||
                        'location not placed'}
                    </span>
                    <div className="ml-auto flex items-center gap-3">
                      {activeJobId != null && (
                        <Link
                          href={`/inspect/${activeJobId}`}
                          className="text-[11px] text-muted hover:text-gold"
                          title="open the dedicated footage page"
                        >
                          full page ↗
                        </Link>
                      )}
                      <button
                        onClick={() => setOpen(false)}
                        className="rounded border border-line px-2 py-0.5 text-[11px] text-ink/90 hover:border-raised"
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
          <div className="panel p-3">
            <h2 className="label">
              Queue
            </h2>
            {selectedSegment &&
              (stretchText ? (
                <button
                  type="button"
                  onClick={scrollToStretchMember}
                  disabled={segmentVisible === 0}
                  className="mt-1 block w-full text-left text-[11px] text-gold/90 hover:text-gold disabled:text-muted2"
                  title={
                    segmentVisible === 0
                      ? 'these rows are hidden by the active filters'
                      : 'scroll the queue to the first one'
                  }
                >
                  {stretchText} ↧
                </button>
              ) : (
                <p className="mt-1 text-[11px] text-gold/90">
                  No hazards in this stretch.
                </p>
              ))}
            <ul ref={queueRef} className="mt-2 max-h-72 divide-y divide-line overflow-y-auto">
              {filtered.length === 0 && (
                <li className="py-6 text-center text-sm text-muted">
                  Nothing matches these filters.
                </li>
              )}
              {filtered.map((d) => {
                const group = hazardOf.get(d.id!);
                return (
                <li
                  key={d.id}
                  data-seg-member={segmentIds.has(d.id!) ? '' : undefined}
                  className={`flex items-center gap-2 py-2 ${
                    d.id === activeId ? 'bg-surface2/70 -mx-1 px-1 rounded' : ''
                  } ${
                    segmentIds.has(d.id!)
                      ? 'border-l-2 border-gold pl-1.5'
                      : ''
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
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold text-bg"
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
                    className="h-6 w-10 shrink-0 rounded border border-line bg-surface2 object-cover"
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
                      {d.tooSmall && (
                        <span
                          className="rounded border border-gold/40 bg-gold/10 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-gold"
                          title="mask too small to judge - out of the grade and the exports"
                        >
                          too small
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {[d.street, d.crossStreet].filter(Boolean).join(' @ ') ||
                        'location not placed'}
                    </div>
                  </button>
                  {group && group.passes > 1 && (
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                        group.state === 'disputed'
                          ? 'border-gold/40 bg-gold/10 text-gold'
                          : 'border-good/40 bg-good/10 text-good'
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
                        ? 'border-good/40 bg-good/10 text-good'
                        : d.reviewStatus === 'verified'
                          ? 'border-sky-700 bg-sky-950 text-sky-300'
                          : 'border-line text-muted hover:border-raised'
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

          <div className="panel p-3">
            <h2 className="label">
              Breakdown
            </h2>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {Object.entries(byType).map(([k, n]) => {
                const active = type === k;
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setType(active ? 'all' : k)}
                    title={
                      active
                        ? 'show every type again'
                        : `show only ${k.replace('_', ' ')} findings`
                    }
                    className={`rounded border px-2 py-1 capitalize transition-colors ${
                      active
                        ? 'border-gold/60 bg-gold/15 text-gold'
                        : 'border-line text-ink/90 hover:border-raised'
                    }`}
                  >
                    {k.replace('_', '-')}{' '}
                    <span className={active ? 'text-gold/80' : 'text-muted'}>
                      {n}
                    </span>
                  </button>
                );
              })}
              {Object.keys(byType).length === 0 && (
                <span className="text-muted">No hazards in view.</span>
              )}
            </div>
            {sidewalkCount > 0 && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-sky-400">
                <span className="inline-block h-2 w-2 rounded-full border border-sky-400 bg-sky-950" />
                {streetCount} street · {sidewalkCount} on sidewalk
              </p>
            )}
            {unplaced.length > 0 && (
              <p className="mt-2 text-xs text-gold">
                {unplaced.length} without a GPS fix — open the footage to place them.
              </p>
            )}
          </div>

          <div className="panel p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="label">
                Route quality
              </h2>
              {selectedSegment && (
                <button
                  type="button"
                  onClick={() => setSegmentKey(null)}
                  className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-raised hover:text-ink"
                  title="back to the whole-route summary"
                >
                  whole route ✕
                </button>
              )}
            </div>
            {visibleSegments.length === 0 ? (
              <p className="mt-2 text-xs text-muted">
                No GPS route to grade yet — segments need a track from the audit.
              </p>
            ) : (
              <>
                {selectedSegment ? (
                  <div>
                    <div className="mt-2 text-[10px] uppercase tracking-wider text-muted2">
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
                      <span className="text-xs text-muted">
                        RQSI · {GRADE_LABEL[selectedSegment.grade]} ·{' '}
                        {selectedSegment.lengthM} m
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <span className="rounded border border-line px-2 py-1">
                        {selectedSegment.defectCount} defect
                        {selectedSegment.defectCount === 1 ? '' : 's'}
                      </span>
                      {selectedSegment.defectCount > 0 && (
                        <span className="rounded border border-line px-2 py-1">
                          worst severity {selectedSegment.worstSeverity}
                        </span>
                      )}
                      <span className="rounded border border-line px-2 py-1">
                        density {selectedSegment.density}/100 m
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] text-muted">
                      {Math.round(segStartM)}–
                      {Math.round(segStartM + selectedSegment.lengthM)} m along
                      the route
                      {selectedSegment.offRoute > 0
                        ? ` · ${selectedSegment.offRoute} placed off-track`
                        : ''}
                    </p>
                    {selectedSegment.passes > 1 && (
                      <p className="mt-1 text-[11px] text-muted">
                        {selectedSegment.passes} passes{' '}
                        {selectedSegment.disagree
                          ? 'grade it differently'
                          : 'agree on the grade'}{' '}
                        · jobs{' '}
                        {selectedSegment.jobIds.map((id) => `#${id}`).join(', ')}
                      </p>
                    )}
                    <p className="mt-2 text-[11px] text-muted">
                      Whole route:{' '}
                      <span className="tabular-nums text-muted">
                        {route.rqsi} RQSI
                      </span>{' '}
                      · {route.counts.green} green · {route.counts.yellow}{' '}
                      yellow · {route.counts.red} red
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="text-3xl font-semibold tabular-nums text-ink">
                        {route.rqsi}
                      </span>
                      <span className="text-xs text-muted">
                        RQSI · {Math.round(route.totalLengthM)} m graded
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      {(['green', 'yellow', 'red'] as const).map((g) => (
                        <span
                          key={g}
                          className="flex items-center gap-1.5 rounded border border-line px-2 py-1"
                        >
                          <span
                            className="inline-block h-2 w-4 rounded-sm"
                            style={{ background: GRADE_COLOR[g] }}
                          />
                          {GRADE_LABEL[g]}{' '}
                          <span className="text-muted">{route.counts[g]}</span>
                        </span>
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] text-muted2">
                      Click any stretch on the map for its own grade.
                    </p>
                  </>
                )}
                {corroborated + disputedHazards + sharedStretches > 0 && (
                  <p className="mt-2 text-[11px] text-muted">
                    {corroborated} corroborated · {disputedHazards} disputed hazard
                    {corroborated + disputedHazards === 1 ? '' : 's'}
                    {passesInView > 1
                      ? ` · ${sharedStretches} shared stretch${sharedStretches === 1 ? '' : 'es'} across ${passesInView} passes`
                      : ''}
                  </p>
                )}
                {disagreeingStretches > 0 && (
                  <p className="mt-1 text-[11px] text-gold">
                    {disagreeingStretches} stretch
                    {disagreeingStretches === 1 ? '' : 'es'} graded differently by
                    different runs
                  </p>
                )}
                {!selectedSegment && route.worst && (
                  <p className="mt-2 text-xs text-muted">
                    Worst: segment {route.worst.index + 1} ·{' '}
                    <span style={{ color: GRADE_COLOR[route.worst.grade] }}>
                      {GRADE_LABEL[route.worst.grade]}
                    </span>{' '}
                    · RQSI {route.worst.rqsi} · {route.worst.defectCount} defect
                    {route.worst.defectCount === 1 ? '' : 's'}
                  </p>
                )}
                <p className="mt-1.5 text-[11px] text-muted">
                  Grades use every <em className="not-italic text-muted">street</em>{' '}
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

          <div className="panel p-3">
            <h2 className="label">
              Intersections
            </h2>
            {crossings.length === 0 ? (
              <p className="mt-2 text-xs text-muted">
                No two routes meet yet — drive the same street in a second
                audit and every shared stretch lands here.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {crossings.map((x) => (
                  <li
                    key={x.key}
                    className="rounded border border-line bg-bg/50 p-2"
                  >
                    <button
                      type="button"
                      onClick={() => setSegmentKey(x.key)}
                      className="w-full text-left"
                      title="detail this stretch on the map"
                    >
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="truncate text-ink/90">
                          {x.street ?? 'unnamed stretch'}
                        </span>
                        <span
                          className={`ml-auto shrink-0 rounded border px-1 py-0.5 text-[9px] uppercase tracking-wide ${
                            x.agree
                              ? 'border-good/40 bg-good/10 text-good'
                              : 'border-gold/40 bg-gold/10 text-gold'
                          }`}
                          title={
                            x.agree
                              ? 'every pass graded this stretch the same way'
                              : 'the passes graded this stretch differently'
                          }
                        >
                          {x.agree ? 'agree' : 'disagree'}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {x.jobs.map((j) => (
                          <span
                            key={j.jobId}
                            className="rounded border border-line px-1 py-0.5 text-[10px]"
                            style={{ color: GRADE_COLOR[j.grade] }}
                          >
                            #{j.jobId} {GRADE_LABEL[j.grade]}
                          </span>
                        ))}
                      </div>
                    </button>
                    {/*
                      Watch links open in a new tab: the dashboard stays put
                      behind the footage, which is the point of comparing one
                      pass against another.
                    */}
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {x.jobs.map((j) => (
                        <a
                          key={j.jobId}
                          href={`/inspect/${j.jobId}${
                            j.tMs != null ? `?t=${j.tMs}` : ''
                          }`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-gold hover:text-gold hover:underline"
                          title={`watch audit #${j.jobId} at this crossing`}
                        >
                          ▶ #{j.jobId}
                          {j.tMs != null ? ` @ ${clock(j.tMs)}` : ''}
                        </a>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

        </div>
      </div>

      {/*
        Audits table: every clip and its bill in one row.

        This replaces both the old / page's list and the Export card - the four
        exports and the cost link are per-audit facts, so they belong on the
        audit's own line rather than in a list that repeated its name twice.
        Status reads the live queue first, so a row says "segment 2/3 requests"
        while it is working instead of just "running".
      */}
      <div className="panel mt-5 overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <h2 className="label">Audits</h2>
          <span className="text-[11px] text-muted">
            {jobs.length} total · {scanning.length} in the queue
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-xs">
            <thead>
              <tr className="border-y border-line text-left text-[10px] uppercase tracking-wider text-muted2">
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-2 py-2 font-medium">Audit</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 text-right font-medium">Frames</th>
                <th className="px-2 py-2 text-right font-medium">Hazards</th>
                <th className="px-2 py-2 text-right font-medium">RQSI</th>
                <th className="px-2 py-2 text-right font-medium">Cost</th>
                <th className="px-4 py-2 font-medium">Export</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {jobs.map((j) => {
                const live = progressByJob.get(j.id);
                const jobSegments = segments.filter((s) => s.jobIds.includes(j.id));
                const jobRoute = summarize(jobSegments);
                const count = detections.filter(
                  (d) => d.jobId === j.id && d.reviewStatus !== 'rejected' && (!d.tooSmall || showTiny)
                ).length;
                const running = j.status === 'segmenting' || j.status === 'enriching' || j.status === 'transcoding';
                const tone =
                  j.status === 'ready'
                    ? 'border-good/40 bg-good/10 text-good'
                    : j.status === 'failed'
                      ? 'border-bad/40 bg-bad/10 text-bad'
                      : running
                        ? 'border-gold/40 bg-gold/10 text-gold'
                        : 'border-line text-muted';
                return (
                  <tr
                    key={j.id}
                    className={`transition-colors hover:bg-surface2/60 ${
                      jobId === String(j.id) ? 'bg-surface2/40' : ''
                    }`}
                  >
                    <td className="px-4 py-2 font-mono text-[11px] text-muted2">{j.id}</td>
                    <td className="max-w-[240px] px-2 py-2">
                      <button
                        type="button"
                        onClick={() => setJobId(jobId === String(j.id) ? 'all' : String(j.id))}
                        className="block max-w-full truncate text-left text-ink hover:text-accent"
                        title="filter this page to the audit"
                      >
                        {j.name}
                      </button>
                      <span className="block truncate text-[10px] text-muted2">
                        {j.createdAt}
                        {j.error ? ` · ${j.error.slice(0, 48)}` : ''}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}>
                        {j.status}
                      </span>
                      {live && (
                        <span className="mt-1 block max-w-[180px] truncate text-[10px] text-gold/80">
                          {live.position > 0 ? `queued · ${live.position}` : live.message}
                        </span>
                      )}
                    </td>
                    <td className="num px-2 py-2 text-right text-muted">{j.frames || '—'}</td>
                    <td className="num px-2 py-2 text-right text-ink">{count}</td>
                    <td className="num px-2 py-2 text-right" style={{ color: jobSegments.length ? GRADE_COLOR[jobRoute.rqsi >= 80 ? 'green' : jobRoute.rqsi >= 50 ? 'yellow' : 'red'] : undefined }}>
                      {jobSegments.length ? jobRoute.rqsi : '—'}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Link
                        href={`/costs#job-${j.id}`}
                        className="rounded border border-good/30 bg-good/10 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-good hover:border-good/60"
                        title={`what this audit cost - SAM ${usd(SAM_USD_PER_1000_FRAMES, 2)} per 1k frames plus Muse Spark classification. Opens the expense breakdown.`}
                      >
                        {mode === 'fixture' ? '(sim) ' : ''}
                        {usd(j.costEstimateUsd ?? 0, 2)}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <Link href={`/inspect/${j.id}`} className="text-accent hover:underline">
                          ▶ watch
                        </Link>
                        <a className="text-muted hover:text-gold hover:underline" href={`/api/jobs/${j.id}/export?format=csv`}>
                          CSV
                        </a>
                        <a className="text-muted hover:text-gold hover:underline" href={`/api/jobs/${j.id}/export?format=geojson`}>
                          GeoJSON
                        </a>
                        <a className="text-muted hover:text-gold hover:underline" href={`/api/jobs/${j.id}/export?format=open311`}>
                          Open311
                        </a>
                        <a className="text-muted hover:text-gold hover:underline" href={`/api/jobs/${j.id}/export?format=rqsi`}>
                          RQSI
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted">
                    No audits yet. Use “+ New audit” to start one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/*
        Uploading, without leaving the page you were reading.

        A drawer over Dispatch rather than a separate route: the point of this
        screen is that a scan can be started and watched in the same place, and
        the audits table above picks the new row up on its own 5s refresh.
      */}
      {newOpen && (
        <div className="fixed inset-0 z-[1000] flex justify-end" role="dialog" aria-modal="true" aria-label="New audit">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setNewOpen(false)}
            className="absolute inset-0 cursor-default bg-black/65 backdrop-blur-sm"
          />
          <div className="relative z-10 h-full w-full max-w-md overflow-y-auto border-l border-line bg-bg p-4 shadow-[-20px_0_60px_rgb(0_0_0/0.55)]">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">New audit</h2>
                <p className="mt-0.5 text-xs text-muted">
                  Drop footage and it starts scanning in the background.
                </p>
              </div>
              <button type="button" onClick={() => setNewOpen(false)} className="control" title="Esc">
                ✕
              </button>
            </div>
            <Uploader compact />
            <p className="mt-4 text-[11px] leading-relaxed text-muted2">
              Scanning runs on the server and does not need this tab. Close the drawer and keep
              working — progress stays on the audits table, and several clips can run at once.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
