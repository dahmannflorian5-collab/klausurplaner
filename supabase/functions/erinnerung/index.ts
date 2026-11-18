// Supabase Edge Function: erinnerung
// Wird jeden Abend vom Zeitplan in der Datenbank aufgerufen (Header x-cron-secret).
// Wenn der Klausurplaner seit 5 Tagen nicht geöffnet wurde, kommt eine E-Mail,
// damit das kostenlose Supabase-Projekt nicht nach 7 Tagen pausiert wird.
//
// Geheimnisse: CRON_SECRET (wie bei untis-sync), RESEND_API_KEY (von resend.com)

const DAYS = 5;
const APP = "https://dahmannflorian5-collab.github.io/klausurplaner/";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async (req: Request) => {
  const env = Deno.env.toObject();
  if (!env.CRON_SECRET || req.headers.get("x-cron-secret") !== env.CRON_SECRET) return json({ ok: false, error: "Nicht erlaubt." }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* leer ist ok */ }

  const URL_ = env.SUPABASE_URL, SRV = env.SUPABASE_SERVICE_ROLE_KEY;
  const h = { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" };
  const rows = await (await fetch(`${URL_}/rest/v1/user_settings?select=user_id,last_seen,reminder_sent_at`, { headers: h })).json();
  const out: unknown[] = [];

  for (const r of rows || []) {
    if (!r.last_seen) { out.push({ skipped: "noch nie geöffnet" }); continue; }
    const days = Math.floor((Date.now() - new Date(r.last_seen).getTime()) / 864e5);
    const already = r.reminder_sent_at && new Date(r.reminder_sent_at) > new Date(r.last_seen);
    if (!body.test && (days < DAYS || already)) { out.push({ skipped: `zuletzt vor ${days} Tagen geöffnet` }); continue; }
    if (!env.RESEND_API_KEY) { out.push({ skipped: "RESEND_API_KEY fehlt" }); continue; }

    const u = await (await fetch(`${URL_}/auth/v1/admin/users/${r.user_id}`, { headers: h })).json();
    if (!u?.email) { out.push({ skipped: "keine E-Mail-Adresse" }); continue; }

    const today = new Date().toISOString().slice(0, 10), in7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const next = await (await fetch(`${URL_}/rest/v1/entries?select=titel,datum,typ,done&user_id=eq.${r.user_id}&datum=gte.${today}&datum=lte.${in7}&order=datum`, { headers: h })).json();
    const list = (next || []).filter((e: any) => !(e.typ === "aufgabe" && e.done)).slice(0, 8)
      .map((e: any) => `<li>${new Date(e.datum + "T00:00").toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" })}: ${esc(e.titel)}</li>`).join("");
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
      <p>Hallo Florian,</p>
      <p>du hast deinen Klausurplaner seit <b>${days} Tagen</b> nicht geöffnet. Nach 7 Tagen ohne Nutzung pausiert Supabase das kostenlose Projekt, dann funktionieren Abgleich und WebUntis nicht mehr, bis du es im Dashboard wieder startest.</p>
      <p><a href="${APP}" style="display:inline-block;background:#1f2328;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Klausurplaner öffnen</a></p>
      ${list ? `<p>In den nächsten 7 Tagen steht an:</p><ul>${list}</ul>` : ""}
      <p style="color:#80868f;font-size:13px">Diese Erinnerung kommt höchstens einmal, bis du die App wieder öffnest.</p></div>`;

    const s = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Klausurplaner <onboarding@resend.dev>", to: [u.email], subject: body.test ? "Test: Erinnerung vom Klausurplaner" : `Klausurplaner: seit ${days} Tagen nicht geöffnet`, html }),
    });
    if (!s.ok) { out.push({ error: "Resend: " + (await s.text()) }); continue; }
    if (!body.test) await fetch(`${URL_}/rest/v1/user_settings?user_id=eq.${r.user_id}`, { method: "PATCH", headers: h, body: JSON.stringify({ reminder_sent_at: new Date().toISOString() }) });
    out.push({ sent: true, days });
  }
  return json({ ok: true, results: out });
});
