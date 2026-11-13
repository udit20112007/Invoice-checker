// GSTR-2B: the GST portal's list of invoices your suppliers reported. Reading it, and matching the uploaded
// invoices against it to find ITC at risk.
import { unzipSync } from "fflate";
import { excelDate, readXlsx } from "./sheets.ts";
import { cleanGstin } from "./gst.ts";
import { amount, compactNo, date, invoiceKey, round2, rupees, showDate } from "./parse.ts";
import { CRITICAL, type Verdict } from "./checks.ts";
import { taxOf, type Finding, type Invoice } from "./types.ts";

export type TwoBDoc = {
  id: string; gstin: string; name: string; number: string; date: string | null; kind: "INV" | "CN" | "DN";
  taxable: number; igst: number; cgst: number; sgst: number; cess: number; total: number;
  itcAvailable: boolean; reverseCharge: boolean; period: string;
};
export type TwoB = { gstin: string; period: string; docs: TwoBDoc[] };

// ---------------------------------------------------------------- reading GSTR-2B
type J = Record<string, unknown>;
const arr = (v: unknown) => (Array.isArray(v) ? (v as J[]) : []);
const num = (v: unknown) => { const n = amount(v); return Number.isFinite(n) ? n : 0; };

export function parse2bJson(text: string): TwoB {
  let root: J;
  try { root = JSON.parse(text); } catch { throw new Error("This file isn't valid JSON. Download GSTR-2B again from the GST portal."); }
  const data = (root.data ?? root) as J;
  const docdata = data.docdata as J | undefined;
  if (!docdata) throw new Error("This JSON isn't a GSTR-2B file: it has no invoice details.");
  const period = String(data.rtnprd ?? "");
  const docs: TwoBDoc[] = [];
  const add = (sup: J, d: J, kind: TwoBDoc["kind"]) => docs.push({
    id: `2b-${docs.length}`, gstin: cleanGstin(sup.ctin), name: String(sup.trdnm ?? ""), number: String(d.inum ?? d.ntnum ?? ""),
    date: date(d.dt), kind, taxable: num(d.txval), igst: num(d.igst), cgst: num(d.cgst), sgst: num(d.sgst), cess: num(d.cess), total: num(d.val),
    itcAvailable: String(d.itcavl ?? "Y").toUpperCase() !== "N", reverseCharge: String(d.rev ?? "N").toUpperCase() === "Y", period: String(sup.supprd ?? period),
  });
  for (const sup of [...arr(docdata.b2b), ...arr(docdata.b2ba)]) for (const d of arr(sup.inv)) add(sup, d, "INV");
  for (const sup of [...arr(docdata.cdnr), ...arr(docdata.cdnra)]) for (const d of arr(sup.nt)) add(sup, d, String(d.typ ?? "C").toUpperCase() === "D" ? "DN" : "CN");
  return { gstin: cleanGstin(data.gstin), period, docs };
}

// The portal's Excel: a "B2B" sheet with two heading rows ("Invoice details" over "Invoice number", …)
export function parse2bXlsx(bytes: Uint8Array): TwoB {
  const sheets = readXlsx(bytes);
  const b2b = sheets.find((s) => /^b2b$/i.test(s.name.replace(/\s/g, "")));
  if (!b2b) throw new Error("This Excel file has no B2B sheet. Use the GSTR-2B Excel downloaded from the GST portal.");
  const rows = b2b.rows;
  const headAt = rows.findIndex((r) => r.some((c) => /gstin of supplier/i.test(c)));
  if (headAt < 0) throw new Error("Couldn't find the headings in the B2B sheet.");
  const head = rows[headAt].map((h, i) => `${h} ${rows[headAt + 1]?.[i] ?? ""}`.toLowerCase());
  const find = (re: RegExp) => head.findIndex((h) => re.test(h));
  const c = { g: find(/gstin of supplier/), n: find(/trade|legal/), no: find(/invoice number/), dt: find(/invoice date/), val: find(/invoice value/), tx: find(/taxable/), i: find(/integrated/), ce: find(/central/), s: find(/state/), cs: find(/cess/), itc: find(/itc availability/) };
  const docs: TwoBDoc[] = [];
  for (const r of rows.slice(headAt + 2)) {
    const g = cleanGstin(r[c.g]);
    if (g.length !== 15) continue;
    const d = /^\d{5}$/.test(r[c.dt] ?? "") ? excelDate(Number(r[c.dt])) : date(r[c.dt]);
    docs.push({ id: `2b-${docs.length}`, gstin: g, name: r[c.n] ?? "", number: r[c.no] ?? "", date: d, kind: "INV", taxable: num(r[c.tx]), igst: num(r[c.i]), cgst: num(r[c.ce]), sgst: num(r[c.s]), cess: num(r[c.cs]), total: num(r[c.val]), itcAvailable: !/^no?$/i.test(r[c.itc] ?? ""), reverseCharge: false, period: "" });
  }
  // your own GSTIN is on the "Read me" sheet (or above the B2B headings)
  const findGstin = (text: string) => text.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/)?.[0];
  const gstin = cleanGstin(findGstin(rows.slice(0, headAt).flat().join(" ")) ?? sheets.filter((x) => x !== b2b).map((x) => findGstin(x.rows.slice(0, 20).flat().join(" "))).find(Boolean));
  return { gstin, period: "", docs };
}

