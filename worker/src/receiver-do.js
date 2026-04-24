// ReceiverDO — one Durable Object per <kiwi-host>:<port>:<band>. Owns
// the sole upstream WebSocket to that KiwiSDR channel, runs the DSC
// decoder, and fans decoded calls out to every browser attached to it.
// No audio crosses the wire except during an actual FSK burst.
//
// Keyed by DirectoryDO via `idFromName("<host>:<port>:<bandKHz>")`,
// placed near the receiver via a `locationHint` derived from the
// receiver's GPS at creation time.
//
// Client → DO protocol (all JSON):
//   incoming from client:  { t: "audio-follow", on: true|false }
//   outgoing to client:    { t: "hello",  slot, band, ... }
//                          { t: "call",   slot, band, call: {...} }
//                          { t: "audio",  slot, band, sr, rssi, pcm: <b64> }
//                          { t: "status", slot, band, state, msg? }

import { decode as dscDecode } from "./dsc.js";
import { KiwiUpstream } from "./kiwi-upstream.js";
import { bandLabelFor } from "./regions.js";

// Matches the client-side thresholds from v1 so the in-burst / out-of-
// burst judgement stays consistent (see client/app.js AUDIO_* consts).
const AUDIO_ACTIVITY_RMS = 0.010;
const AUDIO_INBAND_RATIO = 0.15;
const AUDIO_HOLD_MS      = 6000;

// Idle teardown: when the last client leaves, close the upstream and
// hibernate this minute later. Matches PLAN.md's "5 min idle" target;
// kept a little shorter to avoid squatting a KiwiSDR slot for nothing.
const IDLE_TEARDOWN_MS   = 5 * 60 * 1000;

// Decoder cadence — one decode pass per N ms over the latest 10 s of
// audio. Matches v1's tuning.
const DECODE_EVERY_MS    = 3000;
const DECODE_WINDOW_SEC  = 10;
const RING_MAX_SEC       = 15;

// TDOA snippet: window of audio around each detection handed to the
// coordinator for cross-correlation. 2 s centred on the packet start
// comfortably covers the ~500 ms burst plus enough flanking context for
// sub-sample lag refinement across receivers whose GPS-ns timestamps
// may disagree by tens of ms due to decoder scheduling jitter.
const SNIPPET_BEFORE_SEC = 0.5;
const SNIPPET_AFTER_SEC  = 1.5;

