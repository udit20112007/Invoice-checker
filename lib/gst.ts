// GST facts the checks rely on: GSTIN format and check character, state codes, and the rate slabs.

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The 15th character of a GSTIN, computed from the first 14 (mod-36 checksum used by GSTN). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    if (v < 0) return "?";
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export const cleanGstin = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
const SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export type GstinCheck = { ok: boolean; reason?: string };
export function checkGstin(raw: string): GstinCheck {
  const g = cleanGstin(raw);
  if (!g) return { ok: false, reason: "missing" };
  if (g.length !== 15) return { ok: false, reason: `has ${g.length} characters instead of 15` };
  if (!SHAPE.test(g)) return { ok: false, reason: "isn't in the GSTIN format (2 digits, PAN, entity number, Z, check character)" };
  if (!STATES[g.slice(0, 2)]) return { ok: false, reason: `starts with ${g.slice(0, 2)}, which isn't a state code` };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return { ok: false, reason: "fails the check-character test, so it was mistyped or made up" };
  return { ok: true };
}
export const gstinValid = (g: string) => checkGstin(g).ok;

/** Builds a valid GSTIN from state code + PAN (+ entity number); used for demo data. */
export const makeGstin = (state: string, pan: string, entity = "1") => {
  const first = `${state}${pan}${entity}Z`;
  return first + gstinCheckChar(first);
};

export const STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};

/** "27", "27-Maharashtra", "Maharashtra (27)", "maharashtra" → "27" */
export function stateCode(s: string | undefined | null): string | null {
  if (!s) return null;
  const digits = s.match(/\b(\d{2})\b/)?.[1];
  if (digits && STATES[digits]) return digits;
  const name = s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return null;
  for (const [code, n] of Object.entries(STATES)) if (name.includes(n.toLowerCase())) return code;
  return null;
}

// GST 2.0: from 22 September 2025 the main slabs are 5%, 18% and 40%; the 12% and 28% slabs were removed.
export const GST2_DATE = "2025-09-22";
export const RATES_NOW = [0, 0.1, 0.25, 1.5, 3, 5, 18, 40];
export const RATES_BEFORE = [0, 0.1, 0.25, 1.5, 3, 5, 12, 18, 28];

/** Last date to claim ITC for an invoice: 30 November after the end of its financial year (Section 16(4)). */
export function itcDeadline(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  const fyEnd = m >= 4 ? y + 1 : y;
  return `${fyEnd}-11-30`;
}
