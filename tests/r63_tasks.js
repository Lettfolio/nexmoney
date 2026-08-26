#!/usr/bin/env node
/* =============================================================================
   tests/r63_tasks.js — acceptance tests for ROUND 63, the "cases with no next
   action" round: the stage playbook stops being advisory, and a leftover task
   from an earlier stage stops counting as a next action.

   THE DEFECT THIS ROUND IS ABOUT. In production 127 of 134 live cases carried
   NO open task at all, because R17's stage playbook was offered as a panel of
   "+ Add" buttons in the case modal and nobody pressed them. Of the seven that
   did have a task, some were held by a step from a stage the case had long
   since left ("Submit DIP to lender" still open on a case at Offer) — which
   was ALSO what the case header advertised as NEXT TASK, and what kept the
   case off the No-next-action radar.

     §A  H1a · LEAD ACCEPT — acceptLead writes the ENQUIRY playbook items onto
         the case it creates: due today + each step's dueOffsetDays, assigned
         to the adviser the lead was ROUTED to (not necessarily the person who
         pressed Accept), created_by the actor — the same row shape
         playbookAddAll writes by hand. Idempotent by title. The accept toast
         names them ("· 2 tasks added").
     §B  H1b · STAGE ADVANCE — moveCaseToStage auto-adds every applicable
         playbook item for the NEW stage that is not already an open task, on
         EVERY path in: programmatic, the modal's Advance button, and the
         pipeline's bulk move (silent per case, tallied in the batch summary).
         Kind-gated (a product transfer gets no valuation step at Application).
         Nothing for not_proceeding. Nothing titled "Chase solicitors…" — that
         one belongs to production's own auto_stage_comms trigger. All of it
         gated on ONE new setting, `playbook_auto_tasks` (absent ⇒ ON), which
         renders on the Settings page with a .panel-sub explaining it.
     §C  H1c · STALE TASKS — isStalePlaybookTask(task, caseStage): an OPEN task
         whose title matches (by playbookTitleKey) a playbook step of a stage
         EARLIER than the case's current one. Three readers, one predicate:
         the case header's NEXT TASK prefers a non-stale task and falls back to
         a stale one LABELLED "(from an earlier stage)"; the case modal's task
         list puts an "earlier stage" chip on the row with a one-click Done
         (the existing complete-task action); and loadUnactioned treats a case
         whose ONLY open tasks are stale as unactioned, so it reaches the
         radar. The 7-day activity threshold is untouched.
     §D  M1 · LEAD ADVISER DEFAULT ON THE MINE FEED — when My Day's scope is
         Mine, an enquiry row's adviser select defaults to the signed-in user
         if they are advising staff, and the note beside it says "defaulted to
         you — this is your feed". On All it is the R7-5 lightest-load
         suggestion, exactly as before. An admin who does not advise keeps the
         lightest-load default on BOTH scopes.
     §E  no console errors anywhere above.

   EVERY figure this file asserts — the playbook map, the due-date arithmetic,
   the stale predicate, the stage order — is recomputed HERE, independently of
   app.js's own CASE_STAGE_PLAYBOOK / isStalePlaybookTask / STAGES, per the
   standing rule in HARNESS.md. Cases are created fresh via mkClientCase and
   never taken from the fixtures, except where a FIXTURE lead is the subject
   (§A) — a lead is the one thing this round's first half needs an inbox row
   for. mock-supabase.js rebuilds its DB per page load, so every id minted on a
   page is only meaningful on that page.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r63_tasks.js
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

/* Same defensive localStorage clear + tour skip every recent suite in this harness does before
   depending on a default (see tests/r41.js's NX_KEYS / skipTour) — the product tour is a modal
   overlay, and a suite that clicks real buttons has to be sure it is not there. */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser"/* R64 · M9 — the Clients adviser filter persists now */, "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_ret_scope", "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads",
  "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
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

/* Insert a client + case in one round trip. A case created this way has NO tasks on it: the
   auto-add is bound to acceptLead and moveCaseToStage, never to a plain insert, which is exactly
   what lets §B measure the move rather than the fixture. */
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email || (`r63.${Math.random().toString(36).slice(2, 9)}@example.com`);
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Test", last_name: o.last || "R63Case", email, phone: o.phone || null })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = {
      client_id: cl.id, case_kind: o.case_kind || "purchase", stage: o.stage || "enquiry",
      assigned_to: o.assigned_to === undefined ? "p2" : o.assigned_to,
      lender: o.lender === undefined ? "Halifax" : o.lender,
      // Every stage from Application on is gated on a recorded protection status — without it
      // moveCaseToStage refuses the move and this file would be measuring the gate, not the tasks.
      protection_status: o.protection_status === undefined ? "not_needed" : o.protection_status,
    };
    if (o.offer_expiry_date !== undefined) row.offer_expiry_date = o.offer_expiry_date;
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id };
  }, opts || {});
}

/* A case with no activity of its own — the radar's fixture shape. Every case insert auto-logs a
   "case_created" case_event dated now (mock-supabase.js), so a fresh case always reads as touched;
   wiping its events/notes reproduces the state a real case only reaches after a week. */
