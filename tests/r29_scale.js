#!/usr/bin/env node
/* =============================================================================
   tests/r29_scale.js — ROUND 29: SCALE / VERIFICATION (+ same-round fix).

   Started as a pure VERIFICATION round (no admin/app.js change) to prove the
   back office stays correct, error-free and RENDER-BOUNDED at the scale the
   product is heading for — "~2,000+" is R23's own comment on OWNER_ROW_CAP
   ("2,000+ ≫ Daniel's book" is the sentence the R23 notes use). This suite
   seeds ~2,500 clients + ~2,500 cases directly into the mock's in-memory
   store — on top of the ~50/~69 the base fixture already carries — then
   drives every owner-facing page (plus a lighter adviser pass) and checks:
     (a) zero NEW console errors / window.__errorLog entries per page,
     (b) the page actually rendered (a stable selector, non-empty),
     (c) DOM render is bounded where app.js has a known cap — Clients
         (CLIENT_LIST_CAP=100), the board (BOARD_COL_CAP=50/column), the
         dashboard's rate/erc (15) and retention (12) panels, Monday money's
         rate-ends (top 5) and cold-quotes (top 10) lists, the (small,
         team-sized) adviser scoreboards on Reports/Money, and — since the
         fix below — Data health's own per-issue list panels (DH_PANEL_CAP=200),
     (d) the R23 OWNER_ROW_CAP notices (#dash-cap-notice / #board-cap-notice
         / #clients-cap-notice / #data-cap-notice) correctly stay HIDDEN at
         this scale — OWNER_ROW_CAP is 20,000 and this round's book is ~2,600,
         so "never fires for Daniel" (the R23 comment) is exactly what a
         hidden notice here proves — while CLIENT_LIST_CAP's own render-cap
         note (`.client-list-cap-note`, unrelated machinery) DOES fire,
     (e) KPI/MI numbers render as real numbers — no "NaN"/"undefined" — in
         every kpi-row, MI panel and money strip touched.

   §G FOUND a genuine gap this round, then verified the FIX for it, same
   round — see the comment above §G and the R29 notes in HARNESS.md for the
   full story. In short: Data health's per-issue list panels
   (#dh-unassigned-panel, #dh-nofee-panel, #dh-phone-panel,
   #dh-milestone-panel, #dh-deadbook-panel, etc.) originally rendered EVERY
   matching row with no cap and no "Showing N of M" note — #dh-deadbook-panel
   alone hit 1,021 rows at this suite's seed. admin/app.js now caps every one
   of those panels at `DH_PANEL_CAP = 200` with an overflow note
   ("…and N more not shown…") when the true count exceeds it. §G proves the
   FIX precisely: an independent ground-truth recompute off window.__mockDb
   is checked against the KPI tile's own (still un-sliced) number, the
   panel's now-capped row count, and the overflow note's presence/absence —
   with #dh-deadbook-panel pinned to exactly 200 rows + its note as the
   direct regression test.

   R45 · non-masking repair — R45 (admin/app.js ~24173) added a 180-day
   freshness guard to noMilestoneDate: a COMPLETED case whose completed_at
   is more than 180 days old is now excluded outright. §G's `gt.noMilestone`
   recompute reimplemented the pre-R45 predicate and, at this suite's ~2,500-
   case scale seed, genuinely disagreed with the app's honest post-R45 count
   (expected 207, got 195 — the fixture carries old completions this round
   correctly stopped flagging). The recompute now carries the identical
   guard (proven correct against app.js's own change in tests/r45.js §A7,
   independently) — nothing else in §G moved.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r29_scale.js
         (expects a static server on 8099; starts one itself if absent)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const N = 2500; // clients AND cases seeded, on top of the base fixture

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
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  page.on("dialog", (d) => d.accept().catch(() => {}));
  /* R69-HF1 — DELIBERATE CONTRACT CHANGE, and the whole reason this suite exists.
     admin/mock-supabase.js now enforces PostgREST's real `max-rows = 1000` server ceiling (see
     MOCK_MAX_ROWS there): a plain `.select()` returns at most 1,000 rows no matter what `.limit()`
     asked for, exactly as Supabase does in production. That is what silently truncated ~32 owner-
     facing reads for the whole live book, and this suite (2,500 clients + 2,500 cases) is the
     canary that proves it: with the ceiling in and app.js unpatched, it failed with truncated
     counts the way Daniel's browser does.
     app.js now pages every such read (readAll). This suite's OWN ground-truth reads — three
     `window.__mockDb.from(...).select(...)` calls that deliberately take no limit at all, so they
     can be an INDEPENDENT check on what the app computed — hit the very same ceiling and were
     returning 1,000 rows as "the truth". They page too now. Nothing about what they assert has
     changed; only how the rows are fetched. Deliberately hand-rolled here rather than calling
     app.js's readAll, so the check stays independent of the code under test. */
  await page.addInitScript(() => {
    window.__readAllRaw = async function (table, cols) {
      const PAGE = 1000, out = [];
      for (let from = 0; from < 500000; from += PAGE) {
        const res = await window.__mockDb.from(table).select(cols || "*").order("id").range(from, from + PAGE - 1);
        const rows = (res && res.data) || [];
        for (let i = 0; i < rows.length; i++) out.push(rows[i]);
        if (rows.length < PAGE) break;
      }
      return out;
    };
  });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(1500);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const noNewErr = (page, before) => (page.__err || []).length === before;
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1200 : ms);
};
/* Heavy pages (thousands of underlying rows behind a bounded or unbounded render) get a
   poll-until-stable wait instead of a fixed sleep — robust against this box being slower or
   faster than whatever ran this last, without inflating every other suite's fixed SETTLE. */
