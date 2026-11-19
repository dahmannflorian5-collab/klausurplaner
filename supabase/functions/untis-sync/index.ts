// Supabase Edge Function: untis-sync
// Holt den Stundenplan aus WebUntis (Login mit Untis-Mobile-Schlüssel) und
// schreibt ihn in die Tabelle "planner". Wird aufgerufen
//  - jeden Morgen um 6:45 Uhr (Zeitplan in der Datenbank, Header x-cron-secret)
//  - von der Webseite beim Öffnen / wenn das Gerät wieder online ist (Login-Token)
//
// Geheimnisse (Dashboard > Edge Functions > Secrets):
//   UNTIS_SERVER  z. B. ibb-ggmbh.webuntis.com
//   UNTIS_SCHOOL  z. B. ibb-ggmbh
//   UNTIS_USER    dein Untis-Benutzername
//   UNTIS_SECRET  der Schlüssel aus "Zugriff über Untis Mobile"
//   CRON_SECRET   frei gewähltes langes Passwort für den 6:45-Zeitplan
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

// ---------- Hausaufgaben ----------
const RULES: [RegExp, string][] = [[/ethik/i, "Ethik"], [/chemie/i, "Chemie"], [/sport/i, "Sport"], [/englisch/i, "Englisch"], [/kunst/i, "Kunst"], [/volks|betriebs|vbw/i, "VBWL"], [/mathe/i, "Mathe"], [/geschicht/i, "Geschichte"], [/informatik/i, "Informatik"], [/deutsch/i, "Deutsch"], [/spanisch/i, "Spanisch"]];
const subjOf = (n: string) => { for (const [r, v] of RULES) if (r.test(n || "")) return v; return n || null; };
const isoFromNum = (n: any) => { const d = String(n); return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; };

export async function fetchHomework(s: any, from: Date, to: Date) {
  const url = `${s.base}/WebUntis/api/homeworks/lessons?startDate=${yyyymmdd(from)}&endDate=${yyyymmdd(to)}`;
  const tries: string[] = [];
  let j: any = null;
  const variants: (() => Promise<Record<string, string>>)[] = [
    async () => ({ ...s.hdr, Cookie: s.cookie }),
    async () => { const h: any = await restSession(s); delete h["Tenant-Id"]; return h; },
    async () => await restSession(s),
  ];
  for (const v of variants) {
    const r = await fetch(url, { headers: await v(), redirect: "manual" });
    tries.push(String(r.status));
    if (r.ok) { j = await r.json().catch(() => null); if (j) break; }
  }
  if (!j) throw new Error("Hausaufgaben: Status " + tries.join("/"));
  const d = j?.data || {};
  const les = new Map((d.lessons || []).map((l: any) => [l.id, l.subject || ""]));
  return (d.homeworks || []).filter((x: any) => x && x.text && x.dueDate).map((x: any) => ({
    id: x.id, text: String(x.text).trim(), remark: String(x.remark || "").trim(),
    due: isoFromNum(x.dueDate), given: x.date ? isoFromNum(x.date) : null, subject: les.get(x.lessonId) || "", completed: !!x.completed,
  }));
}

// ---------- Noten ----------
const STEMS: [string, string][] = [["VBW", "VBWL"], ["Phy", "Physik"], ["Ma", "Mathe"], ["Ch", "Chemie"], ["Inf", "Informatik"], ["Et", "Ethik"], ["En", "Englisch"], ["Ge", "Geschichte"], ["Ku", "Kunst"], ["Sp", "Sport"], ["De", "Deutsch"], ["D", "Deutsch"]];
const subjOf2 = (code: string, longMap: Record<string, string>) => {
  const l = longMap[code]; if (l) { const v = subjOf(l); if (v && v !== l) return v; }
  const c = String(code || "").replace(/^BGY-?/i, "").replace(/\s*\d+$/, "").replace(/^(LK|GK)(?=[A-Z])/, "").replace(/^(L|G)(?=[A-Z])/, "");
  for (const [p, v] of STEMS) if (c.toLowerCase().startsWith(p.toLowerCase())) return v;
  return code || "Sonstiges";
};
const hjOf = (iso: string) => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); const sy = m >= 8 ? y : y - 1; return (13 + sy - 2026) + (m >= 8 || m === 1 ? "/I" : "/II"); };
const artOf = (t: any) => { const n = `${t?.name || ""} ${t?.longname || ""}`; return /klausur/i.test(n) ? "Klausur" : /mdl|mündl/i.test(n) ? "Mündlich" : /schr|lnw|test|kontroll/i.test(n) ? "LK" : /präs|vortrag/i.test(n) ? "Präsentation" : "Sonstiges"; };

