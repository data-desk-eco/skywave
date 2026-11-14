// per-receiver clock bias from truth-scored residuals: alternate
// (burst offset = median of bias-corrected residuals) and
// (host bias = median of offset-corrected residuals) to convergence.
// prints host bias table; writes corrected residuals with --out.
//
//   node scripts/toa_bias.mjs captures/day1_res.jsonl [--out f] [--kind ais]
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), file = args[0];
const opt = (k) => { const i = args.indexOf(k); return i < 0 ? null : args[i + 1]; };
const kind = opt("--kind"), maxMob = +(opt("--mob") ?? 5), half = opt("--half");   // --half a|b: fit on alternate vessels only
let rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .filter((r) => (!half || (+r.mmsi % 2 === 0) === (half === "a")) && (!kind || r.kind.startsWith(kind)) && r.mob <= maxMob && (r.dec !== undefined || r.rho > 0.3));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : 0; };
const by = (k) => { const m = new Map(); for (const r of rows) (m.get(r[k]) ?? m.set(r[k], []).get(r[k])).push(r); return m; };
const bias = new Map();
for (const r of rows) r.e = r.resUs;
for (let it = 0; it < 30; it++) {
  for (const g of by("id").values()) { const m = med(g.map((r) => r.resUs - (bias.get(r.host) ?? 0))); for (const r of g) r.e = r.resUs - m; }
  for (const [h, g] of by("host")) bias.set(h, g.length >= 5 ? med(g.map((r) => r.e)) : 0);
}
for (const r of rows) r.c = r.e - bias.get(r.host);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log("host\tn\tbiasUs\tmadUs\tp90abs\tkm");
for (const [h, g] of [...by("host")].sort((a, b) => b[1].length - a[1].length)) {
  const c = g.map((r) => Math.abs(r.c));
  console.log([h, g.length, Math.round(bias.get(h)), Math.round(med(c)), Math.round(q(c, 0.9)), Math.round(med(g.map((r) => r.km)))].join("\t"));
}
const all = rows.filter((r) => r.q >= 3).map((r) => Math.abs(r.c));
console.log(`\nall q>=3: n=${all.length} p50=${q(all, .5)} p75=${q(all, .75)} p90=${q(all, .9)} p95=${q(all, .95)} us`);
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(Object.fromEntries([...by("host")].filter(([, g]) => g.length >= 5).map(([h]) => [h, Math.round(bias.get(h))]))));
if (opt("--out")) writeFileSync(opt("--out"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
