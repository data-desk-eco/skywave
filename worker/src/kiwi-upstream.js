// Server-side KiwiSDR client. A near-mirror of client/kiwi.js, adjusted
// for the Cloudflare Worker runtime:
//   * outbound WebSocket via fetch() with Upgrade headers
//   * ArrayBuffer → Uint8Array without needing DataView ceremony
//   * no onStatus DOM hook; callers get a terse onReady / onError
//
// Protocol: we ask the receiver for IQ at 12 kHz, dial 1.7 kHz below
// the DSC channel, passband 300–3000 Hz. That passband is positive-
// only in IQ space so the Kiwi pre-filters the stream to be analytic,
// which means real(IQ) reproduces USB audio sample-for-sample — what
// the DSC decoder expects.
//
// Why IQ instead of plain USB: stereo (IQ) frames carry a 10-byte GPS
// header per block (last_gps_solution / gpssec / gpsnsec), which the
// mono USB path discards. That per-frame GNSS timestamp is the shared
// time base TDOA geolocation needs.

export class KiwiUpstream {
  constructor(host, port, opts = {}) {
    this.host = host;
    this.port = port;
    this.dialKHz = opts.dialKHz;
    this.lowCut = opts.lowCut ?? 300;
    this.highCut = opts.highCut ?? 3000;
    this.ident = opts.ident || "skywave-shared";
    this.onAudio = opts.onAudio || (() => {});
    this.onReady = opts.onReady || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.onError = opts.onError || (() => {});
    this.ws = null;
    this.sampleRate = null;
    this.keepaliveTimer = null;
    this.closed = false;
  }

  async connect() {
    const ts = Math.floor(Date.now() / 1000);
    const target = `http://${this.host}:${this.port}/${ts}/SND`;
    let resp;
    try {
      resp = await fetch(target, {
        headers: {
          upgrade: "websocket",
          connection: "upgrade",
          origin: `http://${this.host}:${this.port}`,
        },
      });
    } catch (e) {
      this.onError(`fetch threw: ${e.message}`);
      return;
    }
    const ws = resp.webSocket;
    if (!ws) {
      this.onError(`upstream upgrade failed (${resp.status})`);
      return;
    }
    ws.accept();
    this.ws = ws;
    ws.addEventListener("message", (ev) => this._onMessage(ev));
    ws.addEventListener("close", () => this._cleanup());
    ws.addEventListener("error", () => this._cleanup());

    // KiwiSDR expects the handshake immediately after upgrade.
    this._send("SET auth t=kiwi p=");
    this._send(`SET ident_user=${this.ident}`);
    // Server kicks idle clients at ~30s. Keep alive every 5s.
    this.keepaliveTimer = setInterval(() => this._send("SET keepalive"), 5000);
  }

  close() {
    this.closed = true;
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
  }

  _cleanup() {
    if (this.closed) return;
    this.closed = true;
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    this.onClose();
  }

  _send(msg) {
    if (!this.ws) return;
    try { this.ws.send(msg); } catch (_) {}
  }

  _onMessage(ev) {
    const data = ev.data;
    if (typeof data === "string") return;
    const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
    if (u8.length < 3) return;
    const tag = String.fromCharCode(u8[0], u8[1], u8[2]);
    if (tag === "MSG") {
      this._handleMsg(new TextDecoder().decode(u8.subarray(4)));
    } else if (tag === "SND") {
      this._handleSnd(u8.subarray(3));
    }
  }

  _handleMsg(body) {
    const params = {};
    for (const tok of body.split(" ")) {
      if (!tok) continue;
      const eq = tok.indexOf("=");
      if (eq < 0) params[tok] = null;
      else params[tok.slice(0, eq)] = decodeURIComponent(tok.slice(eq + 1));
    }
    if ("too_busy" in params) { this.onError("server full"); this.close(); return; }
    if ("badp" in params && params.badp !== "0") { this.onError("bad password"); this.close(); return; }
    if ("down" in params) { this.onError("server down"); this.close(); return; }
    if ("audio_rate" in params) {
      this._send(`SET AR OK in=${params.audio_rate} out=44100`);
    }
    if ("sample_rate" in params) {
      this.sampleRate = parseFloat(params.sample_rate);
      this._send("SET squelch=0 max=0");
      this._send("SET genattn=0");
      this._send("SET gen=0 mix=-1");
      this._send(`SET mod=iq low_cut=${this.lowCut} high_cut=${this.highCut} freq=${this.dialKHz.toFixed(3)}`);
      this._send("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50");
      this._send("SET compression=0");
      this._send("SET keepalive");
      this.onReady(this.sampleRate);
    }
  }

  _handleSnd(body) {
    // 3-byte "SND" already stripped. Fixed 7-byte header:
    //   flags(1), seq(u32 LE), smeter(u16 BE)
    // Then, in stereo (IQ) mode, a 10-byte GPS block:
    //   last_gps_solution(u8), dummy(u8), gpssec(u32 LE), gpsnsec(u32 LE)
    // Then int16-BE samples. In IQ mode these are interleaved I, Q pairs.
    if (body.length < 7) return;
    const flags = body[0];
    const seq = body[1] | (body[2] << 8) | (body[3] << 16) | (body[4] << 24);
    const smeter = (body[5] << 8) | body[6];
    const rssi = 0.1 * smeter - 127;
    // compression=0 — stereo/IQ is never compressed, but a stray mono-
    // compressed frame can still land before our SET settles.
    if (flags & 0x10) return;
    if (!(flags & 0x08)) return;  // not stereo/IQ; ignore until mod=iq settles
    if (body.length < 17) return;
    const gpsSolution = body[7];
    const gpssec = body[9]  | (body[10] << 8) | (body[11] << 16) | (body[12] << 24);
    const gpsnsec = body[13] | (body[14] << 8) | (body[15] << 16) | (body[16] << 24);
    const gpsFresh = gpsSolution === 0;  // kiwirecorder convention: 0 = fresh fix

    const iqBytes = body.subarray(17);          // int16-BE I,Q,I,Q,...
    const pairs = iqBytes.length >> 2;          // 4 bytes per complex sample
    const audio = new Float32Array(pairs);      // real(IQ) — USB audio
    // Mono PCM (I channel only) as int16-BE bytes, for verbatim browser
    // fanout. Same shape the old USB path produced.
    const pcmBytes = new Uint8Array(pairs * 2);
    for (let i = 0; i < pairs; i++) {
      const hi = iqBytes[i * 4], lo = iqBytes[i * 4 + 1];
      pcmBytes[i * 2] = hi;
      pcmBytes[i * 2 + 1] = lo;
      let s = (hi << 8) | lo;
      if (s & 0x8000) s |= ~0xFFFF;
      audio[i] = s / 32768;
    }
    const gps = { fresh: gpsFresh, gpssec, gpsnsec, seq, nSamples: pairs };
    this.onAudio(audio, this.sampleRate, rssi, pcmBytes, gps, iqBytes);
  }
}
