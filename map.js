// Per-card mini-map — one tiny Leaflet instance, lazy-mounted on first
// expand, showing the listening receivers that heard the call. Without
// a real-time AIS source the vessel itself isn't plotted, but the
// receiver fan tells you roughly where the ship must have been
// (inside the reception envelope of every dot at once).

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
  // the parent was still `display:none` during the same paint tick.
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
  fitMiniMap(entry);
}

function fitMiniMap(entry) {
  const pts = entry.receiverSlots.filter((s) => s.gps).map((s) => s.gps.slice());
  if (!pts.length) { entry._map.setView([0, 0], 2); return; }
  if (pts.length === 1) { entry._map.setView(pts[0], 5); return; }
  entry._map.fitBounds(pts, { padding: [22, 22], maxZoom: 6 });
}
