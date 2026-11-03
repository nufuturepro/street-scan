import path from 'node:path';
import { db, storageRoot } from './db';
import { canonicalStreets } from './streets';
import type { Detection, GpsTrack, Job, JobStatus, Polygon } from './types';

/**
 * Thin data access. Plain SQL, no ORM - fewer moving parts on a deadline.
 */

/**
 * Every job read carries its ledger total. jobs.cost_estimate used to be the
 * cost, but it held only the last run's tally and a crash or a re-run could
 * make it undercount - the app claimed $12.09 while Meta billed $33.38. The
 * spend table is written at billing time, so this sum cannot be lost that way.
 */
const JOBS_SELECT = `
  SELECT jobs.*,
         (SELECT COALESCE(SUM(usd), 0) FROM spend s WHERE s.job_id = jobs.id) AS spend_usd
  FROM jobs`;

type JobRow = {
  id: number;
  name: string;
  footage_path: string | null;
  playback_path: string | null;
  analysis_path: string | null;
  gps_path: string | null;
  gps_source: string;
  gps_json: string | null;
  status: string;
  frames: number;
  analysis_fps: number;
  /** frozen pre-ledger column; only the seed at db open still reads it */
  cost_estimate: number;
  /** the job's real cost: SUM over its spend-ledger rows */
  spend_usd: number;
  error: string | null;
  created_at: string;
};

type DetectionRow = {
  id: number;
  job_id: number;
  hazard_type: string;
  severity: number;
  confidence: number;
  t_ms: number;
  lat: number | null;
  lon: number | null;
  street: string | null;
  cross_street: string | null;
  description: string | null;
  needs_review: number;
  review_status: string;
  polygon_json: string;
  frame_index: number;
  osm_street: string | null;
  osm_disagrees: number;
  service_code: string;
  priority: string;
  surface: string | null;
  created_at: string;
};

/**
 * Rows store the absolute path of whichever machine wrote them, so a database
 * copied to another host - or another OS - still points at a filesystem that
 * is not there. Anything with a `storage` segment is re-rooted onto this
 * install’s storage directory.
 *
 * Deliberately no regex: some rows were written with doubled separators
 * (`street-scan\\storage\\jobs`), and splitting on both separator characters
 * handles single, doubled and forward-slash forms in one pass.
 */
function resolveStoredPath(p: string | null): string | null {
  if (!p) return null;
  const segs = p.split('\\').join('/').split('/');
  const at = segs.lastIndexOf('storage');
  if (at < 0) return path.isAbsolute(p) ? p : path.join(storageRoot(), p);
  const rel = segs.slice(at + 1).filter(Boolean);
  return rel.length ? path.join(storageRoot(), ...rel) : storageRoot();
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    name: r.name,
    footagePath: resolveStoredPath(r.footage_path),
    playbackPath: resolveStoredPath(r.playback_path),
    analysisPath: resolveStoredPath(r.analysis_path),
    gpsPath: resolveStoredPath(r.gps_path),
    gpsSource: r.gps_source,
    status: r.status as JobStatus,
    frames: r.frames,
    analysisFps: r.analysis_fps,
    costEstimateUsd: Math.round(r.spend_usd * 1e4) / 1e4,
    error: r.error,
    createdAt: r.created_at,
  };
}

function toDetection(r: DetectionRow): Detection {
  return {
    id: r.id,
    jobId: r.job_id,
    hazardType: r.hazard_type as Detection['hazardType'],
    severity: r.severity as Detection['severity'],
    confidence: r.confidence,
    tMs: r.t_ms,
    lat: r.lat,
    lon: r.lon,
    street: r.street,
    crossStreet: r.cross_street,
    description: r.description ?? '',
    needsReview: !!r.needs_review,
    reviewStatus: r.review_status as Detection['reviewStatus'],
    polygon: JSON.parse(r.polygon_json) as Polygon,
    frameIndex: r.frame_index,
    osmStreet: r.osm_street,
    osmDisagrees: !!r.osm_disagrees,
    serviceCode: r.service_code,
    priority: r.priority,
    // Rows written before the column existed are roadway - the only sidewalk
    // findings that ever reached the table came after it.
    surface: r.surface === 'sidewalk' ? 'sidewalk' : 'roadway',
  };
}

