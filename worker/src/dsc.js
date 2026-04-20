// ITU-R M.493 maritime DSC decoder — 100 baud FSK, mark 1615 Hz /
// space 1785 Hz on the audio after USB demod of a 2187.5 kHz channel
// with dial 2185.8. Phasing: DX symbol 125 at even byte positions,
// RX counter 111..104 descending at odd. Symbols are 10-bit LSB-first
// on the wire (7 info bits then 3 check bits MSB-first).
// Port of ~/Research/dsc-triangulation/scripts/dsc_decode_ddesk.py.

const BAUD = 100;
const MARK = 1615.0;
const SPACE = 1785.0;
const DX_SYM = 125;
const RX_COUNTERS = [111, 110, 109, 108, 107, 106, 105, 104];

const FORMATS = {
  102: "geographic area call",
  112: "distress alert",
  114: "group call",
  116: "all ships",
  120: "selective call",
  123: "automatic service",
};
const CATEGORIES = {
  100: "routine",
  108: "safety",
  110: "urgency",
  112: "distress",
};
const TELECOMMANDS = {
  100: "F3E/G3E all modes",
  101: "F3E/G3E duplex",
  103: "polling",
  104: "unable to comply",
  105: "end of call",
  106: "data",
  109: "J3E TP",
  110: "distress ack",
  112: "distress relay",
  118: "test",
  121: "ship position",
  126: "no information",
};
const DISTRESS_NATURES = {
  100: "fire / explosion",
  101: "flooding",
  102: "collision",
  103: "grounding",
  104: "capsizing",
  105: "sinking",
  106: "disabled & adrift",
  107: "undesignated",
  108: "abandoning ship",
  109: "piracy",
  110: "man overboard",
  112: "EPIRB emission",
};
const EOS_SYMBOLS = { 117: "REQ", 122: "ACK", 127: "EOS" };

// Non-coherent I/Q FSK demod. Per bit window: correlate samples against
// cos/sin of mark and space; bit = 1 iff mark power > space power.
//
// KiwiSDR serves audio at ~11998.9 Hz (not an integer multiple of 100
// baud), so we must track bit boundaries as floats — using floor(sr/BAUD)
// drifts by ~0.008 samples/bit → ~5 bit periods over a full burst → every
// data symbol fails its check. The integer `spb` only sets the correlator
// window size; the per-bit start offset is derived from the true rate.
function fskDemod(samples, sr, mark, space) {
  const samplesPerBit = sr / BAUD;
  const spb = Math.floor(samplesPerBit);
  if (spb < 4) throw new Error(`sr ${sr} too low for ${BAUD} baud`);
  const nb = Math.floor(samples.length / samplesPerBit);
  const bits = new Uint8Array(nb);
  const mc = new Float32Array(spb), ms = new Float32Array(spb);
  const sc = new Float32Array(spb), ss = new Float32Array(spb);
  const w = 2 * Math.PI / sr;
  for (let i = 0; i < spb; i++) {
    mc[i] = Math.cos(w * mark * i);
    ms[i] = Math.sin(w * mark * i);
    sc[i] = Math.cos(w * space * i);
    ss[i] = Math.sin(w * space * i);
  }
  for (let b = 0; b < nb; b++) {
    let mcs = 0, mss = 0, scs = 0, sss = 0;
    const off = Math.round(b * samplesPerBit);
    if (off + spb > samples.length) break;
    for (let i = 0; i < spb; i++) {
      const s = samples[off + i];
      mcs += s * mc[i]; mss += s * ms[i];
      scs += s * sc[i]; sss += s * ss[i];
    }
    bits[b] = (mcs * mcs + mss * mss > scs * scs + sss * sss) ? 1 : 0;
  }
  return bits;
}

// Bit → 10-bit symbol (LSB-first wire order).
function packLSB(bits, start) {
  let s = 0;
  for (let j = 0; j < 10; j++) s |= bits[start + j] << j;
  return s;
}

// Returns [info7bit, hasCheckError]. Check bits are the count of zeros in
// the info field, transmitted MSB-first — so when we pack LSB-first the
// top 3 bits of `packed` need re-ordering to recover the expected count.
function decode10(packed) {
  const info = packed & 0x7F;
  const b7 = (packed >> 7) & 1;
  const b8 = (packed >> 8) & 1;
  const b9 = (packed >> 9) & 1;
  const check = (b7 << 2) | (b8 << 1) | b9;
  let ones = 0;
  for (let k = 0; k < 7; k++) if (info & (1 << k)) ones++;
  const expected = 7 - ones;
  return [info, check !== expected];
}

