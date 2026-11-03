'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import VideoPane from './VideoPane';
import DetectionList from './DetectionList';
import WorkOrderPanel, { type DetectionEditPatch } from './WorkOrderPanel';
import CostMeter from './CostMeter';
import type { Detection, Job, JobProgress, SpendTotals } from '@/lib/types';

type JobResponse = {
  job: Job;
  detections: Detection[];
  counts: Record<string, number>;
  gps: { source: string; samples: number };
  /** metres of street this audit's own GPS track covers; null without a track */
  distanceM?: number | null;
  /** configured client mode - 'fixture' means the figures are simulated */
  mode?: string;
  cost: { frames: number; usd: number };
  /** this audit's spend-ledger rows: the meter's exact SAM/Spark split */
  spend?: SpendTotals;
  /** live queue snapshot; null when nothing is running for this job */
  progress: JobProgress | null;
};

const STAGE_LABEL: Record<string, string> = {
  queued: 'Queued',
  transcoding: 'Transcoding',
  gps: 'Reading GPS',
  segmenting: 'SAM 3.1 segmenting',
  filtering: 'Persistence filter',
  classifying: 'Muse Spark classifying',
  done: 'Complete',
  failed: 'Failed',
};

/** Statuses where the queue is still working on this job - poll fast. */
const IN_FLIGHT = new Set(['queued', 'transcoding', 'transcoded', 'segmenting', 'enriching']);

