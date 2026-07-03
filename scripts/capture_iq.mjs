// live IQ capture harness for TDOA ground-truthing. connects directly
// to the kiwis in a region's MF rack, decodes DSC continuously, and for
// every decoded burst writes a JSONL record with the COMPLEX snippet
// plus raw GPS anchors, so offline analysis can re-derive arrival times
// under any timing convention and estimator.
//
//   node scripts/capture_iq.mjs [region] [maxRx] [hours] > captures/xx.jsonl 2> captures/xx.log

import { decode as dscDecode } from "../worker/src/dsc.js";

const GW = "https://skywave-gateway.louis-6bf.workers.dev";
const [region = "english-channel", maxRx = 14, hours = 4, bands = "MF"] = process.argv.slice(2);
const DIAL_OFF_KHZ = 1.7, RING_SEC = 15, DECODE_EVERY = 3000, WIN_SEC = 10;
const SNIP_BEFORE = 0.5, SNIP_AFTER = 3.5;

const b64f32 = (f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`);

async function resolveEndpoint(host, port) {
  if (!/\.proxy\.kiwisdr\.com$/i.test(host)) return { host, port };
  try {
    const r = await fetch(`http://${host}:${port}/`, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    const u = new URL(r.url);
    return { host: u.hostname, port: +(u.port || 80) };
  } catch { return { host, port }; }
}

class Rx {
  constructor(slot) {
    this.slot = slot;
    this.id = `${slot.host}:${slot.port}`;
    this.sr = 12000;
    this.iRing = null;   // preallocated at first frame; in-place ring
    this.qRing = null;
    this.used = 0;
    this.total = 0;
    this.anchors = [];        // fresh gps solutions {abs, sec, nsec}
    this.allAnchors = [];     // kept for clock-discipline stats
    this.lastKey = "";
    this.lastDecode = 0;
    this.sigs = new Map();
    this.closed = false;
    this.frames = 0;
  }

  async connect() {
    if (this.closed) return;
    const { host, port } = await resolveEndpoint(this.slot.host, this.slot.port);
    const ws = new WebSocket(`ws://${host}:${port}/${Math.floor(Date.now() / 1000)}/SND`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    const send = (m) => { try { ws.send(m); } catch {} };
    ws.onopen = () => {
      send("SET auth t=kiwi p=");
      send("SET ident_user=skywave-groundtruth");
      this.ka = setInterval(() => send("SET keepalive"), 5000);
    };
    ws.onmessage = (ev) => this._msg(ev.data, send);
    // a failed socket fires BOTH error and close — without the guard
    // each cycle doubles the pending reconnects (exponential leak, OOM)
    ws.onclose = ws.onerror = () => {
      clearInterval(this.ka);
      try { ws.close(); } catch {}
      if (this.closed || this.retrying) return;
      this.retrying = true;
      setTimeout(() => { this.retrying = false; this.connect(); }, 30000 + Math.random() * 30000);
    };
  }

  _msg(data, send) {
    if (typeof data === "string") return;
    const u8 = new Uint8Array(data);
    if (u8.length < 4) return;
    const tag = String.fromCharCode(u8[0], u8[1], u8[2]);
    if (tag === "MSG") {
      const body = new TextDecoder().decode(u8.subarray(4));
      if (body.includes("too_busy") || body.includes("down=")) { log(`${this.id} busy/down`); this.ws.close(); return; }
      const ar = /audio_rate=(\S+)/.exec(body);
      if (ar) send(`SET AR OK in=${ar[1]} out=44100`);
      const srm = /sample_rate=(\S+)/.exec(body);
      if (srm) {
        this.sr = parseFloat(srm[1]);
        send("SET squelch=0 max=0");
        send(`SET mod=iq low_cut=300 high_cut=3000 freq=${(this.slot.bandKHz - DIAL_OFF_KHZ).toFixed(3)}`);
        send("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50");
        send("SET compression=0");
        log(`${this.id} live sr=${this.sr}`);
      }
      return;
    }
    if (tag !== "SND") return;
    const body = u8.subarray(3);
    if (body.length < 17) return;
    const flags = body[0];
    if (flags & 0x10 || !(flags & 0x08)) return;
    const fresh = body[7] === 0;
    const sec = body[9] | (body[10] << 8) | (body[11] << 16) | (body[12] << 24);
    const nsec = body[13] | (body[14] << 8) | (body[15] << 16) | (body[16] << 24);
    const iq = body.subarray(17);
    const n = iq.length >> 2;
    const abs = this.total;
    this.total += n;
    this.frames++;
    const key = `${sec}.${nsec}`;
    if ((fresh || key !== this.lastKey) && (sec || nsec)) {
      const a = { abs, sec: sec >>> 0, nsec: nsec >>> 0 };
      this.anchors.push(a);
      this.allAnchors.push(a);
      const keepFrom = this.total - Math.floor(this.sr * (RING_SEC + 2));
      while (this.anchors.length > 2 && this.anchors[1].abs <= keepFrom) this.anchors.shift();
      if (this.allAnchors.length > 5000) this.allAnchors.splice(0, 2500);
    }
    this.lastKey = key;
    const iNew = new Float32Array(n), qNew = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let i16 = (iq[k * 4] << 8) | iq[k * 4 + 1];
      if (i16 & 0x8000) i16 |= ~0xFFFF;
      let q16 = (iq[k * 4 + 2] << 8) | iq[k * 4 + 3];
      if (q16 & 0x8000) q16 |= ~0xFFFF;
      iNew[k] = i16 / 32768;
      qNew[k] = q16 / 32768;
    }
    const max = Math.floor(this.sr * RING_SEC);
    if (!this.iRing || this.iRing.length !== max) { this.iRing = new Float32Array(max); this.qRing = new Float32Array(max); this.used = 0; }
    if (this.used + n > max) {
      const shift = this.used + n - max;
      this.iRing.copyWithin(0, shift, this.used);
      this.qRing.copyWithin(0, shift, this.used);
      this.used -= shift;
    }
    this.iRing.set(iNew, this.used);
    this.qRing.set(qNew, this.used);
    this.used += n;
    const now = Date.now();
    if (now - this.lastDecode > DECODE_EVERY && this.used >= this.sr * WIN_SEC) {
      this.lastDecode = now;
      this._decode();
    }
  }

