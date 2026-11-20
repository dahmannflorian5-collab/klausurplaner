// Supabase Edge Function: widget
// Liefert kompakte Daten für ein Homescreen-Widget (KWGT auf Android).
// Aufruf: /functions/v1/widget?k=<widget_token>   (Token steht in user_settings.widget_token)
// Antwort: JSON mit fertigen Textzeilen, z. B. .heute, .jetzt, .pruefung, .pruefungen, .aufgaben, .schnitt

const CORS = { "Access-Control-Allow-Origin": "*" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const WT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const berlin = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}` };
};
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wd = (iso: string) => new Date(iso + "T12:00:00Z").getUTCDay();
const dm = (iso: string) => `${WT[wd(iso)]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
const diff = (a: string, b: string) => Math.round((new Date(b + "T12:00:00Z").getTime() - new Date(a + "T12:00:00Z").getTime()) / 864e5);
const wann = (n: number) => n === 0 ? "heute" : n === 1 ? "morgen" : `in ${n} Tagen`;
const short = (f: string) => String(f || "").replace(/^(Grund|Leistungs)kurs\s+/i, "").replace(/\s+\d+$/, "").replace(/^Volks.*|^Betriebs.*/i, "VBWL");
const label = (e: any) => { const t = String(e.titel || "").trim(), head = [e.art || (e.typ === "klausur" ? "Klausur" : "Aufgabe"), e.fach].filter(Boolean).join(" "); if (!t || t === e.art) return head; if (e.fach && t.toLowerCase().includes(String(e.fach).toLowerCase())) return t; return head + " – " + t; };
const LKF = ["VBWL", "Mathe"];
const mean = (l: any[]) => { const w = l.reduce((s, g) => s + +g.gewicht, 0); return w ? l.reduce((s, g) => s + g.punkte * g.gewicht, 0) / w : null; };
const favg = (l: any[]) => { const k = mean(l.filter((g) => g.art === "Klausur")), o = mean(l.filter((g) => g.art !== "Klausur")); if (k == null) return o; if (o == null) return k; const wk = LKF.includes(l[0].fach) ? 0.5 : 1 / 3; return k * wk + o * (1 - wk); };
const hjOf = (iso: string) => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); const sy = m >= 8 ? y : y - 1; return (13 + sy - 2026) + (m >= 8 || m === 1 ? "/I" : "/II"); };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const env = Deno.env.toObject();
  const rest = (path: string) => fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }).then((r) => r.json());
  const k = new URL(req.url).searchParams.get("k") || "";
  if (!/^[a-f0-9]{32}$/.test(k)) return json({ ok: false, fehler: "Ungültiger Widget-Schlüssel" }, 401);
  const us = await rest(`user_settings?select=user_id&widget_token=eq.${k}`);
  const uid = us?.[0]?.user_id;
  if (!uid) return json({ ok: false, fehler: "Ungültiger Widget-Schlüssel" }, 401);

  const now = berlin(), today = now.day;
  // Schultag für die Stunden: heute, ab 17 Uhr oder am Wochenende der nächste Schultag
  let sday = today;
  if (now.hm >= "17:00") sday = addDays(sday, 1);
  while ([0, 6].includes(wd(sday))) sday = addDays(sday, 1);

  const [ents, pl, grades] = await Promise.all([
    rest(`entries?select=typ,art,titel,fach,datum,von,done,vorlaeufig&user_id=eq.${uid}&done=is.false&datum=gte.${today}&datum=lte.${addDays(today, 60)}&order=datum,von`),
    rest(`planner?select=plan,dated&user_id=eq.${uid}`),
    rest(`grades?select=fach,art,punkte,gewicht,halbjahr&user_id=eq.${uid}&halbjahr=eq.${encodeURIComponent(hjOf(today))}`),
  ]);
  const plan: any[] = Array.isArray(pl?.[0]?.plan) ? pl[0].plan : [];
  const dated: any[] = Array.isArray(pl?.[0]?.dated) ? pl[0].dated : [];
  const datedDays = new Set(dated.map((d) => d.datum));
  let les: any[];
  if (datedDays.has(sday)) {
    les = dated.filter((d) => d.datum === sday).map((d) => ({ von: d.von, bis: d.bis, fach: short(d.fach), raum: d.raum, aus: d.status === "CANCELLED", notiz: d.notiz }));
  } else {
    les = plan.filter((p) => (p.datum ? p.datum === sday : p.tag === wd(sday))).map((p) => ({ von: p.von, bis: p.bis, fach: short(p.fach), raum: p.raum, aus: false, notiz: "" }));
  }
  les.push(...plan.filter((p) => !p.untis && (p.datum ? p.datum === sday : p.tag === wd(sday)) && datedDays.has(sday)).map((p) => ({ von: p.von, bis: p.bis, fach: short(p.fach), raum: p.raum, aus: false, notiz: "" })));
  les.sort((a, b) => a.von.localeCompare(b.von));
  les = les.filter((l, i, arr) => arr.findIndex((x) => x.von === l.von && x.fach === l.fach) === i);
  const lines = les.map((l) => `${l.von}  ${l.fach}${l.raum ? " · " + l.raum : ""}${l.aus ? " – fällt aus" : ""}`);
  const offen = les.filter((l) => !l.aus);
  let jetzt = "";
  if (sday === today) {
    const cur = offen.find((l) => l.von <= now.hm && now.hm < l.bis), next = offen.find((l) => l.von > now.hm);
    jetzt = cur ? `Jetzt: ${cur.fach} bis ${cur.bis}` + (next ? ` · danach ${next.fach}` : "") : next ? `Als Nächstes: ${next.fach} um ${next.von}` : offen.length ? "Schule ist aus für heute" : "Heute keine Stunden";
  } else jetzt = offen.length ? `${dm(sday)}: ${offen.length} Stunden ab ${offen[0].von}` : `${dm(sday)}: frei`;

  const ex = (ents || []).filter((e: any) => e.typ === "klausur");
  const tasks = (ents || []).filter((e: any) => e.typ === "aufgabe" && e.datum <= addDays(today, 7));
  const n0 = ex[0];
  const subj = [...new Set((grades || []).map((g: any) => g.fach))] as string[];
  const avgs = subj.map((f) => favg((grades || []).filter((g: any) => g.fach === f).map((g: any) => ({ ...g, punkte: +g.punkte })))).filter((x) => x != null) as number[];
  const schnitt = avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null;
  const f1 = (n: number) => n.toFixed(1).replace(".", ",");

  const pr = n0 ? `Nächste Prüfung: ${label(n0)} · ${wann(diff(today, n0.datum))}` : "Keine Prüfung geplant";
  const fuss = [pr, tasks.length ? "Aufgaben: " + tasks.slice(0, 3).map((e: any) => label(e)).join(", ") : "", schnitt == null ? "" : `Schnitt ${f1(schnitt)} Punkte · Note ${f1((17 - schnitt) / 3)}`].filter(Boolean).join("\n");
  const alles = [(sday === today ? "Heute, " + dm(today) : dm(sday)) + "\n" + jetzt, lines.length ? lines.join("\n") : "Keine Stunden", fuss].join("\n\n");
  return json({
    ok: true,
    alles,
    stand: now.hm,
    tag: sday === today ? "Heute, " + dm(today) : dm(sday),
    jetzt,
    heute: lines.length ? lines.join("\n") : "Keine Stunden",
    stunden: les.length,
    pruefung: n0 ? label(n0) : "Keine Prüfung geplant",
    pruefung_wann: n0 ? wann(diff(today, n0.datum)) + (n0.vorlaeufig ? " (vorläufig)" : "") : "",
    pruefung_tage: n0 ? diff(today, n0.datum) : null,
    pruefungen: ex.slice(0, 5).map((e: any) => `${dm(e.datum)}  ${label(e)}${e.vorlaeufig ? " (?)" : ""}`).join("\n") || "Keine Prüfungen geplant",
    aufgaben: tasks.slice(0, 6).map((e: any) => `${wann(diff(today, e.datum))}: ${label(e)}`).join("\n") || "Keine offenen Aufgaben",
    aufgaben_anzahl: tasks.length,
    schnitt: schnitt == null ? "–" : f1(schnitt),
    note: schnitt == null ? "–" : f1((17 - schnitt) / 3),
  });
});
