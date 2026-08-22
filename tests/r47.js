#!/usr/bin/env node
/* =============================================================================
   tests/r47.js — acceptance tests for ROUND 47 GATE 0: rate-recency floor on
   the "today" surfaces (Bug A) + cold segment ignoring import provenance
   notes (Bug B). admin/app.js + admin/mock-supabase.js only, no schema.

   What R47 shipped (see the round's own commit + inline comments):

   BUG A — RATE-RECENCY FLOOR. Rate feeds had no lower age bound, so
   back-book rates that ended years ago (oldest 2017) flooded My Day, the
   dashboard KPI strip and the dashboard Rate & ERC drawer.
     - SQL (already migrated to prod, r47_briefing_rate_recency_floor):
       get_briefing's rate_urgent block gained
       `and c.rate_end_date >= current_date - interval '18 months'`.
     - mock-supabase.js's rpc_get_briefing mirrors it inline:
       `days <= 60 && days >= -Math.round(18 * 30.44)` (was `days <= 60`).
     - app.js gained module consts `RATE_ACTION_FLOOR_DAYS`
       (`-Math.round(18*30.44)`, ≈ -548) and `rateWithinActionFloor(a, on)`.
     - renderTodayKpis' `ratesSoon` (the "Rates ending ≤Nmo" KPI tile) now
       ALSO requires `rateWithinActionFloor(a, true)`.
     - buildRateErcFeed gained `opts.recentOnly`: when true, BOTH
       `ratesSoonAll` and `ercFlagsAll` require `rateWithinActionFloor(a,
       true)`. loadDashboard's caller (the drawer, #alerts-rateerc) passes
       `recentOnly:true`. loadRetentionRates' caller (the Retention page,
       #ret-rates-list) does NOT — deliberately: the full lapsed recovery
       book is the Retention page's whole purpose and must stay un-floored.

   BUG B — COLD SEGMENT IGNORED IMPORT PROVENANCE. The back-book import
   wrote 2,854 notes dated import-day; loadClientData's "last contact" map
   counted ANY note as contact, so ~1,133/1,162 clients read "contacted
   today" and the cold segment collapsed to ~29.
     - app.js gained `SYSTEM_NOTE_RE = /^\s*SB-IMPORT-\d/` and
       `isSystemProvenanceNote(body)`.
     - loadClientData's case_notes read widened to
       `select("case_id,created_at,body")`; its bump loop now skips a note
       where `isSystemProvenanceNote(n.body)` is true.
     - loadClientData is the ONE builder behind both the Clients-page cold
       segment (coldClients()) and the Retention-page cold panel
       (clientDataCached()/coldClients() again) — one fix, both surfaces.
     - The dashboard's "no-next-action radar" (loadUnactioned) is
       unaffected — it reads live cases only, never case_notes.

   §A — MY DAY (mock get_briefing rate_urgent) — the floor, in the RPC
        directly. A1: rate ended ~4y ago → NOT in rate_urgent items. A2:
        rate ended 3mo ago → IS present. A3: rate ending in 30 days (still
        future) → present (unaffected by a floor on the PAST side only).
        A4/A5: the ~18mo boundary at whole-month granularity (17mo ago
        present, 19mo ago absent) matching the round brief's own framing.
        A6/A7: the same boundary at single-day precision, read live off
        the floor's own formula rather than assumed (>= floor included,
        the first day past it excluded) — the same rigor tests/r45.js's
        §A6 applies to its 180-day boundary.
   §B — buildRateErcFeed's opts.recentOnly, called directly (bypassing the
        DOM entirely, the same technique tests/r45.js's ground-truth
        helpers use) — the floor excludes an old-ended alert from BOTH
        ratesSoonAll and ercFlagsAll when recentOnly:true, and excludes
        neither when recentOnly is omitted (the Retention page's own call
        shape) — proving the split at the one function both surfaces share,
        before ever touching a live page's DOM.
   §C — THE SPLIT, ON THE REAL PAGES. The same old-ended case, driven
        through the real loadDashboard (recentOnly:true): absent from the
        KPI "Rates ending" tile's count (a before/after seed delta) and
        absent from #alerts-rateerc's rendered rows. Then, same case,
        through the real loadRetentionPage (no recentOnly): STILL present
        in #ret-rates-list. This dashboard-floored / retention-unfloored
        split is the crux of Bug A's fix and is tested explicitly, on both
        the pure builder (§B) and the rendered pages (§C).
   §D — A REAL DEFECT IN THIS ROUND'S OWN DIFF, reported per the round
        brief rather than papered over. renderTodayKpis' R47 diff touched
        ONLY the `ratesSoon` line — `ercFlags` (the "ERC outlasts rate"
        tile, fed by the SAME `alerts` array, linked to the SAME drawer via
        `kpiGoto('erc')` → #alerts-rateerc) never gained the floor. So an
        ERC alert on a rate that ended years ago is correctly excluded from
        the drawer (buildRateErcFeed's ercFlagsAll IS floored under
        recentOnly:true — §D1, passing) but STILL counted by the KPI tile
        sitting directly above it (§D2, passing — confirms the tile moves
        when the drawer does not) — the exact "badge counts rows the list
        does not show" shape app.js's own W-16 comment names two lines
        above the very code this round touched. §D3 is the one assertion
        in this file left failing on purpose: it states what SHOULD be
        true (the tile agrees with what its own drawer can show) and the
        round's diff does not make it true. Root cause: app.js ~L5686,
        `const ercFlags = alerts.filter((a) => a.erc_outlasts_rate &&
        alertMine(a));` — missing the same `rateWithinActionFloor(a, true)`
        the line above it (ratesSoon) already has. One-line fix, same shape
        as every other repair in this file's history — out of this pass's
        file-commit scope (tests + HARNESS.md only).
        §D4 — the OTHER direction, checked and clean: a LIVE (future-
        ending) ERC alert is NOT wrongly dropped by the recentOnly floor —
        rateWithinActionFloor only ever excludes the PAST side, so a rate
        with days_to_rate_end > 0 always clears it regardless of `on`.
   §E — isSystemProvenanceNote, the pure predicate, via page.evaluate
        directly against the bare function (module-level, same technique
        tests/r44.js's suggestStatementMatches / tests/r45.js's `daysSince`
        reimplementation rely on for "read the app's own logic live").
        SB-IMPORT-<digit> prefix (leading whitespace tolerated) → true; the
        same text merely mentioned mid-body → false; no digit after the
        dash → false; null/undefined/empty → false; lowercase "sb-import"
        → false (the regex is case-sensitive by construction — a defensive
        spot-check, not a claim the round promised case-insensitivity).
   §F — loadClientData / coldClients, live, at the module-state level
        (clientDataCached's own `last` map, the same bare-identifier
        technique tests/r43.js's viewsMode reads and tests/r30.js's
        window.__errorLog reference already establish as fair game). A
        client whose ONLY case_note is an SB-IMPORT-1 provenance note dated
        today has NO entry in `last` at all (the note is filtered before
        the bump, not merely down-ranked) and reads as cold; a client with
        a real human note dated today has a `last` entry timestamped today
        and reads as NOT cold.
   §G — THE SAME THING, ON THE REAL CLIENTS PAGE. #client-segment's Cold
        chip: the system-note-only client's row is IN the cold list and
        its `.client-lastcontact` line reads the "no contact of any kind"
        text (not a phantom "contacted today"); the real-note client's row
        is NOT in the cold list at all.

   EVERY figure this file asserts is either read straight back off the mock
   db/RPC, computed by the test's own construction/seeding, or read live off
   app.js's own module state (RATE_ACTION_FLOOR_DAYS, rateWithinActionFloor,
   buildRateErcFeed, readDashboardCases, isSystemProvenanceNote,
   clientDataCached, coldClients) — never a number this file invented
   independently of the fixture/app it is testing against, the same
   standing rule tests/r25.js/r38.js/r40.js/r41.js/r42.js/r45.js already
   follow.

   Run:  node /root/nx/tests/r47.js
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
  await wait(page, ms == null ? 1800 : ms);
};
const noNewErr = (page, before) => (page.__err || []).length === before;

/* Days-ago → an ISO date string, date-only, same technique tests/r45.js/r27.js/r42.js already use
   for date-boundary seeding — daysSince()/days-to-rate-end floor() lands on the intended day
   regardless of what time of day this suite happens to run at. A NEGATIVE n gives a FUTURE date. */
