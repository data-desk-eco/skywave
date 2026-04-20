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
    const up = new KiwiUpstream(host, port, {
      dialKHz: bandKHz - 1.7,
      ident: "skywave shared listener",
      onAudio: (samples, sr, rssi, pcmBytes) =>
        this._onAudio(samples, sr, rssi, pcmBytes),
      onReady: (sr) => {
        this.sampleRate = sr;
        this._announce({ t: "status", state: "live", sr });
      },
      onClose: () => {
        this.upstream = null;
        this._announce({ t: "status", state: "down" });
        // Only reconnect if we still have subscribers; otherwise let
        // the idle alarm take care of shutdown.
        if (this.state.getWebSockets().length > 0) {
          setTimeout(() => this._ensureUpstream(), 4000);
        }
      },
      onError: (e) => {
        this._announce({ t: "status", state: "err", msg: String(e) });
      },
    });
    this.upstream = up;
    up.connect().catch((e) => {
      this._announce({ t: "status", state: "err", msg: String(e) });
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

  _onAudio(samples, sr, rssi, pcmBytes) {
    this.rssi = rssi;
    this.sampleRate = sr;
    const N = samples.length;
    if (!N) return;

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
    const view = this.ring.subarray(Math.max(0, this.ring.length - windowLen));

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

    this._announce({ t: "call", call });
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
