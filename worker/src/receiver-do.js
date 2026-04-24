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
    // Running count of samples received on this upstream. Lets the
    // decoder's in-view sample offset translate to an absolute index
    // that can be looked up in `gpsFrames` for a wall-clock anchor.
    this.totalSamples = 0;
    // Parallel ring of { absSample, gpssec, gpsnsec, fresh } entries,
    // one per upstream IQ frame. Trimmed in lockstep with `ring`.
    this.gpsFrames = [];
    this.rssi = -127;
    this.rmsEMA = 0;
    this.inBandEMA = 0;
    this.lastActiveAt = 0;
    this.audioOn = false;
    this.lastDecodeAt = 0;
    this.decodedSigs = new Map();

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
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("skywave receiver", { status: 404 });
    }
    const url = new URL(request.url);

    // Every attach carries the receiver's config in the query string —
    // no separate /init round-trip needed, and the first arrival can
    // populate this.config from scratch on a cold DO.
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

    // Record this frame's GPS timestamp before advancing the cumulative
    // sample counter, so the decoder can later convert an in-ring offset
    // to a wall-clock anchor via `_gpsAtAbsSample`.
    const frameAbs = this.totalSamples;
    this.totalSamples += N;
    if (gps) {
      this.gpsFrames.push({
        absSample: frameAbs,
        gpssec:  gps.gpssec  >>> 0,
        gpsnsec: gps.gpsnsec >>> 0,
        fresh:   !!gps.fresh,
      });
      // Trim in lockstep with the audio ring, keeping one extra second
      // of history so extrapolation from a still-fresh anchor works at
      // the oldest ring sample.
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

    // TDOA detection: translate the decoder's in-view sample offset to
    // an absolute sample index, build a GPS-anchored audio snippet, and
    // hand it to the coordinator. Silently skipped if no GPS anchor is
    // available (e.g. the Kiwi's GNSS hasn't fixed yet).
    const absStart = this.totalSamples - this.ring.length
                   + viewOffsetInRing + (call.startSample | 0);
    const det = this._detectionRecord(call, absStart, sr);
    if (det) this._emitDetection(det);

    this._announce({ t: "call", call });
  }

  // Assemble the detection record: receiver metadata, GPS-ns anchor,
  // and an audio snippet spanning the burst for cross-correlation.
  //
  // The snippet has a FIXED length anchored at `packetStart -
  // SNIPPET_BEFORE_SEC`, zero-padded if the ring doesn't cover that
  // much history. Every receiver's snippet for the same packet then
  // begins at the same wall-clock moment (up to the TDOA itself),
  // which is what the coordinator's xcorr relies on.
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
      packetGpsNs: anchor.ns,          // GPS-ns at the packet's start
      snippet: {
        sampleRate: sr,
        startGpsNs: snippetStartAnchor.ns,  // GPS-ns at sample 0
        samples: audio,                     // Float32Array, real(IQ)
      },
    };
  }

  // Map an absolute sample index to a GPS-ns timestamp.
  //
  // The KiwiSDR GNSS reports a new PVT solution ~1/sec; between fixes
  // the same (gpssec, gpsnsec) is stamped on every outgoing IQ frame,
  // so we can't naïvely treat per-frame timestamps as "sample-0 time".
  // Instead: find the latest frame whose gps pair is fresh (or has
  // just changed from the previous), and extrapolate forward by
  // sample-count. The sample rate is GPS-disciplined, so this stays
  // sub-microsecond-accurate across the multi-second ring.
  _gpsAtAbsSample(absSample, sr) {
    const frames = this.gpsFrames;
    if (!frames.length) return null;
    let anchor = null;
    let prevKey = null;
    for (const f of frames) {
      if (f.absSample > absSample) break;
      if (!f.gpssec && !f.gpsnsec) continue;  // no fix on this frame
      const key = `${f.gpssec}.${f.gpsnsec}`;
      if (f.fresh || prevKey !== key) anchor = f;
      prevKey = key;
    }
    if (!anchor) return null;
    const offsetSamples = absSample - anchor.absSample;
    const ns = BigInt(anchor.gpssec) * 1_000_000_000n
             + BigInt(anchor.gpsnsec)
             + BigInt(Math.round(offsetSamples * 1e9 / sr));
    return { ns };
  }

  // Fire-and-forget POST to the TDOA coordinator. Never block the audio
  // path on it: if the coordinator is cold or busy, we drop this
  // detection and the next one will make it through.
  _emitDetection(det) {
    if (!this.env.TDOA) return;
    const body = JSON.stringify({
      ...det,
      packetGpsNs: det.packetGpsNs.toString(),
      snippet: {
        sampleRate: det.snippet.sampleRate,
        startGpsNs: det.snippet.startGpsNs.toString(),
        samples: Array.from(det.snippet.samples),
      },
    });
    const stub = this.env.TDOA.get(this.env.TDOA.idFromName("singleton"));
    stub.fetch("https://tdoa/detect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
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