/* ------------------------------ jobs ------------------------------ */

export function createJob(name: string): number {
  const res = db().prepare('INSERT INTO jobs (name) VALUES (?)').run(name);
  return Number(res.lastInsertRowid);
}

export function getJob(id: number): Job | null {
  const row = db().prepare(`${JOBS_SELECT} WHERE id = ?`).get(id) as JobRow | undefined;
  return row ? toJob(row) : null;
}

export function listJobs(): Job[] {
  const rows = db().prepare(`${JOBS_SELECT} ORDER BY id DESC`).all() as JobRow[];
  return rows.map(toJob);
}

export function updateJob(
  id: number,
  patch: Partial<{
    name: string;
    footage_path: string | null;
    playback_path: string | null;
    analysis_path: string | null;
    gps_path: string | null;
    gps_source: string;
    gps_json: string | null;
    status: JobStatus;
    frames: number;
    analysis_fps: number;
    error: string | null;
  }>
): void {
  // Deliberately no cost_estimate here: spend is append-only in `spend`,
  // written at billing time. The column that used to take it was per-run and
  // overwrote itself - that is the bug this ledger replaced.
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => {
    const v = (patch as Record<string, unknown>)[k];
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
    if (v instanceof Uint8Array) return v;
    return String(v);
  });
  db().prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).run(...values, id);
}

