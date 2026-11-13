// Views across the whole batch: who is linked to whom, month-by-month totals, Benford's law, payment ageing
// and advice, what GSTR-2B action to take, a draft reply to an ITC mismatch notice, and a few calculators.
import { cleanGstin } from "./gst.ts";
import { round2, rupees, showDate } from "./parse.ts";
import { addDays, daysBetween, type PaidInfo } from "./payments.ts";
import type { Row, TwoBDoc } from "./reconcile.ts";
import type { Analysis } from "./analyse.ts";
import { cleanVehicle } from "./vehicle.ts";

// ---------------------------------------------------------------- suppliers linked by shared details
export type RingNode = { id: string; name: string; atRisk: number; bills: number };
export type RingEdge = { a: string; b: string; why: string[] };
export function ringMap(rows: Row[]): { nodes: RingNode[]; edges: RingEdge[] } {
  const live = rows.filter((r) => !r.findings.some((f) => f.code === "duplicate"));
  const id = (r: Row) => cleanGstin(r.inv.supplierGstin) || r.inv.supplierName;
  const edges = new Map<string, RingEdge>();
  const link = (a: string, b: string, why: string) => {
    if (!a || !b || a === b) return;
    const [x, y] = [a, b].sort(), k = `${x}|${y}`, e = edges.get(k) ?? { a: x, b: y, why: [] };
    if (!e.why.includes(why)) e.why.push(why);
    edges.set(k, e);
  };
  const share = (label: string, key: (r: Row) => string) => {
    const m = new Map<string, Row[]>();
    for (const r of live) { const k = key(r); if (k) m.set(k, [...(m.get(k) ?? []), r]); }
    for (const g of m.values()) for (const p of g) for (const q of g) link(id(p), id(q), label);
  };
  share("same bank account", (r) => r.inv.bank);
  share("same phone number", (r) => r.inv.phone);
  share("same email", (r) => r.inv.email);
  share("same vehicle", (r) => (r.inv.vehicle ? cleanVehicle(r.inv.vehicle) : ""));
  // a bill whose number runs on from another supplier's
  for (const r of live) if (r.findings.some((f) => f.code === "pattern-series")) {
    const n = Number(r.inv.number.match(/(\d+)\D*$/)?.[1]);
    const prev = live.find((o) => id(o) !== id(r) && Number(o.inv.number.match(/(\d+)\D*$/)?.[1]) === n - 1);
    if (prev) link(id(r), id(prev), "invoice numbers run on");
  }
  const linked = new Set([...edges.values()].flatMap((e) => [e.a, e.b]));
  const nodes = [...linked].map((g) => { const rs = live.filter((r) => id(r) === g); return { id: g, name: rs[0]?.inv.supplierName || g, atRisk: round2(rs.reduce((a, r) => a + r.atRisk, 0)), bills: rs.length }; });
  return { nodes, edges: [...edges.values()] };
}

