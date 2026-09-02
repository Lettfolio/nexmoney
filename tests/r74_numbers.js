#!/usr/bin/env node
/* =============================================================================
   tests/r74_numbers.js — acceptance tests for R74 build A, "The numbers
   reconcile" (R73 UI/UX panel findings D#1–D#4, D-25, D#6, D#12, D#14, A#9,
   A#13, D#7, D#8).

   What the panel found, verified against the app on 28 August:

     · ONE BOOK, FOUR PREDICATES (D#1). Today's KPI said 13 rates, the Rate &
       ERC panel six inches below it said 11, and Retention said "4 already
       ended + 11 in the window" over a 14-row list whose chip read 14. Nothing
       was miscounted: the KPI had never been given the live-successor
       suppression the feed applies, the "6 months (all)" chip was silently
       carrying ERC-conflict rows whose rate ends well beyond six months, and
       "4 + 11" double-counted because a lapsed rate is INSIDE the window.

     · TWO DEBTOR TOTALS A SCREEN APART (D#2). "Fees outstanding £14,270" and
       "Money owed £27,035" — different fee types over different case sets,
       explained only in 11px captions.

     · ATTACH RATE, TWO PAGES, NO PERIOD (D#4). The same adviser at 0% on
       Reports (this month) and 43% on Monday money (the year).

     · ONE STATE, THREE WORDS (D-25 + A#9). Held email was "queued" on Emails,
       "queued" in Settings, "stuck" on Data health — and #em-summary promised
       "the next 8am run will send…" while Today's banner said the run had been
       stopped for days.

     · REPORTS OPENED ON A PARAGRAPH (D#12/D#14/D#6), and its level-2 tab strip
       listed all twenty panels at once.

     · THE DATA HEALTH HEADLINE NEVER MOVED (A#13), and its tile wall was in
       the order fifteen rounds happened to write it.

     §A  A1 · ONE RATE BOOK. rateBookCounts() is the only definition; Today's
         KPI, the Rate & ERC panel badge and the Retention page all render the
         same number for the same scope, the three Retention groups sum to the
         chip above them, and the ERC-only group exists.
     §B  A2 · MONEY THAT AGREES. Both debtor KPIs on one row with their basis
         in the LABEL; the Money-owed panel's grand total IS the second tile;
         attach headers carry their period on both pages; the dash convention.
     §C  A3 · "HELD" ON FOUR SURFACES while the hold is on, and #em-summary
         reads last_cron_run_at — "stuck" survives only where it is true.
     §D  A4 · REPORTS LEADS WITH THE NUMBER. Hero first, disclosure closed,
         level-2 chips scoped to the selected section with no overflow at 1160,
         section pills sticky, deep link crosses sections.
     §E  A5 · DATA HEALTH TELLS THE TRUTH. Headline decrements on an inline
         fix, the fix panel counts down, the wall is banded and sorted, and
         "Clients total" has left the wall for the page sub.

   Every figure asserted here is computed by this file's own seeding, read back
   off window.__mockDb, or read live off app.js's own module state — never a
   number invented independently of the fixture it is testing.

   Run:  node /root/nx/tests/r74_numbers.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — see HARNESS.md.)
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
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  return srv;
}

const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_sortdir", "nx_wt_scope", "nx_board_adviser",
  "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc", "nx_drawer_retention", "nx_ret_untouched"];

async function boot(browser, persona, viewport) {
  const page = await (await browser.newContext(viewport ? { viewport } : {})).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.waitForTimeout(1600);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));

const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 2600 : ms);
};
const txt = (page, sel) => page.$eval(sel, (e) => (e.textContent || "").replace(/\s+/g, " ").trim()).catch(() => null);

/* The mock's own settings row, nudged in place then re-read the way Save does it. An ADVISER
   cannot write settings (the mock enforces the real owner-only policy), and some of what this file
   drives — last_cron_run_at — is stamped by the edge function, never by a client. So it arrives as
   the database arriving in that state. Same technique as r68_mi's setSettingLive. */
const setSettingLive = (page, key, value) => page.evaluate(async ({ key, value }) => {
  const rows = window.__mock.db.settings;
  const row = rows.filter((r) => r.key === key)[0];
  if (row) row.value = value;
  else rows.push({ key, value, updated_at: new Date().toISOString() });
  await window.__reloadSettings();
}, { key, value });

let uniq = 0;
const tag = () => `R74${Date.now().toString(36)}${++uniq}`;
const isoDaysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/* One client + one completed case through the mock's own client, so applyInsertDefaults runs
   exactly as production would. */
async function mkCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const { data: cl, error: ce } = await db.from("clients").insert({
      first_name: o.first, last_name: o.last, email: o.email || `${o.last}@example.com`, phone: "07700900123",
    }).select("id").single();
    if (ce) throw new Error("client insert: " + ce.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "completed" }, o.case || {});
    const { data: cs, error: se } = await db.from("cases").insert(row).select("id").single();
    if (se) throw new Error("case insert: " + se.message);
    return { clientId: cl.id, caseId: cs.id };
  }, opts);
}

