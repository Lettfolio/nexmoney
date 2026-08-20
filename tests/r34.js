#!/usr/bin/env node
/* =============================================================================
   tests/r34.js — acceptance tests for ROUND 34: the adviser scoping pack
   (admin/app.js + admin/index.html only, no schema).

   What R34 shipped (build agent's verified summary):
     1. Watchtower Mine/All scope — `#wt-scope-mine`/`#wt-scope-all` seg-btns in the
        watchtower header; default Mine for an adviser (p2/p3), All for admin/owner
        (p1/p4); persisted `nx_wt_scope`; scoped via `wtLast.assignedBy` (one bounded
        cases read, keyed on the case ids already in hand). Alerts with NO case_id
        (firm-level: workload/retention_gap/fee_aging_60/lead_slow) are admin/owner-
        ONLY in BOTH scopes — an adviser never sees them, flipping to All included.
        Chips/panelCount/autoDrawer all read off the scoped list.
     2. Board/diary default-to-me + persist — `#board-adviser` (`nx_board_adviser`)
        and `#diary-staff` (`nx_diary_staff`): a stored VALID value wins; else an
        adviser defaults to their own id; else "all" (admin/owner). Nothing is
        written by the default itself — only a real choice persists, so clearing
        the key genuinely restores the role default. Also wired into R31's saved-
        view apply on the board.
     3. Drawer persistence — `toggleDrawer` now writes `nx_drawer_<key>` for every
        dashboard drawer (watchtower/unactioned/leads/todayappts/tasks/rateerc/
        retention/revenue); `applyStoredDrawers()` runs at the very top of
        `loadDashboard`, before anything can call `autoDrawer`; a stored choice
        outranks the auto-open/auto-close heuristic permanently, not just for the
        session that made it.
     4. Synthetic adviser data-health rows in Watchtower (advisers only) — two
        rules computed client-side from the adviser's own book: `my_missing_email`
        (warn — a live case whose client has no email) and `my_no_rateend` (info —
        a completed case with no rate_end_date), de-duplicated against whatever
        run_watchtower already returned, capped at 8 with a tail "…and N more" row
        (button → Data health). Rows carry `data-wt-synth="<rule>"` and class
        `wt-row-mine`, are Open-only (no Snooze/Dismiss — there is no watch_alerts
        row behind them), and never appear for the Owner/Administrator.

   §A — WATCHTOWER SCOPE (p2): defaults Mine; every rendered (non-synthetic) row's
        case belongs to p2; no firm-level rows in either scope; All reveals other
        advisers' cases, still no firm-level; reload → All persisted; clear key +
        reload → Mine again. (p4): defaults All, no stored key needed; firm-level
        rows present; zero `.wt-row-mine` synthetic rows.
   §B — SYNTHETIC DH ROWS (p2): a freshly-seeded live case with a blank-email
        client renders `[data-wt-synth="my_missing_email"]` (warn, Open-only, no
        Snooze/Dismiss); a freshly-seeded completed case with no rate_end_date
        renders `[data-wt-synth="my_no_rateend"]` (info, same shape); both count
        toward the "All" chip. Seeding well past 8 qualifying cases caps the
        rendered synthetic rows at exactly 8 plus one tail row with a Data health
        button.
   §C — BOARD/DIARY DEFAULTS (p2): `#board-adviser` and `#diary-staff` both open on
        p2's own id; an explicit "all" persists across a reload; clearing the key
        restores the adviser default. (p4): both open on "all". A saved pipeline
        view that pins the board to "all" re-persists on apply, surviving a reload.
   §D — DRAWER PERSISTENCE (p2): closing the auto-opened Leads drawer survives a
        reload; opening the (default-collapsed) Rate & ERC drawer survives a
        reload; clearing both keys restores first-run (auto) behaviour.
   §E — no NEW console errors anywhere above (checked per-block, same convention
        every suite in this harness uses).

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r34.js
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

/* R34's own localStorage keys, plus the older ones the round's own notes list as
   "clear these too if you touch those areas" — this suite touches nx_views_v1
   (saved-view apply) so it is cleared alongside the R34 keys. */
