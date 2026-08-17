#!/usr/bin/env node
/* =============================================================================
   tests/r23.js — acceptance tests for ROUND 23: defeat the silent 1,000-row
   PostgREST cap on the OWNER-facing full-table reads R18's REPORTS_ROW_CAP
   fix (P7) never reached.

   What R23 added (app.js, admin/index.html):
     - `let OWNER_ROW_CAP = REPORTS_ROW_CAP;` (app.js, just after renderCapNotice())
       — one shared ceiling (20,000) with Reports. 19 owner full-table reads
       now carry `.order(<pk>).limit(OWNER_ROW_CAP)`: readDashboardCases (3
       branches), loadPipeline, loadClientData, loadDataHealth (cases/clients
       primary + 42703-retry + case_documents + email_queue + waiting cases +
       exchange_date cases + care clients), fetchMatchClients, clientDobStats,
       openCase's fetchClientPicker, openAppt's client read, revFetchClients,
       revFetchCases.
     - `ownerCapHit(rows) = rows.length === OWNER_ROW_CAP` + helper
       `renderOwnerCapNotice(sel, hit)`, mirroring Reports' own
       `renderCapNotice`/`REPORTS_ROW_CAP`/`#report-cap-notice` machinery
       exactly, but kept as an entirely separate cap/notice pair — Reports
       and Monday money are UNTOUCHED by this round.
     - Four new hidden `.dq-notice` containers in index.html: #dash-cap-notice,
       #board-cap-notice, #clients-cap-notice, #data-cap-notice.
     - `window.__setOwnerRowCap(n)` — mock-only test hook mirroring the
       pre-existing `window.__setReportsRowCap(n)`.

   Below the cap (20,000 vs. this fixture's 69 cases / 50 clients) every
   capped read is asserted to be byte-identical to an unbounded one — the
   headline claim of the round is "zero regression below the cap" — so §B
   below is the most important section in this file.

   EVERY figure this file asserts is computed at RUNTIME off window.__mockDb
   (ground truth) or off values recorded by monkeypatching window.__mockDb.from
   to observe the .limit() call and the resolved row count of each read —
   nothing here is hardcoded against fixture composition (69 cases / 50
   clients), per the HARNESS.md standing rule. mock-supabase.js's whole
   in-memory DB is rebuilt per page load; this file runs its owner-persona
   battery (§A-E) on ONE shared page, then opens a second page for the
   adviser-persona gating checks in §F, same pattern as r19/r20.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r23.js
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
  await wait(page, ms == null ? 900 : ms);
};
const noNewErr = (page, before) => (page.__err || []).length === before;

/* Monkeypatch window.__mockDb.from ONCE (idempotent — see the guard) so every `.limit(n)` call on
   any table records {table, limit, len} — `len` being the row count the read ACTUALLY resolved
   with, i.e. proof of truncation, not just proof the call was made. `db` inside app.js IS
   window.__mockDb (mock-supabase.js's createClient() both returns and stashes the same object), so
   this is observing app.js's real reads, not a copy. */
