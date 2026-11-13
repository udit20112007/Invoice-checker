// Reads a bank statement (Excel or CSV) and matches its payments to invoices, for the 180-day rule.
import { cleanGstin } from "./gst.ts";
import { amount, compactNo, date } from "./parse.ts";
import { mapColumns, type SheetRows } from "./sheets.ts";
import type { Payment } from "./payments.ts";
import type { Invoice } from "./types.ts";

export type BankEntry = { date: string | null; narration: string; paidOut: number };

export function parseBank(sheets: SheetRows[]): BankEntry[] {
  for (const s of sheets) {
    const { headAt, col } = mapColumns(s.rows, [
      ["date", /^(txn|tran(saction)?|value|posting)?\s*date/],
      ["narration", /narration|description|particulars|remarks|details/],
      ["debit", /withdrawal|debit|\bdr\b|paid out|money out/],
      ["amount", /^amount/],
      ["type", /^(dr\s*\/\s*cr|cr\s*\/\s*dr|type)$/],
    ]);
    if (headAt < 0 || col.narration === undefined || (col.debit === undefined && col.amount === undefined)) continue;
    const out: BankEntry[] = [];
    for (const r of s.rows.slice(headAt + 1)) {
      let paid = col.debit !== undefined ? amount(r[col.debit]) : NaN;
      if (col.debit === undefined && col.amount !== undefined) {
        const a = amount(r[col.amount]), type = col.type !== undefined ? String(r[col.type]) : "";
        paid = /^d/i.test(type) || (!type && a < 0) || /\bdr\b/i.test(String(r[col.amount])) ? Math.abs(a) : NaN;
      }
      if (Number.isFinite(paid) && paid > 0) out.push({ date: col.date !== undefined ? date(r[col.date]) : null, narration: String(r[col.narration] ?? ""), paidOut: paid });
    }
    if (out.length) return out;
  }
  throw new Error("Couldn't read this as a payments file or a bank statement. A payments file needs invoice number and amount columns; a bank statement needs date, narration and withdrawal columns.");
}

const nameWords = (s: string) => s.toUpperCase().split(/[^A-Z]+/).filter((w) => w.length >= 4 && !/^(PRIVATE|LIMITED|TRADERS|ENTERPRISES|AGENCIES|COMPANY|INDIA)$/.test(w));

/** Each payment out goes to the invoice whose number is in the narration, or whose total it equals (the supplier's name in the narration settles a tie). */
export function matchBank(entries: BankEntry[], invoices: Invoice[]): { payments: Payment[]; matched: number; unmatched: BankEntry[] } {
  const bills = invoices.filter((i) => i.docType !== "credit" && Number.isFinite(i.total) && i.total > 0);
  const payments: Payment[] = [], unmatched: BankEntry[] = [], settled = new Map<string, number>();
  for (const e of entries) {
    const text = compactNo(e.narration), words = e.narration.toUpperCase();
    const named = (i: Invoice) => nameWords(i.supplierName).some((w) => words.includes(w));
    const open = bills.filter((i) => (settled.get(i.id) ?? 0) < i.total - 1 && (!e.date || !i.date || e.date >= i.date));
    let hit = open.find((i) => compactNo(i.number).length >= 4 && text.includes(compactNo(i.number)));
    if (!hit) {
      const same = open.filter((i) => Math.abs(i.total - (settled.get(i.id) ?? 0) - e.paidOut) <= 1);
      hit = same.length === 1 ? same[0] : same.find(named);
    }
    if (!hit) { unmatched.push(e); continue; }
    settled.set(hit.id, (settled.get(hit.id) ?? 0) + e.paidOut);
    payments.push({ gstin: cleanGstin(hit.supplierGstin), number: hit.number, date: e.date, amount: e.paidOut });
  }
  return { payments, matched: payments.length, unmatched };
}
