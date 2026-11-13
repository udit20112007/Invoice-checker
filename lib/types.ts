// The one shape every part of the app agrees on.

export type Item = {
  description: string;
  hsn: string;            // "" when the invoice doesn't show one
  qty: number | null;
  taxable: number;
  rate: number | null;    // total GST % on this line (e.g. 18), null when not printed
};

export type EInvoiceQr = {
  kind: "einvoice";
  sellerGstin: string;
  buyerGstin: string;
  docNo: string;
  docType: string;
  docDate: string | null;  // yyyy-mm-dd
  total: number;
  itemCount: number | null;
  mainHsn: string;
  irn: string;
  irnDate: string;
  issuer: string;
};
export type OtherQr = { kind: "upi"; payee: string; name: string; amount: number | null } | { kind: "other"; text: string };
export type QrInfo = EInvoiceQr | OtherQr;

export type Invoice = {
  id: string;
  fileName: string;
  source: "pdf" | "image" | "manual";
  readBy: "text" | "ocr" | "ai" | "manual";
  supplierName: string;
  supplierGstin: string;
  buyerName: string;
  buyerGstin: string;
  number: string;
  date: string | null;          // yyyy-mm-dd
  placeOfSupply: string;        // as printed
  reverseCharge: boolean | null;
  items: Item[];
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  roundOff: number;
  total: number;
  irn: string;
  qr: QrInfo | null;
  text: string;                 // what was read, for the "what we read" view
  missing: string[];            // fields we couldn't find
};

export type Level = "red" | "amber" | "info";
export type Finding = { level: Level; code: string; title: string; detail: string; rule?: string };

export const emptyInvoice = (id: string, fileName: string, source: Invoice["source"]): Invoice => ({
  id, fileName, source, readBy: source === "manual" ? "manual" : "text",
  supplierName: "", supplierGstin: "", buyerName: "", buyerGstin: "", number: "", date: null, placeOfSupply: "",
  reverseCharge: null, items: [], taxable: NaN, cgst: 0, sgst: 0, igst: 0, cess: 0, roundOff: 0, total: NaN,
  irn: "", qr: null, text: "", missing: [],
});

export const taxOf = (inv: Pick<Invoice, "cgst" | "sgst" | "igst" | "cess">) => (inv.cgst || 0) + (inv.sgst || 0) + (inv.igst || 0) + (inv.cess || 0);
