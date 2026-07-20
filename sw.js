/* Cache-first service worker: app works fully offline after first load. */
var VERSION = 'xiezi-v22';
var ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'lib/hanzilookup.min.js',
  'data/mmah.json',
  'data/orig.json',
  'data/dict.json',
  'data/chars.json',
  'data/medians.json',
  'data/dialogs.json',
  'data/sentences.json',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-512.png',
  'icons/favicon-64.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(ASSETS); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  // network-first for page loads so updates arrive immediately; cache fallback offline
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
          return hit || caches.match('index.html');
        });
      })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      });
    })
  );
});
