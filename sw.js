const CACHE_NAME = 'gestao-tarefas-v2';
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

  // HTML (o "app shell"): sempre busca a versao mais nova na rede primeiro.
  // So usa o cache se estiver offline. Isso garante que atualizacoes do app
  // aparecam na hora, sem depender do usuario limpar cache ou reinstalar o PWA.
  const isHTML = req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  if (isHTML) {
    event.respondWith(
      fetch(req).then(function(response) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(req, copy); });
        return response;
      }).catch(function() {
        return caches.match(req).then(function(cached) {
          return cached || caches.match('/index.html');
        });
      })
    );
    return;
  }

  // Demais arquivos estaticos (icones, manifest): cache primeiro, com atualizacao
  // em segundo plano para a proxima visita.
  event.respondWith(
    caches.match(req).then(function(cached) {
      const network = fetch(req).then(function(response) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(req, copy); });
        return response;
      }).catch(function() { return cached; });
      return cached || network;
    })
  );
});
