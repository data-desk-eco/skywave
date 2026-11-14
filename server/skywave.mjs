// skywave server: one process holds the kiwisdr connections for every
// region someone is watching, decodes DSC on each, and on every decoded
// burst cuts ALL same-band receivers' buffers, times them against the
// decoded bit sequence, solves a position and attaches the ship's single
// latest LSEG AIS position. browsers get one server-sent-event stream.
//
//   GET  /v2/events?region=<id>   hello, rack, status, call, tdoa, audio
//   POST /v2/follow?id=&slot=&band=   which slot's audio a client hears
//   GET  /lseg/track?mmsi=        single latest AIS position (LSEG)
//   GET  /gfw?query=<mmsi>        vessel identity search (no positions)
//
//   PORT=8083 node server/skywave.mjs
// env: LSEG_PROXY_URL, LSEG_PROXY_API_KEY, LSEG_APP_KEY; SKYWAVE_BIAS
// (json file of {"host:port": offsetUs}, see scripts/toa_bias.mjs)

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { decode } from "./dsc.js";
import { baseband } from "./replica.js";
import { arrivals, sunElevation } from "./burst.js";
import { locate, geodist } from "./locate.js";
import { lsegLookupMmsi } from "./lseg.js";
import { regionById, pickRack, pickTargetRack, parseGps, coversBand, bandLabelFor } from "./regions.js";

const RING = 45, WIN = 10, PRE = 2.6, LEN = 10, IDLE_MS = 5 * 60e3;
const RING_KM = [600, 1700], RING_N = 30;   // night helpers around a target
const bias = existsSync(process.env.SKYWAVE_BIAS ?? "") ? JSON.parse(readFileSync(process.env.SKYWAVE_BIAS, "utf8")) : {};
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const compat = (a, b) => a.length === b.length && [...a].every((c, i) => c === "?" || b[i] === "?" || c === b[i]);
const clients = new Map(), rxs = new Map(), bursts = [], fixes = new Map();
let nextClient = 1, list = null, listAt = 0;

const send = (c, ev, data) => c.res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
const all = (ev, data, keep = () => true) => { for (const c of clients.values()) if (keep(c)) send(c, ev, data); };

// ---- receivers -------------------------------------------------------

async function directory() {
  if (list && Date.now() - listAt < 600e3) return list;
  const js = await (await fetch("http://rx.linkfanel.net/kiwisdr_com.js")).text();
  // *.proxy.kiwisdr.com has refused every connection since 2026-11-14:
  // those receivers stay out of the racks unless PROXY=1
  list = JSON.parse(js.slice(js.indexOf("["), js.lastIndexOf("]") + 1).replace(/,(\s*[\]}])/g, "$1"))
    .filter((x) => process.env.PROXY || !/proxy\.kiwisdr\.com/.test(x.url || ""));
  listAt = Date.now();
  return list;
}

// the region's rack, plus for a single-band target a ring of distant
// receivers on that band: at night only arrivals from beyond ~500 km
// are consistent enough to fix a ship inside the rack
async function rackFor(region) {
  const rs = await directory();
  const picks = region.target ? pickTargetRack(rs, region.target) : pickRack(rs, region.bbox);
  if (region.target?.bands?.length === 1) {
    const khz = region.target.bands[0], have = new Set(picks.map((p) => `${p.host}:${p.port}`)), ring = [];
    for (const x of rs) {
      const gps = parseGps(x.gps), u = /^https?:\/\/([^:/]+)(?::(\d+))?/.exec(x.url || "");
      if (!gps || !u || !(+x.fixes > 0) || x.offline === "yes" || x.status !== "active" || +x.users_max - +x.users < 2 || !coversBand(x, khz)) continue;
      const d = geodist(gps, region.target.gps) / 1000;
      if (d < RING_KM[0] || d > RING_KM[1] || have.has(`${u[1]}:${+(u[2] || 8073)}`)) continue;
      if (ring.some((r) => geodist(r.gps, gps) < 5000)) continue;
      ring.push({ host: u[1], port: +(u[2] || 8073), bandKHz: khz, bandLabel: bandLabelFor(khz), label: x.name?.slice(0, 60), gps, far: true });
    }
    picks.push(...ring.sort(() => Math.random() - 0.5).slice(0, RING_N));
  }
  return picks.map((p) => ({ slot: `${p.host}:${p.port}`, host: p.host, port: p.port, band: p.bandLabel, bandKHz: p.bandKHz, label: p.label, gps: p.gps, far: p.far }));
}

