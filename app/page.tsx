import Link from 'next/link';
import { listJobs } from '@/lib/repo';
import Uploader from '@/components/Uploader';

export const dynamic = 'force-dynamic';

const STAGE_HINTS: Record<string, { label: string; tone: string }> = {
  ingested: { label: 'awaiting run', tone: 'text-zinc-400' },
  transcoded: { label: 'ready to segment', tone: 'text-zinc-400' },
  segmenting: { label: 'segmenting', tone: 'text-amber-300' },
  enriching: { label: 'classifying', tone: 'text-amber-300' },
  ready: { label: 'ready', tone: 'text-emerald-300' },
  failed: { label: 'failed', tone: 'text-red-400' },
};

export default function HomePage() {
  const jobs = listJobs();

  return (
    <div className="mx-auto max-w-7xl px-4 py-10">
      <section className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight">
          Turn a ride into a work order.
        </h1>
        <p className="mt-3 text-zinc-400 leading-relaxed">
          Upload footage and StreetScan segments every frame with SAM 3.1, keeps only hazards
          persistent enough to be real, tags them with your camera&apos;s GPS, then has Muse Spark
          decide <em className="text-zinc-200 not-italic">what</em> it is — pothole or cave-in —
          and assemble the Open311 payload.
        </p>
        <div className="mt-6">
          <Uploader />
        </div>
      </section>

      <section className="mt-14">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-500">
            Audits
          </h2>
          <Link href="/dashboard" className="text-sm text-amber-400 hover:text-amber-300">
            Open dispatch dashboard →
          </Link>
        </div>

        {jobs.length === 0 ? (
          <p className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-8 text-sm text-zinc-500">
            No audits yet. Your first clip lands here.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900/50">
            {jobs.map((j) => {
              const tone = STAGE_HINTS[j.status] ?? STAGE_HINTS.ingested;
              return (
                <li key={j.id}>
                  <Link
                    href={`/inspect/${j.id}`}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-zinc-900 transition-colors"
                  >
                    <span className="font-mono text-xs text-zinc-600 w-8">#{j.id}</span>
                    <span className="flex-1 truncate text-sm">{j.name}</span>
                    <span className={`text-xs ${tone.tone}`}>{tone.label}</span>
                    <span className="hidden sm:block text-xs tabular-nums text-zinc-600">
                      {j.frames ? `${j.frames} frames` : '—'}
                    </span>
                    <span className="text-xs tabular-nums text-zinc-600">
                      ${j.costEstimateUsd.toFixed(3)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