export async function read2bFile(name: string, bytes: Uint8Array): Promise<TwoB> {
  if (/\.zip$/i.test(name)) {
    const inner = Object.entries(unzipSync(bytes)).find(([p]) => /\.(json|xlsx)$/i.test(p));
    if (!inner) throw new Error("This zip has no GSTR-2B JSON or Excel file in it.");
    return read2bFile(inner[0], inner[1]);
  }
  if (/\.json$/i.test(name)) return parse2bJson(new TextDecoder().decode(bytes));
  if (/\.xlsx$/i.test(name)) return parse2bXlsx(bytes);
  throw new Error("Choose the GSTR-2B file from the GST portal (.json, .xlsx or .zip).");
}

// ---------------------------------------------------------------- several months of GSTR-2B
const docKey = (d: TwoBDoc) => `${d.gstin}|${d.kind}|${compactNo(d.number)}`;
/** Joins several GSTR-2B files. When a document is in more than one, the newest file's version is kept. */
export function mergeTwoB(list: TwoB[]): TwoB | null {
  if (!list.length) return null;
  const order = [...list].sort((a, b) => periodSort(a.period).localeCompare(periodSort(b.period)));
  const docs = new Map<string, TwoBDoc>();
  order.forEach((t, fi) => t.docs.forEach((d) => docs.set(docKey(d), { ...d, id: `2b-${fi}-${d.id}`, period: d.period || t.period })));
  const last = order[order.length - 1];
  return { gstin: order.map((t) => t.gstin).find(Boolean) ?? "", period: order.length > 1 && order[0].period !== last.period ? `${order[0].period}-${last.period}` : last.period, docs: [...docs.values()] };
}
const periodSort = (p: string) => (/^\d{6}$/.test(p) ? `${p.slice(2)}${p.slice(0, 2)}` : p);
export type TwoBChange = { gstin: string; name: string; number: string; from: string; to: string; what: string };
/** Documents that changed between GSTR-2B files: amended amounts, or reported in one file and gone from a later file of the same month. */
export function twobChanges(list: TwoB[]): TwoBChange[] {
  const order = [...list].sort((a, b) => periodSort(a.period).localeCompare(periodSort(b.period)));
  const out: TwoBChange[] = [];
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) {
    const a = order[i], b = order[j], later = new Map(b.docs.map((d) => [docKey(d), d]));
    for (const d of a.docs) {
      const n = later.get(docKey(d));
      const base = { gstin: d.gstin, name: d.name, number: d.number, from: a.period || `file ${i + 1}`, to: b.period || `file ${j + 1}` };
      if (n) {
        const t1 = round2(d.igst + d.cgst + d.sgst + d.cess), t2 = round2(n.igst + n.cgst + n.sgst + n.cess);
        if (Math.abs(t1 - t2) > 1 || Math.abs(d.taxable - n.taxable) > 1) out.push({ ...base, what: `Amended: GST ${rupees(t1)} → ${rupees(t2)}, taxable value ${rupees(d.taxable)} → ${rupees(n.taxable)}` });
        else if (d.itcAvailable !== n.itcAvailable) out.push({ ...base, what: n.itcAvailable ? "ITC is now available" : "ITC is no longer available" });
      } else if (a.period && a.period === b.period) out.push({ ...base, what: "Was in the earlier download, missing from the later one" });
    }
  }
  return out;
}

// ---------------------------------------------------------------- matching
export type MatchStatus = "matched" | "mismatch" | "missing" | "unchecked";
export type Match = { status: MatchStatus; doc: TwoBDoc | null; how?: "exact" | "number" | "probable"; diffs: string[] };

