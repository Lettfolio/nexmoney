#!/usr/bin/env node
/* =============================================================================
   tests/r19.js — acceptance tests for ROUND 19: owner/admin Pipeline MI in
   Reports (SPEC19.md — Fable). Four panels inside #report-mi-section, gated
   OWNER/ADMIN (isAdminOrOwner()):

     Panel 1 — #report-mi-funnel-panel: live pipeline funnel by stage
               (#report-mi-funnel), historical conversion from milestone dates
               (#report-mi-conversion: created -> submitted_at -> offer_issued
               _date -> completed_at, step %), win rate among terminal cases
               (#report-mi-winrate, <5-terminal thin-data guard).
     Panel 2 — #report-mi-velocity-panel: median (headline) + average days
               between milestones (#report-mi-velocity), only pairs where BOTH
               endpoints exist; bottleneck = slowest median sub-step
               (#report-mi-bottleneck).
     Panel 3 — #report-mi-revenue-panel: monthly completed-fee (broker+proc)
               run-rate, last 12 months (#report-mi-runrate/-basis) + a
               forecast headline/table (#report-mi-forecast-headline/
               -forecast) = Σ(live fee × stage weight); weight is the
               historical stage->completed rate when reachedCompleted >= 5
               (per-stage further gated on that stage's own reach >= 5), else
               the default MI_STAGE_DEFAULT_WEIGHT (enquiry .1, fact_find .2,
               decision_in_principle .4, application .6, offer .85, exchange
               .95).
     Panel 4 — #report-mi-scoreboard-panel: per-adviser table
               (#report-mi-scoreboard) — live / completed(period) / fees
               written(period) / win rate(all-time) / median cycle(all-time),
               "Unassigned" row when a case has null assigned_to, sorted by
               fees written desc.

   IMPORTANT: the funnel/conversion/velocity/forecast are derived from the
   POPULATED milestone DATE columns (created_at/submitted_at/offer_issued_date
   /completed_at) — NOT stage_changed case_events (only ~36 exist pre-launch,
   per SPEC19.md) — so every fixture below controls those date columns
   directly, never relies on the event log.

   EVERY figure this file asserts is recomputed INDEPENDENTLY here
   (computeExpectedMI below) from the exact same row descriptors this file
   inserts — never imported from app.js's renderPipelineMI. The only app.js
   helpers reused are pure DISPLAY formatters (fmtM, localMonthStr), called
   through page.evaluate exactly the way tests/r17.js unit-tests fmtM/fmtM2
   directly — never the MI feature logic itself. mock-supabase.js's whole
   in-memory DB is rebuilt per page load, so this file runs on ONE shared
   page for the whole battery, same as r15/r16/r17/r18.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r19.js
         (expects a static server on 8099; starts one itself if absent)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const SETTLE = 1500;
const DAY = 86400000;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
    r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}
async function newPage(browser, persona) {
  const page = await browser.newPage();
  page.__dialogs = [];
  page.on("dialog", async (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); await d.accept(); });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 900 : ms);
};

/* ---------------------------------------------------------------------------
   Independent re-implementation of the R19 MI formulas (SPEC19.md), never
   imported from app.js. Operates on plain row descriptors:
     { assigned_to, stage, broker_fee, proc_fee, created_at, submitted_at,
       offer_issued_date, completed_at }  (any date field may be undefined)
   ------------------------------------------------------------------------- */
const MI_LIVE_STAGES = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
const MI_DEFAULT_WEIGHT = { enquiry: 0.1, fact_find: 0.2, decision_in_principle: 0.4, application: 0.6, offer: 0.85, exchange: 0.95 };
function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function mean(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null; }
function dayGap(a, b) { const d = Math.round((new Date(b) - new Date(a)) / DAY); return isNaN(d) ? null : d; }
const feeOf = (c) => Number(c.broker_fee || 0) + Number(c.proc_fee || 0);