// Phasing search: scan every bit offset; score the first 16 candidate
// bytes against the interleaved DX/RX pattern. Fewer than ~5 mismatches
// in 15 checks = a lock. Real captures under fading/AGC pumping often
// score 3–4; tighter than that and we reject most live traffic.
function scorePhasing(bytes_) {
  if (bytes_.length < 15) return 999;
  let score = 0;
  for (let i = 0; i < 7; i++) if (bytes_[i * 2] !== DX_SYM) score++;
  for (let i = 0; i < 8; i++) if (bytes_[i * 2 + 1] !== RX_COUNTERS[i]) score++;
  return score;
}

function findPhasing(bits, maxScore = 5) {
  let bestStart = -1, bestScore = maxScore + 1;
  const maxStart = bits.length - 160;
  const bytes_ = new Array(16);
  for (let start = 0; start < maxStart; start++) {
    for (let k = 0; k < 16; k++) {
      bytes_[k] = decode10(packLSB(bits, start + k * 10))[0];
    }
    const s = scorePhasing(bytes_);
    if (s < bestScore) { bestStart = start; bestScore = s; }
    if (s === 0) break;
  }
  return { start: bestStart, score: bestScore };
}

function bitsToBytes(bits, start) {
  const out = [];
  for (let i = start; i + 10 <= bits.length; i += 10) {
    const [info, err] = decode10(packLSB(bits, i));
    out.push(err ? -1 : info);
  }
  return out;
}

// Every other byte is DX (primary), the rest is RX (5-symbol-delayed
// repeat). The real message starts at DX[6]; on a check failure we sub
// in the RX copy offset by 2. See TAOSW.GMDSSDecoderHelper.
function deinterleave(bytes_) {
  const dx = [], rx = [];
  for (let i = 0; i < bytes_.length; i++) (i % 2 === 0 ? dx : rx).push(bytes_[i]);
  const syms = [];
  for (let c = 6; c < dx.length; c++) {
    if (dx[c] !== -1) syms.push(dx[c]);
    else if (rx.length > c + 2) syms.push(rx[c + 2]);
    else syms.push(-1);
  }
  return syms;
}

function mmsiFromBCD(symbols5) {
  let s = "";
  for (const sy of symbols5) {
    if (sy >= 0 && sy <= 99) s += sy.toString().padStart(2, "0");
    else s += "??";
  }
  return s.slice(0, 9);
}

function parseCall(symbols) {
  if (symbols.length < 13) return null;
  const fmt = symbols[0];
  const fmt2 = symbols[1] != null ? symbols[1] : -1;
  const call = {
    format: FORMATS[fmt] || `unknown(${fmt})`,
    formatCode: fmt,
    destination: null,
    caller: null,
    category: null,
    categoryCode: null,
    tc1: null, tc2: null,
    tc1Code: null, tc2Code: null,
    eos: null,
    ecc_valid: FORMATS[fmt] !== undefined,
    errors: [],
    symbols,
  };
  if (fmt !== fmt2 && fmt2 !== -1) call.errors.push(`format mismatch ${fmt}/${fmt2}`);

  if (fmt === 112) {
    call.caller = mmsiFromBCD(symbols.slice(2, 7));
    call.category = "distress";
    call.categoryCode = 112;
    const nat = symbols[7];
    if (nat != null) {
      call.tc1 = DISTRESS_NATURES[nat] || `nature(${nat})`;
      call.tc1Code = nat;
    }
  } else {
    call.destination = mmsiFromBCD(symbols.slice(2, 7));
    const cat = symbols[7];
    if (cat != null) {
      call.category = CATEGORIES[cat] || `cat(${cat})`;
      call.categoryCode = cat;
    }
    if (symbols.length > 12) call.caller = mmsiFromBCD(symbols.slice(8, 13));
    const t1 = symbols[13], t2 = symbols[14];
    if (t1 != null) { call.tc1 = TELECOMMANDS[t1] || `tc(${t1})`; call.tc1Code = t1; }
    if (t2 != null) { call.tc2 = TELECOMMANDS[t2] || `tc(${t2})`; call.tc2Code = t2; }
  }

  for (let i = symbols.length - 1; i >= 0; i--) {
    if (EOS_SYMBOLS[symbols[i]]) { call.eos = EOS_SYMBOLS[symbols[i]]; break; }
  }
  if (!call.eos) call.eos = "—";

  // A caller-MMSI with >3 "??" BCD digits is almost certainly a noise
  // lock rather than a real transmission — reject it outright. Matches
  // the Python reference's tolerance for one-digit BCD corruption.
  const badDigits = (s) => (String(s || "").match(/\?/g) || []).length;
  if (badDigits(call.caller) > 3) return null;
  if (call.destination && badDigits(call.destination) > 3) return null;
  return call;
}