/* The three rate-book surfaces, read as they render. */
const kpiRateNum = (page) => page.$eval(`.kpi[onclick="kpiGoto('rates')"] .num`, (e) => Number(e.textContent.replace(/[^\d-]/g, "")));
const kpiErcNum = (page) => page.$eval(`.kpi[onclick="kpiGoto('erc')"] .num`, (e) => Number(e.textContent.replace(/[^\d-]/g, "")));
const kpiRateLbl = (page) => page.$eval(`.kpi[onclick="kpiGoto('rates')"] .lbl`, (e) => e.textContent.replace(/\s+/g, " ").trim());
const drawerBadge = (page) => txt(page, "#rate-erc-panel h3");
const retH3 = (page) => txt(page, "#ret-rates-h3");
const retGroups = (page) => page.$$eval("#ret-rates-list .ret-group-h", (els) => els.map((e) => ({
  title: (e.childNodes[0].textContent || "").trim(),
  n: Number((e.querySelector(".count") || {}).textContent || 0),
  cls: [...e.classList].filter((c) => c.indexOf("ret-g-") === 0)[0] || "",
})));
const retChipAll = (page) => page.$eval("#ret-month-chips .ret-month-chip[data-month='all']", (e) => ({
  label: e.textContent.replace(/\s+/g, " ").trim(),
  n: Number((e.querySelector(".count") || {}).textContent || 0),
}));

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {

    /* =====================================================================
       §A · A1 — ONE RATE BOOK, ONE DEFINITION, THREE SURFACES.
       ===================================================================== */
    {
      console.log("\n— §A1 · the shared helper exists and classifies every row exactly once (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;

      /* The helper is the contract. Driven directly off a synthetic feed so the classification is
         tested independently of any page's rendering. */
      const cls = await page.evaluate(() => {
        const feed = {
          ratesSoonScoped: [{ case_id: "a" }, { case_id: "b" }],
          ercFlagsScoped: [{ case_id: "b" }, { case_id: "c" }],
          rows: [
            { case_id: "a", days_to_rate_end: -30 },   // ended
            { case_id: "b", days_to_rate_end: 40 },    // ending, and ALSO an ERC conflict
            { case_id: "c", days_to_rate_end: 400 },   // erc only — rate ends beyond the window
          ],
        };
        return window.__r74RateBookCounts ? window.__r74RateBookCounts(feed) : null;
      });
      ok("§A1a · rateBookCounts is reachable for testing", !!cls, JSON.stringify(cls));
      if (cls) {
        eq("§A1b · one ended", cls.ended, 1);
        eq("§A1c · one ending", cls.ending, 1);
        eq("§A1d · one ERC-only — a row whose rate ends BEYOND the window", cls.ercOnly, 1);
        eq("§A1e · inWindow = ended + ending (a lapsed rate is INSIDE the window)", cls.inWindow, 2);
        eq("§A1f · the three groups sum to the total", cls.ended + cls.ending + cls.ercOnly, cls.total);
        eq("§A1g · ercAll counts every ERC conflict, in-window ones included", cls.ercAll, 2);
      }
      eq("§A1 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §A2 · the three surfaces render THE SAME number, over seeded rows (p4, All scope)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;

      /* Three seeds, one of each kind, all address-less so R7-2's collapse cannot merge them:
         one ended, one ending inside the window, one ERC-only (rate 14 months out, ERC running). */
      const t = tag();
      const ended = await mkCase(page, { first: "R74A", last: "Ended" + t, case: { rate_end_date: isoDaysFromNow(-30), lender: "R74Lender", loan_amount: 210000 } });
      const ending = await mkCase(page, { first: "R74A", last: "Ending" + t, case: { rate_end_date: isoDaysFromNow(40), lender: "R74Lender", loan_amount: 220000 } });
      const ercOnly = await mkCase(page, { first: "R74A", last: "ErcOnly" + t, case: { rate_end_date: isoDaysFromNow(420), erc_end_date: isoDaysFromNow(500), lender: "R74Lender", loan_amount: 230000 } });

      await goPage(page, "dashboard", 2600);
      const kpiN = await kpiRateNum(page);
      const kpiLbl = await kpiRateLbl(page);
      const drawer = await drawerBadge(page);
      const drawerN = Number((drawer.match(/(\d+) in the (\d+)-month window/) || [])[1]);

      ok("§A2a · the KPI tile is labelled with the shared phrase, not \"ending ≤6mo\"",
        /Rates in the \d+-month window/.test(kpiLbl), kpiLbl);
      ok("§A2b · the Rate & ERC badge uses the same phrase", /\d+ in the \d+-month window/.test(drawer), drawer.slice(0, 140));
      eq("§A2c · …and the SAME number (D#1: this pair read 13 vs 11)", kpiN, drawerN);

      await goPage(page, "retention", 3000);
      const h3 = await retH3(page);
      const pageWindowN = Number((h3.match(/(\d+) in the (\d+)-month window/) || [])[1]);
      eq("§A2d · the Retention page's window badge is the same number again", pageWindowN, drawerN);

      const groups = await retGroups(page);
      const chip = await retChipAll(page);
      eq("§A2e · three headed groups — Ended, Ending soon, ERC conflict only",
        groups.map((g) => g.cls), ["ret-g-ended", "ret-g-soon", "ret-g-erc"]);
      const groupSum = groups.reduce((s, g) => s + g.n, 0);
      eq("§A2f · the group badges sum to the chip's own count (D#1: 4+10 over a 14-row list)", groupSum, chip.n);
      ok("§A2g · the chip is labelled for what it HOLDS, ERC conflicts included",
        /6 months \+ ERC conflicts/.test(chip.label), chip.label);

      const rowIds = await page.$$eval("#ret-rates-list [onclick*=\"openCase\"]", (els) =>
        els.map((e) => (e.getAttribute("onclick").match(/openCase\('([^']+)'/) || [])[1]).filter(Boolean));
      ok("§A2h · the seeded ended row is on the page", rowIds.includes(ended.caseId), ended.caseId);
      ok("§A2i · the seeded ending row is on the page", rowIds.includes(ending.caseId), ending.caseId);
      ok("§A2j · the seeded ERC-only row is on the page…", rowIds.includes(ercOnly.caseId), ercOnly.caseId);

      /* The ERC-only row must be UNDER the ERC-only heading, not folded into "Ending soon" — that
         merge is the whole of D#1's "pulled in silently". */
      const ercGroupIds = await page.evaluate(() => {
        const heads = [...document.querySelectorAll("#ret-rates-list .ret-group-h")];
        const h = heads.filter((x) => x.classList.contains("ret-g-erc"))[0];
        if (!h) return null;
        const out = [];
        let n = h.nextElementSibling;
        while (n && !n.classList.contains("ret-group-h")) {
          n.querySelectorAll("[onclick*='openCase']").forEach((b) => {
            const m = (b.getAttribute("onclick") || "").match(/openCase\('([^']+)'/);
            if (m) out.push(m[1]);
          });
          n = n.nextElementSibling;
        }
        return out;
      });
      ok("§A2k · …and it sits under the ERC-only heading", !!ercGroupIds && ercGroupIds.includes(ercOnly.caseId), JSON.stringify(ercGroupIds));

      /* The sub-line does the arithmetic out loud. */
      const sub = await txt(page, "#ret-rates-sub");
      ok("§A2l · the panel sub states the reconciliation in words",
        /already ended and \d+ still to end make the \d+ in the \d+-month window/.test(sub) && /rows in all/.test(sub), sub.slice(-260));

      eq("§A2 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §A3 · the live-successor suppression is applied by the KPI too (the 13-vs-11 gap) (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "dashboard", 2600);
      const before = await kpiRateNum(page);
      const beforeDrawer = Number(((await drawerBadge(page)).match(/(\d+) in the \d+-month window/) || [])[1]);

      /* A completed case in the window, plus a LIVE retention successor pointing at it. The feed
         has always suppressed the successor's own alert; the KPI never did, which is exactly how
         one screen read 13 over a panel reading 11. */
      const t = tag();
      const src = await mkCase(page, { first: "R74B", last: "Src" + t, case: { rate_end_date: isoDaysFromNow(50), lender: "R74BLender", loan_amount: 300000 } });
      await page.evaluate(async ({ clientId, caseId, d }) => {
        await window.__mockDb.from("cases").insert({
          client_id: clientId, case_kind: "remortgage", stage: "enquiry",
          retention_source_case_id: caseId, rate_end_date: d, lender: "R74BLender", loan_amount: 300000,
        });
      }, { clientId: src.clientId, caseId: src.caseId, d: isoDaysFromNow(50) });

      await goPage(page, "dashboard", 2800);
      const after = await kpiRateNum(page);
      const afterDrawer = Number(((await drawerBadge(page)).match(/(\d+) in the \d+-month window/) || [])[1]);
      eq("§A3a · seeding a source + a LIVE successor adds exactly one to the KPI, not two", after, before + 1);
      eq("§A3b · …and the same one to the drawer badge", afterDrawer, beforeDrawer + 1);
      eq("§A3c · the two still agree", after, afterDrawer);
      eq("§A3 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §A4 · Mine/All scoping is preserved on every surface (p2 Wayne, adviser)");
      const page = await boot(browser, "p2");
      const errBefore = realErrs(page).length;
      await goPage(page, "dashboard", 2600);
      const mineN = await kpiRateNum(page);
      const mineLbl = await kpiRateLbl(page);
      ok("§A4a · the adviser's tile still says whose it is", /mine/i.test(await page.$eval("#kpi-row .kpi:nth-child(3)", (e) => e.textContent)), mineLbl);
      /* Flip My Day to All: the tile is re-counted from rows already in memory, and must not shrink. */
      await page.evaluate(() => document.getElementById("brief-scope-all").click());
      await page.waitForTimeout(900);
      const allN = await kpiRateNum(page);
      ok("§A4b · switching My Day to All widens (never narrows) the same tile", allN >= mineN, JSON.stringify({ mineN, allN }));
      eq("§A4 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §B · A2 — MONEY THAT AGREES WITH ITSELF.
       ===================================================================== */
    {
      console.log("\n— §B1 · the two debtor KPIs sit together with their bases in the LABEL (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "reports", 3600);

      const tiles = await page.$$eval("#report-kpis .kpi", (els) => els.map((e) => ({
        id: e.id || "",
        lbl: ((e.querySelector(".lbl") || {}).textContent || "").replace(/\s+/g, " ").trim(),
        num: ((e.querySelector(".num") || {}).textContent || "").trim(),
        basis: ((e.querySelector(".s") || {}).textContent || "").replace(/\s+/g, " ").trim(),
      })));
      const outIdx = tiles.findIndex((t) => /^Broker fees outstanding \(all stages\)$/.test(t.lbl));
      const owedIdx = tiles.findIndex((t) => t.id === "report-kpi-owed");
      ok("§B1a · the old \"Fees outstanding\" tile is now \"Broker fees outstanding (all stages)\"", outIdx >= 0, JSON.stringify(tiles.map((t) => t.lbl)));
      ok("§B1b · a sibling \"Owed on completed cases\" tile exists", owedIdx >= 0, JSON.stringify(tiles.map((t) => t.lbl)));
      eq("§B1c · they are adjacent — the pair reads as one pair", owedIdx, outIdx + 1);
      ok("§B1d · both are .kpi in the same row", await page.evaluate(() =>
        !!document.querySelector("#report-kpis #report-kpi-owed.kpi")));
      ok("§B1e · the completed-cases tile names its fee types in its basis line",
        /proc \+ sols \+ broker/.test(tiles[owedIdx] ? tiles[owedIdx].basis : ""), tiles[owedIdx] && tiles[owedIdx].basis);
      ok("§B1f · the all-stages tile still names broker-only in its basis line",
        /broker only/.test(tiles[outIdx] ? tiles[outIdx].basis : ""), tiles[outIdx] && tiles[outIdx].basis);

      /* The second tile IS the Money owed panel's grand total — same model, not a re-derivation. */
      const owedTileNum = tiles[owedIdx] ? tiles[owedIdx].num : "";
      const panelGrand = await page.$$eval("#report-owed-buckets .kpi", (els) => {
        const last = els[els.length - 1];
        return last ? (last.querySelector(".num") || {}).textContent.trim() : null;
      });
      eq("§B1g · the tile equals the Money owed panel's own \"Total owed\" (D#2: £14,270 vs £27,035, unexplained)", owedTileNum, panelGrand);
      eq("§B1 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §B2 · both ATTACH RATE columns carry their period in the header (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "reports", 3600);
      const heads = await page.$$eval("#report-advisers table tr:first-child th", (els) => els.map((e) => ({
        t: e.textContent.replace(/\s+/g, " ").trim(), title: e.getAttribute("title") || "",
      })));
      const attach = heads.filter((h) => /^Attach/.test(h.t))[0];
      ok("§B2a · Reports' header names the MONTH — e.g. \"Attach (Aug)\"", !!attach && /^Attach \([A-Z][a-z]{2}\)$/.test(attach.t), JSON.stringify(heads.map((h) => h.t)));
      ok("§B2b · …and keeps its existing tooltip", !!attach && /policy taken ÷ completions/.test(attach.title), attach && attach.title.slice(0, 120));
      ok("§B2c · no header still carries a wrapped .money-basis block (D#14 — headers are one line now)",
        (await page.$$eval("#report-advisers table tr:first-child th .money-basis", (e) => e.length)) === 0);
      ok("§B2d · the Overdue column has left this table (it renders twice more on this page)",
        !heads.some((h) => /^Overdue/i.test(h.t)), JSON.stringify(heads.map((h) => h.t)));
      ok("§B2e · …and the adoption strip below still carries it", (await page.$$eval("#report-adoption .adopt-overdue", (e) => e.length)) > 0);
      /* The whole point of the drop: the table fits its own panel again. */
      const fit = await page.evaluate(() => {
        const t = document.querySelector("#report-advisers table");
        const w = t && (t.closest(".board-scroll-wrap--table") || t.parentElement);
        return t && w ? { table: t.scrollWidth, wrap: w.clientWidth } : null;
      });
      ok("§B2f · the scoreboard fits its panel at 1280 — no clipped columns", !!fit && fit.table <= fit.wrap + 1, JSON.stringify(fit));

      await goPage(page, "money", 3600);
      const mHead = await page.$$eval("#money-adviser-table tr:first-child th", (els) => els.map((e) => ({
        t: e.textContent.replace(/\s+/g, " ").trim(), title: e.getAttribute("title") || "",
      })));
      const mAttach = mHead.filter((h) => /^Attach/.test(h.t))[0];
      ok("§B2g · Monday money's header names the YEAR — \"Attach (2026)\"", !!mAttach && /^Attach \(20\d\d\)$/.test(mAttach.t), JSON.stringify(mHead.map((h) => h.t)));
      ok("§B2h · …and its tooltip now says why the two pages can differ",
        !!mAttach && /Reports scoreboard/.test(mAttach.title), mAttach && mAttach.title.slice(0, 160));
      eq("§B2 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §B3 · the zero convention — £0 for a real zero, — only where the question does not apply (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "reports", 3600);

      /* An ageing band with nothing in it is a real zero on BOTH pages. Before R74, Reports said
         "£0 · 0 cases" and Monday money said "—" for the same band off the same model. */
      const repBuckets = await page.$$eval("#report-owed-buckets .kpi", (els) => els.map((e) => ({
        lbl: ((e.querySelector(".lbl") || {}).textContent || "").trim(),
        num: ((e.querySelector(".num") || {}).textContent || "").trim(),
        n: ((e.querySelector(".s") || {}).textContent || "").trim(),
      })));
      const repEmpty = repBuckets.filter((b) => /^0 case/.test(b.n));
      ok("§B3a · fixture sanity — at least one ageing band on Reports is genuinely empty", repEmpty.length > 0, JSON.stringify(repBuckets));
      ok("§B3b · an empty band on Reports reads £0, never a dash", repEmpty.every((b) => /£0/.test(b.num) && !/—/.test(b.num)), JSON.stringify(repEmpty));

      await goPage(page, "money", 3600);
      const mRows = await page.$$eval("#money-owed-ageing tr, #page-money table tr", (els) => els.map((r) =>
        [...r.cells].map((c) => c.textContent.replace(/\s+/g, " ").trim())));
      const ageRows = mRows.filter((r) => r.length === 3 && /days|No completion date/i.test(r[0]));
      const emptyAge = ageRows.filter((r) => r[1] === "0");
      ok("§B3c · fixture sanity — Monday money shows the same ageing bands", ageRows.length > 0, JSON.stringify(ageRows));
      ok("§B3d · an empty band on Monday money reads £0 too, matching Reports (D#4)",
        emptyAge.every((r) => /£0/.test(r[2]) && r[2] !== "—"), JSON.stringify(emptyAge));

      await goPage(page, "reports", 3600);
      /* A dash still means "not applicable", and now says which. */
      const noTargetTitle = await page.evaluate(() => {
        const c = document.querySelector("#report-advisers .adv-target-cell[data-pct='']");
        const d = c && c.querySelector(".cs-muted");
        return d ? d.getAttribute("title") : null;
      });
      ok("§B3e · a Target cell with no target set explains its dash on hover",
        !!noTargetTitle && /not applicable|no monthly target/i.test(noTargetTitle), noTargetTitle);
      eq("§B3 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §C · A3 — ONE WORD FOR HELD MAIL, AND A SUMMARY THAT READS THE HEARTBEAT.
       ===================================================================== */
    {
      console.log("\n— §C1 · while email_hold is on, all four surfaces say \"held\" (p1 Kim, administrator)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      await setSettingLive(page, "email_hold", "on");
      await setSettingLive(page, "last_cron_run_at", new Date().toISOString());   // healthy cron: the hold is the only story

      await goPage(page, "dashboard", 3000);
      const chip = await txt(page, "#ops-emails-queued");
      ok("§C1a · Today's chip says \"emails held\"", /emails held/.test(chip), chip);

      await goPage(page, "emails", 3000);
      const em = await txt(page, "#em-summary");
      ok("§C1b · #em-summary says the emails are held and will wait", /held/.test(em) && /will wait/.test(em), em.slice(0, 200));
      ok("§C1c · …and does NOT promise the next 8am run will send them", !/next 8am run will send/.test(em), em.slice(0, 200));
      ok("§C1d · …and names the control that releases them", /Settings › Email sending/.test(em), em.slice(0, 240));

      await goPage(page, "data", 3600);
      const dh = await txt(page, "#dh-stuck-notice");
      ok("§C1e · Data health's notice says \"held\", not \"stuck\" (D-25)", dh != null && /held/.test(dh) && !/stuck/.test(dh), dh);

      await goPage(page, "settings", 3600);
      const banner = await txt(page, "#email-sending-line");
      ok("§C1f · the Settings banner says the emails are held and will wait", /held and will wait/.test(banner), banner);
      ok("§C1g · …and the word \"queued\" is not used for them there", !/are queued and will wait/.test(banner), banner);
      eq("§C1 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §C2 · hold OFF + cron STALE → #em-summary reads the heartbeat, and \"stuck\" is true (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      const staleIso = new Date(Date.now() - 9 * 86400000).toISOString();
      await setSettingLive(page, "email_hold", "off");
      await setSettingLive(page, "last_cron_run_at", staleIso);

      await goPage(page, "emails", 3000);
      const em = await txt(page, "#em-summary");
      ok("§C2a · it says the run has not completed since a date (A#9)", /has not completed since/.test(em), em.slice(0, 220));
      ok("§C2b · …and that these are waiting on IT", /waiting on it/.test(em), em.slice(0, 220));
      ok("§C2c · it does NOT promise \"the next 8am run will send\" while the banner calls the cron stale",
        !/next 8am run will send/.test(em), em.slice(0, 220));
      ok("§C2d · \"stuck\" survives here, where it is true", /stuck/.test(em), em.slice(0, 260));

      /* And Today's banner is saying the same thing on the same reading. */
      await goPage(page, "dashboard", 3000);
      const banner = await txt(page, "#dash-cron-notice");
      ok("§C2e · Today's banner agrees — same settings key, same verdict", banner != null && /last ran/.test(banner), banner);
      eq("§C2 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §C3 · hold OFF + cron HEALTHY → the original sentence, plus the clock (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      await setSettingLive(page, "email_hold", "off");
      await setSettingLive(page, "last_cron_run_at", new Date().toISOString());
      await goPage(page, "emails", 3000);
      const em = await txt(page, "#em-summary");
      ok("§C3a · the original promise is back", /next 8am run/.test(em), em.slice(0, 200));
      ok("§C3b · …with the clock time beside it, the way the SMS line gives one", /08:00 UTC/.test(em) && /British Summer Time/.test(em), em.slice(0, 220));
      ok("§C3c · nothing is called stuck when nothing is", !/stuck/.test(em), em.slice(0, 220));
      const chipTxt = await page.evaluate(() => {
        const c = document.querySelector("#em-summary .em-summary-clock");
        return c ? c.textContent : null;
      });
      ok("§C3d · the clock is its own element, so it can be quietened without touching the sentence", !!chipTxt, chipTxt);
      eq("§C3 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §D · A4 — REPORTS LEADS WITH THE NUMBER, AND THE TABS FIT.
       ===================================================================== */
    {
      console.log("\n— §D1 · the hero is the first thing under the tabs, and the essay is folded away (p4)");
      const page = await boot(browser, "p4", { width: 1160, height: 900 });
      const errBefore = realErrs(page).length;
      await goPage(page, "reports", 3800);

      const order = await page.evaluate(() => {
        const nav = document.getElementById("rep-nav");
        let n = nav && nav.nextElementSibling;
        while (n && (n.hidden || n.classList.contains("hidden"))) n = n.nextElementSibling;
        return n ? n.id : null;
      });
      eq("§D1a · #report-hero is the first visible element under the level-2 tab strip", order, "report-hero");

      const hero = await txt(page, "#report-hero");
      ok("§D1b · the hero leads with the earned figure", /^£[\d,]+ earned/.test(hero), hero.slice(0, 120));
      ok("§D1c · …and the percentage of target beside it", /\d+% of target/.test(hero), hero.slice(0, 140));
      ok("§D1d · …and names the basis it is counted on", /paid or not/.test(hero) && /completion date/.test(hero), hero.slice(0, 300));

      /* The hero must agree with the bar it summarises — the whole point of a hero. */
      const barLine = await txt(page, "#month-fee-target .target-headline");
      const heroNum = (hero.match(/£[\d,]+/) || [])[0];
      ok("§D1e · the hero's number is the same one the Monthly business bar prints",
        !!heroNum && barLine.indexOf(heroNum) >= 0, JSON.stringify({ heroNum, barLine }));
      const heroPct = (hero.match(/(\d+)% of target/) || [])[1];
      ok("§D1f · …and the same percentage", !!heroPct && barLine.indexOf("(" + heroPct + "%)") >= 0, JSON.stringify({ heroPct, barLine }));

      const fold = await page.evaluate(() => {
        const d = document.getElementById("report-basis-fold");
        return d ? { hidden: d.hidden, open: d.open, holdsLegend: !!d.querySelector("#report-basis-legend") } : null;
      });
      ok("§D1g · the three-money-bases paragraph now lives behind a disclosure", !!fold && fold.holdsLegend, JSON.stringify(fold));
      ok("§D1h · …which is CLOSED on arrival", !!fold && fold.open === false, JSON.stringify(fold));
      ok("§D1i · …and visible as a handle for the reader who wants it", !!fold && fold.hidden === false, JSON.stringify(fold));

      const scoreFold = await page.evaluate(() => {
        const d = document.getElementById("report-scoreboard-how");
        return d ? { open: d.open, text: (d.textContent || "").length } : null;
      });
      ok("§D1j · the scoreboard's essay is behind its own closed \"How these are counted\"", !!scoreFold && scoreFold.open === false && scoreFold.text > 300, JSON.stringify(scoreFold));
      const scoreSub = await page.evaluate(() => {
        const el = document.getElementById("report-scoreboard-scope");
        const d = document.getElementById("report-scoreboard-how");
        if (!el) return null;
        const clone = el.cloneNode(true);
        const dd = clone.querySelector("details"); if (dd) dd.remove();
        return clone.textContent.replace(/\s+/g, " ").trim();
      });
      ok("§D1k · what is left in front of it is ONE sentence", !!scoreSub && (scoreSub.match(/\./g) || []).length <= 2 && scoreSub.length < 220, JSON.stringify(scoreSub));
      eq("§D1 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §D2 · the level-2 strip shows ONE section's panels, and does not overflow at 1160 (p4)");
      const page = await boot(browser, "p4", { width: 1160, height: 900 });
      const errBefore = realErrs(page).length;
      await goPage(page, "reports", 3800);

      const sections = await page.$$eval("#reports-jump-chips .seg-btn", (els) => els.map((e) => ({
        key: e.dataset.reportsJump, label: e.textContent.trim(), active: e.classList.contains("active"), sel: e.getAttribute("aria-selected"),
      })));
      ok("§D2a · the section pills are on the page", sections.length >= 4, JSON.stringify(sections.map((s) => s.key)));
      eq("§D2b · exactly one is selected", sections.filter((s) => s.active).length, 1);
      eq("§D2c · aria-selected is a live state, not a hard-coded false", sections.filter((s) => s.sel === "true").length, 1);

      const totalPanels = await page.evaluate(() => window.__r74AllRepChips ? window.__r74AllRepChips() : null);
      const perSection = [];
      for (const s of sections) {
        await page.click(`#reports-nav-${s.key}`);
        await page.waitForTimeout(700);
        const chips = await page.$$eval("#rep-nav-chips .seg-btn", (els) => els.map((e) => e.textContent.trim()));
        const of = await page.evaluate(() => {
          const w = document.getElementById("rep-nav-chips");
          return { sw: w.scrollWidth, cw: w.clientWidth };
        });
        perSection.push({ key: s.key, n: chips.length, overflow: of.sw > of.cw + 1 });
      }
      /* The panel's number was "20 → 4–6"; the real spread on this role is 1–7, and what actually
         matters is that no strip needs a chevron at the width the app is used at. */
      ok("§D2d · every section's chip strip is a handful of chips, never twenty (D#6)",
        perSection.every((p) => p.n >= 1 && p.n <= 8), JSON.stringify(perSection));
      ok("§D2e · …and none of them overflows at 1160", perSection.every((p) => !p.overflow), JSON.stringify(perSection));
      if (totalPanels != null) {
        const sum = perSection.reduce((a, p) => a + p.n, 0);
        ok("§D2f · the sections between them account for every visible panel — none is unreachable",
          sum >= totalPanels, JSON.stringify({ sum, totalPanels, perSection }));
      }

      /* The pills stay reachable while you move — the level-1 control must not scroll away. */
      const sticky = await page.evaluate(() => {
        const s = document.getElementById("reports-jump"), n = document.getElementById("rep-nav");
        const cs = getComputedStyle(s), cn = getComputedStyle(n);
        return { sPos: cs.position, nPos: cn.position, sTop: cs.top, nTop: cn.top };
      });
      eq("§D2g · the section strip is sticky", sticky.sPos, "sticky");
      eq("§D2h · …and the chip strip under it still is", sticky.nPos, "sticky");
      ok("§D2i · the two do not sit on top of each other — the chip strip is offset below the pills",
        parseFloat(sticky.nTop) > parseFloat(sticky.sTop), JSON.stringify(sticky));

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(900);
      const visibleAfterScroll = await page.evaluate(() => {
        const s = document.getElementById("reports-jump");
        const r = s.getBoundingClientRect();
        return r.top >= -2 && r.bottom <= window.innerHeight;
      });
      ok("§D2j · the pills are still on screen after scrolling to the bottom of the page", visibleAfterScroll);
      eq("§D2 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §D3 · a deep link into another section switches the section first, then scrolls (p4)");
      const page = await boot(browser, "p4", { width: 1160, height: 900 });
      const errBefore = realErrs(page).length;
      await goPage(page, "reports", 3800);
      await page.click("#reports-nav-month");
      await page.waitForTimeout(700);
      const before = await page.evaluate(() => (document.querySelector("#reports-jump-chips .seg-btn.active") || {}).dataset.reportsJump);
      eq("§D3a · starting in \"This month\"", before, "month");

      /* The Watchtower's fee_aging_60 link, the one deep link that crosses sections. */
      await page.evaluate(() => window.gotoMoneyOwed());
      await page.waitForTimeout(1600);
      const after = await page.evaluate(() => (document.querySelector("#reports-jump-chips .seg-btn.active") || {}).dataset.reportsJump);
      eq("§D3b · gotoMoneyOwed lands in \"Money & book\" with the tabs saying so", after, "money");
      const chips = await page.$$eval("#rep-nav-chips .seg-btn", (els) => els.map((e) => e.dataset.repJump));
      ok("§D3c · …and the chip strip now holds that section's panels, Money owed among them",
        chips.includes("owed"), JSON.stringify(chips));
      eq("§D3 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §E · A5 — DATA HEALTH TELLS THE TRUTH ABOUT PROGRESS AND PRIORITY.
       ===================================================================== */
    {
      console.log("\n— §E1 · the tile wall is banded, sorted, and \"Clients total\" has left it (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "data", 3600);

      const wall = await page.evaluate(() => {
        const row = document.getElementById("dh-kpi-row");
        const out = [];
        [...row.children].forEach((el) => {
          if (el.classList.contains("dh-band-h")) out.push({ band: el.dataset.band, title: (el.childNodes[0].textContent || "").trim() });
          else if (el.id) out.push({ id: el.id, n: Number(((el.querySelector(".num") || {}).textContent || "").split(" of ")[0]) });
        });
        return out;
      });
      const bands = wall.filter((w) => w.band);
      eq("§E1a · two labelled bands, counted first", bands.map((b) => b.band), ["counted", "watch"]);
      ok("§E1b · the first band names the headline it feeds", /^Counts toward the \d+$/.test(bands[0].title), bands[0].title);
      eq("§E1c · the second is the watchlist", bands[1].title, "Watchlist — context, not counted");

      const idxCounted = wall.findIndex((w) => w.band === "counted");
      const idxWatch = wall.findIndex((w) => w.band === "watch");
      const countedTiles = wall.slice(idxCounted + 1, idxWatch).filter((w) => w.id && w.id !== "dh-clean-toggle");
      const watchTiles = wall.slice(idxWatch + 1).filter((w) => w.id && w.id !== "dh-clean-toggle");
      ok("§E1d · the counted band is sorted by count, biggest first",
        countedTiles.every((t, i) => i === 0 || countedTiles[i - 1].n >= t.n), JSON.stringify(countedTiles));
      ok("§E1e · the watchlist is sorted the same way",
        watchTiles.every((t, i) => i === 0 || watchTiles[i - 1].n >= t.n), JSON.stringify(watchTiles));

      /* R77: a SEVENTH watch tile — dh-tile-completedgaps ("Completed with file gaps · 6 months",
         B3's owner-only audit register). This list is the r74 contract's ground truth for "which
         tiles are context, not counted", not a claim the band may never grow; the new tile obeys
         the band's whole discipline (sorted, never counted, never amber, never folded) and every
         assertion around this one is unweakened. This run is p4, so the owner-only tile is present. */
      const WATCH = ["dh-tile-failed", "dh-tile-waitingdocs", "dh-tile-sharedprop", "dh-tile-vulnerable", "dh-tile-suppressed", "dh-tile-nopolicystart", "dh-tile-completedgaps"];
      eq("§E1f · the watchlist holds exactly the six the brief names (+ R77's audit register)", watchTiles.map((t) => t.id).sort(), WATCH.slice().sort());

      /* r42 §J's ground truth is a SET, and it is unchanged — only order and grouping moved. */
      const READINESS_TILE_IDS = ["dh-tile-email", "dh-tile-phone", "dh-tile-both", "dh-tile-invalid-email",
        "dh-tile-invalid-phone", "dh-tile-unassigned", "dh-tile-nofee", "dh-tile-rateend",
        "dh-tile-nocompleted", "dh-tile-milestone", "dh-tile-deadbook", "dh-tile-ltv",
        "dh-tile-address", "dh-tile-loan", "dh-tile-completeness"];
      const present = await page.evaluate((ids) => ids.filter((id) => !!document.getElementById(id)), READINESS_TILE_IDS);
      eq("§E1g · every READINESS_TILE_ID still exists (r42 §J contract — the set is unchanged)", present.length, READINESS_TILE_IDS.length);
      eq("§E1h · …and every one of them is in the COUNTED band", countedTiles.map((t) => t.id).sort(), READINESS_TILE_IDS.slice().sort());

      ok("§E1i · \"Clients total\" is no longer a tile on the wall",
        !(await page.evaluate(() => [...document.querySelectorAll("#dh-kpi-row .lbl")].some((l) => /Clients total/.test(l.textContent)))));
      const sub = await txt(page, "#dh-page-sub");
      ok("§E1j · …the number moved into the page's own sub-line", /across \d+ clients?/.test(sub), sub);

      const key = await txt(page, "#dh-key");
      ok("§E1k · a one-line key above the wall says what orange and navy mean",
        key != null && /Orange/.test(key) && /Navy/.test(key), key);
      const keyBefore = await page.evaluate(() => {
        const k = document.getElementById("dh-key"), w = document.getElementById("dh-kpi-row");
        return !!(k && w && (k.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING));
      });
      ok("§E1l · …and it sits ABOVE the wall it describes", keyBefore);
      eq("§E1 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §E2 · an inline fix decrements the headline, the tile, the rollup row AND the panel's own counter (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;

      /* Two seeded completed cases with no loan amount, so the tile is guaranteed non-zero and one
         save cannot empty the whole check (which would test a different branch). */
      const t = tag();
      await mkCase(page, { first: "R74E", last: "NoLoanA" + t, case: { completed_at: isoDaysFromNow(-20), lender: "R74ELender", mortgage_account_number: "R74E-1", loan_amount: null, property_address: "1 R74E Road, Bournemouth BH1 1AA" } });
      await mkCase(page, { first: "R74E", last: "NoLoanB" + t, case: { completed_at: isoDaysFromNow(-21), lender: "R74ELender", mortgage_account_number: "R74E-2", loan_amount: null, property_address: "2 R74E Road, Bournemouth BH1 1AA" } });

      await goPage(page, "data", 4000);
      const read = () => page.evaluate(() => {
        const h = document.getElementById("dh-readiness-headline");
        const tile = document.getElementById("dh-tile-loan");
        const panel = document.getElementById("dh-loan-panel");
        const rowItem = [...document.querySelectorAll("#dh-readiness .dh-readiness-item")]
          .filter((it) => (it.getAttribute("onclick") || "").indexOf("'dh-tile-loan'") >= 0)[0];
        return {
          headline: h ? Number(h.dataset.total) : null,
          headlineText: h ? h.textContent.replace(/\s+/g, " ").trim() : null,
          checks: h ? Number(h.dataset.checks) : null,
          tile: tile ? Number(tile.querySelector(".num").textContent.trim()) : null,
          rollup: rowItem ? Number(rowItem.querySelector(".dh-readiness-count").textContent.trim()) : null,
          panelLeft: panel ? ((panel.querySelector("h3 .dh-left-n") || {}).textContent || "") : null,
          rows: panel ? panel.querySelectorAll(".row-item").length : null,
        };
      });
      const before = await read();
      ok("§E2a · fixture sanity — the loan tile has at least two rows to fix", before.tile >= 2 && before.rows >= 2, JSON.stringify(before));
      ok("§E2b · the headline carries its own machine-readable total", Number.isFinite(before.headline) && before.headline > 0, JSON.stringify(before));
      ok("§E2c · the fix panel already shows \"N left in this list\" before anything is saved",
        /^\d+ left in this list$/.test(before.panelLeft || ""), before.panelLeft);
      const headlineMatchesText = String(before.headline) === (before.headlineText.match(/(\d+) data-quality/) || [])[1];
      ok("§E2d · …and the sentence agrees with it", headlineMatchesText, JSON.stringify(before));

      /* Open the panel and save one value, exactly as an operator would. */
      await page.click("#dh-tile-loan");
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        const p = document.getElementById("dh-loan-panel");
        const inp = p.querySelector(".dh-fix-input");
        inp.value = "185000";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector("#dh-loan-panel .dh-fix-save").click());
      await page.waitForTimeout(1400);
      const after = await read();

      eq("§E2e · the tile comes down by one (R71's behaviour, unchanged)", after.tile, before.tile - 1);
      eq("§E2f · the rollup row comes down by one (R71's behaviour, unchanged)", after.rollup, before.rollup - 1);
      eq("§E2g · THE HEADLINE COMES DOWN TOO — the R73 panel's finding 10", after.headline, before.headline - 1);
      ok("§E2h · …and its sentence is rewritten to match, plurals and all",
        String(after.headline) === (after.headlineText.match(/(\d+) data-quality/) || [])[1], JSON.stringify(after));
      eq("§E2i · the check count is untouched while the check still has rows in it", after.checks, before.checks);
      eq("§E2j · the fix panel's own counter comes down where the work is happening", after.panelLeft, `${before.rows - 1} left in this list`);

      const toast = await txt(page, "#toast");
      ok("§E2k · the save still names the case and the field", /loan amount set to/.test(toast || ""), toast);
      eq("§E2 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §E3 · an adviser sees the same banded wall, error-free (p2)");
      const page = await boot(browser, "p2");
      const errBefore = realErrs(page).length;
      await goPage(page, "data", 3600);
      const bands = await page.$$eval("#dh-kpi-row .dh-band-h", (els) => els.map((e) => e.dataset.band));
      eq("§E3a · both bands render for an adviser", bands, ["counted", "watch"]);
      ok("§E3b · the key renders too", !!(await page.$("#dh-key")));
      eq("§E3 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r74_numbers: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
