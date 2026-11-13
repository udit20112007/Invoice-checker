"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { analyse, MATCH_LABEL, reportXlsx, VERDICT_LABEL, type Analysis } from "../lib/analyse";
import { checkGstin, cleanGstin } from "../lib/gst";
import { amount, date as parseDate, rupees, showDate } from "../lib/parse";
import { read2bFile, type TwoB } from "../lib/reconcile";
import type { Row } from "../lib/reconcile";
import { aiAvailable, aiRead, readInvoice } from "../lib/reader";
import type { Invoice } from "../lib/types";

type Item = { id: string; file: File; status: "waiting" | "reading" | "done" | "error"; step: string; invoice?: Invoice; preview?: string; error?: string };
type Tab = "invoices" | "gstr2b" | "suppliers";

const money0 = (n: number) => rupees(n, 0);
let seq = 0;
const newId = () => `inv-${++seq}`;

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
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

const Pill = ({ v }: { v: Row["verdict"] }) => <span className={`pill ${v}`}>{VERDICT_LABEL[v]}</span>;

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [twob, setTwob] = useState<TwoB | null>(null);
  const [twobName, setTwobName] = useState("");
  const [twobError, setTwobError] = useState("");
  const [ourGstin, setOurGstin] = useState("");
  const [ourName, setOurName] = useState("");
  const [ai, setAi] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const [tab, setTab] = useState<Tab>("invoices");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  const queue = useRef(Promise.resolve());

  useEffect(() => { aiAvailable().then(setAi); }, []);

  const update = (id: string, patch: Partial<Item>) => setItems((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const addInvoices = (files: File[]) => {
    const fresh = files.filter((f) => /pdf|image\//i.test(f.type) || /\.(pdf|png|jpe?g|webp)$/i.test(f.name)).map((file) => ({ id: newId(), file, status: "waiting" as const, step: "Waiting" }));
    setItems((l) => [...l, ...fresh]);
    for (const it of fresh) {
      queue.current = queue.current.then(async () => {
        update(it.id, { status: "reading", step: "Starting" });
        try {
          let { invoice, preview } = await readInvoice(it.file, it.id, (step) => update(it.id, { step }));
          if (useAi && ai && (invoice.source === "image" || invoice.missing.length)) {
            update(it.id, { step: "Asking the AI reader" });
            try { invoice = await aiRead(invoice, preview); } catch { /* keep what we read */ }
          }
          update(it.id, { status: "done", step: "Done", invoice, preview });
        } catch (e) {
          update(it.id, { status: "error", step: "", error: e instanceof Error ? e.message : "Couldn't read this file." });
        }
      });
    }
  };
  const add2b = async (files: File[]) => {
    setTwobError("");
    try {
      const f = files[0];
      const t = await read2bFile(f.name, new Uint8Array(await f.arrayBuffer()));
      setTwob(t); setTwobName(f.name);
      if (t.gstin && !ourGstin) setOurGstin(t.gstin);
    } catch (e) { setTwobError(e instanceof Error ? e.message : "Couldn't read this file."); }
  };
  const loadDemo = async () => {
    const m = await (await fetch("/demo/manifest.json")).json() as { buyer: { name: string; gstin: string }; files: { file: string }[]; twob: string };
    setOurName(m.buyer.name); setOurGstin(m.buyer.gstin);
    const blob = async (name: string, type: string) => new File([await (await fetch(`/demo/${name}`)).blob()], name, { type });
    await add2b([await blob(m.twob, "application/json")]);
    addInvoices(await Promise.all(m.files.map((f) => blob(f.file, f.file.endsWith(".png") ? "image/png" : "application/pdf"))));
  };
  const reset = () => { setItems([]); setTwob(null); setTwobName(""); setOpen(null); };

  const invoices = items.filter((x) => x.invoice).map((x) => x.invoice!);
  const analysis: Analysis | null = useMemo(() => (invoices.length ? analyse(invoices, twob, { ourGstin, ourName }) : null), [items, twob, ourGstin, ourName]); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = items.some((x) => x.status === "waiting" || x.status === "reading");
  const editInvoice = (id: string, patch: Partial<Invoice>) => setItems((l) => l.map((x) => (x.id === id && x.invoice ? { ...x, invoice: { ...x.invoice, ...patch, readBy: x.invoice.readBy } } : x)));
  const copy = async (key: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 2000); } catch { /* blocked */ } };
  const openRow = analysis?.rows.find((r) => r.inv.id === open);
  const openItem = items.find((x) => x.id === open);

  return (
    <>
      <section className="panel inputs">
        <div className="drops">
          <Drop id="inv-input" title="Purchase invoices" hint="PDFs or phone photos · several at once" accept="application/pdf,image/png,image/jpeg,image/webp" multiple onFiles={addInvoices}>
            {items.length > 0 && <span className="drop-count">{items.length} added</span>}
          </Drop>
          <Drop id="twob-input" title="GSTR-2B (optional)" hint="JSON, Excel or zip from the GST portal" accept=".json,.xlsx,.zip" onFiles={add2b}>
            {twob && <span className="drop-count">{twob.docs.length} invoices · {twobName}</span>}
          </Drop>
        </div>
        {twobError && <p className="error" role="alert">{twobError}</p>}
        <div className="fields-row">
          <label className="field">Your GSTIN<input value={ourGstin} onChange={(e) => setOurGstin(cleanGstin(e.target.value))} placeholder="Filled in from GSTR-2B" maxLength={15} />
            {ourGstin && !checkGstin(ourGstin).ok && <small className="warn-text">This GSTIN isn&apos;t valid</small>}</label>
          <label className="field">Your business name<input value={ourName} onChange={(e) => setOurName(e.target.value)} placeholder="Signs the messages to suppliers" /></label>
          {ai && <label className="check"><input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> Use AI reading for photos and unclear invoices <span className="muted">(sends that invoice to an AI service)</span></label>}
        </div>
        <div className="actions">
          {!items.length && <button className="btn primary" type="button" onClick={loadDemo}>Try the demo pile</button>}
          {items.length > 0 && <button className="btn ghost" type="button" onClick={reset}>Start again</button>}
          <span className="muted small">Invoices are read in your browser and aren&apos;t uploaded{ai ? " unless you switch on AI reading" : ""}.</span>
        </div>
        {items.some((x) => x.status !== "done") && (
          <ul className="progress" aria-live="polite">
            {items.filter((x) => x.status !== "done").map((x) => <li key={x.id} className={x.status}><span>{x.file.name}</span><span>{x.status === "error" ? x.error : x.step}</span></li>)}
          </ul>
        )}
      </section>

      {analysis && (
        <section className="results" aria-busy={busy}>
          <div className="kpis">
            <div className="kpi"><span>Invoices checked</span><b>{analysis.totals.invoices}{busy ? "…" : ""}</b><small><i className="dot green" />{analysis.totals.green} OK · <i className="dot amber" />{analysis.totals.amber} check · <i className="dot red" />{analysis.totals.red} problems</small></div>
            <div className="kpi"><span>GST on these invoices</span><b>{money0(analysis.totals.tax)}</b><small>Input tax credit you would claim</small></div>
            <div className="kpi bad"><span>ITC at risk</span><b>{money0(analysis.totals.atRisk)}</b><small>{analysis.totals.notIn2b ? `${analysis.totals.notIn2b} not in GSTR-2B · ` : ""}{analysis.rows.filter((r) => r.atRisk > 0).length} invoices</small></div>
            <div className="kpi good"><span>Safe to claim</span><b>{money0(analysis.totals.safe)}</b><small>{twob ? "Checked against GSTR-2B" : "Upload GSTR-2B to confirm"}</small></div>
          </div>

          <div className="bar">
            <div className="tabs" role="tablist">
              {([["invoices", `Invoices (${analysis.rows.length})`], ["gstr2b", "GSTR-2B"], ["suppliers", `Suppliers to chase (${analysis.suppliers.length})`]] as [Tab, string][]).map(([k, l]) =>
                <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? " on" : ""}`} type="button" onClick={() => setTab(k)}>{l}</button>)}
            </div>
            <button className="btn primary" type="button" disabled={busy} onClick={() => download(reportXlsx(analysis, twob?.period ?? ""), `invoice-check${twob?.period ? `-${twob.period}` : ""}.xlsx`)}>Download Excel report</button>
          </div>

          {tab === "invoices" && (
            <div className="table-wrap">
              <table className="grid">
                <thead><tr><th>Result</th><th>Supplier</th><th>Invoice</th><th className="num">Total</th><th>GSTR-2B</th><th className="num">ITC at risk</th><th>Main problem</th></tr></thead>
                <tbody>
                  {analysis.rows.map((r) => {
                    const top = r.findings.find((f) => f.level === "red") ?? r.findings.find((f) => f.level === "amber");
                    return (
                      <tr key={r.inv.id} className="clickable" tabIndex={0} onClick={() => setOpen(r.inv.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r.inv.id); }}>
                        <td><Pill v={r.verdict} /></td>
                        <td><div className="strong">{r.inv.supplierName || "—"}</div><div className="mono muted">{r.inv.supplierGstin || "no GSTIN"}</div></td>
                        <td><div>{r.inv.number || "—"}</div><div className="muted small">{showDate(r.inv.date)} · {r.inv.fileName}</div></td>
                        <td className="num">{rupees(r.inv.total)}</td>
                        <td><span className={`tag ${r.match.status}`}>{MATCH_LABEL[r.match.status]}</span></td>
                        <td className="num">{r.atRisk ? <b className="risk">{rupees(r.atRisk)}</b> : "—"}</td>
                        <td>{top?.level !== "red" && r.atRisk > 0 ? <span className="red-text">{r.why}</span> : top ? <span className={top.level === "red" ? "red-text" : "amber-text"}>{top.title}</span> : r.match.status === "mismatch" ? <span className="amber-text">Differs from GSTR-2B</span> : <span className="muted">No problems found</span>}
                          {r.findings.length + (r.match.status === "missing" || r.match.status === "mismatch" ? 1 : 0) > 1 && <span className="muted small"> +{r.findings.length + (r.match.status === "missing" || r.match.status === "mismatch" ? 1 : 0) - 1} more</span>}</td>
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
                  <thead><tr><th>Status</th><th>Supplier</th><th>Invoice</th><th className="num">Invoice total</th><th className="num">GSTR-2B total</th><th>Differences</th></tr></thead>
                  <tbody>
                    {analysis.rows.map((r) => (
                      <tr key={r.inv.id} className="clickable" onClick={() => setOpen(r.inv.id)}>
                        <td><span className={`tag ${r.match.status}`}>{MATCH_LABEL[r.match.status]}</span></td>
                        <td>{r.inv.supplierName}<div className="mono muted">{r.inv.supplierGstin}</div></td>
                        <td>{r.inv.number}<div className="muted small">{showDate(r.inv.date)}</div></td>
                        <td className="num">{rupees(r.inv.total)}</td>
                        <td className="num">{r.match.doc ? rupees(r.match.doc.total) : "—"}</td>
                        <td className="small">{r.match.status === "missing" ? <span className="red-text">The supplier hasn&apos;t reported this invoice: ITC can&apos;t be claimed yet</span> : r.match.diffs.join("; ") || <span className="muted">Matches</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {analysis.extra.length > 0 && <>
                <h3>In GSTR-2B, but no invoice uploaded ({analysis.extra.length})</h3>
                <p className="muted small">Your suppliers reported these. Upload the invoice, or check it isn&apos;t someone else&apos;s purchase billed to your GSTIN.</p>
                <div className="table-wrap"><table className="grid"><thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th><th className="num">Total</th></tr></thead>
                  <tbody>{analysis.extra.map((d) => <tr key={d.id}><td>{d.name}<div className="mono muted">{d.gstin}</div></td><td>{d.number}</td><td>{showDate(d.date)}</td><td className="num">{rupees(d.total)}</td></tr>)}</tbody></table></div>
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
                  <button className="btn" type="button" onClick={() => copy(s.gstin, s.message)}>{copied === s.gstin ? "Copied" : "Copy message"}</button>
                </article>
              ))}
            </div>
          ) : <p className="empty">No supplier needs chasing.</p>)}
        </section>
      )}

      {openRow && openItem && <Detail row={openRow} preview={openItem.preview ?? ""} onClose={() => setOpen(null)} onEdit={(p) => editInvoice(openRow.inv.id, p)} />}
    </>
  );
}

// ---------------------------------------------------------------- one invoice, side by side with its picture
function Detail({ row, preview, onClose, onEdit }: { row: Row; preview: string; onClose: () => void; onEdit: (p: Partial<Invoice>) => void }) {
  const inv = row.inv;
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const num = (k: "taxable" | "cgst" | "sgst" | "igst" | "roundOff" | "total") => (
    <label className="field" key={k}>{({ taxable: "Taxable value", cgst: "CGST", sgst: "SGST", igst: "IGST", roundOff: "Round off", total: "Invoice total" })[k]}
      <input inputMode="decimal" defaultValue={Number.isFinite(inv[k]) ? String(inv[k]) : ""} onBlur={(e) => { const v = amount(e.target.value); onEdit({ [k]: Number.isFinite(v) ? v : k === "taxable" || k === "total" ? NaN : 0 }); }} /></label>
  );
  const text = (k: "supplierName" | "supplierGstin" | "buyerGstin" | "number" | "placeOfSupply", label: string) => (
    <label className="field" key={k}>{label}<input defaultValue={inv[k]} onBlur={(e) => onEdit({ [k]: k.endsWith("Gstin") ? cleanGstin(e.target.value) : e.target.value.trim() })} /></label>
  );
  const q = inv.qr;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={`Invoice ${inv.number}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="detail">
        <header className="detail-head">
          <div><Pill v={row.verdict} /> <b>{inv.supplierName || inv.fileName}</b> <span className="muted">· {inv.number || "no number"} · {showDate(inv.date)}</span></div>
          <button className="btn ghost" type="button" onClick={onClose} aria-label="Close">Close</button>
        </header>
        <div className="detail-body">
          <div className="preview">{preview ? <img src={preview} alt={`Invoice ${inv.fileName}`} /> : <p className="muted">No preview</p>}</div>
          <div className="side">
            {row.atRisk > 0 && <div className="callout red">ITC at risk: <b>{rupees(row.atRisk)}</b> · {row.why}</div>}
            <h3>What we found</h3>
            {row.findings.length === 0 && row.match.status !== "missing" && <p className="ok-text">No problems found. The invoice is complete and the numbers add up.</p>}
            <ul className="findings">
              {row.match.status === "missing" && <li className="red"><b>Not in GSTR-2B</b><span>The supplier hasn&apos;t reported this invoice in their GSTR-1, so you can&apos;t claim its ITC yet. Ask them to file it.</span><small>Section 16(2)(aa), CGST Act</small></li>}
              {row.match.status === "mismatch" && <li className="amber"><b>Differs from GSTR-2B</b><span>{row.match.diffs.join("; ")}</span></li>}
              {row.findings.map((f, i) => <li key={i} className={f.level}><b>{f.title}</b><span>{f.detail}</span>{f.rule && <small>{f.rule}</small>}</li>)}
            </ul>
            {q?.kind === "einvoice" && (
              <>
                <h3>E-invoice QR code</h3>
                <table className="qr">
                  <thead><tr><th></th><th>In the QR</th><th>Printed</th></tr></thead>
                  <tbody>
                    {([["Supplier GSTIN", q.sellerGstin, inv.supplierGstin], ["Buyer GSTIN", q.buyerGstin, inv.buyerGstin], ["Invoice no.", q.docNo, inv.number], ["Date", showDate(q.docDate), showDate(inv.date)], ["Total", rupees(q.total), rupees(inv.total)]] as [string, string, string][]).map(([l, a, b]) =>
                      <tr key={l} className={a.replace(/\W/g, "").toUpperCase() !== b.replace(/\W/g, "").toUpperCase() ? "differs" : ""}><th>{l}</th><td className="mono">{a}</td><td className="mono">{b}</td></tr>)}
                  </tbody>
                </table>
                <p className="muted small">Read from the QR the government portal added when the invoice was registered ({q.issuer || "IRP"}). Checking its digital signature is the next step.</p>
              </>
            )}
            {q?.kind === "upi" && <p className="muted small">UPI payment QR: {q.name || q.payee}{q.amount ? ` · ${rupees(q.amount)}` : ""}</p>}
            <h3>Details read from the invoice</h3>
            <p className="muted small">Read by {inv.readBy === "ocr" ? "OCR from the image" : inv.readBy === "ai" ? "the AI reader" : "the PDF's text"}. Correct anything that&apos;s wrong; the checks update straight away.{inv.missing.length ? ` Not found: ${inv.missing.join(", ")}.` : ""}</p>
            <div className="edit-grid" key={inv.id}>
              {text("supplierName", "Supplier name")}{text("supplierGstin", "Supplier GSTIN")}{text("buyerGstin", "Buyer GSTIN")}{text("number", "Invoice number")}
              <label className="field">Invoice date<input type="date" defaultValue={inv.date ?? ""} onBlur={(e) => onEdit({ date: parseDate(e.target.value) })} /></label>
              {text("placeOfSupply", "Place of supply")}
              {num("taxable")}{num("cgst")}{num("sgst")}{num("igst")}{num("roundOff")}{num("total")}
            </div>
            {inv.items.length > 0 && (
              <table className="items"><thead><tr><th>Item</th><th>HSN</th><th className="num">Taxable</th><th className="num">GST %</th></tr></thead>
                <tbody>{inv.items.map((it, i) => <tr key={i}><td>{it.description}</td><td className={it.hsn ? "mono" : "amber-text"}>{it.hsn || "missing"}</td><td className="num">{rupees(it.taxable)}</td><td className="num">{it.rate ?? "—"}</td></tr>)}</tbody></table>
            )}
            <details><summary>Text we read</summary><pre>{inv.text}</pre></details>
          </div>
        </div>
      </div>
    </div>
  );
}
