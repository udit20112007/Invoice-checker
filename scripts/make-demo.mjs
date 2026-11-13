// Makes the demo pile in public/demo: 9 invoice PDFs and 1 phone-style photo from fictional businesses,
// each with a planted problem (or none), plus the matching GSTR-2B JSON for October 2026.
// Run: npm run demo-files   (needs the dev dependencies and Playwright for the photo)
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { makeGstin } from "../lib/gst.ts";

const OUT = new URL("../public/demo/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const BUYER = { name: "Sharma Electronics Pvt Ltd", address: "14 Lamington Road, Mumbai 400007", gstin: makeGstin("27", "AAHCS4821K") };
const S = {
  ganesh: { name: "Ganesh Lighting Co", address: "Plot 22, MIDC Bhosari, Pune 411026", gstin: makeGstin("27", "AAJFG3150M"), state: "27" },
  kaveri: { name: "Kaveri Components Pvt Ltd", address: "88 Peenya Industrial Area, Bengaluru 560058", gstin: makeGstin("29", "AADCK7712P"), state: "29" },
  prime: { name: "Prime Traders", address: "Shop 5, Crawford Market, Mumbai 400001", gstin: makeGstin("27", "ABMPT1234Q").slice(0, 14) + "X", state: "27" },
  omsai: { name: "Om Sai Cables", address: "Gala 9, Vasai East, Palghar 401208", gstin: makeGstin("27", "AAPFO2218C"), state: "27" },
  mehta: { name: "Mehta Switchgear", address: "31 Kalbadevi Road, Mumbai 400002", gstin: makeGstin("27", "AEZPM6630B"), state: "27" },
  unity: { name: "Unity Plastics", address: "GIDC Vatva, Ahmedabad 382445", gstin: makeGstin("24", "AABFU5521J"), state: "24" },
  bharat: { name: "Bharat Electricals Ltd", address: "12 Ambattur Industrial Estate, Chennai 600058", gstin: makeGstin("33", "AAACB9081Q"), state: "33" },
  sunrise: { name: "Sunrise Wires", address: "Unit 3, Wagle Estate, Thane 400604", gstin: makeGstin("27", "AAZFS3390K"), state: "27" },
  deccan: { name: "Deccan Fasteners", address: "Balanagar, Hyderabad 500037", gstin: makeGstin("36", "AAGFD7754P"), state: "36" },
  shiv: { name: "Shiv Shakti Enterprises", address: "Bhiwandi, Thane 421302", gstin: makeGstin("27", "AEHFS6102L"), state: "27" },
  royal: { name: "Royal Cables", address: "Shop 14, Lohar Chawl, Mumbai 400002", gstin: makeGstin("27", "ATRPR2846D"), state: "27" },
  annapurna: { name: "Annapurna Caterers", address: "Girgaon, Mumbai 400004", gstin: makeGstin("27", "AALFA4417R"), state: "27" },
  kumar: { name: "Kumar Agencies", address: "Ulhasnagar 421003", gstin: makeGstin("27", "AKHPK7350F"), state: "27" },
};
const STATE_NAMES = { "27": "Maharashtra" };
const r2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const addDaysIso = (iso, n) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// file, supplier, number, date, items [desc, hsn, qty, rate, gst%], and what's planted
const INVOICES = [
  { file: "invoice-01.pdf", sup: S.ganesh, no: "GLC/2026/0412", date: "2026-10-03", vehicle: "MH14GT4521", items: [["LED Panel Light 18W", "9405", 40, 450, 18], ["LED Batten 20W", "9405", 60, 210, 18]], note: "Clean" },
  { file: "invoice-02.pdf", sup: S.kaveri, no: "KCP/26-27/1187", date: "2026-10-06", vehicle: "KA02AB7781", items: [["Modular Switch 6A", "8536", 500, 38, 18], ["Switch Plate 8M", "3925", 200, 95, 18]], einvoice: true, note: "Clean e-invoice with a valid QR" },
  { file: "invoice-03.pdf", sup: S.prime, no: "PT-559", date: "2026-10-08", vehicle: "MX12AB1234", items: [["MCB 32A Double Pole", "8536", 50, 620, 18]], note: "Supplier GSTIN fails the check character, and a made-up vehicle number" },
  { file: "invoice-04.pdf", sup: S.omsai, no: "OSC/0045/26-27", date: "2026-10-10", vehicle: "MH48BY2290", items: [["Copper Cable 1.5 sq mm (90 m)", "8544", 20, 1250, 18]], tax: { cgst: 2520, sgst: 2520 }, note: "CGST and SGST charged at the wrong amount" },
  { file: "invoice-05.pdf", sup: S.mehta, no: "MS/779", date: "2026-10-13", items: [["Distribution Board 8-Way", "8537", 15, 1840, 18]], igstLocal: true, note: "IGST charged on a same-state sale" },
  { file: "invoice-06.pdf", sup: S.unity, no: "UP-2026-311", date: "2026-10-15", vehicle: "GJ01DV5532", items: [["PVC Conduit Pipe 25 mm", "3917", 300, 85, 12]], note: "Old 12% rate after GST 2.0" },
  { file: "invoice-07.pdf", sup: S.bharat, no: "BEL/IN/90342", date: "2026-10-17", vehicle: "TN05BX3018", ewb: "331009876543", km: 1340, ewbDate: "2026-10-17", items: [["Ceiling Fan 1200 mm", "8414", 70, 2191.28, 18]], einvoice: true, edited: true, qrTotal: 118000, note: "Printed total edited: QR says ₹1,18,000" },
  { file: "invoice-08.pdf", sup: S.ganesh, no: "GLC/2026/0412", date: "2026-10-03", vehicle: "MH14GT4521", items: [["LED Panel Light 18W", "9405", 40, 450, 18], ["LED Batten 20W", "9405", 60, 210, 18]], note: "Duplicate of invoice 1" },
  { file: "invoice-09.pdf", sup: S.sunrise, no: "SW-2210", date: "2026-10-21", vehicle: "MH04JK8810", items: [["Flexible Wire 0.75 sq mm (90 m)", "", 30, 780, 18]], note: "Not filed by the supplier, and no HSN code" },
  { file: "invoice-10-photo.png", sup: S.deccan, no: "DF/1043", date: "2026-10-24", vehicle: "TG07UA4412", items: [["Anchor Bolt M10 x 100", "7318", 1000, 14.5, 18], ["Self Tapping Screw 8 x 1", "7318", 5000, 1.2, 18]], photo: true, note: "Clean, as a phone photo" },
  { file: "invoice-11.pdf", sup: S.shiv, no: "SSE/118", date: "2026-10-27", vehicle: "MH43AB9921", bank: "50200041778812", phone: "98200 41778", items: [["Electrical Wire 1.0 sq mm (90 m)", "8544", 40, 1037.5, 18]], note: "Split bill 1 of 2: just under ₹50,000" },
  { file: "invoice-12.pdf", sup: S.shiv, no: "SSE/119", date: "2026-10-27", vehicle: "MH43AB9921", bank: "50200041778812", phone: "98200 41778", items: [["Electrical Wire 1.0 sq mm (90 m)", "8544", 39, 1050, 18]], note: "Split bill 2 of 2: same day, same lorry" },
  { file: "invoice-13.pdf", sup: S.royal, no: "RC/120", date: "2026-10-28", vehicle: "MH01CK5530", items: [["Armoured Cable 4 core 16 sq mm (50 m)", "8544", 6, 6850, 18]], einvoice: true, forged: true, bank: "50200041778812", note: "Forged e-invoice QR; number follows Shiv Shakti's bill; new GSTIN; same bank account as Shiv Shakti" },
  { file: "invoice-14.pdf", sup: S.kaveri, no: "KCP/CN/26-27/031", date: "2026-10-20", credit: true, ref: "KCP/26-27/1187", items: [["Modular Switch 6A (returned)", "8536", 50, 38, 18]], note: "Credit note against invoice 2: reduces ITC" },
  { file: "invoice-15.pdf", sup: S.annapurna, no: "AC/2026/214", date: "2026-10-22", items: [["Staff lunch catering (160 plates)", "996334", 160, 50, 5]], note: "Correct invoice, but ITC on food and catering is blocked" },
  { file: "bundle-a", bundle: "invoice-16-bundle.pdf", sup: S.ganesh, no: "GLC/2026/0431", date: "2026-10-29", vehicle: "MH14GT4521", items: [["LED Flood Light 50W", "9405", 20, 890, 18]], note: "Clean; page 1 of a two-invoice PDF" },
  { file: "bundle-b", bundle: "invoice-16-bundle.pdf", sup: S.kaveri, no: "KCP/26-27/1203", date: "2026-10-30", vehicle: "KA02AB7781", einvoice: true, items: [["Modular Socket 16A", "8536", 300, 62, 18]], note: "Clean; page 2 of a two-invoice PDF" },
];

function build(inv) {
  const items = inv.items.map(([desc, hsn, qty, rate, gst]) => ({ desc, hsn, qty, rate, gst, taxable: r2(qty * rate) }));
  const taxable = r2(items.reduce((a, it) => a + it.taxable, 0));
  const fullTax = r2(items.reduce((a, it) => a + (it.taxable * it.gst) / 100, 0));
  const intra = inv.sup.state === "27";
  let cgst = 0, sgst = 0, igst = 0;
  if (inv.tax) ({ cgst, sgst } = inv.tax);
  else if (intra && !inv.igstLocal) { cgst = r2(fullTax / 2); sgst = r2(fullTax - cgst); }
  else igst = fullTax;
  const exact = r2(taxable + cgst + sgst + igst);
  const total = Math.round(exact), roundOff = r2(total - exact);
  return { ...inv, items, taxable, cgst, sgst, igst, total, roundOff, fullTax };
}
const DATA = INVOICES.map(build);

// the e-invoice QR: a JWT shaped like the IRP's (header.payload.signature). The signature here is a
// placeholder, because only the government portal can sign real ones.
const b64url = (s) => Buffer.from(s).toString("base64url");
function irnOf(d) { return createHash("sha256").update(`${d.sup.gstin}|${d.no}|2026-27`).digest("hex"); }
// a demo Invoice Registration Portal key: signs the demo QRs, so the app can check signatures.
// Only its public half is saved (public/irp-keys.json); the forged invoice is signed with another key.
const irp = generateKeyPairSync("rsa", { modulusLength: 2048 }), forger = generateKeyPairSync("rsa", { modulusLength: 2048 });
writeFileSync(new URL("../public/irp-keys.json", import.meta.url), JSON.stringify({
  note: "Public keys of the Invoice Registration Portals (IRPs) that sign e-invoice QR codes. Add each IRP's key (base64 SPKI) from its official documentation. The demo key only signs this app's demo invoices.",
  keys: [{ name: "Demo IRP key (demo invoices only)", demo: true, spki: irp.publicKey.export({ type: "spki", format: "der" }).toString("base64") }],
}, null, 1));
function qrJwt(d) {
  const data = { SellerGstin: d.sup.gstin, BuyerGstin: BUYER.gstin, DocNo: d.no, DocTyp: "INV", DocDt: dmy(d.date), TotInvVal: d.qrTotal ?? d.total, ItemCnt: d.items.length, MainHsnCode: d.items[0].hsn, Irn: irnOf(d), IrnDt: `${d.date} 11:42:00` };
  const body = `${b64url(JSON.stringify({ alg: "RS256", kid: "DEMO", typ: "JWT" }))}.${b64url(JSON.stringify({ data: JSON.stringify(data), iss: "NIC Sandbox (demo)" }))}`;
  return `${body}.${sign("sha256", Buffer.from(body), (d.forged ? forger : irp).privateKey).toString("base64url")}`;
}

async function pdf(one) {
  const all = [].concat(one);
  const doc = await PDFDocument.create();
  doc.setTitle(all.map((d) => `${d.credit ? "Credit note" : "Tax invoice"} ${d.no}`).join(", ")); doc.setAuthor(all[0].sup.name); doc.setCreator("Invoice Checker demo data");
  // billing software writes the PDF once, on the invoice date; invoice 7 was "edited" three days later
  const made = new Date(`${all[0].date}T06:12:00Z`);
  doc.setCreationDate(made); doc.setModificationDate(all[0].edited ? new Date(made.getTime() + 3 * 864e5) : made);
  doc.setProducer(all[0].edited ? "iLovePDF" : "Demo Billing 4.2");
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const d of all) {
  const page = doc.addPage([595.28, 841.89]);
  const ink = rgb(0.1, 0.12, 0.16), grey = rgb(0.4, 0.42, 0.47), line = rgb(0.8, 0.82, 0.85);
  const t = (s, x, y, o = {}) => page.drawText(String(s), { x, y, size: o.size ?? 9.5, font: o.bold ? bold : font, color: o.color ?? ink });
  const tr = (s, xr, y, o = {}) => t(s, xr - (o.bold ? bold : font).widthOfTextAtSize(String(s), o.size ?? 9.5), y, o);
  const hr = (y) => page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.6, color: line });
  let y = 800;
  t(d.sup.name, 40, y, { size: 16, bold: true }); tr(d.credit ? "CREDIT NOTE" : "TAX INVOICE", 555, y, { size: 13, bold: true });
  y -= 16; t(d.sup.address, 40, y, { color: grey });
  y -= 13; t(`GSTIN: ${d.sup.gstin}`, 40, y);
  y -= 26;
  if (d.einvoice) {
    const png = await QRCode.toBuffer(qrJwt(d), { errorCorrectionLevel: "L", margin: 2, scale: 6 });
    const img = await doc.embedPng(png);
    page.drawImage(img, { x: 425, y: y - 118, width: 130, height: 130 });
    t(`IRN: ${irnOf(d)}`, 40, 60, { size: 7.5, color: grey });
    t(`Ack No: 1126${d.no.replace(/\D/g, "").slice(-6).padStart(6, "0")}  Ack Date: ${dmy(d.date)}`, 40, 48, { size: 7.5, color: grey });
  }
  t(`${d.credit ? "Credit Note" : "Invoice"} No: ${d.no}`, 40, y, { bold: true });
  y -= 14; t(`${d.credit ? "Credit Note" : "Invoice"} Date: ${dmy(d.date)}`, 40, y);
  if (d.ref) { y -= 14; t(`Against Invoice No: ${d.ref}`, 40, y); }
  y -= 14; t(`Place of Supply: 27-${STATE_NAMES["27"]}`, 40, y);
  y -= 14; t("Reverse Charge: No", 40, y);
  if (d.vehicle) { y -= 14; t(`Vehicle No: ${d.vehicle}`, 40, y); }
  if (d.ewb) { y -= 14; t(`E-Way Bill No: ${d.ewb}`, 40, y); }
  if (d.ewbDate) { y -= 14; t(`E-Way Bill Date: ${dmy(d.ewbDate)}`, 40, y); }
  if (d.km) { y -= 14; t(`Distance: ${d.km} km`, 40, y); }
  if (d.bank) t(`Bank: HDFC Bank, A/c No: ${d.bank}, IFSC: HDFC0000542`, 40, 96, { size: 8.5, color: grey });
  if (d.phone) t(`Phone: ${d.phone}`, 40, 84, { size: 8.5, color: grey });
  y -= 24; t("Bill To:", 40, y, { bold: true });
  y -= 14; t(BUYER.name, 40, y);
  y -= 13; t(BUYER.address, 40, y, { color: grey });
  y -= 13; t(`GSTIN: ${BUYER.gstin}`, 40, y);
  y = Math.min(y, 610) - 30; hr(y + 14);
  const cols = { no: 40, desc: 58, hsn: 270, qty: 340, rate: 410, taxable: 495, gst: 555 };
  t("#", cols.no, y, { bold: true }); t("Description", cols.desc, y, { bold: true }); t("HSN/SAC", cols.hsn, y, { bold: true });
  tr("Qty", cols.qty, y, { bold: true }); tr("Rate", cols.rate, y, { bold: true }); tr("Taxable Value", cols.taxable, y, { bold: true }); tr("GST %", cols.gst, y, { bold: true });
  y -= 6; hr(y);
  d.items.forEach((it, i) => {
    y -= 16;
    t(i + 1, cols.no, y); t(it.desc, cols.desc, y); if (it.hsn) t(it.hsn, cols.hsn, y);
    tr(it.qty, cols.qty, y); tr(fmt(it.rate), cols.rate, y); tr(fmt(it.taxable), cols.taxable, y); tr(`${it.gst}%`, cols.gst, y);
  });
  y -= 10; hr(y);
  const rate = d.items[0].gst;
  const rows = [["Taxable Value", d.taxable]];
  if (d.cgst) rows.push([`CGST @ ${rate / 2}%`, d.cgst], [`SGST @ ${rate / 2}%`, d.sgst]);
  if (d.igst) rows.push([`IGST @ ${rate}%`, d.igst]);
  rows.push(["Round Off", d.roundOff]);
  for (const [label, v] of rows) { y -= 16; t(label, 330, y); tr(fmt(v), 555, y); }
  y -= 8; page.drawLine({ start: { x: 330, y }, end: { x: 555, y }, thickness: 0.8, color: ink });
  y -= 16; t("Total", 330, y, { bold: true, size: 11 }); tr(`${fmt(d.total)}`, 555, y, { bold: true, size: 11 });
  y -= 40; t(`For ${d.sup.name}`, 380, y, { color: grey }); y -= 30; t("Authorised Signatory", 400, y, { color: grey });
  }
  return doc.save();
}

