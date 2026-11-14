// whole-rack burst capture. every receiver keeps a rolling IQ ring;
// when ANY receiver decodes a DSC call, every receiver's ring is cut
// around that burst's gps time and written out (±300 Hz baseband at
// ~2 kHz, int16). arrival times are then measured against the decoded
// bit sequence (replica.js), so receivers too weak to decode still
// contribute a timing — cohorts grow from "who decoded" to "who heard".
//
// FOLLOW=<other capture's jsonl> makes this process a slave: it does not
// decode, it cuts its own receivers on the other capture's bursts (same
// ids), so two processes can share one burst list (burst_toa takes both).
//
//   node scripts/capture_burst.mjs [lat] [lon] [radiusKm] [maxRx] [hours] [minKm] > captures/x.jsonl 2> captures/x.log

import { decode as dscDecode } from "../server/dsc.js";
import { baseband } from "../server/replica.js";
import { openSync, readSync, fstatSync } from "node:fs";

const [lat = 51, lon = 1.5, radiusKm = 600, maxRx = 60, hours = 4, minKm = 0] = process.argv.slice(2);
const RING = 45, WIN = 10, PRE = 2.6, LEN = 10, F0 = 1700;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`);
const compat = (a, b) => a.length === b.length && [...a].every((c, i) => c === "?" || b[i] === "?" || c === b[i]);
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
const bursts = [];
let nextId = 0;

async function resolve(host, port) {
  if (!/\.proxy\.kiwisdr\.com$/i.test(host)) return { host, port };
  try {
    const u = new URL((await fetch(`http://${host}:${port}/`, { redirect: "follow", signal: AbortSignal.timeout(8000) })).url);
    return { host: u.hostname, port: +(u.port || 80) };
  } catch { return { host, port }; }
}

class Rx {
  constructor(slot) { Object.assign(this, { slot, id: `${slot.host}:${slot.port}`, sr: 12000, used: 0, total: 0, anchors: [], lastKey: "", lastDecode: 0, sigs: new Map() }); }
  async connect() {
    if (this.closed) return;
    const { host, port } = await resolve(this.slot.host, this.slot.port);
    const ws = this.ws = new WebSocket(`ws://${host}:${port}/${Math.floor(Date.now() / 1000)}/SND`);
    ws.binaryType = "arraybuffer";
    const send = (m) => { try { ws.send(m); } catch {} };
    ws.onopen = () => { send("SET auth t=kiwi p="); send("SET ident_user=skywave-groundtruth"); this.ka = setInterval(() => send("SET keepalive"), 5000); };
    ws.onmessage = (ev) => this.msg(ev.data, send);
    ws.onclose = ws.onerror = () => {
      clearInterval(this.ka);
      try { ws.close(); } catch {}
      if (this.closed || this.retrying) return;
      this.retrying = true; this.live = false;
      setTimeout(() => { this.retrying = false; this.connect(); }, 30000 + Math.random() * 30000);
    };
  }
  msg(data, send) {
    if (typeof data === "string") return;
    const u8 = new Uint8Array(data), tag = String.fromCharCode(u8[0], u8[1], u8[2]);
    if (tag === "MSG") {
      const body = new TextDecoder().decode(u8.subarray(4));
      if (body.includes("too_busy") || body.includes("down=")) { log(`${this.id} busy/down`); this.ws.close(); return; }
      const ar = /audio_rate=(\S+)/.exec(body), srm = /sample_rate=(\S+)/.exec(body);
      if (ar) send(`SET AR OK in=${ar[1]} out=44100`);
      if (srm) {
        this.sr = parseFloat(srm[1]);
        send("SET squelch=0 max=0");
        send(`SET mod=iq low_cut=300 high_cut=3000 freq=${(this.slot.bandKHz - 1.7).toFixed(3)}`);
        send("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50");
        send("SET compression=0");
        this.live = true; this.used = 0; this.anchors = [];
        log(`${this.id} live sr=${this.sr}`);
      }
      return;
    }
    if (tag !== "SND" || u8.length < 20) return;
    const b = u8.subarray(3), flags = b[0];
    if (flags & 0x10 || !(flags & 0x08)) return;
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
    const dv = new DataView(iq.buffer, iq.byteOffset);
    for (let k = 0; k < n; k++) { this.i[this.used + k] = dv.getInt16(k * 4) / 32768; this.q[this.used + k] = dv.getInt16(k * 4 + 2) / 32768; }
    this.used += n; this.total += n;
    if (!process.env.FOLLOW && Date.now() - this.lastDecode > 3000 && this.used >= this.sr * WIN) { this.lastDecode = Date.now(); this.decode(); }
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
    return { tAt: (abs) => t0 + c + m * (abs - x0), absAt: (T) => x0 + (T - t0 - c) / m, sr: 1 / m, rmsUs: Math.sqrt(rss / n) * 1e6 };
  }
  decode() {
    const off = Math.max(0, this.used - Math.floor(this.sr * WIN)), view = this.i.subarray(off, this.used);
    let g = 0;
    for (let k = 0; k < view.length; k += 64) g += view[k] * view[k];
    if (Math.sqrt(g * 64 / view.length) < 0.005) return;
    let call;
    try { call = dscDecode(view, this.sr, {}); } catch { return; }
    const clk = this.clock();
    if (!call?.caller || !clk) return;
    const sig = [call.formatCode, call.destination, call.caller, call.tc1Code, call.tc2Code, call.eos].join("|"), now = Date.now();
    if (now - (this.sigs.get(sig) || 0) < 60000) return;
    this.sigs.set(sig, now);
    for (const [k, t] of this.sigs) if (now - t > 120000) this.sigs.delete(k);
    const T = clk.tAt(this.total - this.used + off + (call.startSample | 0));
    let b = bursts.find((b) => Math.abs(b.T - T) < 2 && compat(b.caller, call.caller));
    if (!b) {
      bursts.push(b = { id: nextId++, T, caller: call.caller, wallMs: now });
      if (bursts.length > 50) bursts.shift();
      setTimeout(() => dump(b), 7500);
    }
    out({ t: "det", id: b.id, wallMs: now, host: this.id, T, caller: call.caller, destination: call.destination, formatCode: call.formatCode,
      categoryCode: call.categoryCode, tc1: call.tc1Code, eos: call.eos, score: call.phasingScore, bad: call.badSymbols, markHz: call.markHz, spaceHz: call.spaceHz });
    log(`${this.id} DECODE #${b.id} ${call.caller} → ${call.destination ?? "-"} score=${call.phasingScore} bad=${call.badSymbols}`);
  }
  cut(b) {
    const clk = this.live && this.clock();
    if (!clk) return;
    const head = this.total - this.used, a = Math.round(clk.absAt(b.T - PRE)) - head, n = Math.floor(LEN * this.sr);
    if (a < 0) return;
    if (a + n > this.used) return "wait";   // frames still queued (busy host): retry
    const z = baseband(this.i.subarray(a, a + n), this.q.subarray(a, a + n), this.sr, F0);
    let mx = 1e-12;
    for (let k = 0; k < z.re.length; k++) mx = Math.max(mx, Math.abs(z.re[k]), Math.abs(z.im[k]));
    const re = new Int16Array(z.re.length), im = new Int16Array(z.re.length);
    for (let k = 0; k < re.length; k++) { re[k] = Math.round(z.re[k] / mx * 32767); im[k] = Math.round(z.im[k] / mx * 32767); }
    out({ t: "iq", id: b.id, host: this.id, label: this.slot.label, gps: this.slot.gps, sr: this.sr, fs: clk.sr / Math.round(this.sr / 2000),
      t0: clk.tAt(head + a), clkUs: +clk.rmsUs.toFixed(2), scale: mx / 32767, re: b64(re), im: b64(im) });
  }
}

