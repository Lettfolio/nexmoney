#!/usr/bin/env node
/* =============================================================================
   tests/r44.js — acceptance tests for ROUND 44: Stonebridge payment
   reconciliation (admin/app.js ~L22840-23915, admin/index.html #money-recon-
   panel / #money-procrates-panel, admin/mock-supabase.js R44_TABLES).

   What R44 shipped, in one paragraph: two OWNER-ONLY panels at the foot of
   Monday money. The proc-rate card (#money-procrates-panel) is uploaded and
   REPLACES WHOLESALE — it exists only to give expected-fee checks something
   to compare against. The weekly commission-statement importer
   (#money-recon-panel) parses a workbook by HEADER NAME (never position),
   suggests a matching case for every mortgage/takeback/protection line with
   suggestStatementMatches() (a PURE function — no I/O — tested here directly
   via page.evaluate against synthetic case/line objects, the same reason the
   product comment gives for keeping it pure), and writes NOTHING to a case
   until a human reviews and confirms one line at a time. Confirming a
   mortgage receipt reuses feePaidPatch() (the R13-M2 legacy-column rule,
   lifted out of markFeePaid unchanged) to date proc_fee_paid_at; confirming
   a real (unpaired) takeback never touches a paid date — it raises a
   CLAWBACK note plus an owner case_tasks row instead; a takeback reversed
   INSIDE the same statement (r44ReversalPairs) gets one net-£0 note and no
   task. Every one of the three new tables (proc_rates, commission_statements,
   commission_lines) is is_owner() on every operation in the mock, mirroring
   the migration, and none of them are in AUDITED (no audit trigger in prod).

   Sandbox note: cdn.sheetjs.com is 403'd here, so every test that needs to
   drive an actual file upload injects the XLSX UMD bundle with
   page.addScriptTag({ path }) BEFORE building a workbook — see XLSX_PATH and
   bootXlsx() below. Tests that only exercise the PARSER or MATCHER functions
   never need this: parseProcRatesSheet/parseStatementSheet take a plain
   array-of-arrays and suggestStatementMatches takes plain objects, so §A/§B/§C
   call them directly with in-memory JS, no spreadsheet involved at all — the
   same "pure function, testable without a spreadsheet" reasoning the product
   comment gives for the matcher applies just as well to the two parsers.
   All workbook/case fixture data below is INVENTED for this file; nothing is
   read from /tmp/r44's real workbooks.

   §A  parseProcRatesSheet — header scan/fallback names, blank/non-numeric/
       out-of-range skip (counted), explicit-zero kept but excluded from
       `usable`, missing-column report
   §B  parseStatementSheet — Ref: scan across rows 0-4, header row via
       newline-bearing header names, firm-row-vs-adviser-row via the "Total
       for X" trailer names, subtotal/total-row skip, negative/accounting-
       format money cells, statement totals from the trailer row vs summed
       when it is absent
   §C  pure matcher — r44Surnames edge cases, r44LenderMatch normalisation,
       r44LineKind classification, r44ReversalPairs tolerance, r44ExpectedFee/
       r44FeeVerdict boundaries, suggestStatementMatches admission/scoring/
       confidence/tie-break, R44_MATCHABLE gate on renewal/other
   §D  owner-only gating — p4 sees both panels + DOM order; p1 admin and p2
       adviser get neither, read empty on all three tables, write 42501
   §E  proc-rate card upload — skip counts end to end, replace-wholesale
   §F  statement import — ref/statement/lines rows, dup-ref 23505 (no half-
       import), a forced line-insert failure rolling the statement back
   §G  review UI — five kind-groups render, pre-ticked confident rows, re-pick
       select, renewal aggregate-per-adviser, takeback tint
   §H  confirm flows — mortgage receipt (dates + legacy columns + note),
       fee-fix checkbox (unset case always sets; close match shows no
       checkbox; far match unticked leaves the case alone; ticked updates
       it), paired takeback (one net note, no task), real takeback (CLAWBACK
       note + owner task due today), protection (note only), bulk "Confirm
       ticked", dismiss/un-dismiss, a confirmed line refusing dismiss
   §I  statement-list counters update after confirm; review renders FROM THE
       DB and survives close+reopen; hostile spreadsheet strings render inert
   §J  no console errors, all four personas

   Run:  node /root/nx/tests/r44.js
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
/* The XLSX UMD bundle: a real npm install of the `xlsx` package that lives
   in this sandbox at /tmp/r44/node_modules/xlsx (a LIBRARY file — sheetjs.com's
   own code, not client data). cdn.sheetjs.com 403s in this sandbox, so every
   upload-driving test injects this bundle with page.addScriptTag({ path })
   before touching a file input, rather than a <script src="https://cdn...">
   tag. This file never reads anything else out of /tmp/r44 — the real
   workbooks living alongside it are real client data and are never opened;
   every fixture workbook below is built in-page from invented rows. If this
   path ever moves, `npm ls xlsx --prefix /tmp/r44` (or a fresh
   `npm install xlsx --prefix /tmp/some-dir`) finds/recreates it. */
const XLSX_PATH = "/tmp/r44/node_modules/xlsx/dist/xlsx.full.min.js";

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail !== undefined ? ` — ${JSON.stringify(detail)}` : "")); console.log(`  ✗ ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`); }
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
  page.on("dialog", async (d) => { try { await d.accept(); } catch (e) { /* ignore */ } });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const noNewErr = (page, before) => (page.__err || []).length === before;
const gotoMoney = async (page, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate(() => window.nav("money"));
  await wait(page, ms == null ? 2000 : ms);
};
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
/* Injects the SheetJS bundle (see XLSX_PATH above) plus two tiny in-page
   helpers every upload-driving test uses: __mkFile builds a real .xlsx File
   from an array-of-arrays, __drop puts it on a <input type=file> and fires
   `change` — the same DataTransfer technique the rest of this harness family
   uses for file inputs elsewhere in the app. */
async function bootXlsx(page) {
  await page.addScriptTag({ path: XLSX_PATH });
  await page.evaluate(() => {
    window.__mkFile = function (aoa, sheetName, fileName) {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      return new File([out], fileName, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    };
    window.__drop = function (sel, file) {
      const el = document.querySelector(sel);
      const dt = new DataTransfer(); dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
  });
  await wait(page, 200);
}

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — same technique tests/r38.js/r37.js/... use.
   ------------------------------------------------------------------------- */
async function insertClient(page, fields) {
  return page.evaluate(async (f) => {
    const db = window.__mockDb;
    const { data, error } = await db.from("clients").insert(f).select("id").single();
    if (error) throw new Error("client insert: " + error.message);
    return data.id;
  }, fields);
}
async function insertCase(page, fields) {
  return page.evaluate(async (f) => {
    const db = window.__mockDb;
    const { data, error } = await db.from("cases").insert(f).select("id").single();
    if (error) throw new Error("case insert: " + error.message);
    return data.id;
  }, fields);
}
let uniq = 0;
function tag() { uniq += 1; return "R44" + Date.now().toString(36) + uniq; }
/* One deterministic client+case pair, tagged so its surname can never collide
   with the base fixture's ~70 cases. `o.case` overrides land on the row. */
async function mkFixtureCase(page, last, o) {
  const opt = o || {};
  const clId = await insertClient(page, { first_name: "R44", last_name: last, email: `${last.toLowerCase()}@example.invalid`, phone: "07700900000" });
  const row = Object.assign({
    client_id: clId, case_kind: "remortgage", stage: "completed", assigned_to: "p2",
    lender: "Halifax", loan_amount: 200000, proc_fee: 0, proc_fee_paid_at: null,
  }, opt.case || {});
  const caseId = await insertCase(page, row);
  return { clientId: clId, caseId, last };
}
const readCase = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", id).single();
  return data;
}, caseId);
const notesFor = (page, caseId) => page.evaluate((id) => window.__mock.db.case_notes.filter((n) => n.case_id === id).map((n) => n.body), caseId);
const tasksFor = (page, caseId) => page.evaluate((id) => window.__mock.db.case_tasks.filter((t) => t.case_id === id), caseId);

/* The statement fixture builder shared by §F/§G/§H/§I. 21 spacer-interleaved
   columns, header text carrying literal mid-phrase newlines and a Ref: cell
   buried inside the trailer rows — the exact shape the product comment
   describes for the real workbook, values entirely invented. `rows` is a list
   of { d, tt, addr, prov, acct, opp, reason, ptype, pgroup, prem, g, n,
   adviser: "one"|"two" }; a firm row + one adviser group per distinct
   `adviser` value are generated automatically. */
