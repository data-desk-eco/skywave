# Skywave

Single-page browser app that fans out across dozens of public KiwiSDR
receivers, tunes each to a DSC channel, decodes every call, and prints
the result as a scrolling table. Optional GFW enrichment adds ship
name / flag / type to each caller. No backend of our own; the
Cloudflare Worker in `worker/` only tunnels WSS→WS so HTTPS pages can
reach the ws:// KiwiSDRs.

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

Six small modules (ES modules, `<script type="module">`):

- `app.js` — orchestration, the `RxSlot` class, audio routing, call
  dedupe & rendering, CSV export, bootstrap.
- `dsc.js` — self-contained ITU-R M.493 decoder (port of
  `~/Research/dsc-triangulation/scripts/dsc_decode_ddesk.py`). Only
  exports `decode(samples, sr, opts)`.
- `kiwi.js` — `KiwiClient` WebSocket client, gateway-URL helper.
- `vessels.js` — Global Fishing Watch vessel lookup (`search` endpoint
  only; no position data from GFW, just name/flag/type/callsign/IMO).
  Cached in localStorage forever.
- `regions.js` — DSC channel table, regional presets with bboxes, MID
  to ISO country mapping, coastal proximity scoring, small helpers.
- `map.js` — per-card Leaflet mini-map showing the receivers that
  heard the call. Lazy-mounted on first expand.

## Do

- Plain ES modules, Web Audio, Fetch, WebSocket. No framework, no
  build step. Leaflet from CDN is the only runtime dep.
- Each module keeps a single responsibility and a small surface.
- Ship small. Target under 100 KB gzipped total (currently comfortable).
- Mobile- and desktop-friendly from a single stylesheet.

## Don't

- Any framework or bundler. `npm` is banned.
- Auto-reconnect loops, multi-slot occupation, or any "listen forever"
  behaviour. A listener connected for 10–30 min is normal KiwiSDR
  usage; anything that squats on a slot indefinitely is not. The
  etiquette gate (≥2 free slots to join, drop on fill) runs every 45 s
  and is non-negotiable.
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
- **GFW search doesn't return position.** Identity only (name, flag,
  type, callsign, IMO). For position you'd have to cascade into the
  events endpoint — not currently done.

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
