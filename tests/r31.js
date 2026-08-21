#!/usr/bin/env node
/* =============================================================================
   tests/r31.js — acceptance tests for ROUND 31: THREE small, independent
   features shipped together (admin/app.js + admin/index.html only, no schema):

   A · MAIN-NAV ACCESSIBILITY
     - `a.skip-link[href="#main"]` ("Skip to main content") is the FIRST
       element in the document body's tab order — off-screen (CSS
       `left:-9999px`) until :focus, on-screen while focused. Its click
       handler (app.js ~L4076) does `e.preventDefault()` then
       `#main.focus()`.
     - `<main id="main" tabindex="-1">` — focusable via script/fragment even
       though it is never in the natural Tab order itself.
     - `#topnav[aria-label="Main navigation"]`.
     - `nav(page)` (app.js ~4312) sets `aria-current="page"` on the ACTIVE
       `#topnav button[data-page]` and removes it from every other one, on
       every navigation (not just first paint).

   B · SAVED FILTER VIEWS (Clients + Pipeline), localStorage key `nx_views_v1`
     - Shape: `{ clients: [{name, filters}], pipeline: [{name, filters}] }`.
       Pure per-browser convenience — no server row, wrapped so a disabled /
       corrupt localStorage degrades to "no saved views", never throws
       (app.js `savedViews`/`saveView`/`deleteView`, ~L7396).
     - Pipeline bar: `#board-views` / `#board-view-save` / `#board-view-del`.
       Captured filters (`pipelineFilterState`): `#board-search`,
       `#board-adviser`, `pipelineSegment`, `stageTab`, `sortKey`, `sortDir`,
       `pipelineView`.
     - Clients bar: `#client-views` / `#client-view-save` / `#client-view-del`.
       Captured filters (`clientsFilterState`): `#client-search`,
       `clientAdviser`, `clientSegment`, `clientSort`.
     - Save reads `window.prompt()`; delete reads `window.confirm()` — both
       stubbed on the page before the relevant click, per the round's own
       test convention.

   C · DATA-HEALTH READINESS ROLLUP (`#dh-readiness`, app.js ~L21320)
     - Sits above the tile row (`#data-content`), rebuilt on every
       `loadDataHealth()`. Rolls up ONLY the page's genuine data-quality
       fault tiles (missing/invalid email+phone, unassigned live cases,
       completed-with-no-fee/rate-end/completion-date, missing milestone
       date, dead-book/overdue) — deliberately EXCLUDES the informational /
       Consumer-Duty care lists (shared addresses, waiting-on-documents,
       vulnerable, automation-suppressed).
     - 0 issues → a "…looks clean… ✅" empty state, no `.dh-readiness-item`s.
     - >0 issues → `#dh-readiness-headline` (a `<strong>` count + "N checks"),
       and `.dh-readiness-item`s (`.dh-readiness-label` / `.dh-readiness-count`)
       sorted worst-first, each wired via an inline `onclick` that resolves
       `document.getElementById(<realTileId>)` and clicks it — reusing the
       tile's own `wireTile`/`wireTileScroll` handler, which scrolls to (and,
       for `wireTile` tiles, un-hides) that tile's panel.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r31.js
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
const clearViews = (page) => page.evaluate(() => { try { localStorage.removeItem("nx_views_v1"); } catch (e) { /* ignore */ } });
/* R37 · non-masking repair — R37's starter-views seeding (seedStarterViews) triggers on the ABSENCE
   of nx_views_v1, which is exactly the state clearViews() above produces. Every newPage() call is
   already a fresh browser context (isolated storage), so the key was always absent going into B1/B2
   regardless of clearViews() — R37 now fills that absence with 1-3 starter views before this file's
   own assertions ever run, which would corrupt "starts with only the placeholder option" (B1a) and
   the exact-one-view counts (B1c/B2b) etc. A PRESENT but EMPTY store is the R31-era ground truth
   these blocks were written against — present, so seedStarterViews' "raw != null" guard skips
   seeding entirely; empty, so every original assertion (placeholder-only select, arrays of length 1
   after one Save, empty arrays after one Delete) holds byte-for-byte. B3 (corrupt-but-present key)
   already exercises the "no seeding" path a different way and needs no change. */
