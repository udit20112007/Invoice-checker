import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Invoice Checker · catch bad GST invoices before you claim ITC",
  description: "Checks GST purchase invoices for errors and tampering, and reconciles them with GSTR-2B to show the input tax credit at risk.",
};
export const viewport: Viewport = { themeColor: "#14284b" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
