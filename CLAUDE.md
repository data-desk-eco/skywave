# Skywave

Single-page browser app that watches a rack of public KiwiSDR
receivers tuned to the six international DSC channels, decodes every
call, and prints the result as a scrolling table. Optional Global
Fishing Watch enrichment resolves each caller's MMSI to a ship name,
flag, type and 14-day AIS track.

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
  closes itself 5 min after the last viewer leaves.
* **locationHint**: a ReceiverDO is placed near its KiwiSDR via a
  GPS-derived CF region string (apac / weur / wnam …), keeping
  upstream hops on-continent.

There is no persistent state worth backing up — DO storage holds only
each ReceiverDO's (host, port, band, label, gps) config, rebuilt from
the URL on first attach anyway.

## Why the rack looks the way it does

Two rack flavours live in `worker/src/regions.js`:

- **bbox regions** — the default "show me a rack across this big area"
  picker. Band-weighted slot allocation (HF8/HF12 get more, HF4 fewer)
  reflects which bands actually produce co-hearings. Cluster-gate on
  MF/HF4 only (short-range bands); HF6+ skip-zone receivers stay in.
- **target regions** — a small surround cohort (typically 5-8 hosts)
  picked by an octant-surround scorer (`pickSurroundCohort`): divides
  the compass around the target centroid into wedges, takes the best
  receiver in each occupied wedge. The cohort gets replicated across
  every DSC band each host covers. Five regions defined: Black Sea,
  Persian Gulf, N Atlantic, SE Asia / W Pacific, North Sea (tight
  Europe). Each carries an area-of-interest centroid + monitoring
  radius used by the TDOA trust gate.

All picks pass the same hard health filters: **active**, **GPS-equipped
and actively fixing** (TDOA needs per-frame GNSS timestamps — this also
cuts the pool by ~37%), **list entry updated in the last hour, not IP-
blacklisting us**, and **considerate** (≥ 2 free user slots so a human
listener always has one). Any one (host, port) is capped at 2 bands
in the bbox picker so the rack doesn't over-index on a single operator;
target picks replicate across all 6 bands deliberately. The "Global"
view and per-region bbox views share a 96-slot ceiling; target views
typically run 30-48 slots.

Scoring (bbox): `freeSlots × coastalProximity × snrBonus × antennaBonus`.
Scoring (target octants): SNR weighted, distance penalty, equal weight
across wedges. `antennaBonus = 1.5` when the antenna free-text mentions
a broadband design (loop / dipole / T2FD / Beverage / folded / longwire).

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
  `/v2/tdoa/subscribe`, `/v2/tdoa/recent`, `/gfw`, `/gfw/tracks`,
  `/receivers` (debug).
- `directory-do.js` — `DirectoryDO`. Composes the rack; no fan-out.
- `receiver-do.js` — `ReceiverDO`. The hot path. Upstream + decoder
  + hibernation fanout + idle alarm. Also emits TDOA detection
  records (GPS-anchored audio snippets) to `TDOADO`.
- `tdoa-do.js` — `TDOADO`. Singleton coordinator. Fuzzy-MMSI-pairs
  detections across receivers, cross-correlates snippets, calls the
  solver, broadcasts positions to subscribed browsers.
- `tdoa.js` — pure solver math. `xcorr` + `solveTdoa` (two-phase
  grid-search over the hyperbola landscape). Exercised offline by
  the scripts under `scripts/`.
- `kiwi-upstream.js` — server-side KiwiSDR WebSocket client. Runs in
  IQ mode so every frame carries a GPS-ns header — the shared time
  base the TDOA coordinator needs.
- `dsc.js` — ITU-R M.493 decoder (port of
  `~/Research/dsc-triangulation/scripts/dsc_decode_ddesk.py`).
- `regions.js` — BANDS + regional bboxes + coastal anchors + `pickRack`.
- `location-hint.js` — GPS → CF region string.

### `scripts/` — offline validation + live testing

- `test_tdoa.mjs` — synthetic geometry against `tdoa.js` solver,
  p50 ≈ 1.6 km on 50 trials.
- `test_tdoa_e2e.mjs` — synthetic multi-receiver cohorts through
  `TDOADO._solveBucket` with realistic sample-rate + snippet-start
  jitter + skywave propagation, p50 ≈ 1.4 km.
- `attach_nwe.mjs`, `inject_tdoa.mjs`, `inject_tdoa_real.mjs` —
  live-operations tools: attach to a whole region's rack, or inject
  a known cohort against production to sanity-check the live path.
