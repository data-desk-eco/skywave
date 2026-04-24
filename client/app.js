// Skywave v2 client — a pure viewer. All decoding and the KiwiSDR
// handshake live in Cloudflare Durable Objects (one per channel); this
// module subscribes to a rack of them and renders whatever they tell it.
//
//   1. Boot: GET /v2/rack?region=<id> → { slots: [{host, port, band,
//      bandKHz, label, gps, wsUrl}, ...] }.
//   2. For each slot, open its WebSocket. Each slot announces decoded
//      calls, activity-burst status flips, and — only during bursts,
//      only to clients that asked — base-64 PCM for playback.
//   3. Audio picker: follow whichever live slot has the loudest burst;
//      un-follow the others so the server doesn't waste bandwidth
//      streaming PCM we'd never play.

import { Vessels } from "./vessels.js?v=26";
import { initMiniMap, addReceiverToMiniMap, setVesselOnMiniMap, setTdoaOnMiniMap } from "./map.js?v=26";
import { REGIONS, REGION_STORAGE_KEY, currentRegion, midIso } from "./regions.js?v=26";

const DEBUG = /(\?|&)debug=1\b/.test(location.search);
const AUDIO_LEAD_SEC = 0.25;
const AUDIO_HOLD_MS  = 6000;
const RACK_REFRESH_MS = 60_000;
// Only surface TDOA fixes whose solver residual is tight enough to be
// worth trusting. Bigger residuals usually mean a 3-receiver mirror
// ambiguity landed on the wrong hyperbola basin, or the packet reached
// some receivers via an extra skywave hop the solver models as
// straight-line c. Silent is better than misleading; a later re-solve
// with more receivers often tightens the fix and it'll appear then.
const TDOA_MAX_RESIDUAL_KM = 100;

const GATEWAY = (() => {
  const meta = document.querySelector('meta[name="skywave-gateway"]');
  const url = meta && meta.content.trim();
  if (!url) return null;
  return url.replace(/\/+$/, "");
})();

// -------------------------------------------------------------------
// DOM
// -------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const rxCountEl = $("rxcount"), playingEl = $("playing"),
      callsEl = $("calls"), emptyEl = $("empty"),
      csvBtn = $("csv"), regionEl = $("region"),
      tdoaOnlyEl = $("tdoa-only");

// -------------------------------------------------------------------
// State
// -------------------------------------------------------------------

/** @type {Map<string, SlotConn>} slotKey ("host:port:bandKHz") → SlotConn */
const slots = new Map();
/** Cross-slot dedupe: sig → { firstSeen, receivers, row, ... } */
const callIndex = new Map();
/** MMSI → latest TDOA fix from the coordinator DO. Kept for the whole
 *  session so a call decoded long after its TDOA still picks up the
 *  position when the card is opened. */
const tdoaByMmsi = new Map();
let tdoaWs = null;
let tdoaRetry = 2000;
let audioCtx = null;
let destinationGain = null;
let audioEl = null;
let nextStart = 0;
let audioFollowKey = null;
let audioUnlocked = false;
let rackTimer = null;

// -------------------------------------------------------------------
// SlotConn — one WebSocket to a ReceiverDO
// -------------------------------------------------------------------

class SlotConn {
  constructor(meta) {
    this.host = meta.host;
    this.port = meta.port;
    this.bandKHz = meta.bandKHz;
    this.bandLabel = meta.band;
    this.label = meta.label;
    this.gps = meta.gps;
    this.wsUrl = meta.wsUrl;
    this.key = `${meta.host}:${meta.port}:${meta.bandKHz}`;
    this.hostKey = `${meta.host}:${meta.port}`;   // compat with map.js markers
    this.ws = null;
    this.state = "idle";
    this.rssi = -127;
    this.lastBurstAt = 0;
    this.audioFollow = false;
    this.closed = false;
    this.retryDelay = 2000;
    // Set when the slot enters "dead" via a status frame (DO is up,
    // upstream Kiwi failed). The dead-slot watchdog uses this to
    // force-close and reconnect a slot that's been dark too long.
    this.deadSince = 0;
  }

