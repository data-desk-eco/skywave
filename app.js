// Skywave main module. Wires the DSC decoder (`dsc.js`), KiwiSDR
// WebSocket client (`kiwi.js`), GFW vessel lookup (`vessels.js`), and
// per-card mini-maps (`map.js`) into a UI. The heavy lifting lives
// in those modules; this file owns the rack of receivers, audio
// routing, call dedupe and rendering.

import { decode as dscDecode } from "./dsc.js";
import { KiwiClient } from "./kiwi.js";
import { Vessels } from "./vessels.js";
import { initMiniMap, addReceiverToMiniMap, setVesselOnMiniMap } from "./map.js";
import {
  BANDS, bandLabelFor, REGIONS, MAX_FANOUT, REGION_STORAGE_KEY,
  currentRegion, inRegion, coastDeg, parseGps, coversBand, midIso,
} from "./regions.js";

const DEBUG = /(\?|&)debug=1\b/.test(location.search);

// Etiquette: only join receivers with ≥2 free user slots; drop out
// when the receiver fills up. So we never occupy the last slot
// another listener might want.
const MIN_FREE_SLOTS_TO_JOIN = 2;
const RX_LIST_REFRESH_MS = 45_000;
const CONNECT_STAGGER_MS = 60;

// Audio routing: a slot is "active" (route to speakers) only when it
// carries an actual DSC FSK burst. Broadband RMS alone misleads —
// static, voice cross-talk and AGC pumping all peg an S-meter — so
// we also require a large fraction of the chunk energy to sit in
// the two FSK tones (1615/1785 Hz). AUDIO_HOLD_MS keeps routing in
// place briefly after activity ends so the burst's tail isn't cut.
const AUDIO_LEAD_SEC = 0.25;
const AUDIO_ACTIVITY_RMS = 0.010;
const AUDIO_INBAND_RATIO = 0.15;
const AUDIO_HOLD_MS = 6_000;

// ---------------------------------------------------------------------------
// DOM handles & state
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const rxCountEl = $("rxcount"), playingEl = $("playing"),
      callsEl = $("calls"), emptyEl = $("empty"),
      csvBtn = $("csv"), regionEl = $("region");

/** @type {Array<RxSlot>} */
let slots = [];
let audioSlot = null;
let audioCtx = null, destinationGain = null;
let nextStart = 0;
let lastActivityAt = 0;
let watchdogTimer = null;
let connectTimers = [];

const receiverList = [];
const receiversByHost = new Map();
// Cross-receiver dedupe: sig → { firstSeen, receivers, receiverSlots, row, ... }
const callIndex = new Map();

// ---------------------------------------------------------------------------
// Gateway & receiver list
// ---------------------------------------------------------------------------

const GATEWAY = (() => {
  const meta = document.querySelector('meta[name="skywave-gateway"]');
  const url = meta && meta.content.trim();
  if (!url || location.protocol !== "https:") return null;
  return url.replace(/\/+$/, "");
})();

