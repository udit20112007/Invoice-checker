"use client";

import { useEffect, useMemo, useState } from "react";
import { FEATURES, type Feature } from "../lib/features";

/** A panel that lists everything the site does and takes the person to each feature. */
export default function Explore({ hasData, canTour, busy, onShow, onDemo, onTour, onClose }: {
  hasData: boolean; canTour: boolean; busy: boolean; onShow: (f: Feature) => void; onDemo: (f: Feature | null) => void; onTour: () => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = FEATURES.filter((f) => words.every((w) => `${f.name} ${f.what} ${f.group}`.toLowerCase().includes(w)));
    const m = new Map<string, Feature[]>();
    for (const f of hit) m.set(f.group, [...(m.get(f.group) ?? []), f]);
    return [...m];
  }, [q]);
  const count = groups.reduce((a, [, l]) => a + l.length, 0);
  return (
    <div className="overlay explore-overlay" role="dialog" aria-modal="true" aria-label="Explore the features" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="explore">
        <header className="explore-head">
          <div><h2>Explore</h2><p className="muted small">{FEATURES.length} things this site does. Pick one to be taken to it.</p></div>
          <button className="btn ghost" type="button" onClick={onClose}>Close</button>
        </header>
        <div className="explore-top">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: QR, payment, vehicle, Tally…" aria-label="Search the features" autoFocus />
          {!hasData && <button className="btn primary" type="button" disabled={busy} onClick={() => onDemo(null)}>Load the demo data</button>}
          {canTour && <button className="btn" type="button" disabled={busy} onClick={onTour}>{hasData ? "Take the guided tour" : "Guided tour with demo data"}</button>}
        </div>
        {!hasData && <p className="explore-note">Nothing is loaded yet. Features marked <span className="tag need">needs data</span> can be shown on the demo pile, or add your own files first.</p>}
        <div className="explore-list">
          {count === 0 && <p className="empty">Nothing matches “{q}”.</p>}
          {groups.map(([group, list]) => (
            <section key={group}>
              <h3>{group} <span className="muted small">({list.length})</span></h3>
              <ul>
                {list.map((f) => {
                  const locked = !!f.needs && !hasData;
                  return (
                    <li key={f.id}>
                      <div><b>{f.name}</b>{locked && <span className="tag need">needs data</span>}<p>{f.what}</p>{locked && <p className="muted small">With your own data: add {f.needs}.</p>}</div>
                      {locked ? <button className="btn" type="button" disabled={busy} onClick={() => onDemo(f)}>Show on demo data</button> : <button className="btn primary" type="button" onClick={() => onShow(f)}>Show me</button>}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
