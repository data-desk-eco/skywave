# Skywave

Single-page browser app that watches a rack of public KiwiSDR
receivers tuned to the six international DSC channels, decodes every
call, and prints the result as a scrolling table. Optional Global
Fishing Watch enrichment resolves each caller's MMSI to a ship name,
flag, type and 14-day AIS track. For target regions, when ≥3 receivers
hear the same burst, a TDOA solver triangulates the transmitter's
position and broadcasts a fix to subscribed clients.

## Topology — v2, edge-decoded

One Cloudflare Durable Object per KiwiSDR channel holds the only
upstream WebSocket, runs the DSC decoder, and fans decoded calls out
to every browser attached to it. The browser is a pure viewer.

```
browser —ws—┐
browser —ws—┼──► ReceiverDO (one per <host>:<port>:<bandKHz>)
browser —ws—┘        │ upstream ws://
                     ▼
                 KiwiSDR @ Etten-Leur / Dover / …
```

* **DirectoryDO** (singleton) refreshes the public kiwisdr_com list and
  composes the "front page" rack for each region. HTTP only — traffic
  doesn't flow through it.
* **ReceiverDO** (keyed) owns the upstream, runs `dsc.js` on a
  10-second rolling Float32 ring, broadcasts decoded calls, and
  gates base64 PCM frames on a Goertzel burst detector (1615 /
  1785 Hz). Uses the hibernation API so client sockets are cheap;
  closes itself 5 min after the last viewer leaves. Also POSTs each
  decoded call's GPS-anchored audio snippet to `TDOADO`.
* **TDOADO** (singleton) buckets snippets by fuzzy MMSI + same band +
  tight packetGpsNs window, cross-correlates them, runs `solveTdoa`,
  applies the geometry gates (residual + bearing-gap + ellipse), and
  broadcasts each surviving fix to clients on `/v2/tdoa/subscribe`.
* **locationHint**: a ReceiverDO is placed near its KiwiSDR via a
  GPS-derived CF region string (apac / weur / wnam …), keeping
  upstream hops on-continent.

There is no persistent state worth backing up — DO storage holds only
each ReceiverDO's (host, port, band, label, gps) config and the
TDOADO's last 100 broadcasts (`/recent` debug ring).

## Why the rack looks the way it does

Two rack flavours live in `worker/src/regions.js`:

- **bbox regions** — the default "show me a rack across this big area"
  picker (`pickRack`). Band-weighted slot allocation (HF8/HF12 get
  more, HF4 fewer) reflects which bands actually produce co-hearings.
  Cluster-gate on MF/HF4 only (short-range bands); HF6+ skip-zone
  receivers stay in. Used for the "Global" view and continent-scale
  presets.
- **target regions** — a tight cohort focused on one specific patch
  of sea (`pickTargetRack`). Two cohort-selection strategies depending
  on whether the target restricts bands:
  - **Ground-wave mode** (`target.bands` set, e.g. `[2187.5]` for MF):
    `pickGroundWaveCohort` picks the closest receiver in each compass
    octant, then tops up with the next-closest unpicked. Site-deduped
    at 5 km. SNR self-report is ignored (it's a noise-floor estimate,
    not a decode predictor). The whole available pool is taken
    (`cohortSize: 40` is naturally capped by the pool, ~25-35 distinct
    sites within a 400 km radius of busy maritime areas).
  - **Surround mode** (no `target.bands`): `pickSurroundCohort` does
    one-per-octant SNR-weighted, replicates across all 6 DSC bands
    each receiver covers. Used for long-baseline targets where ground
    wave isn't an option (sea-pac, persian-gulf, etc.).

All picks pass the same hard health filters: **active**, **GPS-equipped
and actively fixing** (TDOA needs per-frame GNSS timestamps — this also
cuts the pool by ~37%), **list entry updated in the last hour, not IP-
blacklisting us**, and **considerate** (≥ 2 free user slots so a human
listener always has one). Any one (host, port) is capped at 2 bands
in the bbox picker so the rack doesn't over-index on a single operator;
target picks replicate across allowed bands deliberately. The "Global"
view and per-region bbox views share a 96-slot ceiling.

