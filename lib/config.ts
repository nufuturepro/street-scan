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

/**
 * Burned-in GPS overlay (overlay.ts): frames sampled per second while reading
 * the corner of the picture. 1Hz matches how often the app rewrites the fix.
 */
export const OVERLAY_SAMPLE_FPS = 1;

/**
 * Corner of the frame the overlay text lives in, as fractions of width/height.
 * Measured on a 1080p night clip: the two-line block ends near x=0.85, y=0.11.
 */
export const OVERLAY_CROP_W = 0.85;
export const OVERLAY_CROP_H = 0.11;

/**
 * A fix further than this from the fix on either side of it is a misread or a
 * GPS spike, not a drive. Measured on the dashcam clip: one frame sat 74 m
 * from the fix 3 s before it and 73 m from the one 1 s after it - a hairpin no
 * vehicle makes, which would otherwise be spliced into the graded route as
 * ~150 m of phantom street. Real movement in that clip peaks at 4.4 m/s, so
 * this sits an order of magnitude clear of honest motion while still allowing
 * a long OCR blackout to move the car legitimately.
 */
export const OVERLAY_SPIKE_M = 50;

/** Frames of overlap between chunks, used to re-join object IDs. */
export const CHUNK_OVERLAP_FRAMES = 150;

/**
 * A hazard must be seen in at least this many frames to survive.
 *
 * Loosened from 6 frames / 600 ms: on audit #4 that pair kept 3 cracks out of
 * 67 s of visibly broken asphalt, because a hairline crossing the frame is only
 * legible for a few tenths of a second at speed. Shadows and glare are what
 * this pair was protecting against, and the classifier still rejects those by
 * looking at the crop - so the cost of lowering it is extra Spark calls, not
 * extra work orders.
 */
export const MIN_PERSISTENT_FRAMES = 5;

/** ...and for at least this long. Filters shadows, glare, birds. */
export const MIN_PERSISTENT_MS = 400;

/** Overlap (IoU) below this between two boxes means "different object". */
export const MERGE_IOU_THRESHOLD = 0.3;

/** Detections under this confidence are never auto-filed. */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Size gate: a mask narrower than this fraction of the frame is too small to
 * judge, and so is one under MIN_MASK_AREA_FRAC of the frame's area.
 *
 * Measured on this project's own 76 detections rather than guessed: at 854x480
 * this floor is ~13 px, which still catches the 13x28 px speck that audit #13
 * filed at severity 4 (and the 10-20 px masks beside it) while admitting
 * near-field cracks that 2.5% used to hide. A real pothole 3 m from the bumper
 * is 80-200 px across, so the floor stays clear of honest close evidence.
 *
 * Lowered from 2.5% when audit #4 was found to be under-reporting cracks: at
 * 2.5% (~48 px on 1080p) a narrow patch crack never reached the classifier at
 * all, and a rejection the classifier never sees cannot be argued with.
 */
export const MIN_MASK_WIDTH_FRAC = 0.015;

/** ...and the same verdict for tall, thin masks that slip past the width test. */
export const MIN_MASK_AREA_FRAC = 0.0005;

/**
 * Two detections from the SAME audit this close together are one defect filed
 * twice: SAM gives each approach distance a new object id, so one broken patch
 * becomes three or four work orders. Measured on audit #13: its two knots sit
 * 0.9-5.1 m apart, and the nearest pair of genuinely separate defects on the
 * street is further than this. Two audits are never merged here - that is
 * consensus, and it is the opposite claim.
 */
export const SAME_AUDIT_MERGE_M = 8;

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

/**
 * How close two detections from DIFFERENT audits must be to count as the same
 * hazard seen twice (consensus.ts).
 *
 * Measured on this project's own three jobs, not guessed: at 12 m the two
 * passes share nothing at all, at 20 m exactly one genuine cross-pass
 * disagreement surfaces, and at 25 m - a whole grading window - unrelated
 * defects start pairing up. The tight radius is deliberate: corroboration is a
 * claim that this is the same physical defect, and a wrong match is worse than
 * a missed one.
 */
export const CONSENSUS_RADIUS_M = 20;

/**
 * How close two route segments from different audits must be to be the same
 * stretch of street. A segment is SEGMENT_LENGTH_M long, so two windows that
 * cover the same road have midpoints within one window of each other - the real
 * audit's segments all landed 9-19 m from job 6's.
 */
export const SEGMENT_MERGE_M = SEGMENT_LENGTH_M;

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

/**
 * How many audits may scan at once (lib/queue.ts).
 *
 * Two is deliberate rather than generous: transcode is CPU-bound ffmpeg and
 * SAM calls are long-lived network requests, so a third simultaneous job
 * slows the two already running without finishing sooner overall. If Meta
 * rate-limits live mode, this is the one number to lower.
 */
export const SCAN_CONCURRENCY = 2;

/** SAM pricing: USD per 1,000 video frames. */
export const SAM_USD_PER_1000_FRAMES = 0.2;

/** SAM billing floor per request. */
export const SAM_MIN_BILLED_FRAMES = 50;

/**
 * Muse Spark pricing: USD per 1M tokens - dev.meta.ai/docs/pricing-rate-limits.
 * These live next to SAM's rate so the cost ledger, the spend pill and the
 * meter all quote the same numbers from one place.
 */
export const SPARK_USD_PER_1M_IN = 1.25;
export const SPARK_USD_PER_1M_OUT = 4.25;

/**
 * The free-credit pool the spend pill reports against, and the number the
 * reconcile action subtracts from to turn "credits remaining" (as Meta's
 * Billing page shows it) into actual spend.
 */
export const HACKATHON_CREDIT_USD = 150;

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
