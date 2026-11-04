import { MIN_MASK_AREA_FRAC, MIN_MASK_WIDTH_FRAC } from './config';
import type { Detection, Polygon } from './types';

/**
 * How big is this mask, really?
 *
 * SAM returns a box with no notion of distance. A pothole 25 m ahead and a
 * pothole under the bumper are the same "pothole" to it - one is 300 pixels
 * wide, the other thirteen. Everything downstream then treated those as equal
 * evidence: a 13x28 px speck on audit #13 (job 13, detection 258) was filed at
 * severity 4, turned a 25 m stretch of Brooklyn Ave red, and was shown to the
 * classifier as a crop smaller than an icon.
 *
 * This module is the missing measurement. It is pure arithmetic over the
 * polygon already stored, so:
 *   - existing audits are fixed at READ time, with no re-scan and no spend;
 *   - the dashboard, the audit page, the route grade and the exports all read
 *     the same verdict instead of each inventing one.
 *
 * A patch whose mask is under MIN_MASK_WIDTH_FRAC of the frame across, or
 * under MIN_MASK_AREA_FRAC of its area, is "too small to judge": it may be a
 * real defect, but at this distance the picture cannot support the claim, and
 * a confident work order about thirteen pixels is worse than no work order.
 */

export type MaskSize = {
  /** bbox width as a fraction of frame width (0..1) */
  widthFrac: number;
  /** bbox height as a fraction of frame height (0..1) */
  heightFrac: number;
  /** bbox area as a fraction of frame area (0..1) */
  areaFrac: number;
};

/** Bounding box of a normalized polygon, expressed as fractions of the frame. */
export function maskSize(polygon: Polygon): MaskSize {
  if (!polygon || polygon.length < 3) {
    return { widthFrac: 0, heightFrac: 0, areaFrac: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { widthFrac: 0, heightFrac: 0, areaFrac: 0 };
  const widthFrac = Math.max(0, maxX - minX);
  const heightFrac = Math.max(0, maxY - minY);
  return { widthFrac, heightFrac, areaFrac: widthFrac * heightFrac };
}

/**
 * Too small to judge, or not.
 *
 * A polygon with fewer than three points is not evidence of smallness - it is
 * absence of a mask (hand-built fixtures, a row written before polygons were
 * stored), and those must keep grading exactly as they did.
 */
export function tooSmall(polygon: Polygon): boolean {
  if (!polygon || polygon.length < 3) return false;
  const s = maskSize(polygon);
  return s.widthFrac < MIN_MASK_WIDTH_FRAC || s.areaFrac < MIN_MASK_AREA_FRAC;
}

/**
 * One predicate for a detection row, whichever way its flag arrived: the read
 * layer stamps `tooSmall` once (so a merged row keeps the mask it was judged
 * on), and everything else just asks.
 */
export function isTooSmall(d: Detection): boolean {
  return d.tooSmall ?? tooSmall(d.polygon);
}
