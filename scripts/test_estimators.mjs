// monte-carlo testbed for DSC burst arrival-time estimators.
//
// simulates two kiwis hearing the same 100-baud CPFSK burst with a known
// fractional-sample TDOA, random per-receiver LO phase, CFO, and band-
// limited noise, then scores estimators on recovered dt:
//   prod — production xcorr (real signals, raw max, parabolic)   [tdoa.js]
//   env  — complex analytic xcorr, CFO grid search, |R| peak
//   fm   — instantaneous-frequency correlation (CFO-immune by design)
//
//   node scripts/test_estimators.mjs [trialsPerCell]

import { xcorr } from "../worker/src/tdoa.js";
import { estimateDt } from "../worker/src/toa.js";

const SR = 11998.9, BAUD = 100, MARK = 1615, SPACE = 1785;
const N = Math.floor(2.0 * SR);          // 2 s snippet like production
const TRIALS = +(process.argv[2] ?? 50);

// ---- tiny fft (radix-2, in-place, float64) ----
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

// ---- burst synthesis ----
// dsc-ish bit pattern: 2 s worth = 200 bits: dot pattern then phasing
// then pseudo-random symbols. exact content barely matters; structure
// (alternations + runs) does.
function makeBits(nBits, seed = 1234) {
  const bits = new Uint8Array(nBits);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 20; i++) bits[i] = i & 1;             // dot pattern
  for (let i = 20; i < nBits; i++) bits[i] = rnd() > 0.5 ? 1 : 0;
  return bits;
}

// continuous CPFSK phase at time t (seconds) for the given bits.
function phaseAt(bits, t) {
  if (t < 0) return 0;
  const Tb = 1 / BAUD;
  const k = Math.min(bits.length - 1, Math.floor(t / Tb));
  let integ = 0;
  for (let i = 0; i < k; i++) integ += (bits[i] ? MARK : SPACE) * Tb;
  integ += (bits[k] ? MARK : SPACE) * (t - k * Tb);
  return 2 * Math.PI * integ;
}

// analytic snippet: burst starts at `startSec` into the window, delayed
// by `tau`, rotated by CFO `dfHz` and phase `ph0`, plus band-limited
// complex noise at `snrDb` (in the 300-3000 Hz passband).
function makeSnippet(bits, startSec, tau, dfHz, ph0, snrDb, rng) {
  const burstSec = bits.length / BAUD;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const t = n / SR - startSec - tau;
    if (t < 0 || t > burstSec) continue;
    const ph = phaseAt(bits, t) + ph0 + 2 * Math.PI * dfHz * (n / SR);
    re[n] = Math.cos(ph); im[n] = Math.sin(ph);
  }
  // band-limited analytic noise, 300-3000 Hz
  const M = 1 << Math.ceil(Math.log2(N));
  const nr = new Float64Array(M), ni = new Float64Array(M);
  for (let i = 0; i < M; i++) { nr[i] = gauss(rng); ni[i] = gauss(rng); }
  fft(nr, ni);
  for (let i = 0; i < M; i++) {
    const f = i / M * SR;
    if (f < 300 || f > 3000) { nr[i] = 0; ni[i] = 0; }
  }
  fft(nr, ni, true);
  // scale: signal power 1 (during burst), noise power → 10^(-snr/10)
  let np = 0;
  for (let i = 0; i < N; i++) np += nr[i] * nr[i] + ni[i] * ni[i];
  np /= N;
  const g = Math.sqrt(Math.pow(10, -snrDb / 10) / np);
  for (let i = 0; i < N; i++) { re[i] += g * nr[i]; im[i] += g * ni[i]; }
  return { re, im };
}

function gauss(rng) {
  let u = 0, v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- estimators under test ----
// production baseline: real-part xcorr, raw max + parabola.
function prodEstimate(a, b, maxLag) {
  const ar = Float32Array.from(a.re), br = Float32Array.from(b.re);
  const { lag } = xcorr(ar, br, maxLag);
  return lag / SR;    // xcorr: positive lag = b delayed vs a
}

// fm: correlate instantaneous frequencies (phase-diff), CFO-immune.
function fmEstimate(a, b, maxLag) {
  const inst = (s) => {
    const f = new Float64Array(N - 1);
    for (let i = 1; i < N; i++) {
      const cr = s.re[i] * s.re[i - 1] + s.im[i] * s.im[i - 1];
      const ci = s.im[i] * s.re[i - 1] - s.re[i] * s.im[i - 1];
      const mag = Math.hypot(s.re[i], s.im[i]) * Math.hypot(s.re[i - 1], s.im[i - 1]);
      f[i - 1] = mag > 1e-6 ? Math.atan2(ci, cr) : 0;
    }
    const mean = f.reduce((x, y) => x + y, 0) / f.length;
    for (let i = 0; i < f.length; i++) f[i] -= mean;
    return f;
  };
  const fa = inst(a), fb = inst(b);
  let best = -Infinity, bl = 0;
  const c = new Float64Array(2 * maxLag + 1);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    const i0 = Math.max(0, -lag), i1 = Math.min(fa.length, fa.length - lag);
    for (let i = i0; i < i1; i++) s += fa[i] * fb[i + lag];
    c[lag + maxLag] = s;
    if (s > best) { best = s; bl = lag; }
  }
  const idx = bl + maxLag;
  let r = bl;
  if (idx > 0 && idx < c.length - 1) {
    const d = c[idx - 1] - 2 * c[idx] + c[idx + 1];
    if (Math.abs(d) > 1e-12) r = bl + 0.5 * (c[idx - 1] - c[idx + 1]) / d;
  }
  return r / SR;
}

// ---- monte carlo ----
const bits = makeBits(Math.floor(1.4 * BAUD));
const maxLag = Math.ceil(0.010 * SR);
console.log("snr cfoHz | est        p50_us   p90_us   rms_us  slip%   (slip = |err| > 250 us)");
for (const snr of [0, 5, 10, 20]) {
  for (const cfo of [0, 0.5, 2]) {
    const errs = { prod: [], env: [], fm: [] };
    for (let tr = 0; tr < TRIALS; tr++) {
      const rng = mulberry(snr * 7919 + cfo * 104729 + tr * 31 + 7);
      const tau = (rng() - 0.5) * 0.008;            // ±4 ms true dt
      const a = makeSnippet(bits, 0.5, 0, 0, rng() * 7, snr, rng);
      const b = makeSnippet(bits, 0.5, tau, cfo * (rng() - 0.5) * 2, rng() * 7, snr, rng);
      errs.prod.push(prodEstimate(a, b, maxLag) - tau);
      errs.env.push(estimateDt(a.re, a.im, b.re, b.im, SR, { maxLagSec: 0.010 }).dt - tau);
      errs.fm.push(fmEstimate(a, b, maxLag) - tau);
    }
    for (const [name, e] of Object.entries(errs)) {
      const abs = e.map(Math.abs).sort((x, y) => x - y);
      const p = (q) => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))] * 1e6;
      const rms = Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length) * 1e6;
      const slip = abs.filter((x) => x > 250e-6).length / abs.length * 100;
      console.log(`${String(snr).padStart(3)} ${String(cfo).padStart(5)} | ${name.padEnd(4)} ${p(0.5).toFixed(1).padStart(10)} ${p(0.9).toFixed(1).padStart(8)} ${rms.toFixed(1).padStart(8)} ${slip.toFixed(0).padStart(5)}`);
    }
  }
}
