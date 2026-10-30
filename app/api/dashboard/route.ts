import { listJobs, listAllDetections, readGps } from '@/lib/repo';
import { buildRqsi } from '@/lib/rqsi';
import { groupHazards, mergeSegments } from '@/lib/consensus';

export const dynamic = 'force-dynamic';

/**
 * Everything the dispatch dashboard needs in one request: jobs, all detections
 * across them, the hazard groups those detections form across audits, and the
 * RQSI route segments graded into them.
 *
 * Small data - a hundred rows, a few dozen segments - so no pagination.
 *
 * All three derived collections are computed, not stored: recomputing is
 * arithmetic over rows already in memory, which keeps them correct the moment
 * someone moves a pin or a new clip lands, with no cache to invalidate and no
 * table to migrate. Consensus between audits falls out of the same pass - see
 * lib/consensus.ts for why one sighting per audit, per group.
 */
export async function GET() {
  const jobs = listJobs();
  const detections = listAllDetections();

  const hazards = groupHazards(detections);

  const perJob = jobs.flatMap((job) => {
    const track = readGps(job.id);
    if (track.samples.length < 2) return [];
    const located = detections.filter(
      (d) => d.jobId === job.id && d.lat != null && d.lon != null
    );
    return buildRqsi({ jobId: job.id, track, detections: located });
  });

  // A street driven twice is graded once, at the worse of the two readings.
  const segments = mergeSegments(perJob, hazards);

  return Response.json({ jobs, detections, segments, hazards });
}
