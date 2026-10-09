'use client';

import { Tabs } from '@/components/ui';
import type { Assistant } from '@/lib/types';
import { t } from '@/lib/i18n';
import { HavanSettingsPanel } from './settings-panel';
import { HavanTypesPanel } from './types-panel';
import { HavanBookings, HavanCallbacks } from './work-panel';

export const HAVAN_TEMPLATE_KEY = 'HAVAN_BOOKING';
export type HavanSection = 'callbacks' | 'bookings' | 'types' | 'settings';
export const HAVAN_SECTIONS: HavanSection[] = ['callbacks', 'bookings', 'types', 'settings'];

/** Havan data belongs to the assistant built from the havan template (or one given havan capabilities), not to every workspace. */
export const isHavanAssistant = (a: Pick<Assistant, 'template' | 'capabilities'>) =>
  a.template?.key === HAVAN_TEMPLATE_KEY || a.capabilities.some((c) => c.key.startsWith('havan.'));

/** The "Havan" tab of a havan assistant: Pandit Ji's work list and the havan setup, for that assistant's business. */
export function HavanPanel({ a, orgId, section, onSection }: { a: Assistant; orgId: string | null; section: HavanSection; onSection: (s: HavanSection) => void }) {
  const bid = a.businessId;
  return (
    <>
      <Tabs label={t("Havan sections")} value={section} onChange={onSection} tabs={[
        { id: 'callbacks', label: t("📞 Call-back requests") }, { id: 'bookings', label: t("🔥 Havan bookings") },
        { id: 'types', label: t("Havan types") }, { id: 'settings', label: t("Settings & calendar") }]} />
      <div className="mt-4">
        {section === 'callbacks' && <HavanCallbacks bid={bid} orgId={orgId} />}
        {section === 'bookings' && <HavanBookings bid={bid} orgId={orgId} />}
        {section === 'types' && <HavanTypesPanel bid={bid} orgId={orgId} settingsHref="?tab=havan&section=settings" />}
        {section === 'settings' && <HavanSettingsPanel bid={bid} orgId={orgId} />}
      </div>
    </>
  );
}
