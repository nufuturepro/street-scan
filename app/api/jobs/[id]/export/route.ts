import { listDetections, getJob, readGps } from '@/lib/repo';
import { toCsv, toGeoJson, buildWorkOrder, getProfile } from '@/lib/open311';
import { buildRqsi, toRqsiGeoJson } from '@/lib/rqsi';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Export for handoff.
 *
 * open311 returns the assembled POST bodies but does not send them: filing
 * against a live 311 endpoint needs a jurisdiction account and that city's
 * real service codes. The payload is the deliverable; dispatching it is a
 * deliberate human act.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const jobId = Number(id);
  const job = getJob(jobId);
  if (!job) return Response.json({ error: 'not found' }, { status: 404 });

  const url = new URL(req.url);
  const format = (url.searchParams.get('format') ?? 'geojson').toLowerCase();
  // Rejected false positives never leave this app: they are not hazards, so
  // they are not in a CSV, a GeoJSON file, or a work-order payload a city
  // could dispatch from.
  const detections = listDetections(jobId).filter(
    (d) => d.reviewStatus !== 'rejected'
  );
  const profile = url.searchParams.get('profile') ?? undefined;

  if (format === 'csv') {
    return new Response(toCsv(detections), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="streetscan-${jobId}.csv"`,
      },
    });
  }

  if (format === 'geojson') {
    return new Response(toGeoJson(detections), {
      headers: {
        'Content-Type': 'application/geo+json',
        'Content-Disposition': `attachment; filename="streetscan-${jobId}.geojson"`,
      },
    });
  }

  if (format === 'rqsi') {
    // The route artefact: one LineString per graded stretch, colour and grade
    // in the properties. This is what a city or a navigation app consumes -
    // a list of pins is not.
    const track = readGps(jobId);
    const segments =
      track.samples.length >= 2 ? buildRqsi({ jobId, track, detections }) : [];
    return new Response(
      toRqsiGeoJson(
        segments,
        segments.length
          ? undefined
          : `job ${jobId} has no GPS route recorded, so there is nothing to grade`
      ),
      {
        headers: {
          'Content-Type': 'application/geo+json',
          'Content-Disposition': `attachment; filename="streetscan-${jobId}-rqsi.geojson"`,
        },
      }
    );
  }

  if (format === 'open311') {
    const payload = {
      profile: getProfile(profile),
      generated_at: new Date().toISOString(),
      job_id: jobId,
      dispatched: false,
      note: 'Payloads assembled, not submitted. Verify service codes against the city catalog.',
      requests: detections.map((d) => buildWorkOrder(d, profile)),
    };
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="streetscan-${jobId}-open311.json"`,
      },
    });
  }

  return Response.json(
    { error: `unknown format: ${format}. Use csv, geojson, rqsi or open311.` },
    { status: 400 }
  );
}
