/* eslint-disable no-restricted-globals */
/**
 * Klang Valley Transit Reliability — service worker.
 *
 * The product's hardest constraint: the core network runs underground in tunnels
 * with no signal. This worker is what makes the app usable there.
 *
 * Strategies (deliberately simple — no background sync, no push):
 *   app shell + icons      cache-first          (instant repeat cold start)
 *   transit graph JSON     cache-first          (routing works in airplane mode)
 *   /api/*                 stale-while-revalidate (fast, then fresh)
 *   navigations            network with a 4s budget, else cached shell, else offline.html
 *
 * COLD START: on a repeat visit the shell, icons and graph come from cache, so
 * the only thing on the critical path is one HTML document. On throttled 4G that
 * is well inside the 60-second budget, and offline it is immediate.
 */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `kv-transit-shell-${CACHE_VERSION}`;
const GRAPH_CACHE = `kv-transit-graph-${CACHE_VERSION}`;
const API_CACHE = `kv-transit-api-${CACHE_VERSION}`;
const ASSET_CACHE = `kv-transit-assets-${CACHE_VERSION}`;
const CURRENT_CACHES = new Set([SHELL_CACHE, GRAPH_CACHE, API_CACHE, ASSET_CACHE]);

const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  OFFLINE_URL,
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

/** How long a navigation may wait on the network before we serve the cached shell. */
const NAVIGATION_NETWORK_BUDGET_MS = 4000;

/** The graph the router loads. Written by `make graph` (S1). */
const GRAPH_PATH_PREFIX = "/graph/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, so one missing URL cannot fail the whole install.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: "reload" });
            if (response && response.ok) {
              await cache.put(url, response.clone());
            }
          } catch (error) {
            // Offline install (or a not-yet-generated graph) is not fatal.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.map((name) => (CURRENT_CACHES.has(name) ? undefined : caches.delete(name))),
      );
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.disable();
        } catch (error) {
          // Not supported everywhere; harmless.
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isGraphRequest(url) {
  return url.pathname.startsWith(GRAPH_PATH_PREFIX) || url.pathname === "/api/graph";
}

function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest" ||
    /\.(?:css|js|png|jpg|jpeg|svg|webp|woff2?|ttf)$/.test(url.pathname)
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: "OFFLINE_NO_CACHE",
          message: "Offline and this resource is not cached on this device.",
          messageKey: "error.offline_no_cache",
        },
      }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response && response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    // Revalidate in the background; the cached copy is served now.
    return cached;
  }
  const response = await network;
  if (response) return response;
  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: "OFFLINE_NO_CACHE",
        message: "Offline and this response is not cached.",
        messageKey: "error.offline_no_cache",
      },
    }),
    { status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("navigation budget exceeded")), NAVIGATION_NETWORK_BUDGET_MS),
      ),
    ]);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      return response;
    }
  } catch (error) {
    // Fall through to the cached shell.
  }
  const cached =
    (await cache.match(request)) ||
    (await cache.match("/")) ||
    (await caches.match(OFFLINE_URL));
  if (cached) return cached;
  return new Response("Offline", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }
  if (!isSameOrigin(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (isGraphRequest(url)) {
    event.respondWith(cacheFirst(request, GRAPH_CACHE));
    return;
  }
  if (isApiRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
});
