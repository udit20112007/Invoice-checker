"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { analyse, reportXlsx, type Analysis } from "../lib/analyse";
import { checkGstin, cleanGstin } from "../lib/gst";
import { amount, date as parseDate, invoiceKey, rupees, showDate } from "../lib/parse";
import { mergeTwoB, read2bFile, twobChanges, type TwoB } from "../lib/reconcile";
import type { Row } from "../lib/reconcile";
import { aiAvailable, aiRead, readInvoices } from "../lib/reader";
import { BASE, HAS_SERVER } from "../lib/base";
import { checkVehicle, EWAYBILL_URL, PARIVAHAN_URL } from "../lib/vehicle";
import { readSheetFile } from "../lib/sheets";
import { parseRegister } from "../lib/register";
import { addDays, daysBetween, paidFor, parsePayments, type PaidInfo, type Payment } from "../lib/payments";
import { parseLookup, type GstinStatus } from "../lib/gstinstatus";
import { DICT, findingTitle, LANGS, type Lang, type T } from "../lib/i18n";
import { matchBank, parseBank, type BankEntry } from "../lib/bank";
import { isTallyXml, parseTallyXml } from "../lib/tally";
import { supplierScores } from "../lib/score";
import { draft3b, total4, type Tax4 } from "../lib/gstr3b";
import { chapterOf } from "../lib/hsn";
import { writeXlsx } from "../lib/xlsx";
import { ageing, imsForExtra, imsForRow, noticeReply, payLines, spoken } from "../lib/insights";
import { lock, unlock } from "../lib/savefile";
import Insights from "./Insights";
import type { Invoice } from "../lib/types";

type Item = { id: string; file: File; status: "waiting" | "reading" | "done" | "error"; step: string; invoice?: Invoice; preview?: string; error?: string };
type Tab = "invoices" | "gstr2b" | "suppliers" | "scores" | "insights" | "payments" | "gstr3b" | "clients";
type Saved = { v: 1; ourGstin: string; ourName: string; items: { id: string; name: string; invoice: Invoice; preview: string }[]; register: Invoice[]; twobs: TwoB[]; payments: Payment[]; bank: BankEntry[]; paidByHand: Record<string, PaidInfo>; gstinInfo: Record<string, GstinStatus>; edits: EditLog[]; msme: string[] };
// numbers that weren't read are NaN in the app and null in a saved file
const reviveInvoice = (i: Invoice): Invoice => ({ ...i, taxable: i.taxable ?? NaN, total: i.total ?? NaN });
type TourStep = { title: string; text: string; tab?: Tab; open?: string };
const TOUR: TourStep[] = [
  { title: "18 bills, checked in seconds", text: "Every bill was read in this browser, checked against the GST rules and matched with GSTR-2B. The red box is the input tax credit a tax officer could take back.", tab: "invoices" },
  { title: "An edited invoice", text: "The QR code was signed by the government portal for ₹1,18,000. The printed total says ₹1,81,000, and the PDF was changed in an editing tool three days later.", tab: "invoices", open: "invoice-07.pdf" },
  { title: "A forged invoice", text: "This QR code wasn't signed by the portal at all. The supplier registered this month, and shares a bank account with another supplier.", tab: "invoices", open: "invoice-13.pdf" },
  { title: "Who is linked to whom", text: "Royal Cables and Shiv Shakti Enterprises share a bank account, and their invoice numbers run on from each other: one bill book, two firms.", tab: "insights" },
  { title: "Pay late, lose the credit", text: "Kumar Agencies hasn't been paid in over 180 days, so ₹7,200 of ITC has to be paid back. For risky bills the advice is to pay the goods and hold the GST.", tab: "payments" },
  { title: "Ready for the return", text: "A draft of GSTR-3B Table 4: what to claim, what to reverse, and what to hold until the supplier files.", tab: "gstr3b" },
  { title: "Chase the suppliers", text: "A message for each supplier is written for you: copy it, or send it on WhatsApp. The audit pack and Excel report keep the proof.", tab: "suppliers" },
];
type EditLog = { id: string; file: string; field: string; from: string; to: string; at: string };
type Client = { name: string; gstin: string; period: string; savedOn: string; invoices: number; problems: number; tax: number; atRisk: number; safe: number };
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const loadClients = (): Client[] => { try { const j = JSON.parse(localStorage.getItem("ic-clients") ?? "[]"); return Array.isArray(j) ? j : []; } catch { return []; } };
const canPickFolder = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

const money0 = (n: number) => rupees(n, 0);
const todayIso = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
let seq = 0;
const newId = () => `inv-${++seq}`;
const sameBill = (a: Invoice, b: Invoice) => cleanGstin(a.supplierGstin) === cleanGstin(b.supplierGstin) && invoiceKey(a.number) === invoiceKey(b.number);

function download(bytes: Uint8Array | string, name: string, type = XLSX_TYPE) {
  const url = URL.createObjectURL(new Blob([typeof bytes === "string" ? bytes : bytes.slice()], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function Drop({ id, title, hint, accept, multiple, onFiles, children }: { id: string; title: string; hint: string; accept: string; multiple?: boolean; onFiles: (f: File[]) => void; children?: React.ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <label className={`drop${over ? " over" : ""}`} htmlFor={id}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); }}>
      <input id={id} type="file" accept={accept} multiple={multiple} onChange={(e) => { if (e.target.files?.length) onFiles([...e.target.files]); e.target.value = ""; }} />
      <span className="drop-title">{title}</span>
      <span className="drop-hint">{hint}</span>
      {children}
    </label>
  );
}

const verdictText = (t: T, v: Row["verdict"]) => (v === "red" ? t.vProblem : v === "amber" ? t.vCheck : t.vOk);
const matchText = (t: T, m: Row["match"]["status"]) => ({ matched: t.mMatched, mismatch: t.mMismatch, missing: t.mMissing, unchecked: t.mUnchecked })[m];
const Pill = ({ v, t }: { v: Row["verdict"]; t: T }) => <span className={`pill ${v}`}>{verdictText(t, v)}</span>;

