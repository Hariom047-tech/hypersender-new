import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Onboarding } from './onboarding';

export default async function OnboardingPage() {
  if (!(await cookies()).has('hs_session')) redirect('/login');
  return <Onboarding />;
}
