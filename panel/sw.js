// ============================================================
//  panel/sw.js — Service worker del panel
//  Solo sirve para dos cosas: que Chrome pueda instalar el panel como app (con https, a través de Tailscale) y que,
//  si no se llega al portátil (apagado, sin Tailscale), se vea una página que lo explique en vez de un error. No guarda
//  nada en caché: el panel siempre muestra datos en vivo.
// ============================================================
const OFFLINE = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Bots Minecraft</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center;
  font:16px/1.5 system-ui, sans-serif;background:#15171c;color:#e6e8ee">
<div><div style="font-size:52px">🤖</div><h1 style="font-size:20px;margin:8px 0">No llego al panel</h1>
<p style="color:#949cad;margin:0 0 18px">¿Está encendido el portátil, con el panel abierto y conectado a Tailscale?</p>
<button onclick="location.reload()" style="font:inherit;padding:10px 20px;border:0;border-radius:8px;
  background:#5b93f0;color:#fff">Reintentar</button></div></body></html>`

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', event => {
  // Solo las páginas (el panel y el mapa): si no hay conexión, la página de arriba. Lo demás (estado en vivo, API,
  // imágenes del mapa) no pasa por aquí: va directo a la red
  if (event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(() =>
    new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
})