  connect() {
    if (this.closed) return;
    this.state = "connecting";
    updateRxCount();
    try { this.ws = new WebSocket(this.wsUrl); }
    catch (e) { this._retry(`ws ctor: ${e.message}`); return; }
    this.ws.onopen = () => { this.retryDelay = 2000; };
    this.ws.onmessage = (ev) => this._onMessage(ev);
    this.ws.onerror = () => {};
    this.ws.onclose = () => {
      this.ws = null;
      this.state = "dead";
      if (this.audioFollow) stopFollowing(this);
      updateRxCount();
      this._retry("ws close");
    };
  }

  close() {
    this.closed = true;
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
  }

  setAudioFollow(on) {
    if (this.audioFollow === !!on) return;
    this.audioFollow = !!on;
    this._send({ t: "audio-follow", on: !!on });
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(msg)); } catch (_) {}
    }
  }

  _retry(reason) {
    if (this.closed) return;
    if (DEBUG) console.log(`[skywave] ${this.key} drop: ${reason}`);
    setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
  }

  _onMessage(ev) {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "hello":
        this.state = "live";
        this.deadSince = 0;
        updateRxCount();
        return;
      case "status":
        if (typeof msg.rssi === "number") this.rssi = msg.rssi;
        if (msg.state === "burst") {
          this.lastBurstAt = performance.now();
          reconsiderAudio();
        } else if (msg.state === "live") {
          this.state = "live";
          this.deadSince = 0;
          reconsiderAudio();
        } else if (msg.state === "down" || msg.state === "err") {
          this.state = "dead";
          if (!this.deadSince) this.deadSince = performance.now();
          reconsiderAudio();
        }
        updateRxCount();
        return;
      case "call":
        if (msg.call) dispatchCall(msg.call, this);
        return;
      case "audio":
        if (this.audioFollow && audioFollowKey === this.key) playAudio(msg);
        return;
    }
  }
}

// -------------------------------------------------------------------
// Rack load + reconcile
// -------------------------------------------------------------------

async function fetchRack(regionId) {
  if (!GATEWAY) throw new Error("no gateway configured");
  const resp = await fetch(`${GATEWAY}/v2/rack?region=${encodeURIComponent(regionId)}`);
  if (!resp.ok) throw new Error(`rack ${resp.status}`);
  return resp.json();
}

function applyRack(rack) {
  const keep = new Set();
  for (const s of rack.slots) {
    const key = `${s.host}:${s.port}:${s.bandKHz}`;
    keep.add(key);
    if (slots.has(key)) continue;
    const conn = new SlotConn(s);
    slots.set(key, conn);
    conn.connect();
  }
  for (const [key, conn] of slots) {
    if (!keep.has(key)) {
      conn.close();
      slots.delete(key);
    }
  }
  updateRxCount();
}

async function refreshRack() {
  try {
    const rack = await fetchRack(currentRegion().id);
    applyRack(rack);
  } catch (e) {
    if (DEBUG) console.log("[skywave] rack refresh failed:", e);
  }
}

function stop() {
  for (const c of slots.values()) c.close();
  slots.clear();
  if (rackTimer) { clearInterval(rackTimer); rackTimer = null; }
  audioFollowKey = null;
  playingEl.textContent = "";
  playingEl.classList.remove("on");
}

async function start() {
  rxCountEl.textContent = "loading…";
  try {
    const rack = await fetchRack(currentRegion().id);
    if (!rack.slots || !rack.slots.length) {
      rxCountEl.textContent = "no receivers in this region";
      return;
    }
    callIndex.clear();
    callsEl.innerHTML = "";
    emptyEl.style.display = "";
    applyRack(rack);
    rackTimer = setInterval(refreshRack, RACK_REFRESH_MS);
    startDeadSlotWatchdog();
    connectTdoaFeed();
  } catch (e) {
    rxCountEl.textContent = "no rack";
    if (DEBUG) console.log("[skywave] start failed:", e);
  }
}

function restart() { stop(); start(); }

// Dead-slot watchdog: a slot can report state=err/down while the
// client-DO WebSocket stays open (the DO is up, only its Kiwi upstream
// failed). The SlotConn retry path is wired to ws.onclose, so without a
// kick the slot sits dead indefinitely. Every DEAD_WATCH_MS we close
// any WS whose slot has been dead for longer than DEAD_GRACE_MS; the
// reconnect triggers a fresh _ensureUpstream inside the DO.

const DEAD_GRACE_MS = 60_000;
const DEAD_WATCH_MS = 15_000;
let deadWatchTimer = null;