  _decode() {
    const sr = this.sr;
    const winLen = Math.floor(sr * WIN_SEC);
    const off = Math.max(0, this.used - winLen);
    const view = this.iRing.subarray(off, this.used);
    let g = 0;
    for (let i = 0; i < view.length; i += 64) g += view[i] * view[i];
    if (Math.sqrt(g * 64 / view.length) < 0.005) return;
    let call;
    try { call = dscDecode(view, sr, {}); } catch { return; }
    if (!call) return;
    const sig = [call.formatCode, call.destination, call.caller, call.tc1Code, call.tc2Code, call.eos].join("|");
    const now = Date.now();
    if (now - (this.sigs.get(sig) || 0) < 60000) return;
    this.sigs.set(sig, now);
    for (const [k, t] of this.sigs) if (now - t > 120000) this.sigs.delete(k);

    const absStart = this.total - this.used + off + (call.startSample | 0);
    const snipAbs = absStart - Math.floor(SNIP_BEFORE * sr);
    const len = Math.floor((SNIP_BEFORE + SNIP_AFTER) * sr);
    const head = this.total - this.used;
    const from = Math.max(snipAbs, head), to = Math.min(snipAbs + len, head + this.used);
    if (to <= from) return;
    const iSnip = new Float32Array(len), qSnip = new Float32Array(len);
    iSnip.set(this.iRing.subarray(from - head, to - head), from - snipAbs);
    qSnip.set(this.qRing.subarray(from - head, to - head), from - snipAbs);
    // every anchor within ±8 s of the snippet start, absolute-indexed —
    // offline analysis picks its own anchoring convention.
    const near = this.allAnchors.filter((a) => Math.abs(a.abs - snipAbs) < sr * 8);
    out({
      t: "det", wallMs: now, host: this.id, label: this.slot.label,
      gps: this.slot.gps, band: this.slot.band, sr, snipAbs, absStart, len,
      call: {
        caller: call.caller, destination: call.destination, formatCode: call.formatCode,
        categoryCode: call.categoryCode, eos: call.eos, phasingScore: call.phasingScore,
        badSymbols: call.badSymbols, markHz: call.markHz, spaceHz: call.spaceHz,
      },
      anchors: near, i: b64f32(iSnip), q: b64f32(qSnip),
    });
    log(`${this.id} DECODE ${call.caller} → ${call.destination ?? "-"} score=${call.phasingScore} bad=${call.badSymbols}`);
  }

  stats() {
    // clock discipline: fit sec+nsec vs abs over retained anchors
    const a = this.allAnchors;
    if (a.length < 10) return { id: this.id, frames: this.frames, anchors: a.length };
    const t0 = a[0].sec + a[0].nsec / 1e9;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of a) {
      const x = p.abs - a[0].abs, y = p.sec + p.nsec / 1e9 - t0;
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const nA = a.length;
    const slope = (nA * sxy - sx * sy) / (nA * sxx - sx * sx);  // s per sample
    let rss = 0;
    const icpt = (sy - slope * sx) / nA;
    for (const p of a) {
      const x = p.abs - a[0].abs, y = p.sec + p.nsec / 1e9 - t0;
      const e = y - (slope * x + icpt);
      rss += e * e;
    }
    return {
      id: this.id, frames: this.frames, anchors: nA,
      srFit: +(1 / slope).toFixed(3), srParam: this.sr,
      anchorRmsUs: +(Math.sqrt(rss / nA) * 1e6).toFixed(1),
    };
  }
}


const rackResp = await (await fetch(`${GW}/v2/rack?region=${region}`)).json();
const rack = Array.isArray(rackResp) ? rackResp : rackResp.rack ?? rackResp.slots;
const wanted = new Set(bands.split(","));
const slots = rack.filter((s) => wanted.has("all") || wanted.has(s.band)).slice(0, +maxRx);
log(`capturing ${slots.length} receivers (${bands}) in ${region} for ${hours} h`);
out({ t: "meta", startMs: Date.now(), region, hours: +hours, slots: slots.map((s) => ({ host: `${s.host}:${s.port}`, band: s.band, label: s.label, gps: s.gps })) });
const rxs = slots.map((s) => new Rx(s));
for (const r of rxs) r.connect().catch((e) => log(`${r.id} connect err ${e}`));

const statTimer = setInterval(() => { for (const r of rxs) out({ t: "stats", wallMs: Date.now(), ...r.stats() }); }, 300000);
setTimeout(() => {
  clearInterval(statTimer);
  for (const r of rxs) { r.closed = true; try { r.ws?.close(); } catch {} }
  for (const r of rxs) out({ t: "stats", wallMs: Date.now(), ...r.stats() });
  log("capture complete");
  setTimeout(() => process.exit(0), 2000);
}, +hours * 3600 * 1000);
