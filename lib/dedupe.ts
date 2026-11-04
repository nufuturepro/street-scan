import { SAME_AUDIT_MERGE_M } from './config';
import { isTooSmall } from './scale';
import { haversineM } from './rqsi';
import type { Detection } from './types';

/**
 * One physical defect, one work order - *within* an audit.
 *
 * This is deliberately not consensus. Two audits are two independent
 * witnesses; two rows from the SAME audit are one camera looking at one broken
 * patch as it gets closer, and SAM hands each approach distance a fresh object
 * id. Audit #13 proved the cost: 13 detections on 160 m of street, seven of
 * them in two knots under 5 m apart (250/251/252 and 257/258/259/260) - one
 * broken patch filed three and four times, at different types and severities.
 *
 * The rule is a greedy radius cluster per audit, same surface only:
 *   - a sidewalk crack and a street crack 5 m apart are different defects;
 *   - the cluster keeps the WORST severity and the HIGHEST confidence, because
 *     the point of a work order is the worst thing at that spot, not the
 *     average of what the model said on the way past;
 *   - the survivor keeps its own mask, timestamp and pin, which is the
 *     sighting a human will actually look at.
 *
 * Greedy against the representative only (not against every member) keeps a
 * chain of defects from welding into one long phantom the way a naive radius
 * union would: A-B 7 m and B-C 7 m do not put A and C together at 14 m.
 *
 * Rejected rows and rows too small to judge are left alone: they are hidden by
 * their own rules, and collapsing them into a real defect would silently move
 * that defect's grade onto a speck's evidence.
 */
export function mergeSameAudit(
  detections: Detection[],
  radiusM: number = SAME_AUDIT_MERGE_M
): Detection[] {
  const kept: Detection[] = [];

  for (const d of detections) {
    if (d.reviewStatus === 'rejected' || isTooSmall(d)) {
      kept.push(d);
      continue;
    }
    if (d.lat == null || d.lon == null) {
      kept.push(d);
      continue;
    }

    const home = kept.find(
      (k) =>
        k.jobId === d.jobId &&
        k.surface === d.surface &&
        k.reviewStatus !== 'rejected' &&
        !isTooSmall(k) &&
        k.lat != null &&
        k.lon != null &&
        haversineM({ lat: k.lat, lon: k.lon }, { lat: d.lat!, lon: d.lon! }) <= radiusM
    );

    if (!home) {
      kept.push({ ...d, mergedIds: d.mergedIds ? [...d.mergedIds] : [] });
      continue;
    }

    const wins =
      d.severity > home.severity ||
      (d.severity === home.severity && d.confidence > home.confidence);
    if (wins) {
      // The worst reading wins the classification, but the mask stays the one
      // the row was already judged on - swapping in a smaller polygon here
      // would change a size verdict that has already been made.
      home.hazardType = d.hazardType;
      home.severity = d.severity;
      home.confidence = d.confidence;
      home.description = d.description;
      home.serviceCode = d.serviceCode;
      home.priority = d.priority;
    }
    home.mergedIds = [...(home.mergedIds ?? []), ...(d.mergedIds ?? []), d.id!].filter(
      (id) => id != null
    );
  }

  return kept;
}
