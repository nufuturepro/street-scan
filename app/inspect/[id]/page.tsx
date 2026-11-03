import InspectClient from '@/components/InspectClient';

export const dynamic = 'force-dynamic';

export default async function InspectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `?t=<ms>` opens the footage at that moment - the Intersections card's
   * watch links land on the shared spot instead of at 00:00. */
  searchParams: Promise<{ t?: string }>;
}) {
  const { id } = await params;
  const { t } = await searchParams;
  const jobId = Number(id);
  if (!Number.isFinite(jobId)) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10 text-sm text-zinc-500">Invalid job id.</div>
    );
  }
  const seekMs = Number(t);
  const initialSeekMs = t != null && Number.isFinite(seekMs) && seekMs > 0 ? seekMs : null;
  return <InspectClient id={jobId} initialSeekMs={initialSeekMs} />;
}
