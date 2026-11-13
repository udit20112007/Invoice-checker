// What a QR code on an invoice says. E-invoices carry a QR signed by the Invoice Registration Portal (IRP):
// a JWT whose payload holds the seller and buyer GSTIN, invoice number, type and date, total value,
// item count, main HSN code and the IRN. Comparing it with the printed invoice catches edited totals.
// This prototype decodes the payload; checking the IRP's signature needs NIC's public key (a next step).
import { cleanGstin } from "./gst.ts";
import { amount, date } from "./parse.ts";
import type { QrInfo } from "./types.ts";

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const pickKey = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) for (const [key, v] of Object.entries(o)) if (key.toLowerCase() === k.toLowerCase() && v !== undefined && v !== null) return v;
  return undefined;
};

export function decodeQr(text: string): QrInfo {
  const t = text.trim();
  // e-invoice: header.payload.signature
  const parts = t.split(".");
  if (parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
    try {
      const payload = JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>;
      const raw = pickKey(payload, "data");
      const d = (typeof raw === "string" ? JSON.parse(raw) : raw ?? payload) as Record<string, unknown>;
      const str = (...k: string[]) => String(pickKey(d, ...k) ?? "");
      return {
        kind: "einvoice",
        sellerGstin: cleanGstin(str("SellerGstin")),
        buyerGstin: cleanGstin(str("BuyerGstin")),
        docNo: str("DocNo"),
        docType: str("DocTyp", "DocType"),
        docDate: date(str("DocDt", "DocDate")),
        total: amount(str("TotInvVal")),
        itemCount: pickKey(d, "ItemCnt") !== undefined ? Number(pickKey(d, "ItemCnt")) : null,
        mainHsn: str("MainHsnCode"),
        irn: str("Irn").toLowerCase(),
        irnDate: str("IrnDt"),
        issuer: String(pickKey(payload, "iss") ?? ""),
        token: t,
      };
    } catch { /* not an e-invoice JWT */ }
  }
  if (/^upi:\/\/pay\?/i.test(t)) {
    const q = new URLSearchParams(t.replace(/^upi:\/\/pay\?/i, ""));
    const am = q.get("am");
    return { kind: "upi", payee: q.get("pa") ?? "", name: q.get("pn") ?? "", amount: am ? amount(am) : null };
  }
  return { kind: "other", text: t.slice(0, 200) };
}