export function reconcile(invoices: Invoice[], twob: TwoB | null, tolerance = 1): { byInvoice: Record<string, Match>; extra: TwoBDoc[] } {
  const byInvoice: Record<string, Match> = {};
  if (!twob) { for (const i of invoices) byInvoice[i.id] = { status: "unchecked", doc: null, diffs: [] }; return { byInvoice, extra: [] }; }
  const used = new Set<string>();
  const last = (no: string) => invoiceKey(no).split("-").pop() ?? "";
  for (const inv of invoices) {
    const g = cleanGstin(inv.supplierGstin);
    const kind = inv.docType === "credit" ? "CN" : inv.docType === "debit" ? "DN" : "INV";
    const pool = twob.docs.filter((d) => d.gstin === g && d.kind === kind && !used.has(d.id));
    let doc = pool.find((d) => compactNo(d.number) === compactNo(inv.number)), how: Match["how"] = "exact";
    if (!doc) { doc = pool.find((d) => invoiceKey(d.number) === invoiceKey(inv.number)); how = "number"; }
    if (!doc) { doc = pool.find((d) => last(d.number) && last(d.number) === last(inv.number) && Math.abs(d.total - inv.total) <= tolerance); how = "probable"; }
    if (!doc || !inv.number) { byInvoice[inv.id] = { status: "missing", doc: null, diffs: [] }; continue; }
    used.add(doc.id);
    const diffs: string[] = [];
    const cmp = (label: string, a: number, b: number) => { if (Number.isFinite(a) && Math.abs(a - b) > tolerance) diffs.push(`${label}: invoice ${rupees(a)}, GSTR-2B ${rupees(b)}`); };
    cmp("Taxable value", inv.taxable, doc.taxable);
    cmp("GST", taxOf(inv), round2(doc.igst + doc.cgst + doc.sgst + doc.cess));
    cmp("Invoice total", inv.total, doc.total);
    if (inv.date && doc.date && inv.date !== doc.date) diffs.push(`Date: invoice ${showDate(inv.date)}, GSTR-2B ${showDate(doc.date)}`);
    if (!doc.itcAvailable) diffs.push("GSTR-2B marks ITC on this invoice as not available");
    byInvoice[inv.id] = { status: diffs.some((d) => !d.startsWith("Date")) ? "mismatch" : "matched", doc, how, diffs };
  }
  return { byInvoice, extra: twob.docs.filter((d) => !used.has(d.id)) };
}

// ---------------------------------------------------------------- ITC at risk, per invoice and in total
export type Row = { inv: Invoice; findings: Finding[]; verdict: Verdict; match: Match; tax: number; atRisk: number; why: string };

export function riskOf(inv: Invoice, findings: Finding[], match: Match): { atRisk: number; why: string } {
  const tax = round2(taxOf(inv));
  if (!Number.isFinite(tax) || tax <= 0 || inv.reverseCharge || inv.docType === "credit") return { atRisk: 0, why: "" };
  const critical = findings.find((f) => CRITICAL.has(f.code));
  if (critical) return { atRisk: tax, why: critical.title };
  if (match.status === "missing") return { atRisk: tax, why: "Not in GSTR-2B" };
  let best = { atRisk: 0, why: "" };
  if (match.status === "mismatch" && match.doc) {
    if (!match.doc.itcAvailable) return { atRisk: tax, why: "GSTR-2B says ITC not available" };
    const twobTax = match.doc.igst + match.doc.cgst + match.doc.sgst + match.doc.cess;
    const extra = round2(tax - twobTax);
    if (extra > 0.5) best = { atRisk: extra, why: "GST on invoice is more than in GSTR-2B" };
  }
  // findings that put part of the ITC at risk (e.g. the unpaid part after 180 days)
  for (const f of findings) if (f.risk && f.risk > best.atRisk) best = { atRisk: round2(Math.min(f.risk, tax)), why: f.title };
  return best;
}

// ---------------------------------------------------------------- messages to suppliers
export function supplierMessage(rows: Row[], ourGstin: string, ourName: string): string {
  const name = rows[0].inv.supplierName || "Sir/Madam";
  const missing = rows.filter((r) => r.match.status === "missing");
  const wrong = rows.filter((r) => r.match.status === "mismatch" || r.findings.some((f) => f.level === "red" && f.code !== "duplicate"));
  const line = (r: Row, i: number) => `${i + 1}. Invoice ${r.inv.number || "(no number)"} dated ${showDate(r.inv.date)}, total ${rupees(r.inv.total)}`;
  const out = [`Dear ${name},`, ""];
  if (missing.length) {
    out.push(`While checking our input tax credit${ourGstin ? ` (GSTIN ${ourGstin})` : ""}, we found that ${missing.length === 1 ? "this invoice does" : `these ${missing.length} invoices do`} not appear in our GSTR-2B:`);
    missing.forEach((r, i) => out.push(line(r, i)));
    out.push("", `Please report ${missing.length === 1 ? "it" : "them"} in your GSTR-1 / IFF against our GSTIN at the earliest.`);
  }
  const fixes = wrong.filter((r) => !missing.includes(r));
  if (fixes.length) {
    if (missing.length) out.push("");
    out.push(`${missing.length ? "Also, these invoices need" : "These invoices need"} correction:`);
    fixes.forEach((r, i) => out.push(`${line(r, i)}: ${[...r.findings.filter((f) => f.level === "red").map((f) => f.title.toLowerCase()), ...r.match.diffs].join("; ")}`));
    out.push("", "Please send corrected invoices, or amend the details in your next GSTR-1.");
  }
  out.push("", "Thank you,", ourName);
  return out.join("\n").trim();
}