Scoring (bbox): `freeSlots × coastalProximity × snrBonus × antennaBonus`.
`antennaBonus = 1.5` when the antenna free-text mentions a broadband
design (loop / dipole / T2FD / Beverage / folded / longwire).

## TDOA methodology

Operating regime: **any DSC band, geometry-gated**. Two propagation
regimes both produce real fixes on the public KiwiSDR fleet, and the
gate stack admits both:

- **MF ground-wave** on a tight cohort (LIG, WAPP, NY, KAT, CHES,
  english-channel, dover — see `regions.js`). Cleanest physics:
  signals travel along the great-circle surface at ~c, so timing-to-
  distance is plain geodesic distance. Where the fleet has the density
  to form a 3+ receiver ground-wave cohort, fixes land within tens of
  km of truth.
- **HF skywave** on a globally-spread cohort (Global / "ALL" view).
  Receivers hear the same burst via 1-3 hop F2 reflection, with all
  the per-pair propagation unknowns that implies. Live data shows two
  clear populations: real fixes with tight error ellipses (semi-major
  <600 km) and ghost basins with wide ones (1500-20000 km). The gates
  separate them empirically.

The previous methodology was *ground-wave only* and rejected HF
outright. Live capture against the deployed Global rack showed several
q≥4 HF skywave fixes landing on AIS truth (MEDI NOSHIMA in Bay of
Biscay; an S-China-Sea AtoN converging across q3→q6 bursts; a SG-flag
ship in Danish waters). Those would have been thrown away. The new
gate stack admits HF when the geometry is good and rejects it when it
isn't — regardless of band.

### What the gates catch

`worker/src/tdoa-do.js`:

- **q ≥ 4 required.** q=3 is exactly determined in 2D, has a mirror
  ambiguity that only a 4th constraint breaks, and residual ≡ 0 by
  construction — too unreliable to publish as a position. Decoded
  calls still surface in the table (presence info); we just don't
  pretend we know where the source is. Live data: every clear ghost
  in the un-rejected set was q=3.
- **Same band per bucket** — receivers on different DSC bands hear
  different physical transmissions, so cross-band snippet xcorr is
  noise. Imposed at ingest in `_findMatchingBucket`. Different-band
  receivers form parallel buckets, each tracking that band on its own.
- **Residual ≤ 300 km** — belt-and-suspenders against grossly bad
  xcorr lags. Rarely fires alone: most ghosts have small residuals
  because the wrong basin is internally self-consistent.
- **Bearing gap ≤ 220°** — max angular gap between consecutive
  receivers as seen from the solved position. >220° means the cohort
  is bunched in <140° of the compass and the fix is unconstrained in
  the away direction. Tightened from 270° after live data showed
  Madagascar-style ghosts at 246° passing.
- **Ellipse semi-major ≤ 1000 km** — the 1σ position-uncertainty
  ellipse from the cohort's Fisher matrix at 1 ms per-receiver timing
  noise. The most discriminating single signal: a near-singular Fisher
  matrix (one-sided cohort) blows up to thousands of km along the
  unconstrained axis. Cleanly separates the convergent S-China-Sea
  AtoN (semi-major 200 km) from the Falmouth-coast-station-fixing-in-
  Coral-Sea ghost (semi-major ~1900 km) in live data.

The 1 ms timing-noise figure isn't ground-truthed — it's a reasonable
estimate of KiwiSDR GPS-discipline behaviour. The ellipse gate is
calibrated to the same σ_t the `tdoaUncertainty` function already
uses, so threshold and value scale together if the real σ_t is
different.

### Reference receiver

The reference is the cohort's **cleanest decode** (highest
`mmsiQuality` — fewest `?` characters in the recovered MMSI), not
just the first detection to arrive. The reference snippet is the
xcorr template every other receiver gets correlated against, so a
noisy template directly inflates the lag estimate noise on every
other receiver. Picking the cleanest decode is a strict improvement
with no downside, since most cohorts have at least one receiver that
got every bit right and ties fall back to first-arrival.

### Hyperbola visualisation

Each non-reference receiver contributes one hyperbola: the locus of
points where geodesic timing would match the measured offset. In a
clean fix all curves intersect at the diamond and fan out elsewhere;
in a degenerate fix they run nearly parallel near the fix or have a
second near-intersection that gives the solver a competing basin —
which is exactly the failure mode the gates can't always catch
(AWTAD-style "wrong propagation model fits a near-cohort source").

