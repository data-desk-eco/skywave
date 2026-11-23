# Skywave

Single-page browser app that watches public KiwiSDR receivers tuned to
the DSC channels, decodes every call, and prints the result as a
scrolling log. For each call it estimates where the transmitter is from
the arrival-time differences across receivers, and shows that estimate
next to the ship's single latest AIS position from LSEG.

## Topology

One Node process on the Data Desk server (`server/skywave.mjs`,
`skywave.service`, behind Caddy at `https://dev.datadesk.eco/skywave`).
The browser is a viewer: one server-sent-event stream per page.

```
browser ─ EventSource ─► skywave (node) ─ ws ─► KiwiSDR × N
                              │
                              └─ http ─► lseg service (same host)
```

- A browser asks for a region. The server picks that region's rack
  (`server/regions.js`), opens one KiwiSDR connection per (receiver,
  band) and keeps a 45 s IQ ring with the per-frame GPS stamps.
- Every receiver decodes DSC every 3 s (`server/dsc.js`). The first
  decode of a burst starts a 7.5 s timer; then EVERY same-band
  receiver's ring is cut around that burst's GPS time, decoded or not.
- `server/burst.js` times each cut against a replica of the decoded
  bits; `server/locate.js` solves; `server/lseg.js` fetches one AIS
  position; the result is broadcast as a `tdoa` event.
- A receiver that no rack names for 5 minutes is closed, so a quiet
  page stops holding KiwiSDR slots.
- `SKYWAVE_KEEP` (region ids, set in the unit) names racks the server
  holds with nobody watching, re-picked every 6 h, so the TOA log
  covers every hour of the day for long-term scoring.
- Every timed burst is appended to `/var/lib/skywave/toa-<date>.jsonl`
  (arrival times per receiver, the estimate, the AIS position), in the
  row format `scripts/toa_fix.mjs` reads. Raw audio is not kept.

Events: `hello {id}`, `rack {region, regionName, slots}`,
`status {slot, band, state, rssi}`, `call {slot, …, call}`,
`tdoa {mmsi, call, position, quality, receivers, ais, convergence}`,
`audio {slot, band, sr, rssi, pcm}` (base64 int16 BE, only for the
slot a client follows via `POST /v2/follow?id=&slot=&band=`).
`GET /lseg/track?mmsi=` and `GET /gfw?query=` serve the latest AIS
position and the vessel identity search; `GET /v2/recent` returns the
last 100 estimates and `GET /status` the client, receiver and held
counts. No vessel track is fetched,
stored or served: one position per ship only.

The Cloudflare worker this replaced (durable objects, pairwise
correlation, a stack of geometric gates) was deleted from Cloudflare on
2026-11-14 with its R2 bucket; its code is in the git history before
commit `3f2663d`, with its documentation in the same commits'
`CLAUDE.md`.

## Method

**Arrival times (`server/replica.js`, `server/burst.js`).** Once one
receiver decodes a burst the bit sequence is known. The decoders' soft
bits vote on it, and every receiver is correlated against a noise-free
CPFSK replica, searched over delay and frequency offset. Each receiver
gets its own arrival time, SNR and sigma. The burst is detected about
20 dB below the decode threshold (`pr`, peak over off-peak probes,
above 6), so a burst decoded by 1–14 receivers is timed at 16–60.
`paths()` separates multiple arrivals on the delay–doppler surface;
it is a diagnostic (`PATHS=1` in `burst_toa.mjs`), not used in fixes.

**Receiver clock offsets.** Each KiwiSDR has a constant timing offset.
It is near zero for 12 kHz receivers and about −463 µs (140 km) for
20.25 kHz-mode receivers. `scripts/toa_bias.mjs` fits the constants
from residuals at AIS truth; the server takes a table from
`SKYWAVE_BIAS` and defaults 20.25 kHz receivers to −463 µs.

