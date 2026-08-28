#!/usr/bin/env node
/* =============================================================================
   tests/r72_admin.js — acceptance tests for ROUND 72 agent B, "the admin can
   work the queues": the four things an administrator does all day that the app
   made her do one row at a time, or did quietly wrong on her behalf.

   THE DEFECTS THIS ROUND IS ABOUT.
     H4 · NEW RECORDS DEFAULT TO WHOEVER IS TYPING. "Book appointment" from a
          case defaulted Who to the person booking, so an administrator doing
          intake on advisers' behalf silently filled her OWN diary; "+ New case"
          defaulted Assigned to to the creator, so cases landed on the desk of
          somebody who does not advise. The Watchtower catches an UNASSIGNED
          case. It cannot catch a silently self-assigned one.
     H5b· WATCHTOWER CANNOT BE TRIAGED IN BULK. 38 open alerts in production and
          23 of them are one rule: ~110 clicks, 23 typed reasons, and a repaint
          between every single one.
     M3 · THE EMAIL QUEUE CANNOT BE READ OR STOPPED IN BULK. Rows showed a type
          and an address and nothing else; checkboxes existed only on FAILED
          rows. 36 emails are queued and none has ever sent — the day the hold
          comes off, all 36 leave, and nobody can see what any of them says.
     B4 · DIP JOINS THE BULK-CHECKLIST VERB (owner decision, 28 Aug). R71 skipped
          Decision in Principle as premature; Daniel overruled it.

     §A  H4a · BOOK APPOINTMENT FROM A CASE — Who defaults to the CASE's adviser
         for an admin booker and for a colleague, to SELF when the case is the
         booker's own, and falls back to the booker on an unassigned case. The
         form says whose diary it is while it is still open, and the save toast
         names that diary. The Diary's own "+ Appointment" (no case) is
         unchanged. retBookReview agrees with the case action bar.
     §B  H4b · + NEW CASE — unassigned for p1 (admin) and p4 (owner), SELF for p2
         (adviser); the rule is stated in the form's own .panel-sub; a case saved
         without touching the select really does store null; an EXISTING case's
         form is untouched; lead-accept routing is NOT affected.
     §C  H5b · WATCHTOWER BULK TRIAGE — a tick per real alert row (never on a
         synthetic one), "Select all N" per RULE selecting exactly that rule's
         rows, ONE overlay confirm with ONE reason, snooze writing
         snoozed_until/snooze_note/snoozed_by on every selected row and nothing
         else, dismiss writing resolved_at and NOT the snooze columns, EXACTLY
         ONE repaint for the batch, selection cleared, a tally toast, a required
         reason (and a case note) when the batch holds a critical, and the
         per-row Snooze…/Dismiss buttons still present and still working.
     §D  M3 · EMAIL QUEUE — queued rows are selectable and foldable; the preview
         renders the stored body INERTLY (no script ran, no <script>/<a
         href>/onerror survived, the words did); a row with no stored body says
         so; "Cancel selected" opens ONE overlay confirm naming the count and
         that a cancelled email never sends, then cancels via one batched write
         and writes the case notes; Retry is scoped to the failed subset and
         never touches a queued row; failed-only Retry is unchanged.
     §E  B4 · a DIP case gets a checklist from the bulk verb; Enquiry is still
         named and skipped.
     §F  no console errors on any persona this round touches.

   EVERY figure asserted here — the London snooze date, the British date in the
   toast, the expected checklist — is recomputed IN THIS FILE at runtime from
   the fixtures, never read out of app.js, per HARNESS.md's standing rule. The
   fixture book is only ever READ; every row this file writes to is one it made.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node /root/nx/tests/r72_admin.js
         (expects a static server on 8099; starts one itself if absent)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const SETTLE = 1600;
const DAY_MS = 86400000;

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

/* The defensive localStorage clear every recent suite does before depending on a default.
   nx_wt_lastrun is deliberately NOT in this list — §C sets it on purpose (see the note there). */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser", "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_ret_scope", "nx_ret_sortdir", "nx_ret_untouched", "nx_drawer_watchtower", "nx_drawer_unactioned",
  "nx_drawer_leads", "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue",
  "nx_em_status"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

async function newPage(browser, persona) {
  const page = await browser.newPage();
  await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  page.__dialogs = [];
  page.on("dialog", async (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); await d.accept(); });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  await clearNxKeys(page);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1300 : ms);
};
const openCase = async (page, caseId) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((id) => window.openCase(id), caseId);
  await wait(page, 1200);
};
const overlay = (page) => page.evaluate(() => {
  const box = document.querySelector("#overlay-modal");
  const bd = document.querySelector("#overlay-backdrop");
  const open = !!box && !!bd && !bd.classList.contains("hidden");
  if (!open) return { open: false, text: "" };
  return {
    open: true,
    heading: (box.querySelector("h3") || {}).textContent || "",
    text: box.textContent.replace(/\s+/g, " ").trim(),
    hasTriageOk: !!box.querySelector("#wtbulk-ok"),
    hasEmCancelOk: !!box.querySelector("#emcancel-ok"),
    hasDocsOk: !!box.querySelector("#bulkdocs-ok"),
    err: (box.querySelector("#wtbulk-err") || {}).textContent || "",
  };
});
/* Same "case with nothing attached to it" helper the R71 suite uses: a plain insert, so no
   playbook and no checklist ride along. */
async function mkCase(page, o) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email === null ? null : (o.email || `r72.${Math.random().toString(36).slice(2, 9)}@example.com`);
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Ada", last_name: o.last || "R72Case", email }).select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = {
      client_id: cl.id, case_kind: o.case_kind || "purchase", stage: o.stage || "fact_find",
      assigned_to: o.assigned_to === undefined ? "p2" : o.assigned_to,
      lender: o.lender === undefined ? "Halifax" : o.lender,
      protection_status: o.protection_status === undefined ? "not_needed" : o.protection_status,
    };
    if (o.completed_at !== undefined) row.completed_at = o.completed_at;
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id };
  }, o || {});
}
const caseRow = (page, id) => page.evaluate(async (i) =>
  (await window.__mockDb.from("cases").select("*").eq("id", i).single()).data, id);
const notesOf = (page, id) => page.evaluate(async (i) =>
  (await window.__mockDb.from("case_notes").select("*").eq("case_id", i)).data || [], id);

/* The case action bar collapses its tail into a "More actions" popover on a narrow modal — same
   helper r12b uses, so this file clicks whichever one is actually on screen. */
async function clickAction(page, id) {
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, `#${id}`);
  if (!visible) await page.click("#case-more-actions-toggle");
  await page.click(`#${id}`);
  await wait(page, 900);
}

/* ---------------------------------------------------------------------------
   INDEPENDENT DATE ARITHMETIC. Europe/London, recomputed here — never read out
   of app.js's localDateStr/fmtD. Run inside the page so the browser's clock and
   the app's clock are the same clock.
   --------------------------------------------------------------------------- */
