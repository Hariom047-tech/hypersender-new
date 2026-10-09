/**
 * Reads the first sheet of an .xlsx file, or a .csv file, into rows of text.
 * Runs in the browser only (DOMParser + DecompressionStream); no dependency.
 * Old binary .xls files are not supported: save them as .xlsx or .csv first.
 */

export class SpreadsheetError extends Error {}

export async function readSpreadsheet(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) return parseCsv(await file.text());
  if (name.endsWith('.xlsx')) return readXlsx(new Uint8Array(await file.arrayBuffer()));
  throw new SpreadsheetError('Please choose an Excel (.xlsx) or CSV file. For an old .xls file, open it in Excel and save as .xlsx.');
}

// ------------------------------------------------------------------ CSV

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return clean(rows);
}

// ------------------------------------------------------------------ XLSX (zip of XML files)

async function readXlsx(buf: Uint8Array): Promise<string[][]> {
  const zip = unzipIndex(buf);
  const xml = async (path: string) => {
    const e = zip.get(path);
    return e ? new DOMParser().parseFromString(await inflate(buf, e), 'application/xml') : null;
  };
  const shared: string[] = [];
  const ss = await xml('xl/sharedStrings.xml');
  if (ss) for (const si of Array.from(ss.getElementsByTagName('si'))) shared.push(Array.from(si.getElementsByTagName('t')).map((t) => t.textContent ?? '').join(''));

  const sheet = await xml(await firstSheetPath(xml)) ?? await xml('xl/worksheets/sheet1.xml');
  if (!sheet) throw new SpreadsheetError('Could not find a sheet in this Excel file.');
  const rows: string[][] = [];
  for (const r of Array.from(sheet.getElementsByTagName('row'))) {
    const out: string[] = [];
    for (const c of Array.from(r.getElementsByTagName('c'))) {
      const col = colIndex(c.getAttribute('r'), out.length);
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let text = type === 's' ? shared[Number(v)] ?? ''
        : type === 'inlineStr' ? Array.from(c.getElementsByTagName('t')).map((t) => t.textContent ?? '').join('')
        : v;
      // Phone numbers saved as numbers can come back as "9.19812345678E+11".
      if ((!type || type === 'n') && /^[0-9.]+E\+\d+$/i.test(text)) text = BigInt(Math.round(Number(text))).toString();
      while (out.length < col) out.push('');
      out[col] = text;
    }
    rows.push(out);
  }
  return clean(rows);
}

async function firstSheetPath(xml: (p: string) => Promise<Document | null>): Promise<string> {
  const wb = await xml('xl/workbook.xml');
  const rid = wb?.getElementsByTagName('sheet')[0]?.getAttribute('r:id');
  const rels = await xml('xl/_rels/workbook.xml.rels');
  // i18n-ignore: XML attribute name
  const target = rid && rels ? Array.from(rels.getElementsByTagName('Relationship')).find((x) => x.getAttribute('Id') === rid)?.getAttribute('Target') : null;
  if (!target) return 'xl/worksheets/sheet1.xml';
  return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
}

function colIndex(ref: string | null, fallback: number): number {
  const m = ref ? /^([A-Z]+)/.exec(ref) : null;
  if (!m) return fallback;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

interface ZipEntry { method: number; size: number; offset: number }

function unzipIndex(buf: Uint8Array): Map<string, ZipEntry> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new SpreadsheetError('This file is not a valid Excel (.xlsx) file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, ZipEntry>();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(p + 28, true); const extraLen = dv.getUint16(p + 30, true); const commentLen = dv.getUint16(p + 32, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), offset: dv.getUint32(p + 42, true) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflate(buf: Uint8Array, e: ZipEntry): Promise<string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const data = buf.slice(start, start + e.size);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new SpreadsheetError('This Excel file uses an unsupported format. Please save it again as .xlsx or .csv.');
  const stream = new Response(data).body!.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/** Trims cells and drops fully empty rows. */
function clean(rows: string[][]): string[][] {
  return rows.map((r) => r.map((c) => (c ?? '').trim())).filter((r) => r.some(Boolean));
}

// ------------------------------------------------------------------ column guessing

const NAME_RE = /^(name|customer|customer name|full name|naam|नाम|ग्राहक)/i;
const PHONE_RE = /(phone|mobile|number|whatsapp|contact|mob|no\.?$|फ़ोन|फोन|मोबाइल|नंबर)/i;
const looksLikePhone = (v: string) => /^[+0-9()\-.\s]{8,20}$/.test(v) && v.replace(/\D/g, '').length >= 8;

/** Finds a header row and the name / phone columns. */
export function guessColumns(rows: string[][]): { hasHeader: boolean; nameCol: number; phoneCol: number } {
  const first = rows[0] ?? [];
  const hasHeader = first.some((c) => NAME_RE.test(c) || PHONE_RE.test(c)) && !first.some(looksLikePhone);
  const sample = rows.slice(hasHeader ? 1 : 0, 20);
  const width = Math.max(0, ...rows.slice(0, 20).map((r) => r.length));
  let phoneCol = hasHeader ? first.findIndex((c) => PHONE_RE.test(c)) : -1;
  if (phoneCol < 0) {
    let best = 0;
    for (let i = 0; i < width; i++) {
      const n = sample.filter((r) => looksLikePhone(r[i] ?? '')).length;
      if (n > best) { best = n; phoneCol = i; }
    }
  }
  let nameCol = hasHeader ? first.findIndex((c, i) => i !== phoneCol && NAME_RE.test(c)) : -1;
  if (nameCol < 0) nameCol = Array.from({ length: width }, (_, i) => i).find((i) => i !== phoneCol && sample.some((r) => /[a-zऀ-ॿ]/i.test(r[i] ?? ''))) ?? -1;
  return { hasHeader, nameCol, phoneCol: Math.max(phoneCol, 0) };
}
