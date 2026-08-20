#!/usr/bin/env node
/* =============================================================================
   tests/r40.js — acceptance tests for ROUND 40: the unified client timeline
   inside the case modal.

   What R40 shipped (see admin/app.js — buildClientTimeline / renderTimelineList /
   timelineRowHtml / window.openCase / the case modal's History section):
    - #notes-list is GONE. The case modal's notes now render inside the SAME
      unified timeline the client record has used since SP3b, at
      #case-events-list, sharing the .tl-row / .tl-filter / .tl-chip markup.
    - #tl-more (a single hardcoded id) is GONE — two timelines can be on
      screen at once (the case modal opens over the client record), so each
      caller now wires its OWN "Show more" through its own container by the
      `.tl-more` CLASS: `#tl-list .tl-more` on the client record,
      `#case-events-list .tl-more` inside the case modal.
    - Every .tl-row now carries `data-case` — the case it belongs to, or an
      empty string for a client-level row (an appointment with no case_id).
    - The client record's #tl-filters grew a 9th chip, `[data-cat="task"]`
      ("Tasks done"); "activity" (everything but system rows) is still the
      default.
    - The case modal has its OWN #case-tl-filters — just two chips, "All"
      (default) and "Activity" — because inside one case's history the stage
      changes ARE the history, not cross-case noise.
    - The case modal's History caps at CASE_TL_CAP = 30 past rows, "Show
      more" adds 100 more from there (vs the client record's cap of 100).
    - eventTimelineHtml() and noteRowHtml() are DELETED. buildClientTimeline
      grew an 8th source: completed case_tasks (done_at truthy) → cat "task",
      icon ✅, title "Task done: {title}".
    - CTO fix (commit 09832e2): inside the case modal ONLY, every row's
      caseChip/caseLabel is stripped — no `.tl-prop` chip, no `.tl-case`
      label inside #case-events-list, on an addressed case or otherwise
      (every row in a single case's modal already belongs to the case named
      in the header). The client record's own timeline (#tl-list) is
      UNCHANGED and still carries the chip/label.

   §1  Case modal — multiple sources render as .tl-row[data-cat], data-case is
       populated (or "" for a client-level row), another case's appointment is
       excluded while a null-case (client-level) appointment is included, the
       modal's own #case-tl-filters (All/Activity) toggle system-row
       visibility, and no .tl-prop/.tl-case ever appears inside
       #case-events-list — while #case-audit / #case-files-body keep their
       place directly below/after the timeline.
   §2  Cap — CASE_TL_CAP=30, #case-events-list .tl-more, click reveals more.
   §3  Composer — a note posted through #new-note/#add-note-btn lands at the
       top of #case-events-list without a modal reopen/refetch, is visible
       under both chips (a note is never a system row), and the Call chip's
       typed prefix produces data-cat="call".
   §4  Re-file from a modal timeline row — strike + badge SURVIVE a reopen
       (i.e. are read back off the database, not just held in memory).
   §5  XSS — a task title and a note body carrying `<img src=x onerror=…>`
       render escaped: 0 <img> nodes inside #case-events-list.
   §6  Client record unregressed — 9 filter chips incl. "Tasks done", the
       "activity" default, the Upcoming block, and #tl-list .tl-more.
   §7  CONTACT_TL_CATS / "Last contact" — a completed task does not count as
       contact and must not make the line read fresher than the client's
       actual last call/note/email/meeting.

   EVERY figure this file asserts is either read straight back off the mock
   db, computed from the test's own seeding, or a constant lifted verbatim
   from admin/app.js (CASE_TL_CAP=30, the client's 9 TL_CATS, CONTACT_TL_CATS)
   — the same standing rule tests/r38.js/r37.js/r36.js already follow.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r40.js
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

/* Same defensive localStorage clear every suite in this harness does before depending on a
   default — nx_drawer_* enumerated the same way tests/r38.js enumerates them. */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_ret_scope", "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads",
  "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — same technique tests/r38.js/r37.js/r36.js
   already use.
   ------------------------------------------------------------------------- */