async function waitStable(page, sel, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 25000, interval = opts.interval || 300, stableFor = opts.stableFor || 700;
  const start = Date.now();
  let lastLen = -1, lastChange = Date.now();
  for (;;) {
    const len = await page.$eval(sel, (el) => el.innerHTML.length).catch(() => -1);
    if (len !== lastLen) { lastLen = len; lastChange = Date.now(); }
    if (Date.now() - lastChange >= stableFor && len > 0) return len;
    if (Date.now() - start > timeout) return lastLen;
    await wait(page, interval);
  }
}
const errLogLen = (page) => page.evaluate(() => (window.__errorLog ? window.__errorLog.length : -1));
const noNaN = (html) => !/NaN|undefined/.test(String(html || ""));
async function rowCount(page, sel) { return page.$$eval(sel, (els) => els.length).catch(() => -1); }
async function numText(page, sel) { return page.$$eval(sel, (els) => els.map((e) => (e.textContent || "").trim())).catch(() => []); }

/* =============================================================================
   THE SEED — bulk insert, one Builder.insert() array call each for clients
   and cases (two round trips total, not N), straight through window.__mockDb
   so applyInsertDefaults() (ids, created_at/updated_at, the M2/M7/M10/M11
   null-default columns, protection_status/fee_status defaults) runs exactly
   as it does for any other insert this harness makes — see r25.js/r27.js's
   insertCase for the same one-row version of this technique. Deliberately
   varied per the round's brief: all 8 stages, a real spread of assigned_to
   (including unassigned), a genuine mix of past/future rate_end_date and
   expected_completion_date, and clients/cases missing email/phone/
   submitted_at — so every page (and every Data health tile) has real volume
   to chew on, not a uniform/degenerate fixture that happens to render fast.
   ========================================================================== */
