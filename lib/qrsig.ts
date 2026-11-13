// Checks the digital signature on an e-invoice QR code. The Invoice Registration Portal (IRP) signs the
// QR's JWT with its private key (RS256); only the IRP's public key verifies it, so a QR made by anyone else
// fails. Public keys are listed in /irp-keys.json: add each IRP's key from its official documentation.
// The demo key there signs only the demo invoices.
import type { EInvoiceQr } from "./types.ts";

export type IrpKey = { name: string; spki: string; demo?: boolean };

const b64urlBytes = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64Bytes = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));

const imported = new Map<string, Promise<CryptoKey | null>>();
function importKey(k: IrpKey) {
  if (!imported.has(k.spki)) imported.set(k.spki, crypto.subtle.importKey("spki", b64Bytes(k.spki), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]).catch(() => null));
  return imported.get(k.spki)!;
}

export async function verifyQr(qr: EInvoiceQr, keys: IrpKey[]): Promise<NonNullable<EInvoiceQr["signature"]>> {
  const parts = qr.token.split(".");
  if (parts.length !== 3) return { status: "invalid" };
  const real = keys.filter((k) => !k.demo);
  if (!keys.length) return { status: "no-key" };
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let sig: Uint8Array<ArrayBuffer>;
  try { sig = b64urlBytes(parts[2]); } catch { return { status: "invalid" }; }
  for (const k of keys) {
    const key = await importKey(k);
    if (key && await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data)) return { status: "verified", key: k.name, demo: !!k.demo };
  }
  // no key verified it: forged if we hold real IRP keys or the QR claims the demo issuer; otherwise unknown
  const claimsDemo = /demo|sandbox/i.test(qr.issuer);
  return real.length || claimsDemo ? { status: "invalid" } : { status: "no-key" };
}