const londonDates = (page, days) => page.evaluate((n) => {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
  const ds = fmt.format(new Date(Date.now() + n * 86400000));
  const iso = new Date(ds + "T23:59:59").toISOString();
  /* R73: the expected string comes from a FIXED month table, not Intl's
     month:"short". Under current ICU en-GB renders September as "Sept" — four
     letters where the other eleven months get three — so this oracle and the app
     disagreed for one month of the year, on a snooze whose whole point is naming
     the date. R73's fmtD stopped using Intl for the month name for exactly that
     reason; the oracle follows, written out separately (the r65_watchtower
     precedent) so a change to one is not silently a change to both. */
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const parts = ds.split("-");
  const british = `${Number(parts[2])} ${MON[Number(parts[1]) - 1]} ${parts[0]}`;
  return { ds, iso, british };
}, days);

/* ---------------------------------------------------------------------------
   §C helpers — the Watchtower panel as it renders.
   --------------------------------------------------------------------------- */
const openWatchtower = async (page) => {
  await goto(page, "dashboard", 2000);
  await page.evaluate(() => {
    const p = document.getElementById("watchtower-panel");
    if (p && p.classList.contains("collapsed")) document.querySelector("#watchtower-panel h3").click();
  });
  // Whole-firm scope: this file's seeded alerts hang off cases owned by several advisers, and
  // "Mine" would hide the ones that are not the viewer's.
  if (await page.$("#wt-scope-all")) { await page.click("#wt-scope-all"); }
  await wait(page, 900);
};
const wtState = (page) => page.evaluate(() => {
  const groups = [...document.querySelectorAll("#watchtower-list .wt-group")].map((g) => ({
    key: g.dataset.wtKey,
    rule: String(g.dataset.wtKey || "").split("|")[0],
    label: (g.querySelector(".wt-group-label") || {}).textContent || "",
    n: Number((g.querySelector(".wt-group-n") || {}).textContent || "-1"),
    allBtn: (g.querySelector(".wt-group-all") || {}).textContent || "",
    allPressed: (g.querySelector(".wt-group-all") || {}).getAttribute ? g.querySelector(".wt-group-all").getAttribute("aria-pressed") : null,
    rows: [...g.querySelectorAll(".wt-row")].map((r) => ({
      id: (r.querySelector(".wt-cb") || {}).dataset ? r.querySelector(".wt-cb").dataset.id : null,
      hasCb: !!r.querySelector(".wt-cb"),
      checked: !!(r.querySelector(".wt-cb") || {}).checked,
      synth: r.classList.contains("wt-row-mine"),
      hasSnooze: !!r.querySelector('button[onclick^="snoozeAlert"]'),
      hasDismiss: !!r.querySelector('button[onclick^="resolveAlert"]'),
    })),
  }));
  const bar = document.querySelector("#wt-bulk-bar");
  return {
    groups,
    barPresent: !!bar,
    /* R73 · A2: the bar no longer uses the `hidden` attribute at zero selection — it RESERVES
       its box and hides it with `visibility`. The first tick used to insert a 53px element at the
       top of the list and shift every row under the cursor down by it, on a panel you work by
       aiming at checkboxes. `visibility: hidden` keeps the box while still taking the bar out of
       the tab order and out of the accessibility tree, which is all the attribute was doing for
       us. Same question, read off the property that now answers it. */
    barHidden: !!bar && getComputedStyle(bar).visibility === "hidden",
    barBoxKept: !!bar && Math.round(bar.getBoundingClientRect().height) > 0,
    barN: Number((document.querySelector("#wt-bulk-n") || {}).textContent || "-1"),
    checked: [...document.querySelectorAll("#watchtower-list .wt-cb")].filter((c) => c.checked).map((c) => c.dataset.id),
  };
});
const alertRows = (page, ids) => page.evaluate(async (i) =>
  (await window.__mockDb.from("watch_alerts").select("*").in("id", i)).data || [], ids);
/* Seed alerts directly. run_watchtower auto-resolves any row whose dedupe_key it does not
   recompute, so §C stamps the auto-run throttle (nx_wt_lastrun) BEFORE seeding — see the note in
   the section itself. */
const seedAlerts = (page, rows) => page.evaluate(async (rs) => {
  const db = window.__mockDb;
  const out = [];
  for (const r of rs) {
    const { data, error } = await db.from("watch_alerts").insert({
      rule: r.rule, severity: r.severity, title: r.title, detail: r.detail,
      case_id: r.case_id || null, client_id: r.client_id || null,
      dedupe_key: r.rule + ":" + Math.random().toString(36).slice(2, 10),
      created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
      last_seen_at: new Date().toISOString(), resolved_at: null,
    }).select("id").single();
    if (error) throw new Error("watch_alerts insert: " + error.message);
    out.push(data.id);
  }
  return out;
}, rows);

/* ---------------------------------------------------------------------------
   §D helpers — the email queue.
   --------------------------------------------------------------------------- */
const seedEmails = (page, rows) => page.evaluate(async (rs) => {
  const db = window.__mockDb;
  const out = [];
  for (const r of rs) {
    const row = {
      case_id: r.case_id || null, client_id: r.client_id || null,
      email_type: r.email_type, to_email: r.to_email, subject: r.subject || null,
      status: r.status, error: r.error || null,
      created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    };
    if (r.body_html !== undefined) row.body_html = r.body_html;
    const { data, error } = await db.from("email_queue").insert(row).select("id").single();
    if (error) throw new Error("email_queue insert: " + error.message);
    out.push(data.id);
  }
  return out;
}, rows);
const emailRows = (page, ids) => page.evaluate(async (i) =>
  (await window.__mockDb.from("email_queue").select("*").in("id", i)).data || [], ids);
const gotoEmails = async (page) => {
  await goto(page, "emails", 2200);
  // "All" — this file seeds queued, failed and sent rows and needs them on one screen.
  if (await page.$("#em-chip-all")) { await page.click("#em-chip-all"); await wait(page, 1400); }
};
const emailRowState = (page, id) => page.evaluate((i) => {
  const cb = document.querySelector(`#email-list .email-cb[data-id="${i}"]`);
  const fold = document.querySelector(`#email-list details.em-fold[data-em-preview="${i}"]`);
  return {
    hasCb: !!cb,
    cbStatus: cb ? cb.dataset.status : null,
    hasFold: !!fold,
    summary: fold ? (fold.querySelector("summary") || {}).textContent : null,
  };
}, id);

/* ---------------------------------------------------------------------------
   §E helper — the pipeline table, ticked by id. Same shape as r71_backfill.
   --------------------------------------------------------------------------- */
