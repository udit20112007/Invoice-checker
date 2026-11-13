// A score for each supplier (how safe is the ITC on their bills?) and the TDS check on large purchases.
import { cleanGstin } from "./gst.ts";
import { round2 } from "./parse.ts";
import { lateFilings, type GstinStatus } from "./gstinstatus.ts";
import type { Row } from "./reconcile.ts";

export type SupplierScore = {
  gstin: string; name: string; invoices: number; purchases: number; atRisk: number;
  score: number; grade: "A" | "B" | "C" | "D"; reasons: string[];
  tds: { fy: string; purchases: number; over: number; tds: number } | null;
};

export const fyOf = (iso: string) => { const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, "0")}`; };
export const TDS_LIMIT = 5000000, TDS_RATE = 0.1;

export function supplierScores(rows: Row[], gstin: Record<string, GstinStatus> = {}): SupplierScore[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) { const k = cleanGstin(r.inv.supplierGstin) || r.inv.supplierName || r.inv.fileName; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const out: SupplierScore[] = [];
  for (const [g, all] of groups) {
    const rs = all.filter((r) => !r.findings.some((f) => f.code === "duplicate"));
    if (!rs.length) continue;
    let score = 100;
    const reasons: string[] = [];
    const take = (n: number, why: string) => { score -= n; reasons.push(why); };
    const count = (test: (r: Row) => boolean) => rs.filter(test).length;
    const has = (code: string) => count((r) => r.findings.some((f) => f.code === code));
    const reg = gstin[g];
    if (has("supplier-gstin")) take(60, "GSTIN isn't valid");
    if (has("gstin-cancelled") || has("gstin-suspended")) take(60, "registration cancelled or suspended");
    if (has("qr-forged")) take(60, "forged e-invoice QR");
    if (has("qr-mismatch")) take(40, "printed invoice differs from its QR");
    const missing = count((r) => r.match.status === "missing" && r.inv.docType !== "credit");
    if (missing) take(Math.min(40, 20 * missing), `${missing} invoice${missing > 1 ? "s" : ""} not in GSTR-2B`);
    const differs = count((r) => r.match.status === "mismatch");
    if (differs) take(Math.min(20, 10 * differs), `${differs} differ${differs > 1 ? "" : "s"} from GSTR-2B`);
    const wrongTax = count((r) => r.findings.some((f) => ["tax-type", "tax-maths", "cgst-sgst", "total", "items-sum"].includes(f.code)));
    if (wrongTax) take(Math.min(30, 15 * wrongTax), "tax worked out wrongly");
    if (has("old-rate") || has("odd-rate")) take(10, "wrong GST rate");
    if (has("gstin-name")) take(15, "name doesn't match the GSTIN");
    if (has("gstin-new") || has("gstin-not-yet")) take(10, "newly registered");
    if (has("supplier-3b")) take(25, "GSTR-3B not filed");
    const late = reg ? lateFilings(reg).length : 0;
    if (late) take(Math.min(20, 5 * late), `${late} return${late > 1 ? "s" : ""} filed late`);
    const pat = count((r) => r.findings.some((f) => /^pattern-(split|vehicle|series|order|shared)/.test(f.code)));
    if (pat) take(15, "suspicious patterns");
    if (has("vehicle")) take(15, "made-up vehicle number");
    if (has("hsn") || has("hsn-invalid")) take(5, "HSN codes missing or wrong");
    score = Math.max(0, score);
    // TDS on purchase of goods above ₹50 lakh from one seller in a year (by PAN, so all of a seller's GSTINs count together)
    const byFy = new Map<string, number>();
    for (const r of rs) if (r.inv.date && Number.isFinite(r.inv.taxable)) byFy.set(fyOf(r.inv.date), (byFy.get(fyOf(r.inv.date)) ?? 0) + r.inv.taxable * (r.inv.docType === "credit" ? -1 : 1));
    const top = [...byFy].sort((a, b) => b[1] - a[1])[0];
    out.push({
      gstin: g, name: rs[0].inv.supplierName, invoices: rs.length, purchases: round2(rs.reduce((a, r) => a + (Number.isFinite(r.inv.taxable) ? r.inv.taxable * (r.inv.docType === "credit" ? -1 : 1) : 0), 0)),
      atRisk: round2(rs.reduce((a, r) => a + r.atRisk, 0)), score, grade: score >= 85 ? "A" : score >= 65 ? "B" : score >= 40 ? "C" : "D", reasons,
      tds: top && top[1] > TDS_LIMIT ? { fy: top[0], purchases: round2(top[1]), over: round2(top[1] - TDS_LIMIT), tds: round2((top[1] - TDS_LIMIT) * TDS_RATE / 100) } : null,
    });
  }
  // one seller with several GSTINs (same PAN): add their purchases together for the TDS limit
  const byPan = new Map<string, SupplierScore[]>();
  for (const s of out) if (s.gstin.length === 15) { const pan = s.gstin.slice(2, 12); byPan.set(pan, [...(byPan.get(pan) ?? []), s]); }
  for (const [, list] of byPan) {
    if (list.length < 2) continue;
    const total = round2(list.reduce((a, s) => a + s.purchases, 0));
    if (total > TDS_LIMIT) for (const s of list) s.tds = { fy: s.tds?.fy ?? "", purchases: total, over: round2(total - TDS_LIMIT), tds: round2((total - TDS_LIMIT) * TDS_RATE / 100) };
  }
  return out.sort((a, b) => a.score - b.score || b.atRisk - a.atRisk);
}
