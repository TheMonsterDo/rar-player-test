// rar.js - minimal, dependency-free RAR header reader (RAR5 + RAR4) over HTTP Range requests.
// Reads only archive headers; file data is never downloaded here. Store mode (-m0) only for playback.

export class RarError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const CHUNK = 64 * 1024;

// Fetch bytes [start, end] (inclusive) from url. Requires the host to honour Range (206) and allow CORS.
export async function fetchRange(url, start, end) {
  let r;
  try {
    r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, mode: 'cors', cache: 'no-store' });
  } catch (e) {
    throw new RarError('network', `Could not fetch ${url}. Most likely the host does not allow CORS (cross-origin reads), or it is offline. (${e.message})`);
  }
  if (r.status === 404) throw new RarError('notfound', `Not found (404): ${url}`);
  if (r.status === 416) return new Uint8Array(0); // range starts past end of file
  if (r.status === 200) { r.body?.cancel(); throw new RarError('norange', `The host ignored the Range request (sent the whole file, status 200): ${url}. Streaming needs a host that supports HTTP Range.`); }
  if (r.status !== 206) throw new RarError('http', `HTTP ${r.status} for ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

// Small windowed reader: keeps one fetched window, refetches on a miss.
class RangeReader {
  constructor(url) { this.url = url; this.start = 0; this.buf = new Uint8Array(0); this.bytesFetched = 0; this.requests = 0; }
  async ensure(off, len) {
    if (off >= this.start && off + len <= this.start + this.buf.length) return;
    const size = Math.max(len, CHUNK);
    this.buf = await fetchRange(this.url, off, off + size - 1);
    this.start = off; this.bytesFetched += this.buf.length; this.requests++;
    if (this.buf.length < len) throw new RarError('truncated', `Archive ends early (needed ${len} bytes at offset ${off}): ${this.url}`);
  }
  u8(off) { return this.buf[off - this.start]; }
  u16(off) { const i = off - this.start; return this.buf[i] | (this.buf[i + 1] << 8); }
  u32(off) { const i = off - this.start; return (this.buf[i] | (this.buf[i + 1] << 8) | (this.buf[i + 2] << 16)) + this.buf[i + 3] * 0x1000000; }
  bytes(off, len) { const i = off - this.start; return this.buf.subarray(i, i + len); }
  // RAR5 variable-length integer: 7 bits per byte, little endian, high bit = more.
  vint(off) {
    let v = 0, mul = 1, n = 0;
    for (;;) {
      const b = this.u8(off + n); n++;
      v += (b & 0x7f) * mul; mul *= 128;
      if (!(b & 0x80)) break;
      if (n > 10) throw new RarError('corrupt', 'Bad vint in RAR5 header');
    }
    return [v, n];
  }
}

const SIG5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const SIG4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
const dec = new TextDecoder();

// Parse one volume. Returns { format, isVolume, volumeNumber, oldNaming, entries: [...] , stats }.
export async function readVolume(url) {
  const rd = new RangeReader(url);
  await rd.ensure(0, 8);
  const head = rd.bytes(0, 8);
  const is5 = SIG5.every((b, i) => head[i] === b);
  const is4 = !is5 && SIG4.every((b, i) => head[i] === b);
  if (!is5 && !is4) throw new RarError('notrar', `Not a RAR archive (no RAR signature at the start): ${url}`);
  const vol = is5 ? await parse5(rd) : await parse4(rd);
  vol.format = is5 ? 'RAR5' : 'RAR4';
  vol.url = url;
  vol.stats = { bytesFetched: rd.bytesFetched, requests: rd.requests };
  return vol;
}

async function parse5(rd) {
  const out = { isVolume: false, volumeNumber: 0, oldNaming: false, entries: [] };
  let pos = 8;
  for (let guard = 0; guard < 10000; guard++) {
    await rd.ensure(pos, 4 + 3);
    const [hsize, hl] = rd.vint(pos + 4);
    const hstart = pos + 4 + hl;
    if (hsize <= 0 || hsize > 2 * 1024 * 1024) throw new RarError('corrupt', 'Bad RAR5 header size');
    await rd.ensure(hstart, hsize);
    let p = hstart;
    const [type, l1] = rd.vint(p); p += l1;
    const [hflags, l2] = rd.vint(p); p += l2;
    let extraSize = 0, dataSize = 0;
    if (hflags & 0x1) { const [v, l] = rd.vint(p); extraSize = v; p += l; }
    if (hflags & 0x2) { const [v, l] = rd.vint(p); dataSize = v; p += l; }
    const hend = hstart + hsize;
    if (type === 4) throw new RarError('password', 'This RAR is password-protected (file names are encrypted too). Encrypted archives cannot be streamed.');
    if (type === 1) { // main archive header
      const [af, l] = rd.vint(p); p += l;
      out.isVolume = !!(af & 0x1);
      if (af & 0x2) out.volumeNumber = rd.vint(p)[0];
    } else if (type === 2) { // file header
      const [ff, a] = rd.vint(p); p += a;
      const [unp, b] = rd.vint(p); p += b;
      const [, c] = rd.vint(p); p += c; // attributes
      if (ff & 0x2) p += 4; // mtime
      if (ff & 0x4) p += 4; // data crc32
      const [ci, d] = rd.vint(p); p += d;
      const [, e] = rd.vint(p); p += e; // host OS
      const [nlen, f] = rd.vint(p); p += f;
      const name = dec.decode(rd.bytes(p, nlen));
      let encrypted = false;
      let q = hend - extraSize;
      while (q < hend) { // extra records
        const [rsize, g] = rd.vint(q);
        const [rtype] = rd.vint(q + g);
        if (rtype === 1) encrypted = true;
        q += g + rsize;
      }
      out.entries.push({
        name, isDir: !!(ff & 0x1), size: unp, method: (ci >> 7) & 0x7, solid: !!(ci & 0x40), encrypted,
        dataOffset: hend, dataSize, splitBefore: !!(hflags & 0x8), splitAfter: !!(hflags & 0x10),
      });
    } else if (type === 5) { // end of archive
      break;
    }
    pos = hend + dataSize;
  }
  return out;
}

async function parse4(rd) {
  const out = { isVolume: false, volumeNumber: 0, oldNaming: true, entries: [] };
  let pos = 7;
  for (let guard = 0; guard < 10000; guard++) {
    try { await rd.ensure(pos, 7); } catch (e) { if (e.code === 'truncated') break; throw e; }
    const type = rd.u8(pos + 2), flags = rd.u16(pos + 3), size = rd.u16(pos + 5);
    if (size < 7) throw new RarError('corrupt', 'Bad RAR4 header size');
    await rd.ensure(pos, size);
    const add = (flags & 0x8000) ? rd.u32(pos + 7) : 0;
    if (type === 0x73) { // main header
      out.isVolume = !!(flags & 0x0001);
      out.oldNaming = !(flags & 0x0010);
      if (flags & 0x0080) throw new RarError('password', 'This RAR is password-protected (file names are encrypted too). Encrypted archives cannot be streamed.');
    } else if (type === 0x74) { // file header
      let pack = rd.u32(pos + 7), unp = rd.u32(pos + 11);
      const method = rd.u8(pos + 25), nsize = rd.u16(pos + 26);
      let noff = pos + 32;
      if (flags & 0x100) { pack += rd.u32(pos + 32) * 2 ** 32; unp += rd.u32(pos + 36) * 2 ** 32; noff = pos + 40; }
      let nb = rd.bytes(noff, nsize);
      const z = nb.indexOf(0); if (z >= 0) nb = nb.subarray(0, z); // unicode names: keep the ASCII part
      out.entries.push({
        name: dec.decode(nb).replace(/\\/g, '/'), isDir: (flags & 0xe0) === 0xe0, size: unp,
        method: method - 0x30, solid: !!(flags & 0x10), encrypted: !!(flags & 0x04),
        dataOffset: pos + size, dataSize: pack, splitBefore: !!(flags & 0x01), splitAfter: !!(flags & 0x02),
      });
    } else if (type === 0x7b) {
      break;
    }
    pos += size + add;
  }
  return out;
}

// Guess the next volume's URL from the current one.
export function nextVolumeUrl(url, index, vol) {
  const u = new URL(url);
  const m = u.pathname.match(/^(.*\.part)(\d+)(\.rar)$/i);
  if (m) {
    const n = String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
    u.pathname = m[1] + n + m[3];
    return u.toString();
  }
  if (/\.rar$/i.test(u.pathname) && index === 0) { u.pathname = u.pathname.replace(/\.rar$/i, '.r00'); return u.toString(); }
  const r = u.pathname.match(/^(.*\.r)(\d\d)$/i);
  if (r) { u.pathname = r[1] + String(parseInt(r[2], 10) + 1).padStart(2, '0'); return u.toString(); }
  return null;
}

export const VIDEO_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm' };
export const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

// Open an archive (one URL, or an explicit list of volume URLs). onVolume(vol) is called per volume.
export async function openArchive(urls, onVolume = () => {}) {
  const explicit = urls.length > 1;
  const volumes = [];
  let url = urls[0];
  for (let i = 0; url && i < 999; i++) {
    let vol;
    try { vol = await readVolume(url); }
    catch (e) {
      if (i > 0 && e.code === 'notfound') throw new RarError('missingpart', `Multi-part archive: the next part was not found at ${url}. Paste all part URLs (one per line) if they don't follow the .partN.rar naming.`);
      throw e;
    }
    volumes.push(vol); onVolume(vol);
    const last = vol.entries[vol.entries.length - 1];
    const continues = last && last.splitAfter;
    if (!continues) break;
    url = explicit ? urls[i + 1] : nextVolumeUrl(url, i, vol);
    if (!url) throw new RarError('missingpart', 'Multi-part archive, but the next part URL could not be guessed. Paste all part URLs, one per line.');
  }
  // Merge entries across volumes into files with segment lists.
  const files = new Map();
  for (const vol of volumes) {
    for (const e of vol.entries) {
      if (e.isDir) continue;
      let f = files.get(e.name);
      if (!f || !e.splitBefore) {
        f = { name: e.name, size: e.size, method: e.method, encrypted: e.encrypted, solid: e.solid, segments: [] };
        files.set(e.name, f);
      }
      f.method = Math.max(f.method, e.method);
      f.encrypted = f.encrypted || e.encrypted;
      f.segments.push({ url: vol.url, offset: e.dataOffset, length: e.dataSize });
    }
  }
  return { volumes, files: [...files.values()] };
}

// Why can't this file be streamed? null = it can.
export function streamProblem(f) {
  if (f.encrypted) return 'This file is password-protected. Encrypted RAR content cannot be streamed (it would need the password and decryption of every byte).';
  if (f.method !== 0) return `This file is compressed (RAR method ${f.method}, not store mode). Only store-mode (-m0) RAR can be streamed: compressed data has to be unpacked from the start. Download and unpack it instead.`;
  const total = f.segments.reduce((s, x) => s + x.length, 0);
  if (total !== f.size) return `Parts are missing: found ${total} of ${f.size} bytes. Check that all volumes are listed.`;
  return null;
}
