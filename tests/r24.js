#!/usr/bin/env node
/* =============================================================================
   tests/r24.js — acceptance tests for ROUND 24: narrow the Pipeline board's
   `cases` read from `select("*, clients!client_id(first_name,last_name)")`
   to a named column list.

   What R24 changed (app.js ~7275, loadPipeline() only):
     - `BOARD_CASE_COLS` — a fixed, always-present list of 22 plain columns
       (id,client_id,stage,case_kind,lender,product_name,loan_amount,
       rate_percent,rate_end_date,rate_end_estimated,erc_end_date,broker_fee,
       fee_status,protection_status,submitted_at,completed_at,created_at,
       updated_at,expected_completion_date,retention_source_case_id,
       lead_source,introducer_id,assigned_to).
     - Three migration-gated columns appended ONLY when their own feature
       detector says the column exists: `property_address` (propAddrSupported,
       M7), `waiting_on,solicitor_firm` (docsSupported, m10),
       `application_status` (lenderTrackSupported, no-migration-toggle column
       but still probed defensively).
     - `,clients!client_id(first_name,last_name)` always appended last.
     - R37 · non-masking repair — R37's board duplicate-hint (W9) widened this embed to
       `,clients!client_id(first_name,last_name,email)` (app.js loadPipeline(), the board's client
       cards need the email to flag same-email duplicate clients). Still a NAMED embed, still
       appended last, still no `select("*")` anywhere in it — the discipline this file's §D/§E were
       written to prove is intact; only the exact string moved, and D4/D5/E4 below are updated to
       the new truth rather than dropped.
     - `.order("updated_at",{ascending:false}).limit(OWNER_ROW_CAP)` (R23)
       unchanged.

   This file:
     §A — sanity: BOARD_CASE_COLS is exactly the documented list; the three
          feature-detect functions exist.
     §B — owner (p4): a purpose-built "kitchen sink" case (every board field
          given a real, non-null value) is inserted, then EVERY field the
          board's named select must still carry is spot-checked on both the
          board card and the table view, read back from the live DOM — not
          re-derived from app.js's own constants, except for the handful of
          PURE DISPLAY formatters (fmtM/fmtD/staffName/propLabel/STAGE_LABEL)
          tests/r19.js and tests/r20.js already establish as fair game.
     §C — same field-level regression as an adviser (p2), independent fixture
          (RLS applies no row-filtering to `cases`, confirmed by grep of
          mock-supabase.js's readFilter — the board must render for both
          roles identically).
     §D — the read is narrowed: window.__mockDb.from is monkeypatched (same
          technique as tests/r23.js's installLimitRecorder, wrapping
          `.select()` instead of `.limit()`) to capture the exact `.select()`
          argument the board's cases read passes. Asserts it is NOT "*", IS
          BOARD_CASE_COLS + the three gated columns (defaults are ON) +
          the clients embed, and does NOT contain four deliberately-dropped
          heavy columns that are real schema (proc_fee, notes,
          offer_doc_path, property_value — all real, used elsewhere in
          app.js, e.g. the case-fees table and case form).
     §E — un-migrated safety: PROP_ADDR_SUPPORTED / DOCS_SUPPORTED /
          LENDER_TRACK_SUPPORTED (module-scope `let`s app.js reads as its
          feature-detect cache) are set to `false` directly from the test —
          the same "force the detector to report unsupported" outcome a real
          un-migrated database produces, without needing a migration toggle
          for the toggle-less `application_status` column. Asserts the board
          reloads with NO console error / no 42703, still renders cards, and
          the captured select omits exactly the three gated columns while
          keeping the base list + clients embed.
     §F — star-row detectors: after an ordinary (unforced) load, both flags
          resolve `true` (this fixture's migrations are ON by default, see
          HARNESS.md), and the board's real (non-fallback) property chips /
          waiting chips are non-zero, cross-checked against ground truth read
          straight off window.__mockDb — never hardcoded against fixture
          composition, per the HARNESS.md standing rule.
     §G — no console errors loading the board as p1 (admin) too, for extra
          persona coverage beyond the p4/p2 pair §B-§F already cover in full.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r24.js
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
const noNewErr = (page, before) => (page.__err || []).length === before;

/* Monkeypatch window.__mockDb.from ONCE (idempotent) so every `.select(cols)` call on any table is
   recorded as {table, cols} — the technique tests/r23.js's installLimitRecorder uses for `.limit()`,
   applied to `.select()` instead so this file can observe the EXACT string loadPipeline() passes,
   not just infer it from app.js source. */
