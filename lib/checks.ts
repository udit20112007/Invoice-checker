// The checks run on every invoice. Each finding says what's wrong in plain words and which rule it comes from.
// red = ITC at risk or the invoice may be fake · amber = fix or confirm · info = good to know
import { checkGstin, cleanGstin, GST2_DATE, itcDeadline, RATES_BEFORE, RATES_NOW, stateCode, STATES } from "./gst.ts";
import { compactNo, round2, rupees, showDate } from "./parse.ts";
import { taxOf, type Finding, type Invoice, type Level } from "./types.ts";
import { checkVehicle, cleanEwb, ewbValid } from "./vehicle.ts";
import { namesMatch, type GstinStatus } from "./gstinstatus.ts";
import { addDays, daysBetween, type PaidInfo } from "./payments.ts";
import { blockedCredit, hsnMismatch, hsnValid, reverseChargeLikely } from "./hsn.ts";
import { dueDate, lateFilings, periodName, periodOf } from "./gstinstatus.ts";

export type Context = { ourGstin?: string; all?: Invoice[]; today?: string; tolerance?: number; gstin?: Record<string, GstinStatus>; paid?: PaidInfo };

const RULE46 = "CGST Rule 46 (what a tax invoice must show)";
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;
const fin = (n: number) => Number.isFinite(n);

