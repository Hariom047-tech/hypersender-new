import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';

/** Optimistic session check only; every API call is authorised by the backend. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await cookies()).has('hs_session')) redirect('/login');
  return <AppShell>{children}</AppShell>;
}
