// data-aided arrival-time estimation. once any receiver has decoded a
// burst its bit sequence is known, so every receiver's arrival time is
// measured against a noise-free CPFSK replica instead of against
// another receiver's noisy snippet: no noise×noise term, a per-receiver
// SNR (hence a per-receiver sigma for the solver), and receivers that
// never decoded the burst still yield a timing.

const TB = 0.01, DEV = 85;   // bit period (s), ±deviation (Hz)

// mix a complex snippet down by f0, low-pass (windowed sinc, ±cut Hz)
// and decimate by D. symmetric taps → zero group delay; output sample m
// sits at input time m·D/sr.
export function baseband(i, q, sr, f0, D = Math.round(sr / 2000), cut = 300) {
  const n = i.length, w = -2 * Math.PI * f0 / sr;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const c = Math.cos(w * k), s = Math.sin(w * k);
    re[k] = i[k] * c - q[k] * s; im[k] = i[k] * s + q[k] * c;
  }
  const H = 4 * D, h = new Float64Array(2 * H + 1);
  let g = 0;
  for (let k = -H; k <= H; k++) {
    const x = 2 * cut / sr * k;
    h[k + H] = (x ? Math.sin(Math.PI * x) / (Math.PI * x) : 1) * (0.5 + 0.5 * Math.cos(Math.PI * k / (H + 1)));
    g += h[k + H];
  }
  const m = Math.floor(n / D), zr = new Float64Array(m), zi = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    let a = 0, b = 0;
    for (let k = Math.max(-H, -j * D), e = Math.min(H, n - 1 - j * D); k <= e; k++) {
      a += re[j * D + k] * h[k + H]; b += im[j * D + k] * h[k + H];
    }
    zr[j] = a / g; zi[j] = b / g;
  }
  return { re: zr, im: zi, fs: sr / D };
}

// soft bits (mark − space energy; mark = low tone = 1) for nb bit
// windows starting t0 seconds into z.
export function softBits(z, t0, nb) {
  const out = new Float64Array(nb), w = 2 * Math.PI * DEV / z.fs;
  for (let b = 0; b < nb; b++) {
    const a = Math.ceil((t0 + b * TB) * z.fs), e = Math.ceil((t0 + (b + 1) * TB) * z.fs);
    if (a < 0 || e > z.re.length) continue;
    let mr = 0, mi = 0, sr = 0, si = 0;
    for (let k = a; k < e; k++) {
      const c = Math.cos(w * k), s = Math.sin(w * k);
      mr += z.re[k] * c - z.im[k] * s; mi += z.re[k] * s + z.im[k] * c;
      sr += z.re[k] * c + z.im[k] * s; si += z.im[k] * c - z.re[k] * s;
    }
    out[b] = mr * mr + mi * mi - sr * sr - si * si;
  }
  return out;
}

// bit-clock phase (s, in [0, TB)) maximising eye opening
export function bitClock(z, nb) {
  let best = 0, bv = -1;
  for (let o = 0; o < TB; o += 0.0005) {
    const s = softBits(z, o, nb);
    let v = 0;
    for (const x of s) v += Math.abs(x);
    if (v > bv) { bv = v; best = o; }
  }
  return best;
}

// CPFSK replica phase track: phase at each bit boundary
export function replica(bits) {
  const ph = new Float64Array(bits.length + 1);
  for (let k = 0; k < bits.length; k++) ph[k + 1] = ph[k] + 2 * Math.PI * DEV * TB * (bits[k] ? -1 : 1);
  return { bits, ph };
}

// y[n] = z[n]·conj(s(t_n − tau)); returns block sums (blk samples) so
// the cfo search is a short DFT. samples outside the replica are skipped.
function despread(z, rep, tau, blk) {
  const nb = rep.bits.length, m = z.re.length, B = Math.ceil(m / blk);
  const yr = new Float64Array(B), yi = new Float64Array(B);
  for (let n = 0; n < m; n++) {
    const u = n / z.fs - tau, k = Math.floor(u / TB);
    if (k < 0 || k >= nb) continue;
    const p = rep.ph[k] + 2 * Math.PI * DEV * (rep.bits[k] ? -1 : 1) * (u - k * TB);
    const c = Math.cos(p), s = Math.sin(p), b = (n / blk) | 0;
    yr[b] += z.re[n] * c + z.im[n] * s; yi[b] += z.im[n] * c - z.re[n] * s;
  }
  return { yr, yi };
}

