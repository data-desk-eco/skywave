#!/usr/bin/env node
// Black-Sea target cohort — live listening sanity test.
//
// Opens a WebSocket per slot of the deployed Worker's black-sea rack and
// streams every decoded DSC call to stdout. If the Worker has picked up
// this branch's changes, the rack will include proxy.kiwisdr.com hosts
// that were previously excluded (Baghdad, Sobikow, etc.), giving the
// cohort an SE vertex that makes TDOA geometry actually work for Russian
// Black Sea port traffic.
//
// Use:
//   node scripts/inject_tdoa_black_sea.mjs --duration 1800
//   node scripts/inject_tdoa_black_sea.mjs --duration 300 --gateway http://127.0.0.1:8787
//
// While this runs, in another terminal:
//   watch -n 5 curl -s $GATEWAY/v2/tdoa/recent | jq
//
// Any DSC burst heard by ≥3 of the 6 cohort hosts lands in /v2/tdoa/recent
// with a solved position. We expect a handful per hour from Russian
// tankers working Novorossiysk and Tuapse.
//
// This script is pure backend and has no browser dependency — it's the
// equivalent of `attach_nwe.mjs` but for the target-focused region. No
// frontend state changes.

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const DURATION = parseInt(getArg("--duration", "1800"), 10) * 1000;
const GATEWAY  = getArg("--gateway", "https://skywave-gateway.louis-6bf.workers.dev");
const BANDS    = getArg("--bands", "MF,HF4,HF6,HF8,HF12,HF16").split(",");

const rack = await (await fetch(`${GATEWAY}/v2/rack?region=black-sea`)).json();
if (!rack.slots || !rack.slots.length) {
  console.error("# no slots for black-sea region — is the Worker deployed?");
  process.exit(1);
}
const slots = rack.slots.filter(s => BANDS.includes(s.band));
console.error(`# Black Sea rack: ${rack.slots.length} slots total, `
  + `attaching to ${slots.length} on ${BANDS.join(",")}`);
console.error("# Cohort (unique hosts):");
const uniqueHosts = [...new Set(slots.map(s => `${s.host}:${s.port}`))];
for (const h of uniqueHosts) {
  const ex = slots.find(s => `${s.host}:${s.port}` === h);
  console.error(`#   ${h.padEnd(38)}  ${ex.label}  gps=${ex.gps[0].toFixed(2)},${ex.gps[1].toFixed(2)}`);
}

const conns = [];
let callCount = 0, liveCount = 0, burstCount = 0, errCount = 0;
const byHost = new Map();

for (const s of slots) {
  const ws = new WebSocket(s.wsUrl);
  const key = `${s.host}:${s.port}`;
  ws.onopen = () => {};
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.t === "call") {
      callCount++;
      const host = byHost.get(key) || { calls: 0, bursts: 0, live: 0 };
      host.calls++; byHost.set(key, host);
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        band: msg.band,
        host: key,
        label: s.label,
        caller: msg.call?.caller,
        destination: msg.call?.destination,
        format: msg.call?.formatCode,
      }));
    } else if (msg.t === "status") {
      const host = byHost.get(key) || { calls: 0, bursts: 0, live: 0 };
      if (msg.state === "live") { liveCount++; host.live = 1; }
      if (msg.state === "burst") { burstCount++; host.bursts++; }
      if (msg.state === "err")  { errCount++; }
      byHost.set(key, host);
      if (msg.state && msg.state !== "live" && msg.state !== "burst") {
        console.error(`# ${key} ${s.band}: ${msg.state} ${msg.msg || ""}`);
      }
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {};
  conns.push(ws);
}

const tick = setInterval(() => {
  const live = conns.filter(w => w.readyState === 1).length;
  console.error(`# [${new Date().toISOString()}] `
    + `live=${live}/${conns.length} calls=${callCount} bursts=${burstCount} err=${errCount}`);
  // Per-host breakdown
  for (const [h, st] of byHost) {
    if (st.calls || st.bursts) {
      console.error(`#   ${h.padEnd(38)} calls=${st.calls} bursts=${st.bursts}`);
    }
  }
}, 30_000);

setTimeout(() => {
  clearInterval(tick);
  console.error("# duration elapsed, closing. summary:");
  console.error(`#   calls=${callCount} bursts=${burstCount} errors=${errCount}`);
  for (const w of conns) { try { w.close(); } catch (_) {} }
  setTimeout(() => process.exit(0), 500);
}, DURATION);
