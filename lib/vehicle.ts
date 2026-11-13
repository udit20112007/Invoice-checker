// Indian vehicle registration numbers and e-way bill numbers: format checks that run offline.
// Owner and RC details live in VAHAN, which the public can only search on the official Parivahan site
// after an OTP login; this app links there instead of copying the data.

export const VEHICLE_STATES: Record<string, string> = {
  AN: "Andaman and Nicobar Islands", AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam", BR: "Bihar",
  CG: "Chhattisgarh", CH: "Chandigarh", DD: "Dadra and Nagar Haveli and Daman and Diu", DL: "Delhi", GA: "Goa",
  GJ: "Gujarat", HP: "Himachal Pradesh", HR: "Haryana", JH: "Jharkhand", JK: "Jammu and Kashmir", KA: "Karnataka",
  KL: "Kerala", LA: "Ladakh", LD: "Lakshadweep", MH: "Maharashtra", ML: "Meghalaya", MN: "Manipur",
  MP: "Madhya Pradesh", MZ: "Mizoram", NL: "Nagaland", OD: "Odisha", PB: "Punjab", PY: "Puducherry",
  RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu", TR: "Tripura", TG: "Telangana", UK: "Uttarakhand",
  UP: "Uttar Pradesh", WB: "West Bengal",
  // older codes still on the road
  OR: "Odisha (old code)", TS: "Telangana (old code)", UA: "Uttarakhand (old code)", DN: "Dadra and Nagar Haveli (old code)",
};

export type VehicleCheck = {
  input: string;
  clean: string;
  ok: boolean;                 // a valid-looking registration number
  kind: "state" | "bh" | "unknown";
  pretty: string;              // MH 12 AB 1234
  state?: string;
  rto?: string;
  problems: string[];          // why it isn't valid
  notes: string[];             // worth knowing
};

export const cleanVehicle = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");

export function checkVehicle(input: string): VehicleCheck {
  const clean = cleanVehicle(input);
  const res: VehicleCheck = { input, clean, ok: false, kind: "unknown", pretty: clean, problems: [], notes: [] };
  if (!clean) { res.problems.push("No vehicle number given."); return res; }

  // Bharat series: YY BH 1234 AB (year of registration, BH, 4 digits, 1–2 letters)
  const bh = clean.match(/^(\d{2})BH(\d{4})([A-Z]{1,2})$/);
  if (bh) {
    res.kind = "bh"; res.pretty = `${bh[1]} BH ${bh[2]} ${bh[3]}`;
    const year = 2000 + Number(bh[1]);
    if (year < 2021 || year > new Date().getFullYear()) res.problems.push(`BH-series numbers started in 2021; “${bh[1]}” isn't a possible registration year.`);
    if (/[IO]/.test(bh[3])) res.problems.push("The letters I and O aren't used in registration numbers.");
    res.notes.push("BH-series numbers are given to personal (non-transport) vehicles, so a goods vehicle shouldn't carry one.");
    res.ok = res.problems.length === 0;
    return res;
  }

  // State series: AA 00 (A)(AA)(A) 0000 — state code, RTO code, series letters, number
  const m = clean.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/);
  if (!m) {
    res.problems.push(clean.length > 11 ? `${clean.length} characters is too long for a registration number.` : "Doesn't follow the pattern of an Indian registration number (e.g. MH 12 AB 1234).");
    return res;
  }
  const [, st, rto, series, num] = m;
  res.kind = "state"; res.pretty = [st, rto.padStart(2, "0"), series, num.padStart(4, "0")].filter(Boolean).join(" ");
  res.rto = `${st}-${rto.padStart(2, "0")}`;
  if (!VEHICLE_STATES[st]) res.problems.push(`“${st}” isn't a state or union territory code.`);
  else res.state = VEHICLE_STATES[st];
  if (Number(rto) === 0) res.problems.push("The RTO code can't be 00.");
  if (Number(num) === 0) res.problems.push("The number part can't be 0000.");
  if (/[IO]/.test(series)) res.notes.push("Series letters I and O are normally not issued; check this number on the RC.");
  if (/^(OR|TS|UA|DN)$/.test(st)) res.notes.push("An older state code; still valid on vehicles registered before the change.");
  res.ok = res.problems.length === 0;
  return res;
}

/** An e-way bill number is 12 digits. */
export const cleanEwb = (s: unknown) => String(s ?? "").replace(/\D/g, "");
export const ewbValid = (s: string) => /^\d{12}$/.test(cleanEwb(s));

export const PARIVAHAN_URL = "https://vahan.parivahan.gov.in/nrservices/";
export const EWAYBILL_URL = "https://ewaybillgst.gov.in/";

// OCR confuses O/0, I/1, S/5, B/8, Z/2, G/6. A registration number has letters and digits in fixed
// places, so try the readings that fit; keep the number as printed if none gives a valid one.
const TO_DIGIT: Record<string, string> = { O: "0", D: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6" };
const TO_LETTER: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G" };
const as = (s: string, map: Record<string, string>) => s.split("").map((c) => map[c] ?? c).join("");
export function repairVehicle(raw: string): string {
  const c = cleanVehicle(raw);
  if (checkVehicle(c).ok) return c;
  for (const rtoLen of [2, 1]) for (const numLen of [4, 3, 2, 1]) {
    const seriesLen = c.length - 2 - rtoLen - numLen;
    if (seriesLen < 0 || seriesLen > 3) continue;
    const fixed = as(c.slice(0, 2), TO_LETTER) + as(c.slice(2, 2 + rtoLen), TO_DIGIT) + as(c.slice(2 + rtoLen, 2 + rtoLen + seriesLen), TO_LETTER) + as(c.slice(c.length - numLen), TO_DIGIT);
    if (checkVehicle(fixed).ok && checkVehicle(fixed).kind === "state") return fixed;
  }
  return raw.toUpperCase();
}
