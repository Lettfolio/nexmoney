#!/usr/bin/env node
/* =============================================================================
   tests/r41.js — acceptance tests for ROUND 41: the Today declutter.

   What R41 shipped (see admin/app.js, admin/index.html):
    - FOUR dashboard drawers REMOVED outright: New website leads (#leads-panel/
      #leads-count/#leads-order/#leads-list, loadLeads, data-lead-row), Today's
      appointments (#today-appts-panel/#today-appts, loadTodayAppts, the old
      .appt-quick-btn data-appt/data-outcome/is-set toggle), Tasks due
      (#tasks-panel/#tasks-list/#tasks-scope-mine/unassigned/all, loadTasks,
      setTasksScope, tasksScope, window.doneTask) and the dashboard's own
      Retention pipeline drawer (#retention-panel/#retention-stats/
      #retention-list/#retention-open-page, loadRetention — the Retention
      PAGE from R38, #ret-*, is untouched).
    - DASH_DRAWER_PANEL_ID is now `{ rateerc: "rate-erc-panel" }` and
      DASH_DRAWER_KEYS is now `["watchtower","unactioned","rateerc","revenue"]`.
    - Every action those drawers carried moved onto the My Day row: a lead's
      adviser select + Accept + ✕ Discard (leadRoutingHtml/acceptLead/
      discardLead — the SAME functions, same markup, just one copy now, inside
      `.brief-lead-actions`); a task's snooze cluster + ✓ Done
      (taskSnoozeControlsHtml/briefDone); an appointment's quick-outcome pair,
      NEW this round on the row itself (apptQuickOutcomeHtml → window.
      quickApptOutcome → writeApptOutcome, 10s Undo, apptOutcomeChipHtml once
      recorded). publishAdviserTaskLoad() survives loadTasks' deletion as a
      count-only read feeding adviserLoadMap()/leastLoadedAdviser() — still
      awaited from loadDashboard.
    - The tour lost its #tasks-panel and #today-appts-panel steps outright
      (not re-pointed); the My Day step's body absorbed the one useful
      sentence each carried. TOUR_STEPS is now 4 long.
    - gotoLeadInbox and the command palette's openLeadOnToday both target the
      My Day row now (gotoLeadInbox walks to
      `select.lead-adviser[data-lead]` → `.closest(".row-item")` and flashes
      it; the palette has no lead id to walk to a specific row with, so it
      scrolls #briefing-panel into view instead — see its own comment in
      app.js).
    - Clients page: `.client-controls` now wraps `.client-views` +
      `.client-advfilter` + `.client-sort` in one flex row (LAYOUT ONLY — every
      id/listener inside is byte-identical); the sort control moved from below
      `#client-seg-def` to inside this row. ~397px of chrome above the first
      client row shrank to ~297px @1280.
    - Retention page cold panel (`#ret-cold-list`, UNCHANGED page, `loadRetentionCold`):
      a secondary sort. When two clients BOTH have an empty last-contact (the
      biggest tie group, previously left in raw `.order("last_name")` order),
      the tie now breaks on the SOONEST future rate_end_date across their
      cases (via `clientNextRateEnd`), a client with none sorting after every
      client who has one, then by name.

   §A  Dashboard — the four removed panels' ids are all absent; the survivors
       (#briefing-panel/#watchtower-panel/#unactioned-panel/#rate-erc-panel/
       #revenue-panel) are present, in the locked order, including the
       kpi-row → dash-cap-notice → briefing-panel lock inside that; DASH_
       DRAWER_PANEL_ID/DASH_DRAWER_KEYS read live and diffed against the
       shrunk shape.
   §B  My Day lead row — adviser select + Accept + ✕ Discard all on ONE row;
       a full discard drive-through including the reason dialog.
   §C  Task row — snooze + ✓ Done, repainting My Day (and only My Day: the
       removed functions are actually gone).
   §D  Appointment quick-outcome — past+unset → both buttons; Attended →
       persisted + badge on repaint + Undo restores; future → neither button;
       an injected appointment title renders escaped.
   §E  gotoLeadInbox lands on the My Day row (.lead-flash); the command
       palette's lead jump lands on My Day.
   §F  Tour — no dead step targets, and the (now 4-step) tour completes.
   §G  Clients page — .client-controls holds the three groups with every id
       still live, the sort select still works from its new position, and the
       measured chrome height at 1280 stays well under the old ~397px.
   §H  Retention cold — the never-contacted tie breaks on soonest future
       rate_end_date, none-last, then name.
   §I  Lightest-load lead suggestion still works via publishAdviserTaskLoad
       feeding adviserLoadMap/leastLoadedAdviser.

   EVERY figure this file asserts is either read straight back off the mock
   db, computed by the test's own construction/seeding, or read live off
   app.js's own module state (DASH_DRAWER_PANEL_ID, DASH_DRAWER_KEYS,
   TOUR_STEPS, RET_LIST_CAP) — never a number this file invented independently
   of the fixture/app it is testing against, the same standing rule
   tests/r38.js/r40.js already follow.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r41.js
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
async function newPage(browser, persona, opts) {
  const page = await browser.newPage();
  if (opts && opts.skipTour) await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
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
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1200 : ms);
};

/* Same defensive localStorage clear every suite in this harness does before depending on a
   default — copied verbatim from tests/r38.js/r40.js's own NX_KEYS. */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser"/* R64 · M9 — the Clients adviser filter persists now */, "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_ret_scope", "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads",
  "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — same technique tests/r38.js/r40.js use.
   ------------------------------------------------------------------------- */
