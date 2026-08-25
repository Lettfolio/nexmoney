#!/usr/bin/env node
/* =============================================================================
   tests/r58.js — acceptance tests for R58 (rate-end outcomes)

   1. §A  "Renewed elsewhere" — the outcome overlay updates the source case
          (new rate_end_date via a +years chip → estimated flag, optional
          lender/rate), RE-ARMS the engine (rate_reminder_queued_at null),
          closes the open old-cycle retention successor as not_proceeding with
          the reason, and writes notes on both cases.
   2. §B  The CYCLE-AWARE gate — with an old-cycle successor still on file,
          the retention engine creates a NEW successor once the new date enters
          the window (the old gate blocked forever).
   3. §C  "Property sold / redeemed" — rate/ERC dates cleared, note written,
          the case leaves the rates feed for good.

   Run:  node /root/nx/tests/r58.js   (expects a static server on 8099;
                                       starts one itself if absent)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }

async function ensureServer() {
  const up = await new Promise((res) => {
    const req = http.get(`http://localhost:${PORT}/admin/mock.html`, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
  });
  if (up) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1200));
  return srv;
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}?as=p1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  /* ---- fixtures: a completed tracked case WITH an open old-cycle successor, and one without ---- */
  const fx = await page.evaluate(async () => {
    const db = window.__mockDb;
    const { data: cases } = await db.from("cases").select("id,client_id,stage,rate_end_date,assigned_to,lender");
    const tracked = (cases || []).filter((c) => c.stage === "completed" && c.rate_end_date);
    const src = tracked[0], soldSrc = tracked[1];
    // an OPEN successor for src's current cycle (same rate_end_date, live stage)
    const { data: succ } = await db.from("cases").insert({
      client_id: src.client_id, case_kind: "remortgage", stage: "enquiry",
      rate_end_date: src.rate_end_date, retention_source_case_id: src.id, assigned_to: src.assigned_to,
    }).select("id").single();
    return { srcId: src.id, srcRateEnd: src.rate_end_date, succId: succ.id, soldId: soldSrc.id };
  });
  ok("fixtures · completed tracked cases + an open old-cycle successor", !!fx.srcId && !!fx.succId && !!fx.soldId, JSON.stringify(fx));

  /* ================= §A · renewed elsewhere ================= */
  console.log("\n— §A · renewed elsewhere — watch the next rate end");
  await page.evaluate((id) => window.openCase(id), fx.srcId);
  await page.waitForTimeout(900);
  ok("A1 · the Rate-end outcome action renders on a completed tracked case", await page.evaluate(() => !!document.querySelector("#act-rate-outcome")));
  await page.click("#act-rate-outcome");
  await page.waitForTimeout(400);
  ok("A2 · the outcome overlay opens with the renewed option selected", await page.evaluate(() =>
    !!document.querySelector("#overlay-modal #reo-date") && document.querySelector('#overlay-modal input[name="reo-kind"]:checked')?.value === "renewed"));
  await page.click('#overlay-modal .reo-chip[data-years="2"]');
  const chipDate = await page.evaluate(() => document.querySelector("#overlay-modal #reo-date").value);
  ok("A3 · the +2 yrs chip fills the date two years out", /^\d{4}-\d{2}-\d{2}$/.test(chipDate) && Number(chipDate.slice(0, 4)) >= new Date().getFullYear() + 1, chipDate);
  await page.fill("#overlay-modal #reo-lender", "Halifax");
  await page.fill("#overlay-modal #reo-rate", "4.5");
  await page.click("#overlay-modal #reo-ok");
  await page.waitForTimeout(1200);

  const after = await page.evaluate(async (fx2) => {
    const db = window.__mockDb;
    const { data: src } = await db.from("cases").select("*").eq("id", fx2.srcId).single();
    const { data: succ } = await db.from("cases").select("stage,lost_reason,rate_end_date").eq("id", fx2.succId).single();
    const { data: notes } = await db.from("case_notes").select("body").eq("case_id", fx2.srcId);
    const { data: snotes } = await db.from("case_notes").select("body").eq("case_id", fx2.succId);
    return {
      rateEnd: src.rate_end_date, erc: src.erc_end_date, est: src.rate_end_estimated,
      rearm: src.rate_reminder_queued_at, lender: src.lender, rate: src.rate_percent,
      succStage: succ.stage, succLost: succ.lost_reason, succOldDate: succ.rate_end_date,
      noteHit: (notes || []).some((n) => /Rate-end outcome — renewed elsewhere with Halifax/.test(n.body)),
      succNoteHit: (snotes || []).some((n) => /renewed elsewhere/.test(n.body)),
    };
  }, fx);
  eq("A4 · the new rate end date is stored", after.rateEnd, chipDate);
  ok("A5 · …flagged estimated (a chip is a term guess) with the ERC cleared", after.est === true && after.erc == null, JSON.stringify({ est: after.est, erc: after.erc }));
  ok("A6 · the engine's one-shot marker is RE-ARMED for the new cycle", after.rearm == null, String(after.rearm));
  ok("A7 · the new lender and rate landed", after.lender === "Halifax" && Number(after.rate) === 4.5, JSON.stringify({ l: after.lender, r: after.rate }));
  ok("A8 · the open old-cycle successor is closed as not proceeding — went direct", after.succStage === "not_proceeding" && after.succLost === "went_direct", JSON.stringify({ s: after.succStage, l: after.succLost }));
  ok("A9 · notes tell the story on BOTH cases", after.noteHit && after.succNoteHit, JSON.stringify({ src: after.noteHit, succ: after.succNoteHit }));

  /* ================= §B · the cycle-aware gate ================= */
  console.log("\n— §B · the retention engine re-fires for the NEW cycle");
  const engine = await page.evaluate(async (fx2) => {
    const db = window.__mockDb;
    // Pull the new date into the reminder window (3 months out), then run the engine.
    const soon = new Date(); soon.setMonth(soon.getMonth() + 3);
    const soonStr = soon.toISOString().slice(0, 10);
    await db.from("cases").update({ rate_end_date: soonStr }).eq("id", fx2.srcId);
    await db.rpc("queue_automated_emails");
    const { data: succs } = await db.from("cases").select("id,stage,rate_end_date").eq("retention_source_case_id", fx2.srcId);
    return { succs: (succs || []).map((s) => ({ stage: s.stage, d: s.rate_end_date })), soonStr };
  }, fx);
  ok("B1 · a NEW successor was auto-created for the new cycle despite the old closed one", engine.succs.some((s) => s.d === engine.soonStr && s.stage === "enquiry"), JSON.stringify(engine));
  ok("B2 · the old-cycle successor is still there, closed (history intact)", engine.succs.some((s) => s.stage === "not_proceeding"), JSON.stringify(engine.succs));
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  /* ================= §C · property sold ================= */
  console.log("\n— §C · property sold / mortgage redeemed");
  await page.evaluate((id) => window.openCase(id), fx.soldId);
  await page.waitForTimeout(900);
  await page.click("#act-rate-outcome");
  await page.waitForTimeout(400);
  await page.check('#overlay-modal input[name="reo-kind"][value="sold"]');
  await page.click("#overlay-modal #reo-ok");
  await page.waitForTimeout(1200);
  const sold = await page.evaluate(async (id) => {
    const db = window.__mockDb;
    const { data: c } = await db.from("cases").select("rate_end_date,erc_end_date,stage").eq("id", id).single();
    const { data: notes } = await db.from("case_notes").select("body").eq("case_id", id);
    return { rateEnd: c.rate_end_date, erc: c.erc_end_date, stage: c.stage, noteHit: (notes || []).some((n) => /property sold \/ mortgage redeemed/i.test(n.body)) };
  }, fx.soldId);
  ok("C1 · rate and ERC dates are cleared — the case leaves the rates feed", sold.rateEnd == null && sold.erc == null, JSON.stringify(sold));
  eq("C2 · the case itself STAYS completed (history, not a lie)", sold.stage, "completed");
  ok("C3 · the note says why", sold.noteHit);
  // …and the outcome action is gone now there is no tracked rate.
  const actionGone = await page.evaluate(() => !document.querySelector("#act-rate-outcome"));
  ok("C4 · the outcome action stands down once tracking is closed", actionGone);
  await page.evaluate(() => window.closeModal && window.closeModal());

  const realErrors = errors.filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs/i.test(e));
  ok("no page errors", realErrors.length === 0, realErrors.join(" | ").slice(0, 300));

  console.log(`\nR58: ${pass} passed, ${failures.length} failed`);
  if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