function computeExpectedMI(rows, mv, monthKeys) {
  const fee = feeOf;
  const funnel = Object.fromEntries(MI_LIVE_STAGES.map((s) => [s, 0]));
  const liveFeeByStage = Object.fromEntries(MI_LIVE_STAGES.map((s) => [s, 0]));
  let reachedApp = 0, reachedOffer = 0, reachedCompleted = 0;
  let completedN = 0, notProceedingN = 0;
  let appAndCompleted = 0, offerAndCompleted = 0;
  const vCreatedApp = [], vAppOffer = [], vOfferComp = [], vCreatedComp = [];
  const runMap = Object.fromEntries(monthKeys.map((m) => [m, 0]));
  const advMap = new Map();

  rows.forEach((c) => {
    const live = MI_LIVE_STAGES.includes(c.stage);
    if (live) { funnel[c.stage]++; liveFeeByStage[c.stage] += fee(c); }
    const hasApp = !!c.submitted_at, hasOffer = !!c.offer_issued_date, hasComp = !!c.completed_at;
    if (hasApp) reachedApp++;
    if (hasOffer) reachedOffer++;
    if (hasComp) reachedCompleted++;
    if (hasApp && hasComp) appAndCompleted++;
    if (hasOffer && hasComp) offerAndCompleted++;
    if (c.stage === "completed") completedN++;
    else if (c.stage === "not_proceeding") notProceedingN++;
    if (c.created_at && hasApp) { const d = dayGap(c.created_at, c.submitted_at); if (d != null && d >= 0) vCreatedApp.push(d); }
    if (hasApp && hasOffer) { const d = dayGap(c.submitted_at, c.offer_issued_date); if (d != null && d >= 0) vAppOffer.push(d); }
    if (hasOffer && hasComp) { const d = dayGap(c.offer_issued_date, c.completed_at); if (d != null && d >= 0) vOfferComp.push(d); }
    if (c.created_at && hasComp) { const d = dayGap(c.created_at, c.completed_at); if (d != null && d >= 0) vCreatedComp.push(d); }
    if (hasComp) { const m = String(c.completed_at).slice(0, 7); if (m in runMap) runMap[m] += fee(c); }
    const key = c.assigned_to || "__unassigned";
    let a = advMap.get(key);
    if (!a) { a = { id: c.assigned_to || null, live: 0, completedPeriod: 0, feesPeriod: 0, won: 0, lost: 0, cycles: [] }; advMap.set(key, a); }
    if (live) a.live++;
    if (c.stage === "completed") { a.won++; if (c.created_at && hasComp) { const d = dayGap(c.created_at, c.completed_at); if (d != null && d >= 0) a.cycles.push(d); } }
    else if (c.stage === "not_proceeding") a.lost++;
    if (hasComp && String(c.completed_at).slice(0, 7) === mv) { a.completedPeriod++; a.feesPeriod += fee(c); }
  });

  const total = rows.length;
  const stepPct = (num, den) => (den ? Math.round((num / den) * 100) : null);
  const terminal = completedN + notProceedingN;
  const winPct = terminal < 5 ? null : Math.round((completedN / terminal) * 100);

  const thin = reachedCompleted < 5;
  const weightOf = { ...MI_DEFAULT_WEIGHT };
  let calibrated = false;
  if (!thin) {
    if (reachedApp >= 5) { weightOf.application = appAndCompleted / reachedApp; calibrated = true; }
    if (reachedOffer >= 5) { weightOf.offer = offerAndCompleted / reachedOffer; calibrated = true; }
  }
  const liveFeeTotal = MI_LIVE_STAGES.reduce((s, st) => s + liveFeeByStage[st], 0);
  const weightedTotal = MI_LIVE_STAGES.reduce((s, st) => s + liveFeeByStage[st] * weightOf[st], 0);

  const subSteps = [
    { name: "to application", arr: vCreatedApp },
    { name: "underwriting", arr: vAppOffer },
    { name: "completion", arr: vOfferComp },
  ].map((s) => ({ name: s.name, med: median(s.arr), n: s.arr.length })).filter((s) => s.med != null);
  subSteps.sort((a, b) => b.med - a.med);

  const boardRows = [...advMap.values()]
    .filter((a) => a.live || a.completedPeriod || a.feesPeriod || a.won || a.lost)
    .map((a) => {
      const term = a.won + a.lost;
      return { id: a.id, live: a.live, completedPeriod: a.completedPeriod, feesPeriod: a.feesPeriod, term, won: a.won, lost: a.lost, winPct: term ? Math.round((a.won / term) * 100) : null, medCycle: median(a.cycles) };
    })
    .sort((x, y) => y.feesPeriod - x.feesPeriod);

  return {
    total, funnel, liveFeeByStage, reachedApp, reachedOffer, reachedCompleted,
    completedN, notProceedingN, terminal, winPct,
    stepApp: stepPct(reachedApp, total), stepOffer: stepPct(reachedOffer, reachedApp), stepComp: stepPct(reachedCompleted, reachedOffer),
    vCreatedApp, vAppOffer, vOfferComp, vCreatedComp,
    medCreatedApp: median(vCreatedApp), meanCreatedApp: mean(vCreatedApp),
    medAppOffer: median(vAppOffer), meanAppOffer: mean(vAppOffer),
    medOfferComp: median(vOfferComp), meanOfferComp: mean(vOfferComp),
    medCreatedComp: median(vCreatedComp), meanCreatedComp: mean(vCreatedComp),
    bottleneck: subSteps[0] || null,
    runMap, thin, calibrated, weightOf, liveFeeTotal, weightedTotal,
    boardRows,
  };
}

