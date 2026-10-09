'use client';

import { useRef, useState } from 'react';
import { WEBHOOK_EVENTS } from '@/lib/types';
import { msg, t } from '@/lib/i18n';

const EVENT_INFO: Record<(typeof WEBHOOK_EVENTS)[number], { label: string; body: string }> = {
  MESSAGE_RECEIVED: { label: msg("Message received"), body: msg("Any incoming message (text, media, etc.)") },
  MESSAGE_SENT: { label: msg("Message sent"), body: msg("Sent by the API, dashboard, AI or from the phone") },
  MESSAGE_DELIVERED: { label: msg("Message delivered"), body: msg("Reached the customer's phone") },
  MESSAGE_READ: { label: msg("Message read"), body: msg("The customer opened it (blue ticks)") },
  MESSAGE_FAILED: { label: msg("Message failed"), body: msg("Could not be sent (see errorCode)") },
  MESSAGE_REVOKED: { label: msg("Message deleted"), body: msg("Deleted for everyone") },
  MESSAGE_REACTION: { label: msg("Message reaction"), body: msg("Reaction to a message") },
  INSTANCE_CONNECTED: { label: msg("Number connected"), body: msg("The WhatsApp number came online") },
  INSTANCE_DISCONNECTED: { label: msg("Number disconnected"), body: msg("The WhatsApp number went offline") },
  INSTANCE_STATUS_CHANGED: { label: msg("Connection status"), body: msg("Any connection status change") },
  OTP_VERIFIED: { label: msg("OTP link verified"), body: msg("A user sent the code of a login-by-WhatsApp link") },
};

/** Event choices come from the backend's normalised event types (no frontend-only names). */
export function EventPicker({ selected }: { selected: string[] }) {
  const box = useRef<HTMLFieldSetElement>(null);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const matches = (ev: (typeof WEBHOOK_EVENTS)[number]) => !needle
    || [ev, t(EVENT_INFO[ev].label), t(EVENT_INFO[ev].body)].some((x) => x.toLowerCase().replace(/_/g, ' ').includes(needle));
  // "Select all" acts on what the search shows; hidden events keep their state (they stay in the form).
  const setAll = (on: boolean) => box.current?.querySelectorAll<HTMLInputElement>('input[name="events"]')
    .forEach((i) => { if (!i.closest('[data-hidden]')) i.checked = on; });
  return (
    <fieldset ref={box}>
      <legend className="text-sm font-medium text-slate-800">{t("Events")}</legend>
      <label className="relative mt-2 block">
        <span className="sr-only">{t("Search events")}</span>
        <svg aria-hidden viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Start typing to search...")}
          className="w-full rounded-md border-0 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-emerald-600" />
      </label>
      <div className="mt-3 flex gap-3 text-xs">
        <button type="button" className="font-medium text-emerald-800 hover:underline" onClick={() => setAll(true)}>{t("Select all")}</button>
        <button type="button" className="text-slate-600 hover:underline" onClick={() => setAll(false)}>{t("Clear")}</button>
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {WEBHOOK_EVENTS.map((ev) => (
          <label key={ev} className={matches(ev) ? 'flex items-start gap-2 text-sm' : 'hidden'} data-hidden={matches(ev) ? undefined : ''}>
            <input type="checkbox" name="events" value={ev} defaultChecked={selected.includes(ev)} className="mt-1" />
            <span><span className="font-medium text-slate-900">{t(EVENT_INFO[ev].label)}</span>
              <span className="block text-xs text-slate-500">{t(EVENT_INFO[ev].body)} · <code>{ev}</code></span></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
