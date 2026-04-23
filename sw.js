// AE WeighApp Service Worker — Offline-first caching
// v2: Network-first for JS (always get latest code), cache-first for static assets
const CACHE_NAME = 'ae-weighapp-v25';
const ASSETS = [
    '/',
    '/index.html',
    '/styles.css?v=25',
    '/js/app.js?v=25',
    '/js/scales.js?v=25',
    '/js/eid-reader.js?v=25',
    '/js/livestockpro-sync.js?v=25',
    '/manifest.json',
    '/icons/icon.svg',
];

// Install — pre-cache all app assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Pre-caching app assets');
            return cache.addAll(ASSETS);
        })
    );
    // Activate immediately (don't wait for old tabs to close)
    self.skipWaiting();
});

// Activate — clean up ALL old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => {
                        console.log('[SW] Removing old cache:', key);
                        return caches.delete(key);
                    })
            );
        })
    );
    // Take control of all open tabs immediately
    self.clients.claim();
});

// Fetch — network-first for JS/HTML (always latest code), cache fallback for offline
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    // Network-first for Supabase API calls
    if (url.hostname.includes('supabase')) {
        event.respondWith(
            fetch(event.request)
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // Network-first for same-origin JS, HTML, and CSS (always get latest code)
    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, clone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // Offline — fall back to cache
                    return caches.match(event.request);
                })
        );
        return;
    }

    // External resources — cache-first
    event.respondWith(
        caches.match(event.request).then((cached) => {
            return cached || fetch(event.request);
        })
    );
});

// Listen for messages from app
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
