'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import VideoPane from './VideoPane';
import DetectionList from './DetectionList';
import WorkOrderPanel from './WorkOrderPanel';
import type { Detection, Job } from '@/lib/types';

type Progress = {
  stage: string;
  done: number;
  total: number;
  message: string;
  clientMode?: string;
};

type JobResponse = {
  job: Job;
  detections: Detection[];
  counts: Record<string, number>;
  gps: { source: string; samples: number };
  cost: { frames: number; usd: number };
};

const STAGE_LABEL: Record<string, string> = {
  transcoding: 'Transcoding',
  gps: 'Reading GPS',
  segmenting: 'SAM 3.1 segmenting',
  filtering: 'Persistence filter',
  classifying: 'Muse Spark classifying',
  done: 'Complete',
  failed: 'Failed',
};

export default function InspectClient({ id }: { id: number }) {
  const [data, setData] = useState<JobResponse | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const startedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
      if (!res.ok) return;
      setData((await res.json()) as JobResponse);
    } catch {
      /* transient */
    }
  }, [id]);

  const run = useCallback(async () => {
    setError(null);
    setProgress({ stage: 'transcoding', done: 0, total: 1, message: 'starting' });
    try {
      const res = await fetch(`/api/jobs/${id}/process`, { method: 'POST' });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `process failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handle = (raw: string) => {
        const line = raw.trim();
        if (!line.startsWith('data:')) return;
        const json = line.slice(5).trim();
        if (!json) return;
        try {
          const p = JSON.parse(json) as Progress;
          setProgress(p);
          if (p.stage === 'failed') setError(p.message);
          if (p.stage === 'transcoding' || p.stage === 'classifying' || p.stage === 'done') {
            void refresh();
          }
        } catch {
          /* ignore malformed frame */
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) handle(part);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    }
  }, [id, refresh]);

  useEffect(() => {
    // Deferred so the initial fetch does not cascade a render during commit.
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  useEffect(() => {
    if (!data || startedRef.current) return;
    const st = data.job.status;
    if (st === 'ready' || st === 'failed') return;
    if (!data.job.footagePath) return;
    startedRef.current = true;
    const t = setTimeout(() => void run(), 0);
    return () => clearTimeout(t);
  }, [data, run]);

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
    setActiveId(detectionId);
    await refresh();
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
    await refresh();
  };

  const detections = data?.detections ?? [];
  const active = detections.find((d) => d.id === activeId) ?? null;
  const running = progress != null && progress.stage !== 'done' && progress.stage !== 'failed';
  const playback = data?.job.playbackPath ? `/api/files/${id}/playback.mp4` : null;

  const counts = data?.counts ?? { detected: 0, verified: 0, filed: 0 };
  const needsReview = detections.filter((d) => d.needsReview).length;

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
          {needsReview > 0 && (
            <span className="rounded border border-amber-700 bg-amber-950 px-2 py-1 text-amber-300">
              {needsReview} need review
            </span>
          )}
          <span className="text-zinc-500">
            GPS: {data ? (data.gps.samples ? `${data.gps.samples} fixes` : 'none') : '—'}
          </span>
          <span className="text-zinc-500 tabular-nums">
            {/* What this audit actually cost, persisted on the job. The process
                tally resets on every restart and would read $0.000 afterwards. */}
            {data ? `${(data.job.costEstimateUsd || data.cost.usd).toFixed(3)}` : ''}
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

      {error && (
        <div className="mb-5 rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          {error}
          <button
            onClick={() => {
              startedRef.current = false;
              void run();
            }}
            className="ml-3 rounded border border-red-700 px-2 py-0.5 text-xs hover:bg-red-900"
          >
            Retry
          </button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
        <section>
          <VideoPane
            src={playback}
            detections={detections}
            activeId={activeId}
            onSelect={setActiveId}
          />
          <div className="mt-5">
            <WorkOrderPanel key={active?.id ?? 'none'} detection={active} onPatch={patch} />
          </div>
        </section>

        <aside className="lg:max-h-[75vh] lg:overflow-y-auto lg:pr-1">
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Detections
          </h2>
          <DetectionList
            detections={detections}
            activeId={activeId}
            onSelect={setActiveId}
            onStatus={(detectionId, status) => setStatus(detectionId, status)}
          />
        </aside>
      </div>
    </div>
  );
}
