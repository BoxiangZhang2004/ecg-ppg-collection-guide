const CACHE='ecg-ppg-guide-20261112-v4.2';
const ASSETS=['./','./index.html','./style.css?v=4.2','./app.mjs?v=4.2','./engine.mjs?v=4.2','./acquisition.mjs?v=4.2','./serial-protocol.mjs?v=4.2','./signal-quality.mjs?v=4.2','./pulse-processing.mjs?v=4.2','./signal-filters.mjs?v=4.2','./raw-storage.mjs?v=4.2','./zip-store.mjs?v=4.2','./icon.svg','./manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('ecg-ppg-guide-')&&key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}
    return response;
  }).catch(()=>caches.match(event.request).then(cached=>cached||Promise.reject(new Error('Unavailable offline')))));
});
