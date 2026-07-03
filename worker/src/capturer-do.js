// CapturerDO — fixed-window simulator that pretends to be a real
// listener so the rack actually fires.
//
// TDOADO only broadcasts when ReceiverDOs are alive, and ReceiverDOs
// only stay alive while a client is attached to their slot WebSocket.
// Without humans on the page nothing happens. This DO opens outbound
// WS connections to every slot in a chosen rack, subscribes to TDOA
// broadcasts, and writes each broadcast as a JSONL line into R2 so
// we can analyse the prior-validation stats offline.
//
// Cost-shape (2026-04, 4 h × 40 slots Global rack):
//   · 40 ReceiverDOs alive ~4 h, ~1¢/slot/h ≈ $1.60
//   · TDOADO alive ~4 h (already cheap, single fanout)
//   · CapturerDO alive ~4 h (idle bookkeeping, negligible)
//   · R2 writes: ~240 chunks × 60 s + 1 manifest + 1 done marker, well
//     under the 1 M class-A free tier.
// MAX_DURATION_MS hard caps the runaway case at 6 h. The alarm()
// auto-tears-down the entire fleet at startedMs + durationMs even
// if the DO is restarted mid-capture, so a forgotten kill switch
// can't run up an unbounded bill.
//
// Routes:
//   POST /start     — idempotent across DO restart; 409 if running
//   POST /stop      — manual kill switch
//   GET  /status    — current state, elapsed time, fix count
//   GET  /list      — list past captures from R2
//   GET  /report/:id — JSON metrics over a finished capture

import { locationHintFor } from "./location-hint.js";

// Hard caps. Even if a caller asks for more, we won't go past these.
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;
const MAX_SLOTS = 50;
// How often the alarm fires to flush the in-memory buffer to R2 and
// check whether we've hit the end time. Shorter = less data lost on
// DO eviction, but more R2 writes; 60 s is comfortably inside the R2
// free tier even on a 24 h capture.
const FLUSH_INTERVAL_MS = 60_000;