function buildStatementAoa(ref, rows, opts) {
  const o = opts || {};
  const H = ["Date", "Tran Type \nDesc", "Addressee", "Provider", "Account \nnumber", "Opp ID", null,
    "File Review Client Name", "Reason", "Policy \nType", "Policy Group", null, "Premium",
    "Banked\n(Gross)", null, null, "Banked\n(Net)", "Deduction(Introducer)", "Deduction\n(Referrer)", "Clawback\nReserve", "£"];
  const blank = () => new Array(21).fill(null);
  const line = (r) => { const a = blank();
    a[0] = r.d; a[1] = r.tt; a[2] = r.addr || ""; a[3] = r.prov || ""; a[4] = r.acct || ""; a[5] = r.opp || "";
    a[8] = r.reason || ""; a[9] = r.ptype || ""; a[10] = r.pgroup || ""; a[12] = r.prem == null ? "" : r.prem;
    a[13] = r.g; a[16] = r.n; return a; };
  const title = blank(); title[0] = "Commission statement";
  const refRow = blank(); refRow[11] = ref ? `Ref:${ref}` : "";
  const firmName = "Fixture Network Ltd";
  const firm = blank(); firm[0] = firmName;
  const advOf = {}; (rows || []).forEach((r) => { advOf[r.adviser || "one"] = true; });
  const advNames = Object.keys(advOf).sort().map((k) => "Fixture Adviser " + k[0].toUpperCase() + k.slice(1));
  const byAdv = {};
  (rows || []).forEach((r) => { const k = r.adviser || "one"; (byAdv[k] = byAdv[k] || []).push(r); });
  let gTot = 0, nTot = 0;
  const aoa = [title, refRow, blank(), blank(), blank(), H, firm, blank()];
  Object.keys(byAdv).sort().forEach((k) => {
    const advRow = blank(); advRow[0] = "Fixture Adviser " + k[0].toUpperCase() + k.slice(1);
    aoa.push(advRow);
    byAdv[k].forEach((r) => { aoa.push(line(r)); gTot += Number(r.g || 0); nTot += Number(r.n || 0); });
    const sub = blank(); sub[10] = byAdv[k].length + " item(s)";
    sub[13] = byAdv[k].reduce((s, r) => s + Number(r.g || 0), 0);
    sub[16] = byAdv[k].reduce((s, r) => s + Number(r.n || 0), 0);
    aoa.push(sub);
    aoa.push(blank());
  });
  const totF = blank(); totF[0] = "Total for " + firmName; totF[13] = gTot; totF[16] = nTot;
  aoa.push(totF);
  if (!o.omitStatementTotal) {
    const totS = blank(); totS[0] = "Total for this statement"; totS[10] = (rows || []).length + " item(s)"; totS[13] = gTot; totS[16] = nTot;
    aoa.push(totS);
  }
  aoa.push(blank());
  return aoa;
}
async function importStatement(page, ref, rows, opts) {
  await page.evaluate(({ aoa, fn }) => {
    window.__drop("#recon-file", window.__mkFile(aoa, "Commission Statement (Fixture)", fn));
  }, { aoa: buildStatementAoa(ref, rows, opts || {}), fn: `${ref || "no-ref"}.xlsx` });
  await wait(page, opts && opts.settle || 2200);
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
       §A · parseProcRatesSheet — PURE, called directly with an AoA
       ======================================================================= */
    {
      console.log("\n— §A · parseProcRatesSheet");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const r1 = await page.evaluate(() => parseProcRatesSheet([
        ["junk", "before", "the", "header"],
        ["Lender", "Product Description", "L&G Code", "Stonebridge", "Notes"],
        ["Halifax", "Residential", "HX1", 0.004, ""],
        ["Halifax", "Retention", "HX3", 0.0035, "retention only"],
        ["Skipton Building Society", "Residential", "SK1", 0.0042, ""],
        [null, null, null, null, null],                       // spacer row: no lender, no rate
        ["Blank Rate Lender", "Further advance", "ZZ1", "", ""],       // skip: blank rate
        ["Bad Rate Lender", "Nonsense", "ZZ2", "not a number", ""],    // skip: non-numeric
        ["Over Range Lender", "X", "ZZ4", 1.5, ""],                    // skip: out of [0,1]
        ["Under Range Lender", "X", "ZZ5", -0.1, ""],                  // skip: negative
        ["Zero Lender", "Further advance", "ZZ3", 0, ""],              // kept: explicit nought
      ]));
      eq("§A1 · header row found at index 1 (scan past junk rows)", r1.headerRow, 1);
      eq("§A2 · 4 rows kept (Halifax×2 + Skipton + the explicit zero)", r1.rows.length, 4);
      eq("§A3 · 4 skipped (blank / non-numeric / >1 / <0)", r1.skipped, 4);
      eq("§A4 · `usable` excludes the explicit-zero row (3, not 4)", r1.usable, 3);
      ok("§A5 · the spacer row (no lender, no rate) is neither kept nor counted as skipped (4+4=8, leaving exactly the 1 spacer of 9 data rows unaccounted)", r1.rows.length + r1.skipped === 8, { rows: r1.rows.length, skipped: r1.skipped });
      ok("§A6 · the explicit-zero row IS in `rows`", r1.rows.some((x) => x.lender === "Zero Lender" && x.rate === 0));
      ok("§A7 · Skipton row's product/lg_code/notes columns mapped by name", r1.rows.some((x) => x.lender === "Skipton Building Society" && x.product === "Residential" && x.lg_code === "SK1"));

      const r2 = await page.evaluate(() => parseProcRatesSheet([["Lender", "Rate"], ["Nationwide", 0.005]]));
      ok("§A8 · header fallback: bare \"Rate\" column used when \"Stonebridge\" is absent", r2.rows.length === 1 && r2.rows[0].rate === 0.005, r2);

      const r3 = await page.evaluate(() => parseProcRatesSheet([["Lender", "Stonebridge", "Rate", "Proc Fee"], ["X", 0.001, 0.002, 0.003]]));
      eq("§A9 · header preference order: \"Stonebridge\" wins over \"Rate\"/\"Proc Fee\" when all three are present", r3.rows[0].rate, 0.001);

      const r4 = await page.evaluate(() => parseProcRatesSheet([["Product", "Rate"], ["X", 0.001]]));
      eq("§10 · no \"Lender\" cell anywhere → headerRow -1, missing [\"lender\"]", r4.headerRow, -1);
      eq("§A11 · missing reports the lender column", r4.missing, ["lender"]);

      const r5 = await page.evaluate(() => parseProcRatesSheet([["Lender", "Notes"], ["X", "no rate column at all"]]));
      ok("§A12 · a Lender column with no Stonebridge/Rate/Proc-Fee column → missing includes \"Stonebridge\"", r5.missing.indexOf("Stonebridge") >= 0, r5.missing);

      ok("§A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §B · parseStatementSheet — PURE, called directly with an AoA
       ======================================================================= */
    {
      console.log("\n— §B · parseStatementSheet");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      const H = ["Date", "Tran Type \nDesc", "Addressee", "Provider", "Account \nnumber", "Opp ID", null,
        "File Review Client Name", "Reason", "Policy \nType", "Policy Group", null, "Premium",
        "Banked\n(Gross)", null, null, "Banked\n(Net)"];
      const blank = () => new Array(17).fill(null);

      const b1 = await page.evaluate((H0) => {
        const blank = () => new Array(17).fill(null);
        const title = blank(); title[0] = "Commission statement";
        const spacer1 = blank();
        const refRow = blank(); refRow[9] = "Ref:BP-1048";          // buried in row 2, not row 0
        const spacer2 = blank();
        const header = H0.slice();
        const firm = blank(); firm[0] = "Fixture Network Ltd";
        const advH = blank(); advH[0] = "Fixture Adviser One";
        const data1 = blank();
        data1[0] = new Date(2026, 6, 21); data1[1] = "Commission receipt"; data1[2] = "Mr Testcase";
        data1[3] = "Halifax"; data1[4] = "ACC-1"; data1[5] = 900001; data1[9] = "Mortgage"; data1[10] = "Mortgage";
        data1[12] = 1500; data1[13] = "£1,011.50"; data1[16] = "(914.54)";     // accounting-format NEGATIVE net
        const data2 = blank();
        data2[0] = new Date(2026, 6, 22); data2[1] = "Commission takeback"; data2[2] = "Mrs Reversed";
        data2[3] = "Nationwide"; data2[4] = "ACC-2"; data2[9] = "Mortgage"; data2[10] = "Mortgage";
        data2[13] = -725.40; data2[16] = -652.86;                    // plain numeric negative
        const sub = blank(); sub[10] = "2 item(s)"; sub[13] = 286.1; sub[16] = 261.68;
        const totF = blank(); totF[0] = "Total for Fixture Network Ltd"; totF[13] = 286.1; totF[16] = 261.68;
        const totS = blank(); totS[0] = "Total for this statement"; totS[13] = 286.1; totS[16] = 261.68;
        return parseStatementSheet([title, spacer1, refRow, spacer2, blank(), header, firm, blank(), advH, data1, data2, sub, blank(), totF, totS], "Sheet1");
      }, H);
      eq("§B1 · Ref: found scanning down to row 2, not just row 0", b1.ref, "BP-1048");
      eq("§B2 · header row detected via newline-bearing header text", b1.headerRow, 5);
      eq("§B3 · 2 data lines parsed", b1.lines.length, 2);
      ok("§B4 · £1,011.50 (currency + comma) parsed to 1011.5", Math.abs(b1.lines[0].banked_gross - 1011.5) < 1e-9, b1.lines[0].banked_gross);
      ok("§B5 · (914.54) accounting-format parsed to -914.54", Math.abs(b1.lines[0].banked_net - (-914.54)) < 1e-9, b1.lines[0].banked_net);
      ok("§B6 · plain numeric -725.4 parsed as a negative (takeback gross)", b1.lines[1].banked_gross === -725.4, b1.lines[1].banked_gross);
      ok("§B7 · both lines attributed to the one adviser group header", b1.lines.every((l) => l.adviser_name === "Fixture Adviser One"), b1.lines.map((l) => l.adviser_name));
      eq("§B8 · advisers[] lists exactly that one name (firm row excluded)", b1.advisers, ["Fixture Adviser One"]);
      ok("§B9 · the \"2 item(s)\" subtotal row produced no data line", b1.lines.length === 2);
      ok("§B10 · totals taken from \"Total for this statement\" (totalsFromRow)", b1.totalsFromRow && b1.gross === 286.1 && b1.net === 261.68, b1);

      /* Firm row vs adviser row: the pre-scan of "Total for X" trailers is what
         tells a firm group header apart from an adviser one. */
      const b2 = await page.evaluate((H0) => {
        const blank = () => new Array(17).fill(null);
        const header = H0.slice();
        const firm = blank(); firm[0] = "Acme Network";
        const d = blank(); d[0] = new Date(2026, 0, 5); d[1] = "Commission receipt"; d[9] = "Mortgage"; d[10] = "Mortgage"; d[13] = 100; d[16] = 90;
        const totF = blank(); totF[0] = "Total for Acme Network"; totF[13] = 100; totF[16] = 90;
        const totS = blank(); totS[0] = "Total for this statement"; totS[13] = 100; totS[16] = 90;
        return parseStatementSheet([header, firm, d, totF, totS], "Sheet1");
      }, H);
      eq("§B11 · a firm-row line (adviser reset to \"\") has adviser_name \"\"", b2.lines[0].adviser_name, "");
      eq("§B12 · the firm name never lands in advisers[]", b2.advisers, []);

      /* Missing the "Total for this statement" row entirely: totals summed. */
      const b3 = await page.evaluate((H0) => {
        const blank = () => new Array(17).fill(null);
        const header = H0.slice();
        const firm = blank(); firm[0] = "Acme Network";
        const d1 = blank(); d1[0] = new Date(2026, 0, 5); d1[1] = "Commission receipt"; d1[9] = "Mortgage"; d1[10] = "Mortgage"; d1[13] = 100; d1[16] = 90;
        const d2 = blank(); d2[0] = new Date(2026, 0, 6); d2[1] = "Commission receipt"; d2[9] = "Mortgage"; d2[10] = "Mortgage"; d2[13] = 50; d2[16] = 45;
        return parseStatementSheet([header, firm, d1, d2], "Sheet1");     // no trailer at all
      }, H);
      ok("§B13 · no statement-total row → totalsFromRow is false", !b3.totalsFromRow, b3.totalsFromRow);
      ok("§B14 · … and gross/net are SUMMED from the lines (150 / 135)", b3.gross === 150 && b3.net === 135, b3);

      /* Missing required columns. */
      const b4 = await page.evaluate(() => parseStatementSheet([["not", "date", "here"]], "Sheet1"));
      eq("§B15 · no \"Date\" first-cell row anywhere → missing [\"Date\"]", b4.missing, ["Date"]);
      const b5 = await page.evaluate(() => parseStatementSheet([["Date", "Tran Type", "Addressee"]], "Sheet1"));
      ok("§B16 · a Date header with no Policy Group column → missing includes policy_group", b5.missing.indexOf("policy_group") >= 0, b5.missing);

      /* statementDate = the MAX line date. */
      const b6 = await page.evaluate((H0) => {
        const blank = () => new Array(17).fill(null);
        const header = H0.slice();
        const firm = blank(); firm[0] = "Acme Network";
        const early = blank(); early[0] = new Date(2026, 2, 1); early[1] = "Commission receipt"; early[9] = "Mortgage"; early[10] = "Mortgage"; early[13] = 10; early[16] = 9;
        const late = blank(); late[0] = new Date(2026, 2, 15); late[1] = "Commission receipt"; late[9] = "Mortgage"; late[10] = "Mortgage"; late[13] = 10; late[16] = 9;
        return parseStatementSheet([header, firm, late, early], "Sheet1");   // out of order
      }, H);
      eq("§B17 · statementDate is the MAX line date regardless of row order", b6.statementDate, "2026-03-15");

      ok("§B · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §C · the pure matcher — r44Surnames, r44LenderMatch, r44LineKind,
       r44ReversalPairs, r44ExpectedFee/r44FeeVerdict, suggestStatementMatches
       ======================================================================= */
    {
      console.log("\n— §C · pure matcher functions (page.evaluate on the shipped functions, synthetic data)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      /* --- r44Surnames --- */
      eq("§C1 · \"Mr Hawkins & Miss Haynes-Flood\" → two surnames, hyphen KEPT as one", await page.evaluate(() => r44Surnames("Mr Hawkins & Miss Haynes-Flood")), ["hawkins", "haynes-flood"]);
      eq("§C2 · \"Mr A & Mrs B-C\" → the single-letter surname \"a\" is dropped, hyphenated one kept", await page.evaluate(() => r44Surnames("Mr A & Mrs B-C")), ["b-c"]);
      eq("§C3 · \"Smith, Jones\" → comma-separated, two surnames", await page.evaluate(() => r44Surnames("Smith, Jones")), ["smith", "jones"]);
      eq("§C4 · a bare title with no name (\"Mr\") → no surname, not \"mr\"", await page.evaluate(() => r44Surnames("Mr & Mrs Ashdown-Pryce")), ["ashdown-pryce"]);
      eq("§C5 · dotted initials collapse to spaces (\"A.N. Other\")", await page.evaluate(() => r44Surnames("A.N. Other")), ["other"]);
      eq("§C6 · duplicate surname across the two people is de-duplicated", await page.evaluate(() => r44Surnames("Mr Smith & Mrs Smith")), ["smith"]);
      eq("§C7 · empty addressee → []", await page.evaluate(() => r44Surnames("")), []);

      /* --- r44LenderMatch --- */
      ok("§C8 · \"Barclays Bank PLC\" ~ \"Barclays\"", await page.evaluate(() => r44LenderMatch("Barclays Bank PLC", "Barclays")));
      ok("§C9 · \"Skipton Building Society\" ~ \"Skipton BS\"", await page.evaluate(() => r44LenderMatch("Skipton Building Society", "Skipton BS")));
      ok("§C10 · unrelated lenders do not match", !(await page.evaluate(() => r44LenderMatch("Halifax", "Nationwide"))));
      ok("§C11 · short (<3 char) keys require an EXACT match, not containment", !(await page.evaluate(() => r44LenderMatch("BM Solutions", "ABM Corp"))));
      ok("§C12 · … but an exact short-key match still counts (\"BM Solutions\" = \"BM\")", await page.evaluate(() => r44LenderMatch("BM Solutions", "BM")));
      ok("§C13 · empty either side never matches", !(await page.evaluate(() => r44LenderMatch("", "Halifax"))));

      /* --- r44LineKind --- */
      const kinds = await page.evaluate(() => ({
        takeback1: r44LineKind({ tran_type: "Commission takeback", policy_group: "Mortgage", addressee: "X" }),
        takeback2: r44LineKind({ tran_type: "Claw back adjustment", policy_group: "Mortgage", addressee: "X" }),
        renewalByType: r44LineKind({ tran_type: "Renewal commission", policy_group: "Life/Protection", addressee: "" }),
        renewalByVarious: r44LineKind({ tran_type: "Commission receipt", policy_group: "Life/Protection", addressee: "", reason: "VARIOUS" }),
        mortgage: r44LineKind({ tran_type: "Commission receipt", policy_group: "Mortgage", addressee: "X" }),
        mortgageCaseInsensitive: r44LineKind({ tran_type: "x", policy_group: "MORTGAGE", addressee: "X" }),
        protection: r44LineKind({ tran_type: "Commission receipt", policy_group: "Life/Protection", addressee: "X" }),
        protectionNoAddressee: r44LineKind({ tran_type: "Commission receipt", policy_group: "Life/Protection", addressee: "" }),
        other: r44LineKind({ tran_type: "Adjustment", policy_group: "", addressee: "X" }),
      }));
      eq("§C14 · \"Commission takeback\" → takeback regardless of policy group", kinds.takeback1, "takeback");
      eq("§C15 · \"Claw back adjustment\" → takeback", kinds.takeback2, "takeback");
      eq("§C16 · tran_type containing \"renewal\" → renewal", kinds.renewalByType, "renewal");
      eq("§C17 · no addressee + reason \"VARIOUS\" → renewal (the network's trailer)", kinds.renewalByVarious, "renewal");
      eq("§C18 · policy_group === \"Mortgage\" → mortgage", kinds.mortgage, "mortgage");
      eq("§C19 · policy_group comparison is case-insensitive", kinds.mortgageCaseInsensitive, "mortgage");
      eq("§C20 · life/protection group WITH an addressee → protection", kinds.protection, "protection");
      eq("§C21 · life/protection group with NO addressee (and no VARIOUS reason) → other, not protection", kinds.protectionNoAddressee, "other");
      eq("§C22 · everything else → other", kinds.other, "other");

      /* --- r44ReversalPairs --- */
      const pairs = await page.evaluate(() => {
        const lines = [
          { account_number: "AAA", tran_type: "Commission takeback", policy_group: "Mortgage", addressee: "X", banked_gross: -500 },   // 0
          { account_number: "AAA", tran_type: "Commission receipt", policy_group: "Mortgage", addressee: "X", banked_gross: 500 },      // 1: exact pair for 0
          { account_number: "BBB", tran_type: "Commission takeback", policy_group: "Mortgage", addressee: "X", banked_gross: -200 },    // 2
          { account_number: "CCC", tran_type: "Commission takeback", policy_group: "Mortgage", addressee: "X", banked_gross: -300 },    // 3: mismatched account, no partner
          { account_number: "DDD", tran_type: "Commission takeback", policy_group: "Mortgage", addressee: "X", banked_gross: 500 },     // 4: POSITIVE takeback gross — never initiates a pair
          { account_number: "DDD", tran_type: "Commission receipt", policy_group: "Mortgage", addressee: "X", banked_gross: -500 },     // 5
          { account_number: "EEE", tran_type: "Commission takeback", policy_group: "Mortgage", addressee: "X", banked_gross: -1000 },   // 6: 5% off — too far to pair
          { account_number: "EEE", tran_type: "Commission receipt", policy_group: "Mortgage", addressee: "X", banked_gross: 950 },      // 7
          { account_number: "FFF", tran_type: "Commission takeback", policy_group: "Mortgage", addressee: "X", banked_gross: -400 },    // 8: candidate partner is ALSO a takeback — excluded
          { account_number: "FFF", tran_type: "Commission takeback", policy_group: "Mortgage", addressee: "X", banked_gross: 400 },     // 9
        ];
        return r44ReversalPairs(lines);
      });
      eq("§C23 · exact same-account opposite-sign pair (0↔2)", pairs[0], 1);
      eq("§C24 · … and the reverse mapping is set too", pairs[1], 0);
      ok("§C25 · mismatched account (line 3) pairs with nothing", pairs[3] === undefined);
      ok("§C26 · a takeback whose OWN gross is positive never initiates a pair (line 4)", pairs[4] === undefined, pairs[4]);
      ok("§C27 · amounts 5% apart are outside the tight tolerance (line 6)", pairs[6] === undefined, pairs[6]);
      ok("§C28 · a partner that is ITSELF a takeback is excluded (line 8/9 do not pair)", pairs[8] === undefined && pairs[9] === undefined, [pairs[8], pairs[9]]);

      /* --- r44ExpectedFee / r44FeeVerdict --- */
      const exp = await page.evaluate(() => ({
        none_noLoan: r44ExpectedFee("Halifax", 0, [{ lender: "Halifax", rate: 0.004 }]),
        none_noRates: r44ExpectedFee("Halifax", 200000, []),
        none_zeroRateOnly: r44ExpectedFee("Halifax", 200000, [{ lender: "Halifax", rate: 0 }]),
        range: r44ExpectedFee("Halifax", 200000, [{ lender: "Halifax", rate: 0.003 }, { lender: "Halifax Bank PLC", rate: 0.005 }, { lender: "Nationwide", rate: 0.01 }]),
      }));
      ok("§C29 · no loan amount → null", exp.none_noLoan === null);
      ok("§C30 · no rate card → null", exp.none_noRates === null);
      ok("§C31 · an explicit-zero rate is excluded from the expected-fee calc entirely", exp.none_zeroRateOnly === null, exp.none_zeroRateOnly);
      eq("§C32 · lo/hi = min/max × loan across every lender-matching rate row", [exp.range.expectedLo, exp.range.expectedHi], [600, 1000]);

      const verdicts = await page.evaluate(() => {
        const e = { expectedLo: 150, expectedHi: 150, rateCount: 1 };   // ±10% → [135, 165]
        return {
          atHi: r44FeeVerdict(165, e), overHi: r44FeeVerdict(165.01, e),
          atLo: r44FeeVerdict(135, e), underLo: r44FeeVerdict(134.99, e),
          noExp: r44FeeVerdict(999, null),
        };
      });
      eq("§C33 · gross exactly at the +10% bound → within", verdicts.atHi.verdict, "within");
      ok("§C34 · one penny over → over, delta measured from the RAW expectedHi (not the tolerant bound)", verdicts.overHi.verdict === "over" && Math.abs(verdicts.overHi.delta - 15.01) < 1e-9, verdicts.overHi);
      eq("§C35 · gross exactly at the -10% bound → within", verdicts.atLo.verdict, "within");
      ok("§C36 · one penny under → under, delta from the raw expectedLo", verdicts.underLo.verdict === "under" && Math.abs(verdicts.underLo.delta - 15.01) < 1e-9, verdicts.underLo);
      ok("§C37 · no expected-fee object → null verdict", verdicts.noExp === null);

      /* --- suggestStatementMatches: admission, scoring, confidence, ties --- */
      const sugg = await page.evaluate(() => {
        const cases = [
          { id: "surnameOnly", lender: "Halifax", loan_amount: 200000, proc_fee: 800, proc_fee_paid_at: null, clients: { last_name: "Doyle" } },
          { id: "acctOnly", lender: "Nationwide", loan_amount: 100000, proc_fee: 0, proc_fee_paid_at: null, clients: { last_name: "NoMatch" } },
          { id: "unrelated", lender: "TSB", loan_amount: 50000, proc_fee: 0, proc_fee_paid_at: "2020-01-01T12:00:00Z", clients: { last_name: "Someone" } },
          { id: "tieA", lender: "Nobody", loan_amount: 0, proc_fee: 0, proc_fee_paid_at: null, clients: { last_name: "Tiewell" } },
          { id: "tieB", lender: "Nobody", loan_amount: 0, proc_fee: 0, proc_fee_paid_at: null, clients: { last_name: "Tiewell" } },
        ];
        const lines = [
          { addressee: "Mr Doyle", provider: "Halifax", account_number: "NEW-1", banked_gross: 790, policy_group: "Mortgage", tran_type: "Commission receipt" },   // surname+lender+amount → high
          { addressee: "Mrs Nobody Here", provider: "X", account_number: "HIST-1", banked_gross: 300, policy_group: "Mortgage", tran_type: "Commission takeback" }, // account-history ONLY (no surname, no lender)
          { addressee: "Mr Tiewell", provider: "Whoever", account_number: "TIE-1", banked_gross: 1, policy_group: "Mortgage", tran_type: "Commission receipt" },    // ties between tieA/tieB
          { addressee: "", provider: "Legal & General", account_number: "REN-1", banked_gross: 5, policy_group: "Life/Protection", tran_type: "Renewal commission" }, // renewal: never scored even though "provider" is irrelevant
        ];
        const priorLines = [{ account_number: "HIST-1", matched_case_id: "acctOnly" }];
        const rates = [{ lender: "Halifax", rate: 0.004 }];
        return suggestStatementMatches(lines, cases, priorLines, rates);
      });
      ok("§C38 · surname+lender+amount all hit → confidence high", sugg[0].suggested === "surnameOnly" && sugg[0].confidence === "high", sugg[0]);
      eq("§C39 · score = lender(2) + amount(2) + unpaid(1)", sugg[0].score, 5);
      ok("§C40 · account-history admits a case with NO surname/lender match at all", sugg[1].suggested === "acctOnly", sugg[1]);
      ok("§C41 · account-history alone → confidence high (score includes acctHist)", sugg[1].confidence === "high" && sugg[1].why.indexOf("account history") >= 0, sugg[1]);
      ok("§C42 · the unrelated/no-admission case never appears as a candidate for line 0 or 1", !sugg[0].candidates.some((c) => c.id === "unrelated") && !sugg[1].candidates.some((c) => c.id === "unrelated"));
      ok("§C43 · a tie on the top score → confidence LOW even though a case was picked", sugg[2].suggested != null && sugg[2].confidence === "low", sugg[2]);
      ok("§C44 · the tie is recorded in the note", /\(tied\)/.test(sugg[2].note), sugg[2].note);
      eq("§C45 · a renewal line is never scored at all (R44_MATCHABLE gate)", sugg[3], { index: 3, kind: "renewal", suggested: null, confidence: null, score: 0, why: [], candidates: [], expected: null, pairedWith: null, note: "" });

      ok("§C · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §D · owner-only gating
       ======================================================================= */
    {
      console.log("\n— §D · owner-only gating — p4 sees both panels; p1/p2 see neither");
      const p4 = await newPage(browser, "p4");
      const errBefore4 = (p4.__err || []).length;
      await gotoMoney(p4);
      ok("§D1 · #money-recon-panel visible to the owner", await p4.isVisible("#money-recon-panel"));
      ok("§D2 · #money-procrates-panel visible to the owner", await p4.isVisible("#money-procrates-panel"));
      const st0 = (await p4.textContent("#procrates-status")) || "";
      ok("§D3 · empty rate-card status names the consequence", /No rates uploaded yet/.test(st0), st0);
      const list0 = (await p4.textContent("#recon-statements")) || "";
      ok("§D4 · empty statement list says nothing imported yet", /No commission statement imported yet/.test(list0), list0.slice(0, 100));
      ok("§D5 · #recon-review starts hidden", await p4.evaluate(() => document.querySelector("#recon-review").classList.contains("hidden")));
      ok("§D6 · DOM order: advisers panel → recon panel → procrates panel", await p4.evaluate(() => {
        const a = document.querySelector("#money-advisers-panel"), r = document.querySelector("#money-recon-panel"), p = document.querySelector("#money-procrates-panel");
        return !!(a.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(r.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
      }));
      ok("§D · owner console clean on Monday money", noNewErr(p4, errBefore4), JSON.stringify(p4.__err));

      for (const persona of ["p1", "p2"]) {
        const page = await newPage(browser, persona);
        const errBefore = (page.__err || []).length;
        await gotoMoney(page, 1200);
        ok(`§D7 · ${persona}: #money-recon-panel not visible via nav()`, !(await page.isVisible("#money-recon-panel")));
        ok(`§D8 · ${persona}: #money-procrates-panel not visible via nav()`, !(await page.isVisible("#money-procrates-panel")));
        /* nav() redirects a non-owner off the page entirely; force the renderer
           to run so the panels' OWN self-gate (belt-and-braces) is proven too. */
        const forced = await page.evaluate(async () => {
          document.querySelector("#page-money").classList.remove("hidden");
          await window.loadMoneyPage();
          return {
            bodyHidden: document.querySelector("#money-body").classList.contains("hidden"),
            reconHidden: document.querySelector("#money-recon-panel").classList.contains("hidden"),
            ratesHidden: document.querySelector("#money-procrates-panel").classList.contains("hidden"),
            status: (document.querySelector("#procrates-status") || {}).textContent,
            list: (document.querySelector("#recon-statements") || {}).innerHTML,
            deniedShown: !document.querySelector("#money-denied").classList.contains("hidden"),
          };
        });
        ok(`§D9 · ${persona}: forced loadMoneyPage() still hides #money-body`, forced.bodyHidden, forced);
        ok(`§D10 · ${persona}: both R44 panels self-gate to .hidden`, forced.reconHidden && forced.ratesHidden, forced);
        ok(`§D11 · ${persona}: no rate-card or statement content left in the DOM`, !forced.status && !forced.list, forced);
        ok(`§D12 · ${persona}: the denied notice is shown`, forced.deniedShown);
        const reads = await page.evaluate(async () => {
          const a = await window.__mockDb.from("proc_rates").select("*");
          const b = await window.__mockDb.from("commission_statements").select("*");
          const c = await window.__mockDb.from("commission_lines").select("*");
          const w = await window.__mockDb.from("proc_rates").insert({ lender: "X", rate: 0.004 });
          return { a: (a.data || []).length, b: (b.data || []).length, c: (c.data || []).length, wcode: w.error && w.error.code };
        });
        ok(`§D13 · ${persona}: reads come back EMPTY on all three tables`, reads.a === 0 && reads.b === 0 && reads.c === 0, reads);
        ok(`§D14 · ${persona}: a write is refused 42501`, reads.wcode === "42501", reads);
        ok(`§D · ${persona} console clean`, noNewErr(page, errBefore), JSON.stringify(page.__err));
        await page.close();
      }
      await p4.close();
    }

    /* =======================================================================
       §E · proc-rate card upload
       ======================================================================= */
    let p4;      // the long-lived owner page carried through §E-§I
    let REF1;    // the first statement's ref — referenced again from §H/§I
    {
      console.log("\n— §E · proc-rate card upload (real .xlsx via addScriptTag)");
      p4 = await newPage(browser, "p4");
      await bootXlsx(p4);
      await gotoMoney(p4);
      const errBefore = (p4.__err || []).length;

      await p4.evaluate(() => {
        const rows = [["Lender", "Product Description", "L&G Code", "Stonebridge", "Notes"],
          ["Halifax", "Residential", "HX1", 0.004, ""],
          ["Nationwide", "All products", "NW1", 0.0035, ""],
          ["Skipton Building Society", "Residential", "SK1", 0.0042, ""],
          ["Blank Rate Lender", "Further advance", "ZZ1", "", ""],
          ["Bad Rate Lender", "Nonsense", "ZZ2", "not a number", ""],
          ["Zero Lender", "Further advance", "ZZ3", 0, ""]];
        window.__drop("#procrates-file", window.__mkFile(rows, "Sheet1", "rates-v1.xlsx"));
      });
      await wait(p4, 1500);
      const st1 = (await p4.textContent("#procrates-status")) || "";
      ok("§E1 · status line names the count/date/label", /4 rates/.test(st1) && /rates-v1\.xlsx/.test(st1), st1);
      const rows1 = await p4.evaluate(() => window.__mock.db.proc_rates.map((r) => ({ l: r.lender, r: r.rate, lbl: r.effective_label })));
      eq("§E2 · 4 rows stored (2 skipped, the explicit nought kept)", rows1.length, 4);
      ok("§E3 · effective_label = the uploaded filename on every row", rows1.every((r) => r.lbl === "rates-v1.xlsx"), rows1);
      ok("§E4 · the explicit nought made it in", rows1.some((r) => r.r === 0));

      await p4.evaluate(() => {
        window.__drop("#procrates-file", window.__mkFile(
          [["Lender", "Stonebridge"], ["Halifax", 0.004], ["Barclays", 0.0038]], "Sheet1", "rates-v2.xlsx"));
      });
      await wait(p4, 1500);
      const rows2 = await p4.evaluate(() => window.__mock.db.proc_rates.map((r) => r.lender));
      eq("§E5 · second upload REPLACES the card WHOLESALE (2 rows, old ones gone)", rows2.sort(), ["Barclays", "Halifax"]);

      ok("§E · no console errors", noNewErr(p4, errBefore), JSON.stringify(p4.__err));
    }

    /* =======================================================================
       Fixture cases for §F-§I, inserted straight into the mock.
       ======================================================================= */
    const A = await mkFixtureCase(p4, "Doyle" + tag(), { case: { lender: "Halifax", loan_amount: 200000, proc_fee: 800 } });
    const B = await mkFixtureCase(p4, "Ashcroft" + tag(), { case: { lender: "Nationwide", loan_amount: 150000, proc_fee: 600 } });
    const C = await mkFixtureCase(p4, "Fenwick" + tag(), { case: { lender: "Aviva", loan_amount: null, proc_fee: null } });
    const Dc = await mkFixtureCase(p4, "Marchetti" + tag(), { case: { lender: "Skipton", loan_amount: 100000, proc_fee: 900 } });   // fee-fix, UNTICKED
    const Fc = await mkFixtureCase(p4, "Whitmore" + tag(), { case: { lender: "TSB", loan_amount: 80000, proc_fee: 0 } });            // no proc fee recorded yet
    const Gc = await mkFixtureCase(p4, "Pemberton" + tag(), { case: { lender: "Barclays", loan_amount: 120000, proc_fee: 1000 } });  // within £1 — no fee-fix checkbox
    const Ec = await mkFixtureCase(p4, "Whittaker" + tag(), { case: { lender: "Skipton", loan_amount: 100000, proc_fee: 900 } });    // fee-fix, TICKED

    /* =======================================================================
       §F · statement import
       ======================================================================= */
    {
      console.log("\n— §F · statement import (real .xlsx)");
      const errBefore = (p4.__err || []).length;
      REF1 = "TEST-" + tag();
      await importStatement(p4, REF1, [
        { d: new Date(2026, 6, 21), tt: "Commission receipt", addr: "Mr " + A.last, prov: "Halifax", acct: "ACC-A", opp: 900001, ptype: "Mortgage", pgroup: "Mortgage", prem: 1500, g: 800, n: 720, adviser: "one" },
        { d: new Date(2026, 6, 21), tt: "Commission takeback", addr: "Mrs " + B.last, prov: "Nationwide", acct: "ACC-B", opp: 900002, ptype: "Mortgage", pgroup: "Mortgage", prem: 1200, g: -600, n: -540, adviser: "one" },
        { d: new Date(2026, 5, 30), tt: "Commission receipt", addr: "Mrs " + B.last, prov: "Nationwide", acct: "ACC-B", opp: 900002, ptype: "Mortgage", pgroup: "Mortgage", prem: 1200, g: 600, n: 540, adviser: "one" },
        { d: new Date(2026, 6, 22), tt: "Commission receipt", addr: "Mr & Mrs " + C.last, prov: "Aviva", acct: "POL-C", opp: 900003, ptype: "Level Term", pgroup: "Life/Protection", prem: 42.5, g: 150, n: 135, adviser: "one" },
        { d: new Date(2026, 6, 22), tt: "Commission receipt", addr: "Miss " + Dc.last, prov: "Skipton", acct: "ACC-D", opp: 900004, ptype: "Mortgage", pgroup: "Mortgage", prem: 1000, g: 950, n: 855, adviser: "two" },
        { d: new Date(2026, 6, 23), tt: "Commission receipt", addr: "Mr " + Fc.last, prov: "TSB", acct: "ACC-F", opp: 900005, ptype: "Mortgage", pgroup: "Mortgage", prem: 800, g: 400, n: 360, adviser: "two" },
        { d: new Date(2026, 6, 23), tt: "Commission receipt", addr: "Mr " + Gc.last, prov: "Barclays", acct: "ACC-G", opp: 900006, ptype: "Mortgage", pgroup: "Mortgage", prem: 1200, g: 1000.5, n: 900, adviser: "two" },
        { d: new Date(2026, 6, 24), tt: "Renewal commission", addr: "", prov: "Legal & General", acct: "POL-REN-1", reason: "VARIOUS", pgroup: "Life/Protection", g: 3.25, n: 2.93, adviser: "one" },
        { d: new Date(2026, 6, 24), tt: "Renewal commission", addr: "", prov: "Legal & General", acct: "POL-REN-2", reason: "VARIOUS", pgroup: "Life/Protection", g: 1.75, n: 1.58, adviser: "one" },
        { d: new Date(2026, 6, 25), tt: "Adjustment", addr: "", prov: "", acct: "", pgroup: "", g: 0.5, n: 0.5, adviser: "two" },
      ]);
      const imported = await p4.evaluate((ref) => {
        const st = window.__mock.db.commission_statements.filter((s) => s.ref === ref)[0];
        const lines = window.__mock.db.commission_lines.filter((l) => l.statement_id === st.id);
        return { st, lines: lines.map((l) => ({ tt: l.tran_type, acct: l.account_number, g: l.banked_gross, ms: l.match_status, adv: l.adviser_name })) };
      }, REF1);
      ok("§F1 · one statement row with the expected ref", imported.st && imported.st.ref === REF1, imported.st);
      eq("§F2 · 10 lines imported, line_count matches", [imported.lines.length, imported.st.line_count], [10, 10]);
      ok("§F3 · adviser tracked per group, firm row never used as an adviser", imported.lines.every((l) => /Fixture Adviser (One|Two)/.test(l.adv)), imported.lines.map((l) => l.adv));
      ok("§F4 · renewal lines imported as match_status \"na\"", imported.lines.filter((l) => /Renewal/.test(l.tt)).every((l) => l.ms === "na"), imported.lines);
      ok("§F5 · the \"Adjustment\"/other line is also \"na\" (not matchable)", imported.lines.filter((l) => l.tt === "Adjustment").every((l) => l.ms === "na"));
      ok("§F6 · review opens automatically on import", !(await p4.evaluate(() => document.querySelector("#recon-review").classList.contains("hidden"))));

      /* --- duplicate ref --- */
      console.log("   · duplicate ref → 23505");
      await importStatement(p4, REF1, [{ d: new Date(2026, 6, 26), tt: "Commission receipt", addr: "Whoever", prov: "X", acct: "DUP", pgroup: "Mortgage", g: 1, n: 1 }]);
      const dupToast = (await toastText(p4)) || "";
      ok("§F7 · toast names the already-imported ref", new RegExp(`Statement ${REF1} is already imported`).test(dupToast), dupToast);
      const afterDup = await p4.evaluate((ref) => window.__mock.db.commission_statements.filter((s) => s.ref === ref).length, REF1);
      eq("§F8 · still exactly ONE statement row with that ref — no half-import", afterDup, 1);

      /* --- forced line-insert failure: no half-import, statement rolled back --- */
      console.log("   · forced commission_lines insert failure → statement rolled back");
      const before = await p4.evaluate(() => ({ s: window.__mock.db.commission_statements.length, l: window.__mock.db.commission_lines.length }));
      const REF2 = "FAIL-" + tag();
      await p4.evaluate(() => {
        const orig = db.from.bind(db);
        window.__origFrom = orig;
        window.__forceLineFail = true;
        db.from = (t) => {
          const b = orig(t);
          /* r44LoadPriorLines() ALSO calls db.from("commission_lines") — for a
             .select(), before the real bulk .insert() ever happens. The flag
             must only be consumed by an actual insert() call, not merely by
             naming the table, or it gets eaten by that earlier read and the
             real insert sails through untouched. */
          if (t === "commission_lines") {
            const realInsert = b.insert.bind(b);
            b.insert = (rows) => {
              if (window.__forceLineFail) {
                window.__forceLineFail = false;
                return Promise.resolve({ data: null, error: { message: "forced test failure", code: "TESTFAIL" } });
              }
              return realInsert(rows);
            };
          }
          return b;
        };
      });
      await importStatement(p4, REF2, [{ d: new Date(2026, 6, 27), tt: "Commission receipt", addr: "X", prov: "Y", acct: "Z", pgroup: "Mortgage", g: 1, n: 1 }]);
      await p4.evaluate(() => { db.from = window.__origFrom; });
      const failToast = (await toastText(p4)) || "";
      ok("§F9 · toast says the statement lines could not be saved / nothing imported", /statement lines could not be saved.*nothing was imported/i.test(failToast), failToast);
      const after = await p4.evaluate(() => ({ s: window.__mock.db.commission_statements.length, l: window.__mock.db.commission_lines.length }));
      eq("§10 · the half-written statement row is gone (cascade delete) — same statement count as before", after.s, before.s);
      eq("§F11 · … and no orphaned commission_lines either", after.l, before.l);
      const gone = await p4.evaluate((ref) => window.__mock.db.commission_statements.some((s) => s.ref === ref), REF2);
      ok("§F12 · the failed ref is not present at all", !gone);
    }

    /* =======================================================================
       §G · review UI
       ======================================================================= */
    let mortLineId, tbLineId, protLineId, feeFixLineId, unsetFeeLineId, closeFeeLineId;
    {
      console.log("\n— §G · review UI");
      ok("§G1 · mortgage group renders", await p4.isVisible("#recon-group-mortgage"));
      ok("§G2 · takeback group renders", await p4.isVisible("#recon-group-takeback"));
      ok("§G3 · protection group renders", await p4.isVisible("#recon-group-protection"));
      ok("§G4 · renewal group renders", await p4.isVisible("#recon-group-renewal"));
      ok("§G5 · other group renders", await p4.isVisible("#recon-group-other"));
      const revTxt = await p4.textContent("#recon-review");
      ok("§G6 · in-statement reversal (Ashcroft pair) badged \"reversed in-statement\"", /reversed in-statement/.test(revTxt));
      ok("§G7 · renewals aggregated to ONE line per adviser (\"Renewals: 2 lines\")", /Renewals: 2 lines?/.test(revTxt), (revTxt.match(/Renewals:[^<]*/) || [])[0]);
      ok("§G8 · the takeback row carries the .recon-takeback tint class", await p4.evaluate(() => !!document.querySelector("#recon-group-takeback .recon-line.recon-takeback")));

      const lines = await p4.evaluate(() => [...document.querySelectorAll(".recon-line[data-kind]")].map((el) => ({
        id: el.dataset.line, kind: el.dataset.kind,
        addr: el.textContent,
        ticked: !!(el.querySelector(".recon-tick") || {}).checked,
        tickDisabled: !!(el.querySelector(".recon-tick") || {}).disabled,
        confident: /confident/.test((el.querySelector(".recon-suggest") || {}).textContent || ""),
      })));
      const mortA = lines.filter((l) => l.kind === "mortgage" && new RegExp(A.last).test(l.addr))[0];
      mortLineId = mortA.id;
      ok("§G9 · the surname+lender+amount mortgage line is marked confident", mortA.confident, mortA);
      ok("§G10 · … and its checkbox is PRE-TICKED", mortA.ticked, mortA);
      const tbLine = lines.filter((l) => l.kind === "takeback")[0]; tbLineId = tbLine.id;
      const protLine = lines.filter((l) => l.kind === "protection")[0]; protLineId = protLine.id;
      const feeFixLine = lines.filter((l) => l.kind === "mortgage" && new RegExp(Dc.last).test(l.addr))[0]; feeFixLineId = feeFixLine.id;
      const unsetFeeLine = lines.filter((l) => l.kind === "mortgage" && new RegExp(Fc.last).test(l.addr))[0]; unsetFeeLineId = unsetFeeLine.id;
      const closeFeeLine = lines.filter((l) => l.kind === "mortgage" && new RegExp(Gc.last).test(l.addr))[0]; closeFeeLineId = closeFeeLine.id;
      ok("§G11 · every fixture kind resolved a line id", [mortLineId, tbLineId, protLineId, feeFixLineId, unsetFeeLineId, closeFeeLineId].every(Boolean), lines);

      /* re-pick select */
      await p4.evaluate((d) => {
        const sel = document.querySelector(`#recon-pick-${d.id}`);
        sel.value = d.caseId; sel.dispatchEvent(new Event("change", { bubbles: true }));
      }, { id: protLineId, caseId: C.caseId });
      await wait(p4, 400);
      const pickState = await p4.evaluate((id) => reconState.picks[id], protLineId);
      eq("§G12 · re-picking a select updates reconState.picks", pickState, C.caseId);
    }

    /* =======================================================================
       §H · confirm flows
       ======================================================================= */
    {
      console.log("\n— §H · confirm flows");

      /* --- mortgage receipt: dates, legacy columns, note --- */
      const before = await readCase(p4, A.caseId);
      await p4.click(`#recon-confirm-${mortLineId}`);
      await wait(p4, 1400);
      const after = await readCase(p4, A.caseId);
      ok("§H1 · proc_fee_paid_at set to the line's date at LOCAL MIDDAY", /^2026-07-21T12:00:00/.test(after.proc_fee_paid_at), after.proc_fee_paid_at);
      const complete = ["proc_fee", "sols_fee", "broker_fee"].every((amtK, i) => {
        const dtK = ["proc_fee_paid_at", "sols_fee_paid_at", "broker_fee_paid_at"][i];
        return !(Number(after[amtK] || 0) > 0) || !!after[dtK];
      });
      ok("§H2 · legacy fee_status obeys the R13-M2 rule (paid only once every fee w/ an amount is dated)", complete ? after.fee_status === "paid" : after.fee_status === before.fee_status, { complete, before: before.fee_status, after: after.fee_status });
      if (complete) ok("§H3 · legacy fee_paid_at is the LAST of the dated fees", after.fee_paid_at === [after.proc_fee_paid_at, after.sols_fee_paid_at, after.broker_fee_paid_at].filter(Boolean).sort().pop(), after.fee_paid_at);
      const notesA = await notesFor(p4, A.caseId);
      ok("§H4 · case note written naming the statement (\"Proc fee … banked …\")", notesA.some((b) => /^Proc fee .* banked .*/.test(b)), notesA.slice(-2));
      eq("§H5 · proc_fee unchanged (800 already close to the 800 gross)", after.proc_fee, 800);
      ok("§H6 · no clawback task raised for a plain receipt", (await tasksFor(p4, A.caseId)).every((t) => !/^Clawback:/.test(t.title)));

      /* --- fee-fix: case with NO proc fee recorded — always set, regardless of checkbox --- */
      await p4.evaluate((d) => { const s = document.querySelector(`#recon-pick-${d.id}`); if (s) { s.value = d.caseId; s.dispatchEvent(new Event("change", { bubbles: true })); } }, { id: unsetFeeLineId, caseId: Fc.caseId });
      const noteHtml0 = await p4.evaluate((id) => document.querySelector(`.recon-line[data-line="${id}"]`).innerHTML, unsetFeeLineId);
      ok("§H7 · \"no proc fee recorded\" note shown, no fee-fix checkbox (nothing to compare against)", /no proc fee recorded/i.test(noteHtml0) && !/recon-feefix-chk/.test(noteHtml0), noteHtml0.slice(0, 300));
      await p4.click(`#recon-confirm-${unsetFeeLineId}`);
      await wait(p4, 1200);
      const fAfter = await readCase(p4, Fc.caseId);
      eq("§H8 · proc_fee auto-set to the banked gross (400) when the case had none", fAfter.proc_fee, 400);

      /* --- fee-fix: CLOSE match (≤£1 diff) — no checkbox at all, amount left alone --- */
      await p4.evaluate((d) => { const s = document.querySelector(`#recon-pick-${d.id}`); if (s) { s.value = d.caseId; s.dispatchEvent(new Event("change", { bubbles: true })); } }, { id: closeFeeLineId, caseId: Gc.caseId });
      const noteHtml1 = await p4.evaluate((id) => document.querySelector(`.recon-line[data-line="${id}"]`).innerHTML, closeFeeLineId);
      ok("§H9 · a ≤£1 delta (1000 vs 1000.50) shows NO fee-fix note/checkbox at all", !/recon-feefix|no proc fee recorded/i.test(noteHtml1), noteHtml1.slice(0, 300));
      await p4.click(`#recon-confirm-${closeFeeLineId}`);
      await wait(p4, 1200);
      const gAfter = await readCase(p4, Gc.caseId);
      eq("§H10 · proc_fee stays at the case's original 1000 (not nudged to 1000.50)", gAfter.proc_fee, 1000);
      ok("§H11 · … but the date is still stamped", !!gAfter.proc_fee_paid_at);

      /* --- fee-fix: FAR match, checkbox left UNTICKED (default) — case amount untouched --- */
      await p4.evaluate((d) => { const s = document.querySelector(`#recon-pick-${d.id}`); if (s) { s.value = d.caseId; s.dispatchEvent(new Event("change", { bubbles: true })); } }, { id: feeFixLineId, caseId: Dc.caseId });
      const noteHtml2 = await p4.evaluate((id) => document.querySelector(`.recon-line[data-line="${id}"]`).innerHTML, feeFixLineId);
      ok("§H12 · a >£1 delta (900 vs 950) DOES show the fee-fix checkbox", /recon-feefix-chk/.test(noteHtml2), noteHtml2.slice(0, 300));
      const checkedByDefault = await p4.evaluate((id) => { const el = document.querySelector(`#recon-feefix-${id}`); return el ? el.checked : null; }, feeFixLineId);
      ok("§H13 · the fee-fix checkbox is OFF by default", checkedByDefault === false, checkedByDefault);
      await p4.click(`#recon-confirm-${feeFixLineId}`);
      await wait(p4, 1200);
      const dAfter = await readCase(p4, Dc.caseId);
      eq("§H14 · UNticked → case proc_fee stays at 900 (network's 950 not applied)", dAfter.proc_fee, 900);
      ok("§H15 · … but the date is still stamped regardless", !!dAfter.proc_fee_paid_at);

      /* --- paired takeback: reversed inside the same statement — one net note,
         no task. This has to run while REF1's review is STILL the open one
         (tbLineId/protLineId were captured off REF1's DOM in §G) — hence
         ahead of the REF3 import just below, which would replace reconState
         and strand both ids against a review that no longer contains them. --- */
      await p4.evaluate((d) => { const s = document.querySelector(`#recon-pick-${d.id}`); if (s) { s.value = d.caseId; s.dispatchEvent(new Event("change", { bubbles: true })); } }, { id: tbLineId, caseId: B.caseId });
      const bBefore = await readCase(p4, B.caseId);
      await p4.click(`#recon-confirm-${tbLineId}`);
      await wait(p4, 1400);
      const bAfter = await readCase(p4, B.caseId);
      ok("§H17 · a takeback confirm never sets/changes the paid date", bAfter.proc_fee_paid_at === bBefore.proc_fee_paid_at, { before: bBefore.proc_fee_paid_at, after: bAfter.proc_fee_paid_at });
      const notesB = await notesFor(p4, B.caseId);
      ok("§H18 · reversal pair → ONE \"net £0\" note", notesB.some((b) => /taken back and re-banked within the same statement.*net £0/.test(b)), notesB.slice(-2));
      ok("§H19 · … and no clawback task", (await tasksFor(p4, B.caseId)).every((t) => !/^Clawback:/.test(t.title)));
      const bothHalves = await p4.evaluate(() => window.__mock.db.commission_lines.filter((l) => l.account_number === "ACC-B").map((l) => l.match_status));
      ok("§H20 · BOTH halves of the pair end up confirmed together", bothHalves.length === 2 && bothHalves.every((s) => s === "confirmed"), bothHalves);

      /* --- protection: note only, no fee columns touched --- */
      const cBefore = await readCase(p4, C.caseId);
      await p4.click(`#recon-confirm-${protLineId}`);
      await wait(p4, 1200);
      const cAfter = await readCase(p4, C.caseId);
      const notesC = await notesFor(p4, C.caseId);
      ok("§H21 · protection confirm writes a note only", notesC.some((b) => /^Protection commission .* banked/.test(b)), notesC.slice(-2));
      ok("§H22 · … and touches NO fee column on the case", cAfter.proc_fee === cBefore.proc_fee && cAfter.proc_fee_paid_at === cBefore.proc_fee_paid_at, { before: cBefore, after: cAfter });

      /* --- fee-fix: FAR match, checkbox TICKED — case amount updated to the banked gross --- */
      const REF3 = "FEE-" + tag();
      await importStatement(p4, REF3, [
        { d: new Date(2026, 6, 28), tt: "Commission receipt", addr: "Ms " + Ec.last, prov: "Skipton", acct: "ACC-E", pgroup: "Mortgage", ptype: "Mortgage", g: 950, n: 855, adviser: "one" },
      ]);
      const eLineId = await p4.evaluate(() => document.querySelector('#recon-group-mortgage .recon-line[data-kind="mortgage"]').dataset.line);
      await p4.evaluate((d) => { const s = document.querySelector(`#recon-pick-${d.id}`); if (s) { s.value = d.caseId; s.dispatchEvent(new Event("change", { bubbles: true })); } }, { id: eLineId, caseId: Ec.caseId });
      await p4.evaluate((id) => { const c = document.querySelector(`#recon-feefix-${id}`); if (c) { c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); } }, eLineId);
      await p4.click(`#recon-confirm-${eLineId}`);
      await wait(p4, 1200);
      const eAfter = await readCase(p4, Ec.caseId);
      eq("§H16 · TICKED → case proc_fee updated to the banked gross (950)", eAfter.proc_fee, 950);

      /* --- real (unreversed) clawback: second statement, same account as A's confirmed receipt --- */
      const REF4 = "CB-" + tag();
      await importStatement(p4, REF4, [
        { d: new Date(2026, 7, 4), tt: "Commission takeback", addr: "Mrs Someone Else Entirely", prov: "Halifax", acct: "ACC-A", pgroup: "Mortgage", ptype: "Mortgage", g: -800, n: -720, adviser: "one" },
      ]);
      const cbLine = await p4.evaluate(() => {
        const el = document.querySelector('#recon-group-takeback .recon-line[data-kind="takeback"]');
        return el ? { id: el.dataset.line, txt: el.textContent } : null;
      });
      ok("§H23 · the real clawback line renders", !!cbLine);
      const cbMatch = await p4.evaluate((id) => (window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0] || {}).matched_case_id, cbLine.id);
      ok("§H24 · account history alone (surname mismatched on purpose) found case A", cbMatch === A.caseId, cbMatch);
      ok("§H25 · NOT badged as an in-statement reversal", !/reversed in-statement/.test(cbLine.txt));
      const aBefore = await readCase(p4, A.caseId);
      await p4.click(`#recon-confirm-${cbLine.id}`);
      await wait(p4, 1400);
      const aAfter = await readCase(p4, A.caseId);
      const notesA2 = await notesFor(p4, A.caseId);
      const tasksA = await tasksFor(p4, A.caseId);
      const today = await p4.evaluate(() => localDateStr());
      ok("§H26 · CLAWBACK note written", notesA2.some((b) => /^CLAWBACK £800\.00/.test(b)), notesA2.slice(-2));
      ok("§H27 · owner task raised, due TODAY (localDateStr), assigned to ME", tasksA.some((t) => /^Clawback:/.test(t.title) && t.due_date === today && t.assigned_to === "p4"), tasksA);
      ok("§H28 · the paid date is NOT un-set by the clawback — history stays true", aAfter.proc_fee_paid_at === aBefore.proc_fee_paid_at, { before: aBefore.proc_fee_paid_at, after: aAfter.proc_fee_paid_at });

      /* --- dismiss / un-dismiss, and a CONFIRMED line refuses dismiss ---
         r44MatchCell()'s `locked` branch renders NO dismiss button at all for
         a confirmed line (only the "Confirmed …" summary), so the UI never
         actually offers a way to click one — call r44DismissLine() directly,
         same as the review's own click handler does, to prove the function's
         OWN defensive check (`if (l.match_status === "confirmed") return
         toast(...)`) still holds even if a future render ever did offer the
         button. REF4 (the clawback statement) is the open review, but
         r44DismissLine reads reconState.byLine keyed off whatever statement
         is currently open — mortLineId belongs to REF1, so reopen REF1 first
         so reconState actually knows about it. */
      await p4.evaluate((ref) => {
        const st = window.__mock.db.commission_statements.filter((s) => s.ref === ref)[0];
        const btn = st && document.querySelector(`#recon-review-btn-${st.id}`);
        if (btn) btn.click();
      }, REF1);
      await wait(p4, 1400);
      await p4.evaluate((id) => r44DismissLine(id), mortLineId);
      await wait(p4, 800);
      const stillConfirmed = await p4.evaluate((id) => (window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0] || {}).match_status, mortLineId);
      eq("§H30 · a confirmed line's match_status is untouched by a dismiss attempt", stillConfirmed, "confirmed");
      const refuseToast = await toastText(p4);
      ok("§H31 · the refusal toast says so", /it cannot be dismissed/.test(refuseToast || ""), refuseToast);
      ok("§H31b · … and (belt and braces) the rendered UI never even offers a dismiss button on a confirmed line", await p4.evaluate((id) => !document.querySelector(`#recon-dismiss-${id}`), mortLineId));

      /* A dedicated statement for the dismiss test — every matchable line in
         REF1/REF3/REF4 above is already confirmed by this point, and the
         renewal/other aggregate rows carry no dismiss button at all
         (`.recon-agg` rows skip r44MatchCell entirely), so this needs a line
         of its own that is suggested but never confirmed. */
      const Ic = await mkFixtureCase(p4, "Dismissable" + tag(), { case: { lender: "Halifax", loan_amount: 90000, proc_fee: 350 } });
      const REF6 = "DISM-" + tag();
      await importStatement(p4, REF6, [
        { d: new Date(2026, 7, 6), tt: "Commission receipt", addr: "Mr " + Ic.last, prov: "Halifax", acct: "ACC-DISM", pgroup: "Mortgage", ptype: "Mortgage", g: 350, n: 315, adviser: "one" },
      ]);
      const dismissable = await p4.evaluate(() => {
        const el = document.querySelector('#recon-group-mortgage .recon-line[data-kind="mortgage"]:not(.is-confirmed)');
        return el ? el.dataset.line : null;
      });
      if (dismissable) {
        await p4.click(`#recon-dismiss-${dismissable}`);
        await wait(p4, 900);
        let ms = await p4.evaluate((id) => (window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0] || {}).match_status, dismissable);
        eq("§H32 · dismiss sets match_status \"dismissed\"", ms, "dismissed");
        await p4.click(`#recon-dismiss-${dismissable}`);
        await wait(p4, 900);
        ms = await p4.evaluate((id) => (window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0] || {}).match_status, dismissable);
        ok("§H33 · un-dismiss returns it to the queue (suggested/unmatched)", ms === "suggested" || ms === "unmatched", ms);
      } else {
        ok("§H32 · dismiss sets match_status \"dismissed\"", false, "no dismissable line found");
        ok("§H33 · un-dismiss returns it to the queue", false, "no dismissable line found");
      }

      /* --- bulk "Confirm ticked" --- */
      const REF5 = "BULK-" + tag();
      const Hc1 = await mkFixtureCase(p4, "Kowalczyk" + tag(), { case: { lender: "Halifax", loan_amount: 90000, proc_fee: 360 } });
      await importStatement(p4, REF5, [
        { d: new Date(2026, 7, 5), tt: "Commission receipt", addr: "Mr " + Hc1.last, prov: "Halifax", acct: "ACC-BULK", pgroup: "Mortgage", ptype: "Mortgage", g: 360, n: 324, adviser: "one" },
      ]);
      const bulkLineId = await p4.evaluate(() => document.querySelector('#recon-group-mortgage .recon-line[data-kind="mortgage"]').dataset.line);
      const bulkTicked = await p4.evaluate((id) => { const el = document.querySelector(`#recon-tick-${id}`); return el ? el.checked : null; }, bulkLineId);
      ok("§H34 · a high-confidence line arrives pre-ticked, ready for bulk confirm", bulkTicked === true, bulkTicked);
      await p4.click("#recon-confirm-ticked");
      await wait(p4, 1500);
      const hAfter = await readCase(p4, Hc1.caseId);
      ok("§H35 · \"Confirm ticked\" wrote the proc fee date via the bulk path too", !!hAfter.proc_fee_paid_at, hAfter.proc_fee_paid_at);
    }

    /* =======================================================================
       §I · counters, DB persistence, XSS
       ======================================================================= */
    {
      console.log("\n— §I · statement-list counters, DB persistence, XSS");
      const REF1txt = await p4.evaluate(() => {
        const rows = [...document.querySelectorAll("#recon-statements .recon-stmt")];
        return rows.map((r) => r.textContent).join(" || ");
      });
      ok("§I1 · the statement list shows a confirmed count", /confirmed/.test(REF1txt), REF1txt.slice(0, 200));
      ok("§I2 · … and a takeback badge where one exists", /takeback/.test(REF1txt), REF1txt.slice(0, 200));

      /* review renders FROM THE DB and survives close + reopen. The currently
         open review is whichever statement §H's bulk-confirm block imported
         last (REF5) — close it and reopen the FIRST statement (REF1), which
         carries the confirmed mortgage/takeback/protection lines. */
      await p4.evaluate(() => document.querySelector("#recon-close").click());
      await wait(p4, 400);
      ok("§I3 · close hides the review", await p4.evaluate(() => document.querySelector("#recon-review").classList.contains("hidden")));
      const reopened = await p4.evaluate((ref) => {
        const st = window.__mock.db.commission_statements.filter((s) => s.ref === ref)[0];
        const btn = st && document.querySelector(`#recon-review-btn-${st.id}`);
        if (btn) { btn.click(); return true; }
        return false;
      }, REF1);
      ok("§I3b · found the Review button for the first statement", reopened);
      await wait(p4, 1400);
      const reText = (await p4.textContent("#recon-review")) || "";
      ok("§I4 · re-opened review shows CONFIRMED state read back off the DB", /Confirmed/.test(reText), reText.slice(0, 200));

      /* XSS spot-check: hostile spreadsheet strings render inert */
      const REFX = "XSS-" + tag();
      await p4.evaluate((ref) => {
        window.__XSS = 0;
        const H = ["Date", "Tran Type \nDesc", "Addressee", "Provider", "Account \nnumber", "Opp ID", null,
          "File Review Client Name", "Reason", "Policy \nType", "Policy Group", null, "Premium",
          "Banked\n(Gross)", null, null, "Banked\n(Net)"];
        const blank = () => new Array(17).fill(null);
        const title = blank(); title[0] = "Commission statement";
        const refRow = blank(); refRow[9] = `Ref:${ref}`;
        const firm = blank(); firm[0] = "Fixture Network Ltd";
        const adv = blank(); adv[0] = '<script>window.__XSS=2</script>Adviser';
        const r = blank();
        r[0] = new Date(2026, 7, 11); r[1] = "Commission receipt"; r[2] = '<img src=x onerror="window.__XSS=3">';
        r[3] = '"><svg onload="window.__XSS=4">'; r[4] = "ACC-XSS"; r[9] = "Mortgage"; r[10] = "Mortgage"; r[12] = 1; r[13] = 10; r[16] = 9;
        window.__drop("#recon-file", window.__mkFile([title, refRow, blank(), blank(), blank(), H, firm, blank(), adv, r], "Commission Statement (Fixture)", "<b>evil</b>.xlsx"));
      }, REFX);
      await wait(p4, 2200);
      const xss = await p4.evaluate(() => ({
        flag: window.__XSS,
        imgs: document.querySelectorAll("#recon-review img, #recon-review svg, #recon-statements img").length,
        txt: (document.querySelector("#recon-review") || {}).textContent || "",
      }));
      ok("§I5 · no injected script or element actually ran", !xss.flag && xss.imgs === 0, xss);
      ok("§I6 · the raw markup is rendered as inert TEXT", /<img src=x/.test(xss.txt), xss.txt.slice(0, 200));
    }

    /* =======================================================================
       §J · no console errors across the whole owner session
       ======================================================================= */
    {
      console.log("\n— §J · console clean across the whole owner run");
      ok("§J1 · owner console clean end to end (§E-§I)", (p4.__err || []).length === 0, p4.__err);
      await p4.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r44: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
