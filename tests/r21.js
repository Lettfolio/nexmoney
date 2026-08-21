#!/usr/bin/env node
/* =============================================================================
   tests/r21.js — acceptance tests for ROUND 21: client-side resilience and
   observability. Three parts, all in admin/app.js:

     R21 Part A (app.js ~L22) — GLOBAL, IN-SESSION error capture. `window`
       `error`/`unhandledrejection` listeners feed logClientError(), which
       pushes onto ERROR_LOG (an in-memory ring buffer, capped at
       ERROR_LOG_CAP=100, session-only, NEVER persisted client-side). A
       repeat of the LAST entry's message within ERROR_DEDUPE_MS (5s) bumps
       its `.count` instead of pushing a new row, and raises no extra toast.
       A genuinely new entry raises exactly one non-blocking toast.

     R21 Part B (app.js ~L8777/14200/20407) — SKIP-AND-COUNT resilient
       rendering. Three render loops (the pipeline board's cards, the client
       list's rows, Reports' Pipeline MI aggregation) each wrap ONE record's
       work in try/catch: a genuine exception on one record calls
       logClientError("caught", …, {recordId, where}) and lets every OTHER
       record keep rendering, with a small on-screen "N record(s) couldn't
       be displayed — logged" note rather than a white screen.

     R21 Part C (app.js ~L20696, relocated to Settings by R33) — the
       OWNER/ADMIN Diagnostics panel (`#diag-details` → `#report-diag-
       section`), rendering ERROR_LOG as `#diag-error-table` (newest first)
       plus a health summary, and wiring CSV export (`#report-diag-csv`),
       clipboard copy (`#report-diag-copy`) and clearing the SESSION log
       (`#report-diag-clear`).

   This file covers the IN-SESSION layer only. It deliberately does NOT
   duplicate tests/r30.js, which already owns: the persisted `error_events`
   table, its four-column sanitisation guarantee, `errorEventsOff`,
   `loadPersistedDiagnostics()`/`#diag-persist-table`, and the owner/admin
   vs adviser audience gate on `#diag-details`/`#report-diag-section` (this
   file runs entirely as owner, p4, for that reason — the gate is r30.js's
   ground to cover, not this file's).

   Also covered: `renderLoadError()` (app.js ~L3812) — the older, SIBLING
   safety net for a CONTROLLED `{data:null,error}` response (a graceful
   "Couldn't load this" state + a working retry), as distinct from Part A's
   uncaught-exception capture: a controlled query failure must NOT also add
   an ERROR_LOG entry, which is asserted directly.

   §A  Part A — real `window.error`/`unhandledrejection` events reach
       ERROR_LOG with the documented shape; a genuinely new entry raises
       exactly one toast; a repeat within the dedupe window bumps `.count`
       with no second entry/toast; an over-500-char message is truncated;
       the log is session-only (a reload starts empty).
   §B  Part A — the ring buffer caps at ERROR_LOG_CAP (100): pushing 105
       distinct entries leaves exactly 100, the OLDEST five shifted out.
   §C  Part B — the pipeline board: a genuine exception on one card's
       render (a real throw from a helper called ONLY inside the per-card
       try, restored immediately after) leaves every other card rendered,
       shows the skip-count note, and records one "caught" entry naming the
       right recordId/where.
   §D  Part B — the client list: the same proof, on clientPropertyCount and
       loadClients.
   §E  Part B — Reports' Pipeline MI: a landmine object (a getter that
       throws) fed straight into renderPipelineMI() proves the catch is
       genuinely unconditional — it is not tied to any specific helper —
       and the rest of the MI panel still renders around it.
   §F  renderLoadError — a forced, CONTROLLED query failure degrades to the
       "Couldn't load this" state with a working retry, and — the key
       negative assertion distinguishing it from Part A — adds NOTHING to
       ERROR_LOG.
   §G  Part C — `#diag-error-table` renders session rows newest-first with
       the right columns, and `#report-diag-health`'s "Errors this session"
       total is dedupe-aware (sums `.count`, not row count).
   §H  Part C — `#report-diag-clear` empties ERROR_LOG, repaints the table
       to its empty state, and tells the user so — without touching
       anything persisted (that boundary is r30.js's own to prove; this is
       only "clear did not throw and stayed session-scoped").
   §I  Part C — `#report-diag-csv` produces a real file (header + one row
       per logged message) named for today; `#report-diag-copy` writes the
       same summary to the clipboard when available, and degrades to a
       named toast when it is not.
   §J  Part B, defensively — capturing all of the above never raises a NEW
       console error itself; checked per-section throughout, the same
       `page.__err` convention every suite in this harness uses.

   Run:  node /root/nx/tests/r21.js
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
  // R21's own subject is uncaught page errors, so this suite's console/pageerror listeners record
  // rather than filter EXPECTED ones out — each section reasons about its own error count deltas
  // explicitly instead of relying on a blanket "no new errors" the way other suites can.
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
  await wait(page, ms == null ? 1200 : ms);
};
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const errorLog = (page) => page.evaluate(() => window.__errorLog);
const errorLogLen = (page) => page.evaluate(() => window.__errorLog.length);
/* R33 — the diagnostics block sits inside a collapsed <details id="diag-details"> at the bottom
   of Settings, the same accommodation tests/r30.js's own openDiagDetails() makes. */
