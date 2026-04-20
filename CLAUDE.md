# Skywave

Single-page browser app that watches a rack of public KiwiSDR receivers
tuned to the six international DSC channels, decodes every call, and
prints the result as a scrolling table. Optional GFW enrichment adds
ship name / flag / type to each caller.

Two topologies share the same UI:

- **v1**: browser opens ~24 WSs to KiwiSDRs, runs the decoder locally.
  The Cloudflare Worker only tunnels WSS→WS.
- **v2**: browser subscribes to a rack composed by a Worker. One
  `ReceiverDO` per channel per receiver holds the sole upstream WS,
  runs the decoder at the edge, and fans decoded calls out to every
  attached browser. See `PLAN.md`.

## What it is

- Pick a region from the dropdown (or Global). Browser opens WebSockets
  to up to 96 eligible KiwiSDRs, streams their 12 kHz USB audio, and
  runs a DSC decoder on each one.
- Every decoded call lands as a row: time, caller, destination, payload,
  count-of-receivers-that-heard-it. Rows expand to show decoder detail,
  the heard-by list, a mini map of the receivers, and GFW-resolved
  ship info (when a GFW key is set in localStorage).
- Audio stays silent until a real DSC FSK burst is detected; then the
  strongest-signal receiver drives the speakers for the duration of
  the call.

## Why it exists

Data Desk research (`~/Research/dsc-triangulation`) proved the decode
pipeline end-to-end in Python. The commercial maritime-intel world
runs on AIS (MarineTraffic, GFW, Kpler); the DSC crowd is a small,
greying amateur community. Nobody had wired
`KiwiSDR → DSC decoder → public readout` even though every ingredient
has been on the shelf since 2014. Skywave is that wire.

## Tone & design

Radio-ham tinker spirit served with Data Desk restraint.

- Monospace everything (JetBrains Mono). Pure monochrome, one accent,
  no clutter.
- Educational as much as it is intelligence-generating — hearing the
  actual FSK burst that AIS was supposed to replace is viscerally
  satisfying, lean into that.
- Mobile first: the whole UI collapses to a stacked list on narrow
  viewports; at ≥900px it's a classic five-column log.

## Code shape

### `client/` — static site (ES modules, no build step)

- `app.js` — v2 viewer. Owns `SlotConn` (one WS per rack slot), call
  dedupe / rendering, audio picker (follow the loudest live burst),
  CSV export, region dropdown, bootstrap.
- `vessels.js` — Global Fishing Watch integration. Chains `/gfw`
  (identity: name / flag / type / callsign / IMO / vesselId) →
  `/gfw/tracks` (last 14 days of AIS positions, decimated to ≤100
  points). Both routes proxy through the Worker because GFW's public
  endpoints check Origin + Referer. Cached in localStorage
  (schema-versioned, dropped on bump).
- `regions.js` — DSC channel table, regional presets with bboxes, MID
  to ISO country mapping, coastal proximity scoring.
- `map.js` — per-card Leaflet mini-map showing the receivers that
  heard the call. Lazy-mounted on first expand.

### `worker/src/` — Cloudflare Worker + Durable Objects

- `index.js` — router. Keeps v1 routes (`/receivers`, `/kiwi/...`,
  `/gfw`, `/gfw/tracks`); adds v2 (`/v2/rack`, `/v2/slot/...`). Both
  coexist during migration.
- `directory-do.js` — singleton `DirectoryDO`. Refreshes the public
  KiwiSDR list, composes the "front page" rack for each region. No
  traffic flows through it; it just answers HTTP GETs.
- `receiver-do.js` — `ReceiverDO`, keyed `<host>:<port>:<bandKHz>`.
  Owns the sole upstream WebSocket to that channel, runs `dsc.js`,
  broadcasts decoded calls to every attached client via the
  hibernation API. Alarm-based idle teardown after 5 min with no
  subscribers.
- `kiwi-upstream.js` — server-side `KiwiClient`, mirrors `kiwi.js` but
  runs in the Worker runtime.
- `dsc.js` — ITU-R M.493 decoder (identical to the one `client/` used
  to carry; copy of `~/Research/dsc-triangulation/scripts/dsc_decode_ddesk.py`).
- `regions.js` — server subset of the regions data; adds `pickRack`
  which replaces v1's client-side `pickReceiversAcrossBands`.