const presetEmptyViews = (page) => page.evaluate(() => { try { localStorage.setItem("nx_views_v1", JSON.stringify({ clients: [], pipeline: [] })); } catch (e) { /* ignore */ } });
const stubDialogs = (page) => page.evaluate(() => { window.prompt = () => "My view"; window.confirm = () => true; });
/* R43 · non-masking repair — R43 moved the saved-view STORE to the server (`public.saved_views`,
   one row per user_id/scope/name); localStorage.nx_views_v1 is now only the fallback a save/delete
   ever touches while in "local" mode. presetEmptyViews() above still leaves a PRESENT-but-empty key,
   which R43's own migration rule reads as "this device already owns a store" and migrates (writing
   only the `_meta` marker, since there is nothing to migrate) — so a fresh pipeline/clients load
   under it settles into DB mode exactly as it would on a real, un-migrated-nowhere deployment, and
   every Save/Delete this file drives lands in the TABLE, never in localStorage (which is why B1k/B2g
   below still pass — they are reading a value nothing in this run ever writes to, not proof of
   anything). tableView() reads the same table tests/r43.js's own selectSavedViews() reads, via the
   identical `window.__mockDb.from("saved_views")` handle. */
async function tableView(page, scope, name) {
  return page.evaluate(async ({ scope, name }) => {
    const { data, error } = await window.__mockDb.from("saved_views").select("scope,name,filters");
    if (error) throw new Error("saved_views select: " + error.message);
    return (data || []).filter((r) => r.scope === scope && r.name === name);
  }, { scope, name });
}

/* Insert one client (+ optionally one case) straight into the mock's in-memory store — same
   independent-of-fixture technique tests/r25.js/r27.js's insertCase uses, so these assertions
   never depend on the fixture's current composition. */
async function insertClient(page, o) {
  return page.evaluate(async (opts) => {
    const db = window.__mockDb;
    const email = `r31.${Math.random().toString(36).slice(2, 9)}@example.com`;
    const row = Object.assign({ first_name: opts.first, last_name: opts.last, email: opts.email !== undefined ? opts.email : email, phone: "07700900000" }, opts.fields || {});
    const { data: cl, error } = await db.from("clients").insert(row).select("id").single();
    if (error) throw new Error("client insert: " + error.message);
    return cl.id;
  }, o);
}
async function insertCase(page, o) {
  return page.evaluate(async (opts) => {
    const db = window.__mockDb;
    const email = `r31.${Math.random().toString(36).slice(2, 9)}@example.com`;
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: opts.first, last_name: opts.last, email, phone: "07700900000" })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "purchase" }, opts.fields);
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return cs.id;
  }, o);
}

/* Parse the readiness rollup's rows off the DOM, in order: label, shown count, and the real tile
   id the row's inline onclick targets (`document.getElementById('<id>')?.scrollIntoView...`). */