function power(y, nu, dtBlk, from = 0, to = y.yr.length) {
  let a = 0, b = 0;
  for (let k = from; k < to; k++) {
    const p = -2 * Math.PI * nu * k * dtBlk, c = Math.cos(p), s = Math.sin(p);
    a += y.yr[k] * c - y.yi[k] * s; b += y.yr[k] * s + y.yi[k] * c;
  }
  return [a * a + b * b, a, b];
}

// matched-filter TOA of the replica's bit-0 edge within z (seconds from
// z's first sample). searches tau0 ± span and cfo0 ± cfoSpan.
// returns { tau, cfo, rho, pr, snr, sigma, seg: [{tau, amp, ph}] };
// pr = peak over the rms of off-peak probes — the detection statistic
// for receivers that did not decode (noise alone gives ~1–3).
export function toa(z, rep, tau0, span = 0.008, cfoSpan = 12, cfo0 = 0) {
  const blk = Math.round(z.fs * 0.05), dtB = blk / z.fs;
  let best = { p: -1 };
  for (let tau = tau0 - span; tau <= tau0 + span; tau += 0.001) {
    const y = despread(z, rep, tau, blk);
    for (let nu = cfo0 - cfoSpan; nu <= cfo0 + cfoSpan; nu += 0.04) {
      const [p] = power(y, nu, dtB);
      if (p > best.p) best = { p, tau, nu };
    }
  }
  let { tau, nu } = best;
  const P = (t, v) => power(despread(z, rep, t, blk), v, dtB)[0];
  const para = (f, x, h) => {
    const a = f(x - h), b = f(x), c = f(x + h), d = a - 2 * b + c;
    return d < 0 ? x + Math.max(-h, Math.min(h, 0.5 * h * (a - c) / d)) : x;
  };
  for (const [ht, hn] of [[4e-4, 0.02], [1e-4, 0.01], [3e-5, 0.005], [1e-5, 0.002]]) {
    nu = para((v) => P(tau, v), nu, hn);
    tau = para((t) => P(t, nu), tau, ht);
  }
  const y = despread(z, rep, tau, blk);
  const [p] = power(y, nu, dtB);
  // noise floor: same statistic at delays/offsets where no replica fits
  let fl = 0, nf = 0;
  for (const dt of [-0.237, -0.163, -0.091, 0.087, 0.149, 0.223]) {
    const yo = despread(z, rep, tau + dt, blk);
    for (const dn of [-3.3, -1.7, 0.9, 2.3, 4.1]) { fl += power(yo, nu + dn, dtB)[0]; nf++; }
  }
  const pr = Math.sqrt(p / (fl / nf));
  // energy of z under the replica's support, and replica energy (= count)
  let ez = 0, cnt = 0;
  for (let n = 0; n < z.re.length; n++) {
    const k = Math.floor((n / z.fs - tau) / TB);
    if (k < 0 || k >= rep.bits.length) continue;
    ez += z.re[n] ** 2 + z.im[n] ** 2; cnt++;
  }
  const rho2 = Math.min(0.999999, p / (ez * cnt));
  const snr = rho2 / (1 - rho2);              // in the baseband filter band
  // CRLB with rms bandwidth ~100 Hz; E/N0 = snr·cnt (per complex sample)
  const sigma = 1 / (2 * Math.PI * 100 * Math.sqrt(2 * snr * cnt * 600 / z.fs));
  // per-quarter diagnostics: local tau, amplitude, phase
  const B = y.yr.length, seg = [], h = 2e-4;
  const ym = despread(z, rep, tau - h, blk), yp = despread(z, rep, tau + h, blk);
  for (let s = 0; s < 4; s++) {
    const f = Math.floor(s * B / 4), t = Math.floor((s + 1) * B / 4);
    const [b, re, im] = power(y, nu, dtB, f, t);
    const a = power(ym, nu, dtB, f, t)[0], c = power(yp, nu, dtB, f, t)[0], d = a - 2 * b + c;
    seg.push({ tau: d < 0 ? 0.5 * h * (a - c) / d : NaN, amp: Math.sqrt(b), ph: Math.atan2(im, re) });
  }
  return { tau, cfo: nu, rho: Math.sqrt(rho2), pr, snr, sigma, seg };
}