async function mkQuietCase(page, opts) {
  const r = await mkClientCase(page, opts);
  await page.evaluate(async (caseId) => {
    const db = window.__mockDb;
    await db.from("case_events").delete().eq("case_id", caseId);
    await db.from("case_notes").delete().eq("case_id", caseId);
  }, r.caseId);
  return r;
}

const addTask = (page, caseId, title, due, assignee) => page.evaluate(
  ({ caseId, title, due, assignee }) => window.__mockDb.from("case_tasks")
    .insert({ case_id: caseId, title, due_date: due || null, assigned_to: assignee || "p2" }),
  { caseId, title, due, assignee });

const tasksOf = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("case_tasks").select("*").eq("case_id", id);
  return data || [];
}, caseId);
const openTitlesOf = async (page, caseId) =>
  (await tasksOf(page, caseId)).filter((t) => !t.done_at).map((t) => t.title).sort();

const move = async (page, caseId, stage, ms) => {
  const r = await page.evaluate(({ id, s }) => window.moveCaseToStage(id, s, {}), { id: caseId, s: stage });
  await wait(page, ms == null ? 1200 : ms);
  return r;
};

const openCase = async (page, caseId) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((id) => window.openCase(id), caseId);
  await wait(page, 1000);
};

const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1100 : ms);
};

/* ---------------------------------------------------------------------------
   Independent re-implementation of the R17 playbook map and the R63 stale
   rule. Never imported from app.js — see the header.
   ------------------------------------------------------------------------- */