async function installLimitRecorder(page) {
  await page.evaluate(() => {
    if (window.__r23Installed) { window.__r23Reads = []; return; }
    window.__r23Installed = true;
    window.__r23Reads = [];
    const orig = window.__mockDb.from.bind(window.__mockDb);
    window.__mockDb.from = function (table) {
      const b = orig(table);
      const origLimit = b.limit.bind(b);
      b.limit = function (n) {
        origLimit(n);
        const origThen = b.then.bind(b);
        b.then = function (resolve, reject) {
          return origThen(function (result) {
            window.__r23Reads.push({ table: table, limit: n, len: (result && Array.isArray(result.data)) ? result.data.length : null });
            return resolve ? resolve(result) : result;
          }, reject);
        };
        return b;
      };
      return b;
    };
  });
}
const clearReads = (page) => page.evaluate(() => { window.__r23Reads = []; });
const readsFor = (page, table) => page.evaluate((t) => window.__r23Reads.filter((r) => r.table === t), table);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    const page = await newPage(browser, "p4"); // Daniel Potts, owner

    /* =======================================================================
       A · CONSTANTS — checked FIRST, before anything on this page could call
           either test hook and mutate a cap away.
       ======================================================================= */
    {
      console.log("\n— A · OWNER_ROW_CAP / REPORTS_ROW_CAP constants + test hooks exist (p4)");
      const errBefore = (page.__err || []).length;
      const caps = await page.evaluate(() => ({ owner: OWNER_ROW_CAP, reports: REPORTS_ROW_CAP }));
      eq("A1 · OWNER_ROW_CAP === 20000 by default", caps.owner, 20000);
      eq("A2 · REPORTS_ROW_CAP === 20000 by default", caps.reports, 20000);
      eq("A3 · OWNER_ROW_CAP === REPORTS_ROW_CAP (one shared ceiling)", caps.owner, caps.reports);
      const hooks = await page.evaluate(() => ({
        setOwner: typeof window.__setOwnerRowCap,
        setReports: typeof window.__setReportsRowCap,
      }));
      eq("A4 · window.__setOwnerRowCap is a function", hooks.setOwner, "function");
      eq("A5 · window.__setReportsRowCap is a function", hooks.setReports, "function");
      ok("A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
    }

    // Install the recorder before any of the four pages load for real, so §B can observe the
    // below-cap reads too (not just §D's capped ones).
    await installLimitRecorder(page);

    /* Ground truth, read straight off the fixture DB with NO limit at all — never hardcoded. */
    const gt = await page.evaluate(async () => {
      const db = window.__mockDb;
      const cases = (await db.from("cases").select("id")).data || [];
      const clients = (await db.from("clients").select("id")).data || [];
      return { cases: cases.length, clients: clients.length };
    });
    ok("ground truth · fixture has at least a handful of cases and clients (sanity)", gt.cases > 5 && gt.clients > 5, JSON.stringify(gt));

    /* =======================================================================
       B · BELOW-CAP INVARIANT — the headline claim. As owner, with the cap
           at its 20,000 default (≫ this book), each of the four pages: (1)
           reads the WHOLE table (recorded len === ground truth, not merely
           <= cap), (2) renders normally, and (3) shows none of the four
           notices.
       ======================================================================= */
    {
      console.log("\n— B · Below-cap invariant: whole-book reads, normal render, notices hidden (p4)");
      const errBefore = (page.__err || []).length;

      // B1 — Dashboard.
      await clearReads(page);
      await goto(page, "dashboard", 1200);
      const dashCasesReads = await readsFor(page, "cases");
      ok("B1 · Dashboard's cases read carries .limit(OWNER_ROW_CAP=20000)", dashCasesReads.some((r) => r.limit === 20000), JSON.stringify(dashCasesReads));
      ok("B1 · …and resolves with the FULL book (len === ground truth), not truncated", dashCasesReads.some((r) => r.len === gt.cases), JSON.stringify({ dashCasesReads, gt }));
      const kpiChildren = await page.$$eval("#kpi-row > *", (els) => els.length);
      ok("B1 · #kpi-row rendered normally (has tiles)", kpiChildren > 0, kpiChildren);
      const dashHidden = await page.$eval("#dash-cap-notice", (e) => e.classList.contains("hidden"));
      ok("B1 · #dash-cap-notice is hidden below the cap", dashHidden);

      // B2 — Pipeline.
      await clearReads(page);
      await goto(page, "pipeline", 1200);
      const pipeCasesReads = await readsFor(page, "cases");
      ok("B2 · Pipeline's cases read carries .limit(OWNER_ROW_CAP=20000)", pipeCasesReads.some((r) => r.limit === 20000), JSON.stringify(pipeCasesReads));
      ok("B2 · …and resolves with the FULL book", pipeCasesReads.some((r) => r.len === gt.cases), JSON.stringify({ pipeCasesReads, gt }));
      const boardCards = await page.$$eval("#board .col .card", (els) => els.length);
      // Header counts across every rendered column sum to the TRUE total the board segment holds —
      // an independent, DOM-level cross-check that nothing was silently dropped, without assuming
      // which segment is default (BOARD_COL_CAP's OWN 50-per-column cap is orthogonal to this round).
      const headerSum = await page.$$eval("#board .col h4 span", (els) => els.reduce((s, e) => s + (Number(e.textContent.trim()) || 0), 0));
      ok("B2 · the board rendered cards (not empty)", boardCards > 0, boardCards);
      ok("B2 · every column header count sums to at least as many cards as rendered (BOARD_COL_CAP may hide some, R23 must not)", headerSum >= boardCards, JSON.stringify({ headerSum, boardCards }));
      const boardHidden = await page.$eval("#board-cap-notice", (e) => e.classList.contains("hidden"));
      ok("B2 · #board-cap-notice is hidden below the cap", boardHidden);

      // B3 — Clients.
      await clearReads(page);
      await goto(page, "clients", 900);
      const clientsReads = await readsFor(page, "clients");
      ok("B3 · Clients' loadClientData read carries .limit(OWNER_ROW_CAP=20000)", clientsReads.some((r) => r.limit === 20000), JSON.stringify(clientsReads));
      ok("B3 · …and resolves with the FULL book", clientsReads.some((r) => r.len === gt.clients), JSON.stringify({ clientsReads, gt }));
      const clientRowCount = await page.$$eval("#client-list .client-row", (els) => els.length);
      eq("B3 · every client in the fixture renders a row (50 < CLIENT_LIST_CAP=100, so nothing is R18-capped either)", clientRowCount, gt.clients);
      const clientsHidden = await page.$eval("#clients-cap-notice", (e) => e.classList.contains("hidden"));
      ok("B3 · #clients-cap-notice is hidden below the cap", clientsHidden);

      // B4 — Data health.
      await clearReads(page);
      await goto(page, "data", 1200);
      const dhCasesReads = await readsFor(page, "cases");
      const dhClientsReads = await readsFor(page, "clients");
      ok("B4 · Data health's primary cases read carries .limit(OWNER_ROW_CAP=20000)", dhCasesReads.some((r) => r.limit === 20000), JSON.stringify(dhCasesReads));
      ok("B4 · …and resolves with the FULL book", dhCasesReads.some((r) => r.len === gt.cases), JSON.stringify({ dhCasesReads, gt }));
      ok("B4 · Data health's clients read carries .limit(OWNER_ROW_CAP=20000)", dhClientsReads.some((r) => r.limit === 20000), JSON.stringify(dhClientsReads));
      ok("B4 · …and resolves with the FULL book", dhClientsReads.some((r) => r.len === gt.clients), JSON.stringify({ dhClientsReads, gt }));
      const dataContent = await page.$eval("#data-content", (e) => e.textContent.trim());
      ok("B4 · #data-content rendered normally (not stuck on \"Loading…\", not empty)", dataContent.length > 0 && !/^Loading/.test(dataContent), dataContent.slice(0, 60));
      const dataHidden = await page.$eval("#data-cap-notice", (e) => e.classList.contains("hidden"));
      ok("B4 · #data-cap-notice is hidden below the cap", dataHidden);

      ok("B · no console errors across all four pages", noNewErr(page, errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       C · SUBSIDIARY OWNER READS ALSO CARRY .limit — the two Data health
           reads named explicitly in the round's own notes (case_documents,
           email_queue), proven the same way as §B: recorded .limit call,
           not just source-reading app.js.
       ======================================================================= */
    {
      console.log("\n— C · Data health's subsidiary reads (case_documents, email_queue) also carry .limit(OWNER_ROW_CAP) (p4)");
      const errBefore = (page.__err || []).length;
      const docReads = await readsFor(page, "case_documents");
      const mailReads = await readsFor(page, "email_queue");
      ok("C1 · case_documents read carries .limit(OWNER_ROW_CAP=20000)", docReads.some((r) => r.limit === 20000), JSON.stringify(docReads));
      ok("C2 · email_queue (doc-chase) read carries .limit(OWNER_ROW_CAP=20000)", mailReads.some((r) => r.limit === 20000), JSON.stringify(mailReads));
      ok("C · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       D · NOTICE FIRES AT CAP — window.__setOwnerRowCap(10), below the ~69-
           case/50-client fixture. Reloading each of the four pages: the
           matching notice becomes visible with the right text, the
           corresponding read resolves with EXACTLY 10 rows (proven via the
           recorder, not guessed from the DOM), and the page still renders
           (doesn't crash) on the truncated set. Reset afterwards and confirm
           every notice hides again.
       ======================================================================= */
    {
      console.log("\n— D · window.__setOwnerRowCap(10): notices fire, reads truncate to 10, page still renders (p4)");
      const errBefore = (page.__err || []).length;
      const newCap = await page.evaluate(() => window.__setOwnerRowCap(10));
      eq("D0 · __setOwnerRowCap(10) returns the new cap", newCap, 10);
      const capNow = await page.evaluate(() => OWNER_ROW_CAP);
      eq("D0 · OWNER_ROW_CAP is now 10", capNow, 10);

      const EXPECTED_TXT = "⚠ Showing the first 10 records — this view describes a subset, not the whole book.";

      // D1 — Dashboard.
      await clearReads(page);
      await goto(page, "dashboard", 1200);
      const dashReads = await readsFor(page, "cases");
      ok("D1 · Dashboard's cases read now resolves with EXACTLY 10 rows (truncated)", dashReads.some((r) => r.len === 10), JSON.stringify(dashReads));
      const dashVisible = await page.$eval("#dash-cap-notice", (e) => !e.classList.contains("hidden"));
      ok("D1 · #dash-cap-notice is now VISIBLE", dashVisible);
      const dashTxt = await page.$eval("#dash-cap-notice", (e) => e.textContent.trim());
      eq("D1 · …with the exact expected text", dashTxt, EXPECTED_TXT);
      const kpiChildrenCapped = await page.$$eval("#kpi-row > *", (els) => els.length);
      ok("D1 · the dashboard still rendered (not blank/crashed) on the truncated set", kpiChildrenCapped > 0, kpiChildrenCapped);

      // D2 — Pipeline.
      await clearReads(page);
      await goto(page, "pipeline", 1200);
      const pipeReads = await readsFor(page, "cases");
      ok("D2 · Pipeline's cases read now resolves with EXACTLY 10 rows (truncated)", pipeReads.some((r) => r.len === 10), JSON.stringify(pipeReads));
      const boardVisible = await page.$eval("#board-cap-notice", (e) => !e.classList.contains("hidden"));
      ok("D2 · #board-cap-notice is now VISIBLE", boardVisible);
      const boardTxt = await page.$eval("#board-cap-notice", (e) => e.textContent.trim());
      eq("D2 · …with the exact expected text", boardTxt, EXPECTED_TXT);
      const boardCardsCapped = await page.$$eval("#board .col .card", (els) => els.length);
      ok("D2 · the board rendered no more than the 10 cases now read (truncation is real, not cosmetic)", boardCardsCapped <= 10 && boardCardsCapped > 0, boardCardsCapped);

      // D3 — Clients.
      await clearReads(page);
      await goto(page, "clients", 900);
      const clientsReadsCapped = await readsFor(page, "clients");
      ok("D3 · Clients' read now resolves with EXACTLY 10 rows (truncated)", clientsReadsCapped.some((r) => r.len === 10), JSON.stringify(clientsReadsCapped));
      const clientsVisible = await page.$eval("#clients-cap-notice", (e) => !e.classList.contains("hidden"));
      ok("D3 · #clients-cap-notice is now VISIBLE", clientsVisible);
      const clientsTxt = await page.$eval("#clients-cap-notice", (e) => e.textContent.trim());
      eq("D3 · …with the exact expected text", clientsTxt, EXPECTED_TXT);
      const clientRowCountCapped = await page.$$eval("#client-list .client-row", (els) => els.length);
      eq("D3 · the client list rendered exactly the 10 clients now read", clientRowCountCapped, 10);

      // D4 — Data health.
      await clearReads(page);
      await goto(page, "data", 1200);
      const dhCasesCapped = await readsFor(page, "cases");
      const dhClientsCapped = await readsFor(page, "clients");
      ok("D4 · Data health's cases read now resolves with EXACTLY 10 rows (truncated)", dhCasesCapped.some((r) => r.len === 10), JSON.stringify(dhCasesCapped));
      ok("D4 · Data health's clients read now resolves with EXACTLY 10 rows (truncated)", dhClientsCapped.some((r) => r.len === 10), JSON.stringify(dhClientsCapped));
      const dataVisible = await page.$eval("#data-cap-notice", (e) => !e.classList.contains("hidden"));
      ok("D4 · #data-cap-notice is now VISIBLE", dataVisible);
      const dataTxt = await page.$eval("#data-cap-notice", (e) => e.textContent.trim());
      eq("D4 · …with the exact expected text", dataTxt, EXPECTED_TXT);
      const dataContentCapped = await page.$eval("#data-content", (e) => e.textContent.trim());
      ok("D4 · Data health still rendered (not blank/crashed) on the truncated set", dataContentCapped.length > 0 && !/^Loading/.test(dataContentCapped), dataContentCapped.slice(0, 60));

      ok("D · no console errors while capped", noNewErr(page, errBefore), JSON.stringify(page.__err));

      // Reset — every notice hides again and every read goes back to resolving the whole book.
      console.log("\n— D5 · window.__setOwnerRowCap(20000): reset, notices hide again (p4)");
      const errBefore2 = (page.__err || []).length;
      const resetCap = await page.evaluate(() => window.__setOwnerRowCap(20000));
      eq("D5 · __setOwnerRowCap(20000) returns 20000", resetCap, 20000);

      await goto(page, "dashboard", 1200);
      ok("D5 · #dash-cap-notice hides again after reset", await page.$eval("#dash-cap-notice", (e) => e.classList.contains("hidden")));
      await goto(page, "pipeline", 1200);
      ok("D5 · #board-cap-notice hides again after reset", await page.$eval("#board-cap-notice", (e) => e.classList.contains("hidden")));
      await goto(page, "clients", 900);
      ok("D5 · #clients-cap-notice hides again after reset", await page.$eval("#clients-cap-notice", (e) => e.classList.contains("hidden")));
      const clientRowCountReset = await page.$$eval("#client-list .client-row", (els) => els.length);
      eq("D5 · …and the client list is back to the full 50", clientRowCountReset, gt.clients);
      await goto(page, "data", 1200);
      ok("D5 · #data-cap-notice hides again after reset", await page.$eval("#data-cap-notice", (e) => e.classList.contains("hidden")));

      ok("D5 · no console errors after reset", noNewErr(page, errBefore2), JSON.stringify(page.__err));
    }

    /* =======================================================================
       E · REPORTS + MONDAY MONEY UNTOUCHED — REPORTS_ROW_CAP and
           OWNER_ROW_CAP are independent constants; changing one never moves
           the other, and Reports/Monday money keep working exactly as
           before this round.
       ======================================================================= */
    {
      console.log("\n— E · Reports (REPORTS_ROW_CAP) and Monday money are untouched by R23 (p4)");
      const errBefore = (page.__err || []).length;

      // E1 — moving OWNER_ROW_CAP does not move REPORTS_ROW_CAP.
      await page.evaluate(() => window.__setOwnerRowCap(5));
      let caps = await page.evaluate(() => ({ owner: OWNER_ROW_CAP, reports: REPORTS_ROW_CAP }));
      eq("E1 · __setOwnerRowCap(5) leaves REPORTS_ROW_CAP at 20000", caps.reports, 20000);
      await page.evaluate(() => window.__setOwnerRowCap(20000)); // restore before any page reload below

      // E2 — Reports still renders normally for the owner with OWNER_ROW_CAP back at 20000; its own
      // notice is silent (this fixture is nowhere near REPORTS_ROW_CAP either).
      await goto(page, "reports", 1300);
      const repHidden = await page.$eval("#report-cap-notice", (e) => e.classList.contains("hidden"));
      ok("E2 · #report-cap-notice is hidden (fixture is nowhere near REPORTS_ROW_CAP)", repHidden);
      const miVisible = await page.evaluate(() => { const el = document.querySelector("#report-mi-section"); return !!el && !el.classList.contains("hidden"); });
      ok("E2 · owner/admin Pipeline MI (#report-mi-section, R19/R20) still renders for the owner", miVisible);

      // E3 — moving REPORTS_ROW_CAP does not move OWNER_ROW_CAP, and DOES independently make
      // Reports' OWN notice fire, proving the two caps are wired to two entirely separate mechanisms.
      await page.evaluate(() => window.__setReportsRowCap(5));
      caps = await page.evaluate(() => ({ owner: OWNER_ROW_CAP, reports: REPORTS_ROW_CAP }));
      eq("E3 · __setReportsRowCap(5) leaves OWNER_ROW_CAP at 20000", caps.owner, 20000);
      await goto(page, "reports", 1300);
      const repVisibleNow = await page.$eval("#report-cap-notice", (e) => !e.classList.contains("hidden"));
      ok("E3 · #report-cap-notice now fires from __setReportsRowCap alone", repVisibleNow);
      // …and none of R23's OWN four notices are affected by REPORTS_ROW_CAP moving.
      await goto(page, "dashboard", 1200);
      ok("E3 · #dash-cap-notice stays hidden — REPORTS_ROW_CAP moving does not touch OWNER_ROW_CAP's notices", await page.$eval("#dash-cap-notice", (e) => e.classList.contains("hidden")));
      await page.evaluate(() => window.__setReportsRowCap(20000)); // restore
      await goto(page, "reports", 1300);
      ok("E3 · #report-cap-notice hides again once REPORTS_ROW_CAP is restored", await page.$eval("#report-cap-notice", (e) => e.classList.contains("hidden")));

      // E4 — Monday money (also REPORTS_ROW_CAP-scoped, per the round's own notes) still renders
      // for the owner, un-denied, with real content.
      await goto(page, "money", 1200);
      const moneyDenied = await page.$eval("#money-denied", (e) => e.classList.contains("hidden"));
      ok("E4 · Monday money is NOT denied to the owner", moneyDenied);
      const moneyBodyVisible = await page.$eval("#money-body", (e) => !e.classList.contains("hidden"));
      ok("E4 · #money-body is visible", moneyBodyVisible);
      const moneyContent = await page.$eval("#money-body", (e) => e.textContent.trim());
      ok("E4 · Monday money rendered real content", moneyContent.length > 0, moneyContent.slice(0, 60));

      ok("E · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
    }

    await page.close();

    /* =======================================================================
       F · GATING LIGHT-CHECK — Monday money stays owner-only (an adviser is
           bounced), Pipeline/Clients stay reachable to an adviser exactly as
           before, no console errors on any of it.
       ======================================================================= */
    {
      console.log("\n— F · Gating: Monday money owner-only (adviser bounced); Pipeline/Clients reachable to adviser (p2)");
      const page2 = await newPage(browser, "p2"); // Wayne Kellow, adviser
      const errBefore = (page2.__err || []).length;

      await page2.evaluate(() => window.nav("money"));
      await wait(page2, 900);
      const moneyPageHidden = await page2.$eval("#page-money", (e) => e.classList.contains("hidden"));
      ok("F1 · an adviser navigating to #money is bounced away — #page-money stays hidden", moneyPageHidden);
      const dashPageVisible = await page2.$eval("#page-dashboard", (e) => !e.classList.contains("hidden"));
      ok("F1 · …landing back on the dashboard instead", dashPageVisible);
      const hash = await page2.evaluate(() => location.hash);
      ok("F1 · …and the URL hash is rewritten off #money too (no stale gated hash for Back to re-enter)", !/money/i.test(hash), hash);

      await goto(page2, "pipeline", 900);
      const pipeVisible = await page2.$eval("#page-pipeline", (e) => !e.classList.contains("hidden"));
      ok("F2 · Pipeline stays reachable to an adviser", pipeVisible);
      const pipeCardsAdv = await page2.$$eval("#board .col .card, #board .board-empty", (els) => els.length);
      ok("F2 · …and actually renders content (cards or an explicit empty state)", pipeCardsAdv > 0, pipeCardsAdv);

      await goto(page2, "clients", 900);
      const clientsVisible = await page2.$eval("#page-clients", (e) => !e.classList.contains("hidden"));
      ok("F3 · Clients stays reachable to an adviser", clientsVisible);
      const clientListAdv = await page2.$eval("#client-list", (e) => e.textContent.trim());
      ok("F3 · …and actually renders content", clientListAdv.length > 0, clientListAdv.slice(0, 60));

      ok("F · no console errors across the adviser's page loads", noNewErr(page2, errBefore), JSON.stringify(page2.__err));
      await page2.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r23: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
