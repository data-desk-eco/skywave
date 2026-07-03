// burst-alignment estimation for TDOA — complex-envelope cross-
// correlation with CFO compensation.
//
// why not plain real xcorr (the v1 approach): the correlation of two
// real USB-audio snippets oscillates at the ~1.7 kHz tone frequency,
// and its fine-structure peak lands where the pair's random phase
// offset (receiver LO phases + RF carrier phase at the two sites) says
// it lands — an irreducible uniform ±0.29 ms bias, plus ±0.59 ms
// cycle slips under noise. that is the dominant term in the ~1 ms
// timing error the old pipeline carried. the |R| envelope of the
// complex (analytic) cross-correlation has no carrier fine-structure,
// so both terms vanish; what remains is the noise-limited width of the
// envelope peak (~30 us at 0 dB in-band for a 1.5 s burst).
//
// CFO: kiwi LO offsets put the two snippets a few tenths of a Hz to a
// few Hz apart; complex correlation integrates to ~sinc(df*T), so at
// T=1.5 s even 0.5 Hz wipes the peak out. we search a small grid of
// spectral shifts (one FFT-bin granularity) and keep the best peak.

export function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// analytic signal from a real snippet. kiwi IQ mode with a positive-
// only passband delivers an analytic signal whose real part is the USB
// audio, so hilbert() losslessly reconstructs the imaginary part the
// receiver path threw away.
export function hilbert(x) {
  const M = 1 << Math.ceil(Math.log2(x.length));
  const re = new Float64Array(M), im = new Float64Array(M);
  re.set(x);
  fft(re, im);
  // zero negative freqs, double positive (keep DC and nyquist)
  for (let i = 1; i < M / 2; i++) { re[i] *= 2; im[i] *= 2; }
  for (let i = M / 2 + 1; i < M; i++) { re[i] = 0; im[i] = 0; }
  fft(re, im, true);
  return { re: re.subarray(0, x.length), im: im.subarray(0, x.length) };
}

// cubic-hermite resample of a real snippet to a new rate, preserving
// sample-0 time. our tones sit at ~1.7 kHz against a 6-10x oversample,
// so interpolation error is negligible next to channel noise.
export function resample(x, srFrom, srTo) {
  const n = Math.floor(x.length * srTo / srFrom);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * srFrom / srTo;
    const k = Math.floor(t), f = t - k;
    const xm = x[k - 1] ?? 0, x0 = x[k] ?? 0, x1 = x[k + 1] ?? 0, x2 = x[k + 2] ?? 0;
    y[i] = x0 + 0.5 * f * (x1 - xm + f * (2 * xm - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm)));
  }
  return y;
}

// dt such that feature at time t in `a` appears at t+dt in `b`
// (b delayed vs a → dt > 0), for same-rate complex snippets.
// returns { dt (sec), peak, peakRatio, cfoHz } or null.
//
// peakRatio = envelope peak over the rms envelope away from the peak —
// a direct confidence measure on the alignment (2-3 = marginal lock,
// >6 = unambiguous).
export function estimateDt(aRe, aIm, bRe, bIm, sr, opts = {}) {
  const maxLagSec = opts.maxLagSec ?? 0.010;
  const cfoSpanHz = opts.cfoSpanHz ?? 2.5;
  const n = Math.min(aRe.length, bRe.length);
  // M >= n + maxLag keeps every scanned lag linear (the zero-pad tail
  // absorbs the circular wrap) at half the FFT cost of the safe 2n.
  const M = 1 << Math.ceil(Math.log2(n + Math.ceil(maxLagSec * sr) + 2));
  const far = new Float64Array(M), fai = new Float64Array(M);
  const fbr = new Float64Array(M), fbi = new Float64Array(M);
  for (let i = 0; i < n; i++) { far[i] = aRe[i]; fai[i] = aIm[i]; fbr[i] = bRe[i]; fbi[i] = bIm[i]; }
  fft(far, fai); fft(fbr, fbi);
  const binHz = sr / M;
  const kMax = Math.round(cfoSpanHz / binHz);
  const maxLag = Math.min(Math.ceil(maxLagSec * sr), M >> 1);
  let best = null;
  const xr = new Float64Array(M), xi = new Float64Array(M);
  for (let k = -kMax; k <= kMax; k++) {
    // cross-spectrum with b's spectrum shifted by k bins (CFO = k*binHz)
    for (let i = 0; i < M; i++) {
      const j = (i - k + M) % M;
      xr[i] = far[i] * fbr[j] + fai[i] * fbi[j];
      xi[i] = fai[i] * fbr[j] - far[i] * fbi[j];
    }
    fft(xr, xi, true);
    // scan lags: R[L] = sum_n a[n]·conj(b[n-L]) at index (M+L)%M; when
    // b is a-delayed-by-D, the peak sits at L = -D → dt = -L/sr.
    for (let L = -maxLag; L <= maxLag; L++) {
      const idx = (M + L) % M;
      const m = xr[idx] * xr[idx] + xi[idx] * xi[idx];
      if (!best || m > best.m) best = { m, L, k };
    }
  }
  if (!best || best.m <= 0) return null;
  // recompute the winning CFO's envelope for interpolation + stats
  for (let i = 0; i < M; i++) {
    const j = (i - best.k + M) % M;
    xr[i] = far[i] * fbr[j] + fai[i] * fbi[j];
    xi[i] = fai[i] * fbr[j] - far[i] * fbi[j];
  }
  fft(xr, xi, true);
  const env = (L) => {
    const idx = (M + L) % M;
    return Math.hypot(xr[idx], xi[idx]);
  };
  const y0 = env(best.L - 1), y1 = env(best.L), y2 = env(best.L + 1);
  const den = y0 - 2 * y1 + y2;
  const frac = Math.abs(den) > 1e-12 ? 0.5 * (y0 - y2) / den : 0;
  // envelope noise floor: rms outside ±8 ms of the peak (past the FSK
  // 170 Hz beat sidelobes at ±5.9 ms, which scale with the peak and
  // would otherwise flatter noise and penalise strong locks alike)
  const guard = Math.ceil(0.008 * sr);
  let s2 = 0, cnt = 0;
  for (let L = -maxLag; L <= maxLag; L++) {
    if (Math.abs(L - best.L) <= guard) continue;
    const e = env(L); s2 += e * e; cnt++;
  }
  const floor = cnt ? Math.sqrt(s2 / cnt) : 0;
  return {
    dt: -(best.L + frac) / sr,
    peak: y1,
    peakRatio: floor > 0 ? y1 / floor : Infinity,
    cfoHz: best.k * binHz,
  };
}