function dump(b, todo = rxs, tries = 0) {
  if (!tries && !process.env.FOLLOW) out({ t: "burst", id: b.id, wallMs: b.wallMs, T: b.T, caller: b.caller });
  const again = todo.filter((r) => { try { return r.cut(b) === "wait"; } catch (e) { log(`${r.id} cut failed ${e.message}`); } });
  if (again.length && tries < 8) setTimeout(() => dump(b, again, tries + 1), 3000);
}

// receivers straight from the public list: gps-fixing, ≥2 free slots,
// nearest-first around the centre, one per 5 km site. proxied hosts
// are skipped unless PROXY=1 (the proxy service is not always up).
const km = (p, q) => {
  const r = Math.PI / 180, h = Math.sin((q[0] - p[0]) * r / 2) ** 2 + Math.cos(p[0] * r) * Math.cos(q[0] * r) * Math.sin((q[1] - p[1]) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const js = await (await fetch("http://rx.linkfanel.net/kiwisdr_com.js")).text();
const slots = [];
for (const x of JSON.parse(js.slice(js.indexOf("["), js.lastIndexOf("]") + 1).replace(/,\s*\]$/, "]"))) {
  const m = /(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(x.gps || ""), u = /^https?:\/\/([^:/]+)(?::(\d+))?/.exec(x.url || "");
  if (!m || !u || !(+x.fixes > 0) || x.offline === "yes" || x.status !== "active" || +x.users_max - +x.users < 2) continue;
  if (/proxy/.test(u[1]) && !process.env.PROXY) continue;
  const gps = [+m[1], +m[2]], d = km(gps, [+lat, +lon]);
  if (d <= +radiusKm && d >= +minKm) slots.push({ host: u[1], port: +(u[2] || 8073), gps, d, label: x.name?.slice(0, 60), sw: x.sw_version, bandKHz: 2187.5 });
}
slots.sort((a, b) => a.d - b.d);
if (+minKm) slots.sort(() => Math.random() - 0.5);   // a ring: spread the picks around it
for (let i = 0; i < slots.length; i++) for (let j = slots.length - 1; j > i; j--) if (km(slots[i].gps, slots[j].gps) < 5) slots.splice(j, 1);
slots.length = Math.min(slots.length, +maxRx);
log(`capturing ${slots.length} receivers within ${radiusKm} km of ${lat},${lon} for ${hours} h`);
out({ t: "meta", startMs: Date.now(), hours: +hours, slots: slots.map((s) => ({ host: `${s.host}:${s.port}`, label: s.label, gps: s.gps, sw: s.sw })) });
if (process.env.FOLLOW) {
  const fd = openSync(process.env.FOLLOW, "r"), buf = Buffer.alloc(1 << 22);
  let pos = fstatSync(fd).size, tail = "";
  setInterval(() => {
    for (let n; (n = readSync(fd, buf, 0, buf.length, pos)) > 0; pos += n) {
      const lines = (tail + buf.toString("latin1", 0, n)).split("\n");
      tail = lines.pop().slice(0, 200);   // only short burst lines matter; iq lines are megabytes
      for (const l of lines) if (l.startsWith('{"t":"burst"')) dump(JSON.parse(l));
    }
  }, 1500);
}
const rxs = slots.map((s) => new Rx(s));
for (const r of rxs) r.connect().catch((e) => log(`${r.id} connect err ${e}`));
setInterval(() => log(`live ${rxs.filter((r) => r.live).length}/${rxs.length}`), 300000);
setTimeout(() => {
  for (const r of rxs) { r.closed = true; try { r.ws?.close(); } catch {} }
  log("capture complete");
  setTimeout(() => process.exit(0), 2000);
}, +hours * 3600 * 1000);
