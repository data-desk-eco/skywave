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

Defensible: out of ~900 public KiwiSDRs, the picker (in
`worker/src/regions.js`) selects 8 per DSC band (48 total by default,
cap 60) that are **active**, **coastal** (≤8° from a major port
anchor), **healthy** (self-reported SNR ≥ 15 dB, list entry updated in
the last hour, not IP-blacklisting us), and **considerate** (≥ 2 free
user slots so a human listener always has one). Same-band picks are
≥ 3° apart for geographic diversity; any one (host, port) is capped
at 2 bands so the rack doesn't over-index on a single operator.

Scoring: `freeSlots × coastalProximity × snrBonus × antennaBonus`,
with `antennaBonus = 1.5` when the antenna free-text mentions a
broadband design (loop / dipole / T2FD / Beverage / folded /
longwire).

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
  `/gfw`, `/gfw/tracks`, `/receivers` (debug).
- `directory-do.js` — `DirectoryDO`. Composes the rack; no fan-out.
- `receiver-do.js` — `ReceiverDO`. The hot path. Upstream + decoder
  + hibernation fanout + idle alarm.
- `kiwi-upstream.js` — server-side `KiwiClient`; mirrors the old
  `client/kiwi.js` but uses Workers' outbound-WebSocket fetch pattern.
- `dsc.js` — ITU-R M.493 decoder (identical port of
  `~/Research/dsc-triangulation/scripts/dsc_decode_ddesk.py`).
- `regions.js` — BANDS + regional bboxes + coastal anchors + `pickRack`.
- `location-hint.js` — GPS → CF region string.

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
- **CF DO costs scale with listener-hours, not listeners.** 48 slots
  in a region = 48 DOs active while anyone is watching, each handling
  ~100 audio frames/sec (each = 1 billable WS message). Nobody
  watching = zero cost. Ten people watching the same region = same
  cost as one person.

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
