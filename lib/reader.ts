// Reads an uploaded invoice in the browser: PDF text (or OCR for scans and photos), the QR code, a preview
// image, then the invoice fields. Optionally asks the AI reader (this site's /api/extract) for a second opinion.
import jsQR from "jsqr";
import { extractFields } from "./extract";
import { groupPages, pdfText, type PdfDoc } from "./pdftext";
import { decodeQr } from "./qr";
import { verifyQr, type IrpKey } from "./qrsig";
import { BASE, HAS_SERVER } from "./base";
import { emptyInvoice, type Invoice } from "./types";

export type Progress = (step: string) => void;

let keys: Promise<IrpKey[]> | null = null;
const irpKeys = () => (keys ??= fetch(`${BASE}/irp-keys.json`).then((r) => (r.ok ? r.json() : [])).then((j) => (Array.isArray(j) ? j : j.keys ?? [])).catch(() => []));

let pdfjsLib: Promise<typeof import("pdfjs-dist")> | null = null;
function pdfjs() {
  pdfjsLib ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => {
    m.GlobalWorkerOptions.workerSrc = `${BASE}/pdfjs/worker.mjs`;
    return m as unknown as typeof import("pdfjs-dist");
  });
  return pdfjsLib;
}

type OcrWorker = { recognize(img: HTMLCanvasElement): Promise<{ data: { text: string; confidence: number } }>; terminate(): Promise<unknown> };
let ocrWorker: Promise<OcrWorker> | null = null;
function ocr() {
  ocrWorker ??= import("tesseract.js").then(({ createWorker }) => createWorker("eng", 1, {
    workerPath: `${BASE}/ocr/worker.min.js`, corePath: `${BASE}/ocr/`, langPath: `${BASE}/ocr/lang`, gzip: true, workerBlobURL: false,
  }) as unknown as Promise<OcrWorker>);
  return ocrWorker;
}

// A dense e-invoice QR is small on a full page, so after trying the whole page we try overlapping
// windows (a QR fills more of each), first where QR codes usually are: the top right.
function scanQr(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const W = canvas.width, H = canvas.height;
  const tryAt = (x: number, y: number, w: number, h: number) => {
    const img = ctx.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    return jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
  };
  const windows: [number, number][] = [[0.5, 0], [0, 0], [0.25, 0], [0.5, 0.25], [0, 0.25], [0.5, 0.5], [0, 0.5], [0.25, 0.5], [0.5, 0.75], [0, 0.75]];
  const found = tryAt(0, 0, W, H);
  if (found) return found;
  for (const [fx, fy] of windows) {
    const r = tryAt(fx * W, fy * H, W * 0.5, Math.min(H * 0.25 + W * 0.25, H - fy * H));
    if (r) return r;
  }
  return null;
}

async function renderPage(doc: PdfDoc, scale: number, n = 1) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  return canvas;
}

async function imageCanvas(file: Blob, maxSide = 2400) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas;
}

export type ReadResult = { invoice: Invoice; preview: string };

async function finish(text: string, base: Invoice, readBy: Invoice["readBy"], qr: string | null, confidence: number | undefined, onStep: Progress): Promise<Invoice> {
  const invoice = extractFields(text, { ...base, readBy });
  if (confidence !== undefined) invoice.ocrConfidence = Math.round(confidence);
  invoice.qr = qr ? decodeQr(qr) : null;
  if (invoice.qr?.kind === "einvoice") {
    if (!invoice.irn) invoice.irn = invoice.qr.irn;
    onStep("Checking the QR code's signature");
    invoice.qr.signature = await verifyQr(invoice.qr, await irpKeys());
  }
  return invoice;
}

