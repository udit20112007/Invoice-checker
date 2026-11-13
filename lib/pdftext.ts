// A PDF's text, rebuilt into lines as they appear on the page (pdf.js gives separate pieces with positions).
// Shared by the browser and the tests, so `pdfjs` is passed in.

type TextItem = { str: string; transform: number[]; width: number; height: number };
type PdfjsLike = { getDocument(src: object): { promise: Promise<PdfDoc>; destroy(): Promise<void> } };
export type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage> };
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

export async function pdfText(pdfjs: PdfjsLike, data: Uint8Array, opts: object = {}): Promise<{ text: string; pages: number; doc: PdfDoc; close: () => Promise<void> }> {
  const task = pdfjs.getDocument({ data, isEvalSupported: false, ...opts });
  const doc = await task.promise;
  const lines: string[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
    const page = await doc.getPage(n);
    lines.push(...linesFromItems((await page.getTextContent()).items as TextItem[]));
  }
  return { text: lines.join("\n"), pages: doc.numPages, doc, close: () => task.destroy() };
}
