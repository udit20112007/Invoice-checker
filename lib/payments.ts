// Payments to suppliers, for the 180-day rule: ITC must be paid back if the supplier isn't paid within
// 180 days of the invoice date (Section 16(2), second proviso, CGST Act).
import { cleanGstin } from "./gst.ts";
import { amount, compactNo, date, round2 } from "./parse.ts";
import { mapColumns, type SheetRows } from "./sheets.ts";
import type { Invoice } from "./types.ts";

export type Payment = { gstin: string; number: string; date: string | null; amount: number };
export type PaidInfo = { paid: number; lastDate: string | null };

export function parsePayments(sheets: SheetRows[]): Payment[] {
  for (const s of sheets) {
    const { headAt, col } = mapColumns(s.rows, [
      ["number", /invoice|bill|against|ref/, /date|amount/],
      ["gstin", /gstin|gst no/],
      ["date", /date|paid on|payment on/],
      ["amount", /amount|paid|payment/, /date/],
    ]);
    if (headAt < 0 || col.number === undefined || col.amount === undefined) continue;
    const out: Payment[] = [];
    for (const r of s.rows.slice(headAt + 1)) {
      const a = amount(r[col.amount]);
      if (!r[col.number] || !Number.isFinite(a)) continue;
      out.push({ gstin: col.gstin !== undefined ? cleanGstin(r[col.gstin]) : "", number: String(r[col.number]).trim(), date: col.date !== undefined ? date(r[col.date]) : null, amount: a });
    }
    if (out.length) return out;
  }
  throw new Error("Couldn't find payment rows. The file needs columns for the invoice number and the amount paid (and ideally the date and supplier GSTIN).");
}

export function paidFor(inv: Invoice, payments: Payment[]): PaidInfo {
  const mine = payments.filter((p) => compactNo(p.number) === compactNo(inv.number) && (!p.gstin || p.gstin === cleanGstin(inv.supplierGstin)));
  const lastDate = mine.map((p) => p.date).filter(Boolean).sort().at(-1) ?? null;
  return { paid: round2(mine.reduce((a, p) => a + p.amount, 0)), lastDate };
}

export const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
