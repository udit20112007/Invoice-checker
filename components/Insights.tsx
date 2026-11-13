"use client";

import { useMemo, useState } from "react";
import type { Analysis } from "../lib/analyse";
import { amount, rupees } from "../lib/parse";
import { BENFORD, BENFORD_MIN, benford, interest, monthly, recoverable, ringMap, rule42 } from "../lib/insights";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`;
const Num = ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
  <label className="field">{label}<input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0" /></label>
);
const n = (s: string) => { const v = amount(s); return Number.isFinite(v) ? v : 0; };

export default function Insights({ analysis }: { analysis: Analysis }) {
  const rows = analysis.rows;
  const ring = useMemo(() => ringMap(rows), [rows]);
  const months = useMemo(() => monthly(rows), [rows]);
  const ben = useMemo(() => benford(rows.filter((r) => !r.findings.some((f) => f.code === "duplicate")).map((r) => r.inv.total)), [rows]);
  const back = recoverable(rows);
  const [output, setOutput] = useState(""), [days, setDays] = useState("90"), [common, setCommon] = useState(""), [exempt, setExempt] = useState(""), [turnover, setTurnover] = useState("");
  const safe = analysis.totals.safe, cash = Math.max(0, n(output) - safe);

  // the ring map: suppliers on a circle, a line for every shared detail
  const W = 560, H = 260, cx = W / 2, cy = H / 2, R = 85;
  const pos = new Map(ring.nodes.map((node, i) => { const a = (2 * Math.PI * i) / Math.max(1, ring.nodes.length) + (ring.nodes.length === 2 ? Math.PI : -Math.PI / 2); return [node.id, { x: cx + R * 1.7 * Math.cos(a), y: cy + R * Math.sin(a) }]; }));
  const top = Math.max(1, ...months.map((m) => m.tax));

  return (
    <div className="insights">
      <article className="panel">
        <h3>Linked suppliers</h3>
        <p className="muted small">Suppliers that share a bank account, phone, email or vehicle, or whose invoice numbers run on from each other. Separate firms rarely do; fake-invoice rings often do.</p>
        {ring.edges.length ? (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} className="ring" role="img" aria-label={`Links between ${ring.nodes.length} suppliers`}>
              {ring.edges.map((e, i) => { const a = pos.get(e.a)!, b = pos.get(e.b)!; return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="ring-edge" strokeWidth={1.5 + e.why.length} />; })}
              {ring.nodes.map((node) => { const p = pos.get(node.id)!; return (
                <g key={node.id}>
                  <circle cx={p.x} cy={p.y} r={16 + Math.min(14, node.bills * 3)} className={node.atRisk > 0 ? "ring-node bad" : "ring-node"} />
                  <text x={p.x} y={p.y + 4} textAnchor="middle" className="ring-count">{node.bills}</text>
                  <text x={p.x} y={p.y + (p.y > cy ? 48 : -36)} textAnchor="middle" className="ring-label">{node.name}</text>
                </g>); })}
            </svg>
            <ul className="ring-list">
              {ring.edges.map((e, i) => <li key={i}><b>{ring.nodes.find((x) => x.id === e.a)?.name}</b> ↔ <b>{ring.nodes.find((x) => x.id === e.b)?.name}</b>: {e.why.join(", ")}</li>)}
            </ul>
          </>
        ) : <p className="empty">No links found between suppliers.</p>}
      </article>

      <article className="panel">
        <h3>Month by month</h3>
        <p className="muted small">GST on the bills of each month, and how much of it is at risk.</p>
        <div className="bars" role="img" aria-label="GST and ITC at risk by month">
          {months.map((m) => (
            <div className="bar-col" key={m.month} title={`${monthName(m.month)}: GST ${rupees(m.tax, 0)}, at risk ${rupees(m.atRisk, 0)}, ${m.bills} bills`}>
              <span className="bar-val">{rupees(m.tax, 0)}</span>
              <div className="bar-stack" style={{ height: `${Math.max(4, (Math.max(0, m.tax) / top) * 120)}px` }}><i style={{ height: `${m.tax > 0 ? Math.min(100, (m.atRisk / m.tax) * 100) : 0}%` }} /></div>
              <span className="bar-label">{monthName(m.month)}</span>
            </div>
          ))}
        </div>
        <p className="small"><i className="dot red" /> at risk <i className="dot brand" /> safe</p>
        <table className="grid compact"><thead><tr><th>Month</th><th className="num">Bills</th><th className="num">GST</th><th className="num">At risk</th></tr></thead>
          <tbody>{months.map((m) => <tr key={m.month}><td>{monthName(m.month)}</td><td className="num">{m.bills}</td><td className="num">{rupees(m.tax, 0)}</td><td className="num">{m.atRisk ? rupees(m.atRisk, 0) : "—"}</td></tr>)}</tbody></table>
      </article>

      <article className="panel">
        <h3>What if suppliers file?</h3>
        <p className="big">{rupees(back, 0)}</p>
        <p className="muted small">of the {rupees(analysis.totals.atRisk, 0)} at risk comes back as soon as suppliers report the invoices missing from GSTR-2B. The rest ({rupees(analysis.totals.atRisk - back, 0)}) needs corrected invoices, payments, or can&apos;t be claimed at all.</p>
        <h3>Tax to pay in cash</h3>
        <div className="calc"><Num label="GST on your sales this month" value={output} onChange={setOutput} />
          <p>− safe ITC {rupees(safe, 0)} = <b>{output ? rupees(cash, 0) : "—"}</b> to pay in cash{output && n(output) < safe ? ` (${rupees(safe - n(output), 0)} of ITC carries forward)` : ""}</p></div>
        <h3>Interest if risky ITC is claimed</h3>
        <div className="calc"><Num label="Days until it's reversed" value={days} onChange={setDays} />
          <p>18% a year on {rupees(analysis.totals.atRisk, 0)} for {n(days)} days = <b>{rupees(interest(analysis.totals.atRisk, n(days)))}</b> <span className="muted small">(Section 50(3), when the credit is claimed and used)</span></p></div>
      </article>

      <article className="panel">
        <h3>Common credit (Rule 42)</h3>
        <p className="muted small">If you sell both taxable and exempt goods, part of the ITC on shared expenses (rent, electricity, audit fees) has to be reversed.</p>
        <div className="calc three"><Num label="ITC on shared expenses" value={common} onChange={setCommon} /><Num label="Exempt sales" value={exempt} onChange={setExempt} /><Num label="Total sales" value={turnover} onChange={setTurnover} /></div>
        <p>To reverse in GSTR-3B 4(B)(1): <b>{n(turnover) ? rupees(rule42(n(common), n(exempt), n(turnover))) : "—"}</b></p>
        <h3>First-digit test (Benford&apos;s law)</h3>
        {ben.n >= BENFORD_MIN ? (
          <>
            <div className="benford" role="img" aria-label="Share of invoice totals starting with each digit, against Benford's law">
              {BENFORD.map((e, i) => <div key={i} className="ben-col"><div className="ben-bars"><i style={{ height: `${ben.observed[i] * 260}px` }} /><b style={{ height: `${e * 260}px` }} /></div><span>{i + 1}</span></div>)}
            </div>
            <p className={ben.unusual ? "amber-text small" : "muted small"}>{ben.n} invoice totals. {ben.unusual ? "The first digits don't follow the usual pattern: amounts may have been made up or kept under a limit. Look at the suppliers with the lowest scores." : "The first digits follow the usual pattern."} <i className="dot brand" /> yours <i className="dot grey" /> expected</p>
          </>
        ) : <p className="muted small">In real accounts about 30% of amounts start with 1 and under 5% with 9; made-up amounts don&apos;t. The test needs at least {BENFORD_MIN} invoices to mean anything; there are {ben.n} here. Add the purchase register for the year to run it.</p>}
      </article>
    </div>
  );
}
