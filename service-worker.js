/* Subí este número (v2, v3...) cada vez que actualices app.js/index.html/styles.css
   para forzar a que se borre el caché viejo y todos vean la versión nueva. */
const CACHE = "quilla-v4";

/* Rutas relativas: así funcionan tanto en un dominio propio como en GitHub
   Pages sirviendo desde una subcarpeta (https://usuario.github.io/repo/). */
const FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./quilla.png",
];

/* Instala y cachea los archivos base. skipWaiting() hace que el nuevo
   Service Worker se active de inmediato, sin esperar a que se cierren
   todas las pestañas abiertas del sitio. */
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(FILES))
  );
});

/* Al activarse, borra cualquier caché de una versión anterior y toma control
   de las pestañas abiertas ya mismo (en vez de recién en el próximo reload). */
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Estrategia "red primero, caché de respaldo":
   - Si hay internet, siempre trae la versión más nueva del servidor (y la
     actualiza en caché de paso), así los cambios se ven al toque.
   - Si no hay internet, usa lo que haya guardado en caché para que la app
     siga abriendo offline. */
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
