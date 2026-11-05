import { redirect } from 'next/navigation';

/*
 * Dispatch moved to /. Kept as a redirect rather than deleted so bookmarks,
 * the README's older links and anything already open keep working.
 */
export default function DashboardPage() {
  redirect('/');
}
