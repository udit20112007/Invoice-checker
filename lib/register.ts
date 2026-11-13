// Importing a purchase register (Tally, Busy, Zoho or a home-made sheet, as Excel or CSV): each row
// becomes an invoice to check and reconcile, without needing the invoice file itself.
import { cleanGstin } from "./gst.ts";
import { amount, date, round2 } from "./parse.ts";
import { mapColumns, type SheetRows } from "./sheets.ts";
import { emptyInvoice, type Invoice } from "./types.ts";

type F = "number" | "voucher" | "date" | "name" | "gstin" | "taxable" | "igst" | "cgst" | "sgst" | "cess" | "total" | "vehicle";
const PATTERNS: [F, RegExp, RegExp?][] = [
  ["gstin", /gstin|gst\s*no|gst\s*number/],
  ["number", /supplier'?s?\s*(invoice|inv|bill)|(invoice|inv|bill|ref)\.?\s*(no|number|#)|^invoice$/, /date|value|type/],
  ["voucher", /v(ou)?ch(er)?\.?\s*(no|number)/],
  ["date", /^(invoice\s*|bill\s*|voucher\s*)?date$|invoice date|bill date/],
  ["taxable", /taxable|assessable|value before tax|net value/],
  ["igst", /igst|integrated/],
  ["cgst", /cgst|central/],
  ["sgst", /sgst|utgst|state/],
  ["cess", /cess/],
  ["total", /gross\s*total|invoice\s*(total|value|amount)|^total|grand\s*total|^amount$/],
  ["vehicle", /vehicle/],
  ["name", /particulars|party|supplier|vendor|ledger|^name/, /gstin|gst|no\b|number|date/],
];

export function parseRegister(sheets: SheetRows[]): Invoice[] {
  for (const s of sheets) {
    const { headAt, col } = mapColumns(s.rows, PATTERNS);
    if (headAt < 0 || col.gstin === undefined || (col.number === undefined && col.voucher === undefined) || (col.taxable === undefined && col.total === undefined)) continue;
    const get = (r: string[], f: F) => (col[f] === undefined ? "" : String(r[col[f]!] ?? "").trim());
    const num = (r: string[], f: F) => { const n = amount(get(r, f)); return Number.isFinite(n) ? Math.abs(n) : 0; };
    const out: Invoice[] = [];
    s.rows.slice(headAt + 1).forEach((r, i) => {
      const no = get(r, "number") || get(r, "voucher");
      if (!no || /^(grand\s*)?total/i.test(r.join(" ").trim())) return;
      const inv = emptyInvoice(`reg-${i}`, `Register row ${headAt + i + 2}`, "register");
      inv.readBy = "manual";
      inv.supplierGstin = cleanGstin(get(r, "gstin"));
      inv.supplierName = get(r, "name");
      inv.number = no;
      inv.date = date(get(r, "date"));
      inv.igst = num(r, "igst"); inv.cgst = num(r, "cgst"); inv.sgst = num(r, "sgst"); inv.cess = num(r, "cess");
      const tax = inv.igst + inv.cgst + inv.sgst + inv.cess;
      inv.taxable = col.taxable !== undefined ? num(r, "taxable") : round2(num(r, "total") - tax);
      inv.total = col.total !== undefined ? num(r, "total") : round2(inv.taxable + tax);
      inv.vehicle = get(r, "vehicle").toUpperCase();
      inv.items = [{ description: "(from purchase register)", hsn: "", qty: null, taxable: inv.taxable, rate: inv.taxable ? round2((tax - inv.cess) / inv.taxable * 100) : null }];
      inv.text = r.join(" | ");
      if (inv.supplierGstin || inv.taxable) out.push(inv);
    });
    if (out.length) return out;
  }
  throw new Error("Couldn't find the purchase register's columns. It needs at least supplier GSTIN, invoice (or voucher) number and taxable value or total.");
}
