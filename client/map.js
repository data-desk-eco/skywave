// per-card mini-map, mounted on first expand and redrawn whole on each
// change: the position estimate with its 1σ ellipse, the single latest
// AIS position, a thin line between the two, and the receivers.

const L = window.L, RAD = Math.PI / 180;
// Esri dark gray canvas: no key, no labels
const TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/"
  + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const ATTR = "Esri, HERE, Garmin, &copy; OpenStreetMap";
const ACCENT = getComputedStyle(document.documentElement)
  .getPropertyValue("--accent").trim();
// tooltips are text nodes: receiver labels come from a public list
const text = (...bits) =>
  document.createTextNode(bits.filter(Boolean).join(" · "));
const num = (x, unit, dp = 0) =>
  Number.isFinite(x) && `${x.toFixed(dp)} ${unit}`;

// outline of the 1σ ellipse on the local tangent plane. bearingDeg is
// the major axis, clockwise from north.
function ellipse({ lat, lon, semiMajorKm: a, semiMinorKm: b, bearingDeg }) {
  const s = Math.sin(bearingDeg * RAD), c = Math.cos(bearingDeg * RAD);
  return Array.from({ length: 72 }, (_, i) => {
    const u = a * Math.cos(i * 5 * RAD), v = b * Math.sin(i * 5 * RAD);
    return [lat + (u * c - v * s) / 111.32,
            lon + (u * s + v * c) / 111.32 / Math.cos(lat * RAD)];
  });
}

export function drawMap(e, ais) {
  const el = e.row.querySelector(".mini-map");
  if (!L || !e.row.classList.contains("open")) return;
  if (!e.map) {
    e.map = L.map(el, {
      zoomControl: false, scrollWheelZoom: false, preferCanvas: true,
    }).setView([0, 0], 1);
    L.tileLayer(TILES, { maxZoom: 9, attribution: ATTR })
      .addTo(e.map);
    e.layer = L.layerGroup().addTo(e.map);
  }
  e.map.invalidateSize();
  const g = e.layer.clearLayers(), t = e.tdoa, p = t?.position;
  const line = { color: "#fff", weight: 1, interactive: false };
  const dot = (ll, style, tip) => L.circleMarker(ll, { ...line, ...style })
    .bindTooltip(tip, { direction: "top" }).addTo(g);

  // receivers: solid = decoded, hollow = detected only, faded by weight
  const rx = (t?.receivers || [...e.rx.values()].map((s) => ({ ...s, dec: 1 })))
    .filter((r) => r.gps);
  for (const r of rx) {
    const o = 0.2 + 0.8 * (r.w ?? 1);
    dot(r.gps, { radius: 3, opacity: o, fillColor: "#fff",
                 fillOpacity: r.dec ? o : 0, interactive: true },
        text(r.label, num(r.snrDb, "dB"), num(r.resUs, "µs")));
  }

  const focus = [];
  if (p) {
    const ring = ellipse(p), at = [p.lat, p.lon];
    L.polygon(ring, { ...line, color: ACCENT, fillOpacity: 0.12 }).addTo(g);
    if (ais) L.polyline([at, [ais.lat, ais.lon]],
      { ...line, opacity: 0.6, dashArray: "2 4" }).addTo(g);
    L.marker(at, { icon: L.divIcon({ className: "est", iconSize: [10, 10] }) })
      .bindTooltip(text("estimate", "± " + num(p.semiMajorKm, "km")),
                   { direction: "top" }).addTo(g);
    focus.push(...ring);
  }
  if (ais) {
    const at = [ais.lat, ais.lon];
    dot(at, { radius: 5, fillColor: "#fff", fillOpacity: 1, interactive: true },
        text("AIS", ais.name, num(ais.speed, "kn", 1)));
    focus.push(at);
  }
  if (!p) focus.push(...rx.map((r) => r.gps));

  // refit only when the framed points change, so a redraw keeps the
  // reader's pan and zoom
  const key = focus.join();
  if (key === e.fit || !focus.length) return;
  e.fit = key;
  e.map.fitBounds(focus, { padding: [24, 24], maxZoom: 7 });
}
