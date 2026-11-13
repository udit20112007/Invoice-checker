// A supplier's registration status (active, cancelled, suspended), from a GST data service through this
// site's /api/gstin route, or from the demo file for the demo pile.
import { date } from "./parse.ts";

export type GstinStatus = {
  gstin: string;
  status: string;              // "Active", "Cancelled", "Suspended", …
  legalName: string;
  tradeName: string;
  registeredOn: string | null; // yyyy-mm-dd
  cancelledOn: string | null;
  source: "demo" | "api";
  kind: string;                // taxpayer type: "Regular", "Composition", …
  filings: Filing[];           // returns the supplier filed, when the service reports them
};
export type Filing = { type: "GSTR1" | "GSTR3B"; period: string; filedOn: string | null };   // period: MMYYYY

function findFilings(o: unknown, depth = 0): Filing[] {
  if (!o || typeof o !== "object" || depth > 4) return [];
  if (Array.isArray(o)) {
    const rows = o.filter((x) => x && typeof x === "object" && ("rtntype" in x || "returnType" in x)) as Record<string, unknown>[];
    if (rows.length) return rows.map((x) => {
      const t = String(x.rtntype ?? x.returnType ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      return { type: t === "GSTR3B" ? "GSTR3B" as const : "GSTR1" as const, period: String(x.ret_prd ?? x.period ?? "").replace(/\D/g, "").padStart(6, "0"), filedOn: date(String(x.dof ?? x.filedOn ?? "")), ok: t === "GSTR3B" || t === "GSTR1" || t === "IFF" };
    }).filter((x) => x.ok && x.period.length === 6).map(({ ok: _ok, ...f }) => f);
    return [];
  }
  for (const v of Object.values(o)) { const r = findFilings(v, depth + 1); if (r.length) return r; }
  return [];
}

/** Due date of a monthly return: GSTR-1 on the 11th, GSTR-3B on the 20th of the next month. */
export function dueDate(type: Filing["type"], period: string): string {
  const m = Number(period.slice(0, 2)), y = Number(period.slice(2));
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-${type === "GSTR1" ? "11" : "20"}`;
}
export const lateFilings = (s: GstinStatus) => s.filings.filter((f) => f.filedOn && f.filedOn > dueDate(f.type, f.period));
export const periodOf = (isoDate: string) => `${isoDate.slice(5, 7)}${isoDate.slice(0, 4)}`;
export const periodName = (p: string) => `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(p.slice(0, 2)) - 1]} ${p.slice(2)}`;

type J = Record<string, unknown>;
// GST data services pass on the GST portal's taxpayer search fields (sts, lgnm, tradeNam, rgdt, cxdt),
// often wrapped in { data: … } or { result: … }; find them wherever they are.
function findRecord(o: unknown, depth = 0): J | null {
  if (!o || typeof o !== "object" || depth > 4) return null;
  const j = o as J;
  if ("sts" in j || "lgnm" in j || "status" in j && ("lgnm" in j || "legalName" in j)) return j;
  for (const v of Object.values(j)) { const r = findRecord(v, depth + 1); if (r) return r; }
  return null;
}

export function parseLookup(gstin: string, body: unknown, source: GstinStatus["source"] = "api"): GstinStatus | null {
  const r = findRecord(body);
  if (!r) return null;
  const s = (k: string, ...more: string[]) => { for (const key of [k, ...more]) if (r[key] !== undefined && r[key] !== null && r[key] !== "") return String(r[key]); return ""; };
  return {
    gstin, source,
    status: s("sts", "status", "gstinStatus"),
    legalName: s("lgnm", "legalName", "legal_name"),
    tradeName: s("tradeNam", "tradeName", "trade_name"),
    registeredOn: date(s("rgdt", "registrationDate")),
    cancelledOn: date(s("cxdt", "cancellationDate")),
    kind: s("dty", "taxpayerType", "taxpayer_type"),
    filings: findFilings(body),
  };
}

const words = (s: string) => new Set(s.toUpperCase().replace(/\b(M\/S|PVT|PRIVATE|LTD|LIMITED|LLP|CO|COMPANY|AND|THE|&)\b\.?/g, " ").split(/[^A-Z0-9]+/).filter((w) => w.length > 2));
/** Do two business names share their main words? ("Om Sai Cables" ~ "OM SAI CABLES PRIVATE LIMITED") */
export function namesMatch(a: string, b: string) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return true;
  let common = 0; for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size) >= 0.5;
}