async function seedScale(page, n) {
  return page.evaluate(async (n) => {
    const db = window.__mockDb;
    const FIRST = ["James", "Sarah", "Michael", "Emma", "David", "Laura", "Robert", "Katie", "Daniel", "Sophie",
      "Thomas", "Hannah", "Andrew", "Chloe", "Paul", "Rebecca", "Mark", "Amy", "Simon", "Jessica",
      "Peter", "Olivia", "Richard", "Charlotte", "Steven", "Grace", "Ian", "Lucy", "Craig", "Rachel"];
    const LAST = ["Smith", "Jones", "Taylor", "Brown", "Williams", "Wilson", "Johnson", "Davies", "Robinson", "Wright",
      "Thompson", "Evans", "Walker", "White", "Roberts", "Green", "Hall", "Wood", "Jackson", "Clarke",
      "Turner", "Hill", "Baker", "Carter", "Cook", "Ward", "Cox", "Bell", "Morris", "Fisher"];
    const LENDERS = ["Halifax", "Nationwide", "Barclays", "HSBC", "NatWest", "Santander", "TSB", "Skipton",
      "Coventry BS", "Leeds BS", "Virgin Money", "The Mortgage Works", "Metro Bank", "Accord", "Precise Mortgages"];
    const ASSIGN = ["p1", "p2", "p3", "p4", null, "p2", "p3"]; // ~1/7 unassigned, rest spread across the team
    const KINDS_V = ["purchase", "remortgage", "product_transfer", "buy_to_let", "first_time_buyer", "other"];
    const LEAD_SOURCES = ["website", "referral", "introducer", "repeat_client", "other"];
    const PROT = ["not_discussed", "discussed", "quoted", "policy_taken", "declined"];

    // 100-slot weighted stage cycle: 72% live (spread across all 6 live stages), 18% completed, 10% not_proceeding.
    const STAGE_CYCLE = [];
    [["enquiry", 14], ["fact_find", 14], ["decision_in_principle", 10], ["application", 14],
      ["offer", 10], ["exchange", 10], ["completed", 18], ["not_proceeding", 10]]
      .forEach(([s, c]) => { for (let k = 0; k < c; k++) STAGE_CYCLE.push(s); });

    const now = Date.now(), DAY = 86400000;
    const dOff = (days) => new Date(now + days * DAY).toISOString().slice(0, 10);
    const PAST = [-900, -700, -500, -380, -300, -250, -200, -150, -120, -90, -60, -45, -30, -20, -10, -5];
    const FUTURE = [900, 700, 500, 380, 300,250, 200, 150, 120, 90, 60, 45, 30, 20, 10, 5];

    const clients = [];
    for (let i = 0; i < n; i++) {
      clients.push({
        first_name: FIRST[i % FIRST.length],
        last_name: LAST[Math.floor(i / FIRST.length) % LAST.length],
        email: (i % 11 === 0) ? null : `r29.scale.${i}@example.com`,   // ~1/11 missing an email
        phone: (i % 13 === 0) ? null : `07700${String(900000 + i).slice(-6)}`, // ~1/13 missing a phone, 11 digits when present
      });
    }
    const insClients = await db.from("clients").insert(clients).select("id");
    if (insClients.error) throw new Error("client insert failed: " + insClients.error.message);
    const clientIds = insClients.data.map((r) => r.id);
    if (clientIds.length !== n) throw new Error("client insert returned " + clientIds.length + " ids, expected " + n);

    const cases = [];
    for (let i = 0; i < n; i++) {
      const stage = STAGE_CYCLE[i % 100];
      const hasSubmitted = stage !== "enquiry" && !(i % 12 === 0);   // ~1/12 of non-enquiry cases missing submitted_at
      const submitted_at = hasSubmitted ? dOff(-(30 + (i % 600))) : null;
      const hasRateEnd = !(i % 9 === 0);
      const rate_end_date = hasRateEnd ? dOff(i % 2 === 0 ? PAST[i % PAST.length] : FUTURE[i % FUTURE.length]) : null;
      const hasExpComp = !(i % 8 === 0);
      const expPast = (i % 20) < 5; // 25% of those with a date are in the past
      const expected_completion_date = hasExpComp ? dOff(expPast ? PAST[(i + 3) % PAST.length] : FUTURE[(i + 3) % FUTURE.length]) : null;
      const stageRank = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange", "completed", "not_proceeding"].indexOf(stage);
      const loan = 80000 + (i % 60) * 5000;

      const row = {
        client_id: clientIds[i],
        stage,
        case_kind: KINDS_V[i % KINDS_V.length],
        lender: LENDERS[i % LENDERS.length],
        product_name: "2 Year Fixed",
        rate_type: (i % 3 === 0) ? "tracker" : "fixed",
        rate_percent: Number((2.5 + (i % 12) * 0.25).toFixed(2)),
        loan_amount: loan,
        property_value: Math.round(loan * (1.25 + (i % 10) * 0.02)),
        term_years: 15 + (i % 20),
        assigned_to: ASSIGN[i % ASSIGN.length],
        submitted_at,
        rate_end_date,
        rate_end_estimated: (i % 7 === 0),
        expected_completion_date,
        lead_source: LEAD_SOURCES[i % LEAD_SOURCES.length],
      };
      // offer_issued_date — set for most offer+ cases (a real book has it), ~1/10 missing on purpose
      // so Data health's "missing application/offer date" tile has real (not artificially maximal) volume.
      if (stageRank >= 4 && !(i % 10 === 0)) row.offer_issued_date = submitted_at ? dOff(-(10 + (i % 200))) : dOff(-(10 + (i % 200)));

      if (stage === "completed") {
        const thisMonth = (i % 4 === 0);
        const day = 1 + (i % 27);
        const compDate = thisMonth
          ? new Date(now).toISOString().slice(0, 7) + "-" + String(day).padStart(2, "0")
          : dOff(-(30 * (1 + (i % 20))));
        row.completed_at = (i % 40 === 0) ? null : compDate; // ~1/40 completed cases missing completed_at
        const noFee = (i % 15 === 0);                        // ~1/15 completed cases with no fee at all
        if (!noFee) {
          row.proc_fee = 250 + (i % 10) * 25;
          row.broker_fee = 400 + (i % 15) * 40;
          row.sols_fee = (i % 4 === 0) ? 0 : 150;
          row.fee_status = (i % 8 === 0) ? "requested" : "paid";
          if (!(i % 10 === 0) && row.completed_at) { // most paid dates line up with completion — a few (~1/10) don't
            row.proc_fee_paid_at = row.completed_at;
            row.broker_fee_paid_at = row.completed_at;
            row.sols_fee_paid_at = row.sols_fee ? row.completed_at : null;
          }
        } else {
          row.proc_fee = 0; row.broker_fee = 0; row.sols_fee = 0; row.fee_status = "not_requested";
        }
        row.protection_status = PROT[i % PROT.length];
      } else if (stage === "not_proceeding") {
        row.fee_status = "not_requested";
      } else {
        row.fee_status = (i % 6 === 0) ? "requested" : "not_requested";
        row.broker_fee = (i % 6 === 0) ? (300 + (i % 10) * 20) : 0;
      }
      cases.push(row);
    }
    const insCases = await db.from("cases").insert(cases).select("id");
    if (insCases.error) throw new Error("case insert failed: " + insCases.error.message);
    return { clientsInserted: clientIds.length, casesInserted: insCases.data.length };
  }, n);
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
       0 / SEED — owner (p4), one shared page for §A-§H (same pattern
       r23.js/r27.js use: the seed lives on this page's store for the rest of
       the file).
       ======================================================================= */
    console.log("\n— 0 · seed ~2,500 clients + ~2,500 cases directly via window.__mockDb (owner, p4)");
    const page = await newPage(browser, "p4");
    const errBefore0 = (page.__err || []).length;

    const before = await page.evaluate(() => window.__mock.counts());
    const seedResult = await seedScale(page, N);
    ok("0.1 · seed resolved with no thrown error", !!seedResult && seedResult.clientsInserted === N && seedResult.casesInserted === N, JSON.stringify(seedResult));

    const after = await page.evaluate(() => window.__mock.counts());
    eq("0.2 · clients table grew by exactly N", after.clients - before.clients, N);
    eq("0.3 · cases table grew by exactly N", after.cases - before.cases, N);
    ok("0.4 · store now holds 2,000+ clients and cases (the round's own production-scale target)",
      after.clients >= 2000 && after.cases >= 2000, JSON.stringify(after));

    // Confirm the store the app itself reads from (window.__mockDb) is the SAME store §0.2/§0.3
    // just grew — not a copy the seed wrote into and the app reads from somewhere else.
    // R69-HF1 — paged (see __readAllRaw in newPage): a bare .select() now stops at the mock's
    // 1,000-row PostgREST ceiling, which would make this read 1,000/1,000 rather than the truth.
    const liveCount = await page.evaluate(async () => {
      const c = await window.__readAllRaw("clients", "id");
      const k = await window.__readAllRaw("cases", "id");
      return { clients: c.length, cases: k.length };
    });
    eq("0.5 · window.__mockDb reads back the same grown counts (not a stale/copied store)", liveCount, { clients: after.clients, cases: after.cases });

    ok("0 · no console errors during/after the seed", noNewErr(page, errBefore0), JSON.stringify(page.__err));

    /* =======================================================================
       A · DASHBOARD
       ======================================================================= */
    console.log("\n— A · Dashboard at scale (owner, p4)");
    {
      const errBefore = (page.__err || []).length;
      const logBefore = await errLogLen(page);
      await goto(page, "dashboard", 2500);

      const kpiHtml = await page.$eval("#kpi-row", (e) => e.innerHTML).catch(() => "");
      ok("A1 · #kpi-row rendered and non-empty", kpiHtml.length > 0);
      ok("A2 · #kpi-row carries no NaN/undefined", noNaN(kpiHtml), kpiHtml.slice(0, 300));
      const nums = await numText(page, "#kpi-row .kpi .num");
      ok("A3 · every KPI number is non-blank, finite-looking text", nums.length > 0 && nums.every((t) => t.length > 0 && !/NaN|undefined/i.test(t)), JSON.stringify(nums));

      const rateErcN = await rowCount(page, "#alerts-rateerc .row-item");
      ok("A4 · Rate & ERC drawer is bounded to its 15-row cap", rateErcN >= 0 && rateErcN <= 15, rateErcN);
      /* R41 · F1 — the Retention drawer (#retention-panel/#retention-list/#retention-stats) and the
         Tasks-due drawer (#tasks-panel/#tasks-list) are both gone. `rowCount()` against a selector
         that matches nothing quietly returns 0 (Playwright's $$eval on zero elements does not
         throw), which is exactly the "too lax" failure mode HARNESS.md warns about: A5/A6 used to
         "pass" here for the wrong reason (no case_tasks are even seeded by seedScale(), so
         #tasks-list would have read 0 rows before R41 too) rather than for proving a real cap. Two
         honest replacements: confirm the drawer ids are actually gone at this scale (not just on a
         small fixture), and exercise a cap that genuinely has volume behind it here —
         seedScale() gives ~8/9 of 2,000+ cases a rate_end_date, so the Retention page's own
         #ret-rates-list (RET_LIST_CAP, read live off app.js rather than hardcoded) is the real
         at-scale cap assertion the old #retention-list one never actually was. */
      const drawersGone = await page.evaluate(() => ({
        retentionPanel: !document.getElementById("retention-panel"),
        retentionList: !document.getElementById("retention-list"),
        retentionStats: !document.getElementById("retention-stats"),
        tasksPanel: !document.getElementById("tasks-panel"),
        tasksList: !document.getElementById("tasks-list"),
      }));
      ok("A5 · the Retention drawer's ids are gone even at scale", Object.values(drawersGone).every(Boolean), JSON.stringify(drawersGone));
      const briefN = await rowCount(page, "#briefing-list .row-item");
      ok("A6 · My Day (the tasks drawer's replacement) rendered at scale with no console error", briefN >= 0, briefN);

      const dashCapHidden = await page.$eval("#dash-cap-notice", (e) => e.classList.contains("hidden")).catch(() => null);
      ok("A7 · #dash-cap-notice stays HIDDEN at ~2,600 rows — OWNER_ROW_CAP=20,000 is not hit (correct per-rule behaviour)", dashCapHidden === true, dashCapHidden);

      // A8 — the Retention page's own rates panel (R38), the surface that actually inherits the
      // "bound a big feed to a sane row count" job the drawer used to do, exercised for real here
      // because seedScale() gives the great majority of these 2,000+ cases a rate_end_date.
      await page.evaluate(() => window.nav("retention"));
      await wait(page, 2000);
      const retCap = await page.evaluate(() => RET_LIST_CAP);
      const ratesN = await rowCount(page, "#ret-rates-list .row-item");
      ok(`A8 · #ret-rates-list is bounded to RET_LIST_CAP (${retCap})`, ratesN >= 0 && ratesN <= retCap, JSON.stringify({ ratesN, retCap }));
      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, 1200);

      ok("A · zero new console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      const logAfter = await errLogLen(page);
      eq("A · zero new window.__errorLog entries", logAfter, logBefore);
    }

    /* =======================================================================
       B · PIPELINE BOARD
       ======================================================================= */
    console.log("\n— B · Pipeline board at scale (owner, p4)");
    {
      const errBefore = (page.__err || []).length;
      const logBefore = await errLogLen(page);
      await goto(page, "pipeline", 500);
      await waitStable(page, "#board");

      const boardHtml = await page.$eval("#board", (e) => e.innerHTML).catch(() => "");
      ok("B1 · #board rendered and non-empty", boardHtml.length > 0);
      const colCount = await rowCount(page, "#board .col");
      eq("B2 · all 8 stage columns render", colCount, 8);

      const cardsPerCol = await page.$$eval("#board .col", (cols) => cols.map((c) => c.querySelectorAll(".card").length));
      ok("B3 · EVERY column is bounded to BOARD_COL_CAP=50 cards", cardsPerCol.every((n) => n <= 50), JSON.stringify(cardsPerCol));
      const totalCards = cardsPerCol.reduce((a, b) => a + b, 0);
      ok("B4 · total rendered cards ≤ 8×50=400 — render is bounded, not proportional to the ~2,600-case book", totalCards <= 400, totalCards);

      const showMoreN = await rowCount(page, "#board .board-show-more");
      ok("B5 · at least one column is over its cap and shows a 'Show N more' control", showMoreN > 0, showMoreN);

      /* R73: board column heads were demoted H4 → H3 (heading-order fix) and carry .col-h now —
         same element, same count span, addressed by class. r18/r23 got the same re-point. */
      const headerCounts = await page.$$eval("#board .col .col-h span", (els) => els.map((e) => Number(e.textContent)));
      ok("B6 · every column HEADER count (the full, uncapped count) is a finite non-negative number", headerCounts.every((n) => Number.isFinite(n) && n >= 0), JSON.stringify(headerCounts));
      const headerSum = headerCounts.reduce((a, b) => a + b, 0);
      // R69-HF1 — paged, per __readAllRaw in newPage.
      const groundTruthStages = await page.evaluate(async () => (await window.__readAllRaw("cases", "id,stage")).length);
      eq("B7 · sum of column header counts equals the true total case count (headers are never themselves capped)", headerSum, groundTruthStages);

      const boardCapHidden = await page.$eval("#board-cap-notice", (e) => e.classList.contains("hidden")).catch(() => null);
      ok("B8 · #board-cap-notice stays HIDDEN at this scale (OWNER_ROW_CAP not hit)", boardCapHidden === true, boardCapHidden);

      ok("B · zero new console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      const logAfter = await errLogLen(page);
      eq("B · zero new window.__errorLog entries", logAfter, logBefore);
    }

    /* =======================================================================
       C · CLIENTS
       ======================================================================= */
    console.log("\n— C · Clients list at scale (owner, p4)");
    {
      const errBefore = (page.__err || []).length;
      const logBefore = await errLogLen(page);
      await goto(page, "clients", 500);
      await waitStable(page, "#client-list");

      const listHtml = await page.$eval("#client-list", (e) => e.innerHTML).catch(() => "");
      ok("C1 · #client-list rendered and non-empty", listHtml.length > 0);
      const rowN = await rowCount(page, "#client-list .client-row");
      ok("C2 · rendered rows bounded to CLIENT_LIST_CAP=100", rowN >= 0 && rowN <= 100, rowN);

      const capNoteText = await page.$eval("#client-list .client-list-cap-note", (e) => e.textContent).catch(() => null);
      ok("C3 · the render-cap note (.client-list-cap-note) IS shown — the full list is far past 100", !!capNoteText, capNoteText);
      const m = /Showing 100 of ([\d,]+)/.exec(capNoteText || "");
      ok("C4 · note reads exactly 'Showing 100 of <N>'", !!m, capNoteText);
      const shownOfN = m ? Number(m[1].replace(/,/g, "")) : NaN;
      ok("C5 · the N in that note is the real, uncapped scale of the book (≥ 2,000)", Number.isFinite(shownOfN) && shownOfN >= 2000, shownOfN);

      const clientsCapHidden = await page.$eval("#clients-cap-notice", (e) => e.classList.contains("hidden")).catch(() => null);
      ok("C6 · #clients-cap-notice (OWNER_ROW_CAP) stays HIDDEN at this scale — a DIFFERENT notice from C3's render-cap note", clientsCapHidden === true, clientsCapHidden);

      ok("C · zero new console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      const logAfter = await errLogLen(page);
      eq("C · zero new window.__errorLog entries", logAfter, logBefore);
    }

    /* =======================================================================
       D · REPORTS — KPIs, MI section, adviser scoreboard
       ======================================================================= */
    console.log("\n— D · Reports (KPIs + Pipeline MI + adviser scoreboard) at scale (owner, p4)");
    {
      const errBefore = (page.__err || []).length;
      const logBefore = await errLogLen(page);
      await goto(page, "reports", 500);
      await waitStable(page, "#page-reports");

      const kpiHtml = await page.$eval("#report-kpis", (e) => e.innerHTML).catch(() => "");
      ok("D1 · #report-kpis rendered and non-empty", kpiHtml.length > 0);
      ok("D2 · #report-kpis carries no NaN/undefined", noNaN(kpiHtml), kpiHtml.slice(0, 300));

      const capHidden = await page.$eval("#report-cap-notice", (e) => e.classList.contains("hidden")).catch(() => null);
      ok("D3 · #report-cap-notice stays HIDDEN — REPORTS_ROW_CAP=20,000 not hit", capHidden === true, capHidden);

      const advRows = await rowCount(page, "#report-advisers tr");
      ok("D4 · adviser scoreboard is small and team-sized (≤ 10 rows, header included) — bounded by TEAM, never by case volume", advRows >= 0 && advRows <= 10, advRows);
      const advHtml = await page.$eval("#report-advisers", (e) => e.innerHTML).catch(() => "");
      ok("D5 · adviser scoreboard carries no NaN/undefined", noNaN(advHtml), advHtml.slice(0, 300));

      const miHidden = await page.$eval("#report-mi-section", (e) => e.classList.contains("hidden")).catch(() => null);
      ok("D6 · the owner-gated MI section is visible for the owner", miHidden === false, miHidden);
      const miFunnelHtml = await page.$eval("#report-mi-funnel", (e) => e.innerHTML).catch(() => "");
      ok("D7 · MI funnel rendered and non-empty at scale", miFunnelHtml.length > 0);
      ok("D8 · MI funnel carries no NaN/undefined (percentages compute cleanly on ~1,800 live cases)", noNaN(miFunnelHtml), miFunnelHtml.slice(0, 300));

      const miScoreHtml = await page.$eval("#report-mi-scoreboard", (e) => e.innerHTML).catch(() => "");
      ok("D9 · MI scoreboard rendered", miScoreHtml.length > 0);
      const miScoreRows = await rowCount(page, "#report-mi-scoreboard tr");
      ok("D10 · MI scoreboard is team-sized, not case-sized (≤ 10 rows)", miScoreRows >= 0 && miScoreRows <= 10, miScoreRows);
      ok("D11 · MI scoreboard carries no NaN/undefined", noNaN(miScoreHtml), miScoreHtml.slice(0, 300));

      // Money-owed list on Reports — same "renders every matching row" shape as Data health's
      // uncapped panels (§H). Kept deliberately modest by the seed (most completed cases carry a
      // paid date — see seedScale) so it stays a light, documenting check here rather than a
      // second full write-up of the same architectural gap.
      const owedHtml = await page.$eval("#report-owed-table", (e) => e.innerHTML).catch(() => "");
      ok("D12 · Money owed table rendered without error at scale", owedHtml.length >= 0);
      ok("D13 · Money owed table carries no NaN/undefined", noNaN(owedHtml), owedHtml.slice(0, 300));

      ok("D · zero new console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      const logAfter = await errLogLen(page);
      eq("D · zero new window.__errorLog entries", logAfter, logBefore);
    }

    /* =======================================================================
       E · MONDAY MONEY (owner only)
       ======================================================================= */
    console.log("\n— E · Monday money at scale (owner, p4)");
    {
      const errBefore = (page.__err || []).length;
      const logBefore = await errLogLen(page);
      await goto(page, "money", 500);
      await waitStable(page, "#money-body");

      const deniedHidden = await page.$eval("#money-denied", (e) => e.classList.contains("hidden")).catch(() => null);
      ok("E1 · owner is NOT denied Monday money", deniedHidden === true, deniedHidden);
      const bankedHtml = await page.$eval("#money-banked", (e) => e.innerHTML).catch(() => "");
      ok("E2 · #money-banked rendered and non-empty", bankedHtml.length > 0);
      ok("E3 · #money-banked carries no NaN/undefined (no £NaN)", noNaN(bankedHtml), bankedHtml.slice(0, 300));

      const rateEndsRows = await rowCount(page, "#money-rateends tr");
      ok("E4 · rate-ends table bounded to top-5 (≤ 6 rows incl. header)", rateEndsRows >= 0 && rateEndsRows <= 6, rateEndsRows);
      const coldRows = await rowCount(page, "#money-cold .row-item");
      ok("E5 · cold-quotes list bounded to top-10", coldRows >= 0 && coldRows <= 10, coldRows);
      const advRows = await rowCount(page, "#money-advisers tr");
      ok("E6 · per-adviser strip is team-sized (≤ 10 rows incl. header), not case-sized", advRows >= 0 && advRows <= 10, advRows);

      const moneyHtml = await page.$eval("#money-body", (e) => e.innerHTML).catch(() => "");
      ok("E7 · the whole Monday money body carries no NaN/undefined", noNaN(moneyHtml), moneyHtml.length);

      ok("E · zero new console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      const logAfter = await errLogLen(page);
      eq("E · zero new window.__errorLog entries", logAfter, logBefore);
    }

    /* =======================================================================
       F · EMAILS
       ======================================================================= */
    console.log("\n— F · Emails at scale (owner, p4)");
    {
      const errBefore = (page.__err || []).length;
      const logBefore = await errLogLen(page);
      await goto(page, "emails", 500);
      await waitStable(page, "#email-list");

      const listHtml = await page.$eval("#email-list", (e) => e.innerHTML).catch(() => "");
      ok("F1 · #email-list rendered and non-empty", listHtml.length > 0);
      const rowN = await rowCount(page, "#email-list .row-item");
      ok("F2 · rendered rows bounded to EMAIL_ROW_LIMIT=100 (a read-level cap, unaffected by this round's client/case seed)", rowN >= 0 && rowN <= 100, rowN);
      ok("F3 · email list carries no NaN/undefined", noNaN(listHtml), listHtml.slice(0, 300));

      ok("F · zero new console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      const logAfter = await errLogLen(page);
      eq("F · zero new window.__errorLog entries", logAfter, logBefore);
    }

    /* =======================================================================
       G · DATA HEALTH — THE FIX, VERIFIED.

       R29's original scale run found every OTHER page above had a real,
       working DOM render cap (Clients 100, board 50/column, dashboard panels
       15/12/15, Money's top-5/top-10) but Data health's per-issue list
       panels did not — loadDataHealth() rendered one DOM row per match with
       no slice and no "Showing N of M" note, and #dh-tile-deadbook alone
       rendered 1,021 rows at this suite's seed. That gap is now FIXED, same
       round, in admin/app.js: `const DH_PANEL_CAP = 200;` plus a
       `dhMoreNote(n)` helper slice every list-shaped panel (unassigned,
       noFee, missingPhoneLive, noRateEnd, noCompletedAt, noMilestoneDate,
       deadBook, missingBoth, invalidEmail, invalidPhone, dhVulnerable,
       dhSuppressed) to `.slice(0, DH_PANEL_CAP)` and append
       `<div class="empty">…and N more not shown — clear the ones above
       first, or use the firm export to work the whole list.</div>` whenever
       the true count exceeds the cap; `#dh-missing-panel`'s table (already
       capped at 300 by the get_data_quality RPC) gets the same treatment
       with a `<tr><td colspan="2">…and N more not shown…</td></tr>` row
       instead, since it is a `<table>`, not `.row-item`s.

       §G now proves the FIX holds at scale: for every panel, an INDEPENDENT
       ground-truth recompute off window.__mockDb (not borrowed from app.js)
       is checked against the KPI TILE's own number (unchanged — tiles still
       report the true, un-sliced count) AND the panel's rendered row count
       (now min(true count, 200)), with the overflow note asserted present
       (naming the exact remainder) whenever the true count exceeds 200, and
       asserted ABSENT when it does not. #dh-deadbook-panel — the panel that
       hit 1,021 raw rows in the original scale run — is pinned to exactly
       200 rendered rows plus its overflow note, the direct regression test
       for the fix.
       ======================================================================= */
    console.log("\n— G · Data health at scale — DH_PANEL_CAP=200 fix verified (owner, p4)");
    {
      const errBefore = (page.__err || []).length;
      const logBefore = await errLogLen(page);
      await goto(page, "data", 500);
      await waitStable(page, "#data-content", { timeout: 30000 });

      const contentHtml = await page.$eval("#data-content", (e) => e.innerHTML).catch(() => "");
      ok("G1 · #data-content rendered and non-empty at scale (page did not white-screen)", contentHtml.length > 0);

      const dataCapHidden = await page.$eval("#data-cap-notice", (e) => e.classList.contains("hidden")).catch(() => null);
      ok("G2 · #data-cap-notice (OWNER_ROW_CAP) stays HIDDEN at this scale", dataCapHidden === true, dataCapHidden);

      const DH_PANEL_CAP = 200;

      // Ground truth, independently recomputed off window.__mockDb — same technique tests/r27.js's
      // groundTruth() uses for deadBook, extended to every panel this section checks. STAGES/
      // STAGE_LABEL are read off the page (a fair-game shared ordering constant per the HARNESS
      // standing rule); the FILTER logic itself is written fresh here, not borrowed from app.js.
      const gt = await page.evaluate(async () => {
        // R69-HF1 — paged, per __readAllRaw in newPage: these two reads ARE the independent
        // ground truth every §G assertion below is measured against, so they must see the whole
        // book, not the first 1,000 rows the mock's PostgREST ceiling would otherwise hand back.
        const cases = await window.__readAllRaw("cases",
          "id,stage,assigned_to,proc_fee,broker_fee,completed_at,submitted_at,offer_issued_date,expected_completion_date,rate_end_date");
        const clients = await window.__readAllRaw("clients", "id,email,phone");
        const isLive = (s) => s !== "completed" && s !== "not_proceeding";
        const stageRank = Object.fromEntries(STAGES.map(([k], i) => [k, i]));
        const appRank = stageRank["application"], offerRank = stageRank["offer"];
        const daysSince = (iso) => { if (!iso) return null; const t = new Date(iso).getTime(); return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000); };

        const unassigned = cases.filter((c) => isLive(c.stage) && !c.assigned_to).length;
        const noFee = cases.filter((c) => c.stage === "completed" && !(Number(c.broker_fee) > 0) && !(Number(c.proc_fee) > 0)).length;
        const noCompletedAt = cases.filter((c) => c.stage === "completed" && !c.completed_at).length;
        // R45 · non-masking repair — noMilestoneDate (admin/app.js ~24173) gained a 180-day
        // freshness guard: a COMPLETED case whose completed_at is more than 180 days old is now
        // excluded outright (blank milestone dates on the back book are read as history, not a
        // fault still worth chasing). At this suite's scale seed the fixture genuinely carries
        // completed cases past that window, so this ground truth now applies the identical guard —
        // proven correct against admin/app.js's own change in tests/r45.js §A7, independently.
        let noMilestone = 0;
        cases.forEach((c) => {
          if (c.stage === "not_proceeding") return;
          if (c.stage === "completed" && c.completed_at && daysSince(c.completed_at) > 180) return;
          const rank = stageRank[c.stage];
          if (rank == null) return;
          if (rank >= appRank && !c.submitted_at) noMilestone++;
          else if (rank >= offerRank && !c.offer_issued_date) noMilestone++;
        });
        let deadBook = 0;
        cases.forEach((c) => {
          if (c.stage === "completed" || c.stage === "not_proceeding") return;
          if (stageRank[c.stage] == null) return;
          if (c.expected_completion_date && daysSince(c.expected_completion_date) > 0) { deadBook++; return; }
          if (c.rate_end_date && daysSince(c.rate_end_date) > 0) deadBook++;
        });
        const missingBoth = clients.filter((c) => !c.email && !c.phone).length;

        return { unassigned, noFee, noCompletedAt, noMilestone, deadBook, missingBoth, totalCases: cases.length, totalClients: clients.length };
      });
      console.log("    ground truth @ scale: " + JSON.stringify(gt));

      // For each panel: (i) the KPI tile's own number matches ground truth EXACTLY (tiles still
      // report the true, un-sliced count — only the RENDER is capped); (ii) the panel's rendered
      // .row-item count is min(ground truth, DH_PANEL_CAP); (iii) the overflow note is present,
      // naming the exact remainder, iff ground truth > DH_PANEL_CAP — and absent otherwise.
      async function tileAndPanel(tileSel, panelSel, expected, label) {
        const tileNum = await page.$eval(tileSel + " .num", (e) => Number((e.textContent || "").trim())).catch(() => NaN);
        ok(`G · ${label}: tile shows a sane number`, Number.isFinite(tileNum) && tileNum >= 0, tileNum);
        eq(`G · ${label}: tile count matches independent ground truth (the TRUE, un-sliced count)`, tileNum, expected);

        const expectedRendered = Math.min(expected, DH_PANEL_CAP);
        const panelRows = await rowCount(page, panelSel + " .row-item");
        eq(`G · ${label}: panel renders AT MOST DH_PANEL_CAP=${DH_PANEL_CAP} rows (exactly ${expectedRendered} here)`, panelRows, expectedRendered);

        const panelText = await page.$eval(panelSel, (e) => e.textContent || "").catch(() => "");
        if (expected > DH_PANEL_CAP) {
          const remainder = expected - DH_PANEL_CAP;
          const re = new RegExp(`${remainder}\\s+more not shown`);
          ok(`G · ${label}: overflow note present, naming the remaining ${remainder}`, re.test(panelText), panelText.slice(-220));
        } else {
          ok(`G · ${label}: no overflow note — the full list already fit under the cap`, !/more not shown/.test(panelText));
        }
      }
      await tileAndPanel("#dh-tile-unassigned", "#dh-unassigned-panel", gt.unassigned, "Live cases unassigned");
      await tileAndPanel("#dh-tile-nofee", "#dh-nofee-panel", gt.noFee, "Completed, no fee");
      await tileAndPanel("#dh-tile-nocompleted", "#dh-nocompleted-panel", gt.noCompletedAt, "Completed, no completion date");
      await tileAndPanel("#dh-tile-milestone", "#dh-milestone-panel", gt.noMilestone, "Missing application/offer date");
      // THE direct regression check for the fix — this panel rendered 1,021 raw rows before it.
      await tileAndPanel("#dh-tile-deadbook", "#dh-deadbook-panel", gt.deadBook, "Overdue — dead book");
      await tileAndPanel("#dh-tile-both", "#dh-both-panel", gt.missingBoth, "Missing email & phone");

      ok("G · deadBook ground truth is well over DH_PANEL_CAP at this seed — the fix is actually exercised, not vacuously true",
        gt.deadBook > DH_PANEL_CAP, gt.deadBook);

      // Every KPI tile on the page — numeric and NaN-free, whatever its magnitude.
      const kpiHtml = await page.$eval("#data-content .kpi-row", (e) => e.innerHTML).catch(() => "");
      ok("G · the data-health KPI row carries no NaN/undefined", noNaN(kpiHtml), kpiHtml.slice(0, 400));
      const allTileNums = await numText(page, "#data-content .kpi .num");
      ok("G · every data-health tile number is finite-looking text (no bare NaN/undefined)", allTileNums.length > 0 && allTileNums.every((t) => !/NaN|undefined/i.test(t)), JSON.stringify(allTileNums));

      // #dh-missing-panel — a <table>, not .row-item rows: capped at 300 by the get_data_quality
      // RPC (backend, pre-existing), and now ALSO capped for render at DH_PANEL_CAP=200 with its
      // own colspan overflow <tr>, exactly like every other panel above.
      const missingEmailTileTxt = await page.$eval("#dh-tile-email .num", (e) => e.textContent).catch(() => "");
      ok("G · #dh-tile-email renders as '<N> of <M>' (its own, separate, RPC-side 300-cap machinery, unchanged)", /^\d+ of \d+$/.test((missingEmailTileTxt || "").trim()), missingEmailTileTxt);
      const missingEmailTrCount = await rowCount(page, "#dh-missing-panel table tr");
      ok("G · #dh-missing-panel's table renders AT MOST DH_PANEL_CAP+1 rows (≤200 data rows, +1 overflow row if truncated)", missingEmailTrCount >= 0 && missingEmailTrCount <= DH_PANEL_CAP + 1, missingEmailTrCount);

      // Safety net: total DOM node count on this page, now that every list panel is capped, stays
      // small and predictable regardless of how many rows the underlying book actually has —
      // proof the fix bounds the page as a whole, not just the one panel checked above.
      const totalNodes = await page.$eval("#data-content", (e) => e.querySelectorAll("*").length);
      console.log(`    #data-content total DOM node count at scale (post-fix): ${totalNodes}`);
      // Ceiling set with real headroom above the measured post-fix figure (~33k at this seed: a
      // dozen-odd panels each independently capped at 200 rows, plus the page's other panels/
      // tables) — the point is not the exact number but that it no longer scales with the
      // underlying book (pre-fix, one panel alone — deadBook — hit 1,021 rows on its own).
      ok("G · total DOM nodes on Data health now stay genuinely bounded (<60,000) with DH_PANEL_CAP in place — no longer scaling with book size", totalNodes < 60000, totalNodes);

      ok("G · zero new console errors with every panel now capped", noNewErr(page, errBefore), JSON.stringify(page.__err));
      const logAfter = await errLogLen(page);
      eq("G · zero new window.__errorLog entries", logAfter, logBefore);
    }
    await page.close();

    /* =======================================================================
       H · ADVISER PASS (p2) — lighter: their scoped pages load at scale
       with zero console errors and bounded render.
       ======================================================================= */
    console.log("\n— H · Adviser (p2) pass at scale: Dashboard, Pipeline, Clients");
    {
      // Each page load re-executes mock-supabase.js from scratch (its DB is a fresh IIFE-scoped
      // variable, not a shared/global store — confirmed by §0's seed living only on the owner's
      // `page` object above), so the adviser's own page needs its OWN seed to be "at scale" too.
      const advPage = await newPage(browser, "p2");
      const advSeed = await seedScale(advPage, N);
      ok("H0 · adviser-page seed also resolved with no thrown error", !!advSeed && advSeed.clientsInserted === N && advSeed.casesInserted === N, JSON.stringify(advSeed));

      const errBefore = (advPage.__err || []).length;
      const logBefore = await errLogLen(advPage);

      await goto(advPage, "dashboard", 2500);
      const advKpiHtml = await advPage.$eval("#kpi-row", (e) => e.innerHTML).catch(() => "");
      ok("H1 · adviser Dashboard rendered and non-empty", advKpiHtml.length > 0);
      ok("H2 · adviser Dashboard KPIs carry no NaN/undefined", noNaN(advKpiHtml), advKpiHtml.slice(0, 300));
      const advRateErcN = await rowCount(advPage, "#alerts-rateerc .row-item");
      ok("H3 · adviser's Rate & ERC drawer is bounded (≤ 15)", advRateErcN >= 0 && advRateErcN <= 15, advRateErcN);

      await goto(advPage, "pipeline", 500);
      await waitStable(advPage, "#board");
      const advCardsPerCol = await advPage.$$eval("#board .col", (cols) => cols.map((c) => c.querySelectorAll(".card").length));
      ok("H4 · adviser's board columns are bounded to ≤ 50 cards each", advCardsPerCol.every((n) => n <= 50), JSON.stringify(advCardsPerCol));
      const advBoardHtml = await advPage.$eval("#board", (e) => e.innerHTML).catch(() => "");
      ok("H5 · adviser's board rendered and non-empty", advBoardHtml.length > 0);

      await goto(advPage, "clients", 500);
      await waitStable(advPage, "#client-list");
      const advClientRows = await rowCount(advPage, "#client-list .client-row");
      ok("H6 · adviser's client list is bounded to ≤ 100 rows", advClientRows >= 0 && advClientRows <= 100, advClientRows);
      const advCapNote = await advPage.$eval("#client-list .client-list-cap-note", (e) => e.textContent).catch(() => null);
      ok("H7 · adviser sees the same render-cap note as the owner", !!advCapNote, advCapNote);

      ok("H · zero console errors across the adviser's whole pass", noNewErr(advPage, errBefore), JSON.stringify(advPage.__err));
      const logAfter = await errLogLen(advPage);
      eq("H · zero new window.__errorLog entries across the adviser's pass", logAfter, logBefore);

      await advPage.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r29_scale: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