const daysAgoISO = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — same technique tests/r38.js/r43.js/r45.js's
   own insertClient/insertCase helpers use.
   ------------------------------------------------------------------------- */
async function insertClient(page, fields) {
  return page.evaluate(async (f) => {
    const { data, error } = await window.__mockDb.from("clients").insert(f).select("id").single();
    if (error) throw new Error("client insert: " + error.message);
    return data.id;
  }, fields);
}
async function insertCase(page, fields) {
  return page.evaluate(async (f) => {
    const { data, error } = await window.__mockDb.from("cases").insert(f).select("id").single();
    if (error) throw new Error("case insert: " + error.message);
    return data.id;
  }, fields);
}
async function insertNote(page, fields) {
  return page.evaluate(async (f) => {
    const { data, error } = await window.__mockDb.from("case_notes").insert(f).select("id").single();
    if (error) throw new Error("note insert: " + error.message);
    return data.id;
  }, fields);
}
let uniq = 0;
function tag() { uniq += 1; return `R47U${Date.now().toString(36)}${uniq}`; }
async function mkClientCase(page, opts) {
  const o = opts || {};
  const clId = await insertClient(page, {
    first_name: o.first || "R47", last_name: o.last || ("Case" + tag()),
    email: o.email !== undefined ? o.email : `r47.${tag().toLowerCase()}@example.com`, phone: "07700900000",
  });
  const row = Object.assign({ client_id: clId, case_kind: "remortgage", stage: "completed" }, o.case || {});
  const caseId = await insertCase(page, row);
  return { clId, caseId };
}

