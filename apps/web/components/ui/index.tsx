'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { friendlyMessage } from '@/lib/api';
import { bytes, clock, INSTANCE_STATUS_TEXT, MESSAGE_STATUS_TEXT } from '@/lib/format';
import type { Message } from '@/lib/types';
import { Button, cx } from './primitives';
import { t } from '@/lib/i18n';

export * from './primitives';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{t(title)}</h1>
        {description && <p className="mt-1.5 max-w-3xl text-sm text-slate-600">{t(description)}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function MetricCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="relative overflow-hidden rounded-xl bg-white p-5 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.6)] ring-1 ring-slate-200">
      <span className={cx('absolute inset-x-0 bottom-0 h-0.5', tone === 'bad' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-gradient-to-r from-emerald-400 to-cyan-400')} aria-hidden />
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{t(label)}</p>
      <p className={cx('mt-2 text-3xl font-bold tracking-tight', tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900')}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{t(hint)}</p>}
    </div>
  );
}

type Tone = 'green' | 'amber' | 'red' | 'slate' | 'blue';
const TONE: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20', amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-red-50 text-red-800 ring-red-600/20', slate: 'bg-slate-100 text-slate-700 ring-slate-500/20', blue: 'bg-sky-50 text-sky-800 ring-sky-600/20',
};
const DOT: Record<Tone, string> = { green: 'bg-emerald-600', amber: 'bg-amber-500', red: 'bg-red-600', slate: 'bg-slate-400', blue: 'bg-sky-500' };

/** Status badges always carry TEXT (never colour alone). */
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONE[tone])}>
      <span className={cx('h-1.5 w-1.5 rounded-full', DOT[tone])} aria-hidden />
      {typeof children === 'string' ? t(children) : children}
    </span>
  );
}

export function instanceTone(status: string): Tone {
  if (status === 'CONNECTED') return 'green';
  if (['RECONNECTING', 'WAITING_FOR_QR', 'PAIRING'].includes(status)) return 'amber';
  if (['LOGGED_OUT', 'ERROR', 'SUSPENDED'].includes(status)) return 'red';
  return 'slate';
}

export function InstanceStatus({ status }: { status: string }) {
  return <StatusBadge tone={instanceTone(status)}>{t(INSTANCE_STATUS_TEXT[status] ?? status)}</StatusBadge>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded bg-slate-200', className)} aria-hidden />;
}

export function LoadingSkeleton({ rows = 4, label }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label ? t(label) : t('Loading')} className="space-y-3">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-sm font-medium text-slate-900">{t(title)}</p>
      {body && <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{t(body)}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-900 ring-1 ring-inset ring-red-200">
      <p>{friendlyMessage(error)}</p>
      {onRetry && <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>{t("Try again")}</Button>}
    </div>
  );
}

export interface Column<T> { key: string; header: string; cell: (row: T) => ReactNode; className?: string }

