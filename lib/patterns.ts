// Patterns across many invoices that single-invoice checks can't see: signs of bills split to dodge the
// e-way bill limit, fake bills from one bill book, or a lorry that was in two places at once.
import { cleanGstin } from "./gst.ts";
import { compactNo, round2, rupees, showDate } from "./parse.ts";
import { taxOf, type Finding, type Invoice } from "./types.ts";
import { cleanVehicle } from "./vehicle.ts";

const lastNumber = (no: string) => { const m = String(no).match(/(\d+)\D*$/); return m ? Number(m[1]) : NaN; };
const isGoods = (inv: Invoice) => inv.items.some((it) => /^\d{4,8}$/.test(it.hsn) && !it.hsn.startsWith("99")) || inv.source === "register";

export function findPatterns(invoices: Invoice[]): Record<string, Finding[]> {
  const out: Record<string, Finding[]> = {};
  const add = (id: string, f: Finding) => { (out[id] ??= []).push(f); };
  const group = <K,>(key: (i: Invoice) => K | null) => {
    const m = new Map<K, Invoice[]>();
    for (const i of list) { const k = key(i); if (k !== null && k !== "") m.set(k, [...(m.get(k) ?? []), i]); }
    return m;
  };
  const dupes = new Set(invoices.filter((a, i) => invoices.findIndex((b) => cleanGstin(b.supplierGstin) === cleanGstin(a.supplierGstin) && compactNo(b.number) === compactNo(a.number)) !== i).map((x) => x.id));
  const list = invoices.filter((i) => !dupes.has(i.id));

  // 1. several bills from one supplier on one day, each under ₹50,000 but over it together
  for (const [, g] of group((i) => (i.date && cleanGstin(i.supplierGstin) ? `${cleanGstin(i.supplierGstin)}|${i.date}` : null))) {
    const parts = g.filter((i) => Number.isFinite(i.total) && i.total < 50000 && isGoods(i));
    const sum = round2(parts.reduce((a, i) => a + i.total, 0));
    if (parts.length >= 2 && sum > 50000) for (const i of parts) add(i.id, { level: "amber", code: "pattern-split", title: "Bills split to stay under the e-way bill limit?",
      detail: `${parts.length} bills from this supplier on ${showDate(i.date)} (${parts.map((p) => p.number).join(", ")}) are each under ₹50,000 but total ${rupees(sum)}. One consignment split this way still needs an e-way bill.`, rule: "CGST Rule 138" });
  }
  // 2. one vehicle carrying goods for different suppliers on the same day
  for (const [, g] of group((i) => (i.vehicle && i.date ? `${cleanVehicle(i.vehicle)}|${i.date}` : null))) {
    const sups = new Set(g.map((i) => cleanGstin(i.supplierGstin)));
    if (sups.size >= 2) for (const i of g) add(i.id, { level: "amber", code: "pattern-vehicle", title: "Same vehicle on bills from different suppliers",
      detail: `Vehicle ${i.vehicle} carries goods on ${showDate(i.date)} for ${sups.size} different suppliers (${g.filter((x) => x.id !== i.id).map((x) => x.supplierName || x.supplierGstin).join(", ")}). Possible with a transporter, but also a sign of bills made up together.` });
  }
  // 3. a bill whose number runs straight on from another supplier's bill a few days apart
  for (const a of list) for (const b of list) {
    if (a === b || cleanGstin(a.supplierGstin) === cleanGstin(b.supplierGstin) || !a.date || !b.date) continue;
    const na = lastNumber(a.number), nb = lastNumber(b.number);
    if (na >= 100 && nb === na + 1 && Math.abs(Date.parse(a.date) - Date.parse(b.date)) <= 3 * 864e5)
      add(b.id, { level: "amber", code: "pattern-series", title: "Invoice number follows another supplier's bill",
        detail: `${b.supplierName || "This supplier"}'s bill ${b.number} comes straight after ${a.supplierName || "another supplier"}'s ${a.number}, ${showDate(a.date)}. Different businesses don't share a numbering series; the bills may come from one bill book.` });
  }
  // 4. one supplier's invoice numbers going backwards in time
  for (const [, g] of group((i) => cleanGstin(i.supplierGstin) || null)) {
    const dated = g.filter((i) => i.date && Number.isFinite(lastNumber(i.number)));
    for (const a of dated) for (const b of dated) if (a !== b && lastNumber(a.number) > lastNumber(b.number) && a.date! < b.date! && a.number.replace(/\d+\D*$/, "") === b.number.replace(/\d+\D*$/, ""))
      add(a.id, { level: "amber", code: "pattern-order", title: "Invoice numbers out of date order", detail: `${a.number} (${showDate(a.date)}) has a higher number than ${b.number} (${showDate(b.date)}), which was issued later. Invoice numbers must run in order within a financial year.`, rule: "CGST Rule 46(b)" });
  }
  // 5. a large round total that the tax doesn't explain
  for (const i of list) {
    const exact = round2(i.taxable + taxOf(i));
    if (Number.isFinite(i.total) && i.total >= 100000 && i.total % 1000 === 0 && Number.isFinite(exact) && exact % 1000 !== 0)
      add(i.id, { level: "info", code: "pattern-round", title: "Total is a round figure", detail: `The total is exactly ${rupees(i.total)} although taxable value + GST is ${rupees(exact)}. Totals chosen first and worked backwards are common in made-up bills.` });
  }
  // 6. different suppliers that share a bank account, phone number or email
  for (const [field, label] of [["bank", "bank account"], ["phone", "phone number"], ["email", "email address"]] as const) {
    for (const [value, g] of group((i) => i[field] || null)) {
      const sups = new Map(g.map((i) => [cleanGstin(i.supplierGstin), i.supplierName || i.supplierGstin]));
      if (sups.size >= 2) for (const i of g) add(i.id, { level: "amber", code: "pattern-shared", title: `Shares a ${label} with another supplier`,
        detail: `The ${label} ${field === "bank" ? `ending ${String(value).slice(-4)}` : value} is also printed on bills from ${[...sups].filter(([k]) => k !== cleanGstin(i.supplierGstin)).map(([, n]) => n).join(", ")}. Separate firms that share payment or contact details are often run by the same people; fake-invoice rings work this way.` });
    }
  }
  // 8. a supplier who issues e-invoices, but this bill has none
  for (const [, g] of group((i) => cleanGstin(i.supplierGstin) || null)) {
    const withQr = g.find((i) => i.qr?.kind === "einvoice");
    if (withQr) for (const i of g) if (i.docType === "invoice" && i.source !== "register" && i.qr?.kind !== "einvoice" && !i.irn)
      add(i.id, { level: "amber", code: "einvoice-missing", title: "No e-invoice QR, though this supplier issues e-invoices", detail: `${withQr.number} from the same supplier is a registered e-invoice with a QR code; this bill has no IRN or QR. A supplier who must issue e-invoices has to register every B2B invoice, and a bill without one isn't a valid tax invoice.`, rule: "CGST Rule 48(4)" });
  }
  // 9. the same item bought well above its usual price
  const unit = (it: Invoice["items"][number]) => (it.qty && it.qty > 0 && Number.isFinite(it.taxable) ? it.taxable / it.qty : NaN);
  const itemKey = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9.]+/g, " ").trim();
  const prices = new Map<string, { inv: Invoice; price: number; name: string }[]>();
  for (const i of list) if (i.docType === "invoice") for (const it of i.items) { const p = unit(it), k = itemKey(it.description); if (k.length >= 5 && p > 0) prices.set(k, [...(prices.get(k) ?? []), { inv: i, price: p, name: it.description }]); }
  for (const [, g] of prices) {
    if (g.length < 3) continue;
    const sorted = g.map((x) => x.price).sort((a, b) => a - b), median = sorted[Math.floor((sorted.length - 1) / 2)];
    for (const x of g) if (x.price > median * 1.5) add(x.inv.id, { level: "amber", code: "pattern-price", title: "Price is well above what you usually pay",
      detail: `“${x.name}” is billed at ${rupees(round2(x.price))} each; across ${g.length} purchases the usual price is ${rupees(round2(median))}. An inflated price inflates the ITC too.` });
  }
  // 10. a supplier whose monthly billing suddenly jumps
  for (const [, g] of group((i) => cleanGstin(i.supplierGstin) || null)) {
    const months = new Map<string, number>();
    for (const i of g) if (i.date && i.docType === "invoice" && Number.isFinite(i.taxable)) months.set(i.date.slice(0, 7), (months.get(i.date.slice(0, 7)) ?? 0) + i.taxable);
    const keys = [...months.keys()].sort(), latest = keys[keys.length - 1];
    if (keys.length < 3) continue;
    const before = keys.slice(0, -1).map((k) => months.get(k)!), avg = before.reduce((a, b) => a + b, 0) / before.length;
    if (months.get(latest)! > avg * 3 && months.get(latest)! - avg > 50000) for (const i of g) if (i.date?.startsWith(latest))
      add(i.id, { level: "info", code: "pattern-spike", title: "Billing from this supplier has jumped", detail: `${rupees(round2(months.get(latest)!), 0)} this month against a usual ${rupees(round2(avg), 0)} a month over the ${before.length} months before.` });
  }
  // 7. credit and debit notes, tied to the invoice they change
  for (const n of list.filter((i) => i.docType !== "invoice")) {
    const word = n.docType === "credit" ? "Credit" : "Debit";
    const orig = n.refNumber ? list.find((i) => i.docType === "invoice" && cleanGstin(i.supplierGstin) === cleanGstin(n.supplierGstin) && compactNo(i.number) === compactNo(n.refNumber)) : undefined;
    if (orig) {
      add(n.id, { level: "info", code: "note-linked", title: `${word} note against invoice ${orig.number}`, detail: `${n.docType === "credit" ? "Reduces" : "Adds to"} the ITC on ${orig.number} (${showDate(orig.date)}) by ${rupees(round2(taxOf(n)))}.`, rule: "Section 34, CGST Act" });
      add(orig.id, { level: "info", code: "has-note", title: `${word} note ${n.number} changes this invoice`, detail: `${word} note ${n.number} dated ${showDate(n.date)} ${n.docType === "credit" ? "reduces" : "adds to"} its GST by ${rupees(round2(taxOf(n)))}. ${n.docType === "credit" ? "Reverse that much ITC." : ""}`.trim(), rule: "Section 34, CGST Act" });
      if (n.docType === "credit" && Number.isFinite(n.total) && Number.isFinite(orig.total) && n.total > orig.total + 1) add(n.id, { level: "amber", code: "note-bigger", title: "Credit note is for more than the invoice", detail: `The credit note is for ${rupees(n.total)}, but invoice ${orig.number} was for ${rupees(orig.total)}.` });
    } else if (n.refNumber) add(n.id, { level: "amber", code: "note-orphan", title: `${word} note's invoice isn't in this batch`, detail: `It's against invoice ${n.refNumber}, which hasn't been uploaded. Upload that invoice to check the two together.` });
  }
  return out;
}
