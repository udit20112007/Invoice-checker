// Reads invoice fields out of the text of an invoice (from a PDF's text layer, OCR, or pasted text).
// Works line by line with labels Indian invoices use; anything it can't find is listed in `missing`,
// so the person can type it in on the review screen.
import { cleanGstin, gstinCheckChar } from "./gst.ts";
import { amount, date, round2 } from "./parse.ts";
import { emptyInvoice, type Invoice, type Item } from "./types.ts";
import { repairVehicle } from "./vehicle.ts";

const AMOUNT = /\(?-?\s*(?:₹|Rs\.?|INR)?\s*\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?\)?|\(?-?\s*(?:₹|Rs\.?|INR)?\s*\d+\.\d{1,2}\)?/gi;
const lastAmount = (line: string) => {
  const all = [...line.matchAll(AMOUNT)].map((m) => amount(m[0].replace(/\s/g, ""))).filter((n) => Number.isFinite(n));
  return all.length ? all[all.length - 1] : NaN;
};
const rateIn = (line: string) => { const m = line.match(/(\d{1,2}(?:\.\d{1,2})?)\s*%/); return m ? Number(m[1]) : null; };

// OCR often reads 0 as O, 1 as I, 5 as S, 8 as B. A GSTIN has digits and letters in fixed places, so a
// near-GSTIN can be repaired; the repair is kept only if the check character then agrees.
const DIGIT_AT = [0, 1, 7, 8, 9, 10], LETTER_AT = [2, 3, 4, 5, 6, 11];
const toDigit: Record<string, string> = { O: "0", D: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6" };
const toLetter: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G" };
function repairGstin(raw: string): string {
  const g = raw.split("");
  for (const i of DIGIT_AT) if (toDigit[g[i]]) g[i] = toDigit[g[i]];
  for (const i of LETTER_AT) if (toLetter[g[i]]) g[i] = toLetter[g[i]];
  if (g[13] === "2") g[13] = "Z";
  // the 13th character (entity number) may be a digit or a letter, so try both readings
  const options = [g[12], toDigit[g[12]], toLetter[g[12]]].filter(Boolean) as string[];
  for (const e of options) {
    const fixed = [...g.slice(0, 12), e, ...g.slice(13)].join("");
    if (/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(fixed) && gstinCheckChar(fixed.slice(0, 14)) === fixed[14]) return fixed;
  }
  return raw;
}

const BUYER = /bill(ed)?\s*to|buyer|recipient|ship(ped)?\s*to|consignee|customer|receiver|sold\s*to|party/i;
const SELLER = /seller|supplier|sold\s*by|from|billed\s*by|details\s*of\s*supplier/i;

export function splitLines(text: string) {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function extractFields(text: string, base: Invoice = emptyInvoice("x", "", "manual")): Invoice {
  const lines = splitLines(text);
  const inv: Invoice = { ...base, text, items: [], missing: [] };

  // ---- GSTINs: supplier and buyer, told apart by the labels near them
  const found: { g: string; line: number }[] = [];
  lines.forEach((l, i) => {
    for (const m of l.toUpperCase().matchAll(/(?<![0-9A-Z])[0-9A-Z]{2}[0-9A-Z]{5}[0-9A-Z]{4}[0-9A-Z]{2}[Z2][0-9A-Z](?![0-9A-Z])/g)) {
      const g = repairGstin(m[0]);
      if (/^\d{2}/.test(g) && !found.some((f) => f.g === g)) found.push({ g, line: i });
    }
  });
  const roleOf = (line: number) => {
    for (let k = line; k >= Math.max(0, line - 4); k--) {
      const l = lines[k].replace(/GSTIN|GST\s*NO\.?/gi, "");
      if (BUYER.test(l)) return "buyer";
      if (SELLER.test(l)) return "seller";
    }
    return null;
  };
  for (const f of found) {
    const role = roleOf(f.line);
    if (role === "buyer" && !inv.buyerGstin) inv.buyerGstin = f.g;
    else if (role === "seller" && !inv.supplierGstin) inv.supplierGstin = f.g;
  }
  for (const f of found) {
    if (f.g === inv.supplierGstin || f.g === inv.buyerGstin) continue;
    if (!inv.supplierGstin) inv.supplierGstin = f.g; else if (!inv.buyerGstin) inv.buyerGstin = f.g;
  }

  // ---- names: the supplier is usually the first line; the buyer follows the "Bill to" label
  const skip = /^(tax\s*invoice|invoice|credit\s*note|debit\s*note|original|duplicate|triplicate|bill\s*of\s*supply|e-?invoice|page\s*\d)/i;
  inv.supplierName = lines.find((l) => !skip.test(l) && /[a-z]{3}/i.test(l) && !/gstin|irn|ack/i.test(l))?.replace(/\s*(tax\s*invoice|credit\s*note|debit\s*note)\s*$/i, "") ?? "";
  const top = lines.slice(0, 8).join(" ");
  inv.docType = /credit\s*note/i.test(top) ? "credit" : /debit\s*note/i.test(top) ? "debit" : "invoice";
  const bi = lines.findIndex((l) => BUYER.test(l) && !/gstin/i.test(l));
  if (bi >= 0) {
    const same = lines[bi].replace(/.*?(bill(ed)?\s*to|buyer|recipient|ship(ped)?\s*to|consignee|customer|sold\s*to)\s*(\(.*?\))?\s*[:\-]?\s*/i, "").trim();
    inv.buyerName = same && /[a-z]{3}/i.test(same) ? same : (lines[bi + 1] && !/gstin/i.test(lines[bi + 1]) ? lines[bi + 1] : "");
  }

  // ---- invoice number, date, place of supply, reverse charge, IRN
  for (const l of lines) {
    // a credit or debit note names the invoice it's against
    const ref = l.match(/(?:against|original|ref(?:erence)?\.?)\s*(?:invoice|inv|bill)\s*(?:no|number|num|#)?\.?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\/\-_.]*)/i);
    if (ref) { if (!inv.refNumber && /\d/.test(ref[1])) inv.refNumber = ref[1].replace(/[.,]$/, ""); continue; }
    if (!inv.number) {
      const m = l.match(/(?:invoice|inv|bill|credit\s*note|debit\s*note|note)\s*(?:no|number|num|#)\.?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\/\-_.]*)/i);
      if (m && !/^date$/i.test(m[1])) inv.number = m[1].replace(/[.,]$/, "");
    }
    if (!inv.date && /date/i.test(l) && !/due|ack|irn|order|challan|po\b|delivery|supply|e[\s-]*way|valid/i.test(l)) {
      const d = date(l.replace(/.*?date\s*(of\s*(issue|invoice))?\s*[:\-]?\s*/i, ""));
      if (d) inv.date = d;
    }
    if (!inv.placeOfSupply) { const m = l.match(/place\s*of\s*supply\s*[:\-]?\s*(.+)/i); if (m) inv.placeOfSupply = m[1].trim(); }
    if (inv.reverseCharge === null) {
      const m = l.match(/reverse\s*charge[^:]*?[:\-]?\s*(yes|no|y|n)\b/i);
      if (m) inv.reverseCharge = /^y/i.test(m[1]);
    }
    if (!inv.irn) { const m = l.match(/IRN\s*(?:no\.?)?\s*[:\-]?\s*([0-9a-f]{64})/i); if (m) inv.irn = m[1].toLowerCase(); }
    if (!inv.ewayBill) { const m = l.match(/e[\s-]*way\s*bill\s*(?:no|number|#)?\.?\s*[:\-]?\s*(\d[\d ]{8,16}\d)/i); if (m) inv.ewayBill = m[1].replace(/\s/g, ""); }
    if (!inv.ewbDate) { const m = l.match(/e[\s-]*way\s*bill\s*(?:date|dt)\.?\s*[:\-]?\s*(.+)/i); if (m) inv.ewbDate = date(m[1]); }
    if (!inv.ewbValidUntil) { const m = l.match(/valid\s*(?:up\s*to|upto|until|till)\s*[:\-]?\s*(.+)/i); if (m) inv.ewbValidUntil = date(m[1]); }
    if (inv.distanceKm === null) { const m = l.match(/distance\s*(?:\(\s*kms?\s*\))?\s*[:\-]?\s*(\d{1,4})\s*(?:kms?\b)?/i); if (m) inv.distanceKm = Number(m[1]); }
    if (!inv.bank) { const m = l.match(/(?:a\/c|acc(?:oun)?t)\.?\s*(?:no|number|#)?\.?\s*[:\-]?\s*(\d[\d ]{7,20}\d)/i); if (m) inv.bank = m[1].replace(/\s/g, ""); }
    if (!inv.phone) { const m = l.match(/(?:ph|phone|mob|mobile|tel|contact)\.?\s*(?:no\.?)?\s*[:\-]?\s*(\+?\d[\d -]{8,14}\d)/i); if (m) inv.phone = m[1].replace(/\D/g, "").slice(-10); }
    if (!inv.email) { const m = l.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/); if (m) inv.email = m[0].toLowerCase(); }
    if (!inv.vehicle) {
      const m = l.match(/(?:vehicle|veh|truck|lorry|motor\s*vehicle)\s*(?:reg(?:istration|n)?\.?\s*)?(?:no|number|#)?\.?\s*[:\-]\s*(.+)/i);
      if (m) {
        const v = m[1].split(/\s{2,}|e[\s-]*way|transport|\bdate\b|\bL\.?R\b|\bG\.?R\b|driver|mode/i)[0].trim().match(/^[A-Z0-9][A-Z0-9 -]{3,15}[A-Z0-9]/i)?.[0];
        if (v) inv.vehicle = repairVehicle(v);
      }
    }
  }
  if (!inv.date) { const d = lines.map((l) => date(l)).find(Boolean); if (d) inv.date = d; }

  // ---- items: the rows between the column headings (with "HSN") and the totals
  const head = lines.findIndex((l) => /hsn|sac/i.test(l) && /(desc|item|particular|goods|service)/i.test(l));
  const totalsAt = (i: number) => /^(sub\s*total|total|taxable|cgst|sgst|utgst|igst|cess|round|grand|amount\s*in\s*words|tax\s*amount)/i.test(lines[i]);
  if (head >= 0) {
    for (let i = head + 1; i < lines.length && !totalsAt(i); i++) {
      const l = lines[i];
      const amounts = [...l.matchAll(AMOUNT)];
      if (!amounts.length) continue;
      const rest = l.replace(/^\d{1,3}[.)]?\s+/, "");                // the row number
      const tokens = rest.split(" ");
      // the HSN is a 4, 6 or 8-digit code followed by the quantity or an amount ("Fan 1200 mm 8414 70 …")
      const isNum = (t?: string) => !!t && /^[\d,]+(\.\d+)?$/.test(t);
      const hi = tokens.findIndex((t, k) => k > 0 && /^\d{4}(\d{2}){0,2}$/.test(t) && isNum(tokens[k + 1]));
      const desc = (hi > 0 ? tokens.slice(0, hi) : tokens.filter((t) => /[a-z]/i.test(t) && !/%/.test(t))).join(" ").trim();
      const after = hi > 0 ? tokens.slice(hi + 1) : tokens;
      const qty = after.find((t) => /^\d+(\.\d+)?$/.test(t) && !/\.\d{2}$/.test(t));
      const item: Item = { description: desc, hsn: hi > 0 ? tokens[hi] : "", qty: qty ? Number(qty) : null, taxable: lastAmount(l.replace(/\d{1,2}(\.\d+)?\s*%.*$/, "")), rate: rateIn(l) };
      if (Number.isFinite(item.taxable)) inv.items.push(item);
    }
  }

  // ---- totals and taxes: the label starts the line, the amount is the last number on it
  const pick = (re: RegExp, after = 0, not?: RegExp) => {
    let val = NaN, rate: number | null = null;
    lines.forEach((l, i) => { if (i >= after && re.test(l) && !(not && not.test(l))) { const a = lastAmount(l); if (Number.isFinite(a)) { val = a; rate = rateIn(l); } } });
    return { val, rate };
  };
  const end = head >= 0 ? head + 1 : 0;
  const taxable = pick(/^(total\s+)?taxable\s*(value|amount)?\b|^sub\s*total/i, end);
  const cgst = pick(/^(add\s*:?\s*)?(cgst|central\s*tax)\b/i, end);
  const sgst = pick(/^(add\s*:?\s*)?(sgst|utgst|state\s*tax|state\/ut\s*tax)\b/i, end);
  const igst = pick(/^(add\s*:?\s*)?(igst|integrated\s*tax)\b/i, end);
  const cess = pick(/^(add\s*:?\s*)?cess\b/i, end);
  const round = pick(/^round(ed)?\s*(off|-off)/i, end);
  const total = pick(/^(grand\s*total|invoice\s*total|total\s*invoice\s*(value|amount)|total\s*amount|amount\s*payable|net\s*payable|total)\b/i, end, /taxable|\b(c|s|i|ut)gst\b|tax\s*amount|in\s*words|qty|quantity/i);
  inv.taxable = Number.isFinite(taxable.val) ? taxable.val : inv.items.length ? round2(inv.items.reduce((a, it) => a + it.taxable, 0)) : NaN;
  inv.cgst = Number.isFinite(cgst.val) ? cgst.val : 0;
  inv.sgst = Number.isFinite(sgst.val) ? sgst.val : 0;
  inv.igst = Number.isFinite(igst.val) ? igst.val : 0;
  inv.cess = Number.isFinite(cess.val) ? cess.val : 0;
  inv.roundOff = Number.isFinite(round.val) ? round.val : 0;
  inv.total = total.val;
  // if items show no rate, use the rate printed beside the tax lines
  const headRate = igst.rate ?? (cgst.rate !== null && sgst.rate !== null ? cgst.rate + sgst.rate : cgst.rate !== null ? cgst.rate * 2 : null);
  for (const it of inv.items) if (it.rate === null && headRate !== null) it.rate = headRate;
  if (!inv.items.length && Number.isFinite(inv.taxable)) inv.items.push({ description: "(items not read)", hsn: "", qty: null, taxable: inv.taxable, rate: headRate });

  const need: [keyof Invoice, string][] = [["supplierGstin", "Supplier GSTIN"], ["number", "Invoice number"], ["date", "Invoice date"], ["taxable", "Taxable value"], ["total", "Invoice total"]];
  inv.missing = need.filter(([k]) => { const v = inv[k]; return v === "" || v === null || (typeof v === "number" && !Number.isFinite(v)); }).map(([, label]) => label);
  if (!cleanGstin(inv.buyerGstin)) inv.missing.push("Buyer GSTIN");
  return inv;
}