const DRAWER_KEYS = ["watchtower", "unactioned", "leads", "todayappts", "tasks", "rateerc", "retention", "revenue"].map((k) => "nx_drawer_" + k);
const R34_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_diary_staff", "nx_views_v1"].concat(DRAWER_KEYS);
const clearR34Keys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, R34_KEYS);
const clearKey = (page, key) => page.evaluate((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }, key);
const lsGetPage = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

/* Straight-into-the-mock inserts, the same independent-of-fixture technique
   tests/r31.js/r25.js/r27.js already use, so these assertions never depend on
   the fixture's current composition. */
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
/* One client + one case, wired together, for the synthetic-row seeds below. */
async function seedCase(page, tag, clientFields, caseFields) {
  const clId = await insertClient(page, Object.assign({ first_name: "R34" + tag, last_name: "Synth" + Math.random().toString(36).slice(2, 8), phone: "07700900000" }, clientFields));
  const caseId = await insertCase(page, Object.assign({ client_id: clId, case_kind: "remortgage", assigned_to: "p2" }, caseFields));
  return { clId, caseId };
}

/* The Watchtower's own DOM shape: pull every rendered row's case id (from its
   Open button, the only place a case id is written to the page) and whether it
   is one of R34's client-side synthetic rows. */
const watchtowerState = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll("#watchtower-list .wt-row")].map((r) => {
    const btn = [...r.querySelectorAll("button")].find((b) => b.textContent.trim() === "Open");
    const oc = btn ? btn.getAttribute("onclick") : null;
    const mCase = oc && oc.match(/openCase\('([^']+)'\)/);
    const mClient = oc && oc.match(/openClient\('([^']+)'\)/);
    return {
      synth: r.classList.contains("wt-row-mine"),
      synthRule: r.getAttribute("data-wt-synth"),
      caseId: mCase ? mCase[1] : null,
      clientId: mClient ? mClient[1] : null,
      hasOpenBtn: !!btn,
      hasSnooze: !!r.querySelector('button[onclick^="snoozeAlert"]'),
      hasDismiss: !!r.querySelector('button[onclick^="resolveAlert"]'),
      text: r.textContent,
    };
  });
  const groups = [...document.querySelectorAll("#watchtower-list .wt-group")].map((g) => g.dataset.wtKey);
  return { rows, groups };
});
const FIRM_RULES = ["workload", "retention_gap", "fee_aging_60", "lead_slow"];
const hasFirmLevelGroup = (groups) => groups.some((k) => FIRM_RULES.some((r) => k.startsWith(r + "|")));

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       A · WATCHTOWER SCOPE
       ======================================================================= */
    {
      console.log("\n— A1 · adviser (p2) defaults to Mine; every non-synthetic row's case is p2's own; no firm-level rows");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearR34Keys(page);
      await page.reload();
      await wait(page, SETTLE);

      const scopeState = await page.evaluate(() => ({
        mineActive: document.getElementById("wt-scope-mine").classList.contains("scope-active"),
        allActive: document.getElementById("wt-scope-all").classList.contains("scope-active"),
        minePressed: document.getElementById("wt-scope-mine").getAttribute("aria-pressed"),
      }));
      ok("A1a · #wt-scope-mine carries .scope-active by default for an adviser", scopeState.mineActive, JSON.stringify(scopeState));
      ok("A1b · #wt-scope-all does not", !scopeState.allActive, JSON.stringify(scopeState));
      eq("A1c · #wt-scope-mine reports aria-pressed=\"true\"", scopeState.minePressed, "true");

      const mine1 = await watchtowerState(page);
      const nonSynth = mine1.rows.filter((r) => !r.synth);
      ok("A1d · at least one real (non-synthetic) alert is showing, so this check actually proves something", nonSynth.length > 0, JSON.stringify(mine1.rows.length));
      const caseIds = [...new Set(nonSynth.map((r) => r.caseId).filter(Boolean))];
      const owners = await page.evaluate(async (ids) => {
        const db = window.__mockDb;
        const { data } = await db.from("cases").select("id,assigned_to").in("id", ids);
        return data;
      }, caseIds);
      const notMine = (owners || []).filter((c) => c.assigned_to !== "p2");
      ok("A1e · every rendered row's case is genuinely assigned to p2 (verified via the mock db)", notMine.length === 0, JSON.stringify(notMine));
      ok("A1f · no firm-level (case-less) rule group is showing in Mine scope", !hasFirmLevelGroup(mine1.groups), JSON.stringify(mine1.groups));

      console.log("\n— A2 · clicking All reveals other advisers' cases, still no firm-level rows, and persists immediately");
      await page.click("#wt-scope-all");
      await wait(page, 500);
      const all1 = await watchtowerState(page);
      const allNonSynth = all1.rows.filter((r) => !r.synth);
      const allCaseIds = [...new Set(allNonSynth.map((r) => r.caseId).filter(Boolean))];
      const allOwners = await page.evaluate(async (ids) => {
        const db = window.__mockDb;
        const { data } = await db.from("cases").select("id,assigned_to").in("id", ids);
        return data;
      }, allCaseIds);
      const someoneElse = (allOwners || []).some((c) => c.assigned_to !== "p2");
      ok("A2a · All scope shows at least one case NOT assigned to p2", someoneElse, JSON.stringify(allOwners));
      ok("A2b · …and still shows no firm-level rule group (adviser, both scopes)", !hasFirmLevelGroup(all1.groups), JSON.stringify(all1.groups));
      eq("A2c · the choice is written to localStorage immediately", await lsGetPage(page, "nx_wt_scope"), "all");

      console.log("\n— A3 · a reload keeps All (persisted choice beats the role default)");
      await page.reload();
      await wait(page, SETTLE);
      const afterReload = await page.evaluate(() => document.getElementById("wt-scope-all").classList.contains("scope-active"));
      ok("A3 · #wt-scope-all is still active after a reload", afterReload);

      console.log("\n— A4 · clearing nx_wt_scope + reload restores the Mine default");
      await clearKey(page, "nx_wt_scope");
      await page.reload();
      await wait(page, SETTLE);
      const backToMine = await page.evaluate(() => document.getElementById("wt-scope-mine").classList.contains("scope-active"));
      ok("A4 · #wt-scope-mine is active again once the stored choice is cleared", backToMine);

      ok("A · no console errors (p2)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— A5 · owner (p4): defaults All with no stored key, firm-level rows present, zero synthetic rows");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearR34Keys(page);
      await page.reload();
      await wait(page, SETTLE);

      eq("A5a · no nx_wt_scope is stored yet — the All default is a pure role judgement", await lsGetPage(page, "nx_wt_scope"), null);
      const state = await page.evaluate(() => ({
        allActive: document.getElementById("wt-scope-all").classList.contains("scope-active"),
        mineActive: document.getElementById("wt-scope-mine").classList.contains("scope-active"),
      }));
      ok("A5b · #wt-scope-all carries .scope-active by default for the owner", state.allActive, JSON.stringify(state));
      ok("A5c · #wt-scope-mine does not", !state.mineActive, JSON.stringify(state));

      const p4State = await watchtowerState(page);
      ok("A5d · at least one firm-level rule group is showing for the owner", hasFirmLevelGroup(p4State.groups), JSON.stringify(p4State.groups));
      const synthRows = p4State.rows.filter((r) => r.synth);
      eq("A5e · zero .wt-row-mine synthetic rows for the owner", synthRows.length, 0);

      ok("A · no console errors (p4)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B · SYNTHETIC DATA-HEALTH ROWS (p2)
       ======================================================================= */
    {
      console.log("\n— B1 · a seeded blank-email live case and a seeded no-rate-end completed case each render their own synthetic row");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearR34Keys(page);
      await page.reload();
      await wait(page, SETTLE);

      const noEmail = await seedCase(page, "NoEmail", { email: "" }, { stage: "enquiry", rate_end_date: null });
      const noRateEnd = await seedCase(page, "NoRateEnd", { email: "r34.norateend@example.com" }, { stage: "completed", rate_end_date: null });

      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, SETTLE);

      const state = await watchtowerState(page);
      const emailRow = state.rows.find((r) => r.synthRule === "my_missing_email" && r.text.includes("R34NoEmail"));
      const rateRow = state.rows.find((r) => r.synthRule === "my_no_rateend" && r.text.includes("R34NoRateEnd"));
      ok("B1a · [data-wt-synth=\"my_missing_email\"] renders for the seeded blank-email live case", !!emailRow, JSON.stringify(state.rows.map((r) => r.synthRule)));
      ok("B1b · it carries the WARNING badge", emailRow && /WARNING/.test(emailRow.text), emailRow && emailRow.text);
      ok("B1c · it has an Open action…", emailRow && emailRow.hasOpenBtn, JSON.stringify(emailRow));
      ok("B1d · …and no Snooze or Dismiss (no watch_alerts row stands behind it)", emailRow && !emailRow.hasSnooze && !emailRow.hasDismiss, JSON.stringify(emailRow));

      ok("B1e · [data-wt-synth=\"my_no_rateend\"] renders for the seeded completed/no-rate-end case", !!rateRow, JSON.stringify(state.rows.map((r) => r.synthRule)));
      ok("B1f · it carries the FYI badge", rateRow && /FYI/.test(rateRow.text), rateRow && rateRow.text);
      ok("B1g · it has an Open action…", rateRow && rateRow.hasOpenBtn, JSON.stringify(rateRow));
      ok("B1h · …and no Snooze or Dismiss either", rateRow && !rateRow.hasSnooze && !rateRow.hasDismiss, JSON.stringify(rateRow));

      const chipAll = await page.evaluate(() => (document.getElementById("wt-sev-all") || {}).textContent || "");
      const chipCount = Number((chipAll.match(/(\d+)\s*$/) || [])[1]);
      eq("B1i · the \"All\" chip count matches the rendered row count (synthetic rows are counted)", chipCount, state.rows.length);

      ok("B · no console errors (p2)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— B2 · seeding well past the 8-row cap leaves exactly 8 synthetic rows plus one tail row");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearR34Keys(page);
      await page.reload();
      await wait(page, SETTLE);

      for (let i = 0; i < 15; i++) {
        await seedCase(page, "Cap" + i, { email: "" }, { stage: "enquiry", rate_end_date: null });
      }
      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, SETTLE);

      const state = await watchtowerState(page);
      const synthRows = state.rows.filter((r) => r.synth);
      const capped = synthRows.filter((r) => r.synthRule === "my_missing_email" || r.synthRule === "my_no_rateend");
      const tail = synthRows.filter((r) => r.synthRule === "my_data_health");
      eq("B2a · exactly 8 capped synthetic rows render", capped.length, 8);
      eq("B2b · exactly one tail row renders", tail.length, 1);
      const tailHtml = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-wt-synth="my_data_health"]')][0];
        const btn = el && [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === "Data health");
        return { text: el ? el.textContent : "", hasBtn: !!btn };
      });
      ok("B2c · the tail row's text says how many more there are", /more/i.test(tailHtml.text), tailHtml.text);
      ok("B2d · …with a \"Data health\" button", tailHtml.hasBtn, JSON.stringify(tailHtml));

      ok("B · no console errors (p2, cap)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C · BOARD/DIARY DEFAULTS
       ======================================================================= */
    {
      console.log("\n— C1 · #board-adviser / #diary-staff both default to p2's own id, persist \"all\", and restore on clear (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearR34Keys(page);
      await page.reload();
      await wait(page, SETTLE);

      await goto(page, "pipeline");
      eq("C1a · #board-adviser defaults to p2's own id on a fresh load", await page.evaluate(() => document.getElementById("board-adviser").value), "p2");
      await goto(page, "diary");
      eq("C1b · #diary-staff defaults to p2's own id on a fresh load", await page.evaluate(() => document.getElementById("diary-staff").value), "p2");

      await goto(page, "pipeline");
      await page.selectOption("#board-adviser", "all");
      await wait(page, 300);
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "pipeline");
      eq("C1c · setting #board-adviser to \"all\" persists across a reload", await page.evaluate(() => document.getElementById("board-adviser").value), "all");

      await goto(page, "diary");
      await page.selectOption("#diary-staff", "all");
      await wait(page, 300);
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "diary");
      eq("C1d · setting #diary-staff to \"all\" persists across a reload", await page.evaluate(() => document.getElementById("diary-staff").value), "all");

      await clearKey(page, "nx_board_adviser");
      await clearKey(page, "nx_diary_staff");
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "pipeline");
      eq("C1e · clearing nx_board_adviser + reload restores p2's own id", await page.evaluate(() => document.getElementById("board-adviser").value), "p2");
      await goto(page, "diary");
      eq("C1f · clearing nx_diary_staff + reload restores p2's own id", await page.evaluate(() => document.getElementById("diary-staff").value), "p2");

      ok("C · no console errors (p2)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— C2 · #board-adviser / #diary-staff both default to \"all\" (p4, owner)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearR34Keys(page);
      await page.reload();
      await wait(page, SETTLE);

      await goto(page, "pipeline");
      eq("C2a · #board-adviser defaults to \"all\" for the owner", await page.evaluate(() => document.getElementById("board-adviser").value), "all");
      await goto(page, "diary");
      eq("C2b · #diary-staff defaults to \"all\" for the owner", await page.evaluate(() => document.getElementById("diary-staff").value), "all");

      ok("C · no console errors (p4)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— C3 · a saved pipeline view that pins the board to \"all\" re-persists on apply, surviving a reload (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearR34Keys(page);
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "pipeline");

      await page.selectOption("#board-adviser", "all");
      await wait(page, 300);
      const viewName = "r34-view-" + Date.now();
      await page.evaluate((nm) => { window.prompt = () => nm; }, viewName);
      await page.click("#board-view-save");
      await wait(page, 400);

      // Move the live filter away from "all" so applying the view is the only thing that can put it back.
      await page.selectOption("#board-adviser", "p3");
      await wait(page, 300);
      eq("C3a · #board-adviser now reads p3, and that is what's stored", await page.evaluate(() => document.getElementById("board-adviser").value), "p3");
      eq("C3a2 · …persisted too", await lsGetPage(page, "nx_board_adviser"), "p3");

      await page.selectOption("#board-views", viewName);
      await wait(page, 500);
      eq("C3b · applying the saved view restores #board-adviser to \"all\"", await page.evaluate(() => document.getElementById("board-adviser").value), "all");
      eq("C3c · …and re-persists \"all\" to localStorage", await lsGetPage(page, "nx_board_adviser"), "all");

      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "pipeline");
      eq("C3d · #board-adviser is still \"all\" after a reload", await page.evaluate(() => document.getElementById("board-adviser").value), "all");

      ok("C · no console errors (p2, saved view)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       D · DRAWER PERSISTENCE (p2)
       ======================================================================= */
    {
      /* R41 · F1 — #leads-panel (and loadLeads' auto-open-because-leads-are-waiting behaviour) is
         gone; a lead's own auto-open condition had no equivalent on a SURVIVING drawer (a case-
         insert made mid-test does not survive page.reload() — the mock DB is reseeded from its
         deterministic PRNG on every navigation, which is exactly why the original D1 leant on
         fixture-guaranteed "leads waiting", not a test-inserted row). The persistence MECHANISM
         under test (toggleDrawer writes nx_drawer_<key>; applyStoredDrawers reads it before any
         autoDrawer call can run; clearing the key restores the markup default) is unchanged and is
         proven here against the two collapsed-by-default drawers R41 left standing side by side:
         #rate-erc-panel and #revenue-panel — neither carries an autoDrawer() call (see admin/app.js),
         so both start collapsed on a clean load regardless of fixture data, same as Rate & ERC always
         did in the original D1b. */
      console.log("\n— D1 · opening #rate-erc-panel survives a reload; opening #revenue-panel survives one too");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearR34Keys(page);
      await page.reload();
      await wait(page, SETTLE);

      const initial = await page.evaluate(() => ({
        rateErcCollapsed: document.getElementById("rate-erc-panel").classList.contains("collapsed"),
        revenueCollapsed: document.getElementById("revenue-panel").classList.contains("collapsed"),
      }));
      ok("D1a · the Rate & ERC drawer starts collapsed (its markup default — no auto-open rule)", initial.rateErcCollapsed, JSON.stringify(initial));
      ok("D1b · the Protection & fees drawer starts collapsed too (its markup default — no auto-open rule)", initial.revenueCollapsed, JSON.stringify(initial));

      await page.click("#rate-erc-panel h3");
      await wait(page, 300);
      const openedRate = await page.evaluate(() => document.getElementById("rate-erc-panel").classList.contains("collapsed"));
      ok("D1c · clicking the Rate & ERC header opens it", !openedRate);
      eq("D1d · the choice is written to localStorage as \"open\"", await lsGetPage(page, "nx_drawer_rateerc"), "open");

      await page.click("#revenue-panel h3");
      await wait(page, 300);
      const openedRevenue = await page.evaluate(() => document.getElementById("revenue-panel").classList.contains("collapsed"));
      ok("D1e · clicking the Protection & fees header opens it", !openedRevenue);
      eq("D1f · the choice is written to localStorage as \"open\"", await lsGetPage(page, "nx_drawer_revenue"), "open");

      await page.reload();
      await wait(page, SETTLE);
      const afterReload = await page.evaluate(() => ({
        rateErcCollapsed: document.getElementById("rate-erc-panel").classList.contains("collapsed"),
        revenueCollapsed: document.getElementById("revenue-panel").classList.contains("collapsed"),
      }));
      ok("D1g · the Rate & ERC drawer is STILL open after a reload (stored choice beats the collapsed default)", !afterReload.rateErcCollapsed, JSON.stringify(afterReload));
      ok("D1h · the Protection & fees drawer is STILL open after a reload too", !afterReload.revenueCollapsed, JSON.stringify(afterReload));

      console.log("\n— D2 · clearing both keys restores first-run (collapsed) behaviour");
      await clearKey(page, "nx_drawer_rateerc");
      await clearKey(page, "nx_drawer_revenue");
      await page.reload();
      await wait(page, SETTLE);
      const afterClear = await page.evaluate(() => ({
        rateErcCollapsed: document.getElementById("rate-erc-panel").classList.contains("collapsed"),
        revenueCollapsed: document.getElementById("revenue-panel").classList.contains("collapsed"),
      }));
      ok("D2a · Rate & ERC is back to its collapsed markup default once nothing is stored", afterClear.rateErcCollapsed, JSON.stringify(afterClear));
      ok("D2b · Protection & fees is back to its collapsed markup default too", afterClear.revenueCollapsed, JSON.stringify(afterClear));

      ok("D · no console errors (p2)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r34: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
