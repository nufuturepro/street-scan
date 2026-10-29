import { NextResponse } from 'next/server';
import { getDetection, updateDetectionStatus } from '@/lib/repo';
import { buildWorkOrder } from '@/lib/open311';
import type { Detection } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const STATUSES: Array<Detection['reviewStatus']> = ['detected', 'verified', 'filed'];

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
  } | null;
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });

  const status =
    body.status && STATUSES.includes(body.status) ? body.status : existing.reviewStatus;

  updateDetectionStatus(detectionId, status, {
    lat: body.lat ?? undefined,
    lon: body.lon ?? undefined,
    street: body.street ?? undefined,
    crossStreet: body.crossStreet ?? undefined,
    needsReview: body.needsReview,
  });

  const updated = getDetection(detectionId)!;
  return NextResponse.json({
    detection: updated,
    workOrder: status === 'filed' ? buildWorkOrder(updated) : null,
  });
}
