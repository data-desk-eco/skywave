# Skywave v2 — edge-decoded, slot-shared

**Status: shipped (2026-04-20).** What's below is the design doc that
drove the rebuild; what's running is close to it but differs in a few
places — see CLAUDE.md for the delivered shape. Kept for the narrative
and as a record of the bet.

---

v1 works: every listener's browser opens its own fleet of WebSockets to
the KiwiSDR pool and decodes locally. It's fine, but the footprint
scales with users — 96 slots × N listeners. Etiquette creaks.

v2 inverts the topology.

## Idea

> One Cloudflare Durable Object per KiwiSDR. It holds the only upstream
> WebSocket, runs the decoder, and fans decoded calls out to every
> browser that cares. Zero raw audio on the wire except during an
> actual burst.

That single sentence covers it. The rest of this document is mechanics.

## What the KiwiSDR sees

Exactly one connection from Skywave per channel per receiver, forever —
`ident_user=skywave · shared listener`. If a hundred humans open the
page, the receiver still sees one user, still has headroom for another
human listener. The etiquette gate (≥2 free slots to join, drop on
fill) keeps working; it just applies to our one connection.

## What the browser sees

One WebSocket to the Worker. JSON frames in, nothing else:

```
{ "t": "call",  "slot": "<host>:<port>",  "band": "MF",  "call": {...} }
{ "t": "audio", "slot": "...",            "band": "MF",  "pcm": <b64> }   // only during bursts
{ "t": "rack",  "slots": [{slot, band, label, gps, rssi}, ...] }
```

No per-user KiwiSDR handshake, no client-side rack management, no
mixed-content gateway dance. The client becomes a viewer.

## Why it wants to live at the edge

Durable Objects are placed near their first caller. A DO for a Tokyo
KiwiSDR should not wake up in Frankfurt just because a German user
was first. Fix with `locationHint` — derive it from the receiver's
GPS at DO creation time (one static lat/lon → "apac" / "weur" / "enam"
lookup). Then: upstream SDR → DO over CF's backbone, same continent;
DO → browser terminates at the nearest CF edge to the user. Minimum
hops both ways.

## Shape of the Worker

One script, two DO bindings:

- `ReceiverDO` — keyed `<host>:<port>:<band>`. Opens and owns the
  upstream `ws://`. Runs `dsc.js`. Holds a 10-sec ring buffer and the
  per-band RSSI / activity state. Attached clients are plain WebSockets
  managed via `state.acceptWebSocket()` (the hibernation API; zero CPU
  while the SDR is quiet).

- `DirectoryDO` — singleton. Owns the receiver list refresh (currently
  `/receivers`), picks the "front page" rack for each region, and
  maintains ref-counts across `ReceiverDO`s so a quiet one can
  gracefully shut down after N minutes with no subscribers.

The existing `/kiwi/...` and `/gfw/*` routes on the Worker stay as-is
during the migration — v1 clients keep working while v2 rolls in.

## Audio

- **Default: silent.** Most of the day a DSC channel carries nothing.
  The client draws decoded rows and is blameless on bandwidth.

- **Burst-gated.** `ReceiverDO` runs the same Goertzel we have client-
  side. When the in-band ratio crosses threshold, it flips into "audio
  on" for that burst and includes base64-encoded PCM frames in the
  fan-out. Flips back off after AUDIO_HOLD_MS of quiet.

- **At most one live audio slot per browser.** Client sends
  `{ "t": "audio-follow", "slot": null | "..." }` to pick which slot's
  audio (if any) to actually play. Others decode but don't stream
  audio to that client.

## Milestones

**M0 · decoder at the edge (one receiver, one user)** — port `dsc.js`
into `worker/src/dsc.js` (it's pure functions, copy-paste). New
`ReceiverDO` opens one hardcoded KiwiSDR, runs the decoder, pushes
JSON calls to an attached WS client. Prove end-to-end that a browser
tab sees calls with no ws:// of its own.

**M1 · multi-client fanout** — add `state.acceptWebSocket()` hibernation.
Open five tabs to the same receiver, confirm one upstream WS, five
downstream, no duplicated decodes.

**M2 · directory DO + regional pool** — move receiver-list fetching +
pool management to `DirectoryDO`. Client connects once, gets the
current rack for its region, and auto-subscribes to the right
`ReceiverDO`s. Upstream connections are ref-counted; teardown after
5 min idle.

**M3 · locationHint** — derive a CF region string from each receiver's
GPS when spawning its DO. Verify upstream hops stay on-continent.

**M4 · burst-gated audio** — activity detector in the DO, audio frames
flagged `t: audio` mixed into the JSON stream (base64 or binary-typed
WS messages). Client decodes back into Web Audio.

**M5 · client slim-down** — once v2 is stable, delete `kiwi.js`, most
of `app.js`'s rack code, and the etiquette watchdog. The client
shrinks to ~300 LoC: a WebSocket, a renderer, and a mini-map.

**M6 · the write-up** — this pattern (long-lived upstream source +
hibernated downstream fanout + edge placement by a physical location)
is worth a blog post with the CF dev advocacy angle. Case study
material.

## Cost shape

Back-of-envelope on the free tier:

- ~20 `ReceiverDO`s active concurrently across all viewers.
- Each one: one upstream WS (always on), N downstream WSs (hibernated
  when quiet). One decode per 3 s, ~30 ms CPU.
- A quiet channel is nearly-free (hibernated clients + idle Goertzel).
- A busy channel is ~1 % of one DO's budget.

Durable Object free-tier numbers shift with CF pricing announcements;
sanity-check with the outreach contact before committing. Fallback:
same topology on Fly.io / Deno Deploy at ~$5/month if we outgrow it.

## Non-goals for v2

- No user accounts, no auth — anyone can view, the decoded stream is
  the output of a public radio channel being listened to once on our
  behalf.
- No per-user receiver picks. The front-page rack is shared globally
  within a region. Users who want different receivers use v1's direct
  path.
- No historical archive served from the DO. If we want history it goes
  in Workers KV or a sidecar, not in DO memory.
- Still mobile-desktop ambidextrous, still pure-browser client, still
  no build step, still no framework.

## The bet

v1 proves Skywave is technically possible. v2 proves it's socially
possible — one listener on each channel, forever, serving everyone who
turns up. That's the version worth writing about.