// a phone-style photo: the same invoice drawn as a page, slightly tilted, on a desk
async function photo(d) {
  const require = createRequire(import.meta.url);
  const { chromium } = require("playwright");
  const rows = d.items.map((it, i) => `<tr><td>${i + 1}</td><td>${it.desc}</td><td>${it.hsn}</td><td class=r>${it.qty}</td><td class=r>${fmt(it.rate)}</td><td class=r>${fmt(it.taxable)}</td><td class=r>${it.gst}%</td></tr>`).join("");
  const html = `<html><body style="margin:0;background:#8a8378;width:1000px;height:1300px;display:grid;place-items:center;font-family:Arial,sans-serif">
  <div style="width:820px;background:#fbfaf6;padding:44px 50px;transform:rotate(-1.2deg);box-shadow:0 18px 40px rgba(0,0,0,.35);color:#1d2230;font-size:17px;line-height:1.45">
  <div style="display:flex;justify-content:space-between"><b style="font-size:28px">${d.sup.name}</b><b style="font-size:22px">TAX INVOICE</b></div>
  <div style="color:#555">${d.sup.address}</div><div>GSTIN: ${d.sup.gstin}</div><br>
  <div><b>Invoice No: ${d.no}</b></div><div>Invoice Date: ${dmy(d.date)}</div><div>Place of Supply: 27-Maharashtra</div><div>Reverse Charge: No</div>${d.vehicle ? `<div>Vehicle No: ${d.vehicle}</div>` : ""}<br>
  <div><b>Bill To:</b></div><div>${BUYER.name}</div><div style="color:#555">${BUYER.address}</div><div>GSTIN: ${BUYER.gstin}</div><br>
  <style>td,th{padding:6px 8px;text-align:left}.r{text-align:right}table{border-collapse:collapse;width:100%}th{border-bottom:1px solid #999}</style>
  <table><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th class=r>Qty</th><th class=r>Rate</th><th class=r>Taxable Value</th><th class=r>GST %</th></tr>${rows}</table><br>
  <table style="width:55%;margin-left:45%"><tr><td>Taxable Value</td><td class=r>${fmt(d.taxable)}</td></tr><tr><td>IGST @ 18%</td><td class=r>${fmt(d.igst)}</td></tr><tr><td>Round Off</td><td class=r>${fmt(d.roundOff)}</td></tr><tr><td><b>Total</b></td><td class=r><b>${fmt(d.total)}</b></td></tr></table>
  <br><div style="text-align:right;color:#555">For ${d.sup.name}<br><br>Authorised Signatory</div></div></body></html>`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
  await page.setContent(html);
  const png = await page.screenshot({ type: "png" });
  await browser.close();
  return png;
}