The mini-map traces each curve via marching-squares zero-crossings
of the constraint on a global lat/lon grid, drawn as subtle white
polylines. Cheaper than ray-casting from the fix, and works equally
well far from the fix where the diagnostic value lives. See
`client/hyperbola.js`.

### Solver

`worker/src/tdoa.js`:
- Plain geodesic distance — no skywave / slant correction. The HF
  skywave fixes that pass do so because their geometry is good enough
  that residual per-hop variability stays inside the timing-noise
  budget the gates already account for.
- Two-phase grid search: 81×81 coarse sweep over the receiver bbox
  expanded by 10°, then nested refinement on the top-3 coarse cells
  (top-3 rescues cases where the coarse-cell minimum is one cell off
  truth due to grid discretisation).
- `tdoaUncertainty` returns the 1σ error ellipse (Fisher inverse →
  2×2 eigendecomposition). **Load-bearing for the ellipse gate**, not
  just telemetry.

### Cohort selection

`worker/src/regions.js`:
- **bbox regions** (Global + continent presets) → `pickRack` allocates
  96 slots across all 6 DSC bands, weighted by where multi-hearings
  actually happen (HF8/HF12 heaviest). Most multi-RX detections in
  this rack are HF skywave; the ones that survive the gates are the
  real-HF path.
- **target regions with `target.bands: [2187.5]`** → `pickGroundWaveCohort`
  picks octant-balanced MF receivers within `radiusKm`. Site-deduped
  at 5 km. SNR self-report ignored (it's a noise-floor estimate, not
  a decode-rate predictor). The high-confidence ground-wave path.
- **target regions without `target.bands`** → `pickSurroundCohort`
  for long-baseline targets where ground wave isn't an option.
- All picks pass the same hard health filters: active, GPS-fixing,
  considerate (≥2 free user slots), recent.

### Validation

Live capture against the deployed Global rack (`/v2/tdoa/recent`)
during methodology revision:
- ~10 fixes/min throughput.
- Of 20 fixes in a 4-minute snapshot: 6 with semi-major <600 km
  looked plausible (3 converging on one S-China-Sea AtoN, an SG-flag
  ship in Danish waters, a Singapore-area HF16, and a Danish coast
  station fixing in Denmark on MF); 11 with semi-major >1500 km were
  clear ghosts (UK Falmouth coast station "fixing" in the Coral Sea
  three times, a HK ship "in" Madagascar, a fix in landlocked
  Central African Republic).
- The ~800 km gap in the ellipse distribution was empirical, not
  designed — the 1000 km gate drops every ghost in the sample while
  keeping every plausible fix.

The earlier `english-channel` ground-wave validation (WHITCHALLENGER,
UK tanker, MMSI 235007413: repeat q=4/6/7 fixes converging within 10
km of each other and 40-50 km of her actual Solent anchor) still
stands — that geometry has tight ellipse and low bearing gap, so it
passes the new gates as well as the old.

`scripts/global_chokepoints.mjs` ranks where ground-wave cohorts can
form on the current public KiwiSDR fleet:
- **Tier 1**: Dover Strait, English Channel — 26-32 receivers within
  60° bearing gap.
- **Tier 2**: NY Harbour, Skagerrak/Kattegat, Chesapeake, Cornwall
  Lands End, Northern Italy — 11-19 receivers within 95-167° gap.
- **Other strategic chokepoints** (Hormuz, Malacca, Bosphorus,
  Singapore) lack ground-wave receiver density — they appear on the
  Global rack via HF skywave instead, and benefit from the same
  geometry gates.

## Tone & design

Radio-ham tinker spirit served with Data Desk restraint.

- Monospace everything (JetBrains Mono). Pure monochrome, one accent,
  no clutter.
- Educational as much as it is intelligence-generating — hearing the
  actual FSK burst that AIS was supposed to replace is viscerally
  satisfying; lean into that.
- Mobile first: UI collapses to a stacked list on narrow viewports;
  at ≥ 900 px it's a classic five-column log.

## Code shape

### `client/` — static site (ES modules, no build step)

