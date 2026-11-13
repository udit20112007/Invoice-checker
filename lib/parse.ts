// Turning what's printed on invoices into numbers and dates.

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "1,23,456.50", "₹ 500", "Rs. 500/-", "(250.00)" → numbers; NaN when there's no number */
export function amount(v: unknown): number {
  if (typeof v === "number") return v;
  let s = String(v ?? "").trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/₹|rs\.?|inr|\/-|,|\s/gi, "");
  if (s.startsWith("-")) { neg = true; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return neg ? -Number(s) : Number(s);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/** Indian dates (day first): 05/10/2026, 5-10-26, 05.10.2026, 5 Oct 2026, 05-Oct-2026, 2026-10-05 → "2026-10-05" */
export function date(v: unknown): string | null {
  const s = String(v ?? "").trim();
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4}|\d{2})(?!\d)/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = s.match(/(\d{1,2})[-/ ]*([A-Za-z]{3})[A-Za-z]*[-/ ,]*(\d{4}|\d{2})(?!\d)/);
  if (m && MONTHS.includes(m[2].toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return null;
}
export const showDate = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : "—");

/** The same bill is written "INV/0045/26-27", "INV-45" or "45": keep the identifying part only. */
export function invoiceKey(no: string): string {
  let t = String(no ?? "").toUpperCase();
  // drop financial-year parts such as 2026-27, 26-27, FY27
  t = t.replace(/(?<!\d)(?:20)?(\d{2})\s*[-/]\s*(?:20)?(\d{2})(?!\d)/g, (all, a, b) => ((+b - +a + 100) % 100 === 1 ? " " : all));
  t = t.replace(/\bFY\s*\d{2,4}\b/g, " ");
  const digits = t.match(/\d+/g);
  if (digits) return digits.map((d) => d.replace(/^0+(?=\d)/, "")).join("-");
  return t.replace(/[^0-9A-Z]/g, "");
}
export const compactNo = (no: string) => String(no ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");

export const rupees = (n: number, decimals = 2) =>
  Number.isFinite(n) ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}` : "—";
