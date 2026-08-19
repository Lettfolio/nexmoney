#!/usr/bin/env node
/* =============================================================================
   tests/r30.js — acceptance tests for ROUND 30: a persisted, SANITISED
   client-error fingerprint (`error_events`) + a cross-session diagnostics
   view for owner/admin.

   What R30 added (admin/app.js `logClientError` ~L42 + `loadPersistedDiagnostics`
   ~L18661, admin/mock-supabase.js's `error_events` table + `errorEventsSupported`
   feature-gate + `window.__setErrorEventsSupported`):
     - On every genuinely-NEW in-memory ERROR_LOG entry (the de-dupe branch
       returns before this), logClientError fires a best-effort, fire-and-forget
       insert into `error_events` with EXACTLY FOUR columns: error_type (the JS
       error CLASS name parsed off detail.stack, or `kind`), location
       (detail.where, truncated), page (the base hash route, ids stripped),
       role (MY_ROLE). No message, no stack, no recordId, no email/name — ever.
     - `errorEventsOff` — once a 42P01/42501/PGRST205/PGRST106 comes back, the
       session stops trying (no console-error storms; in-memory logging is
       unaffected).
     - `loadPersistedDiagnostics()` reads `error_events`, aggregates by
       error_type|location|page → ×count + last-seen + roles, renders
       `#diag-persist-table` (owner/admin only, same gate as `#report-mi-section`),
       and wires `#report-diag-persist-clear` to delete all persisted rows.
       Any read failure (including the feature-gate 42P01) degrades to a plain
       "isn't enabled" note — never throws, never re-enters logClientError.

   §A — PRIVACY / SANITISATION (the round's whole point). As owner (p4), with
        `location.hash` set to `#case/ca001` right before the call, log one
        error whose message/stack contain an obviously-sensitive client name.
        Read the persisted row straight off `window.__mock.db.error_events`
        (the mock's live in-memory table, not a `select()`-projected copy) and
        prove: exactly one row; its keys are a SUBSET of
        {id,created_at,error_type,location,page,role} (no message/stack/name
        column exists AT ALL, by construction); error_type/location/page/role
        match the expected sanitised fingerprint; and — the crucial negative
        assertion — NO field's stringified value contains the secret client
        name, the original message text, or the case id "ca001".
   §B — DE-DUPE: two logClientError calls with the IDENTICAL message within
        the 5s window bump ERROR_LOG's single entry's `.count` rather than
        pushing a second in-memory row, and — because the persist call sits
        strictly after the de-dupe early-return — add exactly ONE row to
        `error_events`, not two.
   §C — PERSISTED VIEW (owner): two distinct errors sharing an error_type/
        location/page aggregate into one `#diag-persist-table` row showing
        ×2 and the role; `#report-diag-persist-clear` empties both the DOM
        table and the underlying `error_events` store.
   §D — FEATURE-GATE DEGRADE: `window.__setErrorEventsSupported(false)` then
        logClientError() — must not throw; `window.__errorLog` still grows;
        `error_events` stays empty; `#diag-persist-table` shows the "isn't
        enabled" note. Restored to `true` afterward.
   §E — AUDIENCE: `#report-diag-section` (and its persisted table) hidden for
        an adviser (p2); visible for both admin (p1) and owner (p4).
   §F — no NEW console errors anywhere above (checked per-section, same
        `page.__err` convention every other suite in this harness uses).

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r30.js
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
  await wait(page, ms == null ? 1000 : ms);
};
const noNewErr = (page, before) => (page.__err || []).length === before;

/* Raw, un-projected snapshot of the mock's in-memory error_events store — the same
   live-object handle `window.__mock.db.error_events` the harness's own r5-batch tests
   use for other tables (`window.__mock.db.<table>`), NOT a select()-shaped copy, so §A's
   "only these keys exist on the row" assertion is a fact about storage, not projection. */
