#!/usr/bin/env node
// Synthetic validation of the TDOA solver.
//
// Places a virtual transmitter and four virtual KiwiSDR receivers at
// real NW-Europe coordinates, generates a short DSC-like FSK burst,
// applies the true inter-receiver path delays (with fractional-sample
// resolution + noise), recovers inter-arrival time via xcorr, and asks
// solveTdoa() to reconstruct the transmitter position.
//
// Run:   node scripts/test_tdoa.mjs [--trials N]
//
// Success criterion: recovered position within a few km of ground truth
// over many trials. Real-world floor is worse (ionospheric path bias,
// receiver clock jitter, multipath); this script only validates the
// geometry and signal-processing chain.

import { xcorr, solveTdoa, geodist, C } from "../worker/src/tdoa.js";

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const TRIALS = parseInt(getArg("--trials", "20"), 10);
const NOISE = parseFloat(getArg("--noise", "0.05"));     // 5% additive per sample
const SR = 12000;
const SEED = parseInt(getArg("--seed", "1"), 10);

// --- Test geometry ---------------------------------------------------------
const receivers = [
  { name: "Chichester UK", gps: [50.846, -0.662] },
  { name: "Dover UK",      gps: [51.129,  1.316] },
  { name: "Den Helder NL", gps: [52.958,  4.760] },
  { name: "Bergen NO",     gps: [60.391,  5.322] },
];

// --- Synthetic DSC-ish FSK burst ------------------------------------------
// 100 baud FSK at 1615/1785 Hz with pseudorandom payload bits. Rendered
// at OVERSAMPLE × SR and decimated per-receiver to its own sample grid
// (offset by the true continuous-time delay). Linear-interp fractional
// delay on the 12 kHz grid has been shown to smear the xcorr peak by
// 1–2 samples on FSK content; oversampling removes that artefact because
// each receiver now sees a genuine Nyquist-sampled realisation.
const OVERSAMPLE = 8;
const HIGH_SR = SR * OVERSAMPLE;

function makeBurst(nSymbols = 200, rngSeed = 0xD5C) {
  const sps = HIGH_SR / 100;              // samples per symbol at high rate
  const total = Math.floor(sps * nSymbols);
  const out = new Float32Array(total);
  const rng = mulberry32(rngSeed);
  const symbols = new Uint8Array(nSymbols);
  for (let s = 0; s < nSymbols; s++) symbols[s] = rng() < 0.5 ? 0 : 1;
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const sym = symbols[Math.floor(i / sps)];
    const freq = sym ? 1785 : 1615;
    phase += 2 * Math.PI * freq / HIGH_SR;
    out[i] = Math.sin(phase);
  }
  const fadeN = 20 * OVERSAMPLE;
  for (let i = 0; i < fadeN; i++) {
    const w = 0.5 * (1 - Math.cos(Math.PI * i / fadeN));
    out[i] *= w;
    out[total - 1 - i] *= w;
  }
  return out;
}

// Small deterministic PRNG so runs reproduce.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simulate a receiver's capture of the continuous-time burst.
// `arrivalSec` = the time (relative to the receiver's own sample grid
// zero) at which the leading edge of base lands. Positive = later arrival
// = further from transmitter. Output is at SR, padded padSec on each
// end. Nearest-neighbour on the oversampled grid is accurate to
// 1/OVERSAMPLE of an output sample (~0.01 ms at OVERSAMPLE=8, SR=12 kHz).
function sampleReceiver(highRateBase, arrivalSec, padSec, noise, rng) {
  const padSamples = Math.ceil(padSec * SR);
  const burstSec = highRateBase.length / HIGH_SR;
  const totalOut = Math.ceil((burstSec + arrivalSec) * SR) + 2 * padSamples;
  const out = new Float32Array(totalOut);
  for (let k = 0; k < totalOut; k++) {
    const t = (k - padSamples) / SR - arrivalSec;   // time into the burst
    const idx = Math.round(t * HIGH_SR);
    if (idx >= 0 && idx < highRateBase.length) out[k] = highRateBase[idx];
    out[k] += (rng() - 0.5) * 2 * noise;
  }
  return out;
}

// --- One trial ------------------------------------------------------------
function runTrial(txGps, rng) {
  const base = makeBurst(200);
  const arrivals = receivers.map(r => geodist(r.gps, txGps) / C);
  const refArr = arrivals[0];
  const relDelays = arrivals.map(t => t - refArr);

  // Each receiver's 12 kHz capture window is aligned to rx[0]: sample k
  // of its stream represents time (k - pad)/SR + relDelays[i] relative
  // to rx[0]'s zero. The burst itself lives in `base` at HIGH_SR centred
  // on t=0, and sampleReceiver picks it up at the receiver's phase grid.
  const padSec = 0.05;    // 50 ms of silence flanking the burst
  const sigs = relDelays.map(t => sampleReceiver(base, t, padSec, NOISE, rng));

  const maxAbsSamples = Math.max(...relDelays.map(t => Math.abs(t * SR)));
  const ref = sigs[0];
  const maxLag = Math.ceil(maxAbsSamples) + 20;

  const dets = sigs.map((s, i) => {
    if (i === 0) return { gps: receivers[0].gps, t: 0 };
    const { lag } = xcorr(ref, s, maxLag);
    return { gps: receivers[i].gps, t: lag / SR };
  });

  const solved = solveTdoa(dets);
  const errKm = geodist([solved.lat, solved.lon], txGps) / 1000;

  return {
    txGps,
    solved: [solved.lat, solved.lon],
    errKm,
    residualKm: solved.residualKm,
    relDelays,
    recoveredDelays: dets.map(d => d.t),
  };
}

// --- Drive several trials at different TX positions -----------------------
const rng = mulberry32(SEED);
const txCandidates = [
  [52.0,  3.5],   // off Dutch coast
  [54.0,  6.0],   // German Bight
  [58.0, -2.0],   // North Sea, N Scotland
  [51.5, -5.0],   // Celtic Sea
  [57.0,  7.5],   // Skagerrak
];

console.log(`# TDOA self-test — ${TRIALS} trials × ${txCandidates.length} TX positions`);
console.log(`# sr=${SR} Hz, noise=${NOISE}, seed=${SEED}`);
console.log();
console.log("tx_lat   tx_lon   solved_lat  solved_lon  err_km  resid_km");

const errors = [];
for (const tx of txCandidates) {
  for (let t = 0; t < TRIALS; t++) {
    const r = runTrial(tx, rng);
    errors.push(r.errKm);
    if (t === 0) {
      console.log(
        `${tx[0].toFixed(3).padStart(6)}  ${tx[1].toFixed(3).padStart(7)}  `
        + `${r.solved[0].toFixed(3).padStart(9)}  ${r.solved[1].toFixed(3).padStart(10)}  `
        + `${r.errKm.toFixed(2).padStart(6)}  ${r.residualKm.toFixed(3).padStart(8)}`,
      );
    }
  }
}

errors.sort((a, b) => a - b);
const p50 = errors[Math.floor(errors.length * 0.5)];
const p90 = errors[Math.floor(errors.length * 0.9)];
const mean = errors.reduce((s, x) => s + x, 0) / errors.length;
console.log();
console.log(`# n=${errors.length}   mean=${mean.toFixed(2)} km   p50=${p50.toFixed(2)} km   p90=${p90.toFixed(2)} km   max=${errors[errors.length-1].toFixed(2)} km`);
