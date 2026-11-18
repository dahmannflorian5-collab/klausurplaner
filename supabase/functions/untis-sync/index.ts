// Supabase Edge Function: untis-sync
// Holt den Stundenplan aus WebUntis (Login mit Untis-Mobile-Schlüssel) und
// schreibt ihn in die Tabelle "planner". Wird aufgerufen
//  - jeden Morgen um 7:45 Uhr (Zeitplan in der Datenbank, Header x-cron-secret)
//  - von der Webseite beim Öffnen / wenn das Gerät wieder online ist (Login-Token)
//
// Geheimnisse (Dashboard > Edge Functions > Secrets):
//   UNTIS_SERVER  z. B. ibb-ggmbh.webuntis.com
//   UNTIS_SCHOOL  z. B. ibb-ggmbh
//   UNTIS_USER    dein Untis-Benutzername
//   UNTIS_SECRET  der Schlüssel aus "Zugriff über Untis Mobile"
//   CRON_SECRET   frei gewähltes langes Passwort für den 7:45-Zeitplan
//
// Zusätzlich werden über die REST-Schnittstelle von WebUntis die Stunden der
// aktuellen und nächsten Woche mit Notizen, Lehrstoff und Hausaufgaben geholt (Spalte planner.dated).

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.79 Safari/537.36";

