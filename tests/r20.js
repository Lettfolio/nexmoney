#!/usr/bin/env node
/* =============================================================================
   tests/r20.js — acceptance tests for ROUND 20: "actionable" Pipeline MI —
   per-panel CSV export + click-through drill-downs on top of R19's
   #report-mi-section (SPEC20.md — Fable). Frontend + tests only, no schema.

     Part A — CSV export. Each of the four MI panels gets a small "⭳ CSV"
       button in its header (#report-mi-csv-funnel / -velocity / -revenue /
       -scoreboard), emitting via a shared `miCsv(filename, header, rows)`
       (app.js ~18297) that reuses exportCsv's EXACT serialization contract
       (UTF-8 BOM, `""` quote-doubling, the `=+-@\t\r` formula-injection
       guard) — never a second CSV library. Filenames
       `nexmoney-mi-<panel>-YYYY-MM-DD.csv`. miCsv is NOT exposed on
       `window`, so this file intercepts the download the same way
       tests/r13.js and tests/r8_touch.js already do: override
       `URL.createObjectURL` + `HTMLAnchorElement.prototype.click` to capture
       the Blob instead of letting Chromium try to save it, then read its
       text (armCsvCapture/readCsv/parseCsvLine below, copied from that
       existing pattern — no new technique).

     Part B — drill-down modal. `window.miDrilldown(title, cases)`
       (app.js ~18316) renders `#mi-drilldown` inside the existing `#modal` /
       openModal() infra: a titled table (client · stage · adviser · fee ·
       Open button), a `.mi-drill-count` header chip, its own
       `#mi-drilldown-csv`, and `#mi-drilldown-close`. Click targets are real
       `<button>`s (funnel stage bars `.mi-bar-row[data-mi-stage]`,
       scoreboard adviser rows `.mi-adv-link[data-mi-adv]`, the win-rate
       figure `#report-mi-winrate-link`) so Enter/Space work natively; a
       zero-count funnel bar is `disabled`. Each Open button is
       `onclick="closeModal(); openCase('<id>')"`.

   EVERY figure this file asserts against the CSV/drilldown output is
   recomputed INDEPENDENTLY (computeExpectedMI below, copied from
   tests/r19.js's own independent reimplementation of the R19 MI formulas —
   never imported from app.js) or derived directly from the fixture
   descriptors' own `.id`s captured at insert time — never read back off
   renderPipelineMI's DOM output as its own source of truth. The only app.js
   helpers reused are pure DISPLAY formatters (fmtM, localMonthStr,
   monthLabel, STAGE_LABEL), exactly as tests/r17.js/r19.js already do.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r20.js
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
const closeAnyModal = async (page) => { await page.evaluate(() => { if (window.closeModal) window.closeModal(); }); await wait(page, 200); };

/* ---------------------------------------------------------------------------
   CSV capture — same technique tests/r13.js (armBlobCapture/readBlobJson) and
   tests/r8_touch.js (armCsvCapture/readCsv/parseCsvLine) already use: override
   URL.createObjectURL + <a download> click so nothing hits disk, then read
   the Blob back as text. miCsv() is not window-exposed, so this is the only
   way to see its output short of reading app.js source.
   ------------------------------------------------------------------------- */
async function armCsvCapture(page) {
  await page.evaluate(() => {
    window.__csvBlob = null; window.__csvName = null;
    if (!window.__csvArmed) {
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__csvBlob = b; try { return origCreate(b); } catch (e) { return "blob:captured"; } };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute("download")) { window.__csvName = this.getAttribute("download"); return; } return origClick.apply(this, arguments); };
      window.__csvArmed = true;
    }
  });
}
const resetCsvCapture = (page) => page.evaluate(() => { window.__csvBlob = null; window.__csvName = null; });
const readCsv = (page) => page.evaluate(async () => (window.__csvBlob ? await window.__csvBlob.text() : null));
const readCsvName = (page) => page.evaluate(() => window.__csvName);
/* blob.text() decodes as UTF-8 via TextDecoder, whose DEFAULT behaviour is to silently STRIP a
   leading U+FEFF (that is what "UTF-8 BOM" support in a decoder means) — so the BOM can never be
   observed on the decoded string, only on the raw bytes. miCsv's Blob is constructed from a plain
   JS string starting with the BOM CHARACTER (not a manually-encoded 3-byte sequence), so the
   correct — and only — way to prove it is really there is to read the raw bytes and look for the
   UTF-8 encoding of U+FEFF (EF BB BF), exactly what Excel/Numbers sniff for. */
