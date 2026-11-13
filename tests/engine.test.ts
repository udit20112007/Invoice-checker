// Tests for reading, checking and reconciling, on the demo pile in public/demo.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { checkGstin, gstinCheckChar, itcDeadline, makeGstin, stateCode } from "../lib/gst.ts";
import { amount, date, invoiceKey } from "../lib/parse.ts";
import { extractFields } from "../lib/extract.ts";
import { pdfText } from "../lib/pdftext.ts";
import { decodeQr } from "../lib/qr.ts";
import { checkInvoice, verdictOf } from "../lib/checks.ts";
import { parse2bJson } from "../lib/reconcile.ts";
import { analyse, reportXlsx } from "../lib/analyse.ts";
import { emptyInvoice, type Invoice } from "../lib/types.ts";

const DEMO = new URL("../public/demo/", import.meta.url).pathname;
const readPdf = async (f: string) => {
  const r = await pdfText(pdfjs as never, new Uint8Array(fs.readFileSync(DEMO + f)), { standardFontDataUrl: new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname });
  await r.close();
  return extractFields(r.text, emptyInvoice(f, f, "pdf"));
};

test("GSTIN check character and state codes", () => {
  assert.equal(gstinCheckChar("27AAPFU0939F1Z"), "V");          // a published example GSTIN: 27AAPFU0939F1ZV
  assert.ok(checkGstin("27AAPFU0939F1ZV").ok);
  assert.match(checkGstin("27AAPFU0939F1ZX").reason!, /check-character/);
  assert.match(checkGstin("99AAPFU0939F1ZV").reason!, /state code/);
  assert.match(checkGstin("27AAPFU0939").reason!, /11 characters/);
  assert.ok(checkGstin(makeGstin("29", "AADCK7712P")).ok);
  assert.equal(stateCode("27-Maharashtra"), "27");
  assert.equal(stateCode("Karnataka"), "29");
  assert.equal(itcDeadline("2026-10-03"), "2027-11-30");
  assert.equal(itcDeadline("2026-02-10"), "2026-11-30");
});

test("amounts, dates and invoice numbers", () => {
  assert.equal(amount("1,53,389.60"), 153389.6);
  assert.equal(amount("₹ 500/-"), 500);
  assert.equal(amount("(0.40)"), -0.4);
  assert.equal(date("17/10/2026"), "2026-10-17");
  assert.equal(date("5-Oct-26"), "2026-10-05");
  assert.equal(date("31/02/2026"), null);
  assert.equal(invoiceKey("OSC/0045/26-27"), invoiceKey("OSC-45"));
  assert.notEqual(invoiceKey("BSI/26-27/310"), invoiceKey("BSI/26-27/344"));
});

test("reads the demo invoices", async () => {
  const inv = await readPdf("invoice-07.pdf");
  assert.equal(inv.supplierName, "Bharat Electricals Ltd");
  assert.equal(inv.supplierGstin, "33AAACB9081Q1Z8");
  assert.equal(inv.buyerGstin, "27AAHCS4821K1Z3");
  assert.equal(inv.number, "BEL/IN/90342");
  assert.equal(inv.date, "2026-10-17");
  assert.deepEqual([inv.taxable, inv.igst, inv.roundOff, inv.total], [153389.6, 27610.13, 0.27, 181000]);
  assert.deepEqual(inv.items.map((i) => [i.hsn, i.qty, i.taxable, i.rate]), [["8414", 70, 153389.6, 18]]);
  assert.equal(inv.irn.length, 64);
  const two = await readPdf("invoice-01.pdf");
  assert.equal(two.items.length, 2);
  assert.deepEqual([two.cgst, two.sgst, two.total], [2754, 2754, 36108]);
});

test("OCR mistakes in a GSTIN are repaired only when the check character agrees", () => {
  const ok = extractFields("Acme Ltd\nGSTIN: 27AAPFUO939FIZV\nInvoice No: 1\nBill To: X\nGSTIN: 27AAPFU0939F1ZV");
  assert.equal(ok.supplierGstin, "27AAPFU0939F1ZV");
  const bad = extractFields("Acme Ltd\nGSTIN: 27AAPFU0939F1ZX");
  assert.equal(bad.supplierGstin, "27AAPFU0939F1ZX", "a wrong GSTIN is kept as printed, so it can be reported");
});

