import { NextResponse } from 'next/server';
import { getDetection, updateDetectionStatus, type DetectionEdit } from '@/lib/repo';
import { buildWorkOrder, getProfile } from '@/lib/open311';
import { TAXONOMY, isHazardType } from '@/lib/taxonomy';
import type { Detection } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 'detected' is reachable on purpose: it is the undo. A reviewer who clicked
 * Verify on the wrong row, or filed a work order against a hazard they then
 * decided is a false positive, must be able to walk the status back rather
 * than live with it. 'rejected' is the false-positive verdict - see types.ts.
 */
const STATUSES: Array<Detection['reviewStatus']> = [
  'detected',
  'verified',
  'filed',
  'rejected',
];

/** This municipality's code for a class, with the taxonomy as the fallback. */
function codesFor(hazardType: Detection['hazardType']): {
  serviceCode: string;
  priority: string;
} {
  let fromProfile: { service_code?: string; priority?: string } | undefined;
  try {
    fromProfile = getProfile().codes[hazardType];
  } catch {
    // service-codes.json missing or unreadable - the taxonomy still describes
    // the class, and failing the whole edit over a catalog lookup would be
    // worse than exporting a generic code.
    fromProfile = undefined;
  }
  return {
    serviceCode: fromProfile?.service_code ?? TAXONOMY[hazardType].serviceCode,
    priority: fromProfile?.priority ?? TAXONOMY[hazardType].priority,
  };
}

/**
 * The human verification step.
 *
 * "Verified" is doing real work here: a detection only becomes fileable after
 * a person confirms the hazard, its location and its street. When the GPS
 * track was missing, the pin is placed on this endpoint.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const detectionId = Number(id);
  const detection = Number.isFinite(detectionId) ? getDetection(detectionId) : null;
  if (!detection) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({
    detection,
    workOrder: buildWorkOrder(detection),
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const detectionId = Number(id);
  if (!Number.isFinite(detectionId)) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }

  const existing = getDetection(detectionId);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    status?: Detection['reviewStatus'];
    lat?: number | null;
    lon?: number | null;
    street?: string | null;
    crossStreet?: string | null;
    needsReview?: boolean;
    /** a reviewer's reclassification - see the "not a hazard" case in types.ts */
    hazardType?: Detection['hazardType'];
    severity?: Detection['severity'];
  } | null;
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });

  if (body.hazardType !== undefined && !isHazardType(body.hazardType)) {
    return NextResponse.json(
      { error: `unknown hazard type: ${String(body.hazardType)}` },
      { status: 400 }
    );
  }
  if (
    body.severity !== undefined &&
    (!Number.isInteger(body.severity) || body.severity < 1 || body.severity > 5)
  ) {
    return NextResponse.json(
      { error: 'severity must be an integer 1-5' },
      { status: 400 }
    );
  }

  const status =
    body.status && STATUSES.includes(body.status) ? body.status : existing.reviewStatus;

  if (
    (body.crossStreet !== undefined && body.crossStreet !== null && typeof body.crossStreet !== 'string') ||
    (body.street !== undefined && body.street !== null && typeof body.street !== 'string')
  ) {
    return NextResponse.json(
      { error: 'street and crossStreet must be strings or null' },
      { status: 400 }
    );
  }

  const patch: DetectionEdit = {
    lat: body.lat ?? undefined,
    lon: body.lon ?? undefined,
    // Explicit null clears a wrong name; omitting the key leaves it alone.
    street: body.street === undefined ? undefined : body.street,
    crossStreet: body.crossStreet === undefined ? undefined : body.crossStreet,
    needsReview: body.needsReview,
    severity: body.severity,
  };

  // Reclassifying changes what this work order IS, so the service code and
  // priority have to move with it. Left behind, a corrected manhole would
  // export as POTHOLE and rank as P3.
  if (body.hazardType !== undefined) {
    patch.hazardType = body.hazardType;
    if (body.hazardType !== existing.hazardType) {
      Object.assign(patch, codesFor(body.hazardType));
    }
  }

  updateDetectionStatus(detectionId, status, patch);

  const updated = getDetection(detectionId)!;
  return NextResponse.json({
    detection: updated,
    // Always the current payload, so the panel that just applied a correction
    // redraws the work order a city would receive instead of the stale one.
    workOrder: buildWorkOrder(updated),
  });
}
