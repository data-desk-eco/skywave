/* Skywave — browser-native KiwiSDR DSC monitor.
 * Vanilla JS. No build step. Three sections:
 *   1. DSC decoder (port of ~/Research/dsc-triangulation/scripts/dsc_decode_ddesk.py)
 *   2. KiwiSDR WebSocket audio client
 *   3. UI / app orchestration
 * See PLAN.md and CLAUDE.md in this directory for context.
 */
"use strict";

// ========================================================================
// 1. DSC decoder
// ========================================================================
//
// ITU-R M.493 maritime DSC at 100 baud FSK (mark 1615 Hz / space 1785 Hz
// on the audio after USB demod of a 2187.5 kHz channel with dial 2185.8).
// Phasing: DX symbol 125 at even byte positions, RX counter 111..104
// descending at odd. Symbols are 10-bit LSB-first on the wire (7 info bits
// then 3 check bits MSB-first).

const DSC = (() => {
  const BAUD = 100;
  const MARK = 1615.0;
  const SPACE = 1785.0;
  const DX_SYM = 125;
  const RX_COUNTERS = [111, 110, 109, 108, 107, 106, 105, 104];

  const FORMATS = {
    102: "geographic area call",
    112: "distress alert",
    114: "group call",
    116: "all ships",
    120: "selective call",
    123: "automatic service",
  };
  const CATEGORIES = {
    100: "routine",
    108: "safety",
    110: "urgency",
    112: "distress",
  };
  const TELECOMMANDS = {
    100: "F3E/G3E all modes",
    101: "F3E/G3E duplex",
    103: "polling",
    104: "unable to comply",
    105: "end of call",
    106: "data",
    109: "J3E TP",
    110: "distress ack",
    112: "distress relay",
    118: "test",
    121: "ship position",
    126: "no information",
  };
  const DISTRESS_NATURES = {
    100: "fire / explosion",
    101: "flooding",
    102: "collision",
    103: "grounding",
    104: "capsizing",
    105: "sinking",
    106: "disabled & adrift",
    107: "undesignated",
    108: "abandoning ship",
    109: "piracy",
    110: "man overboard",
    112: "EPIRB emission",
  };
  const EOS_SYMBOLS = { 117: "REQ", 122: "ACK", 127: "EOS" };

  // -- Non-coherent I/Q FSK demod ----------------------------------------
  // Per bit window: correlate samples against cos/sin of mark and space;
  // bit = 1 iff mark power > space power.
  function fskDemod(samples, sr, mark, space) {
    const spb = Math.floor(sr / BAUD);
    if (spb < 4) throw new Error(`sr ${sr} too low for ${BAUD} baud`);
    const nb = Math.floor(samples.length / spb);
    const bits = new Uint8Array(nb);
    const mc = new Float32Array(spb), ms = new Float32Array(spb);
    const sc = new Float32Array(spb), ss = new Float32Array(spb);
    const w = 2 * Math.PI / sr;
    for (let i = 0; i < spb; i++) {
      mc[i] = Math.cos(w * mark * i);
      ms[i] = Math.sin(w * mark * i);
      sc[i] = Math.cos(w * space * i);
      ss[i] = Math.sin(w * space * i);
    }
    for (let b = 0; b < nb; b++) {
      let mcs = 0, mss = 0, scs = 0, sss = 0;
      const off = b * spb;
      for (let i = 0; i < spb; i++) {
        const s = samples[off + i];
        mcs += s * mc[i]; mss += s * ms[i];
        scs += s * sc[i]; sss += s * ss[i];
      }
      bits[b] = (mcs * mcs + mss * mss > scs * scs + sss * sss) ? 1 : 0;
    }
    return bits;
  }

  // -- Bit → symbol (10-bit LSB-first wire order) ------------------------
  function packLSB(bits, start) {
    let s = 0;
    for (let j = 0; j < 10; j++) s |= bits[start + j] << j;
    return s;
  }

  // Returns [info7bit, hasCheckError]. Check bits are the count of zeros in
  // the info field, transmitted MSB-first — so when we pack LSB-first the
  // top 3 bits of `packed` need re-ordering to recover the expected count.
  function decode10(packed) {
    const info = packed & 0x7F;
    const b7 = (packed >> 7) & 1;
    const b8 = (packed >> 8) & 1;
    const b9 = (packed >> 9) & 1;
    const check = (b7 << 2) | (b8 << 1) | b9;
    let ones = 0;
    for (let k = 0; k < 7; k++) if (info & (1 << k)) ones++;
    const expected = 7 - ones;
    return [info, check !== expected];
  }

  // -- Phasing search ----------------------------------------------------
  // Scan every bit offset; score the first 16 candidate bytes against the
  // interleaved DX/RX pattern. Lowest score wins. Fewer than ~5 mismatches
  // in 15 checks = a lock.
  function scorePhasing(bytes_) {
    if (bytes_.length < 15) return 999;
    let score = 0;
    for (let i = 0; i < 7; i++) if (bytes_[i * 2] !== DX_SYM) score++;
    for (let i = 0; i < 8; i++) if (bytes_[i * 2 + 1] !== RX_COUNTERS[i]) score++;
    return score;
  }

  function findPhasing(bits, maxScore = 2) {
    let bestStart = -1, bestScore = maxScore + 1;
    const maxStart = bits.length - 160;
    const bytes_ = new Array(16);
    for (let start = 0; start < maxStart; start++) {
      for (let k = 0; k < 16; k++) {
        bytes_[k] = decode10(packLSB(bits, start + k * 10))[0];
      }
      const s = scorePhasing(bytes_);
      if (s < bestScore) { bestStart = start; bestScore = s; }
      if (s === 0) break;
    }
    return { start: bestStart, score: bestScore };
  }

  // -- Deinterleave (5-symbol time diversity) ----------------------------
  // Every other byte is DX (primary), the rest is RX (5-symbol-delayed
  // repeat). The real message starts at DX[6]; on a check failure we sub
  // in the RX copy offset by 2. See TAOSW.GMDSSDecoderHelper.
  function bitsToBytes(bits, start) {
    const out = [];
    for (let i = start; i + 10 <= bits.length; i += 10) {
      const [info, err] = decode10(packLSB(bits, i));
      out.push(err ? -1 : info);
    }
    return out;
  }

  function deinterleave(bytes_) {
    const dx = [], rx = [];
    for (let i = 0; i < bytes_.length; i++) (i % 2 === 0 ? dx : rx).push(bytes_[i]);
    const syms = [];
    for (let c = 6; c < dx.length; c++) {
      if (dx[c] !== -1) syms.push(dx[c]);
      else if (rx.length > c + 2) syms.push(rx[c + 2]);
      else syms.push(-1);
    }
    return syms;
  }

  // -- Call parsing ------------------------------------------------------
  function mmsiFromBCD(symbols5) {
    let s = "";
    for (const sy of symbols5) {
      if (sy >= 0 && sy <= 99) s += sy.toString().padStart(2, "0");
      else s += "??";
    }
    return s.slice(0, 9);
  }

  function parseCall(symbols) {
    if (symbols.length < 13) return null;
    const fmt = symbols[0];
    const fmt2 = symbols[1] != null ? symbols[1] : -1;
    const call = {
      format: FORMATS[fmt] || `unknown(${fmt})`,
      formatCode: fmt,
      destination: null,
      caller: null,
      category: null,
      categoryCode: null,
      tc1: null, tc2: null,
      tc1Code: null, tc2Code: null,
      eos: null,
      ecc_valid: FORMATS[fmt] !== undefined,
      errors: [],
      symbols,
    };
    if (fmt !== fmt2 && fmt2 !== -1) call.errors.push(`format mismatch ${fmt}/${fmt2}`);

    if (fmt === 112) {
      call.caller = mmsiFromBCD(symbols.slice(2, 7));
      call.category = "distress";
      call.categoryCode = 112;
      const nat = symbols[7];
      if (nat != null) {
        call.tc1 = DISTRESS_NATURES[nat] || `nature(${nat})`;
        call.tc1Code = nat;
      }
    } else {
      call.destination = mmsiFromBCD(symbols.slice(2, 7));
      const cat = symbols[7];
      if (cat != null) {
        call.category = CATEGORIES[cat] || `cat(${cat})`;
        call.categoryCode = cat;
      }
      if (symbols.length > 12) call.caller = mmsiFromBCD(symbols.slice(8, 13));
      const t1 = symbols[13], t2 = symbols[14];
      if (t1 != null) { call.tc1 = TELECOMMANDS[t1] || `tc(${t1})`; call.tc1Code = t1; }
      if (t2 != null) { call.tc2 = TELECOMMANDS[t2] || `tc(${t2})`; call.tc2Code = t2; }
    }

    for (let i = symbols.length - 1; i >= 0; i--) {
      if (EOS_SYMBOLS[symbols[i]]) { call.eos = EOS_SYMBOLS[symbols[i]]; break; }
    }
    if (!call.eos) call.eos = "—";

    // Sanity: a caller-MMSI with >2 "??" BCD digits is almost certainly a
    // noise lock rather than a real transmission — reject it outright.
    const badDigits = (s) => (String(s || "").match(/\?/g) || []).length;
    if (badDigits(call.caller) > 2) return null;
    if (call.destination && badDigits(call.destination) > 2) return null;
    return call;
  }

  // -- Top-level pipeline ------------------------------------------------
  // Tries baseline mark/space first; if no clean lock, sweeps ±200 Hz
  // around the expected mark centre. Also tries three sub-bit offsets to
  // handle bit-timing misalignment.
  function decode(samples, sr) {
    const spb = Math.floor(sr / BAUD);
    const subOffsets = [0, (spb / 3) | 0, ((2 * spb) / 3) | 0];
    let best = null;

    const tryTone = (mark, space) => {
      for (const off of subOffsets) {
        const view = samples.subarray(off);
        const bits = fskDemod(view, sr, mark, space);
        const { start, score } = findPhasing(bits, 2);
        if (start < 0) continue;
        if (!best || score < best.score) best = { bits, start, score, mark, space };
      }
    };

    tryTone(MARK, SPACE);
    if (!best || best.score > 2) {
      for (let c = 1500; c <= 1900; c += 10) {
        tryTone(c - 85, c + 85);
        if (best && best.score <= 1) break;
      }
    }
    if (!best) return null;

    const rawBytes = bitsToBytes(best.bits, best.start);
    const dataSyms = deinterleave(rawBytes);

    // Quality gate — a noise lock will produce mostly check-error symbols
    // (which deinterleave() sets to -1). Real DSC bursts usually have <2
    // bad symbols in the first 16. Reject anything >4 (>25%) to keep
    // garbage out of the log.
    const headLen = Math.min(16, dataSyms.length);
    let badSyms = 0;
    for (let i = 0; i < headLen; i++) if (dataSyms[i] === -1) badSyms++;
    if (badSyms > 4 || headLen < 13) return null;

    const call = parseCall(dataSyms);
    if (call) {
      call.markHz = best.mark;
      call.spaceHz = best.space;
      call.phasingScore = best.score;
      call.badSymbols = badSyms;
    }
    return call;
  }

  return { decode, fskDemod, findPhasing, parseCall,
           FORMATS, CATEGORIES, TELECOMMANDS, EOS_SYMBOLS };
})();