async function resolve(host, port) {
  if (!/\.proxy\.kiwisdr\.com$/i.test(host)) return { host, port };
  try {
    const u = new URL((await fetch(`http://${host}:${port}/`, { redirect: "follow", signal: AbortSignal.timeout(8000) })).url);
    return { host: u.hostname, port: +(u.port || 80) };
  } catch { return { host, port }; }
}

const goertzel = (x, sr, f) => {
  const cw = 2 * Math.cos(2 * Math.PI * f / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const s0 = x[i] + cw * s1 - s2; s2 = s1; s1 = s0; }
  return Math.max(0, (s1 * s1 + s2 * s2 - cw * s1 * s2) * 4 / (x.length * x.length));
};

class Rx {
  constructor(s) {
    Object.assign(this, { s, key: `${s.slot}|${s.band}`, sr: 12000, used: 0, total: 0, anchors: [], lastKey: "", lastDecode: 0,
      sigs: new Map(), rms: 0, inband: 0, activeAt: 0, on: false, seen: Date.now() });
    this.connect();
  }
  info() { const { slot, band, bandKHz, label, gps } = this.s; return { slot, band, bandKHz, label, gps }; }
  async connect() {
    if (this.closed) return;
    const { host, port } = await resolve(this.s.host, this.s.port);
    let ws;
    try { ws = this.ws = new WebSocket(`ws://${host}:${port}/${Math.floor(Date.now() / 1000)}/SND`); } catch { return this.retry(); }
    ws.binaryType = "arraybuffer";
    const tx = (m) => { try { ws.send(m); } catch {} };
    ws.onopen = () => { tx("SET auth t=kiwi p="); tx("SET ident_user=skywave"); this.ka = setInterval(() => tx("SET keepalive"), 5000); };
    ws.onmessage = (ev) => this.msg(ev.data, tx);
    ws.onclose = ws.onerror = () => { clearInterval(this.ka); try { ws.close(); } catch {} this.retry(); };
  }
  retry() {
    if (this.closed || this.retrying) return;
    if (this.live) all("status", { ...this.info(), state: "down" });
    this.retrying = true; this.live = false;
    setTimeout(() => { this.retrying = false; this.connect(); }, 30000 + Math.random() * 30000);
  }
  close() { this.closed = true; clearInterval(this.ka); try { this.ws?.close(); } catch {} }
  msg(data, tx) {
    if (typeof data === "string") return;
    const u8 = new Uint8Array(data), tag = String.fromCharCode(u8[0], u8[1], u8[2]);
    if (tag === "MSG") {
      const body = new TextDecoder().decode(u8.subarray(4));
      if (body.includes("too_busy") || body.includes("down=")) return this.ws.close();
      const ar = /audio_rate=(\S+)/.exec(body), srm = /sample_rate=(\S+)/.exec(body);
      if (ar) tx(`SET AR OK in=${ar[1]} out=44100`);
      if (srm) {
        this.sr = parseFloat(srm[1]);
        tx("SET squelch=0 max=0");
        // usb dial 1.7 kHz below the channel puts the tones at 1615 / 1785 Hz
        tx(`SET mod=iq low_cut=300 high_cut=3000 freq=${(this.s.bandKHz - 1.7).toFixed(3)}`);
        tx("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50");
        tx("SET compression=0");
        this.live = true; this.used = 0; this.anchors = [];
        all("status", { ...this.info(), state: "live" });
      }
      return;
    }
    if (tag !== "SND" || u8.length < 20) return;
    const b = u8.subarray(3);
    if (b[0] & 0x10 || !(b[0] & 0x08)) return;   // compressed, or not iq
    const rssi = 0.1 * ((b[5] << 8) | b[6]) - 127;
    const sec = (b[9] | (b[10] << 8) | (b[11] << 16) | (b[12] << 24)) >>> 0;
    const nsec = (b[13] | (b[14] << 8) | (b[15] << 16) | (b[16] << 24)) >>> 0;
    const iq = b.subarray(17), n = iq.length >> 2, key = `${sec}.${nsec}`;
    if (key !== this.lastKey && (sec || nsec)) {
      this.anchors.push({ abs: this.total, t: sec + nsec / 1e9 });
      while (this.anchors.length > 2 && this.anchors[0].abs < this.total - this.sr * (RING + 4)) this.anchors.shift();
    }
    this.lastKey = key;
    const max = Math.floor(this.sr * RING);
    if (!this.i || this.i.length !== max) { this.i = new Float32Array(max); this.q = new Float32Array(max); this.used = 0; }
    if (this.used + n > max) {
      const s = this.used + n - max;
      this.i.copyWithin(0, s, this.used); this.q.copyWithin(0, s, this.used); this.used -= s;
    }
    const dv = new DataView(iq.buffer, iq.byteOffset), pcm = Buffer.alloc(n * 2);
    for (let k = 0; k < n; k++) {
      const re = dv.getInt16(k * 4);
      this.i[this.used + k] = re / 32768; this.q[this.used + k] = dv.getInt16(k * 4 + 2) / 32768;
      pcm.writeInt16BE(re, k * 2);
    }
    const frame = this.i.subarray(this.used, this.used + n);
    this.used += n; this.total += n;
    // burst gate: level plus energy at the two fsk tones
    let p = 0;
    for (const x of frame) p += x * x;
    this.rms = this.rms * 0.8 + Math.sqrt(p / n) * 0.2;
    this.inband = this.inband * 0.65 + (goertzel(frame, this.sr, 1615) + goertzel(frame, this.sr, 1785)) / (p * 2 / n + 1e-9) * 0.35;
    const now = Date.now();
    if (this.rms > 0.01 && this.inband > 0.15) {
      this.activeAt = now;
      if (!this.on) { this.on = true; all("status", { ...this.info(), state: "burst", rssi }); }
    } else if (this.on && now - this.activeAt > 1500) { this.on = false; all("status", { ...this.info(), state: "live", rssi }); }
    if (this.on) all("audio", { slot: this.s.slot, band: this.s.band, sr: this.sr, rssi, pcm: pcm.toString("base64") }, (c) => c.follow === this.key);
    if (now - this.lastDecode > 3000 && this.used >= this.sr * WIN) { this.lastDecode = now; this.decode(); }
  }
  // gps time ↔ absolute sample index, from a line through recent anchors
  clock() {
    const a = this.anchors;
    if (a.length < 8) return null;
    const t = a.map((p) => (p.t < a[0].t - 3e5 ? p.t + 604800 : p.t)), x0 = a[0].abs, t0 = t[0];
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    a.forEach((p, k) => { const x = p.abs - x0, y = t[k] - t0; sx += x; sy += y; sxx += x * x; sxy += x * y; });
    const n = a.length, m = (n * sxy - sx * sy) / (n * sxx - sx * sx), c = (sy - m * sx) / n;
    let rss = 0;
    a.forEach((p, k) => { rss += (t[k] - t0 - c - m * (p.abs - x0)) ** 2; });
    return Math.sqrt(rss / n) > 5e-6 ? null : { tAt: (abs) => t0 + c + m * (abs - x0), absAt: (T) => x0 + (T - t0 - c) / m, sr: 1 / m };
  }
  decode() {
    const off = Math.max(0, this.used - Math.floor(this.sr * WIN)), view = this.i.subarray(off, this.used);
    let g = 0;
    for (let k = 0; k < view.length; k += 64) g += view[k] * view[k];
    if (Math.sqrt(g * 64 / view.length) < 0.005) return;
    let call;
    try { call = decode(view, this.sr, {}); } catch { return; }
    if (!call?.caller) return;
    // one row per call: a decode that ran before the end-of-sequence
    // symbol arrived (eos "—") waits for the next pass to complete it
    const sig = [call.formatCode, call.destination, call.caller, call.tc1Code, call.tc2Code].join("|"), now = Date.now();
    for (const [k, t] of this.sigs) if (now - Math.abs(t) > 120000) this.sigs.delete(k);
    const seen = this.sigs.get(sig);
    if (seen > 0) return;
    this.sigs.set(sig, call.eos === "—" && !seen ? -now : now);
    delete call.symbols;
    if (this.sigs.get(sig) > 0) all("call", { ...this.info(), call });
    const clk = this.clock();
    if (!clk) return;
    const T = clk.tAt(this.total - this.used + off + (call.startSample | 0));
    let b = bursts.find((b) => b.band === this.s.band && Math.abs(b.T - T) < 2 && compat(b.caller, call.caller));
    if (!b) {
      bursts.push(b = { T, band: this.s.band, caller: call.caller, call, q: new Map(), wallMs: now });
      if (bursts.length > 50) bursts.shift();
      setTimeout(() => solve(b).catch((e) => log(`solve failed ${e.message}`)), 7500);
    }
    if (!call.caller.includes("?")) { b.caller = call.caller; b.call = call; }
    b.q.set(this.s.slot, Math.min(b.q.get(this.s.slot) ?? 999, call.badSymbols * 10 + call.phasingScore));
  }
  // ±300 Hz baseband of the burst window, or "wait" while frames lag
  cut(b) {
    const clk = this.live && this.clock();
    if (!clk) return null;
    const head = this.total - this.used, a = Math.round(clk.absAt(b.T - PRE)) - head, n = Math.floor(LEN * this.sr);
    if (a < 0) return null;
    if (a + n > this.used) return "wait";
    const z = baseband(this.i.subarray(a, a + n), this.q.subarray(a, a + n), this.sr, 1700);
    z.fs = clk.sr / Math.round(this.sr / 2000);
    return { host: this.s.slot, gps: this.s.gps, label: this.s.label, sr: this.sr, t0: clk.tAt(head + a), z };
  }
}