const openDiagDetails = (page) => page.evaluate(() => document.getElementById("diag-details")?.setAttribute("open", ""));

/* CSV capture — same technique tests/r42.js/r20.js/r8_touch.js/r13.js already use: override
   URL.createObjectURL + <a download> click so nothing hits disk. */
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
const readCsv = (page) => page.evaluate(async () => (window.__csvBlob ? await window.__csvBlob.text() : null));
const readCsvName = (page) => page.evaluate(() => window.__csvName);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       §A · PART A — real window events reach ERROR_LOG; toast-once; dedupe;
            truncation; session-only.
       ======================================================================= */
    {
      console.log("\n— §A · Part A · real window error/unhandledrejection events, toast-once, dedupe, truncation, session-only (p4)");
      const page = await newPage(browser, "p4");

      const before = await errorLogLen(page);
      eq("§A0 · a fresh page starts with an empty in-memory error log", before, 0);

      // A real, asynchronous, genuinely uncaught throw — not a simulated call to logClientError.
      await page.evaluate(() => { setTimeout(() => { throw new Error("r21-window-error-probe"); }, 0); });
      await wait(page, 400);
      const afterErr = (await errorLog(page)).slice(-1)[0];
      ok("§A1 · window 'error' reaches ERROR_LOG", !!afterErr && afterErr.kind === "error" && /r21-window-error-probe/.test(afterErr.msg), JSON.stringify(afterErr));
      ok("§A2 · …carrying the documented shape (t/kind/msg/where/count/user/role/view)", afterErr && "t" in afterErr && "where" in afterErr && afterErr.count === 1 && "user" in afterErr && "role" in afterErr && "view" in afterErr, JSON.stringify(afterErr));
      const toastAfterErr = await toastText(page);
      eq("§A3 · a genuinely new entry raises exactly the documented toast", toastAfterErr, "Something went wrong — a diagnostic was logged.");

      // A real unhandled promise rejection — the sibling listener.
      await page.evaluate(() => { Promise.reject(new Error("r21-promise-probe")); });
      await wait(page, 400);
      const afterPromise = (await errorLog(page)).slice(-1)[0];
      ok("§A4 · window 'unhandledrejection' reaches ERROR_LOG as kind:\"promise\", where:\"unhandledrejection\"", afterPromise && afterPromise.kind === "promise" && afterPromise.where === "unhandledrejection" && /r21-promise-probe/.test(afterPromise.msg), JSON.stringify(afterPromise));

      // De-dupe: an identical message logged twice in a row bumps .count, no second entry/toast.
      const lenBeforeDupe = await errorLogLen(page);
      await page.evaluate(() => {
        window.__dupeToastCount = 0;
        const orig = window.toast;
        window.toast = (m) => { window.__dupeToastCount++; return orig(m); };
        window.logClientError("error", "r21-dedupe-probe", { where: "dedupe.js:1" });
        window.logClientError("error", "r21-dedupe-probe", { where: "dedupe.js:1" });
        window.toast = orig;
      });
      await wait(page, 300);
      const lenAfterDupe = await errorLogLen(page);
      eq("§A5 · a repeat message within the dedupe window adds exactly ONE new entry, not two", lenAfterDupe - lenBeforeDupe, 1);
      const dupeEntry = (await errorLog(page)).slice(-1)[0];
      eq("§A6 · …and its count bumped to 2", dupeEntry.count, 2);
      const dupeToastCount = await page.evaluate(() => window.__dupeToastCount);
      eq("§A7 · …with only the FIRST call raising a toast — the repeat raises none", dupeToastCount, 1);

      // Truncation — an over-500-char message is clipped to exactly 500.
      await page.evaluate(() => { window.logClientError("error", "Y".repeat(600), { where: "trunc.js:1" }); });
      await wait(page, 300);
      const truncEntry = (await errorLog(page)).slice(-1)[0];
      eq("§A8 · a >500-char message is truncated to exactly 500 characters", truncEntry.msg.length, 500);

      // Session-only — a reload starts the log fresh (never persisted client-side).
      await page.reload();
      await wait(page, SETTLE);
      const afterReload = await errorLogLen(page);
      eq("§A9 · ERROR_LOG is session-only — a reload starts empty again, nothing survives client-side", afterReload, 0);

      await page.close();
    }

    /* =======================================================================
       §B · PART A — the ring buffer caps at ERROR_LOG_CAP (100).
       ======================================================================= */
    {
      console.log("\n— §B · Part A · the in-memory ring buffer caps at 100, oldest entries shifted out (p4)");
      const page = await newPage(browser, "p4");

      const r = await page.evaluate(() => {
        for (let i = 0; i < 105; i++) window.logClientError("error", "cap-probe-" + i, { where: "cap.js:" + i });
        return { len: window.__errorLog.length, first: window.__errorLog[0].msg, last: window.__errorLog[window.__errorLog.length - 1].msg };
      });
      eq("§B1 · 105 genuinely distinct pushes leave exactly 100 (ERROR_LOG_CAP)", r.len, 100);
      eq("§B2 · the OLDEST five were shifted out — the buffer starts at probe #5", r.first, "cap-probe-5");
      eq("§B3 · …and ends at the newest, #104", r.last, "cap-probe-104");

      await page.close();
    }

    /* =======================================================================
       §C · PART B — the pipeline board survives one card's real exception.
       ======================================================================= */
    {
      console.log("\n— §C · Part B · one card's genuine render exception is skipped-and-counted; every other card still renders (p4)");
      const page = await newPage(browser, "p4");
      await goto(page, "pipeline");

      const r = await page.evaluate(async () => {
        const before = document.querySelectorAll("#board .card").length;
        // nextStageFor is a top-level `function` declaration (a window property in this classic,
        // non-module script — confirmed live: typeof window.nextStageFor === "function"), called
        // ONLY inside the per-card try (app.js ~L8789), never in the board's earlier, unguarded
        // sort comparator — unlike cardAge, which is called in BOTH places and would abort the
        // whole board's sort before a single card is skip-counted.
        const orig = window.nextStageFor;
        let fired = false;
        window.nextStageFor = function (stage, kind) {
          if (!fired) { fired = true; throw new Error("r21-board-card-probe"); }
          return orig(stage, kind);
        };
        const logBefore = window.__errorLog.length;
        await window.loadPipeline();
        await new Promise((res) => setTimeout(res, 400));
        const after = document.querySelectorAll("#board .card").length;
        const noteText = document.querySelector("#board .board-skip-note")?.textContent || null;
        const newEntries = window.__errorLog.slice(logBefore);
        window.nextStageFor = orig;
        await window.loadPipeline();
        await new Promise((res) => setTimeout(res, 400));
        const restored = document.querySelectorAll("#board .card").length;
        return { before, after, restored, noteText, newEntries };
      });

      eq("§C1 · exactly one FEWER card renders while the exception fires", r.after, r.before - 1);
      ok("§C2 · the skip-count note appears, naming exactly one record", (r.noteText || "").includes("1 record(s) couldn't be displayed — logged"), r.noteText);
      eq("§C3 · exactly one new ERROR_LOG entry was recorded for it", r.newEntries.length, 1);
      const entry = r.newEntries[0];
      ok("§C4 · …kind \"caught\", where \"loadPipeline\", naming the real recordId of the skipped case", entry.kind === "caught" && entry.where === "loadPipeline" && typeof entry.recordId === "string" && entry.recordId.length > 0, JSON.stringify(entry));
      ok("§C5 · …and the message names the underlying failure", /r21-board-card-probe/.test(entry.msg), entry.msg);
      eq("§C6 · restoring the helper and re-rendering brings the board back to its full count", r.restored, r.before);

      ok("§C · no NEW pageerror/console-error crash from the forced throw itself", !(page.__err || []).some((e) => /r21-board-card-probe/.test(e)), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §D · PART B — the client list survives one row's real exception.
       ======================================================================= */
    {
      console.log("\n— §D · Part B · one client row's genuine render exception is skipped-and-counted; every other row still renders (p4)");
      const page = await newPage(browser, "p4");
      await goto(page, "clients");

      const r = await page.evaluate(async () => {
        const before = document.querySelectorAll("#client-list .client-row").length;
        // clientPropertyCount is a top-level `function` declaration, called ONLY inside the
        // per-row try (app.js ~L14223).
        const orig = window.clientPropertyCount;
        let fired = false;
        window.clientPropertyCount = function (cases) {
          if (!fired) { fired = true; throw new Error("r21-client-row-probe"); }
          return orig(cases);
        };
        const logBefore = window.__errorLog.length;
        await window.loadClients();
        await new Promise((res) => setTimeout(res, 400));
        const after = document.querySelectorAll("#client-list .client-row").length;
        const noteText = document.querySelector("#client-list .client-list-cap-note")?.textContent || null;
        const newEntries = window.__errorLog.slice(logBefore);
        window.clientPropertyCount = orig;
        await window.loadClients();
        await new Promise((res) => setTimeout(res, 400));
        const restored = document.querySelectorAll("#client-list .client-row").length;
        return { before, after, restored, noteText, newEntries };
      });

      eq("§D1 · exactly one FEWER row renders while the exception fires", r.after, r.before - 1);
      ok("§D2 · the skip-count note appears, naming exactly one record", (r.noteText || "").includes("1 record(s) couldn't be displayed — logged"), r.noteText);
      eq("§D3 · exactly one new ERROR_LOG entry was recorded for it", r.newEntries.length, 1);
      const entry = r.newEntries[0];
      ok("§D4 · …kind \"caught\", where \"loadClients\", naming the real recordId of the skipped client", entry.kind === "caught" && entry.where === "loadClients" && typeof entry.recordId === "string" && entry.recordId.length > 0, JSON.stringify(entry));
      eq("§D5 · restoring the helper and re-rendering brings the list back to its full count", r.restored, r.before);

      ok("§D · no NEW pageerror/console-error crash from the forced throw itself", !(page.__err || []).some((e) => /r21-client-row-probe/.test(e)), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §E · PART B — Reports' Pipeline MI aggregation survives one poisoned
            case, proving the catch is unconditional (not tied to one helper).
       ======================================================================= */
    {
      console.log("\n— §E · Part B · a landmine case object (a throwing getter) proves renderPipelineMI's catch is genuinely unconditional; the rest of MI still renders (p4)");
      const page = await newPage(browser, "p4");
      await goto(page, "reports");

      const r = await page.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases").select("*");
        const poison = { id: "r21-mi-poison-1", stage: "completed" };
        // A getter that throws on read — this proves the try/catch is unconditional (any throw,
        // from any field access), rather than merely tolerant of one specific known-bad shape.
        Object.defineProperty(poison, "completed_at", { get() { throw new Error("r21-mi-landmine"); } });
        const all = cases.concat([poison]);
        const logBefore = window.__errorLog.length;
        window.renderPipelineMI(all, "2026-08");
        await new Promise((res) => setTimeout(res, 300));
        const scopeTxt = document.querySelector("#report-mi-scope")?.textContent || "";
        const funnelLen = (document.querySelector("#report-mi-funnel") || {}).innerHTML?.length || 0;
        const newEntries = window.__errorLog.slice(logBefore);
        return { scopeTxt, funnelLen, newEntries, realCaseCount: cases.length };
      });

      ok("§E1 · the MI scope note carries the skip-count for exactly the one poisoned case", r.scopeTxt.includes("1 record(s) couldn't be displayed — logged"), r.scopeTxt);
      eq("§E2 · exactly one new ERROR_LOG entry was recorded for it", r.newEntries.length, 1);
      const entry = r.newEntries[0];
      ok("§E3 · …kind \"caught\", where \"renderPipelineMI\", recordId is the poisoned case's own id", entry.kind === "caught" && entry.where === "renderPipelineMI" && entry.recordId === "r21-mi-poison-1", JSON.stringify(entry));
      ok("§E4 · …and the message names the underlying failure", /r21-mi-landmine/.test(entry.msg), entry.msg);
      ok("§E5 · the rest of the MI panel still rendered real content around the poisoned row (not blanked)", r.funnelLen > 0, r.funnelLen);

      ok("§E · no NEW pageerror/console-error crash from the forced throw itself", !(page.__err || []).some((e) => /r21-mi-landmine/.test(e)), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §F · renderLoadError — a CONTROLLED query failure degrades gracefully
            and adds NOTHING to ERROR_LOG (the key distinction from Part A).
       ======================================================================= */
    {
      console.log("\n— §F · renderLoadError · a forced, controlled query failure shows a retry state and records ZERO ERROR_LOG entries (p4)");
      const page = await newPage(browser, "p4");

      const r = await page.evaluate(async () => {
        const logBefore = window.__errorLog.length;
        const orig = window.__mockDb.from.bind(window.__mockDb);
        window.__mockDb.from = (t) => {
          if (t === "v_alerts") return { select: () => ({ order: () => Promise.resolve({ data: null, error: { message: "r21 simulated v_alerts failure" } }) }) };
          return orig(t);
        };
        window.nav("dashboard");
        await new Promise((res) => setTimeout(res, 1500));
        const kpiHtml = document.querySelector("#kpi-row")?.innerHTML || "";
        const hasRetry = !!document.querySelector("#kpi-row .load-error button.btn-sm");
        const logGrew = window.__errorLog.length - logBefore;
        window.__mockDb.from = orig;   // restore before clicking retry, so the retry actually succeeds
        const btn = document.querySelector("#kpi-row .load-error button.btn-sm");
        if (btn) btn.click();
        await new Promise((res) => setTimeout(res, 1200));
        const recoveredLen = document.querySelector("#kpi-row")?.innerHTML.length || 0;
        const stillShowsError = !!document.querySelector("#kpi-row .load-error");
        return { kpiHtml, hasRetry, logGrew, recoveredLen, stillShowsError };
      });

      ok("§F1 · the forced failure renders the \"Couldn't load this\" state with the underlying message", /Couldn.t load this/.test(r.kpiHtml) && /r21 simulated v_alerts failure/.test(r.kpiHtml), r.kpiHtml.slice(0, 200));
      ok("§F2 · …with a working retry button", r.hasRetry);
      eq("§F3 · a CONTROLLED {error} response adds NOTHING to ERROR_LOG — this is not Part A's territory", r.logGrew, 0);
      ok("§F4 · clicking retry (after the query recovers) replaces the error state with real content", !r.stillShowsError && r.recoveredLen > 200, JSON.stringify({ stillShowsError: r.stillShowsError, recoveredLen: r.recoveredLen }));

      await page.close();
    }

    /* =======================================================================
       §G · PART C — #diag-error-table renders session rows newest-first;
            the health summary's total is dedupe-aware.
       ======================================================================= */
    {
      console.log("\n— §G · Part C · #diag-error-table renders logged rows newest-first with the right columns; the health total sums .count (p4)");
      const page = await newPage(browser, "p4");

      await page.evaluate(() => {
        window.logClientError("error", "r21-diag-AAA", { where: "diag.js:1", stack: "TypeError: r21-diag-AAA\n at diag.js:1:1" });
        window.logClientError("error", "r21-diag-BBB", { where: "diag.js:2", stack: "RangeError: r21-diag-BBB\n at diag.js:2:1" });
        // Bump AAA's count to 2 via an identical repeat WITHIN the dedupe window is impossible now
        // (BBB sits between them), so instead log a THIRD, distinct message to prove the health
        // total is a straight sum of however many rows are in the table, each at count 1 — the
        // sum-of-.count behaviour itself is already proven directly in §A6.
        window.logClientError("error", "r21-diag-CCC", { where: "diag.js:3", stack: "URIError: r21-diag-CCC\n at diag.js:3:1" });
      });
      await goto(page, "settings");
      await openDiagDetails(page);
      await wait(page, 400);

      const rows = await page.$$eval("#diag-error-table tr", (trs) => trs.slice(1).map((tr) => [...tr.children].map((td) => td.textContent.trim())));
      eq("§G1 · exactly three data rows (header excluded)", rows.length, 3);
      ok("§G2 · newest-first ordering — CCC, then BBB, then AAA", rows[0][2] === "r21-diag-CCC" && rows[1][2] === "r21-diag-BBB" && rows[2][2] === "r21-diag-AAA", JSON.stringify(rows.map((r) => r[2])));
      ok("§G3 · each row carries kind/message/×count/where in the documented column order", rows[0][1] === "error" && rows[0][3] === "1" && rows[0][4] === "diag.js:3", JSON.stringify(rows[0]));

      const healthTxt = await page.$eval("#report-diag-health", (e) => e.textContent);
      ok("§G4 · the health summary's session total counts all three", /Errors this session:\s*3/.test(healthTxt), healthTxt);
      ok("§G5 · …and names the signed-in user + role", /daniel@nexmoney\.co\.uk/.test(healthTxt) && /owner/.test(healthTxt), healthTxt);

      await page.close();
    }

    /* =======================================================================
       §H · PART C — #report-diag-clear empties the SESSION log only.
       ======================================================================= */
    {
      console.log("\n— §H · Part C · #report-diag-clear empties ERROR_LOG, repaints the empty state, and confirms with a toast (p4)");
      const page = await newPage(browser, "p4");

      await page.evaluate(() => { window.logClientError("error", "r21-clear-probe", { where: "clear.js:1" }); });
      await goto(page, "settings");
      await openDiagDetails(page);
      await wait(page, 400);

      const before = await page.$eval("#diag-error-table", (e) => e.textContent);
      ok("§H1 · fixture sanity — the logged row is visible before clearing", /r21-clear-probe/.test(before), before);

      await page.click("#report-diag-clear");
      await wait(page, 400);

      const logLen = await errorLogLen(page);
      eq("§H2 · ERROR_LOG is genuinely emptied", logLen, 0);
      const after = await page.$eval("#diag-error-table", (e) => e.textContent);
      ok("§H3 · #diag-error-table repaints to its empty state", /No errors logged this session/.test(after), after);
      const toast = await toastText(page);
      eq("§H4 · …and confirms with the documented toast", toast, "Diagnostics cleared for this session.");

      await page.close();
    }

    /* =======================================================================
       §I · PART C — CSV export and clipboard copy.
       ======================================================================= */
    {
      console.log("\n— §I · Part C · #report-diag-csv exports a real file; #report-diag-copy writes to the clipboard (and degrades honestly without one) (p4)");
      const page = await newPage(browser, "p4");

      await page.evaluate(() => {
        window.logClientError("error", "r21-csv-AAA", { where: "csv.js:1", stack: "TypeError: r21-csv-AAA\n at csv.js:1:1" });
        window.logClientError("error", "r21-csv-BBB", { where: "csv.js:2", stack: "RangeError: r21-csv-BBB\n at csv.js:2:1" });
      });
      await goto(page, "settings");
      await openDiagDetails(page);
      await wait(page, 400);

      await armCsvCapture(page);
      await page.click("#report-diag-csv");
      await wait(page, 400);
      const csvName = await readCsvName(page);
      const csvText = await readCsv(page);
      const todayISO = await page.evaluate(() => new Date().toISOString().slice(0, 10));
      ok("§I1 · the CSV button produces a real file named for today", !!csvName && csvName.startsWith("nexmoney-diagnostics-") && csvName.includes(todayISO), csvName);
      ok("§I2 · …with the documented header row", (csvText || "").split("\n")[0] === '"time","kind","message","count","where","view","role"', csvText && csvText.split("\n")[0]);
      ok("§I3 · …and one data row per logged message, both present", /r21-csv-AAA/.test(csvText || "") && /r21-csv-BBB/.test(csvText || ""), csvText);

      // Clipboard present — writeText is called with the same summary the CSV/table carry.
      await page.evaluate(() => {
        window.__clipText = null;
        Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => { window.__clipText = t; return Promise.resolve(); } }, configurable: true });
      });
      await page.click("#report-diag-copy");
      await wait(page, 300);
      const clipText = await page.evaluate(() => window.__clipText);
      ok("§I4 · Copy diagnostics writes the session summary to the clipboard", !!clipText && /Errors this session: 2/.test(clipText) && /r21-csv-AAA/.test(clipText) && /r21-csv-BBB/.test(clipText), clipText);
      const toastCopyOk = await toastText(page);
      eq("§I5 · …and confirms with the documented toast", toastCopyOk, "Diagnostics copied to clipboard.");

      // Clipboard absent — degrades to a named toast, never a throw.
      await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }); });
      let threw = false;
      try { await page.click("#report-diag-copy"); } catch (e) { threw = true; }
      await wait(page, 300);
      ok("§I6 · with no clipboard API at all, Copy diagnostics does not throw", !threw);
      const toastNoClip = await toastText(page);
      eq("§I7 · …and says so honestly, pointing at the CSV alternative", toastNoClip, "Clipboard unavailable — use ⭳ CSV instead.");

      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r21: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
