// Service Worker: hält die App-Dateien vor, damit sie schnell startet und
// auch ohne Netz aufgeht. Immer zuerst das Netz fragen, damit Updates sofort
// ankommen. Datenbank-Anfragen (andere Domain) laufen nie über den Cache.
const CACHE = 'crm-v13';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'demo.js', 'config.js',
  'manifest.webmanifest', 'vendor/preact-htm.js', 'vendor/purify.js', 'vendor/supabase.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'vendor/fonts/Geist-Variable.woff2', 'vendor/fonts/GeistMono-Variable.woff2',
  'vendor/fonts/instrument-serif-latin-400-normal.woff2', 'vendor/fonts/instrument-serif-latin-400-italic.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
