// Per-card mini-map — one tiny Leaflet instance, lazy-mounted on first
// expand. Shows the listening receivers (hollow white rings) and, when
// GFW has track data for the caller, the vessel's last known position
// (filled white dot) with a decimated 14-day trail.

import { Vessels } from "./vessels.js";

const TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
const TILE_ATTR = '&copy; <a href="https://carto.com/">carto</a> · OSM';

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
  if (entry._rxMarkers.has(slot.hostKey)) return;
  const L = window.L;
  const m = L.circleMarker(slot.gps, {
    radius: 4, color: "#fff", weight: 1.5, fillColor: "#000", fillOpacity: 1,
  }).bindTooltip(`${slot.bandLabel} · ${slot.label}`, {
    direction: "top", offset: [0, -4],
  });
  m.addTo(entry._map);
  entry._rxMarkers.set(slot.hostKey, m);
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

// TDOA fix marker: a hollow diamond at the solved lat/lon with a
// translucent circle whose radius matches the solver's reported RMS
// timing residual (converted to km). Distinct from the filled-disc
// GFW track marker so both can coexist on the same mini-map when
// available.
export function setTdoaOnMiniMap(entry, tdoa) {
  if (!entry._mapInited || !entry._map || !tdoa || !tdoa.position) return;
  const L = window.L;
  const { lat, lon, residualKm } = tdoa.position;
  const radiusM = Math.max(500, (residualKm || 0) * 1000);

  if (entry._tdoaCircle) entry._map.removeLayer(entry._tdoaCircle);
  entry._tdoaCircle = L.circle([lat, lon], {
    radius: radiusM,
    color: "#fff",
    weight: 1,
    fillColor: "#fff",
    fillOpacity: 0.08,
    opacity: 0.5,
    dashArray: "2 3",
    interactive: false,
  }).addTo(entry._map);

  if (entry._tdoaMarker) {
    entry._tdoaMarker.setLatLng([lat, lon]);
  } else {
    entry._tdoaMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: "tdoa-marker",
        html: '<div class="tdoa-diamond"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
    }).bindTooltip(
      `TDOA fix · ±${(residualKm || 0).toFixed(1)} km · q=${tdoa.quorum}`,
      { direction: "top", offset: [0, -6] },
    );
    entry._tdoaMarker.addTo(entry._map);
  }
  fitMiniMap(entry);
}

function fitMiniMap(entry) {
  const pts = entry.receiverSlots.filter((s) => s.gps).map((s) => s.gps.slice());
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
