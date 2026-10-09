'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, Card, ConfirmDialog, ErrorState, Field, Input, LoadingSkeleton, Notice, StatusBadge, Tabs, Textarea } from '@/components/ui';
import { api, friendlyMessage } from '@/lib/api';
import { DOCS_URL } from '@/lib/brand';
import { dateTime, timeAgo } from '@/lib/format';
import { can } from '@/lib/permissions';
import { qk, useWorkspace } from '@/lib/workspace';
import { msg, t } from '@/lib/i18n';
import { type Lang, snippet } from './api-snippets';

interface KeyInfo { id: string; prefix: string; createdAt: string; lastUsedAt: string | null; recoverable: boolean }
interface Credentials { instanceId: string; baseUrl: string; key: KeyInfo | null; apiKey?: string }
interface Endpoint {
  id: string; group: 'whatsapp' | 'otp'; method: 'GET' | 'POST'; path: string; title: string; body?: Record<string, unknown>; response: unknown; notes?: string;
}

// Request/response examples are API data, not UI text. i18n-ignore
const ENDPOINTS: Endpoint[] = [
  { id: 'send-text', group: 'whatsapp', method: 'POST', path: '/send-text', title: msg("Send a text message"),
    body: { to: '+919812345678', text: 'Namaste! Your booking is confirmed.' }, // i18n-ignore
    response: { queued: true, messageId: '0199…', status: 'QUEUED', duplicate: false, statusUrl: '…/messages/0199…' },
    notes: msg("Use \"to\" (+919812345678) or \"chatId\" (919812345678@c.us). Add \"idempotencyKey\" so a retry never sends twice.") },
  { id: 'send-image', group: 'whatsapp', method: 'POST', path: '/send-image', title: msg("Send an image"),
    body: { to: '+919812345678', mimeType: 'image/jpeg', dataBase64: '<base64>', caption: 'Your receipt' }, // i18n-ignore
    response: { queued: true, messageId: '0199…', status: 'QUEUED' } },
  { id: 'send-file', group: 'whatsapp', method: 'POST', path: '/send-file', title: msg("Send a file (PDF, Excel, …)"),
    body: { to: '+919812345678', mimeType: 'application/pdf', fileName: 'invoice.pdf', dataBase64: '<base64>' }, // i18n-ignore
    response: { queued: true, messageId: '0199…', status: 'QUEUED' } },
  { id: 'message', group: 'whatsapp', method: 'GET', path: '/messages/{messageId}', title: msg("Check a message's status"),
    response: { message: { id: '0199…', status: 'DELIVERED', to: '+919812345678', type: 'TEXT' } }, notes: msg("QUEUED → SENT → DELIVERED → READ, or FAILED with an errorCode.") },
  { id: 'status', group: 'whatsapp', method: 'GET', path: '/status', title: msg("Check the number's connection"),
    response: { instanceId: '…', status: 'CONNECTED', phoneNumber: '+917067257835', displayName: 'Maa Baglamukhi Havan' } }, // i18n-ignore
  { id: 'request-code', group: 'otp', method: 'POST', path: '/request-code', title: msg("Send an OTP code on WhatsApp"),
    body: { to: '+919812345678', name: 'PanditSuggest', length: 6, expires: 600 }, // i18n-ignore
    response: { id: '0199…', kind: 'CODE', status: 'PENDING', to: '+919812345678', code: '482913', expiresAt: '…' },
    notes: msg("Optional: useLetter, allCapital, template (must contain {code}). Max 5 codes per number per 10 minutes; only the newest code is valid.") },
  { id: 'validate-code', group: 'otp', method: 'POST', path: '/validate-code', title: msg("Check the code the user typed"),
    body: { to: '+919812345678', code: '482913' }, // i18n-ignore
    response: { valid: true, reason: 'OK', otp: { status: 'VERIFIED' } },
    notes: msg("Always HTTP 200. reason is OK, INVALID_CODE (with attemptsLeft), EXPIRED, TOO_MANY_ATTEMPTS (5 wrong tries) or NOT_FOUND.") },
  { id: 'generate-link', group: 'otp', method: 'POST', path: '/generate-link', title: msg("Login by WhatsApp (link)"),
    body: { name: 'PanditSuggest', expires: 600, message: { prompt: 'Log me in to {name}', success: 'You are logged in to {name} ✅', expired: 'This link has expired. Please try again.' } }, // i18n-ignore
    response: { id: '0199…', kind: 'LINK', status: 'PENDING', code: 'K7QX4M2P', whatsappLink: 'https://wa.me/91…?text=…' },
    notes: msg("Show whatsappLink as a button or QR. When the user sends the message, the request becomes VERIFIED with their phone, they get your success reply, and the OTP_VERIFIED webhook fires.") },
  { id: 'otp-status', group: 'otp', method: 'GET', path: '/requests/{id}', title: msg("Check an OTP request"),
    response: { id: '0199…', kind: 'LINK', status: 'VERIFIED', to: '+919812345678', verifiedAt: '…' } },
];

