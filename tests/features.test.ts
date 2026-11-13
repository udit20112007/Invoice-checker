// Tests for the QR signature check, supplier registration, 180-day rule, register import and patterns.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyQr } from "../lib/qrsig.ts";
import { decodeQr } from "../lib/qr.ts";
import { checkInvoice } from "../lib/checks.ts";
import { parseLookup, namesMatch } from "../lib/gstinstatus.ts";
import { parsePayments, paidFor } from "../lib/payments.ts";
import { parseRegister } from "../lib/register.ts";
import { readSheetFile } from "../lib/sheets.ts";
import { findPatterns } from "../lib/patterns.ts";
import { analyse } from "../lib/analyse.ts";
import { parse2bJson } from "../lib/reconcile.ts";
import { makeGstin } from "../lib/gst.ts";
import { emptyInvoice, type Invoice } from "../lib/types.ts";

const DEMO = new URL("../public/demo/", import.meta.url).pathname;
const OUR = "27AAHCS4821K1Z3";
const b64url = (s: string) => Buffer.from(s).toString("base64url");

function bill(id: string, p: Partial<Invoice>): Invoice {
  const inv = emptyInvoice(id, `${id}.pdf`, "pdf");
  const taxable = p.taxable ?? 10000;
  return { ...inv, supplierName: "Test Traders", supplierGstin: makeGstin("27", "AAFFT1234K"), buyerGstin: OUR, number: `T/${id}`, date: "2026-10-10", placeOfSupply: "27-Maharashtra",
    taxable, cgst: taxable * 0.09, sgst: taxable * 0.09, igst: 0, cess: 0, roundOff: 0, total: taxable * 1.18, items: [{ description: "Wire", hsn: "8544", qty: 1, taxable, rate: 18 }], missing: [], ...p };
}