const cleanTitle = (name: string, code: string, t: any) => {
  let n = String(name || "");
  if (code) n = n.split(code).join("");
  n = n.replace(/^BGY[-_ ]?\w*?_/i, "").replace(/^[\s_:\-–]+/, "").trim();
  if (n) return n;
  const ln = String(t?.longname || t?.name || "");
  return /klausur/i.test(ln) ? "Klausur" : /mdl|mündl/i.test(ln) ? "Mündliche Note" : /prakt/i.test(ln) ? "Praktische Leistung" : /schr/i.test(ln) ? "Schriftliche Leistungskontrolle" : "Note";
};
export async function fetchGrades(s: any, longMap: Record<string, string>) {
  const now = new Date(), y = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const out: any[] = [];
  for (const sy of [y - 1, y]) {
    const r = await fetch(`${s.base}/WebUntis/api/classreg/grade/gradeList?personId=${s.personId}&startDate=${sy}0801&endDate=${sy + 1}0731`, { headers: { ...s.hdr, Cookie: s.cookie }, redirect: "manual" });
    if (!r.ok) throw new Error("Noten: Status " + r.status);
    const j = await r.json();
    for (const x of j?.data || []) {
      const g = x.grade || {}, pts = g.mark?.markDisplayValue;
      if (pts == null || isNaN(+pts) || !g.date) continue;
      const datum = isoFromNum(g.date);
      out.push({ untis_id: "g-" + g.id, datum, halbjahr: hjOf(datum), code: x.subject, fach: subjOf2(x.subject, longMap), titel: cleanTitle(g.exam?.name, x.subject, g.examType), art: artOf(g.examType), typ: g.examType?.longname || g.examType?.name || "", gewicht: +g.examType?.weightFactor || 1, punkte: +pts, text: g.text || "" });
    }
  }
  return out;
}

