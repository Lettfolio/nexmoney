#!/usr/bin/env node
/* =============================================================================
   tests/r43.js — acceptance tests for ROUND 43: server-side saved views
   (T2) + briefing rate_urgent retention-successor parity in the mock (T1).

   What R43 shipped (admin/app.js ~L8278-8600, admin/mock-supabase.js ~L4429
   + the saved_views table):

   T1 — mock get_briefing's rate_urgent predicate now mirrors the production
   RPC and app.js's own client-side retentionSuccessorSets (R35 §4) reasoning:
     `c.rate_end_date && c.stage !== "not_proceeding"
       && (!c.retention_source_case_id || c.stage === "completed")
       && !liveSuccessorSourceIds[c.id]`
   A SOURCE case goes silent while it has a LIVE (non-terminal) retention
   successor; a SUCCESSOR case is silent about its own (inherited) rate end
   while it is itself live, because the conversation it represents is already
   open. Both effects clear the moment the successor completes; a successor
   that falls to not_proceeding suppresses nothing and never alerts itself.
   ZERO base-fixture rows change under the new predicate — this file proves
   the RULE with its own seeded pairs, never touches the fixture assertions
   any other suite depends on.

   T2 — saved views (Clients + Pipeline) move to `public.saved_views`
   (PK user_id,scope,name — R43's mock gained list-column PK support via
   pkCols()), with localStorage `nx_views_v1` demoted to a FALLBACK, never
   deleted. loadSavedViews() fires once a session from loadPipeline/
   loadClients, before seedStarterViews; viewsMode ("db"|"local"|null) decides
   which store owns reads. Zero rows + a present local key migrates it
   (key left in place); zero rows + no key + a resolved identity seeds the
   three role-appropriate starters PLUS a `{scope:'_meta',name:'seeded'}`
   marker row — the marker is why deleting every named view never re-seeds
   (the table is no longer reporting zero rows). A failed write mirrors into
   the cache + localStorage and fires exactly one "device only" toast a
   session. RLS is per-user on read/update/delete alike, enforced in the
   mock's `_matching()` — proven here by seeding a foreign-owned row directly
   into the shared in-memory table and confirming this persona's own
   select/delete never reaches it.

   §1  T1A — a live successor silences both the source's and its own
       rate_urgent row; completing the successor returns the source's row
       and may raise the successor's own.
   §2  T1B — a not_proceeding successor suppresses nothing; the source stays
       visible throughout and the successor itself never alerts.
   §3  T1C — R35 spot-check: the client-side Rate & ERC drawer
       (retentionSuccessorSets, unrelated to the mock RPC T1 touches) still
       silences a live successor exactly as R35 shipped it.
   §4  T2A — DB-mode starter seed on first paint: three role-appropriate
       starters + the `_meta` marker, every row's user_id the signed-in
       persona, localStorage never written.
   §5  T2B — save → table upsert; saving the same name twice still leaves
       exactly one row (upsert, not append), via the real UI (button + a
       stubbed prompt).
   §6  T2C — delete → the row is gone from the table and the dropdown drops
       the option, via the real UI (button + a stubbed confirm).
   §7  T2D — deleting every named view, then forcing a second same-session
       read, does NOT re-seed the starters — the `_meta` marker is the
       reason why.
   §8  T2E — one-time migration: a pre-existing local store + an empty table
       migrates every view into rows, leaves the localStorage key in place,
       and does not ALSO seed the starters on top.
   §9  T2F — local fallback: `__setSavedViewsSupported(false)` reproduces
       R31/R37 in full, starters included, entirely in localStorage.
   §10 T2G — write-failure mid-session mirrors into the cache and
       localStorage and fires exactly one toast across two failed saves.
   §11 T2H — a name over the 120-char CHECK constraint is refused by the
       table (23514) and degrades exactly like any other write failure.
   §12 T2I — cross-persona isolation: a foreign-owned row seeded straight
       into the shared table is invisible to this persona's own select AND
       untouched by a same-named delete.

   EVERY figure this file asserts is either read straight off the mock db
   (`window.__mockDb`/`window.__mock.db`), computed by the test's own
   construction/seeding, or read live off app.js's own module state
   (viewsMode/viewsCache — top-level `let`/`const` bindings, readable and
   writable by bare identifier from `page.evaluate`, the same fact
   tests/r30.js's `window.__errorLog` reference and tests/r13.js's
   `window.__mockDb.from` monkeypatch already lean on) — never a number this
   file invented independently of the fixture/app it is testing against.

   Run:  node /root/nx/tests/r43.js
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
/* newPage supports a queued dialog-answer list (page.__answers), the same technique
   tests/r9_docs.js uses, so a save/delete flow can drive the real prompt()/confirm() UI
   rather than only calling saveView/deleteView directly. */