export function DataTable<T>({ rows, columns, rowKey, loading, empty, caption, onRowClick }: {
  rows: T[] | undefined; columns: Column<T>[]; rowKey: (r: T) => string; loading?: boolean; empty?: ReactNode; caption: string; onRowClick?: (r: T) => void;
}) {
  if (loading) return <LoadingSkeleton label={t('Loading {what}', { what: t(caption) })} />;
  if (!rows || rows.length === 0) return <>{empty}</>;
  return (
    <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <caption className="sr-only">{t(caption)}</caption>
        <thead className="bg-slate-50">
          <tr>{columns.map((c) => <th key={c.key} scope="col" className={cx('px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-600', c.className)}>{t(c.header)}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={rowKey(r)} className={cx(onRowClick && 'cursor-pointer hover:bg-slate-50')} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map((c) => <td key={c.key} className={cx('whitespace-nowrap px-4 py-3 text-slate-700', c.className)}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Accessible confirmation built on the native <dialog> (focus trap + Esc handled by the browser). */
export function ConfirmDialog({ open, title, body, confirmLabel, tone = 'danger', onConfirm, onClose, busy, confirmText }: {
  open: boolean; title: string; body: ReactNode; confirmLabel: string; tone?: 'danger' | 'primary'; busy?: boolean;
  onConfirm: () => void; onClose: () => void; confirmText?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setTyped(''); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);
  const blocked = Boolean(confirmText) && typed !== confirmText;
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="confirm-title" className="w-full max-w-md rounded-lg p-0 shadow-xl backdrop:bg-slate-900/40">
      <div className="p-5">
        <h2 id="confirm-title" className="text-base font-semibold text-slate-900">{title}</h2>
        <div className="mt-2 text-sm text-slate-600">{body}</div>
        {confirmText && (
          <label className="mt-4 block text-sm text-slate-700">{t("Type")}{' '}<strong>{confirmText}</strong> {t("to confirm")}
            <input className="mt-1 block w-full rounded-md px-3 py-2 ring-1 ring-slate-300" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
          <Button variant={tone} onClick={onConfirm} loading={busy} disabled={blocked}>{confirmLabel}</Button>
        </div>
      </div>
    </dialog>
  );
}

const STATUS_ICON: Record<string, string> = { QUEUED: '◷', SENT: '✓', DELIVERED: '✓✓', READ: '✓✓', FAILED: '!', REVOKED: '⊘' };

/**
 * One chat message. Customer content is UNTRUSTED: it is rendered strictly as
 * React text (never HTML), file names included. Unknown types render a safe placeholder.
 */
export function MessageBubble({ message, pending, mediaUrl }: { message: Message; pending?: boolean; mediaUrl?: (attachmentId: string) => Promise<string | null> }) {
  const out = message.direction === 'OUTBOUND';
  const status = pending ? 'QUEUED' : message.status;
  return (
    <div className={cx('flex', out ? 'justify-end' : 'justify-start')}>
      <div className={cx('max-w-[80%] rounded-lg px-3 py-2 text-sm shadow-sm', out ? 'bg-emerald-50 ring-1 ring-emerald-100' : 'bg-white ring-1 ring-slate-200')}>
        {out && message.origin === 'LINKED_DEVICE' && <p className="mb-1 text-[11px] font-medium text-slate-500">{t("Sent from phone")}</p>}
        {out && message.origin === 'AI' && <p className="mb-1 text-[11px] font-medium text-violet-700">{t("AI Assistant")}</p>}
        <MessageBody message={message} mediaUrl={mediaUrl} />
        <p className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-slate-500">
          <time dateTime={message.timestamp}>{clock(message.timestamp)}</time>
          {out && (
            <span className={cx(status === 'READ' && 'text-sky-600', status === 'FAILED' && 'text-red-700')}>
              <span aria-hidden>{STATUS_ICON[status] ?? ''}</span> {pending ? t("Sending…") : t(MESSAGE_STATUS_TEXT[status] ?? status)}
            </span>
          )}
        </p>
        {status === 'FAILED' && <p className="mt-1 text-xs text-red-700">{t("Not delivered")}{message.errorCode === 'WHATSAPP_INSTANCE_NOT_CONNECTED' ? t(" — WhatsApp was disconnected.") : '.'}</p>}
      </div>
    </div>
  );
}

function MessageBody({ message, mediaUrl }: { message: Message; mediaUrl?: (id: string) => Promise<string | null> }) {
  const att = message.attachments[0];
  if (message.status === 'REVOKED') return <p className="italic text-slate-500">{t("This message was deleted.")}</p>;
  switch (message.type) {
    case 'TEXT':
      return <p className="whitespace-pre-wrap break-words text-slate-900">{message.text}</p>;
    case 'IMAGE':
    case 'STICKER':
      return (
        <div>
          {att ? <SecureImage attachmentId={att.id} status={att.status} mediaUrl={mediaUrl} /> : <Placeholder>{t("Image")}</Placeholder>}
          {message.text && <p className="mt-1 whitespace-pre-wrap break-words">{message.text}</p>}
        </div>
      );
    case 'DOCUMENT':
    case 'AUDIO':
    case 'VOICE':
    case 'VIDEO':
      return (
        <div>
          <DocumentChip att={att} kind={message.type} mediaUrl={mediaUrl} />
          {message.text && <p className="mt-1 whitespace-pre-wrap break-words">{message.text}</p>}
        </div>
      );
    case 'LOCATION':
      return <Placeholder>{t("📍 Location")}{message.text ? `: ${message.text}` : ''}</Placeholder>;
    case 'CONTACT':
      return <Placeholder>{t("👤 Contact card")}{message.text ? `: ${message.text}` : ''}</Placeholder>;
    case 'REACTION':
      return <Placeholder>{t("Reacted")}{' '}{message.text ?? t("(removed)")}{message.replyTo?.preview ? t(' to “{text}”', { text: message.replyTo.preview }) : ''}</Placeholder>;
    case 'POLL':
      return <Placeholder>{t("📊 Poll:")}{' '}{message.text}</Placeholder>;
    default:
      return <Placeholder>{t("Unsupported WhatsApp message")}</Placeholder>;
  }
}

function Placeholder({ children }: { children: ReactNode }) {
  return <p className="text-slate-600">{children}</p>;
}

/** Fetches a short-lived signed URL only when rendered; lazy-loaded; never base64 in the API. */
function SecureImage({ attachmentId, status, mediaUrl }: { attachmentId: string; status: string; mediaUrl?: (id: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (status !== 'STORED' || !mediaUrl) return;
    let alive = true;
    mediaUrl(attachmentId).then((u) => { if (alive) setSrc(u); }).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [attachmentId, status, mediaUrl]);
  if (status === 'PENDING') return <Placeholder>{t("Image (downloading…)")}</Placeholder>;
  if (status !== 'STORED' || failed) return <Placeholder>{t("Image unavailable")}</Placeholder>;
  if (!src) return <Skeleton className="h-40 w-56" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={t("Image sent in WhatsApp")} loading="lazy" className="max-h-72 max-w-full rounded" />;
}

function DocumentChip({ att, kind, mediaUrl }: { att?: Message['attachments'][number]; kind: string; mediaUrl?: (id: string) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const fileKind = t('{kind} file', { kind: t(kind.charAt(0) + kind.slice(1).toLowerCase()) });
  if (!att) return <Placeholder>{fileKind}</Placeholder>;
  const name = att.fileName ?? fileKind;
  const download = async () => {
    if (!mediaUrl) return;
    setBusy(true);
    try {
      const u = await mediaUrl(att.id);
      if (u) window.open(u, '_blank', 'noopener,noreferrer');
    } finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-3 rounded-md bg-white/60 p-2 ring-1 ring-slate-200">
      <span aria-hidden className="text-lg">📄</span>
      <div className="min-w-0">
        <p className="truncate font-medium text-slate-900" title={name}>{name}</p>
        <p className="text-xs text-slate-500">{att.mimeType}{att.fileSize ? ` · ${bytes(att.fileSize)}` : ''}</p>
      </div>
      {att.status === 'STORED'
        ? <Button variant="secondary" size="sm" onClick={download} loading={busy} aria-label={t('Download {name}', { name })}>{t("Download")}</Button>
        : <span className="text-xs text-slate-500">{att.status === 'PENDING' ? t("Downloading…") : t("Unavailable")}</span>}
    </div>
  );
}