// Abgleich: verknüpft vorhandene (eigene/Notan-)Noten mit WebUntis, legt fehlende an, meldet Abweichungen
export async function syncGrades(userId: string, rest: any, ug: any[], dry = false) {
  const mine: any[] = await (await rest(`grades?select=id,fach,titel,art,punkte,datum,halbjahr,untis_id,untis_punkte,konflikt,quelle&user_id=eq.${userId}`)).json();
  const isK = (a: string) => a === "Klausur";
  const byUid = new Map(mine.filter((g) => g.untis_id).map((g) => [g.untis_id, g]));
  const ops: any[] = [], neu: any[] = [], konf: any[] = [];
  const free = mine.filter((g) => !g.untis_id);
  const dist = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime());
  const take = (u: any, pred: (g: any) => boolean) => { const c = free.filter((g) => g.fach === u.fach && g.halbjahr === u.halbjahr && pred(g)).sort((a, b) => dist(a.datum, u.datum) - dist(b.datum, u.datum))[0]; if (c) free.splice(free.indexOf(c), 1); return c; };
  const pending: any[] = [];
  for (const u of ug) {
    const ex = byUid.get(u.untis_id);
    if (ex) {
      if (+ex.untis_punkte !== u.punkte) {
        const k = +ex.punkte !== u.punkte;
        ops.push({ id: ex.id, patch: { untis_punkte: u.punkte, konflikt: k } });
        if (k) konf.push({ ...u, mein: +ex.punkte });
      }
      continue;
    }
    pending.push(u);
  }
  // 1) gleiche Punkte, gleiche Art (Klausur/sonstige) -> verknüpfen
  const rest1: any[] = [];
  for (const u of pending) { const m = take(u, (g) => +g.punkte === u.punkte && isK(g.art) === isK(u.art)); if (m) ops.push({ id: m.id, patch: link(u, m, false) }); else rest1.push(u); }
  // 2) gleiche Punkte, andere Art -> verknüpfen
  const rest2: any[] = [];
  for (const u of rest1) { const m = take(u, (g) => +g.punkte === u.punkte); if (m) ops.push({ id: m.id, patch: link(u, m, false) }); else rest2.push(u); }
  // 3) gleiche Art, andere Punkte -> verknüpfen + Abweichung
  for (const u of rest2) {
    const m = take(u, (g) => isK(g.art) === isK(u.art));
    if (m) { ops.push({ id: m.id, patch: link(u, m, true) }); konf.push({ ...u, mein: +m.punkte }); }
    else neu.push(u);
  }
  function link(u: any, m: any, k: boolean) { return { untis_id: u.untis_id, untis_punkte: u.punkte, konflikt: k, datum: u.datum, halbjahr: u.halbjahr, titel: u.titel, art: u.art, ...(m.quelle === "notan" ? { quelle: "notan+untis" } : { quelle: m.quelle === "manuell" ? "manuell+untis" : m.quelle }) }; }
  if (dry) return { untis: ug.length, verknuepft: ops.length, neu: neu.map((u) => `${u.halbjahr} ${u.fach} ${u.art} ${u.punkte} (${u.code}, ${u.titel})`), konflikte: konf.map((u) => `${u.halbjahr} ${u.fach} ${u.titel}: WebUntis ${u.punkte}, eingetragen ${u.mein}`), codes: [...new Set(ug.map((u) => u.code + "→" + u.fach))], arten: [...new Set(ug.map((u) => u.typ + "→" + u.art))], freiUebrig: free.length };
  for (const o of ops) await rest(`grades?id=eq.${o.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(o.patch) });
  if (neu.length) await rest("grades?on_conflict=user_id,untis_id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(neu.map((u) => ({ user_id: userId, untis_id: u.untis_id, untis_punkte: u.punkte, fach: u.fach, titel: u.titel, art: u.art, punkte: u.punkte, gewicht: 1, datum: u.datum, halbjahr: u.halbjahr, quelle: "untis" }))) });
  return { neu, konf };
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
  let homework: any[] | null = null, hwError = "";
  try { const a = new Date(); a.setDate(a.getDate() - 7); const b = new Date(); b.setDate(b.getDate() + 42); homework = await fetchHomework(s, a, b); } catch (e) { hwError = String((e as Error).message || e); }
  const longMap: Record<string, string> = {};
  for (const w of weeks) for (const l of w.raw) for (const su of l.su || []) if (su?.name) longMap[su.name] = su.longname || su.name;
  let grades: any[] | null = null, grError = "";
  try { grades = await fetchGrades(s, longMap); } catch (e) { grError = String((e as Error).message || e); }
  return { plan: best.plan, raw: best.raw, week: yyyymmdd(best.from), dated, homework, hwError, grades, grError };
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
    if (!body.force && berlinHour() !== 6) return json({ ok: true, skipped: "nicht 6 Uhr in Berlin" });
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
    const { plan: fresh, raw, week, dated, homework, hwError, grades, grError } = await fetchPlan(env);
    if (body.gradesDry) return json({ ok: true, grError, dry: grades ? await syncGrades(userId!, rest, grades, true) : null });
    if (body.debug) return json({ ok: true, week, lessons: raw.slice(0, 5), plan: fresh, dated: (dated || []).slice(0, 8), homework, hwError });
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
    let hwCount = 0;
    if (homework && homework.length) {
      const rows = homework.map((x) => ({
        user_id: userId, untis_id: "hw-" + x.id, typ: "aufgabe", art: "Hausaufgabe",
        titel: (x.text.split("\n")[0] || "Hausaufgabe").slice(0, 120), fach: subjOf(x.subject), datum: x.due,
        notiz: [x.text, x.remark, "Aus WebUntis" + (x.given ? " (aufgegeben am " + x.given.split("-").reverse().join(".") + ")" : "")].filter(Boolean).join("\n\n"),
      }));
      const hw = await rest("entries?on_conflict=user_id,untis_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
      if (hw.ok) hwCount = rows.length;
    }
    let gr: any = null;
    if (grades && grades.length) {
      try {
        gr = await syncGrades(userId!, rest, grades);
        const msgs: any[] = [];
        if (gr.konf.length) msgs.push({ title: gr.konf.length === 1 ? "Noten-Abweichung" : `${gr.konf.length} Noten-Abweichungen`, body: gr.konf.slice(0, 4).map((u: any) => `${u.fach} – ${u.titel}: WebUntis ${String(u.punkte).replace(".", ",")} P., bei dir ${String(u.mein).replace(".", ",")} P.`).join("\n"), tag: "noten-konflikt", url: "./handy.html#noten" });
        if (gr.neu.length && gr.neu.length <= 10) msgs.push({ title: gr.neu.length === 1 ? "Neue Note in WebUntis" : `${gr.neu.length} neue Noten in WebUntis`, body: gr.neu.slice(0, 4).map((u: any) => `${u.fach} – ${u.titel}: ${String(u.punkte).replace(".", ",")} Punkte`).join("\n"), tag: "noten-neu", url: "./handy.html#noten" });
        for (const m of msgs) await fetch(`${URL_}/functions/v1/push`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, "x-cron-secret": env.CRON_SECRET || "" }, body: JSON.stringify({ custom: { uid: userId, ...m } }) }).catch(() => {});
      } catch (e) { gr = { error: String((e as Error).message || e) }; }
    }
    return json({ ok: true, count: fresh.length, week, syncedAt, plan: merged, dated: dated ?? undefined, homework: hwCount, hwError: hwError || undefined, noten: gr ? { neu: gr.neu?.length ?? 0, konflikte: gr.konf?.length ?? 0, error: gr.error } : undefined, grError: grError || undefined });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 502);
  }
}

// deno-lint-ignore no-explicit-any
if (typeof (globalThis as any).Deno !== "undefined" && (globalThis as any).Deno.serve) {
  (globalThis as any).Deno.serve(handler);
}