- `app.js` — SlotConn WebSocket class, cross-slot call dedupe,
  rendering, audio picker (follow-the-loudest-burst), CSV export,
  region dropdown, bootstrap.
- `vessels.js` — GFW identity + tracks. Both routes proxy through the
  Worker (GFW checks Origin + Referer). Cached in localStorage with
  a schema version.
- `regions.js` — region dropdown data, MID-to-ISO, GPS parser.
- `map.js` — Leaflet mini-map per card; lazy-mounted on first expand.
- `hyperbola.js` — geo math + marching-squares trace of the per-pair
  TDOA constraint. Pure function `hyperbolaSegments(refGps, otherGps,
  dtSec)` returns `[[lat,lon],[lat,lon]]` segments for `map.js` to
  draw. Lets the human see at a glance whether a fix is the unique
  intersection of all curves or a coincidental near-miss with ghosts.
- `index.html`, `styles.css`, `favicon.svg`.

### `worker/src/` — Cloudflare Worker + Durable Objects

- `index.js` — HTTP routing. `/v2/rack`, `/v2/slot/:host/:port/:band`,
  `/v2/tdoa/subscribe`, `/v2/tdoa/recent`, `/v2/tdoa/inject` (debug),
  `/gfw`, `/gfw/tracks`, `/receivers` (debug).
- `directory-do.js` — `DirectoryDO`. Composes the rack; no fan-out.
- `receiver-do.js` — `ReceiverDO`. The hot path. Upstream + decoder
  + hibernation fanout + idle alarm. Also emits TDOA detection
  records (GPS-anchored audio snippets) to `TDOADO`.
- `tdoa-do.js` — `TDOADO`. Singleton coordinator. Fuzzy-MMSI +
  same-band bucketing across receivers, cross-correlates snippets,
  calls the solver, applies the residual + bearing-gap + ellipse
  gates, broadcasts.
- `tdoa.js` — pure solver math. `xcorr` + `solveTdoa` (two-phase
  grid-search assuming geodesic distance) + `tdoaUncertainty`
  (Fisher-inverse ellipse, load-bearing for the ellipse gate).
  Exercised offline by the scripts under `scripts/`.
- `kiwi-upstream.js` — server-side KiwiSDR WebSocket client. Runs in
  IQ mode so every frame carries a GPS-ns header — the shared time
  base the TDOA coordinator needs.
- `dsc.js` — ITU-R M.493 decoder (port of
  `~/Research/dsc-triangulation/scripts/dsc_decode_ddesk.py`).
- `regions.js` — BANDS + regional bboxes + coastal anchors +
  `pickRack` (bbox) + `pickTargetRack` (target) +
  `pickGroundWaveCohort` (target.bands-restricted) +
  `pickSurroundCohort` (long-baseline target).
- `location-hint.js` — GPS → CF region string.

### `scripts/` — offline validation + live testing

- `test_tdoa.mjs` — synthetic geometry against `tdoa.js` solver,
  p50 ≈ 1.6 km on 100 trials.
- `test_tdoa_e2e.mjs` — synthetic multi-receiver cohorts through
  `TDOADO._solveBucket` with realistic sample-rate + snippet-start
  jitter, ground-wave (geodesic) propagation, p50 ≈ 1.1 km.
- `tdoa_watch.mjs` — the live ground-truth harness. Subscribes to
  `/v2/tdoa/subscribe` and the `/v2/tdoa/recent` poll, attaches to
  every slot in a region's rack with auto-reconnect, and for each
  solved MMSI cross-checks against fresh AIS via LSEG (MMSI → GFW
  search → IMO → LSEG SymbologySearch → RIC → LSEG TR.AssetLocation*).
  GFW lookup filters strictly on `ssvid == query MMSI` because GFW's
  fuzzy search returns entries for *different* vessels too.
- `analyse_solves.mjs` — offline post-processor for `tdoa_watch.mjs`
  JSONL. Per-MMSI: GFW lookup (for vessels) + speed-plausibility
  check, or fixed-position lookup (for coast stations). Cohort
  fetched live from `/v2/rack` so the analyser stays in sync with
  the picker. Use this whenever you want to turn a capture into a
  table of "did we get the right ship in the right place".
