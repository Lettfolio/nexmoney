#!/usr/bin/env node
/* =============================================================================
   tests/r38.js — acceptance tests for ROUND 38: the new Retention page.

   What R38 shipped (see admin/app.js, admin/index.html):
    - A 13th nav destination, `data-page="retention"` (🔁), in the BOOK group
      (Clients/Protection/Retention) — NOT the collapsible Firm group, so
      every staff role sees it without opening anything.
    - `#page-retention`, gated by nothing (PAGE_ROLE_GATE has no "retention"
      entry) and reachable by hash deep-link (`#retention`, PAGE_HASH).
    - ONE scope control for the whole page, `#ret-scope-mine` / `#ret-scope-all`
      (persisted `localStorage.nx_ret_scope`), defaulting to Mine for an
      adviser (p2/p3) and All for admin/owner (p1/p4) — same rule as every
      other scope default in the app (retScopeResolved()).
    - `#ret-rates-panel` / `#ret-rates-list`: the FULL rate & ERC feed, from
      the SAME shared builder the dashboard drawer uses (buildRateErcFeed /
      renderRateErcRow), grouped Ended-first then Ending-soon (`.ret-group-h`
      headings), with a value/date sort toggle (`#ret-rates-sort`, owner
      only — showMoney()) and the same "Start retention case" / "retention
      started" buttons and confirm the drawer has always had, working
      identically from the page (RES-1's in-flight lock, the sold-property
      warning, the assignee line). Capped at RET_LIST_CAP=100 rather than the
      drawer's 15.
    - `#ret-pipeline-panel` / `#ret-pipeline-list` + `#ret-pipeline-stats`:
      open retention cases (readRetentionPipeline / retentionPipelineStats /
      renderRetentionRows — the SAME functions the drawer renders from),
      scoped by the case's OWN assigned_to (not the source case's), capped at
      100 rather than 12.
    - `#ret-cold-panel` / `#ret-cold-list`: the Clients page's own "cold"
      segment (coldClients() = clientHasAdviser + clientInSegment(..,"cold")
      over clientDataCached()), with a last-contact age and a
      `#ret-cold-goto` "Work this list on Clients →" that calls
      gotoClientSegment("cold", adviser) — R38's one addition to that
      function, so the hand-off keeps the page's own adviser scope instead
      of silently widening to the whole firm.
    - Dashboard drawers (`#alerts-rateerc` ≤15, `#retention-list` ≤12) are
      UNCHANGED in content/caps — same shared builders, same rows — but each
      gained a link to the Retention page: the Rate & ERC drawer's header
      grew `#rate-erc-open-retention` (`.ret-page-link`, nav('retention')),
      and both drawers' "…and N more" overflow tails now read "…see the
      Retention page" with a button that also calls nav('retention').
    - startRetentionCase / markRateReminded now repaint whichever surface is
      open — the Retention page included — when they finish.

   §A  nav + page (13 buttons, Book-group placement, nav('retention'),
       #retention deep-link)
   §B  scope (adviser Mine default + row-level adviser check against the
       mock db, All widens all three panels, persists across reload, key
       clear reverts to Mine, admin/owner default All)
   §C  rates panel (Ended-before-Ending-soon, page vs drawer feed parity +
       page shows more once the feed exceeds 15, sort toggle, Start
       retention case from the page)
   §D  pipeline panel (open cases + won/lost/conversion line, cross-checked
       against the mock db)
   §E  cold panel (cold clients + last-contact ages, #ret-cold-goto deep-link
       with the adviser filter carried over)
   §F  dashboard drawers unchanged (#alerts-rateerc ≤15 + its Retention-page
       link, #retention-list ≤12 + its own link)
   §G  no console errors, all four personas

   EVERY figure this file asserts is either read straight back off the mock
   db, computed by the test's own construction/seeding, or read live off
   app.js's own module state (CLIENT_SEG_CONTACT_MONTHS, RET_LIST_CAP,
   lastContactAgeLabel()) — never a number this file invented independently
   of the fixture/app it is testing against, the same standing rule
   tests/r37.js/r24.js/r36.js already follow.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r38.js
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
  page.__dialogAnswer = "accept";
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    if (page.__dialogAnswer === "dismiss") await d.dismiss(); else await d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const noNewErr = (page, before) => (page.__err || []).length === before;
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1200 : ms);
};

/* Every key the Retention page (and the surfaces it deep-links from/to) can touch, cleared the
   same defensive way every suite in this harness clears them before it depends on a default. */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_ret_scope", "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads",
  "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — same technique tests/r37.js/r36.js/r35.js
   /r34.js/r31.js already use.
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
async function insertNote(page, fields) {
  return page.evaluate(async (f) => {
    const db = window.__mockDb;
    const { data, error } = await db.from("case_notes").insert(f).select("id").single();
    if (error) throw new Error("note insert: " + error.message);
    return data.id;
  }, fields);
}
let uniq = 0;
function tag() { uniq += 1; return `R38U${Date.now().toString(36)}${uniq}`; }
async function mkClientCase(page, opts) {
  const o = opts || {};
  const clId = await insertClient(page, {
    first_name: o.first || "R38", last_name: o.last || ("Case" + tag()),
    email: o.email !== undefined ? o.email : `r38.${tag().toLowerCase()}@example.com`, phone: "07700900000",
  });
  const row = Object.assign({ client_id: clId, case_kind: "remortgage", stage: "application", assigned_to: "p2" }, o.case || {});
  const caseId = await insertCase(page, row);
  return { clId, caseId };
}
const readCase = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", id).single();
  return data;
}, caseId);
const readAllCases = (page) => page.evaluate(async () => {
  const { data } = await window.__mockDb.from("cases").select("*");
  return data || [];
});
const isoDaysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/* Rows on both the drawers and the page carry the case/client id in an onclick attribute
   (onclick="openCase('<id>')" / onclick="openClient('<id>')") rather than a data- attribute — this
   pulls it back out the same way the row was built, so a test never has to guess a selector the
   product markup doesn't offer. */
