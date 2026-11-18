// Supabase Edge Function: news
// Holt die aktuellen Schlagzeilen der Tagesschau (öffentliche Tagesschau-API)
// und gibt eine kurze Liste für das Laufband im Klausurplaner zurück.
// Zwischenspeicher: 5 Minuten, damit die Tagesschau nicht bei jedem Öffnen gefragt wird.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

let cache: { at: number; items: unknown[] } | null = null;

async function load() {
  if (cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.items;
  const r = await fetch("https://www.tagesschau.de/api2u/homepage/", { headers: { "User-Agent": "Klausurplaner/1.0", Accept: "application/json" } });
  if (!r.ok) throw new Error("Tagesschau antwortet mit Status " + r.status);
  const j = await r.json();
  const seen = new Set<string>();
  const items = [...(j.news || [])]
    .filter((n: any) => n && n.title && (n.shareURL || n.detailsweb))
    .map((n: any) => ({
      titel: String(n.title).trim(),
      dach: String(n.topline || "").trim(),
      url: String(n.shareURL || n.detailsweb),
      zeit: n.date || null,
      eil: !!n.breakingNews,
    }))
    .filter((n) => (seen.has(n.url) ? false : (seen.add(n.url), true)))
    .slice(0, 20);
  cache = { at: Date.now(), items };
  return items;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const items = await load();
    return new Response(JSON.stringify({ ok: true, items }), { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message || e) }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