async function pipelineTable(page, search) {
  await goto(page, "pipeline", 1800);
  const segSel = `#pipe-segment .seg-btn[data-seg="all"]`;
  if (await page.$(segSel)) {
    const active = await page.$eval(segSel, (e) => e.classList.contains("active"));
    if (!active) { await page.click(segSel); await wait(page, 1600); }
  }
  const isTable = await page.evaluate(() => !document.querySelector("#table-wrap").classList.contains("hidden"));
  if (!isTable) { await page.click("#view-toggle"); await wait(page, 1400); }
  if (search !== undefined) { await page.fill("#board-search", search); await wait(page, 1500); }
  await wait(page, 500);
}
async function tickRows(page, ids) {
  let n = 0;
  for (const id of ids) {
    const sel = `#pipe-table .bulk-cb[data-id="${id}"]`;
    if (await page.$(sel)) { await page.check(sel); n++; }
  }
  await wait(page, 400);
  return n;
}
const docsOf = (page, id) => page.evaluate(async (i) =>
  (await window.__mockDb.from("case_documents").select("*").eq("case_id", i)).data || [], id);
/* The firm's document list, narrowed the way the app narrows it — recomputed here, exactly as
   tests/r71_backfill.js §B does, so §E measures the writer rather than a list this file invented. */