**Solver (`server/locate.js`).** Unknowns are position and one
emission time per burst. Each arrival is weighted by its sigma
(Cramér–Rao from its SNR, plus a floor: 20 µs by day, 300 µs when the
sun is under 10° at the cohort's centre). Cauchy loss, coarse grid
then pattern search. The 1σ ellipse is the weighted Fisher matrix.
Several bursts can share one position (`k`). Options kept for
experiments: `h` / `hs` (ground wave or one E-layer hop per arrival),
`late` (one-sided night loss).

**Racks.** `regions.js` picks as before. For a single-band target
region the server adds up to 30 receivers 600–1700 km from the target
on that band: at night only distant receivers time consistently.

## What has been measured

All against LSEG AIS polled during the capture, offsets fitted on half
the vessels and fixes scored on the other half unless stated.

- **Summer day, Channel (2026-07-03, decoders only, ~4 receivers).**
  Per-receiver residual 17 µs median, p90 106 µs, flat with range to
  500+ km. Fix error tracks the ellipse (ratio 0.7–0.8): 11 km median
  where the ellipse is under 15 km (3 fixes), 17 km for 15–30 km (22),
  46 km over all 72. Limited by four near-collinear receivers. The
  earlier belief that summer daytime MF is sporadic-E contaminated was
  the uncalibrated −463 µs receiver (Alderney).
- **Winter afternoon, US east coast (2026-11-14, 12 receivers).**
  Residual 50 µs median, p90 300 µs. Ships in or near the cohort: 51 km
  median, 18 fixes, about twice the ellipse. Ships 600+ km outside it:
  210 km. A ground / E-hop model (h ≈ 110 km) helped some far ships
  and hurt others; not adopted. Low winter sun leaves some skywave in
  daytime.
- **Night, Channel (2026-11-14).** Receivers within ~400 km of the
  ship see several ionospheric hops spread over 1–4 ms and arrive
  0.4–1.4 ms late; beyond ~500 km arrivals agree to ±100–200 µs.
  Near rack only (20–29 receivers): 70–145 km median. With the
  600–1700 km ring (40–64 receivers): 60 km median, p75 111 km, for
  24 fixes in the Channel and North Sea; 106 km for 35 elsewhere in
  Europe. The ellipse under-reports at a 150 µs floor (hence 300).
  Rejected on this data: a ground/1E/1F/2F hop model with free layer
  heights, the one-sided loss, range-dependent sigma, a single
  effective reflection height.
- **First-path timing at night (in progress, 2026-11-14).**
  `toa_fix.mjs --first F` times on the earliest path at least F x the
  strongest. A first sweep on `nov1b` (359 bursts) was void: only 135
  bursts carried `paths`. Next: finish `PATHS=1 node
  scripts/burst_toa.mjs captures/nov1b.jsonl captures/nov1w.jsonl
  captures/nov1p_toa.jsonl >> captures/nov1p_toa.jsonl` (127 of 359
  done; it resumes), then score F = 0, .25, .5, 1 against the blend at floors
  150 and 300, paired per burst, Channel/North Sea apart.
- **Keep log, 19–23 Nov (english-channel + ny-harbour, 17 411 bursts,
  2 759 vessel fixes with AIS).** Live estimates: 73 km median by day
  (7 receivers), 196 km at night in Europe, 609 km at night in the US.
  Night timing spread is 250–300 µs at every SNR (propagation-limited);
  by day it follows SNR. At night US receivers decode European calls
  and time them 5–20 ms off (and vice versa); re-solving without
  arrivals over 4000 km from the first fix (`--near 4000`, now in the
  server) cut night p75 626 → 538 km, paired. Rejected on this data: a
  per-receiver offset table fitted on half the vessels plus coast
  stations (day 72 → 124 km median, even after the gate), and `--far
  500` at night (205 → 283 km). A few receivers have stable gross
  offsets (178.115.248.93 ≈ −9 ms, 178.164.107.18 ≈ +1 ms,
  sm1.thulesius.se ≈ −450 µs) that a hand-picked table could fix.
  Ellipses under 500 km under-report error 1.3–2x; long ellipses
  (ship outside the cohort) over-report it, but their median error is
  still 630–750 km.
- **Not yet measured.** A daytime capture with a large cohort around
  the ship (Channel, `captures/nov2`, 2026-11-15). The July error
  model predicts single-digit km there; the US result says winter
  daytime may fall short of that.

## Scripts

- `capture_burst.mjs [lat] [lon] [radiusKm] [maxRx] [hours] [minKm]` —
  the server's receiver side, writing every cut to JSONL for offline
  work. Receivers come straight from the public list. `FOLLOW=<file>`
  runs a second receiver set on another capture's bursts.
- `ais_watch.mjs <capture> <out> <seconds>` — polls LSEG every 10 min
  for every vessel heard (GFW only for MMSI → IMO).
- `burst_toa.mjs <capture> [slaves…] [out_toa.jsonl]` — arrival times,
  one row per burst; incremental when the output file is named.
  `toa_extract.mjs` does the same for the July decode-only captures.
- `toa_score.mjs`, `toa_bias.mjs` — residuals at truth; offsets
  (`--half a|b` fits on alternate vessels).
- `toa_fix.mjs` — solve and score (`--bias`, `--floor`, `--fuse MIN`,
  `--h N|fit`, `--first F`, `--late`, `--far KM`, `--near KM`,
  `--half`).
- `scorecard.sh captures/<name> [toa_fix flags]` — the whole chain;
  `SLAVES=` names `FOLLOW` captures.
- `toa_modes.mjs`, `toa_excess.mjs` — night diagnostics: excess delay
  at truth by range, effective-height fit.

`captures/` is not committed. Everything captured up to 2026-11-14
(the July campaign, the November night, ring and US captures, their AIS
polls, and what the retired worker held on Cloudflare) is in the private
bucket at `s3://data-desk-raw/skywave/captures-2026-11-14/`, one
zstd-compressed object per file (`data-desk env aws s3 cp …`).

## Client (`client/`, static, no build step)

`app.js` (event stream, call log, audio picker, CSV export),
`vessels.js` (identity + single AIS position, cached), `regions.js`,
`map.js` (Leaflet mini-map: estimate, 1σ ellipse, AIS point,
receivers), `index.html`, `styles.css`.

Design: radio-ham spirit with Data Desk restraint. Monospace
(JetBrains Mono), monochrome with one accent, no clutter. Mobile
first: a stacked list on narrow screens, a five-column log at ≥ 900 px.
Plain ES modules; Leaflet from CDN is the only runtime dependency.

## Deploy

- Client: GitHub Pages on push to `main`
  (`https://research.datadesk.eco/skywave/`). The `skywave-gateway`
  meta tag in `index.html` names the server. Bump the `?v=` cache-busts
  when modules change.
- Server: `ssh eouser@dev.datadesk.eco 'git -C /srv/skywave pull &&
  sudo systemctl restart skywave'`. The unit, the Caddy route, the
  pinned Node and the `skywave` credential are declared in
  `data-desk/infra` (see its README). `curl
  https://dev.datadesk.eco/skywave/status` shows clients and receivers.

## Don't

- Add a framework, bundler or npm dependency. `package.json` exists
  only to mark `.js` as ES modules.
- Hold receivers with nobody watching beyond the `SKYWAVE_KEEP` racks.
  The 5-minute idle close and the ≥ 2 free slots rule in the pickers
  are the etiquette.
- Fetch, store or publish a vessel track. One AIS position per ship.
- Put a secret in the repository. LSEG keys reach the server through
  its credential store.
- Add a gate or a propagation model without a truth-scored capture
  showing it helps. The rejected list above is what that test caught.

## Gotchas

- **Dial frequency.** DSC is at e.g. 2187.5 kHz; in USB the dial sits
  1.7 kHz below so the tones land at 1615 / 1785 Hz. Passband
  300–3000 Hz, IQ mode (every frame carries a GPS stamp).
- **Sample rate is not a multiple of 100 baud** (~11998.9 Hz, or
  ~20250 Hz). Track bit boundaries as floats; fit the rate from the
  GPS stamps, do not trust the nominal one.
- **GPS stamps are per-frame and sample-accurate** (~0.1 µs against a
  line fit). A receiver whose fit is worse than 5 µs is skipped.
- **The correlation search aliases.** The block-sum doppler search
  repeats every 20 Hz, and DSC's DX/RX interleave repeats symbols
  500 ms later; keep the first search inside ±9 Hz and ±8 ms.
- **MMSIs decoded under noise differ between receivers** (`5632??300`).
  Bursts are grouped with `?` as a wildcard, same band, within 2 s.
- **Coast stations (`00MIDxxxx`) are not solved.** Their arrivals are
  still kept in the TOA log; the station's position is known.
- **A burst on two bands is two transmissions.** Never mix bands in
  one solve.
- **`*.proxy.kiwisdr.com` redirects the websocket handshake.** The
  server resolves the redirect with a plain fetch first. On 2026-11-14
  the proxy refused all connections from a UK home line.
- **Self-reported KiwiSDR SNR does not predict decoding.**
- **GFW identity needs Origin + Referer from globalfishingwatch.org**,
  so it is proxied by the server. Its positions lag by days; AIS
  positions come from LSEG only.
- **AIS truth can be the wrong ship or stale.** MMSI → IMO → RIC
  sometimes resolves to another vessel (a 7 000 km "error"); score on
  vessels with bracketing polls and treat gross outliers as suspect.
- **Browser audio needs a user gesture** before `AudioContext` runs.
- **A busy host starves the capture.** Cuts are retried for 24 s when
  frames are still queued.

## Research pointers

`~/Research/dsc-triangulation`: KiwiSDR protocol
(`vendor/kiwiclient/kiwirecorder.py`), DSC decoders (TAOSW .NET and
the Python reference), test vectors and a real 5-call WAV. Public
receiver list: `http://rx.linkfanel.net/kiwisdr_com.js`.