- `global_chokepoints.mjs` — feasibility sweep. Walks a labelled list
  of maritime chokepoints + a 2.5° lat × lon grid, computes for each
  candidate centroid: `n receivers within 400 km after site-dedup`,
  `max bearing gap`, `mean distance`. Score = n × (180 / max_gap).
  Tells you where in the world the methodology can run.
- `inject_tdoa.mjs`, `inject_tdoa_real.mjs` — push synthetic cohorts
  at the deployed `/v2/tdoa/inject` debug route, useful for sanity-
  checking the live path before burning hours waiting for traffic.
- `attach_nwe.mjs`, `inject_tdoa_black_sea.mjs`, `tdoa_summary.mjs` —
  legacy harnesses from earlier methodology iterations; kept for
  reproducibility of historical captures.

## Do

- Plain ES modules, Web Audio, Fetch, WebSocket. No framework, no
  build step. Leaflet from CDN is the only runtime dep.
- Each module keeps a single responsibility and a small surface.
- Ship small. Client is under 100 KB gzipped.
- Mobile- and desktop-friendly from a single stylesheet.

## Don't

- Any framework or bundler. The repo's only `package.json` exists
  to declare `"type": "module"` so Node treats `.js` files as ESM
  when scripts under `scripts/` import from `worker/src/`. `npm`
  proper is banned; only `npx wrangler` runs in `worker/`.
- "Listen forever" loops. The etiquette gate (≥ 2 free slots to join)
  still applies server-side; `ReceiverDO` self-destructs 5 min after
  the last viewer leaves so a quiet region stops squatting slots.
- Storing secrets. The GFW proxy works with an empty bearer because
  of Origin/Referer allow-listing on globalfishingwatch.org; no API
  key anywhere.
- Adding TDOA gates without a live-data case showing the new gate
  rejects ghosts *more* than it rejects real fixes. The history is
  littered with gates that looked principled but in practice fired
  on real fixes while letting through obvious ghosts. Current stack
  (residual + bearing-gap + ellipse + same-band-per-bucket) earned
  its keep against a 20-fix `/v2/tdoa/recent` snapshot showing clean
  separation between real fixes (semi-major <600 km) and ghosts
  (semi-major >1500 km). Same standard for any future addition.

## Gotchas

- **DSC channel ≠ KiwiSDR dial frequency.** DSC lives at 2187.5 kHz
  MF; the audio decoder wants tones at 1615 / 1785 Hz. In USB the
  dial sits 1.7 kHz below the channel (2185.8 kHz for MF). Passband
  300–3000 Hz. `scripts/kiwi_capture.py` in the research repo
  explains the chain.
- **KiwiSDR sample rate is not an integer multiple of 100 baud.** Bit
  boundaries must be tracked as floats, not rounded. See `fskDemod`
  in `dsc.js`.
- **Browser audio autoplay.** `AudioContext.resume()` is blocked
  until the user activates the page. Decoding and UI work without a
  gesture — only speakers wait for the first tap/click/key.
- **GFW's public endpoints need Origin + Referer from
  globalfishingwatch.org.** Browsers won't forge those, so every GFW
  call goes through the Worker, which adds them server-side. No API
  key needed; `Authorization: Bearer` (literally empty) is what the
  logged-out map UI sends too.
- **GFW `/tracks` only accepts `binary=true` without a key.** We ask
  for `format=GEOJSON&binary=true` so the Worker can decode without a
  protobuf dep.
- **GFW lastPos can be days stale.** GFW caches non-fishing vessel
  tracks; large container ships often show 3-5 day old positions. The
  watch script's plausibility check converts (Δkm to TDOA fix) ÷
  (Δhours since AIS) to an implied speed; flagged as implausible only
  when > 60 kn. For exact ground truth use LSEG (`tdoa_watch.mjs`)
  or a fixed-position coast station.
- **Outbound WebSockets from a DO prevent the DO from hibernating.**
  This is fine here — the DO is only alive while a viewer is
  attached; 5 minutes after the last WebSocketClose, the idle alarm
  fires and tears the DO down.
