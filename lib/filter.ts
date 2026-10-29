import type { Polygon, SamFrame } from './types';
import {
  MERGE_IOU_THRESHOLD,
  MIN_PERSISTENT_FRAMES,
  MIN_PERSISTENT_MS,
} from './config';

/**
 * Temporal persistence filtering + chunk-boundary reconciliation.
 *
 * This is the part that turns raw SAM output into trustworthy hazards.
 *
 * Two separate problems:
 *
 * 1. TRANSIENT FALSE POSITIVES. Shadows, glare, birds, compression blocks and
 *    road markings all produce a mask for a frame or two. A real pothole is
 *    under the camera for a second or more. Require both a minimum frame count
 *    AND a minimum wall-clock span, because either alone is gameable.
 *
 * 2. CHUNK BOUNDARIES. SAM's object IDs are stable *within* a response, and
 *    Meta explicitly warns they are NOT stable across entry, exit or long
 *    clips. We upload overlapping windows, so a hazard straddling a boundary
 *    arrives as two different IDs in two different responses. Re-join them by
 *    comparing polygons in the overlap region.
 */

/**
 * Which prompt asked for this frame. Optional because fixtures and
 * scripts/verify-filter.ts build frames by hand - absent reads as prompt 0.
 */
export type TaggedFrame = SamFrame & { chunkId: number; promptIdx?: number };

export type Track = {
  /** synthetic stable id across the whole job */
  key: string;
  chunkId: number;
  objectId: number;
  /** which prompt produced this track (0 when the caller did not say) */
  promptIdx: number;
  frames: TaggedFrame[];
  firstFrame: number;
  lastFrame: number;
  frameCount: number;
  spanMs: number;
  /** representative mask - the highest-confidence frame in the track */
  best: TaggedFrame;
};

export type BBox = { x: number; y: number; w: number; h: number };

export function bbox(polygon: Polygon): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Intersection over union of two normalized boxes. 0 = disjoint, 1 = same. */
export function iou(a: BBox, b: BBox): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;

  const ix = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const iy = Math.min(ay2, by2) - Math.max(a.y, b.y);
  if (ix <= 0 || iy <= 0) return 0;

  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

export function centroid(b: BBox): [number, number] {
  return [b.x + b.w / 2, b.y + b.h / 2];
}

/** Distance between box centres, normalized to the frame diagonal. */
export function centerDistance(a: BBox, b: BBox): number {
  const [ax, ay] = centroid(a);
  const [bx, by] = centroid(b);
  return Math.hypot(ax - bx, ay - by);
}

export function msPerFrame(fps: number): number {
  return 1000 / fps;
}

/** Group frames into tracks, keyed by (chunk, objectId). */
export function buildTracks(frames: TaggedFrame[], analysisFps: number): Track[] {
  const buckets = new Map<string, TaggedFrame[]>();
  for (const f of frames) {
    // promptIdx belongs in the key: both prompts re-identify the same hazard
    // under the same objectId inside one chunk, so leaving it out would weld
    // their frames into one track before the dedupe pass could see a duplicate.
    const k = `${f.chunkId}:${f.promptIdx ?? 0}:${f.objectId}`;
    const arr = buckets.get(k);
    if (arr) arr.push(f);
    else buckets.set(k, [f]);
  }

  const perFrame = msPerFrame(analysisFps);
  const tracks: Track[] = [];

  for (const [k, list] of buckets) {
    list.sort((a, b) => a.frameIndex - b.frameIndex);
    const first = list[0];
    const last = list[list.length - 1];
    let best = list[0];
    for (const f of list) if (f.score > best.score) best = f;
    tracks.push({
      key: k,
      chunkId: first.chunkId,
      objectId: first.objectId,
      promptIdx: first.promptIdx ?? 0,
      frames: list,
      firstFrame: first.frameIndex,
      lastFrame: last.frameIndex,
      frameCount: list.length,
      spanMs: (last.frameIndex - first.frameIndex) * perFrame,
      best,
    });
  }

  tracks.sort((a, b) => a.firstFrame - b.firstFrame);
  return tracks;
}

/**
 * Keep a track only if it is both dense enough and long enough.
 *
 * frameCount >= 6  kills single-frame noise (glare, a bird, a codec artifact)
 * spanMs    >= 600 kills fast-moving things that sweep through the frame
 *
 * Requiring BOTH matters: a flickering artifact can span a second while only
 * appearing twice, and a burst of codec noise can hit six frames in 200ms.
 */
export function persists(track: Track): boolean {
  return track.frameCount >= MIN_PERSISTENT_FRAMES && track.spanMs >= MIN_PERSISTENT_MS;
}