function startDeadSlotWatchdog() {
  if (deadWatchTimer) return;
  deadWatchTimer = setInterval(() => {
    const now = performance.now();
    for (const s of slots.values()) {
      if (!s.ws || s.ws.readyState !== 1) continue;
      if (s.state !== "dead" || !s.deadSince) continue;
      if (now - s.deadSince < DEAD_GRACE_MS) continue;
      if (DEBUG) console.log(`[skywave] watchdog bouncing ${s.key}`);
      try { s.ws.close(); } catch (_) {}
      s.deadSince = 0;  // don't re-bounce before onclose fires
    }
  }, DEAD_WATCH_MS);
}

// -------------------------------------------------------------------
// Audio picker — follow the loudest live burst, drop the rest
// -------------------------------------------------------------------

function reconsiderAudio() {
  const now = performance.now();
  let best = null, bestScore = -Infinity;
  for (const c of slots.values()) {
    if (c.state !== "live") continue;
    const freshness = now - c.lastBurstAt;
    if (freshness > AUDIO_HOLD_MS) continue;
    const rssiW = Math.min(1, Math.max(0, (c.rssi + 110) / 80));
    const score = rssiW - freshness / 1e6;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  if (best && audioFollowKey !== best.key) {
    for (const c of slots.values()) if (c !== best && c.audioFollow) c.setAudioFollow(false);
    best.setAudioFollow(true);
    audioFollowKey = best.key;
    if (audioCtx) nextStart = audioCtx.currentTime + AUDIO_LEAD_SEC;
  } else if (!best && audioFollowKey) {
    for (const c of slots.values()) if (c.audioFollow) c.setAudioFollow(false);
    audioFollowKey = null;
  }
  updatePlayingLabel();
}

function stopFollowing(conn) {
  conn.audioFollow = false;
  if (audioFollowKey === conn.key) audioFollowKey = null;
  updatePlayingLabel();
}

// The header indicator doubles as the audio-locked hint: on iOS the
// AudioContext can be running but muted until the user taps, so don't
// pretend a station is audible when it isn't. On fine-pointer devices
// any click anywhere unlocks audio, so the hint is noise — drop it
// and let the bare label sit unstyled until the first interaction.
const NEEDS_TAP_HINT = !!window.matchMedia?.("(pointer: coarse)").matches;

function updatePlayingLabel() {
  const conn = audioFollowKey ? slots.get(audioFollowKey) : null;
  if (!conn) {
    playingEl.textContent = "";
    playingEl.classList.remove("on");
    return;
  }
  const label = `${conn.bandLabel} · ${conn.label}`;
  const ctxReady = audioCtx && audioCtx.state === "running" && audioUnlocked;
  const elReady  = !audioEl || !audioEl.paused;
  if (ctxReady && elReady) {
    playingEl.textContent = label;
    playingEl.classList.add("on");
  } else {
    playingEl.textContent = NEEDS_TAP_HINT ? `tap to enable audio · ${label}` : label;
    playingEl.classList.remove("on");
  }
}

// int16-BE base64 → Float32
function decodePcm(b64) {
  const bin = atob(b64);
  const len = bin.length >> 1;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = (bin.charCodeAt(i * 2) << 8) | bin.charCodeAt(i * 2 + 1);
    if (s & 0x8000) s |= ~0xFFFF;
    out[i] = s / 32768;
  }
  return out;
}

function playAudio(msg) {
  if (!audioCtx || audioCtx.state !== "running") return;
  const samples = decodePcm(msg.pcm);
  const sr = msg.sr || 12000;
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

function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  destinationGain = audioCtx.createGain();
  destinationGain.gain.value = 1;

  // Route through an <audio> element via a MediaStreamDestination.
  // On iOS a direct audioCtx.destination output plays in the "ambient"
  // audio category, which the hardware Ring/Silent switch mutes — so
  // tapping "unlocks" the context but nothing is audible. Feeding the
  // graph into an <audio srcObject> re-categorises playback as "media",
  // which ignores the silent switch.
  try {
    const streamDest = audioCtx.createMediaStreamDestination();
    destinationGain.connect(streamDest);
    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.srcObject = streamDest.stream;
    audioEl.addEventListener("play", updatePlayingLabel);
    audioEl.addEventListener("pause", updatePlayingLabel);
    document.body.appendChild(audioEl);
  } catch (_) {
    destinationGain.connect(audioCtx.destination);
  }

  nextStart = audioCtx.currentTime + AUDIO_LEAD_SEC;
  audioCtx.addEventListener("statechange", updatePlayingLabel);
}

