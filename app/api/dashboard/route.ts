import { listJobs, listAllDetections, readGps } from '@/lib/repo';
import { buildRqsi } from '@/lib/rqsi';

export const dynamic = 'force-dynamic';

/**
 * Everything the dispatch dashboard needs in one request: jobs, all detections
 * across them, and the RQSI route segments those detections were graded into.
 * Small data - a hundred rows, a few dozen segments - so no pagination.
 *
 * Segments are derived, not stored: recomputing them is arithmetic over a
 * track that is already in memory, which keeps them correct the moment someone
 * moves a pin, with no cache to invalidate and no table to migrate.
 */
export async function GET() {
  const jobs = listJobs();
  const detections = listAllDetections();

  const segments = jobs.flatMap((job) => {
    const track = readGps(job.id);
    if (track.samples.length < 2) return [];
    const located = detections.filter(
      (d) => d.jobId === job.id && d.lat != null && d.lon != null
    );
    return buildRqsi({ jobId: job.id, track, detections: located });
  });

  return Response.json({ jobs, detections, segments });
}
