// App lives under /podcast/ on aogj.com — all shell paths are scoped there.
const CACHE_NAME = 'nordpod-v7'
const BASE = '/podcast/'
const APP_SHELL = [
  BASE, BASE + 'index.html', BASE + 'manifest.webmanifest',
  BASE + 'icon.svg', BASE + 'icon-192.png', BASE + 'icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // tolerate any single asset 404ing so install never aborts
      .then((cache) => Promise.allSettled(APP_SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)

  // Cross-origin (podcast images, audio CDN) → straight to network.
  if (url.origin !== self.location.origin) return
  // API is always live.
  if (url.pathname.includes('index.php') || url.pathname.includes('/api/')) return

  // Navigation (HTML) + manifest → network-first, så nye index.html/manifest altid
  // slår igennem (ellers serverer SW en gammel cachet shell efter en opdatering).
  const isHtml = event.request.mode === 'navigate' || url.pathname === BASE || url.pathname.endsWith('/index.html')
  if (isHtml || url.pathname.endsWith('manifest.webmanifest')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const cloned = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned)).catch(() => {})
          }
          return response
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match(BASE))),
    )
    return
  }

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((response) => {
          if (response.ok) {
            const cloned = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned)).catch(() => {})
          }
          return response
        }),
    ),
  )
})