test("e-invoice QR signature: genuine, forged and unknown", async () => {
  const irp = generateKeyPairSync("rsa", { modulusLength: 2048 }), other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const body = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ data: JSON.stringify({ SellerGstin: "27AAPFU0939F1ZV", BuyerGstin: OUR, DocNo: "A/1", DocTyp: "INV", DocDt: "10/10/2026", TotInvVal: 1180, ItemCnt: 1, MainHsnCode: "8544", Irn: "x".repeat(64), IrnDt: "2026-10-10 10:00:00" }), iss: "NIC" }))}`;
  const token = (k: typeof irp) => `${body}.${sign("sha256", Buffer.from(body), k.privateKey).toString("base64url")}`;
  const keys = [{ name: "Test IRP", spki: irp.publicKey.export({ type: "spki", format: "der" }).toString("base64") }];
  const good = decodeQr(token(irp)), bad = decodeQr(token(other));
  assert.equal(good.kind, "einvoice");
  if (good.kind !== "einvoice" || bad.kind !== "einvoice") return;
  assert.equal((await verifyQr(good, keys)).status, "verified");
  assert.equal((await verifyQr(bad, keys)).status, "invalid");
  assert.equal((await verifyQr(good, [])).status, "no-key");
  // the demo key file only holds a public key
  const demo = JSON.parse(fs.readFileSync(new URL("../public/irp-keys.json", import.meta.url), "utf8"));
  assert.ok(demo.keys[0].spki.length > 300 && !/PRIVATE/.test(JSON.stringify(demo)));
  // a forged signature is a red finding
  const inv = bill("q", { number: "A/1", supplierGstin: "27AAPFU0939F1ZV", total: 1180, taxable: 1000, cgst: 90, sgst: 90, items: [{ description: "Wire", hsn: "8544", qty: 1, taxable: 1000, rate: 18 }], qr: { ...bad, signature: { status: "invalid" } } });
  assert.ok(checkInvoice(inv, { ourGstin: OUR, today: "2026-11-13" }).some((f) => f.code === "qr-forged" && f.level === "red"));
});

test("supplier registration: cancelled, new, other name", () => {
  const sup = makeGstin("27", "AAFFT1234K");
  const s = parseLookup(sup, { data: { sts: "Cancelled", lgnm: "TEST TRADERS", tradeNam: "TEST TRADERS", rgdt: "01/07/2017", cxdt: "30/09/2026" } })!;
  assert.deepEqual([s.status, s.registeredOn, s.cancelledOn], ["Cancelled", "2017-07-01", "2026-09-30"]);
  const codes = (st: object) => checkInvoice(bill("r", {}), { ourGstin: OUR, today: "2026-11-13", gstin: { [sup]: parseLookup(sup, st)! } }).map((f) => f.code).filter((c) => c.startsWith("gstin"));
  assert.ok(codes({ sts: "Cancelled", lgnm: "TEST TRADERS", cxdt: "30/09/2026", rgdt: "01/07/2017" }).includes("gstin-cancelled"));
  assert.ok(codes({ sts: "Cancelled", lgnm: "TEST TRADERS", cxdt: "30/10/2026", rgdt: "01/07/2017" }).includes("gstin-cancelled-later"));
  assert.ok(codes({ sts: "Active", lgnm: "TEST TRADERS", rgdt: "01/09/2026" }).includes("gstin-new"));
  assert.ok(codes({ sts: "Active", lgnm: "TEST TRADERS", rgdt: "20/10/2026" }).includes("gstin-not-yet"));
  assert.ok(codes({ sts: "Active", lgnm: "VARDHMAN POLYMERS", tradeNam: "VARDHMAN POLYMERS", rgdt: "01/07/2017" }).includes("gstin-name"));
  assert.deepEqual(codes({ sts: "Active", lgnm: "TEST TRADERS", rgdt: "01/07/2017" }), []);
  assert.ok(namesMatch("M/s Test Traders Pvt Ltd", "TEST TRADERS PRIVATE LIMITED"));
});

test("180-day payment rule", () => {
  const pays = parsePayments(readSheetFile("p.csv", new TextEncoder().encode("Payment Date,Supplier GSTIN,Against Invoice No,Amount Paid\n20/05/2026,,T/old,5000\n")));
  assert.equal(pays.length, 1);
  const old = bill("old", { date: "2026-04-25" });
  assert.deepEqual(paidFor(old, pays), { paid: 5000, lastDate: "2026-05-20" });
  const f = checkInvoice(old, { ourGstin: OUR, today: "2026-11-13", paid: paidFor(old, pays) }).find((x) => x.code === "payment-180");
  assert.ok(f && f.level === "red");
  assert.equal(f!.risk, Math.round(1800 * (11800 - 5000) / 11800 * 100) / 100, "ITC reversed only on the unpaid part");
  const soon = bill("soon", { date: "2026-05-20" });   // 180 days end 16 Nov 2026
  assert.ok(checkInvoice(soon, { ourGstin: OUR, today: "2026-11-13", paid: { paid: 0, lastDate: null } }).some((x) => x.code === "payment-due"));
  assert.ok(!checkInvoice(old, { ourGstin: OUR, today: "2026-11-13", paid: { paid: 11800, lastDate: null } }).some((x) => x.code.startsWith("payment")));
});

test("Tally purchase register and demo payments are read", () => {
  const reg = parseRegister(readSheetFile("purchase-register.xlsx", new Uint8Array(fs.readFileSync(DEMO + "purchase-register.xlsx"))));
  assert.equal(reg.length, 16);
  const kumar = reg.find((r) => r.number === "KA/2026/77")!;
  assert.deepEqual([kumar.date, kumar.taxable, kumar.cgst, kumar.total, kumar.source, kumar.items[0].rate], ["2026-04-25", 40000, 3600, 47200, "register", 18]);
  const pays = parsePayments(readSheetFile("payments.csv", new Uint8Array(fs.readFileSync(DEMO + "payments.csv"))));
  assert.equal(pays.length, 8);
  // the register row on its own: in GSTR-2B, unpaid after 180 days, register rows aren't faulted for missing details
  const twob = parse2bJson(fs.readFileSync(DEMO + "GSTR-2B-Oct-2026.json", "utf8"));
  const a = analyse([kumar], twob, { ourGstin: OUR, today: "2026-11-13", payments: pays });
  assert.equal(a.rows[0].match.status, "matched");
  assert.deepEqual(a.rows[0].findings.map((f) => f.code), ["payment-180"]);
  assert.equal(a.rows[0].atRisk, 7200);
});

test("patterns across invoices", () => {
  const other = makeGstin("27", "AAKFR5521M");
  const p = findPatterns([
    bill("a", { number: "S/118", taxable: 41000, vehicle: "MH43AB9921" }), bill("b", { number: "S/119", taxable: 40000, vehicle: "MH43AB9921" }),
    bill("c", { number: "R/120", supplierGstin: other, supplierName: "Royal", date: "2026-10-11", vehicle: "MH43AB9921" }),
    bill("d", { number: "S/300", date: "2026-09-01" }),
    bill("e", { number: "Q/1", supplierGstin: makeGstin("27", "AAQFQ7777L"), taxable: 99500, total: 118000 }),
  ]);
  const codes = (id: string) => (p[id] ?? []).map((f) => f.code);
  assert.ok(codes("a").includes("pattern-split") && codes("b").includes("pattern-split"));
  assert.ok(codes("c").includes("pattern-series"), "R/120 follows S/119");
  assert.ok(codes("d").includes("pattern-order"), "a higher number dated earlier");
  assert.ok(codes("e").includes("pattern-round"));
  // a duplicate upload doesn't make a "split"
  const dup = findPatterns([bill("x", { number: "S/1", taxable: 30000 }), bill("y", { number: "S/1", taxable: 30000 })]);
  assert.ok(!Object.values(dup).flat().some((f) => f.code === "pattern-split"));
});

// ---------------------------------------------------------------- credit notes, bundles, HSN, blocked credit, bank, Tally, scores, GSTR-3B
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { groupPages, pdfText } from "../lib/pdftext.ts";
import { extractFields } from "../lib/extract.ts";
import { blockedCredit, chapterOf, hsnMismatch, hsnValid, reverseChargeLikely } from "../lib/hsn.ts";
import { matchBank, parseBank } from "../lib/bank.ts";
import { parseTallyXml } from "../lib/tally.ts";
import { supplierScores } from "../lib/score.ts";
import { draft3b, total4 } from "../lib/gstr3b.ts";
import { mergeTwoB, twobChanges } from "../lib/reconcile.ts";

const pages = async (f: string) => {
  const r = await pdfText(pdfjs as never, new Uint8Array(fs.readFileSync(DEMO + f)), { standardFontDataUrl: new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname });
  await r.close();
  return r.pageTexts;
};

test("credit note, transport details and shared bank account are read from the demo PDFs", async () => {
  const cn = extractFields((await pages("invoice-14.pdf"))[0], emptyInvoice("cn", "invoice-14.pdf", "pdf"));
  assert.deepEqual([cn.docType, cn.number, cn.refNumber, cn.date, cn.supplierName, cn.igst, cn.total], ["credit", "KCP/CN/26-27/031", "KCP/26-27/1187", "2026-10-20", "Kaveri Components Pvt Ltd", 342, 2242]);
  const seven = extractFields((await pages("invoice-07.pdf"))[0], emptyInvoice("7", "invoice-07.pdf", "pdf"));
  assert.deepEqual([seven.distanceKm, seven.ewbDate, seven.date, seven.ewayBill], [1340, "2026-10-17", "2026-10-17", "331009876543"]);
  assert.ok(checkInvoice(seven, { today: "2026-11-13" }).some((f) => f.code === "ewb-days" && /7 days/.test(f.title)), "1340 km = 7 days");
  assert.ok(checkInvoice({ ...seven, ewbDate: "2026-10-15" }, { today: "2026-11-13" }).some((f) => f.code === "ewb-early"));
  assert.ok(checkInvoice({ ...seven, ewbValidUntil: "2026-11-05" }, { today: "2026-11-13" }).some((f) => f.code === "ewb-validity"));
  const [a, b, c] = await Promise.all(["invoice-11.pdf", "invoice-12.pdf", "invoice-13.pdf"].map(async (f) => extractFields((await pages(f))[0], emptyInvoice(f, f, "pdf"))));
  assert.deepEqual([a.bank, a.phone, c.bank], ["50200041778812", "9820041778", "50200041778812"]);
  const p = findPatterns([a, b, c]);
  assert.ok(p[c.id].some((f) => f.code === "pattern-shared") && p[a.id].some((f) => f.code === "pattern-shared"));
  // the credit note takes ITC away and is tied to its invoice
  const two = extractFields((await pages("invoice-02.pdf"))[0], emptyInvoice("two", "invoice-02.pdf", "pdf"));
  const twob = parse2bJson(fs.readFileSync(DEMO + "GSTR-2B-Oct-2026.json", "utf8"));
  const an = analyse([two, cn], twob, { ourGstin: OUR, today: "2026-11-13" });
  assert.equal(an.rows[1].tax, -342);
  assert.equal(an.rows[1].match.status, "matched", "matched to the credit note in GSTR-2B, not an invoice");
  assert.ok(an.rows[1].findings.some((f) => f.code === "note-linked") && an.rows[0].findings.some((f) => f.code === "has-note"));
  assert.equal(an.totals.tax, Math.round((two.igst - 342) * 100) / 100);
});

test("a PDF with several invoices is split by invoice number", async () => {
  const texts = await pages("invoice-16-bundle.pdf");
  assert.equal(texts.length, 2);
  const numbers = texts.map((t) => extractFields(t).number);
  assert.deepEqual(numbers, ["GLC/2026/0431", "KCP/26-27/1203"]);
  assert.deepEqual(groupPages(numbers), [[0], [1]]);
  assert.deepEqual(groupPages(["A/1", "", "A/1", "B/2", ""]), [[0, 1, 2], [3, 4]], "continuation pages stay with their invoice");
  assert.deepEqual(groupPages(["", "A/1"]), [[0, 1]], "a cover page joins the first invoice");
});

test("HSN chapters, blocked credit and reverse charge", () => {
  assert.equal(chapterOf("8544"), "Electrical machinery and equipment");
  assert.ok(hsnValid("996334") && !hsnValid("7712") && !hsnValid("85441"));
  const it = (description: string, hsn: string) => ({ description, hsn, qty: 1, taxable: 1000, rate: 18 });
  assert.match(hsnMismatch(it("Copper Cable 1.5 sq mm", "9405"))!, /chapter 94/);
  assert.equal(hsnMismatch(it("Copper Cable 1.5 sq mm", "8544")), null);
  assert.equal(hsnMismatch(it("Switch Plate 8M", "3925")), null, "accessories are left alone");
  assert.match(blockedCredit([it("Staff lunch catering (160 plates)", "996334")])!, /food/);
  assert.match(blockedCredit([it("Maruti Swift VXI", "87032291")])!, /motor vehicles/);
  assert.equal(blockedCredit([it("LED Panel Light 18W", "9405")]), null);
  assert.match(reverseChargeLikely([it("Freight charges Mumbai to Pune", "996511")])!, /transport/);
  const food = bill("f", { taxable: 8000, cgst: 200, sgst: 200, total: 8400, items: [{ description: "Staff lunch catering", hsn: "996334", qty: 160, taxable: 8000, rate: 5 }] });
  const f = checkInvoice(food, { ourGstin: OUR, today: "2026-11-13" }).find((x) => x.code === "blocked-credit");
  assert.equal(f?.risk, 400);
  const gta = bill("g", { taxable: 5000, cgst: 0, sgst: 0, total: 5000, items: [{ description: "Freight charges", hsn: "996511", qty: 1, taxable: 5000, rate: null }] });
  assert.ok(checkInvoice(gta, { ourGstin: OUR, today: "2026-11-13" }).some((x) => x.code === "rcm-likely"));
  assert.ok(checkInvoice(bill("o", { readBy: "ocr", ocrConfidence: 41 }), { ourGstin: OUR, today: "2026-11-13" }).some((x) => x.code === "ocr-low"));
});

test("bank statement payments are matched to invoices", () => {
  const a = bill("a", { number: "T/501", taxable: 10000 }), b = bill("b", { number: "T/502", taxable: 20000, supplierName: "Mehta Switchgear", supplierGstin: makeGstin("27", "AEZPM6630B") }),
    c = bill("c", { number: "Q/9", taxable: 20000, supplierName: "Royal Cables", supplierGstin: makeGstin("27", "ATRPR2846D") });
  const csv = ["HDFC Bank statement", "Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance",
    "20/10/2026,NEFT-TEST TRADERS-INV T/501,000123,11800.00,,500000", "22/10/2026,RTGS MEHTA SWITCHGEAR MUMBAI,000124,23600.00,,476400", "23/10/2026,UPI-CHAI WALA,000125,120.00,,476280", "24/10/2026,SALES RECEIPT,,,50000,526280"].join("\n");
  const entries = parseBank(readSheetFile("bank.csv", new TextEncoder().encode(csv)));
  assert.equal(entries.length, 3);
  const m = matchBank(entries, [a, b, c]);
  assert.deepEqual(m.payments.map((p) => [p.number, p.amount, p.date]), [["T/501", 11800, "2026-10-20"], ["T/502", 23600, "2026-10-22"]], "by number, then by amount with the supplier's name settling the tie");
  assert.equal(m.unmatched.length, 1);
});

test("Tally XML export is read", () => {
  const xml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE><VOUCHER VCHTYPE="Purchase" ACTION="Create"><DATE>20261003</DATE><VOUCHERNUMBER>101</VOUCHERNUMBER><REFERENCE>GLC/2026/0412</REFERENCE><PARTYLEDGERNAME>Ganesh Lighting &amp; Co</PARTYLEDGERNAME><PARTYGSTIN>27AAJFG3150M1Z7</PARTYGSTIN>
   <ALLLEDGERENTRIES.LIST><LEDGERNAME>Ganesh Lighting &amp; Co</LEDGERNAME><AMOUNT>36108.00</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase @ 18%</LEDGERNAME><AMOUNT>-30600.00</AMOUNT></ALLLEDGERENTRIES.LIST>
   <ALLLEDGERENTRIES.LIST><LEDGERNAME>Input CGST 9%</LEDGERNAME><AMOUNT>-2754.00</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Input SGST 9%</LEDGERNAME><AMOUNT>-2754.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
   <TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20261004</DATE><VOUCHERNUMBER>7</VOUCHERNUMBER><PARTYLEDGERNAME>Someone</PARTYLEDGERNAME></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const [v, ...rest] = parseTallyXml(xml);
  assert.equal(rest.length, 0, "sales vouchers are skipped");
  assert.deepEqual([v.supplierName, v.supplierGstin, v.number, v.date, v.taxable, v.cgst, v.sgst, v.total, v.items[0].rate], ["Ganesh Lighting & Co", "27AAJFG3150M1Z7", "GLC/2026/0412", "2026-10-03", 30600, 2754, 2754, 36108, 18]);
});

test("supplier scores, TDS over ₹50 lakh, late filers", () => {
  const sup = makeGstin("27", "AAFFT1234K"), bad = makeGstin("27", "AAKFR5521M");
  const twob = { gstin: OUR, period: "102026", docs: [{ id: "d", gstin: sup, name: "TEST", number: "T/a", date: "2026-10-10", kind: "INV" as const, taxable: 6000000, igst: 0, cgst: 540000, sgst: 540000, cess: 0, total: 7080000, itcAvailable: true, reverseCharge: false, period: "102026" }] };
  const status = { [sup]: parseLookup(sup, { sts: "Active", lgnm: "TEST TRADERS", rgdt: "01/07/2017", EFiledlist: [{ rtntype: "GSTR3B", ret_prd: "082026", dof: "02-10-2026" }, { rtntype: "GSTR1", ret_prd: "092026", dof: "15-10-2026" }, { rtntype: "GSTR3B", ret_prd: "092026", dof: "19-10-2026" }] })! };
  const an = analyse([bill("a", { taxable: 6000000, ewayBill: "331009876543" }), bill("z", { supplierGstin: bad, supplierName: "Royal" })], twob, { ourGstin: OUR, today: "2026-11-13", gstin: status });
  assert.ok(an.rows[0].findings.some((f) => f.code === "supplier-late"));
  const s = supplierScores(an.rows, status);
  assert.equal(s[0].gstin, bad, "worst first");
  assert.ok(s[0].score <= 80 && s[0].reasons.some((r) => /not in GSTR-2B/.test(r)));
  const good = s.find((x) => x.gstin === sup)!;
  assert.deepEqual([good.score, good.grade, good.reasons], [90, "A", ["2 returns filed late"]]);
  assert.deepEqual(good.tds, { fy: "2026-27", purchases: 6000000, over: 1000000, tds: 1000 });
  // GSTR-3B not filed for the invoice's month, though later months are
  const st2 = { [sup]: parseLookup(sup, { sts: "Active", lgnm: "TEST TRADERS", rgdt: "01/07/2017", EFiledlist: [{ rtntype: "GSTR3B", ret_prd: "052026", dof: "19-06-2026" }] })! };
  assert.ok(checkInvoice(bill("k", { date: "2026-04-25" }), { ourGstin: OUR, today: "2026-11-13", gstin: st2 }).some((f) => f.code === "supplier-3b"));
});

test("GSTR-3B Table 4 draft", () => {
  const sup2 = makeGstin("27", "AAKFR5521M");
  const food = bill("f", { number: "F/1", taxable: 8000, cgst: 200, sgst: 200, total: 8400, items: [{ description: "Staff lunch catering", hsn: "996334", qty: 160, taxable: 8000, rate: 5 }] });
  const rcm = bill("r", { number: "R/1", reverseCharge: true, taxable: 5000, cgst: 125, sgst: 125, total: 5250, items: [{ description: "Freight", hsn: "996511", qty: 1, taxable: 5000, rate: 5 }] });
  const doc = (i: Invoice, id: string) => ({ id, gstin: i.supplierGstin, name: "X", number: i.number, date: i.date, kind: "INV" as const, taxable: i.taxable, igst: 0, cgst: i.cgst, sgst: i.sgst, cess: 0, total: i.total, itcAvailable: true, reverseCharge: false, period: "102026" });
  const ok = bill("a", { number: "T/1" }), gone = bill("m", { number: "M/1", supplierGstin: sup2 });
  const an = analyse([ok, food, rcm, gone], { gstin: OUR, period: "102026", docs: [doc(ok, "1"), doc(food, "2"), doc(rcm, "3")] }, { ourGstin: OUR, today: "2026-11-13" });
  const d = draft3b(an.rows, true);
  const by = Object.fromEntries(d.lines.map((l) => [l.key, total4(l.tax)]));
  assert.deepEqual(by, { "4(A)(3)": 250, "4(A)(5)": 2200, "4(B)(1)": 400, "4(B)(2)": 0 });
  assert.equal(total4(d.net), 2050);
  assert.equal(total4(d.waiting.tax), 1800, "not in GSTR-2B: wait");
  assert.equal(total4(d.rcmPayable), 250);
});

test("several GSTR-2B files: merged, and changes found", () => {
  const d = (number: string, cgst: number, period: string) => ({ id: number, gstin: makeGstin("27", "AAFFT1234K"), name: "TEST", number, date: "2026-09-10", kind: "INV" as const, taxable: cgst / 0.09, igst: 0, cgst, sgst: cgst, cess: 0, total: cgst / 0.09 + 2 * cgst, itcAvailable: true, reverseCharge: false, period });
  const sep = { gstin: OUR, period: "092026", docs: [d("T/1", 900, "092026"), d("T/2", 450, "092026")] }, oct = { gstin: OUR, period: "102026", docs: [d("T/1", 810, "102026"), d("T/3", 90, "102026")] };
  const m = mergeTwoB([oct, sep])!;
  assert.equal(m.docs.length, 3);
  assert.equal(m.docs.find((x) => x.number === "T/1")!.cgst, 810, "the later file wins");
  assert.equal(m.period, "092026-102026");
  const ch = twobChanges([oct, sep]);
  assert.equal(ch.length, 1);
  assert.match(ch[0].what, /Amended: GST ₹1,800.00 → ₹1,620.00/);
  assert.match(twobChanges([sep, { ...sep, docs: [sep.docs[0]] }])[0].what, /missing from the later/);
  assert.equal(mergeTwoB([]), null);
});

// ---------------------------------------------------------------- edited PDFs, more patterns, insights, save files
import { ageing, benford, imsForRow, interest, monthly, noticeReply, payLines, recoverable, ringMap, rule42, spoken } from "../lib/insights.ts";
import { lock, unlock } from "../lib/savefile.ts";

test("PDF edited after it was made, composition dealer, holiday dates, ITC deadline", async () => {
  const meta = async (f: string) => { const r = await pdfText(pdfjs as never, new Uint8Array(fs.readFileSync(DEMO + f))); await r.close(); return r.meta; };
  const seven = await meta("invoice-07.pdf"), one = await meta("invoice-01.pdf");
  assert.deepEqual([seven.producer, seven.created?.slice(0, 10), seven.modified?.slice(0, 10)], ["iLovePDF", "2026-10-17", "2026-10-20"]);
  const f = checkInvoice(bill("e", { pdf: seven }), { ourGstin: OUR, today: "2026-11-13" }).find((x) => x.code === "pdf-edited");
  assert.match(f!.detail, /created on 17-10-2026 and changed on 20-10-2026, and was last saved with iLovePDF/);
  assert.ok(!checkInvoice(bill("c", { pdf: one }), { ourGstin: OUR, today: "2026-11-13" }).some((x) => x.code === "pdf-edited"), "an untouched PDF isn't flagged");
  const sup = makeGstin("27", "AAFFT1234K");
  const comp = { [sup]: parseLookup(sup, { sts: "Active", lgnm: "TEST TRADERS", rgdt: "01/07/2017", dty: "Composition" })! };
  assert.ok(checkInvoice(bill("k", {}), { ourGstin: OUR, today: "2026-11-13", gstin: comp }).some((x) => x.code === "composition" && x.level === "red"));
  assert.ok(checkInvoice(bill("s", { date: "2026-10-11" }), { ourGstin: OUR, today: "2026-11-13" }).some((x) => x.code === "date-holiday"), "11 Oct 2026 is a Sunday");
  assert.ok(checkInvoice(bill("d", { date: "2026-03-20" }), { ourGstin: OUR, today: "2026-11-13" }).some((x) => x.code === "itc-soon"), "FY 2025-26 bills must be claimed by 30 Nov 2026");
  assert.ok(!checkInvoice(bill("d2", { date: "2026-10-10" }), { ourGstin: OUR, today: "2026-11-13" }).some((x) => x.code === "itc-soon" || x.code === "date-holiday"));
});

test("patterns: missing e-invoice, inflated price, billing spike", () => {
  const qr = { kind: "einvoice" as const, sellerGstin: "", buyerGstin: "", docNo: "", docType: "INV", docDate: null, total: 0, itemCount: 1, mainHsn: "", irn: "x", irnDate: "", issuer: "", token: "" };
  const p1 = findPatterns([bill("a", { number: "E/1", qr }), bill("b", { number: "E/2" }), bill("c", { number: "E/3", docType: "credit", refNumber: "E/1" })]);
  assert.ok(p1.b.some((f) => f.code === "einvoice-missing") && !(p1.a ?? []).some((f) => f.code === "einvoice-missing") && !p1.c.some((f) => f.code === "einvoice-missing"));
  const item = (rate: number) => [{ description: "Copper Cable 1.5 sq mm (90 m)", hsn: "8544", qty: 10, taxable: rate * 10, rate: 18 }];
  const p2 = findPatterns([bill("x", { number: "P/1", items: item(1200) }), bill("y", { number: "P/2", items: item(1250), supplierGstin: makeGstin("27", "AAKFR5521M") }), bill("z", { number: "P/3", items: item(2600), supplierGstin: makeGstin("27", "AAQFQ7777L") })]);
  assert.ok(p2.z.some((f) => f.code === "pattern-price") && !(p2.x ?? []).some((f) => f.code === "pattern-price"));
  const p3 = findPatterns([bill("m1", { number: "S/1", date: "2026-07-10", taxable: 20000 }), bill("m2", { number: "S/2", date: "2026-08-10", taxable: 25000 }), bill("m3", { number: "S/3", date: "2026-09-10", taxable: 300000 })]);
  assert.ok(p3.m3.some((f) => f.code === "pattern-spike") && !(p3.m1 ?? []).some((f) => f.code === "pattern-spike"));
});

test("insights: ring map, months, Benford, payments advice, IMS, notice reply, calculators", () => {
  const royal = makeGstin("27", "ATRPR2846D"), shiv = makeGstin("27", "AEHFS6102L");
  const a = bill("a", { number: "SSE/119", supplierGstin: shiv, supplierName: "Shiv Shakti", bank: "50200041778812", date: "2026-10-27" }), b = bill("b", { number: "RC/120", supplierGstin: royal, supplierName: "Royal Cables", bank: "50200041778812", date: "2026-10-28" }), c = bill("c", { number: "T/7", date: "2026-04-25" });
  const doc = (i: Invoice, id: string) => ({ id, gstin: i.supplierGstin, name: "X", number: i.number, date: i.date, kind: "INV" as const, taxable: i.taxable, igst: 0, cgst: i.cgst, sgst: i.sgst, cess: 0, total: i.total, itcAvailable: true, reverseCharge: false, period: "102026" });
  const an = analyse([a, b, c], { gstin: OUR, period: "102026", docs: [doc(a, "1"), doc(c, "3")] }, { ourGstin: OUR, ourName: "Sharma Electronics", today: "2026-11-13" });
  const ring = ringMap(an.rows);
  assert.equal(ring.nodes.length, 2);
  assert.deepEqual(ring.edges[0].why, ["same bank account", "invoice numbers run on"]);
  assert.deepEqual(monthly(an.rows).map((m) => [m.month, m.bills, m.tax, m.atRisk]), [["2026-04", 1, 1800, 0], ["2026-10", 2, 3600, 1800]]);
  assert.equal(recoverable(an.rows), 1800);
  const lines = payLines(an.rows, (r) => ({ paid: r.inv.id === "a" ? 11800 : 0, lastDate: null }), "2026-11-13", new Set([an.rows[2].inv.supplierGstin]));
  const byId = Object.fromEntries(lines.map((l) => [l.row.inv.id, l]));
  assert.deepEqual([byId.a.unpaid, byId.b.hold, byId.b.payNow, byId.c.hold], [0, 1800, 10000, 0]);
  assert.match(byId.b.advice, /Pay ₹10,000 now; hold ₹1,800 \(the GST\) until it shows in GSTR-2B/);
  assert.equal(byId.c.msmeLate, 157, "45 days from 25 Apr is 9 Jun; 157 days late on 13 Nov");
  assert.deepEqual(ageing(lines).map((x) => x.bills), [1, 0, 0, 0, 1]);
  assert.deepEqual([imsForRow(an.rows[0])?.action, imsForRow(an.rows[1])], ["Accept", null]);
  const reply = noticeReply(an, "Sharma Electronics", "102026");
  assert.match(reply, /Invoices not reported by the supplier \(1\), GST ₹1,800.00/);
  assert.match(reply, /Royal Cables .* invoice RC\/120 dated 28-10-2026/);
  assert.equal(interest(10000, 365), 1800);
  assert.equal(rule42(9000, 250000, 1000000), 2250);
  assert.match(spoken(an, false), /3 invoices checked/);
  assert.match(spoken(an, true), /3 बिल जाँचे गए/);
  // Benford: amounts that follow the law pass; amounts all starting with 4 don't
  const natural = Array.from({ length: 300 }, (_, i) => Math.round(10 ** (2 + ((i * 0.6180339887) % 1) * 3)));
  assert.equal(benford(natural).unusual, false);
  assert.equal(benford(Array.from({ length: 100 }, (_, i) => 48000 + i * 13)).unusual, true);
  assert.equal(benford([100, 200]).unusual, false, "too few to judge");
});

test("save file: locked with a password", async () => {
  const data = { v: 1, ourName: "Sharma Electronics", items: [{ id: "inv-1", total: 36108 }] };
  const file = await lock(data, "correct horse");
  assert.ok(!new TextDecoder().decode(file).includes("Sharma"), "nothing readable in the file");
  assert.deepEqual(await unlock(file, "correct horse"), data);
  await assert.rejects(unlock(file, "wrong"), /Wrong password/);
  await assert.rejects(unlock(new Uint8Array(50), "x"), /isn't an Invoice Checker save file/);
});
