// The site's base path: "" on Vercel or a custom domain, "/<repo>" on GitHub Pages (set at build time).
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
// Off on static hosting (GitHub Pages), where there's no server for the AI reader
export const HAS_SERVER = process.env.NEXT_PUBLIC_STATIC_EXPORT !== "true";