/** Reads one file. A PDF that holds several invoices (a scanned bundle) gives one result per invoice. */
export async function readInvoices(file: File, id: string, onStep: Progress = () => {}): Promise<ReadResult[]> {
  const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    onStep("Opening the photo");
    const canvas = await imageCanvas(file);
    onStep("Looking for a QR code");
    const qr = scanQr(canvas);
    onStep("Reading the photo (OCR)");
    const o = (await (await ocr()).recognize(canvas)).data;
    const preview = canvas.toDataURL("image/jpeg", 0.8);
    canvas.width = canvas.height = 0;
    return [{ invoice: await finish(o.text, emptyInvoice(id, file.name, "image"), "ocr", qr, o.confidence, onStep), preview }];
  }
  onStep("Reading the PDF");
  const lib = await pdfjs();
  const r = await pdfText(lib as never, new Uint8Array(await file.arrayBuffer()), { standardFontDataUrl: `${BASE}/pdfjs/standard_fonts/` });
  const count = r.pageTexts.length;
  // scanned pages have no text layer: read each page's picture
  const texts = [...r.pageTexts], conf: (number | undefined)[] = [], canvases: (HTMLCanvasElement | undefined)[] = [];
  for (let n = 0; n < count; n++) {
    if (texts[n].replace(/\s/g, "").length >= 40) continue;
    onStep(count > 1 ? `Reading the scan (OCR), page ${n + 1} of ${count}` : "Reading the scan (OCR)");
    canvases[n] = await renderPage(r.doc, 3, n + 1);
    const o = (await (await ocr()).recognize(canvases[n]!)).data;
    texts[n] = o.text; conf[n] = o.confidence;
  }
  const groups = groupPages(texts.map((t) => extractFields(t).number));
  const out: ReadResult[] = [];
  for (const [gi, pages] of groups.entries()) {
    const first = pages[0];
    const big = canvases[first] ?? await renderPage(r.doc, 3, first + 1);
    onStep(groups.length > 1 ? `Invoice ${gi + 1} of ${groups.length}: looking for a QR code` : "Looking for a QR code");
    const text = pages.map((n) => texts[n]).join("\n");
    let qr = scanQr(big);
    if (!qr && /\bIRN\b|e-?invoice/i.test(text)) {   // a dense e-invoice QR (long signature) may need a sharper picture
      const sharp = await renderPage(r.doc, 5, first + 1);
      qr = scanQr(sharp);
      sharp.width = sharp.height = 0;
    }
    const preview = big.toDataURL("image/jpeg", 0.8);
    if (!canvases[first]) big.width = big.height = 0;
    const base = emptyInvoice(groups.length > 1 ? `${id}-${gi + 1}` : id, groups.length > 1 ? `${file.name} (page ${first + 1})` : file.name, "pdf");
    const invoice = await finish(text, base, conf[first] !== undefined ? "ocr" : "text", qr, conf[first], onStep);
    invoice.pdf = r.meta;
    out.push({ invoice, preview });
  }
  for (const c of canvases) if (c) c.width = c.height = 0;
  await r.close();
  return out;
}

// ---------------------------------------------------------------- optional AI reader
export async function aiAvailable(): Promise<boolean> {
  if (!HAS_SERVER) return false;
  try { const r = await fetch(`${BASE}/api/extract`, { cache: "no-store" }); return r.ok && (await r.json()).enabled === true; } catch { return false; }
}

/** Asks the AI reader for the fields and fills in what the rule-based reader missed or got wrong. */
export async function aiRead(inv: Invoice, preview: string): Promise<Invoice> {
  const body = inv.source === "image" ? { image: preview } : { text: inv.text.slice(0, 20000) };
  const r = await fetch(`${BASE}/api/extract`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.invoice) throw new Error(j.error || "The AI reader didn't answer.");
  const a = j.invoice as Partial<Invoice>;
  const out: Invoice = { ...inv, readBy: "ai" };
  for (const k of ["supplierName", "supplierGstin", "buyerName", "buyerGstin", "number", "date", "placeOfSupply"] as const) if (a[k]) (out as Record<string, unknown>)[k] = a[k];
  for (const k of ["taxable", "cgst", "sgst", "igst", "cess", "roundOff", "total"] as const) if (typeof a[k] === "number" && Number.isFinite(a[k])) out[k] = a[k] as number;
  if (typeof a.reverseCharge === "boolean") out.reverseCharge = a.reverseCharge;
  if (Array.isArray(a.items) && a.items.length) out.items = a.items.map((it) => ({ description: String(it.description ?? ""), hsn: String(it.hsn ?? ""), qty: typeof it.qty === "number" ? it.qty : null, taxable: Number(it.taxable), rate: typeof it.rate === "number" ? it.rate : null }));
  out.missing = inv.missing.filter((m) => !(m === "Supplier GSTIN" && out.supplierGstin) && !(m === "Invoice number" && out.number) && !(m === "Invoice date" && out.date) && !(m === "Taxable value" && Number.isFinite(out.taxable)) && !(m === "Invoice total" && Number.isFinite(out.total)) && !(m === "Buyer GSTIN" && out.buyerGstin));
  return out;
}
