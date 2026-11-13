import App from "../components/App";

export default function Home() {
  return (
    <>
      <header className="top">
        <div className="wrap top-row">
          <div className="brand"><span className="mark" aria-hidden="true">✓</span>Invoice Checker</div>
          <span className="muted small">GST invoice checks + GSTR-2B reconciliation</span>
        </div>
      </header>
      <main className="wrap">
        <section className="hero">
          <h1>Catch bad GST invoices before you claim ITC.</h1>
          <p>Drop in your purchase invoices and GSTR-2B. Invoice Checker reads each invoice, checks it against the GST rules, compares it with what your suppliers reported, and shows how much input tax credit is at risk.</p>
          <ol className="steps">
            <li><b>Read</b> PDFs and photos, including the e-invoice QR code</li>
            <li><b>Check</b> GSTIN, tax type, maths, rates, HSN, duplicates and tampering</li>
            <li><b>Reconcile</b> with GSTR-2B and message the suppliers to chase</li>
          </ol>
        </section>
        <App />
      </main>
      <footer className="wrap foot">
        Invoice Checker helps you find problems; check the results before filing GSTR-3B. Rules used: CGST Act sections 16 and 31, CGST Rules 46 and 48, IGST Act sections 7–8, GST rate notifications of 17 Sep 2025 (GST 2.0).
      </footer>
    </>
  );
}