function unlockAudio() {
  ensureAudio();
  if (audioCtx.state === "suspended") {
    try { audioCtx.resume(); } catch (_) {}
  }
  // iOS WebKit needs an actual buffer scheduled inside the gesture to
  // unmute the AudioContext — resume() alone isn't enough.
  try {
    const silent = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = silent;
    src.connect(audioCtx.destination);
    src.start(0);
    audioUnlocked = true;
  } catch (_) {}
  // And kick the <audio> element's play() inside the same gesture so
  // iOS actually starts pulling from the MediaStream. Without this the
  // element stays paused, silencing every later sample.
  if (audioEl) {
    try { const p = audioEl.play(); if (p && p.catch) p.catch(() => {}); }
    catch (_) {}
  }
  updatePlayingLabel();
}

// -------------------------------------------------------------------
// Call dedupe + rendering (unchanged from v1)
// -------------------------------------------------------------------

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
  // TDOA may have arrived before this call's card was rendered (coord
  // DO broadcasts on quorum, which can beat a decoder re-run elsewhere).
  const tdoa = tdoaByMmsi.get(call.caller);
  if (tdoa) renderTdoaInCard(entry, tdoa);
  for (const [k, v] of callIndex) if (now - v.firstSeen > 600000) callIndex.delete(k);
}

// TDOA feed — one WebSocket to the coordinator DO. Keeps a MMSI→fix
// map so a late call decode for a previously-solved ship still picks up
// its position when the card is rendered. Auto-reconnects on close.

function connectTdoaFeed() {
  if (!GATEWAY) return;
  if (tdoaWs) { try { tdoaWs.close(); } catch (_) {} }
  tdoaWs = new WebSocket(GATEWAY.replace(/^http/, "ws") + "/v2/tdoa/subscribe");
  tdoaWs.onopen = () => { tdoaRetry = 2000; };
  tdoaWs.onerror = () => {};
  tdoaWs.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (!msg || msg.t !== "tdoa" || !msg.mmsi || !msg.position) return;
    tdoaByMmsi.set(msg.mmsi, msg);
    for (const entry of callIndex.values()) {
      if (entry.call.caller === msg.mmsi) renderTdoaInCard(entry, msg);
    }
  };
  tdoaWs.onclose = () => {
    tdoaWs = null;
    setTimeout(connectTdoaFeed, tdoaRetry);
    tdoaRetry = Math.min(tdoaRetry * 2, 30_000);
  };
}

function renderTdoaInCard(entry, tdoa) {
  // Confirmed fixes (≥4 receivers, residual is meaningful): drop those
  // whose residual exceeds the self-check threshold. Preliminary fixes
  // (3 receivers, exactly determined, residual is always ~0) bypass
  // that check — they're already gated server-side on stricter
  // geometry and will render with a visible "preliminary" marker.
  const residKm = tdoa?.position?.residualKm;
  const isPrelim = tdoa.tier === "preliminary";
  if (!isPrelim && (!Number.isFinite(residKm) || residKm >= TDOA_MAX_RESIDUAL_KM)) return;
  entry.tdoa = tdoa;
  if (!entry.row) return;
  entry.row.classList.add("has-tdoa");
  entry.row.classList.toggle("tdoa-prelim", isPrelim);

  // Summary reflects the coordinator's authoritative quorum, not the
  // local WS-feed count (which can be lower when this browser isn't
  // attached to every cohort member).
  const summary = entry.row.querySelector(".c-heard");
  if (summary) {
    summary.classList.add("has-tdoa");
    const bands = new Set(entry.receivers.values());
    summary.textContent = `${tdoa.quorum} RX · ${Array.from(bands).join("/")}`;
  }

  const detail = entry.row.querySelector(".detail-text");
  if (detail) {
    let tdoaEl = detail.querySelector(".tdoa-fix");
    if (!tdoaEl) {
      tdoaEl = document.createElement("div");
      tdoaEl.className = "tdoa-fix";
      // Sit just under the GFW vessel chips, above the format/kv block.
      const anchor = detail.querySelector(".vessel");
      if (anchor && anchor.nextSibling) detail.insertBefore(tdoaEl, anchor.nextSibling);
      else detail.prepend(tdoaEl);
    }
    const { lat, lon, residualKm } = tdoa.position;
    const when = new Date(tdoa.broadcastMs).toISOString().slice(11, 19) + "Z";
    tdoaEl.classList.toggle("prelim", isPrelim);
    const label = isPrelim ? "TDOA fix · preliminary" : "TDOA fix";
    // Residual is meaningful only for confirmed fixes; for preliminary
    // we show the geometry (bearing spread) instead as the quality cue.
    const qualityMeta = isPrelim
      ? `max-gap ${tdoa.geometry?.maxBearingGapDeg?.toFixed(0) ?? "?"}°`
      : `±${residualKm.toFixed(1)} km`;
    tdoaEl.innerHTML =
      `<span class="tdoa-label">${label}</span>` +
      `<span class="tdoa-coord">${lat.toFixed(3)}°, ${lon.toFixed(3)}°</span>` +
      `<span class="tdoa-meta">${qualityMeta} · q=${tdoa.quorum} · ${when}</span>`;
  }
  if (entry._mapInited) setTdoaOnMiniMap(entry, tdoa);
}

