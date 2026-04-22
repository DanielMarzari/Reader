// Reader TTS service worker.
//
// Narrow scope on purpose: precache the onnxruntime-web WASM backend
// (~32 MB total across .wasm + .mjs files) plus a couple of tiny
// shared configs (tokens.txt, model.json). Everything else passes
// through to the network untouched.
//
// What we DON'T handle here:
//   • The per-voice ONNX blobs (fm_decoder.onnx, text_encoder.onnx,
//     vocos_fp16.onnx) — those are cached via a dedicated chunked
//     Cache Storage path in src/lib/tts/browser-inference.ts. Chrome
//     throws "Unexpected internal error" on single Cache entries
//     larger than ~500 MB, so we split them into 64 MB chunks + a
//     manifest ourselves. Intercepting those URLs here would fight
//     the chunking.
//   • /api/voices and other dynamic JSON — let Next.js handle freshness.
//
// Versioning: bump CACHE_VERSION whenever onnxruntime-web is upgraded.
// The activate handler deletes every older reader-tts-sw-* cache so
// stale WASM doesn't accumulate. Cost of a bump is one re-download of
// the ~32 MB bundle on next page load.

const CACHE_VERSION = "reader-tts-sw-v1";

// onnxruntime-web's runtime backend. The `.jsep.*` variants back the
// WebGPU execution provider; the plain ones are the WASM-only
// fallback. We cache both so the device-capability fallback path
// stays fast even if WebGPU wins on first load.
const ORT_ASSETS = [
  "/ort/ort-wasm-simd-threaded.jsep.wasm",
  "/ort/ort-wasm-simd-threaded.jsep.mjs",
  "/ort/ort-wasm-simd-threaded.wasm",
  "/ort/ort-wasm-simd-threaded.mjs",
];

// Tiny shared configs fetched by the TTS tokenizer + model meta
// loader. Trivial to cache alongside the ORT assets.
const SHARED_SMALL_ASSETS = [
  "/tts-assets/shared/tokens.txt",
  "/tts-assets/shared/model.json",
];

const PRECACHE_URLS = [...ORT_ASSETS, ...SHARED_SMALL_ASSETS];

// ---------- install: precache ----------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // Best-effort: if one URL 404s (e.g. dev server isn't copying
      // WASM yet), log it but don't tank the whole SW install.
      const results = await Promise.allSettled(
        PRECACHE_URLS.map((url) => cache.add(url))
      );
      const failed = results
        .map((r, i) => (r.status === "rejected" ? PRECACHE_URLS[i] : null))
        .filter(Boolean);
      if (failed.length) {
        console.warn("[SW] precache failures (will cache on demand):", failed);
      }
      // Don't wait for tabs to close to activate.
      await self.skipWaiting();
    })()
  );
});

// ---------- activate: drop older versions ----------

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("reader-tts-sw-") && k !== CACHE_VERSION)
          .map((k) => caches.delete(k))
      );
      // Claim already-open tabs immediately (no reload required).
      await self.clients.claim();
    })()
  );
});

// ---------- fetch: cache-first for our narrow asset set ----------

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  const isOrt = path.startsWith("/ort/");
  const isSmallShared = SHARED_SMALL_ASSETS.includes(path);
  if (!isOrt && !isSmallShared) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      if (cached) return cached;

      let response;
      try {
        response = await fetch(request);
      } catch (err) {
        // Offline + not cached → bubble up. Caller gets to surface a
        // meaningful error (e.g. "WASM backend unavailable offline").
        throw err;
      }

      // Cache successful same-origin responses for next time. Skip
      // partial / redirected / opaque responses — cloning those is
      // either forbidden or pointless.
      if (
        response.ok &&
        (response.type === "basic" || response.type === "default")
      ) {
        cache.put(request, response.clone()).catch((e) => {
          console.warn("[SW] cache put failed:", path, e);
        });
      }
      return response;
    })()
  );
});
