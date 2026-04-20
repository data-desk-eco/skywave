// Server-side KiwiSDR client. A near-mirror of client/kiwi.js, adjusted
// for the Cloudflare Worker runtime:
//   * outbound WebSocket via fetch() with Upgrade headers
//   * ArrayBuffer → Uint8Array without needing DataView ceremony
//   * no onStatus DOM hook; callers get a terse onReady / onError
//
// Protocol: we ask the receiver for USB-demodulated audio at 12 kHz,
// passband 300–3000 Hz, dial 1.7 kHz below the DSC channel. Compression
// is disabled (compression=0) so frames arrive as raw int16 PCM.

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
      this._send(`SET mod=usb low_cut=${this.lowCut} high_cut=${this.highCut} freq=${this.dialKHz.toFixed(3)}`);
      this._send("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50");
      this._send("SET compression=0");
      this._send("SET keepalive");
      this.onReady(this.sampleRate);
    }
  }

  _handleSnd(body) {
    // 3-byte "SND" already stripped. Next: flags(1), seq(u32 LE),
    // smeter(u16 BE), then int16-BE audio PCM.
    if (body.length < 7) return;
    const flags = body[0];
    const smeter = (body[5] << 8) | body[6];
    const rssi = 0.1 * smeter - 127;
    // compression=0 may not have propagated to the very first frame.
    if (flags & 0x10) return;
    const count = (body.length - 7) >> 1;
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const hi = body[7 + i * 2], lo = body[7 + i * 2 + 1];
      let s = (hi << 8) | lo;
      if (s & 0x8000) s |= ~0xFFFF;
      samples[i] = s / 32768;
    }
    // Hand the raw int16 bytes up too so we can forward them verbatim
    // as PCM without re-encoding Float32 → int16 for the fanout.
    const pcmBytes = body.subarray(7);
    this.onAudio(samples, this.sampleRate, rssi, pcmBytes);
  }
}
