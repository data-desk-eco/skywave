// Per-card mini-map — one tiny Leaflet instance, lazy-mounted on first
// expand. Renders three layers:
//   · listening receivers (hollow white rings) — local WS feed
//   · GFW vessel position (filled white dot + 14-day trail) if available
//   · TDOA solved position (hollow diamond + dashed residual circle)
//     with extra receiver rings for cohort members this browser isn't
//     directly attached to.

import { Vessels } from "./vessels.js?v=26";

const TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
const TILE_ATTR = '&copy; <a href="https://carto.com/">carto</a> · OSM';
const RX_STYLE = { radius: 4, color: "#fff", weight: 1.5, fillColor: "#000", fillOpacity: 1 };

function addRxRing(entry, hostKey, gps, tooltip) {
  if (entry._rxMarkers.has(hostKey)) return;
  const m = window.L.circleMarker(gps, RX_STYLE)
    .bindTooltip(tooltip, { direction: "top", offset: [0, -4] });
  m.addTo(entry._map);
  entry._rxMarkers.set(hostKey, m);
}

export function initMiniMap(entry) {
  if (entry._mapInited || !window.L) {
    if (entry._map) entry._map.invalidateSize();
    return;
  }
  const container = entry.row.querySelector(".mini-map");
  if (!container) return;
  entry._mapInited = true;
  // Wait one frame so the browser has painted the now-open card; Leaflet
  // reads the container size at init time and produces a 0×0 map if
  // the parent was still display:none during the same paint tick.
  requestAnimationFrame(() => {
    const L = window.L;
    entry._map = L.map(container, {
      zoomControl: false,
      attributionControl: true,
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: true,
      touchZoom: true,
      preferCanvas: true,
    });
    L.tileLayer(TILE_URL, { subdomains: "abcd", maxZoom: 9, attribution: TILE_ATTR })
      .addTo(entry._map);

    for (const slot of entry.receiverSlots) addReceiverToMiniMap(entry, slot);
    const info = Vessels.get(entry.call.caller);
    if (info && info.lastPos) setVesselOnMiniMap(entry, info);
    else if (info && info.vesselId) container.classList.add("no-track");
    // Draw TDOA last so the diamond paints above the GFW disc. Users
    // are watching this app for the passive radio-triangulation result,
    // not the GFW track — TDOA wins the z-order contest.
    if (entry.tdoa) setTdoaOnMiniMap(entry, entry.tdoa);
    fitMiniMap(entry);
    setTimeout(() => entry._map && entry._map.invalidateSize(), 120);
  });
}

export function addReceiverToMiniMap(entry, slot) {
  if (!entry._mapInited || !slot.gps) return;
  addRxRing(entry, slot.hostKey, slot.gps, `${slot.bandLabel} · ${slot.label}`);
  if (entry._vesselMarker) drawReceiverLines(entry);
  fitMiniMap(entry);
}

export function setVesselOnMiniMap(entry, info) {
  if (!entry._mapInited || !info || !info.lastPos) return;
  const L = window.L;
  const { lat, lon } = info.lastPos;

  const container = entry.row.querySelector(".mini-map");
  if (container) container.classList.remove("no-track");

  if (info.trail && info.trail.length > 1) {
    if (entry._trail) entry._map.removeLayer(entry._trail);
    entry._trail = L.polyline(info.trail.map(([x, y]) => [y, x]), {
      color: "#fff", weight: 1, opacity: 0.35, lineCap: "round",
    }).addTo(entry._map);
  }

  if (entry._vesselMarker) {
    entry._vesselMarker.setLatLng([lat, lon]);
  } else {
    entry._vesselMarker = L.circleMarker([lat, lon], {
      radius: 5, color: "#fff", weight: 1.5, fillColor: "#fff", fillOpacity: 0.85,
    }).bindTooltip(info.name || `MMSI ${entry.call.caller}`, {
      direction: "top", offset: [0, -5],
    });
    entry._vesselMarker.addTo(entry._map);
  }

  drawReceiverLines(entry);
  fitMiniMap(entry);
}