- `tdoa_watch.mjs` — the live ground-truth harness. Subscribes to
  `/v2/tdoa/subscribe` and the `/v2/tdoa/recent` poll, attaches to
  every slot in a region's rack with auto-reconnect, and for each
  solved MMSI cross-checks against fresh AIS via LSEG (MMSI → GFW
  search → IMO → LSEG SymbologySearch → RIC → LSEG TR.AssetLocation*).
  GFW lookup filters strictly on `ssvid == query MMSI` because GFW's
  fuzzy search returns entries for *different* vessels too (e.g.
  005030001 returns ssvid=503177000 entries that are a different
  Australian warship). LSEG is for OFFLINE TESTING only — the UI
  still uses GFW exclusively.
- `tdoa_summary.mjs` — post-processes a `tdoa_watch.mjs` JSONL into
  per-MMSI accuracy stats, multi-broadcast convergence, tier
  distribution.

### TDOA methodology (current state)

The solver + gates are calibrated for one defensible regime:
**a tight cohort that surrounds an area of interest**. Outside that
regime — long-haul HF skip, ghost basins, mixed propagation — fixes
are still emitted but tagged tier=`tentative` so they don't claim
accuracy. The trust criterion is mechanistic, not statistical:

1. **Skywave-aware propagation model** (`tdoa.js:slantDistance`).
   Signals travel via F2 reflection at ~250 km, in ~2000 km hops; the
   solver computes slant rather than straight-line distance.
2. **Octant surround picker** (`pickSurroundCohort`). Divides compass
   into 6 wedges around the target centroid; one best receiver per
   wedge. Naturally produces good GDOP when the receiver pool allows.
3. **Wide solver search** (60° pad, 161×161 coarse grid). Lets the
   refiner discover basins outside the receiver bbox — without it,
   one-sided cohorts find only the local ghost.
4. **Robust trim** (`_solveBucket` iterative reweighting at q≥5).
   Drops the worst-residual receiver and re-solves up to 3 rounds.
5. **Multi-burst per-MMSI history** (`mmsiHistory` Map). 60-min window
   of past fixes for the same MMSI; pairwise scatter exposed in the
   broadcast `history` field. Ghost basins shift between cohorts; a
   real ship's position stays consistent.
6. **Tier classification**:
   - `trusted` — q≥4 AND every receiver within band's single-hop
     range (MF 1500 km, HF4 2500, HF6 3500, HF8 4000, HF12/16 4500)
     AND every receiver above 500 km (no near-field bias) AND the
     fix lands inside a defined **area-of-interest** (every region
     with `target.monitoringRadiusKm` contributes one).
   - `tentative` — q≥4 but at least one trust condition fails. The
     position is suggestive (a vessel is broadcasting somewhere) but
     coordinates can't be claimed because the timing-to-distance
     map is degenerate (multi-hop) or the fix is outside what we're
     monitoring (likely a ghost basin).
   - `preliminary` — q=3, exactly determined; activity hint only.

Constants and threshold rationale live as long-form comments at the
top of `worker/src/tdoa-do.js`. None of these are hand-tuned to AIS
ground truth; each derives from physics or from publicly-described
KiwiSDR TDoA practitioner consensus (see HF Underground topic 117872).

## Do

- Plain ES modules, Web Audio, Fetch, WebSocket. No framework, no
  build step. Leaflet from CDN is the only runtime dep.
- Each module keeps a single responsibility and a small surface.
- Ship small. Client is under 100 KB gzipped.
- Mobile- and desktop-friendly from a single stylesheet.

## Don't

- Any framework or bundler. `npm` is banned except for `wrangler`
  in `worker/` (npx-run, no `package.json`).
- "Listen forever" loops. The etiquette gate (≥ 2 free slots to join)
  still applies server-side; `ReceiverDO` self-destructs 5 min after
  the last viewer leaves so a quiet region stops squatting slots.
- Storing secrets. The GFW proxy works with an empty bearer because
  of Origin/Referer allow-listing on globalfishingwatch.org; no API
  key anywhere.

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
- **CF DO costs scale with listener-hours, not listeners.** 96 slots
  in a region = 96 DOs active while anyone is watching, each handling
  ~100 audio frames/sec (each = 1 billable WS message). Nobody
  watching = zero cost. Ten people watching the same region = same
  cost as one person.
- **TDOA cohorts need `host:port` dedup, not `slotId` dedup.** A
  single physical KiwiSDR hearing the same burst on two bands gives
  identical geometry — counting both toward quorum wastes the solve
  on degenerate math. `tdoa-do.js` collapses on `host:port`.
- **MMSIs decoded under noise differ between receivers.** One Kiwi
  reads `563250300`, another `5632??300`, a third `563252??0` — all
  the same ship. The coordinator fuzzy-matches with `?` as a
  wildcard and carries the cleanest variant forward.

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

## Deploy

Static client served at `https://research.datadesk.eco/skywave/` via
GitHub Pages (`.github/workflows/deploy.yml`). Worker deployed to
`https://skywave-gateway.louis-6bf.workers.dev`:

    cd worker && npx wrangler deploy

The `skywave-gateway` `<meta>` tag in `client/index.html` points the
client at the Worker URL.