// replica waveform a·s(t − tau)·e^{j2π nu t} sampled on z's grid
function wave(z, rep, tau, nu) {
  const m = z.re.length, re = new Float64Array(m), im = new Float64Array(m), nb = rep.bits.length;
  let cnt = 0;
  for (let n = 0; n < m; n++) {
    const t = n / z.fs, u = t - tau, k = Math.floor(u / TB);
    if (k < 0 || k >= nb) continue;
    const p = rep.ph[k] + 2 * Math.PI * DEV * (rep.bits[k] ? -1 : 1) * (u - k * TB) + 2 * Math.PI * nu * t;
    re[n] = Math.cos(p); im[n] = Math.sin(p); cnt++;
  }
  return { re, im, cnt };
}
const proj = (z, w) => {
  let a = 0, b = 0;
  for (let n = 0; n < w.re.length; n++) { a += z.re[n] * w.re[n] + z.im[n] * w.im[n]; b += z.im[n] * w.re[n] - z.re[n] * w.im[n]; }
  return [a / w.cnt, b / w.cnt];
};
const axpy = (z, w, [a, b], s) => {
  for (let n = 0; n < w.re.length; n++) { z.re[n] += s * (a * w.re[n] - b * w.im[n]); z.im[n] += s * (a * w.im[n] + b * w.re[n]); }
};

// multipath decomposition. at night a receiver hears the ground wave
// plus one or more ionospheric hops 0.3–5 ms later, each with its own
// doppler; a single correlation peak then lands anywhere between them.
// with the bit sequence known, the delay–doppler surface is a thumbtack,
// so paths are peeled off strongest-first (subtract, re-search), then
// re-fitted against each other. the EARLIEST path is the one a geodesic
// solver wants: the ground wave when there is one.
// returns [{tau, cfo, amp, snr, sigma}] sorted by tau.
export function paths(z, rep, tau0, cfo0 = 0, maxK = 5) {
  const blk = Math.round(z.fs * 0.05), dtB = blk / z.fs;
  const r = { re: z.re.slice(), im: z.im.slice(), fs: z.fs }, out = [];
  const P = (t, v) => power(despread(r, rep, t, blk), v, dtB)[0];
  const para = (f, x, h) => {
    const a = f(x - h), b = f(x), c = f(x + h), d = a - 2 * b + c;
    return d < 0 ? x + Math.max(-h, Math.min(h, 0.5 * h * (a - c) / d)) : x;
  };
  const refine = (p) => {
    for (const [ht, hn] of [[2e-4, 0.02], [5e-5, 0.01], [1.5e-5, 0.004]]) {
      p.cfo = para((v) => P(p.tau, v), p.cfo, hn);
      p.tau = para((t) => P(t, p.cfo), p.tau, ht);
    }
    p.w = wave(r, rep, p.tau, p.cfo); p.a = proj(r, p.w);
  };
  for (let k = 0; k < maxK; k++) {
    let best = { p: -1 };
    const all = [];
    for (let tau = tau0 - 0.004; tau <= tau0 + 0.012; tau += 0.0005) {
      const y = despread(r, rep, tau, blk);
      for (let nu = cfo0 - 1.5; nu <= cfo0 + 1.5; nu += 0.05) {
        const [p] = power(y, nu, dtB);
        all.push(p);
        if (p > best.p) best = { p, tau, cfo: nu };
      }
    }
    const med = all.sort((a, b) => a - b)[all.length >> 1];
    refine(best);
    const amp = Math.hypot(...best.a);
    if (k && (best.p < 30 * med || amp < 0.15 * out[0].amp)) break;
    best.amp = amp;
    axpy(r, best.w, best.a, -1);
    out.push(best);
  }
  for (let it = 0; it < 2 && out.length > 1; it++) for (const p of out) {
    axpy(r, p.w, p.a, 1); refine(p); p.amp = Math.hypot(...p.a); axpy(r, p.w, p.a, -1);
  }
  let nv = 0;
  for (let n = 0; n < r.re.length; n++) if (out[0].w.re[n] || out[0].w.im[n]) nv += r.re[n] ** 2 + r.im[n] ** 2;
  nv /= out[0].w.cnt;
  return out.map((p) => {
    const snr = p.amp ** 2 / nv;
    return { tau: p.tau, cfo: p.cfo, amp: p.amp, snr, sigma: 1 / (2 * Math.PI * 100 * Math.sqrt(2 * snr * p.w.cnt * 600 / z.fs)) };
  }).sort((a, b) => a.tau - b.tau);
}
