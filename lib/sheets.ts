// Reading spreadsheets: Excel (.xlsx) and CSV, as rows of text per sheet.
import { strFromU8, unzipSync } from "fflate";

export type SheetRows = { name: string; rows: string[][] };

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");
const colIndex = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** Excel day numbers (e.g. 46313) to yyyy-mm-dd */
export const excelDate = (serial: number) => new Date(Math.round((serial - 25569) * 864e5)).toISOString().slice(0, 10);

export function readXlsx(bytes: Uint8Array): SheetRows[] {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error("This isn't an Excel (.xlsx) file. Save old .xls files as .xlsx first."); }
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : "");
  if (!files["xl/workbook.xml"]) throw new Error("This isn't an Excel (.xlsx) file.");
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  // which cell styles are dates, so day numbers can be shown as dates
  const styles = read("xl/styles.xml");
  const dateFmts = new Set([...styles.matchAll(/<numFmt [^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].filter((m) => /[dy]/i.test(m[2].replace(/"[^"]*"|\[[^\]]*\]/g, ""))).map((m) => +m[1]));
  const xfs = [...(styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "").matchAll(/<xf [^>]*?(?:numFmtId="(\d+)")?[^>]*?\/?>/g)].map((m) => +(m[0].match(/numFmtId="(\d+)"/)?.[1] ?? 0));
  const isDate = (s: number) => { const id = xfs[s] ?? 0; return (id >= 14 && id <= 22) || dateFmts.has(id); };
  const rels = Object.fromEntries([...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship [^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const sheets = [...read("xl/workbook.xml").matchAll(/<sheet [^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)].map((m) => ({ name: unesc(m[1]), path: `xl/${(rels[m[2]] ?? "").replace(/^\/?xl\//, "")}` }));
  return sheets.map((s) => {
    const rows: string[][] = [];
    for (const r of read(s.path).matchAll(/<row [^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = [];
      for (const c of (r[1] ?? "").matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = c[1].match(/r="([A-Z]+\d+)"/)?.[1] ?? "A1", t = c[1].match(/t="(\w+)"/)?.[1], st = +(c[1].match(/s="(\d+)"/)?.[1] ?? 0);
        const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? c[2]?.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
        cells[colIndex(ref)] = t === "s" ? shared[+v] ?? "" : t === "inlineStr" || t === "str" ? unesc(v) : v && isDate(st) && /^\d+(\.\d+)?$/.test(v) ? excelDate(+v) : unesc(v);
      }
      rows.push(Array.from(cells, (x) => x ?? ""));
    }
    return { name: s.name, rows };
  });
}

export function readCsv(text: string): SheetRows[] {
  const src = text.replace(/^﻿/, "");
  const first = src.split("\n", 1)[0];
  const d = [",", ";", "\t"].map((c) => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && !cell) q = true;
    else if (ch === d) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && src[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return [{ name: "CSV", rows: rows.filter((r) => r.some((c) => c.trim())) }];
}

export function readSheetFile(name: string, bytes: Uint8Array): SheetRows[] {
  if (/\.xlsx$/i.test(name)) return readXlsx(bytes);
  if (/\.(csv|txt)$/i.test(name)) return readCsv(new TextDecoder().decode(bytes));
  throw new Error("Choose an Excel (.xlsx) or CSV file.");
}

/** Finds the heading row (within the first 15) where the most columns are recognised, and maps fields to columns. */
export function mapColumns<F extends string>(rows: string[][], patterns: [F, RegExp, RegExp?][]): { headAt: number; col: Partial<Record<F, number>> } {
  let best = { headAt: -1, col: {} as Partial<Record<F, number>>, n: 0 };
  for (let r = 0; r < Math.min(15, rows.length); r++) {
    const heads = (rows[r] ?? []).map((h) => String(h).toLowerCase().replace(/\s+/g, " ").trim());
    const col: Partial<Record<F, number>> = {};
    const used = new Set<number>();
    for (const [f, re, not] of patterns) {
      const i = heads.findIndex((h, j) => h && !used.has(j) && re.test(h) && !(not && not.test(h)));
      if (i >= 0) { col[f] = i; used.add(i); }
    }
    const n = Object.keys(col).length;
    if (n > best.n) best = { headAt: r, col, n };
  }
  return { headAt: best.headAt, col: best.col };
}
