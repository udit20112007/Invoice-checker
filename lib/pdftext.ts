// A PDF's text, rebuilt into lines as they appear on the page (pdf.js gives separate pieces with positions).
// Shared by the browser and the tests, so `pdfjs` is passed in.

type TextItem = { str: string; transform: number[]; width: number; height: number };
type PdfjsLike = { getDocument(src: object): { promise: Promise<PdfDoc>; destroy(): Promise<void> } };
export type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage>; getMetadata?(): Promise<{ info?: Record<string, unknown> }> };
export type PdfInfo = { producer: string; creator: string; created: string | null; modified: string | null };
const pdfDate = (v: unknown) => { const m = String(v ?? "").match(/(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}` : null; };
export type PdfPage = { getTextContent(): Promise<{ items: unknown[] }>; getViewport(o: { scale: number }): { width: number; height: number }; render(o: object): { promise: Promise<void> } };

export function linesFromItems(items: TextItem[]): string[] {
  const parts = items.filter((i) => i.str && i.str.trim()).map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height || 10, s: i.str }));
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: (typeof parts)[] = [];
  for (const p of parts) {
    const row = rows.find((r) => Math.abs(r[0].y - p.y) <= Math.max(2, r[0].h * 0.35));
    if (row) row.push(p); else rows.push([p]);
  }
  return rows.sort((a, b) => b[0].y - a[0].y).map((r) => r.sort((a, b) => a.x - b.x).map((p) => p.s.trim()).join(" ").replace(/\s+/g, " ").trim());
}

export const MAX_PAGES = 40;

/** A PDF may hold several invoices (a scanned bundle). Pages are grouped: a new invoice starts on each page
 *  that shows an invoice number different from the one before; other pages continue the invoice. */
export function groupPages(numbers: string[]): number[][] {
  const groups: number[][] = [];
  let current = "";
  numbers.forEach((no, i) => {
    const key = no.toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (!groups.length || (key && current && key !== current)) groups.push([i]);
    else groups[groups.length - 1].push(i);
    current = key || current;
  });
  return groups;
}

export async function pdfText(pdfjs: PdfjsLike, data: Uint8Array, opts: object = {}): Promise<{ text: string; pageTexts: string[]; pages: number; doc: PdfDoc; meta: PdfInfo; close: () => Promise<void> }> {
  const task = pdfjs.getDocument({ data, isEvalSupported: false, ...opts });
  const doc = await task.promise;
  const pageTexts: string[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
    const page = await doc.getPage(n);
    pageTexts.push(linesFromItems((await page.getTextContent()).items as TextItem[]).join("\n"));
  }
  const info = (await doc.getMetadata?.().catch(() => null))?.info ?? {};
  const meta: PdfInfo = { producer: String(info.Producer ?? ""), creator: String(info.Creator ?? ""), created: pdfDate(info.CreationDate), modified: pdfDate(info.ModDate) };
  return { text: pageTexts.slice(0, 3).join("\n"), pageTexts, meta, pages: doc.numPages, doc, close: () => task.destroy() };
}
