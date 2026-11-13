// Puts it all together: checks every invoice, reconciles with GSTR-2B, works out ITC at risk,
// groups problems by supplier, and builds the Excel report.
import { checkInvoice, verdictOf, type Verdict } from "./checks.ts";
import { cleanGstin } from "./gst.ts";
import { round2, showDate } from "./parse.ts";
import { reconcile, riskOf, supplierMessage, type Row, type TwoB, type TwoBDoc } from "./reconcile.ts";
import { signOf, taxOf, type Invoice } from "./types.ts";
import type { GstinStatus } from "./gstinstatus.ts";
import { paidFor, type PaidInfo, type Payment } from "./payments.ts";
import { findPatterns } from "./patterns.ts";
import { writeXlsx } from "./xlsx.ts";

export type Supplier = { gstin: string; name: string; rows: Row[]; atRisk: number; message: string };
export type Analysis = {
  rows: Row[];
  extra: TwoBDoc[];
  suppliers: Supplier[];
  totals: { invoices: number; red: number; amber: number; green: number; tax: number; atRisk: number; safe: number; notIn2b: number };
  ourGstin: string;
};

const worst = (a: Verdict, b: Verdict): Verdict => (a === "red" || b === "red" ? "red" : a === "amber" || b === "amber" ? "amber" : "green");

export type AnalyseOptions = {
  ourGstin?: string; ourName?: string; today?: string;
  gstin?: Record<string, GstinStatus>;           // supplier registrations looked up
  payments?: Payment[];                          // payments file
  paidByHand?: Record<string, PaidInfo>;         // payments entered on the invoice screen
};

export function analyse(invoices: Invoice[], twob: TwoB | null, opts: AnalyseOptions = {}): Analysis {
  const ourGstin = cleanGstin(opts.ourGstin) || twob?.gstin || "";
  const rec = reconcile(invoices, twob);
  const patterns = findPatterns(invoices);
  const tracksPayments = !!(opts.payments?.length || Object.keys(opts.paidByHand ?? {}).length);
  const rows: Row[] = invoices.map((inv) => {
    const fromFile = opts.payments?.length ? paidFor(inv, opts.payments) : { paid: 0, lastDate: null };
    const byHand = opts.paidByHand?.[inv.id];
    const paid = tracksPayments ? (byHand ?? fromFile) : undefined;
    const findings = [...checkInvoice(inv, { ourGstin, all: invoices, today: opts.today, gstin: opts.gstin, paid }), ...(patterns[inv.id] ?? [])];
    const match = rec.byInvoice[inv.id];
    const { atRisk, why } = riskOf(inv, findings, match);
    let verdict = verdictOf(findings);
    if ((match.status === "missing" && inv.docType !== "credit") || atRisk > 0) verdict = "red";
    else if (match.status === "mismatch") verdict = worst(verdict, "amber");
    return { inv, findings, verdict, match, tax: round2(taxOf(inv) * signOf(inv)), atRisk, why };
  });
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = cleanGstin(r.inv.supplierGstin) || r.inv.supplierName || r.inv.fileName;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const suppliers: Supplier[] = [...groups.entries()]
    // a duplicate is our own double entry, not something to ask the supplier about
    .map(([gstin, all]) => [gstin, all.filter((r) => !r.findings.some((f) => f.code === "duplicate"))] as const)
    .filter(([, rs]) => rs.length > 0)
    .map(([gstin, rs]) => ({ gstin, name: rs[0].inv.supplierName, rows: rs, atRisk: round2(rs.reduce((a, r) => a + r.atRisk, 0)), message: "" }))
    .filter((s) => s.rows.some((r) => r.match.status === "missing" || r.match.status === "mismatch" || r.findings.some((f) => f.level === "red" && f.code !== "duplicate")))
    .map((s) => ({ ...s, message: supplierMessage(s.rows, ourGstin, opts.ourName ?? "") }))
    .sort((a, b) => b.atRisk - a.atRisk);
  const tax = round2(rows.reduce((a, r) => a + (Number.isFinite(r.tax) ? r.tax : 0), 0));
  const atRisk = round2(rows.reduce((a, r) => a + r.atRisk, 0));
  return {
    rows, extra: rec.extra, suppliers, ourGstin,
    totals: {
      invoices: rows.length, red: rows.filter((r) => r.verdict === "red").length, amber: rows.filter((r) => r.verdict === "amber").length,
      green: rows.filter((r) => r.verdict === "green").length, tax, atRisk, safe: round2(tax - atRisk), notIn2b: rows.filter((r) => r.match.status === "missing").length,
    },
  };
}

export const MATCH_LABEL = { matched: "In GSTR-2B", mismatch: "Differs from GSTR-2B", missing: "Not in GSTR-2B", unchecked: "No GSTR-2B uploaded" } as const;
export const VERDICT_LABEL = { red: "Problem", amber: "Check", green: "OK" } as const;

export function reportXlsx(a: Analysis, period: string): Uint8Array {
  const t = a.totals;
  return writeXlsx([
    { name: "Summary", heading: false, widths: [44, 22], money: [1], rows: [
      ["Invoice check and GSTR-2B reconciliation"], [],
      ["Your GSTIN", a.ourGstin || "—"], ["GSTR-2B period", period || "—"], ["Prepared on", new Date().toLocaleDateString("en-IN")], [],
      ["Invoices checked", String(t.invoices)], ["OK", String(t.green)], ["Need checking", String(t.amber)], ["Problems", String(t.red)], [],
      ["GST on these invoices", t.tax], ["ITC at risk", t.atRisk], ["ITC safe to claim", t.safe], [],
      ["Check the results before filing GSTR-3B."],
    ] },
    { name: "Invoices", widths: [10, 30, 18, 18, 12, 14, 14, 14, 22, 14, 70, 14, 16, 20], money: [5, 6, 7, 9], rows: [
      ["Result", "Supplier", "Supplier GSTIN", "Invoice no.", "Date", "Taxable value", "GST", "Total", "GSTR-2B", "ITC at risk", "Problems found", "Vehicle", "E-way bill", "File"],
      ...a.rows.map((r) => [VERDICT_LABEL[r.verdict], r.inv.supplierName, r.inv.supplierGstin, r.inv.number, showDate(r.inv.date), r.inv.taxable, r.tax, r.inv.total, MATCH_LABEL[r.match.status], r.atRisk || null,
        [...r.findings.map((f) => f.title), ...r.match.diffs].join("; "), r.inv.vehicle, r.inv.ewayBill, r.inv.fileName]),
    ] },
    { name: "Not uploaded", widths: [30, 18, 18, 12, 14, 14], money: [4, 5], rows: [
      ["Supplier (in GSTR-2B)", "GSTIN", "Invoice no.", "Date", "Taxable value", "Total"],
      ...a.extra.map((d) => [d.name, d.gstin, d.number, showDate(d.date), d.taxable, d.total]),
    ] },
    { name: "Supplier messages", widths: [30, 18, 14, 90], money: [2], rows: [
      ["Supplier", "GSTIN", "ITC at risk", "Message"],
      ...a.suppliers.map((s) => [s.name, s.gstin, s.atRisk || null, s.message]),
    ] },
  ]);
}