/* Raw get_briefing read — the ground truth §A tests against, never a rendered My Day list (the
   same "raw RPC read" technique tests/r43.js's briefingItems() uses). */
const briefingItems = (page, scope) => page.evaluate(async (sc) => {
  const { data, error } = await window.__mockDb.rpc("get_briefing", { p_scope: sc });
  if (error) throw new Error("get_briefing: " + error.message);
  return data || [];
}, scope || "all");
const briefRateIds = (items) => items.filter((it) => it.kind === "rate_urgent").map((it) => it.case_id);

/* buildRateErcFeed, called directly against the SAME reads loadDashboard/loadRetentionRates
   themselves make (readDashboardCases() + v_alerts), bypassing the DOM entirely — the §B ground
   truth for the recentOnly split, at the one function both surfaces share. */
async function rateErcFeedDirect(page, opts) {
  return page.evaluate(async (o) => {
    const cases = (await readDashboardCases()).data || [];
    const alerts = (await window.__mockDb.from("v_alerts").select("*").order("rate_end_date")).data || [];
    const feed = await buildRateErcFeed(cases, alerts, o || {});
    return { ratesSoonAll: feed.ratesSoonAll.map((a) => a.case_id), ercFlagsAll: feed.ercFlagsAll.map((a) => a.case_id) };
  }, opts || null);
}

/* Rows on both the drawer and the Retention page carry the case id in onclick="openCase('<id>')" —
   same technique tests/r38.js's rowIds() uses, reused verbatim here. */
