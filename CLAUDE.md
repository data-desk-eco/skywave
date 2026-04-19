# Skywave

Single-page browser app that tunes a public KiwiSDR, streams its audio to your
speakers, and decodes the ship-to-ship DSC traffic live on the same page.

## What it is

- Pick a KiwiSDR from a list of public receivers.
- Browser opens a WebSocket to the SDR, receives 12 kHz audio, plays it,
  and runs a DSC decoder over the same samples.
- Each decoded call appears as a line in a scrolling log: time, ship name
  (looked up from Global Fishing Watch), MMSI, from/to, category, what
  was said.
- No backend. No build step. No framework. No `node_modules`.

## Why it exists

Data Desk research (`~/Research/dsc-triangulation`) proved the decode
pipeline end-to-end in Python. The commercial maritime-intel world runs on
AIS (MarineTraffic, GFW, Kpler); the DSC crowd is a small, graying amateur
community. Nobody has wired up `KiwiSDR → DSC decoder → public readout`
even though every ingredient has been sitting on the shelf since 2014.
Skywave is that wire.

## Tone

Radio-ham tinker spirit served with Data Desk restraint.

- Monospace everything. Tuning dials. S-meter needles. Amber-on-black is
  fine — as long as it's functional, not ironic.
- The product is *educational* as much as it is intelligence-generating.
  Hearing the actual FSK burst that AIS is supposed to replace is viscerally
  satisfying; lean into that.
- Data Desk design sensibility: clean, high-contrast, one accent colour,
  no clutter. Functional first, decorative second.

## Do

- Vanilla HTML, CSS, JS. Web Audio API for playback. Web standards only.
- One HTML file, or a tiny handful of linked files. Should open from
  `file://` and work.
- WebAssembly is OK if it earns its keep — 100-baud FSK at 12 kHz is
  trivially within plain-JS reach, so probably don't bother.
- Ship small. Target under 100 KB gzipped total.
- Deployable as static files to GitHub Pages from day one.

## Don't

- Any framework. React, Vue, Svelte, Solid, Astro — no.
- `npm` / `yarn` / `pnpm` / `webpack` / `rollup` / `vite` / `parcel` — no.
- A required server. Optional crowdsourced upload can come later; v1 is
  purely client-side.
- Mobile-first. Desktop browser is the target.

## Pointers

Everything needed to build this already exists in the research repo at
`~/Research/dsc-triangulation`:

- **KiwiSDR protocol** — `vendor/kiwiclient/kiwirecorder.py` is a working
  Python WebSocket client. Handshake + audio frame format are all there.
  The browser port is ~200 LoC.
- **DSC decoder (canonical)** — `scripts/dsc_decode_taosw/` wraps the .NET
  TAOSW library. Its `Program.cs` shows the exact call sequence. The logic
  to port lives in `vendor/TAOSW.DSC_Decoder.Core/GMDSSDecoder.cs` and
  `SymbolsDecoder.cs`.
- **DSC decoder (Python reference)** — `scripts/dsc_decode_ddesk.py`. Our
  own non-coherent I/Q demodulator + phasing search. Shorter and easier
  to port to JS.
- **Test vectors** — `vendor/TAOSW.DSC_Decoder.Core/TAOSW.DSC_Decoder.Core.Tests/SymbolsDecoderTests.cs`
  has hand-decoded real DSC symbol sequences with expected outputs. Port
  these as JS unit tests.
- **Real SDR capture** — `vendor/TAOSW.DSC_Decoder/testFiles/*.wav` contains
  an 88.2 kHz stereo WAV with 5 real DSC calls from Greek coast station
  Olympia Radio. Non-negotiable: the decoder must produce those 5 calls
  byte-for-byte.
- **Public KiwiSDR list** — `http://rx.linkfanel.net/kiwisdr_com.js`
  returns a semi-JSON blob listing all registered public receivers, with
  GPS coords, open-slot counts, band coverage.

## Gotcha

DSC channel frequency ≠ KiwiSDR dial frequency. DSC is at 2187.5 kHz MF,
but the decoder wants audio tones at 1615/1785 Hz, so in USB the dial must
be **1.7 kHz below** the DSC channel (dial 2185.8 kHz). Passband 300–3000 Hz.
See `scripts/kiwi_capture.py` for the full explanation.

## Etiquette

A human listener connected for 10–30 minutes is normal KiwiSDR usage and
not anti-social. **Don't** add "listen in a hidden tab forever" behaviour,
auto-reconnect loops, or multi-slot occupation. If someone wants a 24/7
capture, that's what the research pipeline is for.