// Autotune: sweep single-bin tone power across 300–2500 Hz, find the
// strongest peak-pair separated by ~170 Hz (the M.493 FSK deviation).
// Cheaper than a full FFT; subsamples by 8. Returns null when no
// plausible FSK peak-pair exists — gates the expensive sweep on
// empty/noisy bands.
function autotuneMarkSpace(samples, sr) {
  const STEP = 20, FMIN = 300, FMAX = 2500, SHIFT = 170;
  const n = samples.length;
  const w = 2 * Math.PI / sr;
  const peaks = [];
  for (let f = FMIN; f <= FMAX; f += STEP) {
    let cs = 0, ss = 0;
    const wf = w * f;
    for (let i = 0; i < n; i += 8) {
      cs += samples[i] * Math.cos(wf * i);
      ss += samples[i] * Math.sin(wf * i);
    }
    peaks.push([f, cs * cs + ss * ss]);
  }
  peaks.sort((a, b) => b[1] - a[1]);
  const top = peaks.slice(0, 8);
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const [f1] = top[i], [f2] = top[j];
      const lo = Math.min(f1, f2), hi = Math.max(f1, f2);
      if (Math.abs(hi - lo - SHIFT) <= 15) return [lo, hi];
    }
  }
  return null;
}

// Top-level pipeline. Three tiers, mirroring dsc_decode_ddesk.py:
//   1. baseline 1615/1785 (what a correct 2185.8 kHz dial produces)
//   2. autotune-located peak pair — handles LO offset / non-standard dial
//   3. ±60 Hz sweep around the autotune center for fine bit-bin alignment
// Each tier tries 3 sub-bit offsets for bit-clock alignment.
export function decode(samples, sr, opts = {}) {
  const debug = !!opts.debug;
  const spb = Math.floor(sr / BAUD);
  const subOffsets = [0, (spb / 3) | 0, ((2 * spb) / 3) | 0];
  let best = null;
  let attempts = 0;

  const tryTone = (mark, space) => {
    for (const off of subOffsets) {
      attempts++;
      const view = samples.subarray(off);
      const bits = fskDemod(view, sr, mark, space);
      const { start, score } = findPhasing(bits, 5);
      if (start < 0) continue;
      if (!best || score < best.score) best = { bits, start, score, mark, space };
    }
  };

  tryTone(MARK, SPACE);
  let tuned = null;
  if (!best || best.score > 2) {
    tuned = autotuneMarkSpace(samples, sr);
    if (tuned) tryTone(tuned[0], tuned[1]);
  }
  if (tuned && (!best || best.score > 2)) {
    const center = (tuned[0] + tuned[1]) / 2;
    for (let c = center - 60; c <= center + 60; c += 10) {
      tryTone(c - 85, c + 85);
      if (best && best.score <= 1) break;
    }
  }
  if (!best) {
    if (debug) console.log(`[dsc] no phasing after ${attempts} trials (sr=${sr})`);
    return null;
  }

  const rawBytes = bitsToBytes(best.bits, best.start);
  const dataSyms = deinterleave(rawBytes);

  const headLen = Math.min(16, dataSyms.length);
  let badSyms = 0;
  for (let i = 0; i < headLen; i++) if (dataSyms[i] === -1) badSyms++;
  if (debug) {
    console.log(`[dsc] lock: score=${best.score} mark=${best.mark.toFixed(0)} ` +
                `space=${best.space.toFixed(0)} bad=${badSyms}/${headLen} ` +
                `attempts=${attempts}`);
  }
  if (badSyms > 6 || headLen < 13) return null;

  const call = parseCall(dataSyms);
  if (call) {
    call.markHz = best.mark;
    call.spaceHz = best.space;
    call.phasingScore = best.score;
    call.badSymbols = badSyms;
  } else if (debug) {
    console.log(`[dsc] parseCall rejected (too many '??' BCD digits)`);
  }
  return call;
}
