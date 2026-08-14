const CACHE_NAME = 'gestao-tarefas-v1';
const ASSETS_TO_CACHE = [
'/',
'/index.html',
'/manifest.json',
'/icon-192.png',
'/icon-512.png'
];

self.addEventListener('install', function(event) {
event.waitUntil(
caches.open(CACHE_NAME).then(function(cache) {
return cache.addAll(ASSETS_TO_CACHE);
})
);
self.skipWaiting();
});

self.addEventListener('activate', function(event) {
event.waitUntil(
caches.keys().then(function(keys) {
return Promise.all(
keys.filter(function(key) { return key !== CACHE_NAME; })
.map(function(key) { return caches.delete(key); })
);
})
);
self.clients.claim();
});

self.addEventListener('fetch', function(event) {
const req = event.request;
const url = new URL(req.url);

if (req.method !== 'GET' || url.origin !== self.location.origin) {
return;
}

event.respondWith(
caches.match(req).then(function(cached) {
if (cached) return cached;
return fetch(req).then(function(response) {
return response;
}).catch(function() {
return caches.match('/index.html');
});
})
);
});
