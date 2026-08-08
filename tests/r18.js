#!/usr/bin/env node
/* =============================================================================
   tests/r18.js — acceptance tests for ROUND 18: scale/speed hardening.

     P1   — one shared Intl.DateTimeFormat for localDateStr (perf only, no
            behaviour to assert).
     P2   — debounce() (app.js ~224): trailing-edge, 250ms, wraps #client-search
            and #board-search's `input` listeners; the client-row checkbox
            handler is now ONE delegated listener on #client-list instead of
            one per row (no behavioural surface to assert beyond the existing
            bulk-bar tests already covering it).
     P3   — the unactioned radar's note/event read widened from 7 to 90 days:
            MEMBERSHIP is still the 7-day UNACTIONED_DAYS test, but the "quiet
            N days" LABEL now reflects the true last-touch date out to 90 days
            before falling back to created_at.
     P4   — render caps: BOARD_COL_CAP (50) per board column with a
            `.board-show-more` button (`window.boardShowMore(stage)`,
            `boardExpandedStages` Set persists across re-renders) and
            CLIENT_LIST_CAP (100) on the client list with a
            `.client-list-cap-note`; the column/segment HEADER counts and the
            bulk-bar "Select all N shown" always describe the FULL filtered
            set, never the capped render.
     P6   — the case modal's client-picker list is now cached for the session
            (`clientPickerCache`); every client-insert path calls
            `invalidateClientPicker()` so a client created via openClient's own
            Save shows up in `#case-client-select` on the next case opened in
            the same session, with no reload.
     D1   — optimistic-concurrency guard on the client save, mirroring the
            existing case-save guard: `openedClientUpdatedAt` is captured on
            open and the save is `.eq("id", id).eq("updated_at",
            openedClientUpdatedAt)`; zero rows back means someone else saved
            first, and a `confirm()` decides discard-and-reload vs re-baseline-
            and-keep-editing (`refreshOpenedClientStamp`).
     P7   — REPORTS_ROW_CAP raised 5000 -> 20000.

   EVERY figure this file asserts is read back from the fixture DB at runtime
   (window.__mockDb) or derived from a BASELINE read before seeding, never
   hardcoded against fixture composition — see the HARNESS.md standing rule.
   Boilerplate (ok/eq/newPage/wait/goto/mkClientCase/openCase) is copied from
   tests/r17.js; mock-supabase.js's whole in-memory DB is rebuilt per page
   load, so this file runs its entire battery on ONE shared page, same as
   r15/r16/r17.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r18.js
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
    if (page.__dialogAnswer === "dismiss") await d.dismiss();
    else await d.accept(typeof page.__dialogAnswer === "string" && page.__dialogAnswer !== "accept" ? page.__dialogAnswer : undefined);
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);

/* Insert a client + case in one round trip. Copied from tests/r17.js's mkClientCase — every case
   this file opens comes from here, never a fixture row. Extended with an optional `days_created`
   (created_at override, days ago) for the radar's 90-day-fallback test. */
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email || (`r18.${Math.random().toString(36).slice(2, 9)}@example.com`);
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Test", last_name: o.last || "R18Case", email, phone: o.phone || null })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = {
      client_id: cl.id, case_kind: o.case_kind || "purchase", stage: o.stage || "application",
      assigned_to: o.assigned_to === undefined ? "p2" : o.assigned_to,
      lender: o.lender === undefined ? "Halifax" : o.lender,
    };
    if (o.created_at) row.created_at = o.created_at;
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id };
  }, opts || {});
}
/* A client-only insert (no case), for the concurrency-guard tests. */
async function mkClient(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email || (`r18.cl.${Math.random().toString(36).slice(2, 9)}@example.com`);
    const { data: cl, error } = await db.from("clients")
      .insert({ first_name: o.first || "Test", last_name: o.last || "R18Client", email, phone: o.phone || null })
      .select("id").single();
    if (error) throw new Error("client insert: " + error.message);
    return cl.id;
  }, opts || {});
}
/* Same trick as tests/r17.js's mkQuietCase: every case insert auto-logs a case_created case_event
   dated "now", so a case is never quiet on its own — wipe case_events/case_notes to reach a genuinely
   quiet baseline, then let the caller add back exactly the note fixture the test needs. */