for (const d of DATA.filter((x) => !x.bundle)) writeFileSync(OUT + d.file, d.photo ? await photo(d) : await pdf(d));
// one PDF with two invoices in it, as a scanned bundle would be
for (const name of new Set(DATA.filter((x) => x.bundle).map((x) => x.bundle))) writeFileSync(OUT + name, await pdf(DATA.filter((x) => x.bundle === name)));
const FILES = [...new Set(DATA.map((d) => d.bundle ?? d.file))];

// GSTR-2B for October 2026, as the suppliers reported it. Not in it: Prime Traders (invalid GSTIN),
// Sunrise Wires (didn't file) and the duplicate. Om Sai filed the correct tax; Bharat filed ₹1,18,000.
// Ganesh also filed an invoice that isn't in the uploaded pile.
const filed = (d, over = {}) => {
  const taxable = over.taxable ?? d.taxable, tax = over.tax ?? (d.tax ? d.fullTax : r2(d.cgst + d.sgst + d.igst));
  const intra = d.sup.state === "27" && !d.igstLocal;
  return { inum: d.no, dt: d.date.split("-").reverse().join("-"), val: over.val ?? Math.round(taxable + tax), pos: "27", rev: "N", typ: "R", itcavl: "Y", rsn: "", diffprcnt: 1, srctyp: d.einvoice ? "e-Invoice" : "", irn: d.einvoice ? irnOf(d) : "", irngendate: d.einvoice ? d.date.split("-").reverse().join("-") : "",
    txval: taxable, igst: intra ? 0 : tax, cgst: intra ? r2(tax / 2) : 0, sgst: intra ? r2(tax - r2(tax / 2)) : 0, cess: 0 };
};
const byFile = Object.fromEntries(DATA.map((d) => [d.file, d]));
const b2b = new Map();
const put = (d, inv) => { const e = b2b.get(d.sup.gstin) ?? { ctin: d.sup.gstin, trdnm: d.sup.name.toUpperCase(), supprd: "102026", supfildt: "11-11-2026", inv: [] }; e.inv.push(inv); b2b.set(d.sup.gstin, e); };
put(byFile["invoice-01.pdf"], filed(byFile["invoice-01.pdf"]));
put(byFile["invoice-01.pdf"], { ...filed(byFile["invoice-01.pdf"]), inum: "GLC/2026/0398", dt: "28-09-2026", txval: 9600, cgst: 864, sgst: 864, val: 11328 });
for (const f of ["invoice-02.pdf", "invoice-05.pdf", "invoice-06.pdf", "invoice-10-photo.png", "invoice-11.pdf", "invoice-12.pdf", "invoice-15.pdf", "bundle-a", "bundle-b"]) put(byFile[f], filed(byFile[f]));
// the credit note, as Kaveri reported it
const cn = byFile["invoice-14.pdf"], cnFiled = filed(cn);
const cdnr = [{ ctin: cn.sup.gstin, trdnm: cn.sup.name.toUpperCase(), supprd: "102026", supfildt: "11-11-2026", nt: [{ ...cnFiled, inum: undefined, ntnum: cn.no, typ: "C", suptyp: "R" }] }];
// Kumar Agencies: an April purchase that's only in the register; the supplier filed it late, in October
const kumar = build({ sup: S.kumar, no: "KA/2026/77", date: "2026-04-25", items: [["Switch Boards (assorted)", "8537", 25, 1600, 18]] });
put(kumar, filed(kumar));
put(byFile["invoice-04.pdf"], filed(byFile["invoice-04.pdf"]));
put(byFile["invoice-07.pdf"], filed(byFile["invoice-07.pdf"], { taxable: 100000, tax: 18000, val: 118000 }));
const twob = { chksum: "demo", data: { gstin: BUYER.gstin, rtnprd: "102026", version: "1.0", gendt: "14-11-2026", docdata: { b2b: [...b2b.values()], cdnr } } };
writeFileSync(OUT + "GSTR-2B-Oct-2026.json", JSON.stringify(twob, null, 1));