const PLAYBOOK = {
  enquiry: [
    { title: "Qualify enquiry — budget, timeline, goal", dueOffsetDays: 0 },
    { title: "Book fact-find appointment", dueOffsetDays: 2 },
  ],
  fact_find: [
    { title: "Complete fact-find", dueOffsetDays: 1 },
    { title: "Collect ID & proof of income/deposit", dueOffsetDays: 3 },
    { title: "Discuss protection needs", dueOffsetDays: 3 },
  ],
  decision_in_principle: [
    { title: "Submit DIP to lender", dueOffsetDays: 0 },
    { title: "Confirm DIP outcome with client", dueOffsetDays: 2 },
  ],
  application: [
    { title: "Submit full application to lender", dueOffsetDays: 1 },
    { title: "Chase outstanding documents", dueOffsetDays: 3 },
    { title: "Instruct valuation", dueOffsetDays: 2, notKinds: ["product_transfer"] },
    { title: "Confirm ICR / rental income", dueOffsetDays: 1, onlyKinds: ["buy_to_let"] },
  ],
  offer: [
    { title: "Check mortgage offer terms", dueOffsetDays: 0 },
    { title: "Send offer to client & explain", dueOffsetDays: 1 },
    { title: "Confirm solicitor instructed", dueOffsetDays: 2, notKinds: ["product_transfer"] },
  ],
  exchange: [
    { title: "Confirm exchange", dueOffsetDays: 0 },
    { title: "Prepare for completion", dueOffsetDays: 1 },
  ],
  completed: [
    { title: "Send fee request", dueOffsetDays: 3 },
    { title: "Request a review", dueOffsetDays: 7 },
    { title: "Set/confirm rate-end reminder", dueOffsetDays: 3 },
  ],
};
const STAGE_ORDER = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange", "completed"];
function pbItems(stage, kind) {
  return (PLAYBOOK[stage] || []).filter((it) =>
    (!it.notKinds || !it.notKinds.includes(kind)) &&
    (!it.onlyKinds || it.onlyKinds.includes(kind)));
}
const pbTitles = (stage, kind) => pbItems(stage, kind).map((it) => it.title).sort();
const titleKey = (t) => String(t == null ? "" : t).trim().toLowerCase();
// title key → earliest stage index it belongs to
const TITLE_STAGE = (() => {
  const m = {};
  STAGE_ORDER.forEach((st, i) => (PLAYBOOK[st] || []).forEach((it) => {
    if (!Object.prototype.hasOwnProperty.call(m, titleKey(it.title))) m[titleKey(it.title)] = i;
  }));
  return m;
})();
function stalePredicate(title, caseStage) {
  const cur = STAGE_ORDER.indexOf(caseStage);
  if (cur <= 0) return false;
  const from = TITLE_STAGE[titleKey(title)];
  return from != null && from < cur;
}
// Local YYYY-MM-DD, computed the same way the app's localDateStr does — never toISOString(), which
// would be a day out west of Greenwich in summer.
function dstr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const dueFor = (offset, now) => dstr(now + offset * DAY_MS);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  const page = await newPage(browser, "p2");
  const noNewErr = (before) => (page.__err || []).length === before;

  try {

    /* =======================================================================
       §A · H1a — ACCEPTING A LEAD STARTS THE CASE WITH ITS ENQUIRY STEPS.
       ======================================================================= */
    {
      console.log("\n— §A · Lead accept writes the Enquiry playbook onto the new case (p2)");
      const errBefore = (page.__err || []).length;
      await goto(page, "dashboard", 1500);

      // The first enquiry row on My Day, and the lead behind it.
      const leadId = await page.evaluate(() => {
        const s = document.querySelector("#briefing-list select.lead-adviser[data-lead]");
        return s ? s.dataset.lead : null;
      });
      ok("A0 · fixture — My Day carries at least one acceptable website enquiry", !!leadId, String(leadId));

      const leadRow = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("leads").select("*").eq("id", id).single();
        return data;
      }, leadId);
      // The lead's enquiry_type decides the case kind, which decides which steps apply. Recomputed
      // here from the same map the app uses so this file never asks app.js what it should expect.
      const KIND_MAP = {
        purchase: "purchase", first_time_buyer: "first_time_buyer", remortgage: "remortgage",
        buy_to_let: "buy_to_let", product_transfer: "product_transfer",
      };
      const expectKind = KIND_MAP[leadRow.enquiry_type] || "other";

      // Route it deliberately to p3 — NOT the persona pressing Accept — so "assigned to the adviser
      // the lead was routed to" is a claim this test can actually distinguish from "assigned to me".
      await page.selectOption(`#briefing-list select.lead-adviser[data-lead="${leadId}"]`, "p3");
      await wait(page, 250);
      const nowA = await page.evaluate(() => Date.now());
      // The real button on the real row (same selector shape tests/r41.js uses for Accept/Discard).
      await page.click(`#briefing-list [onclick^="acceptLead('${leadId}'"]`, { timeout: 10000 });
      await wait(page, 2600);

      const acceptedCaseId = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("leads").select("converted_case_id,status").eq("id", id).single();
        return data && data.converted_case_id;
      }, leadId);
      ok("A1 · the lead converted into a case", !!acceptedCaseId, String(acceptedCaseId));

      const caseRow = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("*").eq("id", id).single();
        return data;
      }, acceptedCaseId);
      eq("A1 · …at Enquiry, on the adviser the lead was routed to", [caseRow.stage, caseRow.assigned_to], ["enquiry", "p3"]);

      const aTasks = await tasksOf(page, acceptedCaseId);
      const expA = pbItems("enquiry", expectKind);
      eq("A2 · the new case carries exactly the Enquiry playbook steps",
        aTasks.map((t) => t.title).sort(), expA.map((it) => it.title).sort());
      eq("A2 · …all of them open (nothing pre-completed)", aTasks.filter((t) => t.done_at).length, 0);
      for (const it of expA) {
        const row = aTasks.find((t) => t.title === it.title);
        eq(`A3 · “${it.title}” is due today + ${it.dueOffsetDays}d`, row && row.due_date, dueFor(it.dueOffsetDays, nowA));
      }
      eq("A4 · every task is assigned to the ROUTED adviser (p3), not the acting user (p2)",
        [...new Set(aTasks.map((t) => t.assigned_to))], ["p3"]);
      eq("A4 · …and created_by the person who pressed Accept (p2)",
        [...new Set(aTasks.map((t) => t.created_by))], ["p2"]);

      const tA = await toastText(page);
      ok(`A5 · the accept toast names the tasks ("· ${expA.length} tasks added")`,
        new RegExp(`${expA.length} tasks? added`).test(tA), tA);

      // A6 — accepting the same lead twice cannot double the tasks: the claim is atomic and the
      // second call is refused before anything is written.
      await page.evaluate((id) => window.acceptLead(id), leadId);
      await wait(page, 1400);
      const aTasks2 = await tasksOf(page, acceptedCaseId);
      eq("A6 · re-accepting an already-accepted lead writes no second set of tasks", aTasks2.length, aTasks.length);

      /* A7 — THE TITLE DEDUPE ITSELF, on the same enquiry playbook and the same shared writer.
         A case that arrives at Enquiry already carrying one of the Enquiry steps (added by hand, or
         left from an earlier pass) gets only the steps it does NOT have. */
      const a7 = await mkClientCase(page, { first: "Dedupe", last: "Enquiry", case_kind: "purchase", stage: "fact_find" });
      await addTask(page, a7.caseId, "Qualify enquiry — budget, timeline, goal", dstr(nowA), "p2");
      await move(page, a7.caseId, "enquiry");
      const a7Titles = await openTitlesOf(page, a7.caseId);
      eq("A7 · a step already open by title is not added a second time", a7Titles, pbTitles("enquiry", "purchase"));
      const a7Rows = await tasksOf(page, a7.caseId);
      eq("A7 · …and there is exactly one row per title", a7Rows.length, pbTitles("enquiry", "purchase").length);

      ok("§A · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       §B · H1b — REACHING A STAGE WRITES THAT STAGE'S STEPS.
       ======================================================================= */
    {
      console.log("\n— §B · Stage advance auto-adds the new stage's playbook (p2)");
      const errBefore = (page.__err || []).length;

      // B1 — programmatic move, the path every board affordance funnels into.
      const b1 = await mkClientCase(page, { first: "Move", last: "ToFactFind", case_kind: "purchase", stage: "enquiry", assigned_to: "p3" });
      eq("B1 · fixture sanity — a plain case insert adds NO tasks", (await tasksOf(page, b1.caseId)).length, 0);
      const nowB1 = await page.evaluate(() => Date.now());
      const res1 = await move(page, b1.caseId, "fact_find");
      eq("B1 · the move reports success", res1, "moved");
      eq("B1 · the case now carries exactly the Fact Find steps",
        await openTitlesOf(page, b1.caseId), pbTitles("fact_find", "purchase"));
      const b1Rows = await tasksOf(page, b1.caseId);
      for (const it of pbItems("fact_find", "purchase")) {
        const row = b1Rows.find((t) => t.title === it.title);
        eq(`B1 · “${it.title}” due today + ${it.dueOffsetDays}d`, row && row.due_date, dueFor(it.dueOffsetDays, nowB1));
      }
      eq("B1 · …assigned to the CASE's adviser (p3), not the actor (p2)",
        [...new Set(b1Rows.map((t) => t.assigned_to))], ["p3"]);
      ok("B1 · the move toast reports the tasks it wrote",
        /3 tasks added for Fact Find/i.test(await toastText(page)), await toastText(page));

      // B2 — no duplicates when the case comes back to a stage it has already been at.
      await move(page, b1.caseId, "enquiry");
      await move(page, b1.caseId, "fact_find");
      const b2Rows = await tasksOf(page, b1.caseId);
      const dupes = pbTitles("fact_find", "purchase").filter((t) => b2Rows.filter((r) => r.title === t).length !== 1);
      eq("B2 · returning to a stage never writes a second copy of its steps", dupes, []);
      eq("B2 · …and the visit to Enquiry in between added the Enquiry steps once each",
        pbTitles("enquiry", "purchase").filter((t) => b2Rows.filter((r) => r.title === t).length !== 1), []);

      // B3 — the case modal's "Advance to…" button is the same path.
      const b3 = await mkClientCase(page, { first: "Advance", last: "Button", case_kind: "purchase", stage: "enquiry", assigned_to: "p2" });
      await openCase(page, b3.caseId);
      const advLabel = await page.$eval("#cs-advance-btn", (e) => e.textContent).catch(() => "");
      ok("B3 · the case modal offers Advance to the next stage", /Fact Find/i.test(advLabel), advLabel);
      await page.click("#cs-advance-btn");
      await wait(page, 900);
      /* R63 · H2 (merged in the same round): Advance into Fact Find on a case with no checklist now
         opens the document-checklist prompt first. "Skip — advance anyway" moves the case without
         writing a checklist — the playbook tasks below are H1b's, written on the move itself. */
      ok("B3 · the Fact Find checklist prompt (R63 · H2) opened on Advance", !!(await page.$("#se-skip")));
      await page.click("#se-skip").catch(() => {});
      await wait(page, 2200);
      eq("B3 · advancing from the modal writes the Fact Find steps",
        await openTitlesOf(page, b3.caseId), pbTitles("fact_find", "purchase"));
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      // B4 — kind gating survives the automatic path: a product transfer gets no valuation step.
      const b4 = await mkClientCase(page, { first: "PT", last: "NoValuation", case_kind: "product_transfer", stage: "decision_in_principle", assigned_to: "p2" });
      await move(page, b4.caseId, "application");
      const b4Titles = await openTitlesOf(page, b4.caseId);
      eq("B4 · product_transfer at Application gets exactly its two applicable steps",
        b4Titles, pbTitles("application", "product_transfer"));
      ok("B4 · …and nothing titled “Instruct valuation”", !b4Titles.includes("Instruct valuation"), JSON.stringify(b4Titles));
      // …while a buy-to-let at the same stage gets all four, ICR included.
      const b4b = await mkClientCase(page, { first: "BTL", last: "WithIcr", case_kind: "buy_to_let", stage: "decision_in_principle", assigned_to: "p2" });
      await move(page, b4b.caseId, "application");
      eq("B4 · buy_to_let at Application gets all four, ICR included",
        await openTitlesOf(page, b4b.caseId), pbTitles("application", "buy_to_let"));

      // B5 — Exchange: the two exchange steps and NOTHING titled "Chase solicitors…". That task is
      // production's own auto_stage_comms trigger's, on its own solicitor_chase_days timing.
      const b5 = await mkClientCase(page, { first: "Exch", last: "NoSolicitorChase", case_kind: "purchase", stage: "offer", assigned_to: "p2" });
      await move(page, b5.caseId, "exchange");
      const b5All = await openTitlesOf(page, b5.caseId);
      /* The mock now mirrors production's auto_stage_comms trigger (R63 · A2), which writes ONE
         "Chase solicitors for completion date" task at Exchange. That row is the trigger's, not
         this code's: it is set aside here, and its presence exactly once is asserted separately. */
      const b5Titles = b5All.filter((t) => !/^chase solicitors/i.test(t));
      eq("B5 · Exchange gets exactly its two playbook steps", b5Titles, pbTitles("exchange", "purchase"));
      eq("B5 · …and the trigger mirror wrote its solicitor-chase task exactly once (this code adds none)",
        b5All.filter((t) => /^chase solicitors/i.test(t)).length, 1);

      /* B6 — Not proceeding has no playbook entry, so a dead case gains nothing. The move asks for
         a reason first (R5-20's overlay), so the call is fired WITHOUT being awaited and the
         dialog is answered here — the same shape tests/r5_batch2.js uses for this flow. */
      const b6 = await mkClientCase(page, { first: "Dead", last: "NoTasks", case_kind: "purchase", stage: "fact_find", assigned_to: "p2" });
      const b6Before = (await tasksOf(page, b6.caseId)).length;
      await page.evaluate((id) => { window.__r63move = window.moveCaseToStage(id, "not_proceeding", {}); }, b6.caseId);
      await wait(page, 800);
      await page.selectOption("#lost-reason", "another_broker");
      await page.click("#lost-ok");
      await wait(page, 2000);
      const b6Stage = await page.evaluate(async (id) => (await window.__mockDb.from("cases").select("stage").eq("id", id).single()).data.stage, b6.caseId);
      eq("B6 · the case did move to Not proceeding", b6Stage, "not_proceeding");
      eq("B6 · …and moving there adds no tasks (there is no playbook for a dead case)",
        (await tasksOf(page, b6.caseId)).length, b6Before);

      // B7 — the bulk move writes the same rows, silently, and the batch summary tallies them.
      await goto(page, "pipeline", 1600);
      const isBoard = await page.evaluate(() => !document.querySelector("#board").classList.contains("hidden"));
      if (isBoard) { await page.click("#view-toggle"); await wait(page, 1200); }
      const bulkIds = [];
      for (const n of ["BulkOne", "BulkTwo"]) {
        const r = await mkClientCase(page, { first: "Bulk", last: n, case_kind: "purchase", stage: "enquiry", assigned_to: "p2" });
        bulkIds.push(r.caseId);
      }
      await goto(page, "pipeline", 1800);
      const selectable = await page.evaluate((ids) =>
        ids.filter((id) => !!document.querySelector(`#pipe-table .bulk-cb[data-id="${id}"]`)), bulkIds);
      eq("B7 · fixture — both new cases are selectable in the pipeline table", selectable.length, 2);
      for (const id of bulkIds) await page.check(`#pipe-table .bulk-cb[data-id="${id}"]`);
      page.__dialogs = [];
      await page.selectOption("#pipe-bulk-stage", "fact_find");
      await wait(page, 2600);
      for (const id of bulkIds) {
        eq(`B7 · bulk-moved case ${id === bulkIds[0] ? "1" : "2"} carries the Fact Find steps`,
          await openTitlesOf(page, id), pbTitles("fact_find", "purchase"));
      }
      const bulkToast = await toastText(page);
      ok("B7 · the batch summary tallies the tasks it wrote (6 = 2 cases × 3 steps)",
        /6 tasks added for Fact Find/i.test(bulkToast), bulkToast);

      ok("§B · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       §B2 · THE SETTING IS THE GATE — and it is on the Settings page, with a
             sentence saying what it does. Owner persona: only the Owner can
             write settings (RLS), and loadSettings() only re-reads through the
             Save button, which is the real path a firm would use.
       ======================================================================= */
    {
      console.log("\n— §B2 · playbook_auto_tasks: rendered, explained, and actually the gate (p4 owner)");
      const p4 = await newPage(browser, "p4");
      const errBefore = (p4.__err || []).length;
      await goto(p4, "settings", 1800);

      const setUi = await p4.evaluate(() => {
        const sel = document.querySelector('#settings-form [name="playbook_auto_tasks"]');
        const note = document.querySelector("#playbook-auto-note");
        return {
          present: !!sel,
          value: sel ? sel.value : null,
          options: sel ? Array.prototype.map.call(sel.options, (o) => o.value) : [],
          noteLen: note ? note.textContent.trim().length : 0,
          note: note ? note.textContent : "",
          heading: !!document.querySelector("#set-sec-stage-tasks"),
        };
      });
      ok("S1 · the Settings page renders the playbook_auto_tasks toggle", setUi.present, JSON.stringify(setUi));
      eq("S1 · …with on/off values, the house shape for a settings toggle", setUi.options.slice().sort(), ["off", "on"]);
      eq("S1 · …defaulting to ON", setUi.value, "on");
      ok("S1 · …under its own section heading", setUi.heading);
      ok("S2 · a .panel-sub explains exactly what it does", setUi.noteLen > 200, String(setUi.noteLen));
      ok("S2 · …naming BOTH moments it fires (lead accept and stage change)",
        /lead is accepted/i.test(setUi.note) && /reaches a new stage/i.test(setUi.note), setUi.note.slice(0, 220));
      ok("S2 · …and saying the “Chase solicitors” task is NOT one of them",
        /chase solicitors/i.test(setUi.note), setUi.note.slice(-260));

      // Turn it OFF through the real form, then prove nothing is written on a stage move.
      await p4.selectOption('#settings-form [name="playbook_auto_tasks"]', "off");
      await p4.click("#save-settings-btn");
      await wait(p4, 2000);
      const stored = await p4.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("value").eq("key", "playbook_auto_tasks").single();
        return data && data.value;
      });
      eq("S3 · saving stores 'off' as a prod-shaped on/off value", stored, "off");

      const s3 = await mkClientCase(p4, { first: "Gate", last: "Off", case_kind: "purchase", stage: "enquiry", assigned_to: "p2" });
      await move(p4, s3.caseId, "fact_find");
      eq("S3 · with the setting off, a stage move adds NOTHING", (await tasksOf(p4, s3.caseId)).length, 0);

      await openCase(p4, s3.caseId);
      const subOff = await p4.$eval("#stage-checklist-sub", (e) => e.textContent).catch(() => "");
      ok("S4 · …and the case's Stage checklist says so, and goes back to Advisory",
        /switched\s+off/i.test(subOff) && /Advisory/i.test(subOff), subOff);
      const addBtns = await p4.$$eval("#stage-checklist-items .playbook-add", (els) => els.length);
      eq("S4 · …with every step still offered by hand (R17's behaviour, intact)", addBtns, pbItems("fact_find", "purchase").length);
      await p4.evaluate(() => { if (window.closeModal) window.closeModal(); });

      // Back ON, and the same move now writes.
      await goto(p4, "settings", 1800);
      await p4.selectOption('#settings-form [name="playbook_auto_tasks"]', "on");
      await p4.click("#save-settings-btn");
      await wait(p4, 2000);
      const s5 = await mkClientCase(p4, { first: "Gate", last: "On", case_kind: "purchase", stage: "enquiry", assigned_to: "p2" });
      await move(p4, s5.caseId, "fact_find");
      eq("S5 · switched back on, the same move writes the Fact Find steps",
        await openTitlesOf(p4, s5.caseId), pbTitles("fact_find", "purchase"));

      await openCase(p4, s5.caseId);
      const subOn = await p4.$eval("#stage-checklist-sub", (e) => e.textContent).catch(() => "");
      ok("S6 · the Stage checklist copy now says the steps were added automatically on arrival",
        /added .*automatically/i.test(subOn) && /reached/i.test(subOn), subOn);
      ok("S6 · …and no longer claims “nothing is added until you press Add”",
        !/nothing is added until you press Add/i.test(subOn), subOn);
      const doneMarks = await p4.$$eval("#stage-checklist-items .playbook-done", (els) => els.length);
      eq("S6 · …every step showing as already added", doneMarks, pbItems("fact_find", "purchase").length);
      ok("S6 · …and “+ Add” survives for anything missing (the add-all button is gone here)",
        await p4.evaluate(() => !document.querySelector("#playbook-add-all")));
      await p4.evaluate(() => { if (window.closeModal) window.closeModal(); });

      ok("§B2 · no console errors", (p4.__err || []).length === errBefore, JSON.stringify(p4.__err));
      await p4.close();
    }

    /* =======================================================================
       §C · H1c — A STALE TASK IS NOT A NEXT ACTION.
       ======================================================================= */
    {
      console.log("\n— §C · Stale earlier-stage tasks: header, chip, radar (p2)");
      const errBefore = (page.__err || []).length;
      const today = await page.evaluate(() => localDateStr());
      const nowC = await page.evaluate(() => Date.now());

      // The predicate this whole section rests on, recomputed here.
      eq("C0 · fixture — “Submit DIP to lender” is a DIP step, i.e. earlier than Offer",
        stalePredicate("Submit DIP to lender", "offer"), true);
      eq("C0 · …“Check mortgage offer terms” at Offer is NOT stale", stalePredicate("Check mortgage offer terms", "offer"), false);
      eq("C0 · …and a hand-typed title is never stale", stalePredicate("Ring the client back", "offer"), false);

      // C1 — a case at Offer whose ONLY open task is a DIP step.
      const c1 = await mkClientCase(page, { first: "Stale", last: "OnlyOld", case_kind: "purchase", stage: "offer", assigned_to: "p2" });
      await addTask(page, c1.caseId, "Submit DIP to lender", dstr(nowC - 5 * DAY_MS), "p2");
      await openCase(page, c1.caseId);
      const c1Head = await page.$eval("#cs-task-val", (e) => e.textContent);
      ok("C1 · with nothing else open, the header still shows the stale task", /Submit DIP to lender/.test(c1Head), c1Head);
      ok("C1 · …labelled “(from an earlier stage)”", /\(from an earlier stage\)/.test(c1Head), c1Head);
      ok("C1 · …via its own hook, so the label is testable and tooltipped",
        await page.evaluate(() => !!document.querySelector("#cs-task-stale")));

      // C2 — the modal's task row carries the chip and a one-click Done that is the ordinary
      // complete-task action.
      const c2 = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#tasks-inline .row-item")];
        const stale = rows.filter((r) => r.classList.contains("task-stale-row"));
        const chip = document.querySelector("#tasks-inline .task-stale-chip");
        const btn = document.querySelector("#tasks-inline .task-stale-done");
        return {
          rows: rows.length, stale: stale.length,
          chipText: chip ? chip.textContent.trim() : null,
          btnText: btn ? btn.textContent.trim() : null,
          btnOnclick: btn ? btn.getAttribute("onclick") : null,
        };
      });
      eq("C2 · exactly one task row is flagged as an earlier-stage leftover", [c2.rows, c2.stale], [1, 1]);
      eq("C2 · …carrying the muted “earlier stage” chip", c2.chipText, "earlier stage");
      eq("C2 · …and a one-click Done", c2.btnText, "✓ Done");
      ok("C2 · …which is the EXISTING complete-task action (doneTaskInCase)",
        /^doneTaskInCase\(/.test(c2.btnOnclick || ""), String(c2.btnOnclick));
      await page.click("#tasks-inline .task-stale-done");
      await wait(page, 1400);
      const c2Done = (await tasksOf(page, c1.caseId)).every((t) => !!t.done_at);
      ok("C2 · pressing it closes the task", c2Done);
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      /* C3 — a NON-stale task is preferred over a stale one even when the stale one sorts first.
         The stale task is given the EARLIER due date on purpose: "the first open task" would pick
         it, so this can only pass because the header is choosing on staleness, not on order. */
      const c3 = await mkClientCase(page, { first: "Stale", last: "PlusFresh", case_kind: "purchase", stage: "offer", assigned_to: "p2" });
      await addTask(page, c3.caseId, "Submit DIP to lender", dstr(nowC - 5 * DAY_MS), "p2");
      await addTask(page, c3.caseId, "Check mortgage offer terms", today, "p2");
      await openCase(page, c3.caseId);
      const c3Head = await page.$eval("#cs-task-val", (e) => e.textContent);
      ok("C3 · the header shows the CURRENT-stage task, not the older stale one",
        /Check mortgage offer terms/.test(c3Head) && !/Submit DIP to lender/.test(c3Head), c3Head);
      ok("C3 · …with no “(from an earlier stage)” label on it", !/\(from an earlier stage\)/.test(c3Head), c3Head);
      const c3Chips = await page.$$eval("#tasks-inline .task-stale-chip", (els) => els.length);
      eq("C3 · …and only the leftover row is chipped", c3Chips, 1);
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      /* C4 — THE RADAR. Two quiet cases at Offer: one whose only open task is a DIP leftover, one
         with a real Offer task. Only the first belongs on the No-next-action list. */
      const c4stale = await mkQuietCase(page, { first: "Radar63", last: "StaleOnly", case_kind: "purchase", stage: "offer", assigned_to: "p2" });
      await addTask(page, c4stale.caseId, "Submit DIP to lender", dstr(nowC - 9 * DAY_MS), "p2");
      const c4fresh = await mkQuietCase(page, { first: "Radar63", last: "FreshTask", case_kind: "purchase", stage: "offer", assigned_to: "p2" });
      await addTask(page, c4fresh.caseId, "Check mortgage offer terms", today, "p2");
      await goto(page, "dashboard", 2000);
      const radar = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("C4 · a case whose ONLY open task is an earlier-stage leftover reaches the radar",
        radar.includes("Radar63 StaleOnly"), radar.slice(0, 400));
      ok("C4 · …while a case with a task for the stage it is actually at does NOT",
        !radar.includes("Radar63 FreshTask"), radar.slice(0, 400));
      const staleRow = await page.evaluate(() => {
        const row = [...document.querySelectorAll("#unactioned-list .row-item")]
          .find((r) => r.textContent.includes("Radar63 StaleOnly"));
        return row ? { cls: row.className, badge: (row.querySelector(".badge") || {}).textContent, txt: row.textContent } : null;
      });
      ok("C4 · …and the row says WHY it is here rather than claiming no task exists",
        !!staleRow && /only an earlier-stage task is open/i.test(staleRow.txt) && /STALE TASK ONLY/.test(staleRow.badge || ""),
        JSON.stringify(staleRow));

      // C5 — the 7-day activity threshold is untouched: a stale-only case that was touched
      // yesterday is still not on the list.
      const c5 = await mkQuietCase(page, { first: "Radar63", last: "StaleButTouched", case_kind: "purchase", stage: "offer", assigned_to: "p2" });
      await addTask(page, c5.caseId, "Submit DIP to lender", dstr(nowC - 9 * DAY_MS), "p2");
      await page.evaluate(({ id, when }) => window.__mockDb.from("case_notes")
        .insert({ case_id: id, body: "Rang them yesterday", created_at: when }),
        { id: c5.caseId, when: new Date(nowC - DAY_MS).toISOString() });
      await goto(page, "dashboard", 2000);
      const radar2 = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("C5 · the 7-day threshold is unchanged — a case touched yesterday stays off the radar",
        !radar2.includes("Radar63 StaleButTouched"), radar2.slice(0, 400));

      // C6 — nothing is stale at Enquiry (there is no earlier stage), and a current-stage step is
      // never stale however overdue.
      const c6 = await mkClientCase(page, { first: "Stale", last: "NeverAtEnquiry", case_kind: "purchase", stage: "enquiry", assigned_to: "p2" });
      await addTask(page, c6.caseId, "Qualify enquiry — budget, timeline, goal", dstr(nowC - 40 * DAY_MS), "p2");
      await openCase(page, c6.caseId);
      const c6Chips = await page.$$eval("#tasks-inline .task-stale-chip", (els) => els.length);
      eq("C6 · a 40-day-overdue CURRENT-stage step is not “stale” — it is just overdue", c6Chips, 0);
      const c6Head = await page.$eval("#cs-task-val", (e) => e.textContent);
      ok("C6 · …and the header shows it with no earlier-stage label", !/\(from an earlier stage\)/.test(c6Head), c6Head);
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      ok("§C · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       §D · M1 — THE LEAD ADVISER DEFAULT FOLLOWS MY DAY'S SCOPE.
       ======================================================================= */
    {
      console.log("\n— §D · Lead adviser default: me on Mine, lightest load on All (p2 / p1)");
      const errBefore = (page.__err || []).length;

      const d2 = await newPage(browser, "p2");
      await goto(d2, "dashboard", 1800);
      const readLead = (p) => p.evaluate(() => {
        const s = document.querySelector("#briefing-list select.lead-adviser[data-lead]");
        if (!s) return null;
        const note = document.querySelector(`.lead-rr[data-rr-for="${s.dataset.lead}"]`);
        return {
          lead: s.dataset.lead, value: s.value,
          selText: s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : "",
          optTexts: Array.prototype.map.call(s.options, (o) => o.text),
          noteTxt: note ? note.textContent : null,
          noteHidden: note ? note.classList.contains("hidden") : null,
          title: s.title,
        };
      });

      const mineState = await readLead(d2);
      eq("D1 · on Mine, an adviser's enquiry row defaults to THEM", mineState && mineState.value, "p2");
      ok("D1 · …with the “(me)” option label kept", /\(me\)/.test(mineState.selText), mineState.selText);
      ok("D1 · …and the hint says why", /defaulted to you — this is your feed/.test(mineState.noteTxt || ""), String(mineState.noteTxt));
      ok("D1 · …with the hint actually visible", mineState.noteHidden === false, JSON.stringify(mineState.noteHidden));
      ok("D1 · the lightest desk is still marked in the list, so nothing is hidden",
        mineState.optTexts.some((t) => /· lightest load/.test(t)), JSON.stringify(mineState.optTexts));
      ok("D1 · …and the tooltip names the scope this default comes from",
        /this is your feed/i.test(mineState.title) && /Mine/.test(mineState.title), mineState.title);

      // D2 — All: the R7-5 round-robin, exactly as before.
      await d2.click("#brief-scope-all");
      await wait(d2, 1800);
      const allState = await readLead(d2);
      ok("D2 · on All the default goes back to the lightest-load suggestion",
        /· lightest load/.test(allState.selText), JSON.stringify(allState));
      eq("D2 · …and the note is the lightest-load caption again", (allState.noteTxt || "").trim(), "(lightest load)");
      const rrIsMe = allState.value === "p2";
      ok("D2 · …computed from load, not from who is signed in (it may or may not be me)",
        typeof allState.value === "string" && allState.value.length > 0, JSON.stringify(allState.value));

      // D3 — and back to Mine, so this is a live consequence of the toggle, not a boot-time default.
      await d2.click("#brief-scope-mine");
      await wait(d2, 1800);
      const backState = await readLead(d2);
      eq("D3 · flipping back to Mine re-defaults the row to me", backState.value, "p2");
      ok("D3 · …hint back too", /defaulted to you/.test(backState.noteTxt || ""), String(backState.noteTxt));
      ok("D3 · (sanity — the two scopes really did differ)", rrIsMe === false || allState.selText !== backState.selText,
        `${allState.selText} vs ${backState.selText}`);

      // D4 — a human choice still wins over the default, on both scopes.
      await d2.selectOption(`#briefing-list select.lead-adviser[data-lead="${backState.lead}"]`, "p3");
      await wait(d2, 400);
      const chosen = await readLead(d2);
      eq("D4 · picking a colleague overrides the default", chosen.value, "p3");
      ok("D4 · …and the “defaulted to you” hint hides the moment it is overridden", chosen.noteHidden === true, JSON.stringify(chosen.noteHidden));
      ok("§D · no console errors (p2)", !(d2.__err || []).length, JSON.stringify(d2.__err));
      await d2.close();

      /* D5 — THE ADMIN EXCEPTION. Kim advises nobody; W-9's rule is that she is never the
         suggestion, and switching a scope toggle does not make her an adviser. */
      const d1 = await newPage(browser, "p1");
      await goto(d1, "dashboard", 1800);
      const adminAll = await readLead(d1);
      ok("D5 · admin on All: the lightest-load suggestion, as before",
        /· lightest load/.test(adminAll.selText) && adminAll.value !== "p1", JSON.stringify(adminAll));
      await d1.click("#brief-scope-mine");
      await wait(d1, 1800);
      const adminMine = await readLead(d1);
      eq("D5 · admin on Mine: STILL the lightest-load adviser, never the admin", adminMine.value, adminAll.value);
      ok("D5 · …and never themselves", adminMine.value !== "p1", adminMine.value);
      ok("D5 · …with the lightest-load caption, not the “your feed” one",
        !/defaulted to you/.test(adminMine.noteTxt || ""), String(adminMine.noteTxt));
      ok("§D · no console errors (p1)", !(d1.__err || []).length, JSON.stringify(d1.__err));
      await d1.close();

      ok("§D · no console errors (shared page)", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       §E · the shared page picked up no console error across the whole run.
       ======================================================================= */
    ok("§E · no console errors across the whole run", !(page.__err || []).length, JSON.stringify(page.__err));

  } catch (e) {
    failures.push("EXCEPTION: " + (e && e.stack ? e.stack : e));
    console.log("  ✗ EXCEPTION: " + (e && e.message ? e.message : e));
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r63_tasks: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
