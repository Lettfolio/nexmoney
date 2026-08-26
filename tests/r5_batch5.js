#!/usr/bin/env node
/* =============================================================================
   tests/r5_batch5.js — acceptance tests for PLAN-R5 Batch 5
   ("Pipeline bulk verbs & leaver handover")

   One block per plan item:
     1. S3a   bulk "Queue rate-end reminders" on the pipeline table: eligible cases get a
              queued email + a stamped rate_reminder_queued_at + a follow-up task; cases with
              no client email or no rate-end date are named in the confirm and skipped;
              NOTHING is sent (process-emails is never called — R5-1 discipline).
     2. S3b   bulk "Add task…": one title + due date → one task per selected case, each landing
              on THAT case's adviser (or the operator where the case is unassigned).
     3. S3c   bulk protection status on the Protection page: checkbox column + bulk bar, one
              "Set status →" action applying the ordinary protection_status write per row,
              with a count confirm, and the KPI tiles refreshed afterwards.
     4. R5-2  handover leaves history alone: deactivating an adviser moves only LIVE cases,
              OPEN tasks and FUTURE appointments; completed/closed cases, done tasks and past
              appointments stay attributed to the leaver, whose row still renders in the month
              report (renderMonthReport now iterates PROFILES, not TEAM).

   Run:  node /root/nx/tests/r5_batch5.js  (expects a static server on 8099;
                                            starts one itself if absent)
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
  page.__dialogPlan = [];
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    const next = page.__dialogPlan.length ? page.__dialogPlan.shift() : page.__dialogAnswer;
    if (next && typeof next === "object") { if (next.type === "dismiss") await d.dismiss(); else await d.accept(next.text); }
    else if (next === "dismiss") await d.dismiss();
    else await d.accept(typeof next === "string" ? next : undefined);
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const lastDialog = (page, re) => (page.__dialogs.filter((d) => re.test(d.message)).slice(-1)[0] || {}).message || "";

// Pipeline in table view, "All" segment — every seeded case is then selectable.
async function pipelineTable(page) {
  await page.click('[data-page="pipeline"]');
  await page.waitForTimeout(800);
  const isBoard = await page.evaluate(() => !document.querySelector("#board").classList.contains("hidden"));
  if (isBoard) { await page.click("#view-toggle"); await page.waitForTimeout(800); }
  const seg = await page.$('.seg-btn[data-seg="all"]');
  if (seg) { await seg.click(); await page.waitForTimeout(800); }
  const stillBoard = await page.evaluate(() => !document.querySelector("#board").classList.contains("hidden"));
  if (stillBoard) { await page.click("#view-toggle"); await page.waitForTimeout(800); }
}
// Count every call the page makes to the process-emails edge function from now on.
async function spySends(page) {
  await page.evaluate(() => {
    window.__sendCalls = [];
    if (!window.__origFetch) window.__origFetch = window.fetch;
    window.fetch = function (url, opts) {
      if (String(url).indexOf("process-emails") >= 0) window.__sendCalls.push({ url: String(url), body: opts && opts.body });
      return window.__origFetch.apply(this, arguments);
    };
  });
}
const sendCalls = (page) => page.evaluate(() => window.__sendCalls || []);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore", detached: true });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       1 · S3a — bulk "Queue rate-end reminders" (pipeline table)
       =================================================================== */
    console.log("\n— S3a · bulk Queue rate-end reminders (p4 Daniel, owner)");
    {
      const page = await newPage(browser, "p4");
      await pipelineTable(page);

      /* Fixture: four live cases with a client email AND a rate end date, plus one with no email.
         R64 · M5 — CONTRACT CHANGE, and the fixture moved rather than the assertions. Eligibility
         for this sweep is no longer "has an email and a rate-end date": a rate ending more than
         274 days out is now named in the confirm under its own ⚠ block and deliberately NOT
         queued, because a select-all on this table was queueing client emails about rates ending
         in 2031 (two of the four cases this line used to pick are Offer/Exchange cases carrying
         the NEW mortgage's five-year fix — 59 months out). So the picker asks for four cases that
         are genuinely due, which is what every assertion below was always about; nothing here is
         weakened, and the new behaviour has its own coverage in tests/r64_small.js §A. */
      const fix = await page.evaluate(async () => {
        const ids = [...document.querySelectorAll("#pipe-table .bulk-cb")].map((cb) => cb.dataset.id);
        const { data } = await window.__mockDb.from("cases").select("id,stage,rate_end_date,assigned_to,rate_reminder_queued_at,clients!client_id(first_name,email)").in("id", ids);
        const live = (data || []).filter((c) => ["completed", "not_proceeding"].indexOf(c.stage) === -1);
        const today = new Date(new Date().toISOString().slice(0, 10) + "T12:00:00").getTime();
        const dueSoon = (c) => Math.round((new Date(c.rate_end_date + "T12:00:00").getTime() - today) / 86400000) <= 274;
        const good = live.filter((c) => c.clients && c.clients.email && c.rate_end_date && !c.rate_reminder_queued_at && dueSoon(c)).slice(0, 4);
        const noEmail = live.filter((c) => !(c.clients && c.clients.email))[0];
        return {
          good: good.map((c) => c.id), goodAdvisers: good.map((c) => c.assigned_to),
          noEmail: noEmail && noEmail.id,
          noEmailName: noEmail && noEmail.clients ? noEmail.clients.first_name : null,
        };
      });
      eq("fixture · four eligible cases (client email + rate end date) are on screen", fix.good.length, 4);
      ok("fixture · one selectable case has no client email", !!fix.noEmail, JSON.stringify(fix));

      const picked = fix.good.concat([fix.noEmail]);
      const before = await page.evaluate(async (ids) => {
        const { data: q } = await window.__mockDb.from("email_queue").select("id,case_id,status,email_type");
        const { data: t } = await window.__mockDb.from("case_tasks").select("id,case_id,title,due_date,assigned_to");
        return { ids: q.map((r) => r.id), sent: q.filter((r) => r.status === "sent").length, tasks: t.length };
      }, picked);

      await spySends(page);
      for (const id of picked) await page.check(`#pipe-table .bulk-cb[data-id="${id}"]`);
      eq("S3a · the bulk bar counts the five selected rows", await page.evaluate(() => document.querySelector("#pipe-bulk-n").textContent), "5");
      ok("S3a · the pipeline bulk bar offers 'Queue rate-end reminders'", await page.evaluate(() => !!document.querySelector("#pipe-bulk-rate")));

      page.__dialogs = [];
      await page.click("#pipe-bulk-rate");
      await page.waitForTimeout(1800);

      const msg = lastDialog(page, /Queue \d+ rate-end reminder/);
      ok("S3a · the confirm counts the reminders it will queue", /Queue 4 rate-end reminders\?/.test(msg), JSON.stringify(msg));
      ok("S3a · …names the skipped rows and why", /1 skipped: no email\/no rate-end date/.test(msg) && /Skipped: .*\(no email\)/.test(msg), JSON.stringify(msg));
      ok("S3a · …says plainly that nothing is sent now", /send with the next automation run — nothing is sent now/.test(msg), JSON.stringify(msg));
      ok("S3a · …warns that each one leaves a follow-up task behind", /follow-up task due /.test(msg), JSON.stringify(msg));

      const after = await page.evaluate(async (arg) => {
        const ids = arg.ids, known = arg.known;
        const { data: q } = await window.__mockDb.from("email_queue").select("id,case_id,status,email_type,to_email");
        const { data: t } = await window.__mockDb.from("case_tasks").select("id,case_id,title,due_date,assigned_to");
        const { data: c } = await window.__mockDb.from("cases").select("id,rate_reminder_queued_at,assigned_to").in("id", ids);
        // Only rows this action created — a couple of these cases already had a seeded reminder row.
        const mine = q.filter((r) => known.indexOf(r.id) === -1 && r.email_type === "rate_end_reminder");
        const myTasks = t.filter((x) => ids.indexOf(x.case_id) >= 0 && /^Follow up rate-end reminder — /.test(x.title));
        return {
          queue: q.length, sent: q.filter((r) => r.status === "sent").length,
          newRows: mine.map((r) => ({ case_id: r.case_id, status: r.status, to: r.to_email })),
          tasks: myTasks.map((x) => ({ case_id: x.case_id, due: x.due_date, assigned_to: x.assigned_to })),
          stamped: (c || []).filter((x) => x.rate_reminder_queued_at).map((x) => x.id),
          advisers: Object.fromEntries((c || []).map((x) => [x.id, x.assigned_to])),
        };
      }, { ids: picked, known: before.ids });

      eq("S3a · exactly four email_queue rows were created", after.newRows.length, 4);
      ok("S3a · …one per eligible case, and none for the no-email case",
        fix.good.every((id) => after.newRows.some((r) => r.case_id === id)) && !after.newRows.some((r) => r.case_id === fix.noEmail),
        JSON.stringify(after.newRows));
      ok("S3a · every new row is QUEUED, not sent", after.newRows.every((r) => r.status === "queued"), JSON.stringify(after.newRows));
      eq("S3a · the firm's sent count is unchanged — nothing went out", after.sent, before.sent);
      eq("S3a · process-emails was never called (R5-1: a bulk queue is not a send)", (await sendCalls(page)).length, 0);
      eq("S3a · four follow-up tasks were created", after.tasks.length, 4);
      ok("S3a · each follow-up task is due in a week", after.tasks.every((t) => {
        const d = new Date(t.due + "T12:00:00"); const now = new Date();
        return Math.round((d - now) / 86400000) >= 6 && Math.round((d - now) / 86400000) <= 8;
      }), JSON.stringify(after.tasks));
      ok("S3a · each follow-up task lands on that case's adviser",
        after.tasks.every((t) => t.assigned_to === after.advisers[t.case_id] || (!after.advisers[t.case_id] && !!t.assigned_to)),
        JSON.stringify({ tasks: after.tasks, advisers: after.advisers }));
      ok("S3a · every queued case is stamped rate_reminder_queued_at (the My Day nag retires)",
        fix.good.every((id) => after.stamped.indexOf(id) >= 0) && after.stamped.indexOf(fix.noEmail) === -1,
        JSON.stringify(after.stamped));
      eq("S3a · the selection is cleared afterwards", await page.evaluate(() => document.querySelector("#pipe-bulk-bar").hidden), true);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));

      // Backing out of the confirm writes nothing at all.
      const snapshot = await page.evaluate(async () => {
        const { data: q } = await window.__mockDb.from("email_queue").select("id");
        const { data: t } = await window.__mockDb.from("case_tasks").select("id");
        return { q: q.length, t: t.length };
      });
      await page.check(`#pipe-table .bulk-cb[data-id="${fix.good[0]}"]`);
      page.__dialogPlan = ["dismiss"];
      await page.click("#pipe-bulk-rate");
      await page.waitForTimeout(1000);
      const afterCancel = await page.evaluate(async () => {
        const { data: q } = await window.__mockDb.from("email_queue").select("id");
        const { data: t } = await window.__mockDb.from("case_tasks").select("id");
        return { q: q.length, t: t.length };
      });
      eq("S3a · cancelling the confirm writes nothing", afterCancel, snapshot);
      await page.close();
    }

    /* ===================================================================
       2 · S3b — bulk "Add task…" (pipeline table)
       =================================================================== */
    console.log("\n— S3b · bulk Add task… (p1 Kim, admin)");
    {
      const page = await newPage(browser, "p1");
      await pipelineTable(page);
      const picked = await page.evaluate(() => [...document.querySelectorAll("#pipe-table .bulk-cb")].slice(0, 8).map((cb) => cb.dataset.id));
      eq("fixture · eight cases selected", picked.length, 8);
      for (const id of picked) await page.check(`#pipe-table .bulk-cb[data-id="${id}"]`);

      ok("S3b · the bulk bar offers 'Add task…'", await page.evaluate(() => !!document.querySelector("#pipe-bulk-task")));
      await page.click("#pipe-bulk-task");
      await page.waitForTimeout(500);
      ok("S3b · a title/due-date overlay opens over the table", await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden")));
      ok("S3b · the overlay names the number of cases it will touch", await page.evaluate(() => /Add a task to 8 cases/.test(document.querySelector("#overlay-modal").textContent)));

      // A title is required.
      await page.click("#btask-ok");
      ok("S3b · an empty title is refused", await page.evaluate(() =>
        !document.querySelector("#overlay-backdrop").classList.contains("hidden") && /Give the task a title/.test(document.querySelector("#btask-err").textContent)));

      await page.fill("#btask-title", "Chase the solicitor");
      await page.click("#overlay-modal .btask-chip[data-days='3']");
      const dueWanted = await page.evaluate(() => document.querySelector("#btask-due").value);
      await page.click("#btask-ok");
      await page.waitForTimeout(1600);

      const res = await page.evaluate(async (ids) => {
        const { data: t } = await window.__mockDb.from("case_tasks").select("id,case_id,title,due_date,assigned_to,created_by");
        const { data: c } = await window.__mockDb.from("cases").select("id,assigned_to").in("id", ids);
        const mine = t.filter((x) => x.title === "Chase the solicitor");
        const adv = Object.fromEntries((c || []).map((x) => [x.id, x.assigned_to]));
        return {
          n: mine.length,
          cases: mine.map((x) => x.case_id).sort(),
          dues: [...new Set(mine.map((x) => x.due_date))],
          rightOwner: mine.every((x) => x.assigned_to === (adv[x.case_id] || "p1")),
          creator: [...new Set(mine.map((x) => x.created_by))],
        };
      }, picked);
      eq("S3b · eight tasks created — one per selected case", res.n, 8);
      eq("S3b · one per case, no duplicates and no strays", res.cases, picked.slice().sort());
      eq("S3b · all share the chosen due date (+3 days)", res.dues, [dueWanted]);
      ok("S3b · each task sits with its own case's adviser (not with whoever ran the batch)", res.rightOwner, JSON.stringify(res));
      eq("S3b · created_by records who ran the batch", res.creator, ["p1"]);
      eq("S3b · the selection is cleared afterwards", await page.evaluate(() => document.querySelector("#pipe-bulk-bar").hidden), true);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       3 · S3c — bulk protection status (Protection page)
       =================================================================== */
    console.log("\n— S3c · bulk protection status (p4 Daniel, owner)");
    {
      const page = await newPage(browser, "p4");
      await page.click('[data-page="protection"]');
      await page.waitForTimeout(900);
      await page.click("#prot-scope-all");
      await page.waitForTimeout(700);
      await page.selectOption("#prot-filter", "quoted");
      await page.waitForTimeout(900);

      ok("S3c · the Protection table gained a checkbox column", await page.evaluate(() => !!document.querySelector("#prot-list-table th.bulk-col") && document.querySelectorAll("#prot-list-table .prot-cb").length > 0));
      const quotedBefore = await page.evaluate(() => Number(document.querySelector("#prot-kpi-quoted").textContent));
      ok("fixture · at least six quoted opportunities are on screen", quotedBefore >= 6, String(quotedBefore));

      const picked = await page.evaluate(() => [...document.querySelectorAll("#prot-list-table .prot-cb")].slice(0, 6).map((cb) => cb.dataset.id));
      eq("fixture · six quoted rows selected", picked.length, 6);
      for (const id of picked) await page.check(`#prot-list-table .prot-cb[data-id="${id}"]`);
      eq("S3c · the bulk bar appears with the count", await page.evaluate(() => ({ hidden: document.querySelector("#prot-bulk-bar").hidden, n: document.querySelector("#prot-bulk-n").textContent })), { hidden: false, n: "6" });

      page.__dialogs = [];
      /* R37 · non-masking repair — R7-3's requirement ("policy taken" needs a commission figure)
         is unchanged; only its capture UI moved off prompt() onto R37's own second-layer overlay
         (askProtectionCommission → #prot-comm-box, see admin/app.js). The two facts this block was
         checking — the overlay/prompt names the count it will apply the figure to, and the confirm
         that follows still names the status/count/commission — are both still true, just reached by
         filling #prot-comm-input and clicking #prot-comm-save instead of answering a JS prompt. The
         downstream confirm() dialog is untouched by R37 (bulkSetProtStatus still calls confirm()
         after the overlay resolves), so page.__dialogPlan still drives THAT one. */
      page.__dialogPlan = [];        // only the confirm() after the overlay remains a real dialog — default-accept it
      await page.selectOption("#prot-bulk-status", "policy_taken");
      await page.waitForTimeout(600);
      const overlayCtx = await page.$eval("#prot-comm-box", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("S3c · a bulk 'policy taken' asks for the commission before anything is written",
        /Policy taken/.test(overlayCtx), overlayCtx);
      ok("S3c · …and warns that ONE figure will be written to all six",
        /written to ALL 6 selected cases/.test(overlayCtx), overlayCtx);
      await page.fill("#prot-comm-input", "1250");
      await page.click("#prot-comm-save");
      await page.waitForTimeout(1000);
      const msg = lastDialog(page, /Set protection status/);
      ok("S3c · the confirm names the status and the count", /Set protection status to "Policy taken" on 6 cases\?/.test(msg), JSON.stringify(msg));
      ok("S3c · …and names the commission it is about to record on every one of them", /Commission £1,250 will be recorded on every one of them/.test(msg), JSON.stringify(msg));

      const res = await page.evaluate(async (ids) => {
        const { data } = await window.__mockDb.from("cases").select("id,protection_status,protection_commission").in("id", ids);
        return { statuses: (data || []).map((c) => c.protection_status), commissions: (data || []).map((c) => c.protection_commission), n: (data || []).length };
      }, picked);
      eq("S3c · all six cases were updated", res.statuses, new Array(6).fill("policy_taken"));
      eq("S3c · …each carrying the commission that was typed", res.commissions, new Array(6).fill(1250));
      const quotedAfter = await page.evaluate(() => Number(document.querySelector("#prot-kpi-quoted").textContent));
      eq("S3c · the KPI tiles refresh — six fewer quoted", quotedAfter, quotedBefore - 6);
      eq("S3c · the selection is cleared afterwards", await page.evaluate(() => document.querySelector("#prot-bulk-bar") ? document.querySelector("#prot-bulk-bar").hidden : true), true);

      // Backing out changes nothing.
      await page.selectOption("#prot-filter", "all");
      await page.waitForTimeout(800);
      const one = await page.evaluate(() => (document.querySelector("#prot-list-table .prot-cb") || {}).dataset.id);
      const wasStatus = await page.evaluate(async (id) => (await window.__mockDb.from("cases").select("protection_status").eq("id", id).single()).data.protection_status, one);
      await page.check(`#prot-list-table .prot-cb[data-id="${one}"]`);
      page.__dialogPlan = ["dismiss"];
      await page.selectOption("#prot-bulk-status", "declined");
      await page.waitForTimeout(900);
      eq("S3c · cancelling the confirm changes nothing",
        await page.evaluate(async (id) => (await window.__mockDb.from("cases").select("protection_status").eq("id", id).single()).data.protection_status, one), wasStatus);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       4 · R5-2 — handover leaves history alone
       =================================================================== */
    console.log("\n— R5-2 · deactivating Luke (p3) hands over live work only (p4 Daniel, owner)");
    {
      const page = await newPage(browser, "p4");

      const before = await page.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases").select("id,stage,assigned_to,completed_at,submitted_at");
        const { data: tasks } = await window.__mockDb.from("case_tasks").select("id,assigned_to,done_at");
        const { data: appts } = await window.__mockDb.from("appointments").select("id,staff_id,starts_at");
        const now = new Date().toISOString();
        return {
          liveCases: cases.filter((c) => c.assigned_to === "p3" && ["completed", "not_proceeding"].indexOf(c.stage) === -1).map((c) => c.id).sort(),
          closedCases: cases.filter((c) => c.assigned_to === "p3" && ["completed", "not_proceeding"].indexOf(c.stage) >= 0).map((c) => c.id).sort(),
          openTasks: tasks.filter((t) => t.assigned_to === "p3" && !t.done_at).map((t) => t.id).sort(),
          doneTasks: tasks.filter((t) => t.assigned_to === "p3" && t.done_at).map((t) => t.id).sort(),
          futureAppts: appts.filter((a) => a.staff_id === "p3" && a.starts_at >= now).map((a) => a.id).sort(),
          pastAppts: appts.filter((a) => a.staff_id === "p3" && a.starts_at < now).map((a) => a.id).sort(),
        };
      });
      ok("fixture · Luke holds live cases, closed cases, open tasks and done tasks",
        before.liveCases.length > 0 && before.closedCases.length > 0 && before.openTasks.length > 0 && before.doneTasks.length > 0,
        JSON.stringify(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length]))));

      // The month report BEFORE the handover: May 2026 (a month whose activity for Luke is entirely
      // historical) and June 2026 (which also contains still-live submissions).
      await page.click('[data-page="reports"]');
      await page.waitForTimeout(1600);
      const monthTable = async (m) => {
        await page.evaluate((mv) => { const el = document.querySelector("#report-month"); el.value = mv; el.dispatchEvent(new Event("change", { bubbles: true })); }, m);
        await page.waitForTimeout(1200);
        return page.evaluate(() => document.querySelector("#month-advisers").innerHTML);
      };
      const may26Before = await monthTable("2026-05");
      const jun26Before = await monthTable("2026-06");
      ok("fixture · Luke has a row in the May 2026 month report", /Luke Richards/.test(may26Before), may26Before.slice(0, 200));
      ok("fixture · …and in June 2026", /Luke Richards/.test(jun26Before));

      // Now the handover: Settings → roster → Luke → No access → reassign to Wayne.
      await page.click('[data-page="settings"]');
      await page.waitForTimeout(1200);
      await page.selectOption('#team-roster select.team-role[data-id="p3"]', "none");
      await page.waitForTimeout(1400);
      ok("R5-2 · the deactivate panel opens rather than removing access outright",
        await page.evaluate(() => !document.querySelector('#team-roster [data-deact="p3"]').classList.contains("hidden")));
      const scopeLine = await page.evaluate(() => (document.querySelector("#deact-scope") || {}).textContent || "");
      ok("R5-2 · the panel states that only live work moves", /Handing over moves/.test(scopeLine) && /live case/.test(scopeLine), JSON.stringify(scopeLine));
      ok("R5-2 · …and that completed cases stay with the leaver for reporting",
        /Completed and closed cases stay attributed to Luke Richards for reporting/.test(scopeLine), JSON.stringify(scopeLine));

      await page.selectOption("#deact-to", "p2");
      page.__dialogs = [];
      await page.click("#deact-reassign");
      await page.waitForTimeout(2200);
      const confirmMsg = lastDialog(page, /Move .* from Luke Richards to Wayne Kellow/);
      ok("R5-2 · the confirm counts LIVE cases, open tasks and future appointments",
        new RegExp(`Move ${before.liveCases.length} live cases · ${before.openTasks.length} open tasks · ${before.futureAppts.length} future appointment`).test(confirmMsg), JSON.stringify(confirmMsg));
      ok("R5-2 · …and says completed/closed cases stay with the leaver",
        /Completed and closed cases stay attributed to Luke Richards for reporting/.test(confirmMsg), JSON.stringify(confirmMsg));

      const after = await page.evaluate(async (b) => {
        const { data: cases } = await window.__mockDb.from("cases").select("id,stage,assigned_to");
        const { data: tasks } = await window.__mockDb.from("case_tasks").select("id,assigned_to,done_at");
        const { data: appts } = await window.__mockDb.from("appointments").select("id,staff_id");
        const { data: prof } = await window.__mockDb.from("profiles").select("id,role").eq("id", "p3").single();
        const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
        const tById = Object.fromEntries(tasks.map((t) => [t.id, t]));
        const aById = Object.fromEntries(appts.map((a) => [a.id, a]));
        return {
          role: prof.role,
          liveNowWayne: b.liveCases.every((id) => byId[id].assigned_to === "p2"),
          closedStillLuke: b.closedCases.filter((id) => byId[id].assigned_to === "p3").length,
          closedTotal: b.closedCases.length,
          openTasksMoved: b.openTasks.every((id) => tById[id].assigned_to === "p2"),
          doneTasksStillLuke: b.doneTasks.every((id) => tById[id].assigned_to === "p3"),
          futureApptsMoved: b.futureAppts.every((id) => aById[id].staff_id === "p2"),
          pastApptsStillLuke: b.pastAppts.every((id) => aById[id].staff_id === "p3"),
          roleMsg: (document.querySelector("#team-role-msg") || {}).textContent || "",
        };
      }, before);
      eq("R5-2 · Luke's access is removed", after.role, "none");
      ok("R5-2 · his LIVE cases are now Wayne's", after.liveNowWayne);
      eq("R5-2 · his completed/closed cases are ALL still his", after.closedStillLuke, after.closedTotal);
      ok("R5-2 · his open tasks moved to Wayne", after.openTasksMoved);
      ok("R5-2 · his DONE tasks were left alone", after.doneTasksStillLuke);
      ok("R5-2 · his future appointments moved to Wayne", after.futureApptsMoved);
      ok("R5-2 · his past appointments were left alone", after.pastApptsStillLuke);
      /* R5-M6 — the harness now mocks reassign_holdings(), so the deployed app's RPC-FIRST branch
         is the one that ran. It reports the RPC's own tally with the words "in one transaction",
         which the compensating client-side path never says. The counts in that sentence must be
         the tally the transaction actually moved, not the pre-flight estimate. */
      ok("R5-2 · the handover went through the atomic RPC, and says so",
        /in one transaction/.test(after.roleMsg), JSON.stringify(after.roleMsg));
      ok("R5-2 · … and the sentence counts what the transaction really moved",
        new RegExp(`${before.liveCases.length} live cases · ${before.openTasks.length} open tasks · ${before.futureAppts.length} future appointment`).test(after.roleMsg),
        JSON.stringify({ msg: after.roleMsg, want: { live: before.liveCases.length, tasks: before.openTasks.length, appts: before.futureAppts.length } }));

      // The report a month later must read the same as it did before he left.
      await page.click('[data-page="reports"]');
      await page.waitForTimeout(1600);
      const may26After = await monthTable("2026-05");
      const jun26After = await monthTable("2026-06");
      eq("R5-2 · the May 2026 month report is byte-identical before and after the handover", may26After === may26Before, true);
      ok("R5-2 · Luke's row survives in June 2026 too (renderMonthReport iterates PROFILES, not TEAM)", /Luke Richards/.test(jun26After), jun26After.slice(0, 300));
      /* The two cells this cares about are located BY HEADER, not by counting in from the end:
         Batch 6 appended a previous-month column pair to this table, and a position-based
         assertion silently starts checking a different column the moment one is added. Cell
         markup is read attribute-tolerantly for the same reason. The property under test is
         unchanged: Luke's June completions and Completed £ must survive the handover. */
      const junCompletions = (html) => {
        const heads = (html.match(/<th[^>]*>([\s\S]*?)<\/th>/g) || []).map((h) => h.replace(/<[^>]*>/g, "").trim());
        const m = /<tr><td[^>]*><strong>Luke Richards<\/strong><\/td>([\s\S]*?)<\/tr>/.exec(html);
        if (!m || !heads.length) return null;
        const cells = ["Luke Richards"].concat((m[1].match(/<td[^>]*>[\s\S]*?<\/td>/g) || [])
          .map((x) => x.replace(/<[^>]*>/g, "").trim()));
        const out = ["Completed", "Completed £ (earned)"].map((w) => {
          const i = heads.indexOf(w);
          return i >= 0 ? cells[i] : null;
        });
        return out.some((v) => v == null) ? null : out.join("|");
      };
      ok("R5-2 · his June completions/fees columns are unchanged (only live work moved)",
        (() => {
          const b = junCompletions(jun26Before), a = junCompletions(jun26After);
          return !!b && !!a && b === a;
        })(), JSON.stringify({ before: junCompletions(jun26Before), after: junCompletions(jun26After) }));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* A leaver whose only remaining holdings are completed cases has nothing to hand over — the
       reassign control would be a no-op, so it is not offered. */
    console.log("\n— R5-2 · nothing live to hand over (p4 Daniel, owner)");
    {
      const page = await newPage(browser, "p4");
      // Park every live case / open task / future appointment of Wayne's on Daniel, leaving Wayne
      // with completed cases only.
      await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cases } = await db.from("cases").select("id,stage").eq("assigned_to", "p2");
        for (const c of cases.filter((x) => ["completed", "not_proceeding"].indexOf(x.stage) === -1)) {
          await db.from("cases").update({ assigned_to: "p4" }).eq("id", c.id);
        }
        await db.from("case_tasks").update({ assigned_to: "p4" }).eq("assigned_to", "p2").is("done_at", null);
        await db.from("appointments").update({ staff_id: "p4" }).eq("staff_id", "p2").gte("starts_at", new Date().toISOString());
      });
      await page.click('[data-page="settings"]');
      await page.waitForTimeout(1200);
      await page.selectOption('#team-roster select.team-role[data-id="p2"]', "none");
      await page.waitForTimeout(1400);
      const txt = await page.evaluate(() => document.querySelector('#team-roster [data-deact="p2"]').textContent);
      ok("R5-2 · the panel still reports the completed cases he holds", /still holds/.test(txt) && /0 still live/.test(txt), JSON.stringify(txt.slice(0, 220)));
      ok("R5-2 · …says there is nothing live to hand over", /nothing live to hand over/.test(txt), JSON.stringify(txt.slice(0, 300)));
      eq("R5-2 · …and offers no reassign control that would do nothing",
        await page.evaluate(() => ({ btn: !!document.querySelector("#deact-reassign"), sel: !!document.querySelector("#deact-to") })), { btn: false, sel: false });
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       R5-M6 · the same handover on a database that has NOT taken the
       migration. reassign_holdings() comes back 42883, isMissingFunctionError()
       recognises it, and the compensating client-side path runs instead —
       same three scopes, same outcome, just not in one transaction. The
       fallback existing is the whole point of calling the RPC first.
       =================================================================== */
    console.log("\n— R5-M6 · older database (m6 off): the handover falls back and still moves the work");
    {
      const page = await newPage(browser, "p4");
      const before = await page.evaluate(async () => {
        window.__mock.setMigrations({ m6: false });
        const probe = await window.__mockDb.rpc("reassign_holdings", { p_from: "p3", p_to: "p2" });
        const db = window.__mockDb;
        const nowIso = new Date().toISOString();
        const { data: cases } = await db.from("cases").select("id,stage,assigned_to");
        const { data: tasks } = await db.from("case_tasks").select("id,assigned_to,done_at");
        const { data: appts } = await db.from("appointments").select("id,staff_id,starts_at");
        return {
          rpcCode: probe.error && probe.error.code,
          live: cases.filter((c) => c.assigned_to === "p3" && ["completed", "not_proceeding"].indexOf(c.stage) === -1).map((c) => c.id),
          closed: cases.filter((c) => c.assigned_to === "p3" && ["completed", "not_proceeding"].indexOf(c.stage) >= 0).map((c) => c.id),
          openTasks: tasks.filter((t) => t.assigned_to === "p3" && !t.done_at).map((t) => t.id),
          futureAppts: appts.filter((a) => a.staff_id === "p3" && a.starts_at >= nowIso).map((a) => a.id),
        };
      });
      eq("R5-M6 · the function really is missing on this database (42883)", before.rpcCode, "42883");
      ok("fixture · and the probe moved nothing (a missing function cannot have side effects)",
        before.live.length > 0, JSON.stringify({ live: before.live.length }));

      await page.click('[data-page="settings"]');
      await page.waitForTimeout(1200);
      await page.selectOption('#team-roster select.team-role[data-id="p3"]', "none");
      await page.waitForTimeout(1400);
      await page.selectOption("#deact-to", "p2");
      page.__dialogs = [];
      await page.click("#deact-reassign");
      await page.waitForTimeout(2400);

      const after = await page.evaluate(async (b) => {
        const db = window.__mockDb;
        const { data: cases } = await db.from("cases").select("id,assigned_to");
        const { data: tasks } = await db.from("case_tasks").select("id,assigned_to");
        const { data: appts } = await db.from("appointments").select("id,staff_id");
        const byId = Object.fromEntries(cases.map((c) => [c.id, c.assigned_to]));
        const tById = Object.fromEntries(tasks.map((t) => [t.id, t.assigned_to]));
        const aById = Object.fromEntries(appts.map((a) => [a.id, a.staff_id]));
        const { data: prof } = await db.from("profiles").select("id,role").eq("id", "p3").single();
        window.__mock.setMigrations({ m6: true });
        return {
          role: prof.role,
          liveMoved: b.live.every((id) => byId[id] === "p2"),
          closedKept: b.closed.every((id) => byId[id] === "p3"),
          tasksMoved: b.openTasks.every((id) => tById[id] === "p2"),
          apptsMoved: b.futureAppts.every((id) => aById[id] === "p2"),
          roleMsg: (document.querySelector("#team-role-msg") || {}).textContent || "",
        };
      }, before);
      eq("R5-M6 · the leaver's access is still removed", after.role, "none");
      ok("R5-M6 · the fallback moved the live cases", after.liveMoved);
      ok("R5-M6 · … and left the completed/closed ones alone", after.closedKept);
      ok("R5-M6 · … and moved the open tasks and future appointments", after.tasksMoved && after.apptsMoved);
      ok("R5-M6 · the confirmation does NOT claim a transaction it never had",
        !/in one transaction/.test(after.roleMsg) && /moved to Wayne Kellow/.test(after.roleMsg), JSON.stringify(after.roleMsg));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (e) {} }
  }

  console.log(`\nBATCH 5: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
