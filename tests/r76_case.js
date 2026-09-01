#!/usr/bin/env node
/* =============================================================================
   tests/r76_case.js — acceptance tests for R76 build A, "close the loop".

   Seven items, all on the case/board/diary loop:
     §A  A1 · THE COMPLETED STAGE-ENTRY OVERLAY. Moving a case to Completed
         interactively opens the house overlay (#stage-completed-*): a
         "Completed on" date (today by default; completed_at is written from it
         at local midday so no TZ walk shifts the day), pre-ticked "queue the
         fee request / review request" boxes routed through the SAME queueEmail
         writer the Actions ▾ menu uses (queued only, heldWord() tense on the
         toast), boxes disabled-with-a-reason when they cannot work, a
         read-only rate-end line (or its warning), Cancel aborting the move
         entirely — and NO Undo when anything was queued (the entry-prompt
         wrote data), Undo intact when nothing was.
     §B  A2 · THE STALE-BOARD GUARD. A card's Advance → and stage <select> bake
         the RENDERED stage as expectedStage; when the db has moved on, the
         move is refused with the refreshing-the-board toast and no backward
         write happens.
     §C  A3 · FACT-FIND APPLY CLOSES ITS TASK. A successful #ff-apply-confirm
         completes the case's open "Review submitted fact-find" task
         (trim/case-tolerant), says so on the toast, and its Undo reopens it.
         No such task → nothing changes.
     §D  A4 · ATTENDED → "LOG WHAT WAS DISCUSSED". Flipping an outcome to
         attended on a case-linked appointment puts a second action beside Undo
         on the same toast (#toast-action-2), opening the ONE log-call overlay
         (panelId appt-logcall-panel). #toast-action stays Undo.
     §E  A5 · INBOUND EMAIL ON THE CASE. The case timeline renders the stored
         snippet (esc'd, .tl-snippet) under the subject, and a 'new' row
         carries a Mark handled chip performing markEmailHandled's exact write,
         repainting in place.
     §F  A6 · PAST-BOOKING WARNING (WARN, NEVER BLOCK). The clause "This books
         into the past — recording something that already happened?" appears as
         #appt-past-note in the form, on the save toast, and on the drag Undo
         toast — and nothing is ever blocked.
     §G  A7 · NATIVES → HOUSE. Interactive reopen = confirmTyped REOPEN;
         bulkAssignCases = confirmDestructive (#ovl-confirm-ok); the referral
         thank-you offer = house overlay. No native dialog anywhere in here.

   Every figure asserted is seeded by this file or read back off
   window.__mockDb — never invented. PLAYWRIGHT-AWAIT: a move that raises an
   overlay is fired UNAWAITED (window.__r76mv) and the DOM is polled.

   Run:  node /root/nx/tests/r76_case.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — see HARNESS.md.)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

async function ensureServer() {
  const up = await new Promise((res) => {
    const req = http.get(`http://localhost:${PORT}/admin/mock.html`, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
  });
  if (up) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1200));
  return srv;
}

const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_untouched", "nx_wt_scope", "nx_board_adviser",
  "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_clients_adviser", "nx_brief_scope", "nx_pipe_cols",
  "nx_diaryview_p1", "nx_diaryview_p2", "nx_diaryview_p3", "nx_diaryview_p4"];

const DESK = { width: 1400, height: 950 };

async function boot(browser, persona) {
  const ctx = await browser.newContext({ viewport: DESK });
  const page = await ctx.newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(300);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const toastHasAction = (page) => page.evaluate(() => document.querySelector("#toast").classList.contains("has-action"));
const wait = (page, ms) => page.waitForTimeout(ms);
const goPage = async (page, name, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await page.waitForTimeout(ms == null ? 2000 : ms);
};

// Europe/London calendar date, computed in the TEST — never borrowed from app.js.
const londonYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d || new Date());
const pad2 = (n) => String(n).padStart(2, "0");
const localYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

let uniq = 0;
const tag = () => `R76${Date.now().toString(36)}${++uniq}`;

async function mkClientCase(page, o) {
  return page.evaluate(async (opt) => {
    const db = window.__mockDb;
    const { data: cl, error: ce } = await db.from("clients").insert({
      first_name: opt.first, last_name: opt.last, email: opt.email === undefined ? null : opt.email, phone: opt.phone === undefined ? null : opt.phone,
    }).select("id").single();
    if (ce) throw new Error("client insert: " + ce.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "application", assigned_to: "p2", protection_status: "discussed" }, opt.case || {});
    const { data: cs, error: se } = await db.from("cases").insert(row).select("id").single();
    if (se) throw new Error("case insert: " + se.message);
    return { clientId: cl.id, caseId: cs.id };
  }, o);
}
const caseRow = (page, id) => page.evaluate(async (i) => (await window.__mockDb.from("cases").select("*").eq("id", i).single()).data, id);
const tasksOf = (page, caseId) => page.evaluate(async (id) => (await window.__mockDb.from("case_tasks").select("*").eq("case_id", id)).data || [], caseId);
// The owner-only bank settings (RLS'd), seeded so the fee box can be live. p4 pages only.
const seedBank = (page) => page.evaluate(async () => {
  const { error } = await window.__mockDb.from("settings").upsert([
    { key: "bank_account_name", value: "NexMoney Ltd" },
    { key: "bank_sort_code", value: "12-34-56" },
    { key: "bank_account_number", value: "12345678" },
  ]);
  if (error) throw new Error("bank seed: " + error.message);
});
/* Fire a stage move WITHOUT awaiting it (an overlay may be about to open) and stash the promise. */
const fireMove = (page, caseId, stage) => page.evaluate(({ id, s }) => { window.__r76mv = window.moveCaseToStage(id, s); }, { id: caseId, s: stage });
const moveResult = (page) => page.evaluate(() => window.__r76mv);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* =======================================================================
     §A · A1 — THE COMPLETED STAGE-ENTRY OVERLAY
     ==================================================================== */
  {
    console.log("\n— §A · A1 · the Completed overlay: date, pre-ticked emails, rate line, cancel, undo");
    const page = await boot(browser, "p4");   // owner: the bank settings are owner-RLS'd
    await seedBank(page);
    const em = `a1.${tag()}@example.com`.toLowerCase();
    const full = await mkClientCase(page, {
      first: "Aine", last: "Fullloop" + tag(), email: em,
      case: { stage: "exchange", broker_fee: 495, rate_end_date: "2028-03-01", lender: "Skipton" },
    });

    // (1) The full case: everything live and pre-ticked, custom date written at local midday.
    await fireMove(page, full.caseId, "completed");
    await page.waitForSelector("#stage-completed-ok", { timeout: 8000 });
    const st = await page.evaluate(() => ({
      date: document.querySelector("#stage-completed-date").value,
      fee: { checked: document.querySelector("#stage-completed-fee").checked, disabled: document.querySelector("#stage-completed-fee").disabled },
      rev: { checked: document.querySelector("#stage-completed-review").checked, disabled: document.querySelector("#stage-completed-review").disabled },
      rate: document.querySelector("#stage-completed-rate").textContent,
    }));
    eq("A1a · the Completed on date defaults to today (Europe/London)", st.date, londonYmd());
    ok("A1b · the fee request box is PRE-TICKED and live", st.fee.checked && !st.fee.disabled, JSON.stringify(st.fee));
    ok("A1c · the review request box is PRE-TICKED and live", st.rev.checked && !st.rev.disabled, JSON.stringify(st.rev));
    ok("A1d · the rate-end line states the recorded date, read-only", /Rate end date on this case/.test(st.rate) && /1 Mar 2028/.test(st.rate), st.rate);
    const chosen = londonYmd(new Date(Date.now() - 9 * 86400000));
    await page.evaluate((d) => { document.querySelector("#stage-completed-date").value = d; }, chosen);
    await page.click("#stage-completed-ok");
    eq("A1e · the move goes through", await moveResult(page), "moved");
    await wait(page, 900);
    const after = await caseRow(page, full.caseId);
    eq("A1f · the case is Completed", after.stage, "completed");
    eq("A1g · completed_at carries the CHOSEN date (local-midday anchor — no TZ walk)", londonYmd(new Date(after.completed_at)), chosen);
    const q = await page.evaluate(async (id) => (await window.__mockDb.from("email_queue").select("email_type,status,to_email").eq("case_id", id)).data || [], full.caseId);
    eq("A1h · the ticked fee request landed in email_queue, queued (not sent)",
      q.filter((r) => r.email_type === "fee_request" && r.status === "queued" && r.to_email === em).length, 1);
    eq("A1i · the ticked review request landed in email_queue, queued (not sent)",
      q.filter((r) => r.email_type === "review_request" && r.status === "queued" && r.to_email === em).length, 1);
    ok("A1j · the same writer stamped the case exactly as the Actions ▾ path does",
      after.fee_status === "requested" && !!after.fee_requested_at && !!after.review_requested_at,
      JSON.stringify({ fs: after.fee_status, fr: after.fee_requested_at, rr: after.review_requested_at }));
    const t1 = await toastText(page);
    ok("A1k · the toast names both queues in heldWord() tense (hold is on by default → held)",
      /fee request email held/.test(t1) && /review request email held/.test(t1), t1);
    eq("A1l · the move that queued emails offers NO Undo (entry prompt wrote data — the R74 rule)", await toastHasAction(page), false);
    eq("A1m · no native dialog anywhere in it", page.__dialogs.length, 0);

    // (2) A case where neither box can work: reasons stated, warning rate line, Undo intact.
    const bare = await mkClientCase(page, { first: "Bare", last: "Noloop" + tag(), email: null, case: { stage: "exchange" } });
    await fireMove(page, bare.caseId, "completed");
    await page.waitForSelector("#stage-completed-ok", { timeout: 8000 });
    const st2 = await page.evaluate(() => ({
      fee: { checked: document.querySelector("#stage-completed-fee").checked, disabled: document.querySelector("#stage-completed-fee").disabled },
      rev: { checked: document.querySelector("#stage-completed-review").checked, disabled: document.querySelector("#stage-completed-review").disabled },
      body: document.querySelector("#overlay-modal").textContent,
      rate: document.querySelector("#stage-completed-rate").textContent,
    }));
    ok("A2a · a box that cannot work starts UNTICKED and disabled, with its stated reason",
      !st2.fee.checked && st2.fee.disabled && !st2.rev.checked && st2.rev.disabled && /no email address/.test(st2.body), st2.body.slice(0, 260));
    ok("A2b · no rate end date → the warning line, word for word",
      /no rate end date — retention won't chase this case; add it on the case/i.test(st2.rate), st2.rate);
    await page.click("#stage-completed-ok");
    eq("A2c · the move still goes through", await moveResult(page), "moved");
    await wait(page, 900);
    ok("A2d · nothing was queued for it", (await page.evaluate(async (id) =>
      (await window.__mockDb.from("email_queue").select("email_type").eq("case_id", id)).data || [], bare.caseId))
      .filter((r) => r.email_type === "fee_request" || r.email_type === "review_request").length === 0);
    eq("A2e · a completed move that queued NOTHING keeps its R74 Undo", await toastHasAction(page), true);
    await page.click("#toast-action");
    await wait(page, 900);
    const undone = await caseRow(page, bare.caseId);
    ok("A2f · Undo puts the stage and completion date back", undone.stage === "exchange" && undone.completed_at == null,
      JSON.stringify({ stage: undone.stage, completed_at: undone.completed_at }));

    // (3) Cancel aborts the move entirely.
    const canc = await mkClientCase(page, { first: "Cassie", last: "Cancels" + tag(), case: { stage: "offer" } });
    await fireMove(page, canc.caseId, "completed");
    await page.waitForSelector("#stage-completed-cancel", { timeout: 8000 });
    await page.click("#stage-completed-cancel");
    eq("A3a · Cancel returns 'cancelled'", await moveResult(page), "cancelled");
    eq("A3b · …and the case never moved", (await caseRow(page, canc.caseId)).stage, "offer");

    eq("§A · no native dialogs", page.__dialogs.length, 0);
    eq("§A · no console errors", realErrs(page), []);
    await page.close();
  }

  /* =======================================================================
     §B · A2 — THE STALE-BOARD GUARD
     ==================================================================== */
  {
    console.log("\n— §B · A2 · a stale card cannot drag a colleague's case backwards");
    const page = await boot(browser, "p4");
    const c = await mkClientCase(page, { first: "Stale", last: "Board" + tag(), case: { stage: "application" } });
    await goPage(page, "pipeline", 2400);
    ok("B1a · fixture — the card is on the board", await page.evaluate((id) => !!document.querySelector(`#board .card[data-id="${id}"]`), c.caseId));
    ok("B1b · the card carries its rendered stage (data-stage — the drag path's capture)",
      (await page.evaluate((id) => document.querySelector(`#board .card[data-id="${id}"]`).dataset.stage, c.caseId)) === "application");
    // A colleague advances the case while this board sits stale.
    await page.evaluate(async (id) => { await window.__mockDb.from("cases").update({ stage: "offer" }).eq("id", id); }, c.caseId);
    await page.click(`#board .card[data-id="${c.caseId}"] .card-advance`);
    await wait(page, 1200);
    const t1 = await toastText(page);
    ok("B2a · the stale Advance → is refused with the refreshing toast",
      /This case moved to Offer since this board loaded — refreshing the board/.test(t1), t1);
    eq("B2b · …and the case was NOT dragged backwards", (await caseRow(page, c.caseId)).stage, "offer");
    await wait(page, 1600);   // the guard's own loadPipeline() repaint
    eq("B2c · the board repainted with the card at its real stage",
      await page.evaluate((id) => { const el = document.querySelector(`#board .card[data-id="${id}"]`); return el ? el.dataset.stage : null; }, c.caseId), "offer");
    // Same hole, via the card's stage <select> — mutate again under the fresh card.
    await page.evaluate(async (id) => { await window.__mockDb.from("cases").update({ stage: "exchange" }).eq("id", id); }, c.caseId);
    // The card select is hover-revealed — drive it the way its inline handler is driven.
    await page.evaluate((id) => {
      const s = document.querySelector(`#board .card[data-id="${id}"] .card-stage-move`);
      s.value = "fact_find";
      s.dispatchEvent(new Event("change"));
    }, c.caseId);
    await wait(page, 1200);
    const t2 = await toastText(page);
    ok("B3a · the stale stage <select> is refused the same way",
      /This case moved to Exchange since this board loaded — refreshing the board/.test(t2), t2);
    eq("B3b · …and no backward write happened", (await caseRow(page, c.caseId)).stage, "exchange");
    eq("§B · no native dialogs", page.__dialogs.length, 0);
    eq("§B · no console errors", realErrs(page), []);
    await page.close();
  }

  /* =======================================================================
     §C · A3 — FACT-FIND APPLY CLOSES ITS TASK
     ==================================================================== */
  {
    console.log("\n— §C · A3 · applying a fact-find completes the 'Review submitted fact-find' task");
    const page = await boot(browser, "p2");
    const c = await mkClientCase(page, { first: "Ffa", last: "Applies" + tag(), email: `c.${tag()}@example.com` });
    // The trigger's fixed title, deliberately mangled in trim/case to prove the tolerant match.
    const taskId = await page.evaluate(async (caseId) => {
      const { data } = await window.__mockDb.from("case_tasks").insert({
        case_id: caseId, title: "  review SUBMITTED Fact-Find  ", due_date: "2026-01-01", assigned_to: "p2",
      }).select("id").single();
      return data.id;
    }, c.caseId);
    await page.evaluate(({ caseId, clientId }) => window.ffApplyDiff(caseId, clientId, { phone: "07700 900321" }), { caseId: c.caseId, clientId: c.clientId });
    await page.waitForSelector("#ff-apply-confirm", { timeout: 8000 });
    await page.click("#ff-apply-confirm");
    await wait(page, 1200);
    const done = await page.evaluate(async (id) => (await window.__mockDb.from("case_tasks").select("done_at").eq("id", id).single()).data, taskId);
    ok("C1a · the open review task is completed on a successful apply (trim/case-tolerant)", !!done.done_at, JSON.stringify(done));
    const t = await toastText(page);
    ok("C1b · the toast says so", /closed the review task/.test(t), t);
    eq("C1c · …and offers Undo", await toastHasAction(page), true);
    await page.click("#toast-action");
    await wait(page, 900);
    const back = await page.evaluate(async (id) => (await window.__mockDb.from("case_tasks").select("done_at").eq("id", id).single()).data, taskId);
    eq("C1d · Undo reopens exactly that task", back.done_at, null);
    ok("C1e · …and the applied field is NOT unwound by it (the Undo un-does the one thing it names)",
      (await page.evaluate(async (id) => (await window.__mockDb.from("clients").select("phone").eq("id", id).single()).data.phone, c.clientId)) === "07700 900321");

    // No such open task → nothing changes, no clause.
    const c2 = await mkClientCase(page, { first: "Ffb", last: "Notask" + tag() });
    await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
    await page.evaluate(({ caseId, clientId }) => window.ffApplyDiff(caseId, clientId, { phone: "07700 900654" }), { caseId: c2.caseId, clientId: c2.clientId });
    await page.waitForSelector("#ff-apply-confirm", { timeout: 8000 });
    await page.click("#ff-apply-confirm");
    await wait(page, 1200);
    const t2 = await toastText(page);
    ok("C2a · with no open review task the toast has no such clause", /Applied 1 field/.test(t2) && !/closed the review task/.test(t2), t2);
    eq("§C · no console errors", realErrs(page), []);
    await page.close();
  }

  /* =======================================================================
     §D · A4 — ATTENDED → "LOG WHAT WAS DISCUSSED"
     ==================================================================== */
  {
    console.log("\n— §D · A4 · attended on a case-linked appointment offers the log beside Undo");
    const page = await boot(browser, "p2");
    const c = await mkClientCase(page, { first: "Della", last: "Attended" + tag() });
    const mkAp = (caseId) => page.evaluate(async (cid) => {
      const start = new Date(Date.now() - 3 * 3600000);
      const { data } = await window.__mockDb.from("appointments").insert({
        title: "Fact find call", starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600000).toISOString(),
        staff_id: "p2", client_id: null, case_id: cid,
      }).select("id").single();
      return data.id;
    }, caseId);
    const apId = await mkAp(c.caseId);
    await page.evaluate((id) => { window.__r76q = window.quickApptOutcome(id, "attended"); }, apId);
    await wait(page, 1400);
    const btns = await page.evaluate(() => ({
      a1: (document.querySelector("#toast-action") || {}).textContent || null,
      a2: (document.querySelector("#toast-action-2") || {}).textContent || null,
    }));
    eq("D1a · #toast-action is still Undo (old suites keep their button)", btns.a1, "Undo");
    eq("D1b · the second action is Log what was discussed", btns.a2, "Log what was discussed");
    await page.click("#toast-action-2");
    await page.waitForSelector("#appt-logcall-panel", { timeout: 8000 });
    ok("D1c · it opens the ONE log-call overlay under its own panelId (appt-logcall-panel)",
      await page.evaluate(() => !!document.querySelector("#appt-logcall-panel #cs-call-save")));
    ok("D1d · …titled with the client's name",
      /Della/.test(await page.evaluate(() => document.querySelector("#overlay-modal h3").textContent)));
    await page.click("#cs-call-cancel");
    await wait(page, 400);

    // A caseless appointment, and a no-show, both stay one-action toasts.
    const apLoose = await page.evaluate(async () => {
      const start = new Date(Date.now() - 2 * 3600000);
      const { data } = await window.__mockDb.from("appointments").insert({
        title: "Walk-in", starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 1800000).toISOString(), staff_id: "p2",
      }).select("id").single();
      return data.id;
    });
    await page.evaluate((id) => { window.__r76q = window.quickApptOutcome(id, "attended"); }, apLoose);
    await wait(page, 1300);
    eq("D2a · attended on a CASELESS appointment offers no second action",
      await page.evaluate(() => !!document.querySelector("#toast-action-2")), false);
    const apNs = await mkAp(c.caseId);
    await page.evaluate((id) => { window.__r76q = window.quickApptOutcome(id, "no_show"); }, apNs);
    await wait(page, 1500);
    eq("D2b · a no-show offers no second action (its next step is the call-back task)",
      await page.evaluate(() => !!document.querySelector("#toast-action-2")), false);
    eq("§D · no console errors", realErrs(page), []);
    await page.close();
  }

  /* =======================================================================
     §E · A5 — INBOUND EMAIL ON THE CASE: SNIPPET + MARK HANDLED
     ==================================================================== */
  {
    console.log("\n— §E · A5 · the case timeline shows the snippet and can mark the email handled");
    const page = await boot(browser, "p2");
    const c = await mkClientCase(page, { first: "Ines", last: "Inbound" + tag() });
    const snip = "Hi — payslips attached, and a question about the <b>rate</b> please.";
    const emailId = await page.evaluate(async ({ caseId, clientId, snip }) => {
      const { data } = await window.__mockDb.from("case_emails").insert({
        case_id: caseId, client_id: clientId, from_email: "ines@example.com", subject: "Payslips and a question",
        snippet: snip, received_at: new Date(Date.now() - 3600000).toISOString(), triage_status: "new",
      }).select("id").single();
      return data.id;
    }, { caseId: c.caseId, clientId: c.clientId, snip });
    await page.evaluate((id) => window.openCase(id), c.caseId);
    await wait(page, 1600);
    const row = await page.evaluate(() => {
      const sn = document.querySelector("#case-events-list .tl-snippet");
      const chip = document.querySelector("#case-events-list .tl-mark-handled");
      return { snText: sn ? sn.textContent : null, snHtml: sn ? sn.innerHTML : null, chip: chip ? chip.textContent : null };
    });
    ok("E1a · the stored snippet renders under the subject", row.snText === snip, JSON.stringify(row.snText));
    ok("E1b · …escaped, never as markup", row.snHtml && row.snHtml.includes("&lt;b&gt;"), row.snHtml);
    eq("E1c · the 'new' row carries a Mark handled chip", row.chip, "Mark handled");
    await page.click("#case-events-list .tl-mark-handled");
    await wait(page, 900);
    eq("E2a · the chip performs markEmailHandled's exact write",
      await page.evaluate(async (id) => (await window.__mockDb.from("case_emails").select("triage_status").eq("id", id).single()).data.triage_status, emailId),
      "handled");
    ok("E2b · …and repaints in place ('handled ✓', chip gone)", await page.evaluate(() =>
      !document.querySelector("#case-events-list .tl-mark-handled") && !!document.querySelector("#case-events-list .tl-handled-done")));
    // A handled row reopened fresh shows no chip at all.
    await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
    await page.evaluate((id) => window.openCase(id), c.caseId);
    await wait(page, 1500);
    eq("E3 · a handled row re-rendered offers no chip",
      await page.evaluate(() => !!document.querySelector("#case-events-list .tl-mark-handled")), false);
    eq("§E · no console errors", realErrs(page), []);
    await page.close();
  }

  /* =======================================================================
     §F · A6 — PAST-BOOKING WARNING (WARN, NEVER BLOCK)
     ==================================================================== */
  {
    console.log("\n— §F · A6 · booking into the past warns in the form, the save toast, and the drag toast");
    const page = await boot(browser, "p2");
    const CLAUSE = "This books into the past — recording something that already happened?";
    const yesterday = localYmd(new Date(Date.now() - 86400000));
    const tomorrow = localYmd(new Date(Date.now() + 86400000));
    await page.evaluate((ymd) => window.openAppt(null, { starts_at: `${ymd}T10:00` }), yesterday);
    await wait(page, 900);
    const note = await page.evaluate(() => ({ hidden: document.querySelector("#appt-past-note").classList.contains("hidden"), text: document.querySelector("#appt-past-note").textContent }));
    ok("F1a · the form shows the notice for a past date", !note.hidden && note.text === CLAUSE, JSON.stringify(note));
    await page.fill('#appt-form [name="date"]', tomorrow);
    await wait(page, 300);
    eq("F1b · fixing the date hides it live", await page.evaluate(() => document.querySelector("#appt-past-note").classList.contains("hidden")), true);
    await page.fill('#appt-form [name="date"]', yesterday);
    await wait(page, 300);
    eq("F1c · …and back", await page.evaluate(() => document.querySelector("#appt-past-note").classList.contains("hidden")), false);
    await page.fill('#appt-form [name="title"]', "Catch-up (already happened)");
    await page.click("#modal-save");
    await wait(page, 1200);
    const t = await toastText(page);
    ok("F2a · the save toast carries the same clause", t.includes("Appointment saved") && t.includes(CLAUSE), t);
    const saved = await page.evaluate(async (ymd) => {
      const { data } = await window.__mockDb.from("appointments").select("id,starts_at,title").order("created_at", { ascending: false }).limit(5);
      return (data || []).find((a) => a.title === "Catch-up (already happened)");
    }, yesterday);
    ok("F2b · NEVER BLOCKED — the appointment was saved", !!saved, JSON.stringify(saved));

    // Drag onto a past day: the clause rides the existing Undo toast.
    const apId = await page.evaluate(async () => {
      const start = new Date(Date.now() + 2 * 86400000); start.setHours(11, 0, 0, 0);
      const { data } = await window.__mockDb.from("appointments").insert({
        title: "Draggable", starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600000).toISOString(), staff_id: "p3",
      }).select("id").single();
      return data.id;
    });
    await page.evaluate(({ id, ymd }) => { window.__r76d = window.diaryMoveAppt(id, { date: ymd, time: "09:00" }); }, { id: apId, ymd: yesterday });
    await wait(page, 1500);
    const dt = await toastText(page);
    ok("F3a · the drag Undo toast carries the clause", /Moved “Draggable”/.test(dt) && dt.includes(CLAUSE), dt);
    eq("F3b · …and still offers Undo", await toastHasAction(page), true);
    ok("F3c · the move itself happened (warn, never block)",
      londonYmd(new Date((await page.evaluate(async (id) => (await window.__mockDb.from("appointments").select("starts_at").eq("id", id).single()).data.starts_at, apId)))) === londonYmd(new Date(Date.now() - 86400000)));
    // A forward move carries no clause.
    await page.evaluate(({ id, ymd }) => { window.__r76d = window.diaryMoveAppt(id, { date: ymd, time: "09:00" }); }, { id: apId, ymd: tomorrow });
    await wait(page, 1500);
    ok("F4 · a forward move has no clause", !(await toastText(page)).includes(CLAUSE), await toastText(page));
    eq("§F · no native dialogs", page.__dialogs.length, 0);
    eq("§F · no console errors", realErrs(page), []);
    await page.close();
  }

  /* =======================================================================
     §G · A7 — THE REMAINING NATIVES, IN HOUSE CLOTHES
     ==================================================================== */
  {
    console.log("\n— §G · A7 · interactive REOPEN = confirmTyped; bulk assign + referral offer = house overlays");
    const page = await boot(browser, "p4");
    // (a) interactive reopen — the typed word.
    const done = await mkClientCase(page, { first: "Rea", last: "Opens" + tag(), case: { stage: "completed", completed_at: new Date().toISOString() } });
    await fireMove(page, done.caseId, "application");
    await page.waitForSelector("#ovl-typed-input", { timeout: 8000 });
    const typed = await page.evaluate(() => ({
      body: document.querySelector("#ovl-typed-body").textContent,
      word: document.querySelector("#ovl-typed-label").textContent,
      okDisabled: document.querySelector("#ovl-typed-ok").disabled,
    }));
    ok("G1a · the reopen keeps its msg text, now in confirmTyped", /REOPEN/.test(typed.body) && /clears its completion date/.test(typed.body), typed.body);
    ok("G1b · the word is REOPEN and OK starts disabled", /REOPEN/.test(typed.word) && typed.okDisabled === true, JSON.stringify(typed));
    await page.fill("#ovl-typed-input", "reopen please");
    eq("G1c · a wrong word keeps OK disabled", await page.evaluate(() => document.querySelector("#ovl-typed-ok").disabled), true);
    await page.fill("#ovl-typed-input", "REOPEN");
    await page.click("#ovl-typed-ok");
    eq("G1d · typing the word reopens the case", await moveResult(page), "reopened");
    await wait(page, 900);
    const re = await caseRow(page, done.caseId);
    ok("G1e · …stage live, completion date cleared", re.stage === "application" && re.completed_at == null, JSON.stringify({ s: re.stage, c: re.completed_at }));
    // Cancel leaves a settled case settled.
    const done2 = await mkClientCase(page, { first: "Reb", last: "Stays" + tag(), case: { stage: "completed", completed_at: new Date().toISOString() } });
    await fireMove(page, done2.caseId, "offer");
    await page.waitForSelector("#ovl-typed-cancel", { timeout: 8000 });
    await page.click("#ovl-typed-cancel");
    eq("G1f · cancelling the typed gate cancels the move", await moveResult(page), "cancelled");
    eq("G1g · …and the case stays Completed", (await caseRow(page, done2.caseId)).stage, "completed");

    // (b) bulk assign — confirmDestructive, #ovl-confirm-ok.
    const b1 = await mkClientCase(page, { first: "Bulka", last: "Assign" + tag() });
    const b2 = await mkClientCase(page, { first: "Bulkb", last: "Assign" + tag() });
    await goPage(page, "pipeline", 2400);
    const isBoard = await page.evaluate(() => !document.querySelector("#board").classList.contains("hidden"));
    if (isBoard) { await page.click("#view-toggle"); await wait(page, 1200); }
    await page.check(`#pipe-table .bulk-cb[data-id="${b1.caseId}"]`);
    await page.check(`#pipe-table .bulk-cb[data-id="${b2.caseId}"]`);
    await page.selectOption("#pipe-bulk-adviser", "p3");
    await page.waitForSelector("#ovl-confirm-ok", { timeout: 8000 });
    const asg = await page.evaluate(() => ({
      title: document.querySelector("#ovl-confirm-title").textContent,
      ok: document.querySelector("#ovl-confirm-ok").textContent,
    }));
    ok("G2a · bulk assign asks in the house dialog, naming count and adviser",
      /Assign 2 cases to Luke Richards\?/.test(asg.title) && /Assign 2 cases/.test(asg.ok), JSON.stringify(asg));
    await page.click("#ovl-confirm-ok");
    await wait(page, 1300);
    eq("G2b · both cases were assigned", await page.evaluate(async (ids) =>
      (await window.__mockDb.from("cases").select("assigned_to").in("id", ids)).data.map((r) => r.assigned_to), [b1.caseId, b2.caseId]), ["p3", "p3"]);

    // (c) the referral thank-you offer — a house overlay that cannot pop behind toasts.
    const refClient = await mkClientCase(page, { first: "Renee", last: "Referrer" + tag(), case: { stage: "application" } });
    const referred = await mkClientCase(page, { first: "Rufus", last: "Referred" + tag(), case: { stage: "exchange", referrer_client_id: refClient.clientId } });
    await fireMove(page, referred.caseId, "completed");
    await page.waitForSelector("#stage-completed-ok", { timeout: 8000 });
    await page.click("#stage-completed-ok");
    await page.waitForSelector("#ovl-confirm-ok", { timeout: 8000 });
    const refBody = await page.evaluate(() => document.querySelector("#ovl-confirm-body").textContent);
    ok("G3a · the offer is the house overlay, naming both people and the no-email rule",
      /Renee/.test(refBody) && /Rufus/.test(refBody) && /No email is sent to anybody either way/.test(refBody), refBody.slice(0, 240));
    await page.click("#ovl-confirm-ok");
    await moveResult(page);
    await wait(page, 1200);
    const thanks = (await tasksOf(page, refClient.caseId)).filter((t) => /^Thank /.test(t.title || ""));
    eq("G3b · accepting creates the thank-you task on the referrer's case", thanks.length, 1);
    eq("§G · NO native dialog anywhere in the section", page.__dialogs.length, 0);
    eq("§G · no console errors", realErrs(page), []);
    await page.close();
  }

  await browser.close();
  if (srv) { try { process.kill(-srv.pid); } catch (e) { /* ignore */ } }
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("FAIL: " + f)); process.exit(1); }
})().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