const readCsvHasBom = (page) => page.evaluate(async () => {
  if (!window.__csvBlob) return false;
  const buf = new Uint8Array(await window.__csvBlob.arrayBuffer());
  return buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
});
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}
/* Strips the UTF-8 BOM (asserted separately, once, per file) and parses every
   remaining line. Returns { header, rows }. */
function parseCsv(text) {
  const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const lines = body.split("\n").filter((l) => l.length);
  return { header: parseCsvLine(lines[0]), rows: lines.slice(1).map(parseCsvLine) };
}

/* ---------------------------------------------------------------------------
   Independent re-implementation of the R19 MI formulas, copied verbatim from
   tests/r19.js (never imported from app.js) — used here only to derive the
   exact CSV-row content the R20 export SHOULD contain for a known fixture.
   Drill-down MEMBERSHIP (which cases a click reveals) is checked separately,
   directly off the fixture's own captured `.id`s, not through this.
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
    runMap, thin, calibrated, weightOf, liveFeeTotal, weightedTotal,
    boardRows,
  };
}

/* ---------------------------------------------------------------------------
   Fixture helpers.
   ------------------------------------------------------------------------- */
async function wipeCases(page) { await page.evaluate(async () => { await window.__mockDb.from("cases").delete(); }); }
async function mkClient(page, first, last) {
  return page.evaluate(async ({ first, last }) => {
    const { data, error } = await window.__mockDb.from("clients")
      .insert({ first_name: first, last_name: last, email: `mi.${Math.random().toString(36).slice(2, 9)}@example.com` })
      .select("id").single();
    if (error) throw new Error(error.message);
    return data.id;
  }, { first, last });
}
/* Batch-inserts one descriptor per row, attached to ONE client, and returns
   the inserted ids IN THE SAME ORDER as `rows` — so the caller can stamp
   `rows[i].id = ids[i]` and use the fixture descriptors themselves as ground
   truth for which cases a drill-down SHOULD reveal (never the rendered DOM). */