/** Copy button; `icon` renders the compact clipboard icon used next to ids and keys. */
export function Copy({ value, label, icon }: { value: string; label?: string; icon?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = () => { void navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); };
  if (icon) {
    return (
      <button type="button" onClick={copy} aria-label={label ?? t("Copy")} title={done ? t("Copied ✓") : label ?? t("Copy")}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-emerald-700 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600">
        {done ? <span aria-hidden>✓</span> : (
          <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
        )}
      </button>
    );
  }
  return <Button size="sm" variant="secondary" onClick={copy}>{done ? t("Copied ✓") : label ?? t("Copy")}</Button>;
}

export const canManageApi = (role: string | null | undefined) => role === 'OWNER' || role === 'ADMIN';

export function useInstanceCredentials(id: string) {
  const { orgId, role } = useWorkspace();
  return useQuery({ queryKey: [...qk.instance(orgId, id), 'api-key'], enabled: canManageApi(role),
    queryFn: () => api<Credentials>(`/v1/whatsapp/instances/${id}/api-key`) });
}

/**
 * "Api Key (Bearer Token)": created automatically with the instance. Masked by default; the eye shows it and
 * the copy icon copies it at any time (owners/admins; each reveal is audited server-side).
 * `fresh` holds the revealed key at page level so the code samples can use the real key too.
 */