// ========================================================================
// 2. KiwiSDR WebSocket audio client
// ========================================================================
//
// Stripped-down port of kiwirecorder.py — enough to pull uncompressed
// 12 kHz PCM audio from a public receiver. We skip the waterfall stream
// (computed client-side from audio) and the IMA ADPCM codec (we force
// compression off for code-size).

class KiwiClient {
  constructor(host, port, opts = {}) {
    this.host = host;
    this.port = port;
    this.dialKHz = opts.dialKHz;            // e.g. 2185.800
    this.lowCut = opts.lowCut || 300;
    this.highCut = opts.highCut || 3000;
    this.onAudio = opts.onAudio || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onMsg = opts.onMsg || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.ws = null;
    this.sampleRate = null;
    this.keepaliveTimer = null;
    this.closed = false;
    this.bytes = 0;
  }

  connect() {
    const ts = Math.floor(Date.now() / 1000);
    const url = `ws://${this.host}:${this.port}/${ts}/SND`;
    this.onStatus(`connecting…`);
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this._onOpen();
    this.ws.onmessage = (e) => this._onMessage(e);
    this.ws.onerror = () => { this.onStatus("error"); };
    this.ws.onclose = () => {
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.closed = true;
      this.onClose();
    };
  }

  close() {
    if (this.ws && this.ws.readyState <= 1) this.ws.close();
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.closed = true;
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(msg);
  }

