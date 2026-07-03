# Brief: detections map view (incl. suppressed fixes)

Build a standalone web map that plots recent DSC TDOA activity — solved
fixes **and** the suppressed (gate-rejected) ghosts — over a world map.
The point of showing suppressed fixes is didactic: most of what the
pipeline computes is a ghost, and seeing the ghosts land in empty ocean
/ across continents next to the real fixes is the whole story.

## Data — one endpoint, no auth, CORS-open

`GET https://skywave-gateway.louis-6bf.workers.dev/v2/tdoa/recent`
→ JSON `{ recentDetections, openBuckets, recentSolves, recentRejects, rejections }`

Poll it every ~10 s (it's a rolling in-memory ring on a Durable Object;
no websocket needed for a "recent activity" view). Fields you want:

- **`recentSolves`** (last 40 fixes that PASSED every gate — the ones
  actually broadcast): `{ mmsi, regime, position:{lat,lon,residualKm},
  quorum, geometry:{ellipseSemiMajorKm, ellipseSemiMinorKm,
  ellipseOrientationDeg, maxBearingGapDeg, farfieldRatio, ...},
  convergence:{fixCount,agreeCount,maxDistKm}, ais:{name,km,ageH,
  impliedKn}|null, receivers:[<slotId strings>], broadcastMs }`
- **`recentRejects`** (last 60 SUPPRESSED fixes, each with the position
  it would have claimed): `{ mmsi, gate, regime, position:{lat,lon,
  residualKm}, quorum, receivers:[{slot,label,gps:[lat,lon]}],
  broadcastMs }`. `gate` ∈ residual · edge · farfield · registry ·
  bearing · ellipse · ais — the reason it was killed.
- **`recentDetections`** (last 50 raw decodes, one per receiver-hearing):
  `{ mmsi, slot, gps:[lat,lon], packetGpsNs, receivedMs, snippetSamples }`.
  Use these to plot the **receivers** and, by joining `slot`, to draw a
  solved fix's cohort (solve `receivers` are slot-id strings; the
  reject records already embed receiver `gps`).
- **`rejections`**: running gate→count totals, good for a legend/tally.

Reference `worker/src/tdoa-do.js` for exact field provenance if unsure,
and `worker/src/coast-registry.js` for the ~25 fixed coast-station
truth positions (nice to overlay: `002191000` Lyngby, etc.).

## What to draw

- Solved fixes as the accent-colour diamonds (match the existing
  client's one-accent monochrome look — see `styles.css`,
  `favicon.svg`, JetBrains Mono). Draw the 1σ error ellipse from
  `geometry.ellipse*` (semi-major/minor km + orientation) — it's
  honest and visually central to the "how sure are we" story.
- Suppressed fixes as muted/hollow markers, coloured or icon-coded by
  `gate`. A toggle per gate (and a solved/suppressed master toggle)
  makes the ghost geography legible.
- Receivers as small ticks; on hover/click a fix, draw lines to its
  cohort receivers (from the reject's `receivers[].gps`, or by joining
  solve `receivers` slot-ids against `recentDetections`).
- Popups: MMSI, regime, q, residual, ellipse, farfield ratio, and for
  solves the `ais` miss (`name`, `km`, `impliedKn`) — that's the
  ground-truth annotation.

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

## Gotcha

The `recentRejects` ring only fills while the rack is actively hearing
traffic and producing ghosts — right after a worker deploy it's empty.
If you need sample data immediately, kick a capture
(`curl -X POST "$GW/v2/capture/start?region=english-channel&fanout=40&durationH=1"`)
or just poll for a few minutes during European daytime.