export function ApiKeyField({ id, fresh, onFresh }: { id: string; fresh: string | null; onFresh: (key: string | null) => void }) {
  const { orgId, role } = useWorkspace();
  const qc = useQueryClient();
  const cred = useInstanceCredentials(id);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const reveal = useMutation({ mutationFn: () => api<{ apiKey: string | null }>(`/v1/whatsapp/instances/${id}/api-key/reveal`, { method: 'POST' }) });
  const rotate = useMutation({
    mutationFn: () => api<Credentials>(`/v1/whatsapp/instances/${id}/api-key`, { method: 'POST' }),
    onSuccess: (r) => { onFresh(r.apiKey ?? null); setConfirmRotate(false); qc.setQueryData([...qk.instance(orgId, id), 'api-key'], { ...r, apiKey: undefined }); },
  });
  const key = async () => {
    if (fresh) return fresh;
    const k = (await reveal.mutateAsync()).apiKey;
    onFresh(k);
    return k;
  };
  const copy = async () => {
    const k = await key().catch(() => null);
    if (!k) return;
    await navigator.clipboard.writeText(k);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const toggle = async () => { if (!shown && !(await key().catch(() => null))) return; setShown((v) => !v); };

  if (!canManageApi(role)) return <p className="text-sm text-slate-500">{t("Only owners and admins can see this number's API credentials.")}</p>;
  if (cred.isError) return <ErrorState error={cred.error} onRetry={() => cred.refetch()} />;
  if (!cred.data) return <LoadingSkeleton rows={1} />;
  const k = cred.data.key;
  if (!k) return <Notice tone="warn">{t("API access is not included in your current plan.")}</Notice>;
  const iconBtn = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-emerald-700 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-50 disabled:opacity-50';
  return (
    <div className="space-y-2">
      {k.recoverable || fresh ? (
        <div className="flex items-center gap-2">
          <button type="button" className={iconBtn} onClick={() => void copy()} disabled={reveal.isPending} aria-label={t("Copy API key")} title={copied ? t("Copied ✓") : t("Copy API key")}>
            {copied ? <span aria-hidden>✓</span> : (
              <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
              </svg>)}
          </button>
          <code className="min-w-0 break-all text-sm text-slate-900">{shown && fresh ? fresh : `${k.prefix}_${'•'.repeat(24)}`}</code>
          <button type="button" className={iconBtn} onClick={() => void toggle()} disabled={reveal.isPending} aria-pressed={shown} aria-label={shown ? t("Hide API key") : t("Show API key")}>
            <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />{shown && <path d="M3 3l18 18" />}
            </svg>
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-sm text-slate-900">{k.prefix}_{'•'.repeat(24)}</code>
          <span className="w-full text-xs text-amber-700">{t("This older key cannot be shown again. Generate a new key to copy it.")}</span>
        </div>
      )}
      <p className="text-xs text-slate-500">
        {t("created")}{' '}{dateTime(k.createdAt)} · {t("last used")}{' '}{k.lastUsedAt ? timeAgo(k.lastUsedAt) : t("never")}{' · '}
        <button type="button" className="font-medium text-emerald-800 underline" onClick={() => setConfirmRotate(true)}>{t("Generate new key")}</button>
      </p>
      {(reveal.isError || rotate.isError) && <Notice tone="error">{friendlyMessage(reveal.error ?? rotate.error)}</Notice>}
      <ConfirmDialog open={confirmRotate} title={t("Generate a new API key?")} body={t("The current key stops working immediately. Update every app that uses it.")}
        confirmLabel={t("Generate new key")} tone="danger" busy={rotate.isPending} onClose={() => setConfirmRotate(false)} onConfirm={() => rotate.mutate()} />
    </div>
  );
}

/** "API Documentation" section under the instance: how to use it, a test send and the endpoint reference. */
export function ApiDocs({ id, connected, fresh }: { id: string; connected: boolean; fresh: string | null }) {
  const { role } = useWorkspace();
  const cred = useInstanceCredentials(id);
  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-sky-50 p-4 ring-1 ring-inset ring-sky-200">
        <p className="flex items-center gap-2 font-semibold text-sky-900"><span aria-hidden className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-sky-600 text-xs text-white">{"i" /* i18n-ignore */}</span>{t("API Documentation")}</p>
        <ul className="mt-2 list-disc space-y-1 pl-10 text-sm text-sky-900">
          <li>{t("Paste the Instance ID and API key into your website or app (for example your login OTP code), and send WhatsApp messages and OTPs through this number. Put the webhook URL of your app below to receive replies.")}</li>
          <li>{t("Send the key as")}{' '}<code>{'Authorization: Bearer hs_live_…' /* i18n-ignore */}</code> {t("- it works only for this number and cannot open your inbox, contacts or settings.")}</li>
          <li>{t("You can test the API using the documentation below.")}</li>
        </ul>
      </div>
      <TestSend id={id} connected={connected} />
      {canManageApi(role) && cred.data && <Reference baseUrl={cred.data.baseUrl} instanceId={cred.data.instanceId} apiKey={fresh ?? 'YOUR_API_KEY'} />}
    </div>
  );
}