function updateHeard(entry) {
  const bands = new Set(entry.receivers.values());
  const heardEl = entry.row.querySelector(".c-heard");
  if (heardEl) {
    // A TDOA broadcast takes precedence — it counts network-wide
    // receivers, not just the ones this client is attached to.
    const n = entry.tdoa ? entry.tdoa.quorum : entry.receivers.size;
    heardEl.textContent = `${n} RX · ${Array.from(bands).join("/")}`;
  }
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
          <span>mark / space</span><span>${(+call.markHz || 0).toFixed(0)} / ${(+call.spaceHz || 0).toFixed(0)} Hz</span>
          <span>phasing score</span><span>${call.phasingScore}</span>
        </div>
        <div class="heard-list">heard by: ${Array.from(entry.receivers).map(([rx, band]) => `<span>${escapeHtml(rx)}</span> <em>${band}</em>`).join(", ")}</div>
        <code>${(call.symbols || []).map((s) => s < 0 ? "?" : s).join(" ")}</code>
      </div>
      <div class="mini-map"></div>
    </div>
  `;
  row.addEventListener("click", (e) => {
    if (e.target.closest(".mini-map, a")) return;
    row.classList.toggle("open");
    // initMiniMap itself picks up entry.tdoa inside its RAF, so we
    // don't re-invoke setTdoaOnMiniMap here — the map object doesn't
    // exist yet at this synchronous moment.
    if (row.classList.contains("open")) initMiniMap(entry);
  });
  callsEl.prepend(row);
  while (callsEl.children.length > 200) callsEl.lastChild.remove();

  applyVesselIfCached(callerMmsi);
  return row;
}

// -------------------------------------------------------------------
// GFW vessel rendering
// -------------------------------------------------------------------

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
      const c = entry.row.querySelector(".mini-map");
      if (c) c.classList.add("no-track");
    }
  }
});

// -------------------------------------------------------------------
// Header counter
// -------------------------------------------------------------------

function updateRxCount() {
  const live = Array.from(slots.values()).filter((s) => s.state === "live").length;
  const total = slots.size;
  const region = currentRegion();
  const rx = !total
    ? "connecting…"
    : live === 0
      ? `0 / ${total} stations`
      : `${live} station${live === 1 ? "" : "s"}`;
  const regionPart = region.id === "global" ? "" : ` · ${region.name}`;
  rxCountEl.textContent = rx + regionPart;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// -------------------------------------------------------------------
// CSV export
// -------------------------------------------------------------------

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

// -------------------------------------------------------------------
// Bootstrap
// -------------------------------------------------------------------

if (csvBtn) csvBtn.addEventListener("click", downloadCsv);

if (tdoaOnlyEl) {
  tdoaOnlyEl.addEventListener("change", () => {
    document.body.classList.toggle("tdoa-only", tdoaOnlyEl.checked);
  });
}

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

// Stay attached for the life of the page: iOS aggressively re-suspends
// the AudioContext on tab backgrounding and after long silence, and the
// next gesture has to be able to unlock it again. WebKit only counts
// touchend/pointerup/click/keydown as user activations for audio — not
// touchstart/pointerdown — so listen for the former.
["pointerup", "click", "keydown", "touchend"].forEach((evt) =>
  document.addEventListener(evt, unlockAudio, { passive: true })
);

start();

if (DEBUG) window.skywave = { slots, callIndex, Vessels };
