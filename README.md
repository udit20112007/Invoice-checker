# Invoice Checker

**Catch bad GST invoices before you claim ITC.**

Drop in purchase invoices (PDFs or phone photos) and the month's GSTR-2B. Invoice Checker reads every invoice, checks it against the GST rules, compares it with what suppliers reported to the GST portal, and shows how much input tax credit (ITC) is at risk, with a ready message for each supplier to chase and an Excel report for the accountant.

Click **Try the demo pile** to see it work on 10 sample invoices with planted problems.

## What it checks

| Check | Rule | Example result |
| --- | --- | --- |
| Supplier and buyer GSTIN | Format, state code and the mod-36 check character | "27ABMPT1234Q1ZX fails the check-character test" |
| Invoice is addressed to you | Buyer GSTIN = your GSTIN (Section 16(2)) | "Invoice is addressed to a different GSTIN" |
| Required details | CGST Rule 46: number (max 16 characters), date, HSN/SAC, place of supply, reverse charge | "No HSN/SAC code" |
| Right kind of tax | Supplier's state vs place of supply: CGST + SGST within a state, IGST between states | "IGST charged on a same-state sale" |
| Maths | Items add up, taxable value × rate = tax, total = taxable + tax + round-off | "Tax doesn't match the rate" |
| Current rates | GST 2.0 from 22 Sep 2025: 5%, 18%, 40% (+ special rates); 12% and 28% removed | "12% rate used after GST 2.0" |
| E-invoice QR | Decodes the signed QR (seller, buyer, number, date, total, IRN) and compares it with the print | "QR ₹1,18,000, printed ₹1,81,000" |
| Vehicle number | State code, RTO code, series and number format (incl. BH series); BH vehicles are personal, not goods carriers | "MX12AB1234: “MX” isn't a state code" |
| E-way bill | 12-digit number; goods over ₹50,000 need one (CGST Rule 138) | "No e-way bill number on the invoice" |
| Duplicates, dates | Same supplier + number twice; future dates; past the ITC deadline (Section 16(4)) | "Duplicate invoice" |
| QR signature | Verifies the e-invoice QR's RS256 signature with the Invoice Registration Portals' public keys (`public/irp-keys.json`) | "The QR code's signature is fake" |
| Supplier registration | Status, registration and cancellation dates and registered name, from a GST data service (Section 16(2), Rule 21A) | "Supplier's GSTIN was cancelled on 30-09-2026" |
| 180-day payment rule | Unpaid 180 days after the invoice → ITC on the unpaid part is reversed (Section 16(2), second proviso) | "Not paid within 180 days: ₹7,200 to pay back" |
| Patterns across invoices | Bills split under ₹50,000 on one day; one vehicle for several suppliers; invoice numbers running on from another supplier's; numbers out of date order; round totals | "Bills split to stay under the e-way bill limit?" |
| Shared details | Different suppliers printing the same bank account, phone or email | "Shares a bank account with another supplier" |
| Credit and debit notes | Read as notes, tied to their invoice, matched to the notes in GSTR-2B; a credit note reduces ITC (Section 34) | "Credit note KCP/CN/26-27/031 changes this invoice" |
| HSN codes | Valid chapter; description against chapter for common goods | "Cable billed under chapter 94" |
| Blocked credit | Section 17(5): food and catering, passenger vehicles, insurance, club fees, gifts, construction | "ITC is blocked on this kind of purchase" |
| Reverse charge | Services where the buyer pays (goods transport, advocates, security) billed without GST | "You may have to pay GST under reverse charge" |
| E-way bill dates | Dated before the invoice; validity against distance (1 day per 200 km, Rule 138(10)) | "E-way bill valid for 7 days" |
| Supplier's returns | GSTR-3B not filed for the invoice month; habitual late filing (Section 16(2)(c)) | "Supplier hasn't filed GSTR-3B for Apr 2026" |
| Hard-to-read pictures | OCR confidence below 60% (handwriting, blur) | "This picture was hard to read" |
| Edited PDFs | File changed after it was created, or last saved by a PDF editing tool | "This PDF was changed after it was made" |
| Composition dealers | A composition-scheme supplier charging GST (Section 10(4)) | "Composition dealer has charged GST" |
| Missing e-invoice | A supplier who issues e-invoices sends a bill with no IRN or QR | "No e-invoice QR, though this supplier issues e-invoices" |
| Prices and spikes | An item billed 50% above your usual price; a supplier's monthly billing tripling | "Price is well above what you usually pay" |
| Dates | Sundays and national holidays; ITC deadline within 60 days (Section 16(4)) | "Claim this ITC by 30-11-2026" |
| GSTR-2B | Matches by supplier GSTIN + invoice number (ignoring separators, leading zeros, financial-year parts), amounts within ₹1 | "Not in GSTR-2B: ₹4,212 at risk" |

