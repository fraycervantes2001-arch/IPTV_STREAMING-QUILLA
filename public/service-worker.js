const CACHE = "quilla-v2";

/* Rutas relativas al scope del service worker: funcionan tanto si la app
   vive en la raíz del dominio como si vive en una subcarpeta. */
const FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./quilla.png",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) =>
      // cache.addAll aborta TODO el install si un solo archivo falla (404, etc).
      // Se cachea uno por uno para que un recurso faltante no rompa la instalación.
      Promise.all(
        FILES.map((url) =>
          cache.add(url).catch((err) => console.warn("SW: no se pudo cachear", url, err))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;

  // Solo se cachea el "app shell" (GET, mismo origen). Todo lo demás
  // (player_api.php, listas .m3u/.m3u8, segmentos de video, streams de
  // los servidores IPTV) va directo a la red sin pasar por el cache,
  // para no interferir con las peticiones por rango (seeking) ni con
  // recursos de otros orígenes.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});