test("e-invoice QR payload is decoded", () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = { SellerGstin: "33AAACB9081Q1Z8", BuyerGstin: "27AAHCS4821K1Z3", DocNo: "BEL/IN/90342", DocTyp: "INV", DocDt: "17/10/2026", TotInvVal: 118000, ItemCnt: 1, MainHsnCode: "8414", Irn: "AB12", IrnDt: "2026-10-17 11:42:00" };
  const q = decodeQr(`${b64({ alg: "RS256" })}.${b64({ data: JSON.stringify(data), iss: "NIC" })}.c2ln`);
  assert.equal(q.kind, "einvoice");
  if (q.kind === "einvoice") { assert.equal(q.total, 118000); assert.equal(q.docDate, "2026-10-17"); assert.equal(q.sellerGstin, data.SellerGstin); }
  const upi = decodeQr("upi://pay?pa=shop@okbank&pn=Shop&am=250.00");
  assert.deepEqual(upi, { kind: "upi", payee: "shop@okbank", name: "Shop", amount: 250 });
});

test("the checks catch each planted problem", async () => {
  const all: Invoice[] = [];
  for (let i = 1; i <= 9; i++) all.push(await readPdf(`invoice-0${i}.pdf`));
  const codes = (n: number) => checkInvoice(all[n - 1], { ourGstin: "27AAHCS4821K1Z3", all, today: "2026-11-13" }).map((f) => f.code);
  assert.deepEqual(codes(1), []);
  assert.ok(codes(3).includes("supplier-gstin"));
  assert.ok(codes(4).includes("tax-maths"));
  assert.ok(codes(5).includes("tax-type"));
  assert.ok(codes(6).includes("old-rate"));
  assert.ok(codes(8).includes("duplicate"));
  assert.ok(codes(9).includes("hsn"));
  assert.equal(verdictOf(checkInvoice(all[5], { today: "2026-11-13", ourGstin: "27AAHCS4821K1Z3" })), "amber");
  // a tampered total is caught when the QR says something else
  const tampered = { ...all[6], qr: { kind: "einvoice" as const, sellerGstin: all[6].supplierGstin, buyerGstin: all[6].buyerGstin, docNo: all[6].number, docType: "INV", docDate: all[6].date, total: 118000, itemCount: 1, mainHsn: "8414", irn: all[6].irn, irnDate: "", issuer: "NIC", token: "" } };
  assert.ok(checkInvoice(tampered, { today: "2026-11-13" }).some((f) => f.code === "qr-mismatch"));
  // wrong buyer, future date
  assert.ok(checkInvoice(all[0], { ourGstin: "29AADCK7712P1ZX", today: "2026-11-13" }).some((f) => f.code === "buyer-mismatch"));
  assert.ok(checkInvoice({ ...all[0], date: "2027-01-01" }, { today: "2026-11-13" }).some((f) => f.code === "date-future"));
});

test("reconciliation with GSTR-2B and ITC at risk", async () => {
  const all: Invoice[] = [];
  for (let i = 1; i <= 9; i++) all.push(await readPdf(`invoice-0${i}.pdf`));
  const twob = parse2bJson(fs.readFileSync(DEMO + "GSTR-2B-Oct-2026.json", "utf8"));
  assert.equal(twob.gstin, "27AAHCS4821K1Z3");
  const a = analyse(all, twob, { today: "2026-11-13", ourName: "Sharma Electronics" });
  const status = (n: number) => a.rows[n - 1].match.status;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(status), ["matched", "matched", "missing", "mismatch", "matched", "matched", "mismatch", "missing", "missing"]);
  assert.equal(a.rows[3].atRisk, 540, "Om Sai: ₹540 more GST than reported");
  assert.equal(a.extra.map((d) => d.number).sort().join(), "AC/2026/214,DF/1043,GLC/2026/0398,GLC/2026/0431,KA/2026/77,KCP/26-27/1203,KCP/CN/26-27/031,SSE/118,SSE/119", "reported but not uploaded (the photo isn't in this test)");
  const sunrise = a.suppliers.find((s) => s.name === "Sunrise Wires")!;
  assert.match(sunrise.message, /SW-2210/);
  assert.ok(!a.suppliers.some((s) => s.name === "Ganesh Lighting Co"), "a duplicate entry isn't the supplier's problem");
  const x = reportXlsx(a, "102026");
  assert.ok(x.length > 3000 && x[0] === 0x50 && x[1] === 0x4b, "report is a zip-based xlsx");
});