const DOC_KIND_DROP = {
  remortgage: [/deposit/i, /memorandum/i, /gift/i],
  product_transfer: [/deposit/i, /memorandum/i, /gift/i, /bank statement/i],
  buy_to_let: [/gift/i],
};
const DOC_KIND_EXTRA = {
  purchase: ["Memorandum of sale", "Proof of deposit"],
  first_time_buyer: ["Proof of deposit", "Gifted deposit letter"],
  buy_to_let: ["Tenancy agreement", "Portfolio schedule"],
  remortgage: ["Current mortgage statement"],
  product_transfer: ["Current mortgage statement"],
  other: [],
};
function docSuggested(docsListRaw, kind) {
  const base = String(docsListRaw || "").split("|").map((s) => s.trim()).filter(Boolean);
  const drop = DOC_KIND_DROP[kind] || [];
  const suggested = [];
  base.forEach((item) => { if (!drop.some((re) => re.test(item))) suggested.push(item); });
  const seen = new Set(suggested.map((s) => s.toLowerCase()));
  (DOC_KIND_EXTRA[kind] || []).forEach((item) => {
    if (seen.has(item.toLowerCase()) || drop.some((re) => re.test(item))) return;
    seen.add(item.toLowerCase());
    suggested.push(item);
  });
  return suggested;
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
       §A · H4a — BOOK APPOINTMENT FROM A CASE.
       ======================================================================= */
    {
      console.log("\n— §A · H4a · “Book appointment” from a case defaults to the CASE's adviser (p1 admin)");
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;

      const c2 = await mkCase(page, { first: "Ann", last: "R72Appt", stage: "fact_find", assigned_to: "p2" });
      const c3 = await mkCase(page, { first: "Ben", last: "R72Appt", stage: "fact_find", assigned_to: "p3" });
      const cNone = await mkCase(page, { first: "Cal", last: "R72Appt", stage: "fact_find", assigned_to: null });

      await openCase(page, c2.caseId);
      await clickAction(page, "act-appt");
      const a1 = await page.evaluate(() => ({
        title: (document.querySelector("#modal h3") || {}).textContent || "",
        who: (document.querySelector('#appt-form [name="staff_id"]') || {}).value || "",
        whoLabel: (() => { const s = document.querySelector('#appt-form [name="staff_id"]'); return s ? s.options[s.selectedIndex].textContent : ""; })(),
        note: (document.querySelector("#appt-whose-note") || {}).textContent || "",
      }));
      eq("A1 · the appointment form opens from the case", a1.title, "New appointment");
      eq("A1b · Who defaults to the CASE's adviser (p2), not to the admin doing the booking", a1.who, "p2");
      ok("A1c · …named in the select", /Wayne/.test(a1.whoLabel), a1.whoLabel);
      ok("A1d · the form says out loud whose diary this lands in", /Wayne/.test(a1.note) && /not yours/i.test(a1.note), a1.note);

      // …and the save toast names it too.
      await page.fill('#appt-form [name="title"]', "R72 fact find call");
      const d = new Date(Date.now() + 3 * DAY_MS);
      await page.fill('#appt-form [name="date"]', d.toISOString().slice(0, 10));
      await page.fill('#appt-form [name="time"]', "11:00");
      page.__dialogs.length = 0;
      await page.click("#modal-save");
      await wait(page, 1400);
      const tA = await toastText(page);
      ok("A2 · the save toast names the diary it went into", /in Wayne Kellow's diary/.test(tA), tA);
      ok("A2b · …and still reports coming back to the case (R12b · W-10 unchanged)", /back on the case/.test(tA), tA);
      const savedAppt = await page.evaluate(async (cid) =>
        (await window.__mockDb.from("appointments").select("*").eq("case_id", cid)).data || [], c2.caseId);
      eq("A2c · the appointment was actually written to p2's diary", savedAppt.map((x) => x.staff_id), ["p2"]);
      eq("A2d · ZERO native dialogs were raised on that path", page.__dialogs.length, 0);

      // Another adviser's case, from the same admin session — still the case's adviser.
      await openCase(page, c3.caseId);
      await clickAction(page, "act-appt");
      eq("A3 · a case owned by p3 defaults to p3", await page.$eval('#appt-form [name="staff_id"]', (e) => e.value), "p3");

      // An unassigned case has nobody to default to — it falls back to the booker, and says nothing.
      await openCase(page, cNone.caseId);
      await clickAction(page, "act-appt");
      const a4 = await page.evaluate(() => ({
        who: (document.querySelector('#appt-form [name="staff_id"]') || {}).value || "",
        note: (document.querySelector("#appt-whose-note") || {}).textContent || "",
      }));
      eq("A4 · an unassigned case falls back to the person booking (p1)", a4.who, "p1");
      eq("A4b · …and the whose-diary line stays silent, because it IS your diary", a4.note.trim(), "");

      // The Diary's own "+ Appointment" is not a case booking and is unchanged.
      await goto(page, "diary", 1600);
      await page.click("#new-appt-btn");
      await wait(page, 900);
      eq("A5 · the Diary's blank “+ Appointment” still defaults to the signed-in user",
        await page.$eval('#appt-form [name="staff_id"]', (e) => e.value), "p1");
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      // R64's "Book review" from Retention takes the same rule.
      const rr = await page.evaluate(async (cid) => { await window.retBookReview(cid); return true; }, c3.caseId);
      await wait(page, 1200);
      eq("A6 · retBookReview prefills the case's own adviser too", await page.$eval('#appt-form [name="staff_id"]', (e) => e.value), "p3");
      ok("A6b · …and it is the diary's own editor, not a new form", rr === true);
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      ok("§A · no console errors", (page.__err || []).length === errBefore, JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §A2 · the case's OWN adviser booking from their own case gets themselves (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      const mine = await mkCase(page, { first: "Dee", last: "R72Appt2", stage: "fact_find", assigned_to: "p2" });
      await openCase(page, mine.caseId);
      await clickAction(page, "act-appt");
      const a = await page.evaluate(() => ({
        who: (document.querySelector('#appt-form [name="staff_id"]') || {}).value || "",
        note: (document.querySelector("#appt-whose-note") || {}).textContent || "",
      }));
      eq("A7 · Wayne booking from Wayne's case gets Wayne", a.who, "p2");
      eq("A7b · …and no “not yours” line, because it is his", a.note.trim(), "");
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
      ok("§A2 · no console errors", (page.__err || []).length === errBefore, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §B · H4b — "+ NEW CASE" DEFAULT ASSIGNEE.
       ======================================================================= */
    {
      console.log("\n— §B · H4b · a new case starts unassigned for an admin/owner, on self for an adviser");
      for (const [persona, expected, who] of [["p1", "", "Kim (admin)"], ["p4", "", "Daniel (owner)"], ["p2", "p2", "Wayne (adviser)"]]) {
        const page = await newPage(browser, persona);
        const errBefore = (page.__err || []).length;
        await goto(page, "pipeline", 1600);
        await page.click("#new-case-btn");
        await wait(page, 1200);
        const got = await page.evaluate(() => {
          const s = document.querySelector("#case-form select[name='assigned_to']");
          const sub = document.querySelector("#case-assign-sub");
          return {
            value: s ? s.value : null,
            label: s ? s.options[s.selectedIndex].textContent : null,
            sub: sub ? sub.textContent.replace(/\s+/g, " ").trim() : null,
          };
        });
        eq(`B1 · ${who}: “Assigned to” defaults to ${expected === "" ? "— unassigned —" : "themselves"}`, got.value, expected);
        if (expected === "") ok(`B1b · ${who}: …and the option reads “— unassigned —”`, /unassigned/i.test(got.label || ""), got.label);
        ok(`B2 · ${who}: the form carries a .panel-sub stating the rule`, !!got.sub, String(got.sub));
        if (expected === "") {
          ok(`B2b · ${who}: …and it says why (the Watchtower cannot catch a silently self-assigned case)`,
            /unassigned/i.test(got.sub || "") && /Watchtower/i.test(got.sub || ""), got.sub);
        } else {
          ok(`B2b · ${who}: …and it says the case starts on them because they advise`,
            /adviser/i.test(got.sub || "") && /you/i.test(got.sub || ""), got.sub);
        }
        ok(`B2c · ${who}: no console errors`, (page.__err || []).length === errBefore, JSON.stringify(page.__err));
        await page.close();
      }
    }

    {
      console.log("\n— §B2 · the default is what actually gets STORED, and an existing case is untouched (p1)");
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;

      // Save a brand-new case without touching the assignee select.
      const clientId = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients")
          .insert({ first_name: "Eve", last_name: "R72New", email: "eve.r72@example.com" }).select("id").single();
        return data.id;
      });
      await goto(page, "pipeline", 1600);
      await page.click("#new-case-btn");
      await wait(page, 1200);
      // The client picker is a combobox whose native <select> is visually hidden (R36 §B), so it is
      // set the way r69_hf1 sets it — value + a change event — rather than by clicking.
      await page.evaluate((id) => {
        const sel = document.querySelector("#case-client-select");
        sel.value = id;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }, clientId);
      await wait(page, 700);
      page.__dialogs.length = 0;
      await page.click("#modal-save");
      await wait(page, 2000);
      const created = await page.evaluate(async (cid) =>
        (await window.__mockDb.from("cases").select("*").eq("client_id", cid)).data || [], clientId);
      eq("B3 · exactly one case was created", created.length, 1);
      eq("B3b · …and it is stored UNASSIGNED (null), not quietly on the administrator", created[0] && created[0].assigned_to, null);

      // An EXISTING case keeps whatever it has, and carries no new-case sentence.
      const kept = await mkCase(page, { first: "Fay", last: "R72Keep", stage: "application", assigned_to: "p3" });
      await openCase(page, kept.caseId);
      const existing = await page.evaluate(() => ({
        value: (document.querySelector("#case-form select[name='assigned_to']") || {}).value,
        sub: !!document.querySelector("#case-assign-sub"),
      }));
      eq("B4 · an existing case's form still shows its own adviser", existing.value, "p3");
      eq("B4b · …and does NOT carry the new-case sentence", existing.sub, false);
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      /* LEAD ROUTING IS NOT AFFECTED — and this is the assertion that matters most in §B, because
         the obvious wrong way to implement "new records start unassigned" would have been to make
         it a global rule. Leads route on their OWN rules (R7-5's lightest-loaded round robin, W-9's
         pinned "(me)" for an advising viewer) and this round deliberately left acceptLeadCore
         alone. Driven through the REAL path — the My Day lead row's Accept button, which is what
         supplies the routing suggestion — not by calling the core writer with no options. */
      const lead = await page.evaluate(async () => {
        const { data, error } = await window.__mockDb.from("leads")
          .insert({ name: "Gus R72Lead", email: "gus.r72@example.com", phone: "07700900321", enquiry_type: "remortgage", status: "new", message: "R72 routing check" })
          .select("id").single();
        if (error) throw new Error("lead insert: " + error.message);
        return data.id;
      });
      await goto(page, "dashboard", 1800);
      const suggested = await page.$eval(`#briefing-list select.lead-adviser[data-lead="${lead}"]`, (s) => s.value).catch(() => null);
      ok("B5 · the lead row still SUGGESTS an adviser (the round-robin default is untouched)",
        !!suggested, String(suggested));
      await page.click(`#briefing-list [onclick^="acceptLead('${lead}'"]`);
      await wait(page, 2000);
      const leadCase = await page.evaluate(async (id) => {
        const { data: l } = await window.__mockDb.from("leads").select("converted_case_id").eq("id", id).single();
        if (!l || !l.converted_case_id) return null;
        const { data: cs } = await window.__mockDb.from("cases").select("id,assigned_to").eq("id", l.converted_case_id).single();
        return cs;
      }, lead);
      ok("B5b · a lead accepted by the ADMINISTRATOR still lands on an adviser, not unassigned",
        !!leadCase && !!leadCase.assigned_to, JSON.stringify(leadCase));
      eq("B5c · …and specifically on the adviser the row suggested, not on Kim",
        leadCase && leadCase.assigned_to, suggested);
      ok("§B2 · no console errors", (page.__err || []).length === errBefore, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §C · H5b — WATCHTOWER BULK TRIAGE.

       run_watchtower() auto-resolves any open alert whose dedupe_key it does not
       recompute, and loadDashboard() runs it (throttled to once per 10 minutes
       per browser). So: land on Today FIRST so the throttle stamp is written,
       THEN seed, then come back. Nothing this section does calls the RPC again.
       ======================================================================= */
    {
      console.log("\n— §C · H5b · Watchtower bulk snooze / dismiss (p1 admin)");
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      await goto(page, "dashboard", 2200);
      await page.evaluate(() => { try { localStorage.setItem("nx_wt_lastrun", String(Date.now())); } catch (e) {} });

      const k1 = await mkCase(page, { first: "Hal", last: "R72Wt", stage: "application", assigned_to: "p2" });
      const k2 = await mkCase(page, { first: "Ivy", last: "R72Wt", stage: "application", assigned_to: "p3" });
      const alphaIds = await seedAlerts(page, [1, 2, 3, 4, 5].map((i) => ({
        rule: "r72_alpha", severity: "warn", case_id: i % 2 ? k1.caseId : k2.caseId,
        title: `R72 Alpha ${i} — protection quote is going stale`,
        detail: "The quote has been sitting unanswered.",
      })));
      const betaIds = await seedAlerts(page, [1, 2].map((i) => ({
        rule: "r72_beta", severity: "warn", case_id: k1.caseId,
        title: `R72 Beta ${i} — the application has not been submitted`,
        detail: "Nothing has gone to the lender.",
      })));

      await goto(page, "clients", 1200);
      await openWatchtower(page);

      const s0 = await wtState(page);
      const alpha = s0.groups.find((g) => g.rule === "r72_alpha");
      const beta = s0.groups.find((g) => g.rule === "r72_beta");
      ok("C0 · the five seeded alerts render as one group of their own rule", !!alpha && alpha.n === 5, JSON.stringify(s0.groups.map((g) => [g.rule, g.n])));
      ok("C0b · …and the two-row control rule is its own group", !!beta && beta.n === 2, JSON.stringify(s0.groups.map((g) => [g.rule, g.n])));
      ok("C1 · every real alert row carries a tick box", s0.groups.every((g) => g.rows.every((r) => r.synth || r.hasCb)),
        JSON.stringify(s0.groups.flatMap((g) => g.rows.map((r) => [r.synth, r.hasCb]))));
      ok("C1b · a client-side synthetic row carries NONE (there is no watch_alerts row to write to)",
        s0.groups.every((g) => g.rows.every((r) => !r.synth || !r.hasCb)));
      ok("C1c · the per-row Snooze… and Dismiss buttons are still on every real row",
        s0.groups.every((g) => g.rows.every((r) => r.synth || (r.hasSnooze && r.hasDismiss))));
      ok("C2 · the bulk bar exists and is hidden with nothing ticked", s0.barPresent && s0.barHidden, JSON.stringify({ p: s0.barPresent, h: s0.barHidden }));
      // R73 · A2 — …and keeps its height while it is, so the first tick moves nothing.
      ok("C2a · …while keeping its box, so ticking a row shifts no rows", s0.barBoxKept, JSON.stringify({ kept: s0.barBoxKept }));
      ok("C2b · each group header carries its own “Select all N”", /Select all 5/.test(alpha.allBtn) && /Select all 2/.test(beta.allBtn),
        JSON.stringify([alpha.allBtn, beta.allBtn]));

      // Select all, on ONE rule only.
      await page.click(`.wt-group[data-wt-key="${alpha.key}"] .wt-group-all`);
      await wait(page, 500);
      const s1 = await wtState(page);
      eq("C3 · “Select all” on a rule ticks exactly that rule's rows", s1.checked.slice().sort(), alphaIds.slice().sort());
      eq("C3b · …and the bar's count says five", s1.barN, 5);
      ok("C3c · …and the bar is now visible", !s1.barHidden);
      ok("C3d · …and that group's button flips to “Clear all 5”",
        /Clear all 5/.test((s1.groups.find((g) => g.rule === "r72_alpha") || {}).allBtn || ""), JSON.stringify(s1.groups.map((g) => g.allBtn)));
      eq("C3e · the control rule's rows are untouched",
        (s1.groups.find((g) => g.rule === "r72_beta") || { rows: [] }).rows.filter((r) => r.checked).length, 0);

      const paintsBefore = await page.evaluate(() => window.__wtPaints());
      const until7 = await londonDates(page, 7);
      page.__dialogs.length = 0;
      await page.click("#wt-bulk-snooze7");
      await wait(page, 1600);
      const ovC = await overlay(page);
      ok("C4 · ONE overlay confirm opens", ovC.open && ovC.hasTriageOk, JSON.stringify(ovC).slice(0, 220));
      eq("C4b · …and ZERO native confirm()/prompt()", page.__dialogs.length, 0);
      ok("C4c · it names the date they come back", ovC.text.includes(until7.british), ovC.text.slice(0, 400));
      ok("C4d · …and says plainly that a snooze fixes nothing", /fixes nothing/i.test(ovC.text), ovC.text.slice(0, 400));
      ok("C4e · …and offers ONE reason box for the whole batch, optional here", /optional/i.test(ovC.text), ovC.text.slice(0, 600));
      ok("C4f · …and names the alerts it will write to", /R72 Alpha 1/.test(ovC.text), ovC.text.slice(0, 600));

      await page.fill("#wtbulk-reason", "R72 batch — chasing these together next week");
      await page.click("#wtbulk-ok");
      await wait(page, 2400);

      const afterSnooze = await alertRows(page, alphaIds);
      eq("C5 · every selected alert now carries a snoozed_until", afterSnooze.filter((a) => !!a.snoozed_until).length, 5);
      eq("C5b · …all to the same, correct Europe/London date", [...new Set(afterSnooze.map((a) => a.snoozed_until))], [until7.iso]);
      eq("C5c · …with the one reason on every one of them",
        [...new Set(afterSnooze.map((a) => a.snooze_note))], ["R72 batch — chasing these together next week"]);
      eq("C5d · …stamped with who did it", [...new Set(afterSnooze.map((a) => a.snoozed_by))], ["p1"]);
      eq("C5e · …and NOT resolved — a snooze is not a dismissal", afterSnooze.filter((a) => a.resolved_at).length, 0);
      const betaAfter = await alertRows(page, betaIds);
      eq("C5f · the rule that was not selected is completely untouched",
        betaAfter.map((a) => [a.snoozed_until, a.snooze_note, a.resolved_at]), [[null, null, null], [null, null, null]]);

      const paintsAfter = await page.evaluate(() => window.__wtPaints());
      eq("C6 · the whole batch cost EXACTLY ONE repaint, not one per row", paintsAfter - paintsBefore, 1);

      const tC = await toastText(page);
      ok("C7 · the toast tallies the batch and names the date", /5 alerts snoozed to/.test(tC) && tC.includes(until7.british), tC);
      const s2 = await wtState(page);
      eq("C7b · the selection is cleared afterwards", s2.checked.length, 0);
      ok("C7c · …and the bar is hidden again", s2.barHidden);
      ok("C7d · the snoozed rows have left the working list", !s2.groups.some((g) => g.rule === "r72_alpha"),
        JSON.stringify(s2.groups.map((g) => g.rule)));
      ok("C7e · …and are counted in the “N snoozed” header instead",
        await page.$eval("#watchtower-snoozed-toggle", (e) => /snoozed/i.test(e.textContent) && !e.classList.contains("hidden")).catch(() => false));

      /* ---- DISMISS, on the control rule ---- */
      const betaGroupKey = (s2.groups.find((g) => g.rule === "r72_beta") || {}).key;
      await page.click(`.wt-group[data-wt-key="${betaGroupKey}"] .wt-group-all`);
      await wait(page, 400);
      const paintsB2 = await page.evaluate(() => window.__wtPaints());
      page.__dialogs.length = 0;
      await page.click("#wt-bulk-dismiss");
      await wait(page, 1600);
      const ovD = await overlay(page);
      ok("C8 · Dismiss opens its own overlay confirm", ovD.open && ovD.hasTriageOk, JSON.stringify(ovD).slice(0, 200));
      eq("C8b · …with zero native dialogs", page.__dialogs.length, 0);
      ok("C8c · …and says a dismissal does not fix the case", /does not fix the underlying case/i.test(ovD.text), ovD.text.slice(0, 400));
      await page.click("#wtbulk-ok");
      await wait(page, 2400);
      const betaDone = await alertRows(page, betaIds);
      eq("C9 · both are resolved", betaDone.filter((a) => !!a.resolved_at).length, 2);
      eq("C9b · …and the snooze columns were NOT written by a dismissal",
        betaDone.map((a) => [a.snoozed_until, a.snooze_note, a.snoozed_by]), [[null, null, null], [null, null, null]]);
      eq("C9c · one repaint again", (await page.evaluate(() => window.__wtPaints())) - paintsB2, 1);
      ok("C9d · the toast tallies the dismissals", /2 alerts dismissed/.test(await toastText(page)), await toastText(page));

      /* ---- A CRITICAL IN THE BATCH MAKES THE REASON MANDATORY ---- */
      const critIds = await seedAlerts(page, [{
        rule: "r72_gamma", severity: "crit", case_id: k1.caseId,
        title: "R72 Gamma — ERC outlasts the rate", detail: "The charge runs past the deal.",
      }]);
      await goto(page, "clients", 1000);
      await openWatchtower(page);
      const s3 = await wtState(page);
      const gamma = s3.groups.find((g) => g.rule === "r72_gamma");
      ok("C10 · the critical alert renders as its own group", !!gamma && gamma.n === 1, JSON.stringify(s3.groups.map((g) => [g.rule, g.n])));
      await page.click(`.wt-group[data-wt-key="${gamma.key}"] .wt-group-all`);
      await wait(page, 400);
      page.__dialogs.length = 0;
      await page.click("#wt-bulk-dismiss");
      await wait(page, 1600);
      const ovE = await overlay(page);
      ok("C11 · the confirm says the reason is REQUIRED when a critical is in the batch",
        /required/i.test(ovE.text) && /critical/i.test(ovE.text), ovE.text.slice(0, 600));
      await page.click("#wtbulk-ok");
      await wait(page, 700);
      const ovE2 = await overlay(page);
      ok("C11b · pressing it empty refuses and says why, without writing", ovE2.open && /required/i.test(ovE2.err), JSON.stringify(ovE2).slice(0, 300));
      eq("C11c · …and nothing was written", (await alertRows(page, critIds)).filter((a) => a.resolved_at).length, 0);
      await page.fill("#wtbulk-reason", "R72 — duplicate of the one Wayne already fixed");
      await page.click("#wtbulk-ok");
      await wait(page, 2400);
      eq("C12 · with a reason it writes", (await alertRows(page, critIds)).filter((a) => !!a.resolved_at).length, 1);
      const critNotes = await notesOf(page, k1.caseId);
      ok("C12b · …and the reason is written onto the critical alert's case, as the per-row path does",
        critNotes.some((n) => /Watchtower alert dismissed/i.test(n.body) && /duplicate of the one Wayne/i.test(n.body)),
        JSON.stringify(critNotes.map((n) => n.body)).slice(0, 400));
      eq("C12c · zero native dialogs across the whole of §C", page.__dialogs.length, 0);

      /* ---- THE PER-ROW VERBS STILL WORK, UNCHANGED ---- */
      const soloIds = await seedAlerts(page, [{
        rule: "r72_delta", severity: "warn", case_id: k2.caseId,
        title: "R72 Delta — the offer is going stale", detail: "Nothing has moved.",
      }]);
      await goto(page, "clients", 1000);
      await openWatchtower(page);
      await page.click(`#watchtower-list button[onclick*="resolveAlert('${soloIds[0]}'"]`);
      await wait(page, 1600);
      eq("C13 · the per-row Dismiss is untouched and still resolves its own row",
        (await alertRows(page, soloIds)).filter((a) => !!a.resolved_at).length, 1);

      ok("§C · no console errors", (page.__err || []).length === errBefore, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §D · M3 — THE EMAIL QUEUE: PREVIEW + BATCH CANCEL.
       ======================================================================= */
    {
      console.log("\n— §D · M3 · email queue preview and batch cancel (p1 admin)");
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;

      const e1 = await mkCase(page, { first: "Jon", last: "R72Mail", stage: "application", assigned_to: "p2" });
      const e2 = await mkCase(page, { first: "Kay", last: "R72Mail", stage: "offer", assigned_to: "p3" });

      /* The hostile body. Every one of these is a thing that would run, fetch or navigate if the
         preview pasted the string into the page: a script, an image error handler, a javascript:
         link, and an inline style. The words around them must survive. */
      const NASTY = '<p>Dear Jon,</p>'
        + '<script>window.__r72_pwned = true;</script>'
        + '<p style="color:red" onclick="window.__r72_pwned=true">Your <strong>rate</strong> ends soon.</p>'
        + '<img src="x" onerror="window.__r72_pwned=true">'
        + '<p><a href="javascript:window.__r72_pwned=true">Click here</a> to book.</p>'
        + '<p>Kind regards,<br>NexMoney</p>';

      const ids = await seedEmails(page, [
        { case_id: e1.caseId, client_id: e1.clientId, email_type: "review_request", to_email: "jon.r72@example.com",
          subject: "R72 · How did we do?", status: "queued", body_html: NASTY },
        { case_id: e2.caseId, client_id: e2.clientId, email_type: "docs_request", to_email: "kay.r72@example.com",
          subject: "R72 · Your document checklist", status: "queued" },
        { case_id: e1.caseId, client_id: e1.clientId, email_type: "offer_update", to_email: "stale.r72@example.com",
          subject: "R72 · Your offer", status: "failed", error: "550 5.1.1 recipient address is invalid — message bounced" },
        { case_id: e2.caseId, client_id: e2.clientId, email_type: "welcome", to_email: "sent.r72@example.com",
          subject: "R72 · Welcome", status: "sent" },
      ]);
      const [qNasty, qPlain, fBounced, sSent] = ids;

      await gotoEmails(page);

      const rNasty = await emailRowState(page, qNasty);
      const rSent = await emailRowState(page, sSent);
      const rFail = await emailRowState(page, fBounced);
      ok("D1 · a QUEUED row is now selectable (it was failed-rows-only)", rNasty.hasCb && rNasty.cbStatus === "queued", JSON.stringify(rNasty));
      ok("D1b · a FAILED row still is", rFail.hasCb && rFail.cbStatus === "failed", JSON.stringify(rFail));
      ok("D1c · a SENT row is not — that decision has already been taken", !rSent.hasCb, JSON.stringify(rSent));
      ok("D2 · a queued row carries a preview fold", rNasty.hasFold && /Preview this email/i.test(rNasty.summary || ""), JSON.stringify(rNasty));
      ok("D2b · a sent row does not", !rSent.hasFold, JSON.stringify(rSent));

      // Open the fold and read what it actually rendered.
      await page.click(`#email-list details.em-fold[data-em-preview="${qNasty}"] > summary`);
      await wait(page, 600);
      const prev = await page.evaluate((i) => {
        const fold = document.querySelector(`#email-list details.em-fold[data-em-preview="${i}"]`);
        const body = fold.querySelector(".em-prev-body");
        return {
          open: fold.open,
          subject: (fold.querySelector(".em-prev-subject") || {}).textContent || "",
          text: body ? body.textContent.replace(/\s+/g, " ").trim() : "",
          html: body ? body.innerHTML : "",
          scripts: body ? body.querySelectorAll("script").length : -1,
          anchors: body ? body.querySelectorAll("a").length : -1,
          images: body ? body.querySelectorAll("img").length : -1,
          withHandlers: body ? [...body.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length : -1,
          // Every attribute on every rendered element, EXCEPT the one class the preview puts on its
          // own de-linked <span>. Nothing else may survive from the source.
          foreignAttrs: body ? [...body.querySelectorAll("*")].flatMap((el) => [...el.attributes]
            .filter((a) => !(a.name === "class" && a.value === "em-prev-link"))
            .map((a) => el.tagName + "@" + a.name)) : ["unread"],
          pwned: !!window.__r72_pwned,
        };
      }, qNasty);
      ok("D3 · the fold opens", prev.open);
      ok("D3b · the subject is shown", /R72 · How did we do\?/.test(prev.subject), prev.subject);
      ok("D4 · the words of the email survive", /Dear Jon/.test(prev.text) && /Your rate ends soon/.test(prev.text) && /Kind regards/.test(prev.text), prev.text);
      eq("D5 · NOT ONE <script> element reaches the page", prev.scripts, 0);
      eq("D5b · no <img> — nothing in a preview fetches anything", prev.images, 0);
      eq("D5c · no <a> — a preview of correspondence carries no live links", prev.anchors, 0);
      eq("D5d · no element carries an on* handler", prev.withHandlers, 0);
      eq("D5e · in fact NOT ONE attribute survives from the source — that is the whole rule", prev.foreignAttrs, []);
      ok("D5f · …so no markup from the source is left in the rendered HTML",
        !/<script/i.test(prev.html) && !/onerror/i.test(prev.html) && !/href=/i.test(prev.html) && !/style=/i.test(prev.html),
        prev.html.slice(0, 300));
      eq("D5g · and nothing in it ever executed", prev.pwned, false);
      ok("D6 · the link's own text and URL are still readable, as text",
        /Click here/.test(prev.text) && /javascript:window/.test(prev.text), prev.text);

      // A row with no stored body says so rather than showing an empty box.
      await page.click(`#email-list details.em-fold[data-em-preview="${qPlain}"] > summary`);
      await wait(page, 500);
      const prevPlain = await page.evaluate((i) => {
        const fold = document.querySelector(`#email-list details.em-fold[data-em-preview="${i}"]`);
        return {
          subject: (fold.querySelector(".em-prev-subject") || {}).textContent || "",
          hasBody: !!fold.querySelector(".em-prev-body"),
          note: (fold.querySelector(".em-prev-note") || {}).textContent || "",
        };
      }, qPlain);
      ok("D7 · a row whose wording is not written yet shows its subject", /Your document checklist/.test(prevPlain.subject), prevPlain.subject);
      ok("D7b · …and says honestly that there is nothing to show, and why", !prevPlain.hasBody && /not written yet/i.test(prevPlain.note), prevPlain.note);

      /* ---- THE BULK BAR ---- */
      await page.check(`#email-list .email-cb[data-id="${qNasty}"]`);
      await page.check(`#email-list .email-cb[data-id="${qPlain}"]`);
      await page.check(`#email-list .email-cb[data-id="${fBounced}"]`);
      await wait(page, 500);
      const bar = await page.evaluate(() => ({
        hidden: (document.querySelector("#email-bulk-bar") || {}).hidden,
        n: (document.querySelector("#email-bulk-n") || {}).textContent,
        cancel: (document.querySelector("#email-bulk-cancel") || {}).textContent,
        retry: (document.querySelector("#email-bulk-retry") || {}).textContent,
        retryDisabled: (document.querySelector("#email-bulk-retry") || {}).disabled,
        retryTitle: (document.querySelector("#email-bulk-retry") || {}).title,
      }));
      eq("D8 · the bar counts all three selected rows", bar.n, "3");
      ok("D8b · Cancel selected acts on all three", /Cancel selected \(3\)/.test(bar.cancel), bar.cancel);
      ok("D8c · Retry counts ONLY the failed one and says so", /Retry failed \(1\)/.test(bar.retry) && /already FAILED/i.test(bar.retryTitle), JSON.stringify(bar));

      /* Retry over a mixed selection must not touch the queued rows. Both queued rows are addressed
         to a stale address; retryEmail rewrites to_email to the client's CURRENT one, so an
         unchanged address is proof the row was left alone. */
      page.__dialogs.length = 0;
      await page.click("#email-bulk-retry");
      await wait(page, 2400);
      const afterRetry = await emailRows(page, [qNasty, qPlain, fBounced]);
      const byId = {}; afterRetry.forEach((r) => { byId[r.id] = r; });
      eq("D9 · Retry left the first queued row's address exactly as it was", byId[qNasty].to_email, "jon.r72@example.com");
      eq("D9b · …and the second's", byId[qPlain].to_email, "kay.r72@example.com");
      eq("D9c · …and both are still queued, not re-queued behind your back", [byId[qNasty].status, byId[qPlain].status], ["queued", "queued"]);
      ok("D9d · …while the FAILED one was re-queued to the client's current address",
        byId[fBounced].status === "queued" && byId[fBounced].to_email !== "stale.r72@example.com", JSON.stringify(byId[fBounced]).slice(0, 200));
      ok("D9e · one summary toast, naming what went back on the queue", /1 re-queued/.test(await toastText(page)), await toastText(page));
      eq("D9f · zero native dialogs", page.__dialogs.length, 0);

      /* ---- CANCEL SELECTED ---- */
      await gotoEmails(page);
      await page.check(`#email-list .email-cb[data-id="${qNasty}"]`);
      await page.check(`#email-list .email-cb[data-id="${qPlain}"]`);
      await wait(page, 500);
      page.__dialogs.length = 0;
      await page.click("#email-bulk-cancel");
      await wait(page, 1800);
      const ovM = await overlay(page);
      ok("D10 · ONE overlay confirm opens", ovM.open && ovM.hasEmCancelOk, JSON.stringify(ovM).slice(0, 220));
      eq("D10b · …and ZERO native confirm()", page.__dialogs.length, 0);
      ok("D10c · it names the count", /Cancel 2 emails/i.test(ovM.heading + " " + ovM.text), ovM.heading);
      ok("D10d · …and says a cancelled email NEVER SENDS", /never sends/i.test(ovM.text), ovM.text.slice(0, 400));
      ok("D10e · …and names the emails it will cancel", /How did we do|Review request/i.test(ovM.text) || /Document request/i.test(ovM.text), ovM.text.slice(0, 500));

      await page.click("#emcancel-ok");
      await wait(page, 2600);
      const cancelled = await emailRows(page, [qNasty, qPlain, fBounced, sSent]);
      const cById = {}; cancelled.forEach((r) => { cById[r.id] = r; });
      eq("D11 · both selected rows are cancelled", [cById[qNasty].status, cById[qPlain].status], ["cancelled", "cancelled"]);
      eq("D11b · the row that was NOT selected is untouched", cById[fBounced].status, "queued");
      eq("D11c · …and the sent one is certainly untouched", cById[sSent].status, "sent");
      const tD = await toastText(page);
      ok("D12 · the toast tallies the batch and repeats that they never send", /2 emails cancelled/.test(tD) && /never send/i.test(tD), tD);
      const mailNotes = await notesOf(page, e1.caseId);
      ok("D12b · the cancellation is written onto the case, naming who did it",
        mailNotes.some((n) => /cancelled by/i.test(n.body) && /bulk/i.test(n.body)), JSON.stringify(mailNotes.map((n) => n.body)).slice(0, 400));
      const barGone = await page.evaluate(() => ({
        hidden: (document.querySelector("#email-bulk-bar") || {}).hidden,
        checked: [...document.querySelectorAll("#email-list .email-cb")].filter((c) => c.checked).length,
      }));
      eq("D13 · the selection is cleared afterwards", barGone.checked, 0);
      ok("D13b · …and the bar is hidden again", barGone.hidden === true, JSON.stringify(barGone));
      ok("D13c · a cancelled row is no longer selectable", !(await emailRowState(page, qNasty)).hasCb);

      /* ---- FAILED-ONLY RETRY IS UNCHANGED ---- */
      const f2 = await seedEmails(page, [{
        case_id: e2.caseId, client_id: e2.clientId, email_type: "docs_request", to_email: "old.r72@example.com",
        subject: "R72 · retry me", status: "failed", error: "Temporary send failure, try later",
      }]);
      await gotoEmails(page);
      await page.check(`#email-list .email-cb[data-id="${f2[0]}"]`);
      await wait(page, 400);
      const retryOnly = await page.evaluate(() => ({
        retry: (document.querySelector("#email-bulk-retry") || {}).textContent,
        disabled: (document.querySelector("#email-bulk-retry") || {}).disabled,
      }));
      ok("D14 · a failed-only selection enables Retry and counts it whole", /Retry failed \(1\)/.test(retryOnly.retry) && retryOnly.disabled === false, JSON.stringify(retryOnly));
      await page.click("#email-bulk-retry");
      await wait(page, 2200);
      eq("D14b · …and it re-queues, exactly as it always did", (await emailRows(page, f2))[0].status, "queued");

      ok("§D · no console errors", (page.__err || []).length === errBefore, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §E · B4 — DIP JOINS THE BULK-CHECKLIST VERB (owner decision, 28 Aug).
       ======================================================================= */
    {
      console.log("\n— §E · B4 · a Decision-in-Principle case now gets a checklist; Enquiry still does not (p1)");
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const docsList = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("value").eq("key", "docs_list").maybeSingle();
        return (data && data.value) || "";
      });
      ok("E0 · fixture — the firm's document list is not empty", docsList.length > 0, docsList.slice(0, 60));

      const dip = await mkCase(page, { first: "Lea", last: "R72Dip", stage: "decision_in_principle", case_kind: "purchase", assigned_to: "p2" });
      const enq = await mkCase(page, { first: "Moe", last: "R72Dip", stage: "enquiry", case_kind: "purchase", assigned_to: "p2" });

      await pipelineTable(page, "R72Dip");
      eq("E0b · both seeded cases are selectable", await tickRows(page, [dip.caseId, enq.caseId]), 2);
      page.__dialogs.length = 0;
      await page.click("#pipe-bulk-checklists");
      await wait(page, 2400);
      const ovF = await overlay(page);
      ok("E1 · ONE overlay confirm opens", ovF.open && ovF.hasDocsOk, JSON.stringify(ovF).slice(0, 200));
      eq("E1b · …and zero native dialogs", page.__dialogs.length, 0);
      ok("E2 · the DIP case is named as one it will BUILD on", /Lea/.test(ovF.text) && /Decision in Principle/i.test(ovF.text), ovF.text.slice(0, 700));
      ok("E2b · …and the confirm says the verb applies from Decision in Principle onwards",
        /from Decision in Principle onwards/i.test(ovF.text), ovF.text.slice(0, 700));
      ok("E3 · the Enquiry case is still named and skipped as premature",
        /Moe/.test(ovF.text) && /premature/i.test(ovF.text), ovF.text.slice(0, 900));

      await page.click("#bulkdocs-ok");
      await wait(page, 2800);
      const expDip = docSuggested(docsList, "purchase");
      eq("E4 · the DIP case gets exactly the firm's list narrowed to a purchase",
        (await docsOf(page, dip.caseId)).map((d) => d.item).sort(), [...expDip].sort());
      eq("E4b · every row created as outstanding", [...new Set((await docsOf(page, dip.caseId)).map((d) => d.status))], ["requested"]);
      eq("E5 · the Enquiry case got nothing", (await docsOf(page, enq.caseId)).length, 0);
      const mails = await page.evaluate(async (i) =>
        (await window.__mockDb.from("email_queue").select("id").in("case_id", i)).data || [], [dip.caseId, enq.caseId]);
      eq("E6 · and NOT ONE email was queued by it", mails.length, 0);
      const tE = await toastText(page);
      ok("E7 · the toast tallies one checklist built and one skipped",
        /1 checklist built/i.test(tE) && /1 skipped/i.test(tE) && /nothing emailed/i.test(tE), tE);

      ok("§E · no console errors", (page.__err || []).length === errBefore, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §F · every persona this round touches, clean.
       ======================================================================= */
    {
      console.log("\n— §F · no console errors on p2, p3, p4 across the touched screens");
      for (const persona of ["p2", "p3", "p4"]) {
        const page = await newPage(browser, persona);
        for (const p of ["dashboard", "pipeline", "emails", "diary"]) await goto(page, p, 1500);
        ok(`F · ${persona}: no console errors across Today, Pipeline, Emails and Diary`, !page.__err, JSON.stringify(page.__err));
        await page.close();
      }
    }

  } catch (e) {
    failures.push("EXCEPTION: " + (e && e.stack ? e.stack : e));
    console.log("  ✗ EXCEPTION", e);
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log(`\nR72 ADMIN: ${pass} checks, ${failures.length} failures`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
