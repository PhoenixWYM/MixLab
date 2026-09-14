const CACHE = 'mixlab-v19';
const ASSETS = ['./','./index.html','./styles.css?v=19','./data.js?v=19','./app.js?v=19','./manifest.webmanifest','./favicon.svg','./assets/cocktail-still-life.png'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key!==CACHE).map((key)=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached)=>cached || fetch(event.request).then((response)=>{ const copy=response.clone(); caches.open(CACHE).then((cache)=>cache.put(event.request,copy)); return response; }).catch(()=>caches.match('./index.html'))));
});
