import InspectClient from '@/components/InspectClient';

export const dynamic = 'force-dynamic';

export default async function InspectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isFinite(jobId)) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10 text-sm text-zinc-500">Invalid job id.</div>
    );
  }
  return <InspectClient id={jobId} />;
}