test("GSTR-2B Excel (portal layout) and zip are read", async () => {
  const { writeXlsx } = await import("../lib/xlsx.ts");
  const { read2bFile } = await import("../lib/reconcile.ts");
  const { zipSync } = await import("fflate");
  const x = writeXlsx([{ name: "Read me", rows: [["GSTIN 27AAHCS4821K1Z3"]], heading: false }, { name: "B2B", heading: false, rows: [
    ["Goods and Services Tax - GSTR-2B"], ["Taxable inward supplies received from registered persons"],
    ["GSTIN of supplier", "Trade/Legal name", "Invoice details", "", "", "", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Tax Amount", "", "", "", "GSTR-1/IFF/GSTR-5 Period", "GSTR-1/IFF/GSTR-5 Filing Date", "ITC Availability"],
    ["", "", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "", "", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)"],
    ["27AAJFG3150M1Z7", "GANESH LIGHTING CO", "GLC/2026/0412", "Regular", "03/10/2026", 36108, "27-Maharashtra", "N", 30600, 0, 2754, 2754, 0, "Oct-2026", "11/11/2026", "Yes"],
  ] }]);
  const t = await read2bFile("GSTR2B.xlsx", x);
  assert.equal(t.docs.length, 1);
  assert.deepEqual([t.docs[0].number, t.docs[0].date, t.docs[0].taxable, t.docs[0].cgst, t.docs[0].total], ["GLC/2026/0412", "2026-10-03", 30600, 2754, 36108]);
  assert.equal(t.gstin, "27AAHCS4821K1Z3");
  const z = zipSync({ "returns_102026_R2B.json": new TextEncoder().encode(fs.readFileSync(DEMO + "GSTR-2B-Oct-2026.json", "utf8")) });
  assert.equal((await read2bFile("GSTR2B.zip", z)).docs.length, 15);
});

test("vehicle numbers and e-way bills", async () => {
  const { checkVehicle, ewbValid } = await import("../lib/vehicle.ts");
  const ok = checkVehicle("mh 14 gt 4521");
  assert.ok(ok.ok); assert.equal(ok.pretty, "MH 14 GT 4521"); assert.equal(ok.state, "Maharashtra"); assert.equal(ok.rto, "MH-14");
  assert.ok(checkVehicle("DL3CAB1234").ok);
  assert.ok(checkVehicle("TG07UA4412").ok);
  assert.ok(checkVehicle("22BH1234AA").ok && checkVehicle("22BH1234AA").kind === "bh");
  assert.match(checkVehicle("MX12AB1234").problems[0], /isn't a state/);
  assert.match(checkVehicle("MH12AB0000").problems[0], /0000/);
  assert.ok(!checkVehicle("MH12AB12345").ok);
  assert.ok(!checkVehicle("15BH1234AA").ok, "BH series started in 2021");
  const { repairVehicle } = await import("../lib/vehicle.ts");
  assert.equal(repairVehicle("TGO7UA4412"), "TG07UA4412");
  assert.equal(repairVehicle("MH I2 AB 1234"), "MH12AB1234");
  assert.equal(repairVehicle("MX12AB1234"), "MX12AB1234", "a wrong state code isn't 'repaired'");
  assert.ok(ewbValid("3310 0987 6543")); assert.ok(!ewbValid("33100987654"));
  const seven = await readPdf("invoice-07.pdf");
  assert.equal(seven.vehicle, "TN05BX3018"); assert.equal(seven.ewayBill, "331009876543");
  const three = await readPdf("invoice-03.pdf");
  assert.equal(three.vehicle, "MX12AB1234");
  assert.ok(checkInvoice(three, { today: "2026-11-13" }).some((f) => f.code === "vehicle"));
  assert.ok(checkInvoice({ ...seven, ewayBill: "" }, { today: "2026-11-13" }).some((f) => f.code === "ewb-missing"));
  assert.ok(!checkInvoice(seven, { today: "2026-11-13" }).some((f) => (f.code.startsWith("ewb") && f.level !== "info") || f.code === "vehicle"));
});