async function installSelectRecorder(page) {
  await page.evaluate(() => {
    if (window.__r24Installed) { window.__r24Selects = []; return; }
    window.__r24Installed = true;
    window.__r24Selects = [];
    const orig = window.__mockDb.from.bind(window.__mockDb);
    window.__mockDb.from = function (table) {
      const b = orig(table);
      const origSelect = b.select.bind(b);
      b.select = function (cols, opts) {
        window.__r24Selects.push({ table: table, cols: cols });
        return origSelect(cols, opts);
      };
      return b;
    };
  });
}
const clearSelects = (page) => page.evaluate(() => { window.__r24Selects = []; });
/* The board's cases read is the only one whose column list starts with the FULL BOARD_CASE_COLS
   string — every other `cases` select in app.js (Reports, Dashboard, revFetchCases, the case-picker
   reads…) either has a different column order or a different, shorter/longer list, so this prefix
   match is a safe, unique fingerprint (verified by hand against every other `.select(` on the
   "cases" table in app.js while writing this file). */
async function boardSelectCalls(page) {
  return page.evaluate(async () => {
    const base = BOARD_CASE_COLS;
    return window.__r24Selects.filter((r) => r.table === "cases" && typeof r.cols === "string" && r.cols.indexOf(base) === 0);
  });
}

/* Insert a client + a "kitchen sink" case carrying a real, non-null value in EVERY field the
   board's named select must still provide — one round trip, independent of the seeded fixture, so
   every assertion below is proof the NAMED select actually returns that value, not a coincidence
   of fixture composition (HARNESS.md standing rule). */
async function insertKitchenSink(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = `r24.${Math.random().toString(36).slice(2, 9)}@example.com`;
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first, last_name: o.last, email, phone: null })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = {
      client_id: cl.id,
      case_kind: "purchase",
      stage: "application",                 // in LENDER_TRACK_STAGES, so the lender-status badge is live
      assigned_to: o.assigned_to,
      lender: o.lender,
      product_name: o.product_name,          // NOT rendered directly — only feeds the board search filter
      loan_amount: o.loan_amount,
      rate_percent: o.rate_percent,
      rate_end_date: o.rate_end_date,
      rate_end_estimated: false,
      erc_end_date: o.erc_end_date,
      broker_fee: o.broker_fee,
      fee_status: "paid",
      protection_status: "quoted",
      property_address: o.property_address,
      waiting_on: "solicitor",
      solicitor_firm: o.solicitor_firm,
      application_status: "underwriting",
      expected_completion_date: o.rate_end_date,
      lead_source: "R24 kitchen-sink test lead",
    };
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id, fullName: [o.first, o.last].filter(Boolean).join(" "), row };
  }, opts);
}

/* Read back the pure DISPLAY formatting app.js itself would apply to the kitchen-sink row's raw
   values — reused exactly as tests/r19.js/r20.js already reuse fmtM/STAGE_LABEL, never re-derived
   by hand, so a formatting change elsewhere can't make this file assert the wrong string. */
async function expectedDisplay(page, row) {
  return page.evaluate((r) => ({
    loanText: fmtM(r.loan_amount),
    rateEndText: fmtD(r.rate_end_date),
    ercText: fmtD(r.erc_end_date),
    feeText: fmtM(r.broker_fee),
    staffNameText: staffName(r.assigned_to),
    propLabelText: propLabel(r.property_address),
    stageLabelText: STAGE_LABEL[r.stage],
  }), row);
}