- **`*.proxy.kiwisdr.com` hosts 307-redirect the WS handshake, and
  neither browsers nor CF Worker WebSocket clients follow those.** The
  Worker sidesteps this by pre-resolving the redirect chain with a
  plain `fetch({ redirect: "follow" })` before the upgrade — the final
  stable endpoint is some `*.proxy2.kiwisdr.com:8073` the WS can reach
  directly. The resolved endpoint is cached per-host. Browsers still
  never see the redirect because they only ever talk to the Worker,
  not the KiwiSDR. Without this, ~35% of the public fleet (including
  the only SE-of-Black-Sea receiver) is unreachable.
- **CF DO costs scale with listener-hours, not listeners.** N slots
  in a region = N DOs active while anyone is watching, each handling
  ~100 audio frames/sec (each = 1 billable WS message). Nobody
  watching = zero cost. Ten people watching the same region = same
  cost as one person. Ground-wave target cohorts run 25-35 slots; a
  rough order-of-magnitude is 1¢/hour-of-viewing per cohort member.
- **TDOA cohorts need `host:port` dedup, not `slotId` dedup.** A
  single physical KiwiSDR hearing the same burst on two bands gives
  identical geometry — counting both toward quorum wastes the solve
  on degenerate math. `tdoa-do.js` collapses on `host:port`. The
  picker also site-dedups at 5 km so two boxes at the same operator
  don't burn two cohort slots.
- **Cross-band buckets are rejected at ingest.** A burst heard by
  receiver A on HF8 and receiver B on HF12 is two different physical
  transmissions; xcorr between their snippets returns a noise lag
  that the solver then triangulates into a ghost. `_findMatchingBucket`
  requires same-band, so a single MMSI heard on multiple bands within
  the 2 s window forms parallel buckets, each tracking its band
  independently. Real cross-band convergence (vessel re-keys all DSC
  channels back-to-back) is rare and not worth the ghost risk.
- **MMSIs decoded under noise differ between receivers.** One Kiwi
  reads `563250300`, another `5632??300`, a third `563252??0` — all
  the same ship. The coordinator fuzzy-matches with `?` as a
  wildcard and carries the cleanest variant forward.
- **Self-reported KiwiSDR SNR is a noise-floor estimate, not a
  decode-rate predictor.** Close-in low-SNR receivers (Brighton at
  96 km, Chichester at 105 km) decode MF DSC reliably; distant
  high-SNR receivers can sit silent due to upstream/antenna issues
  invisible at pick time. Ground-wave cohort selection ignores the
  SNR floor for this reason.

## Research pointers

Everything below is in `~/Research/dsc-triangulation`:

- **KiwiSDR protocol** — `vendor/kiwiclient/kiwirecorder.py`. The
  Worker port (`kiwi-upstream.js`) is ~140 LoC.
- **DSC decoder (canonical)** — `scripts/dsc_decode_taosw/` wraps the
  .NET TAOSW library.
- **DSC decoder (Python reference)** — `scripts/dsc_decode_ddesk.py`.
  Non-coherent I/Q demod + phasing search.
- **Test vectors** —
  `vendor/TAOSW.DSC_Decoder.Core/.../SymbolsDecoderTests.cs` has
  hand-decoded real symbol sequences with expected outputs.
- **Real SDR capture** — `vendor/TAOSW.DSC_Decoder/testFiles/*.wav`
  contains an 88.2 kHz stereo WAV with 5 real DSC calls from Greek
  coast station Olympia Radio. The decoder must produce those 5
  calls byte-for-byte.
- **Public KiwiSDR list** — `http://rx.linkfanel.net/kiwisdr_com.js`.
  Returns a JS assignment (not JSON).
- **HF Underground TDoA discussion** — topic 117872. Practitioner
  consensus on what works and what doesn't for KiwiSDR-based
  triangulation. Skywave timing has too many free parameters for the
  free-public-receiver case; ground-wave is what actually works.

## Deploy

Static client served at `https://research.datadesk.eco/skywave/` via
GitHub Pages (`.github/workflows/deploy.yml` triggers on push to main).
Worker deployed to `https://skywave-gateway.louis-6bf.workers.dev`:

    cd worker && npx wrangler deploy

The `skywave-gateway` `<meta>` tag in `client/index.html` points the
client at the Worker URL. Bump the `?v=` cache-bust in `index.html`,
`app.js`, `map.js` whenever client modules change so browsers pick up
the new code.
