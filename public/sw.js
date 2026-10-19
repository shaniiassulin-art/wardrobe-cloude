const CACHE = "open-wardrobe-shell-v2";
const IMAGE_CACHE = "wardrobe-images-v1";
// Wardrobe and look photos. Their URLs change (?t=) whenever a photo is replaced,
// so a saved copy never goes stale and can be shown straight from the phone.
const PHOTO_CACHE = "wardrobe-photos-v1";
const MAX_PHOTO_ENTRIES = 1500;
const ACTIVE_CACHES = new Set([CACHE, IMAGE_CACHE, PHOTO_CACHE]);
const isStoredPhoto = (url) => url.pathname.startsWith("/api/import/library/") || url.pathname.startsWith("/api/import/outfits/images/");
const MAX_IMAGE_ENTRIES = 800;
const SHELL = ["/", "/manifest.webmanifest"];

async function trimImages(cache, max = MAX_IMAGE_ENTRIES) {
  const keys = await cache.keys();
  const overflow = keys.length - max;
  if (overflow > 0) await Promise.all(keys.slice(0, overflow).map((request) => cache.delete(request)));
}

async function fetchAndCacheImage(request, cache, max) {
  const response = await fetch(request);
  const contentType = response.headers.get("content-type") || "";
  if (response.ok && !response.redirected && contentType.startsWith("image/")) {
    await cache.put(request, response.clone());
    await trimImages(cache, max);
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => !ACTIVE_CACHES.has(key)).map((key) => caches.delete(key)))),
  ]));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (isStoredPhoto(url)) {
    event.respondWith(caches.open(PHOTO_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      return cached || fetchAndCacheImage(request, cache, MAX_PHOTO_ENTRIES);
    }).catch(() => fetch(request)));
    return;
  }

  if (url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_ipx/")) {
    event.respondWith(caches.open(IMAGE_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const update = fetchAndCacheImage(request, cache);
      if (cached) {
        event.waitUntil(update.catch(() => undefined));
        return cached;
      }
      return update;
    }));
    return;
  }

  // The app's code files have a unique name per version, so a saved copy is
  // always right. Keeping them means a saved page can still start offline.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    }));
    return;
  }

  // Pages: always try the network first. Only a good answer is saved, so an
  // error page (server busy, offline) is never shown later as the site.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      }
      return caches.match(request).then((cached) => cached || caches.match("/")).then((cached) => cached || response);
    }).catch(() => caches.match(request).then((cached) => cached || caches.match("/"))));
  }
});