export function deleteJob(id: number): void {
  db().prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

/**
 * Clear a job's detections before a re-run. Without this, processing the same
 * audit twice appends a second set of rows and the dashboard double-counts
 * every hazard.
 */
export function deleteDetections(jobId: number): void {
  db().prepare('DELETE FROM detections WHERE job_id = ?').run(jobId);
}

export function readGps(jobId: number): GpsTrack {
  const row = db()
    .prepare('SELECT gps_json FROM jobs WHERE id = ?')
    .get(jobId) as { gps_json: string | null } | undefined;
  if (!row?.gps_json) return { source: 'none', samples: [] };
  try {
    return JSON.parse(row.gps_json) as GpsTrack;
  } catch {
    return { source: 'none', samples: [] };
  }
}

/* --------------------------- detections --------------------------- */export function insertDetection(d: Detection): number {
  const res = db()
    .prepare(
      `INSERT INTO detections
       (job_id, hazard_type, severity, confidence, t_ms, lat, lon, street, cross_street,
        description, needs_review, review_status, polygon_json, frame_index, osm_street,
        osm_disagrees, service_code, priority, surface)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      d.jobId,
      d.hazardType,
      d.severity,
      d.confidence,
      d.tMs,
      d.lat,
      d.lon,
      d.street,
      d.crossStreet,
      d.description,
      d.needsReview ? 1 : 0,
      d.reviewStatus,
      JSON.stringify(d.polygon),
      d.frameIndex,
      d.osmStreet,
      d.osmDisagrees ? 1 : 0,
      d.serviceCode,
      d.priority,
      d.surface ?? 'roadway'
    );
  return Number(res.lastInsertRowid);
}

export function getDetection(id: number): Detection | null {
  const row = db().prepare('SELECT * FROM detections WHERE id = ?').get(id) as
    | DetectionRow
    | undefined;
  return row ? toDetection(row) : null;
}

export function listAllDetections(): Detection[] {
  return canonicalize(readAllDetections());
}

export function listDetections(jobId: number): Detection[] {
  const all = readAllDetections();
  return canonicalize(
    all.filter((d) => d.jobId === jobId),
    all
  );
}

function readAllDetections(): Detection[] {
  const rows = db()
    .prepare('SELECT * FROM detections ORDER BY job_id ASC, t_ms ASC')
    .all() as DetectionRow[];
  return rows.map(toDetection);
}

/**
 * Spell every street the way the whole table spells it, not the way this view
 * happens to - so a single-audit page and the all-jobs dashboard cannot
 * disagree. See lib/streets.ts; nothing here is written back.
 */
function canonicalize(rows: Detection[], voters?: Detection[]): Detection[] {
  const canon = canonicalStreets(rows, voters);
  return rows.map((d) => {
    const names = d.id != null ? canon.get(d.id) : undefined;
    return names ? { ...d, street: names.street, crossStreet: names.crossStreet } : d;
  });
}

/**
 * A second audit that reaches the same conclusion is a verification, so the
 * human does not have to click Verify twice for one pothole.
 *
 * Only ever upgrades `detected`: a human who filed a work order keeps it filed,
 * and a disputed group is never promoted - two passes that disagree are a
 * reason to look, not a reason to sign off. Returns the rows changed.
 */
export function promoteVerified(ids: number[]): number {
  if (!ids.length) return 0;
  const marks = ids.map(() => '?').join(',');
  const res = db()
    .prepare(
      `UPDATE detections SET review_status = 'verified' ` +
        `WHERE review_status = 'detected' AND id IN (${marks})`
    )
    .run(...ids);
  return Number(res.changes);
}

/**
 * What a human is allowed to correct on a detection.
 *
 * Type and severity are in here because they are the fields that make a work
 * order wrong in a way no pin fix can repair: a manhole typed as a pothole
 * ships the city the wrong service code and charges a false defect to the
 * street's grade. serviceCode/priority ride along so a reclassification cannot
 * leave the export describing the old class.
 */
export type DetectionEdit = Partial<
  Pick<
    Detection,
    | 'lat'
    | 'lon'
    | 'street'
    | 'crossStreet'
    | 'hazardType'
    | 'severity'
    | 'serviceCode'
    | 'priority'
    | 'needsReview'
  >
>;

/** camelCase patch key -> column. Order is the order they are written in. */
const EDIT_COLUMNS: Array<[keyof DetectionEdit, string]> = [
  ['lat', 'lat'],
  ['lon', 'lon'],
  ['street', 'street'],
  ['crossStreet', 'cross_street'],
  ['hazardType', 'hazard_type'],
  ['severity', 'severity'],
  ['serviceCode', 'service_code'],
  ['priority', 'priority'],
];

/**
 * One write for a status change and any corrections that came with it.
 *
 * Built as dynamic SQL because the fields are optional and a reviewer usually
 * changes one: COALESCE over eight columns would still write every one of
 * them, which is how a "reject" click used to be able to overwrite a pin.
 */
export function updateDetectionStatus(
  id: number,
  status: Detection['reviewStatus'],
  patch: DetectionEdit = {}
): void {
  const sets: string[] = ['review_status = ?'];
  const values: Array<string | number | null> = [status];

  for (const [key, column] of EDIT_COLUMNS) {
    // undefined = "leave it alone"; null = "clear it". A reviewer who typed
    // the wrong cross street has to be able to blank it again, and an empty
    // string would be a street name that is not a name.
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value as string | number | null);
  }
  if (patch.needsReview !== undefined) {
    sets.push('needs_review = ?');
    values.push(patch.needsReview ? 1 : 0);
  }

  db()
    .prepare(`UPDATE detections SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id);
}

export function detectionCounts(jobId: number): Record<string, number> {
  const rows = db()
    .prepare(
      'SELECT review_status AS status, COUNT(*) AS n FROM detections WHERE job_id = ? GROUP BY review_status'
    )
    .all(jobId) as Array<{ status: string; n: number }>;
  const out: Record<string, number> = { detected: 0, verified: 0, filed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}