export function checkInvoice(inv: Invoice, ctx: Context = {}): Finding[] {
  const out: Finding[] = [];
  const add = (level: Level, code: string, title: string, detail: string, rule?: string, risk?: number) => out.push({ level, code, title, detail, rule, ...(risk !== undefined ? { risk } : {}) });
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
  } else if (inv.source !== "register") add("amber", "buyer-missing", "Your GSTIN isn't on the invoice", "A B2B invoice must show the buyer's GSTIN, or the supplier reports it as a sale to an unregistered person and it won't reach your GSTR-2B.", RULE46);

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
  if (inv.source !== "register" && inv.items.length && noHsn.length) add("amber", "hsn", noHsn.length === inv.items.length ? "No HSN/SAC code" : `${noHsn.length} item${noHsn.length > 1 ? "s have" : " has"} no HSN/SAC code`,
    "Each item needs an HSN (goods) or SAC (services) code of at least 4 digits; 6 digits if the supplier's turnover is above ₹5 crore.", RULE46);
  if (inv.reverseCharge === null && inv.source !== "register") add("info", "rcm-missing", "Reverse charge not stated", "The invoice should say whether tax is payable on reverse charge.", RULE46);
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
    const sig = q.signature;
    if (sig?.status === "invalid") add("red", "qr-forged", "The QR code's signature is fake",
      "The e-invoice QR isn't signed by the government's Invoice Registration Portal. Someone made this QR code, so the invoice was probably never registered.", "CGST Rule 48(4) (e-invoicing)");
    else if (sig?.status === "no-key") add("info", "qr-unsigned", "QR signature not checked", "The QR was read, but its digital signature couldn't be checked because no Invoice Registration Portal key is installed (see irp-keys.json).");
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

  // ---------------------------------------------------------------- transport: vehicle number and e-way bill
  if (inv.vehicle) {
    const v = checkVehicle(inv.vehicle);
    if (!v.ok) add("red", "vehicle", "Vehicle number isn't valid", `“${inv.vehicle}”: ${v.problems.join(" ")} A made-up vehicle number is a common sign of a bill without real goods.`, "Motor Vehicles Act registration format");
    else if (v.kind === "bh") add("amber", "vehicle-bh", "Goods carried by a BH-series (personal) vehicle", `${v.pretty}: ${v.notes[0]}`);
    else if (v.notes.length) add("info", "vehicle-note", `Vehicle ${v.pretty}`, v.notes.join(" "));
  }
  if (inv.ewayBill && !ewbValid(inv.ewayBill)) add("amber", "ewb-format", "E-way bill number isn't 12 digits", `“${inv.ewayBill}” has ${cleanEwb(inv.ewayBill).length} digits. Check it on the e-way bill portal.`, "CGST Rule 138");
  const goods = inv.items.some((it) => /^\d{4,8}$/.test(it.hsn) && !it.hsn.startsWith("99"));
  if (inv.ewbDate && inv.date && inv.ewbDate < inv.date) add("amber", "ewb-early", "E-way bill is dated before the invoice", `The e-way bill is dated ${showDate(inv.ewbDate)}, but the invoice is dated ${showDate(inv.date)}. An e-way bill is made from the invoice, so it can't come first.`, "CGST Rule 138");
  if (inv.distanceKm && inv.distanceKm > 0) {
    const days = Math.max(1, Math.ceil(inv.distanceKm / 200));
    const start = inv.ewbDate ?? inv.date;
    if (start && inv.ewbValidUntil && inv.ewbValidUntil > addDays(start, days)) add("amber", "ewb-validity", "E-way bill validity is longer than allowed", `For ${inv.distanceKm} km an e-way bill is valid for ${days} day${days > 1 ? "s" : ""} (1 day per 200 km), up to ${showDate(addDays(start, days))}; this one shows ${showDate(inv.ewbValidUntil)}.`, "CGST Rule 138(10)");
    else if (inv.ewayBill && start) add("info", "ewb-days", `E-way bill valid for ${days} day${days > 1 ? "s" : ""}`, `${inv.distanceKm} km at 1 day per 200 km: the goods should have moved by ${showDate(addDays(start, days))}.`, "CGST Rule 138(10)");
  }
  if (inv.source !== "register" && inv.docType === "invoice" && goods && fin(inv.total) && inv.total > 50000 && !inv.ewayBill)
    add("amber", "ewb-missing", "No e-way bill number on the invoice", `Goods worth ${rupees(inv.total)} moving by road need an e-way bill (above ₹50,000; some states use a higher limit within the state). Ask the supplier for its number.`, "CGST Rule 138");

  // ---------------------------------------------------------------- the supplier's registration (from a GST data service)
  const reg = ctx.gstin?.[sup];
  if (reg && s.ok) {
    const cancelled = /cancel/i.test(reg.status), suspended = /suspend/i.test(reg.status);
    if (cancelled && (!reg.cancelledOn || !inv.date || reg.cancelledOn <= inv.date))
      add("red", "gstin-cancelled", "Supplier's GSTIN was cancelled", `${sup} was cancelled${reg.cancelledOn ? ` on ${showDate(reg.cancelledOn)}` : ""}${inv.date ? `, before this invoice (${showDate(inv.date)})` : ""}. No ITC is available on an invoice from a cancelled registration.`, "Section 16(2), CGST Act");
    else if (cancelled) add("amber", "gstin-cancelled-later", "Supplier's GSTIN has since been cancelled", `Cancelled on ${showDate(reg.cancelledOn)}, after this invoice. Check the supplier filed its returns for this period.`);
    else if (suspended) add("red", "gstin-suspended", "Supplier's GSTIN is suspended", "A suspended registration can't issue tax invoices; ITC is at risk.", "CGST Rule 21A");
    if (reg.registeredOn && inv.date && reg.registeredOn > inv.date) add("red", "gstin-not-yet", "Invoice is dated before the supplier registered", `Registered on ${showDate(reg.registeredOn)}, but the invoice is dated ${showDate(inv.date)}.`);
    else if (reg.registeredOn && inv.date && daysBetween(reg.registeredOn, inv.date) < 90) add("amber", "gstin-new", "Supplier registered only recently", `Registered on ${showDate(reg.registeredOn)}, ${daysBetween(reg.registeredOn, inv.date)} days before this invoice. New registrations are common among fake-invoice firms; check the supplier.`);
    if (inv.supplierName && (reg.legalName || reg.tradeName) && !namesMatch(inv.supplierName, reg.legalName) && !namesMatch(inv.supplierName, reg.tradeName))
      add("amber", "gstin-name", "Supplier name doesn't match the GSTIN", `The invoice says “${inv.supplierName}”, but ${sup} is registered to “${reg.tradeName || reg.legalName}”. Someone may be using another firm's GSTIN.`);
  }

  // ---------------------------------------------------------------- 180 days to pay the supplier
  if (ctx.paid && inv.docType !== "credit" && inv.date && fin(inv.total) && inv.total > 0 && !inv.reverseCharge) {
    const due = addDays(inv.date, 180), unpaid = round2(inv.total - ctx.paid.paid);
    const tax = taxOf(inv);
    if (unpaid > tol) {
      if (today > due) add("red", "payment-180", "Not paid within 180 days: ITC must be paid back", `${rupees(unpaid)} of ${rupees(inv.total)} is still unpaid ${daysBetween(inv.date, today)} days after the invoice. Reverse the ITC on the unpaid part (with interest) in GSTR-3B; you can claim it again after paying.`, "Section 16(2), second proviso, CGST Act", round2(tax * unpaid / inv.total));
      else if (daysBetween(today, due) <= 30) add("amber", "payment-due", `Pay by ${showDate(due)} to keep the ITC`, `${rupees(unpaid)} is unpaid and the 180-day limit ends in ${daysBetween(today, due)} days.`, "Section 16(2), second proviso, CGST Act");
    }
  }

  if (reg && /composition/i.test(reg.kind) && tax > 0) add("red", "composition", "Composition dealer has charged GST", `${sup} is registered under the composition scheme. Such a dealer can't charge GST on a bill, and you can't claim ITC on it.`, "Section 10(4), CGST Act");

  // ---------------------------------------------------------------- dates
  if (inv.date) {
    const d = new Date(`${inv.date}T00:00:00Z`), md = inv.date.slice(5);
    const holiday = md === "01-26" ? "Republic Day" : md === "08-15" ? "Independence Day" : md === "10-02" ? "Gandhi Jayanti" : d.getUTCDay() === 0 ? "a Sunday" : "";
    if (holiday && inv.source !== "register") add("info", "date-holiday", `Invoice is dated on ${holiday}`, "Most businesses are closed that day. On its own this means little; with other findings it's worth a look.");
    const last = itcDeadline(inv.date), left = daysBetween(today, last);
    if (left >= 0 && left <= 60 && tax > 0 && inv.docType !== "credit") add("amber", "itc-soon", `Claim this ITC by ${showDate(last)}`, `Only ${left} day${left === 1 ? "" : "s"} left: ITC on an invoice can't be claimed after 30 November following its financial year.`, "Section 16(4), CGST Act");
  }

  // ---------------------------------------------------------------- was the PDF edited after it was made?
  if (inv.pdf) {
    const tool = `${inv.pdf.producer} ${inv.pdf.creator}`.match(/ilovepdf|sejda|smallpdf|pdfescape|pdf-?xchange|foxit\s*phantom|pdffiller|soda\s*pdf|pdfelement|nitro|acrobat\s*pro|dochub|xodo|photoshop|pdf\s*editor/i)?.[0];
    const later = inv.pdf.created && inv.pdf.modified && Date.parse(inv.pdf.modified) - Date.parse(inv.pdf.created) > 60 * 60 * 1000;
    if (tool || later) add("amber", "pdf-edited", "This PDF was changed after it was made",
      `${later ? `The file was created on ${showDate(inv.pdf.created!.slice(0, 10))} and changed on ${showDate(inv.pdf.modified!.slice(0, 10))}` : "The file"}${tool ? `${later ? ", and" : ""} was last saved with ${tool.trim()}, a PDF editing tool` : ""}. Billing software writes a PDF once. Compare the figures with the supplier's own copy.`);
  }

  // ---------------------------------------------------------------- the supplier's return filing
  if (reg?.filings.length && inv.date) {
    const p = periodOf(inv.date), due = dueDate("GSTR3B", p);
    const known = reg.filings.filter((f) => f.type === "GSTR3B").map((f) => f.period);
    // only when the service lists returns around that month (it usually reports the last several)
    if (today > due && !known.includes(p) && known.some((k) => `${k.slice(2)}${k.slice(0, 2)}` > `${p.slice(2)}${p.slice(0, 2)}`))
      add("amber", "supplier-3b", `Supplier hasn't filed GSTR-3B for ${periodName(p)}`, "The supplier filed later months but not this one, so the tax on your invoice may not have been paid to the government. ITC needs the tax to be paid.", "Section 16(2)(c), CGST Act");
    const late = lateFilings(reg);
    if (late.length >= 2) add("info", "supplier-late", "Supplier often files returns late", `${late.length} of the last ${reg.filings.length} returns were filed after the due date (${late.slice(0, 3).map((f) => `${f.type === "GSTR1" ? "GSTR-1" : "GSTR-3B"} ${periodName(f.period)}`).join(", ")}). Late filing delays your ITC in GSTR-2B.`);
  }

  // ---------------------------------------------------------------- HSN codes, blocked credit, reverse charge
  if (inv.source !== "register") {
    for (const it of inv.items) {
      if (it.hsn && !hsnValid(it.hsn)) { add("amber", "hsn-invalid", "HSN/SAC code doesn't exist", `“${it.hsn}” isn't a valid code: HSN codes have 4, 6 or 8 digits and start with a chapter from 01 to 99.`, RULE46); break; }
      const q = hsnMismatch(it);
      if (q) { add("info", "hsn-mismatch", "Check the HSN code against the item", q); break; }
    }
    const blocked = blockedCredit(inv.items);
    if (blocked && tax > 0 && !inv.reverseCharge) add("amber", "blocked-credit", "ITC is blocked on this kind of purchase", `This looks like ${blocked}. Credit on it can't be claimed (with a few exceptions, such as when you sell the same thing onward), even though the invoice is correct.`, "Section 17(5), CGST Act", round2(tax));
    const rcm = reverseChargeLikely(inv.items);
    if (rcm && inv.reverseCharge !== true && tax === 0) add("amber", "rcm-likely", "You may have to pay GST on this under reverse charge", `This looks like ${rcm}, and the supplier charged no GST. A registered buyer usually pays the tax on it under reverse charge, then claims it as ITC.`, "Section 9(3), CGST Act");
  }
  if (inv.ocrConfidence !== undefined && inv.ocrConfidence < 60 && inv.readBy === "ocr") add("amber", "ocr-low", "This picture was hard to read", `The text was read with ${inv.ocrConfidence}% confidence, so some details may be wrong (handwritten or blurred bills often are). Check the details below against the picture, or switch on AI reading if it's available.`);
  if (inv.docType !== "invoice" && !inv.refNumber && inv.source !== "register") add("amber", "note-ref", `${inv.docType === "credit" ? "Credit" : "Debit"} note doesn't say which invoice it's against`, "A credit or debit note should give the number and date of the original invoice.", "CGST Rule 53");

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
export const CRITICAL = new Set(["supplier-gstin", "buyer-gstin", "buyer-mismatch", "tax-type", "qr-mismatch", "qr-forged", "duplicate", "itc-time", "date-future", "composition", "gstin-cancelled", "gstin-suspended", "gstin-not-yet"]);
