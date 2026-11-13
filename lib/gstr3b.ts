// A draft of GSTR-3B Table 4 (input tax credit) from the checked invoices, and the tax to pay under
// reverse charge (Table 3.1(d)). A working paper to check, not a return.
import { round2 } from "./parse.ts";
import type { Row } from "./reconcile.ts";

export type Tax4 = { igst: number; cgst: number; sgst: number; cess: number };
export type Line3b = { key: string; label: string; note: string; tax: Tax4; rows: Row[] };
export type Draft3b = { lines: Line3b[]; net: Tax4; rcmPayable: Tax4; waiting: Line3b };

const zero = (): Tax4 => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
const KEYS = ["igst", "cgst", "sgst", "cess"] as const;
const plus = (a: Tax4, b: Tax4, k = 1) => { for (const x of KEYS) a[x] = round2(a[x] + b[x] * k); return a; };
export const total4 = (t: Tax4) => round2(t.igst + t.cgst + t.sgst + t.cess);
const taxOfRow = (r: Row, share = 1): Tax4 => {
  const s = (r.inv.docType === "credit" ? -1 : 1) * share;
  return { igst: round2((r.inv.igst || 0) * s), cgst: round2((r.inv.cgst || 0) * s), sgst: round2((r.inv.sgst || 0) * s), cess: round2((r.inv.cess || 0) * s) };
};

export function draft3b(rows: Row[], has2b: boolean): Draft3b {
  const line = (key: string, label: string, note: string): Line3b => ({ key, label, note, tax: zero(), rows: [] });
  const a3 = line("4(A)(3)", "Inward supplies liable to reverse charge", "Tax you pay yourself under reverse charge, claimed back as ITC");
  const a5 = line("4(A)(5)", "All other ITC", has2b ? "Invoices and notes that are in GSTR-2B" : "All invoices (upload GSTR-2B to limit this to what suppliers reported)");
  const b1 = line("4(B)(1)", "ITC reversed: blocked credit (Section 17(5)) and rules 38, 42, 43", "Purchases where credit isn't allowed");
  const b2 = line("4(B)(2)", "ITC reversed: others", "Unpaid after 180 days (rule 37), and invoices with problems to sort out before claiming");
  const waiting = line("—", "Not claimable yet", "Not in GSTR-2B: claim in the month the supplier reports it");
  const rcmPayable = zero();
  for (const r of rows) {
    if (r.findings.some((f) => f.code === "duplicate")) continue;
    const full = taxOfRow(r);
    if (total4(full) === 0 && !r.inv.reverseCharge) continue;
    if (r.inv.reverseCharge) { plus(a3.tax, full); plus(rcmPayable, full); a3.rows.push(r); continue; }
    if (has2b && r.match.status === "missing") { plus(waiting.tax, full); waiting.rows.push(r); continue; }
    plus(a5.tax, full); a5.rows.push(r);
    if (r.atRisk > 0 && total4(full) > 0) {
      const share = Math.min(1, r.atRisk / total4(full));
      const target = r.findings.some((f) => f.code === "blocked-credit") && r.why.startsWith("ITC is blocked") ? b1 : b2;
      plus(target.tax, taxOfRow(r, share)); target.rows.push(r);
    }
  }
  const net = zero();
  plus(plus(net, a3.tax), a5.tax); plus(plus(net, b1.tax, -1), b2.tax, -1);
  return { lines: [a3, a5, b1, b2], net, rcmPayable, waiting };
}