let uniq = 0;
function tag() { uniq += 1; return `R41U${Date.now().toString(36)}${uniq}`; }
async function insertRow(page, table, fields) {
  return page.evaluate(async ([t, f]) => {
    const { data, error } = await window.__mockDb.from(t).insert(f).select().single();
    if (error) throw new Error(`${t} insert: ` + error.message);
    return data;
  }, [table, fields]);
}
async function mkClient(page, opts) {
  const o = opts || {};
  const row = await insertRow(page, "clients", Object.assign({
    first_name: o.first || "R41", last_name: o.last || ("Client" + tag()),
    email: `r41.${tag().toLowerCase()}@example.com`, phone: "07700900000",
  }, o.fields || {}));
  return row.id;
}
async function mkCase(page, clientId, fields) {
  const row = await insertRow(page, "cases", Object.assign({
    client_id: clientId, case_kind: "remortgage", stage: "application", assigned_to: "p2",
  }, fields || {}));
  return row.id;
}
async function mkClientCase(page, opts) {
  const o = opts || {};
  const clientId = await mkClient(page, o);
  const caseId = await mkCase(page, clientId, o.case || {});
  return { clientId, caseId };
}
async function mkLead(page, fields) {
  const row = await insertRow(page, "leads", Object.assign({
    name: "R41 Lead " + tag(), email: `r41.lead.${tag().toLowerCase()}@example.com`, phone: null,
    enquiry_type: "remortgage", message: "Test enquiry", status: "new",
  }, fields || {}));
  return row.id;
}
async function mkTask(page, caseId, fields) {
  const row = await insertRow(page, "case_tasks", Object.assign({
    case_id: caseId, title: "R41 task " + tag(), assigned_to: "p2",
  }, fields || {}));
  return row.id;
}
async function mkAppt(page, fields) {
  const row = await insertRow(page, "appointments", Object.assign({ title: "R41 appt " + tag() }, fields || {}));
  return row.id;
}
const readRow = (page, table, id) => page.evaluate(async ({ table, id }) => {
  const { data } = await window.__mockDb.from(table).select("*").eq("id", id).single();
  return data;
}, { table, id });

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       §A · DASHBOARD — the four removed panels are gone; the survivors are
            present, in the locked order; DASH_DRAWER_* shrunk.
       ======================================================================= */
    {
      console.log("\n— §A1 · the four removed panels' every id is absent from the dashboard (p4, All)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "dashboard", 1500);

      const removedIds = [
        "leads-panel", "leads-count", "leads-order", "leads-list",
        "today-appts-panel", "today-appts",
        "tasks-panel", "tasks-list", "tasks-scope-mine", "tasks-scope-unassigned", "tasks-scope-all",
        "retention-panel", "retention-stats", "retention-list", "retention-open-page",
      ];
      const gone = await page.evaluate((ids) => ids.map((id) => [id, !document.getElementById(id)]), removedIds);
      const stillPresent = gone.filter(([, absent]) => !absent).map(([id]) => id);
      eq("§A1 · every removed id is absent", stillPresent, []);

      const removedAttr = await page.evaluate(() => document.querySelectorAll("[data-lead-row]").length);
      eq("§A1 · no element carries the removed data-lead-row attribute", removedAttr, 0);

      const removedFns = await page.evaluate(() => ["loadLeads", "loadTodayAppts", "loadTasks", "loadRetention", "setTasksScope", "doneTask"]
        .map((n) => [n, typeof window[n]]));
      ok("§A1 · every removed function is gone from window (loadLeads/loadTodayAppts/loadTasks/loadRetention/setTasksScope/doneTask)",
        removedFns.every(([, t]) => t === "undefined"), JSON.stringify(removedFns));

      ok("§A1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §A2 · the surviving panels render, in the locked order (p4, All)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "dashboard", 1500);

      const survivors = ["briefing-panel", "watchtower-panel", "unactioned-panel", "rate-erc-panel", "revenue-panel"];
      const present = await page.evaluate((ids) => ids.map((id) => [id, !!document.getElementById(id)]), survivors);
      ok("§A2a · every surviving panel is present", present.every(([, p]) => p), JSON.stringify(present));

      // §A2b — R11-1's lock: #today-heading -> #kpi-row -> #dash-cap-notice -> #briefing-panel,
      // then the surviving drawers, then the grid-2 pair, all as direct children of #page-dashboard.
      const order = await page.evaluate(() => {
        const kids = [...document.querySelectorAll("#page-dashboard > *")];
        return kids.map((el) => {
          if (el.id) return el.id;
          if (el.classList.contains("grid-2")) return "grid-2:" + [...el.children].map((c) => c.id).join(",");
          return el.tagName.toLowerCase();
        });
      });
      /* R68 · M16 — ONE new child, and it is deliberately where it is. #ops-strip (the admin/owner
         chip row: queued mail, failed sends, leads nobody picked up, cases nobody owns) sits with
         the health banners ABOVE the page title, precisely so that R11-1's adjacency — heading →
         numbers → briefing — is untouched: the three ids this lock exists to protect are still
         consecutive below. It is hidden outright for an adviser. The lock is widened by exactly
         that one entry rather than loosened. */
      eq("§A2b · #page-dashboard's own child order is the locked one",
        order, ["dash-notices", "ops-strip", "today-heading", "kpi-row", "dash-cap-notice", "briefing-panel", "watchtower-panel", "unactioned-panel", "grid-2:rate-erc-panel,revenue-panel"]);

      ok("§A2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §A3 · DASH_DRAWER_PANEL_ID / DASH_DRAWER_KEYS read live, shrunk to the R41 shape (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const errBefore = (page.__err || []).length;
      const shape = await page.evaluate(() => ({ id: DASH_DRAWER_PANEL_ID, keys: DASH_DRAWER_KEYS }));
      eq("§A3a · DASH_DRAWER_PANEL_ID is { rateerc: \"rate-erc-panel\" } only", shape.id, { rateerc: "rate-erc-panel" });
      eq("§A3b · DASH_DRAWER_KEYS is [\"watchtower\",\"unactioned\",\"rateerc\",\"revenue\"]", shape.keys, ["watchtower", "unactioned", "rateerc", "revenue"]);
      ok("§A3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §B · MY DAY LEAD ROW — select + Accept + ✕ Discard, one row; a full
            discard drive-through including the reason dialog.
       ======================================================================= */
    {
      console.log("\n— §B1 · a My Day lead row carries the adviser select + Accept + ✕ Discard together (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const leadId = await mkLead(page, { name: "Beatrice Northgate " + tag() });
      await goto(page, "dashboard", 1500);

      const row = await page.evaluate((id) => {
        const sel = document.querySelector(`#briefing-list select.lead-adviser[data-lead="${id}"]`);
        const r = sel && sel.closest(".row-item");
        if (!r) return null;
        return {
          hasSelect: !!sel,
          hasAccept: !!r.querySelector(`.brief-lead-actions [onclick^="acceptLead('${id}'"]`),
          hasDiscard: !!r.querySelector(`.brief-lead-actions [onclick^="discardLead('${id}'"]`),
          discardText: (r.querySelector(`.brief-lead-actions [onclick^="discardLead('${id}'"]`) || {}).textContent,
          discardAriaLabel: (r.querySelector(`.brief-lead-actions [onclick^="discardLead('${id}'"]`) || {}).getAttribute && r.querySelector(`.brief-lead-actions [onclick^="discardLead('${id}'"]`).getAttribute("aria-label"),
        };
      }, leadId);
      ok("§B1a · the row has the adviser select", row && row.hasSelect, JSON.stringify(row));
      ok("§B1b · …and Accept", row && row.hasAccept, JSON.stringify(row));
      ok("§B1c · …and ✕ Discard, both inside the same .brief-lead-actions wrapper", row && row.hasDiscard, JSON.stringify(row));
      eq("§B1d · the discard button reads ✕", row && row.discardText, "✕");
      eq("§B1e · …labelled for accessibility", row && row.discardAriaLabel, "Discard lead");

      ok("§B1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §B2 · discarding a lead end to end: the reason dialog, the write, the row leaving My Day (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const leadName = "Discardme Testcase " + tag();
      const leadId = await mkLead(page, { name: leadName });
      await goto(page, "dashboard", 1500);

      const preClick = await page.evaluate((id) => !!document.querySelector(`#briefing-list select.lead-adviser[data-lead="${id}"]`), leadId);
      ok("§B2a · the lead's row is on My Day before discarding", preClick);

      await page.click(`#briefing-list [onclick^="discardLead('${leadId}'"]`);
      await wait(page, 500);
      const dialogUp = await page.evaluate(() => ({
        heading: (document.querySelector("#overlay-modal h3") || {}).textContent || "",
        hasReasonSelect: !!document.getElementById("lead-discard-reason"),
        hasNote: !!document.getElementById("lead-discard-note"),
        hasOk: !!document.getElementById("lead-discard-ok"),
      }));
      ok("§B2b · the reason dialog opens, asking why", /Why are you discarding/.test(dialogUp.heading), JSON.stringify(dialogUp));
      ok("§B2c · …with a reason select, an optional note, and a Discard button", dialogUp.hasReasonSelect && dialogUp.hasNote && dialogUp.hasOk, JSON.stringify(dialogUp));

      // Confirm the choose-a-reason guard before actually choosing one.
      await page.click("#lead-discard-ok");
      await wait(page, 300);
      const guardErr = await page.$eval("#lead-discard-err", (e) => e.textContent).catch(() => "");
      ok("§B2d · leaving the reason blank is refused", /Choose a reason/.test(guardErr), guardErr);

      await page.selectOption("#lead-discard-reason", "no_reply");
      await page.fill("#lead-discard-note", "Left a voicemail, no callback yet.");
      await page.click("#lead-discard-ok");
      await wait(page, 1200);

      const after = await readRow(page, "leads", leadId);
      eq("§B2e · the lead is marked discarded", after.status, "discarded");
      eq("§B2f · discard_reason is stored as \"code — note\", in the same write", after.discard_reason, "no_reply — Left a voicemail, no callback yet.");
      ok("§B2g · first_contact_at IS stamped (\"no_reply\" counts as contact)", !!after.first_contact_at, JSON.stringify(after));

      const rowGone = await page.evaluate((id) => !document.querySelector(`#briefing-list select.lead-adviser[data-lead="${id}"]`), leadId);
      ok("§B2h · the row is gone from My Day without navigating away", rowGone);

      ok("§B2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §C · TASK ROW — snooze + ✓ Done, repainting My Day (and only My Day).
       ======================================================================= */
    {
      console.log("\n— §C · task row: snooze cluster + ✓ Done, single repaint into My Day (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const todayStr = await page.evaluate(() => localDateStr());
      const gt = await mkClientCase(page, { first: "Snooze", last: "R41Row" + tag() });
      const taskId = await mkTask(page, gt.caseId, { title: "Chase valuation", due_date: todayStr, assigned_to: "p2" });
      await goto(page, "dashboard", 1500);

      const controlsPresent = await page.evaluate((id) => ({
        snooze1d: !!document.getElementById(`snooze-1d-brief-${id}`),
        snooze3d: !!document.getElementById(`snooze-3d-brief-${id}`),
        snooze1wk: !!document.getElementById(`snooze-1wk-brief-${id}`),
        pick: !!document.getElementById(`snooze-pick-brief-${id}`),
        done: !!document.querySelector(`[onclick="briefDone('${id}')"]`),
      }), taskId);
      ok("§C1 · the row carries the full snooze cluster + ✓ Done", Object.values(controlsPresent).every(Boolean), JSON.stringify(controlsPresent));

      await page.click(`#snooze-3d-brief-${taskId}`);
      await wait(page, 600);
      const afterSnooze = await readRow(page, "case_tasks", taskId);
      const addDays = (ymd, n) => { const d = new Date(ymd + "T00:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
      eq("§C2 · +3d moved the due date", afterSnooze.due_date, addDays(todayStr, 3));
      const rowGoneAfterSnooze = await page.evaluate((id) => !document.getElementById(`snooze-3d-brief-${id}`), taskId);
      ok("§C3 · the row leaves My Day once its due date is past today — repainted", rowGoneAfterSnooze);

      // ✓ Done, on a fresh task due today.
      const taskId2 = await mkTask(page, gt.caseId, { title: "Confirm ID docs", due_date: todayStr, assigned_to: "p2" });
      await goto(page, "dashboard", 1200);
      const beforeDone = await page.$eval("#briefing-list", (e) => e.textContent);
      ok("§C4 · fixture · the fresh task is on My Day", beforeDone.includes("Confirm ID docs"), beforeDone.slice(0, 200));
      await page.click(`[onclick="briefDone('${taskId2}')"]`);
      await wait(page, 700);
      const afterDone = await readRow(page, "case_tasks", taskId2);
      ok("§C5 · Done stamped done_at", !!afterDone.done_at, JSON.stringify(afterDone));
      const briefAfterDone = await page.$eval("#briefing-list", (e) => e.textContent);
      ok("§C6 · the row is gone from My Day (the only list left to repaint)", !briefAfterDone.includes("Confirm ID docs"), briefAfterDone.slice(0, 200));
      await page.click("#toast-action");
      await wait(page, 700);
      const briefAfterUndo = await page.$eval("#briefing-list", (e) => e.textContent);
      ok("§C7 · Undo restores it to My Day", briefAfterUndo.includes("Confirm ID docs"), briefAfterUndo.slice(0, 200));

      ok("§C · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §D · APPOINTMENT QUICK-OUTCOME.
       ======================================================================= */
    {
      console.log("\n— §D1/D2 · past+unset -> both buttons; Attended persists + badges on repaint + Undo restores (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const gt = await mkClientCase(page, { first: "Outcome", last: "R41Row" + tag() });
      const pastStart = new Date(Date.now() - 5 * 60000).toISOString(); // started 5 minutes ago
      const apptId = await mkAppt(page, { case_id: gt.caseId, client_id: gt.clientId, title: "Fact find call", starts_at: pastStart, ends_at: pastStart, staff_id: "p2" });
      await goto(page, "dashboard", 1500);

      const both = await page.evaluate((id) => ({
        attended: !!document.querySelector(`#briefing-list .appt-quick-btn[onclick^="quickApptOutcome('${id}','attended'"]`),
        noShow: !!document.querySelector(`#briefing-list .appt-quick-btn[onclick^="quickApptOutcome('${id}','no_show'"]`),
        rearranged: !!document.querySelector(`#briefing-list .appt-quick-btn[onclick^="quickApptOutcome('${id}','rearranged'"]`),
      }), apptId);
      ok("§D1a · a past, unset appointment offers Attended", both.attended, JSON.stringify(both));
      ok("§D1b · …and No-show", both.noShow, JSON.stringify(both));
      ok("§D1c · …but never Rearranged (that stays editor-only)", !both.rearranged, JSON.stringify(both));

      page.__dialogAnswer = "dismiss"; // no-show would ask about a call-back task; this click is Attended so it never fires, but stay defensive
      await page.click(`#briefing-list .appt-quick-btn[onclick^="quickApptOutcome('${apptId}','attended'"]`);
      await wait(page, 800);
      const afterClick = await readRow(page, "appointments", apptId);
      eq("§D2a · the outcome persisted", afterClick.outcome, "attended");
      const badge = await page.evaluate((id) => {
        const row = document.querySelector(`#briefing-list [onclick^="openAppt('${id}'"]`);
        const r = row && row.closest(".row-item");
        const chip = r && r.querySelector(".appt-outcome.appt-outcome-attended");
        const buttons = r ? r.querySelectorAll(".appt-quick-btn").length : -1;
        return { chipText: chip ? chip.textContent : null, buttons };
      }, apptId);
      ok("§D2b · on repaint the row shows the ✓ Attended badge, not the button pair", badge.chipText && /Attended/.test(badge.chipText), JSON.stringify(badge));
      eq("§D2c · …and the quick-outcome buttons are gone from that row", badge.buttons, 0);

      const undoToast = await toastText(page);
      ok("§D2d · the toast offers Undo", /Recorded: attended/.test(undoToast), undoToast);
      await page.click("#toast-action");
      await wait(page, 800);
      const afterUndo = await readRow(page, "appointments", apptId);
      eq("§D2e · Undo clears the outcome back to unrecorded", afterUndo.outcome, null);
      const backToButtons = await page.evaluate((id) => !!document.querySelector(`#briefing-list .appt-quick-btn[onclick^="quickApptOutcome('${id}','attended'"]`), apptId);
      ok("§D2f · …and the button pair is back on the row", backToButtons);

      ok("§D1/D2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §D3 · a future appointment offers NEITHER button (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const gt = await mkClientCase(page, { first: "Outcome", last: "R41Future" + tag() });
      // Later today, but not yet started — still an appt_today row (get_briefing matches on the
      // calendar date), just with nothing to record yet.
      const futureToday = await page.evaluate(() => {
        const d = new Date();
        d.setHours(23, 59, 0, 0);
        if (d.getTime() <= Date.now()) d.setTime(Date.now() + 5 * 60000);
        return d.toISOString();
      });
      const apptId = await mkAppt(page, { case_id: gt.caseId, client_id: gt.clientId, title: "Later today call", starts_at: futureToday, ends_at: futureToday, staff_id: "p2" });
      await goto(page, "dashboard", 1500);

      const rowState = await page.evaluate((id) => {
        const row = document.querySelector(`#briefing-list [onclick^="openAppt('${id}'"]`);
        const r = row && row.closest(".row-item");
        return {
          rowPresent: !!r,
          buttons: r ? r.querySelectorAll(".appt-quick-btn").length : -1,
          badge: r ? !!r.querySelector(".appt-outcome") : null,
        };
      }, apptId);
      ok("§D3a · the future appointment's row exists on My Day", rowState.rowPresent, JSON.stringify(rowState));
      eq("§D3b · …with no quick-outcome buttons", rowState.buttons, 0);
      eq("§D3c · …and no outcome badge either (nothing recorded, nothing to record yet)", rowState.badge, false);

      ok("§D3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §D4 · an appointment title carrying markup renders escaped on My Day (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const gt = await mkClientCase(page, { first: "Outcome", last: "R41Xss" + tag() });
      const pastStart = new Date(Date.now() - 5 * 60000).toISOString();
      const nasty = `<img src=x onerror=alert(1)> Review`;
      const apptId = await mkAppt(page, { case_id: gt.caseId, client_id: gt.clientId, title: nasty, starts_at: pastStart, ends_at: pastStart, staff_id: "p2" });
      await goto(page, "dashboard", 1500);

      const escaped = await page.evaluate((id) => {
        const row = document.querySelector(`#briefing-list [onclick^="openAppt('${id}'"]`);
        return {
          hasImg: !!(row && row.querySelector("img")),
          hasImgAnywhereOnPanel: document.querySelectorAll("#briefing-panel img").length,
          text: row ? row.textContent : null,
        };
      }, apptId);
      ok("§D4a · no live <img> element was created from the title", !escaped.hasImg, JSON.stringify(escaped));
      eq("§D4b · …no <img> anywhere in the panel at all", escaped.hasImgAnywhereOnPanel, 0);
      ok("§D4c · the row's text still carries the (harmless, escaped) title text", escaped.text && /Review/.test(escaped.text), escaped.text);

      ok("§D4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §E · gotoLeadInbox / the command palette land on the My Day row.
       ======================================================================= */
    {
      console.log("\n— §E1 · gotoLeadInbox scrolls to and flashes the lead's My Day row (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const leadId = await mkLead(page, { name: "Gotolead Fixture " + tag() });
      // Start on a DIFFERENT page — gotoLeadInbox must itself navigate to the dashboard.
      await goto(page, "clients", 1000);
      await page.evaluate((id) => window.gotoLeadInbox(id), leadId);
      await wait(page, 900);
      const state = await page.evaluate((id) => {
        const onDashboard = !document.getElementById("page-dashboard").classList.contains("hidden");
        const sel = document.querySelector(`#briefing-list select.lead-adviser[data-lead="${id}"]`);
        const row = sel && sel.closest(".row-item");
        return { onDashboard, flashed: !!(row && row.classList.contains("lead-flash")) };
      }, leadId);
      ok("§E1a · gotoLeadInbox navigates to the dashboard", state.onDashboard, JSON.stringify(state));
      ok("§E1b · …and flashes the lead's My Day row (.lead-flash)", state.flashed, JSON.stringify(state));
      ok("§E1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §E2 · the command palette's lead result lands on My Day (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const leadName = "Palettelead Uniquename " + tag();
      await mkLead(page, { name: leadName });
      await goto(page, "clients", 1000); // start elsewhere, same as §E1
      await page.click("#global-search-btn");
      await wait(page, 300);
      await page.fill("#palette-input", "Palettelead Uniquename");
      await wait(page, 600);
      const found = await page.evaluate((name) => [...document.querySelectorAll(".palette-row")].some((r) => (r.querySelector(".pr-title") || {}).textContent === name), leadName);
      ok("§E2a · the lead shows up in the palette's Leads group", found);
      // Click the SPECIFIC row (there is exactly one — the lead name is unique to this test run).
      await page.evaluate((name) => {
        const row = [...document.querySelectorAll(".palette-row")].find((r) => (r.querySelector(".pr-title") || {}).textContent === name);
        if (row) row.click();
      }, leadName);
      await wait(page, 900);
      const onDashboard = await page.evaluate(() => !document.getElementById("page-dashboard").classList.contains("hidden"));
      ok("§E2b · selecting the lead result navigates to the dashboard (My Day)", onDashboard);
      ok("§E2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §F · TOUR — no dead targets, and it completes.
       ======================================================================= */
    {
      console.log("\n— §F · the tour's step list has no dead targets, and it runs to completion (p3, first sign-in)");
      const page = await newPage(browser, "p3");
      await wait(page, 900);
      const bubbleUp = await page.evaluate(() => !!document.querySelector("#tour-bubble"));
      ok("§F1 · the tour fires on first sign-in for p3", bubbleUp);

      const liveCount = await page.evaluate(() => TOUR_STEPS.filter((s) => { try { return !!document.querySelector(s.target); } catch (e) { return false; } }).length);
      const totalCount = await page.evaluate(() => TOUR_STEPS.length);
      eq("§F2 · TOUR_STEPS is 4 long (the #tasks-panel/#today-appts-panel steps were deleted, not re-pointed)", totalCount, 4);
      eq("§F3 · every step in the list has a live target — none silently skipped", liveCount, totalCount);

      let seen = 0;
      for (let i = 0; i < totalCount; i++) {
        const stepN = await page.$eval(".tour-step-n", (e) => e.textContent).catch(() => "");
        if (new RegExp(`${i + 1} of ${totalCount}`).test(stepN)) seen++;
        const btnTxt = await page.$eval("#tour-next", (e) => e.textContent).catch(() => "");
        eq(`§F4 · step ${i + 1}'s button reads ${i < totalCount - 1 ? "Next" : "Finish"}`, btnTxt, i < totalCount - 1 ? "Next" : "Finish");
        await page.click("#tour-next");
        await wait(page, 300);
      }
      eq("§F5 · every step was actually shown, in order", seen, totalCount);
      const gone = await page.evaluate(() => !document.querySelector("#tour-bubble"));
      ok("§F6 · Finish closes the tour", gone);
      const seenAt = await page.evaluate(async () => (await window.__mockDb.from("profiles").select("tour_seen_at").eq("id", "p3").single()).data);
      ok("§F7 · Finish marks it seen (mark_tour_seen)", seenAt && seenAt.tour_seen_at != null, JSON.stringify(seenAt));

      ok("§F · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §G · CLIENTS PAGE CHROME.
       ======================================================================= */
    {
      console.log("\n— §G · .client-controls holds the three groups, every id still live, sort still works, chrome shrank (p4, @1280)");
      const page = await newPage(browser, "p4", { skipTour: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      const errBefore = (page.__err || []).length;
      await goto(page, "clients", 1500);

      const groups = await page.evaluate(() => {
        const wrap = document.querySelector(".client-controls");
        if (!wrap) return null;
        return {
          hasViews: !!wrap.querySelector(".client-views"),
          hasAdvFilter: !!wrap.querySelector(".client-advfilter"),
          hasSort: !!wrap.querySelector(".client-sort"),
          groupCount: wrap.children.length,
          ids: [...wrap.querySelectorAll("[id]")].map((e) => e.id),
        };
      });
      ok("§G1a · .client-controls exists and wraps all three groups", groups && groups.hasViews && groups.hasAdvFilter && groups.hasSort, JSON.stringify(groups));
      eq("§G1b · …exactly three direct child groups", groups && groups.groupCount, 3);
      const expectedIds = ["client-views", "client-view-save", "client-view-del", "client-adviser", "client-adv-note", "cl-sort", "cl-sort-note"];
      const missing = expectedIds.filter((id) => !groups.ids.includes(id));
      eq("§G1c · every one of the control row's known ids is still present and live", missing, []);

      // §G1d — the sort div sits INSIDE the controls row, ABOVE the segment chips (moved from
      // below #client-seg-def).
      const layout = await page.evaluate(() => {
        const controls = document.querySelector(".client-controls");
        const segDef = document.getElementById("client-seg-def");
        if (!controls || !segDef) return null;
        // DOCUMENT_POSITION_FOLLOWING (4) on controls means segDef comes AFTER it.
        return !!(controls.compareDocumentPosition(segDef) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      ok("§G1d · .client-controls (carrying the sort) sits above #client-seg-def", layout);

      // §G2 — the sort select still actually works from its new position.
      const noteBefore = await page.$eval("#cl-sort-note", (e) => e.textContent).catch(() => "");
      eq("§G2a · \"Name A–Z\" (the default) carries no sort note", noteBefore, "");
      await page.selectOption("#cl-sort", "recent");
      await wait(page, 700);
      const noteAfter = await page.$eval("#cl-sort-note", (e) => e.textContent).catch(() => "");
      eq("§G2b · choosing \"Recently added\" updates the sort note to the exact copy app.js writes", noteAfter,
        "Newest first, by the date the client record was created here — not necessarily the date they became a client of the firm.");
      const createdAtOrder = await page.evaluate(async () => {
        const ids = [...document.querySelectorAll("#client-list .client-row")].slice(0, 20).map((r) => r.dataset.client);
        const { data } = await window.__mockDb.from("clients").select("id,created_at").in("id", ids);
        const byId = {}; (data || []).forEach((c) => (byId[c.id] = c.created_at));
        return ids.map((id) => byId[id]);
      });
      const sortedDesc = createdAtOrder.every((d, i) => i === 0 || String(createdAtOrder[i - 1]) >= String(d));
      ok("§G2c · the rendered order really is newest-first by created_at", sortedDesc, JSON.stringify(createdAtOrder));
      await page.selectOption("#cl-sort", "name");
      await wait(page, 500);

      // §G3 — chrome height: top of #page-clients to the top of the first client row, at 1280.
      // R41's own comment measured 397px -> 297px; this test's measurement point (page top to
      // first ROW top, rather than to the chips/definition line under the segment) reads a little
      // higher in this environment's font metrics, so the bound is set generously below the OLD
      // 397px rather than pinned tightly to the exact 297px figure — the property under test is
      // "meaningfully less chrome than before", not an exact pixel count this test does not
      // control the rendering of.
      const chrome = await page.evaluate(() => {
        const pageTop = document.getElementById("page-clients").getBoundingClientRect().top;
        const firstRow = document.querySelector("#client-list .client-row");
        if (!firstRow) return null;
        return firstRow.getBoundingClientRect().top - pageTop;
      });
      ok("§G3 · fixture · there is at least one client row to measure against", chrome != null, chrome);
      if (chrome != null) ok(`§G3 · chrome above the first client row at 1280 is well under the pre-R41 ~397px (got ${Math.round(chrome)}px, bound 360px)`, chrome < 360, chrome);

      ok("§G · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §H · RETENTION COLD — the never-contacted tie breaks on soonest future
            rate_end_date, none-last, then name.
       ======================================================================= */
    {
      console.log("\n— §H · cold panel: never-contacted tie-break — soonest future rate_end_date first, none last (p4, All)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const todayStr = await page.evaluate(() => localDateStr());
      const isoDaysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      const label = tag();

      // Three never-contacted clients, deliberately named so alphabetical order would put them in
      // the OPPOSITE order to the one the rate-end tie-break must actually produce.
      const soon = await mkClientCase(page, {
        first: "R41H", last: `ZZSoonest${label}`,
        case: { stage: "application", assigned_to: "p2", rate_end_date: isoDaysFromNow(30), lender: "Halifax" },
      });
      const later = await mkClientCase(page, {
        first: "R41H", last: `MMLater${label}`,
        case: { stage: "application", assigned_to: "p3", rate_end_date: isoDaysFromNow(200), lender: "Nationwide" },
      });
      const none = await mkClientCase(page, {
        first: "R41H", last: `AANone${label}`,
        case: { stage: "application", assigned_to: "p2", rate_end_date: null },
      });
      // Belt and braces: no notes/emails/appointments/tasks exist for any of them, so every one has
      // an EMPTY last-contact — the biggest tie group loadRetentionCold's own comment describes.

      await goto(page, "retention", 1800);
      const order = await page.evaluate(() => [...document.querySelectorAll("#ret-cold-list .row-item .t[onclick]")].map((e) => {
        const m = e.getAttribute("onclick").match(/openClient\('([^']+)'\)/);
        return m ? m[1] : null;
      }));
      const idxOf = (clientId) => order.indexOf(clientId);
      const iSoon = idxOf(soon.clientId), iLater = idxOf(later.clientId), iNone = idxOf(none.clientId);
      ok("§H1 · fixture · all three seeded clients are on the cold list", iSoon >= 0 && iLater >= 0 && iNone >= 0, JSON.stringify({ iSoon, iLater, iNone, order }));
      ok("§H2 · the soonest future rate-end sorts before the later one", iSoon >= 0 && iLater >= 0 && iSoon < iLater, JSON.stringify({ iSoon, iLater }));
      ok("§H3 · the client with NO future rate-end sorts after BOTH — none-last", iNone >= 0 && iNone > iSoon && iNone > iLater, JSON.stringify({ iSoon, iLater, iNone }));

      // The badge/sub-line on the soonest-rate row actually names that date — the sort is visible
      // ON the row it sorted, not a fact only the test computed independently.
      const soonRowText = await page.evaluate((id) => {
        const t = document.querySelector(`#ret-cold-list .t[onclick="openClient('${id}')"]`);
        const row = t && t.closest(".row-item");
        return row ? row.textContent : null;
      }, soon.clientId);
      ok("§H4 · the soonest client's own row shows a future rate-end (\"rate coming\")", soonRowText && /rate coming/.test(soonRowText), soonRowText);

      ok("§H · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §I · LIGHTEST-LOAD LEAD SUGGESTION — publishAdviserTaskLoad still feeds
            adviserLoadMap/leastLoadedAdviser; the suggestion is never "me".
       ======================================================================= */
    {
      console.log("\n— §I · a new lead's adviser select defaults to the lightest-loaded ADVISING adviser, never the admin viewer (p1 Kim)");
      const page = await newPage(browser, "p1", { skipTour: true });
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      // Ground truth, computed independently of app.js — the exact rule leastLoadedAdviser()
      // documents (adviser always a candidate; owner/staff only while carrying an open case;
      // admin never), over open cases + open tasks inside the 14-day horizon
      // publishAdviserTaskLoad() itself uses.
      const groundTruth = await page.evaluate(async () => {
        const db = window.__mockDb;
        const STAFF_ROLES = ["owner", "admin", "adviser", "staff"];
        const { data: profiles } = await db.from("profiles").select("id,full_name,role").order("full_name");
        const { data: cases } = await db.from("cases").select("assigned_to,stage");
        const { data: tasks } = await db.from("case_tasks").select("assigned_to,due_date,done_at");
        const team = (profiles || []).filter((p) => STAFF_ROLES.includes(p.role));
        const openCases = {};
        (cases || []).forEach((c) => { if (c.assigned_to && c.stage !== "completed" && c.stage !== "not_proceeding") openCases[c.assigned_to] = (openCases[c.assigned_to] || 0) + 1; });
        const horizon = localDateStr(Date.now() + 14 * 86400000);
        const openTasks = {};
        (tasks || []).forEach((t) => { if (t.assigned_to && !t.done_at && t.due_date && t.due_date <= horizon) openTasks[t.assigned_to] = (openTasks[t.assigned_to] || 0) + 1; });
        const isAdvising = (p) => p.role === "adviser" || (["owner", "staff"].includes(p.role) && (openCases[p.id] || 0) > 0);
        const pool = team.filter(isAdvising);
        let best = null;
        pool.forEach((p) => { const tot = (openCases[p.id] || 0) + (openTasks[p.id] || 0); if (!best || tot < best.tot) best = { id: p.id, tot }; });
        return { rr: best && best.id, poolIds: pool.map((p) => p.id) };
      });
      ok("§I · fixture · there is an advising pool to rank", groundTruth.poolIds.length > 0, JSON.stringify(groundTruth));

      const leadId = await mkLead(page, { name: "Loadtest Fixture " + tag() });
      await goto(page, "dashboard", 1500);
      const selState = await page.evaluate((id) => {
        const sel = document.querySelector(`#briefing-list select.lead-adviser[data-lead="${id}"]`);
        return sel ? { value: sel.value, text: sel.options[sel.selectedIndex].text } : null;
      }, leadId);
      ok("§I · the suggestion is the ground-truth lightest-loaded ADVISING adviser", selState && selState.value === groundTruth.rr, JSON.stringify({ selState, groundTruth }));
      ok("§I · …never Kim, the admin viewer, who is pinned first in the list but never advises", selState && selState.value !== "p1", JSON.stringify(selState));
      ok("§I · …and the option text says so (\"· lightest load\")", selState && /lightest load/.test(selState.text), JSON.stringify(selState));

      ok("§I · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r41: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
