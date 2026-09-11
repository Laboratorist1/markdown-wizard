/*
 * Offline shell. The app must open with no network at all: the documents live
 * on the device, so needing a connection to read them would be absurd.
 */
const CACHE = 'markdown-wizard-v12';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './lib/markdown.js',
  './lib/markdown.css',
  './lib/structured.js',
  './lib/structured.css',
  './lib/book.js',
  './lib/book.css',
  './lib/records.js',
  './lib/records.css',
  './manifest.webmanifest',
  './icons/icon192.png',
  './icons/icon512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Cache-first: the shell is versioned by CACHE, so a new release replaces it
  // wholesale rather than serving a half-old, half-new app.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