## How it works

1. **Read** (`lib/reader.ts`): PDF text with pdf.js, or OCR with Tesseract for photos and scanned PDFs; the page is scanned for a QR code with jsQR. Optional AI reading (`app/api/extract`) for messy photos.
2. **Extract** (`lib/extract.ts`): finds the fields line by line using the labels Indian invoices use; repairs OCR mistakes in GSTINs only when the check character confirms the repair.
3. **Check** (`lib/checks.ts`): every rule above, each finding with a plain reason and the rule it comes from.
4. **More checks**: `lib/qrsig.ts` (QR signature, WebCrypto), `lib/gstinstatus.ts` + `app/api/gstin` (supplier status), `lib/payments.ts` (180 days), `lib/patterns.ts` (patterns), `lib/register.ts` + `lib/sheets.ts` (Tally/Busy/Excel purchase register).
5. **Reconcile** (`lib/reconcile.ts`): reads GSTR-2B (JSON, Excel or zip), matches invoices, works out ITC at risk, writes supplier messages.
6. **Report** (`lib/analyse.ts`, `lib/xlsx.ts`): totals, the Excel report.

## Tools around the checks

- **Supplier scores** (`lib/score.ts`): 0–100 and a grade A–D per supplier, with the reasons; flags purchases above ₹50 lakh in a year for TDS on purchase of goods.
- **GSTR-3B draft** (`lib/gstr3b.ts`): Table 4 lines 4(A)(3), 4(A)(5), 4(B)(1), 4(B)(2), net ITC, what to hold until the supplier files, and reverse-charge tax to pay.
- **Payments**: a payments list, or a bank statement whose withdrawals are matched to invoices by number, amount and supplier name (`lib/bank.ts`).
- **Purchase register**: Excel/CSV from Tally or Busy, or Tally's XML export (`lib/tally.ts`).
- **Several months of GSTR-2B**: drop them together; they are merged and amended invoices are listed.
- **PDFs with several invoices**: split by invoice number, page by page (`groupPages` in `lib/pdftext.ts`).
- **Open a folder** (Chrome, Edge): reads every invoice, GSTR-2B, register and payments file in a folder in one go. **Monthly reminder** adds a calendar entry for the 14th, when GSTR-2B is ready.
- **Send on WhatsApp**: opens WhatsApp with the supplier's message ready to send.
- **Audit pack**: a printable pack (save as PDF) with every invoice's picture, findings and the corrections made by hand.
- **Insights** (`lib/insights.ts`): a map of suppliers linked by shared bank account, phone, email, vehicle or invoice numbers; GST and ITC at risk month by month; Benford's first-digit test (from 50 invoices); what comes back if suppliers file; calculators for tax to pay in cash, interest on wrongly claimed ITC, and Rule 42 common credit.
- **Payments advice**: ageing of unpaid bills, "pay the goods, hold the GST" advice on risky bills, and the 45-day limit for suppliers you mark as MSME.
- **IMS action** for every GSTR-2B entry (accept or keep pending), and a **draft reply** to an ITC mismatch notice (DRC-01C, ASMT-10).
- **Save your work** to a password-locked file (AES-256-GCM, `lib/savefile.ts`) and open it next month.
- **Guided tour** of the demo pile, **Listen to the summary** (English or Hindi, using the browser's voice), and **Take a photo** on phones.
- **Clients**: accountants can save each client's totals in the browser and download them as Excel.

The interface is in English, Hindi, Marathi, Gujarati and Tamil (`lib/i18n.ts`).

Invoices are read in the browser. Nothing is uploaded unless AI reading is switched on and chosen (the GSTIN lookup sends only supplier GSTINs), and the Content-Security-Policy stops the page from contacting any other site.

## Open-source libraries and services used (declared as the rules require)

| Library / service | Used for | Licence |
| --- | --- | --- |
| Next.js, React | Web app | MIT |
| pdf.js (`pdfjs-dist`) | Reading PDF text and drawing pages | Apache-2.0 |
| Tesseract.js + English data | OCR for photos and scans | Apache-2.0 |
| jsQR | Reading QR codes | Apache-2.0 |
| fflate | Zip (Excel files) | MIT |
| pdf-lib, qrcode (dev only) | Making the demo invoices | MIT |
| Anthropic Claude API (optional) | AI reading of messy photos | Commercial API |

Everything else (extraction, checks, matching, the Excel writer, the interface) was written for this project.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm run check        # type-check, tests, production build
npm run demo-files   # rebuild public/demo (needs Playwright installed for the photo)
```

Needs Node 22. To switch on AI reading, set `ANTHROPIC_API_KEY` (see `.env.example`) in the hosting settings, never in the code.

## Deploy

### GitHub Pages (free, from the repository)

The workflow in `.github/workflows/deploy.yml` tests the app on every push and pull request, and publishes it to GitHub Pages from `main`.

1. Create a **public** repository and upload these files (keep the `.github` folder; on GitHub's web upload, drag the whole unzipped folder so hidden folders come along).
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main` (or open **Actions → Test and deploy → Run workflow**). In about 3 minutes the site is live at `https://<your-username>.github.io/<repo-name>/`.

On GitHub Pages the app is static files only: everything works except the optional AI reader, which needs a server. The security policy is set with a `<meta>` tag there.

### Vercel (adds the optional AI reader)

Import the same repository in Vercel. No settings are needed. Optional settings (Settings → Environment Variables, never in the code):

| Variable | Switches on |
| --- | --- |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | AI reading of messy photos |
| `GSTIN_API_URL` (with `{gstin}` where the GSTIN goes), `GSTIN_API_KEY`, `GSTIN_API_KEY_HEADER` (default `x-api-key`) | Live supplier GSTIN status from a licensed GST data service (GSP/ASP) |

### QR signature keys

`public/irp-keys.json` lists the public keys that verify e-invoice QR codes. It ships with a demo key that only signs the demo invoices. For real invoices, add each IRP's public key (base64 SPKI) from its official e-invoice documentation; with only the demo key, real QRs show "signature not checked".

## Demo script (3 minutes)

1. **Problem (20 s):** a shop claims ITC on a supplier's invoice; months later the department reverses it because the supplier never filed, or the invoice was edited.
2. **Demo (2 min):** *Try the demo pile* → 16 files (17 invoices and a credit note), the purchase register and payments read in about 20 seconds → ₹63,416 ITC at risk. Press *Guided tour*: it walks through the edited invoice 7, the forged invoice 13, the linked suppliers, the 180-day payment, the GSTR-3B draft and the supplier messages in seven steps. Then switch the language and download the audit pack.
3. **How (25 s):** read → extract → check → reconcile, all in the browser.
4. **Next (15 s):** direct Tally connection, WhatsApp follow-ups to suppliers, monthly auto-runs.

## Limits

- Vehicle numbers are checked for format, state and RTO on the device. Owner and RC details come from VAHAN, which the public can search only on the official Parivahan site after an OTP login (and private API access was stopped from 1 October 2026), so the app links there instead of fetching them.

- QR signatures are verified only against the keys in `irp-keys.json`; add the real IRP keys before relying on it.
- Live GSTIN status needs a paid GST data service; without one, the demo pile uses demo registration data.
- Hindi covers the interface and finding titles; Marathi, Gujarati and Tamil cover the interface; the longer explanations are in English.
- Tally is read from its exported files. A browser page can't call Tally's local port directly (Tally sends no cross-origin permission), so there is no live connection.
- WhatsApp opens with the message text; a web link can't attach files.
- Supplier return filing is shown only when the GST data service reports it. HSN, blocked-credit and reverse-charge checks use short keyword lists: they raise questions, not verdicts. GST rates per HSN are not checked.
- Handwritten bills are flagged as hard to read; reading them well needs the optional AI reader.
- The GSTR-3B draft, the notice reply and the TDS note are working papers to check, not filings.
- The edited-PDF check reads the file's own dates and software name; these can be blank or wiped, so a clean result proves nothing.
- Extraction is tuned for common invoice layouts; unusual ones may need a field corrected on the review screen, or AI reading.
- GSTR-2B Excel is read from the B2B sheet; credit notes are read from the JSON.
- It finds problems; a person should check the results before filing GSTR-3B.