export default function App() {
  const [lang, setLang] = useState<Lang>("en");
  const t = DICT[lang];
  const [items, setItems] = useState<Item[]>([]);
  const [twobs, setTwobs] = useState<TwoB[]>([]);
  const [twobName, setTwobName] = useState("");
  const twob = useMemo(() => mergeTwoB(twobs), [twobs]);
  const changes = useMemo(() => twobChanges(twobs), [twobs]);
  const [bank, setBank] = useState<BankEntry[]>([]);
  const [edits, setEdits] = useState<EditLog[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [pack, setPack] = useState(false);
  const [folderOk, setFolderOk] = useState(false);
  const [msme, setMsme] = useState<string[]>([]);
  const [reply, setReply] = useState(false);
  const [tour, setTour] = useState(-1);
  const [isDemo, setIsDemo] = useState(false);
  const [device, setDevice] = useState({ touch: false, speech: false });
  const [password, setPassword] = useState("");
  const [saveNote, setSaveNote] = useState("");
  const [register, setRegister] = useState<Invoice[]>([]);
  const [registerName, setRegisterName] = useState("");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsName, setPaymentsName] = useState("");
  const [paidByHand, setPaidByHand] = useState<Record<string, PaidInfo>>({});
  const [gstinInfo, setGstinInfo] = useState<Record<string, GstinStatus>>({});
  const [lookupOn, setLookupOn] = useState(false);
  const [lookupAvailable, setLookupAvailable] = useState(false);
  const [error, setError] = useState("");
  const [ourGstin, setOurGstin] = useState("");
  const [ourName, setOurName] = useState("");
  const [ai, setAi] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const [tab, setTab] = useState<Tab>("invoices");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  const queue = useRef(Promise.resolve());
  const asked = useRef(new Set<string>());

  useEffect(() => {
    try { const l = localStorage.getItem("ic-lang"); if (LANGS.some(([k]) => k === l)) setLang(l as Lang); } catch { /* storage blocked */ }
    setClients(loadClients()); setFolderOk(canPickFolder());
    setDevice({ touch: window.matchMedia("(pointer: coarse)").matches, speech: "speechSynthesis" in window });
    aiAvailable().then(setAi);
    if (HAS_SERVER) fetch(`${BASE}/api/gstin`, { cache: "no-store" }).then((r) => r.json()).then((j) => setLookupAvailable(j.enabled === true)).catch(() => {});
  }, []);
  useEffect(() => { document.documentElement.lang = lang === "en" ? "en-IN" : lang; try { localStorage.setItem("ic-lang", lang); } catch { /* storage blocked */ } }, [lang]);

  const update = (id: string, patch: Partial<Item>) => setItems((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const addInvoices = (files: File[]) => {
    const fresh = files.filter((f) => /pdf|image\//i.test(f.type) || /\.(pdf|png|jpe?g|webp)$/i.test(f.name)).map((file) => ({ id: newId(), file, status: "waiting" as const, step: "Waiting" }));
    setItems((l) => [...l, ...fresh]);
    for (const it of fresh) {
      queue.current = queue.current.then(async () => {
        update(it.id, { status: "reading", step: "Starting" });
        try {
          const results = await readInvoices(it.file, it.id, (step) => update(it.id, { step }));
          const done: Item[] = [];
          for (const r of results) {
            let invoice = r.invoice;
            // AI reading for photos, anything missing, and pictures the OCR found hard (handwriting, blur)
            if (useAi && ai && (invoice.source === "image" || invoice.missing.length || (invoice.ocrConfidence ?? 100) < 60)) {
              update(it.id, { step: "Asking the AI reader" });
              try { invoice = await aiRead(invoice, r.preview); } catch { /* keep what we read */ }
            }
            done.push({ id: invoice.id, file: it.file, status: "done", step: "Done", invoice, preview: r.preview });
          }
          // a PDF with several invoices in it becomes several rows
          setItems((l) => l.flatMap((x) => (x.id === it.id ? done : [x])));
        } catch (e) {
          update(it.id, { status: "error", step: "", error: e instanceof Error ? e.message : "Couldn't read this file." });
        }
      });
    }
  };
  const guard = async (fn: () => Promise<void>) => { setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't read this file."); } };
  const bytesOf = async (f: File) => new Uint8Array(await f.arrayBuffer());
  // one file, or several months of GSTR-2B
  const add2b = (files: File[]) => guard(async () => {
    const read: TwoB[] = [];
    for (const f of files) read.push(await read2bFile(f.name, await bytesOf(f)));
    setTwobs((l) => [...l, ...read]); setTwobName(files.length > 1 ? `${files.length} files` : files[0].name);
    const g = read.map((x) => x.gstin).find(Boolean);
    if (g && !ourGstin) setOurGstin(g);
  });
  const addRegister = (files: File[]) => guard(async () => {
    const f = files[0], bytes = await bytesOf(f);
    const text = /\.xml$/i.test(f.name) ? new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8").decode(bytes) : "";
    if (text && !isTallyXml(text)) throw new Error("This XML file isn't a Tally export. In Tally, export the Day Book or Purchase Register as XML.");
    setRegister(text ? parseTallyXml(text) : parseRegister(readSheetFile(f.name, bytes))); setRegisterName(f.name);
  });
  // a payments list (invoice number + amount), or a bank statement whose payments are matched to invoices
  const addPayments = (files: File[]) => guard(async () => {
    const f = files[0], sheets = readSheetFile(f.name, await bytesOf(f));
    let p: Payment[] = [];
    try { p = parsePayments(sheets); } catch { /* not a payments list: try it as a bank statement */ }
    if (p.length) { setPayments(p); setBank([]); } else { setBank(parseBank(sheets)); setPayments([]); }
    setPaymentsName(f.name);
  });
  // a whole folder: every file goes to the right place by its type and name
  const addAny = async (files: File[]) => {
    const is = (f: File, re: RegExp) => re.test(f.name);
    const inv = files.filter((f) => is(f, /\.(pdf|png|jpe?g|webp)$/i));
    const b2 = files.filter((f) => is(f, /\.(json|zip)$/i) || (is(f, /\.xlsx$/i) && is(f, /2b/i)));
    const pay = files.find((f) => is(f, /\.(xlsx|csv)$/i) && is(f, /pay|bank|statement/i) && !b2.includes(f));
    const reg = files.find((f) => (is(f, /\.xml$/i) || (is(f, /\.(xlsx|csv)$/i) && is(f, /regist|purchase|tally|day\s*book/i))) && !b2.includes(f) && f !== pay);
    if (b2.length) await add2b(b2);
    if (reg) await addRegister([reg]);
    if (pay) await addPayments([pay]);
    if (inv.length) addInvoices(inv);
    if (!b2.length && !reg && !pay && !inv.length) setError("No invoices, GSTR-2B, register or payment files were found in that folder.");
  };
  const openFolder = async () => {
    try {
      const dir = await (window as unknown as { showDirectoryPicker(): Promise<{ values(): AsyncIterable<{ kind: string; getFile(): Promise<File> }> }> }).showDirectoryPicker();
      const files: File[] = [];
      for await (const h of dir.values()) if (h.kind === "file" && files.length < 300) files.push(await h.getFile());
      await addAny(files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
    } catch { /* cancelled */ }
  };
  const reminder = () => {
    const d = new Date(), y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0");
    download(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Invoice Checker//EN", "BEGIN:VEVENT", `UID:invoice-checker-monthly-${y}${m}@invoice-checker`, `DTSTAMP:${y}${m}01T000000Z`, `DTSTART;VALUE=DATE:${y}${m}14`,
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=14", "SUMMARY:Check purchase invoices against GSTR-2B", "DESCRIPTION:GSTR-2B for last month is ready on the GST portal today. Download it and run Invoice Checker on last month's purchase invoices before filing GSTR-3B (due on the 20th).",
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Check purchase invoices against GSTR-2B", "TRIGGER:PT9H", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n"), "invoice-check-reminder.ics", "text/calendar");
  };
  const loadDemo = async () => {
    const m = await (await fetch(`${BASE}/demo/manifest.json`)).json() as { buyer: { name: string; gstin: string }; files: { file: string }[]; twob: string; register?: string; payments?: string; gstinStatus?: string };
    setOurName(m.buyer.name); setOurGstin(m.buyer.gstin);
    const blob = async (name: string, type = "") => new File([await (await fetch(`${BASE}/demo/${name}`)).blob()], name, { type });
    await add2b([await blob(m.twob, "application/json")]);
    if (m.register) await addRegister([await blob(m.register)]);
    if (m.payments) await addPayments([await blob(m.payments, "text/csv")]);
    if (m.gstinStatus) {
      const j = await (await fetch(`${BASE}/demo/${m.gstinStatus}`)).json() as { records: Record<string, unknown> };
      setGstinInfo(Object.fromEntries(Object.entries(j.records).map(([g, r]) => [g, parseLookup(g, r, "demo")]).filter(([, s]) => s)) as Record<string, GstinStatus>);
    }
    addInvoices(await Promise.all(m.files.map((f) => blob(f.file, f.file.endsWith(".png") ? "image/png" : "application/pdf"))));
    setIsDemo(true);
  };
  const reset = () => { setItems([]); setTwobs([]); setBank([]); setEdits([]); setMsme([]); setIsDemo(false); setTour(-1); setReply(false); setTwobName(""); setRegister([]); setRegisterName(""); setPayments([]); setPaymentsName(""); setPaidByHand({}); setGstinInfo({}); asked.current.clear(); setOpen(null); setError(""); };

  const read = items.filter((x) => x.invoice).map((x) => x.invoice!);
  // register rows that are already uploaded as invoices are left out, so nothing counts twice
  const invoices = useMemo(() => [...read, ...register.filter((r) => !read.some((x) => sameBill(x, r)))], [items, register]); // eslint-disable-line react-hooks/exhaustive-deps

  // online GSTIN lookup: only supplier GSTINs leave the browser, one at a time
  useEffect(() => {
    if (!lookupOn || !lookupAvailable) return;
    const todo = [...new Set(invoices.map((i) => cleanGstin(i.supplierGstin)))].filter((g) => g && checkGstin(g).ok && !gstinInfo[g] && !asked.current.has(g));
    (async () => {
      for (const g of todo) {
        asked.current.add(g);
        try {
          const j = await (await fetch(`${BASE}/api/gstin?g=${g}`, { cache: "no-store" })).json();
          if (j.status) setGstinInfo((m) => ({ ...m, [g]: j.status }));
        } catch { /* try again on the next change */ asked.current.delete(g); }
      }
    })();
  }, [invoices, lookupOn, lookupAvailable]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = todayIso();
  const banked = useMemo(() => matchBank(bank, invoices), [bank, invoices]);
  const allPayments = useMemo(() => [...payments, ...banked.payments], [payments, banked]);
  const analysis: Analysis | null = useMemo(() => (invoices.length ? analyse(invoices, twob, { ourGstin, ourName, today, gstin: gstinInfo, payments: allPayments, paidByHand }) : null),
    [invoices, twob, ourGstin, ourName, today, gstinInfo, allPayments, paidByHand]);
  const scores = useMemo(() => (analysis ? supplierScores(analysis.rows, gstinInfo) : []), [analysis, gstinInfo]);
  const g3 = useMemo(() => (analysis ? draft3b(analysis.rows, !!twob) : null), [analysis, twob]);
  const busy = items.some((x) => x.status === "waiting" || x.status === "reading");
  const editInvoice = (id: string, patch: Partial<Invoice>) => {
    // every correction is kept for the audit pack
    const before = invoices.find((x) => x.id === id);
    if (before) {
      const log = Object.entries(patch).filter(([k, v]) => String(v ?? "") !== String(before[k as keyof Invoice] ?? "") && !(Number.isNaN(v) && Number.isNaN(before[k as keyof Invoice])))
        .map(([k, v]) => ({ id, file: before.fileName, field: k, from: String(before[k as keyof Invoice] ?? ""), to: String(v ?? ""), at: new Date().toLocaleString("en-IN") }));
      if (log.length) setEdits((l) => [...l, ...log]);
    }
    setItems((l) => l.map((x) => (x.id === id && x.invoice ? { ...x, invoice: { ...x.invoice, ...patch, readBy: x.invoice.readBy } } : x)));
    setRegister((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };
  const setPaid = (inv: Invoice, paid: number | null) => setPaidByHand((m) => {
    const n = { ...m };
    if (paid === null) delete n[inv.id]; else n[inv.id] = { paid, lastDate: today };
    return n;
  });
  const copy = async (key: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 2000); } catch { /* blocked */ } };
  const openRow = analysis?.rows.find((r) => r.inv.id === open);
  const openItem = items.find((x) => x.id === open);
  const tracksPayments = allPayments.length > 0 || Object.keys(paidByHand).length > 0;
  const saveClients = (l: Client[]) => { setClients(l); try { localStorage.setItem("ic-clients", JSON.stringify(l)); } catch { /* storage blocked */ } };
  const saveClient = () => {
    if (!analysis) return;
    const c: Client = { name: ourName || analysis.ourGstin || "Client", gstin: analysis.ourGstin, period: twob?.period ?? "", savedOn: today, invoices: analysis.totals.invoices, problems: analysis.totals.red, tax: analysis.totals.tax, atRisk: analysis.totals.atRisk, safe: analysis.totals.safe };
    saveClients([c, ...clients.filter((x) => !(x.gstin === c.gstin && x.name === c.name && x.period === c.period))]);
  };
  // save the work to a password-locked file, and open it again later
  const saveWork = () => guard(async () => {
    if (password.length < 6) throw new Error("Choose a password of at least 6 characters for the save file.");
    const data: Saved = { v: 1, ourGstin, ourName, items: items.filter((x) => x.invoice).map((x) => ({ id: x.id, name: x.file.name, invoice: x.invoice!, preview: x.preview ?? "" })), register, twobs, payments, bank, paidByHand, gstinInfo, edits, msme };
    download(await lock(data, password), `invoice-check-${today}.icsave`, "application/octet-stream");
    setSaveNote("Saved. Keep the password: the file can't be opened without it.");
  });
  const openWork = (files: File[]) => guard(async () => {
    setSaveNote("");
    const d = await unlock<Saved>(await bytesOf(files[0]), password);
    setOurGstin(d.ourGstin ?? ""); setOurName(d.ourName ?? "");
    setItems((d.items ?? []).map((x) => ({ id: x.id, file: new File([], x.name), status: "done" as const, step: "Done", invoice: reviveInvoice(x.invoice), preview: x.preview })));
    seq = Math.max(seq, ...(d.items ?? []).map((x) => Number(x.id.match(/\d+/)?.[0] ?? 0)));
    setRegister((d.register ?? []).map(reviveInvoice)); setRegisterName(d.register?.length ? "saved file" : "");
    setTwobs(d.twobs ?? []); setTwobName(d.twobs?.length ? "saved file" : "");
    setPayments(d.payments ?? []); setBank(d.bank ?? []); setPaymentsName(d.payments?.length || d.bank?.length ? "saved file" : "");
    setPaidByHand(d.paidByHand ?? {}); setGstinInfo(d.gstinInfo ?? {}); setEdits(d.edits ?? []); setMsme(d.msme ?? []);
    setSaveNote(`Opened: ${d.items?.length ?? 0} invoices.`);
  });
  const speak = () => {
    if (!analysis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(spoken(analysis, lang === "hi"));
    u.lang = lang === "hi" ? "hi-IN" : "en-IN";
    speechSynthesis.speak(u);
  };
  const goTour = (i: number) => {
    setTour(i);
    const st = TOUR[i];
    if (!st) { setOpen(null); return; }
    if (st.tab) setTab(st.tab);
    setOpen(st.open ? items.find((x) => x.file.name === st.open)?.id ?? null : null);
  };
  useEffect(() => {
    if (!pack) return;
    document.documentElement.classList.add("printing");
    const done = () => { document.documentElement.classList.remove("printing"); setPack(false); };
    window.addEventListener("afterprint", done, { once: true });
    const t = setTimeout(() => window.print(), 400);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); document.documentElement.classList.remove("printing"); };
  }, [pack]);

  return (
    <>
      <header className="top">
        <div className="wrap top-row">
          <div className="brand"><span className="mark" aria-hidden="true">✓</span>Invoice Checker</div>
          <span className="muted small">{t.tagline}</span>
          <select className="lang" aria-label="Language / भाषा" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGS.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
          </select>
        </div>
      </header>
      <main className="wrap">
        <section className="hero">
          <h1>{t.h1}</h1>
          <p>{t.lead}</p>
          <ol className="steps">
            {[t.step1, t.step2, t.step3].map((s, i) => <li key={i} dangerouslySetInnerHTML={{ __html: s }} />)}
          </ol>
        </section>

        <section className="panel inputs">
          <div className="drops four">
            <Drop id="inv-input" title={t.invoices} hint={t.invoicesHint} accept="application/pdf,image/png,image/jpeg,image/webp" multiple onFiles={addInvoices}>
              {items.length > 0 && <span className="drop-count">{items.length} {t.added}</span>}
            </Drop>
            <Drop id="twob-input" title={t.twob} hint={t.twobHint} accept=".json,.xlsx,.zip" multiple onFiles={add2b}>
              {twob && <span className="drop-count">{twob.docs.length} · {twobName}</span>}
            </Drop>
            <Drop id="reg-input" title={t.register} hint={t.registerHint} accept=".xlsx,.csv,.xml" onFiles={addRegister}>
              {register.length > 0 && <span className="drop-count">{register.length} · {registerName}</span>}
            </Drop>
            <Drop id="pay-input" title={t.payments} hint={t.paymentsHint} accept=".xlsx,.csv" onFiles={addPayments}>
              {payments.length > 0 && <span className="drop-count">{payments.length} · {paymentsName}</span>}
              {bank.length > 0 && <span className="drop-count">{banked.matched} of {bank.length} payments matched · {paymentsName}</span>}
            </Drop>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="fields-row">
            <label className="field">{t.ourGstin}<input value={ourGstin} onChange={(e) => setOurGstin(cleanGstin(e.target.value))} placeholder={t.ourGstinPh} maxLength={15} />
              {ourGstin && !checkGstin(ourGstin).ok && <small className="warn-text">{t.badGstin}</small>}</label>
            <label className="field">{t.ourName}<input value={ourName} onChange={(e) => setOurName(e.target.value)} placeholder={t.ourNamePh} /></label>
            {ai && <label className="check"><input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> {t.useAi} <span className="muted">{t.useAiNote}</span></label>}
            {lookupAvailable && <label className="check"><input type="checkbox" checked={lookupOn} onChange={(e) => setLookupOn(e.target.checked)} /> {t.lookup} <span className="muted">{t.lookupNote}</span></label>}
          </div>
          <div className="actions">
            {!items.length && !register.length && <button className="btn primary" type="button" onClick={loadDemo}>{t.demo}</button>}
            {(items.length > 0 || register.length > 0) && <button className="btn ghost" type="button" onClick={reset}>{t.again}</button>}
            {device.touch && <label className="btn camera">Take a photo<input type="file" accept="image/*" capture="environment" onChange={(e) => { if (e.target.files?.length) addInvoices([...e.target.files]); e.target.value = ""; }} /></label>}
            {folderOk && <button className="btn" type="button" onClick={openFolder}>{t.folder}</button>}
            <button className="btn" type="button" onClick={reminder}>{t.remind}</button>
            <span className="muted small">{t.privacy}</span>
          </div>
          <details className="savebox">
            <summary>Save your work, or open a saved file</summary>
            <div className="save-row">
              <label className="field">Password for the file<input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              <button className="btn" type="button" disabled={!invoices.length} onClick={saveWork}>Save to a file</button>
              <label className="btn">Open a saved file<input type="file" accept=".icsave" onChange={(e) => { if (e.target.files?.length) openWork([...e.target.files]); e.target.value = ""; }} /></label>
              {saveNote && <span className="ok-text small" role="status">{saveNote}</span>}
            </div>
            <p className="muted small">The file holds your invoices and results, locked with the password (AES-256). It stays on this device.</p>
          </details>
          {items.some((x) => x.status !== "done") && (
            <ul className="progress" aria-live="polite">
              {items.filter((x) => x.status !== "done").map((x) => <li key={x.id} className={x.status}><span>{x.file.name}</span><span>{x.status === "error" ? x.error : x.step}</span></li>)}
            </ul>
          )}
        </section>

        {analysis && (
          <section className="results" aria-busy={busy}>
            <div className="kpis">
              <div className="kpi"><span>{t.kChecked}</span><b>{analysis.totals.invoices}{busy ? "…" : ""}</b><small><i className="dot green" />{analysis.totals.green} {t.kOk} · <i className="dot amber" />{analysis.totals.amber} {t.kCheck} · <i className="dot red" />{analysis.totals.red} {t.kProblems}</small></div>
              <div className="kpi"><span>{t.kGst}</span><b>{money0(analysis.totals.tax)}</b><small>{t.kGstNote}</small></div>
              <div className="kpi bad"><span>{t.kRisk}</span><b>{money0(analysis.totals.atRisk)}</b><small>{analysis.totals.notIn2b ? `${analysis.totals.notIn2b} ${t.kNotIn2b} · ` : ""}{analysis.rows.filter((r) => r.atRisk > 0).length} {t.kInvoices}</small></div>
              <div className="kpi good"><span>{t.kSafe}</span><b>{money0(analysis.totals.safe)}</b><small>{twob ? t.kSafe2b : t.kSafeNo2b}</small></div>
            </div>

            {(isDemo || device.speech) && <div className="actions">
              {isDemo && !busy && <button className="btn primary" type="button" onClick={() => goTour(0)}>Guided tour (2 minutes)</button>}
              {device.speech && <button className="btn" type="button" disabled={busy} onClick={speak}>Listen to the summary</button>}
            </div>}

            <div className="bar">
              <div className="tabs" role="tablist">
                {([["invoices", `${t.tInvoices} (${analysis.rows.length})`], ["gstr2b", t.tTwob], ["suppliers", `${t.tSuppliers} (${analysis.suppliers.length})`], ["scores", t.tScores], ["insights", t.tInsights], ["payments", t.tPayments], ["gstr3b", t.tGstr3b], ["clients", `${t.tClients}${clients.length ? ` (${clients.length})` : ""}`]] as [Tab, string][]).map(([k, l]) =>
                  <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? " on" : ""}`} type="button" onClick={() => setTab(k)}>{l}</button>)}
              </div>
              <div className="bar-actions">
                <button className="btn" type="button" disabled={busy} onClick={() => setPack(true)}>{t.audit}</button>
                <button className="btn primary" type="button" disabled={busy} onClick={() => download(reportXlsx(analysis, twob?.period ?? ""), `invoice-check${twob?.period ? `-${twob.period}` : ""}.xlsx`)}>{t.excel}</button>
              </div>
            </div>

            {tab === "invoices" && (
              <div className="table-wrap">
                <table className="grid">
                  <thead><tr><th>{t.hResult}</th><th>{t.hSupplier}</th><th>{t.hInvoice}</th><th className="num">{t.hTotal}</th><th>{t.hTwob}</th><th className="num">{t.hRisk}</th><th>{t.hProblem}</th></tr></thead>
                  <tbody>
                    {analysis.rows.map((r) => {
                      const top = r.findings.find((f) => f.level === "red") ?? r.findings.find((f) => f.level === "amber");
                      const count = r.findings.length + (r.match.status === "missing" || r.match.status === "mismatch" ? 1 : 0);
                      return (
                        <tr key={r.inv.id} className="clickable" tabIndex={0} onClick={() => setOpen(r.inv.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r.inv.id); }}>
                          <td><Pill v={r.verdict} t={t} /></td>
                          <td><div className="strong">{r.inv.supplierName || "—"}</div><div className="mono muted">{r.inv.supplierGstin || "no GSTIN"}</div></td>
                          <td><div>{r.inv.number || "—"}{r.inv.docType !== "invoice" && <span className="tag note">{r.inv.docType === "credit" ? "Credit note" : "Debit note"}</span>}</div><div className="muted small">{showDate(r.inv.date)} · {r.inv.fileName}</div></td>
                          
                          <td className="num">{r.inv.docType === "credit" ? "−" : ""}{rupees(r.inv.total)}</td>
                          <td><span className={`tag ${r.match.status}`}>{matchText(t, r.match.status)}</span></td>
                          <td className="num">{r.atRisk ? <b className="risk">{rupees(r.atRisk)}</b> : "—"}</td>
                          <td>{top?.level !== "red" && r.atRisk > 0 ? <span className="red-text">{r.why}</span> : top ? <span className={top.level === "red" ? "red-text" : "amber-text"}>{findingTitle(lang, top.code, top.title)}</span> : r.match.status === "mismatch" ? <span className="amber-text">{t.differs2b}</span> : <span className="muted">{t.noProblems}</span>}
                            {count > 1 && <span className="muted small"> +{count - 1} {t.more}</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {tab === "gstr2b" && (!twob ? <p className="empty">Upload GSTR-2B to see which invoices your suppliers have reported.</p> : (
              <div className="stack">
                <div className="table-wrap">
                  <table className="grid">
                    <thead><tr><th>Status</th><th>{t.hSupplier}</th><th>{t.hInvoice}</th><th className="num">Invoice total</th><th className="num">GSTR-2B total</th><th>Differences</th><th>IMS action</th></tr></thead>
                    <tbody>
                      {analysis.rows.map((r) => (
                        <tr key={r.inv.id} className="clickable" onClick={() => setOpen(r.inv.id)}>
                          <td><span className={`tag ${r.match.status}`}>{matchText(t, r.match.status)}</span></td>
                          <td>{r.inv.supplierName}<div className="mono muted">{r.inv.supplierGstin}</div></td>
                          <td>{r.inv.number}<div className="muted small">{showDate(r.inv.date)}</div></td>
                          <td className="num">{rupees(r.inv.total)}</td>
                          <td className="num">{r.match.doc ? rupees(r.match.doc.total) : "—"}</td>
                          <td className="small">{r.match.status === "missing" ? <span className="red-text">The supplier hasn&apos;t reported this invoice: ITC can&apos;t be claimed yet</span> : r.match.diffs.join("; ") || <span className="muted">Matches</span>}</td>
                          <td className="small">{(() => { const a = imsForRow(r); return a ? <span title={a.why} className={a.action === "Accept" ? "ok-text" : "amber-text"}>{a.action}</span> : "—"; })()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted small">IMS action: what to do with each entry in the GST portal&apos;s Invoice Management System before GSTR-2B is final. Hover for the reason.</p>
                <div className="actions"><button className="btn" type="button" onClick={() => setReply((v) => !v)}>{reply ? "Hide the notice reply" : "Draft a reply to an ITC mismatch notice"}</button></div>
                {reply && <div className="panel supplier">
                  <p className="muted small">A starting draft for a reply to DRC-01C or ASMT-10. Fill in the blanks, choose the sentence in square brackets that applies, and have your tax adviser check it.</p>
                  <textarea className="tall" readOnly value={noticeReply(analysis, ourName, twob.period)} aria-label="Draft reply to the notice" />
                  <button className="btn" type="button" onClick={() => copy("reply", noticeReply(analysis, ourName, twob.period))}>{copied === "reply" ? "Copied" : "Copy the draft"}</button>
                </div>}
                {changes.length > 0 && <>
                  <h3>Changed between GSTR-2B files ({changes.length})</h3>
                  <div className="table-wrap"><table className="grid"><thead><tr><th>{t.hSupplier}</th><th>{t.hInvoice}</th><th>Files</th><th>What changed</th></tr></thead>
                    <tbody>{changes.map((c, i) => <tr key={i}><td>{c.name}<div className="mono muted">{c.gstin}</div></td><td>{c.number}</td><td>{c.from} → {c.to}</td><td className="amber-text">{c.what}</td></tr>)}</tbody></table></div>
                </>}
                {analysis.extra.length > 0 && <>
                  <h3>In GSTR-2B, but no invoice uploaded ({analysis.extra.length})</h3>
                  <p className="muted small">Your suppliers reported these. Upload the invoice, or check it isn&apos;t someone else&apos;s purchase billed to your GSTIN.</p>
                  <div className="table-wrap"><table className="grid"><thead><tr><th>{t.hSupplier}</th><th>{t.hInvoice}</th><th>Date</th><th className="num">{t.hTotal}</th><th>IMS action</th></tr></thead>
                    <tbody>{analysis.extra.map((d) => <tr key={d.id}><td>{d.name}<div className="mono muted">{d.gstin}</div></td><td>{d.number}{d.kind !== "INV" && <span className="tag note">{d.kind === "CN" ? "Credit note" : "Debit note"}</span>}</td><td>{showDate(d.date)}</td><td className="num">{rupees(d.total)}</td><td className="small"><span className="amber-text">{imsForExtra(d).action}</span><div className="muted">{imsForExtra(d).why}</div></td></tr>)}</tbody></table></div>
                </>}
              </div>
            ))}

            {tab === "suppliers" && (analysis.suppliers.length ? (
              <div className="suppliers">
                {analysis.suppliers.map((s) => (
                  <article key={s.gstin} className="panel supplier">
                    <div className="row-between"><h3>{s.name || s.gstin}</h3>{s.atRisk > 0 && <b className="risk">{rupees(s.atRisk)} at risk</b>}</div>
                    <div className="mono muted">{s.gstin}</div>
                    <textarea readOnly value={s.message} aria-label={`Message for ${s.name}`} />
                    <div className="actions">
                      <button className="btn" type="button" onClick={() => copy(s.gstin, s.message)}>{copied === s.gstin ? "Copied" : "Copy message"}</button>
                      <a className="btn whatsapp" href={`https://wa.me/?text=${encodeURIComponent(s.message)}`} target="_blank" rel="noopener noreferrer">{t.whatsapp}</a>
                    </div>
                  </article>
                ))}
              </div>
            ) : <p className="empty">No supplier needs chasing.</p>)}

            {tab === "scores" && (
              <div className="stack">
                <p className="muted small">Each supplier starts at 100 and loses points for problems on their bills: invalid or cancelled GSTIN, invoices missing from GSTR-2B, wrong tax, late returns, suspicious patterns. A is safe; D needs attention before you pay or claim.</p>
                <div className="table-wrap"><table className="grid">
                  <thead><tr><th>Score</th><th>{t.hSupplier}</th><th className="num">Bills</th><th className="num">Purchases</th><th className="num">{t.hRisk}</th><th>Why</th></tr></thead>
                  <tbody>{scores.map((s) => (
                    <tr key={s.gstin}>
                      <td><span className={`grade g${s.grade}`}>{s.grade}</span> <b>{s.score}</b></td>
                      <td>{s.name || "—"}<div className="mono muted">{s.gstin}</div></td>
                      <td className="num">{s.invoices}</td><td className="num">{rupees(s.purchases, 0)}</td>
                      <td className="num">{s.atRisk ? <b className="risk">{rupees(s.atRisk)}</b> : "—"}</td>
                      <td className="small">{s.reasons.join("; ") || <span className="muted">No problems</span>}
                        {s.tds && <div className="amber-text">Purchases of {rupees(s.tds.purchases, 0)} in {s.tds.fy} are over ₹50 lakh: if your turnover last year was above ₹10 crore, deduct TDS of {rupees(s.tds.tds)} (0.1% of the amount above ₹50 lakh; section 194Q of the 1961 Act, carried into the Income-tax Act, 2025).</div>}</td>
                    </tr>))}</tbody>
                </table></div>
              </div>
            )}

            {tab === "insights" && <Insights analysis={analysis} />}

            {tab === "gstr3b" && g3 && (
              <div className="stack">
                <p className="muted small">A working draft of GSTR-3B Table 4 from the invoices loaded here. Check it against your books and the portal before filing.</p>
                <div className="table-wrap"><table className="grid">
                  <thead><tr><th>Table</th><th>Details</th><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th><th className="num">Cess</th><th className="num">Total</th><th className="num">Bills</th></tr></thead>
                  <tbody>
                    {g3.lines.map((l) => <tr key={l.key}><td className="strong">{l.key}</td><td>{l.label}<div className="muted small">{l.note}</div></td><TaxCells tax={l.tax} /><td className="num">{l.rows.length}</td></tr>)}
                    <tr className="net"><td className="strong">4(C)</td><td className="strong">Net ITC available (A − B)</td><TaxCells tax={g3.net} /><td /></tr>
                    <tr><td>—</td><td>{g3.waiting.label}<div className="muted small">{g3.waiting.note}</div></td><TaxCells tax={g3.waiting.tax} /><td className="num">{g3.waiting.rows.length}</td></tr>
                    <tr><td className="strong">3.1(d)</td><td>Tax to pay under reverse charge<div className="muted small">Pay this in cash; it comes back as ITC in 4(A)(3)</div></td><TaxCells tax={g3.rcmPayable} /><td /></tr>
                  </tbody>
                </table></div>
              </div>
            )}

            {tab === "clients" && (
              <div className="stack">
                <div className="actions">
                  <button className="btn primary" type="button" onClick={saveClient}>Save this check{ourName ? ` for ${ourName}` : ""}</button>
                  {clients.length > 0 && <button className="btn" type="button" onClick={() => download(writeXlsx([{ name: "Clients", widths: [30, 18, 12, 12, 10, 10, 14, 14, 14], money: [6, 7, 8], rows: [["Client", "GSTIN", "GSTR-2B period", "Checked on", "Invoices", "Problems", "GST on invoices", "ITC at risk", "Safe to claim"], ...clients.map((c) => [c.name, c.gstin, c.period, showDate(c.savedOn), String(c.invoices), String(c.problems), c.tax, c.atRisk, c.safe])] }]), "clients.xlsx")}>Download as Excel</button>}
                  <span className="muted small">For accountants: keep each client&apos;s result here. Only these totals are kept, in this browser.</span>
                </div>
                {clients.length ? (
                  <div className="table-wrap"><table className="grid">
                    <thead><tr><th>Client</th><th>Period</th><th>Checked on</th><th className="num">Invoices</th><th className="num">Problems</th><th className="num">GST</th><th className="num">{t.hRisk}</th><th className="num">{t.kSafe}</th><th /></tr></thead>
                    <tbody>{clients.map((c, i) => (
                      <tr key={i}><td>{c.name}<div className="mono muted">{c.gstin}</div></td><td>{c.period || "—"}</td><td>{showDate(c.savedOn)}</td><td className="num">{c.invoices}</td><td className="num">{c.problems}</td>
                        <td className="num">{rupees(c.tax, 0)}</td><td className="num">{c.atRisk ? <b className="risk">{rupees(c.atRisk, 0)}</b> : "—"}</td><td className="num">{rupees(c.safe, 0)}</td>
                        <td><button type="button" className="link small" onClick={() => saveClients(clients.filter((_, k) => k !== i))}>Remove</button></td></tr>))}
                      <tr className="net"><td className="strong">All clients</td><td /><td /><td className="num">{clients.reduce((a, c) => a + c.invoices, 0)}</td><td className="num">{clients.reduce((a, c) => a + c.problems, 0)}</td>
                        <td className="num">{rupees(clients.reduce((a, c) => a + c.tax, 0), 0)}</td><td className="num">{rupees(clients.reduce((a, c) => a + c.atRisk, 0), 0)}</td><td className="num">{rupees(clients.reduce((a, c) => a + c.safe, 0), 0)}</td><td /></tr>
                    </tbody>
                  </table></div>
                ) : <p className="empty">No clients saved yet.</p>}
              </div>
            )}

            {tab === "payments" && bank.length > 0 && <p className="muted small">Bank statement: {banked.matched} of {bank.length} payments matched to invoices by invoice number, or by amount and supplier name.{banked.unmatched.length ? ` Not matched: ${banked.unmatched.slice(0, 3).map((e) => `${rupees(e.paidOut, 0)} (${e.narration.slice(0, 30)})`).join(", ")}${banked.unmatched.length > 3 ? "…" : ""}.` : ""}</p>}
            {tab === "payments" && <Payments rows={analysis.rows} payments={allPayments} paidByHand={paidByHand} tracks={tracksPayments} today={today} onPaid={setPaid} onOpen={setOpen} msme={msme} onMsme={(g, on) => setMsme((l) => (on ? [...new Set([...l, g])] : l.filter((x) => x !== g)))} />}
          </section>
        )}

        <VehicleTool t={t} />

        {tour >= 0 && TOUR[tour] && (
          <aside className="tour" role="dialog" aria-label="Guided tour">
            <div className="muted small">Step {tour + 1} of {TOUR.length}</div>
            <b>{TOUR[tour].title}</b>
            <p>{TOUR[tour].text}</p>
            <div className="actions">
              {tour > 0 && <button className="btn" type="button" onClick={() => goTour(tour - 1)}>Back</button>}
              {tour < TOUR.length - 1 ? <button className="btn primary" type="button" onClick={() => goTour(tour + 1)}>Next</button> : <button className="btn primary" type="button" onClick={() => goTour(-1)}>Finish</button>}
              <button className="btn ghost" type="button" onClick={() => goTour(-1)}>Close</button>
            </div>
          </aside>
        )}

        {pack && analysis && <AuditPack analysis={analysis} items={items} edits={edits} ourName={ourName} period={twob?.period ?? ""} lang={lang} />}

        {openRow && <Detail row={openRow} preview={openItem?.preview ?? ""} lang={lang} t={t} reg={gstinInfo[cleanGstin(openRow.inv.supplierGstin)]} onClose={() => setOpen(null)} onEdit={(p) => editInvoice(openRow.inv.id, p)} />}
      </main>
      <footer className="wrap foot">
        {t.foot} Rules used: CGST Act sections 16 and 31, CGST Rules 21A, 46, 48 and 138, IGST Act sections 7–8, GST rate notifications of 17 Sep 2025 (GST 2.0).
      </footer>
    </>
  );
}