  _onOpen() {
    this.onStatus("handshaking…");
    this._send("SET auth t=kiwi p=");
    this._send(`SET ident_user=skywave`);
    // keepalive every 5 seconds — server kicks idle clients
    this.keepaliveTimer = setInterval(() => this._send("SET keepalive"), 5000);
  }

  _onMessage(ev) {
    const data = ev.data;
    if (typeof data === "string") return;      // server rarely sends text
    this.bytes += data.byteLength;
    const dv = new DataView(data);
    if (data.byteLength < 3) return;
    const tag = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2));
    if (tag === "MSG") {
      // body is ASCII after a single leading byte (usually space)
      const bytes = new Uint8Array(data, 4);
      const body = new TextDecoder().decode(bytes);
      this._handleMsg(body);
    } else if (tag === "SND") {
      this._handleSnd(new Uint8Array(data, 3));
    }
    // W/F frames: ignored (we derive waterfall from audio)
  }

  _handleMsg(body) {
    // tokens are "key=value" or bare "key"
    const params = {};
    for (const tok of body.split(" ")) {
      if (!tok) continue;
      const eq = tok.indexOf("=");
      if (eq < 0) params[tok] = null;
      else params[tok.slice(0, eq)] = decodeURIComponent(tok.slice(eq + 1));
    }
    this.onMsg(params);

    if ("too_busy" in params) { this.onStatus("server full"); this.close(); return; }
    if ("badp" in params && params.badp !== "0") { this.onStatus("bad password"); this.close(); return; }
    if ("down" in params) { this.onStatus("server down"); this.close(); return; }

    if ("audio_rate" in params) {
      this._send(`SET AR OK in=${params.audio_rate} out=44100`);
    }
    if ("sample_rate" in params) {
      this.sampleRate = parseFloat(params.sample_rate);
      this._send("SET squelch=0 max=0");
      this._send("SET genattn=0");
      this._send("SET gen=0 mix=-1");
      this._send(`SET mod=usb low_cut=${this.lowCut} high_cut=${this.highCut} freq=${this.dialKHz.toFixed(3)}`);
      this._send("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50");
      this._send("SET compression=0");
      this._send("SET keepalive");
      this.onStatus(`live · ${this.sampleRate.toFixed(0)} Hz`);
    }
  }

  _handleSnd(body) {
    // After 3-byte tag: flags(1), seq(u32 LE), smeter(u16 BE), audio
    if (body.length < 7) return;
    const flags = body[0];
    const smeter = (body[5] << 8) | body[6];
    const rssi = 0.1 * smeter - 127;
    const compressed = (flags & 0x10) !== 0;
    if (compressed) {
      // We asked for compression=0 but the first frame or two may still
      // arrive compressed while the setting propagates. Skip them.
      return;
    }
    // 16-bit signed big-endian PCM
    const nb = body.length - 7;
    const count = nb >> 1;
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const hi = body[7 + i * 2];
      const lo = body[7 + i * 2 + 1];
      let s = (hi << 8) | lo;
      if (s & 0x8000) s |= ~0xFFFF;             // sign-extend
      samples[i] = s / 32768;
    }
    this.onAudio(samples, this.sampleRate, rssi);
  }
}

// ========================================================================
// 3. UI / app orchestration  (sixteen-wide fan-out)
// ========================================================================
//
// We open up to 16 concurrent KiwiSDR sessions on different receivers,
// each running its own DSC decoder. One session at a time feeds the
// speakers (click a rack slot to switch). Calls heard on multiple
// receivers collapse into a single log row with an aggregate count.

const FANOUT = 16;
const AUDIO_LEAD_SEC = 0.25;                 // how far ahead of currentTime we schedule

// ITU-R M.493 DSC channels.
const BANDS = [
  { khz:  2187.5, short: "MF"   },
  { khz:  4207.5, short: "HF4"  },
  { khz:  6312.0, short: "HF6"  },
  { khz:  8414.5, short: "HF8"  },
  { khz: 12577.0, short: "HF12" },
  { khz: 16804.5, short: "HF16" },
];
const bandLabelFor = (khz) => (BANDS.find((b) => b.khz === khz) || {}).short || "?";

