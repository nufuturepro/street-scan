import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

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
  `);
  return db;
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
