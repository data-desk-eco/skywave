// Server-side KiwiSDR client for the Cloudflare Worker runtime.
//
// Protocol: we ask the receiver for IQ at 12 kHz, dial 1.7 kHz below
// the DSC channel, passband 300–3000 Hz. That passband is positive-
// only in IQ space so the Kiwi pre-filters the stream to be analytic,
// which means real(IQ) reproduces USB audio sample-for-sample — what
// the DSC decoder expects.
//
// Why IQ instead of plain USB: stereo (IQ) frames carry a 10-byte GPS
// header per block (last_gps_solution / gpssec / gpsnsec) which the
// mono USB path drops. That per-frame GNSS timestamp is the shared
// time base TDOA geolocation needs.
//
// Redirect handling: public KiwiSDRs behind *.proxy.kiwisdr.com reply
// with a 307-redirect chain on the WS upgrade, which CF Worker (and
// browser) WebSocket clients can't follow transparently. We pre-resolve
// the endpoint with a plain HTTP GET+redirect-follow and open the WS
// against the final host:port. Module-level cache so we only pay the
// resolution once per (host, port), not once per ReceiverDO.

const resolvedEndpointCache = new Map();  // "host:port" → {host, port}
const RESOLVE_TIMEOUT_MS = 5000;

async function resolveEndpoint(host, port) {
  // Only *.proxy.kiwisdr.com actually 307s; direct IPs/hostnames answer
  // WS upgrades on the given port. Skip the round-trip for them.
  if (!/\.proxy\.kiwisdr\.com$/i.test(host)) return { host, port };
  const key = `${host}:${port}`;
  const cached = resolvedEndpointCache.get(key);
  if (cached) return cached;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), RESOLVE_TIMEOUT_MS);
    const probe = await fetch(`http://${host}:${port}/`, {
      redirect: "follow",
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const u = new URL(probe.url);
    const resolved = {
      host: u.hostname,
      port: parseInt(u.port || (u.protocol === "https:" ? "443" : "80"), 10),
    };
    resolvedEndpointCache.set(key, resolved);
    return resolved;
  } catch (_) {
    // Fall back to the original — the WS upgrade itself will surface a
    // clearer error path (onError → reconnect).
    return { host, port };
  }
}

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
    const { host, port } = await resolveEndpoint(this.host, this.port);
    const ts = Math.floor(Date.now() / 1000);
    const target = `http://${host}:${port}/${ts}/SND`;
    let resp;
    try {
      resp = await fetch(target, {
        headers: {
          upgrade: "websocket",
          connection: "upgrade",
          origin: `http://${host}:${port}`,
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
    // "SND" tag is already stripped. Body layout:
    //   flags(1)  seq(u32 LE)  smeter(u16 BE)                             = 7 bytes
    //   [stereo only] last_gps_solution(u8)  dummy(u8)
    //                 gpssec(u32 LE)         gpsnsec(u32 LE)              = 10 bytes
    //   int16-BE samples — interleaved I,Q,I,Q,… in IQ mode.
    if (body.length < 7) return;
    const flags = body[0];
    // compression=0 gets set at handshake but a stray compressed or
    // mono frame can still land before the server applies it.
    if (flags & 0x10) return;       // compressed
    if (!(flags & 0x08)) return;    // not stereo/IQ
    if (body.length < 17) return;
    const rssi = 0.1 * ((body[5] << 8) | body[6]) - 127;
    // GPS: kiwirecorder convention, last_gps_solution==0 means "this
    // frame carries a fresh PVT solution". Between fixes (~1/sec) the
    // same gpssec/gpsnsec repeats across many frames.
    const gpsFresh = body[7] === 0;
    const gpssec  = body[9]  | (body[10] << 8) | (body[11] << 16) | (body[12] << 24);
    const gpsnsec = body[13] | (body[14] << 8) | (body[15] << 16) | (body[16] << 24);

    const iq = body.subarray(17);
    const pairs = iq.length >> 2;             // 4 bytes per complex sample
    const audio = new Float32Array(pairs);    // real(IQ) = USB audio
    // Also emit I-channel-as-int16-BE bytes so the receiver-DO fanout
    // can forward PCM to browsers without re-quantising.
    const pcm = new Uint8Array(pairs * 2);
    for (let i = 0; i < pairs; i++) {
      const hi = iq[i * 4], lo = iq[i * 4 + 1];
      pcm[i * 2] = hi;
      pcm[i * 2 + 1] = lo;
      let s = (hi << 8) | lo;
      if (s & 0x8000) s |= ~0xFFFF;
      audio[i] = s / 32768;
    }
    this.onAudio(audio, this.sampleRate, rssi, pcm, { fresh: gpsFresh, gpssec, gpsnsec });
  }
}