- `location-hint.js` — maps a receiver's GPS to a Cloudflare
  `locationHint` so a Tokyo DO wakes up in apac, not wnam.

## Do

- Plain ES modules, Web Audio, Fetch, WebSocket. No framework, no
  build step. Leaflet from CDN is the only runtime dep.
- Each module keeps a single responsibility and a small surface.
- Ship small. Target under 100 KB gzipped total (currently comfortable).
- Mobile- and desktop-friendly from a single stylesheet.

## Don't

- Any framework or bundler. `npm` is banned (except for wrangler in
  `worker/`, which npx-runs without a package.json).
- Auto-reconnect loops, multi-slot occupation, or any "listen forever"
  behaviour. A listener connected for 10–30 min is normal KiwiSDR
  usage; anything that squats on a slot indefinitely is not. The
  etiquette gate (≥2 free slots to join) still applies; v2 enforces it
  server-side when `DirectoryDO` picks the rack, and ReceiverDOs
  self-destruct 5 min after the last subscriber leaves.
- Storing secrets. The aisstream.io key was hard-coded for a while
  during development but has been removed (aisstream was dropped
  entirely — the MMSI filter doesn't work and real-time positions for
  DSC-heard ships are sparse anyway). GFW key is user-supplied.

## Gotchas

- **DSC channel ≠ KiwiSDR dial frequency.** DSC lives at 2187.5 kHz
  MF, but the audio decoder wants tones at 1615/1785 Hz. In USB the
  dial sits 1.7 kHz below the channel (e.g. 2185.8 kHz). Passband
  300–3000 Hz. `scripts/kiwi_capture.py` in the research repo
  explains the chain.
- **KiwiSDR sample rate is not integer-multiple of 100 baud.** Bit
  boundaries must be tracked as floats, not rounded; otherwise
  every symbol's check bits fail mid-burst. See `fskDemod` in
  `dsc.js`.
- **Browser audio autoplay.** `AudioContext.resume()` is blocked until
  the user activates the page. Connections, decoding and UI all work
  without a gesture — only speakers wait for the first tap/click/key.
- **aisstream.io's FiltersShipMMSI parameter silently returns zero
  messages**, even for MMSIs actively reporting in the unfiltered
  firehose. See `memory/reference_aisstream_filter.md`. We don't use
  aisstream in the shipping version.
- **GFW's public endpoints need Origin + Referer from
  globalfishingwatch.org.** Browsers refuse to let page JS forge those,
  so every GFW call goes through the Cloudflare Worker which adds them
  server-side. No API key needed; `Authorization: Bearer` (literally
  empty) is what the logged-out map UI sends too.
- **GFW `/tracks` only accepts `binary=true` without an API key.** The
  `binary=false` path returns 401. With `binary=true` the response is
  `application/protobuf` for some formats and `application/geo+json`
  for others. We use `format=GEOJSON&binary=true` so the Worker can
  decode without a protobuf dep.

## Research pointers

Everything below is in `~/Research/dsc-triangulation`:

- **KiwiSDR protocol** — `vendor/kiwiclient/kiwirecorder.py`. The
  browser port (`kiwi.js`) is ~130 LoC.
- **DSC decoder (canonical)** — `scripts/dsc_decode_taosw/` wraps the
  .NET TAOSW library. `Program.cs` shows the exact call sequence.
- **DSC decoder (Python reference)** — `scripts/dsc_decode_ddesk.py`.
  Non-coherent I/Q demod + phasing search. Short, easy to port.
- **Test vectors** — `vendor/TAOSW.DSC_Decoder.Core/.../SymbolsDecoderTests.cs`
  has hand-decoded real symbol sequences with expected outputs.
- **Real SDR capture** — `vendor/TAOSW.DSC_Decoder/testFiles/*.wav`
  contains an 88.2 kHz stereo WAV with 5 real DSC calls from Greek
  coast station Olympia Radio. The decoder must produce those 5
  calls byte-for-byte to be considered working.
- **Public KiwiSDR list** — `http://rx.linkfanel.net/kiwisdr_com.js`.
  Returns a JS assignment (not JSON) listing receivers with GPS,
  open-slot counts and band coverage.

## Deploy

Static. Served at `https://research.datadesk.eco/skywave/` via GitHub
Pages. HTTPS origin needs the Cloudflare Worker in `worker/` for the
WSS→WS tunnel; the `skywave-gateway` meta tag in `index.html` points
to the deployed worker URL.