// ---- solve -----------------------------------------------------------

const tick = () => new Promise((r) => setImmediate(r));

async function solve(b) {
  let todo = [...rxs.values()].filter((r) => r.s.band === b.band && r.s.gps);
  const iq = [];
  for (let tries = 0; todo.length && tries < 8; tries++) {
    if (tries) await new Promise((r) => setTimeout(r, 3000));
    const again = [];
    for (const r of todo) { const c = r.cut(b); if (c === "wait") again.push(r); else if (c) iq.push(c); await tick(); }
    todo = again;
  }
  const rows = arrivals(iq, (h) => b.q.get(h) ?? 999)?.filter((r) => r.pr > 6);
  if (!rows || rows.length < 4 || b.caller.includes("?")) return;
  // timing floor by daylight at the cohort's centre; 20.25 kHz-mode
  // kiwis stamp ~463 us early unless individually calibrated.
  const mid = [0, 1].map((k) => rows.reduce((s, r) => s + r.gps[k], 0) / rows.length);
  // night floor: measured error ran ~2x the ellipse at 150 us
  const night = sunElevation(mid, b.wallMs) < 10, floor = night ? 300e-6 : 20e-6;
  const obs = rows.map((r) => ({ gps: r.gps, t: r.t - (bias[r.host] ?? (r.sr > 20000 ? -463 : 0)) * 1e-6, sigma: Math.hypot(r.sigUs * 1e-6, floor) }));
  await tick();
  const f = locate(obs);
  if (!f || !Number.isFinite(f.semiMajorKm)) return;
  const pos = [f.lat, f.lon], km = (p) => geodist(pos, p) / 1000;
  const a = await lsegLookupMmsi(process.env, b.caller).catch(() => null);
  const ais = a?.lat != null ? { name: a.name, lat: a.lat, lon: a.lon, ts: a.ts, speed: a.speed,
    km: +km([a.lat, a.lon]).toFixed(1), ageMin: a.ts ? Math.round((Date.now() - a.ts) / 60e3) : null } : null;
  const prev = (fixes.get(b.caller) ?? []).filter((x) => Date.now() - x.t < 30 * 60e3).slice(-9);
  const dist = prev.map((x) => km(x.pos));
  fixes.set(b.caller, [...prev, { t: Date.now(), pos }]);
  const { caller, destination, formatCode, categoryCode, eos } = b.call;
  const msg = {
    mmsi: b.caller, call: { caller, destination, formatCode, categoryCode, eos },
    position: { lat: +f.lat.toFixed(4), lon: +f.lon.toFixed(4), semiMajorKm: +f.semiMajorKm.toFixed(1),
      semiMinorKm: +f.semiMinorKm.toFixed(1), bearingDeg: Math.round(((90 - f.orientDeg) % 180 + 180) % 180) },
    quality: { receivers: rows.length, decoders: rows.filter((r) => r.dec).length, night }, quorum: rows.length,
    receivers: rows.map((r, i) => ({ slot: r.host, label: iq.find((c) => c.host === r.host).label, gps: r.gps, dec: !!r.dec,
      snrDb: r.snrDb, resUs: Math.round(f.res[i] * 1e6), w: +f.w[i].toFixed(2) })),
    ais, convergence: { fixCount: prev.length + 1, agreeCount: 1 + dist.filter((d) => d <= 200).length, maxDistKm: Math.round(Math.max(0, ...dist)) },
    broadcastMs: Date.now(),
  };
  all("tdoa", msg);
  log(`fix ${b.caller} ${msg.position.lat},${msg.position.lon} ±${msg.position.semiMajorKm} km q=${rows.length}${night ? " night" : ""}${ais ? ` ais Δ${ais.km} km` : ""}`);
}

