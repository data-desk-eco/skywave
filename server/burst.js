// one burst, many receivers → an arrival time per receiver.
// the decoding receivers' soft bits vote on the transmitted sequence;
// every receiver (decoded or not) is then timed against that replica.

import { softBits, bitClock, replica, toa, paths } from "./replica.js";

const TB = 0.01, NB = 980;

// iq: [{host, gps, sr, t0 (gps s of sample 0), z:{re, im, fs}}]
// quality(host) → smaller is a cleaner decode, 999 = did not decode
// returns [{host, gps, sr, dec, t (gps s), cfo, rho, pr, snrDb, sigUs,
//           paths?}] or null when no decoder's cut is present
export function arrivals(iq, quality, withPaths = false) {
  const dec = iq.filter((r) => quality(r.host) < 999).sort((a, b) => quality(a.host) - quality(b.host));
  if (!dec.length || iq.length < 2) return null;
  // common bit grid on gps time, on the cleanest decoder's bit clock
  const T0 = Math.max(...iq.map((r) => r.t0)) + 0.02;
  const refClk = dec[0].t0 + bitClock(dec[0].z, NB);
  const E0 = refClk + Math.ceil((T0 - refClk) / TB) * TB;
  const soft = new Float64Array(NB);
  for (const d of dec.slice(0, 10)) {
    const c = d.t0 + bitClock(d.z, NB);   // own clock, within ±TB/2 of the grid
    const e = E0 + ((((c - E0) / TB + 0.5) % 1 + 1) % 1 - 0.5) * TB;
    const s = softBits(d.z, e - d.t0, NB);
    let norm = 0;
    for (const x of s) norm += Math.abs(x);
    if (norm > 0) for (let k = 0; k < NB; k++) soft[k] += s[k] / norm;
  }
  // burst extent: where the 30-bit mean eye stays above a third of its
  // level in the phasing/message core (2.6 s … 5.6 s into the window)
  const eye = (k) => { let s = 0; for (let j = k; j < k + 30; j++) s += Math.abs(soft[j] ?? 0); return s; };
  const core = [];
  for (let k = 260; k < 560; k += 30) core.push(eye(k));
  const lvl = core.sort((a, b) => a - b)[core.length >> 1] / 3;
  let a = 260, b = 560;
  while (a > 0 && eye(a - 10) > lvl) a -= 10;
  while (b < NB - 30 && eye(b) > lvl) b += 10;
  const rep = replica(Array.from(soft.subarray(a, b), (x) => (x > 0 ? 1 : 0)));
  const tauOf = (r) => E0 + a * TB - r.t0;
  const first = toa(dec[0].z, rep, tauOf(dec[0]), 0.004, 9);   // block DFT aliases every 20 Hz
  return iq.map((r) => {
    const m = r === dec[0] ? first : toa(r.z, rep, tauOf(r) + first.tau - tauOf(dec[0]), 0.008, 1.5, first.cfo);
    return {
      host: r.host, gps: r.gps, sr: Math.round(r.sr), dec: quality(r.host) < 999 ? 1 : 0, t: r.t0 + m.tau,
      cfo: +m.cfo.toFixed(3), rho: +m.rho.toFixed(4), pr: +m.pr.toFixed(1), snrDb: +(10 * Math.log10(m.snr)).toFixed(1),
      sigUs: +(m.sigma * 1e6).toFixed(1),
      paths: withPaths && m.pr > 5 ? paths(r.z, rep, m.tau, m.cfo).map((p) => [r.t0 + p.tau, +p.cfo.toFixed(3), Math.round(p.amp), +(10 * Math.log10(p.snr)).toFixed(1), +(p.sigma * 1e6).toFixed(1)]) : [],
    };
  });
}

// sun elevation (degrees) at [lat, lon] and a js timestamp — decides the
// timing floor: below ~10° the D layer is gone and skywave dominates
export function sunElevation([lat, lon], ms) {
  const d = new Date(ms), r = Math.PI / 180;
  const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
  const dec = -23.44 * Math.cos(2 * Math.PI * (doy + 10) / 365) * r;
  const H = ((d.getUTCHours() + d.getUTCMinutes() / 60 + lon / 15 - 12) * 15) * r;
  return Math.asin(Math.sin(lat * r) * Math.sin(dec) + Math.cos(lat * r) * Math.cos(dec) * Math.cos(H)) / r;
}
