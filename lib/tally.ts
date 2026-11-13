// Reads purchase vouchers from a Tally XML export (Day Book or Purchase Register → Export → XML).
import { cleanGstin } from "./gst.ts";
import { amount, round2 } from "./parse.ts";
import { emptyInvoice, type Invoice } from "./types.ts";

const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const tag = (xml: string, name: string) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, "i")); return m ? unescape(m[1].trim()) : ""; };

export const isTallyXml = (text: string) => /<ENVELOPE[\s>]/i.test(text) && /<VOUCHER[\s>]/i.test(text);

export function parseTallyXml(text: string): Invoice[] {
  const out: Invoice[] = [];
  const vouchers = [...text.matchAll(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi)];
  vouchers.forEach((v, n) => {
    const body = v[2];
    const type = (v[1].match(/VCHTYPE="([^"]*)"/i)?.[1] ?? tag(body, "VOUCHERTYPENAME")).toLowerCase();
    if (!/purchase|debit note|credit note/.test(type) || /order/.test(type)) return;
    const party = tag(body, "PARTYLEDGERNAME") || tag(body, "PARTYNAME");
    const inv = emptyInvoice(`reg-${n}`, `Tally voucher ${tag(body, "VOUCHERNUMBER") || n + 1}`, "register");
    inv.readBy = "manual";
    if (/debit note/.test(type)) inv.docType = "credit";      // a debit note we raise on the supplier = their credit note
    inv.supplierName = party;
    inv.supplierGstin = cleanGstin(tag(body, "PARTYGSTIN") || tag(body, "GSTREGISTRATIONNUMBER") || tag(body, "CONSIGNEEGSTIN"));
    inv.number = tag(body, "REFERENCE") || tag(body, "VOUCHERNUMBER");
    const d = (tag(body, "REFERENCEDATE") || tag(body, "DATE")).match(/^(\d{4})(\d{2})(\d{2})$/);
    inv.date = d ? `${d[1]}-${d[2]}-${d[3]}` : null;
    let total = 0, other = 0;
    for (const e of body.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST>([\s\S]*?)<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi)) {
      const name = tag(e[1], "LEDGERNAME"), a = Math.abs(amount(tag(e[1], "AMOUNT")));
      if (!Number.isFinite(a)) continue;
      if (name === party) total = a;
      else if (/\bigst\b|integrated/i.test(name)) inv.igst += a;
      else if (/\bcgst\b|central/i.test(name)) inv.cgst += a;
      else if (/\b(sgst|utgst)\b|state/i.test(name)) inv.sgst += a;
      else if (/\bcess\b/i.test(name)) inv.cess += a;
      else if (/round/i.test(name)) inv.roundOff = round2(amount(tag(e[1], "AMOUNT")) * -1);
      else other += a;
    }
    if (!other) for (const e of body.matchAll(/<(?:ALL)?INVENTORYENTRIES\.LIST>([\s\S]*?)<\/(?:ALL)?INVENTORYENTRIES\.LIST>/gi)) { const a = Math.abs(amount(tag(e[1], "AMOUNT"))); if (Number.isFinite(a)) other += a; }
    const tax = inv.igst + inv.cgst + inv.sgst + inv.cess;
    inv.taxable = round2(other || total - tax - inv.roundOff);
    inv.total = round2(total || inv.taxable + tax + inv.roundOff);
    inv.items = [{ description: "(from Tally)", hsn: "", qty: null, taxable: inv.taxable, rate: inv.taxable ? round2((tax - inv.cess) / inv.taxable * 100) : null }];
    inv.text = `${party} | ${inv.number} | ${inv.date ?? ""} | ${inv.total}`;
    if (inv.number && (inv.supplierGstin || inv.taxable)) out.push(inv);
  });
  if (!out.length) throw new Error(vouchers.length ? "This Tally file has no purchase vouchers." : "Couldn't find any vouchers in this XML file. In Tally, export the Day Book or Purchase Register as XML.");
  return out;
}
