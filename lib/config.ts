/**
 * Tunable constants. Centralised so the unverified assumptions can be
 * flipped in one place when the API becomes callable.
 *
 * Assumption A (UNVERIFIED — blocked by 402 billing_not_configured):
 *   SAM 3.1 processes an uploaded video at its native frame rate rather than
 *   resampling. We rely on this to encode a cheap 10fps analysis copy.
 *   If the spike disproves it, set ANALYSIS_FPS = PLAYBACK_FPS and use a
 *   single file. Nothing else in the codebase needs to change.
 */

/** FPS of the file the browser plays back (what the human watches). */
export const PLAYBACK_FPS = 30;

/** FPS of the file SAM sees. Lower = cheaper: SAM bills per video frame. */
export const ANALYSIS_FPS = 10;

/** Playable resolution of the analysis file. */
export const ANALYSIS_SIZE = '854x480';

/** Playable resolution of the playback file. */
export const PLAYBACK_SIZE = '1280x720';

/** Max frames per SAM request. Hard API cap is 15,000. */
export const CHUNK_FRAMES = 3000;

/** Frames of overlap between chunks, used to re-join object IDs. */
export const CHUNK_OVERLAP_FRAMES = 150;

/** A hazard must be seen in at least this many frames to survive. */
export const MIN_PERSISTENT_FRAMES = 6;

/** ...and for at least this long. Filters shadows, glare, birds. */
export const MIN_PERSISTENT_MS = 600;

/** Overlap (IoU) below this between two boxes means "different object". */
export const MERGE_IOU_THRESHOLD = 0.3;

/** Detections under this confidence are never auto-filed. */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.75;

/**
 * RQSI: length of one graded route segment, in metres.
 *
 * Measured, not guessed: our own audit track is 78 m long (68 s of slow
 * moving footage), so the planned 100 m window collapsed the entire street into
 * a single segment and the colour-coding had nothing to colour. 25 m gives four
 * stretches out of that clip - enough to show smooth -> hazardous -> smooth on
 * one screen.
 *
 * The rubric's "per 100 metres" language is preserved where it matters: the
 * density each segment is scored with is normalised to 100 m regardless of how
 * long the window is (see rqsi.ts).
 */
export const SEGMENT_LENGTH_M = 25;

/** A detection this close to a segment belongs to it outright. */
export const SEGMENT_SNAP_RADIUS_M = 30;

/**
 * Between the snap radius and this distance we still fall back to the nearest
 * segment: a hand-placed pin sits a little way off the recorded track. Past it
 * the detection is dropped rather than charged to a segment it is not on.
 *
 * This cap used to be SEGMENT_LENGTH_M, which was correct while windows were
 * 100 m and became dead the moment they shrank to 25 m - a fallback above the
 * snap radius but below the window can never fire, so every off-track pin was
 * silently discarded. It is a fixed distance for a reason: how far a pin may
 * sit from the road has nothing to do with how long a grading window is.
 * Must stay above SEGMENT_SNAP_RADIUS_M or the band closes again.
 */
export const SEGMENT_OFF_ROUTE_M = 60;

/**
 * Index slope: weighted defect load per 100 m of road that costs 100 RQSI
 * points. Calibrated against this project's own detections, not picked - the
 * numbers below are what a 25 m window actually produces, because a defect
 * sitting in a quarter-window is a quarter-window's worth of rate:
 *   one severity-2 crack   (4.8/100m) -> 81   barely dented, as it should be
 *   two severity-2 cracks  (9.6/100m) -> 62   a cracked stretch, not a ruin
 *   one severity-4 pothole (28/100m)  ->  0   genuinely saturated
 * The grade itself never uses K - grades come from the rubric - so this only
 * shapes the headline number. Asserted by scripts/verify-rqsi.ts; changing K
 * breaks those assertions on purpose.
 */
export const RQSI_DENSITY_K = 4;

/** SAM pricing: USD per 1,000 video frames. */
export const SAM_USD_PER_1000_FRAMES = 0.2;

/** SAM billing floor per request. */
export const SAM_MIN_BILLED_FRAMES = 50;

/** API base. Public, not a secret. */
export const META_API_BASE = process.env.NEXT_PUBLIC_META_API_BASE ?? 'https://api.meta.ai/v1';

/**
 * Client mode.
 *   live    - always call the API
 *   fixture - never call the API (deterministic recorded responses)
 *   auto    - try live, fall back to fixture if billing/auth fails
 *
 * AUTO is the default because the team currently returns 402.
 */
export type ClientMode = 'live' | 'fixture' | 'auto';

export function clientMode(): ClientMode {
  const raw = (process.env.META_API_MODE ?? 'auto').toLowerCase();
  if (raw === 'live' || raw === 'fixture') return raw;
  return 'auto';
}