/* ---------------------------------------------------------------------------
   Row-insertion helper — writes a plain descriptor straight into the mock DB,
   attached to ONE shared throwaway client (MI reads case fields only, never
   client identity), preserving every date field verbatim (undefined = null,
   the mock never invents a milestone date the row didn't ask for).
   ------------------------------------------------------------------------- */
async function seedMiRows(page, clientId, rows) {
  await page.evaluate(async ({ clientId, rows }) => {
    const db = window.__mockDb;
    for (const r of rows) {
      const row = {
        client_id: clientId, case_kind: "purchase", stage: r.stage,
        assigned_to: r.assigned_to === undefined ? null : r.assigned_to,
        broker_fee: r.broker_fee || 0, proc_fee: r.proc_fee || 0,
      };
      if (r.created_at) row.created_at = r.created_at;
      if (r.submitted_at) row.submitted_at = r.submitted_at;
      if (r.offer_issued_date) row.offer_issued_date = r.offer_issued_date;
      if (r.completed_at) row.completed_at = r.completed_at;
      const { error } = await db.from("cases").insert(row);
      if (error) throw new Error("seed insert failed: " + error.message);
    }
  }, { clientId, rows });
}
async function wipeCases(page) {
  await page.evaluate(async () => { await window.__mockDb.from("cases").delete(); });
}
async function mkThrowawayClient(page) {
  return page.evaluate(async () => {
    const { data, error } = await window.__mockDb.from("clients")
      .insert({ first_name: "MI", last_name: "TestBatch " + Math.random().toString(36).slice(2, 8), email: `mi.${Math.random().toString(36).slice(2, 9)}@example.com` })
      .select("id").single();
    if (error) throw new Error(error.message);
    return data.id;
  });
}
/* Node-side ISO helpers, mirroring the app's own bucket construction (host-local Y/M, exactly
   like renderPipelineMI's runMonths loop) so month buckets always agree with what the app renders. */
