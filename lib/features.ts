// Everything the site can do, in one list: what it is, what it needs, and where it lives on the page.
// The Explore panel shows this list and takes the person to each feature.
export type FeatureTab = "invoices" | "gstr2b" | "suppliers" | "scores" | "insights" | "payments" | "gstr3b" | "clients";
export type Feature = {
  id: string; group: string; name: string; what: string;
  needs?: string;          // what has to be loaded first; nothing when the feature works on an empty page
  tab?: FeatureTab;        // the results tab it is on
  show?: string;           // the part of the page to bring into view
  codes?: string[];        // findings that show it: the first invoice with one of them is opened
  act?: "reply";
};

const INV = "purchase invoices (PDFs or photos)";
const TWOB = "purchase invoices and your GSTR-2B";
const PAY = "invoices and a payments file or bank statement (or type in what you've paid)";
const LOOKUP = "invoices, and the supplier lookup switched on (the demo has sample registrations)";

export const FEATURES: Feature[] = [
  // ---- getting data in
  { id: "upload", group: "Add your data", name: "Read invoices from PDFs and photos", what: "Drop in PDFs or phone photos, several at once. Text PDFs are read directly; scans and photos are read by OCR. Everything is read in your browser.", show: "label[for=inv-input]" },
  { id: "bundle", group: "Add your data", name: "One PDF with many invoices", what: "A scanned bundle is split into its invoices, page by page, using the invoice number on each page.", needs: INV, tab: "invoices", show: ".results .table-wrap" },
  { id: "twob", group: "Add your data", name: "GSTR-2B, one month or several", what: "Add the JSON, Excel or zip from the GST portal. Drop several months together and they are joined; invoices that were amended between files are listed.", show: "label[for=twob-input]" },
  { id: "register", group: "Add your data", name: "Purchase register from Tally, Busy or Excel", what: "Add the register as Excel, CSV or Tally's XML export. Bills in the register that you haven't uploaded are still checked against GSTR-2B and the payment rule.", show: "label[for=reg-input]" },
  { id: "payfile", group: "Add your data", name: "Payments list or bank statement", what: "Add a list of payments, or your bank statement: withdrawals are matched to invoices by invoice number, amount and supplier name.", show: "label[for=pay-input]" },
  { id: "folder", group: "Add your data", name: "Open a whole folder", what: "In Chrome and Edge, pick a folder and every invoice, GSTR-2B, register and payments file in it is loaded in one go.", show: "[data-f=folder]" },
  { id: "camera", group: "Add your data", name: "Take a photo on your phone", what: "On a phone, a Take a photo button opens the camera and reads the bill straight away.", show: "[data-f=camera]" },
  { id: "edit", group: "Add your data", name: "Correct what was read", what: "Open any invoice to see its picture beside the details. Fix a wrong field and every check updates at once; each correction is kept for the audit pack.", needs: INV, tab: "invoices", codes: ["tax-maths", "total", "hsn"], show: ".results .table-wrap" },
  { id: "ai", group: "Add your data", name: "AI reading for messy photos", what: "When the site owner switches it on, hard photos and handwritten bills can be sent to an AI reader. It is off unless you tick the box.", show: ".fields-row" },

  // ---- checks on each invoice
  { id: "gstin", group: "Checks on every invoice", name: "GSTIN check", what: "The supplier's and your GSTIN are tested for format, state code and the built-in check character. A made-up GSTIN fails.", needs: INV, tab: "invoices", codes: ["supplier-gstin", "buyer-gstin", "buyer-mismatch"] },
  { id: "taxtype", group: "Checks on every invoice", name: "Right kind of tax", what: "CGST + SGST within a state, IGST between states. The wrong one can't be used as credit.", needs: INV, tab: "invoices", codes: ["tax-type", "cgst-sgst"] },
  { id: "maths", group: "Checks on every invoice", name: "The maths", what: "Items add up to the taxable value, tax matches the rate, and the total adds up.", needs: INV, tab: "invoices", codes: ["tax-maths", "total", "items-sum"] },
  { id: "rates", group: "Checks on every invoice", name: "GST 2.0 rates", what: "The 12% and 28% slabs ended on 22 September 2025. A later invoice using them is flagged.", needs: INV, tab: "invoices", codes: ["old-rate", "odd-rate"] },
  { id: "required", group: "Checks on every invoice", name: "Required details", what: "Invoice number, date, HSN code, place of supply and reverse-charge mention, as Rule 46 requires.", needs: INV, tab: "invoices", codes: ["hsn", "number-missing", "date-missing", "pos-missing", "buyer-missing", "rcm-missing", "number-format"] },
  { id: "hsn", group: "Checks on every invoice", name: "HSN code sense check", what: "The code must exist, and for common goods the description should fit the chapter. Each code's chapter is shown beside the item.", needs: INV, tab: "invoices", codes: ["hsn-invalid", "hsn-mismatch"] },
  { id: "dup", group: "Checks on every invoice", name: "Duplicates", what: "The same supplier and invoice number twice. Claiming credit twice on one bill is a common mistake.", needs: INV, tab: "invoices", codes: ["duplicate"] },
  { id: "dates", group: "Checks on every invoice", name: "Dates and deadlines", what: "Future dates, Sundays and national holidays, the deadline for claiming credit (30 November after the year ends), and a warning 60 days before it.", needs: INV, tab: "invoices", codes: ["date-future", "itc-time", "itc-soon", "date-holiday"] },
  { id: "blocked", group: "Checks on every invoice", name: "Blocked credit (Section 17(5))", what: "Food and catering, passenger vehicles, insurance, club fees, gifts and construction: the invoice can be correct and the credit still not allowed.", needs: INV, tab: "invoices", codes: ["blocked-credit"] },
  { id: "rcm", group: "Checks on every invoice", name: "Reverse charge", what: "Transport, advocate and security bills charged without GST: you may have to pay the tax yourself, then claim it.", needs: INV, tab: "invoices", codes: ["rcm-likely", "rcm"] },
  { id: "notes", group: "Checks on every invoice", name: "Credit and debit notes", what: "A credit note is tied to its invoice, matched to the note in GSTR-2B, and takes that much credit away.", needs: INV, tab: "invoices", codes: ["note-linked", "has-note", "note-orphan", "note-ref"] },
  { id: "ocrlow", group: "Checks on every invoice", name: "Hard-to-read pictures", what: "When a photo or handwritten bill was read with low confidence, the invoice is flagged so you check the details against the picture.", needs: INV, tab: "invoices", codes: ["ocr-low"] },

  // ---- fake and tampered bills
  { id: "qrsig", group: "Fake and edited bills", name: "E-invoice QR signature", what: "The QR code on an e-invoice is signed by the government portal. The signature is checked: a QR made by anyone else is a forgery.", needs: INV, tab: "invoices", codes: ["qr-forged"] },
  { id: "qrmatch", group: "Fake and edited bills", name: "Printed invoice against its QR", what: "The seller, buyer, number, date and total inside the signed QR are compared with what is printed. A changed total shows up here.", needs: INV, tab: "invoices", codes: ["qr-mismatch"] },
  { id: "pdfedit", group: "Fake and edited bills", name: "PDF edited after it was made", what: "A file changed after it was created, or last saved by a PDF editing tool, is flagged.", needs: INV, tab: "invoices", codes: ["pdf-edited"] },
  { id: "einv", group: "Fake and edited bills", name: "Missing e-invoice", what: "If a supplier's other bills are registered e-invoices, a bill from them with no QR code is flagged.", needs: INV, tab: "invoices", codes: ["einvoice-missing", "qr-missing"] },
  { id: "vehicle", group: "Fake and edited bills", name: "Vehicle number on the bill", what: "The state code, RTO code and format of the vehicle number are checked. Made-up numbers are common on fake bills; BH-series cars don't carry goods.", needs: INV, tab: "invoices", codes: ["vehicle", "vehicle-bh"] },
  { id: "ewb", group: "Fake and edited bills", name: "E-way bill", what: "Goods over ₹50,000 need one. The number, its date against the invoice date, and its validity for the distance (1 day per 200 km) are checked.", needs: INV, tab: "invoices", codes: ["ewb-early", "ewb-validity", "ewb-missing", "ewb-format", "ewb-days"] },
  { id: "split", group: "Fake and edited bills", name: "Bills split under ₹50,000", what: "Several bills from one supplier on one day, each under the e-way bill limit but over it together.", needs: INV, tab: "invoices", codes: ["pattern-split"] },
  { id: "series", group: "Fake and edited bills", name: "One bill book, two firms", what: "An invoice number that runs straight on from another supplier's bill, numbers out of date order, or one vehicle on bills from different suppliers.", needs: INV, tab: "invoices", codes: ["pattern-series", "pattern-order", "pattern-vehicle"] },
  { id: "shared", group: "Fake and edited bills", name: "Shared bank account, phone or email", what: "Different suppliers printing the same payment or contact details are often run by the same people.", needs: INV, tab: "invoices", codes: ["pattern-shared"] },
  { id: "price", group: "Fake and edited bills", name: "Inflated prices and sudden spikes", what: "An item billed 50% above what you usually pay, or a supplier's monthly billing tripling.", needs: INV, tab: "invoices", codes: ["pattern-price", "pattern-spike", "pattern-round"] },
  { id: "ring", group: "Fake and edited bills", name: "Map of linked suppliers", what: "A picture of which suppliers are tied together by shared bank accounts, phones, vehicles or invoice numbers.", needs: INV, tab: "insights", show: ".insights article:nth-child(1)" },
  { id: "benford", group: "Fake and edited bills", name: "First-digit test (Benford's law)", what: "In real accounts about 30% of amounts start with 1. Made-up amounts don't follow the pattern. Needs at least 50 invoices.", needs: INV, tab: "insights", show: ".insights article:nth-child(4)" },
  { id: "vehtool", group: "Fake and edited bills", name: "Vehicle number checker", what: "Type any registration number to see its state and RTO, with a link to the official Parivahan site for the owner and RC details.", show: ".vehicle-tool" },

  // ---- suppliers
  { id: "regstatus", group: "Your suppliers", name: "Supplier's GST registration", what: "Cancelled or suspended registrations, firms registered only days ago, a name that doesn't match the GSTIN, and composition dealers charging GST.", needs: LOOKUP, tab: "invoices", codes: ["gstin-cancelled", "gstin-suspended", "gstin-name", "gstin-new", "gstin-not-yet", "gstin-cancelled-later", "composition"] },
  { id: "filing", group: "Your suppliers", name: "Supplier's return filing", what: "A supplier who hasn't filed GSTR-3B for the month of your invoice, or who files late again and again.", needs: LOOKUP, tab: "invoices", codes: ["supplier-3b", "supplier-late"] },
  { id: "scores", group: "Your suppliers", name: "Supplier scores", what: "Every supplier gets 0 to 100 and a grade A to D, with the reasons, so you know who is safe to buy from.", needs: INV, tab: "scores", show: ".results .table-wrap" },
  { id: "tds", group: "Your suppliers", name: "TDS above ₹50 lakh", what: "When purchases from one seller cross ₹50 lakh in a year, the score table tells you how much TDS to deduct.", needs: INV, tab: "scores", show: ".results .table-wrap" },
  { id: "messages", group: "Your suppliers", name: "Messages to suppliers", what: "A ready message for each supplier listing the invoices they must report or correct. Copy it, or open it in WhatsApp.", needs: TWOB, tab: "suppliers", show: ".suppliers .supplier" },

  // ---- GSTR-2B
  { id: "kpis", group: "GSTR-2B and your credit", name: "ITC at risk and safe to claim", what: "Four numbers at the top: bills checked, GST on them, credit at risk, and credit that is safe to claim.", needs: INV, show: ".kpis" },
  { id: "recon", group: "GSTR-2B and your credit", name: "Match with GSTR-2B", what: "Each invoice is matched to what the supplier reported, even when the number is written differently. Missing and differing invoices are marked.", needs: TWOB, tab: "gstr2b", show: ".results .table-wrap" },
  { id: "ims", group: "GSTR-2B and your credit", name: "IMS action for each entry", what: "For the portal's Invoice Management System: accept what matches, keep the rest pending, with the reason.", needs: TWOB, tab: "gstr2b", show: ".results .table-wrap" },
  { id: "reply", group: "GSTR-2B and your credit", name: "Draft reply to a mismatch notice", what: "A starting draft for a reply to DRC-01C or ASMT-10 that lists the unreported and differing invoices.", needs: TWOB, tab: "gstr2b", act: "reply", show: "textarea.tall" },
  { id: "whatif", group: "GSTR-2B and your credit", name: "What if suppliers file?", what: "How much of the credit at risk comes back as soon as suppliers report the missing invoices.", needs: TWOB, tab: "insights", show: ".insights article:nth-child(3)" },
  { id: "months", group: "GSTR-2B and your credit", name: "Month-by-month chart", what: "GST and credit at risk for each month's bills.", needs: INV, tab: "insights", show: ".insights article:nth-child(2)" },

  // ---- payments
  { id: "p180", group: "Payments", name: "The 180-day rule", what: "A supplier not paid within 180 days costs you the credit on the unpaid part. Each bill shows its pay-by date and days left.", needs: PAY, tab: "payments", show: ".results .table-wrap" },
  { id: "ageing", group: "Payments", name: "Ageing of unpaid bills", what: "Unpaid amounts in buckets: 0–30, 31–60, 61–90, 91–180 and over 180 days.", needs: PAY, tab: "payments", show: ".ageing" },
  { id: "hold", group: "Payments", name: "Pay the goods, hold the GST", what: "For a bill whose credit is at risk, the advice column says how much to pay now and how much to hold until the problem is fixed.", needs: PAY, tab: "payments", show: ".results .table-wrap" },
  { id: "msme", group: "Payments", name: "MSME 45-day limit", what: "Tick the suppliers that are micro or small enterprises: bills unpaid beyond 45 days are flagged.", needs: PAY, tab: "payments", show: ".results .table-wrap" },

  // ---- returns
  { id: "g3b", group: "Returns and paperwork", name: "GSTR-3B Table 4 draft", what: "What to claim, what to reverse (blocked credit, unpaid bills, problem invoices), what to hold until the supplier files, and reverse-charge tax to pay.", needs: INV, tab: "gstr3b", show: ".results .table-wrap" },
  { id: "calc", group: "Returns and paperwork", name: "Calculators", what: "Tax to pay in cash this month, interest on wrongly claimed credit at 18%, and the Rule 42 reversal for shops that sell exempt goods too.", needs: INV, tab: "insights", show: ".insights article:nth-child(3)" },
  { id: "excel", group: "Returns and paperwork", name: "Excel report", what: "One workbook with the summary, every invoice and its problems, what's in GSTR-2B but not uploaded, and the supplier messages.", needs: INV, show: ".bar-actions" },
  { id: "audit", group: "Returns and paperwork", name: "Audit pack (PDF)", what: "A printable pack with each invoice's picture, its findings and every correction made by hand. Use Save as PDF in the print window.", needs: INV, show: ".bar-actions" },
  { id: "clients", group: "Returns and paperwork", name: "Clients list for accountants", what: "Save each client's totals in this browser and download them all as Excel.", needs: INV, tab: "clients", show: ".results .actions" },

  // ---- the site itself
  { id: "lang", group: "Using the site", name: "Five languages", what: "English, Hindi, Marathi, Gujarati and Tamil. Problem titles are also in Hindi.", show: ".lang" },
  { id: "save", group: "Using the site", name: "Save your work", what: "Save everything to a file locked with your password, and open it again next month.", show: ".savebox" },
  { id: "remind", group: "Using the site", name: "Monthly reminder", what: "Adds a calendar entry for the 14th of every month, the day GSTR-2B is ready.", show: "[data-f=remind]" },
  { id: "listen", group: "Using the site", name: "Listen to the summary", what: "The result read aloud, in English or Hindi.", needs: INV, show: "[data-f=listen]" },
  { id: "privacy", group: "Using the site", name: "Your invoices stay with you", what: "Invoices are read in your browser. The page is blocked from contacting other websites, so nothing can leak.", show: ".inputs .actions" },
];