function loadReceivers({ force = false } = {}) {
  if (!force) {
    const cached = localStorage.getItem("skywave.rx");
    const at = parseInt(localStorage.getItem("skywave.rxAt") || "0", 10);
    if (cached && Date.now() - at < 10 * 60 * 1000) {
      try { return Promise.resolve(JSON.parse(cached)); } catch (_) {}
    }
  }
  const cache = (list) => {
    localStorage.setItem("skywave.rx", JSON.stringify(list));
    localStorage.setItem("skywave.rxAt", String(Date.now()));
    return list;
  };
  if (GATEWAY) {
    return fetch(`${GATEWAY}/receivers?t=${Date.now()}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`gateway ${r.status}`)))
      .then(cache);
  }
  // Direct load — only works from http:// origins. The endpoint returns
  // a JS assignment (not JSON); inject a <script> to bypass CORS.
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "http://rx.linkfanel.net/kiwisdr_com.js?t=" + Date.now();
    s.onload = () => resolve(cache(window.kiwisdr_com || []));
    s.onerror = () => reject(new Error("failed to fetch receiver list"));
    document.head.appendChild(s);
  });
}

function indexReceivers(list) {
  receiverList.length = 0;
  receiverList.push(...list);
  receiversByHost.clear();
  for (const r of list) {
    if (!r.url) continue;
    try {
      const u = new URL(r.url);
      receiversByHost.set(u.hostname + ":" + (u.port || "8073"), r);
    } catch (_) {}
  }
}

// Rank every receiver that covers `khz` inside `bbox`. Etiquette gate:
// require ≥MIN_FREE_SLOTS_TO_JOIN free user slots.
function rankCandidates(khz, excludeHosts, bbox) {
  return receiverList
    .filter((r) => r.status === "active" && r.offline !== "yes" && r.url && coversBand(r, khz))
    // proxy.kiwisdr.com 307-redirects on handshake; browsers can't follow.
    .filter((r) => !/proxy\.kiwisdr\.com/i.test(r.url))
    .map((r) => {
      let host = "";
      try { const u = new URL(r.url); host = u.hostname + ":" + (u.port || "8073"); } catch (_) {}
      if (!host || excludeHosts.has(host)) return null;
      const free = Math.max(0, (parseInt(r.users_max, 10) || 0) - (parseInt(r.users, 10) || 0));
      const gps = parseGps(r.gps);
      if (!gps || free < MIN_FREE_SLOTS_TO_JOIN) return null;
      if (!inRegion(gps, bbox)) return null;
      const coast = coastDeg(gps);
      const coastBoost = Math.max(0.25, 3 / (coast + 0.5));
      return { r, host, gps, free, coast, score: free * coastBoost };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

// Distribute `n` slots across `bandsKHz`, picking different receivers
// per band where possible, with a minimum geographic separation (~2.5°)
// between slots on the same band.
function pickReceiversAcrossBands(bandsKHz, n, excludeHosts, bbox) {
  const k = bandsKHz.length;
  if (!k) return [];
  const base = Math.floor(n / k);
  const extra = n - base * k;
  const quota = bandsKHz.map((_, i) => base + (i < extra ? 1 : 0));
  const pools = bandsKHz.map((khz) => rankCandidates(khz, excludeHosts, bbox));
  const picks = [];
  const used = new Set(excludeHosts);
  const MIN_SEP = 2.5;

  let progress = true;
  while (progress && picks.length < n) {
    progress = false;
    for (let bi = 0; bi < k; bi++) {
      if (quota[bi] <= 0) continue;
      const pool = pools[bi];
      for (let ci = 0; ci < pool.length; ci++) {
        const c = pool[ci];
        if (!c || used.has(c.host)) continue;
        const sameBand = picks.filter((p) => p.bandKHz === bandsKHz[bi]);
        const tooClose = sameBand.some(
          (p) => Math.hypot(p.gps[0] - c.gps[0], p.gps[1] - c.gps[1]) < MIN_SEP
        );
        if (tooClose) continue;
        used.add(c.host);
        picks.push({ ...c, bandKHz: bandsKHz[bi] });
        pool[ci] = null;
        quota[bi]--;
        progress = true;
        break;
      }
      if (picks.length >= n) break;
    }
  }
  // Top-up ignoring geographic filter if still short on budget.
  for (let bi = 0; bi < k && picks.length < n; bi++) {
    for (const c of pools[bi]) {
      if (!c || used.has(c.host)) continue;
      used.add(c.host);
      picks.push({ ...c, bandKHz: bandsKHz[bi] });
      if (picks.length >= n) break;
    }
  }
  return picks.slice(0, n);
}

// ---------------------------------------------------------------------------
// RxSlot — one KiwiSDR + its DSC decoder state
// ---------------------------------------------------------------------------

class RxSlot {
  constructor(meta) {
    this.rx = meta.r;
    this.gps = meta.gps;
    this.bandKHz = meta.bandKHz;
    this.bandLabel = bandLabelFor(this.bandKHz);
    this.label = (meta.r.loc || "").slice(0, 34) || meta.r.name || "unknown";
    const url = new URL(meta.r.url);
    this.host = url.hostname;
    this.port = parseInt(url.port || "8073", 10);
    this.hostKey = this.host + ":" + this.port;
    this.client = null;
    this.state = "idle";
    this.rssi = -127;
    this.rmsEMA = 0;
    this.inBandEMA = 0;
    this.buffer = new Float32Array(0);
    this.sr = 12000;
    this.lastRun = 0;
    this.lastActive = 0;
    this.signatures = new Map();
  }

  connect() {
    this.state = "connecting";
    this.client = new KiwiClient(this.host, this.port, {
      dialKHz: this.bandKHz - 1.7,
      onAudio: (samples, sr, rssi) => this._onAudio(samples, sr, rssi),
      onStatus: (s) => {
        if (/^live/.test(s)) this.state = "live";
        else if (/error|down|busy|bad/.test(s)) this.state = "err";
        updateRxCount();
      },
      onClose: () => {
        if (this.state !== "err") this.state = "dead";
        if (audioSlot === this) audioSlot = null;
        updateRxCount();
      },
    });
    this.client.connect();
  }

  close() { if (this.client) this.client.close(); }

  _onAudio(samples, sr, rssi) {
    this.rssi = rssi;
    this.sr = sr;
    const N = samples.length;

    let totalP = 0;
    for (let i = 0; i < N; i++) totalP += samples[i] * samples[i];
    const rms = Math.sqrt(totalP / N);
    this.rmsEMA = this.rmsEMA * 0.8 + rms * 0.2;

    // Narrow-band Goertzel at the two FSK tones. An FSK burst
    // concentrates most chunk energy into these ~20 Hz bins; broadband
    // noise and human voice don't. Normalised to the same scale as
    // rms² ≈ A²/2 for a pure tone of amplitude A.
    const tonePow = (freq) => {
      const w = 2 * Math.PI * freq / sr;
      const cw = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) {
        const s0 = samples[i] + cw * s1 - s2;
        s2 = s1; s1 = s0;
      }
      return Math.max(0, (s1 * s1 + s2 * s2 - cw * s1 * s2) * 4 / (N * N));
    };
    const inband = tonePow(1615) + tonePow(1785);
    const bandFrac = inband / (totalP * 2 / N + 1e-9);
    this.inBandEMA = this.inBandEMA * 0.65 + bandFrac * 0.35;

    const active = this.rmsEMA > AUDIO_ACTIVITY_RMS && this.inBandEMA > AUDIO_INBAND_RATIO;
    if (active) this.lastActive = performance.now();

    updateAudioRouting();

    if (audioSlot === this) playSamples(samples, sr);

    this._pushDecoder(samples, sr);
  }

  _pushDecoder(samples, sr) {
    const maxLen = Math.floor(sr * 15);
    if (this.buffer.length + samples.length <= maxLen) {
      const merged = new Float32Array(this.buffer.length + samples.length);
      merged.set(this.buffer); merged.set(samples, this.buffer.length);
      this.buffer = merged;
    } else {
      const keep = maxLen - samples.length;
      const merged = new Float32Array(maxLen);
      merged.set(this.buffer.subarray(this.buffer.length - keep));
      merged.set(samples, keep);
      this.buffer = merged;
    }
    const now = performance.now();
    if (now - this.lastRun > 3000 && this.buffer.length >= sr * 10) {
      this.lastRun = now;
      // Yield to the event loop so 64+ decoders don't block audio.
      setTimeout(() => this._runDecoder(), 0);
    }
  }

  _runDecoder() {
    const view = this.buffer.subarray(Math.max(0, this.buffer.length - Math.floor(this.sr * 10)));
    let rms = 0;
    for (let i = 0; i < view.length; i += 64) rms += view[i] * view[i];
    rms = Math.sqrt(rms * 64 / view.length);
    if (rms < 0.005) return;
    if (DEBUG) console.log(`[dsc] ${this.bandLabel} ${this.label}: rms=${rms.toFixed(3)} run decoder`);

    let call;
    try { call = dscDecode(view, this.sr, { debug: DEBUG }); }
    catch (e) { if (DEBUG) console.log(`[dsc] threw:`, e); return; }
    if (!call) return;

    // Per-slot dedupe so one burst in the decode window doesn't report
    // twice from the same receiver.
    const sig = callSig(call);
    const now = Date.now();
    if (now - (this.signatures.get(sig) || 0) < 60000) return;
    this.signatures.set(sig, now);
    for (const [k, t] of this.signatures) if (now - t > 120000) this.signatures.delete(k);

    dispatchCall(call, this);
  }
}

// ---------------------------------------------------------------------------
// Cross-receiver dedupe, rendering, GFW enrichment
// ---------------------------------------------------------------------------

const callSig = (c) =>
  [c.formatCode, c.destination, c.caller, c.tc1Code, c.tc2Code, c.eos].join("|");

function dispatchCall(call, slot) {
  const sig = callSig(call);
  const now = Date.now();
  const existing = callIndex.get(sig);
  if (existing && now - existing.firstSeen < 120000) {
    existing.receivers.set(slot.label, slot.bandLabel);
    if (!existing.receiverSlots.includes(slot)) existing.receiverSlots.push(slot);
    updateHeard(existing);
    addReceiverToMiniMap(existing, slot);
    return;
  }
  const entry = {
    firstSeen: now,
    receivers: new Map([[slot.label, slot.bandLabel]]),
    receiverSlots: [slot],
    primaryBand: slot.bandLabel,
    call,
    row: null,
    _mapInited: false, _map: null, _rxMarkers: new Map(),
  };
  callIndex.set(sig, entry);
  entry.row = addCallRow(call, entry);
  if (/^\d{9}$/.test(call.caller || "")) Vessels.lookup(call.caller);
  for (const [k, v] of callIndex) if (now - v.firstSeen > 600000) callIndex.delete(k);
}

function updateHeard(entry) {
  const bands = new Set(entry.receivers.values());
  const heardEl = entry.row.querySelector(".c-heard");
  if (heardEl) heardEl.textContent = `${entry.receivers.size} RX · ${Array.from(bands).join("/")}`;
  const list = entry.row.querySelector(".heard-list");
  if (list) list.innerHTML = "heard by: " + Array.from(entry.receivers).map(
    ([rx, band]) => `<span>${escapeHtml(rx)}</span> <em>${band}</em>`
  ).join(", ");
}

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
    <span class="c-t">${hh}:${mm}:${ss}Z</span>
    <span class="c-who">
      <span class="name" data-mmsi="${callerMmsi}">MMSI ${callerMmsi}</span><span class="flag">${midIso(callerMmsi)}</span>
    </span>
    <span class="c-flow">→ ${escapeHtml(destMmsi)}</span>
    <span class="c-pay">${escapeHtml(call.category || "?")} · ${escapeHtml(call.tc1 || "?")}${call.tc2 && call.tc2 !== call.tc1 ? " · " + escapeHtml(call.tc2) : ""} · ${escapeHtml(call.eos)}</span>
    <span class="c-heard">${entry.receivers.size} RX · ${entry.primaryBand}</span>
    <div class="call-detail">
      <div class="detail-text">
        <div class="vessel" data-mmsi="${callerMmsi}"></div>
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
      <div class="mini-map"></div>
    </div>
  `;
  row.addEventListener("click", (e) => {
    if (e.target.closest(".mini-map, a")) return;
    row.classList.toggle("open");
    if (row.classList.contains("open")) initMiniMap(entry);
  });
  callsEl.prepend(row);
  while (callsEl.children.length > 200) callsEl.lastChild.remove();

  // Kick off GFW enrichment — already-cached hits populate synchronously.
  applyVesselIfCached(callerMmsi);
  return row;
}

// ---------------------------------------------------------------------------
// GFW enrichment rendering
// ---------------------------------------------------------------------------

function applyVesselIfCached(mmsi) {
  const info = Vessels.get(mmsi);
  if (info) renderVessel(mmsi, info);
}

function renderVessel(mmsi, info) {
  if (!info) return;
  for (const nameEl of document.querySelectorAll(`.name[data-mmsi="${mmsi}"]`)) {
    nameEl.textContent = info.name || `MMSI ${mmsi}`;
    if (info.type) nameEl.title = info.type;
  }
  // Detail-block chips complement the name-already-in-the-row — GFW flag
  // (3-letter), ML-inferred vessel type, callsign, IMO — but skip the
  // name itself so we don't repeat it.
  for (const v of document.querySelectorAll(`.vessel[data-mmsi="${mmsi}"]`)) {
    const flag = info.flag || midIso(mmsi);
    const bits = [];
    if (flag) bits.push(`<span class="vchip">${escapeHtml(flag)}</span>`);
    if (info.type) bits.push(`<span class="vchip">${escapeHtml(info.type)}</span>`);
    if (info.callsign) bits.push(`<span class="vchip">${escapeHtml(info.callsign)}</span>`);
    if (info.imo) bits.push(`<span class="vchip">IMO ${escapeHtml(info.imo)}</span>`);
    v.innerHTML = bits.join(" ");
  }
}

Vessels.onUpdate((mmsi, info) => {
  renderVessel(mmsi, info);
  if (!info) return;
  for (const entry of callIndex.values()) {
    if (entry.call.caller !== mmsi || !entry._mapInited) continue;
    if (info.lastPos) {
      setVesselOnMiniMap(entry, info);
    } else if (info.vesselId) {
      // Tracks fetch completed but returned no points — mark the map so
      // the user can distinguish "still loading" from "ship silent".
      const c = entry.row.querySelector(".mini-map");
      if (c) c.classList.add("no-track");
    }
  }
});

// ---------------------------------------------------------------------------
// Audio output
// ---------------------------------------------------------------------------

function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  destinationGain = audioCtx.createGain();
  destinationGain.gain.value = 1;
  destinationGain.connect(audioCtx.destination);
  nextStart = audioCtx.currentTime + AUDIO_LEAD_SEC;
}

function playSamples(samples, sr) {
  if (!audioCtx || audioCtx.state !== "running") return;
  const buf = audioCtx.createBuffer(1, samples.length, sr);
  buf.copyToChannel(samples, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(destinationGain);
  const start = Math.max(nextStart, audioCtx.currentTime + 0.02);
  src.start(start);
  nextStart = start + samples.length / sr;
  if (nextStart < audioCtx.currentTime - 0.5) nextStart = audioCtx.currentTime + AUDIO_LEAD_SEC;
}

// Pick the slot that should drive the speakers: highest RMS × in-band
// ratio × RSSI weight across currently-active slots. Keep the pick for
// AUDIO_HOLD_MS after activity stops so a burst's tail isn't cut.
function updateAudioRouting() {
  const now = performance.now();
  let bestSlot = null, bestScore = 0;
  for (const s of slots) {
    if (s.state !== "live") continue;
    if (s.rmsEMA <= AUDIO_ACTIVITY_RMS) continue;
    if (s.inBandEMA <= AUDIO_INBAND_RATIO) continue;
    const rssiW = Math.min(1, Math.max(0, (s.rssi + 110) / 80));
    const score = s.rmsEMA * s.inBandEMA * (0.25 + rssiW);
    if (score > bestScore) { bestSlot = s; bestScore = score; }
  }
  if (bestSlot) {
    lastActivityAt = now;
    if (audioSlot !== bestSlot) setAudioSlot(bestSlot);
  } else if (audioSlot && now - lastActivityAt > AUDIO_HOLD_MS) {
    setAudioSlot(null);
  }
}

function setAudioSlot(slot) {
  if (audioSlot === slot) return;
  audioSlot = slot;
  if (audioCtx) nextStart = audioCtx.currentTime + AUDIO_LEAD_SEC;
  if (slot) {
    playingEl.textContent = `${slot.bandLabel} · ${slot.label}`;
    playingEl.classList.add("on");
  } else {
    playingEl.textContent = "";
    playingEl.classList.remove("on");
  }
}

// ---------------------------------------------------------------------------
// Header + counters
// ---------------------------------------------------------------------------

function updateRxCount() {
  const live = slots.filter((s) => s.state === "live").length;
  const region = currentRegion();
  const rx = !slots.length
    ? "connecting…"
    : live === 0
      ? `0 / ${slots.length} stations`
      : `${live} station${live === 1 ? "" : "s"}`;
  const regionPart = region.id === "global" ? "" : ` · ${region.name}`;
  rxCountEl.textContent = rx + regionPart;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ---------------------------------------------------------------------------
// Etiquette watchdog: periodically re-fetch the receiver list and drop
// slots where the RX has filled up, picking a replacement on the same
// band from a receiver that still has ≥2 free slots.
// ---------------------------------------------------------------------------

async function watchOccupancy() {
  try { indexReceivers(await loadReceivers({ force: true })); }
  catch (e) { if (DEBUG) console.log("[skywave] receiver refresh failed:", e); return; }

  const drop = slots.filter((s) => {
    if (s.state !== "live" && s.state !== "connecting") return false;
    const info = receiversByHost.get(s.hostKey);
    if (!info) return false;
    const users = parseInt(info.users, 10) || 0;
    const maxU = parseInt(info.users_max, 10) || 0;
    return maxU > 0 && users >= maxU;
  });
  if (!drop.length) return;

  if (DEBUG) console.log(`[skywave] dropping ${drop.length} full receiver(s)`);
  const occupied = new Set(slots.filter((s) => !drop.includes(s)).map((s) => s.hostKey));
  const bbox = currentRegion().bbox;
  for (const s of drop) {
    s.close();
    const idx = slots.indexOf(s);
    if (idx >= 0) slots.splice(idx, 1);
    const candidates = pickReceiversAcrossBands([s.bandKHz], 1, occupied, bbox);
    if (candidates.length) {
      const ns = new RxSlot(candidates[0]);
      slots.push(ns);
      occupied.add(ns.hostKey);
      ns.connect();
    }
  }
  updateRxCount();
}

// ---------------------------------------------------------------------------
// Start / stop / restart
// ---------------------------------------------------------------------------

function stop() {
  for (const t of connectTimers) clearTimeout(t);
  connectTimers = [];
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  for (const s of slots) s.close();
  slots = [];
  audioSlot = null;
  playingEl.textContent = "";
  playingEl.classList.remove("on");
}

function start() {
  const region = currentRegion();
  const bands = BANDS.map((b) => b.khz);
  const picks = pickReceiversAcrossBands(bands, MAX_FANOUT, new Set(), region.bbox);
  if (!picks.length) {
    rxCountEl.textContent = "no receivers in this region";
    return;
  }

  slots = picks.map((p) => new RxSlot(p));
  callIndex.clear();
  callsEl.innerHTML = "";
  emptyEl.style.display = "";

  slots.forEach((s, i) => {
    connectTimers.push(setTimeout(() => s.connect(), i * CONNECT_STAGGER_MS));
  });
  updateRxCount();
  watchdogTimer = setInterval(watchOccupancy, RX_LIST_REFRESH_MS);
}

function restart() { stop(); start(); }

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function downloadCsv() {
  const cols = [
    "time_utc", "caller_mmsi", "caller_name", "caller_flag", "caller_type",
    "dest_mmsi", "format", "category", "tc1", "tc2", "eos",
    "mark_hz", "space_hz", "phasing_score",
    "receivers_count", "primary_band", "heard_by",
  ];
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = Array.from(callIndex.values()).sort((a, b) => a.firstSeen - b.firstSeen);
  const lines = [cols.join(",")];
  for (const e of rows) {
    const c = e.call;
    const v = Vessels.get(c.caller) || {};
    const heardBy = Array.from(e.receivers).map(([rx, band]) => `${rx} (${band})`).join("; ");
    lines.push([
      new Date(e.firstSeen).toISOString(),
      c.caller || "",
      v.name || "",
      v.flag || midIso(c.caller),
      v.type || "",
      c.destination || (c.formatCode === 112 ? "all ships" : ""),
      c.format || "",
      c.category || "",
      c.tc1 || "",
      c.tc2 || "",
      c.eos || "",
      c.markHz != null ? c.markHz.toFixed(0) : "",
      c.spaceHz != null ? c.spaceHz.toFixed(0) : "",
      c.phasingScore != null ? c.phasingScore : "",
      e.receivers.size,
      e.primaryBand || "",
      heardBy,
    ].map(esc).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `skywave-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Wire events & bootstrap
// ---------------------------------------------------------------------------

if (csvBtn) csvBtn.addEventListener("click", downloadCsv);

if (regionEl) {
  for (const r of REGIONS) {
    const opt = document.createElement("option");
    opt.value = r.id; opt.textContent = r.name;
    regionEl.appendChild(opt);
  }
  regionEl.value = currentRegion().id;
  regionEl.addEventListener("change", () => {
    localStorage.setItem(REGION_STORAGE_KEY, regionEl.value);
    restart();
  });
}

// Audio unlock: browsers block AudioContext.resume() until the user
// activates the page. Connection, decoding, and UI work without any
// gesture — only sound waits for the first tap/click/key.
function unlockAudio() {
  ensureAudio();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
["pointerdown", "click", "keydown", "touchstart"].forEach((evt) =>
  document.addEventListener(evt, unlockAudio, { once: true, passive: true })
);

(async function init() {
  rxCountEl.textContent = "loading…";
  try { indexReceivers(await loadReceivers()); }
  catch (e) { rxCountEl.textContent = "no receiver list"; return; }
  start();
})();

// Debug hook — lets ?debug=1 users poke at state from devtools without
// us leaking internals into `window` in production.
if (DEBUG) window.skywave = { slots: () => slots, callIndex, Vessels, dispatchCall };