// Coastal anchors: (lat, lon) of major ports, coast-guard stations and
// busy chokepoints. A receiver's "coastal score" is an inverse-distance
// to the closest anchor — inland KiwiSDRs get deprioritised, sea-adjacent
// ones float to the top.
const COASTAL_ANCHORS = [
  // NE Atlantic / North Sea / Baltic
  [51.1,   1.3], [48.4,  -5.1], [50.4,  -4.1], [53.5,   9.9], [51.9,   4.5],
  [60.4,   5.3], [64.1, -21.9], [57.7,  11.9], [59.3,  18.1], [60.2,  24.9],
  [59.4,  24.8], [54.4,  18.7], [55.7,  12.6], [57.0,  -2.1], [62.0,  -7.0],
  // Mediterranean / Black Sea
  [36.1,  -5.3], [43.3,   5.4], [44.4,   8.9], [37.9,  23.7], [41.0,  29.0],
  [35.9,  14.5], [31.2,  29.9], [32.8,  35.0], [44.5,  33.5],
  // Iberia / W Africa / S Atlantic
  [38.7,  -9.1], [37.7, -25.7], [33.6,  -7.6], [14.7, -17.4], [ 6.5,   3.4],
  [-33.9,  18.4], [-29.9,  31.0], [-22.9, -43.2], [-34.6, -58.4], [-33.0, -71.6],
  // NW Atlantic / Caribbean
  [44.6, -63.6], [42.4, -71.1], [40.7, -74.0], [36.9, -76.3], [25.8, -80.2],
  [29.9, -90.1], [29.7, -95.4], [25.1, -77.3], [18.5, -66.1], [ 9.4, -79.9],
  // Pacific N America
  [47.6, -122.3], [37.8, -122.4], [33.7, -118.2], [49.3, -123.1],
  [21.3, -157.9], [61.2, -149.9],
  // Red Sea / Gulf / Indian Ocean
  [21.5,  39.2], [12.8,  45.0], [11.6,  43.1], [23.6,  58.6], [27.2,  56.3],
  [29.4,  48.0], [19.1,  72.9], [ 6.9,  79.9], [13.1,  80.3],
  // SE / E Asia
  [ 1.3, 103.8], [-6.2, 106.8], [14.6, 121.0], [22.3, 114.2], [31.2, 121.5],
  [35.2, 129.1], [35.7, 139.8], [43.1, 131.9], [13.7, 100.5],
  // Oceania
  [-33.9, 151.2], [-27.5, 153.0], [-31.9, 115.9], [-36.9, 174.8],
  [-41.3, 174.8], [-18.1, 178.4], [-9.5, 147.2],
];

function coastDeg(gps) {
  if (!gps) return 999;
  let min = Infinity;
  for (const [la, lo] of COASTAL_ANCHORS) {
    const dlat = gps[0] - la;
    const dlon = ((gps[1] - lo + 540) % 360) - 180;   // wrap-around longitude
    const d = Math.hypot(dlat, dlon);
    if (d < min) min = d;
  }
  return min;                                          // degrees (~111 km each)
}

const $ = (id) => document.getElementById(id);
const statusEl = $("status"), bandsEl = $("bands"),
      listenBtn = $("listen"), gainIn = $("gain"), muteBtn = $("mute"),
      needle = $("needle"), wfCanvas = $("waterfall"), callsEl = $("calls"),
      emptyEl = $("empty"), byteEl = $("bytecount"), rxCountEl = $("rxcount"),
      rackEl = $("rack");

/** @type {Array<RxSlot>} */
let slots = [];
let audioSlot = null;                        // slot currently driving the speakers
let audioCtx = null, gainNode = null, analyser = null;
let nextStart = 0;
let muted = false;
const receiverList = [];

// Cross-receiver call dedupe: sig → { row, firstSeen, receivers:Set<label> }
const callIndex = new Map();

// -- Receiver list (KiwiSDR community index) ------------------------------
// The endpoint returns a JS file: `var kiwisdr_com = [...];`. Fetch by
// injecting a <script>, which bypasses CORS. Cached for 10 minutes.
function loadReceivers() {
  const cached = localStorage.getItem("skywave.rx");
  const cachedAt = parseInt(localStorage.getItem("skywave.rxAt") || "0", 10);
  if (cached && Date.now() - cachedAt < 10 * 60 * 1000) {
    try { return Promise.resolve(JSON.parse(cached)); } catch (_) {}
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "http://rx.linkfanel.net/kiwisdr_com.js?t=" + Date.now();
    s.onload = () => {
      const list = window.kiwisdr_com || [];
      localStorage.setItem("skywave.rx", JSON.stringify(list));
      localStorage.setItem("skywave.rxAt", String(Date.now()));
      resolve(list);
    };
    s.onerror = () => reject(new Error("failed to fetch receiver list"));
    document.head.appendChild(s);
  });
}

