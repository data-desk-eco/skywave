// periodic LSEG AIS snapshotter for vessels heard during a capture —
// gives fix-time ground truth to interpolate against, instead of a
// single stale post-hoc lookup. GFW is used only for MMSI → IMO
// identity (registry data, no lag); positions come from LSEG.
//
//   node scripts/ais_watch.mjs captures/day1.jsonl captures/day1_ais.jsonl 21600

import { appendFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const [capFile, outFile, durationSec = 21600] = process.argv.slice(2);
const LSEG = `${homedir()}/Research/.github/.claude/skills/lseg/lseg`;
const GW = "https://skywave-gateway.louis-6bf.workers.dev";
const ricCache = new Map();   // mmsi → ric | null
const t0 = Date.now();

const log = (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`);

async function ricFor(mmsi) {
  if (ricCache.has(mmsi)) return ricCache.get(mmsi);
  let ric = null;
  try {
    const d = await (await fetch(`${GW}/gfw?query=${mmsi}`)).json();
    let imo = null;
    for (const e of d.entries ?? []) {
      for (const s of [...(e.selfReportedInfo ?? []), ...(e.registryInfo ?? [])]) {
        if (String(s.ssvid) === mmsi && s.imo) { imo = s.imo; break; }
      }
      if (imo) break;
    }
    if (imo) {
      const tsv = execFileSync(LSEG, ["symbology", String(imo), "--from", "IMO", "--to", "RIC"], { encoding: "utf8" });
      ric = tsv.trim().split("\n").at(-1)?.split("\t")[1] || null;
      if (ric === "RIC") ric = null;
    }
  } catch (e) { log(`${mmsi} resolve failed: ${e.message}`); }
  ricCache.set(mmsi, ric);
  log(`${mmsi} → ${ric}`);
  return ric;
}

while (Date.now() - t0 < durationSec * 1000) {
  const mmsis = new Set();
  if (existsSync(capFile)) {
    // grep, not readFileSync — capture files outgrow node's string cap
    try {
      const outp = execFileSync("grep", ["-ohE", '"caller":"[0-9]{9}"', capFile],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      for (const m of outp.matchAll(/"caller":"(\d{9})"/g)) {
        if (!m[1].startsWith("00")) mmsis.add(m[1]);
      }
    } catch {}
  }
  const rics = [];
  for (const m of mmsis) {
    const r = await ricFor(m);
    if (r) rics.push([m, r]);
  }
  if (rics.length) {
    try {
      const tsv = execFileSync(LSEG, ["query", rics.map(([, r]) => r).join(","),
        "--fields", "TR.AssetName,TR.AssetDateTime,TR.AssetLocationLatitude,TR.AssetLocationLongitude,TR.AssetSpeed,TR.AssetHeading"],
        { encoding: "utf8", timeout: 120000 });
      const rows = tsv.trim().split("\n").slice(1).map((l) => l.split("\t"));
      for (const row of rows) {
        const [ric, name, ts, lat, lon, speed, heading] = row;
        const mmsi = rics.find(([, r]) => r === ric)?.[0];
        if (!mmsi || !lat) continue;
        appendFileSync(outFile, JSON.stringify({
          pollMs: Date.now(), mmsi, ric, name, ts,
          lat: +lat, lon: +lon, speedKn: +speed || null, headingDeg: +heading || null,
        }) + "\n");
      }
      log(`polled ${rows.length} vessels`);
    } catch (e) { log(`poll failed: ${e.message}`); }
  }
  await new Promise((r) => setTimeout(r, 900000));
}
log("ais watch done");
