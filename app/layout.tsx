import type { Metadata, Viewport } from "next";
import "./globals.css";

// On GitHub Pages there are no server headers, so the security policy goes in a <meta> tag
const STATIC = process.env.NEXT_PUBLIC_STATIC_EXPORT === "true";
const META_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'";

export const metadata: Metadata = {
  title: "Invoice Checker · catch bad GST invoices before you claim ITC",
  description: "Checks GST purchase invoices for errors and tampering, and reconciles them with GSTR-2B to show the input tax credit at risk.",
};
export const viewport: Viewport = { themeColor: "#14284b" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      {STATIC && <head><meta httpEquiv="Content-Security-Policy" content={META_CSP} /><meta name="referrer" content="no-referrer" /></head>}
      <body>{children}</body>
    </html>
  );
}