const TaxCells = ({ tax }: { tax: Tax4 }) => <>{(["igst", "cgst", "sgst", "cess"] as const).map((k) => <td key={k} className="num">{tax[k] ? rupees(tax[k]) : "—"}</td>)}<td className="num strong">{rupees(total4(tax))}</td></>;

// ---------------------------------------------------------------- the audit pack: printed, or saved as a PDF from the print window
function AuditPack({ analysis, items, edits, ourName, period, lang }: { analysis: Analysis; items: Item[]; edits: EditLog[]; ourName: string; period: string; lang: Lang }) {
  const a = analysis.totals;
  return (
    <section className="print-pack">
      <div className="pack-page">
        <h1>Invoice check: audit pack</h1>
        <p>{ourName || "—"} · GSTIN {analysis.ourGstin || "—"}{period ? ` · GSTR-2B ${period}` : ""} · prepared {new Date().toLocaleDateString("en-IN")}</p>
        <table className="grid"><tbody>
          <tr><td>Invoices checked</td><td className="num">{a.invoices}</td></tr><tr><td>OK / to check / problems</td><td className="num">{a.green} / {a.amber} / {a.red}</td></tr>
          <tr><td>GST on these invoices</td><td className="num">{rupees(a.tax)}</td></tr><tr><td>ITC at risk</td><td className="num">{rupees(a.atRisk)}</td></tr><tr><td>ITC safe to claim</td><td className="num">{rupees(a.safe)}</td></tr>
        </tbody></table>
        <h2>Invoices</h2>
        <table className="grid"><thead><tr><th>Result</th><th>Supplier</th><th>Invoice</th><th className="num">Total</th><th>GSTR-2B</th><th className="num">ITC at risk</th></tr></thead>
          <tbody>{analysis.rows.map((r) => <tr key={r.inv.id}><td>{r.verdict === "red" ? "Problem" : r.verdict === "amber" ? "Check" : "OK"}</td><td>{r.inv.supplierName}<br />{r.inv.supplierGstin}</td><td>{r.inv.number}<br />{showDate(r.inv.date)}</td><td className="num">{rupees(r.inv.total)}</td><td>{r.match.status}</td><td className="num">{r.atRisk ? rupees(r.atRisk) : "—"}</td></tr>)}</tbody></table>
        {edits.length > 0 && <>
          <h2>Corrections made by hand ({edits.length})</h2>
          <table className="grid"><thead><tr><th>File</th><th>Field</th><th>Read as</th><th>Changed to</th><th>When</th></tr></thead>
            <tbody>{edits.map((e, i) => <tr key={i}><td>{e.file}</td><td>{e.field}</td><td>{e.from || "—"}</td><td>{e.to || "—"}</td><td>{e.at}</td></tr>)}</tbody></table>
        </>}
      </div>
      {analysis.rows.map((r) => {
        const preview = items.find((x) => x.id === r.inv.id)?.preview;
        return (
          <div className="pack-page" key={r.inv.id}>
            <h2>{r.inv.supplierName || r.inv.fileName} · {r.inv.number || "no number"} · {showDate(r.inv.date)}</h2>
            <p>{r.inv.fileName} · supplier GSTIN {r.inv.supplierGstin || "—"} · total {rupees(r.inv.total)} · GST {rupees(r.tax)} · {r.verdict === "red" ? "Problem" : r.verdict === "amber" ? "Check" : "OK"}{r.atRisk ? ` · ITC at risk ${rupees(r.atRisk)} (${r.why})` : ""}</p>
            <div className="pack-cols">
              {preview && <img src={preview} alt="" />}
              <div>
                <h3>Findings</h3>
                {r.findings.length === 0 && r.match.status !== "missing" && r.match.status !== "mismatch" && <p>No problems found.</p>}
                <ul>
                  {r.match.status === "missing" && <li><b>Not in GSTR-2B.</b> The supplier hasn&apos;t reported this invoice. Section 16(2)(aa), CGST Act.</li>}
                  {r.match.status === "mismatch" && <li><b>Differs from GSTR-2B.</b> {r.match.diffs.join("; ")}</li>}
                  {r.findings.map((f, i) => <li key={i}><b>{findingTitle(lang, f.code, f.title)}.</b> {f.detail}{f.rule ? ` (${f.rule})` : ""}</li>)}
                </ul>
                {edits.some((e) => e.id === r.inv.id) && <><h3>Corrections</h3><ul>{edits.filter((e) => e.id === r.inv.id).map((e, i) => <li key={i}>{e.field}: “{e.from || "—"}” → “{e.to || "—"}” ({e.at})</li>)}</ul></>}
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------- the 180-day payment rule
function Payments({ rows, payments, paidByHand, tracks, today, onPaid, onOpen, msme, onMsme }: {
  rows: Row[]; payments: Payment[]; paidByHand: Record<string, PaidInfo>; tracks: boolean; today: string;
  onPaid: (inv: Invoice, paid: number | null) => void; onOpen: (id: string) => void; msme: string[]; onMsme: (gstin: string, on: boolean) => void;
}) {
  const lines = payLines(rows, (r) => paidByHand[r.inv.id] ?? paidFor(r.inv, payments), today, new Set(msme));
  const more = new Map(lines.map((l) => [l.row.inv.id, l]));
  const ages = ageing(lines);
  const list = rows.filter((r) => r.inv.date && Number.isFinite(r.inv.total) && r.inv.total > 0 && !r.inv.reverseCharge && !r.findings.some((f) => f.code === "duplicate"))
    .map((r) => {
      const p = paidByHand[r.inv.id] ?? paidFor(r.inv, payments);
      const due = addDays(r.inv.date!, 180), unpaid = Math.max(0, Math.round((r.inv.total - p.paid) * 100) / 100);
      return { r, p, due, unpaid, left: daysBetween(today, due), byHand: !!paidByHand[r.inv.id] };
    })
    .sort((a, b) => (a.unpaid > 1 ? 0 : 1) - (b.unpaid > 1 ? 0 : 1) || a.due.localeCompare(b.due));
  const overdue = list.filter((x) => x.unpaid > 1 && x.left < 0), soon = list.filter((x) => x.unpaid > 1 && x.left >= 0 && x.left <= 30);
  return (
    <div className="stack">
      <p className="muted small">If you don&apos;t pay a supplier within 180 days of the invoice date, the ITC on the unpaid part has to be paid back with interest (Section 16(2), second proviso). {tracks ? "" : "Upload a payments file, or enter what you've paid below, to track this."}</p>
      {tracks && <div className="pay-sum">
        <span className={overdue.length ? "red-text" : "ok-text"}><b>{overdue.length}</b> past 180 days</span>
        <span className={soon.length ? "amber-text" : "muted"}><b>{soon.length}</b> due within 30 days</span>
        <span className="muted"><b>{rupees(list.reduce((a, x) => a + x.unpaid, 0), 0)}</b> unpaid in all</span>
      </div>}
      {tracks && <div className="ageing" aria-label="Unpaid bills by age">
        {ages.map((a) => <div key={a.label} className={a.label === "Over 180" && a.bills ? "bad" : ""}><span>{a.label}</span><b>{rupees(a.unpaid, 0)}</b><small>{a.bills} bill{a.bills === 1 ? "" : "s"}</small></div>)}
      </div>}
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Status</th><th>Supplier</th><th>Invoice</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Unpaid</th><th>Pay by</th><th>Advice</th><th title="Micro or small enterprise: must be paid within 45 days">MSME</th></tr></thead>
          <tbody>
            {list.map(({ r, p, due, unpaid, left, byHand }) => {
              const status = !tracks ? ["muted", "—"] : unpaid <= 1 ? ["ok-text", "Paid"] : left < 0 ? ["red-text", `${-left} days late`] : left <= 30 ? ["amber-text", `${left} days left`] : ["muted", `${left} days left`];
              return (
                <tr key={r.inv.id}>
                  <td><span className={status[0]}>{status[1]}</span></td>
                  <td className="clickable" onClick={() => onOpen(r.inv.id)}>{r.inv.supplierName}<div className="mono muted">{r.inv.supplierGstin}</div></td>
                  <td>{r.inv.number}<div className="muted small">{showDate(r.inv.date)}</div></td>
                  <td className="num">{rupees(r.inv.total)}</td>
                  <td className="num">
                    <input className="paid-input" inputMode="decimal" aria-label={`Amount paid on ${r.inv.number}`} key={`${r.inv.id}-${p.paid}-${byHand}`} defaultValue={tracks ? String(p.paid) : ""} placeholder="0"
                      onBlur={(e) => { const v = e.target.value.trim(); const n = amount(v); onPaid(r.inv, v === "" ? null : Number.isFinite(n) ? n : null); }} />
                    <button type="button" className="link small" onClick={() => onPaid(r.inv, r.inv.total)}>Paid in full</button>
                  </td>
                  <td className="num">{tracks && unpaid > 1 ? rupees(unpaid) : "—"}</td>
                  <td>{showDate(due)}</td>
                  <td className="small">{tracks ? (() => { const l = more.get(r.inv.id); return l ? <>{l.advice && <span className={l.hold > 0 ? "amber-text" : "muted"}>{l.advice}</span>}{l.msmeLate > 0 && <div className="red-text">MSME supplier unpaid {l.msmeLate} days past the 45-day limit: the expense isn&apos;t deductible until paid, and interest is due</div>}</> : null; })() : "—"}</td>
                  <td><input type="checkbox" aria-label={`${r.inv.supplierName} is an MSME`} checked={msme.includes(cleanGstin(r.inv.supplierGstin))} onChange={(e) => onMsme(cleanGstin(r.inv.supplierGstin), e.target.checked)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one invoice, side by side with its picture
function Detail({ row, preview, lang, t, reg, onClose, onEdit }: { row: Row; preview: string; lang: Lang; t: T; reg?: GstinStatus; onClose: () => void; onEdit: (p: Partial<Invoice>) => void }) {
  const inv = row.inv;
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const num = (k: "taxable" | "cgst" | "sgst" | "igst" | "roundOff" | "total") => (
    <label className="field" key={k}>{({ taxable: "Taxable value", cgst: "CGST", sgst: "SGST", igst: "IGST", roundOff: "Round off", total: "Invoice total" })[k]}
      <input inputMode="decimal" defaultValue={Number.isFinite(inv[k]) ? String(inv[k]) : ""} onBlur={(e) => { const v = amount(e.target.value); onEdit({ [k]: Number.isFinite(v) ? v : k === "taxable" || k === "total" ? NaN : 0 }); }} /></label>
  );
  const text = (k: "supplierName" | "supplierGstin" | "buyerGstin" | "number" | "placeOfSupply" | "vehicle" | "ewayBill" | "refNumber", label: string) => (
    <label className="field" key={k}>{label}<input defaultValue={inv[k]} onBlur={(e) => onEdit({ [k]: k.endsWith("Gstin") ? cleanGstin(e.target.value) : k === "vehicle" ? e.target.value.toUpperCase().trim() : e.target.value.trim() })} /></label>
  );
  const veh = inv.vehicle ? checkVehicle(inv.vehicle) : null;
  const q = inv.qr;
  const sig = q?.kind === "einvoice" ? q.signature : undefined;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={`Invoice ${inv.number}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="detail">
        <header className="detail-head">
          <div><Pill v={row.verdict} t={t} /> <b>{inv.supplierName || inv.fileName}</b> <span className="muted">· {inv.number || "no number"} · {showDate(inv.date)}</span></div>
          <button className="btn ghost" type="button" onClick={onClose} aria-label={t.close}>{t.close}</button>
        </header>
        <div className="detail-body">
          <div className="preview">{preview ? <img src={preview} alt={`Invoice ${inv.fileName}`} /> : <p className="muted">{inv.source === "register" ? "From the purchase register: upload the invoice to read and check it in full." : "No preview"}</p>}</div>
          <div className="side">
            {row.atRisk > 0 && <div className="callout red">{t.kRisk}: <b>{rupees(row.atRisk)}</b> · {row.why}</div>}
            <h3>{t.found} {t.english && <span className="muted small">{t.english}</span>}</h3>
            {row.findings.length === 0 && row.match.status !== "missing" && <p className="ok-text">{t.noProblems}. The invoice is complete and the numbers add up.</p>}
            <ul className="findings">
              {row.match.status === "missing" && <li className="red"><b>{t.mMissing}</b><span>The supplier hasn&apos;t reported this invoice in their GSTR-1, so you can&apos;t claim its ITC yet. Ask them to file it.</span><small>Section 16(2)(aa), CGST Act</small></li>}
              {row.match.status === "mismatch" && <li className="amber"><b>{t.differs2b}</b><span>{row.match.diffs.join("; ")}</span></li>}
              {row.findings.map((f, i) => <li key={i} className={f.level}><b>{findingTitle(lang, f.code, f.title)}</b><span>{f.detail}</span>{f.rule && <small>{f.rule}</small>}</li>)}
            </ul>
            {q?.kind === "einvoice" && (
              <>
                <h3>E-invoice QR code</h3>
                {sig && <div className={`sig ${sig.status}`}>
                  {sig.status === "verified" ? <>✓ Digital signature verified{sig.key ? ` · ${sig.key}` : ""}</> : sig.status === "invalid" ? <>✗ The signature doesn&apos;t match any IRP key: this QR wasn&apos;t made by the government portal</> : <>Signature not checked: no IRP public key is set up (add it to irp-keys.json)</>}
                </div>}
                <table className="qr">
                  <thead><tr><th></th><th>In the QR</th><th>Printed</th></tr></thead>
                  <tbody>
                    {([["Supplier GSTIN", q.sellerGstin, inv.supplierGstin], ["Buyer GSTIN", q.buyerGstin, inv.buyerGstin], ["Invoice no.", q.docNo, inv.number], ["Date", showDate(q.docDate), showDate(inv.date)], ["Total", rupees(q.total), rupees(inv.total)]] as [string, string, string][]).map(([l, a, b]) =>
                      <tr key={l} className={a.replace(/\W/g, "").toUpperCase() !== b.replace(/\W/g, "").toUpperCase() ? "differs" : ""}><th>{l}</th><td className="mono">{a}</td><td className="mono">{b}</td></tr>)}
                  </tbody>
                </table>
                <p className="muted small">Read from the QR the Invoice Registration Portal adds when the invoice is registered ({q.issuer || "IRP"}).</p>
              </>
            )}
            {reg && (
              <>
                <h3>Supplier registration</h3>
                <div className="transport">
                  <div><span className="muted small">Status</span><b className={/active/i.test(reg.status) ? "ok-text" : "red-text"}>{reg.status || "—"}</b>{reg.cancelledOn && <span className="small">Cancelled {showDate(reg.cancelledOn)}</span>}</div>
                  <div><span className="muted small">Registered to</span><b>{reg.tradeName || reg.legalName}</b>{reg.tradeName && reg.legalName && reg.tradeName !== reg.legalName && <span className="small muted">{reg.legalName}</span>}</div>
                  <div><span className="muted small">Registered on</span><b>{showDate(reg.registeredOn)}</b><span className="small muted">{reg.source === "demo" ? "Demo data" : "GST data service"}</span></div>
                </div>
              </>
            )}
            {(veh || inv.ewayBill) && (
              <>
                <h3>Transport</h3>
                <div className="transport">
                  {veh && <div><span className="muted small">Vehicle</span><b className="mono">{veh.pretty}</b>
                    <span className={veh.ok ? "ok-text small" : "red-text small"}>{veh.ok ? `${veh.kind === "bh" ? "Bharat series" : `${veh.state} · RTO ${veh.rto}`}` : veh.problems[0]}</span>
                    {veh.ok && <a className="small" href={PARIVAHAN_URL} target="_blank" rel="noopener noreferrer">Check its registration on Parivahan ↗</a>}</div>}
                  {inv.ewayBill && <div><span className="muted small">E-way bill</span><b className="mono">{inv.ewayBill}</b>
                    <a className="small" href={EWAYBILL_URL} target="_blank" rel="noopener noreferrer">Verify on the e-way bill portal ↗</a></div>}
                </div>
              </>
            )}
            {q?.kind === "upi" && <p className="muted small">UPI payment QR: {q.name || q.payee}{q.amount ? ` · ${rupees(q.amount)}` : ""}</p>}
            <h3>Details read from the invoice</h3>
            <p className="muted small">Read by {inv.source === "register" ? "the purchase register" : inv.readBy === "ocr" ? "OCR from the image" : inv.readBy === "ai" ? "the AI reader" : "the PDF's text"}. Correct anything that&apos;s wrong; the checks update straight away.{inv.missing.length ? ` Not found: ${inv.missing.join(", ")}.` : ""}</p>
            <div className="edit-grid" key={inv.id}>
              {text("supplierName", "Supplier name")}{text("supplierGstin", "Supplier GSTIN")}{text("buyerGstin", "Buyer GSTIN")}{text("number", "Invoice number")}
              <label className="field">Invoice date<input type="date" defaultValue={inv.date ?? ""} onBlur={(e) => onEdit({ date: parseDate(e.target.value) })} /></label>
              {text("placeOfSupply", "Place of supply")}
              {text("vehicle", "Vehicle number")}{text("ewayBill", "E-way bill number")}
              <label className="field">Document<select defaultValue={inv.docType} onChange={(e) => onEdit({ docType: e.target.value as Invoice["docType"] })}><option value="invoice">Tax invoice</option><option value="credit">Credit note</option><option value="debit">Debit note</option></select></label>
              {inv.docType !== "invoice" && text("refNumber", "Against invoice no.")}
              {num("taxable")}{num("cgst")}{num("sgst")}{num("igst")}{num("roundOff")}{num("total")}
            </div>
            {inv.items.length > 0 && (
              <table className="items"><thead><tr><th>Item</th><th>HSN</th><th className="num">Taxable</th><th className="num">GST %</th></tr></thead>
                <tbody>{inv.items.map((it, i) => <tr key={i}><td>{it.description}</td><td className={it.hsn ? "mono" : "amber-text"}>{it.hsn || "missing"}{chapterOf(it.hsn) && <div className="muted small sans">{chapterOf(it.hsn)}</div>}</td><td className="num">{rupees(it.taxable)}</td><td className="num">{it.rate ?? "—"}</td></tr>)}</tbody></table>
            )}
            <details><summary>Text we read</summary><pre>{inv.text}</pre></details>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- a quick vehicle number check
function VehicleTool({ t }: { t: T }) {
  const [value, setValue] = useState("");
  const v = value.trim() ? checkVehicle(value) : null;
  return (
    <section className="panel vehicle-tool" aria-labelledby="veh-title">
      <div>
        <h2 id="veh-title">{t.vehTitle}</h2>
        <p className="muted small">{t.vehLead}</p>
      </div>
      <div className="veh-row">
        <label className="field">{t.vehLabel}<input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. MH 12 AB 1234" maxLength={20} autoCapitalize="characters" /></label>
        {v && (
          <div className={`veh-result ${v.ok ? "ok" : "bad"}`} role="status">
            <b className="mono">{v.pretty}</b>
            {v.ok ? <span>{v.kind === "bh" ? "Bharat series (BH) number" : `${v.state} · RTO code ${v.rto}`}</span> : <span>{v.problems.join(" ")}</span>}
            {v.notes.map((n, i) => <span key={i} className="muted small">{n}</span>)}
            {v.ok && <a href={PARIVAHAN_URL} target="_blank" rel="noopener noreferrer">Look it up on Parivahan (official) ↗</a>}
          </div>
        )}
      </div>
    </section>
  );
}
