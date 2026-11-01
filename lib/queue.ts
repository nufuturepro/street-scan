import { runJob } from './pipeline';
import { SCAN_CONCURRENCY } from './config';
import { listJobs, updateJob } from './repo';
import type { JobProgress, JobStatus } from './types';

/**
 * The scan queue: uploads start working without a page open on them.
 *
 * Before this, a job only ever ran while somebody sat on /inspect holding the
 * SSE stream - upload three clips and two of them waited at `ingested` until
 * someone remembered them. Now the route handlers enqueue on ingest, up to
 * SCAN_CONCURRENCY jobs run at once, and progress lives here so any page can
 * read a snapshot instead of owning the run.
 *
 * In-process and in-memory on purpose: this is a single-node homelab demo,
 * and a run in flight dies with the process either way. The boot sweep marks
 * what a restart interrupted rather than silently resuming - a resumed run
 * re-bills the Meta API with nobody watching it.
 */

type State = {
  /** FIFO of job ids waiting for a slot, in enqueue order */
  waiting: number[];
  /** job id -> latest progress from runJob's own callback, with queue place */
  running: Map<number, JobProgress>;
  /** slots in use */
  active: number;
  swept: boolean;
};

// Survives dev-server recompiles the same way the sqlite handle does: the
// module may be evaluated twice, the process keeps one queue.
declare global {
  var __streetScanQueue: State | undefined;
}

function state(): State {
  if (!globalThis.__streetScanQueue) {
    globalThis.__streetScanQueue = {
      waiting: [],
      running: new Map(),
      active: 0,
      swept: false,
    };
  }
  return globalThis.__streetScanQueue;
}

/** Statuses a dead process leaves behind - the run died mid-flight. */
const ORPHANED: JobStatus[] = [
  'queued',
  'transcoding',
  'transcoded',
  'segmenting',
  'enriching',
];

/**
 * One-time repair on first touch of the queue in this process. Runs on reads
 * as well as writes so a page listing jobs never shows a `segmenting` status
 * that no live run owns. Safe on a GET: it is idempotent and only ever fires
 * before anything in this process can be running.
 */
function sweepOnce(): void {
  const s = state();
  if (s.swept) return;
  s.swept = true;
  for (const job of listJobs()) {
    if (ORPHANED.includes(job.status)) {
      updateJob(job.id, {
        status: 'failed',
        error: 'interrupted by a server restart - retry from the audit page',
      });
    }
  }
}

export function enqueue(jobId: number): { queued: boolean; position: number } {
  sweepOnce();
  const s = state();
  if (s.running.has(jobId)) return { queued: false, position: 0 };
  const at = s.waiting.indexOf(jobId);
  if (at >= 0) return { queued: true, position: at + 1 };

  s.waiting.push(jobId);
  // A retry clears the previous failure; `error: null` is how updateJob
  // writes NULL.
  updateJob(jobId, { status: 'queued', error: null });
  pump();


  const after = state();
  const now = after.running.has(jobId)
    ? 0
    : Math.max(0, after.waiting.indexOf(jobId)) + 1;
  return { queued: true, position: now };
}

function pump(): void {
  const s = state();
  while (s.active < SCAN_CONCURRENCY && s.waiting.length) {
    const jobId = s.waiting.shift()!;
    s.active += 1;
    s.running.set(jobId, {
      stage: 'queued',
      done: 0,
      total: 0,
      message: 'starting',
      position: 0,
    });
    void execute(jobId).finally(() => {
      const st = state();
      st.active -= 1;
      st.running.delete(jobId);
      pump();
    });
  }
}

async function execute(jobId: number): Promise<void> {
  try {
    await runJob(jobId, (p) => state().running.set(jobId, { ...p, position: 0 }));
  } catch {
    /* runJob already wrote the failure onto the job row; the queue moves on */
  }
}

/** Snapshot for one job: live progress, its queue place, or null if idle. */
export function progressOf(jobId: number): JobProgress | null {
  sweepOnce();
  const s = state();
  const live = s.running.get(jobId);
  if (live) return live;
  const at = s.waiting.indexOf(jobId);
  if (at >= 0) {
    return {
      stage: 'queued',
      done: 0,
      total: 0,
      message: `waiting - position ${at + 1}`,
      position: at + 1,
    };
  }
  return null;
}

/** Everything the queue is currently doing, running jobs first. */
export function activeJobs(): Array<{ jobId: number; progress: JobProgress }> {
  sweepOnce();
  const s = state();
  const out: Array<{ jobId: number; progress: JobProgress }> = [];
  for (const [jobId, p] of s.running) {
    out.push({ jobId, progress: p });
  }
  s.waiting.forEach((jobId, i) => {
    out.push({
      jobId,
      progress: {
        stage: 'queued',
        done: 0,
        total: 0,
        message: `waiting - position ${i + 1}`,
        position: i + 1,
      },
    });
  });
  return out;
}
