/* Spotify-Fernbedienung für den Klausurplaner
   - Anmeldung per PKCE (kein Client Secret nötig), Tokens nur im Browser (localStorage)
   - Zeigt „Läuft gerade“, steuert Wiedergabe, startet Playlists, wechselt das Gerät
   - Seiten binden ein: <div data-sp-box></div> und rufen nach jedem Neuzeichnen SP.paint() auf */
(function () {
  const CLIENT_ID = 'ecf62ced05974dc389d3cb785943d7b3';
  const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative';
  const BASE = location.origin + location.pathname.replace(/[^/]*$/, '');
  const REDIRECT = /handy\.html$/.test(location.pathname) ? BASE + 'handy.html' : BASE;
  const LS = 'kp-sp', LSV = 'kp-sp-ver', LSO = 'kp-sp-open';
  const API = 'https://api.spotify.com/v1';

  const ls = { get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
               set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  let tok = ls.get(LS), st = { player: null, devices: [], lists: null, msg: '', busy: false, open: ls.get(LSO) || '' }, timer = null;

  /* ---------- Rückkehr von Spotify abfangen (vor der Supabase-Anmeldung) ---------- */
  const q = new URLSearchParams(location.search);
  let pendingCode = null;
  if (q.get('state') && q.get('state').startsWith('kpsp-')) {
    const v = ls.get(LSV);
    if (q.get('code') && v && v.state === q.get('state')) pendingCode = { code: q.get('code'), ver: v.ver };
    else if (q.get('error')) st.msg = 'Spotify-Anmeldung abgebrochen.';
    ls.set(LSV, null);
    history.replaceState(null, '', location.pathname + location.hash);
  }

  async function connect() {
    const arr = crypto.getRandomValues(new Uint8Array(48));
    const ver = b64u(arr), state = 'kpsp-' + b64u(crypto.getRandomValues(new Uint8Array(9)));
    const chal = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ver)));
    ls.set(LSV, { ver, state });
    location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, scope: SCOPES, redirect_uri: REDIRECT,
      code_challenge_method: 'S256', code_challenge: chal, state,
    });
  }
  async function tokenCall(body) {
    const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || 'Token-Fehler');
    tok = { access: j.access_token, refresh: j.refresh_token || (tok && tok.refresh), exp: Date.now() + (j.expires_in - 60) * 1000 };
    ls.set(LS, tok);
  }
  async function access() {
    if (!tok) return null;
    if (Date.now() > tok.exp) {
      try { await tokenCall({ grant_type: 'refresh_token', refresh_token: tok.refresh }); }
      catch (e) { tok = null; ls.set(LS, null); st.msg = 'Spotify-Verbindung abgelaufen – bitte neu verbinden.'; return null; }
    }
    return tok.access;
  }
  async function api(path, opt = {}) {
    const a = await access(); if (!a) throw new Error('nicht verbunden');
    const r = await fetch(API + path, { ...opt, headers: { Authorization: 'Bearer ' + a, ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (r.status === 204 || r.status === 202) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error((j && j.error && j.error.message) || ('Fehler ' + r.status)); e.status = r.status; e.reason = j && j.error && j.error.reason; throw e; }
    return j;
  }
  function disconnect() { tok = null; ls.set(LS, null); st = { player: null, devices: [], lists: null, msg: 'Spotify getrennt.', busy: false, open: '' }; paint(); }

  /* ---------- Daten ---------- */
  async function refresh() {
    if (!tok || document.hidden){ if (!tok) paint(); return; }
    try {
      st.player = await api('/me/player?additional_types=episode');
      if (!st.player || !st.player.device) st.devices = ((await api('/me/player/devices')) || {}).devices || [];
      if (st.msg && !st.busy) st.msg = '';
    } catch (e) { if (e.message !== 'nicht verbunden') st.msg = e.status === 403 ? 'Spotify verweigert den Zugriff (Premium nötig oder App nicht freigeschaltet).' : e.message; }
    paint();
  }
  async function act(fn, ok) {
    st.busy = true; paint();
    try { await fn(); st.msg = ok || ''; }
    catch (e) {
      st.msg = e.reason === 'NO_ACTIVE_DEVICE' || e.status === 404 ? 'Kein aktives Gerät – öffne Spotify auf Handy, Tablet oder PC oder wähle unten ein Gerät.' : e.reason === 'PREMIUM_REQUIRED' ? 'Dafür ist Spotify Premium nötig.' : e.message;
      try { st.devices = ((await api('/me/player/devices')) || {}).devices || []; } catch (_) {}
    }
    st.busy = false;
    setTimeout(refresh, 600);
  }
  const playing = () => st.player && st.player.is_playing;
  const ctl = {
    play: () => act(() => api('/me/player/' + (playing() ? 'pause' : 'play'), { method: 'PUT' })),
    next: () => act(() => api('/me/player/next', { method: 'POST' })),
    prev: () => act(() => api('/me/player/previous', { method: 'POST' })),
    list: uri => act(() => api('/me/player/play' + (st.player && st.player.device ? '' : (st.devices[0] ? '?device_id=' + st.devices[0].id : '')), { method: 'PUT', body: JSON.stringify({ context_uri: uri }) }), 'Playlist gestartet'),
    dev: id => act(() => api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [id], play: true }) }), 'Gerät gewechselt'),
  };
  async function loadLists() {
    if (st.lists) return;
    try { const j = await api('/me/playlists?limit=30'); st.lists = (j && j.items || []).filter(Boolean).map(p => ({ uri: p.uri, name: p.name, img: p.images && p.images.length ? p.images[p.images.length - 1].url : '' })); }
    catch (e) { st.lists = []; st.msg = e.message; }
    paint();
  }

  /* ---------- Darstellung ---------- */
  const IC = {
    sp: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="11" fill="#1DB954"/><path d="M6.5 9.3c3.6-1.1 7.8-.8 11 1M7.2 12.4c3-.8 6.4-.5 9 .9M7.8 15.3c2.4-.6 4.9-.4 7 .7" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z" fill="currentColor"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>',
  };
  const fmt = ms => { const s = Math.floor((ms || 0) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function html() {
    if (!tok) return `<div class="sp-h">${IC.sp}<b>Spotify</b></div><p class="sp-m">${esc(st.msg || 'Verbinde dein Spotify, um Musik direkt hier zu steuern.')}</p><button class="sp-btn sp-pri" data-sp="connect">Mit Spotify verbinden</button>`;
    const p = st.player, it = p && p.item;
    let out = `<div class="sp-h">${IC.sp}<b>Spotify</b><span>${p && p.device ? esc(p.device.name) : ''}</span></div>`;
    if (it) {
      const img = (it.album && it.album.images && it.album.images.length ? it.album.images[it.album.images.length > 1 ? 1 : 0].url : it.images && it.images[0] && it.images[0].url) || '';
      const who = it.artists ? it.artists.map(a => a.name).join(', ') : (it.show && it.show.name) || '';
      const pct = it.duration_ms ? Math.min(100, (p.progress_ms || 0) / it.duration_ms * 100) : 0;
      out += `<div class="sp-now">${img ? `<img src="${esc(img)}" alt="">` : '<i class="sp-noimg"></i>'}<div class="sp-t"><b>${esc(it.name)}</b><span>${esc(who)}</span>
        <div class="sp-bar"><i style="width:${pct}%"></i></div><small>${fmt(p.progress_ms)} / ${fmt(it.duration_ms)}</small></div></div>
        <div class="sp-ctl"><button data-sp="prev" aria-label="Zurück" ${st.busy ? 'disabled' : ''}>${IC.prev}</button><button class="sp-big" data-sp="play" aria-label="${p.is_playing ? 'Pause' : 'Abspielen'}" ${st.busy ? 'disabled' : ''}>${p.is_playing ? IC.pause : IC.play}</button><button data-sp="next" aria-label="Weiter" ${st.busy ? 'disabled' : ''}>${IC.next}</button></div>`;
    } else {
      out += `<p class="sp-m">Gerade läuft nichts. Starte eine Playlist oder öffne Spotify auf einem Gerät.</p>`;
      if (st.devices.length) out += `<div class="sp-devs">${st.devices.map(d => `<button class="sp-btn" data-sp="dev" data-id="${esc(d.id)}">▶ ${esc(d.name)}</button>`).join('')}</div>`;
    }
    if (st.msg) out += `<p class="sp-m sp-e">${esc(st.msg)}</p>`;
    out += `<div class="sp-tabs"><button data-sp="tab" data-v="lists" aria-pressed="${st.open === 'lists'}">Playlists</button><button data-sp="tab" data-v="devs" aria-pressed="${st.open === 'devs'}">Geräte</button><button data-sp="off" class="sp-off">Trennen</button></div>`;
    if (st.open === 'lists') out += st.lists == null ? '<p class="sp-m">Lade Playlists …</p>' : `<div class="sp-list">${st.lists.map(l => `<button data-sp="list" data-uri="${esc(l.uri)}">${l.img ? `<img src="${esc(l.img)}" alt="">` : '<i class="sp-noimg"></i>'}<span>${esc(l.name)}</span></button>`).join('') || '<p class="sp-m">Keine Playlists gefunden.</p>'}</div>`;
    if (st.open === 'devs') out += `<div class="sp-list">${(st.devices.length ? st.devices : []).map(d => `<button data-sp="dev" data-id="${esc(d.id)}"><span>${d.is_active ? '🔊 ' : ''}${esc(d.name)} <small>${esc(d.type)}</small></span></button>`).join('') || '<p class="sp-m">Kein Gerät gefunden. Öffne Spotify auf einem Gerät und tippe nochmal auf „Geräte“.</p>'}</div>`;
    return out;
  }
  function paint() { document.querySelectorAll('[data-sp-box]').forEach(el => { el.classList.add('sp-card'); el.innerHTML = html(); }); }

  document.addEventListener('click', ev => {
    const b = ev.target.closest('[data-sp]'); if (!b || !b.closest('[data-sp-box]')) return;
    ev.preventDefault(); ev.stopPropagation();
    const a = b.dataset.sp;
    if (a === 'connect') connect();
    else if (a === 'off') disconnect();
    else if (a === 'tab') { st.open = st.open === b.dataset.v ? '' : b.dataset.v; ls.set(LSO, st.open); if (st.open === 'lists') loadLists(); if (st.open === 'devs') api('/me/player/devices').then(j => { st.devices = (j && j.devices) || []; paint(); }).catch(() => {}); paint(); }
    else if (a === 'list') ctl.list(b.dataset.uri);
    else if (a === 'dev') ctl.dev(b.dataset.id);
    else if (ctl[a]) ctl[a]();
  }, true);

  const css = document.createElement('style');
  css.textContent = `.sp-card{background:var(--card,#fff);border:1px solid var(--line,#e5e5e5);border-radius:16px;padding:12px 14px;margin:12px 0;color:var(--ink,#111)}
.sp-h{display:flex;align-items:center;gap:8px;font-size:13.5px}.sp-h span{margin-left:auto;color:var(--mut,#777);font-size:12px}
.sp-now{display:flex;gap:12px;align-items:center;margin-top:10px}.sp-now img,.sp-noimg{width:64px;height:64px;border-radius:10px;object-fit:cover;flex:none;background:var(--soft,#eee);display:block}
.sp-t{min-width:0;flex:1;display:grid;gap:2px}.sp-t b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:15px}.sp-t span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--mut,#777);font-size:13px}
.sp-t small{color:var(--mut,#777);font-size:11.5px}.sp-bar{height:4px;background:var(--soft,#eee);border-radius:4px;overflow:hidden;margin-top:6px}.sp-bar i{display:block;height:100%;background:#1DB954}
.sp-ctl{display:flex;justify-content:center;align-items:center;gap:18px;margin:10px 0 2px}.sp-ctl button{border:0;background:none;color:var(--ink,#111);width:40px;height:40px;border-radius:50%;cursor:pointer;display:grid;place-items:center}
.sp-ctl svg{width:22px;height:22px}.sp-ctl .sp-big{width:48px;height:48px;background:var(--ink,#111);color:var(--bg,#fff)}.sp-ctl button:disabled{opacity:.5}
.sp-m{font-size:13px;color:var(--mut,#777);margin:8px 0}.sp-e{color:var(--red,#e5484d)}
.sp-btn{border:1px solid var(--line,#ddd);background:var(--card,#fff);color:var(--ink,#111);border-radius:999px;padding:8px 14px;font-weight:600;cursor:pointer;font:inherit;font-size:13.5px}
.sp-pri{background:#1DB954;border-color:#1DB954;color:#fff;width:100%}.sp-devs{display:flex;flex-wrap:wrap;gap:6px}
.sp-tabs{display:flex;gap:6px;margin-top:10px;border-top:1px solid var(--line,#eee);padding-top:10px}.sp-tabs button{border:1px solid var(--line,#ddd);background:none;color:var(--mut,#777);border-radius:999px;padding:5px 12px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.sp-tabs button[aria-pressed=true]{background:var(--ink,#111);color:var(--bg,#fff);border-color:var(--ink,#111)}.sp-tabs .sp-off{margin-left:auto;border:0}
.sp-list{display:grid;gap:4px;margin-top:8px;max-height:260px;overflow:auto}.sp-list button{display:flex;align-items:center;gap:10px;border:0;background:none;color:var(--ink,#111);text-align:left;padding:6px;border-radius:10px;cursor:pointer;font:inherit;font-size:13.5px}
.sp-list button:hover{background:var(--soft,#f2f2f2)}.sp-list img,.sp-list .sp-noimg{width:36px;height:36px;border-radius:6px}.sp-list small{color:var(--mut,#777)}`;
  document.head.appendChild(css);

  window.SP = { paint, refresh, connect, connected: () => !!tok };

  (async () => {
    if (pendingCode) {
      try { await tokenCall({ grant_type: 'authorization_code', code: pendingCode.code, redirect_uri: REDIRECT, code_verifier: pendingCode.ver }); st.msg = ''; }
      catch (e) { st.msg = 'Spotify-Anmeldung fehlgeschlagen: ' + e.message; }
    }
    paint(); refresh();
    if (tok && st.open === 'lists') loadLists();
    timer = setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  })();
})();
