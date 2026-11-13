// The checks run on every invoice. Each finding says what's wrong in plain words and which rule it comes from.
// red = ITC at risk or the invoice may be fake · amber = fix or confirm · info = good to know
import { checkGstin, cleanGstin, GST2_DATE, itcDeadline, RATES_BEFORE, RATES_NOW, stateCode, STATES } from "./gst.ts";
import { compactNo, round2, rupees, showDate } from "./parse.ts";
import { taxOf, type Finding, type Invoice, type Level } from "./types.ts";

export type Context = { ourGstin?: string; all?: Invoice[]; today?: string; tolerance?: number };

const RULE46 = "CGST Rule 46 (what a tax invoice must show)";
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;
const fin = (n: number) => Number.isFinite(n);

export function checkInvoice(inv: Invoice, ctx: Context = {}): Finding[] {
  const out: Finding[] = [];
  const add = (level: Level, code: string, title: string, detail: string, rule?: string) => out.push({ level, code, title, detail, rule });
  const tol = ctx.tolerance ?? 1;
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const sup = cleanGstin(inv.supplierGstin), buy = cleanGstin(inv.buyerGstin), ours = cleanGstin(ctx.ourGstin);

  // ---------------------------------------------------------------- who
  const s = checkGstin(sup);
  if (!s.ok) add("red", "supplier-gstin", sup ? "Supplier GSTIN isn't valid" : "No supplier GSTIN",
    sup ? `${sup} ${s.reason}. ITC can't be claimed on an invoice from an invalid GSTIN, and it may be a fake invoice.` : "Without the supplier's GSTIN the invoice won't appear in GSTR-2B and ITC can't be claimed.", RULE46);
  if (buy) {
    const b = checkGstin(buy);
    if (!b.ok) add("red", "buyer-gstin", "Your GSTIN on the invoice isn't valid", `${buy} ${b.reason}. Ask the supplier for a corrected invoice.`, RULE46);
    else if (ours && buy !== ours) add("red", "buyer-mismatch", "Invoice is addressed to a different GSTIN", `It shows ${buy}, but your GSTIN is ${ours}. ITC goes to the GSTIN on the invoice.`, "Section 16(2), CGST Act");
  } else add("amber", "buyer-missing", "Your GSTIN isn't on the invoice", "A B2B invoice must show the buyer's GSTIN, or the supplier reports it as a sale to an unregistered person and it won't reach your GSTR-2B.", RULE46);

  // ---------------------------------------------------------------- required details
  if (!inv.number) add("amber", "number-missing", "No invoice number found", "Type it in from the invoice.", RULE46);
  else if (inv.number.length > 16 || !/^[A-Za-z0-9\/-]+$/.test(inv.number))
    add("amber", "number-format", "Invoice number breaks the format rule", `“${inv.number}” must be at most 16 characters, using only letters, digits, - and /.`, RULE46);
  if (!inv.date) add("amber", "date-missing", "No invoice date found", "Type it in from the invoice.", RULE46);
  else {
    if (inv.date > today) add("red", "date-future", "Invoice is dated in the future", `${showDate(inv.date)} is after today. Check for a typing error or a back-dated document.`);
    const last = itcDeadline(inv.date);
    if (today > last) add("red", "itc-time", "Too late to claim ITC", `ITC on this invoice could be claimed only until ${showDate(last)}.`, "Section 16(4), CGST Act");
  }
  const noHsn = inv.items.filter((it) => !/^\d{4,8}$/.test(it.hsn));
  if (inv.items.length && noHsn.length) add("amber", "hsn", noHsn.length === inv.items.length ? "No HSN/SAC code" : `${noHsn.length} item${noHsn.length > 1 ? "s have" : " has"} no HSN/SAC code`,
    "Each item needs an HSN (goods) or SAC (services) code of at least 4 digits; 6 digits if the supplier's turnover is above ₹5 crore.", RULE46);
  if (inv.reverseCharge === null) add("info", "rcm-missing", "Reverse charge not stated", "The invoice should say whether tax is payable on reverse charge.", RULE46);
  else if (inv.reverseCharge) add("info", "rcm", "Reverse charge applies", "You pay this GST yourself in cash; ITC is available after you pay it.");

  // ---------------------------------------------------------------- right kind of tax
  const supState = /^\d{2}/.test(sup) ? sup.slice(0, 2) : null;
  const pos = stateCode(inv.placeOfSupply) ?? (/^\d{2}/.test(buy) ? buy.slice(0, 2) : null);
  const local = inv.cgst + inv.sgst, central = inv.igst;
  if (supState && pos) {
    const intra = supState === pos;
    if (intra && central > tol) add("red", "tax-type", "IGST charged on a same-state sale",
      `The supplier (${STATES[supState]}) and the place of supply (${STATES[pos]}) are in the same state, so the invoice should charge CGST + SGST, not IGST. IGST paid wrongly can't be used as ITC; the supplier must re-issue the invoice.`, "Sections 7–8, IGST Act");
    if (!intra && local > tol) add("red", "tax-type", "CGST + SGST charged on an inter-state sale",
      `The supplier is in ${STATES[supState]} and the place of supply is ${STATES[pos]}, so the invoice should charge IGST.`, "Section 7, IGST Act");
    if (!inv.placeOfSupply && !intra) add("amber", "pos-missing", "Place of supply not shown", "An inter-state invoice must show the place of supply with the state's name.", RULE46);
  }
  if (inv.cgst > 0 && inv.sgst > 0 && !near(inv.cgst, inv.sgst, tol)) add("red", "cgst-sgst", "CGST and SGST aren't equal", `CGST ${rupees(inv.cgst)} and SGST ${rupees(inv.sgst)} should be the same amount.`);

  // ---------------------------------------------------------------- maths
  const tax = taxOf(inv);
  if (fin(inv.taxable) && inv.items.length > 1) {
    const sum = round2(inv.items.reduce((a, it) => a + (fin(it.taxable) ? it.taxable : 0), 0));
    if (!near(sum, inv.taxable, tol)) add("red", "items-sum", "Items don't add up to the taxable value", `The items add up to ${rupees(sum)}, but the invoice says ${rupees(inv.taxable)}.`);
  }
  const rated = inv.items.filter((it) => it.rate !== null && fin(it.taxable));
  if (rated.length) {
    const expected = round2(rated.reduce((a, it) => a + (it.taxable * (it.rate ?? 0)) / 100, 0));
    const charged = round2(tax - inv.cess);
    if (rated.length === inv.items.length && !near(expected, charged, tol * Math.max(1, inv.items.length)))
      add("red", "tax-maths", "Tax doesn't match the rate", `At the rates shown, GST should be ${rupees(expected)}, but the invoice charges ${rupees(charged)} (a difference of ${rupees(Math.abs(charged - expected))}).`);
  }
  if (fin(inv.taxable) && fin(inv.total)) {
    const expected = round2(inv.taxable + tax + inv.roundOff);
    if (!near(expected, inv.total, Math.max(tol, 1)))
      add("red", "total", "Total doesn't add up", `Taxable value ${rupees(inv.taxable)} + GST ${rupees(tax)}${inv.roundOff ? ` + round-off ${rupees(inv.roundOff)}` : ""} = ${rupees(expected)}, but the invoice total is ${rupees(inv.total)}.`);
  }

  // ---------------------------------------------------------------- rates after GST 2.0
  const rates = [...new Set(inv.items.map((it) => it.rate).filter((r): r is number => r !== null))];
  for (const r of rates) {
    const after = inv.date ? inv.date >= GST2_DATE : true;
    if (after && (r === 12 || r === 28)) add("amber", "old-rate", `${r}% rate used after GST 2.0`,
      `The ${r}% slab was removed from 22 Sep 2025 (most goods moved to ${r === 12 ? "5%" : "18%"}). An invoice dated ${showDate(inv.date)} shouldn't use it; check the item's current rate.`, "GST rate notifications of 17 Sep 2025");
    else if (!(after ? RATES_NOW : RATES_BEFORE).includes(r)) add("amber", "odd-rate", `${r}% isn't a GST rate`, "Check the rate printed on the invoice.");
  }

  // ---------------------------------------------------------------- the e-invoice QR code
  const q = inv.qr;
  if (q?.kind === "einvoice") {
    const diffs: string[] = [];
    if (q.sellerGstin && sup && q.sellerGstin !== sup) diffs.push(`supplier GSTIN (QR ${q.sellerGstin}, printed ${sup})`);
    if (q.buyerGstin && buy && q.buyerGstin !== buy) diffs.push(`buyer GSTIN (QR ${q.buyerGstin}, printed ${buy})`);
    if (q.docNo && inv.number && compactNo(q.docNo) !== compactNo(inv.number)) diffs.push(`invoice number (QR ${q.docNo}, printed ${inv.number})`);
    if (q.docDate && inv.date && q.docDate !== inv.date) diffs.push(`date (QR ${showDate(q.docDate)}, printed ${showDate(inv.date)})`);
    if (fin(q.total) && fin(inv.total) && !near(q.total, inv.total, tol)) diffs.push(`total (QR ${rupees(q.total)}, printed ${rupees(inv.total)})`);
    if (q.irn && inv.irn && q.irn !== inv.irn) diffs.push("IRN");
    if (diffs.length) add("red", "qr-mismatch", "Printed invoice doesn't match its e-invoice QR code",
      `The QR code was signed when the invoice was registered, so the printed copy may have been edited. Differences: ${diffs.join("; ")}.`, "CGST Rule 48(4) (e-invoicing)");
  } else if (q?.kind === "upi" && q.amount !== null && fin(inv.total) && !near(q.amount, inv.total, tol)) {
    add("amber", "upi-amount", "Payment QR amount differs from the total", `The UPI QR asks for ${rupees(q.amount)}; the invoice total is ${rupees(inv.total)}.`);
  } else if (inv.irn) {
    add("amber", "qr-missing", "IRN printed but no e-invoice QR found", "An e-invoice must carry the signed QR code. Upload a clearer copy, or ask the supplier for it.", "CGST Rule 46(r)");
  }

  // ---------------------------------------------------------------- duplicates in this batch
  if (ctx.all && sup && inv.number) {
    const first = ctx.all.find((o) => o.id !== inv.id && cleanGstin(o.supplierGstin) === sup && compactNo(o.number) === compactNo(inv.number));
    if (first && ctx.all.indexOf(first) < ctx.all.indexOf(inv)) add("red", "duplicate", "Duplicate invoice", `Same supplier and invoice number as ${first.fileName}. Claiming ITC twice on one invoice is not allowed.`);
  }
  return out;
}

export type Verdict = "red" | "amber" | "green";
export const verdictOf = (f: Finding[]): Verdict => (f.some((x) => x.level === "red") ? "red" : f.some((x) => x.level === "amber") ? "amber" : "green");

// Problems that put the whole ITC on an invoice at risk, whatever GSTR-2B says
export const CRITICAL = new Set(["supplier-gstin", "buyer-gstin", "buyer-mismatch", "tax-type", "qr-mismatch", "duplicate", "itc-time", "date-future"]);
