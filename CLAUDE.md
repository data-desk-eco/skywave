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
* **TDOADO** (singleton) buckets snippets by fuzzy MMSI + tight
  packetGpsNs window, cross-correlates them, runs `solveTdoa`, and
  broadcasts each fix to clients on `/v2/tdoa/subscribe`.
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

## TDOA methodology — ground-wave only

The solver and gates are calibrated for **one defensible regime**:
a tight cohort of MF receivers all within ground-wave range of the
area we're monitoring. That's the regime where the maths actually
works in practice on the public KiwiSDR fleet.

The previous methodology tried to handle multi-hop skywave with
slant-distance corrections and per-pair propagation models; live
captures showed it consistently emitting plausible-looking-but-wrong
fixes for vessels far outside the cohort's radio horizon, with no
gate able to reliably separate them from real fixes. The simpler
ground-wave-only approach has been ground-truth-validated against
real vessels in the English Channel.

### What "ground wave" buys us

- On MF (2187.5 kHz, the international DSC distress channel) signals
  propagate as ground wave to ~600 km over salt water.
- Ground wave travels along the great-circle surface at ~c — so the
  timing-to-distance map is plain geodesic distance. No F2 layer
  reflection, no per-pair hop-count unknown, no ionospheric
  variability. The clean physics regime where the solver's residual
  landscape has one well-defined minimum near the truth.
- HF DSC bands are deliberately excluded from target cohorts: HF
  ground wave dies inside ~100 km, so HF receivers in the same area
  hear bursts via 1-3 hop skywave with all the propagation unknowns
  that brings.

### Cohort selection

`worker/src/regions.js`:
- A target region with `target.bands: [2187.5]` is a ground-wave
  cohort. `pickGroundWaveCohort` selects within `radiusKm` of the
  centroid, octant-balanced for bearing spread.
- 5 km site-dedup collapses literal collocations (one operator
  running multiple KiwiSDR boxes at the same site). 30 km would have
  been too aggressive — two different operators 15-30 km apart give
  measurably different timing, and quantity matters for hitting
  quorum.
- Quantity matters because each KiwiSDR has some independent
  probability of missing each burst (RFI, scheduling, decoder race-
  conditions, worker upstream failures). Over-provisioning the
  cohort (`cohortSize: 40`) ensures 3+ active decoders on most
  bursts even when half the picks are silent.

### Solver

`worker/src/tdoa.js`:
- Plain geodesic distance — no skywave / slant correction.
- Two-phase grid search: 81×81 coarse sweep over the receiver bbox
  expanded by 10°, then nested refinement on the top-3 coarse cells
  (top-3 instead of top-1 rescues cases where the coarse-cell minimum
  is one cell off truth due to grid discretisation).
- Single basin in practice — the residual landscape on a tight
  cohort doesn't have ghost minima you could mistake for the truth.

### Coordinator gates

`worker/src/tdoa-do.js`:
- **q ≥ 3** to solve at all, **q ≥ 4** to label `tier="trusted"`
  (residual gate is meaningful), **q = 3** is `tier="preliminary"`
  (exactly determined, residual is ~0 by construction).
- **Residual ≤ 300 km** — admits any fix consistent with ~1 ms
  KiwiSDR clock jitter on tight ground-wave geometry; rejects bad-
  xcorr / ghost-basin cases that produce 1000+ km residuals.
- **Bearing gap ≤ 270°** — max gap between consecutive receivers as
  seen from the solved position. Above 270° means every receiver is
  bunched in a 90° wedge of the compass — degenerate geometry where
  any timing pull yields wildly different positions in the away-
  from-receivers direction. The cheapest geometric check that
  actually catches ghost basins; everything else (ellipse semi-major,
  per-band single-hop, leave-one-out scatter, multi-burst history,
  area-of-interest containment) was found in live data to either
  duplicate this signal or fire on real fixes too.

That's the whole gate stack. The previous methodology had ~10 gates
and a three-tier system; the simplification is the work that made
real fixes start landing.

### Validation

Live capture against the `english-channel` cohort (35 receivers, MF
only, ≤400 km from (50, 0)) produced:

- WHITCHALLENGER (UK tanker, MMSI 235007413): repeat q=4/6/7 fixes
  all converging within 10 km of each other and **40-50 km of her
  actual Solent anchor position**. Best ground-truth-validated
  case so far.
- 5 of 5 vessel fixes plausible by speed (Δ km from stale GFW
  lastPos divided by Δ hours = implied speed within plausible
  vessel range).
- Ghost-basin cases (TROMS CAPELLA at 61°N Sweden, JAN-LAURENZ at
  39°N Spain) caught by the bearing-gap gate after the methodology
  reset.

`scripts/global_chokepoints.mjs` ranks where else the methodology
can run on the current public KiwiSDR fleet:
- **Tier 1**: Dover Strait, English Channel — orders of magnitude
  better than anywhere else, 26-32 receivers within 60° bearing gap.
- **Tier 2**: NY Harbour, Skagerrak/Kattegat, Chesapeake, Cornwall
  Lands End, Northern Italy — 11-19 receivers within 95-167° gap.
- **Most strategic chokepoints lack receiver density** (Hormuz,
  Malacca, Bosphorus, Singapore, etc.) — too few hobby KiwiSDRs in
  the area.

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
- `index.html`, `styles.css`, `favicon.svg`.

### `worker/src/` — Cloudflare Worker + Durable Objects

- `index.js` — HTTP routing. `/v2/rack`, `/v2/slot/:host/:port/:band`,
  `/v2/tdoa/subscribe`, `/v2/tdoa/recent`, `/v2/tdoa/inject` (debug),
  `/gfw`, `/gfw/tracks`, `/receivers` (debug).
- `directory-do.js` — `DirectoryDO`. Composes the rack; no fan-out.
- `receiver-do.js` — `ReceiverDO`. The hot path. Upstream + decoder
  + hibernation fanout + idle alarm. Also emits TDOA detection
  records (GPS-anchored audio snippets) to `TDOADO`.
- `tdoa-do.js` — `TDOADO`. Singleton coordinator. Fuzzy-MMSI-pairs
  detections across receivers, cross-correlates snippets, calls the
  solver, applies the residual + bearing gates, broadcasts.
- `tdoa.js` — pure solver math. `xcorr` + `solveTdoa` (two-phase
  grid-search assuming geodesic distance) + `tdoaUncertainty` for
  telemetry. Exercised offline by the scripts under `scripts/`.
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
- Re-introducing complex TDOA gates without a ground-truth-validated
  case showing they reject wrong solves *more* than they reject
  right ones. The history is littered with gates that looked
  principled but in live data fired on edge-of-cluster real fixes
  while letting through obvious ghost basins. Residual + bearing-gap
  is the gate stack that earned its keep.

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