// The purchase register as Tally exports it: the uploaded bills plus Kumar Agencies' April bill
const regRows = [["Sharma Electronics Pvt Ltd"], ["Purchase Register: 1-Apr-2026 to 31-Oct-2026"], [],
  ["Date", "Particulars", "Voucher Type", "Vch No.", "Supplier Invoice No.", "GSTIN/UIN", "Taxable Value", "IGST", "CGST", "SGST", "Cess", "Gross Total"]];
let vch = 100;
for (const d of [kumar, ...DATA.filter((x) => x.file !== "invoice-08.pdf" && !x.credit)].sort((a, b) => a.date.localeCompare(b.date)))
  regRows.push([d.date.split("-").reverse().join("-"), d.sup.name, "Purchase", String(++vch), d.no, d.sup.gstin, d.taxable, d.igst || "", d.cgst || "", d.sgst || "", "", d.total]);
const { writeXlsx } = await import("../lib/xlsx.ts");
writeFileSync(OUT + "purchase-register.xlsx", writeXlsx([{ name: "Purchase Register", heading: false, rows: regRows }]));

// Payments made so far (from the bank statement): Kumar Agencies' April bill is still unpaid
const paid = ["invoice-01.pdf", "invoice-02.pdf", "invoice-04.pdf", "invoice-05.pdf", "invoice-06.pdf", "invoice-07.pdf", "invoice-10-photo.png"].map((f) => byFile[f]);
writeFileSync(OUT + "payments.csv", ["Payment Date,Supplier GSTIN,Against Invoice No,Amount Paid", ...paid.map((d) => `${dmy(addDaysIso(d.date, 20))},${d.sup.gstin},${d.no},${d.total}`), `${dmy("2026-10-30")},${S.sunrise.gstin},SW-2210,10000`].join("\n"));

