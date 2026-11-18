// Supabase Edge Function: push
// Schickt Push-Mitteilungen an die Handy-Version des Klausurplaners.
//  - Zeitplan (Header x-cron-secret), halbstündlich -> handelt nur um 7:00 (Morgen) und 19:30 (Abend) Berliner Zeit
//  - Webseite (Login-Token) mit {action:"test"} -> Testmitteilung an die eigenen Geräte
// Die VAPID-Schlüssel liegen in der Tabelle app_secrets (nur service_role darf sie lesen).
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const berlin = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, min: +p.minute };
};
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const WT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const dm = (iso: string) => { const d = new Date(iso + "T12:00:00Z"); return `${WT[d.getUTCDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`; };
const label = (e: any) => [e.art || (e.typ === "klausur" ? "Klausur" : e.typ === "termin" ? "Termin" : "Aufgabe"), e.fach, e.titel && e.titel !== e.art ? "– " + e.titel : ""].filter(Boolean).join(" ").trim();
const short = (f: string) => String(f || "").replace(/^(Grund|Leistungs)kurs\s+/i, "").replace(/\s+\d+$/, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const env = Deno.env.toObject();
  const URL_ = env.SUPABASE_URL, SRV = env.SUPABASE_SERVICE_ROLE_KEY, ANON = env.SUPABASE_ANON_KEY;
  const rest = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  let body: any = {};
  try { body = await req.json(); } catch { /* leer */ }

  const sec = Object.fromEntries(((await (await rest("app_secrets?select=key,value")).json()) || []).map((r: any) => [r.key, r.value]));
  if (!sec.vapid_public || !sec.vapid_private) return json({ ok: false, error: "VAPID-Schlüssel fehlen." }, 500);
  webpush.setVapidDetails(sec.vapid_subject || "mailto:kontakt@example.com", sec.vapid_public, sec.vapid_private);

  const sendTo = async (userId: string, msg: any) => {
    const subs = await (await rest(`push_subs?select=id,endpoint,p256dh,auth&user_id=eq.${userId}`)).json();
    let sent = 0;
    for (const s of subs || []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 6 * 3600, urgency: "normal" });
        sent++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await rest(`push_subs?id=eq.${s.id}`, { method: "DELETE" });
      }
    }
    return { sent, devices: (subs || []).length };
  };

  // ----- Test von der Webseite -----
  const cronHeader = req.headers.get("x-cron-secret");
  if (!cronHeader) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const u = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (!u.ok) return json({ ok: false, error: "Bitte anmelden." }, 401);
    const uid = (await u.json()).id;
    if (body.action === "key") return json({ ok: true, key: sec.vapid_public });
    const r = await sendTo(uid, { title: "Klausurplaner", body: "Push funktioniert 🎉 Du bekommst ab jetzt morgens und abends deine Erinnerungen.", tag: "test", url: "./handy.html" });
    return json({ ok: true, ...r });
  }
  if (!env.CRON_SECRET || cronHeader !== env.CRON_SECRET) return json({ ok: false, error: "Nicht erlaubt." }, 401);

  // ----- Zeitplan -----
  const now = berlin();
  const mode = body.mode || (now.hour === 7 && now.min < 15 ? "morgen" : now.hour === 19 && now.min >= 30 && now.min < 45 ? "abend" : "");
  if (!mode) return json({ ok: true, skipped: "keine Push-Zeit" });
  const today = now.day, tomorrow = addDays(today, 1);
  const users = [...new Set(((await (await rest("push_subs?select=user_id")).json()) || []).map((r: any) => r.user_id))] as string[];
  const out: any[] = [];
  for (const uid of users) {
    const ents = (await (await rest(`entries?select=typ,art,titel,fach,datum,von,done,vorlaeufig&user_id=eq.${uid}&done=is.false&datum=gte.${today}&datum=lte.${addDays(today, 7)}&order=datum,von`)).json()) || [];
    const pl = (await (await rest(`planner?select=dated&user_id=eq.${uid}`)).json())?.[0];
    const dated: any[] = Array.isArray(pl?.dated) ? pl.dated : [];
    let msg: any = null;
    if (mode === "morgen") {
      const heute = ents.filter((e: any) => e.datum === today && !e.vorlaeufig);
      const les = dated.filter((d) => d.datum === today);
      const ausfall = les.filter((d) => d.status === "CANCELLED").map((d) => `${d.von} ${short(d.fach)} fällt aus`);
      const notes = les.filter((d) => d.notiz && d.status !== "CANCELLED").map((d) => `${short(d.fach)}: ${d.notiz}`);
      const lines = [...heute.map((e: any) => (e.von ? e.von.slice(0, 5) + " " : "") + label(e)), ...ausfall, ...notes];
      if (lines.length) msg = { title: `Heute, ${dm(today)}` + (les.length ? ` · ${les.filter((d) => d.status !== "CANCELLED").length} Stunden` : ""), body: lines.slice(0, 6).join("\n"), tag: "morgen-" + today, url: "./handy.html" };
    } else {
      const morgen = ents.filter((e: any) => e.datum === tomorrow && !e.vorlaeufig);
      const bald = ents.filter((e: any) => e.typ === "klausur" && !e.vorlaeufig && (e.datum === addDays(today, 3) || e.datum === addDays(today, 7)));
      const ausfall = dated.filter((d) => d.datum === tomorrow && d.status === "CANCELLED").map((d) => `${d.von} ${short(d.fach)} fällt aus`);
      const lines = [
        ...morgen.map((e: any) => "Morgen: " + label(e)),
        ...ausfall.map((x) => "Morgen: " + x),
        ...bald.map((e: any) => `In ${e.datum === addDays(today, 3) ? "3 Tagen" : "1 Woche"}: ${label(e)}`),
      ];
      if (lines.length) msg = { title: morgen.some((e: any) => e.typ === "klausur") ? "Morgen ist Prüfung – du schaffst das!" : `Für morgen, ${dm(tomorrow)}`, body: lines.slice(0, 6).join("\n"), tag: "abend-" + today, url: "./handy.html" };
    }
    out.push(msg ? { uid, mode, ...(await sendTo(uid, msg)) } : { uid, mode, skipped: "nichts anstehend" });
  }
  return json({ ok: true, out });
});