const rawErrorEvents = (page) => page.evaluate(() => window.__mock.db.error_events);
const errorLog = (page) => page.evaluate(() => window.__errorLog);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       A · PRIVACY / SANITISATION — the round's whole point (owner, p4)
       ======================================================================= */
    {
      console.log("\n— A · persisted error_events row is fully sanitised (p4, owner)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const SECRET_MSG = "TypeError: Cannot read x of undefined";
      const SECRET_STACK = "TypeError: SECRET-CLIENT-NAME here\n at app.js:9:9";
      await page.evaluate(() => { location.hash = "#case/ca001"; });
      await page.evaluate(({ msg, stack }) => {
        window.logClientError("error", msg, { where: "app.js:9", stack });
      }, { msg: SECRET_MSG, stack: SECRET_STACK });
      await wait(page, 500);

      const rows = await rawErrorEvents(page);
      eq("A1 · exactly one persisted row", (rows || []).length, 1);
      const row = (rows || [])[0] || {};
      const ALLOWED_KEYS = ["id", "created_at", "error_type", "location", "page", "role"];
      const rowKeys = Object.keys(row);
      ok("A2 · row's keys are a subset of {id,created_at,error_type,location,page,role}",
        rowKeys.every((k) => ALLOWED_KEYS.indexOf(k) !== -1), JSON.stringify(rowKeys));
      eq("A3 · error_type is the parsed JS error class, not the message", row.error_type, "TypeError");
      eq("A4 · location is the code file:line only", row.location, "app.js:9");
      eq("A5 · page is the base hash route with the id stripped ('case', not 'case/ca001')", row.page, "case");
      eq("A6 · role is the acting persona's role ('owner')", row.role, "owner");

      // The crucial negative assertions — no client string reaches the table, anywhere on the row.
      const rowStr = JSON.stringify(row);
      ok("A7 · no field contains the secret client name", rowStr.indexOf("SECRET-CLIENT-NAME") === -1, rowStr);
      ok("A8 · no field contains the original error message text", rowStr.indexOf("Cannot read x of undefined") === -1, rowStr);
      ok("A9 · no field contains the case id ('ca001')", rowStr.indexOf("ca001") === -1, rowStr);
      ok("A10 · no field contains the raw stack trace's own line:col (':9:9', distinct from the sanitised 'app.js:9' location)", rowStr.indexOf(":9:9") === -1, rowStr);

      ok("A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B · DE-DUPE — identical message within 5s bumps count, inserts ONE row
       ======================================================================= */
    {
      console.log("\n— B · de-dupe: repeat message bumps count, does not double-insert");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const logBefore = await errorLog(page);
      eq("B0 · fresh page starts with an empty in-memory error log", logBefore.length, 0);
      const rowsBefore = await rawErrorEvents(page);
      eq("B0b · fresh page starts with an empty error_events store", rowsBefore.length, 0);

      const DUPE_MSG = "RangeError: dedupe probe xyz123";
      await page.evaluate((msg) => {
        window.logClientError("error", msg, { where: "dedupe.js:1", stack: "RangeError: dedupe probe xyz123\n at dedupe.js:1:1" });
        window.logClientError("error", msg, { where: "dedupe.js:1", stack: "RangeError: dedupe probe xyz123\n at dedupe.js:1:1" });
      }, DUPE_MSG);
      await wait(page, 500);

      const logAfter = await errorLog(page);
      eq("B1 · exactly ONE new in-memory entry (not two)", logAfter.length, 1);
      eq("B2 · that entry's count bumped to 2", logAfter[0].count, 2);

      const rowsAfter = await rawErrorEvents(page);
      eq("B3 · exactly ONE row inserted into error_events (de-dupe path added zero)", rowsAfter.length, 1);

      ok("B · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C · PERSISTED VIEW (owner) — aggregation, ×count, role, and Clear
       ======================================================================= */
    {
      console.log("\n— C · #diag-persist-table aggregates + Clear persisted empties DB + DOM (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      await page.evaluate(() => { location.hash = "#dashboard"; });
      // Two DISTINCT messages (so the in-memory de-dupe never fires — each is a genuinely new
      // ERROR_LOG entry and persists its own row) sharing the same error_type/location/page,
      // so the persisted table aggregates them into one ×2 row.
      await page.evaluate(() => {
        window.logClientError("error", "AAA first distinct message", { where: "api.js:5", stack: "RangeError: boom one\n at api.js:5:1" });
        window.logClientError("error", "BBB second distinct message", { where: "api.js:5", stack: "RangeError: boom two\n at api.js:5:1" });
      });
      await wait(page, 500);
      const rowsSeeded = await rawErrorEvents(page);
      eq("C0 · two distinct persisted rows seeded", rowsSeeded.length, 2);

      await goto(page, "reports", 1500);
      await wait(page, 500);

      const tblText = await page.$eval("#diag-persist-table", (e) => e.textContent);
      ok("C1 · #diag-persist-table shows a ×2 aggregated row", /2/.test(tblText) && /RangeError/.test(tblText), tblText);
      ok("C2 · #diag-persist-table shows the role ('owner')", /owner/.test(tblText), tblText);

      const clearBtn = await page.$("#report-diag-persist-clear");
      ok("C3 · #report-diag-persist-clear exists", !!clearBtn);
      await page.click("#report-diag-persist-clear");
      await wait(page, 500);

      const tblTextAfter = await page.$eval("#diag-persist-table", (e) => e.textContent);
      ok("C4 · #diag-persist-table no longer shows the RangeError row after Clear", !/RangeError/.test(tblTextAfter), tblTextAfter);
      const rowsAfterClear = await rawErrorEvents(page);
      eq("C5 · error_events store is emptied by Clear persisted", rowsAfterClear.length, 0);

      ok("C · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       D · FEATURE-GATE DEGRADE — __setErrorEventsSupported(false)
       ======================================================================= */
    {
      console.log("\n— D · feature-gate degrade: does not throw, session log still grows, DB stays empty");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      await page.evaluate(() => window.__setErrorEventsSupported(false));
      const logBefore = await errorLog(page);

      let threw = false;
      try {
        await page.evaluate(() => {
          window.logClientError("error", "Feature-gate probe message", { where: "gate.js:1", stack: "TypeError: gate probe\n at gate.js:1:1" });
        });
      } catch (e) { threw = true; }
      ok("D1 · logClientError does not throw when error_events is unsupported", !threw);
      await wait(page, 500);

      const logAfter = await errorLog(page);
      eq("D2 · in-memory ERROR_LOG still grew by one", logAfter.length - logBefore.length, 1);

      const rows = await rawErrorEvents(page);
      eq("D3 · error_events stayed empty (no insert attempted/succeeded)", rows.length, 0);

      await goto(page, "reports", 1500);
      await wait(page, 500);
      const tblText = await page.$eval("#diag-persist-table", (e) => e.textContent);
      ok("D4 · #diag-persist-table shows the \"isn't enabled\" note", /isn.t\s+enabled/i.test(tblText), tblText);

      await page.evaluate(() => window.__setErrorEventsSupported(true));   // restore, so it doesn't leak into other tests sharing a browser
      ok("D · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       E · AUDIENCE — hidden for adviser, visible for admin + owner
       ======================================================================= */
    {
      console.log("\n— E · #report-diag-section hidden for adviser (p2), visible for admin (p1) + owner (p4)");
      const pageAdv = await newPage(browser, "p2");
      const errBeforeAdv = (pageAdv.__err || []).length;
      await goto(pageAdv, "reports", 1500);
      const advHidden = await pageAdv.$eval("#report-diag-section", (e) => e.classList.contains("hidden"));
      ok("E1 · adviser (p2): #report-diag-section IS hidden", advHidden);
      ok("E · no console errors (p2)", noNewErr(pageAdv, errBeforeAdv), JSON.stringify(pageAdv.__err));
      await pageAdv.close();

      const pageAdmin = await newPage(browser, "p1");
      const errBeforeAdmin = (pageAdmin.__err || []).length;
      await goto(pageAdmin, "reports", 1500);
      const adminHidden = await pageAdmin.$eval("#report-diag-section", (e) => e.classList.contains("hidden"));
      ok("E2 · admin (p1): #report-diag-section is NOT hidden", !adminHidden);
      const adminPersistTbl = await pageAdmin.$("#diag-persist-table");
      ok("E3 · admin (p1): #diag-persist-table exists", !!adminPersistTbl);
      ok("E · no console errors (p1)", noNewErr(pageAdmin, errBeforeAdmin), JSON.stringify(pageAdmin.__err));
      await pageAdmin.close();

      const pageOwner = await newPage(browser, "p4");
      const errBeforeOwner = (pageOwner.__err || []).length;
      await goto(pageOwner, "reports", 1500);
      const ownerHidden = await pageOwner.$eval("#report-diag-section", (e) => e.classList.contains("hidden"));
      ok("E4 · owner (p4): #report-diag-section is NOT hidden", !ownerHidden);
      const ownerPersistTbl = await pageOwner.$("#diag-persist-table");
      ok("E5 · owner (p4): #diag-persist-table exists", !!ownerPersistTbl);
      ok("E · no console errors (p4)", noNewErr(pageOwner, errBeforeOwner), JSON.stringify(pageOwner.__err));
      await pageOwner.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r30: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