async function rowIds(page, containerSel) {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel + " .row-item .t[onclick]")].map((el) => {
      const m = el.getAttribute("onclick").match(/openCase\('([^']+)'\)/);
      return m ? m[1] : null;
    }).filter(Boolean);
  }, containerSel);
}
const kpiNum = (page, which) => page.$eval(`.kpi[onclick="kpiGoto('${which}')"] .num`, (e) => Number(e.textContent.replace(/[^\d.-]/g, "")));

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       §A · MY DAY — mock get_briefing's rate_urgent floor
       ======================================================================= */
    {
      console.log("\n— §A · get_briefing's rate_urgent 18-month floor (p4, scope=all)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      // The floor's own formula, read live rather than assumed — mirrors app.js's
      // RATE_ACTION_FLOOR_DAYS and mock-supabase.js's identical inline expression.
      const FLOOR = -Math.round(18 * 30.44);
      const appFloor = await page.evaluate(() => (typeof RATE_ACTION_FLOOR_DAYS !== "undefined" ? RATE_ACTION_FLOOR_DAYS : null));
      eq("fixture · app.js's own RATE_ACTION_FLOOR_DAYS matches the round's documented ≈-548", appFloor, FLOOR);

      const sOld = await mkClientCase(page, { first: "R47A", last: "Old4y" + tag(), case: { rate_end_date: daysAgoISO(1460), lender: "R47Lender" } });
      const sRecent = await mkClientCase(page, { first: "R47A", last: "Recent3mo" + tag(), case: { rate_end_date: daysAgoISO(90), lender: "R47Lender" } });
      const sFuture = await mkClientCase(page, { first: "R47A", last: "Future30d" + tag(), case: { rate_end_date: daysAgoISO(-30), lender: "R47Lender" } });
      const s17mo = await mkClientCase(page, { first: "R47A", last: "Boundary17mo" + tag(), case: { rate_end_date: daysAgoISO(Math.round(17 * 30.44)), lender: "R47Lender" } });
      const s19mo = await mkClientCase(page, { first: "R47A", last: "Boundary19mo" + tag(), case: { rate_end_date: daysAgoISO(Math.round(19 * 30.44)), lender: "R47Lender" } });
      const sExactFloor = await mkClientCase(page, { first: "R47A", last: "ExactFloor" + tag(), case: { rate_end_date: daysAgoISO(-FLOOR), lender: "R47Lender" } });
      const sOneDayPast = await mkClientCase(page, { first: "R47A", last: "OneDayPastFloor" + tag(), case: { rate_end_date: daysAgoISO(-FLOOR + 1), lender: "R47Lender" } });

      const items = await briefingItems(page, "all");
      const ids = briefRateIds(items);

      ok("§A1 · rate ended ~4 years ago — NOT in rate_urgent items", !ids.includes(sOld.caseId), JSON.stringify(ids));
      ok("§A2 · rate ended 3 months ago — IS present", ids.includes(sRecent.caseId), JSON.stringify(ids));
      ok("§A3 · rate ending in 30 days (future) — present (the floor is a past-side-only bound)", ids.includes(sFuture.caseId), JSON.stringify(ids));
      ok("§A4 · rate ended ~17 months ago — present (inside the ~18mo window)", ids.includes(s17mo.caseId), JSON.stringify(ids));
      ok("§A5 · rate ended ~19 months ago — absent (past the ~18mo window)", !ids.includes(s19mo.caseId), JSON.stringify(ids));
      ok("§A6 · rate ended EXACTLY at the floor (days == RATE_ACTION_FLOOR_DAYS) — still included (boundary is >=)", ids.includes(sExactFloor.caseId), JSON.stringify(ids));
      ok("§A7 · rate ended ONE DAY further back than the floor — the first excluded day", !ids.includes(sOneDayPast.caseId), JSON.stringify(ids));

      ok("§A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §B · buildRateErcFeed's opts.recentOnly — the split, at the shared
            builder, bypassing the DOM entirely.
       ======================================================================= */
    {
      console.log("\n— §B · buildRateErcFeed(opts.recentOnly) — the dashboard-floored / retention-unfloored split, direct (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "dashboard");

      const sOld = await mkClientCase(page, { first: "R47B", last: "OldEnded" + tag(), case: { rate_end_date: daysAgoISO(1460), lender: "R47BLender", loan_amount: 250000 } });
      const sLiveErc = await mkClientCase(page, {
        first: "R47B", last: "LiveErc" + tag(),
        case: { rate_end_date: daysAgoISO(-60), erc_end_date: daysAgoISO(-90), lender: "R47BLender", loan_amount: 200000 },
      });

      const withFloor = await rateErcFeedDirect(page, { recentOnly: true });
      const withoutFloor = await rateErcFeedDirect(page, {}); // Retention's own call passes no recentOnly key at all

      ok("§B1 · recentOnly:true — the old-ended case is excluded from ratesSoonAll", !withFloor.ratesSoonAll.includes(sOld.caseId), JSON.stringify(withFloor.ratesSoonAll));
      ok("§B2 · recentOnly OMITTED (the Retention page's own call shape) — the SAME old-ended case IS in ratesSoonAll", withoutFloor.ratesSoonAll.includes(sOld.caseId), JSON.stringify(withoutFloor.ratesSoonAll));
      ok("§B3 · recentOnly:true does NOT drop a LIVE (future-ending) ERC alert from ercFlagsAll", withFloor.ercFlagsAll.includes(sLiveErc.caseId), JSON.stringify(withFloor.ercFlagsAll));
      ok("§B4 · …and it is present either way — the floor only ever excludes the past side", withoutFloor.ercFlagsAll.includes(sLiveErc.caseId), JSON.stringify(withoutFloor.ercFlagsAll));

      ok("§B · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §C · THE SPLIT, ON THE REAL PAGES — dashboard floors, Retention doesn't.
       ======================================================================= */
    {
      console.log("\n— §C · same old-ended case: excluded from the dashboard KPI + drawer, still shown on Retention (p4, All scope)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "dashboard");

      const kpiRatesBefore = await kpiNum(page, "rates");

      const sOld = await mkClientCase(page, { first: "R47C", last: "OldEndedDashboard" + tag(), case: { rate_end_date: daysAgoISO(1460), lender: "R47CLender", loan_amount: 300000 } });

      await goto(page, "dashboard");
      const kpiRatesAfterOld = await kpiNum(page, "rates");
      eq("§C1 · the KPI \"Rates ending\" tile does NOT increase for the old-ended alert", kpiRatesAfterOld, kpiRatesBefore);

      const drawerRowsAfterOld = await rowIds(page, "#alerts-rateerc");
      ok("§C2 · the old-ended case is NOT in the dashboard drawer's rendered rows (#alerts-rateerc)", !drawerRowsAfterOld.includes(sOld.caseId), JSON.stringify(drawerRowsAfterOld));

      // Sanity: the tile DOES respond to a genuine in-window alert — the floor isn't silently
      // breaking the tile's ability to count anything at all.
      const sFresh = await mkClientCase(page, { first: "R47C", last: "FreshDashboard" + tag(), case: { rate_end_date: daysAgoISO(-20), lender: "R47CLender", loan_amount: 300000 } });
      await goto(page, "dashboard");
      const kpiRatesAfterFresh = await kpiNum(page, "rates");
      eq("§C3 · fixture sanity — a genuine in-window alert DOES increase the tile by exactly one", kpiRatesAfterFresh, kpiRatesAfterOld + 1);

      await goto(page, "retention");
      const retRows = await rowIds(page, "#ret-rates-list");
      ok("§C4 · the SAME old-ended case IS shown on the Retention page (#ret-rates-list) — the recovery book stays un-floored", retRows.includes(sOld.caseId), JSON.stringify(retRows));

      ok("§C · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §D · A REAL DEFECT IN THIS ROUND'S OWN DIFF — the ERC KPI tile was
            never given the same floor as the drawer it links to.
       ======================================================================= */
    {
      console.log("\n— §D · KNOWN DEFECT — renderTodayKpis' \"ERC outlasts rate\" tile has no R47 floor, unlike the drawer it opens (p4, All scope)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "dashboard");

      const kpiErcBefore = await kpiNum(page, "erc");

      // Both dated years ago (erc_end AFTER rate_end, satisfying erc_outlasts_rate), so this alert
      // is squarely inside the R47 floor's exclusion zone.
      const sOldErc = await mkClientCase(page, {
        first: "R47D", last: "OldErc" + tag(),
        case: { rate_end_date: daysAgoISO(1460), erc_end_date: daysAgoISO(1400), lender: "R47DLender", loan_amount: 275000 },
      });

      await goto(page, "dashboard");
      const kpiErcAfter = await kpiNum(page, "erc");
      const drawerRows = await rowIds(page, "#alerts-rateerc");

      ok("§D1 · the drawer itself correctly EXCLUDES the old-ended ERC alert (buildRateErcFeed's own recentOnly floor works)", !drawerRows.includes(sOldErc.caseId), JSON.stringify(drawerRows));
      ok("§D2 · fixture proof the tile MOVED for this case (documents the mismatch is real, not a wording quibble) — the KPI did increase", kpiErcAfter, kpiErcBefore + 1);
      eq(
        "§D3 · KNOWN DEFECT (app.js renderTodayKpis ~L5686, not fixed this pass) — the \"ERC outlasts rate\" KPI tile should stay in sync with the drawer its own kpiGoto('erc') opens (#alerts-rateerc), the same way `ratesSoon` now does; only `ratesSoon` gained rateWithinActionFloor this round, `ercFlags` did not, so the tile counts an alert the drawer (correctly) no longer lists — click the tile, get one fewer row than promised",
        kpiErcAfter, kpiErcBefore
      );
      // §D4 — the OTHER direction, on the real page: a LIVE (future-ending) ERC alert must not be
      // wrongly dropped by the floor either. Builder-level proof is §B3/§B4; this is the same claim
      // spot-checked through the real dashboard render.
      const sLiveErc = await mkClientCase(page, {
        first: "R47D", last: "LiveErcPage" + tag(),
        case: { rate_end_date: daysAgoISO(-45), erc_end_date: daysAgoISO(-75), lender: "R47DLender", loan_amount: 260000 },
      });
      await goto(page, "dashboard");
      const kpiErcAfterLive = await kpiNum(page, "erc");
      const drawerRowsAfterLive = await rowIds(page, "#alerts-rateerc");
      eq("§D4a · a live, future-ending ERC alert DOES increase the KPI tile by one", kpiErcAfterLive, kpiErcAfter + 1);
      ok("§D4b · …and it IS in the drawer too — the recentOnly floor only ever excludes the past side", drawerRowsAfterLive.includes(sLiveErc.caseId), JSON.stringify(drawerRowsAfterLive));

      ok("§D · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §E · isSystemProvenanceNote — the pure predicate.
       ======================================================================= */
    {
      console.log("\n— §E · isSystemProvenanceNote(body) — the pure function, direct (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const cases = [
        ["SB-IMPORT-1 · Back-book import — mortgage policy #99182", true, "prefix, no leading space"],
        ["   SB-IMPORT-2 · leading whitespace tolerated", true, "leading whitespace"],
        ["Client asked about SB-IMPORT-1 during the call", false, "mid-body mention, not a prefix"],
        ["SB-IMPORT- has no digit after the dash", false, "no digit"],
        [null, false, "null"],
        [undefined, false, "undefined"],
        ["", false, "empty string"],
        ["sb-import-1 lowercase", false, "case-sensitive — no i flag on the regex"],
      ];
      for (const [body, expected, why] of cases) {
        const got = await page.evaluate((b) => (typeof isSystemProvenanceNote !== "undefined" ? isSystemProvenanceNote(b) : "MISSING"), body);
        eq(`§E · isSystemProvenanceNote(${JSON.stringify(body)}) → ${expected} (${why})`, got, expected);
      }

      ok("§E · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §F · loadClientData / coldClients — module state, live.
       ======================================================================= */
    {
      console.log("\n— §F · loadClientData's `last` map + coldClients() — an import-provenance-only note never counts as contact (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const sysOnly = await mkClientCase(page, { first: "R47F", last: "SystemNoteOnly" + tag(), case: {} });
      await insertNote(page, { case_id: sysOnly.caseId, body: "SB-IMPORT-1 · Back-book import — mortgage policy #99182, imported 2024-01-01" });

      const realNote = await mkClientCase(page, { first: "R47F", last: "RealNoteToday" + tag(), case: {} });
      await insertNote(page, { case_id: realNote.caseId, body: "Called to check in on the remortgage timeline." });

      const state = await page.evaluate(async ({ sysId, realId }) => {
        const data = await clientDataCached(true);
        const cold = coldClients(data, "all").map((c) => c.id);
        return {
          sysLast: data.last.get(sysId) || null,
          realLast: data.last.get(realId) || null,
          sysCold: cold.includes(sysId),
          realCold: cold.includes(realId),
        };
      }, { sysId: sysOnly.clId, realId: realNote.clId });

      eq("§F1 · a client whose ONLY note is an SB-IMPORT provenance note has NO `last` contact entry at all", state.sysLast, null, JSON.stringify(state));
      ok("§F2 · …and reads as cold (coldClients includes it)", state.sysCold, JSON.stringify(state));
      ok("§F3 · a client with a real human note today HAS a `last` entry", !!state.realLast && state.realLast.what === "note", JSON.stringify(state));
      ok("§F3 · …timestamped today", state.realLast && new Date(state.realLast.at).toDateString() === new Date().toDateString(), JSON.stringify(state));
      ok("§F4 · …and reads as NOT cold", !state.realCold, JSON.stringify(state));

      ok("§F · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §G · THE SAME THING, ON THE REAL CLIENTS PAGE.
       ======================================================================= */
    {
      console.log("\n— §G · the Clients page's Cold segment: system-note-only client shows up, real-note client does not (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const sysOnly = await mkClientCase(page, { first: "R47G", last: "SystemNoteOnlyPage" + tag(), case: {} });
      await insertNote(page, { case_id: sysOnly.caseId, body: "SB-IMPORT-1 · Back-book import — mortgage policy #55219" });

      const realNote = await mkClientCase(page, { first: "R47G", last: "RealNoteTodayPage" + tag(), case: {} });
      await insertNote(page, { case_id: realNote.caseId, body: "Emailed the client the updated illustration." });

      await goto(page, "clients", 1200);
      await page.click('#client-segment [data-seg="cold"]');
      await wait(page, 900);

      const sysRow = await page.$(`.client-row[data-client="${sysOnly.clId}"]`);
      ok("§G1 · the system-note-only client's row IS in the Cold segment", !!sysRow);
      const sysText = sysRow ? await page.$eval(`.client-row[data-client="${sysOnly.clId}"] .client-lastcontact`, (e) => e.textContent.trim()).catch(() => null) : null;
      ok("§G2 · …and its .client-lastcontact line reads \"no contact\" (not a phantom \"contacted today\")", !!sysText && /no contact/i.test(sysText), JSON.stringify(sysText));

      const realRow = await page.$(`.client-row[data-client="${realNote.clId}"]`);
      ok("§G3 · the real-note client's row is NOT in the Cold segment", !realRow);

      ok("§G · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r47: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
