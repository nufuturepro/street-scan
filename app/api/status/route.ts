import { probeLive, costTally } from '@/lib/meta';
import { clientMode, HACKATHON_CREDIT_USD } from '@/lib/config';
import { allSpend } from '@/lib/spend';

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

  // The lifetime ledger, not the session tally: every billed event has a row
  // written when it was charged, so a restart can no longer reset the pill to
  // $0.000 while the credit has already been consumed. The tally fields stay
  // as the since-restart detail only.
  const lifetime = allSpend();

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
      frames: lifetime.frames,
      requests: lifetime.requests,
      usd: lifetime.usd,
      samUsd: lifetime.samUsd,
      classUsd: lifetime.sparkUsd,
      classCalls: lifetime.classCalls,
      tokensIn: lifetime.tokensIn,
      tokensOut: lifetime.tokensOut,
      // fixtures are free and only ever happen in this process: session by nature
      fixtureCalls: cost.fixtureCalls,
      creditUsd: HACKATHON_CREDIT_USD,
    },
  });
}
