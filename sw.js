// Macht den Klausurplaner offline nutzbar: zuerst Netz, sonst der zuletzt gespeicherte Stand.
const CACHE = 'klausurplaner-shell-v10';
const SHELL = ['./', 'index.html', 'handy.html', 'handy.webmanifest', 'supabase.js', 'config.js', 'manifest.webmanifest', 'icon-k-192.png', 'icon-k-512.png', 'spotify.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return; // Supabase-Anfragen nie zwischenspeichern
  e.respondWith(
    fetch(r).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); }
      return res;
    }).catch(() => caches.match(r).then(m => m || caches.match('index.html')))
  );
});

// Push-Mitteilungen (Erinnerungen morgens und abends)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Klausurplaner', {
    body: d.body || '', tag: d.tag || 'kp', renotify: true, icon: 'icon-k-192.png', badge: 'icon-k-192.png', data: { url: d.url || './handy.html' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './handy.html', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    const w = ws.find(c => c.url.includes('handy.html')) || ws[0];
    return w ? w.focus().then(c => c && c.navigate ? c.navigate(url) : c) : clients.openWindow(url);
  }));
});
