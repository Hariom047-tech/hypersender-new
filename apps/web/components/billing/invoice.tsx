'use client';

import { api } from '@/lib/api';
import { BRAND } from '@/lib/brand';
import { dateTime, money } from '@/lib/format';
import { t } from '@/lib/i18n';
import { methodLabel, txStatusLabel } from './common';
import { invoiceHtml, type InvoiceData } from './invoice-html';

/**
 * Opens the invoice in a new tab, ready to print / "Save as PDF". The tab is opened before the fetch so the
 * browser treats it as part of the click (no popup blocker).
 */
export async function downloadInvoice(id: string): Promise<void> {
  const w = window.open('', '_blank');
  // i18n-ignore (HTML wrapper; the text is translated)
  if (w) w.document.write(`<p style="font-family:sans-serif;padding:24px">${t("Loading invoice…")}</p>`);
  try {
    const inv = await api<InvoiceData>(`/v1/billing/invoices/${id}`);
    const html = invoiceHtml(inv, {
      brand: BRAND, money, date: dateTime, status: txStatusLabel(inv.status), method: methodLabel,
      L: {
        invoice: t("Invoice"), taxInvoice: t("Tax invoice"), print: t("Print / Save as PDF"), billedTo: t("Billed to"), issued: t("Issued"), due: t("Due"),
        paid: t("Paid"), description: t("Description"), period: t("Period"), amount: t("Amount"), subscription: t("Subscription"), subtotal: t("Subtotal"),
        discount: t("Discount"), tax: t("Tax"), amountPaid: t("Amount paid"), total: t("Total"), payments: t("Payments"), date: t("Date"), method: t("Payment Method"),
        reference: t("Reference"), status: t("Status"), footer: t("Thank you for your business. This invoice was generated electronically."),
      },
    });
    if (!w) throw new Error(t("Allow pop-ups for this site to download invoices."));
    w.document.open(); w.document.write(html); w.document.close();
  } catch (err) {
    w?.close();
    throw err;
  }
}