async function newPage(browser, persona, initFn) {
  const page = await browser.newPage();
  page.__dialogs = [];
  page.__answers = [];
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    if (page.__answers.length) {
      const a = page.__answers.shift();
      if (a === null) await d.dismiss(); else await d.accept(String(a));
    } else {
      await d.accept();
    }
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  if (initFn) await initFn(page);
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1500 : ms);
};
const noNewErr = (page, before) => (page.__err || []).length === before;
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");

const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser"/* R64 · M9 — the Clients adviser filter persists now */, "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_ret_scope", "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads",
  "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

/* Poll app.js's own module-level `viewsMode` (a top-level `let`, readable by bare identifier
   from page.evaluate — proven live below) until loadSavedViews() has decided db/local, rather
   than trusting a fixed wait to always be long enough. */
async function waitViewsMode(page, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 4000);
  while (Date.now() < deadline) {
    const m = await page.evaluate(() => (typeof viewsMode !== "undefined" ? viewsMode : null));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 100));
  }
  return page.evaluate(() => (typeof viewsMode !== "undefined" ? viewsMode : null));
}

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — same technique tests/r35.js/r38.js/r40.js/
   r41.js/r42.js's own mk-/insert- helpers use.
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
async function mkClientCase(page, opts) {
  const o = opts || {};
  const clId = await insertClient(page, {
    first_name: o.first || "R43", last_name: o.last || ("Case" + Math.random().toString(36).slice(2, 8)),
    email: o.email || `r43.${Math.random().toString(36).slice(2, 9)}@example.com`, phone: "07700900000",
  });
  const row = Object.assign({ client_id: clId, case_kind: "remortgage", stage: "application", assigned_to: "p2" }, o.case || {});
  const caseId = await insertCase(page, row);
  return { clId, caseId };
}
const localDate = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().slice(0, 10);

/* Raw RPC read — the ground truth T1 tests against, never the rendered Today list. */
const briefingItems = (page, scope) => page.evaluate(async (sc) => {
  const { data, error } = await window.__mockDb.rpc("get_briefing", { p_scope: sc });
  if (error) throw new Error("get_briefing: " + error.message);
  return data || [];
}, scope || "all");

/* Raw, unfiltered snapshot of the shared in-memory table — the same live-object handle
   tests/r30.js's rawErrorEvents() uses for error_events, NOT a select()-shaped copy: it is
   what a foreign persona's row looks like sitting in storage, and what a raw push into it
   simulates "another user already has a view" without needing to switch CURRENT_UID (which
   the mock does not expose — confirmed: window.__mock.readTableAs() bypasses saved_views'
   own per-user filter by design, since that filter lives in the query-builder's _matching(),
   not in readFilter(); see the comment on _matching() in mock-supabase.js). */
