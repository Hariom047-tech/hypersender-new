/** Printable invoice document (HTML only; labels arrive already translated). Skipped by the i18n scanner. */
export interface InvoiceData {
  id: string; number: string | null; status: string; currency: string; organizationName: string; description: string;
  periodStart: string | null; periodEnd: string | null; issuedAt: string | null; dueAt: string | null; paidAt: string | null; subscriptionId: string | null;
  subtotalMinorUnits: number; discountMinorUnits: number; taxMinorUnits: number; totalMinorUnits: number; amountPaidMinorUnits: number;
  payments: Array<{ id: string; provider: string; reference: string; amountMinorUnits: number; currency: string; status: string; method: string | null; paidAt: string | null; createdAt: string }>;
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function invoiceHtml(inv: InvoiceData, o: { brand: string; L: Record<string, string>; money: (m: number, c: string) => string; date: (s: string | null) => string; status: string; method: (m: string | null) => string }): string {
  const { L } = o;
  const row = (k: string, v: string) => `<tr><td>${esc(k)}</td><td class="r">${esc(v)}</td></tr>`;
  const period = inv.periodStart ? `${o.date(inv.periodStart)} – ${o.date(inv.periodEnd)}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(L.invoice)} ${esc(inv.number ?? inv.id)}</title>
<style>
  *{box-sizing:border-box} body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;margin:0;padding:32px;background:#fff}
  .wrap{max-width:760px;margin:0 auto} h1{font-size:28px;margin:0} .muted{color:#64748b;font-size:13px}
  .top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:2px solid #047857;padding-bottom:16px}
  .brand{font-size:22px;font-weight:700;color:#047857} .badge{display:inline-block;padding:2px 10px;border-radius:999px;background:#ecfdf5;color:#065f46;font-size:12px;font-weight:600}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:24px 0} table{width:100%;border-collapse:collapse;font-size:14px}
  th{text-align:left;background:#f8fafc;padding:10px;border-bottom:1px solid #e2e8f0} td{padding:10px;border-bottom:1px solid #f1f5f9} .r{text-align:right}
  .totals{margin-left:auto;width:320px;margin-top:16px} .totals tr:last-child td{font-weight:700;font-size:16px;border-top:2px solid #0f172a}
  .actions{margin:24px 0;text-align:center} button{background:#047857;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:14px;cursor:pointer}
  @media print{.actions{display:none} body{padding:0}}
</style></head><body><div class="wrap">
<div class="actions"><button onclick="window.print()">${esc(L.print)}</button></div>
<div class="top"><div><div class="brand">${esc(o.brand)}</div><div class="muted">${esc(L.taxInvoice)}</div></div>
<div style="text-align:right"><h1>${esc(L.invoice)}</h1><div class="muted">#${esc(inv.number ?? inv.id)}</div><div style="margin-top:6px"><span class="badge">${esc(o.status)}</span></div></div></div>
<div class="grid"><div><div class="muted">${esc(L.billedTo)}</div><strong>${esc(inv.organizationName)}</strong></div>
<div style="text-align:right"><div class="muted">${esc(L.issued)}: ${esc(o.date(inv.issuedAt))}</div>${inv.dueAt ? `<div class="muted">${esc(L.due)}: ${esc(o.date(inv.dueAt))}</div>` : ''}
${inv.paidAt ? `<div class="muted">${esc(L.paid)}: ${esc(o.date(inv.paidAt))}</div>` : ''}</div></div>
<table><thead><tr><th>${esc(L.description)}</th><th>${esc(L.period)}</th><th class="r">${esc(L.amount)}</th></tr></thead>
<tbody><tr><td>${esc(inv.description)}${inv.subscriptionId ? `<div class="muted">${esc(L.subscription)}: ${esc(inv.subscriptionId)}</div>` : ''}</td><td>${esc(period)}</td>
<td class="r">${esc(o.money(inv.subtotalMinorUnits, inv.currency))}</td></tr></tbody></table>
<table class="totals"><tbody>${row(L.subtotal, o.money(inv.subtotalMinorUnits, inv.currency))}
${inv.discountMinorUnits ? row(L.discount, `− ${o.money(inv.discountMinorUnits, inv.currency)}`) : ''}${row(L.tax, o.money(inv.taxMinorUnits, inv.currency))}
${row(L.amountPaid, o.money(inv.amountPaidMinorUnits, inv.currency))}${row(L.total, o.money(inv.totalMinorUnits, inv.currency))}</tbody></table>
${inv.payments.length ? `<h3 style="margin-top:32px">${esc(L.payments)}</h3><table><thead><tr><th>${esc(L.date)}</th><th>${esc(L.method)}</th><th>${esc(L.reference)}</th><th>${esc(L.status)}</th><th class="r">${esc(L.amount)}</th></tr></thead><tbody>
${inv.payments.map((p) => `<tr><td>${esc(o.date(p.paidAt ?? p.createdAt))}</td><td>${esc(o.method(p.method))}</td><td>${esc(p.reference)}</td><td>${esc(p.status)}</td><td class="r">${esc(o.money(p.amountMinorUnits, p.currency))}</td></tr>`).join('')}
</tbody></table>` : ''}
<p class="muted" style="margin-top:40px;text-align:center">${esc(L.footer)}</p>
</div></body></html>`;
}