export default function InspectClient({
  id,
  initialSeekMs = null,
}: {
  id: number;
  /** Open the footage here on load - a ?t= deep link from the dashboard. */
  initialSeekMs?: number | null;
}) {
  const [data, setData] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  // Fixed at mount: the deep link seeks once, then ordinary selection takes
  // over (VideoPane prefers the active hazard's own timestamp).
  const [seekMs] = useState<number | null>(initialSeekMs);
  // Bumped on every selection so asking for the hazard that is already on
  // screen seeks to it again - see VideoPane for why activeId alone is not
  // enough for that.
  const [seekToken, setSeekToken] = useState(0);
  const select = (id: number) => {
    setActiveId(id);
    setSeekToken((t) => t + 1);
  };
  const enqueuedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
      if (!res.ok) return;
      setData((await res.json()) as JobResponse);
    } catch {
      /* transient */
    }
  }, [id]);

  /** Ask the queue to run this job. Idempotent server-side. */
  const enqueue = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${id}/process`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `could not queue this scan (${res.status})`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id, refresh]);

  useEffect(() => {
    // Deferred so the initial fetch does not cascade a render during commit.
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  // This page used to *own* the run through an SSE stream - close the tab and
  // the job's progress vanished with it. The queue owns runs now, so viewing
  // only enqueues: legacy jobs sitting at 'ingested' (uploaded before the
  // queue existed) still start when someone opens them.
  useEffect(() => {
    if (!data || enqueuedRef.current) return;
    if (data.job.status !== 'ingested' || !data.job.footagePath) return;
    enqueuedRef.current = true;
    const t = setTimeout(() => void enqueue(), 0);
    return () => clearTimeout(t);
  }, [data, enqueue]);

  const progress = data?.progress ?? null;

  // Fast polls while the queue works, slow ones when this job is idle - a
  // finished audit does not need a request every 1.5 seconds.
  const inFlight =
    progress != null || (data != null && IN_FLIGHT.has(data.job.status));
  useEffect(() => {
    const t = setInterval(() => void refresh(), inFlight ? 1500 : 8000);
    return () => clearInterval(t);
  }, [inFlight, refresh]);

  // A failed run reports from the job row, so the message survives a reload -
  // it used to live only in the SSE stream. Derived during render rather than
  // copied into state: the row is already the source of truth, and a state
  // copy would go stale against it.
  const jobError =
    data?.job.status === 'failed'
      ? (data.job.error ?? 'This scan failed.')
      : null;
  const displayError = error ?? jobError;

  const setStatus = async (
    detectionId: number,
    status: Detection['reviewStatus'],
    patch?: { lat?: number; lon?: number; street?: string }
  ) => {
    await fetch(`/api/detections/${detectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, ...patch }),
    }).catch(() => undefined);
    select(detectionId);
    await refresh();
  };

  const patch = async (detectionId: number, body: DetectionEditPatch) => {
    await fetch(`/api/detections/${detectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    await refresh();
  };

  const detections = data?.detections ?? [];
  const active = detections.find((d) => d.id === activeId) ?? null;
  const running =
    progress != null && progress.stage !== 'done' && progress.stage !== 'failed';
  const playback = data?.job.playbackPath ? `/api/files/${id}/playback.mp4` : null;

  const counts = data?.counts ?? { detected: 0, verified: 0, filed: 0, rejected: 0 };
  // Rejected entries are looking for nothing: they are a verdict already made,
  // so they must not pad the "need review" badge.
  const needsReview = detections.filter(
    (d) => d.needsReview && d.reviewStatus !== 'rejected'
  ).length;
  const rejected = counts.rejected ?? 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← audits
        </Link>
        <h1 className="text-lg font-semibold">{data?.job.name ?? 'Loading…'}</h1>
        <span className="text-xs text-zinc-500">#{id}</span>

        <div className="ml-auto flex flex-wrap items-center gap-3 text-xs">
          <span className="rounded border border-zinc-700 px-2 py-1 tabular-nums text-zinc-400">
            {counts.detected} detected · {counts.verified} verified · {counts.filed} filed
          </span>
          {rejected > 0 && (
            <span
              className="rounded border border-red-800 bg-red-950 px-2 py-1 tabular-nums text-red-300"
              title="marked not a hazard - excluded from grades and exports"
            >
              {rejected} rejected
            </span>
          )}
          {needsReview > 0 && (
            <span className="rounded border border-amber-700 bg-amber-950 px-2 py-1 text-amber-300">
              {needsReview} need review
            </span>
          )}
          <span className="text-zinc-500">
            GPS: {data ? (data.gps.samples ? `${data.gps.samples} fixes` : 'none') : '—'}
          </span>
        </div>
      </div>

      {progress && (
        <div className="mb-5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <div className="flex items-center gap-3 text-sm">
            <span className={`h-2 w-2 rounded-full ${running ? 'bg-amber-400 pulse-soft' : 'bg-emerald-400'}`} />
            <span className="text-zinc-300">
              {STAGE_LABEL[progress.stage] ?? progress.stage}
            </span>
            <span className="text-zinc-500 text-xs">{progress.message}</span>
            {progress.clientMode && (
              <span className="ml-auto rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500">
                {progress.clientMode === 'live' ? 'live API' : 'fixtures'}
              </span>
            )}
          </div>
          {progress.total > 0 && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full bg-amber-400 transition-[width] duration-300"
                style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {displayError && (
        <div className="mb-5 rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          {displayError}
          <button
            onClick={() => {
              enqueuedRef.current = true;
              void enqueue();
            }}
            className="ml-3 rounded border border-red-700 px-2 py-0.5 text-xs hover:bg-red-900"
          >
            Retry
          </button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <section>
          <VideoPane
            src={playback}
            detections={detections}
            activeId={activeId}
            seekToken={seekToken}
            seekMs={seekMs}
            onSelect={select}
          />
          <div className="mt-5">
            <WorkOrderPanel key={active?.id ?? 'none'} detection={active} onPatch={patch} />
          </div>
        </section>

        <aside className="lg:max-h-[75vh] lg:overflow-y-auto lg:pr-1">
          {data && (
            <div className="mb-4">
              <CostMeter
                frames={data.job.frames}
                analysisFps={data.job.analysisFps}
                billedUsd={data.job.costEstimateUsd}
                distanceM={data.distanceM}
                spend={data.spend}
                simulated={data.mode === 'fixture'}
                jobId={data.job.id}
              />
            </div>
          )}
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Detections
          </h2>
          <DetectionList
            detections={detections}
            activeId={activeId}
            onSelect={select}
            onStatus={(detectionId, status) => setStatus(detectionId, status)}
          />
        </aside>
      </div>
    </div>
  );
}
