import { probeLive, costTally } from '@/lib/meta';
import { clientMode } from '@/lib/config';
import { listJobs } from '@/lib/repo';

export const dynamic = 'force-dynamic';

let cached: { at: number; live: { ok: boolean; detail: string } } | null = null;
const TTL_MS = 60_000;

/**
 * Status of the thing that actually gates this build.
 *
 * The team key currently returns 402 `billing_not_configured`, so the app runs
 * on deterministic fixtures. This endpoint tells the UI which world it is in,
 * and the cost tally keeps us honest about spend against the $150 credit once
 * billing is restored.
 */
export async function GET() {
  const mode = clientMode();

  let live: { ok: boolean; detail: string };
  if (cached && Date.now() - cached.at < TTL_MS) {
    live = cached.live;
  } else {
    live = await probeLive();
    cached = { at: Date.now(), live };
  }

  const cost = costTally();

  // The tally only knows what this process has spent, so a restart used to
  // reset the pill to $0.000 while the credit had already been consumed.
  // Report whichever is larger: the session tally covers work in flight,
  // the persisted job costs cover everything billed before the restart.
  const persisted = listJobs().reduce((sum, j) => sum + (j.costEstimateUsd || 0), 0);

  return Response.json({
    mode,
    live,
    billing:
      live.detail.includes('402')
        ? {
            blocked: true,
            url: 'https://dev.meta.ai/billing/?team_id=2138064107073975',
            message:
              'Meta Model API returns 402 billing_not_configured. Running on recorded fixtures until this is resolved.',
          }
        : { blocked: false },
    cost: {
      frames: cost.frames,
      requests: cost.requests,
      usd: Number(Math.max(cost.totalUsd, persisted).toFixed(4)),
      samUsd: Number(cost.usd.toFixed(4)),
      classUsd: Number(cost.classUsd.toFixed(4)),
      classCalls: cost.classCalls,
      tokensIn: cost.tokensIn,
      tokensOut: cost.tokensOut,
      fixtureCalls: cost.fixtureCalls,
      creditUsd: 150,
    },
  });
}
