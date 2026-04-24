#!/usr/bin/env node
// Open WebSocket attachments to every NW Europe slot so the ReceiverDOs
// actually boot and start pulling IQ from their KiwiSDRs. Stays attached
// for DURATION_SEC seconds, prints every JSON frame as one line.
//
// Use to warm the pipeline during a TDOA live test:
//   node scripts/attach_nwe.mjs --region nw-europe --bands MF,HF4,HF8 --duration 1800
//
// Meanwhile, in another terminal, poll /v2/tdoa/recent to see what
// lands.

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const REGION   = getArg("--region", "nw-europe");
const BANDS    = getArg("--bands", "MF").split(",");
const DURATION = parseInt(getArg("--duration", "600"), 10) * 1000;
const GATEWAY  = getArg("--gateway", "https://skywave-gateway.louis-6bf.workers.dev");

const rack = await (await fetch(`${GATEWAY}/v2/rack?region=${REGION}`)).json();
const slots = rack.slots.filter(s => BANDS.includes(s.band));
console.error(`# attaching to ${slots.length} slots in ${rack.regionName} on bands ${BANDS.join(",")}`);

const conns = [];
let callCount = 0, statusCount = 0, audioCount = 0;

for (const s of slots) {
  const ws = new WebSocket(s.wsUrl);
  ws.onopen = () => {
    console.error(`  opened ${s.band} ${s.label}`);
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.t === "call") {
      callCount++;
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        slot: msg.slot, band: msg.band, caller: msg.call?.caller,
        destination: msg.call?.destination, format: msg.call?.formatCode,
        startSample: msg.call?.startSample,
      }));
    } else if (msg.t === "status") {
      statusCount++;
      if (msg.state && msg.state !== "live" && msg.state !== "burst" && msg.state !== "down") {
        console.error(`# status ${s.band} ${s.label}: ${msg.state} ${msg.msg || ""}`);
      }
    } else if (msg.t === "audio") {
      audioCount++;
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {};
  conns.push(ws);
}

const tick = setInterval(() => {
  const live = conns.filter(w => w.readyState === 1).length;
  console.error(`# [${new Date().toISOString()}] live=${live}/${conns.length} calls=${callCount} audio=${audioCount} status=${statusCount}`);
}, 30_000);

setTimeout(() => {
  clearInterval(tick);
  console.error("# duration elapsed, closing");
  for (const w of conns) { try { w.close(); } catch (_) {} }
  setTimeout(() => process.exit(0), 500);
}, DURATION);