const rawSavedViews = (page) => page.evaluate(() => window.__mock.db.saved_views);
const selectSavedViews = (page) => page.evaluate(async () => {
  const { data, error } = await window.__mockDb.from("saved_views").select("*");
  if (error) throw new Error("saved_views select: " + error.message);
  return data;
});

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       §1 · T1A — live successor silences source + itself; completing it
            returns the source and may raise the successor's own alert.
       ======================================================================= */
    {
      console.log("\n— §1 · T1A · a live retention successor silences the source AND itself; completing it returns the source (p4, scope=all)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const inWindow = localDate(20 * DAY);
      const cl = await insertClient(page, { first_name: "R43T1a", last_name: "Src" + Date.now(), email: `r43t1a.${Math.random().toString(36).slice(2, 9)}@example.com`, phone: "07700900000" });
      const src = await insertCase(page, { client_id: cl, case_kind: "remortgage", stage: "application", assigned_to: "p2", rate_end_date: inWindow, lender: "R43T1aLender" });

      const before = await briefingItems(page, "all");
      ok("§1a · fixture sanity — the fresh source case has its OWN rate_urgent row before any successor exists",
        before.some((it) => it.kind === "rate_urgent" && it.case_id === src), JSON.stringify(before.filter((it) => it.kind === "rate_urgent").map((it) => it.case_id)));

      const succ = await insertCase(page, { client_id: cl, case_kind: "remortgage", stage: "application", assigned_to: "p2", rate_end_date: inWindow, lender: "R43T1aLender", retention_source_case_id: src });
      const during = await briefingItems(page, "all");
      ok("§1b · the source's rate_urgent row is GONE while the successor is live", !during.some((it) => it.kind === "rate_urgent" && it.case_id === src), JSON.stringify(during.filter((it) => it.kind === "rate_urgent").map((it) => it.case_id)));
      ok("§1c · the LIVE successor's own rate_urgent row never appears either (its rate end is the same conversation)", !during.some((it) => it.kind === "rate_urgent" && it.case_id === succ), JSON.stringify(during.filter((it) => it.kind === "rate_urgent").map((it) => it.case_id)));

      await page.evaluate(async (id) => { await window.__mockDb.from("cases").update({ stage: "completed", completed_at: new Date().toISOString().slice(0, 10) }).eq("id", id); }, succ);
      const after = await briefingItems(page, "all");
      ok("§1d · completing the successor RETURNS the source's rate_urgent row", after.some((it) => it.kind === "rate_urgent" && it.case_id === src), JSON.stringify(after.filter((it) => it.kind === "rate_urgent").map((it) => it.case_id)));
      ok("§1e · …and the now-completed successor may raise its own (it is an ordinary case again)", after.some((it) => it.kind === "rate_urgent" && it.case_id === succ), JSON.stringify(after.filter((it) => it.kind === "rate_urgent").map((it) => it.case_id)));

      ok("§1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §2 · T1B — a not_proceeding successor suppresses nothing.
       ======================================================================= */
    {
      console.log("\n— §2 · T1B · a not_proceeding successor never suppresses the source, and never alerts itself (p4, scope=all)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const inWindow = localDate(15 * DAY);
      const cl = await insertClient(page, { first_name: "R43T1b", last_name: "Src" + Date.now(), email: `r43t1b.${Math.random().toString(36).slice(2, 9)}@example.com`, phone: "07700900000" });
      const src = await insertCase(page, { client_id: cl, case_kind: "remortgage", stage: "application", assigned_to: "p2", rate_end_date: inWindow, lender: "R43T1bLender" });
      const succ = await insertCase(page, { client_id: cl, case_kind: "remortgage", stage: "application", assigned_to: "p2", rate_end_date: inWindow, lender: "R43T1bLender", retention_source_case_id: src });

      await page.evaluate(async (id) => { await window.__mockDb.from("cases").update({ stage: "not_proceeding" }).eq("id", id); }, succ);
      const items = await briefingItems(page, "all");
      ok("§2a · the source's rate_urgent row stays present — a lost successor suppresses nothing", items.some((it) => it.kind === "rate_urgent" && it.case_id === src), JSON.stringify(items.filter((it) => it.kind === "rate_urgent").map((it) => it.case_id)));
      ok("§2b · the not_proceeding successor itself never gets a rate_urgent row of its own", !items.some((it) => it.kind === "rate_urgent" && it.case_id === succ), JSON.stringify(items.filter((it) => it.kind === "rate_urgent").map((it) => it.case_id)));

      ok("§2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §3 · T1C — R35 spot-check: the client-side Rate & ERC drawer feed
            (retentionSuccessorSets), unrelated to the mock RPC T1 touched.
       ======================================================================= */
    {
      console.log("\n— §3 · T1C · R35 spot-check — the client-side Rate & ERC drawer still silences a live successor (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await page.reload();
      await wait(page, SETTLE);

      const pastRate = localDate(-30 * DAY);
      const src = await mkClientCase(page, { first: "R43T1c", last: "Source", case: { case_kind: "remortgage", stage: "application", assigned_to: "p2", rate_end_date: pastRate, lender: "R43T1cLender" } });
      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, SETTLE);

      const rowsFor = (id) => page.evaluate((cid) => [...document.querySelectorAll("#alerts-rateerc .row-item")]
        .filter((r) => (((r.querySelector(".t") || {}).getAttribute && r.querySelector(".t").getAttribute("onclick")) || "").includes(`'${cid}'`)).length, id);

      const srcRowsBefore = await rowsFor(src.caseId);
      ok("§3a · the seeded live source case shows in #alerts-rateerc before any successor", srcRowsBefore >= 1, srcRowsBefore);

      const succ = await mkClientCase(page, { first: "R43T1c", last: "Successor", case: { case_kind: "remortgage", stage: "enquiry", assigned_to: "p2", rate_end_date: pastRate, lender: "R43T1cLender", retention_source_case_id: src.caseId } });
      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, SETTLE);

      const succRows = await rowsFor(succ.caseId);
      eq("§3b · the live successor's own id never appears in the drawer (unchanged since R35)", succRows, 0);
      const srcRowsAfter = await rowsFor(src.caseId);
      eq("§3c · the source's own row is untouched — still exactly one row (unchanged since R35)", srcRowsAfter, 1);

      ok("§3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §4 · T2A — DB-mode starter seed on first paint.
       ======================================================================= */
    {
      console.log("\n— §4 · T2A · DB-mode starter seed on first paint: three role-appropriate starters + _meta marker, localStorage untouched (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      await goto(page, "pipeline");
      const mode = await waitViewsMode(page);
      eq("§4a · viewsMode settles to \"db\" on a fresh, un-migrated persona", mode, "db");

      const rows = await selectSavedViews(page);
      /* PATCHED R65 · H7b — starterViewSet() gained a THIRD pipeline starter, "Waiting on
         solicitor" (Current segment, table view, sortKey waiting_on), so the seeded set is four
         named views plus the marker. Nothing about the seeding CONTRACT this section tests has
         changed — one write, role-appropriate adviser pinning, the _meta marker, no localStorage —
         only the count and the name list, which are the fixture, not the rule. */
      eq("§4b · exactly five rows: the four starters + the _meta marker", rows.length, 5);
      const names = rows.map((r) => r.name).sort();
      eq("§4c · the four starter names + \"seeded\" — role-appropriate for an ADVISER (mine, not everyone's)",
        names, ["My cold clients (6mo+)", "My live cases", "Unassigned leads", "Waiting on solicitor", "seeded"].sort());
      ok("§4d · every row's user_id is this persona (p2)", rows.every((r) => r.user_id === "p2"), JSON.stringify(rows.map((r) => r.user_id)));
      const myLive = rows.find((r) => r.name === "My live cases");
      eq("§4e · the pipeline starter is pinned to the adviser's OWN id, not \"all\"", myLive && myLive.filters && myLive.filters.adviser, "p2");

      const lsRaw = await page.evaluate(() => localStorage.getItem("nx_views_v1"));
      eq("§4f · localStorage's nx_views_v1 is never written by the db-mode seed", lsRaw, null);

      const opts = await page.$$eval("#board-views option", (els) => els.map((e) => e.value));
      ok("§4g · the pipeline dropdown carries the two pipeline starters (plus the blank placeholder)", opts.includes("My live cases") && opts.includes("Unassigned leads") && opts[0] === "", JSON.stringify(opts));

      ok("§4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §4h · T2A · owner/admin gets the \"everyone\" phrasing + adviser \"all\", not their own id (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "pipeline");
      await waitViewsMode(page);
      const rows = await selectSavedViews(page);
      const everyone = rows.find((r) => r.name === "Live cases — everyone");
      ok("§4h · owner's starter is named for everyone, not \"My live cases\"", !!everyone, JSON.stringify(rows.map((r) => r.name)));
      eq("§4i · …and its adviser filter is \"all\", not the owner's own id", everyone && everyone.filters && everyone.filters.adviser, "all");
      ok("§4 · no console errors (p4)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §5 · T2B — save → table upsert; re-save (same name) still one row.
       ======================================================================= */
    {
      console.log("\n— §5 · T2B · save (real UI) upserts one row; saving the SAME name again still leaves exactly one row (p2)");
      const page = await newPage(browser, "p2", async (p) => { p.__answers.push("R43 Save Probe"); });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "pipeline");
      await waitViewsMode(page);

      await page.fill("#board-search", "r43-save-probe");
      await page.click("#board-view-save");
      await wait(page, 600);
      const toast1 = await toastText(page);
      ok("§5a · the save toast confirms", /View saved/.test(toast1), toast1);

      const rowsAfterFirst = (await selectSavedViews(page)).filter((r) => r.name === "R43 Save Probe");
      eq("§5b · exactly one row for the new view after the first save", rowsAfterFirst.length, 1);
      eq("§5c · the row carries the captured filter (board-search)", rowsAfterFirst[0].filters && rowsAfterFirst[0].filters.search, "r43-save-probe");
      const optAfterFirst = await page.$eval("#board-views", (e) => e.value);
      eq("§5d · the dropdown selects the just-saved view", optAfterFirst, "R43 Save Probe");

      // Re-save the SAME name with a changed filter — an upsert against the (user_id,scope,name)
      // PK, not a second row.
      page.__answers.push("R43 Save Probe");
      await page.fill("#board-search", "r43-save-probe-v2");
      await page.click("#board-view-save");
      await wait(page, 600);

      const rowsAfterSecond = (await selectSavedViews(page)).filter((r) => r.name === "R43 Save Probe");
      eq("§5e · STILL exactly one row after saving the same name a second time (upsert, not append)", rowsAfterSecond.length, 1);
      eq("§5f · …and it carries the UPDATED filter, proving it was overwritten not ignored", rowsAfterSecond[0].filters && rowsAfterSecond[0].filters.search, "r43-save-probe-v2");

      ok("§5 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §6 · T2C — delete → row gone, dropdown updates.
       ======================================================================= */
    {
      console.log("\n— §6 · T2C · delete (real UI) removes the row and drops the dropdown option (p2)");
      const page = await newPage(browser, "p2", async (p) => { p.__answers.push("R43 Delete Probe"); });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "pipeline");
      await waitViewsMode(page);

      await page.click("#board-view-save");
      await wait(page, 600);
      const before = (await selectSavedViews(page)).some((r) => r.name === "R43 Delete Probe");
      ok("§6a · fixture sanity — the probe view exists before deleting it", before);
      const optsBefore = await page.$$eval("#board-views option", (els) => els.map((e) => e.value));
      ok("§6b · …and its option is in the dropdown", optsBefore.includes("R43 Delete Probe"), JSON.stringify(optsBefore));

      await page.selectOption("#board-views", "R43 Delete Probe");
      page.__answers.push(true);   // confirm()
      await page.click("#board-view-del");
      await wait(page, 600);
      const toastDel = await toastText(page);
      ok("§6c · the delete toast confirms", /View deleted/.test(toastDel), toastDel);

      const after = (await selectSavedViews(page)).some((r) => r.name === "R43 Delete Probe");
      ok("§6d · the row is gone from the table", !after);
      const optsAfter = await page.$$eval("#board-views option", (els) => els.map((e) => e.value));
      ok("§6e · …and the dropdown no longer offers it", !optsAfter.includes("R43 Delete Probe"), JSON.stringify(optsAfter));

      ok("§6 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §7 · T2D — deleting every named view never re-seeds (the _meta marker).
       ======================================================================= */
    {
      console.log("\n— §7 · T2D · deleting ALL named views, then forcing a second same-session read, does NOT bring the starters back (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "pipeline");
      await waitViewsMode(page);

      const starterNames = (await selectSavedViews(page)).filter((r) => r.scope !== "_meta").map((r) => r.name);
      // PATCHED R65 · H7b — four named starters now (the third pipeline one is "Waiting on solicitor").
      eq("§7a · fixture sanity — four named starters exist to delete", starterNames.length, 4);

      // Delete every named view through the app's own deleteView() — the real per-view path a
      // user has, which can never target the _meta row (it is not offered in either dropdown).
      await page.evaluate(async (names) => {
        for (const nm of names) { window.deleteView("pipeline", nm); window.deleteView("clients", nm); }
        await new Promise((r) => setTimeout(r, 300));
      }, starterNames);

      const afterDelete = await selectSavedViews(page);
      eq("§7b · exactly one row left — the _meta marker, never deletable through the UI path", afterDelete.length, 1);
      eq("§7c · …and it is genuinely the marker", afterDelete[0].scope + "|" + afterDelete[0].name, "_meta|seeded");

      // Force a SECOND, same-session read: reset loadSavedViews' own re-entry guard (a top-level
      // `let` in app.js, readable/writable by bare identifier from page.evaluate — proven live in
      // this file's header comment) and call it again, rather than reloading the page (which would
      // reset the mock's whole in-memory table and prove nothing about THIS session's marker).
      await page.evaluate(async () => {
        viewsLoadStarted = false;
        await window.loadSavedViews();
      });
      await wait(page, 400);

      const afterSecondRead = await selectSavedViews(page);
      eq("§7d · still exactly one row — the marker alone, no starters written back", afterSecondRead.length, 1);
      const cacheEmpty = await page.evaluate(() => (viewsCache.pipeline.length === 0 && viewsCache.clients.length === 0));
      ok("§7e · the in-page cache agrees — both scopes empty, not repopulated with starters", cacheEmpty);
      const opts = await page.$$eval("#board-views option", (els) => els.map((e) => e.value));
      eq("§7f · the dropdown shows only its blank placeholder — no starters reappeared in the DOM", opts, [""]);

      ok("§7 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §8 · T2E — one-time migration.
       ======================================================================= */
    {
      console.log("\n— §8 · T2E · a pre-existing local store migrates into rows on an empty table; the key is left in place; no starter double-seed (p2)");
      const page = await newPage(browser, "p2", async (p) => {
        await p.addInitScript(() => {
          localStorage.setItem("nx_views_v1", JSON.stringify({
            pipeline: [{ name: "R43 Legacy Pipeline View", filters: { search: "legacy-probe" } }],
            clients: [{ name: "R43 Legacy Client View", filters: { search: "legacy-client-probe" } }],
          }));
        });
      });
      const errBefore = (page.__err || []).length;

      await goto(page, "pipeline");
      const mode = await waitViewsMode(page);
      eq("§8a · viewsMode settles to \"db\" (the table answered, migration ran against it)", mode, "db");

      const rows = await selectSavedViews(page);
      const names = rows.map((r) => r.name).sort();
      eq("§8b · the table holds exactly the two migrated views + the _meta marker — no starters mixed in",
        names, ["R43 Legacy Client View", "R43 Legacy Pipeline View", "seeded"].sort());
      const pipeRow = rows.find((r) => r.name === "R43 Legacy Pipeline View");
      eq("§8c · the migrated row's filters are carried over intact", pipeRow && pipeRow.filters && pipeRow.filters.search, "legacy-probe");
      ok("§8d · every migrated row's user_id is this persona", rows.every((r) => r.user_id === "p2"), JSON.stringify(rows.map((r) => r.user_id)));

      const lsRaw = await page.evaluate(() => localStorage.getItem("nx_views_v1"));
      ok("§8e · the localStorage key is LEFT IN PLACE after migrating, never cleared", lsRaw != null && /Legacy Pipeline/.test(lsRaw), lsRaw);

      const opts = await page.$$eval("#board-views option", (els) => els.map((e) => e.value));
      eq("§8f · the dropdown shows the migrated view, not a starter", opts, ["", "R43 Legacy Pipeline View"]);

      ok("§8 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §9 · T2F — local fallback: full R31/R37 behaviour, starters included.
       ======================================================================= */
    {
      console.log("\n— §9 · T2F · __setSavedViewsSupported(false) reproduces R31/R37 in full — starters seeded to localStorage, mode=\"local\" (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      await page.evaluate(() => window.__setSavedViewsSupported(false));
      await goto(page, "pipeline");
      const mode = await waitViewsMode(page);
      eq("§9a · viewsMode settles to \"local\" — the table 42P01s", mode, "local");

      const sel = await page.evaluate(async () => {
        const { data, error } = await window.__mockDb.from("saved_views").select("*");
        return { data, code: error && error.code };
      });
      eq("§9b · every op on saved_views answers 42P01, confirming the feature-gate is live", sel.code, "42P01");

      const lsRaw = await page.evaluate(() => localStorage.getItem("nx_views_v1"));
      const ls = JSON.parse(lsRaw || "null");
      // PATCHED R65 · H7b — three pipeline starters in the local fallback too, for the same reason.
      ok("§9c · localStorage now holds the seeded starters — the R31/R37 store is genuinely in play", !!ls && Array.isArray(ls.pipeline) && ls.pipeline.length === 3 && Array.isArray(ls.clients) && ls.clients.length === 1, lsRaw);
      ok("§9d · the pipeline starters are the two role-appropriate names", ls.pipeline.map((v) => v.name).includes("My live cases") && ls.pipeline.map((v) => v.name).includes("Unassigned leads"), JSON.stringify(ls.pipeline));

      const opts = await page.$$eval("#board-views option", (els) => els.map((e) => e.value));
      ok("§9e · the dropdown paints from the localStorage store, unaffected by the DB being unreachable", opts.includes("My live cases") && opts.includes("Unassigned leads"), JSON.stringify(opts));

      // Save/delete round-trip in local mode — R31's original mechanism, unbroken by R43.
      page.__answers.push("R43 Local Probe");
      await page.click("#board-view-save");
      await wait(page, 500);
      const lsAfterSave = JSON.parse((await page.evaluate(() => localStorage.getItem("nx_views_v1"))) || "null");
      ok("§9f · a save in local mode lands in localStorage, not the (unreachable) table", lsAfterSave.pipeline.some((v) => v.name === "R43 Local Probe"), JSON.stringify(lsAfterSave.pipeline));

      await page.evaluate(() => window.__setSavedViewsSupported(true));   // restore — must not leak into later suites sharing the browser
      ok("§9 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §10 · T2G — write-failure mirror + exactly one toast a session.
       ======================================================================= */
    {
      console.log("\n— §10 · T2G · a write failure mid-session mirrors into the cache + localStorage and fires exactly one \"device only\" toast across two failures (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "pipeline");
      const modeBefore = await waitViewsMode(page);
      eq("§10a · fixture sanity — db mode is established before the write starts failing", modeBefore, "db");

      const r = await page.evaluate(async () => {
        const toasts = [];
        const origToast = window.toast;
        window.toast = function (msg) { toasts.push(msg); return origToast(msg); };
        window.__setSavedViewsSupported(false);
        window.saveView("pipeline", "R43 Fail Probe A", { search: "fail-a" });
        await new Promise((res) => setTimeout(res, 500));
        const cacheHasA = viewsCache.pipeline.some((v) => v.name === "R43 Fail Probe A");
        const lsA = JSON.parse(localStorage.getItem("nx_views_v1") || "null");
        const lsHasA = !!(lsA && lsA.pipeline && lsA.pipeline.some((v) => v.name === "R43 Fail Probe A"));
        window.saveView("pipeline", "R43 Fail Probe B", { search: "fail-b" });
        await new Promise((res) => setTimeout(res, 500));
        const cacheHasB = viewsCache.pipeline.some((v) => v.name === "R43 Fail Probe B");
        window.__setSavedViewsSupported(true);
        window.toast = origToast;
        return { toasts, cacheHasA, lsHasA, cacheHasB };
      });

      ok("§10b · the failed write still updated the in-page cache (visible this session)", r.cacheHasA);
      ok("§10c · …and mirrored into localStorage (survives a reload of THIS browser)", r.lsHasA);
      ok("§10d · a SECOND failed save also lands in the cache", r.cacheHasB);
      eq("§10e · exactly ONE toast fired across both failures, not two", r.toasts.length, 1);
      ok("§10f · …and it says the honest thing — device only, not \"saved\"", /this device only/i.test(r.toasts[0] || ""), JSON.stringify(r.toasts));

      const tableRows = (await selectSavedViews(page)).filter((row) => /R43 Fail Probe/.test(row.name));
      eq("§10g · NEITHER failed write actually landed in the table", tableRows.length, 0);

      ok("§10 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §11 · T2H — name over 120 chars is a 23514, handled like any write
             failure (not a crash, not a silent loss).
       ======================================================================= */
    {
      console.log("\n— §11 · T2H · a name over the 120-char CHECK constraint is refused (23514) and degrades exactly like any other write failure (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "pipeline");
      await waitViewsMode(page);

      const longName = "R43 Overlong " + "x".repeat(120);   // > VIEW_NAME_MAX (120)
      ok("§11a · the probe name is genuinely over 120 characters", longName.length > 120, longName.length);

      const r = await page.evaluate(async (nm) => {
        const toasts = [];
        const origToast = window.toast;
        window.toast = function (msg) { toasts.push(msg); return origToast(msg); };
        window.saveView("pipeline", nm, { search: "overlong-probe" });
        await new Promise((res) => setTimeout(res, 500));
        window.toast = origToast;
        return { cacheHas: viewsCache.pipeline.some((v) => v.name === nm), toasts };
      }, longName);

      ok("§11b · logClientError-free — no throw, no console crash (checked below); the cache still shows it this session", r.cacheHas);
      ok("§11c · the write-failure toast fired for the constraint violation same as any other failed write", /this device only/i.test(r.toasts[0] || ""), JSON.stringify(r.toasts));

      const tableRow = (await selectSavedViews(page)).find((row) => row.name === longName);
      ok("§11d · the over-long name never actually landed in the table (the 23514 held)", !tableRow);

      // Directly against the table, independent of the app's own saveView() — proves the table's
      // own CHECK constraint, not just app.js's handling of it.
      const direct = await page.evaluate(async (nm) => {
        const { error } = await window.__mockDb.from("saved_views").upsert([{ scope: "pipeline", name: nm, filters: {} }]);
        return error && error.code;
      }, longName);
      eq("§11e · a direct upsert of the same over-long name is refused with 23514", direct, "23514");

      ok("§11 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §12 · T2I — cross-persona isolation via mock _matching().
       ======================================================================= */
    {
      console.log("\n— §12 · T2I · a foreign-owned row seeded directly into the shared table is invisible to this persona's select, and untouched by a same-named delete (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "pipeline");
      await waitViewsMode(page);

      await page.evaluate(() => {
        // Seeded straight into the shared in-memory store — bypassing insert/RLS entirely, the same
        // way a row that already belongs to a DIFFERENT signed-in user would simply already be
        // sitting in production's real table. CURRENT_UID itself is not exposed for swapping
        // (confirmed: it lives inside mock-supabase.js's own closure), so this is the faithful way
        // to prove the READ side of isolation without needing to actually change persona mid-page.
        window.__mock.db.saved_views.push({ scope: "pipeline", name: "R43 Foreign View", filters: {}, user_id: "p4", updated_at: new Date().toISOString() });
      });

      const raw = await rawSavedViews(page);
      ok("§12a · fixture sanity — the foreign row genuinely sits in the shared table, owned by p4", raw.some((r) => r.name === "R43 Foreign View" && r.user_id === "p4"), JSON.stringify(raw.map((r) => [r.name, r.user_id])));

      const selected = await selectSavedViews(page);
      ok("§12b · this persona's own select() NEVER returns the foreign row", !selected.some((r) => r.name === "R43 Foreign View"), JSON.stringify(selected.map((r) => r.name)));

      const delResult = await page.evaluate(async () => {
        const { error } = await window.__mockDb.from("saved_views").delete().match({ scope: "pipeline", name: "R43 Foreign View" });
        return error;
      });
      eq("§12c · a delete targeting the exact same scope+name reports no error (matches nothing, not a permission error)", delResult, null);
      const rawAfter = await rawSavedViews(page);
      ok("§12d · …and the foreign row is STILL THERE — the delete reached zero of this persona's own rows, never the other user's", rawAfter.some((r) => r.name === "R43 Foreign View" && r.user_id === "p4"), JSON.stringify(rawAfter.map((r) => [r.name, r.user_id])));

      const opts = await page.$$eval("#board-views option", (els) => els.map((e) => e.value));
      ok("§12e · the foreign view never appears in this persona's own dropdown", !opts.includes("R43 Foreign View"), JSON.stringify(opts));

      ok("§12 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r43: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
