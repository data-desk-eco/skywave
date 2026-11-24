// skywave client: a pure viewer. the server tunes the receivers, decodes
// DSC and locates ships; this module reads one server-sent-events
// stream per page (`/v2/events?region=`) and prints what it says:
// the rack, per-slot status, decoded calls, position estimates, and
// audio for the one slot it follows (the loudest live burst, chosen
// here and told to the server with POST `/v2/follow`).

import { Vessels, GATEWAY } from "./vessels.js?v=40";
import { drawMap } from "./map.js?v=40";
import { REGIONS, REGION_STORAGE_KEY, currentRegion, midIso }
  from "./regions.js?v=41";

const DEBUG = /(\?|&)debug=1\b/.test(location.search);
const AUDIO_LEAD_SEC = 0.25;
const AUDIO_HOLD_MS  = 6000;

const $ = (id) => document.getElementById(id);
const rxCountEl = $("rxcount"), playingEl = $("playing"),
      callsEl = $("calls"), emptyEl = $("empty"),
      csvBtn = $("csv"), regionEl = $("region"),
      tdoaOnlyEl = $("tdoa-only");

// -------------------------------------------------------------------
// State
// -------------------------------------------------------------------

/** "host:port|band" → { slot, band, label, gps, state, rssi, lastBurstAt } */
const slots = new Map();
/** Cross-slot dedupe: sig → { firstSeen, call, rx, row } */
const callIndex = new Map();
/** MMSI → latest position estimate */
const tdoaByMmsi = new Map();
const key = (s) => `${s.slot}|${s.band}`;
let es = null;
let clientId = null;
let audioCtx = null;
let destinationGain = null;
let audioEl = null;
let nextStart = 0;
let audioFollowKey = null;
let audioUnlocked = false;

// -------------------------------------------------------------------
// Event stream. EventSource reconnects by itself; every (re)connect
// starts with `hello` (a fresh client id) and `rack`.
// -------------------------------------------------------------------

const handlers = {
  hello(m) {
    clientId = m.id;
    audioFollowKey = null;              // the server forgot our follow
  },
  rack(m) {
    const old = new Map(slots);
    slots.clear();
    for (const s of m.slots) slots.set(key(s), old.get(key(s))
      || { ...s, state: "idle", rssi: -127, lastBurstAt: 0 });
    reconsiderAudio();
    updateRxCount();
    if (!slots.size) rxCountEl.textContent = "no receivers in this region";
  },
  status(m) {
    const s = slots.get(key(m));
    if (!s) return;
    if (typeof m.rssi === "number") s.rssi = m.rssi;
    if (m.state === "burst") s.lastBurstAt = performance.now();
    s.state = m.state === "burst" ? "live" : m.state;
    reconsiderAudio();
    updateRxCount();
  },
  call(m) { if (m.call) dispatchCall(m); },
  tdoa(m) {
    if (!m.mmsi || !m.position) return;
    tdoaByMmsi.set(m.mmsi, m);
    renderMmsi(m.mmsi);
  },
  audio(m) { if (key(m) === audioFollowKey) playAudio(m); },
};

function stop() {
  es?.close();
  es = clientId = audioFollowKey = null;
  slots.clear();
  updatePlayingLabel();
}

function start() {
  stop();
  callIndex.clear();
  callsEl.innerHTML = "";
  emptyEl.hidden = false;
  if (!GATEWAY) return void (rxCountEl.textContent = "no gateway");
  rxCountEl.textContent = "connecting…";
  es = new EventSource(
    `${GATEWAY}/v2/events?region=${encodeURIComponent(currentRegion().id)}`);
  es.onerror = () => { rxCountEl.textContent = "reconnecting…"; };
  for (const [name, fn] of Object.entries(handlers))
    es.addEventListener(name, (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (DEBUG && name !== "audio" && name !== "status") console.log(name, m);
      fn(m);
    });
}

// -------------------------------------------------------------------
// Audio picker: follow the loudest live burst
// -------------------------------------------------------------------

function follow(s) {
  audioFollowKey = s ? key(s) : null;
  if (!clientId) return;
  const q = s ? `${encodeURIComponent(s.slot)}&band=${s.band}` : "none";
  fetch(`${GATEWAY}/v2/follow?id=${clientId}&slot=${q}`, { method: "POST" })
    .catch(() => {});
}