async function mkQuietCase(page, opts) {
  const r = await mkClientCase(page, opts);
  await page.evaluate(async (caseId) => {
    const db = window.__mockDb;
    await db.from("case_events").delete().eq("case_id", caseId);
    await db.from("case_notes").delete().eq("case_id", caseId);
  }, r.caseId);
  return r;
}

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 900 : ms);
};

const openCase = async (page, caseId) => {
  await page.evaluate((id) => window.openCase(id), caseId);
  await wait(page, 900);
  await page.evaluate(() => { const d = document.querySelector(".case-details"); if (d) d.open = true; });
};
const openClient = async (page, id) => {
  await page.evaluate((cid) => window.openClient(cid), id);
  await wait(page, 700);
  // The client-details <details> starts COLLAPSED on an existing client (same fix r13.js/r16.js/
  // r17.js already carry for .case-details): force it open so the form fields are actionable.
  await page.evaluate(() => { const d = document.querySelector(".client-details"); if (d) d.open = true; });
};

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.__dialogs = [];
  page.__dialogAnswer = "accept";
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    if (page.__dialogAnswer === "dismiss") await d.dismiss();
    else await d.accept(typeof page.__dialogAnswer === "string" && page.__dialogAnswer !== "accept" ? page.__dialogAnswer : undefined);
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=p2`);
  await page.waitForTimeout(SETTLE);
  const noNewErr = (before) => (page.__err || []).length === before;

  try {

    /* =======================================================================
       A · REPORTS_ROW_CAP === 20000 — checked FIRST, before anything on this
           page could call window.__setReportsRowCap and mutate it away.
       ======================================================================= */
    {
      console.log("\n— A · REPORTS_ROW_CAP raised to 20000 (p2)");
      const cap = await page.evaluate(() => REPORTS_ROW_CAP);
      eq("A · REPORTS_ROW_CAP === 20000", cap, 20000);
    }

    /* =======================================================================
       B · BOARD CAP + SHOW-MORE — a column with > BOARD_COL_CAP (50) cases
           renders exactly 50, the header count is the TRUE total, the
           show-more button reads the right hidden count, clicking it reveals
           every card, and boardExpandedStages survives a re-render.
       ======================================================================= */
    {
      console.log("\n— B · Board column cap (50) + show-more + expansion persists across re-render (p2)");
      const errBefore = (page.__err || []).length;
      const STAGE = "application";

      await goto(page, "pipeline", 1200);
      // Baseline: however many 'application'-stage cases the fixture book already has, read straight
      // off the app's OWN rendered header — never assumed from fixture composition.
      const baselineTxt = await page.$eval(`.col[data-stage="${STAGE}"] h4 span`, (e) => e.textContent.trim()).catch(() => "0");
      const baseline = Number(baselineTxt) || 0;

      const SEED_N = 55; // > BOARD_COL_CAP (50), well above fixture volume too
      for (let i = 0; i < SEED_N; i++) {
        await mkClientCase(page, { first: "Board", last: `Cap${i}`, stage: STAGE, assigned_to: null, lender: null });
      }
      await goto(page, "pipeline", 1200);

      const total = baseline + SEED_N;
      const headerTxt = await page.$eval(`.col[data-stage="${STAGE}"] h4 span`, (e) => e.textContent.trim());
      eq("B · the column HEADER count is the TRUE total (baseline + seeded)", Number(headerTxt), total);

      const cardCount1 = await page.$$eval(`.col[data-stage="${STAGE}"] .card`, (els) => els.length);
      eq("B · the column renders exactly BOARD_COL_CAP (50) cards, not the true total", cardCount1, 50);

      const hiddenExpected = total - 50;
      const showMoreTxt = await page.$eval(`.col[data-stage="${STAGE}"] .board-show-more`, (e) => e.textContent.trim());
      eq("B · \".board-show-more\" reads \"Show N more\" for the true hidden count", showMoreTxt, `Show ${hiddenExpected} more`);

      // Click it (real UI interaction, not window.boardShowMore called directly) — every card renders.
      await page.click(`.col[data-stage="${STAGE}"] .board-show-more`);
      await wait(page, 400);
      const cardCount2 = await page.$$eval(`.col[data-stage="${STAGE}"] .card`, (els) => els.length);
      eq("B · after clicking \"Show N more\", ALL cards render (true total)", cardCount2, total);
      const showMoreGone = await page.evaluate((s) => !document.querySelector(`.col[data-stage="${s}"] .board-show-more`), STAGE);
      ok("B · the show-more button is gone once nothing is left to reveal", showMoreGone);

      // boardExpandedStages survives a re-render: re-run loadPipeline() (a search/filter change would
      // trigger the same path) and confirm the column is STILL fully expanded, with no re-click.
      await page.evaluate(() => loadPipeline());
      await wait(page, 400);
      const cardCount3 = await page.$$eval(`.col[data-stage="${STAGE}"] .card`, (els) => els.length);
      eq("B · boardExpandedStages survives a re-render — still all cards, no re-click needed", cardCount3, total);
      const stillNoShowMore = await page.evaluate((s) => !document.querySelector(`.col[data-stage="${s}"] .board-show-more`), STAGE);
      ok("B · …and the show-more button stays gone after the re-render", stillNoShowMore);

      // A DIFFERENT column (never expanded) still caps normally — the Set is per-stage, not global.
      const otherCap = await page.evaluate(() => {
        const col = document.querySelector('.col[data-stage="offer"]');
        if (!col) return null;
        const trueTotal = Number((col.querySelector("h4 span") || {}).textContent || 0);
        const rendered = col.querySelectorAll(".card").length;
        const hasShowMore = !!col.querySelector(".board-show-more");
        return { trueTotal, rendered, hasShowMore };
      });
      if (otherCap && otherCap.trueTotal > 50) {
        eq("B · an UNEXPANDED column with > 50 cases still caps at 50", otherCap.rendered, 50);
        ok("B · …and still shows its own show-more button", otherCap.hasShowMore);
      } else {
        ok("B · (offer column has <= 50 cases in this fixture book — cap not applicable there)", true);
      }

      ok("B · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       C · CLIENT LIST CAP (100) — > CLIENT_LIST_CAP clients render exactly
           100 rows + the cap note; a search narrowing below the cap removes
           the note; segment/bulk counts describe the FULL filtered list.
       ======================================================================= */
    {
      console.log("\n— C · Client list cap (100) + cap note + search narrows it away + full-list counts (p2)");
      const errBefore = (page.__err || []).length;

      await goto(page, "clients", 900);
      const baseline = await page.evaluate(async () => (await window.__mockDb.from("clients").select("id")).data.length);

      const FILL_N = 60;
      for (let i = 0; i < FILL_N; i++) await mkClient(page, { first: "CapFill", last: `Bulk${i}` });
      const NEEDLE_N = 3;
      for (let i = 0; i < NEEDLE_N; i++) await mkClient(page, { first: "CapNeedle", last: `Unique${i}` });

      await goto(page, "clients", 900);
      const total = baseline + FILL_N + NEEDLE_N;

      const rowCount = await page.$$eval("#client-list .client-row", (els) => els.length);
      eq("C · exactly CLIENT_LIST_CAP (100) rows render", rowCount, 100);
      const noteTxt = await page.$eval("#client-list .client-list-cap-note", (e) => e.textContent.trim());
      eq("C · the cap note reads \"Showing 100 of N — refine your search to narrow the list.\"",
        noteTxt, `Showing 100 of ${total} — refine your search to narrow the list.`);

      // Full-list counts: the "All" segment chip and the bulk-select-all line both describe the FULL
      // filtered set (`total`), never the capped 100 actually rendered.
      const allSegTxt = await page.$eval('#client-segment .seg-btn[data-seg="all"] .seg-count', (e) => e.textContent.trim());
      eq("C · the \"All\" segment count is the FULL list, not the capped 100", Number(allSegTxt), total);
      const selectAllTxt = await page.$eval("#client-bulk .client-selall label", (e) => e.textContent.trim());
      eq("C · \"Select all N shown\" also reads the FULL list count", selectAllTxt, `Select all ${total} shown`);

      // A search narrowing the result below the cap removes the note entirely.
      await page.fill("#client-search", "CapNeedle");
      await wait(page, 450); // clears the 250ms debounce
      const narrowedRows = await page.$$eval("#client-list .client-row", (els) => els.length);
      eq("C · searching \"CapNeedle\" narrows the list to exactly the 3 seeded matches", narrowedRows, NEEDLE_N);
      const noteGone = await page.evaluate(() => !document.querySelector("#client-list .client-list-cap-note"));
      ok("C · …and the cap note is gone now the list is under the cap", noteGone);
      await page.fill("#client-search", "");
      await wait(page, 450);

      ok("C · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       D · DEBOUNCE (250ms) — #client-search (and #board-search) do NOT
           re-filter at ~50ms after typing, but DO by ~400ms.
       ======================================================================= */
    {
      console.log("\n— D · debounce(250ms): no update at ~50ms, update by ~400ms (p2)");
      const errBefore = (page.__err || []).length;

      // D1 — client search.
      await goto(page, "clients", 900);
      const before = await page.$eval("#client-list", (e) => e.textContent);
      await page.fill("#client-search", "CapNeedle");
      await wait(page, 50);
      const at50 = await page.$eval("#client-list", (e) => e.textContent);
      eq("D1 · #client-search: list is UNCHANGED ~50ms after typing (debounce still pending)", at50, before);
      await wait(page, 400); // total ~450ms since the fill — well past the 250ms debounce
      const at450 = await page.$eval("#client-list", (e) => e.textContent);
      ok("D1 · #client-search: list HAS updated by ~450ms", at450 !== before && /CapNeedle/.test(at450), at450.slice(0, 200));
      await page.fill("#client-search", "");
      await wait(page, 450);

      // D2 — board search (same debounce() wrapper, ~8786).
      await goto(page, "pipeline", 900);
      const boardBefore = await page.$eval("#board", (e) => e.textContent);
      await page.fill("#board-search", "CapNeedle"); // matches nothing on the board — a clean "did it re-render" signal
      await wait(page, 50);
      const boardAt50 = await page.$eval("#board", (e) => e.textContent);
      eq("D2 · #board-search: board UNCHANGED ~50ms after typing", boardAt50, boardBefore);
      await wait(page, 400);
      const boardAt450 = await page.$eval("#board", (e) => e.textContent);
      ok("D2 · #board-search: board HAS re-rendered (now empty/filtered) by ~450ms", boardAt450 !== boardBefore, boardAt450.slice(0, 200));
      await page.fill("#board-search", "");
      await wait(page, 450);

      ok("D · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       E · CLIENT-SAVE CONCURRENCY GUARD — a stale save (row changed since
           open) hits the confirm() branch, never silently overwrites; Cancel
           re-baselines and lets a second Save succeed; OK discards and
           reloads; the happy path (no concurrent change) saves silently.
       ======================================================================= */
    {
      console.log("\n— E · Client-save optimistic-concurrency guard (openedClientUpdatedAt) (p2)");
      const errBefore = (page.__err || []).length;

      // E1 — happy path: no concurrent change, Save succeeds silently and bumps updated_at.
      const e1 = await mkClient(page, { first: "Guard", last: "HappyPath", phone: "07700900001" });
      const before1 = await page.evaluate((id) => window.__mockDb.from("clients").select("updated_at").eq("id", id).single().then((r) => r.data.updated_at), e1);
      await openClient(page, e1);
      page.__dialogAnswer = "accept";
      const dialogsBefore1 = page.__dialogs.length;
      await page.fill('#client-form [name="phone"]', "07700900002");
      await page.click("#modal-save");
      await wait(page, 500);
      eq("E1 · happy path: no confirm() dialog fired", page.__dialogs.length, dialogsBefore1);
      const after1 = await page.evaluate((id) => window.__mockDb.from("clients").select("phone,updated_at").eq("id", id).single().then((r) => r.data), e1);
      eq("E1 · the edit was saved", after1.phone, "07700900002");
      ok("E1 · updated_at was bumped forward", new Date(after1.updated_at).getTime() > new Date(before1).getTime());

      // E2 — conflict + Cancel (dismiss) = "keep editing": re-baselines openedClientUpdatedAt, does
      // NOT write the operator's edit yet, no silent overwrite; Save again then succeeds.
      const e2 = await mkClient(page, { first: "Guard", last: "ConflictKeepEditing", phone: "07700900010" });
      await openClient(page, e2);
      // Mutate behind the modal — a "someone else saved first" scenario.
      await page.evaluate((id) => window.__mockDb.from("clients").update({ phone: "07700900099" }).eq("id", id), e2);
      page.__dialogAnswer = "dismiss";
      const dialogsBefore2 = page.__dialogs.length;
      await page.fill('#client-form [name="phone"]', "07700900011");
      await page.click("#modal-save");
      await wait(page, 500);
      eq("E2 · a confirm() dialog fired for the conflicting save", page.__dialogs.length - dialogsBefore2, 1);
      ok("E2 · the dialog names the conflict", /changed elsewhere/i.test(page.__dialogs[page.__dialogs.length - 1].message));
      const midE2 = await page.evaluate((id) => window.__mockDb.from("clients").select("phone").eq("id", id).single().then((r) => r.data.phone), e2);
      eq("E2 · Cancel (keep editing): the operator's edit was NOT written yet (no silent overwrite)", midE2, "07700900099");
      // Save again — the stamp was re-baselined on the concurrent value, so this now succeeds.
      const dialogsBefore2b = page.__dialogs.length;
      await page.click("#modal-save");
      await wait(page, 500);
      eq("E2 · Save again after Cancel succeeds with NO further dialog", page.__dialogs.length, dialogsBefore2b);
      const finalE2 = await page.evaluate((id) => window.__mockDb.from("clients").select("phone").eq("id", id).single().then((r) => r.data.phone), e2);
      eq("E2 · …and now writes the operator's edit", finalE2, "07700900011");

      // E3 — conflict + OK (accept) = "reload": discards the operator's on-screen edits and reopens
      // showing the CONCURRENT value, never the operator's un-saved edit.
      const e3 = await mkClient(page, { first: "Guard", last: "ConflictReload", phone: "07700900020" });
      await openClient(page, e3);
      await page.evaluate((id) => window.__mockDb.from("clients").update({ phone: "07700900077" }).eq("id", id), e3);
      page.__dialogAnswer = "accept";
      await page.fill('#client-form [name="phone"]', "07700900021");
      await page.click("#modal-save");
      await wait(page, 900); // accept path re-opens the client — allow the reload
      const reloadedPhone = await page.evaluate(() => { const el = document.querySelector('#client-form [name="phone"]'); return el ? el.value : null; });
      eq("E3 · OK (reload): the modal now shows the CONCURRENT value, discarding the operator's edit", reloadedPhone, "07700900077");
      const dbE3 = await page.evaluate((id) => window.__mockDb.from("clients").select("phone").eq("id", id).single().then((r) => r.data.phone), e3);
      eq("E3 · …and the database was never overwritten with the operator's stale edit", dbE3, "07700900077");
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      ok("E · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       F · UNACTIONED RADAR — 90-day activity read; membership is still the
           7-day rule, but the "quiet N days" LABEL reflects the true
           last-touch date out to 90 days, and falls back to created_at only
           beyond that.
       ======================================================================= */
    {
      console.log("\n— F · Unactioned radar: 90-day activity read for the LABEL, 7-day rule for MEMBERSHIP (p2)");
      const errBefore = (page.__err || []).length;

      // F1 — a note 30 days old: outside the 7-day membership window (still quiet) but inside the
      // 90-day activity read, so the label shows the TRUE last-touch date (30 days), not a fallback.
      const f1 = await mkQuietCase(page, { first: "Radar90", last: "Note30d", assigned_to: "p2" });
      await page.evaluate(({ caseId, when }) => window.__mockDb.from("case_notes").insert({ case_id: caseId, body: "old check-in", created_at: when }), { caseId: f1.caseId, when: isoDaysAgo(30) });
      await goto(page, "dashboard", 1200);
      let listTxt = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("F1 · a case with a 30-day-old note IS quiet (outside the 7-day membership window)", listTxt.includes("Radar90 Note30d"), listTxt.slice(0, 200));
      const f1Row = await page.$$eval("#unactioned-list .row-item", (els, name) => { const r = els.find((e) => e.textContent.includes(name)); return r ? r.textContent : null; }, "Radar90 Note30d");
      ok("F1 · …labelled \"quiet 30 days\" — the TRUE last-touch date, read via the 90-day window", /quiet 30 days/.test(f1Row || ""), f1Row);

      // F2 — a note 3 days old: inside the 7-day membership window, so the case is NOT quiet at all.
      const f2 = await mkQuietCase(page, { first: "Radar90", last: "Note3d", assigned_to: "p2" });
      await page.evaluate(({ caseId, when }) => window.__mockDb.from("case_notes").insert({ case_id: caseId, body: "recent check-in", created_at: when }), { caseId: f2.caseId, when: isoDaysAgo(3) });
      await goto(page, "dashboard", 1200);
      listTxt = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("F2 · a case with a 3-day-old note is EXCLUDED from the radar entirely", !listTxt.includes("Radar90 Note3d"), listTxt.slice(0, 200));

      // F3 — a note 100 days old: outside BOTH the 7-day membership window AND the 90-day activity
      // read, so it is never read at all — the label falls back to created_at, exactly as if the
      // case had no note. Pin created_at to a KNOWN 50-days-ago value so the fallback is checkable.
      const f3 = await mkQuietCase(page, { first: "Radar90", last: "Note100d", assigned_to: "p2", created_at: isoDaysAgo(50) });
      await page.evaluate(({ caseId, when }) => window.__mockDb.from("case_notes").insert({ case_id: caseId, body: "ancient check-in", created_at: when }), { caseId: f3.caseId, when: isoDaysAgo(100) });
      await goto(page, "dashboard", 1200);
      listTxt = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("F3 · a case with ONLY a 100-day-old note (outside the 90-day read) IS quiet", listTxt.includes("Radar90 Note100d"), listTxt.slice(0, 200));
      const f3Row = await page.$$eval("#unactioned-list .row-item", (els, name) => { const r = els.find((e) => e.textContent.includes(name)); return r ? r.textContent : null; }, "Radar90 Note100d");
      ok("F3 · …the label FALLS BACK to created_at (\"quiet 50 days\"), the 100-day note is invisible to the 90-day read", /quiet 50 days/.test(f3Row || ""), f3Row);

      ok("F · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       G · P6 CLIENT-PICKER CACHE — a client created via openClient's own Save
           path shows up in a brand-new case's #case-client-select in the same
           session, no reload (invalidateClientPicker() + the self-heal probe).
       ======================================================================= */
    {
      console.log("\n— G · Client-picker cache: a freshly-saved client appears in a new case's picker (p2)");
      const errBefore = (page.__err || []).length;

      const uniqueLast = "PickerCache" + Math.random().toString(36).slice(2, 8);
      await goto(page, "clients", 900);
      await page.click("#new-client-btn");
      await wait(page, 500);
      await page.fill('#client-form [name="first_name"]', "Fresh");
      await page.fill('#client-form [name="last_name"]', uniqueLast);
      await page.fill('#client-form [name="email"]', `${uniqueLast.toLowerCase()}@example.com`);
      await page.click("#modal-save");
      await wait(page, 600);

      const newClientId = await page.evaluate((last) => window.__mockDb.from("clients").select("id").eq("last_name", last).single().then((r) => r.data.id), uniqueLast);
      ok("G · the new client was actually inserted", !!newClientId, newClientId);

      // Open a brand-new case in the SAME session — no page reload.
      await goto(page, "pipeline", 900);
      await page.click("#new-case-btn");
      await wait(page, 700);
      const hasOption = await page.evaluate((id) => !!document.querySelector(`#case-client-select option[value="${id}"]`), newClientId);
      ok("G · the freshly-created client IS in the new case's #case-client-select", hasOption);
      const optText = await page.$eval(`#case-client-select option[value="${newClientId}"]`, (e) => e.textContent);
      ok("G · …under its own name", optText.includes("Fresh") && optText.includes(uniqueLast), optText);
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      ok("G · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

  } finally {
    await page.close();
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r18: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