/**
 * Re-join tracks that describe the same physical hazard across a chunk seam.
 *
 * A candidate pair must satisfy all three:
 *   - adjacent chunks (diff of exactly 1)
 *   - overlapping frame ranges inside CHUNK_OVERLAP_FRAMES
 *   - spatial agreement (IoU above threshold OR centre very close)
 *
 * The spatial test is what stops two different potholes that happen to sit on
 * a seam from being welded into one long phantom track.
 */
export function mergeAcrossChunks(tracks: Track[], analysisFps: number): Track[] {
  const byChunk = new Map<number, Track[]>();
  for (const t of tracks) {
    const arr = byChunk.get(t.chunkId);
    if (arr) arr.push(t);
    else byChunk.set(t.chunkId, [t]);
  }

  const chunkIds = [...byChunk.keys()].sort((a, b) => a - b);
  // Union-find over track keys so a track spanning 3 chunks collapses cleanly.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const t of tracks) parent.set(t.key, t.key);

  for (let i = 0; i < chunkIds.length - 1; i++) {
    const left = byChunk.get(chunkIds[i])!;
    const right = byChunk.get(chunkIds[i + 1])!;
    if (chunkIds[i + 1] - chunkIds[i] !== 1) continue;

    for (const l of left) {
      for (const r of right) {
        // Do their frame ranges actually overlap? (both cover the seam)
        if (l.lastFrame < r.firstFrame) continue;
        if (r.lastFrame < l.firstFrame) continue;

        // Compare at the seam: last frame of the left track vs first of right.
        const seamA = bbox(l.best.polygon);
        const seamB = bbox(r.best.polygon);
        const overlapIoU = iou(seamA, seamB);
        const close = centerDistance(seamA, seamB) < 0.08;

        if (overlapIoU >= MERGE_IOU_THRESHOLD || close) union(l.key, r.key);
      }
    }
  }

  // Second pass - cross-prompt. Both prompts watch the SAME frames, so
  // 'pothole' and 'crack' each report the same broken patch and it would
  // otherwise reach the map as two pins and two work orders. Only tracks from
  // DIFFERENT prompts are considered (same-prompt collisions inside a chunk
  // are genuinely separate objects), the frame ranges must overlap, and the
  // spatial test is exactly the seam one - so two distinct hazards side by
  // side still stay apart.
  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      const a = tracks[i];
      const b = tracks[j];
      if (a.promptIdx === b.promptIdx) continue;
      if (a.lastFrame < b.firstFrame) continue;
      if (b.lastFrame < a.firstFrame) continue;

      const boxA = bbox(a.best.polygon);
      const boxB = bbox(b.best.polygon);
      const sameSpot =
        iou(boxA, boxB) >= MERGE_IOU_THRESHOLD ||
        centerDistance(boxA, boxB) < 0.08;
      if (sameSpot) union(a.key, b.key);
    }
  }

  const merged = new Map<string, Track>();
  for (const t of tracks) {
    const root = find(t.key);
    const existing = merged.get(root);
    if (!existing) {
      merged.set(root, { ...t, key: root });
      continue;
    }
    const raw = [...existing.frames, ...t.frames];
    // The overlap means one physical frame is reported by both neighbouring
    // responses. Dedupe by global frame index so frameCount reflects frames
    // observed rather than requests served - otherwise a short flicker sitting
    // on a seam could double its way past the persistence threshold.
    const byFrame = new Map<number, TaggedFrame>();
    for (const f of raw) {
      const prev = byFrame.get(f.frameIndex);
      if (!prev || f.score > prev.score) byFrame.set(f.frameIndex, f);
    }
    const combined = [...byFrame.values()].sort((a, b) => a.frameIndex - b.frameIndex);
    let best = combined[0];
    for (const f of combined) if (f.score > best.score) best = f;
    const first = combined[0];
    const last = combined[combined.length - 1];
    const perFrame = msPerFrame(analysisFps);
    merged.set(root, {
      ...existing,
      frames: combined,
      firstFrame: first.frameIndex,
      lastFrame: last.frameIndex,
      frameCount: combined.length,
      spanMs: (last.frameIndex - first.frameIndex) * perFrame,
      best,
      chunkId: Math.min(existing.chunkId, t.chunkId),
      objectId: Math.min(existing.objectId, t.objectId),
    });
  }

  return [...merged.values()].sort((a, b) => a.firstFrame - b.firstFrame);
}

/** The whole filter, in one call. Deterministic and pure. */
export function resolveTracks(
  frames: TaggedFrame[],
  analysisFps: number
): Track[] {
  const built = buildTracks(frames, analysisFps);
  const merged = mergeAcrossChunks(built, analysisFps);
  return merged.filter(persists);
}