function reconsiderAudio() {
  const now = performance.now();
  let best = null, bestScore = -Infinity;
  for (const s of slots.values()) {
    const fresh = now - s.lastBurstAt;
    if (s.state !== "live" || fresh > AUDIO_HOLD_MS) continue;
    const score = Math.min(1, Math.max(0, (s.rssi + 110) / 80)) - fresh / 1e6;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  if ((best ? key(best) : null) !== audioFollowKey) {
    follow(best);
    if (best && audioCtx) nextStart = audioCtx.currentTime + AUDIO_LEAD_SEC;
  }
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
  const label = `${conn.band} · ${conn.label}`;
  const ctxReady = audioCtx && audioCtx.state === "running" && audioUnlocked;
  const elReady  = !audioEl || !audioEl.paused;
  if (ctxReady && elReady) {
    playingEl.textContent = label;
    playingEl.classList.add("on");
  } else {
    playingEl.textContent = NEEDS_TAP_HINT
      ? `tap to enable audio · ${label}` : label;
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
  if (nextStart < audioCtx.currentTime - 0.5)
    nextStart = audioCtx.currentTime + AUDIO_LEAD_SEC;
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
// -------------------------------------------------------------------
// Call dedupe + rendering
// -------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt()};`);
const hms = (ms) => new Date(ms).toISOString().slice(11, 19) + "Z";
const km = (x) => x.toFixed(x < 10 ? 1 : 0);
const coord = (p) => `${p.lat.toFixed(3)}°, ${p.lon.toFixed(3)}°`;
const age = (min) => min < 90 ? `${Math.round(min)} min`
  : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
const distKm = (a, b) => {
  const r = Math.PI / 180, h = (x) => Math.sin(x * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h(b.lat - a.lat)
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * h(b.lon - a.lon)));
};
const callSig = (c) => [c.formatCode, c.destination, c.caller,
  c.tc1Code, c.tc2Code, c.eos].join("|");
const dest = (c) => c.destination || (c.formatCode === 112 ? "all ships" : "");
const heardBy = (e) => [...e.rx.values()].map((r) => [r.label, r.band]);
// the one AIS position we hold for a ship: the estimate's own, else
// the lazy lookup made when the card opens
const aisOf = (e) => e.tdoa?.ais || Vessels.ais(e.call.caller);
const NIGHT = `<span class="tag" title="night: skywave paths, `
  + `coarser estimate">night</span>`;

function dispatchCall(m) {
  const { call } = m, sig = callSig(call), now = Date.now();
  let e = callIndex.get(sig);
  if (e && now - e.firstSeen < 120_000) {
    e.rx.set(key(m), m);
    return render(e);
  }
  e = { firstSeen: now, call, rx: new Map([[key(m), m]]) };
  callIndex.set(sig, e);
  addCallRow(e);
  Vessels.lookup(call.caller);
  for (const [k, v] of callIndex)
    if (now - v.firstSeen > 600_000) callIndex.delete(k);
}

const renderMmsi = (mmsi) => {
  for (const e of callIndex.values()) if (e.call.caller === mmsi) render(e);
};
Vessels.onUpdate(renderMmsi);

// everything on a card that can change after it is first printed
function render(e) {
  const { row, call: { caller } } = e, q = (s) => row.querySelector(s);
  const t = e.tdoa = tdoaByMmsi.get(caller), p = t?.session ?? t?.position;
  const dots = (a) => a.filter(Boolean).join(" · ");
  const v = Vessels.get(caller) || {}, a = aisOf(e);
  const bands = [...new Set(heardBy(e).map(([, b]) => b))].join("/");

  row.classList.toggle("has-tdoa", !!p);
  q(".name").textContent = v.name || a?.name || `MMSI ${caller || "—"}`;
  q(".name").title = v.type || "";
  q(".c-heard").textContent =
    `${t?.quality?.receivers ?? t?.quorum ?? e.rx.size} rx · ${bands}`;

  q(".vessel").innerHTML = [
    v.flag || midIso(caller), v.type, v.callsign, v.imo && `IMO ${v.imo}`,
  ].filter(Boolean).map((s) => `<span>${esc(s)}</span>`).join("");

  const rows = [];
  if (p) {
    const { receivers = t.quorum, decoders, night } = t.quality || {};
    const c = t.convergence;
    rows.push(["estimate", coord(p), dots([
      `± ${km(p.err68Km ?? p.semiMajorKm)} km`,
      p.bursts && `${p.bursts} bursts`,
      receivers + " rx" + (decoders == null ? "" : `, ${decoders} decoded`),
      hms(t.broadcastMs),
      c?.fixCount > 1 && `${c.agreeCount}/${c.fixCount} converging`,
      night && NIGHT,
    ])]);
  }
  if (a) {
    const min = a.ageMin ?? (a.ts ? (Date.now() - a.ts) / 60_000 : null);
    rows.push(["AIS", coord(a), dots([
      p && `Δ ${km(t.session ? distKm(p, a) : a.km ?? distKm(p, a))} km`,
      min != null && `${age(min)} old`,
      Number.isFinite(a.speed) && `${a.speed.toFixed(1)} kn`,
    ])]);
  }
  q(".pos").innerHTML = rows.map(([k, at, meta]) =>
    `<span>${k}</span><span><b class="${k}">${at}</b> ${meta}</span>`)
    .join("");

  q(".heard-list").innerHTML = "heard by: " + heardBy(e).map(([rx, band]) =>
    `<span>${esc(rx)}</span> ${band}`).join(", ");
  drawMap(e, a);
}

function addCallRow(e) {
  const c = e.call, row = e.row = document.createElement("div");
  const cat = { 112: "distress", 110: "urgency", 108: "safety" }[
    c.categoryCode];
  const tc1 = c.tc1 && c.tc1 !== "?" ? c.tc1 : null;
  const tc2 = c.tc2 && c.tc2 !== "?" && c.tc2 !== c.tc1 ? c.tc2 : null;
  const kv = [
    ["MMSI", c.caller || "—"],
    ["format", `${c.format} (${c.formatCode})`],
    ["category", c.category || "?"],
    ["telecommand 1", tc1],
    ["telecommand 2", tc2],
    ["EOS", c.eos],
    ["ECC", c.ecc_valid ? "ok" : "—"],
    ["mark / space",
      `${(+c.markHz || 0).toFixed(0)} / ${(+c.spaceHz || 0).toFixed(0)} Hz`],
    ["phasing score", c.phasingScore],
  ].filter(([, v]) => v != null)
    .map(([k, v]) => `<span>${k}</span><span>${esc(v)}</span>`).join("");

  row.className = "call" + (cat ? " " + cat : "");
  row.innerHTML = `
    <span class="c-t">${hms(e.firstSeen)}</span>
    <span class="c-who"><span class="name"></span><span
      class="flag">${midIso(c.caller)}</span></span>
    <span class="c-flow">→ ${esc(dest(c) || "—")}</span>
    <span class="c-pay">${[c.category || "?", tc1, tc2, c.eos]
      .filter(Boolean).map(esc).join(" · ")}</span>
    <span class="c-heard"></span>
    <div class="call-detail">
      <div class="detail-text">
        <div class="vessel"></div>
        <div class="kv"><div class="pos"></div>${kv}</div>
        <div class="heard-list"></div>
        <code>${(c.symbols || []).map((s) => s < 0 ? "?" : s).join(" ")}</code>
      </div>
      <div class="mini-map"></div>
    </div>`;
  row.addEventListener("click", (ev) => {
    if (ev.target.closest(".mini-map, a")) return;
    if (!row.classList.toggle("open")) return;
    if (!e.tdoa?.ais) Vessels.fetchAis(c.caller);
    render(e);
  });
  emptyEl.hidden = true;
  callsEl.prepend(row);
  while (callsEl.children.length > 200) callsEl.lastChild.remove();
  render(e);
}

// -------------------------------------------------------------------
// Header counter
// -------------------------------------------------------------------

function updateRxCount() {
  const live = [...slots.values()].filter((s) => s.state === "live").length;
  const total = slots.size, region = currentRegion();
  rxCountEl.textContent = (!total ? "connecting…"
    : live ? `${live} station${live === 1 ? "" : "s"}`
    : `0 / ${total} stations`)
    + (region.id === "global" ? "" : ` · ${region.name}`);
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
    "est_lat", "est_lon", "est_semi_major_km",
  ];
  const cell = (v) => /[",\n\r]/.test(v = String(v ?? ""))
    ? `"${v.replace(/"/g, '""')}"` : v;
  const rows = [...callIndex.values()]
    .sort((a, b) => a.firstSeen - b.firstSeen).map((e) => {
      const c = e.call, v = Vessels.get(c.caller) || {}, p = e.tdoa?.position;
      return [
        new Date(e.firstSeen).toISOString(), c.caller, v.name,
        v.flag || midIso(c.caller), v.type, dest(c), c.format, c.category,
        c.tc1, c.tc2, c.eos, c.markHz?.toFixed(0), c.spaceHz?.toFixed(0),
        c.phasingScore, e.rx.size, heardBy(e)[0][1],
        heardBy(e).map(([rx, band]) => `${rx} (${band})`).join("; "),
        p?.lat, p?.lon, p?.semiMajorKm,
      ].map(cell).join(",");
    });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([[cols, ...rows].join("\n")], { type: "text/csv;charset=utf-8" }));
  a.download = `skywave-${new Date().toISOString().slice(0, 19)
    .replace(/:/g, "-")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// -------------------------------------------------------------------
// Bootstrap
// -------------------------------------------------------------------

csvBtn.addEventListener("click", downloadCsv);
tdoaOnlyEl.addEventListener("change", () =>
  document.body.classList.toggle("tdoa-only", tdoaOnlyEl.checked));

for (const r of REGIONS) regionEl.add(new Option(r.name, r.id));
regionEl.value = currentRegion().id;
regionEl.addEventListener("change", () => {
  localStorage.setItem(REGION_STORAGE_KEY, regionEl.value);
  start();
});

// Stay attached for the life of the page: iOS aggressively re-suspends
// the AudioContext on tab backgrounding and after long silence, and the
// next gesture has to be able to unlock it again. WebKit only counts
// touchend/pointerup/click/keydown as user activations for audio — not
// touchstart/pointerdown — so listen for the former.
["pointerup", "click", "keydown", "touchend"].forEach((evt) =>
  document.addEventListener(evt, unlockAudio, { passive: true })
);

start();

if (DEBUG) window.skywave = { slots, callIndex, tdoaByMmsi, Vessels, handlers };