async function rowIds(page, containerSel, fnName) {
  return page.evaluate(({ sel, fn }) => {
    return [...document.querySelectorAll(sel + " .row-item .t[onclick]")].map((el) => {
      const m = el.getAttribute("onclick").match(new RegExp(fn + "\\('([^']+)'\\)"));
      return m ? m[1] : null;
    }).filter(Boolean);
  }, { sel: containerSel, fn: fnName });
}
async function groupHeadings(page, containerSel) {
  return page.evaluate((sel) => [...document.querySelectorAll(sel + " .ret-group-h")].map((h) => h.textContent.replace(/\s+/g, " ").trim()), containerSel);
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
       §A · NAV + PAGE
       ======================================================================= */
    {
      console.log("\n— §A1 · 13 data-page buttons; Retention lives in the Book group, not Firm (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const total = await page.evaluate(() => document.querySelectorAll("#topnav button[data-page]").length);
      eq("§A1a · #topnav has 13 data-page buttons", total, 13);

      const retBtn = await page.evaluate(() => !!document.querySelector('#topnav button[data-page="retention"]'));
      ok("§A1b · the Retention button exists", retBtn);

      const inFirmGroup = await page.evaluate(() => {
        const g = document.getElementById("nav-firm-group");
        return g ? !!g.querySelector('button[data-page="retention"]') : null;
      });
      ok("§A1c · the Retention button is NOT inside #nav-firm-group", inFirmGroup === false, JSON.stringify(inFirmGroup));

      const group = await page.evaluate(() => {
        let el = document.querySelector('#topnav button[data-page="retention"]').previousElementSibling;
        while (el && !el.classList.contains("nav-group-head")) el = el.previousElementSibling;
        return el ? el.textContent.trim() : null;
      });
      eq("§A1d · the Retention button's own group heading reads \"Book\"", group, "Book");

      const visibleForAdviser = await page.evaluate(() => document.querySelector('#topnav button[data-page="retention"]').offsetParent !== null);
      ok("§A1e · it is visible for an adviser without opening anything (the Book group is never collapsed)", visibleForAdviser);

      ok("§A1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §A2 · nav('retention') shows #page-retention and hides every other page (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await goto(page, "retention");

      const state = await page.evaluate(() => {
        const others = [...document.querySelectorAll(".page")].filter((s) => s.id !== "page-retention");
        return {
          retentionHidden: document.getElementById("page-retention").classList.contains("hidden"),
          othersAllHidden: others.every((s) => s.classList.contains("hidden")),
          navActive: document.querySelector('#topnav button[data-page="retention"]').classList.contains("active"),
          navAriaCurrent: document.querySelector('#topnav button[data-page="retention"]').getAttribute("aria-current"),
        };
      });
      ok("§A2a · #page-retention is visible", !state.retentionHidden, JSON.stringify(state));
      ok("§A2b · every other .page is hidden", state.othersAllHidden);
      ok("§A2c · the Retention nav button is .active", state.navActive);
      eq("§A2d · …and carries aria-current=\"page\"", state.navAriaCurrent, "page");

      ok("§A2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §A3 · #retention deep-links straight to the page on cold load (p4)");
      const page = await browser.newPage();
      page.__err = [];
      page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err.push(m.text()); });
      page.on("pageerror", (e) => page.__err.push("pageerror: " + e.message));
      await page.goto(`${BASE}?as=p4#retention`);
      await wait(page, SETTLE + 800);

      const state = await page.evaluate(() => ({
        hidden: document.getElementById("page-retention").classList.contains("hidden"),
        hash: location.hash,
      }));
      ok("§A3a · #page-retention is visible straight off the deep-link", !state.hidden, JSON.stringify(state));
      eq("§A3b · the hash is normalised to #retention", state.hash, "#retention");

      ok("§A3 · no console errors", page.__err.length === 0, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §B · SCOPE — one control across all three panels
       ======================================================================= */
    {
      console.log("\n— §B1 · adviser (p2) defaults to Mine — every rendered rates row's case is actually assigned to p2 (mock db cross-check)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const mine = await mkClientCase(page, { first: "R38B1", last: "Mine" + tag(), case: { stage: "completed", assigned_to: "p2", rate_end_date: isoDaysFromNow(20), lender: "Skipton", loan_amount: 150000 } });
      const other = await mkClientCase(page, { first: "R38B1", last: "Other" + tag(), case: { stage: "completed", assigned_to: "p3", rate_end_date: isoDaysFromNow(20), lender: "Skipton", loan_amount: 150000 } });

      await goto(page, "retention", 1800);
      const scopeState = await page.evaluate(() => ({
        mineActive: document.getElementById("ret-scope-mine").classList.contains("scope-active"),
        allActive: document.getElementById("ret-scope-all").classList.contains("scope-active"),
        note: document.getElementById("ret-scope-note").textContent,
      }));
      ok("§B1a · #ret-scope-mine starts active for an adviser", scopeState.mineActive, JSON.stringify(scopeState));
      ok("§B1b · #ret-scope-all does not", !scopeState.allActive);
      ok("§B1c · the scope note describes \"your cases and your clients\"", /your cases and your clients/.test(scopeState.note), scopeState.note);

      const ids = await rowIds(page, "#ret-rates-list", "openCase");
      ok("fixture · the seeded p2 case is on the Mine-scoped rates list", ids.includes(mine.caseId), JSON.stringify(ids));
      ok("fixture · the seeded p3 case is NOT (Mine really is scoped)", !ids.includes(other.caseId), JSON.stringify(ids));

      const advisers = await page.evaluate(async (rowIdsArg) => {
        const { data } = await window.__mockDb.from("cases").select("id,assigned_to").in("id", rowIdsArg);
        return (data || []).map((c) => c.assigned_to);
      }, ids);
      ok("§B1d · EVERY rendered rates row's case is assigned to p2 (read back off the mock db)", advisers.every((a) => a === "p2"), JSON.stringify(advisers));

      ok("§B1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §B2 · toggling All widens all three panels; persists across reload; clearing the key reverts to Mine (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      // Re-seed (fresh browser context — the §B1 inserts don't carry over into this mock db instance).
      const mine = await mkClientCase(page, { first: "R38B2", last: "Mine" + tag(), case: { stage: "completed", assigned_to: "p2", rate_end_date: isoDaysFromNow(25), lender: "Halifax", loan_amount: 120000 } });
      const other = await mkClientCase(page, { first: "R38B2", last: "Other" + tag(), case: { stage: "completed", assigned_to: "p3", rate_end_date: isoDaysFromNow(25), lender: "Halifax", loan_amount: 120000 } });
      const coldMine = await mkClientCase(page, { first: "R38B2Cold", last: "Mine" + tag(), case: { stage: "application", assigned_to: "p2" } });
      const coldOther = await mkClientCase(page, { first: "R38B2Cold", last: "Other" + tag(), case: { stage: "application", assigned_to: "p3" } });

      await goto(page, "retention", 1800);
      const beforeRates = await rowIds(page, "#ret-rates-list", "openCase");
      const beforeCold = await rowIds(page, "#ret-cold-list", "openClient");
      ok("fixture (Mine) · rates list has the p2 case, not the p3 one", beforeRates.includes(mine.caseId) && !beforeRates.includes(other.caseId), JSON.stringify(beforeRates));
      ok("fixture (Mine) · cold list has the p2 client, not the p3 one", beforeCold.includes(coldMine.clId) && !beforeCold.includes(coldOther.clId), JSON.stringify(beforeCold));

      await page.click("#ret-scope-all");
      await wait(page, 1500);
      const afterAllToggle = await page.evaluate(() => ({
        stored: localStorage.getItem("nx_ret_scope"),
        allActive: document.getElementById("ret-scope-all").classList.contains("scope-active"),
      }));
      eq("§B2a · clicking All persists nx_ret_scope=\"all\"", afterAllToggle.stored, "all");
      ok("§B2b · #ret-scope-all is now the active control", afterAllToggle.allActive);

      const afterRates = await rowIds(page, "#ret-rates-list", "openCase");
      const afterPipelineNote = await page.$eval("#ret-pipeline-stats", (e) => e.textContent);
      const afterCold = await rowIds(page, "#ret-cold-list", "openClient");
      ok("§B2c · All widens the rates panel to include the p3 case too", afterRates.includes(mine.caseId) && afterRates.includes(other.caseId), JSON.stringify(afterRates));
      ok("§B2d · …and the pipeline panel's sub-line says \"every adviser\"", /every adviser/.test(afterPipelineNote), afterPipelineNote);
      ok("§B2e · …and the cold panel to include the p3 client too", afterCold.includes(coldMine.clId) && afterCold.includes(coldOther.clId), JSON.stringify(afterCold));

      await page.reload();
      await wait(page, SETTLE + 500);
      const afterReload = await page.evaluate(() => document.getElementById("ret-scope-all").classList.contains("scope-active"));
      ok("§B2f · All survives a reload", afterReload);

      await page.evaluate(() => localStorage.removeItem("nx_ret_scope"));
      await page.reload();
      await wait(page, SETTLE + 500);
      const afterClear = await page.evaluate(() => ({
        mineActive: document.getElementById("ret-scope-mine").classList.contains("scope-active"),
        allActive: document.getElementById("ret-scope-all").classList.contains("scope-active"),
      }));
      ok("§B2g · clearing nx_ret_scope reverts an adviser to Mine", afterClear.mineActive && !afterClear.allActive, JSON.stringify(afterClear));

      ok("§B2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §B3 · admin (p1) and owner (p4) both default to All", "");
      for (const persona of ["p1", "p4"]) {
        const page = await newPage(browser, persona);
        const errBefore = (page.__err || []).length;
        await clearNxKeys(page);
        await goto(page, "retention", 1500);
        const state = await page.evaluate(() => ({
          mineActive: document.getElementById("ret-scope-mine").classList.contains("scope-active"),
          allActive: document.getElementById("ret-scope-all").classList.contains("scope-active"),
        }));
        ok(`§B3 · ${persona} defaults to All`, state.allActive && !state.mineActive, JSON.stringify(state));
        ok(`§B3 · no console errors (${persona})`, noNewErr(page, errBefore), JSON.stringify(page.__err));
        await page.close();
      }
    }

    /* =======================================================================
       §C · RATES PANEL
       ======================================================================= */
    {
      console.log("\n— §C1 · Ended renders before Ending soon (p4, All scope)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      await mkClientCase(page, { first: "R38C1", last: "Ended" + tag(), case: { stage: "completed", assigned_to: "p2", rate_end_date: isoDaysFromNow(-15), lender: "NatWest", loan_amount: 90000 } });
      await mkClientCase(page, { first: "R38C1", last: "Soon" + tag(), case: { stage: "completed", assigned_to: "p2", rate_end_date: isoDaysFromNow(40), lender: "NatWest", loan_amount: 90000 } });

      await goto(page, "retention", 1800);
      const headings = await groupHeadings(page, "#ret-rates-list");
      ok("§C1a · both group headings are present", headings.some((h) => h.startsWith("Ended")) && headings.some((h) => h.startsWith("Ending soon")), JSON.stringify(headings));
      const endedIdx = headings.findIndex((h) => h.startsWith("Ended"));
      const soonIdx = headings.findIndex((h) => h.startsWith("Ending soon"));
      ok("§C1b · \"Ended\" comes before \"Ending soon\" in the DOM", endedIdx >= 0 && soonIdx >= 0 && endedIdx < soonIdx, JSON.stringify({ headings, endedIdx, soonIdx }));

      ok("§C1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §C2 · page vs drawer feed parity, and the page shows MORE once the scoped feed exceeds the drawer's 15-row cap (p2, Mine)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      // 20 distinct, address-less (so none of them collapse into each other — R7-2's dedupe only
      // fires on a shared property+date key) p2-assigned completed cases inside the reminder window.
      const seededIds = [];
      for (let i = 0; i < 20; i++) {
        const { caseId } = await mkClientCase(page, {
          first: "R38C2", last: `Bulk${i}${tag()}`,
          case: { stage: "completed", assigned_to: "p2", rate_end_date: isoDaysFromNow(10 + i), lender: "Nationwide", loan_amount: 80000 + i * 1000 },
        });
        seededIds.push(caseId);
      }

      await goto(page, "dashboard", 1800);
      const drawerRows = await rowIds(page, "#alerts-rateerc", "openCase");
      const drawerBadge = await page.$eval("#rate-erc-panel h3", (e) => e.textContent);
      ok("§C2a · the drawer never renders more than 15 rows", drawerRows.length <= 15, drawerRows.length);
      const drawerSoonMatch = drawerBadge.match(/(\d+)\s+in the \d+-month window/) || drawerBadge.match(/(\d+)\s+ending soon/);
      ok("fixture · the drawer's own badge reports a scoped count", !!drawerSoonMatch, drawerBadge);

      await goto(page, "retention", 1800);
      const pageRows = await rowIds(page, "#ret-rates-list", "openCase");
      const pageBadge = await page.$eval("#ret-rates-h3", (e) => e.textContent);
      const pageSoonMatch = pageBadge.match(/(\d+)\s+in the \d+-month window/);
      ok("fixture · the page's own badge reports a scoped count", !!pageSoonMatch, pageBadge);

      if (drawerSoonMatch && pageSoonMatch) {
        eq("§C2b · the page and the drawer's scoped \"ending soon\" badge COUNT agree (same feed, same scope)", pageSoonMatch[1], drawerSoonMatch[1]);
      }
      ok("§C2c · the page is un-truncated: it renders more rows than the drawer's 15-row cap", pageRows.length > 15, JSON.stringify({ drawer: drawerRows.length, page: pageRows.length }));
      ok("§C2d · every seeded case reaches the page", seededIds.every((id) => pageRows.includes(id)), JSON.stringify({ seededIds, pageRows }));
      const drawerTail = await page.evaluate(() => document.getElementById("alerts-rateerc").innerHTML.includes("see the Retention page"));
      ok("§C2e · the drawer's overflow tail points at the Retention page (\"…see the Retention page\")", drawerTail);

      ok("§C2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §C3 · the value/date sort toggle actually reorders the rates list (p4, owner-only control)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const big = await mkClientCase(page, { first: "R38C3", last: "BigLoan" + tag(), case: { stage: "completed", assigned_to: "p2", rate_end_date: isoDaysFromNow(45), lender: "TSB", loan_amount: 50000000 } });
      const soonest = await mkClientCase(page, { first: "R38C3", last: "SoonestDate" + tag(), case: { stage: "completed", assigned_to: "p2", rate_end_date: isoDaysFromNow(1), lender: "TSB", loan_amount: 5000 } });

      await goto(page, "retention", 1800);
      const sortBtnPresent = await page.evaluate(() => !!document.getElementById("ret-rates-sort"));
      ok("§C3a · the owner sees the sort toggle", sortBtnPresent);

      const byValue = await rowIds(page, "#ret-rates-list", "openCase");
      ok("§C3b · default sort is by value — the huge loan sorts ahead of the soonest-but-tiny one", byValue.indexOf(big.caseId) < byValue.indexOf(soonest.caseId), JSON.stringify({ big: byValue.indexOf(big.caseId), soonest: byValue.indexOf(soonest.caseId) }));

      await page.click("#ret-rates-sort");
      await wait(page, 1200);
      const byDate = await rowIds(page, "#ret-rates-list", "openCase");
      ok("§C3c · after toggling, date sort puts the soonest rate end ahead of the merely-bigger loan", byDate.indexOf(soonest.caseId) < byDate.indexOf(big.caseId), JSON.stringify({ big: byDate.indexOf(big.caseId), soonest: byDate.indexOf(soonest.caseId) }));

      const label = await page.$eval("#ret-rates-sort", (e) => e.textContent.trim());
      eq("§C3d · the toggle's own label now reads \"By date\"", label, "↕ By date");

      ok("§C3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §C4 · \"Start retention case\" from the page: confirm fires, the row flips, and a new case lands in the pipeline panel (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      page.__dialogAnswer = "accept";

      const src = await mkClientCase(page, {
        first: "R38C4", last: "StartFromPage" + tag(), email: `r38c4.${tag().toLowerCase()}@example.com`,
        case: { stage: "completed", assigned_to: "p2", rate_end_date: isoDaysFromNow(-8), lender: "Coventry", loan_amount: 175000 },
      });

      await goto(page, "retention", 1800);
      const rowSel = `#ret-rates-list tr, #ret-rates-list .row-item`;
      const startBtnSel = `#ret-rates-list button.btn-retention[onclick*="startRetentionCase('${src.caseId}'"]`;
      await page.waitForSelector(startBtnSel, { timeout: 5000 }).catch(() => {});
      const btnPresent = await page.$(startBtnSel);
      ok("fixture · the seeded ended case shows a Start retention case button", !!btnPresent);

      await page.click(startBtnSel);
      await wait(page, 1800);

      ok("§C4a · a confirm dialog actually fired", page.__dialogs.some((d) => d.type === "confirm" && /Start a retention case/.test(d.message)), JSON.stringify(page.__dialogs));

      const afterSource = await readCase(page, src.caseId);
      ok("§C4b · the source case is now stamped as reminded", !!afterSource.rate_reminder_queued_at, JSON.stringify(afterSource));

      const flippedBtnGone = await page.evaluate((id) => !document.querySelector(`#ret-rates-list button.btn-retention[onclick*="startRetentionCase('${id}'"]`), src.caseId);
      ok("§C4c · the row's \"Start retention case\" button is gone (it flipped)", flippedBtnGone);

      const allCases = await readAllCases(page);
      const successor = allCases.find((c) => c.retention_source_case_id === src.caseId);
      ok("§C4d · a new successor case now exists, linked back to the source", !!successor, JSON.stringify(successor));

      const pipelineIds = await rowIds(page, "#ret-pipeline-list", "openCase");
      ok("§C4e · the new successor case appears in #ret-pipeline-list", successor && pipelineIds.includes(successor.id), JSON.stringify({ successor: successor && successor.id, pipelineIds }));

      ok("§C4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §D · PIPELINE PANEL
       ======================================================================= */
    {
      console.log("\n— §D · open retention cases listed, and the won/lost/conversion line matches the mock db (p4, All)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const src1 = await mkClientCase(page, { first: "R38D", last: "Src1" + tag(), case: { stage: "completed", assigned_to: "p2" } });
      const src2 = await mkClientCase(page, { first: "R38D", last: "Src2" + tag(), case: { stage: "completed", assigned_to: "p3" } });
      const src3 = await mkClientCase(page, { first: "R38D", last: "Src3" + tag(), case: { stage: "completed", assigned_to: "p2" } });
      const openRet = await mkClientCase(page, { first: "R38D", last: "OpenRet" + tag(), case: { stage: "application", assigned_to: "p2", retention_source_case_id: src1.caseId } });
      const wonRet = await mkClientCase(page, { first: "R38D", last: "WonRet" + tag(), case: { stage: "completed", assigned_to: "p3", retention_source_case_id: src2.caseId } });
      const lostRet = await mkClientCase(page, { first: "R38D", last: "LostRet" + tag(), case: { stage: "not_proceeding", assigned_to: "p2", retention_source_case_id: src3.caseId } });

      await goto(page, "retention", 1800);
      const ids = await rowIds(page, "#ret-pipeline-list", "openCase");
      ok("§D1a · the OPEN retention case is listed", ids.includes(openRet.caseId), JSON.stringify(ids));
      ok("§D1b · the WON (completed) one is not (only open ones render)", !ids.includes(wonRet.caseId));
      ok("§D1c · the LOST (not_proceeding) one is not either", !ids.includes(lostRet.caseId));

      // Cross-check the stats line independently, straight off the mock db, the same predicate
      // readRetentionPipeline()/retentionPipelineStats() use.
      const computed = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,stage,retention_source_case_id").not("retention_source_case_id", "is", null);
        const rows = data || [];
        const open = rows.filter((c) => !["completed", "not_proceeding"].includes(c.stage)).length;
        const won = rows.filter((c) => c.stage === "completed").length;
        const lost = rows.filter((c) => c.stage === "not_proceeding").length;
        const rate = won + lost ? Math.round((won / (won + lost)) * 100) : null;
        return { open, won, lost, rate };
      });
      const statsText = await page.$eval("#ret-pipeline-stats", (e) => e.textContent);
      ok("§D2a · the stats line's open count matches the mock db", statsText.includes(`${computed.open} open`), JSON.stringify({ statsText, computed }));
      ok("§D2b · …won", statsText.includes(`${computed.won} won`), JSON.stringify({ statsText, computed }));
      ok("§D2c · …lost", statsText.includes(`${computed.lost} lost`), JSON.stringify({ statsText, computed }));
      if (computed.rate != null) ok("§D2d · …and the conversion percentage", statsText.includes(`${computed.rate}% conversion`), JSON.stringify({ statsText, computed }));

      ok("§D · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §E · COLD PANEL
       ======================================================================= */
    {
      console.log("\n— §E · cold clients listed with a last-contact age, and #ret-cold-goto deep-links to Clients with the segment + adviser filter carried over (p2, then p4)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      // Truly silent — no notes/emails/appointments/tasks at all — so it is cold regardless of cutoff.
      const silent = await mkClientCase(page, { first: "R38E", last: "Silent" + tag(), case: { stage: "application", assigned_to: "p2" } });
      // A note inside the 210-day comms-read window but past the 6-month cold cutoff, so the row
      // renders a real "last contact N days ago" detail rather than "no contact of any kind".
      const agedTs = new Date(Date.now() - 200 * 86400000).toISOString();
      const aged = await mkClientCase(page, { first: "R38E", last: "AgedContact" + tag(), case: { stage: "application", assigned_to: "p2" } });
      await insertNote(page, { case_id: aged.caseId, body: "R38 aged note", created_at: agedTs, created_by: "p2" });
      // Warm (contacted yesterday) — must NOT be cold.
      const warm = await mkClientCase(page, { first: "R38E", last: "Warm" + tag(), case: { stage: "application", assigned_to: "p2" } });
      await insertNote(page, { case_id: warm.caseId, body: "R38 fresh note", created_at: new Date().toISOString(), created_by: "p2" });

      await goto(page, "retention", 1800);
      const coldIds = await rowIds(page, "#ret-cold-list", "openClient");
      ok("§E1a · the silent client is on the cold list", coldIds.includes(silent.clId), JSON.stringify(coldIds));
      ok("§E1b · the aged-contact client is on the cold list too", coldIds.includes(aged.clId), JSON.stringify(coldIds));
      ok("§E1c · the warm client is NOT", !coldIds.includes(warm.clId), JSON.stringify(coldIds));

      // lastContactAgeLabel is a plain top-level function declaration in app.js's classic (non-module)
      // script, so it is reachable by name from page.evaluate() the same way tests/r37.js already
      // reads CLIENT_SEG_CONTACT_MONTHS — this computes the EXPECTED age off the app's own function
      // rather than this file re-deriving the day-count math independently.
      const expectedAge = await page.evaluate((ts) => lastContactAgeLabel(ts), agedTs);
      const agedRowText = await page.evaluate((id) => {
        const row = [...document.querySelectorAll("#ret-cold-list .row-item")].find((r) => r.querySelector(`.t[onclick="openClient('${id}')"]`));
        return row ? row.textContent : null;
      }, aged.clId);
      ok("§E1d · the aged client's row shows the SAME last-contact age app.js itself computes", agedRowText && agedRowText.includes(expectedAge), JSON.stringify({ agedRowText, expectedAge }));

      await page.click("#ret-cold-goto");
      await wait(page, 1500);
      const afterGoto = await page.evaluate(() => ({
        onClients: !document.getElementById("page-clients").classList.contains("hidden"),
        adviserVal: document.getElementById("client-adviser").value,
        coldChipActive: !!document.querySelector('#client-segment .seg-btn.active[data-seg="cold"]'),
      }));
      eq("§E2a · #ret-cold-goto lands on the Clients page", afterGoto.onClients, true);
      ok("§E2b · …with the cold segment chip active", afterGoto.coldChipActive, JSON.stringify(afterGoto));
      eq("§E2c · …and the adviser filter carried over from the page's Mine scope (p2)", afterGoto.adviserVal, "p2");

      ok("§E · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §E3 · #ret-cold-goto on the All scope lands on Clients with EVERY adviser (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "retention", 1500);
      const gotoPresent = await page.$("#ret-cold-goto");
      ok("fixture · #ret-cold-goto is present for the owner too", !!gotoPresent);
      await page.click("#ret-cold-goto");
      await wait(page, 1500);
      const adviserVal = await page.$eval("#client-adviser", (e) => e.value);
      eq("§E3 · the adviser filter is \"all\" (the page's own scope was All)", adviserVal, "all");
      ok("§E3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §F · DASHBOARD DRAWERS UNCHANGED
       ======================================================================= */
    {
      console.log("\n— §F1 · #alerts-rateerc stays ≤15 and its header link opens the Retention page (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "dashboard", 1500);

      const rows = await rowIds(page, "#alerts-rateerc", "openCase");
      ok("§F1a · #alerts-rateerc renders 15 rows or fewer", rows.length <= 15, rows.length);
      const linkPresent = await page.evaluate(() => {
        const el = document.getElementById("rate-erc-open-retention");
        return el ? { present: true, classHas: el.classList.contains("ret-page-link"), text: el.textContent } : { present: false };
      });
      ok("§F1b · #rate-erc-open-retention is present with the ret-page-link class", linkPresent.present && linkPresent.classHas, JSON.stringify(linkPresent));
      ok("§F1c · …and its label says \"Open Retention page\"", /Open Retention page/.test(linkPresent.text || ""), linkPresent.text);

      await page.click("#rate-erc-open-retention");
      await wait(page, 1200);
      const onRetention = await page.evaluate(() => !document.getElementById("page-retention").classList.contains("hidden"));
      ok("§F1d · clicking it navigates to the Retention page", onRetention);

      ok("§F1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §F2 · #retention-list stays ≤12 with an overflow link once the pipeline exceeds that, and its ids stay intact (p4, All)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      for (let i = 0; i < 16; i++) {
        const src = await mkClientCase(page, { first: "R38F2", last: `Src${i}${tag()}`, case: { stage: "completed", assigned_to: i % 2 ? "p2" : "p3" } });
        await mkClientCase(page, { first: "R38F2", last: `Open${i}${tag()}`, case: { stage: "application", assigned_to: i % 2 ? "p2" : "p3", retention_source_case_id: src.caseId } });
      }

      await goto(page, "dashboard", 1800);
      const drawerIds = await rowIds(page, "#retention-list", "openCase");
      ok("§F2a · #retention-list renders 12 rows or fewer", drawerIds.length <= 12, drawerIds.length);
      const overflowTail = await page.evaluate(() => document.getElementById("retention-list").innerHTML.includes("see the Retention page"));
      ok("§F2b · the overflow tail (\"…see the Retention page\") is present once the pipeline exceeds 12", overflowTail);

      const idsAllPresent = await page.evaluate(() => !!(document.getElementById("alerts-rateerc") && document.getElementById("retention-list") && document.getElementById("retention-stats")));
      ok("§F2c · #alerts-rateerc / #retention-list / #retention-stats ids are all still intact", idsAllPresent);

      await goto(page, "retention", 1800);
      const pageIds = await rowIds(page, "#ret-pipeline-list", "openCase");
      ok("§F2d · the (un-truncated) Retention page shows more open retention cases than the drawer's 12", pageIds.length > drawerIds.length, JSON.stringify({ page: pageIds.length, drawer: drawerIds.length }));

      ok("§F2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §G · NO CONSOLE ERRORS, ALL FOUR PERSONAS
       ======================================================================= */
    {
      console.log("\n— §G · visiting the Retention page throws no console errors for any of the four staff personas");
      for (const persona of ["p1", "p2", "p3", "p4"]) {
        const page = await newPage(browser, persona);
        const errBefore = (page.__err || []).length;
        await goto(page, "retention", 1800);
        const visible = await page.evaluate(() => !document.getElementById("page-retention").classList.contains("hidden"));
        ok(`§G · ${persona} can open the Retention page`, visible);
        ok(`§G · no console errors (${persona})`, noNewErr(page, errBefore), JSON.stringify(page.__err));
        await page.close();
      }
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r38: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
