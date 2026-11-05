import DashboardClient from '@/components/DashboardClient';

/*
 * Dispatch is the landing page.
 *
 * It used to be two screens: / to upload, /dashboard to read the results. That
 * split meant starting a scan navigated you away from the queue you were about
 * to read, and finishing one meant navigating back. Uploading now lives in a
 * drawer on this page, so there is one place to start work and watch it.
 */
export const dynamic = 'force-dynamic';

export default function HomePage() {
  return <DashboardClient />;
}
