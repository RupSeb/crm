// Service Worker: hält die App-Dateien vor, damit sie schnell startet und
// auch ohne Netz aufgeht. Immer zuerst das Netz fragen, damit Updates sofort
// ankommen. Datenbank-Anfragen (andere Domain) laufen nie über den Cache.
// „no-cache“: beim Server nachfragen statt bis zu 10 Minuten den Browser-Zwischenspeicher
// von GitHub Pages zu nehmen. Unveränderte Dateien kosten dabei nur eine kurze Rückfrage.
const CACHE = 'crm-v52';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'demo.js', 'config.js',
  'manifest.webmanifest', 'vendor/preact-htm.js', 'vendor/purify.js', 'vendor/supabase.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'vendor/fonts/Geist-Variable.woff2', 'vendor/fonts/GeistMono-Variable.woff2',
  'vendor/fonts/instrument-serif-latin-400-normal.woff2', 'vendor/fonts/instrument-serif-latin-400-italic.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    // Über die Adresse statt über die Anfrage: Seitenaufrufe (mode „navigate“) lassen sich nicht mit Optionen neu bauen
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});

// Erinnerung an Wiedervorlagen (Funktion „erinnerung“): Mitteilung zeigen, Zahl ans App-Symbol
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const jobs = [self.registration.showNotification(d.title || 'CRM', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'wiedervorlagen',
    data: { url: d.url || '#/heute' },
  })];
  if (d.anzahl != null && self.navigator.setAppBadge) jobs.push(self.navigator.setAppBadge(d.anzahl).catch(() => {}));
  e.waitUntil(Promise.all(jobs));
});

// Antippen: offenes CRM nach vorn holen und dorthin wechseln, sonst neu öffnen
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const hash = e.notification.data?.url || '#/heute';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list.find((c) => c.url.startsWith(self.registration.scope));
    if (win) { win.postMessage({ go: hash }); return win.focus(); }
    return self.clients.openWindow(new URL(hash, self.registration.scope).href);
  }));
});
