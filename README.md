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
| Duplicates, dates | Same supplier + number twice; future dates; past the ITC deadline (Section 16(4)) | "Duplicate invoice" |
| GSTR-2B | Matches by supplier GSTIN + invoice number (ignoring separators, leading zeros, financial-year parts), amounts within ₹1 | "Not in GSTR-2B: ₹4,212 at risk" |

## How it works

1. **Read** (`lib/reader.ts`): PDF text with pdf.js, or OCR with Tesseract for photos and scanned PDFs; the page is scanned for a QR code with jsQR. Optional AI reading (`app/api/extract`) for messy photos.
2. **Extract** (`lib/extract.ts`): finds the fields line by line using the labels Indian invoices use; repairs OCR mistakes in GSTINs only when the check character confirms the repair.
3. **Check** (`lib/checks.ts`): every rule above, each finding with a plain reason and the rule it comes from.
4. **Reconcile** (`lib/reconcile.ts`): reads GSTR-2B (JSON, Excel or zip), matches invoices, works out ITC at risk, writes supplier messages.
5. **Report** (`lib/analyse.ts`, `lib/xlsx.ts`): totals, the Excel report.

Invoices are read in the browser. Nothing is uploaded unless AI reading is switched on and chosen, and the Content-Security-Policy stops the page from contacting any other site.

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

Import the same repository in Vercel. No settings are needed; add `ANTHROPIC_API_KEY` under Settings → Environment Variables only if you want AI reading.

## Demo script (3 minutes)

1. **Problem (20 s):** a shop claims ITC on a supplier's invoice; months later the department reverses it because the supplier never filed, or the invoice was edited.
2. **Demo (2 min):** *Try the demo pile* → 10 invoices read in about 10 seconds → ₹48,418 of ₹72,016 ITC at risk. Open invoice 7: the QR says ₹1,18,000, the print says ₹1,81,000. Open invoice 4, fix the tax, and watch it turn green. Show *Suppliers to chase* and download the Excel report.
3. **How (25 s):** read → extract → check → reconcile, all in the browser.
4. **Next (15 s):** verify the QR's digital signature with the government's public key; live GSTIN status; Tally import.

## Limits

- The QR is decoded, but its digital signature isn't verified yet (needs NIC's public key).
- Extraction is tuned for common invoice layouts; unusual ones may need a field corrected on the review screen, or AI reading.
- GSTR-2B Excel is read from the B2B sheet; credit notes are read from the JSON.
- It finds problems; a person should check the results before filing GSTR-3B.