export class CapturerDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Outbound WS to slot ReceiverDOs, keeps each ReceiverDO alive.
    this.slotSockets = new Map();    // "host:port:band" → WebSocket
    // Outbound WS to TDOADO /subscribe. Where the data we actually
    // care about comes from — every TDOA broadcast lands here.
    this.tdoaSocket = null;
    // In-memory accumulator flushed to R2 every FLUSH_INTERVAL_MS.
    this.buffer = [];
    // Mirrors persisted DO storage; populated by _restore().
    this.session = null;
    this.totalFixes = 0;
    this.chunkSeq = 0;
    this.state.blockConcurrencyWhile(async () => {
      await this._restore();
    });
  }

  async _restore() {
    const stored = await this.state.storage.get("session");
    if (!stored) return;
    // If the persisted session has already ended, clear it; otherwise
    // re-establish WS connections so an evicted DO doesn't silently
    // drop the capture mid-window.
    if (Date.now() >= stored.endMs) {
      await this.state.storage.delete("session");
      return;
    }
    this.session = stored;
    this.totalFixes = stored.totalFixes || 0;
    this.chunkSeq = stored.chunkSeq || 0;
    // Re-open connections in the background; the alarm will flush.
    this._openAll().catch((e) => console.log(`capture/restore: ${e.message}`));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/start" && request.method === "POST") return this._start(url);
    if (path === "/stop"  && request.method === "POST") return this._stop("manual");
    if (path === "/status") return this._status();
    if (path === "/list")   return this._list();
    const reportMatch = path.match(/^\/report\/([\w.-]+)$/);
    if (reportMatch) return this._report(reportMatch[1]);
    return new Response("capturer", { status: 404 });
  }

  async _start(url) {
    if (this.session) {
      return Response.json(
        { error: "capture already running", session: this._publicSession() },
        { status: 409 },
      );
    }
    const region = url.searchParams.get("region") || "global";
    const fanout = Math.min(MAX_SLOTS, parseInt(url.searchParams.get("fanout") || "40", 10));
    const durationH = parseFloat(url.searchParams.get("durationH") || "4");
    const durationMs = Math.min(MAX_DURATION_MS, Math.max(60_000, durationH * 3600_000));

    // Fetch the rack via the DirectoryDO (no HTTP round-trip out).
    const dirId = this.env.DIRECTORY.idFromName("directory");
    const rackResp = await this.env.DIRECTORY.get(dirId).fetch(
      `https://do/rack?region=${encodeURIComponent(region)}&fanout=${fanout}`,
    );
    if (!rackResp.ok) {
      return Response.json({ error: `rack fetch failed: ${rackResp.status}` }, { status: 502 });
    }
    const rack = await rackResp.json();
    if (!Array.isArray(rack.slots) || rack.slots.length === 0) {
      return Response.json({ error: "empty rack" }, { status: 400 });
    }
    if (rack.slots.length > MAX_SLOTS) rack.slots = rack.slots.slice(0, MAX_SLOTS);

    const captureId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${region}`;
    const startedMs = Date.now();
    const endMs = startedMs + durationMs;
    this.session = {
      captureId,
      region,
      regionName: rack.regionName || region,
      startedMs,
      endMs,
      durationMs,
      slots: rack.slots.map((s) => ({
        host: s.host, port: s.port, band: s.bandKHz,
        label: s.label, gps: s.gps,
      })),
      totalFixes: 0,
      chunkSeq: 0,
    };
    this.totalFixes = 0;
    this.chunkSeq = 0;
    await this.state.storage.put("session", this.session);

    await this._writeManifest();
    await this._openAll();
    await this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);

    return Response.json({ ok: true, captureId, slots: this.session.slots.length, endMs });
  }

  async _stop(reason) {
    if (!this.session) return Response.json({ error: "not running" }, { status: 404 });
    const captureId = this.session.captureId;
    await this._closeAll();
    await this._flush();   // final flush of whatever's in the buffer

    const doneMs = Date.now();
    const done = {
      captureId,
      reason,
      stoppedMs: doneMs,
      totalFixes: this.totalFixes,
      chunks: this.chunkSeq,
    };
    await this.env.CAPTURES.put(
      `captures/${captureId}/done.json`,
      JSON.stringify(done, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );
    this.session = null;
    this.totalFixes = 0;
    this.chunkSeq = 0;
    this.buffer = [];
    await this.state.storage.delete("session");
    await this.state.storage.deleteAlarm();
    console.log(`capture/stop: ${captureId} reason=${reason} fixes=${done.totalFixes}`);
    return Response.json({ ok: true, ...done });
  }

  async _status() {
    if (!this.session) return Response.json({ running: false });
    return Response.json({ running: true, ...this._publicSession() });
  }

  _publicSession() {
    if (!this.session) return null;
    const now = Date.now();
    return {
      captureId: this.session.captureId,
      region: this.session.region,
      regionName: this.session.regionName,
      startedMs: this.session.startedMs,
      endMs: this.session.endMs,
      elapsedMs: now - this.session.startedMs,
      remainingMs: Math.max(0, this.session.endMs - now),
      slots: this.session.slots.length,
      slotsConnected: this.slotSockets.size,
      tdoaConnected: !!this.tdoaSocket && this.tdoaSocket.readyState === 1,
      totalFixes: this.totalFixes,
      bufferedFixes: this.buffer.length,
      chunkSeq: this.chunkSeq,
    };
  }

  async _list() {
    const out = [];
    let cursor;
    do {
      const r = await this.env.CAPTURES.list({ prefix: "captures/", cursor });
      for (const obj of r.objects) {
        if (obj.key.endsWith("/manifest.json")) {
          const m = obj.key.match(/^captures\/([^/]+)\/manifest\.json$/);
          if (m) out.push({ captureId: m[1], uploadedMs: obj.uploaded.getTime?.() ?? Date.parse(obj.uploaded) });
        }
      }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    out.sort((a, b) => b.uploadedMs - a.uploadedMs);
    return Response.json({ captures: out });
  }

  async _report(captureId) {
    if (!/^[\w.-]+$/.test(captureId)) {
      return Response.json({ error: "bad id" }, { status: 400 });
    }
    const stats = await reportFor(this.env.CAPTURES, captureId);
    if (!stats) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(stats);
  }

  async alarm() {
    // Two reasons we wake up: scheduled flush (mid-capture) or the
    // hard end-of-capture alarm. Either way, flush first.
    await this._flush();
    if (!this.session) return;
    const now = Date.now();
    if (now >= this.session.endMs) {
      await this._stop("duration-elapsed");
      return;
    }
    // Self-reschedule for the next flush. Don't go past endMs.
    const next = Math.min(now + FLUSH_INTERVAL_MS, this.session.endMs);
    await this.state.storage.setAlarm(next);
    // Self-heal the TDOA subscription: a TDOADO redeploy closes it and
    // one-shot timer retries don't survive DO idling.
    this._openTdoa();
  }

  // -------- WebSocket plumbing --------

  async _openAll() {
    if (!this.session) return;
    // TDOA subscribe — the only WS we actually read meaningful data
    // from. Slot WS connections exist only to keep ReceiverDOs alive.
    this._openTdoa();
    for (const slot of this.session.slots) this._openSlot(slot);
  }

  _openTdoa() {
    if (this.tdoaSocket && this.tdoaSocket.readyState <= 1) return;
    const id = this.env.TDOA.idFromName("singleton");
    const stub = this.env.TDOA.get(id);
    const headers = new Headers({ Upgrade: "websocket" });
    stub.fetch("https://do/subscribe", { headers })
      .then((resp) => {
        if (resp.status !== 101 || !resp.webSocket) {
          console.log(`capture/tdoa: handshake failed status=${resp.status}`);
          return;
        }
        const ws = resp.webSocket;
        ws.accept();
        ws.addEventListener("message", (ev) => this._onTdoaMessage(ev));
        ws.addEventListener("close", () => {
          if (this.tdoaSocket === ws) this.tdoaSocket = null;
          // If we're still capturing, try to re-open. TDOADO closing
          // mid-capture would otherwise drop us silently.
          if (this.session) setTimeout(() => this._openTdoa(), 1000);
        });
        this.tdoaSocket = ws;
      })
      .catch((e) => console.log(`capture/tdoa: ${e.message}`));
  }

  _openSlot(slot) {
    const key = `${slot.host}:${slot.port}:${slot.band}`;
    if (this.slotSockets.has(key)) return;
    const id = this.env.RECEIVER.idFromName(key);
    const locationHint = locationHintFor(slot.gps);
    const stub = this.env.RECEIVER.get(id, locationHint ? { locationHint } : undefined);
    const q = new URLSearchParams({
      host: slot.host, port: String(slot.port), band: String(slot.band),
      label: slot.label || "",
    });
    if (slot.gps) {
      q.set("lat", String(slot.gps[0]));
      q.set("lon", String(slot.gps[1]));
    }
    const headers = new Headers({ Upgrade: "websocket" });
    stub.fetch(`https://do/attach?${q}`, { headers })
      .then((resp) => {
        if (resp.status !== 101 || !resp.webSocket) {
          console.log(`capture/slot ${key}: handshake failed status=${resp.status}`);
          return;
        }
        const ws = resp.webSocket;
        ws.accept();
        // We have to listen so the messages don't sit in CF's queue
        // forever, but we discard everything — we only consume slot
        // streams to keep the ReceiverDO from hibernating.
        ws.addEventListener("message", () => {});
        ws.addEventListener("close", () => {
          if (this.slotSockets.get(key) === ws) this.slotSockets.delete(key);
          // Don't reconnect: a slot dropping mid-capture is the
          // ReceiverDO's call (upstream KiwiSDR went away, list refresh
          // dropped it, etc.). Forcing reconnects would mask real
          // drop-outs and complicate the cost story.
        });
        this.slotSockets.set(key, ws);
      })
      .catch((e) => console.log(`capture/slot ${key}: ${e.message}`));
  }

  _onTdoaMessage(ev) {
    if (!this.session) return;
    let data;
    try {
      data = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
    } catch (_) {
      return;
    }
    if (!data || data.t !== "tdoa") return;
    this.buffer.push(data);
    this.totalFixes++;
  }

  async _closeAll() {
    for (const ws of this.slotSockets.values()) {
      try { ws.close(1000, "capture-end"); } catch (_) {}
    }
    this.slotSockets.clear();
    if (this.tdoaSocket) {
      try { this.tdoaSocket.close(1000, "capture-end"); } catch (_) {}
      this.tdoaSocket = null;
    }
  }

  async _writeManifest() {
    const m = {
      captureId: this.session.captureId,
      region: this.session.region,
      regionName: this.session.regionName,
      startedMs: this.session.startedMs,
      endMs: this.session.endMs,
      slots: this.session.slots,
      // Hard-coded once at session start; the report renderer joins on
      // these to compute the prior-load-bearing stats without a second
      // network hop.
      priorLambdaKm: 100,
    };
    await this.env.CAPTURES.put(
      `captures/${this.session.captureId}/manifest.json`,
      JSON.stringify(m, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  async _flush() {
    if (!this.session || this.buffer.length === 0) {
      // Still persist the running counters so /status survives DO eviction.
      if (this.session) {
        await this.state.storage.put("session", {
          ...this.session,
          totalFixes: this.totalFixes,
          chunkSeq: this.chunkSeq,
        });
      }
      return;
    }
    const seq = this.chunkSeq++;
    const key = `captures/${this.session.captureId}/chunk-${String(seq).padStart(5, "0")}.jsonl`;
    const body = this.buffer.map((o) => JSON.stringify(o)).join("\n") + "\n";
    this.buffer = [];
    await this.env.CAPTURES.put(key, body, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    await this.state.storage.put("session", {
      ...this.session,
      totalFixes: this.totalFixes,
      chunkSeq: this.chunkSeq,
    });
  }
}

// -------- Report computation --------

// Stream every chunk in a finished capture and compute the prior-
// validation metrics. The shape we want, with one capture's worth of
// data behind every number:
//   - fixes total
//   - dual-basin fixes (runnerUp != null)
//   - load-bearing prior fixes (where runnerUp.residual + λ·penalty
//     would have beaten best.residual + λ·penalty had we used residual
//     alone). For each, record the margin (km).
//   - distribution of priorPenaltyDex on chosen vs runner-up basins
//   - per-MMSI repeat count + spatial spread (re-derives convergence
//     across the whole capture, not just the 30 min sliding window).
async function reportFor(bucket, captureId) {
  const manifestObj = await bucket.get(`captures/${captureId}/manifest.json`);
  if (!manifestObj) return null;
  const manifest = await manifestObj.json();
  const lambda = manifest.priorLambdaKm ?? 100;

  let total = 0, withRunnerUp = 0, priorLoadBearing = 0;
  let priorMargins = [];        // km the prior-aware score won by
  let bestPenaltySum = 0, runnerUpPenaltySum = 0;
  const ellipseHistogram = new Array(10).fill(0);     // 0–100, 100–200, ..., 900+
  const sepHistogram = new Array(10).fill(0);         // 1500–3000, 3000–4500, …, 14500+
  const perMmsi = new Map();

  let cursor;
  do {
    const r = await bucket.list({ prefix: `captures/${captureId}/chunk-`, cursor });
    for (const obj of r.objects) {
      const file = await bucket.get(obj.key);
      if (!file) continue;
      const text = await file.text();
      for (const line of text.split("\n")) {
        if (!line) continue;
        let fix;
        try { fix = JSON.parse(line); } catch (_) { continue; }
        if (!fix || fix.t !== "tdoa") continue;
        total++;
        const g = fix.geometry || {};
        const bestPen = g.priorPenaltyDex ?? 0;
        bestPenaltySum += bestPen;
        if (g.ellipseSemiMajorKm != null) {
          const idx = Math.min(9, Math.floor(g.ellipseSemiMajorKm / 100));
          ellipseHistogram[idx]++;
        }
        const ru = g.runnerUp;
        if (ru) {
          withRunnerUp++;
          runnerUpPenaltySum += ru.priorPenaltyDex ?? 0;
          if (ru.sepKm) {
            const idx = Math.min(9, Math.max(0, Math.floor((ru.sepKm - 1500) / 1500)));
            sepHistogram[idx]++;
          }
          // Did the prior matter? Reconstruct the residual-only and
          // prior-aware orderings.
          const residOnlyBest = fix.position.residualKm < ru.residualKm
            ? { resid: fix.position.residualKm, isBest: true }
            : { resid: ru.residualKm, isBest: false };
          const bestScore = fix.position.residualKm + lambda * bestPen;
          const ruScore = ru.residualKm + lambda * (ru.priorPenaltyDex ?? 0);
          // Load-bearing = the prior-aware solver picked a different
          // basin than residual-alone would have.
          if (!residOnlyBest.isBest) {
            priorLoadBearing++;
            priorMargins.push(+(ruScore - bestScore).toFixed(1));
          }
        }
        const m = perMmsi.get(fix.mmsi) || { fixes: 0, lats: [], lons: [] };
        m.fixes++;
        m.lats.push(fix.position.lat);
        m.lons.push(fix.position.lon);
        perMmsi.set(fix.mmsi, m);
      }
    }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);

  // Per-MMSI: median pairwise distance across this capture, capped at
  // top 20 most-frequent MMSIs to keep the response small.
  const repeats = [];
  for (const [mmsi, v] of perMmsi.entries()) {
    if (v.fixes < 2) continue;
    let maxKm = 0;
    for (let i = 0; i < v.lats.length; i++) {
      for (let j = i + 1; j < v.lats.length; j++) {
        const d = greatCircleKm(v.lats[i], v.lons[i], v.lats[j], v.lons[j]);
        if (d > maxKm) maxKm = d;
      }
    }
    repeats.push({ mmsi, fixes: v.fixes, maxSepKm: +maxKm.toFixed(0) });
  }
  repeats.sort((a, b) => b.fixes - a.fixes);

  priorMargins.sort((a, b) => a - b);
  const p = (xs, q) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : null;

  return {
    captureId,
    manifest,
    summary: {
      total,
      withRunnerUp,
      priorLoadBearing,
      meanBestPenaltyDex: total ? +(bestPenaltySum / total).toFixed(2) : null,
      meanRunnerUpPenaltyDex: withRunnerUp ? +(runnerUpPenaltySum / withRunnerUp).toFixed(2) : null,
      priorMarginKm: {
        p10: p(priorMargins, 0.1), p50: p(priorMargins, 0.5), p90: p(priorMargins, 0.9),
        max: priorMargins.length ? priorMargins[priorMargins.length - 1] : null,
      },
    },
    ellipseHistogram,    // counts in 100-km buckets up to 900+
    runnerUpSepHistogram: sepHistogram,    // counts in 1500-km buckets from 1500 to 15000+
    repeats: repeats.slice(0, 20),
  };
}

function greatCircleKm(la1, lo1, la2, lo2) {
  const R = 6371;
  const A = la1 * Math.PI / 180, B = la2 * Math.PI / 180;
  const dla = B - A;
  const dlo = (lo2 - lo1) * Math.PI / 180;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(A) * Math.cos(B) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