function parseGps(s) {
  if (!s) return null;
  const m = s.match(/\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

function coversBand(rx, khz) {
  if (!rx.bands) return true;
  const hz = khz * 1000;
  for (const range of rx.bands.split(",")) {
    const [lo, hi] = range.split("-").map(Number);
    if (hz >= lo && hz <= hi) return true;
  }
  return false;
}

// Rank every receiver that covers `khz`, scored by a mix of free slots
// and coastal proximity — sea-adjacent sites hear far more maritime
// DSC traffic than inland ones.
function rankCandidates(khz) {
  return receiverList
    .filter((r) => r.status === "active" && r.offline !== "yes" && r.url && coversBand(r, khz))
    // proxy.kiwisdr.com hosts 307-redirect on WS handshake, which browsers
    // can't follow — drop them so we don't waste a slot on a known failure
    .filter((r) => !/proxy\.kiwisdr\.com/i.test(r.url))
    .map((r) => {
      const users = parseInt(r.users, 10) || 0;
      const maxU = parseInt(r.users_max, 10) || 0;
      const free = Math.max(0, maxU - users);
      const gps = parseGps(r.gps);
      if (!gps || free <= 0) return null;
      const coast = coastDeg(gps);
      // Near-coast (≤1°): strong boost. Far-inland (≥12°): de-boosted.
      const coastBoost = Math.max(0.25, 3 / (coast + 0.5));
      return { r, gps, free, maxU, coast, score: free * coastBoost };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

// Distribute `n` slots across the given bands, picking different receivers
// per band where possible, with a minimum geographic separation (~2.5°)
// between slots on the same band. Returns an array of
// { r, gps, free, maxU, coast, score, bandKHz }.
function pickReceiversAcrossBands(bandsKHz, n) {
  const k = bandsKHz.length;
  if (!k) return [];
  // Even split: first `extra` bands get an extra slot.
  const base = Math.floor(n / k);
  const extra = n - base * k;
  const quota = bandsKHz.map((_, i) => base + (i < extra ? 1 : 0));

  const pools = bandsKHz.map((khz) => rankCandidates(khz));
  const picks = [];
  const usedHosts = new Set();
  const MIN_SEP = 2.5;

  // Round-robin: take the best unused candidate for each band, respecting
  // same-band geographic separation. Run until every band's quota is met
  // or its pool is exhausted.
  let progress = true;
  while (progress && picks.reduce((a, b) => a + 1, 0) < n) {
    progress = false;
    for (let bi = 0; bi < k; bi++) {
      if (quota[bi] <= 0) continue;
      const pool = pools[bi];
      for (let ci = 0; ci < pool.length; ci++) {
        const c = pool[ci];
        if (!c || usedHosts.has(c.r.url)) continue;
        const sameBandPicks = picks.filter((p) => p.bandKHz === bandsKHz[bi]);
        const tooClose = sameBandPicks.some(
          (p) => Math.hypot(p.gps[0] - c.gps[0], p.gps[1] - c.gps[1]) < MIN_SEP
        );
        if (tooClose) continue;
        usedHosts.add(c.r.url);
        picks.push({ ...c, bandKHz: bandsKHz[bi] });
        pool[ci] = null;
        quota[bi]--;
        progress = true;
        break;
      }
      if (picks.length >= n) break;
    }
  }

  // Top-up ignoring same-host and spread filters if we still have budget
  // (rare — only happens when pools are small or overlapping)
  for (let bi = 0; bi < k && picks.length < n; bi++) {
    for (const c of pools[bi]) {
      if (!c) continue;
      if (picks.length >= n) break;
      if (picks.some((p) => p.r.url === c.r.url && p.bandKHz === bandsKHz[bi])) continue;
      picks.push({ ...c, bandKHz: bandsKHz[bi] });
    }
  }
  return picks.slice(0, n);
}

// -- Rack slot: one receiver + its DSC decoder state ----------------------
class RxSlot {
  constructor(meta, idx) {
    this.idx = idx;
    this.rx = meta.r;                        // raw receiver record
    this.gps = meta.gps;
    this.bandKHz = meta.bandKHz;
    this.bandLabel = bandLabelFor(this.bandKHz);
    this.label = (meta.r.loc || "").slice(0, 34) || meta.r.name || "unknown";
    this.url = new URL(meta.r.url);
    this.host = this.url.hostname;
    this.port = parseInt(this.url.port || "8073", 10);
    this.client = null;
    this.state = "idle";                     // idle | connecting | live | err | dead
    this.rssi = -127;
    this.buffer = new Float32Array(0);
    this.sr = 12000;
    this.lastRun = 0;
    this.signatures = new Map();
    this.el = null;
    this.bar = null;
    this.dotEl = null;
    this.metaEl = null;
  }

  mount(rackEl) {
    this.el = document.createElement("div");
    this.el.className = "rx";
    this.el.innerHTML = `
      <span class="dot"></span>
      <span class="loc"><span class="band">${this.bandLabel}</span>${escapeHtml(this.label)}</span>
      <span class="meta">—</span>
      <span class="bar"></span>
    `;
    this.dotEl = this.el.querySelector(".dot");
    this.metaEl = this.el.querySelector(".meta");
    this.bar = this.el.querySelector(".bar");
    this.el.title = `${this.label} · ${this.bandLabel} ${this.bandKHz} kHz · ${this.host}:${this.port}\nclick to route to speakers`;
    this.el.addEventListener("click", () => setAudioSlot(this));
    rackEl.appendChild(this.el);
  }

  setState(s) {
    this.state = s;
    this.el.classList.remove("idle", "connecting", "live", "err", "dead", "audio");
    this.el.classList.add(s);
    if (audioSlot === this) this.el.classList.add("audio");
    updateRxCount();
  }

  setMeta(s) { if (this.metaEl) this.metaEl.textContent = s; }

  connect() {
    this.setState("connecting");
    this.setMeta("connecting…");
    this.client = new KiwiClient(this.host, this.port, {
      dialKHz: this.bandKHz - 1.7,
      lowCut: 300,
      highCut: 3000,
      onAudio: (samples, sr, rssi) => this._onAudio(samples, sr, rssi),
      onStatus: (s) => {
        if (/^live/.test(s)) {
          this.setState("live"); this.setMeta("live");
          if (!audioSlot) setAudioSlot(this);    // first live claims the speakers
        }
        else if (/error|down|busy|bad/.test(s)) { this.setState("err"); this.setMeta(s); }
      },
      onClose: () => {
        if (this.state !== "err") this.setState("dead");
        if (this.state === "err" || this.state === "dead") this.setMeta(this.state);
        if (audioSlot === this) {
          audioSlot = null;
          // hand audio to the next live slot, if any
          const next = slots.find((s) => s.state === "live");
          if (next) setAudioSlot(next);
        }
      },
    });
    this.client.connect();
  }

  close() { if (this.client) this.client.close(); }

  _onAudio(samples, sr, rssi) {
    this.rssi = rssi;
    this.sr = sr;
    // per-slot RSSI bar (needle in the slot)
    const pct = Math.min(1, Math.max(0, (rssi + 127) / 100));
    this.bar.style.transform = `scaleX(${pct.toFixed(3)})`;
    this.setMeta(`${rssi.toFixed(0)} dB`);

    // route to speakers iff this slot is the chosen one
    if (audioSlot === this && !muted) playSamples(samples, sr);

    // feed own decoder
    this._pushDecoder(samples, sr);
  }

  _pushDecoder(samples, sr) {
    const maxLen = Math.floor(sr * 15);      // 15-sec ring
    if (this.buffer.length + samples.length <= maxLen) {
      const merged = new Float32Array(this.buffer.length + samples.length);
      merged.set(this.buffer);
      merged.set(samples, this.buffer.length);
      this.buffer = merged;
    } else {
      const keep = maxLen - samples.length;
      const merged = new Float32Array(maxLen);
      merged.set(this.buffer.subarray(this.buffer.length - keep));
      merged.set(samples, keep);
      this.buffer = merged;
    }
    const now = performance.now();
    // 3-sec attempts, staggered per-slot so 16 decoders don't pile up
    const staggerOffset = (this.idx * 3000 / FANOUT);
    if (now - this.lastRun > 3000 + staggerOffset * 0 &&
        this.buffer.length >= sr * 10) {
      this.lastRun = now;
      setTimeout(() => this._runDecoder(), 0);
    }
  }

  _runDecoder() {
    const windowSamples = Math.floor(this.sr * 10);
    const view = this.buffer.subarray(Math.max(0, this.buffer.length - windowSamples));
    // RMS gate — cheap skip for silence
    let rms = 0;
    for (let i = 0; i < view.length; i += 64) rms += view[i] * view[i];
    rms = Math.sqrt(rms * 64 / view.length);
    if (rms < 0.005) return;

    let call;
    try { call = DSC.decode(view, this.sr); } catch (e) { return; }
    if (!call) return;

    // per-slot dedupe so one burst seen across the decode window doesn't
    // report twice from the same receiver
    const sig = [call.formatCode, call.destination, call.caller, call.tc1Code, call.tc2Code, call.eos].join("|");
    const prev = this.signatures.get(sig) || 0;
    const now = Date.now();
    if (now - prev < 60000) return;
    this.signatures.set(sig, now);
    for (const [k, t] of this.signatures) if (now - t > 120000) this.signatures.delete(k);

    dispatchCall(call, this);
  }
}

// -- Cross-receiver dedupe & rendering ------------------------------------
// Same MMSI + tc heard within 2 min collapses into one row tagged with
// count of reporting receivers and the bands they reported on.
function dispatchCall(call, slot) {
  const sig = [call.formatCode, call.destination, call.caller, call.tc1Code, call.tc2Code, call.eos].join("|");
  const now = Date.now();
  const existing = callIndex.get(sig);
  if (existing && now - existing.firstSeen < 120000) {
    existing.receivers.set(slot.label, slot.bandLabel);
    updateHeard(existing);
    return;
  }
  const entry = {
    firstSeen: now,
    receivers: new Map([[slot.label, slot.bandLabel]]),
    primaryBand: slot.bandLabel,
    row: null, call,
  };
  callIndex.set(sig, entry);
  entry.row = addCallRow(call, entry);
  for (const [k, v] of callIndex) if (now - v.firstSeen > 600000) callIndex.delete(k);
}

function updateHeard(entry) {
  const n = entry.receivers.size;
  const bands = new Set(entry.receivers.values());
  const heardEl = entry.row.querySelector(".heard");
  if (heardEl) heardEl.textContent = `${n} RX · ${Array.from(bands).join("/")}`;
  const list = entry.row.querySelector(".heard-list");
  if (list) list.innerHTML = "heard by: " + Array.from(entry.receivers).map(
    ([rx, band]) => `<span>${escapeHtml(rx)}</span> <em>${band}</em>`
  ).join(", ");
}

// -- Audio output ---------------------------------------------------------
function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  gainNode = audioCtx.createGain();
  gainNode.gain.value = (parseFloat(gainIn.value) / 100) * (muted ? 0 : 1);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.15;
  gainNode.connect(analyser);
  analyser.connect(audioCtx.destination);
  nextStart = audioCtx.currentTime + AUDIO_LEAD_SEC;
  drawWaterfall();
}

function playSamples(samples, sr) {
  if (!audioCtx) return;
  const buf = audioCtx.createBuffer(1, samples.length, sr);
  buf.copyToChannel(samples, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(gainNode);
  const start = Math.max(nextStart, audioCtx.currentTime + 0.02);
  src.start(start);
  nextStart = start + samples.length / sr;
  if (nextStart < audioCtx.currentTime - 0.5) nextStart = audioCtx.currentTime + AUDIO_LEAD_SEC;
}

function setAudioSlot(slot) {
  if (audioSlot === slot) return;
  const prev = audioSlot;
  audioSlot = slot;
  nextStart = audioCtx ? audioCtx.currentTime + AUDIO_LEAD_SEC : 0;
  for (const s of slots) s.el && s.el.classList.remove("audio");
  if (slot && slot.el) slot.el.classList.add("audio");
}

// -- Waterfall + footer S-meter -------------------------------------------
function drawWaterfall() {
  const ctx = wfCanvas.getContext("2d");
  const w = wfCanvas.width, h = wfCanvas.height;
  const img = ctx.createImageData(w, 1);
  const bins = new Uint8Array(analyser.frequencyBinCount);

  function step() {
    if (!audioCtx) { requestAnimationFrame(step); return; }
    ctx.drawImage(wfCanvas, 0, 0, w, h - 1, 0, 1, w, h - 1);
    analyser.getByteFrequencyData(bins);
    const nyquist = audioCtx.sampleRate / 2;
    const maxBin = Math.min(bins.length - 1, Math.floor(bins.length * 3000 / nyquist));
    for (let x = 0; x < w; x++) {
      const v = bins[Math.floor(x / w * maxBin)];
      const i = x * 4;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    const rssi = audioSlot ? audioSlot.rssi : -127;
    needle.style.width = Math.min(100, Math.max(0, (rssi + 127))).toFixed(0) + "%";

    byteEl.textContent = formatBytes(slots.reduce((n, s) => n + (s.client ? s.client.bytes : 0), 0));
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function updateRxCount() {
  const live = slots.filter((s) => s.state === "live").length;
  rxCountEl.textContent = `${live} / ${slots.length} live`;
  const any = slots.some((s) => s.state === "live" || s.state === "connecting");
  statusEl.textContent = any ? `live · ${live}/${slots.length}` : "idle";
  statusEl.className = any ? "live" : "";
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// -- Call row -------------------------------------------------------------
const flagEmoji = (mmsi) => {
  const mid = parseInt((mmsi || "").slice(0, 3), 10);
  if (!mid) return "";
  const code = MID_TO_ISO[mid];
  if (!code || code.length !== 2) return "";
  const a = 127397;
  return String.fromCodePoint(code.charCodeAt(0) + a, code.charCodeAt(1) + a);
};

function addCallRow(call, entry) {
  emptyEl.style.display = "none";
  const row = document.createElement("div");
  row.className = "call";
  if (call.categoryCode === 112) row.classList.add("distress");
  else if (call.categoryCode === 110) row.classList.add("urgency");
  else if (call.categoryCode === 108) row.classList.add("safety");

  const t = new Date();
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  const ss = String(t.getUTCSeconds()).padStart(2, "0");
  const callerMmsi = call.caller || "—";
  const destMmsi = call.destination || (call.formatCode === 112 ? "all ships" : "—");

  row.innerHTML = `
    <span class="t">${hh}:${mm}:${ss}Z</span>
    <span class="who">
      <span class="flag">${flagEmoji(callerMmsi)}</span><span class="name" data-mmsi="${callerMmsi}">MMSI ${callerMmsi}</span>
      <span class="mmsi">${callerMmsi}</span>
    </span>
    <span class="flow">→ ${escapeHtml(destMmsi)}</span>
    <span class="payload">${escapeHtml(call.category || "?")} · ${escapeHtml(call.tc1 || "?")}${call.tc2 && call.tc2 !== call.tc1 ? " · " + escapeHtml(call.tc2) : ""} · ${escapeHtml(call.eos)}</span>
    <span class="heard">${entry.receivers.size} RX · ${entry.primaryBand}</span>
    <div class="call-detail">
      <div class="kv">
        <span>format</span><span>${escapeHtml(call.format)} (${call.formatCode})</span>
        <span>category</span><span>${escapeHtml(call.category || "?")}</span>
        <span>telecommand 1</span><span>${escapeHtml(call.tc1 || "?")}</span>
        <span>telecommand 2</span><span>${escapeHtml(call.tc2 || "?")}</span>
        <span>EOS</span><span>${escapeHtml(call.eos)}</span>
        <span>ECC</span><span>${call.ecc_valid ? "ok" : "—"}</span>
        <span>mark / space</span><span>${call.markHz.toFixed(0)} / ${call.spaceHz.toFixed(0)} Hz</span>
        <span>phasing score</span><span>${call.phasingScore}</span>
      </div>
      <div class="heard-list">heard by: ${Array.from(entry.receivers).map(([rx, band]) => `<span>${escapeHtml(rx)}</span> <em>${band}</em>`).join(", ")}</div>
      <code>${call.symbols.map((s) => s < 0 ? "?" : s).join(" ")}</code>
    </div>
  `;
  row.addEventListener("click", () => row.classList.toggle("open"));
  callsEl.prepend(row);
  while (callsEl.children.length > 200) callsEl.lastChild.remove();

  if (callerMmsi && /^\d{9}$/.test(callerMmsi)) resolveVessel(callerMmsi, row);
  if (destMmsi && /^\d{9}$/.test(destMmsi)) resolveVessel(destMmsi, row);
  return row;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// -- GFW AIS enrichment ---------------------------------------------------
const vesselCache = new Map();
function resolveVessel(mmsi) {
  const key = localStorage.getItem("skywave.gfwKey");
  if (!key) return;
  if (vesselCache.has(mmsi)) { applyVessel(mmsi, vesselCache.get(mmsi)); return; }
  vesselCache.set(mmsi, null);
  const url = `https://gateway.api.globalfishingwatch.org/v3/vessels/search?query=${mmsi}&datasets[0]=public-global-vessel-identity:latest`;
  fetch(url, { headers: { Authorization: `Bearer ${key}` } })
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      const entry = (data && data.entries && data.entries[0]) || null;
      const info = entry ? {
        name: (entry.registryInfo && entry.registryInfo[0] && entry.registryInfo[0].shipname) || entry.shipname || null,
        flag: entry.flag || (entry.registryInfo && entry.registryInfo[0] && entry.registryInfo[0].flag) || null,
        type: entry.shiptypes && entry.shiptypes[0] || null,
      } : null;
      vesselCache.set(mmsi, info);
      applyVessel(mmsi, info);
    })
    .catch(() => {});
}

function applyVessel(mmsi, info) {
  if (!info) return;
  for (const el of document.querySelectorAll(`.name[data-mmsi="${mmsi}"]`)) {
    el.textContent = info.name || `MMSI ${mmsi}`;
    if (info.type) el.title = info.type;
  }
}

// -- Start / stop the rack ------------------------------------------------
function enabledBands() {
  return Array.from(bandsEl.querySelectorAll("input:checked")).map(
    (el) => parseFloat(el.value)
  );
}

function start() {
  ensureAudio();
  if (audioCtx.state === "suspended") audioCtx.resume();

  const bands = enabledBands();
  if (!bands.length) {
    statusEl.textContent = "enable at least one channel";
    statusEl.className = "err";
    return;
  }
  const picks = pickReceiversAcrossBands(bands, FANOUT);
  if (!picks.length) {
    statusEl.textContent = "no receivers available";
    statusEl.className = "err";
    return;
  }

  rackEl.innerHTML = "";
  slots = picks.map((p, i) => {
    const s = new RxSlot(p, i);
    s.mount(rackEl);
    s.setState("idle");
    return s;
  });
  callIndex.clear();

  // stagger connect to avoid a 16-way simultaneous handshake burst
  slots.forEach((s, i) => setTimeout(() => s.connect(), i * 120));

  listenBtn.textContent = "■ Stop";
  listenBtn.classList.add("stop");
  updateRxCount();
}

function stop() {
  for (const s of slots) s.close();
  slots = [];
  audioSlot = null;
  rackEl.innerHTML = "";
  listenBtn.textContent = "▶ Listen · 16 RX";
  listenBtn.classList.remove("stop");
  updateRxCount();
}

// Render 16 placeholder slots before any connection — makes the layout
// stable on first paint and hints at what Listen does.
function paintEmptyRack() {
  rackEl.innerHTML = "";
  for (let i = 0; i < FANOUT; i++) {
    const d = document.createElement("div");
    d.className = "rx idle";
    d.innerHTML = `<span class="dot"></span><span class="loc">—</span><span class="meta">offline</span><span class="bar"></span>`;
    rackEl.appendChild(d);
  }
}

// -- Wire everything ------------------------------------------------------
listenBtn.addEventListener("click", () => slots.length ? stop() : start());
bandsEl.addEventListener("change", () => { if (slots.length) { stop(); setTimeout(start, 200); } });
gainIn.addEventListener("input", () => {
  if (gainNode) gainNode.gain.value = (parseFloat(gainIn.value) / 100) * (muted ? 0 : 1);
});
muteBtn.addEventListener("click", () => {
  muted = !muted;
  muteBtn.textContent = muted ? "🔇" : "🔊";
  if (gainNode) gainNode.gain.value = muted ? 0 : (parseFloat(gainIn.value) / 100);
});

const gfwDialog = $("gfw-dialog"), gfwInput = $("gfw-input"), gfwLink = $("gfw-link"), gfwSave = $("gfw-save");
gfwLink.addEventListener("click", (e) => {
  e.preventDefault();
  gfwInput.value = localStorage.getItem("skywave.gfwKey") || "";
  gfwDialog.showModal();
});
gfwSave.addEventListener("click", () => {
  const v = gfwInput.value.trim();
  if (v) localStorage.setItem("skywave.gfwKey", v);
  else localStorage.removeItem("skywave.gfwKey");
});

// Bootstrap
(async function init() {
  paintEmptyRack();
  statusEl.textContent = "loading receivers…";
  try {
    const list = await loadReceivers();
    receiverList.push(...list);
    statusEl.textContent = `${receiverList.length} receivers indexed`;
  } catch (e) {
    statusEl.textContent = "couldn't load receiver list";
    statusEl.className = "err";
  }
})();

// ========================================================================
// MID (Maritime Identification Digit) → ISO 3166-1 alpha-2
// ========================================================================
// Compact table covering every assigned maritime MID. Source: ITU-R M.585
// (2023). Missing entries fall through to no flag — the MMSI still renders.
const MID_TO_ISO = {
  201:"AL",202:"AD",203:"AT",204:"PT",205:"BE",206:"BY",207:"BG",208:"VA",209:"CY",210:"CY",
  211:"DE",212:"CY",213:"GE",214:"MD",215:"MT",216:"AM",218:"DE",219:"DK",220:"DK",224:"ES",
  225:"ES",226:"FR",227:"FR",228:"FR",229:"MT",230:"FI",231:"FO",232:"GB",233:"GB",234:"GB",
  235:"GB",236:"GI",237:"GR",238:"HR",239:"GR",240:"GR",241:"GR",242:"MA",243:"HU",244:"NL",
  245:"NL",246:"NL",247:"IT",248:"MT",249:"MT",250:"IE",251:"IS",252:"LI",253:"LU",254:"MC",
  255:"PT",256:"MT",257:"NO",258:"NO",259:"NO",261:"PL",262:"ME",263:"PT",264:"RO",265:"SE",
  266:"SE",267:"SK",268:"SM",269:"CH",270:"CZ",271:"TR",272:"UA",273:"RU",274:"MK",275:"LV",
  276:"EE",277:"LT",278:"SI",279:"RS",301:"AI",303:"US",304:"AG",305:"AG",306:"CW",307:"AW",
  308:"BS",309:"BS",310:"BM",311:"BS",312:"BZ",314:"BB",316:"CA",319:"KY",321:"CR",323:"CU",
  325:"DM",327:"DO",329:"GP",330:"GD",331:"GL",332:"GT",334:"HN",336:"HT",338:"US",339:"JM",
  341:"KN",343:"LC",345:"MX",347:"MQ",348:"MS",350:"NI",351:"PA",352:"PA",353:"PA",354:"PA",
  355:"PA",356:"PA",357:"PA",358:"PR",359:"SV",361:"PM",362:"TT",364:"TC",366:"US",367:"US",
  368:"US",369:"US",370:"PA",371:"PA",372:"PA",373:"PA",374:"PA",375:"VC",376:"VC",377:"VC",
  378:"VG",379:"VI",401:"AF",403:"SA",405:"BD",408:"BH",410:"BT",412:"CN",413:"CN",414:"CN",
  416:"TW",417:"LK",419:"IN",422:"IR",423:"AZ",425:"IQ",428:"IL",431:"JP",432:"JP",434:"TM",
  436:"KZ",437:"UZ",438:"JO",440:"KR",441:"KR",443:"PS",445:"KP",447:"KW",450:"LB",451:"KG",
  453:"MO",455:"MV",457:"MN",459:"NP",461:"OM",463:"PK",466:"QA",470:"AE",471:"AE",472:"TJ",
  473:"YE",475:"YE",477:"HK",478:"BA",501:"AQ",503:"AU",506:"MM",508:"BN",510:"FM",511:"PW",
  512:"NZ",514:"KH",515:"KH",516:"CX",518:"CK",520:"FJ",523:"CC",525:"ID",529:"KI",531:"LA",
  533:"MY",536:"MP",538:"MH",540:"NC",542:"NU",544:"NR",546:"PF",548:"PH",550:"TL",553:"PG",
  555:"PN",557:"SB",559:"AS",561:"WS",563:"SG",564:"SG",565:"SG",566:"SG",567:"TH",570:"TO",
  572:"TV",574:"VN",576:"VU",577:"VU",578:"WF",601:"ZA",603:"AO",605:"DZ",607:"TF",608:"GB",
  609:"BI",610:"BJ",611:"BW",612:"CF",613:"CM",615:"CG",616:"KM",617:"CV",618:"TF",619:"CI",
  620:"KM",621:"DJ",622:"EG",624:"ET",625:"ER",626:"GA",627:"GH",629:"GM",630:"GW",631:"GQ",
  632:"GN",633:"BF",634:"KE",635:"TF",636:"LR",637:"LR",638:"SS",642:"LY",644:"LS",645:"MU",
  647:"MG",649:"ML",650:"MZ",654:"MR",655:"MW",656:"NE",657:"NG",659:"NA",660:"RE",661:"RW",
  662:"SD",663:"SN",664:"SC",665:"SH",666:"SO",667:"SL",668:"ST",669:"SZ",670:"TD",671:"TG",
  672:"TN",674:"TZ",675:"UG",676:"CD",677:"TZ",678:"ZM",679:"ZW",701:"AR",710:"BR",720:"BO",
  725:"CL",730:"CO",735:"EC",740:"FK",745:"GF",750:"GY",755:"PY",760:"PE",765:"SR",770:"UY",
  775:"VE",
};
