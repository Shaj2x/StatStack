// StatStack service worker: makes the app installable and playable offline.
// App files load fresh whenever the network answers, so updates show straight
// away; the saved copy is used offline or when the network is too slow.
// Bump VERSION when the SHELL list changes to drop the old cache.
const VERSION = "v19";
const NETWORK_TIMEOUT = 4000; // ms before falling back to the saved copy
const SHELL_CACHE = `statstack-shell-${VERSION}`;
const IMAGE_CACHE = "statstack-headshots";
const FONT_CACHE = "statstack-fonts";
// Headshots come from another site, so browsers count each one as a large
// opaque entry against storage. Keep the cache modest.
const MAX_IMAGES = 150;

const SHELL = [
  "./",
  "index.html",
  "css/app.css",
  "js/config.js",
  "js/data.js",
  "js/ratings.js",
  "js/teams.js",
  "js/photos.js",
  "js/fx.js",
  "js/account.js",
  "js/app.js",
  "js/modes.js",
  "js/goals.js",
  "js/social.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith("statstack-shell-") && k !== SHELL_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const {request} = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Player headshots: serve from cache, fetch and keep new ones
  if ((url.hostname === "cdn.nba.com" && url.pathname.startsWith("/headshots/")) ||
      url.hostname === "upload.wikimedia.org") {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  // Google Fonts: keep a copy so the type survives offline
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirstFont(request));
    return;
  }

  // App files: latest from the network, saved copy when offline
  if (url.origin === self.location.origin) {
    const key = request.mode === "navigate" ? "index.html" : request;
    event.respondWith(networkFirst(key, request));
  }
});

async function networkFirst(key, request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // Online: always the latest files, with a time limit so a weak signal
    // falls back to the saved copy instead of hanging
    const response = await Promise.race([
      fetch(request, {cache: "no-cache"}),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT)),
    ]);
    if (response.ok) cache.put(key, response.clone());
    return response;
  } catch {
    const cached = await cache.match(key, {ignoreSearch: true});
    return cached || new Response("Offline", {status: 503, statusText: "Offline"});
  }
}

async function cacheFirstImage(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") {
      cache.put(request, response.clone()).then(() => trimCache(cache)).catch(() => {});
    }
    return response;
  } catch {
    return Response.error(); // the page falls back to the silhouette
  }
}

async function cacheFirstFont(request) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch {
    return Response.error(); // falls back to the system font stack
  }
}

async function trimCache(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_IMAGES))) await cache.delete(key);
}