// ---- http ------------------------------------------------------------

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (res, o, status = 200) => { res.writeHead(status, { ...CORS, "content-type": "application/json" }); res.end(JSON.stringify(o)); };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), q = url.searchParams;
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    if (url.pathname === "/v2/events") {
      const region = regionById(q.get("region") || "global"), c = { id: String(nextClient++), res, keys: new Set(), follow: null };
      res.writeHead(200, { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
      clients.set(c.id, c);
      req.on("close", () => clients.delete(c.id));
      send(c, "hello", { id: c.id });
      const slots = await rackFor(region);
      for (const s of slots) {
        const key = `${s.slot}|${s.band}`;
        c.keys.add(key);
        if (!rxs.has(key)) rxs.set(key, new Rx(s));
      }
      send(c, "rack", { region: region.id, regionName: region.name, slots });
      for (const k of c.keys) if (rxs.get(k).live) send(c, "status", { ...rxs.get(k).info(), state: "live" });
      return;
    }
    if (url.pathname === "/v2/follow") {
      const c = clients.get(q.get("id"));
      if (c) c.follow = q.get("slot") === "none" ? null : `${q.get("slot")}|${q.get("band")}`;
      return json(res, { ok: !!c });
    }
    if (url.pathname === "/lseg/track" && /^\d{9}$/.test(q.get("mmsi") || ""))
      return json(res, await lsegLookupMmsi(process.env, q.get("mmsi")));
    if (url.pathname === "/gfw" && /^\d{9}$/.test(q.get("query") || "")) {
      const r = await fetch("https://gateway.api.globalfishingwatch.org/v3/vessels/search?includes%5B0%5D=MATCH_CRITERIA&includes%5B1%5D=OWNERSHIP"
        + `&datasets%5B0%5D=public-global-vessel-identity%3Av4.0&query=${q.get("query")}`, { headers: { accept: "*/*", authorization: "Bearer",
        origin: "https://globalfishingwatch.org", referer: "https://globalfishingwatch.org/map/fishing-activity/default-public/vessel-search" } });
      res.writeHead(r.status, { ...CORS, "content-type": "application/json", "cache-control": "public, max-age=86400" });
      return res.end(await r.text());
    }
    if (url.pathname === "/status") return json(res, { clients: clients.size, receivers: rxs.size, live: [...rxs.values()].filter((r) => r.live).length });
    json(res, { error: "not found" }, 404);
  } catch (e) { log(`${url.pathname} failed ${e.message}`); if (!res.headersSent) json(res, { error: "failed" }, 502); }
}).listen(+(process.env.PORT ?? 8083), "127.0.0.1", () => log("skywave listening"));

// a receiver nobody's rack names for 5 minutes gives its kiwi slot back;
// a comment line every 20 s keeps idle streams open through proxies
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) { c.res.write(": ka\n\n"); for (const k of c.keys) if (rxs.has(k)) rxs.get(k).seen = now; }
  for (const [k, r] of rxs) if (now - r.seen > IDLE_MS) { r.close(); rxs.delete(k); }
}, 20000);
