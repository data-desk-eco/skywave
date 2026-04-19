# Skywave — build plan

A static web page that lets you pick a public KiwiSDR, listen to the MF
2187.5 kHz DSC channel, and watch decoded ship-to-ship calls scroll by.

## Target end-state (v1)

```
┌─────────────────────────────────────────────────────────────────┐
│ SKYWAVE                                                         │
│ [ ▼ Canterbury UK, 2187.5 kHz MF ]   ▶ Listen   🔊 ───────      │
│                                                                 │
│ ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁  waterfall                                     │
│                                                                 │
│ 19:22:00  NIEUW STATENDAM  (244140580, 🇳🇱 passenger)           │
│           self-test            SAF · TEST · REQ    ECC OK       │
│           ~47 km ENE of Canterbury                              │
│                                                                 │
│ 19:24:00  STENA ESTELLE    (219030885, 🇩🇰 ferry)               │
│           → Lyngby Radio       SAF · TEST · ACK    ECC OK       │
│           Baltic Sea, ~890 km E                                 │
│                                                                 │
│ 19:25:14  (audible burst, didn't decode — weak signal?)        │
└─────────────────────────────────────────────────────────────────┘
```

## Non-goals for v1

- Multi-receiver fusion, triangulation (that's the research repo's job).
- Server-side aggregation / crowdsourced uploads.
- Modes other than DSC: no NAVTEX, WEFAX, SITOR, VHF voice.
- Mobile.

## Milestones

### M0 · Scaffolding · ½ day

- `index.html`, `app.js`, `styles.css`. No other files.
- Monospace, one accent colour, works `file://`.
- GitHub Pages deploy on push.

### M1 · KiwiSDR WebSocket audio · 1 day

- Fetch `http://rx.linkfanel.net/kiwisdr_com.js`, parse the semi-JSON blob
  (it is a JS assignment, not strict JSON — strip the wrapper), cache in
  localStorage.
- Filter to hosts that cover 0-30 MHz (most do). Show them in a dropdown
  sorted by open-slot headroom.
- Open `ws://<host>:<port>/<random>/SND`, send the handshake sequence
  (`SET` lines — see `kiwirecorder.py` lines ~500-700 in the Research repo).
  Request: `auth t=kiwi p=`, `SET mod=usb low_cut=300 high_cut=3000
  freq=2185.800`, `SET AR OK in=12000 out=44100`, `SET agc=1`.
- Frames arrive as binary `ArrayBuffer`s, first 3 bytes are a type tag
  (`SND`, `W/F`, `MSG`). Audio frames carry either 16-bit PCM samples or
  ima_adpcm compressed samples.
- Route decoded samples to a Web Audio `AudioBufferSourceNode` so the user
  hears the band. Mute control. Volume slider.

### M2 · DSC decoder · 2–3 days

Port `~/Research/dsc-triangulation/scripts/dsc_decode_ddesk.py` to vanilla
JS. Approximate 300 LoC target. Key pieces:

1. **Non-coherent I/Q FSK demod** at 1615 Hz (mark) / 1785 Hz (space).
   Per bit window: correlate samples against `cos(2πft)` and `sin(2πft)`
   for each of mark/space; `bit = 1` iff mark-power > space-power.
2. **Auto-tune**: run an FFT over a few seconds, find the dominant peak
   pair separated by ~170 Hz, use those as mark/space. Real captures will
   differ from the 1615/1785 ideal.
3. **10-bit symbol packing, LSB-first** — ITU-R M.493 transmits LSB first.
   `sym = bits[0] | bits[1]<<1 | … | bits[9]<<9`. Info = low 7 bits,
   check = high 3 bits (but the check bits are MSB-first on the wire:
   `check = b7<<2 | b8<<1 | b9`).
