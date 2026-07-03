# Brief: detections map view (incl. suppressed fixes)

Build a web map that plots the DSC TDOA results from our 2026-07-02/03
ground-truth campaign — the solved fixes **and** the suppressed
(gate-rejected) ghosts — over a world map. The point of showing the
suppressed fixes is the whole story of this project: only 7 of ~940
computed fixes survived the gates; seeing the 937 ghosts land in empty
ocean / across continents next to the handful of real fixes (and their
LSEG-AIS truth points) is what makes the gate stack legible.

## Data — one static file, already generated

**`client/detections-data.json`** (~500 KB, committed). Load it with
`fetch('detections-data.json')` — no endpoint, no auth, no polling.
Regenerate anytime with `node --max-old-space-size=6144
scripts/build_map_data.mjs` (it replays the session captures through the
production coordinator). Shape:

```
{
  generatedMs, note,
  registry: [ { mmsi, name, sites:[[lat,lon],...] } ],   // coast stations (truth)
  receivers: [ { host, label, gps:[lat,lon], band } ],   // the rack
  fixes:   [ Fix ],     // PASSED every gate — 7 of them
  rejects: [ Reject ],  // SUPPRESSED ghosts — ~937, colour by .gate
}
```

**Fix** = `{ src, mmsi, name, regime, q, lat, lon, residualKm,
ellipseKm, ellipseMinorKm, ellipseDeg, farfieldRatio,
receivers:[{slot,gps:[lat,lon]}], truth:{lat,lon,errKm,stationary}|null,
ms }`. `truth` is the vessel's LSEG AIS position at fix time (join line
from `[lat,lon]` to `truth` to show the error); trust it as ground
truth only when `truth.stationary` (vessel drifted <2 km across polls —
otherwise `errKm` is a loose upper bound, could be stale AIS).

**Reject** = same shape plus `gate` (∈ `residual · edge · farfield ·
registry · bearing · ellipse`) = the reason it was killed, and no
ellipse fields. `src` ∈ `channel-mf-night · channel-mf-day · global-hf
· us-east-mf` — the capture it came from (good as a filter).

`worker/src/coast-registry.js` is the source of the `registry` block if
you want richer station metadata.

### Live mode (optional, secondary)

The same fields are also served live at
`GET https://skywave-gateway.louis-6bf.workers.dev/v2/tdoa/recent`
(CORS-open) as `{recentDetections, recentSolves, recentRejects,
rejections}` — poll every ~10 s if you want a "now" view. But the static
file is the primary deliverable; the campaign data is the story.

## What to draw

- Solved `fixes` as the accent-colour diamonds (match the existing
  client's one-accent monochrome look — see `styles.css`,
  `favicon.svg`, JetBrains Mono). Draw the 1σ error ellipse from
  `ellipseKm`/`ellipseMinorKm`/`ellipseDeg` — it's honest and visually
  central to the "how sure are we" story (e.g. the STENBERG fix's
  335 km semi-major correctly predicted its 103 km miss).
- Suppressed `rejects` as muted/hollow markers, coloured or icon-coded
  by `gate`. A toggle per gate (and a solved/suppressed master toggle)
  makes the ghost geography legible — `edge` and `farfield` ghosts fly
  off across continents, which is the visual you want.
- `receivers` as small ticks; on hover/click any fix or reject, draw
  lines to its cohort (every record embeds `receivers[].gps`).
- Overlay the coast-station `registry` sites as reference pins.
- When `truth` is present, plot it and connect it to the fix — the gap
  IS the error. Style stationary-truth differently from moving (only
  `truth.stationary` is trustworthy to the km).
- Popups: MMSI, `name`, regime, q, residualKm, ellipse, farfieldRatio,
  and `truth.errKm`.

## Stack + conventions (match the repo)

- Plain ES modules, no build step, no framework. Leaflet from CDN is
  the only allowed runtime dep — the existing `client/map.js` already
  mounts Leaflet per-card; copy its tile/setup idiom.
- Design tone (see `CLAUDE.md` "Tone & design"): monospace, pure
  monochrome + one accent, Data-Desk restraint, mobile-first.
- Add it as a new page under `client/` (e.g. `client/map.html` +
  `client/detections-map.js`). Keep the gateway URL in a `<meta>` tag
  like `client/index.html` does (grep `skywave-gateway`).
- Deploy is automatic on push to main via GitHub Pages
  (`research.datadesk.eco/skywave/…`); bump the `?v=` cache-bust on any
  module you touch. To preview locally, `python3 -m http.server` in
  `client/` and drive it with the `browser` skill (headless).

## Notes

- Only 7 fixes survived — that's the real result, not a bug. Design for
  ~940 rejects being the visual mass and the 7 fixes being the rare
  jewels. Don't make the map look empty by hiding rejects by default.
- `global-hf` and `us-east-mf` produced 0 surviving fixes (q≥4 same-band
  cohorts were rare / traffic sparse) — most points are the two Channel
  MF captures. Fine; the `src` field lets you filter.