function agoIso(t0, days, hour = 12) { const d = new Date(t0 - days * DAY); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); }
function monthIso(t0, deltaMonths, day, hour = 12) {
  const now = new Date(t0);
  return new Date(now.getFullYear(), now.getMonth() + deltaMonths, day, hour, 0, 0, 0).toISOString();
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {

    /* =======================================================================
       A · OWNER/ADMIN GATE — #report-mi-section visible + jump chips present
           for owner (p4); hidden + chips absent for an adviser (p2).
       ======================================================================= */
    {
      console.log("\n— A · Owner/admin gate: #report-mi-section + jump chips (p4 vs p2)");

      const pageOwner = await newPage(browser, "p4");
      const errBeforeOwner = (pageOwner.__err || []).length;
      await goto(pageOwner, "reports", 1200);
      const ownerHidden = await pageOwner.evaluate(() => document.querySelector("#report-mi-section").classList.contains("hidden"));
      ok("A · owner (p4): #report-mi-section is NOT hidden", !ownerHidden);
      const ownerPanelsVisible = await pageOwner.evaluate(() => {
        const ids = ["#report-mi-funnel-panel", "#report-mi-velocity-panel", "#report-mi-revenue-panel", "#report-mi-scoreboard-panel"];
        return ids.every((s) => !!document.querySelector(s));
      });
      ok("A · owner: all four MI panel containers exist", ownerPanelsVisible);
      /* R74: the level-2 chip strip is scoped to the SELECTED level-1 section (D#6 — it used to
         list all twenty panels at once). The MI chips live under the "Pipeline MI" pill, so the
         reader picks that section first. Same assertion, same four chips, one control earlier. */
      const ownerChips = await pageOwner.evaluate(async () => {
        const pill = document.getElementById("reports-nav-mi");
        if (pill) { pill.click(); await new Promise((r) => setTimeout(r, 500)); }
        return ["mi", "mivelocity", "mirevenue", "miboard"].map((k) => !!document.querySelector(`#rep-nav-${k}`));
      });
      eq("A · owner: all four MI jump chips are present", ownerChips, [true, true, true, true]);
      ok("A · owner: no console errors", (pageOwner.__err || []).length === errBeforeOwner, JSON.stringify(pageOwner.__err));
      await pageOwner.close();

      const pageAdv = await newPage(browser, "p2");
      const errBeforeAdv = (pageAdv.__err || []).length;
      await goto(pageAdv, "reports", 1200);
      const advHidden = await pageAdv.evaluate(() => document.querySelector("#report-mi-section").classList.contains("hidden"));
      ok("A · adviser (p2): #report-mi-section IS hidden", advHidden);
      /* R74: an adviser has no MI section at all, so there is no pill to press — the chips must be
         absent whichever section is selected. Walk them all rather than trusting one. */
      const advChips = await pageAdv.evaluate(async () => {
        const found = { mi: false, mivelocity: false, mirevenue: false, miboard: false };
        const pills = [...document.querySelectorAll("#reports-jump-chips [data-reports-jump]")];
        for (const p of (pills.length ? pills : [null])) {
          if (p) { p.click(); await new Promise((r) => setTimeout(r, 300)); }
          Object.keys(found).forEach((k) => { if (document.querySelector(`#rep-nav-${k}`)) found[k] = true; });
        }
        return ["mi", "mivelocity", "mirevenue", "miboard"].map((k) => found[k]);
      });
      eq("A · adviser: none of the four MI jump chips are present", advChips, [false, false, false, false]);
      ok("A · adviser: no console errors", (pageAdv.__err || []).length === errBeforeAdv, JSON.stringify(pageAdv.__err));
      await pageAdv.close();
    }

    /* From here on, everything runs on ONE shared owner (p4) page — mock-supabase.js's DB is
       rebuilt per page load, and every block below wipes+reseeds the `cases` table itself. */
    const page = await newPage(browser, "p4");
    const noNewErr = (before) => (page.__err || []).length === before;

    /* =======================================================================
       B · THIN-DATA GUARDS — a near-empty book: no live cases (funnel empty
           state), < 5 terminal cases (win-rate weak message), no velocity
           data (bottleneck "not enough" message), forecast at zero using
           default weights, thin-data scoreboard rows.
       ======================================================================= */
    {
      console.log("\n— B · Thin-data guards: empty funnel, weak win-rate, no bottleneck, default forecast (p4)");
      const errBefore = (page.__err || []).length;

      await wipeCases(page);
      const cid = await mkThrowawayClient(page);
      // Exactly 2 terminal cases, zero milestone dates, zero live cases at all.
      await seedMiRows(page, cid, [
        { stage: "completed", assigned_to: "p2", broker_fee: 0, proc_fee: 0 },
        { stage: "not_proceeding", assigned_to: "p2", broker_fee: 0, proc_fee: 0 },
      ]);
      await goto(page, "reports", 1500);

      const funnelTxt = await page.$eval("#report-mi-funnel", (e) => e.textContent.trim());
      eq("B · funnel: empty-state message when there are no live cases", funnelTxt, "No live cases in the pipeline.");

      const winTxt = await page.$eval("#report-mi-winrate", (e) => e.textContent.trim());
      eq("B · win-rate: thin-data guard message (2 terminal cases)", winTxt, "Win rate: not enough completed cases yet for a reliable rate (2 terminal cases).");

      const bottleneckTxt = await page.$eval("#report-mi-bottleneck", (e) => e.textContent.trim());
      eq("B · bottleneck: \"not enough dated cases\" message with zero velocity data", bottleneckTxt, "Not enough dated cases yet to identify a bottleneck.");

      const forecastBasis = await page.$eval("#report-mi-forecast .money-basis", (e) => e.textContent.trim());
      eq("B · forecast: default-weights label when history is thin", forecastBasis, "(default likelihoods — will calibrate as cases complete)");
      const headlineNums = await page.$$eval("#report-mi-forecast-headline .num", (els) => els.map((e) => e.textContent.trim()));
      const zeroStr = await page.evaluate(() => fmtM(0));
      eq("B · forecast headline: £0 weighted-expected and £0 live pipeline (no live cases)", headlineNums, [zeroStr, zeroStr]);

      ok("B · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       C · THE FULL, KNOWN DATASET — funnel, conversion, win rate, velocity,
           bottleneck, run-rate, forecast (calibrated weights this time,
           reachedCompleted >= 5), scoreboard (multi-adviser, Unassigned row,
           sort-by-fees-desc, both the term<5 "weak" and term>=5 confident
           win-rate formatting).
       ======================================================================= */
    {
      console.log("\n— C · Full known dataset: funnel/conversion/win-rate/velocity/bottleneck/run-rate/forecast/scoreboard (p4)");
      const errBefore = (page.__err || []).length;

      await wipeCases(page);
      const cid = await mkThrowawayClient(page);
      const T0 = await page.evaluate(() => Date.now());
      const mv = await page.evaluate(() => localMonthStr());
      // The 12 run-rate bucket keys, built EXACTLY like renderPipelineMI's own runMonths loop
      // (host-local Y/M, oldest -> newest), then formatted via the app's own localMonthStr.
      const monthKeys = await page.evaluate(() => {
        const now = new Date();
        const out = [];
        for (let i = 11; i >= 0; i--) out.push(localMonthStr(new Date(now.getFullYear(), now.getMonth() - i, 1)));
        return out;
      });

      const rows = [];
      // --- LIVE (funnel + forecast + scoreboard "live") ---
      const live1 = { enquiry: 120, fact_find: 340, decision_in_principle: 560, application: 780, offer: 910, exchange: 1050 };
      Object.entries(live1).forEach(([stage, fee]) => rows.push({ stage, assigned_to: "p2", broker_fee: fee, proc_fee: 0 }));
      const live2 = { enquiry: [50, 0], application: [200, 0], offer: [300, 150], exchange: [150, 0] };
      Object.entries(live2).forEach(([stage, [bf, pf]]) => rows.push({ stage, assigned_to: "p3", broker_fee: bf, proc_fee: pf }));
      rows.push({ stage: "fact_find", assigned_to: null, broker_fee: 0, proc_fee: 0 }); // the Unassigned live case

      // --- group A: created -> submitted only, gaps [3,7,12,5,9,4], not_proceeding, p2 ---
      const SUB_ANCHOR = agoIso(T0, 200);
      [3, 7, 12, 5, 9, 4].forEach((gap) => rows.push({
        stage: "not_proceeding", assigned_to: "p2", broker_fee: 0, proc_fee: 0,
        submitted_at: SUB_ANCHOR, created_at: agoIso(T0, 200 + gap),
      }));
      // --- group B: submitted -> offer, gaps [2,6,10,4,8,3,5,7,9,11], not_proceeding, p2 ---
      const OFFER_ANCHOR = agoIso(T0, 150);
      [2, 6, 10, 4, 8, 3, 5, 7, 9, 11].forEach((gap) => rows.push({
        stage: "not_proceeding", assigned_to: "p2", broker_fee: 0, proc_fee: 0,
        offer_issued_date: OFFER_ANCHOR, submitted_at: agoIso(T0, 150 + gap),
      }));
      // --- group C: offer -> completed, gaps [10,25,40,15], completed, p3 ---
      const OFFER_ANCHOR2 = agoIso(T0, 100);
      [10, 25, 40, 15].forEach((gap) => rows.push({
        stage: "completed", assigned_to: "p3", broker_fee: 0, proc_fee: 0,
        offer_issued_date: OFFER_ANCHOR2, completed_at: agoIso(T0, 100 - gap),
      }));
      // --- group D: created -> completed (total cycle) only, gap 45, completed, p2 ---
      rows.push({ stage: "completed", assigned_to: "p2", broker_fee: 0, proc_fee: 0, created_at: agoIso(T0, 105), completed_at: agoIso(T0, 60) });
      // --- group F: submitted + completed (feeds appAndCompleted / application weight calibration) ---
      rows.push({ stage: "completed", assigned_to: "p2", broker_fee: 0, proc_fee: 0, submitted_at: agoIso(T0, 90), completed_at: agoIso(T0, 70) });
      rows.push({ stage: "completed", assigned_to: "p3", broker_fee: 0, proc_fee: 0, submitted_at: agoIso(T0, 95), completed_at: agoIso(T0, 60) });
      // --- group E: run-rate + scoreboard period, known months + fees ---
      rows.push({ stage: "completed", assigned_to: "p2", broker_fee: 500, proc_fee: 100, completed_at: monthIso(T0, 0, 3) });   // this month
      rows.push({ stage: "completed", assigned_to: "p3", broker_fee: 1500, proc_fee: 0, completed_at: monthIso(T0, 0, 3) });   // this month
      rows.push({ stage: "completed", assigned_to: null, broker_fee: 800, proc_fee: 200, completed_at: monthIso(T0, -3, 15) }); // 3 months ago
      rows.push({ stage: "completed", assigned_to: "p2", broker_fee: 300, proc_fee: 0, completed_at: monthIso(T0, -11, 20) });  // oldest in-window
      rows.push({ stage: "completed", assigned_to: "p2", broker_fee: 9999, proc_fee: 9999, completed_at: monthIso(T0, -13, 10) }); // OUTSIDE the 12-month window

      await seedMiRows(page, cid, rows);
      const exp = computeExpectedMI(rows, mv, monthKeys);

      await goto(page, "reports", 1500);

      // ---- Panel 1: funnel ----
      // R20 — each stage row is now a real <button class="mi-bar-row"> (was a plain <div>), so it
      // can drill down to the live cases at that stage (Enter/Space work natively); it also nests
      // the progress-bar fill inside the track (an extra <span class="mi-bar-fill">), which shifts
      // a POSITIONAL span[i] index. Selecting by class (.mi-bar-lbl / .mi-bar-n) instead of by
      // position is the precise fix — it asserts the exact same two facts (label, count) without
      // depending on how many spans sit between them.
      const funnelRows = await page.$$eval("#report-mi-funnel > .mi-bar-row", (els) => els.map((d) => ({
        label: d.querySelector(".mi-bar-lbl").textContent.trim(),
        n: Number(d.querySelector(".mi-bar-n").textContent.trim()),
      })));
      eq("C · funnel: stage order matches MI_LIVE_STAGES", funnelRows.map((r) => r.label), ["Enquiry", "Fact Find", "DIP", "Application", "Offer", "Exchange"]);
      eq("C · funnel: counts per stage", funnelRows.map((r) => r.n), MI_LIVE_STAGES.map((s) => exp.funnel[s]));

      // ---- Panel 1: conversion table ----
      const convRows = await page.$$eval("#report-mi-conversion table tr", (trs) => trs.slice(1).map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
      eq("C · conversion: \"Created\" row = total cases, no step %", [convRows[0][1], convRows[0][2]], [String(exp.total), "—"]);
      eq("C · conversion: \"Reached application\" row = reachedApp + step %", [convRows[1][1], convRows[1][2]], [String(exp.reachedApp), exp.stepApp + "%"]);
      eq("C · conversion: \"Reached offer\" row = reachedOffer + step %", [convRows[2][1], convRows[2][2]], [String(exp.reachedOffer), exp.stepOffer + "%"]);
      eq("C · conversion: \"Completed\" row = reachedCompleted + step %", [convRows[3][1], convRows[3][2]], [String(exp.reachedCompleted), exp.stepComp + "%"]);

      // ---- Panel 1: win rate (terminal >= 5, confident formatting) ----
      const winTxt = await page.$eval("#report-mi-winrate", (e) => e.textContent.trim());
      eq("C · win rate: confident formatting with the exact computed %", winTxt,
        `Win rate ${exp.winPct}% — ${exp.completedN} completed of ${exp.terminal} terminal (completed + not proceeding).`);

      // ---- Panel 2: velocity table ----
      const velRows = await page.$$eval("#report-mi-velocity table tr", (trs) => trs.slice(1).map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
      const velExpected = [
        ["Created → application", `${exp.medCreatedApp}d`, `${exp.meanCreatedApp}d`, String(exp.vCreatedApp.length)],
        ["Application → offer", `${exp.medAppOffer}d`, `${exp.meanAppOffer}d`, String(exp.vAppOffer.length)],
        ["Offer → completion", `${exp.medOfferComp}d`, `${exp.meanOfferComp}d`, String(exp.vOfferComp.length)],
        ["Created → completion (total)", `${exp.medCreatedComp}d`, `${exp.meanCreatedComp}d`, String(exp.vCreatedComp.length)],
      ];
      eq("C · velocity table: median/average/n for all four transitions", velRows, velExpected);

      // ---- Panel 2: bottleneck ----
      const bottleneckTxt = await page.$eval("#report-mi-bottleneck", (e) => e.textContent.trim());
      eq("C · bottleneck names the slowest median sub-step with its n", bottleneckTxt,
        `Longest stage: ${exp.bottleneck.name}, median ${exp.bottleneck.med} day${exp.bottleneck.med === 1 ? "" : "s"} (n=${exp.bottleneck.n}).`);

      // ---- Panel 3: run-rate (read the per-bar title attr: "YYYY-MM: £X") ----
      const runTitles = await page.$$eval("#report-mi-runrate > div", (els) => els.map((e) => e.getAttribute("title")));
      const runExpected = await Promise.all(monthKeys.map(async (m) => `${m}: ${await page.evaluate((v) => fmtM(v), exp.runMap[m])}`));
      eq("C · run-rate: 12 month bars, each with the exact completed-fee total", runTitles, runExpected);
      const runTotalStr = await page.evaluate((v) => fmtM(v), monthKeys.reduce((s, m) => s + exp.runMap[m], 0));
      const runBasisTxt = await page.$eval("#report-mi-runrate-basis", (e) => e.textContent.trim());
      ok("C · run-rate basis line states the correct 12-month total", runBasisTxt.includes(runTotalStr), `${runBasisTxt} / expected total ${runTotalStr}`);
      // The 13-months-ago row (£19,998 fee) must NOT be included anywhere in the 12-month total.
      const outsideStr = await page.evaluate((v) => fmtM(v), 9999 + 9999);
      ok("C · the case completed 13 months ago is excluded from every run-rate bucket", !runTitles.some((t) => t.endsWith(outsideStr)), JSON.stringify(runTitles));

      // ---- Panel 3: forecast (calibrated — reachedCompleted/reachedApp/reachedOffer all >= 5) ----
      ok("C · this dataset is NOT thin (reachedCompleted >= 5) — sanity check on the test's own fixture", !exp.thin, exp.reachedCompleted);
      ok("C · application AND offer weights are calibrated from history — sanity check", exp.calibrated);
      const forecastBasis = await page.$eval("#report-mi-forecast .money-basis", (e) => e.textContent.trim());
      eq("C · forecast label states calibrated application/offer weights", forecastBasis,
        "(application/offer weights calibrated from history; other stages default likelihoods)");
      const headlineNums = await page.$$eval("#report-mi-forecast-headline .num", (els) => els.map((e) => e.textContent.trim()));
      const expWeightedStr = await page.evaluate((v) => fmtM(v), exp.weightedTotal);
      const expLiveFeeStr = await page.evaluate((v) => fmtM(v), exp.liveFeeTotal);
      eq("C · forecast headline: weighted-expected then live-pipeline-fees, both exact", headlineNums, [expWeightedStr, expLiveFeeStr]);
      const forecastRows = await page.$$eval("#report-mi-forecast table tr", (trs) => trs.slice(1).map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
      for (let i = 0; i < MI_LIVE_STAGES.length; i++) {
        const s = MI_LIVE_STAGES[i];
        const expLiveStr = await page.evaluate((v) => fmtM(v), exp.liveFeeByStage[s]);
        const expPct = Math.round(exp.weightOf[s] * 100) + "%";
        const expExpStr = await page.evaluate((v) => fmtM(v), exp.liveFeeByStage[s] * exp.weightOf[s]);
        eq(`C · forecast table row for ${s}: live £ / weight % / expected £`, forecastRows[i].slice(1), [expLiveStr, expPct, expExpStr]);
      }

      // ---- Panel 4: scoreboard ----
      const profiles = await page.evaluate(async () => (await window.__mockDb.from("profiles").select("id,full_name")).data);
      const nameOf = (id) => (id ? ((profiles.find((p) => p.id === id) || {}).full_name || id) : "Unassigned");
      const boardExpected = await Promise.all(exp.boardRows.map(async (a) => [
        nameOf(a.id), String(a.live), String(a.completedPeriod), await page.evaluate((v) => fmtM(v), a.feesPeriod),
        a.winPct == null ? "—" : `${a.winPct}% (${a.term})`,
        a.medCycle == null ? "—" : `${a.medCycle}d`,
      ]));
      const boardRowsTxt = await page.$$eval("#report-mi-scoreboard table tr", (trs) => trs.slice(1).map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim().replace(/\s+/g, " "))));
      eq("C · scoreboard: adviser name/live/completed(period)/fees(period)/win rate(all-time)/median cycle(all-time), sorted by fees desc",
        boardRowsTxt, boardExpected);
      // Sort-by-fees-desc, and the Unassigned row, checked explicitly (redundant with the row-by-row
      // check above, but a direct, named assertion of the two behaviours SPEC19.md calls out).
      const feesDesc = exp.boardRows.every((a, i) => i === 0 || exp.boardRows[i - 1].feesPeriod >= a.feesPeriod);
      ok("C · scoreboard rows are sorted by fees written (period) descending", feesDesc);
      ok("C · an \"Unassigned\" row is present (the null-assigned_to live case)", boardRowsTxt.some((r) => r[0] === "Unassigned"));

      ok("C · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    await page.close();

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r19: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
