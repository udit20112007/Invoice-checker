import type { NextConfig } from "next";

// Two ways to host:
//  - Vercel (default): a Node server, so security headers are sent and the optional AI reader works.
//  - GitHub Pages (STATIC_EXPORT=true): plain files in out/, served under /<repo>; the security policy is
//    set by a <meta> tag instead (see app/layout.tsx) and the AI reader is off.
const staticExport = process.env.NEXT_PUBLIC_STATIC_EXPORT === "true";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;
const dev = process.env.NODE_ENV !== "production";

// Invoices are read in the browser. The page may only talk to this site ("connect-src 'self'"): the optional
// AI reading goes through this site's own /api/extract route, never straight from the browser to anyone else.
export const csp = (forMeta: boolean) => [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  `connect-src 'self' blob: data:${dev ? " ws: http://localhost:*" : ""}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  ...(forMeta ? [] : ["frame-ancestors 'none'"]),   // not allowed in a <meta> policy
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  ...(staticExport ? { output: "export", trailingSlash: true, basePath, images: { unoptimized: true } } : {
    async headers() {
      return [
        {
          source: "/:path*",
          headers: [
            { key: "Content-Security-Policy", value: csp(false) + (dev ? "" : "; upgrade-insecure-requests") },
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "X-Frame-Options", value: "DENY" },
            { key: "Referrer-Policy", value: "no-referrer" },
            { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          ],
        },
        { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      ];
    },
  }),
};
export default nextConfig;