async function readinessItems(page) {
  return page.$$eval("#dh-readiness .dh-readiness-item", (els) =>
    els.map((el) => {
      const label = el.querySelector(".dh-readiness-label");
      const count = el.querySelector(".dh-readiness-count");
      const onclick = el.getAttribute("onclick") || "";
      const m = onclick.match(/getElementById\('([^']+)'\)/);
      return { label: label ? label.textContent.trim() : "", count: count ? Number(count.textContent.trim()) : NaN, tileId: m ? m[1] : null };
    }));
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
       A · MAIN-NAV ACCESSIBILITY (owner, p4)
       ======================================================================= */
    {
      console.log("\n— A · skip link / #main / #topnav / aria-current (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const skipInfo = await page.evaluate(() => {
        const a = document.querySelector("a.skip-link");
        return a ? { href: a.getAttribute("href"), text: a.textContent.trim() } : null;
      });
      ok("A1 · a.skip-link exists", !!skipInfo, JSON.stringify(skipInfo));
      eq("A2 · skip-link href is #main", skipInfo && skipInfo.href, "#main");
      eq("A3 · skip-link text is 'Skip to main content'", skipInfo && skipInfo.text, "Skip to main content");

      // A4 — genuinely FIRST in the tab order: from a fresh page (nothing focused), one real
      // keyboard Tab press lands on it, not on the global-search button or the first nav item.
      await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
      await page.keyboard.press("Tab");
      const firstFocused = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? { isSkip: el === document.querySelector("a.skip-link"), tag: el.tagName, cls: el.className } : null;
      });
      ok("A4 · one Tab press from a fresh page focuses the skip-link (it's first in tab order)", firstFocused && firstFocused.isSkip, JSON.stringify(firstFocused));

      // A5 — off-screen until focused, on-screen while focused (the CSS contract the round's own
      // <style> block documents: left:-9999px normally, left:0 on :focus).
      const offscreenBefore = await page.evaluate(() => {
        const a = document.querySelector("a.skip-link");
        a.blur();
        return getComputedStyle(a).left;
      });
      ok("A5 · skip-link sits off-screen (large negative left) when not focused", /-\d{3,}/.test(offscreenBefore), offscreenBefore);
      await page.evaluate(() => document.querySelector("a.skip-link").focus());
      const onscreenWhileFocused = await page.evaluate(() => getComputedStyle(document.querySelector("a.skip-link")).left);
      ok("A6 · skip-link comes on-screen (left:0) while focused", onscreenWhileFocused === "0px", onscreenWhileFocused);

      // A7/A8 — clicking it focuses #main (the click handler preventDefaults the native fragment
      // jump and calls #main.focus() itself — app.js ~L4076).
      await page.$eval("a.skip-link", (el) => el.click());
      await wait(page, 200);
      const mainFocused = await page.evaluate(() => document.activeElement === document.getElementById("main"));
      ok("A7 · clicking the skip-link focuses #main", mainFocused);

      const mainAttrs = await page.evaluate(() => {
        const m = document.getElementById("main");
        return m ? { tag: m.tagName, tabindex: m.getAttribute("tabindex") } : null;
      });
      eq("A8 · #main is a <main> with tabindex=\"-1\"", mainAttrs, { tag: "MAIN", tabindex: "-1" });

      const topnavLabel = await page.evaluate(() => {
        const n = document.getElementById("topnav");
        return n ? n.getAttribute("aria-label") : null;
      });
      eq("A9 · #topnav has aria-label=\"Main navigation\"", topnavLabel, "Main navigation");

      // A10-A13 — aria-current="page" tracks the ACTIVE tab across navigations, exclusively.
      await goto(page, "pipeline");
      const afterPipeline = await page.evaluate(() =>
        [...document.querySelectorAll("#topnav button[data-page]")].map((b) => ({ page: b.dataset.page, current: b.getAttribute("aria-current") })));
      const pipelineCurrentSet = afterPipeline.filter((b) => b.current === "page").map((b) => b.page);
      eq("A10 · after nav('pipeline'), exactly #topnav[data-page=pipeline] carries aria-current=page", pipelineCurrentSet, ["pipeline"]);

      await goto(page, "clients");
      const afterClients = await page.evaluate(() =>
        [...document.querySelectorAll("#topnav button[data-page]")].map((b) => ({ page: b.dataset.page, current: b.getAttribute("aria-current") })));
      const clientsCurrentSet = afterClients.filter((b) => b.current === "page").map((b) => b.page);
      eq("A11 · after nav('clients'), exactly #topnav[data-page=clients] carries aria-current=page (pipeline's was removed)", clientsCurrentSet, ["clients"]);

      // A12 — also true of a raw click on the nav button (not just window.nav()).
      await page.click("#topnav button[data-page=\"dashboard\"]");
      await wait(page, 800);
      const afterClick = await page.evaluate(() =>
        [...document.querySelectorAll("#topnav button[data-page]")].map((b) => ({ page: b.dataset.page, current: b.getAttribute("aria-current") })));
      const clickCurrentSet = afterClick.filter((b) => b.current === "page").map((b) => b.page);
      eq("A12 · clicking #topnav button[data-page=dashboard] moves aria-current to it, and only it", clickCurrentSet, ["dashboard"]);

      ok("A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B · SAVED FILTER VIEWS — Pipeline (owner, p4): save / restore / delete
       ======================================================================= */
    {
      console.log("\n— B1 · Pipeline saved views: save persists + populates select, restore applies filters, delete removes (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await presetEmptyViews(page);
      await goto(page, "pipeline");
      // Start from a known, empty select.
      const optsBefore = await page.$$eval("#board-views option", (os) => os.map((o) => o.value));
      eq("B1a · #board-views starts with only the placeholder option", optsBefore, [""]);

      const SEARCH_1 = "r31-pipeline-probe-alpha";
      await page.fill("#board-search", SEARCH_1);
      await page.selectOption("#board-adviser", "unassigned");
      await stubDialogs(page);
      await page.click("#board-view-save");
      await wait(page, 400);

      const optsAfterSave = await page.$$eval("#board-views option", (os) => os.map((o) => ({ value: o.value, text: o.textContent })));
      ok("B1b · a new option 'My view' appears in #board-views after Save", optsAfterSave.some((o) => o.value === "My view"), JSON.stringify(optsAfterSave));

      // R43 · non-masking repair — a fresh pipeline load under presetEmptyViews() settles into DB
      // mode (see the comment on tableView() above), so the Save this file just drove landed in
      // the saved_views TABLE, not localStorage; read the same store the save actually used.
      const rowsAfterSave = await tableView(page, "pipeline", "My view");
      ok("B1c · saved_views holds exactly one pipeline row named 'My view'", rowsAfterSave.length === 1, JSON.stringify(rowsAfterSave));
      const savedView = rowsAfterSave[0];
      eq("B1d · saved view's name is 'My view' (the stubbed prompt answer)", savedView && savedView.name, "My view");
      eq("B1e · saved view captured the search box's live value", savedView && savedView.filters && savedView.filters.search, SEARCH_1);
      eq("B1f · saved view captured the adviser filter's live value", savedView && savedView.filters && savedView.filters.adviser, "unassigned");

      // Change the live filters away from the saved values…
      await page.fill("#board-search", "some other text entirely");
      await page.selectOption("#board-adviser", "all");
      await wait(page, 400);
      const changedBefore = await page.$eval("#board-search", (e) => e.value);
      eq("B1g · sanity — the search box really did change before restoring", changedBefore, "some other text entirely");

      // …then select the saved view and confirm the filters are RESTORED.
      await page.selectOption("#board-views", "My view");
      await wait(page, 500);
      const restoredSearch = await page.$eval("#board-search", (e) => e.value);
      const restoredAdviser = await page.$eval("#board-adviser", (e) => e.value);
      eq("B1h · selecting the saved view restores #board-search to the saved value", restoredSearch, SEARCH_1);
      eq("B1i · selecting the saved view restores #board-adviser to the saved value", restoredAdviser, "unassigned");

      // Delete it.
      await page.click("#board-view-del");
      await wait(page, 400);
      const optsAfterDel = await page.$$eval("#board-views option", (os) => os.map((o) => o.value));
      eq("B1j · #board-views no longer offers 'My view' after Delete", optsAfterDel.indexOf("My view"), -1);
      // R43 · non-masking repair — same reasoning as B1c above: Delete in DB mode never touches
      // localStorage (it was only ever the fallback's own writer), so the ORIGINAL claim here
      // ("Delete actually removed the row") is only provable against the table it actually used.
      const rowsAfterDel = await tableView(page, "pipeline", "My view");
      eq("B1k · saved_views no longer holds a pipeline row named 'My view' after Delete", rowsAfterDel.length, 0);

      ok("B1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B2 · SAVED FILTER VIEWS — Clients (owner, p4): save persists, delete removes
       ======================================================================= */
    {
      console.log("\n— B2 · Clients saved views: save persists a clients view; delete removes it (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await presetEmptyViews(page);
      await goto(page, "clients");

      const SEARCH_2 = "r31-clients-probe-beta";
      await page.fill("#client-search", SEARCH_2);
      await stubDialogs(page);
      await page.click("#client-view-save");
      await wait(page, 400);

      const optsAfterSave = await page.$$eval("#client-views option", (os) => os.map((o) => o.value));
      ok("B2a · a new option 'My view' appears in #client-views after Save", optsAfterSave.indexOf("My view") !== -1, JSON.stringify(optsAfterSave));

      // R43 · non-masking repair — same reasoning as B1c: a fresh clients load under
      // presetEmptyViews() settles into DB mode, so this Save landed in the table.
      const rowsAfterSave = await tableView(page, "clients", "My view");
      ok("B2b · saved_views holds exactly one clients row named 'My view'", rowsAfterSave.length === 1, JSON.stringify(rowsAfterSave));
      const savedView = rowsAfterSave[0];
      eq("B2c · saved view's name is 'My view'", savedView && savedView.name, "My view");
      eq("B2d · saved view captured the search box's live value", savedView && savedView.filters && savedView.filters.search, SEARCH_2);

      // Restore proof, lighter than pipeline's: change the box, select the view, confirm restore.
      await page.fill("#client-search", "something else");
      await page.selectOption("#client-views", "My view");
      await wait(page, 500);
      const restored = await page.$eval("#client-search", (e) => e.value);
      eq("B2e · selecting the saved view restores #client-search", restored, SEARCH_2);

      await page.click("#client-view-del");
      await wait(page, 400);
      const optsAfterDel = await page.$$eval("#client-views option", (os) => os.map((o) => o.value));
      eq("B2f · #client-views no longer offers 'My view' after Delete", optsAfterDel.indexOf("My view"), -1);
      // R43 · non-masking repair — same reasoning as B1k.
      const rowsAfterDel = await tableView(page, "clients", "My view");
      eq("B2g · saved_views no longer holds a clients row named 'My view' after Delete", rowsAfterDel.length, 0);

      ok("B2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B3 · CORRUPT / EMPTY localStorage NEVER THROWS
       ======================================================================= */
    {
      console.log("\n— B3 · corrupt localStorage.nx_views_v1 doesn't throw; controls still present (p4)");
      const page = await newPage(browser, "p4");
      await page.evaluate(() => { try { localStorage.setItem("nx_views_v1", "not json"); } catch (e) { /* ignore */ } });
      const errBefore = (page.__err || []).length;
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "pipeline");
      await goto(page, "clients");

      const boardViewsSel = await page.$("#board-views");
      ok("B3a · #board-views still renders with a corrupt store", !!boardViewsSel);
      const clientViewsSel = await page.$("#client-views");
      ok("B3b · #client-views still renders with a corrupt store", !!clientViewsSel);
      const boardOpts = await page.$$eval("#board-views option", (os) => os.map((o) => o.value));
      eq("B3c · #board-views degrades to just the placeholder (no crash, no phantom views)", boardOpts, [""]);

      ok("B3 · no console errors with a corrupt store", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await clearViews(page);
      await page.close();
    }

    /* =======================================================================
       C · DATA-HEALTH READINESS ROLLUP (owner, p4)
       ======================================================================= */
    {
      console.log("\n— C · #dh-readiness rollup: structure, sort order, tile mapping, seeded top item, click expands (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "data");

      const readinessEl = await page.$("#dh-readiness");
      ok("C1 · #dh-readiness exists", !!readinessEl);

      // C2-C6 — structure off whatever the fixture (+ existing state) currently shows.
      const before = await readinessItems(page);
      const headlineTextBefore = await page.evaluate(() => {
        const h = document.getElementById("dh-readiness-headline");
        return h ? h.textContent : null;
      });
      if (before.length > 0) {
        ok("C2 · #dh-readiness-headline exists with a <strong> count while issues remain", !!headlineTextBefore);
        const totalMatch = headlineTextBefore.match(/(\d+)\s+data-quality issue/);
        const checksMatch = headlineTextBefore.match(/across\s+(\d+)\s+checks?/);
        ok("C3 · headline states a numeric total", !!totalMatch, headlineTextBefore);
        ok("C4 · headline states 'N checks'", !!checksMatch, headlineTextBefore);
        const headlineTotal = totalMatch ? Number(totalMatch[1]) : NaN;
        const headlineChecks = checksMatch ? Number(checksMatch[1]) : NaN;
        eq("C5 · headline check count matches the number of rendered items", headlineChecks, before.length);
        const sumShown = before.reduce((s, c) => s + c.count, 0);
        eq("C6 · headline total equals the sum of the shown item counts", headlineTotal, sumShown);
      } else {
        const clean = await page.$eval("#dh-readiness", (e) => e.textContent);
        ok("C2alt · with zero issues, the empty state renders ('looks clean' + a checkmark)", /looks clean/i.test(clean) && /✅/.test(clean), clean);
      }
      // C7 — sorted worst-first, wherever there's more than one row to order.
      ok("C7 · items are sorted by count, descending", before.every((c, i) => i === 0 || before[i - 1].count >= c.count), JSON.stringify(before));
      // C8 — every row's target tileId resolves to a real element on the page.
      const mapCheck = await page.evaluate((items) => items.map((it) => ({ id: it.tileId, exists: !!(it.tileId && document.getElementById(it.tileId)) })), before);
      ok("C8 · every readiness item maps to a real #dh-tile-* element", mapCheck.every((m) => m.exists), JSON.stringify(mapCheck));

      // C9-C11 — seed enough "live cases unassigned" to make it strictly the largest, then confirm
      // it sorts to the top after a reload. Also seed one guaranteed invalid-email client so the
      // click-to-expand assertion below (§C12) never depends on the fixture already having one.
      const currentMax = before.reduce((m, c) => Math.max(m, c.count), 0);
      const N_UNASSIGNED = currentMax + 8; // strictly larger than anything already on the board
      const todayIso = await page.evaluate(() => new Date().toISOString().slice(0, 10));
      for (let i = 0; i < N_UNASSIGNED; i++) {
        await insertCase(page, {
          first: "R31Unassigned", last: `Seed${i}`,
          // submitted_at is set so this seed trips ONLY the "unassigned" predicate — leaving it
          // null would also trip "Missing application/offer date" (dh-tile-milestone) and confound
          // which tile actually sorts to the top.
          fields: { stage: "application", assigned_to: null, submitted_at: todayIso, expected_completion_date: null, rate_end_date: null },
        });
      }
      await insertClient(page, { first: "R31Invalid", last: "EmailSeed", email: "not-an-email-format" });

      await goto(page, "data");
      const after = await readinessItems(page);
      ok("C9 · 'Live cases unassigned' item is present after seeding", after.some((c) => c.tileId === "dh-tile-unassigned"));
      const unassignedItem = after.find((c) => c.tileId === "dh-tile-unassigned");
      ok("C10 · its count grew to at least the number just seeded", unassignedItem && unassignedItem.count >= N_UNASSIGNED, JSON.stringify(unassignedItem));
      eq("C11 · it now sorts to the TOP of the rollup (largest count first)", after[0] && after[0].tileId, "dh-tile-unassigned");
      ok("C11b · still sorted worst-first after seeding", after.every((c, i) => i === 0 || after[i - 1].count >= c.count), JSON.stringify(after));

      // C12 — clicking an item scrolls to AND expands its tile's panel. Use the invalid-email row
      // (a `wireTile` tile — its panel starts hidden and is toggled visible on tile click), not the
      // unassigned row (whose panel is always-rendered / scroll-only, per app.js's wireTileScroll).
      const invalidEmailItem = after.find((c) => c.tileId === "dh-tile-invalid-email");
      ok("C12pre · the seeded invalid-email item is present", !!invalidEmailItem, JSON.stringify(after));
      const panelHiddenBefore = await page.$eval("#dh-invalid-email-panel", (e) => e.classList.contains("hidden"));
      ok("C12a · #dh-invalid-email-panel starts hidden", panelHiddenBefore);
      await page.evaluate(() => {
        window.__sivCalls = 0;
        const orig = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (...args) { window.__sivCalls++; return orig.apply(this, args); };
      });
      const items = await page.$$(".dh-readiness-item");
      let clicked = false;
      for (const it of items) {
        const label = await it.$eval(".dh-readiness-label", (e) => e.textContent);
        if (/invalid email/i.test(label)) { await it.click(); clicked = true; break; }
      }
      ok("C12b · found and clicked the 'Invalid email' readiness row", clicked);
      await wait(page, 400);
      const sivCalls = await page.evaluate(() => window.__sivCalls);
      ok("C12c · clicking the item invoked scrollIntoView (scrolled to the tile/panel)", sivCalls > 0, sivCalls);
      const panelHiddenAfter = await page.$eval("#dh-invalid-email-panel", (e) => e.classList.contains("hidden"));
      ok("C12d · #dh-invalid-email-panel is no longer hidden — clicking the readiness row expanded it", !panelHiddenAfter);

      ok("C · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r31: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