function TestSend({ id, connected }: { id: string; connected: boolean }) {
  const { role } = useWorkspace();
  const send = useMutation({ mutationFn: (body: object) => api<{ messageId: string }>('/v1/whatsapp/messages/text', { method: 'POST', body }) });
  if (!can(role, 'messages:send')) return null;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    send.mutate({ instanceId: id, to: f.get('to'), text: f.get('text'), idempotencyKey: crypto.randomUUID() });
  };
  return (
    <Card title={t("Send a test message")}>
      {!connected && <div className="mb-3"><Notice tone="warn">{t("Connect this WhatsApp number first.")}</Notice></div>}
      <form onSubmit={submit} className="grid items-end gap-3 sm:grid-cols-[1fr_2fr_auto]">
        <Field label={t("To (phone)")}>{(fid) => <Input id={fid} name="to" required inputMode="tel" placeholder="+91 98123 45678" />}</Field>
        <Field label={t("Message")}>{(fid) => <Textarea id={fid} name="text" required rows={1} maxLength={4096} defaultValue={t("Test message from the API 👋")} />}</Field>
        <Button type="submit" loading={send.isPending} disabled={!connected}>{t("Send")}</Button>
      </form>
      {send.isError && <div className="mt-3"><Notice tone="error">{friendlyMessage(send.error)}</Notice></div>}
      {send.isSuccess && <div className="mt-3"><Notice tone="success">{t("Queued. Message ID:")}{' '}<code className="text-xs">{send.data.messageId}</code></Notice></div>}
    </Card>
  );
}

function Reference({ baseUrl, instanceId, apiKey }: { baseUrl: string; instanceId: string; apiKey: string }) {
  const [group, setGroup] = useState<'whatsapp' | 'otp'>('whatsapp');
  const [lang, setLang] = useState<Lang>('curl');
  const [open, setOpen] = useState<string | null>('send-text');
  return (
    <Card title={t("API reference")} actions={<a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-sm text-emerald-800 underline">{t("Full OpenAPI docs ↗")}</a>}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs label={t("API")} value={group} onChange={setGroup} tabs={[{ id: 'whatsapp', label: t("Send messages") }, { id: 'otp', label: t("OTP authentication") }]} />
        {/* i18n-ignore (language names) */}
        <Tabs label={t("Language")} value={lang} onChange={setLang} tabs={[{ id: 'curl', label: 'cURL' }, { id: 'node', label: 'Node.js' }, { id: 'php', label: 'PHP' }, { id: 'python', label: 'Python' }]} />
      </div>
      <ul className="mt-4 space-y-2">
        {ENDPOINTS.filter((e) => e.group === group).map((e) => {
          const path = `/api/${e.group}/v1/${instanceId}${e.path}`;
          const isOpen = open === e.id;
          return (
            <li key={e.id} className="rounded-lg ring-1 ring-slate-200">
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : e.id)}
                className="flex w-full flex-wrap items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50">
                <StatusBadge tone={e.method === 'GET' ? 'slate' : 'green'}>{e.method}</StatusBadge>
                <code className="text-xs font-semibold text-slate-900">/{'{instance}'}{e.path}</code>
                <span className="text-sm text-slate-600">{t(e.title)}</span>
              </button>
              {isOpen && (
                <div className="space-y-3 border-t border-slate-100 p-3">
                  {e.notes && <p className="text-xs text-slate-600">{t(e.notes)}</p>}
                  <div className="relative">
                    <pre className="overflow-x-auto rounded-lg bg-[#050914] p-3 text-xs text-[#d6deeb] ring-1 ring-slate-200">{snippet(lang, e.method, `${baseUrl}${path}`, apiKey, e.body)}</pre>
                    <div className="absolute right-2 top-2"><Copy value={snippet(lang, e.method, `${baseUrl}${path}`, apiKey, e.body)} /></div>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-slate-500">{t("Response")}</p>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-3 text-xs ring-1 ring-slate-200">{JSON.stringify(e.response, null, 2)}</pre>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {/* i18n-ignore (JSON example) */}
      <p className="mt-3 text-xs text-slate-500">{t("Errors are JSON:")}{' '}<code>{'{ "error": { "code": "WHATSAPP_INSTANCE_NOT_CONNECTED", "message": "…" } }'}</code>{' · '}{t("401 bad key · 404 wrong instance · 409 number disconnected · 429 too fast")}</p>
    </Card>
  );
}