async function seedCases(page, clientId, rows) {
  return page.evaluate(async ({ clientId, rows }) => {
    const db = window.__mockDb;
    const payload = rows.map((r) => {
      const row = {
        client_id: clientId, case_kind: "purchase", stage: r.stage,
        assigned_to: r.assigned_to === undefined ? null : r.assigned_to,
        broker_fee: r.broker_fee || 0, proc_fee: r.proc_fee || 0,
      };
      if (r.created_at) row.created_at = r.created_at;
      if (r.submitted_at) row.submitted_at = r.submitted_at;
      if (r.offer_issued_date) row.offer_issued_date = r.offer_issued_date;
      if (r.completed_at) row.completed_at = r.completed_at;
      return row;
    });
    const { data, error } = await db.from("cases").insert(payload).select("id");
    if (error) throw new Error("seed insert failed: " + error.message);
    return data.map((d) => d.id);
  }, { clientId, rows });
}
function agoIso(t0, days, hour = 12) { const d = new Date(t0 - days * DAY); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); }
function monthIso(t0, deltaMonths, day, hour = 12) {
  const now = new Date(t0);
  return new Date(now.getFullYear(), now.getMonth() + deltaMonths, day, hour, 0, 0, 0).toISOString();
}
const sortedIds = (a) => a.slice().sort();

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {

    /* =======================================================================
       A · OWNER/ADMIN GATE — the four panel CSV buttons exist and are WIRED
           (onclick attached) for owner (p4) inside the visible
           #report-mi-section; for an adviser (p2) the section stays hidden
           and renderPipelineMI's early `return` (same gate R19 already
           proved) means the CSV buttons' onclick is NEVER attached, so they
           are inert even though the static markup is present in the DOM.
       ======================================================================= */
    {
      console.log("\n— A · CSV buttons: present + wired for owner, un-wired + section hidden for adviser");
      const CSV_IDS = ["#report-mi-csv-funnel", "#report-mi-csv-velocity", "#report-mi-csv-revenue", "#report-mi-csv-scoreboard"];

      const pageOwner = await newPage(browser, "p4");
      const errBeforeOwner = (pageOwner.__err || []).length;
      await goto(pageOwner, "reports", 1200);
      ok("A · owner: #report-mi-section is NOT hidden", !(await pageOwner.$eval("#report-mi-section", (e) => e.classList.contains("hidden"))));
      const ownerBtns = await pageOwner.evaluate((ids) => ids.map((s) => {
        const el = document.querySelector(s);
        return el ? { tag: el.tagName, wired: typeof el.onclick === "function", insideSection: !!el.closest("#report-mi-section") } : null;
      }), CSV_IDS);
      eq("A · owner: all four CSV buttons exist, are <button>s, are wired, and live inside #report-mi-section",
        ownerBtns, CSV_IDS.map(() => ({ tag: "BUTTON", wired: true, insideSection: true })));
      ok("A · owner: no console errors", (pageOwner.__err || []).length === errBeforeOwner, JSON.stringify(pageOwner.__err));
      await pageOwner.close();

      const pageAdv = await newPage(browser, "p2");
      const errBeforeAdv = (pageAdv.__err || []).length;
      await goto(pageAdv, "reports", 1200);
      ok("A · adviser: #report-mi-section IS hidden", await pageAdv.$eval("#report-mi-section", (e) => e.classList.contains("hidden")));
      const advBtns = await pageAdv.evaluate((ids) => ids.map((s) => { const el = document.querySelector(s); return el ? typeof el.onclick === "function" : null; }), CSV_IDS);
      eq("A · adviser: none of the four CSV buttons got wired (renderPipelineMI returned before reaching them)", advBtns, [false, false, false, false]);
      ok("A · adviser: no console errors", (pageAdv.__err || []).length === errBeforeAdv, JSON.stringify(pageAdv.__err));
      await pageAdv.close();
    }

    /* From here on, everything runs on ONE shared owner (p4) page. */
    const page = await newPage(browser, "p4");
    const noNewErr = (before) => (page.__err || []).length === before;
    await armCsvCapture(page);

    /* =======================================================================
       B · KNOWN DATASET — CSV export content (all four panels) + drill-down
           membership (funnel stage bars, scoreboard adviser rows, win-rate)
           + a11y (buttons, disabled zero-count bar) + Open-button routing.
       ======================================================================= */
    let rows, exp, mv, label, monthKeys, boardNames, cid;
    {
      console.log("\n— B · Known dataset: CSV export content + drill-down membership (p4)");
      const errBefore = (page.__err || []).length;

      await wipeCases(page);
      cid = await mkClient(page, "MI", "TestBatch " + Math.random().toString(36).slice(2, 8));
      const T0 = await page.evaluate(() => Date.now());
      mv = await page.evaluate(() => localMonthStr());
      monthKeys = await page.evaluate(() => {
        const now = new Date();
        const out = [];
        for (let i = 11; i >= 0; i--) out.push(localMonthStr(new Date(now.getFullYear(), now.getMonth() - i, 1)));
        return out;
      });

      rows = [];
      // --- LIVE (funnel + forecast). "fact_find" deliberately gets ZERO cases,
      //     to prove the zero-count funnel bar renders `disabled`. ---
      rows.push({ stage: "enquiry", assigned_to: "p2", broker_fee: 150, proc_fee: 0 });
      rows.push({ stage: "enquiry", assigned_to: "p3", broker_fee: 50, proc_fee: 0 });
      rows.push({ stage: "decision_in_principle", assigned_to: "p2", broker_fee: 200, proc_fee: 0 });
      rows.push({ stage: "application", assigned_to: "p2", broker_fee: 300, proc_fee: 0 });
      rows.push({ stage: "application", assigned_to: "p2", broker_fee: 150, proc_fee: 0 });
      rows.push({ stage: "application", assigned_to: "p3", broker_fee: 250, proc_fee: 0 });
      rows.push({ stage: "offer", assigned_to: "p3", broker_fee: 400, proc_fee: 0 });
      rows.push({ stage: "exchange", assigned_to: "p2", broker_fee: 120, proc_fee: 0 });
      rows.push({ stage: "exchange", assigned_to: null, broker_fee: 80, proc_fee: 0 });

      // --- terminal, dated (velocity + terminal count) ---
      rows.push({ stage: "not_proceeding", assigned_to: "p3", broker_fee: 0, proc_fee: 0, created_at: agoIso(T0, 40), submitted_at: agoIso(T0, 30) });
      rows.push({ stage: "not_proceeding", assigned_to: "p2", broker_fee: 0, proc_fee: 0, submitted_at: agoIso(T0, 25), offer_issued_date: agoIso(T0, 15) });

      // --- terminal, completed, three dated in "this month" for run-rate/scoreboard period ---
      rows.push({ stage: "completed", assigned_to: "p2", broker_fee: 500, proc_fee: 0, created_at: agoIso(T0, 33), completed_at: monthIso(T0, 0, 3) });
      rows.push({ stage: "completed", assigned_to: "p3", broker_fee: 300, proc_fee: 0, created_at: agoIso(T0, 28), completed_at: monthIso(T0, 0, 3) });
      rows.push({ stage: "completed", assigned_to: null, broker_fee: 100, proc_fee: 0, created_at: agoIso(T0, 20), completed_at: monthIso(T0, 0, 3) });
      // --- terminal, undated (contribute to win/lost counts and all-time win rate only) ---
      rows.push({ stage: "completed", assigned_to: "p2", broker_fee: 0, proc_fee: 0 });
      rows.push({ stage: "completed", assigned_to: "p3", broker_fee: 0, proc_fee: 0 });
      rows.push({ stage: "not_proceeding", assigned_to: "p2", broker_fee: 0, proc_fee: 0 });
      rows.push({ stage: "not_proceeding", assigned_to: null, broker_fee: 0, proc_fee: 0 });

      const ids = await seedCases(page, cid, rows);
      rows.forEach((r, i) => { r.id = ids[i]; });
      exp = computeExpectedMI(rows, mv, monthKeys);
      label = await page.evaluate((v) => monthLabel(v), mv);

      // Sanity on the test's own fixture, mirroring tests/r19.js's own style.
      ok("B · fixture sanity: terminal >= 5 (global win-rate confident branch)", exp.terminal >= 5, exp.terminal);
      ok("B · fixture sanity: reachedCompleted < 5 (thin — default forecast weights)", exp.thin, exp.reachedCompleted);
      ok("B · fixture sanity: every adviser's own term < 5 (per-row weak win-rate branch)", exp.boardRows.every((a) => a.term < 5), JSON.stringify(exp.boardRows));
      eq("B · fixture sanity: scoreboard sorted p2 > p3 > Unassigned by feesPeriod (500/300/100)", exp.boardRows.map((a) => a.feesPeriod), [500, 300, 100]);

      await goto(page, "reports", 1500);

      /* ---------------------------------------------------------------------
         B1 · Funnel + conversion CSV (#report-mi-csv-funnel)
         ------------------------------------------------------------------- */
      await resetCsvCapture(page);
      await page.click("#report-mi-csv-funnel");
      await wait(page, 300);
      ok("B1 · funnel CSV starts with a UTF-8 BOM (raw bytes EF BB BF)", await readCsvHasBom(page));
      const funnelText = await readCsv(page);
      ok("B1 · a CSV was produced", !!funnelText);
      const funnelName = await readCsvName(page);
      const todayUTC = await page.evaluate(() => new Date().toISOString().slice(0, 10));
      eq("B1 · funnel CSV filename", funnelName, `nexmoney-mi-funnel-${todayUTC}.csv`);
      const funnelCsv = parseCsv(funnelText);
      eq("B1 · funnel CSV header", funnelCsv.header, ["Section", "Item", "Count", "Step %"]);
      const STAGE_LABELS = ["Enquiry", "Fact Find", "DIP", "Application", "Offer", "Exchange"];
      const stepStr = (v) => (v == null ? "—" : v + "%"); // "—"
      const funnelExpected = MI_LIVE_STAGES.map((s, i) => ["Live funnel", STAGE_LABELS[i], String(exp.funnel[s]), ""]).concat([
        ["Conversion", "Created", String(exp.total), ""],
        ["Conversion", "Reached application (submitted)", String(exp.reachedApp), stepStr(exp.stepApp)],
        ["Conversion", "Reached offer (offer issued)", String(exp.reachedOffer), stepStr(exp.stepOffer)],
        ["Conversion", "Completed", String(exp.reachedCompleted), stepStr(exp.stepComp)],
        ["Win rate", `${exp.completedN} completed of ${exp.terminal} terminal`, exp.terminal >= 5 ? exp.winPct + "%" : "n/a (<5 terminal)", ""],
      ]);
      eq("B1 · funnel CSV rows: live funnel by stage + conversion milestones + win-rate row, exact", funnelCsv.rows, funnelExpected);

      /* ---------------------------------------------------------------------
         B2 · Velocity CSV (#report-mi-csv-velocity)
         ------------------------------------------------------------------- */
      await resetCsvCapture(page);
      await page.click("#report-mi-csv-velocity");
      await wait(page, 300);
      ok("B2 · velocity CSV starts with a UTF-8 BOM (raw bytes EF BB BF)", await readCsvHasBom(page));
      const velCsv = parseCsv(await readCsv(page));
      eq("B2 · velocity CSV filename", await readCsvName(page), `nexmoney-mi-velocity-${todayUTC}.csv`);
      eq("B2 · velocity CSV header", velCsv.header, ["Transition", "Median days", "Mean days", "n"]);
      const velExpected = [
        ["Created → application", exp.medCreatedApp == null ? "" : String(exp.medCreatedApp), exp.meanCreatedApp == null ? "" : String(exp.meanCreatedApp), String(exp.vCreatedApp.length)],
        ["Application → offer", exp.medAppOffer == null ? "" : String(exp.medAppOffer), exp.meanAppOffer == null ? "" : String(exp.meanAppOffer), String(exp.vAppOffer.length)],
        ["Offer → completion", exp.medOfferComp == null ? "" : String(exp.medOfferComp), exp.meanOfferComp == null ? "" : String(exp.meanOfferComp), String(exp.vOfferComp.length)],
        ["Created → completion (total)", exp.medCreatedComp == null ? "" : String(exp.medCreatedComp), exp.meanCreatedComp == null ? "" : String(exp.meanCreatedComp), String(exp.vCreatedComp.length)],
      ];
      eq("B2 · velocity CSV rows: median/mean/n per transition, exact", velCsv.rows, velExpected);

      /* ---------------------------------------------------------------------
         B3 · Revenue CSV (#report-mi-csv-revenue)
         ------------------------------------------------------------------- */
      await resetCsvCapture(page);
      await page.click("#report-mi-csv-revenue");
      await wait(page, 300);
      ok("B3 · revenue CSV starts with a UTF-8 BOM (raw bytes EF BB BF)", await readCsvHasBom(page));
      const revCsv = parseCsv(await readCsv(page));
      eq("B3 · revenue CSV filename", await readCsvName(page), `nexmoney-mi-revenue-${todayUTC}.csv`);
      eq("B3 · revenue CSV header", revCsv.header, ["Section", "Item", "£ / count", "Weight", "Weighted £"]);
      const runTotal = monthKeys.reduce((s, m) => s + exp.runMap[m], 0);
      const revExpected = monthKeys.map((m) => ["Run-rate", m, String(exp.runMap[m]), "", ""])
        .concat([["Run-rate", "12-month total", String(runTotal), "", ""]])
        .concat(MI_LIVE_STAGES.map((s, i) => ["Forecast", STAGE_LABELS[i], String(exp.liveFeeByStage[s]), Math.round(exp.weightOf[s] * 100) + "%", String(Math.round(exp.liveFeeByStage[s] * exp.weightOf[s]))]))
        .concat([["Forecast", "Live pipeline total", String(exp.liveFeeTotal), "", String(Math.round(exp.weightedTotal))]]);
      eq("B3 · revenue CSV rows: 12 run-rate months + total + per-stage forecast + pipeline total, exact", revCsv.rows, revExpected);
      // This dataset is deliberately thin (reachedCompleted < 5) — confirms the forecast rows use
      // MI_STAGE_DEFAULT_WEIGHT, not calibrated weights, i.e. the CSV genuinely reflects the render.
      eq("B3 · sanity: forecast weights in the CSV are the plain defaults (thin dataset)", MI_LIVE_STAGES.map((s) => exp.weightOf[s]), MI_LIVE_STAGES.map((s) => MI_DEFAULT_WEIGHT[s]));

      /* ---------------------------------------------------------------------
         B4 · Scoreboard CSV (#report-mi-csv-scoreboard)
         ------------------------------------------------------------------- */
      await resetCsvCapture(page);
      await page.click("#report-mi-csv-scoreboard");
      await wait(page, 300);
      ok("B4 · scoreboard CSV starts with a UTF-8 BOM (raw bytes EF BB BF)", await readCsvHasBom(page));
      const boardCsv = parseCsv(await readCsv(page));
      eq("B4 · scoreboard CSV filename", await readCsvName(page), `nexmoney-mi-scoreboard-${todayUTC}.csv`);
      eq("B4 · scoreboard CSV header", boardCsv.header, ["Adviser", "Live", `Completed (${label})`, "Fees written £", "Win rate", "Terminal n", "Median cycle days"]);
      const profiles = await page.evaluate(async () => (await window.__mockDb.from("profiles").select("id,full_name")).data);
      const nameOf = (id) => (id ? ((profiles.find((p) => p.id === id) || {}).full_name || id) : "Unassigned");
      boardNames = exp.boardRows.map((a) => nameOf(a.id));
      const boardExpected = exp.boardRows.map((a) => [
        nameOf(a.id), String(a.live), String(a.completedPeriod), String(a.feesPeriod),
        a.winPct == null ? "" : a.winPct + "%", String(a.term), a.medCycle == null ? "" : String(a.medCycle),
      ]);
      eq("B4 · scoreboard CSV rows: adviser/live/completed(period)/fees(period)/win%/term/medCycle, exact, sorted by fees desc", boardCsv.rows, boardExpected);

      ok("B · no console errors from any CSV export", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       C · A11Y — clickable figures are real <button>s; the zero-count
           "Fact Find" funnel bar is disabled.
       ======================================================================= */
    {
      console.log("\n— C · a11y: clickable MI figures are <button>s; zero-count bar is disabled");
      const errBefore = (page.__err || []).length;

      const funnelBtns = await page.$$eval("#report-mi-funnel .mi-bar-row[data-mi-stage]", (els) => els.map((e) => ({ stage: e.getAttribute("data-mi-stage"), tag: e.tagName, disabled: e.disabled })));
      eq("C · every funnel stage row is a <button>", funnelBtns.map((b) => b.tag), funnelBtns.map(() => "BUTTON"));
      const ff = funnelBtns.find((b) => b.stage === "fact_find");
      ok("C · the zero-count \"Fact Find\" bar is disabled", ff && ff.disabled === true, JSON.stringify(ff));
      funnelBtns.filter((b) => b.stage !== "fact_find").forEach((b) => ok(`C · the non-zero \"${b.stage}\" bar is NOT disabled`, b.disabled === false));

      const advBtns = await page.$$eval("#report-mi-scoreboard .mi-adv-link[data-mi-adv]", (els) => els.map((e) => e.tagName));
      ok("C · every scoreboard adviser link is a <button>", advBtns.length > 0 && advBtns.every((t) => t === "BUTTON"), JSON.stringify(advBtns));

      const wrTag = await page.$eval("#report-mi-winrate-link", (e) => e.tagName);
      eq("C · the win-rate figure is a <button>", wrTag, "BUTTON");

      ok("C · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       D · DRILL-DOWN MEMBERSHIP — funnel stage bar, scoreboard adviser row,
           win-rate figure. Expected case-id sets are computed directly from
           the fixture descriptors (rows), never from the rendered DOM.
       ======================================================================= */
    {
      console.log("\n— D · Drill-down membership: funnel stage / scoreboard adviser / win-rate (p4)");
      const errBefore = (page.__err || []).length;

      const readDrilldown = async () => {
        const count = await page.$eval("#mi-drilldown .mi-drill-count", (e) => e.textContent.trim());
        const ids = await page.$$eval("#mi-drilldown table tr", (trs) => trs.slice(1).map((tr) => {
          const btn = tr.querySelector("button");
          const m = /openCase\('([^']+)'\)/.exec((btn && btn.getAttribute("onclick")) || "");
          return m ? m[1] : null;
        }));
        return { count, ids };
      };

      // D1 — funnel stage bar "enquiry" (2 live cases: p2 150, p3 50).
      await page.click('#report-mi-funnel .mi-bar-row[data-mi-stage="enquiry"]');
      await wait(page, 500);
      ok("D1 · #mi-drilldown opened", await page.$eval("#modal-backdrop", (e) => !e.classList.contains("hidden")));
      const enquiryExpected = rows.filter((r) => r.stage === "enquiry").map((r) => r.id);
      const d1 = await readDrilldown();
      eq("D1 · funnel \"enquiry\" drill-down count chip", d1.count, String(enquiryExpected.length));
      eq("D1 · funnel \"enquiry\" drill-down lists exactly the live enquiry cases", sortedIds(d1.ids), sortedIds(enquiryExpected));
      const d1Title = await page.$eval("#mi-drilldown h3", (e) => e.childNodes[0].textContent.trim());
      ok("D1 · drill-down title names the stage", /Enquiry/.test(d1Title), d1Title);
      await closeAnyModal(page);

      // D2 — funnel stage bar "application" (3 live cases: p2 300, p2 150, p3 250).
      await page.click('#report-mi-funnel .mi-bar-row[data-mi-stage="application"]');
      await wait(page, 500);
      const applicationExpected = rows.filter((r) => r.stage === "application").map((r) => r.id);
      const d2 = await readDrilldown();
      eq("D2 · funnel \"application\" drill-down count chip", d2.count, String(applicationExpected.length));
      eq("D2 · funnel \"application\" drill-down lists exactly the live application cases", sortedIds(d2.ids), sortedIds(applicationExpected));
      await closeAnyModal(page);

      // D3 — scoreboard adviser row for p2 (ALL of p2's cases: live + terminal, per the app's own
      //      filter `(assigned_to||"__unassigned")===key`, not just the live ones).
      const p2Row = await page.$$eval("#report-mi-scoreboard .mi-adv-link[data-mi-adv]", (els) => els.map((e) => e.getAttribute("data-mi-adv")));
      ok("D3 · a scoreboard row for p2 exists", p2Row.includes("p2"), JSON.stringify(p2Row));
      await page.click('#report-mi-scoreboard .mi-adv-link[data-mi-adv="p2"]');
      await wait(page, 500);
      const p2Expected = rows.filter((r) => (r.assigned_to || "__unassigned") === "p2").map((r) => r.id);
      const d3 = await readDrilldown();
      eq("D3 · scoreboard \"p2\" drill-down count chip", d3.count, String(p2Expected.length));
      eq("D3 · scoreboard \"p2\" drill-down lists exactly p2's cases (live AND terminal)", sortedIds(d3.ids), sortedIds(p2Expected));
      await closeAnyModal(page);

      // D4 — scoreboard "Unassigned" row.
      await page.click('#report-mi-scoreboard .mi-adv-link[data-mi-adv="__unassigned"]');
      await wait(page, 500);
      const unassignedExpected = rows.filter((r) => (r.assigned_to || "__unassigned") === "__unassigned").map((r) => r.id);
      const d4 = await readDrilldown();
      eq("D4 · scoreboard \"Unassigned\" drill-down lists exactly the null-assigned_to cases", sortedIds(d4.ids), sortedIds(unassignedExpected));
      await closeAnyModal(page);

      // D5 — win-rate figure (terminal = completed + not_proceeding, ALL of them, not scoped to
      //      one adviser or one month).
      await page.click("#report-mi-winrate-link");
      await wait(page, 500);
      const terminalExpected = rows.filter((r) => r.stage === "completed" || r.stage === "not_proceeding").map((r) => r.id);
      const d5 = await readDrilldown();
      eq("D5 · win-rate drill-down count chip", d5.count, String(terminalExpected.length));
      eq("D5 · win-rate drill-down lists exactly the terminal (completed + not_proceeding) cases", sortedIds(d5.ids), sortedIds(terminalExpected));
      await closeAnyModal(page);

      ok("D · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       E · KEYBOARD ACCESS — a funnel bar is Enter-activatable (real <button>,
           no custom keydown handler needed, but prove it end to end).
       ======================================================================= */
    {
      console.log("\n— E · Keyboard: Enter on a funnel bar opens the drill-down (p4)");
      const errBefore = (page.__err || []).length;

      await page.focus('#report-mi-funnel .mi-bar-row[data-mi-stage="decision_in_principle"]');
      await page.keyboard.press("Enter");
      await wait(page, 500);
      ok("E · #mi-drilldown opened via Enter key", await page.$eval("#modal-backdrop", (e) => !e.classList.contains("hidden")));
      const dipExpected = rows.filter((r) => r.stage === "decision_in_principle").map((r) => r.id);
      const eIds = await page.$$eval("#mi-drilldown table tr", (trs) => trs.slice(1).map((tr) => {
        const btn = tr.querySelector("button");
        const m = /openCase\('([^']+)'\)/.exec((btn && btn.getAttribute("onclick")) || "");
        return m ? m[1] : null;
      }));
      eq("E · the Enter-opened drill-down lists exactly the DIP cases", sortedIds(eIds), sortedIds(dipExpected));
      await closeAnyModal(page);

      ok("E · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       F · DRILL-DOWN "OPEN" BUTTON — routes to the right case (closes the
           drill-down, opens the case modal on the exact id clicked).
       ======================================================================= */
    {
      console.log("\n— F · Drill-down Open button routes to the right case (p4)");
      const errBefore = (page.__err || []).length;

      await page.click('#report-mi-funnel .mi-bar-row[data-mi-stage="offer"]');
      await wait(page, 500);
      const offerCaseId = rows.find((r) => r.stage === "offer").id;
      const openBtnIds = await page.$$eval("#mi-drilldown table tr", (trs) => trs.slice(1).map((tr) => {
        const btn = tr.querySelector("button");
        const m = /openCase\('([^']+)'\)/.exec((btn && btn.getAttribute("onclick")) || "");
        return m ? m[1] : null;
      }));
      eq("F · the offer drill-down has exactly one row, for the one offer case", openBtnIds, [offerCaseId]);
      await page.click("#mi-drilldown table tr:nth-child(2) button");
      await wait(page, 900);
      ok("F · the modal stayed open (drill-down closed, case modal opened)", await page.$eval("#modal-backdrop", (e) => !e.classList.contains("hidden")));
      const openedCaseId = await page.$eval("#case-form", (e) => e.getAttribute("data-case-id"));
      eq("F · the case modal opened is for the EXACT case the Open button targeted", openedCaseId, offerCaseId);
      ok("F · the drill-down table is gone (replaced by the case modal)", (await page.$("#mi-drilldown")) === null);
      await closeAnyModal(page);

      ok("F · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       G · EMPTY DRILL-DOWN — window.miDrilldown('x', []) → "No cases match.",
           count chip reads 0, and no CSV button (nothing to export).
       ======================================================================= */
    {
      console.log("\n— G · Empty drill-down: window.miDrilldown('x', [])");
      const errBefore = (page.__err || []).length;

      await page.evaluate(() => window.miDrilldown("x", []));
      await wait(page, 400);
      ok("G · #mi-drilldown opened", await page.$eval("#modal-backdrop", (e) => !e.classList.contains("hidden")));
      const emptyTxt = await page.$eval("#mi-drilldown", (e) => e.textContent);
      ok("G · empty drill-down shows \"No cases match.\"", /No cases match\./.test(emptyTxt), emptyTxt);
      const emptyCount = await page.$eval("#mi-drilldown .mi-drill-count", (e) => e.textContent.trim());
      eq("G · empty drill-down count chip reads 0", emptyCount, "0");
      ok("G · no CSV button when the list is empty (nothing to export)", (await page.$("#mi-drilldown-csv")) === null);
      await closeAnyModal(page);

      ok("G · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       H · DRILL-DOWN CSV — its own #mi-drilldown-csv, exact rows for a known
           single-case list, and (since none of the panel-CSV fixture's
           labels ever start with a special character or contain a quote)
           this is where the formula-injection guard + quote-doubling are
           exercised for real, via a deliberately hostile CLIENT NAME that
           feeds nameOf() -> miCsv()'s q2() the exact way a real client's name
           would.
       ======================================================================= */
    {
      console.log("\n— H · Drill-down CSV: exact rows + formula-injection guard + quote-doubling (p4)");
      const errBefore = (page.__err || []).length;

      await wipeCases(page);
      // Joined by miDrilldown's nameOf() as `${first} ${last}` = an EVIL string that (a) starts
      // with "=" (formula-injection trigger) and (b) contains a literal '"' AND a ',' (exercises
      // the quote-doubling AND proves the parser/guard survive a comma inside a quoted field).
      const evilFirst = "=1+1", evilLast = 'O\'Brien "Quotes", Ltd';
      const evilClientId = await mkClient(page, evilFirst, evilLast);
      const evilCase = await seedCases(page, evilClientId, [{ stage: "enquiry", assigned_to: null, broker_fee: 42, proc_fee: 7, created_at: "2026-01-05T12:00:00.000Z", completed_at: null }]);
      const evilId = evilCase[0];

      await goto(page, "reports", 1500);
      await page.click('#report-mi-funnel .mi-bar-row[data-mi-stage="enquiry"]');
      await wait(page, 500);
      const hIds = await page.$$eval("#mi-drilldown table tr", (trs) => trs.slice(1).map((tr) => {
        const btn = tr.querySelector("button");
        const m = /openCase\('([^']+)'\)/.exec((btn && btn.getAttribute("onclick")) || "");
        return m ? m[1] : null;
      }));
      eq("H · the drill-down has exactly the one seeded (evil-named) case", hIds, [evilId]);

      await resetCsvCapture(page);
      ok("H · #mi-drilldown-csv is present (list is non-empty)", !!(await page.$("#mi-drilldown-csv")));
      await page.click("#mi-drilldown-csv");
      await wait(page, 300);
      ok("H · drill-down CSV starts with a UTF-8 BOM (raw bytes EF BB BF)", await readCsvHasBom(page));
      const ddText = await readCsv(page);
      const ddName = await readCsvName(page);
      const todayUTC2 = await page.evaluate(() => new Date().toISOString().slice(0, 10));
      eq("H · drill-down CSV filename", ddName, `nexmoney-mi-drilldown-${todayUTC2}.csv`);
      const ddCsv = parseCsv(ddText);
      eq("H · drill-down CSV header", ddCsv.header, ["Client", "Stage", "Adviser", "Fee £", "Created", "Submitted", "Offer issued", "Completed"]);
      eq("H · drill-down CSV has exactly one data row", ddCsv.rows.length, 1);
      const rawName = `${evilFirst} ${evilLast}`; // = "=1+1 O'Brien \"Quotes\", Ltd"
      const guardedName = "'" + rawName; // the formula-injection guard prepends a literal apostrophe
      eq("H · Client cell: quote-doubling undone AND the formula-injection guard's leading ' preserved, exact", ddCsv.rows[0][0], guardedName);
      ok("H · the raw (un-guarded) string genuinely starts with '=' — sanity check on the test's own fixture", /^=/.test(rawName));
      eq("H · Stage cell", ddCsv.rows[0][1], "Enquiry");
      eq("H · Adviser cell (unassigned)", ddCsv.rows[0][2], "Unassigned");
      eq("H · Fee cell (broker + proc)", ddCsv.rows[0][3], "49");
      eq("H · Created cell (YYYY-MM-DD)", ddCsv.rows[0][4], "2026-01-05");
      eq("H · Submitted cell (unset -> blank)", ddCsv.rows[0][5], "");
      eq("H · Offer issued cell (unset -> blank)", ddCsv.rows[0][6], "");
      eq("H · Completed cell (unset -> blank)", ddCsv.rows[0][7], "");
      await closeAnyModal(page);

      ok("H · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    await page.close();

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r20: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
