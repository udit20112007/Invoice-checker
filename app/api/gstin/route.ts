// Optional supplier GSTIN status lookup through a licensed GST data service (GSP / ASP).
// Off unless GSTIN_API_URL is set in the hosting settings, e.g.
//   GSTIN_API_URL=https://api.example-gsp.in/gstin/{gstin}   GSTIN_API_KEY=…   GSTIN_API_KEY_HEADER=x-api-key
// Only the supplier's GSTIN (a public business identifier) is sent. Nothing is stored.
import { checkGstin, cleanGstin } from "../../../lib/gst";
import { parseLookup } from "../../../lib/gstinstatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const cache = new Map<string, { at: number; body: object }>();
const seen = new Map<string, { n: number; until: number }>();

export async function GET(req: Request) {
  const url = process.env.GSTIN_API_URL;
  const g = cleanGstin(new URL(req.url).searchParams.get("g"));
  if (!g) return json({ enabled: !!url });
  if (!url) return json({ error: "GSTIN lookups aren't switched on for this site." }, 503);
  if (!checkGstin(g).ok) return json({ error: "Not a valid GSTIN." }, 400);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local", now = Date.now();
  const v = seen.get(ip); const cur = v && now < v.until ? v : { n: 0, until: now + 10 * 60 * 1000 };
  if (cur.n >= 200) return json({ error: "Too many lookups. Wait a few minutes." }, 429);
  cur.n++; seen.set(ip, cur);
  const hit = cache.get(g);
  if (hit && now - hit.at < 6 * 3600 * 1000) return json(hit.body);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (process.env.GSTIN_API_KEY) headers[process.env.GSTIN_API_KEY_HEADER || "x-api-key"] = process.env.GSTIN_API_KEY;
    const r = await fetch(url.replace("{gstin}", encodeURIComponent(g)), { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return json({ error: "The GST data service didn't answer." }, 502);
    const status = parseLookup(g, await r.json(), "api");
    if (!status) return json({ error: "The GST data service's reply wasn't understood." }, 502);
    const body = { status };
    cache.set(g, { at: now, body });
    return json(body);
  } catch {
    return json({ error: "The GST data service didn't answer." }, 502);
  }
}
