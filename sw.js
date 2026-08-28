// CityOps app-shell service worker. Bump CACHE on each release.
var CACHE = 'cityops-app-v8';
// Both surfaces of the app, because both are things a traveler opens with no
// signal. The fetch handler is cache-first with a background refresh, so
// without the bump above a phone would serve the previous build once after
// every release; activate deletes the older cache outright.
//
// Root-absolute, and the trip surface is the DIRECTORY /trip/ now (served from
// trip/index.html). This worker registers from the app root so its scope is /,
// which covers /trip/ as well. The retired .html path is a redirect stub and is
// deliberately NOT precached: caching a redirect would keep serving the hop
// after the stub is eventually deleted.
var SHELL = ['/', '/index.html', '/trip/'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(e.request).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
