// Stripped-down port of kiwirecorder.py — enough to pull uncompressed
// 12 kHz PCM audio from a public KiwiSDR receiver. We skip the waterfall
// stream (computed client-side from audio) and the IMA ADPCM codec (we
// force compression=0 for code-size).

// When the page is served over HTTPS, a Cloudflare Worker tunnels
// WSS→WS to the receivers so the mixed-content rule doesn't block
// ws:// subresources. On http:// (localhost, preview) we talk to
// KiwiSDRs directly.
export const GATEWAY = (() => {
  const meta = document.querySelector('meta[name="skywave-gateway"]');
  const url = meta && meta.content.trim();
  if (!url) return null;
  if (location.protocol !== "https:") return null;
  return url.replace(/\/+$/, "");
})();

export const wsFor = (host, port, path) =>
  GATEWAY
    ? GATEWAY.replace(/^https:/, "wss:") + `/kiwi/${host}/${port}${path}`
    : `ws://${host}:${port}${path}`;

export class KiwiClient {
  constructor(host, port, opts = {}) {
    this.host = host;
    this.port = port;
    this.dialKHz = opts.dialKHz;
    this.lowCut = opts.lowCut || 300;
    this.highCut = opts.highCut || 3000;
    this.onAudio = opts.onAudio || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onMsg = opts.onMsg || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.ws = null;
    this.sampleRate = null;
    this.keepaliveTimer = null;
    this.closed = false;
    this.bytes = 0;
  }

  connect() {
    const ts = Math.floor(Date.now() / 1000);
    this.onStatus("connecting…");
    this.ws = new WebSocket(wsFor(this.host, this.port, `/${ts}/SND`));
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this._onOpen();
    this.ws.onmessage = (e) => this._onMessage(e);
    this.ws.onerror = () => this.onStatus("error");
    this.ws.onclose = () => {
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.closed = true;
      this.onClose();
    };
  }

  close() {
    if (this.ws && this.ws.readyState <= 1) this.ws.close();
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.closed = true;
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(msg);
  }

  _onOpen() {
    this.onStatus("handshaking…");
    this._send("SET auth t=kiwi p=");
    this._send("SET ident_user=skywave");
    // Server kicks idle clients; keep alive every 5s.
    this.keepaliveTimer = setInterval(() => this._send("SET keepalive"), 5000);
  }

  _onMessage(ev) {
    const data = ev.data;
    if (typeof data === "string") return;
    this.bytes += data.byteLength;
    if (data.byteLength < 3) return;
    const dv = new DataView(data);
    const tag = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2));
    if (tag === "MSG") {
      this._handleMsg(new TextDecoder().decode(new Uint8Array(data, 4)));
    } else if (tag === "SND") {
      this._handleSnd(new Uint8Array(data, 3));
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
    this.onMsg(params);

    if ("too_busy" in params) { this.onStatus("server full"); this.close(); return; }
    if ("badp" in params && params.badp !== "0") { this.onStatus("bad password"); this.close(); return; }
    if ("down" in params) { this.onStatus("server down"); this.close(); return; }

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
      this.onStatus(`live · ${this.sampleRate.toFixed(0)} Hz`);
    }
  }

  _handleSnd(body) {
    // After 3-byte tag: flags(1), seq(u32 LE), smeter(u16 BE), audio PCM
    if (body.length < 7) return;
    const flags = body[0];
    const smeter = (body[5] << 8) | body[6];
    const rssi = 0.1 * smeter - 127;
    // We asked for compression=0 but the first frame or two may still
    // arrive compressed while the setting propagates. Skip those.
    if (flags & 0x10) return;
    const count = (body.length - 7) >> 1;
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const hi = body[7 + i * 2], lo = body[7 + i * 2 + 1];
      let s = (hi << 8) | lo;
      if (s & 0x8000) s |= ~0xFFFF;
      samples[i] = s / 32768;
    }
    this.onAudio(samples, this.sampleRate, rssi);
  }
}
