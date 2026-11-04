import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SAM_USD_PER_1000_FRAMES } from './config';

/**
 * Plain SQL on Node's built-in sqlite. No native dependency to build on
 * Windows, no ORM to fight over an 8-day deadline.
 */

const DATA_DIR = path.join(process.cwd(), 'data');
const STORAGE_DIR = path.join(process.cwd(), 'storage');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(STORAGE_DIR, { recursive: true });

declare global {
  var __streetScanDb: DatabaseSync | undefined;
}

function open(): DatabaseSync {
  const db = new DatabaseSync(path.join(DATA_DIR, 'streetscan.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL,
      footage_path    TEXT,
      playback_path   TEXT,
      analysis_path   TEXT,
      gps_path        TEXT,
      gps_source      TEXT    NOT NULL DEFAULT 'none',
      gps_json        TEXT,
      status          TEXT    NOT NULL DEFAULT 'ingested',
      frames          INTEGER NOT NULL DEFAULT 0,
      analysis_fps    REAL    NOT NULL DEFAULT 10,
      cost_estimate   REAL    NOT NULL DEFAULT 0,
      error           TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS detections (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      hazard_type   TEXT    NOT NULL,
      severity      INTEGER NOT NULL,
      confidence    REAL    NOT NULL,
      t_ms          INTEGER NOT NULL,
      lat           REAL,
      lon           REAL,
      street        TEXT,
      cross_street  TEXT,
      description   TEXT,
      needs_review  INTEGER NOT NULL DEFAULT 1,
      review_status TEXT    NOT NULL DEFAULT 'detected',
      polygon_json  TEXT    NOT NULL,
      frame_index   INTEGER NOT NULL,
      osm_street    TEXT,
      osm_disagrees INTEGER NOT NULL DEFAULT 0,
      service_code  TEXT    NOT NULL,
      priority      TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_detections_job ON detections(job_id);
    CREATE INDEX IF NOT EXISTS idx_detections_status ON detections(review_status);

    CREATE TABLE IF NOT EXISTS work_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      detection_id  INTEGER NOT NULL REFERENCES detections(id) ON DELETE CASCADE,
      service_code  TEXT    NOT NULL,
      priority      TEXT    NOT NULL,
      payload_json  TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'filed',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_work_orders_detection ON work_orders(detection_id);

    -- The spend ledger: one row per billed event, written at the moment Meta
    -- reports the charge. Deliberately NOT a foreign key to jobs - deleting an
    -- audit must not delete its bill, which is exactly how the first ledger
    -- lost $21 of history. kind: 'sam' | 'spark' | 'adjustment'.
    CREATE TABLE IF NOT EXISTS spend (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id      INTEGER,
      kind        TEXT    NOT NULL,
      frames      INTEGER NOT NULL DEFAULT 0,
      tokens_in   INTEGER NOT NULL DEFAULT 0,
      tokens_out  INTEGER NOT NULL DEFAULT 0,
      usd         REAL    NOT NULL,
      detail      TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_spend_job ON spend(job_id);

    -- App settings, so /settings can set the Model API key without a rebuild.
    -- Values never leave the server: GET /api/settings reports only where a
    -- key came from and its last four characters.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Sidewalk findings used to be discarded at classification; now they are
  // kept and labelled. Guarded because ALTER TABLE has no IF NOT EXISTS -
  // every pre-existing row defaults to 'roadway', which is honest: the only
  // sidewalk patches that ever reached the table were written after this
  // column existed.
  try {
    db.exec(`ALTER TABLE detections ADD COLUMN surface TEXT NOT NULL DEFAULT 'roadway'`);
  } catch {
    /* column already there */
  }

  // The reviewer's own words: `description` holds what the classifier said (and
  // is now editable), this holds the extra detail a human adds - access notes,
  // what a crew will actually find, why they reclassified. Kept separate from
  // the model's sentence so the two never get confused in the record.
  try {
    db.exec(`ALTER TABLE detections ADD COLUMN reviewer_note TEXT`);
  } catch {
    /* column already there */
  }

  seedLegacySpend(db);
  return db;
}

/**
 * Adopt pre-ledger history exactly once, per job.
 *
 * Before the spend ledger existed, each job's bill lived in jobs.cost_estimate
 * as a single per-run number, and the meter displayed it split as
 * frames x rate (SAM) plus the remainder (Spark). These two seed rows reproduce
 * that display precisely - including the old derivation's flaws, which is the
 * honest thing: the app claimed $12.09 and Meta billed $33.38, and nothing in
 * this database can reconstruct the difference (overwritten re-runs, crashed
 * runs, deleted audits). The note on /costs says so; Meta's usage page stays
 * authoritative for anything before this ledger.
 *
 * Guard is per job (no spend rows yet), so a job re-run after the ledger
 * existed - whose live rows are written at billing time - is never re-seeded,
 * and a job seeded once is never seeded again on later restarts.
 */
function seedLegacySpend(db: DatabaseSync): void {
  const legacy = db
    .prepare(
      `SELECT id, frames, cost_estimate FROM jobs
       WHERE cost_estimate > 0
         AND NOT EXISTS (SELECT 1 FROM spend s WHERE s.job_id = jobs.id)`
    )
    .all() as Array<{ id: number; frames: number; cost_estimate: number }>;
  if (!legacy.length) return;

  const sam = db.prepare(
    `INSERT INTO spend (job_id, kind, frames, usd, detail)
     VALUES (?, 'sam', ?, ?, ?)`
  );
  const spark = db.prepare(
    `INSERT INTO spend (job_id, kind, usd, detail)
     VALUES (?, 'spark', ?, ?)`
  );

  for (const job of legacy) {
    // Same arithmetic the old meter ran: frames x rate to three places,
    // remainder to Spark, never negative (a bill below the frame charge was
    // displayed as the frame charge - max(billed, samUsd) - so Spark got 0).
    const frameCharge = Math.round(job.frames * SAM_USD_PER_1000_FRAMES) / 1000;
    const sparkUsd = Math.max(0, Math.round((job.cost_estimate - frameCharge) * 1000) / 1000);
    if (frameCharge > 0) {
      sam.run(
        job.id,
        job.frames,
        frameCharge,
        `pre-ledger seed - frame charge as the old meter derived it (${job.frames} frames)`
      );
    }
    if (sparkUsd > 0) {
      spark.run(
        job.id,
        sparkUsd,
        'pre-ledger seed - recorded bill minus that frame charge'
      );
    }
  }
}

export function db(): DatabaseSync {
  if (!globalThis.__streetScanDb) {
    globalThis.__streetScanDb = open();
  }
  return globalThis.__streetScanDb;
}

/**
 * Absolute storage root. Rows store absolute paths, so a database moved from
 * another machine needs re-rooting against this install - see repo.toJob.
 */
export function storageRoot(): string {
  return STORAGE_DIR;
}

export function storageDir(...parts: string[]): string {
  const p = path.join(STORAGE_DIR, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}
