'use client';

import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, friendlyMessage } from '@/lib/api';
import { INSTANCE_STATUS_TEXT } from '@/lib/format';
import { openEventStream, type SseHandle } from '@/lib/sse';
import type { InstanceStatus as Status } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { Button, Field, Input, InstanceStatus, Notice } from '../ui';
import { t } from '@/lib/i18n';

/**
 * QR / pairing-code linking.
 *
 * SECURITY: a WhatsApp QR (and pairing code) is authentication material.
 *  - rendered LOCALLY (qrcode -> data: URL); never sent to any third party;
 *  - lives only in React state of this component: never in URL, local/session
 *    storage, analytics or logs;
 *  - cleared on CONNECTED / LOGGED_OUT / any non-QR status, on expiry, when a
 *    newer QR replaces it, and when the component unmounts (leaving the page).
 */
/** `compact`: narrow, centred layout for the side column of the instance page. */
export function ConnectionPanel({ instanceId, status, canWrite, autoConnect, compact }: { instanceId: string; status: Status; canWrite: boolean; autoConnect?: boolean; compact?: boolean }) {
  const { orgId } = useWorkspace();
  const qc = useQueryClient();
  const [liveStatus, setLiveStatus] = useState<Status>(status);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [mode, setMode] = useState<'qr' | 'phone'>('qr');
  const stream = useRef<SseHandle | null>(null);
  const autoDone = useRef(false);

  useEffect(() => setLiveStatus(status), [status]);

  const clearSecrets = useCallback(() => { setQrImage(null); setExpiresAt(null); setPairingCode(null); }, []);

  /** Renders a QR string locally (never stored); a newer QR replaces the previous one. */
  const showQr = useCallback(async (qr: string, expires?: string) => {
    const expiry = expires ? Date.parse(expires) : Date.now() + 30_000;
    const url = await QRCode.toDataURL(qr, { margin: 1, width: 264, errorCorrectionLevel: 'M' });
    setQrImage(url);
    setExpiresAt(expiry);
  }, []);

  const watch = useCallback(() => {
    stream.current?.close();
    stream.current = openEventStream({
      url: `/api/v1/whatsapp/instances/${instanceId}/events`,
      headers: { 'x-organization-id': orgId },
      onEvent: (type, data) => {
        const d = data as { qr?: string; expiresAt?: string; status?: Status };
        if (type === 'whatsapp.instance.qr' && d.qr) {
          void showQr(d.qr, d.expiresAt);
          setLiveStatus('WAITING_FOR_QR');
        } else if (type === 'whatsapp.instance.status' && d.status) {
          setLiveStatus(d.status);
          if (d.status !== 'WAITING_FOR_QR') setQrImage(null);
          if (d.status === 'CONNECTED' || d.status === 'LOGGED_OUT' || d.status === 'ERROR' || d.status === 'DISCONNECTED') {
            setPairingCode(null);
            void qc.invalidateQueries({ queryKey: ['org', orgId] });
          }
        }
      },
    });
  }, [instanceId, orgId, qc, showQr]);

  // Leaving the page: close the stream and forget any QR / pairing code.
  useEffect(() => () => { stream.current?.close(); stream.current = null; }, []);

  // Watch while a link is in progress (e.g. page reopened during pairing).
  useEffect(() => {
    if ((status === 'WAITING_FOR_QR' || status === 'PAIRING' || status === 'RECONNECTING') && !stream.current) watch();
  }, [status, watch]);

  // Expiry countdown.
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  useEffect(() => { if (expiresAt && now >= expiresAt) { setQrImage(null); setExpiresAt(null); } }, [now, expiresAt]);

  const connect = useCallback(async () => {
    setBusy(true); setError(null); clearSecrets();
    try {
      watch(); // subscribe BEFORE requesting, so the first QR is not missed
      await api(`/v1/whatsapp/instances/${instanceId}/connect`, { method: 'POST' });
      setLiveStatus((s) => (s === 'CONNECTED' ? s : 'WAITING_FOR_QR'));
    } catch (err) {
      setError(friendlyMessage(err));
    } finally { setBusy(false); }
  }, [instanceId, watch, clearSecrets]);

  useEffect(() => {
    if (autoConnect && canWrite && !autoDone.current && ['CREATED', 'DISCONNECTED', 'LOGGED_OUT', 'ERROR'].includes(status)) {
      autoDone.current = true;
      void connect();
    }
  }, [autoConnect, canWrite, status, connect]);

  // Page opened (or reloaded) while a QR link is pending: show the current QR at once. If there is none - e.g. the
  // worker that was showing it restarted - request a fresh one instead of waiting forever.
  const resumeDone = useRef(false);
  useEffect(() => {
    if (resumeDone.current || status !== 'WAITING_FOR_QR') return;
    resumeDone.current = true;
    void api<{ qr: string; expiresAt: string }>(`/v1/whatsapp/instances/${instanceId}/qr`)
      .then((r) => showQr(r.qr, r.expiresAt))
      .catch(() => { if (canWrite) void connect(); });
  }, [status, instanceId, canWrite, connect, showQr]);

  // Safety net: no QR after 20 s of waiting -> offer a button to ask for a new one.
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setStale(false);
    if (liveStatus !== 'WAITING_FOR_QR' || qrImage || busy) return;
    const timer = setTimeout(() => setStale(true), 20_000);
    return () => clearTimeout(timer);
  }, [liveStatus, qrImage, busy]);

  const requestPairing = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const phone = String(new FormData(e.currentTarget).get('phone') ?? '');
    setBusy(true); setError(null); clearSecrets();
    try {
      watch();
      const r = await api<{ pairingCode: string }>(`/v1/whatsapp/instances/${instanceId}/pairing-code`, { method: 'POST', body: { phoneNumber: phone } });
      setPairingCode(r.pairingCode);
      setLiveStatus('PAIRING');
    } catch (err) {
      setError(friendlyMessage(err));
    } finally { setBusy(false); }
  };

  const seconds = expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;
  const connected = liveStatus === 'CONNECTED';
  const waiting = liveStatus === 'WAITING_FOR_QR' || liveStatus === 'PAIRING';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <InstanceStatus status={liveStatus} />
        {liveStatus === 'RECONNECTING' && <span className="text-sm text-slate-600">{t("Connection dropped — reconnecting automatically. No action needed.")}</span>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      {connected && <Notice tone="success">{t("WhatsApp is connected. Customer messages will appear in your Inbox.")}</Notice>}

      {!connected && canWrite && (
        <>
          <div className={compact ? 'flex justify-center gap-2' : 'flex gap-2'} role="group" aria-label={t("Linking method")}>
            <Button variant={mode === 'qr' ? 'primary' : 'secondary'} size="sm" onClick={() => { setMode('qr'); setPairingCode(null); }}>{t("Scan QR code")}</Button>
            <Button variant={mode === 'phone' ? 'primary' : 'secondary'} size="sm" onClick={() => { setMode('phone'); setQrImage(null); }}>{t("Use phone number")}</Button>
          </div>

          {mode === 'qr' && (
            <div className={compact ? 'flex flex-col items-center gap-4' : 'grid gap-6 md:grid-cols-[auto_1fr]'}>
              <div className="flex h-[280px] w-[280px] items-center justify-center rounded-lg bg-white ring-1 ring-slate-200">
                {qrImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrImage} alt={t("WhatsApp linking QR code. Scan it with WhatsApp on your phone.")} width={264} height={264} />
                ) : waiting ? (
                  <div className="flex flex-col items-center gap-3 px-6 text-center">
                    <p className="text-sm text-slate-600" role="status">{busy ? t("Connecting…") : stale ? t("The QR code did not arrive.") : t("Preparing a new QR code…")}</p>
                    {stale && canWrite && <Button size="sm" onClick={connect} loading={busy}>{t("Get a new QR code")}</Button>}
                  </div>
                ) : (
                  <Button onClick={connect} loading={busy}>{t("Connect WhatsApp")}</Button>
                )}
              </div>
              <div className="text-sm text-slate-700">
                <p className="font-medium text-slate-900">{t("To link your WhatsApp:")}</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  <li>{t("Open")}{' '}<strong>{t("WhatsApp")}</strong> {t("on your business phone.")}</li>
                  <li>{t("Tap")}{' '}<strong>{t("Settings")}</strong> {t("(iPhone) or the")}{' '}<strong>{t("⋮ Menu")}</strong> {t("(Android).")}</li>
                  <li>{t("Tap")}{' '}<strong>{t("Linked devices")}</strong>.</li>
                  <li>{t("Tap")}{' '}<strong>{t("Link a device")}</strong>.</li>
                  <li>{t("Point your phone at the QR code on this screen.")}</li>
                </ol>
                {seconds !== null && qrImage && <p className="mt-3 text-slate-500" aria-live="polite">{t("This code refreshes in")}{' '}{seconds}{t("s. A new one will appear automatically.")}</p>}
                {!waiting && !qrImage && <p className="mt-3 text-slate-500">{t("Status:")}{' '}{INSTANCE_STATUS_TEXT[liveStatus] ?? liveStatus}</p>}
              </div>
            </div>
          )}

          {mode === 'phone' && (
            <div className="max-w-md space-y-3">
              {!pairingCode ? (
                <form onSubmit={requestPairing} className="space-y-3">
                  <Field label={t("WhatsApp phone number")} hint={t("The number of the phone you will link, with country code.")}>
                    {(id, d) => <Input id={id} aria-describedby={d} name="phone" type="tel" required placeholder="+91 98123 45678" autoComplete="off" />}
                  </Field>
                  <Button type="submit" loading={busy}>{t("Get pairing code")}</Button>
                </form>
              ) : (
                <div>
                  <p className="text-sm text-slate-700">{t("Enter this code on your phone:")}</p>
                  <p className="mt-2 font-mono text-3xl font-semibold tracking-[0.3em] text-slate-900" aria-label={t('Pairing code {code}', { code: pairingCode.split('').join(' ') })}>{pairingCode}</p>
                  <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-700">
                    <li>{t("Open WhatsApp →")}{' '}<strong>{t("Linked devices")}</strong> → <strong>{t("Link a device")}</strong>.</li>
                    <li>{t("Tap")}{' '}<strong>{t("Link with phone number instead")}</strong>.</li>
                    <li>{t("Type the code above.")}</li>
                  </ol>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {!connected && !canWrite && <Notice>{t("Ask an owner, admin or manager to connect this WhatsApp.")}</Notice>}
    </div>
  );
}