4. **Phasing search**: scan for the interleaved DX (125) + RX position
   counter (111, 110, 109, 108, 107, 106, 105, 104) pattern. DX symbols at
   even byte positions, RX counters descending at odd. Accept a loose
   hamming match (~5 bits of error in 160 bits).
5. **Deinterleaving**: after phasing, even bytes = DX stream, odd = RX
   stream. Real message starts at DX[6]; on a check-failure, substitute
   RX[dxCursor + 2] (5-symbol time-diversity repeat). This is non-trivial
   and is the part TAOSW gets right where everyone else fumbles.
6. **Parse**: format specifier (twice), to-MMSI (5 BCD pairs),
   category, from-MMSI (5 BCD pairs), TC1, TC2, EOS, ECC. Emit a call
   object.

Test inputs:

- `~/Research/dsc-triangulation/vendor/TAOSW.DSC_Decoder/testFiles/SDRuno_20250308_102536_8414000HZ.wav`
  must decode to exactly 5 calls (all from Olympia Radio `002371000`).
- The TAOSW C# unit tests (`SymbolsDecoderTests.cs`) have hand-curated
  symbol sequences with expected decoded fields. Port these as JS unit
  tests.
- Inject a synthetic burst into a silent buffer at known SNR and verify
  round-trip.

### M3 · UI · 1 day

- Receiver dropdown (label: city · country · slot headroom · last-seen).
- Band dropdown (MF 2187.5 default; HF 8414.5 / 12577 / 16804.5 later).
- Large "▶ Listen" button → opens WS, starts audio, starts decoder.
- Live mini-waterfall strip (Web Audio `AnalyserNode` → canvas, 512-bin
  FFT across 0–3 kHz; DSC bursts appear as two stripes at mark/space).
- Analog S-meter-style audio level indicator.
- Scrolling call log. Each row stays 2 min, then fades out. Click a call
  to expand: raw symbol sequence, ECC number, receiver-to-ship rough
  distance, map pin if AIS lookup succeeds.

### M4 · AIS enrichment · ½ day

- For each decoded MMSI, lazily fetch Global Fishing Watch
  `/v3/vessels/search?query=<MMSI>&datasets[0]=public-global-vessel-identity:latest`
  with `Authorization: Bearer <GFW_API_KEY>` (user pastes a key once, we
  stash it in localStorage).
- Response has name, flag, IMO, vessel class. Cache per MMSI. Show flag
  emoji + name in the call row.
- No `Authorization` → show MMSI only; soft-fail.

### M5 · Polish · open-ended

- Extra bands — add 8414.5 / 12577 / 16804.5. Same pipeline, different
  `freq=` in the handshake.
- Export decoded calls as TSV that matches YaDDNet's `cross_180d.tsv`
  schema, so they round-trip into the research repo's DuckDB.
- "QSL card" export — a small shareable image of a notable decode.
- Lighter/darker themes. Print-friendly log.

## Decoder gotchas worth writing on the wall

1. DSC channel ≠ KiwiSDR dial. Dial = channel − 1.7 kHz in USB.
2. Bits are LSB-first but the 3 check bits are MSB-first. They're not the
   same convention.
3. TAOSW was written against 88.2 kHz SDRuno audio; its bit-clock math
   degrades at 12 kHz (the KiwiSDR native rate). Our Python wrapper
   upsamples to 88.2 kHz before feeding TAOSW. The JS decoder should
   handle 12 kHz natively but may need similar care with sample counts.
4. Nearly every hobby DSC decoder (including jbirby/DSC-Codec) uses the
   wrong DX symbol (126 instead of 125), wrong format specifier codes,
   and no interleaving. They work against themselves and nothing else.
   TAOSW is ITU-compliant; trust it.

## When you're stuck

Poke around `~/Research/dsc-triangulation`:
- Recent commits and `docs/kiwisdr_pipeline_design.md` narrate the whole
  journey.
- `scripts/kiwi_capture.py` shows the end-to-end Python version.
- `findings.md` has the propagation / yield math.
