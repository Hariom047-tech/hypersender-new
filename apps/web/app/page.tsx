import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Landing } from '@/components/landing/landing';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: `${BRAND} · WhatsApp API, OTP & AI assistants from ₹499/month`,
  description: 'Send WhatsApp messages and OTPs from your app, get real-time webhooks and add a custom AI assistant. Unlimited messages, plans from ₹499/month.',
};

/** Public landing page; signed-in users go straight to their dashboard. */
export default async function Home() {
  if ((await cookies()).has('hs_session')) redirect('/dashboard');
  return <Landing />;
}