// Supplier registrations, as a GST data service would report them (demo data, made up for these fictional firms)
const filing = (rtntype, ret_prd, dof) => ({ rtntype, ret_prd, dof, status: "Filed", mof: "ONLINE" });
const onTime = (months) => months.flatMap((m) => { const next = String(Number(m) + 1).padStart(2, "0"); return [filing("GSTR1", `${m}2026`, `10-${next}-2026`), filing("GSTR3B", `${m}2026`, `19-${next}-2026`)]; });
const reg = (sup, legal, rgdt, extra = {}) => [sup.gstin, { sts: "Active", lgnm: legal, tradeNam: sup.name.toUpperCase(), rgdt, cxdt: "", dty: "Regular", ...extra }];
writeFileSync(OUT + "gstin-status.json", JSON.stringify({ note: "Demo data for the fictional suppliers in the demo pile.", records: Object.fromEntries([
  reg(S.ganesh, "GANESH LIGHTING CO", "12/07/2018"), reg(S.kaveri, "KAVERI COMPONENTS PRIVATE LIMITED", "01/07/2017"), reg(S.omsai, "OM SAI CABLES", "19/03/2019", { EFiledlist: [filing("GSTR1", "072026", "10-08-2026"), filing("GSTR3B", "072026", "28-08-2026"), filing("GSTR1", "082026", "11-09-2026"), filing("GSTR3B", "082026", "02-10-2026"), filing("GSTR1", "092026", "15-10-2026"), filing("GSTR3B", "092026", "20-10-2026")] }),
  reg(S.mehta, "MEHTA SWITCHGEAR", "05/11/2020"), reg(S.unity, "VARDHMAN POLYMERS", "22/08/2017", { tradeNam: "VARDHMAN POLYMERS" }), reg(S.bharat, "BHARAT ELECTRICALS LIMITED", "01/07/2017"),
  reg(S.sunrise, "SUNRISE WIRES", "14/02/2021", { sts: "Cancelled", cxdt: "30/09/2026" }), reg(S.deccan, "DECCAN FASTENERS", "09/06/2022"),
  reg(S.shiv, "SHIV SHAKTI ENTERPRISES", "17/01/2024"), reg(S.royal, "ROYAL CABLES", "02/10/2026"), reg(S.kumar, "KUMAR AGENCIES", "11/04/2019", { EFiledlist: onTime(["05", "06", "07", "08", "09"]) }), reg(S.annapurna, "ANNAPURNA CATERERS", "03/08/2020"),
]) }, null, 1));

writeFileSync(OUT + "manifest.json", JSON.stringify({ buyer: BUYER, files: FILES.map((f) => ({ file: f, note: DATA.filter((d) => (d.bundle ?? d.file) === f).map((d) => d.note).join(" / ") })), twob: "GSTR-2B-Oct-2026.json", register: "purchase-register.xlsx", payments: "payments.csv", gstinStatus: "gstin-status.json" }, null, 1));
console.log(DATA.map((d) => `${d.file.padEnd(22)} ${d.sup.gstin} ${d.no.padEnd(16)} taxable ${fmt(d.taxable).padStart(12)} total ${fmt(d.total).padStart(12)}  ${d.note}`).join("\n"));
