'use client';

import { HavanLegacyRedirect } from '@/components/havan/legacy-redirect';

/** Moved into the havan assistant's "Havan" tab; kept so old links keep working. */
export default function Page() {
  return <HavanLegacyRedirect section="types" />;
}
