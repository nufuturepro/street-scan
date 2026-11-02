import { db } from './db';

/**
 * The spend ledger: one row per billed event, written at the moment money
 * moves. Everything that could erase a number before now cannot - a crashed
 * run, a re-run overwriting the job's single tally, a deleted job's row, a
 * restart losing the session tally, an orphan probe: the charge happened, the
 * row exists.
 *
 * job_id is nullable: probes and other standalone calls that bill without a
 * job land in the lifetime total but belong to no audit.
 */

export type SpendKind = 'sam' | 'spark' | 'adjustment';

export type SpendEntry = {
  jobId?: number | null;
  kind: SpendKind;
  /** frames billed by SAM (SAM rows only; the pre-ledger seed carries none) */
  frames?: number;
  /** classification tokens (Spark rows only - the real bill, not a guess) */
  tokensIn?: number;
  tokensOut?: number;
  usd: number;
  detail?: string;
};

export type SpendTotals = {
  usd: number;
  samUsd: number;
  sparkUsd: number;
  /** billed frames - only post-ledger SAM rows know theirs; seed rows carry 0 */
  frames: number;
  requests: number;
  classCalls: number;
  tokensIn: number;
  tokensOut: number;
};

export function recordSpend(entry: SpendEntry): void {
  db()
    .prepare(
      `INSERT INTO spend (job_id, kind, frames, tokens_in, tokens_out, usd, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.jobId ?? null,
      entry.kind,
      entry.frames ?? 0,
      entry.tokensIn ?? 0,
      entry.tokensOut ?? 0,
      entry.usd,
      entry.detail ?? null
    );
}

const TOTALS = `
  SELECT
    COALESCE(SUM(usd), 0) AS usd,
    COALESCE(SUM(CASE WHEN kind = 'sam' THEN usd ELSE 0 END), 0) AS sam_usd,
    COALESCE(SUM(CASE WHEN kind = 'spark' THEN usd ELSE 0 END), 0) AS spark_usd,
    COALESCE(SUM(CASE WHEN kind = 'sam' THEN frames ELSE 0 END), 0) AS frames,
    COALESCE(SUM(CASE WHEN kind = 'sam' THEN 1 ELSE 0 END), 0) AS requests,
    COALESCE(SUM(CASE WHEN kind = 'spark' THEN 1 ELSE 0 END), 0) AS class_calls,
    COALESCE(SUM(CASE WHEN kind = 'spark' THEN tokens_in ELSE 0 END), 0) AS tokens_in,
    COALESCE(SUM(CASE WHEN kind = 'spark' THEN tokens_out ELSE 0 END), 0) AS tokens_out
  FROM spend`;

type TotalRow = {
  usd: number;
  sam_usd: number;
  spark_usd: number;
  frames: number;
  requests: number;
  class_calls: number;
  tokens_in: number;
  tokens_out: number;
};

function totals(where: string, arg?: number): SpendTotals {
  const row = (arg === undefined
    ? db().prepare(`${TOTALS} ${where}`).get()
    : db().prepare(`${TOTALS} ${where}`).get(arg)) as TotalRow | undefined;
  return {
    usd: round4(row?.usd ?? 0),
    samUsd: round4(row?.sam_usd ?? 0),
    sparkUsd: round4(row?.spark_usd ?? 0),
    frames: row?.frames ?? 0,
    requests: row?.requests ?? 0,
    classCalls: row?.class_calls ?? 0,
    tokensIn: row?.tokens_in ?? 0,
    tokensOut: row?.tokens_out ?? 0,
  };
}

/** What one audit has actually cost, billed event by billed event. */
export function jobSpend(jobId: number): SpendTotals {
  return totals('WHERE job_id = ?', jobId);
}

/** The account's lifetime spend per this ledger - the number Meta's usage page should agree with, post-ledger. */
export function allSpend(): SpendTotals {
  return totals('');
}

/** SQLite cannot return 1e-05 cleanly; four places keeps every cent visible. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}