let uniq = 0;
function tag() { uniq += 1; return `R40U${Date.now().toString(36)}${uniq}`; }
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
    first_name: o.first || "R40", last_name: o.last || ("Client" + tag()),
    email: `r40.${tag().toLowerCase()}@example.com`, phone: "07700900000",
  }, o.fields || {}));
  return row.id;
}
async function mkCase(page, clientId, fields) {
  const row = await insertRow(page, "cases", Object.assign({
    client_id: clientId, case_kind: "remortgage", stage: "enquiry", assigned_to: "p2",
  }, fields || {}));
  return row.id;
}
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const isoDaysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();

async function rowsOf(page, sel) {
  return page.evaluate((s) => [...document.querySelectorAll(`${s} .tl-row`)].map((r) => ({
    cat: r.dataset.cat, caseId: r.dataset.case,
    text: (r.querySelector(".tl-title") || {}).textContent || "",
    html: (r.querySelector(".tl-title") || {}).innerHTML || "",
  })), sel);
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
       §1 · CASE MODAL — sources, exclusion/inclusion, data-case, chips,
            CTO strip, audit/files still in place
       ======================================================================= */
    {
      console.log("\n— §1 · case modal: multi-source rows, data-case, exclusion, chips, CTO strip (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const clientId = await mkClient(page, { first: "R40S1", last: "Multi" + tag() });
      const caseA = await mkCase(page, clientId, {
        stage: "enquiry", case_kind: "remortgage", lender: "Halifax", assigned_to: "p2",
        property_address: "12 Example Street, Bournemouth BH1 2AB",
      });
      const caseB = await mkCase(page, clientId, { stage: "application", case_kind: "buy_to_let", assigned_to: "p2" });

      // One of each of the seven DB-backed sources, all on caseA, all in the past.
      const note = await insertRow(page, "case_notes", { case_id: caseA, body: "Discussed remortgage options", created_at: isoDaysAgo(6), created_by: "p2" });
      await insertRow(page, "email_queue", { case_id: caseA, client_id: clientId, email_type: "welcome", to_email: "x@example.com", subject: "Welcome", status: "sent", sent_at: isoDaysAgo(5) });
      await insertRow(page, "sms_queue", { case_id: caseA, client_id: clientId, sms_type: "appointment_reminder", to_phone: "07700900000", status: "sent", sent_at: isoDaysAgo(4) });
      const apptA = await insertRow(page, "appointments", { case_id: caseA, client_id: clientId, title: "Fact find call", starts_at: isoDaysAgo(3), staff_id: "p2" });
      await insertRow(page, "fact_finds", { case_id: caseA, client_id: clientId, status: "submitted", submitted_at: isoDaysAgo(2), created_at: isoDaysAgo(9) });
      const task = await insertRow(page, "case_tasks", { case_id: caseA, title: "Chase lender for offer", done_at: isoDaysAgo(1), created_by: "p2" });
      // System row: a real stage change, exactly as the app itself would write it.
      await page.evaluate((id) => window.__mockDb.from("cases").update({ stage: "application" }).eq("id", id), caseA);

      // Exclusion: an appointment on caseB (same client, other case) must not appear in caseA's modal.
      await insertRow(page, "appointments", { case_id: caseB, client_id: clientId, title: "Protection review", starts_at: isoDaysAgo(3), staff_id: "p2" });
      // Inclusion: a NULL-case, client-level appointment must appear (data-case = "").
      const clientAppt = await insertRow(page, "appointments", { case_id: null, client_id: clientId, title: "General catch-up", starts_at: isoDaysAgo(2), staff_id: "p2" });

      await page.evaluate((id) => window.openCase(id), caseA);
      await wait(page, 1000);

      const rows = await rowsOf(page, "#case-events-list");
      const cats = new Set(rows.map((r) => r.cat));
      ok("§1a · a note row rendered (data-cat=\"note\")", cats.has("note") && rows.some((r) => /Discussed remortgage options/.test(r.text)), JSON.stringify(rows.map((r) => r.cat)));
      ok("§1b · a sent-email row rendered (data-cat=\"email\")", rows.some((r) => r.cat === "email" && /Welcome/.test(r.text)), JSON.stringify(rows));
      ok("§1c · a sent-SMS row rendered (data-cat=\"email\", \"… SMS\")", rows.some((r) => r.cat === "email" && /Appointment reminder SMS/.test(r.text)), JSON.stringify(rows));
      ok("§1d · the case's own appointment rendered (data-cat=\"appointment\")", rows.some((r) => r.cat === "appointment" && /Fact find call/.test(r.text)), JSON.stringify(rows));
      ok("§1e · the fact-find rendered (data-cat=\"system\", \"Fact-find submitted\")", rows.some((r) => r.cat === "system" && /Fact-find submitted/.test(r.text)), JSON.stringify(rows));
      ok("§1f · the completed task rendered (data-cat=\"task\", \"Task done: …\")", rows.some((r) => r.cat === "task" && r.text.includes("Task done: Chase lender for offer")), JSON.stringify(rows));
      ok("§1g · the stage-change system row rendered (data-cat=\"system\")", rows.some((r) => r.cat === "system" && /enquiry.*application|application.*enquiry/i.test(r.text)), JSON.stringify(rows));

      ok("§1h · GUARD · the other case's (caseB) appointment is NOT in caseA's modal", !rows.some((r) => /Protection review/.test(r.text)), JSON.stringify(rows));
      const clientApptRow = rows.find((r) => /General catch-up/.test(r.text));
      ok("§1i · the null-case, client-level appointment IS in caseA's modal", !!clientApptRow, JSON.stringify(rows));
      eq("§1j · …and its data-case is empty (a client-level row belongs to no case)", clientApptRow ? clientApptRow.caseId : undefined, "");

      const caseARows = rows.filter((r) => !/General catch-up/.test(r.text));
      ok("§1k · every row that DOES belong to caseA carries data-case=caseA's id", caseARows.every((r) => r.caseId === caseA), JSON.stringify(caseARows.map((r) => r.caseId)));

      /* CTO fix — no .tl-prop / .tl-case anywhere inside #case-events-list, even though caseA
         has a property address that WOULD otherwise stamp every row with a .tl-prop chip. */
      const chipCounts = await page.evaluate(() => ({
        prop: document.querySelectorAll("#case-events-list .tl-prop").length,
        caseLabel: document.querySelectorAll("#case-events-list .tl-case").length,
      }));
      eq("§1l · CTO · no .tl-prop chip anywhere inside #case-events-list", chipCounts.prop, 0);
      eq("§1m · CTO · no .tl-case label anywhere inside #case-events-list", chipCounts.caseLabel, 0);

      /* #case-tl-filters — All (default) vs Activity. */
      const chipState = await page.evaluate(() => {
        const chips = [...document.querySelectorAll("#case-tl-filters .tl-filter")].map((b) => b.dataset.cat);
        const active = document.querySelector("#case-tl-filters .tl-filter.active");
        return { chips, active: active ? active.dataset.cat : null };
      });
      eq("§1n · #case-tl-filters has exactly two chips: all, activity", chipState.chips, ["all", "activity"]);
      eq("§1o · \"All\" is active by default", chipState.active, "all");
      const systemVisibleDefault = await page.evaluate(() => document.querySelectorAll('#case-events-list .tl-row[data-cat="system"]').length);
      ok("§1p · system rows ARE visible by default (All)", systemVisibleDefault >= 2, systemVisibleDefault);

      await page.click('#case-tl-filters .tl-filter[data-cat="activity"]');
      await wait(page, 400);
      const systemHiddenAfterActivity = await page.evaluate(() => document.querySelectorAll('#case-events-list .tl-row[data-cat="system"]').length);
      eq("§1q · clicking Activity hides every system row", systemHiddenAfterActivity, 0);
      const stillHasNote = await page.evaluate(() => !!document.querySelector('#case-events-list .tl-row[data-cat="note"]'));
      ok("§1r · …while a non-system row (the note) stays visible under Activity", stillHasNote);

      await page.click('#case-tl-filters .tl-filter[data-cat="all"]');
      await wait(page, 400);
      const systemRestored = await page.evaluate(() => document.querySelectorAll('#case-events-list .tl-row[data-cat="system"]').length);
      eq("§1s · clicking All restores the system rows", systemRestored, systemVisibleDefault);

      /* #case-audit and #case-files-body still there, #case-audit still directly below the timeline. */
      const layout = await page.evaluate(() => {
        const hist = document.getElementById("case-history");
        const tl = document.getElementById("case-events-list");
        const audit = document.getElementById("case-audit");
        return {
          auditPresent: !!audit,
          auditAfterTimeline: !!(hist && tl && audit && (tl.compareDocumentPosition(audit) & Node.DOCUMENT_POSITION_FOLLOWING)),
          filesBodyPresent: !!document.getElementById("case-files-body"),
        };
      });
      ok("§1t · #case-audit is present", layout.auditPresent);
      ok("§1u · …and sits below the timeline in DOM order", layout.auditAfterTimeline);
      ok("§1v · #case-files-body is present and untouched (documents checklist)", layout.filesBodyPresent);

      /* Same client's own record: the property chip DOES still render there. */
      await page.evaluate(() => window.closeModal());
      await wait(page, 300);
      await page.evaluate((id) => window.openClient(id), clientId);
      await wait(page, 1200);
      const clientChip = await page.evaluate(() => document.querySelectorAll("#tl-list .tl-prop").length);
      ok("§1w · the CLIENT-page timeline (#tl-list) still shows the .tl-prop chip (CTO strip is case-modal-only)", clientChip > 0, clientChip);

      ok("§1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §2 · CAP — CASE_TL_CAP=30, #case-events-list .tl-more, Show more
       ======================================================================= */
    {
      console.log("\n— §2 · case modal caps at 30 past rows, #case-events-list .tl-more reveals the rest (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const clientId = await mkClient(page, { first: "R40S2", last: "Cap" + tag() });
      const caseId = await mkCase(page, clientId, { stage: "application" });
      const NOTES = 35;
      for (let i = 0; i < NOTES; i++) {
        await insertRow(page, "case_notes", { case_id: caseId, body: `Cap probe note #${i}`, created_at: isoDaysAgo(NOTES - i), created_by: "p2" });
      }
      // A `cases` insert itself writes one "case_created" system row (mock-supabase.js parity with
      // the real log_case_event trigger) — that is the 36th past row this default "All" view counts.
      const TOTAL = NOTES + 1;

      await page.evaluate((id) => window.openCase(id), caseId);
      await wait(page, 1000);

      const initial = await rowsOf(page, "#case-events-list");
      eq("§2a · exactly 30 rows render before Show more (CASE_TL_CAP)", initial.length, 30);
      const more = await page.evaluate(() => {
        const btn = document.querySelector("#case-events-list .tl-more");
        return btn ? btn.textContent : null;
      });
      ok(`§2b · #case-events-list .tl-more is present, offering the remaining ${TOTAL - 30}`, !!more && new RegExp(String(TOTAL - 30)).test(more), more);

      await page.click("#case-events-list .tl-more");
      await wait(page, 400);
      const afterClick = await rowsOf(page, "#case-events-list");
      eq("§2c · clicking Show more reveals every row", afterClick.length, TOTAL);
      const gone = await page.evaluate(() => !document.querySelector("#case-events-list .tl-more"));
      ok("§2d · …and the button is gone (nothing left to show)", gone);

      ok("§2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §3 · COMPOSER — in-place insert, both chips, call-prefix category
       ======================================================================= */
    {
      console.log("\n— §3 · #new-note/#add-note-btn lands at the top of #case-events-list without a reopen (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const clientId = await mkClient(page, { first: "R40S3", last: "Compose" + tag() });
      const caseId = await mkCase(page, clientId, { stage: "application" });
      await insertRow(page, "case_notes", { case_id: caseId, body: "An older note", created_at: isoDaysAgo(3), created_by: "p2" });

      await page.evaluate((id) => window.openCase(id), caseId);
      await wait(page, 1000);

      const PLAIN_TEXT = "R40 composer probe " + Date.now();
      await page.fill("#new-note", PLAIN_TEXT);
      await page.click("#add-note-btn");
      await wait(page, 500);

      const afterPlain = await rowsOf(page, "#case-events-list");
      ok("§3a · the new note is now the TOP row (no reopen/refetch needed)", afterPlain[0] && afterPlain[0].text.includes(PLAIN_TEXT), JSON.stringify(afterPlain[0]));
      eq("§3b · …filed as a plain note (data-cat=\"note\")", afterPlain[0] && afterPlain[0].cat, "note");
      const stillOpen = await page.evaluate(() => !!document.getElementById("case-events-list"));
      ok("§3c · the modal itself never closed/reopened for this insert", stillOpen);

      // Visible under both chips — a note is never a system row.
      await page.click('#case-tl-filters .tl-filter[data-cat="activity"]');
      await wait(page, 300);
      const underActivity = await page.evaluate((t) => document.getElementById("case-events-list").textContent.includes(t), PLAIN_TEXT);
      ok("§3d · the new note is visible under \"Activity\"", underActivity);
      await page.click('#case-tl-filters .tl-filter[data-cat="all"]');
      await wait(page, 300);
      const underAll = await page.evaluate((t) => document.getElementById("case-events-list").textContent.includes(t), PLAIN_TEXT);
      ok("§3e · …and under \"All\"", underAll);

      // Call-prefixed note → data-cat="call".
      await page.click('#note-type-chips .tl-chip[data-type="call"]');
      const CALL_TEXT = "R40 call probe " + Date.now();
      await page.fill("#new-note", CALL_TEXT);
      await page.click("#add-note-btn");
      await wait(page, 500);
      const afterCall = await rowsOf(page, "#case-events-list");
      const callRow = afterCall.find((r) => r.text.includes(CALL_TEXT));
      ok("§3f · a note typed with the Call chip active renders data-cat=\"call\"", !!callRow && callRow.cat === "call", JSON.stringify(callRow));

      ok("§3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §4 · RE-FILE FROM A MODAL TIMELINE ROW — survives a reopen
       ======================================================================= */
    {
      console.log("\n— §4 · re-file a note from the modal's History row; strike + badge persist after reopen (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const clientId = await mkClient(page, { first: "R40S4", last: "Refile" + tag() });
      const src = await mkCase(page, clientId, { stage: "application", property_address: "1 Source St, Poole BH15 1AA" });
      const tgt = await mkCase(page, clientId, { stage: "application", property_address: "2 Target Rd, Poole BH15 2BB" });
      const note = await insertRow(page, "case_notes", { case_id: src, body: "Call: chased the valuation", created_at: isoDaysAgo(2), created_by: "p2" });

      await page.evaluate((id) => window.openCase(id), src);
      await wait(page, 900);
      await page.click(`#case-events-list .note-refile-btn[data-note-id="${note.id}"]`);
      await wait(page, 500);
      await page.selectOption("#refile-target", tgt);
      await page.click("#refile-ok");
      await wait(page, 1200);

      // Reopen (a fresh DB read), not just the optimistic in-modal repaint.
      await page.evaluate(() => window.closeModal());
      await wait(page, 300);
      await page.evaluate((id) => window.openCase(id), src);
      await wait(page, 1000);

      const rendered = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#case-events-list .tl-row")];
        const struck = rows.find((r) => r.querySelector("s.tl-refiled") && /chased the valuation/.test(r.querySelector("s.tl-refiled").textContent));
        return {
          found: !!struck,
          badge: !!(struck && struck.querySelector(".note-refiled-badge")),
          text: struck ? struck.querySelector("s.tl-refiled").textContent : null,
          noControl: !!(struck && !struck.querySelector(".note-refile-btn")),
        };
      });
      ok("§4a · after reopening the modal, the original note renders struck (<s class=\"tl-refiled\">)", rendered.found, JSON.stringify(rendered));
      ok("§4b · …with a re-filed badge", rendered.badge, JSON.stringify(rendered));
      eq("§4c · …readable underneath the strike", rendered.text, "chased the valuation");
      ok("§4d · …and no longer offers Re-file", rendered.noControl, JSON.stringify(rendered));

      await page.evaluate(() => window.closeModal());
      await wait(page, 300);
      await page.evaluate((id) => window.openCase(id), tgt);
      await wait(page, 900);
      const copyPresent = await page.evaluate(() => [...document.querySelectorAll("#case-events-list .tl-title")].some((t) => /^Re-filed from /.test(t.textContent)));
      ok("§4e · the target case now carries the re-filed copy", copyPresent);

      ok("§4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §5 · XSS — task title + note body escaped, 0 <img> nodes
       ======================================================================= */
    {
      console.log("\n— §5 · a malicious task title and note body render escaped inside #case-events-list (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const clientId = await mkClient(page, { first: "R40S5", last: "Xss" + tag() });
      const caseId = await mkCase(page, clientId, { stage: "application" });
      const NASTY = '<img src=x onerror="window.__pwned=1">';
      await insertRow(page, "case_tasks", { case_id: caseId, title: NASTY, done_at: isoDaysAgo(1), created_by: "p2" });
      await insertRow(page, "case_notes", { case_id: caseId, body: NASTY, created_at: isoDaysAgo(1), created_by: "p2" });

      await page.evaluate((id) => window.openCase(id), caseId);
      await wait(page, 1000);

      const safety = await page.evaluate(() => ({
        pwned: !!window.__pwned,
        imgs: document.querySelectorAll("#case-events-list img").length,
        escapedTask: document.getElementById("case-events-list").innerHTML.includes("Task done: &lt;img"),
        escapedNote: [...document.querySelectorAll("#case-events-list .tl-title")].some((t) => t.textContent.includes("<img src=x onerror")),
      }));
      eq("§5a · no onerror fired (0 img elements were ever created)", safety.pwned, false);
      eq("§5b · 0 <img> nodes inside #case-events-list", safety.imgs, 0);
      ok("§5c · the task title renders escaped", safety.escapedTask, JSON.stringify(safety));
      ok("§5d · the note body renders as visible text, not markup", safety.escapedNote, JSON.stringify(safety));

      ok("§5 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §6 · CLIENT RECORD UNREGRESSED — 9 chips, activity default, Tasks done
            filter, Upcoming block, #tl-list .tl-more
       ======================================================================= */
    {
      console.log("\n— §6 · client record: 9 filter chips incl. Tasks done, activity default, Upcoming, #tl-list .tl-more (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const clientId = await mkClient(page, { first: "R40S6", last: "Client" + tag() });
      const caseId = await mkCase(page, clientId, { stage: "application" });
      const TOTAL = 105; // > the client record's 100-row cap
      for (let i = 0; i < TOTAL; i++) {
        await insertRow(page, "case_notes", { case_id: caseId, body: `Client cap probe #${i}`, created_at: isoDaysAgo(TOTAL - i), created_by: "p2" });
      }
      const doneTask = await insertRow(page, "case_tasks", { case_id: caseId, title: "Tasks-done chip probe", done_at: isoDaysAgo(1), created_by: "p2" });
      await insertRow(page, "appointments", { case_id: caseId, client_id: clientId, title: "Upcoming block probe", starts_at: isoDaysFromNow(10), staff_id: "p2" });

      await page.evaluate((id) => window.openClient(id), clientId);
      await wait(page, 1500);

      const chipState = await page.evaluate(() => {
        const chips = [...document.querySelectorAll("#tl-filters .tl-filter")].map((b) => b.dataset.cat);
        const active = document.querySelector("#tl-filters .tl-filter.active");
        return { chips, active: active ? active.dataset.cat : null };
      });
      eq("§6a · #tl-filters has exactly 9 chips", chipState.chips.length, 9);
      eq("§6b · …in the expected order, including \"task\" (Tasks done)", chipState.chips,
        ["activity", "all", "call", "email", "meeting", "note", "appointment", "task", "system"]);
      eq("§6c · \"activity\" is still the default", chipState.active, "activity");

      const taskChipLabel = await page.evaluate(() => document.querySelector('#tl-filters .tl-filter[data-cat="task"]').textContent.trim());
      eq("§6d · the 9th chip reads \"Tasks done\"", taskChipLabel, "Tasks done");

      await page.click('#tl-filters .tl-filter[data-cat="task"]');
      await wait(page, 400);
      const afterTaskFilter = await page.evaluate(() => [...document.querySelectorAll("#tl-list .tl-row")].map((r) => r.dataset.cat));
      ok("§6e · clicking \"Tasks done\" shows only task rows", afterTaskFilter.length > 0 && afterTaskFilter.every((c) => c === "task"), JSON.stringify(afterTaskFilter));
      const taskRowText = await page.evaluate(() => (document.querySelector('#tl-list .tl-row[data-cat="task"] .tl-title') || {}).textContent || "");
      ok("§6f · …and it is the completed task we seeded", taskRowText.includes("Tasks-done chip probe"));

      // Back to activity, so the cap/Upcoming reads reflect the default view.
      await page.click('#tl-filters .tl-filter[data-cat="activity"]');
      await wait(page, 400);

      const upcoming = await page.evaluate(() => {
        const block = document.querySelector("#tl-list .tl-upcoming");
        return { present: !!block, hasProbe: block ? block.textContent.includes("Upcoming block probe") : false };
      });
      ok("§6g · the Upcoming block renders", upcoming.present, JSON.stringify(upcoming));
      ok("§6h · …and carries the future-dated appointment", upcoming.hasProbe, JSON.stringify(upcoming));

      const past = await page.evaluate(() => document.querySelectorAll("#tl-list .tl-row").length - (document.querySelectorAll("#tl-list .tl-upcoming .tl-row").length));
      ok("§6i · the past list caps at 100 rows", past <= 100, past);
      const moreBtn = await page.evaluate(() => {
        const b = document.querySelector("#tl-list .tl-more");
        return b ? b.textContent : null;
      });
      ok("§6j · #tl-list .tl-more is present (105 past notes exceed the 100 cap)", !!moreBtn, moreBtn);

      await page.click("#tl-list .tl-more");
      await wait(page, 500);
      const afterMore = await page.evaluate(() => document.querySelectorAll("#tl-list .tl-row").length - document.querySelectorAll("#tl-list .tl-upcoming .tl-row").length);
      eq("§6k · clicking it reveals every past row (105 notes + 1 done task = 106)", afterMore, TOTAL + 1);

      ok("§6 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §7 · CONTACT_TL_CATS / "Last contact" — a completed task is not contact
       ======================================================================= */
    {
      console.log("\n— §7 · a completed task does not freshen the \"Last contact\" line (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const clientId = await mkClient(page, { first: "R40S7", last: "Contact" + tag() });
      const caseId = await mkCase(page, clientId, { stage: "application" });
      // The client's real last contact: a note 30 days ago.
      await insertRow(page, "case_notes", { case_id: caseId, body: "Old check-in call", created_at: isoDaysAgo(30), created_by: "p2" });
      // A task completed TODAY — must NOT count as contact.
      await insertRow(page, "case_tasks", { case_id: caseId, title: "Recently completed task", done_at: new Date().toISOString(), created_by: "p2" });

      await page.evaluate((id) => window.openClient(id), clientId);
      await wait(page, 1200);

      const lastContact = await page.$eval("#client-last-contact", (e) => e.textContent).catch(() => "");
      ok("§7a · \"Last contact\" is present", lastContact.length > 0, lastContact);
      ok("§7b · it reads the 30-day-old NOTE, not \"today\"", /note, 30 days ago/.test(lastContact), lastContact);
      ok("§7c · GUARD · it does not read \"today\" (which is when the task, not a contact, happened)", !/today/.test(lastContact), lastContact);

      ok("§7 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (_) { try { server.kill(); } catch (__) {} } }
  }

  console.log("\n================================================================");
  console.log(`r40: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
