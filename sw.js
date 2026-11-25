// sw.js - Service Worker that serves a file stored inside a store-mode RAR as a normal,
// seekable HTTP resource. The <video> element asks for ./stream/<id>/<name> with a Range header;
// we translate that range into Range requests on the archive volume(s) and pipe the bytes back.

const MAP_CACHE = 'rar-player-maps-v1';
const MAX_CHUNK = 2 * 1024 * 1024; // answer open-ended ranges with at most 2 MB, so only needed bytes are read
const maps = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const m = e.data;
  if (m && m.type === 'register') {
    maps.set(m.id, m.map);
    e.waitUntil(caches.open(MAP_CACHE).then((c) => c.put(`/__rar-map/${m.id}`, new Response(JSON.stringify(m.map)))));
    e.source && e.source.postMessage({ type: 'registered', id: m.id });
  }
});

async function getMap(id) {
  if (maps.has(id)) return maps.get(id);
  const c = await caches.open(MAP_CACHE);
  const r = await c.match(`/__rar-map/${id}`);
  if (!r) return null;
  const map = await r.json();
  maps.set(id, map);
  return map;
}

async function notify(msg) {
  const all = await self.clients.matchAll();
  for (const c of all) c.postMessage(msg);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const m = url.pathname.match(/\/stream\/([a-z0-9]+)\//);
  if (!m || url.origin !== self.location.origin) return;
  e.respondWith(serve(e.request, m[1]));
});

async function serve(req, id) {
  const map = await getMap(id);
  if (!map) return new Response('Unknown stream id (reload the player page and open the archive again).', { status: 404 });
  const size = map.size;
  let start = 0, end = size - 1, partial = false;
  const rh = req.headers.get('range');
  if (rh) {
    const mm = rh.match(/bytes=(\d*)-(\d*)/);
    if (mm) {
      partial = true;
      if (mm[1] === '') { start = Math.max(0, size - parseInt(mm[2], 10)); }
      else { start = parseInt(mm[1], 10); if (mm[2] !== '') end = Math.min(parseInt(mm[2], 10), size - 1); }
    }
  }
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  if (partial) end = Math.min(end, start + MAX_CHUNK - 1);

  // Which archive bytes back [start, end]?
  const pieces = [];
  let base = 0;
  for (const s of map.segments) {
    const a = Math.max(start, base), b = Math.min(end, base + s.length - 1);
    if (a <= b) pieces.push({ url: s.url, from: s.offset + (a - base), to: s.offset + (b - base) });
    base += s.length;
  }

  // Report each upstream read: the range asked for and the bytes actually received
  // (the player often cancels a response early, e.g. when you seek).
  let i = 0, reader = null, cur = null;
  const report = (cancelled) => {
    if (cur) notify({ type: 'range', id, url: cur.url, from: cur.from, to: cur.to, got: cur.got, cancelled });
    cur = null;
  };
  const body = new ReadableStream({
    async pull(ctrl) {
      for (;;) {
        if (!reader) {
          if (i >= pieces.length) { ctrl.close(); return; }
          const p = pieces[i++];
          const r = await fetch(p.url, { headers: { Range: `bytes=${p.from}-${p.to}` }, mode: 'cors', cache: 'no-store' });
          if (r.status !== 206) { ctrl.error(new Error(`Upstream returned ${r.status} for a range request`)); return; }
          cur = { ...p, got: 0 };
          reader = r.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) { reader = null; report(false); continue; }
        cur.got += value.length;
        ctrl.enqueue(value);
        return;
      }
    },
    cancel() { report(true); reader && reader.cancel(); },
  });

  const headers = {
    'Content-Type': map.type,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Cache-Control': 'no-store',
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: partial ? 206 : 200, headers });
}