function drawReceiverLines(entry) {
  const L = window.L;
  for (const l of entry._rxLines || []) entry._map.removeLayer(l);
  entry._rxLines = [];
  if (!entry._vesselMarker) return;
  const vll = entry._vesselMarker.getLatLng();
  for (const slot of entry.receiverSlots) {
    if (!slot.gps) continue;
    const line = L.polyline([slot.gps, [vll.lat, vll.lng]], {
      color: "#fff", weight: 1, opacity: 0.3, dashArray: "2 3",
    }).addTo(entry._map);
    entry._rxLines.push(line);
  }
}

// TDOA fix: hollow diamond at the solved position with a translucent
// dashed circle sized by the solver's residual. Also adds receiver
// rings for any cohort members this browser isn't directly attached
// to — the TDOA quorum is authoritative about who heard the packet,
// the local WS feed may have missed some.
export function setTdoaOnMiniMap(entry, tdoa) {
  if (!entry._mapInited || !entry._map || !tdoa || !tdoa.position) return;
  const L = window.L;
  const { lat, lon, residualKm } = tdoa.position;

  for (const r of tdoa.receivers || []) {
    if (!r || !Array.isArray(r.gps) || typeof r.slot !== "string") continue;
    const hostKey = r.slot.split("|")[0];
    addRxRing(entry, hostKey, r.gps, r.slot.replace("|", " · "));
  }

  const isPrelim = tdoa.tier === "preliminary";

  // Preliminary fixes (q=3, no residual check) get a translucent ring at
  // a fixed "nominal uncertainty" of 50 km so the visual doesn't imply a
  // precision we can't verify. Confirmed fixes size the ring from the
  // solver residual as before.
  if (entry._tdoaCircle) entry._map.removeLayer(entry._tdoaCircle);
  entry._tdoaCircle = L.circle([lat, lon], {
    radius: isPrelim ? 50_000 : Math.max(500, (residualKm || 0) * 1000),
    color: "#fff", weight: 1, opacity: isPrelim ? 0.3 : 0.5, dashArray: "2 3",
    fillColor: "#fff", fillOpacity: isPrelim ? 0.04 : 0.08,
    interactive: false,
  }).addTo(entry._map);

  if (entry._tdoaMarker) {
    entry._tdoaMarker.setLatLng([lat, lon]);
  } else {
    entry._tdoaMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: isPrelim ? "tdoa-marker tdoa-prelim" : "tdoa-marker",
        html: '<div class="tdoa-diamond"></div>',
        iconSize: [14, 14], iconAnchor: [7, 7],
      }),
    }).bindTooltip(
      isPrelim
        ? `TDOA fix · preliminary · q=${tdoa.quorum} · max-gap ${tdoa.geometry?.maxBearingGapDeg?.toFixed(0) ?? "?"}°`
        : `TDOA fix · ±${(residualKm || 0).toFixed(1)} km · q=${tdoa.quorum}`,
      { direction: "top", offset: [0, -6] },
    );
    entry._tdoaMarker.addTo(entry._map);
  }
  fitMiniMap(entry);
}

function fitMiniMap(entry) {
  // Use every placed receiver marker, local or TDOA-contributed —
  // that gives the map a bounds encompassing the full cohort, not
  // just the subset this browser is attached to.
  const pts = [];
  for (const m of entry._rxMarkers.values()) {
    const ll = m.getLatLng();
    pts.push([ll.lat, ll.lng]);
  }
  if (entry._vesselMarker) {
    const v = entry._vesselMarker.getLatLng();
    pts.push([v.lat, v.lng]);
  }
  if (entry._tdoaMarker) {
    const t = entry._tdoaMarker.getLatLng();
    pts.push([t.lat, t.lng]);
  }
  if (!pts.length) { entry._map.setView([0, 0], 2); return; }
  if (pts.length === 1) { entry._map.setView(pts[0], 5); return; }
  entry._map.fitBounds(pts, { padding: [22, 22], maxZoom: 6 });
}