export class ReceiverDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // In-memory only — wiped if the DO ever hibernates. `config` is
    // mirrored to storage so we can rebuild on wake.
    this.config = null;
    this.upstream = null;
    this.upstreamAttempt = 0;
    this.sampleRate = 12000;
    this.ring = new Float32Array(0);
    // Running count of samples we've received on this upstream. Used to
    // convert decoder sample offsets (inside the ring view) back to an
    // absolute index that can be looked up in `gpsFrames` below.
    this.totalSamples = 0;
    // Parallel ring of per-upstream-frame GPS timestamps. Each entry:
    //   { absSample, gpssec, gpsnsec, fresh, nSamples }
    // `absSample` is the index of the first sample of that frame in the
    // cumulative stream. We trim in lockstep with the audio ring so the
    // coverage stays aligned.
    this.gpsFrames = [];
    this.rssi = -127;
    this.rmsEMA = 0;
    this.inBandEMA = 0;
    this.lastActiveAt = 0;
    this.audioOn = false;
    this.lastDecodeAt = 0;
    this.decodedSigs = new Map();
    this.booted = null;

    // blockConcurrencyWhile during construction: load stored config and
    // re-open upstream for any hibernating clients before the first
    // webSocketMessage fires.
    this.state.blockConcurrencyWhile(async () => {
      const cfg = await this.state.storage.get("config");
      if (cfg) this.config = cfg;
      if (this.config && this.state.getWebSockets().length > 0) {
        this._ensureUpstream();
      }
    });
  }

  // -------------------------------------------------------------------
  // HTTP/WS entry point
  // -------------------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path.endsWith("/init")) {
      const cfg = await request.json();
      this.config = cfg;
      await this.state.storage.put("config", cfg);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && path.endsWith("/stop")) {
      this._tearDown("directory asked");
      return Response.json({ ok: true });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("skywave receiver", { status: 404 });
    }

    // Fast path: DirectoryDO includes config in the WS upgrade query
    // so the first attach doesn't need a separate /init round-trip.
    if (!this.config) {
      const host = url.searchParams.get("host");
      const port = url.searchParams.get("port");
      const band = url.searchParams.get("band");
      if (host && port && band) {
        const lat = parseFloat(url.searchParams.get("lat") || "NaN");
        const lon = parseFloat(url.searchParams.get("lon") || "NaN");
        this.config = {
          host,
          port: parseInt(port, 10),
          bandKHz: parseFloat(band),
          label: url.searchParams.get("label") || host,
          gps: Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null,
        };
        await this.state.storage.put("config", this.config);
      } else {
        return new Response("not initialised", { status: 409 });
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ audioFollow: false });
    try { server.send(JSON.stringify({ t: "hello", ...this._slotInfo() })); } catch (_) {}

    // Cancel any pending idle alarm — we have a live subscriber again.
    await this.state.storage.deleteAlarm();
    this._ensureUpstream();

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------
  // Hibernation WebSocket callbacks
  // -------------------------------------------------------------------

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(typeof message === "string" ? message : ""); }
    catch (_) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "audio-follow") {
      const att = ws.deserializeAttachment() || {};
      att.audioFollow = !!msg.on;
      ws.serializeAttachment(att);
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (_) {}
    await this._maybeScheduleIdleTeardown();
  }

  async webSocketError(ws) {
    try { ws.close(1011, "error"); } catch (_) {}
    await this._maybeScheduleIdleTeardown();
  }

  async _maybeScheduleIdleTeardown() {
    if (this.state.getWebSockets().length === 0) {
      await this.state.storage.setAlarm(Date.now() + IDLE_TEARDOWN_MS);
    }
  }

  async alarm() {
    if (this.state.getWebSockets().length === 0) {
      this._tearDown("idle timeout");
    }
  }

  // -------------------------------------------------------------------
  // Upstream KiwiSDR connection
  // -------------------------------------------------------------------

  _ensureUpstream() {
    if (this.upstream && !this.upstream.closed) return;
    if (!this.config) return;
    const { host, port, bandKHz } = this.config;
    this.upstreamAttempt++;
    const reconnect = () => {
      this.upstream = null;
      if (this.state.getWebSockets().length === 0) return;
      // Exponential-ish backoff capped at 30 s: a full or offline Kiwi
      // might recover on a timescale of minutes, and we want to keep
      // trying so the live-station count self-heals, but we don't want
      // to hammer persistently-busy receivers every 4 s forever.
      const delay = Math.min(30_000, 2_000 * Math.pow(1.5, Math.max(0, this.upstreamAttempt - 1)));
      setTimeout(() => this._ensureUpstream(), delay);
    };
    const up = new KiwiUpstream(host, port, {
      dialKHz: bandKHz - 1.7,
      ident: "skywave shared listener",
      onAudio: (samples, sr, rssi, pcmBytes, gps) =>
        this._onAudio(samples, sr, rssi, pcmBytes, gps),
      onReady: (sr) => {
        this.sampleRate = sr;
        // Reset the backoff once we've actually reached audio-rate —
        // next failure resumes from a short delay, not a long one.
        this.upstreamAttempt = 0;
        this._announce({ t: "status", state: "live", sr });
      },
      onClose: () => {
        this._announce({ t: "status", state: "down" });
        reconnect();
      },
      // Previously this path had no retry — when a Kiwi 403'd at the
      // WebSocket upgrade (server full), onError fired but onClose did
      // not, so the slot stayed dead for the lifetime of the DO. Now
      // both paths schedule a reconnect via `reconnect()` so temporary
      // busy/offline states self-heal.
      onError: (e) => {
        this._announce({ t: "status", state: "err", msg: String(e) });
        reconnect();
      },
    });
    this.upstream = up;
    up.connect().catch((e) => {
      this._announce({ t: "status", state: "err", msg: String(e) });
      reconnect();
    });
  }

  _tearDown(reason) {
    if (this.upstream) { this.upstream.close(); this.upstream = null; }
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1000, reason || "shutdown"); } catch (_) {}
    }
    this.state.storage.deleteAlarm().catch(() => {});
  }

  // -------------------------------------------------------------------
  // Audio path — activity detection, ring buffer, decode, fanout
  // -------------------------------------------------------------------

  _onAudio(samples, sr, rssi, pcmBytes, gps) {
    this.rssi = rssi;
    this.sampleRate = sr;
    const N = samples.length;
    if (!N) return;

    // Track cumulative sample index and per-frame GPS timestamp so the
    // decoder can later translate its in-ring sample offset into a
    // GPS-ns wall-clock anchor for TDOA pairing.
    const frameAbs = this.totalSamples;
    this.totalSamples += N;
    if (gps) {
      this.gpsFrames.push({
        absSample: frameAbs,
        gpssec:  gps.gpssec  >>> 0,
        gpsnsec: gps.gpsnsec >>> 0,
        fresh:   !!gps.fresh,
        nSamples: N,
      });
      // Trim in lockstep with the audio ring. Keep ~ RING_MAX_SEC of
      // history plus a small safety margin.
      const keepFromAbs = this.totalSamples - Math.floor(sr * (RING_MAX_SEC + 1));
      while (this.gpsFrames.length > 1
             && this.gpsFrames[1].absSample <= keepFromAbs) {
        this.gpsFrames.shift();
      }
    }

    let totalP = 0;
    for (let i = 0; i < N; i++) totalP += samples[i] * samples[i];
    const rms = Math.sqrt(totalP / N);
    this.rmsEMA = this.rmsEMA * 0.8 + rms * 0.2;

    // Goertzel at the two FSK tones (1615 / 1785 Hz).
    const inband = goertzel(samples, sr, 1615) + goertzel(samples, sr, 1785);
    const bandFrac = inband / (totalP * 2 / N + 1e-9);
    this.inBandEMA = this.inBandEMA * 0.65 + bandFrac * 0.35;

    const now = Date.now();
    const active = this.rmsEMA > AUDIO_ACTIVITY_RMS && this.inBandEMA > AUDIO_INBAND_RATIO;
    if (active) {
      this.lastActiveAt = now;
      if (!this.audioOn) {
        this.audioOn = true;
        this._announce({ t: "status", state: "burst", rssi });
      }
    } else if (this.audioOn && now - this.lastActiveAt > AUDIO_HOLD_MS) {
      this.audioOn = false;
      this._announce({ t: "status", state: "live", rssi });
    }

    if (this.audioOn && pcmBytes && pcmBytes.length) {
      this._fanoutAudio(pcmBytes, sr, rssi);
    }

    // Ring buffer for the decoder: keep the most recent RING_MAX_SEC.
    const maxLen = Math.floor(sr * RING_MAX_SEC);
    if (this.ring.length + N <= maxLen) {
      const merged = new Float32Array(this.ring.length + N);
      merged.set(this.ring);
      merged.set(samples, this.ring.length);
      this.ring = merged;
    } else {
      const keep = maxLen - N;
      const merged = new Float32Array(maxLen);
      merged.set(this.ring.subarray(this.ring.length - keep));
      merged.set(samples, keep);
      this.ring = merged;
    }

    if (now - this.lastDecodeAt > DECODE_EVERY_MS &&
        this.ring.length >= sr * DECODE_WINDOW_SEC) {
      this.lastDecodeAt = now;
      // Run synchronously — we're already on the DO's event loop and
      // decode takes ~30 ms.
      this._runDecoder();
    }
  }

  _fanoutAudio(pcmBytes, sr, rssi) {
    const b64 = bytesToBase64(pcmBytes);
    const info = this._slotInfo();
    const msg = JSON.stringify({ t: "audio", ...info, sr, rssi, pcm: b64 });
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (!att.audioFollow) continue;
      try { ws.send(msg); } catch (_) {}
    }
  }

  _runDecoder() {
    const sr = this.sampleRate;
    const windowLen = Math.floor(sr * DECODE_WINDOW_SEC);
    const viewOffsetInRing = Math.max(0, this.ring.length - windowLen);
    const view = this.ring.subarray(viewOffsetInRing);

    // Cheap RMS gate; skip obviously-silent chunks so we don't run the
    // decoder's autotune sweep on 100 dB of nothing.
    let gate = 0;
    for (let i = 0; i < view.length; i += 64) gate += view[i] * view[i];
    gate = Math.sqrt(gate * 64 / view.length);
    if (gate < 0.005) return;

    let call;
    try { call = dscDecode(view, sr, {}); }
    catch (_) { return; }
    if (!call) return;

    const sig = [
      call.formatCode, call.destination, call.caller,
      call.tc1Code, call.tc2Code, call.eos,
    ].join("|");
    const now = Date.now();
    if (now - (this.decodedSigs.get(sig) || 0) < 60000) return;
    this.decodedSigs.set(sig, now);
    for (const [k, t] of this.decodedSigs) {
      if (now - t > 120000) this.decodedSigs.delete(k);
    }

    // TDOA detection record. `call.startSample` is the bit-aligned packet
    // start within `view`; translate to an absolute sample index, then
    // look up the straddling GPS-timestamped frame and interpolate to
    // sub-frame precision.
    const startInRing = viewOffsetInRing + (call.startSample | 0);
    const absStart = this.totalSamples - this.ring.length + startInRing;
    const det = this._detectionRecord(call, absStart, sr);
    if (det) {
      this._emitDetection(det);
    } else {
      // Surface why so we can diagnose from the client. Common failure:
      // no fresh GPS anchor in the ring (Kiwi's GNSS not reporting yet).
      const gf = this.gpsFrames;
      const withFix = gf.filter((f) => f.gpssec || f.gpsnsec).length;
      const freshCount = gf.filter((f) => f.fresh).length;
      this._announce({
        t: "status",
        state: "no-tdoa-anchor",
        msg: `gpsFrames=${gf.length} withFix=${withFix} fresh=${freshCount}`,
      });
    }

    this._announce({ t: "call", call });
  }

  // Assemble the detection record: receiver metadata, GPS-ns anchor, and
  // an audio snippet spanning the burst for cross-correlation upstream.
  //
  // The snippet has a FIXED length anchored at `packet_start −
  // SNIPPET_BEFORE_SEC`, zero-padded if the ring doesn't contain that
  // much history. Every receiver's snippet for the same packet then
  // begins at the same wall-clock moment (up to the TDOA itself), which
  // is what the coordinator relies on when cross-correlating. The
  // earlier "clamp to ring head" behaviour made startGpsNs wildly
  // divergent across receivers on short-ring slots and blew out the
  // coordinator's spread-check.
  _detectionRecord(call, absStartSample, sr) {
    const anchor = this._gpsAtAbsSample(absStartSample, sr);
    if (!anchor) return null;

    const snippetStartAbs = absStartSample - Math.floor(SNIPPET_BEFORE_SEC * sr);
    const totalLen = Math.floor((SNIPPET_BEFORE_SEC + SNIPPET_AFTER_SEC) * sr);
    const audio = new Float32Array(totalLen);
    const ringHead = this.totalSamples - this.ring.length;
    const availFrom = Math.max(snippetStartAbs, ringHead);
    const availTo   = Math.min(snippetStartAbs + totalLen, ringHead + this.ring.length);
    if (availTo > availFrom) {
      const writeOff = availFrom - snippetStartAbs;
      const readOff  = availFrom - ringHead;
      audio.set(this.ring.subarray(readOff, readOff + (availTo - availFrom)), writeOff);
    }
    const snippetStartAnchor = this._gpsAtAbsSample(snippetStartAbs, sr);
    if (!snippetStartAnchor) return null;

    return {
      slot: this._slotInfo(),
      call: {
        caller: call.caller,
        destination: call.destination,
        formatCode: call.formatCode,
        categoryCode: call.categoryCode,
        eos: call.eos,
      },
      // GPS-ns at the packet's decoder-identified start (phasing→data).
      packetGpsNs: anchor.ns,
      // Snippet metadata: audio is Float32, SR-rate, starts at this
      // wall-clock time. Base64-encoded on the wire (done by whoever
      // transports this record — keep the record plain JS here).
      snippet: {
        sampleRate: sr,
        startGpsNs: snippetStartAnchor.ns,
        samples: audio,      // Float32Array
      },
    };
  }

  // Map an absolute sample index to a GPS-ns timestamp.
  //
  // KiwiSDR IQ frames carry (last_gps_solution, gpssec, gpsnsec). The
  // GNSS subsystem only reports a new PVT solution ~1/sec; in between,
  // the Kiwi repeats the last solution's timestamp across many frames
  // (last_gps_solution counts "frames since fresh" and is 0 only on the
  // frame where a new fix just landed). The repeat makes it unsafe to
  // interpret every frame's timestamp as "this frame's sample 0".
  //
  // Strategy: treat a fresh frame (or the first change we see in gpssec/
  // gpsnsec) as an anchor, and extrapolate to any later sample using the
  // GPS-disciplined sample rate. Accurate to sub-microsecond over the
  // ring's multi-second span.
  _gpsAtAbsSample(absSample, sr) {
    const frames = this.gpsFrames;
    if (!frames.length) return null;
    // Find the latest fresh or gps-changed frame at or before absSample.
    let anchor = null;
    let prevGps = null;
    for (const f of frames) {
      if (f.absSample > absSample) break;
      if (!f.gpssec && !f.gpsnsec) continue;   // Kiwi never had a fix here
      const key = `${f.gpssec}.${f.gpsnsec}`;
      if (f.fresh || prevGps !== key) anchor = f;
      prevGps = key;
    }
    if (!anchor) return null;
    const offsetSamples = absSample - anchor.absSample;
    const extraNs = Math.round(offsetSamples * 1e9 / sr);
    const ns = BigInt(anchor.gpssec) * 1_000_000_000n
             + BigInt(anchor.gpsnsec)
             + BigInt(extraNs);
    return { ns };
  }

  // Hand the detection off. In phase-1 wiring this is a no-op stub; the
  // TDOA coordinator DO consumes these via the task-8 implementation.
  _emitDetection(det) {
    // Placeholder: serialise enough to log without exploding console for
    // the audio snippet. Will be replaced by a fetch() to TDOADO.
    if (!this.env.TDOA) return;
    // Fire-and-forget; we never block the audio path on coordinator I/O.
    const body = {
      ...det,
      packetGpsNs: det.packetGpsNs.toString(),
      snippet: {
        sampleRate: det.snippet.sampleRate,
        startGpsNs: det.snippet.startGpsNs.toString(),
        samples: Array.from(det.snippet.samples),
      },
    };
    const id = this.env.TDOA.idFromName("singleton");
    const stub = this.env.TDOA.get(id);
    stub.fetch("https://tdoa/detect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  // -------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------

  _slotInfo() {
    const c = this.config || {};
    return {
      slot: `${c.host}:${c.port}`,
      band: bandLabelFor(c.bandKHz),
      bandKHz: c.bandKHz,
      label: c.label,
      gps: c.gps,
    };
  }

  _announce(frame) {
    const info = this._slotInfo();
    const payload = JSON.stringify({ ...info, ...frame });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload); } catch (_) {}
    }
  }
}

// Lightweight single-bin Goertzel: returns ~A²/2 for a pure tone at
// `freq`, normalised the same way as the v1 client's in-band detector.
function goertzel(samples, sr, freq) {
  const N = samples.length;
  const w = 2 * Math.PI * freq / sr;
  const cw = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    const s0 = samples[i] + cw * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.max(0, (s1 * s1 + s2 * s2 - cw * s1 * s2) * 4 / (N * N));
}

// btoa(String.fromCharCode.apply(...)) blows the stack for large arrays,
// and we sometimes see 4 KB+ PCM frames after a tab unpauses. Chunk.
function bytesToBase64(u8) {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