// ---------- Einmalpasswort (TOTP, RFC 6238) ----------
function base32Decode(s: string): Uint8Array {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = "";
  for (const c of clean) {
    const v = A.indexOf(c);
    if (v < 0) throw new Error("Der Untis-Schlüssel enthält ungültige Zeichen.");
    bits += v.toString(2).padStart(5, "0");
  }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

export async function totp(secret: string, timeMs = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  let counter = Math.floor(timeMs / 30000);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { msg[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1000000).padStart(6, "0");
}

// ---------- WebUntis ----------
function cookieValue(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null;
  const m = setCookie.match(new RegExp("(?:^|[,;\\s])" + name + "=([^;,\\s]+)"));
  return m ? m[1] : null;
}

async function untisLogin(server: string, school: string, user: string, secret: string) {
  const base = "https://" + server;
  const hdr = { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Cache-Control": "no-cache", "Content-Type": "application/json" };
  const otp = await totp(secret);
  const r = await fetch(`${base}/WebUntis/jsonrpc_intern.do?m=getUserData2017&school=${encodeURIComponent(school)}&v=i2.2`, {
    method: "POST", redirect: "manual", headers: hdr,
    body: JSON.stringify({ id: "Klausurplaner", method: "getUserData2017", params: [{ auth: { clientTime: Date.now(), user, otp: Number(otp) } }], jsonrpc: "2.0" }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok && r.status >= 300) throw new Error("WebUntis antwortet mit Status " + r.status + ".");
  if (j && j.error) throw new Error("WebUntis-Login abgelehnt: " + (j.error.message || JSON.stringify(j.error)));
  const sid = cookieValue(r.headers.get("set-cookie"), "JSESSIONID");
  if (!sid) throw new Error("WebUntis hat keine Sitzung zurückgegeben. Stimmen Schule, Benutzer und Schlüssel?");
  const cookie = `JSESSIONID=${sid}; schoolname=${"_" + btoa(school)}`;

  const c = await fetch(`${base}/WebUntis/api/app/config`, { headers: { ...hdr, Cookie: cookie }, redirect: "manual" });
  const cj = await c.json().catch(() => null);
  const u = cj?.data?.loginServiceConfig?.user;
  const person = u?.persons?.find((p: any) => p.id === u.personId);
  if (!u || !person) throw new Error("Konnte die eigene Person in WebUntis nicht bestimmen.");
  return { base, hdr, cookie, personId: u.personId as number, personType: person.type as number, school };
}

const yyyymmdd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function untisTimetable(s: any, from: Date, to: Date) {
  const r = await fetch(`${s.base}/WebUntis/jsonrpc.do?school=${encodeURIComponent(s.school)}`, {
    method: "POST", redirect: "manual", headers: { ...s.hdr, Cookie: s.cookie },
    body: JSON.stringify({
      id: "Klausurplaner", jsonrpc: "2.0", method: "getTimetable",
      params: { options: {
        id: Date.now(), element: { id: s.personId, type: s.personType },
        startDate: yyyymmdd(from), endDate: yyyymmdd(to),
        showLsText: true, showStudentgroup: true, showLsNumber: true, showSubstText: true, showInfo: true, showBooking: true,
        klasseFields: ["id", "name", "longname", "externalkey"], roomFields: ["id", "name", "longname", "externalkey"],
        subjectFields: ["id", "name", "longname", "externalkey"], teacherFields: ["id", "name", "longname", "externalkey"],
      } },
    }),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.error || !Array.isArray(j.result)) throw new Error("Stundenplan konnte nicht gelesen werden: " + (j?.error?.message || "keine Daten"));
  return j.result as any[];
}

// ---------- REST-Schnittstelle (für Notizen) ----------
async function restSession(s: any) {
  const t = await fetch(`${s.base}/WebUntis/api/token/new`, { headers: { ...s.hdr, Cookie: s.cookie }, redirect: "manual" });
  const token = (await t.text()).trim();
  if (!t.ok || !token || token.length > 4000) throw new Error("Kein REST-Token (" + t.status + ")");
  const auth = { ...s.hdr, Cookie: s.cookie, Authorization: "Bearer " + token };
  let tenant = "";
  try {
    const a = await fetch(`${s.base}/WebUntis/api/rest/view/v1/app/data`, { headers: auth });
    const aj = await a.json();
    tenant = String(aj?.tenant?.id ?? "");
  } catch { /* ohne Tenant weiter */ }
  return { ...auth, ...(tenant ? { "Tenant-Id": tenant } : {}) };
}

// Einzelne Stunden mit Datum, Notizen, Vertretungstexten und Ausfällen (REST: timetable/entries)
export function toDated(days: any[]) {
  const skip = new Set(["BREAK_SUPERVISION", "OFFICE_HOUR", "STAND_BY_PERIOD"]);
  const txt = (v: any) => (typeof v === "string" ? v.trim() : "");
  const out: any[] = [];
  for (const d of days || []) {
    for (const g of d.gridEntries || []) {
      if (!g?.duration?.start || skip.has(g.type)) continue;
      const pos = [1, 2, 3, 4, 5, 6, 7].flatMap((k) => g["position" + k] || []);
      const cur = (t: string) => pos.filter((p: any) => p?.current?.type === t).map((p: any) => p.current);
      const old = (t: string) => pos.filter((p: any) => p?.removed?.type === t).map((p: any) => p.removed);
      const subj = cur("SUBJECT")[0] || old("SUBJECT")[0];
      const notes = [txt(g.notesAll), ...(g.texts || []).filter((x: any) => x?.type === "NOTES_FOR_ALL").map((x: any) => txt(x.text))].filter(Boolean);
      const roomsOld = old("ROOM").map((r: any) => r.displayName || r.shortName);
      out.push({
        datum: String(g.duration.start).slice(0, 10),
        von: String(g.duration.start).slice(11, 16),
        bis: String(g.duration.end).slice(11, 16),
        fach: subj?.longName || subj?.displayName || txt(g.name) || txt(g.lessonText) || "",
        raum: cur("ROOM").map((r: any) => r.displayName || r.shortName).join(", "),
        raumAlt: roomsOld.join(", "),
        lehrer: cur("TEACHER").map((t: any) => t.longName || t.displayName).join(", "),
        status: g.status || "",
        statusDetail: txt(g.statusDetail),
        typ: g.type || "",
        notiz: [...new Set(notes)].join("\n"),
        info: txt(g.lessonInfo),
        text: txt(g.lessonText),
        vertretung: txt(g.substitutionText),
      });
    }
  }
  return out.sort((a, b) => (a.datum + a.von).localeCompare(b.datum + b.von));
}

async function fetchDated(s: any, from: Date, to: Date) {
  const h = await restSession(s);
  const q = new URLSearchParams({ start: isoDay(from), end: isoDay(to), format: "1", resourceType: "STUDENT", resources: String(s.personId), timetableType: "MY_TIMETABLE" });
  const d = await fetch(`${s.base}/WebUntis/api/rest/view/v1/timetable/entries?${q}`, { headers: h });
  if (!d.ok) throw new Error("Stundendetails: Status " + d.status);
  const j = await d.json();
  return toDated(j?.days || []);
}

// ---------- Umwandlung in den Wochenplan der Webseite ----------
const hhmm = (t: number | string) => { const s = String(t).padStart(4, "0"); return s.slice(0, 2) + ":" + s.slice(2); };
const toMin = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3);
const nm = (a: any) => (Array.isArray(a) && a[0] ? (a[0].longname || a[0].name || "") : "");
const sh = (a: any) => (Array.isArray(a) && a[0] ? (a[0].name || a[0].longname || "") : "");

export function toPlan(lessons: any[]) {
  const rows: any[] = [];
  const seen = new Set<string>();
  for (const l of lessons) {
    if (l.code === "cancelled") continue;
    const d = String(l.date);
    const wd = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)).getDay(); // 0 = So
    if (wd === 0) continue;
    const fach = nm(l.su) || sh(l.su) || (l.lstext || "").trim();
    if (!fach) continue;
    const von = hhmm(l.startTime), bis = hhmm(l.endTime);
    const kurs = (l.sg || sh(l.kl) || "").toString().trim();
    const lehrer = sh(l.te), raum = sh(l.ro);
    const key = [wd, von, bis, fach, lehrer, raum].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ tag: wd, von, bis, fach, kurs, lehrer, raum });
  }
  rows.sort((a, b) => a.tag - b.tag || a.von.localeCompare(b.von));
  const out: any[] = [];
  for (const r of rows) {
    const p = out[out.length - 1];
    if (p && p.tag === r.tag && p.fach === r.fach && p.lehrer === r.lehrer && p.raum === r.raum && p.kurs === r.kurs && toMin(r.von) - toMin(p.bis) <= 15 && toMin(r.von) >= toMin(p.von)) {
      if (toMin(r.bis) > toMin(p.bis)) p.bis = r.bis;
    } else out.push({ ...r });
  }
  return out.map((r) => ({ ...r, id: `u-${r.tag}-${r.von.replace(":", "")}-${r.fach.replace(/\W+/g, "").slice(0, 12)}`, untis: true }));
}

function weekRange(offsetWeeks: number): [Date, Date] {
  const n = new Date(); n.setHours(12, 0, 0, 0);
  const mon = new Date(n); mon.setDate(n.getDate() - ((n.getDay() + 6) % 7) + offsetWeeks * 7);
  const sat = new Date(mon); sat.setDate(mon.getDate() + 5);
  return [mon, sat];
}

async function untisSessionFromEnv(env: Record<string, string | undefined>) {
  const server = env.UNTIS_SERVER, school = env.UNTIS_SCHOOL, user = env.UNTIS_USER, secret = env.UNTIS_SECRET;
  if (!server || !school || !user || !secret) throw new Error("Untis-Geheimnisse fehlen (UNTIS_SERVER, UNTIS_SCHOOL, UNTIS_USER, UNTIS_SECRET).");
  return await untisLogin(server.replace(/^https?:\/\//, "").replace(/\/.*$/, ""), school, user, secret);
}

export async function fetchPlan(env: Record<string, string | undefined>) {
  const s = await untisSessionFromEnv(env);
  const weeks = [] as { plan: any[]; raw: any[]; from: Date }[];
  for (const off of [0, 1]) {
    const [a, b] = weekRange(off);
    const raw = await untisTimetable(s, a, b);
    weeks.push({ plan: toPlan(raw), raw, from: a });
  }
  const best = weeks[1].plan.length > weeks[0].plan.length ? weeks[1] : weeks[0];
  let dated: any[] | null = null;
  try { dated = await fetchDated(s, weekRange(0)[0], weekRange(1)[1]); } catch { dated = null; }
  return { plan: best.plan, raw: best.raw, week: yyyymmdd(best.from), dated };
}

// ---------- HTTP ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const berlinHour = () => +new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hour12: false }).format(new Date());

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const env = Deno.env.toObject();
  const URL_ = env.SUPABASE_URL, SRV = env.SUPABASE_SERVICE_ROLE_KEY, ANON = env.SUPABASE_ANON_KEY;
  const rest = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", ...(init.headers || {}) } });

  let body: any = {};
  try { body = await req.json(); } catch { /* leerer Body ist ok */ }

  let userId: string | null = null;
  let cron = false;
  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) {
    if (!env.CRON_SECRET || cronHeader !== env.CRON_SECRET) return json({ ok: false, error: "Nicht erlaubt." }, 401);
    cron = true;
    if (!body.force && berlinHour() !== 7) return json({ ok: true, skipped: "nicht 7 Uhr in Berlin" });
    const r = await rest("planner?select=user_id&limit=1");
    const rows = await r.json();
    userId = rows?.[0]?.user_id ?? null;
    if (!userId) return json({ ok: true, skipped: "noch kein Benutzer angelegt" });
  } else {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ ok: false, error: "Bitte anmelden." }, 401);
    const u = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (!u.ok) return json({ ok: false, error: "Anmeldung ungültig." }, 401);
    userId = (await u.json()).id;
  }

  const cur = await (await rest(`planner?select=plan,untis_synced_at&user_id=eq.${userId}`)).json();
  const row = cur?.[0];
  if (!body.force && !cron && row?.untis_synced_at && Date.now() - new Date(row.untis_synced_at).getTime() < 10 * 60 * 1000) {
    return json({ ok: true, skipped: "kürzlich abgeglichen", syncedAt: row.untis_synced_at });
  }

  try {
    const { plan: fresh, raw, week, dated } = await fetchPlan(env);
    if (body.debug) return json({ ok: true, week, lessons: raw.slice(0, 5), plan: fresh, dated: (dated || []).slice(0, 8) });
    if (!fresh.length) return json({ ok: true, skipped: "WebUntis hat keine Stunden geliefert (Ferien?). Plan bleibt unverändert." });
    const old: any[] = Array.isArray(row?.plan) ? row.plan : [];
    const hadUntis = old.some((p) => p && p.untis);
    const manual = hadUntis ? old.filter((p) => p && !p.untis) : [];
    const merged = [...manual, ...fresh];
    const syncedAt = new Date().toISOString();
    const w = await rest("planner?on_conflict=user_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: userId, plan: merged, untis_synced_at: syncedAt, ...(dated ? { dated } : {}) }),
    });
    if (!w.ok) throw new Error("Speichern fehlgeschlagen: " + (await w.text()));
    return json({ ok: true, count: fresh.length, week, syncedAt, plan: merged, dated: dated ?? undefined });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 502);
  }
}

// deno-lint-ignore no-explicit-any
if (typeof (globalThis as any).Deno !== "undefined" && (globalThis as any).Deno.serve) {
  (globalThis as any).Deno.serve(handler);
}
