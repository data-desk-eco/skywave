// Detections map — plots the 2026-07-02/03 ground-truth campaign: the 7
// gate-surviving TDOA fixes (amber diamonds + 1σ ellipse + AIS-truth line)
// against the ~937 suppressed ghosts, coloured by the gate that killed
// each one. Static file first (detections-data.json); optional live poll
// of /v2/tdoa/recent. Pure Leaflet, no build step. See map.html + brief.

const L = window.L;
const GW = document.querySelector('meta[name="skywave-gateway"]').content;
const TILE = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";

// One muted hue per gate — the ghosts are the visual mass, kept secondary
// to the amber fixes. Ordered by how many the campaign produced.
const GATES = {
  farfield: { c: "#c65f6b", label: "far-field" },
  edge:     { c: "#8d7bc0", label: "edge" },
  residual: { c: "#5b86b0", label: "residual" },
  bearing:  { c: "#4f9a8f", label: "bearing gap" },
  registry: { c: "#b8894f", label: "registry" },
  ellipse:  { c: "#b06a9c", label: "ellipse" },
};
const SRC_LABEL = {
  "channel-mf-night": "Channel MF · night",
  "channel-mf-day":   "Channel MF · day",
  "global-hf":        "Global HF",
  "us-east-mf":       "US East MF",
};
const ACCENT = "#ffb000";

const map = L.map("map", { zoomControl: true, preferCanvas: true, worldCopyJump: true })
  .setView([50.5, 0], 6);
L.control.scale({ imperial: false }).addTo(map);
L.tileLayer(TILE, { subdomains: "abcd", maxZoom: 12, attribution: '&copy; <a href="https://carto.com/">carto</a> · OSM · Skywave' })
  .addTo(map);

const cohortLayer = L.layerGroup().addTo(map); // receiver lines for the selected marker
const items = [];   // { marker, extra:[layers], kind, gate, src, visible() }
const state = { fixes: true, rejects: true, receivers: true, registry: true, src: "all", live: false };
const gateOn = Object.fromEntries(Object.keys(GATES).map(g => [g, true]));

// -- geo helpers --------------------------------------------------------
const R = 111.32;
function offset(lat, lon, northKm, eastKm) {
  return [lat + northKm / R, lon + eastKm / (R * Math.cos(lat * Math.PI / 180))];
}
// 1σ error ellipse as a polygon. degAz = azimuth of the semi-major axis
// from north, clockwise (as tdoaUncertainty reports it).
function ellipse(lat, lon, aKm, bKm, degAz) {
  const th = degAz * Math.PI / 180, ring = [];
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * 2 * Math.PI, ca = aKm * Math.cos(t), cb = bKm * Math.sin(t);
    const north = ca * Math.cos(th) - cb * Math.sin(th);
    const east = ca * Math.sin(th) + cb * Math.cos(th);
    ring.push(offset(lat, lon, north, east));
  }
  return ring;
}
const km = v => (v == null ? "?" : v < 10 ? v.toFixed(1) : Math.round(v));

// -- cohort lines on selection -----------------------------------------
function showCohort(rec) {
  cohortLayer.clearLayers();
  for (const r of rec.receivers || []) {
    if (!r || !Array.isArray(r.gps)) continue;
    L.polyline([[rec.lat, rec.lon], r.gps], { color: "#fff", weight: 1, opacity: 0.28, dashArray: "2 3", interactive: false }).addTo(cohortLayer);
    L.circleMarker(r.gps, { radius: 3, color: "#fff", weight: 1, opacity: 0.6, fillOpacity: 0, interactive: false }).addTo(cohortLayer);
  }
}

// -- popups -------------------------------------------------------------
function fixPopup(f, ghost) {
  const gate = ghost ? `<br><span class="k">killed by</span> <b style="color:${GATES[f.gate].c}">${GATES[f.gate].label}</b>` : "";
  const ell = f.ellipseKm != null ? `<br><span class="k">1σ ellipse</span> ${km(f.ellipseKm)}×${km(f.ellipseMinorKm)} km @${Math.round(f.ellipseDeg)}°` : "";
  const ff = f.farfieldRatio != null ? ` · <span class="k">ff</span> ${f.farfieldRatio.toFixed(2)}` : "";
  const truth = f.truth ? `<br><span class="k">AIS truth</span> ${km(f.truth.errKm)} km off${f.truth.stationary ? " · stationary ✓" : " · moving ~"}` : "";
  return `<b>${ghost ? "✕ ghost" : "◆ fix"}</b> · MMSI ${f.mmsi}${f.name ? " · " + f.name : ""}`
    + `<br><span class="k">${f.regime} · q=${f.q} · ${SRC_LABEL[f.src] || f.src}</span>`
    + `<br><span class="k">pos</span> ${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}`
    + `<br><span class="k">residual</span> ${km(f.residualKm)} km${ff}${ell}${gate}${truth}`;
}

