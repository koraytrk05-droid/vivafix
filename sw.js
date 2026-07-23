const CACHE_NAME='vivafix-shell-pwa-backup-v1';

const APP_SHELL=[
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(
        keys
          .filter(key=>key.startsWith('vivafix-shell-')&&key!==CACHE_NAME)
          .map(key=>caches.delete(key))
      ))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING'){
    self.skipWaiting();
  }
});

self.addEventListener('fetch',event=>{
  const request=event.request;

  if(request.method!=='GET')return;

  const url=new URL(request.url);

  if(url.origin!==self.location.origin){
    return;
  }

  if(request.mode==='navigate'){
    event.respondWith(
      fetch(request)
        .then(response=>{
          const copy=response.clone();
          caches.open(CACHE_NAME).then(cache=>cache.put('./index.html',copy));
          return response;
        })
        .catch(async()=>{
          return await caches.match('./index.html')||
            await caches.match('./')||
            Response.error();
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request,{ignoreSearch:true}).then(cached=>{
      if(cached)return cached;

      return fetch(request).then(response=>{
        if(response&&response.ok){
          const copy=response.clone();
          caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));
        }
        return response;
      });
    })
  );
});