/* Board card, by data-id — exact, not "any card". */
async function readCard(page, caseId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`.card[data-id="${id}"]`);
    if (!el) return null;
    return {
      name: (el.querySelector(".cn-name") || {}).textContent && el.querySelector(".cn-name").textContent.trim(),
      stageCol: el.closest(".col") && el.closest(".col").dataset.stage,
      cd: el.querySelector(".cd") && el.querySelector(".cd").textContent.trim(),
      badges: Array.from(el.querySelectorAll(".badge")).map((b) => b.textContent.trim()),
      propChipHtml: el.querySelector(".prop-chip") ? el.querySelector(".prop-chip").outerHTML : null,
      propChipText: el.querySelector(".prop-chip .pc-txt") ? el.querySelector(".prop-chip .pc-txt").textContent.trim() : null,
      adviserChipTitle: el.querySelector(".chip") ? el.querySelector(".chip").getAttribute("title") : null,
      html: el.outerHTML,
    };
  }, caseId);
}

/* Table row, by the client's full name in the sticky Client cell — table rows carry no data-id, so
   this is the natural key (the fixture never produces a duplicate full name and neither do we). */
async function readTableRow(page, fullName) {
  return page.evaluate((name) => {
    const table = document.querySelector("#pipe-table");
    if (!table) return null;
    const headRow = table.querySelector("tr:first-child");
    const keys = Array.from(headRow.querySelectorAll("th")).map((th) => th.dataset.k || null);
    const rows = Array.from(table.querySelectorAll("tr")).slice(1);
    for (const tr of rows) {
      const nameCell = tr.querySelector(".stick-col");
      if (nameCell && nameCell.textContent.trim() === name) {
        const tds = Array.from(tr.querySelectorAll("td"));
        const obj = {};
        keys.forEach((k, i) => { if (k) obj[k] = tds[i] ? tds[i].textContent.trim() : ""; });
        return obj;
      }
    }
    return null;
  }, fullName);
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
       A · SANITY — BOARD_CASE_COLS is exactly the documented list; the three
           feature-detect functions exist as functions.
       ======================================================================= */
    const pageA = await newPage(browser, "p4");
    {
      console.log("\n— A · BOARD_CASE_COLS constant + feature-detect functions exist (p4)");
      const errBefore = (pageA.__err || []).length;
      const EXPECTED_BASE = "id,client_id,stage,case_kind,lender,product_name,loan_amount,rate_percent,rate_end_date,rate_end_estimated,erc_end_date,broker_fee,fee_status,protection_status,submitted_at,completed_at,created_at,updated_at,expected_completion_date,retention_source_case_id,lead_source,introducer_id,assigned_to";
      const base = await pageA.evaluate(() => BOARD_CASE_COLS);
      eq("A1 · BOARD_CASE_COLS is exactly the documented 22-column list", base, EXPECTED_BASE);
      const types = await pageA.evaluate(() => ({
        propAddrSupported: typeof window.propAddrSupported || typeof propAddrSupported,
        docsSupported: typeof window.docsSupported || typeof docsSupported,
        lenderTrackSupported: typeof window.lenderTrackSupported || typeof lenderTrackSupported,
      }));
      eq("A2 · propAddrSupported is a function", types.propAddrSupported, "function");
      eq("A3 · docsSupported is a function", types.docsSupported, "function");
      eq("A4 · lenderTrackSupported is a function", types.lenderTrackSupported, "function");
      ok("A · no console errors", noNewErr(pageA, errBefore), JSON.stringify(pageA.__err));
    }

    /* =======================================================================
       B · OWNER (p4) — field-level regression. A kitchen-sink case carrying a
           real value in every board field is inserted; every field the task
           calls out is spot-checked on the CARD, then on the TABLE row.
       ======================================================================= */
    let kbCaseId, kbRow, kbFullName, kbExpected;
    {
      console.log("\n— B · Owner (p4): board + table render every field with real values (kitchen-sink case)");
      const errBefore = (pageA.__err || []).length;

      const seed = {
        first: "Bkitchen", last: "SinkOwner",
        assigned_to: "p2", lender: "R24 Test Lender", product_name: "R24UniqueProductToken9931",
        loan_amount: 317500, rate_percent: 4.29,
        rate_end_date: new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10),
        erc_end_date: new Date(Date.now() + 100 * DAY).toISOString().slice(0, 10),
        broker_fee: 695,
        property_address: "42 Kingsley Road, Bournemouth BH5 2QP",
        solicitor_firm: "Kitchensink & Sons Solicitors",
      };
      const ins = await insertKitchenSink(pageA, seed);
      kbCaseId = ins.caseId; kbRow = ins.row; kbFullName = ins.fullName;
      kbExpected = await expectedDisplay(pageA, kbRow);

      await goto(pageA, "pipeline", 1200);

      // — Board card —
      const card = await readCard(pageA, kbCaseId);
      ok("B1 · the kitchen-sink card is present on the board", !!card, kbCaseId);
      if (card) {
        eq("B2 · client name renders (clients!client_id embed)", card.name, kbFullName);
        eq("B3 · card sits in the correct stage column (stage)", card.stageCol, "application");
        ok("B4 · lender renders in the card body", card.cd.indexOf(seed.lender) !== -1, card.cd);
        ok("B5 · loan amount renders in the card body", card.cd.indexOf(kbExpected.loanText) !== -1, card.cd);
        ok("B6 · rate-end badge renders with the right date", card.badges.some((b) => b === `Rate ends ${kbExpected.rateEndText}`), JSON.stringify(card.badges));
        ok("B7 · fee-status badge renders (\"Fee paid\")", card.badges.indexOf("Fee paid") !== -1, JSON.stringify(card.badges));
        ok("B8 · waiting/solicitor chip renders with the firm name", card.badges.some((b) => b === "⏳ solicitor · " + seed.solicitor_firm), JSON.stringify(card.badges));
        ok("B9 · lender-status badge renders from application_status (\"🏦 Underwriting\")", card.badges.indexOf("🏦 Underwriting") !== -1, JSON.stringify(card.badges));
        ok("B10 · property chip renders (real chip, not the hollow fallback)", !!card.propChipHtml && card.propChipHtml.indexOf("prop-chip-none") === -1, card.propChipHtml);
        eq("B11 · property chip's short label matches propLabel(property_address)", card.propChipText, kbExpected.propLabelText);
        eq("B12 · adviser chip title matches staffName(assigned_to)", card.adviserChipTitle, kbExpected.staffNameText);
        ok("B13 · no literal \"undefined\" anywhere in the card markup", card.html.indexOf("undefined") === -1, card.html.slice(0, 200));
      }

      // — Table view —
      await pageA.click("#view-toggle");
      await wait(pageA, 900);
      /* PATCHED R75 · B4 — the live table now paints a RULE-BASED DEFAULT SET of nine
         columns instead of all sixteen (Property is dropped when more than half the rows
         on screen have no address; Adviser is dropped under an adviser filter; the sort
         column is never dropped). BOARD_CASE_COLS and the select are untouched — this is
         which columns are painted. The cell assertions below are not weakened by one
         character: they press the "⊞ All columns" affordance first and then read exactly
         the same cells, by the same data-k keys, for the same expected values. */
      await pageA.click("#pipe-cols-toggle");
      await wait(pageA, 1400);
      const row = await readTableRow(pageA, kbFullName);
      ok("B14 · the kitchen-sink row is present in the table view", !!row, kbFullName);
      if (row) {
        ok("B15 · table Property cell shows the address label", row.property && row.property.indexOf(kbExpected.propLabelText) !== -1, row.property);
        /* PATCHED R65 · H7b — the waiting-on chip MOVED out of the Stage cell into its own
           sortable "Waiting on" column (a chip nested inside another column can be neither sorted
           on nor scanned down, and "show me everything sitting with a solicitor" is the question
           this table exists to answer). The assertion is not weakened: the Stage cell must still
           show the stage label, the chip must still be on the row, and B16c pins that it is NOT
           in both places. */
        ok("B16 · table Stage cell shows the stage label", row.stage.indexOf(kbExpected.stageLabelText) !== -1, row.stage);
        ok("B16b · the waiting chip is in its own Waiting-on column", (row.waiting_on || "").indexOf("solicitor") !== -1, row.waiting_on);
        ok("B16c · …and NOT also in the Stage cell (moved, not duplicated)", row.stage.indexOf("solicitor") === -1, row.stage);
        eq("B17 · table Type cell shows the case kind", row.case_kind, "Purchase");
        ok("B18 · table Lender cell shows the lender", row.lender.indexOf(seed.lender) !== -1, row.lender);
        eq("B19 · table Rate cell shows rate_percent", row.rate_percent, seed.rate_percent + "%");
        eq("B20 · table Rate-ends cell shows rate_end_date", row.rate_end_date, kbExpected.rateEndText);
        eq("B21 · table ERC-ends cell shows erc_end_date", row.erc_end_date, kbExpected.ercText);
        eq("B22 · table Fee cell shows broker_fee", row.broker_fee, kbExpected.feeText);
        eq("B23 · table Fee-status cell shows fee_status", row.fee_status, "paid");
        eq("B24 · table Protection cell shows protection_status", row.protection_status, "quoted");
        eq("B25 · table Adviser cell shows the assignee's name", row.assigned, kbExpected.staffNameText);
        ok("B26 · table Updated cell is non-empty (updated_at)", !!row.updated_at && row.updated_at !== "—", row.updated_at);
        const rowVals = Object.values(row).join(" | ");
        ok("B27 · no literal \"undefined\" anywhere in the row", rowVals.indexOf("undefined") === -1, rowVals);
      }

      // — Bonus: product_name (selected but never displayed directly) still feeds the board search —
      await pageA.click("#view-toggle"); // back to board
      await wait(pageA, 900);
      await pageA.fill("#board-search", seed.product_name);
      await wait(pageA, 500);
      const foundBySearch = await pageA.evaluate((id) => !!document.querySelector(`.card[data-id="${id}"]`), kbCaseId);
      ok("B28 · board-search on product_name (a selected, never-rendered field) still finds the card", foundBySearch);
      await pageA.fill("#board-search", "");
      await wait(pageA, 500);

      ok("B · no console errors across the owner's board/table load", noNewErr(pageA, errBefore), JSON.stringify(pageA.__err));
    }

    /* =======================================================================
       D · THE READ IS NARROWED — capture the exact `.select()` string the
           board's cases read passes, on the SAME page/session as §B (feature
           detectors already resolved true there, so all three gated columns
           should be present).
       ======================================================================= */
    {
      console.log("\n— D · The board's cases read is narrowed, not select(\"*\") (p4)");
      const errBefore = (pageA.__err || []).length;
      await installSelectRecorder(pageA);
      await clearSelects(pageA);
      await goto(pageA, "clients", 500);   // navigate away and back so loadPipeline() runs again under the recorder
      // R78: the board now caches its cases read for the session (A5); bust it so this walk
      // OBSERVES a fresh select — the assertion is about the select string, not the cache.
      await pageA.evaluate(() => window.__bustBoardCache());
      await goto(pageA, "pipeline", 1200);
      const calls = await boardSelectCalls(pageA);
      ok("D1 · exactly one board cases select observed", calls.length === 1, JSON.stringify(calls));
      const cols = calls[0] && calls[0].cols;
      ok("D2 · the select argument is NOT \"*\"", cols !== "*", cols);
      const base = await pageA.evaluate(() => BOARD_CASE_COLS);
      ok("D3 · the select argument starts with BOARD_CASE_COLS verbatim", typeof cols === "string" && cols.indexOf(base) === 0, cols);
      // R37 · non-masking repair — the board's clients embed now widens to include `email` (W9
      // duplicate-client hint); the string this test checks for is updated to that new truth, not
      // relaxed — it still asserts a named, non-"*" embed appended last.
      ok("D4 · …and includes the clients!client_id embed (R37: widened to include email)", cols.indexOf("clients!client_id(first_name,last_name,email)") !== -1, cols);
      ok("D5 · …and ends with the clients embed (appended last, per app.js)", cols.slice(-"clients!client_id(first_name,last_name,email)".length) === "clients!client_id(first_name,last_name,email)", cols);
      ok("D6 · …and (defaults ON) includes property_address", cols.indexOf(",property_address") !== -1, cols);
      ok("D7 · …and includes waiting_on,solicitor_firm", cols.indexOf(",waiting_on,solicitor_firm") !== -1, cols);
      ok("D8 · …and includes application_status", cols.indexOf(",application_status") !== -1, cols);
      ["proc_fee", "notes", "offer_doc_path", "property_value"].forEach((dropped) => {
        ok(`D9 · dropped column "${dropped}" is NOT in the select (real schema column, deliberately narrowed away)`, cols.indexOf(dropped) === -1, cols);
      });
      ok("D · no console errors", noNewErr(pageA, errBefore), JSON.stringify(pageA.__err));
    }
    await pageA.close();

    /* =======================================================================
       C · ADVISER (p2) — the same field-level regression, independent
           kitchen-sink case, fresh page (fresh in-memory DB per page load).
       ======================================================================= */
    {
      console.log("\n— C · Adviser (p2): board + table render every field identically (independent kitchen-sink case)");
      const pageC = await newPage(browser, "p2");
      const errBefore = (pageC.__err || []).length;

      const seed = {
        first: "Ckitchen", last: "SinkAdviser",
        assigned_to: "p3", lender: "R24 Adviser Lender", product_name: "R24AdvUniqueToken4471",
        loan_amount: 228000, rate_percent: 5.14,
        rate_end_date: new Date(Date.now() + 260 * DAY).toISOString().slice(0, 10),
        erc_end_date: new Date(Date.now() + 40 * DAY).toISOString().slice(0, 10),
        broker_fee: 450,
        property_address: "7 Wessex Way, Poole BH15 1LZ",
        solicitor_firm: "Adviser View Legal LLP",
      };
      const ins = await insertKitchenSink(pageC, seed);
      const expC = await expectedDisplay(pageC, ins.row);

      await goto(pageC, "pipeline", 1200);
      // R34 · W2 — #board-adviser now defaults to the signed-in adviser's own id, not "all". This
      // case is deliberately assigned to p3 (proving the RENDER is correct regardless of who is
      // looking, not that p2 owns it), so p2's own default would hide it entirely. Pinned to "all",
      // same real-UI-action fix as tests/r18.js's board-cap block.
      await pageC.selectOption("#board-adviser", "all");
      await wait(pageC, 300);
      const card = await readCard(pageC, ins.caseId);
      ok("C1 · the kitchen-sink card is present on the board for an adviser", !!card, ins.caseId);
      if (card) {
        eq("C2 · client name renders", card.name, ins.fullName);
        eq("C3 · card sits in the correct stage column", card.stageCol, "application");
        ok("C4 · lender renders in the card body", card.cd.indexOf(seed.lender) !== -1, card.cd);
        ok("C5 · loan amount renders in the card body", card.cd.indexOf(expC.loanText) !== -1, card.cd);
        ok("C6 · rate-end badge renders", card.badges.some((b) => b === `Rate ends ${expC.rateEndText}`), JSON.stringify(card.badges));
        ok("C7 · fee-status badge renders", card.badges.indexOf("Fee paid") !== -1, JSON.stringify(card.badges));
        ok("C8 · waiting/solicitor chip renders", card.badges.some((b) => b === "⏳ solicitor · " + seed.solicitor_firm), JSON.stringify(card.badges));
        ok("C9 · lender-status badge renders", card.badges.indexOf("🏦 Underwriting") !== -1, JSON.stringify(card.badges));
        ok("C10 · property chip renders (real, not hollow)", !!card.propChipHtml && card.propChipHtml.indexOf("prop-chip-none") === -1, card.propChipHtml);
        eq("C11 · property chip label matches propLabel()", card.propChipText, expC.propLabelText);
        eq("C12 · adviser chip title matches staffName()", card.adviserChipTitle, expC.staffNameText);
        ok("C13 · no literal \"undefined\" in the card markup", card.html.indexOf("undefined") === -1, card.html.slice(0, 200));
      }

      await pageC.click("#view-toggle");
      await wait(pageC, 900);
      // PATCHED R75 · B4 — same as B14 above: show every column, then read the same cells.
      await pageC.click("#pipe-cols-toggle");
      await wait(pageC, 1400);
      const row = await readTableRow(pageC, ins.fullName);
      ok("C14 · the kitchen-sink row is present in the table view for an adviser", !!row, ins.fullName);
      if (row) {
        ok("C15 · table Property cell shows the address label", row.property && row.property.indexOf(expC.propLabelText) !== -1, row.property);
        eq("C16 · table Rate-ends cell shows rate_end_date", row.rate_end_date, expC.rateEndText);
        eq("C17 · table Fee cell shows broker_fee", row.broker_fee, expC.feeText);
        eq("C18 · table Fee-status cell shows fee_status", row.fee_status, "paid");
        eq("C19 · table Protection cell shows protection_status", row.protection_status, "quoted");
        eq("C20 · table Adviser cell shows the assignee's name", row.assigned, expC.staffNameText);
        const rowVals = Object.values(row).join(" | ");
        ok("C21 · no literal \"undefined\" anywhere in the row", rowVals.indexOf("undefined") === -1, rowVals);
      }

      ok("C · no console errors across the adviser's board/table load", noNewErr(pageC, errBefore), JSON.stringify(pageC.__err));
      await pageC.close();
    }

    /* =======================================================================
       E · UN-MIGRATED SAFETY — force all three feature detectors to report
           "unsupported" (the same module-scope `let` cache app.js itself
           checks with `!== null`, set directly — the one gated column
           (application_status) has no migration toggle to flip, so this is
           the mechanically equivalent way to reach the same runtime state a
           real un-migrated database would produce). The board must still
           load with no 42703 and no console error, on the base columns only.
       ======================================================================= */
    {
      console.log("\n— E · All three feature-detects forced unsupported: board still loads, no 42703 (p4)");
      const pageE = await newPage(browser, "p4");
      const errBefore = (pageE.__err || []).length;
      await installSelectRecorder(pageE);

      await pageE.evaluate(() => { PROP_ADDR_SUPPORTED = false; DOCS_SUPPORTED = false; LENDER_TRACK_SUPPORTED = false; });
      const flagsNow = await pageE.evaluate(() => ({ p: PROP_ADDR_SUPPORTED, d: DOCS_SUPPORTED, l: LENDER_TRACK_SUPPORTED }));
      eq("E1 · the three caches are now forced false", flagsNow, { p: false, d: false, l: false });

      await clearSelects(pageE);
      await pageE.evaluate(() => loadPipeline());
      await wait(pageE, 1200);

      const calls = await boardSelectCalls(pageE);
      ok("E2 · exactly one board cases select observed while forced-unsupported", calls.length === 1, JSON.stringify(calls));
      const cols = calls[0] && calls[0].cols;
      ok("E3 · the select still includes the base BOARD_CASE_COLS", typeof cols === "string" && cols.indexOf(await pageE.evaluate(() => BOARD_CASE_COLS)) === 0, cols);
      ok("E4 · the select still includes the clients embed (R37: widened to include email)", cols && cols.indexOf("clients!client_id(first_name,last_name,email)") !== -1, cols);
      ok("E5 · property_address is OMITTED (not requested at all)", cols && cols.indexOf("property_address") === -1, cols);
      ok("E6 · waiting_on/solicitor_firm are OMITTED", cols && cols.indexOf("waiting_on") === -1 && cols.indexOf("solicitor_firm") === -1, cols);
      ok("E7 · application_status is OMITTED", cols && cols.indexOf("application_status") === -1, cols);

      const boardHtml = await pageE.evaluate(() => document.querySelector("#board").innerHTML);
      ok("E8 · the board is NOT showing a load-error state (renderLoadError never fired — omission, not a 42703)", boardHtml.indexOf("42703") === -1 && boardHtml.indexOf("does not exist") === -1, boardHtml.slice(0, 200));
      const cardCount = await pageE.$$eval(".card, .board-empty", (els) => els.length);
      ok("E9 · the board still renders (cards or an explicit empty state, not blank/crashed)", cardCount > 0, cardCount);
      const boardVisible = await pageE.$eval("#board", (e) => !e.classList.contains("hidden"));
      ok("E10 · #board is visible (not stuck hidden behind an error branch)", boardVisible);

      ok("E · no console errors / no 42703 surfaced while forced-unsupported", noNewErr(pageE, errBefore), JSON.stringify(pageE.__err));
      await pageE.close();
    }

    /* =======================================================================
       F · STAR-ROW DETECTORS — after an ordinary (unforced) load, both flags
           resolve true (this fixture's migrations default ON), and the
           board's real property/waiting chips are non-zero, cross-checked
           against ground truth read straight off window.__mockDb.
       ======================================================================= */
    {
      console.log("\n— F · Star-row detectors resolve consistently after the named-select load (p4)");
      const pageF = await newPage(browser, "p4");
      const errBefore = (pageF.__err || []).length;

      await goto(pageF, "pipeline", 1200);
      const flags = await pageF.evaluate(() => ({ p: PROP_ADDR_SUPPORTED, d: DOCS_SUPPORTED }));
      eq("F1 · PROP_ADDR_SUPPORTED resolves true (migrations default ON)", flags.p, true);
      eq("F2 · DOCS_SUPPORTED resolves true (migrations default ON)", flags.d, true);

      const gt = await pageF.evaluate(async () => {
        const db = window.__mockDb;
        const cases = (await db.from("cases").select("id,stage,property_address,waiting_on")).data || [];
        const live = cases.filter((c) => c.stage !== "completed" && c.stage !== "not_proceeding");
        return { withProp: live.filter((c) => c.property_address).length, withWaiting: live.filter((c) => c.waiting_on).length };
      });
      ok("ground truth · fixture has at least one live case with a property address (sanity)", gt.withProp > 0, JSON.stringify(gt));
      ok("ground truth · fixture has at least one live case with a waiting_on value (sanity)", gt.withWaiting > 0, JSON.stringify(gt));

      const realPropChips = await pageF.$$eval(".card .prop-chip:not(.prop-chip-none)", (els) => els.length);
      ok("F3 · real (non-fallback) property chips render on the board", realPropChips > 0, realPropChips);
      const waitChips = await pageF.$$eval(".card .badge.wait-chip", (els) => els.length);
      ok("F4 · waiting chips render on the board", waitChips > 0, waitChips);

      ok("F · no console errors", noNewErr(pageF, errBefore), JSON.stringify(pageF.__err));
      await pageF.close();
    }

    /* =======================================================================
       G · EXTRA PERSONA COVERAGE — admin (p1) also loads the board cleanly.
       ======================================================================= */
    {
      console.log("\n— G · Admin (p1): board loads with no console errors");
      const pageG = await newPage(browser, "p1");
      const errBefore = (pageG.__err || []).length;
      await goto(pageG, "pipeline", 1200);
      const cardCount = await pageG.$$eval(".card, .board-empty", (els) => els.length);
      ok("G1 · the board renders for admin (cards or explicit empty state)", cardCount > 0, cardCount);
      ok("G · no console errors on the admin's board load", noNewErr(pageG, errBefore), JSON.stringify(pageG.__err));
      await pageG.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r24: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
