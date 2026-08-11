// Service worker kill-switch.
//
// This app registers no service worker — but `localhost:3000` is a shared origin,
// so a worker registered by ANY project ever served on that port stays installed and
// keeps controlling this one. The dev server logs showed a client polling /sw.js
// dozens of times; with no public/ directory the request fell through to the SPA
// fallback and returned index.html with `200 text/html`, so the browser's update
// check failed on a MIME mismatch every time and the stale worker was never replaced.
//
// Serving valid JS here means the next update check succeeds and this worker takes
// over — then immediately deletes every cache and unregisters itself, permanently.
// Deliberately no clients.navigate(): forcing a reload is the exact symptom being
// investigated. The unregister takes effect on the next navigation the user makes.
//
// Safe to keep forever: with nothing registering a worker, this file is only ever
// fetched by a browser that already has a stale registration to clean up.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        // Cache API unavailable or already cleared — unregistering still matters.
      }
      await self.registration.unregister();
    })(),
  );
});

// Never intercept: while this worker is briefly alive it must not serve anything
// from cache, or it could hand back the stale HTML it exists to get rid of.