// -- build markers ------------------------------------------------------
function addRecord(rec, ghost) {
  const extra = [];
  const marker = ghost
    ? L.circleMarker([rec.lat, rec.lon], { radius: 4, color: GATES[rec.gate].c, weight: 1.2, opacity: 0.75, fillColor: GATES[rec.gate].c, fillOpacity: 0.12 })
    : L.marker([rec.lat, rec.lon], { icon: L.divIcon({ className: "fix-marker", html: '<div class="fix-diamond"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), zIndexOffset: 1000 });
  marker.bindPopup(fixPopup(rec, ghost));
  marker.on("click", () => showCohort(rec));

  if (!ghost && rec.ellipseKm) {
    extra.push(L.polygon(ellipse(rec.lat, rec.lon, rec.ellipseKm, rec.ellipseMinorKm, rec.ellipseDeg),
      { color: ACCENT, weight: 1, opacity: 0.4, dashArray: "3 4", fillColor: ACCENT, fillOpacity: 0.04, interactive: false }));
  }
  if (!ghost && rec.truth) {
    const st = rec.truth.stationary;
    extra.push(L.polyline([[rec.lat, rec.lon], [rec.truth.lat, rec.truth.lon]],
      { color: "#fff", weight: 1.5, opacity: st ? 0.7 : 0.35, dashArray: st ? null : "4 4", interactive: false }));
    extra.push(L.circleMarker([rec.truth.lat, rec.truth.lon],
      { radius: 4, color: "#fff", weight: 1.5, fillColor: "#000", fillOpacity: 1 })
      .bindTooltip(`AIS truth${st ? " (stationary)" : " (moving)"} · ${km(rec.truth.errKm)} km`, { direction: "top" }));
  }
  items.push({ marker, extra, kind: ghost ? "reject" : "fix", gate: rec.gate, src: rec.src });
}

const rxLayer = L.layerGroup(), regLayer = L.layerGroup();
function addReceivers(list) {
  for (const r of list) {
    if (!Array.isArray(r.gps)) continue;
    L.circleMarker(r.gps, { radius: 2.5, color: "#fff", weight: 1, opacity: 0.45, fillOpacity: 0 })
      .bindTooltip(`${r.band} · ${r.label}`, { direction: "top" }).addTo(rxLayer);
  }
}
function addRegistry(list) {
  for (const s of list) for (const site of s.sites || []) {
    L.marker(site, { icon: L.divIcon({ className: "fix-marker", html: '<div style="width:8px;height:8px;border:1.5px solid #fff;transform:rotate(45deg);margin:2px"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }) })
      .bindTooltip(`⚓ ${s.name} · ${s.mmsi}`, { direction: "top" }).addTo(regLayer);
  }
}

// -- visibility --------------------------------------------------------
function render() {
  for (const it of items) {
    const vis = it.src && (state.src === "all" || it.src === state.src)
      && (it.kind === "fix" ? state.fixes : state.rejects && gateOn[it.gate]);
    const on = map.hasLayer(it.marker);
    if (vis && !on) { it.marker.addTo(map); it.extra.forEach(l => l.addTo(map)); }
    else if (!vis && on) { map.removeLayer(it.marker); it.extra.forEach(l => map.removeLayer(l)); }
  }
  toggle(rxLayer, state.receivers);
  toggle(regLayer, state.registry);
}
const toggle = (layer, on) => on ? layer.addTo(map) : map.removeLayer(layer);

// -- controls UI -------------------------------------------------------
function rowEl(id, swatch, name, count, on, onToggle, sq) {
  const el = document.createElement("label");
  el.className = "row " + (on ? "on" : "off");
  const sw = swatch === "chk"
    ? `<span class="chk"></span>`
    : `<span class="swatch${sq ? " sq" : ""}" style="background:${swatch};border-color:${swatch}"></span>`;
  el.innerHTML = `${sw}<span class="rname">${name}</span>${count != null ? `<span class="cnt">${count}</span>` : ""}`;
  el.addEventListener("click", e => { e.preventDefault(); const now = onToggle(); el.classList.toggle("on", now); el.classList.toggle("off", !now); });
  return el;
}
function groupEl(label, right) {
  const g = document.createElement("div"); g.className = "group";
  g.innerHTML = `<div class="glabel"><span>${label}</span><span>${right || ""}</span></div>`;
  return g;
}

function buildControls(data) {
  const c = document.getElementById("controls");
  const nFix = data.fixes.length, nRej = data.rejects.length;

  // solved
  const gf = groupEl("Solved fixes", `${nFix}`);
  gf.appendChild(rowEl(0, ACCENT, "Show fixes", nFix, state.fixes, () => (state.fixes = !state.fixes, render(), state.fixes), true));
  c.appendChild(gf);

  // suppressed, per gate
  const counts = {}; for (const r of data.rejects) counts[r.gate] = (counts[r.gate] || 0) + 1;
  const gr = groupEl("Suppressed ghosts", `${nRej}`);
  gr.appendChild(rowEl(0, "chk", "All suppressed", null, state.rejects, () => {
    state.rejects = !state.rejects; render();
    gr.querySelectorAll(".gaterow").forEach(x => x.style.opacity = state.rejects ? 1 : 0.4);
    return state.rejects;
  }));
  for (const g of Object.keys(GATES)) {
    if (!counts[g]) continue;
    const row = rowEl(0, GATES[g].c, GATES[g].label, counts[g], gateOn[g], () => (gateOn[g] = !gateOn[g], render(), gateOn[g]));
    row.classList.add("gaterow");
    gr.appendChild(row);
  }
  c.appendChild(gr);

  // reference layers
  const gl = groupEl("Reference");
  gl.appendChild(rowEl(0, "#fff", "Receivers", data.receivers.length, state.receivers, () => (state.receivers = !state.receivers, render(), state.receivers)));
  gl.appendChild(rowEl(0, "#fff", "⚓ Coast stations", data.registry.length, state.registry, () => (state.registry = !state.registry, render(), state.registry), true));
  c.appendChild(gl);

  // src filter
  const gs = groupEl("Capture");
  const sel = document.createElement("select");
  const srcs = [...new Set([...data.fixes, ...data.rejects].map(r => r.src))];
  sel.innerHTML = `<option value="all">all captures</option>` + srcs.map(s => `<option value="${s}">${SRC_LABEL[s] || s}</option>`).join("");
  sel.addEventListener("change", () => { state.src = sel.value; render(); });
  gs.appendChild(sel);
  c.appendChild(gs);

  // live
  const glv = groupEl("Live");
  const lv = rowEl(0, "chk", "Poll /tdoa/recent", null, false, () => (setLive(!state.live), state.live));
  lv.querySelector(".rname").insertAdjacentHTML("afterend", '<span class="live-dot" id="livedot"></span>');
  glv.appendChild(lv);
  c.appendChild(glv);
}

// -- live mode (secondary) ---------------------------------------------
const liveLayer = L.layerGroup();
let liveTimer = null;
function setLive(on) {
  state.live = on;
  document.getElementById("livedot").classList.toggle("armed", on);
  if (on) { liveLayer.addTo(map); pollLive(); liveTimer = setInterval(pollLive, 10000); }
  else { clearInterval(liveTimer); liveLayer.clearLayers(); map.removeLayer(liveLayer); }
}
async function pollLive() {
  try {
    const r = await fetch(`${GW}/v2/tdoa/recent`, { cache: "no-store" });
    const j = await r.json();
    liveLayer.clearLayers();
    for (const s of j.recentSolves || []) {
      const p = s.position || s; if (typeof p.lat !== "number") continue;
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "fix-marker", html: '<div class="fix-diamond" style="background:#fff;box-shadow:0 0 6px #fff"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) })
        .bindTooltip(`LIVE fix · MMSI ${s.mmsi || "?"} · ±${km(p.residualKm)} km`, { direction: "top" }).addTo(liveLayer);
    }
  } catch { /* live is best-effort; static file is the deliverable */ }
}

// -- boot --------------------------------------------------------------
(async () => {
  const data = await (await fetch("detections-data.json", { cache: "no-store" })).json();
  data.fixes.forEach(f => addRecord(f, false));
  data.rejects.forEach(r => addRecord(r, true));
  addReceivers(data.receivers);
  addRegistry(data.registry);
  buildControls(data);
  render();
  document.getElementById("subtitle").innerHTML =
    `<b style="color:${ACCENT}">${data.fixes.length}</b> fixes survived the gates · `
    + `<b>${data.rejects.length}</b> ghosts suppressed. The ghost geography is the story — `
    + `<a href="index.html">live monitor →</a>`;
  // frame on the campaign's fixes; the ghosts sprawl wider but the jewels anchor the view
  const pts = data.fixes.map(f => [f.lat, f.lon]);
  if (pts.length) map.fitBounds(pts, { padding: [120, 120], maxZoom: 7 });
})();

document.getElementById("panel-toggle").addEventListener("click", () =>
  document.getElementById("panel").classList.toggle("open"));