// ---------------------------------------------------------------- month by month
export type Month = { month: string; bills: number; tax: number; atRisk: number };
export function monthly(rows: Row[]): Month[] {
  const m = new Map<string, Month>();
  for (const r of rows) {
    if (!r.inv.date || r.findings.some((f) => f.code === "duplicate")) continue;
    const k = r.inv.date.slice(0, 7), x = m.get(k) ?? { month: k, bills: 0, tax: 0, atRisk: 0 };
    x.bills++; x.tax = round2(x.tax + (Number.isFinite(r.tax) ? r.tax : 0)); x.atRisk = round2(x.atRisk + r.atRisk);
    m.set(k, x);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// ---------------------------------------------------------------- Benford's law: first digits of made-up amounts don't follow it
export const BENFORD = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => Math.log10(1 + 1 / d));
export const BENFORD_MIN = 50;
export function benford(amounts: number[]): { n: number; observed: number[]; chi2: number; unusual: boolean } {
  const digits = amounts.filter((a) => Number.isFinite(a) && a >= 10).map((a) => Number(String(Math.abs(a)).match(/[1-9]/)?.[0]));
  const n = digits.length, observed = BENFORD.map((_, i) => (n ? digits.filter((d) => d === i + 1).length / n : 0));
  const chi2 = round2(BENFORD.reduce((a, e, i) => a + ((observed[i] - e) ** 2 / e) * n, 0));
  return { n, observed, chi2, unusual: n >= BENFORD_MIN && chi2 > 20.09 };   // 8 degrees of freedom, 1% level
}

// ---------------------------------------------------------------- payments: ageing, what to hold back, MSME 45 days
export type PayLine = { row: Row; paid: number; unpaid: number; age: number; hold: number; payNow: number; advice: string; msmeLate: number };
export const MSME_DAYS = 45;
export function payLines(rows: Row[], paidOf: (r: Row) => PaidInfo, today: string, msme: Set<string> = new Set()): PayLine[] {
  return rows.filter((r) => r.inv.date && Number.isFinite(r.inv.total) && r.inv.total > 0 && r.inv.docType !== "credit" && !r.findings.some((f) => f.code === "duplicate")).map((row) => {
    const paid = paidOf(row).paid, unpaid = Math.max(0, round2(row.inv.total - paid)), age = daysBetween(row.inv.date!, today);
    // hold back the GST that's at risk until the problem is sorted out; pay the rest
    const hold = unpaid > 1 ? round2(Math.min(unpaid, row.atRisk)) : 0;
    const advice = unpaid <= 1 ? "" : hold > 0 ? `Pay ${rupees(round2(unpaid - hold), 0)} now; hold ${rupees(hold, 0)} (the GST) until ${row.match.status === "missing" ? "it shows in GSTR-2B" : "the problem is fixed"}` : "Safe to pay in full";
    const due = addDays(row.inv.date!, MSME_DAYS);
    const msmeLate = msme.has(cleanGstin(row.inv.supplierGstin)) && unpaid > 1 && today > due ? daysBetween(due, today) : 0;
    return { row, paid, unpaid, age, hold, payNow: round2(unpaid - hold), advice, msmeLate };
  });
}
export const AGE_BUCKETS: [string, number, number][] = [["0–30 days", 0, 30], ["31–60", 31, 60], ["61–90", 61, 90], ["91–180", 91, 180], ["Over 180", 181, 1e9]];
export const ageing = (lines: PayLine[]) => AGE_BUCKETS.map(([label, lo, hi]) => { const g = lines.filter((l) => l.unpaid > 1 && l.age >= lo && l.age <= hi); return { label, bills: g.length, unpaid: round2(g.reduce((a, l) => a + l.unpaid, 0)) }; });

// ---------------------------------------------------------------- what-if, interest, common credit
/** ITC that comes back as soon as suppliers report the invoices missing from GSTR-2B (and nothing else is wrong with them). */
export const recoverable = (rows: Row[]) => round2(rows.filter((r) => r.why === "Not in GSTR-2B").reduce((a, r) => a + r.atRisk, 0));
/** Interest at 18% a year on ITC wrongly claimed and used (Section 50(3)). */
export const interest = (amount: number, days: number) => round2(Math.max(0, amount) * 0.18 * Math.max(0, days) / 365);
/** Rule 42: the share of common credit to reverse = exempt turnover ÷ total turnover. */
export const rule42 = (common: number, exempt: number, total: number) => (total > 0 ? round2(Math.max(0, common) * Math.min(1, Math.max(0, exempt) / total)) : 0);

// ---------------------------------------------------------------- Invoice Management System: what to do with each GSTR-2B entry
export type Ims = "Accept" | "Pending" | "Reject";
export function imsForRow(r: Row): { action: Ims; why: string } | null {
  if (!r.match.doc) return null;
  if (r.findings.some((f) => f.code === "duplicate")) return null;
  if (r.match.status === "mismatch") return { action: "Pending", why: "Amounts differ from your invoice: ask the supplier to amend" };
  if (r.findings.some((f) => f.level === "red" && !f.code.startsWith("payment"))) return { action: "Pending", why: "Sort out the problem on the invoice first" };
  return { action: "Accept", why: "Matches your invoice" };
}
export const imsForExtra = (d: TwoBDoc): { action: Ims; why: string } => ({ action: "Pending", why: d.kind === "CN" ? "Credit note not in your books: check before accepting" : "No invoice in your books: find it, or reject if it isn't your purchase" });

// ---------------------------------------------------------------- a draft reply to an ITC mismatch notice (DRC-01C / ASMT-10)
export function noticeReply(a: Analysis, name: string, period: string): string {
  const inBooks = a.rows.filter((r) => !r.findings.some((f) => f.code === "duplicate") && r.inv.docType !== "credit");
  const missing = inBooks.filter((r) => r.match.status === "missing"), differs = inBooks.filter((r) => r.match.status === "mismatch");
  const line = (r: Row, i: number) => `   ${i + 1}. ${r.inv.supplierName} (${r.inv.supplierGstin}), invoice ${r.inv.number} dated ${showDate(r.inv.date)}, GST ${rupees(r.tax)}`;
  const out = ["To", "The Proper Officer", "", `Subject: Reply to the intimation of difference in input tax credit${period ? ` for the period ${period}` : ""}`, `GSTIN: ${a.ourGstin || "________"}`, "Reference no.: ________ dated ________", "", "Sir/Madam,", "",
    `With reference to the above intimation, we have reconciled the input tax credit in our books with GSTR-2B, invoice by invoice. Of ${inBooks.length} purchase invoices carrying GST of ${rupees(round2(inBooks.reduce((x, r) => x + r.tax, 0)))}, ${inBooks.length - missing.length - differs.length} agree with GSTR-2B. The difference is explained below.`, ""];
  if (missing.length) out.push(`1. Invoices not reported by the supplier (${missing.length}), GST ${rupees(round2(missing.reduce((x, r) => x + r.tax, 0)))}:`, ...missing.map(line), "   We hold valid tax invoices for these and have asked the suppliers in writing to report them. [We have not claimed this credit / We have reversed this credit in GSTR-3B of ________ / We have paid ₹________ by DRC-03 dated ________.]", "");
  if (differs.length) out.push(`${missing.length ? 2 : 1}. Invoices reported with different amounts (${differs.length}):`, ...differs.map((r, i) => `${line(r, i)}: ${r.match.diffs.join("; ")}`), "   We have claimed credit only up to the amount in GSTR-2B and asked the suppliers to amend their returns.", "");
  if (!missing.length && !differs.length) out.push("We find no difference between our books and GSTR-2B for the invoices on record.", "");
  out.push("Copies of the invoices, the reconciliation statement and our letters to the suppliers are enclosed. We request that the proceedings be dropped.", "", "Yours faithfully,", name || "________", "Authorised signatory");
  return out.join("\n");
}

// ---------------------------------------------------------------- a short summary to read aloud
export function spoken(a: Analysis, hindi: boolean): string {
  const t = a.totals, n = (x: number) => Math.round(x).toLocaleString("en-IN");
  const worst = [...a.suppliers].sort((x, y) => y.atRisk - x.atRisk)[0];
  return hindi
    ? `${t.invoices} बिल जाँचे गए। ${t.green} ठीक हैं, ${t.amber} देखने लायक हैं, और ${t.red} में समस्या है। कुल GST ${n(t.tax)} रुपये है, जिसमें से ${n(t.atRisk)} रुपये का इनपुट टैक्स क्रेडिट खतरे में है। ${n(t.safe)} रुपये लेना सुरक्षित है।${worst?.atRisk ? ` सबसे ज़्यादा जोखिम ${worst.name} के बिलों पर है, ${n(worst.atRisk)} रुपये।` : ""}`
    : `${t.invoices} invoices checked. ${t.green} are OK, ${t.amber} need a look, and ${t.red} have problems. Of ${n(t.tax)} rupees of GST, ${n(t.atRisk)} rupees of input tax credit is at risk, and ${n(t.safe)} rupees is safe to claim.${worst?.atRisk ? ` The most at risk is with ${worst.name}: ${n(worst.atRisk)} rupees.` : ""}`;
}
