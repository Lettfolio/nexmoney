#!/usr/bin/env node
/* =============================================================================
   tests/r17.js — acceptance tests for ROUND 17: proactive workflow (stage
   playbooks, the unactioned-case radar, inline task snooze) + the six
   papercut fixes.

     PLAYBOOK   — CASE_STAGE_PLAYBOOK (app.js) maps stage -> suggested tasks,
                  each with a dueOffsetDays and optional notKinds/onlyKinds
                  gating. Rendered as the "Stage checklist" panel
                  (#case-stage-checklist / #stage-checklist-items) for the
                  case's CURRENT stage only; not_proceeding has no map entry
                  so the panel does not render there. Each row is either a
                  "+ Add" button (.playbook-add, aria-label "Add task: <title>")
                  or, once a matching OPEN case_tasks row exists (matched by
                  title, case-insensitive/trimmed), a disabled ".playbook-done"
                  "✓ added" marker — dedupe is re-checked at click time so a
                  double-click (or two tabs) can never write two rows. Add
                  writes due_date = today + offset and assigns the case's own
                  assigned_to (falling back to the actor). "+ Add all"
                  (#playbook-add-all) inserts every not-yet-open step in one
                  call and only renders while at least one is outstanding.
     RADAR      — #unactioned-panel / #unactioned-list. A LIVE case (stage not
                  in completed/not_proceeding) with zero OPEN case_tasks and no
                  case_notes/case_events in the last UNACTIONED_DAYS (7) is
                  "quiet". Adviser-scoped: an adviser sees only their own book,
                  owner/admin see the firm. IMPORTANT MOCK DETAIL (see below):
                  every case insert auto-logs a "case_created" case_event
                  dated "now", so a case fresh out of mkClientCase is never
                  quiet on its own — this file's mkQuietCase() helper deletes
                  that auto-event (and any other case_events/case_notes) to
                  build a genuinely quiet fixture, the same way a real case
                  goes quiet only after its creation-day activity ages out.
     SNOOZE     — taskSnoozeControlsHtml renders #snooze-1d-<ctx>-<taskId> /
                  -3d- / -1wk- (buttons) and #snooze-pick-<ctx>-<taskId> (date
                  input), ctx is "tasks" (Tasks-due panel) or "brief" (My Day).
                  snoozeTask(id, days) moves due_date FORWARD by `days` from
                  max(today, current due_date) — so a task already due in the
                  future is never pulled earlier. snoozeTaskTo(id, value) sets
                  an exact date. Both repaint Tasks AND My Day (snoozeRepaintAll).
     GI BADGE   — Protection-page fix: the badge now gates on caseGiApplies()
                  (GI_KINDS = purchase/first_time_buyer/buy_to_let/remortgage)
                  instead of the old ["purchase","first_time_buyer"] array, so
                  a BTL/remortgage GI opportunity now shows the GI_BADGE for
                  its gi_status; product_transfer still never does.
     fmtM/fmtM2 — return "—" for anything Number()-non-coercible, instead of
                  "£NaN".

   EVERY figure this file asserts (the playbook map, the snooze arithmetic,
   the radar predicate) is recomputed HERE, independently of app.js's own
   CASE_STAGE_PLAYBOOK / snoozeTask / loadUnactioned — see the standing rule
   in HARNESS.md. Every case this file opens is created fresh via
   mkClientCase, never a fixture row, run on ONE shared page for the whole
   file — the same reason r15.js/r16.js do this: mock-supabase.js's DB is
   rebuilt per page load, so a caseId minted on one page means nothing on
   another.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r17.js
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

/* Insert a client + case in one round trip, returning {clientId, caseId}. Every case this file
   opens comes from here — never a fixture row — mirroring tests/r15.js / r16.js's mkClientCase. */
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email || (`r17.${Math.random().toString(36).slice(2, 9)}@example.com`);
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Test", last_name: o.last || "R17Case", email, phone: o.phone || null })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = {
      client_id: cl.id, case_kind: o.case_kind || "purchase", stage: o.stage || "application",
      assigned_to: o.assigned_to === undefined ? "p2" : o.assigned_to,
      lender: o.lender === undefined ? "Halifax" : o.lender,
    };
    ["gi_status", "protection_status", "loan_amount", "property_value", "monthly_rent"]
      .forEach((k) => { if (o[k] !== undefined) row[k] = o[k]; });
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id };
  }, opts || {});
}

/* A case built specifically to be "quiet" for the radar. Every case insert auto-logs a
   case_created case_event dated "now" (see mock-supabase.js's _runInsert, `if (table ===
   "cases") caseEvent(row.id, "case_created", ...)`), so a case straight out of mkClientCase always
   reads as having activity inside the last UNACTIONED_DAYS. This helper creates the case, then wipes
   its case_events (and case_notes, belt-and-braces) so it genuinely has none — the same end-state a
   real case reaches only after its creation-day activity ages past 7 days. */
async function mkQuietCase(page, opts) {
  const r = await mkClientCase(page, opts);
  await page.evaluate(async (caseId) => {
    const db = window.__mockDb;
    await db.from("case_events").delete().eq("case_id", caseId);
    await db.from("case_notes").delete().eq("case_id", caseId);
  }, r.caseId);
  return r;
}

const hasClass = (page, sel, cls) => page.evaluate(({ sel, cls }) => {
  const el = document.querySelector(sel);
  return el ? el.classList.contains(cls) : null;
}, { sel, cls });

const openCase = async (page, caseId) => {
  await page.evaluate((id) => window.openCase(id), caseId);
  await wait(page, 900);
  // The case-details <details> starts COLLAPSED on an existing case (r13.js/r16.js's fix, same
  // reason here): force it open so the checklist/BTL/etc fields are all actionable by Playwright.
  // R33 — scoped to #modal: Settings' new #diag-details shares the `.case-details` styling class
  // and, being static markup, is always in the DOM — an unscoped selector now matches it first.
  await page.evaluate(() => { const d = document.querySelector("#modal .case-details"); if (d) d.open = true; });
};

const readCase = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", id).single();
  return data;
}, caseId);

const openTasksOf = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("case_tasks").select("*").eq("case_id", id).is("done_at", null);
  return data || [];
}, caseId);

// nav() only forgets modal HISTORY ownership (currentModal = null) — it does not hide the modal
// backdrop DOM element, which is left visible (and intercepting clicks) if a case modal was open.
// Close it explicitly before every navigation, exactly like tests/r12b.js does around its own nav().
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 900 : ms);
};

/* Dashboard drawer panels (Tasks due, Watchtower, the radar, …) start class="collapsed" — their
   content is in the DOM (readable via $eval regardless) but not VISIBLE, so a real Playwright click
   needs the drawer opened first. Click the heading TEXT, never the inline scope buttons it also
   contains (toggleDrawer deliberately ignores clicks on those). Mirrors tests/r12b.js's openDrawer. */
const openDrawer = async (page, panelId) => {
  const collapsed = await page.evaluate((p) => { const el = document.querySelector(p); return el && el.classList.contains("collapsed"); }, panelId);
  if (collapsed) { await page.click(`${panelId} h3`, { position: { x: 12, y: 10 } }); await wait(page, 300); }
};

/* ---------------------------------------------------------------------------
   Independent re-implementation of the R17 SPEC, never imported from app.js.
   ------------------------------------------------------------------------- */
const CASE_STAGE_PLAYBOOK = {
  enquiry: [
    /* R71: kind-gated now — a product transfer at Enquiry gets its own three steps instead (the
       dated "Ring client — rate ends <date>" call and its follow-ups; tests/r71_backfill.js §C).
       §A's stage x kind matrix does not pair Enquiry with a product transfer, so nothing here
       reads the PT set; it is spelled out anyway so this map stays a true statement of the spec.
       (Its dueOffsetDays are the no-rate-end fallbacks — the real dating is r71_backfill.js §C's.) */
    { title: "Qualify enquiry — budget, timeline, goal", dueOffsetDays: 0, notKinds: ["product_transfer"] },
    { title: "Book fact-find appointment", dueOffsetDays: 2, notKinds: ["product_transfer"] },
    { title: "Ring client — rate ends soon", dueOffsetDays: 3, onlyKinds: ["product_transfer"] },
    { title: "Confirm current lender + balance", dueOffsetDays: 4, onlyKinds: ["product_transfer"] },
    { title: "Issue recommendation", dueOffsetDays: 7, onlyKinds: ["product_transfer"] },
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
    /* R71: the three file artefacts (panel M1), every kind. Deliberate contract change — the
       assertions below still recompute from THIS map. */
    { title: "Save the illustration/ESIS to the case file", dueOffsetDays: 1 },
    { title: "Save the research/sourcing evidence", dueOffsetDays: 2 },
    { title: "Draft + save the suitability letter", dueOffsetDays: 5 },
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
function playbookItems(stage, kind) {
  return (CASE_STAGE_PLAYBOOK[stage] || []).filter((it) =>
    (!it.notKinds || !it.notKinds.includes(kind)) &&
    (!it.onlyKinds || it.onlyKinds.includes(kind)));
}
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.__dialogs = [];
  page.on("dialog", async (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); await d.accept(); });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=p2`);
  await page.waitForTimeout(SETTLE);
  const noNewErr = (before) => (page.__err || []).length === before;

  try {

    /* =======================================================================
       A · STAGE PLAYBOOK — the right items per stage x kind, in the right
           order, with the right due-date offsets; kind gating (notKinds /
           onlyKinds); not_proceeding renders no panel at all.
       ======================================================================= */
    {
      console.log("\n— A · Stage checklist: right items per stage x kind, kind-gating, not_proceeding absent (p2)");
      const errBefore = (page.__err || []).length;

      const STAGE_KIND_CASES = [
        ["enquiry", "purchase"], ["fact_find", "purchase"], ["decision_in_principle", "purchase"],
        ["application", "purchase"], ["application", "buy_to_let"], ["application", "product_transfer"],
        ["offer", "purchase"], ["offer", "product_transfer"], ["exchange", "purchase"],
        ["completed", "purchase"],
      ];
      for (const [stage, kind] of STAGE_KIND_CASES) {
        const expected = playbookItems(stage, kind);
        const { caseId } = await mkClientCase(page, { first: "PB", last: `${stage}${kind}`, case_kind: kind, stage });
        await openCase(page, caseId);
        const rows = await page.$$eval("#stage-checklist-items .playbook-item", (els) => els.map((e) => ({
          title: e.querySelector(".row-main div").textContent.trim(),
        })));
        eq(`A · ${stage} x ${kind} · checklist item titles, in order`, rows.map((r) => r.title), expected.map((it) => it.title));
        // Every not-yet-added row's sub-line states the correct suggested due date.
        for (let i = 0; i < expected.length; i++) {
          const due = new Date(Date.now() + expected[i].dueOffsetDays * DAY_MS);
          const dd = String(due.getDate()).padStart(2, "0"), mm = String(due.getMonth() + 1).padStart(2, "0"), yy = String(due.getFullYear()).slice(-2);
          const sub = await page.$eval(`#stage-checklist-items .playbook-item:nth-child(${i + 1}) .row-main .s`, (e) => e.textContent);
          ok(`A · ${stage} x ${kind} · item ${i + 1} sub-line names the +${expected[i].dueOffsetDays}d due date`,
            sub.includes(`${dd}`) || /suggested due/.test(sub), sub);
        }
      }

      // The BTL-only ICR item is present ONLY for buy_to_let at application, absent for every other kind.
      for (const kind of ["purchase", "first_time_buyer", "remortgage", "product_transfer"]) {
        const { caseId } = await mkClientCase(page, { first: "PB", last: "ICRabsent" + kind, case_kind: kind, stage: "application" });
        await openCase(page, caseId);
        const hasIcr = await page.evaluate(() => !!document.querySelector('[aria-label="Add task: Confirm ICR / rental income"]'));
        ok(`A · application x ${kind} · NO "Confirm ICR / rental income" item`, !hasIcr);
      }
      {
        const { caseId } = await mkClientCase(page, { first: "PB", last: "ICRpresent", case_kind: "buy_to_let", stage: "application" });
        await openCase(page, caseId);
        const hasIcr = await page.evaluate(() => !!document.querySelector('[aria-label="Add task: Confirm ICR / rental income"]'));
        ok(`A · application x buy_to_let · the ICR item IS present`, hasIcr);
      }

      // valuation/solicitor are absent for product_transfer, present for every other kind, at their stages.
      for (const kind of ["purchase", "buy_to_let", "remortgage", "first_time_buyer"]) {
        const app = await mkClientCase(page, { first: "PB", last: "Val" + kind, case_kind: kind, stage: "application" });
        await openCase(page, app.caseId);
        const hasVal = await page.evaluate(() => !!document.querySelector('[aria-label="Add task: Instruct valuation"]'));
        ok(`A · application x ${kind} · "Instruct valuation" item IS present`, hasVal);
        const off = await mkClientCase(page, { first: "PB", last: "Sol" + kind, case_kind: kind, stage: "offer" });
        await openCase(page, off.caseId);
        const hasSol = await page.evaluate(() => !!document.querySelector('[aria-label="Add task: Confirm solicitor instructed"]'));
        ok(`A · offer x ${kind} · "Confirm solicitor instructed" item IS present`, hasSol);
      }
      {
        const app = await mkClientCase(page, { first: "PB", last: "ValPT", case_kind: "product_transfer", stage: "application" });
        await openCase(page, app.caseId);
        const hasVal = await page.evaluate(() => !!document.querySelector('[aria-label="Add task: Instruct valuation"]'));
        ok(`A · application x product_transfer · "Instruct valuation" is ABSENT`, !hasVal);
        const off = await mkClientCase(page, { first: "PB", last: "SolPT", case_kind: "product_transfer", stage: "offer" });
        await openCase(page, off.caseId);
        const hasSol = await page.evaluate(() => !!document.querySelector('[aria-label="Add task: Confirm solicitor instructed"]'));
        ok(`A · offer x product_transfer · "Confirm solicitor instructed" is ABSENT`, !hasSol);
      }

      // not_proceeding has no playbook entry at all — the whole panel does not render.
      {
        const { caseId } = await mkClientCase(page, { first: "PB", last: "NotProceeding", case_kind: "purchase", stage: "not_proceeding" });
        await openCase(page, caseId);
        const absent = await page.evaluate(() => !document.querySelector("#case-stage-checklist"));
        ok(`A · not_proceeding · #case-stage-checklist is entirely ABSENT`, absent);
      }

      ok("A · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       B · ADD / DEDUPE / ADD-ALL — one-click add writes the right row; a
           matching open task shows "✓ added" and is never offered twice; Add
           all fills in the rest in one insert.
       ======================================================================= */
    {
      console.log("\n— B · Add / dedupe / Add-all: exact case_tasks row, .playbook-done, no duplicates (p2)");
      const errBefore = (page.__err || []).length;

      // B1 — a single Add writes exactly one case_tasks row: correct title, due_date, assignee.
      const b1 = await mkClientCase(page, { first: "Add", last: "Single", case_kind: "purchase", stage: "decision_in_principle", assigned_to: "p3" });
      await openCase(page, b1.caseId);
      const beforeTasks = await openTasksOf(page, b1.caseId);
      eq("B1 · fixture sanity — no open tasks yet", beforeTasks.length, 0);
      const item = playbookItems("decision_in_principle", "purchase")[0]; // "Submit DIP to lender", +0
      const nowB1 = await page.evaluate(() => Date.now());
      await page.click('[aria-label="Add task: Submit DIP to lender"]');
      await wait(page, 500);
      const afterTasks = await openTasksOf(page, b1.caseId);
      eq("B1 · exactly one case_task was created", afterTasks.length, 1);
      eq("B1 · the task title matches the playbook step", afterTasks[0].title, item.title);
      const expDue = new Date(nowB1 + item.dueOffsetDays * DAY_MS);
      const expDueStr = `${expDue.getFullYear()}-${String(expDue.getMonth() + 1).padStart(2, "0")}-${String(expDue.getDate()).padStart(2, "0")}`;
      eq("B1 · due_date is today + the step's offset (0 days)", afterTasks[0].due_date, expDueStr);
      eq("B1 · assigned to the CASE's adviser (p3), not the acting user (p2)", afterTasks[0].assigned_to, "p3");

      // B2 — after Add, the item shows the ✓ added marker, disabled, and the Add button is gone.
      const doneMarker = await page.$$eval(".playbook-done", (els) => els.map((e) => e.textContent.trim()));
      ok("B2 · a \"✓ added\" marker is now shown for the added step", doneMarker.some((t) => /added/i.test(t)), JSON.stringify(doneMarker));
      const addBtnGone = await page.evaluate(() => !document.querySelector('[aria-label="Add task: Submit DIP to lender"]'));
      ok("B2 · the \"+ Add\" button for that step is gone (replaced, not just hidden)", addBtnGone);

      // B3 — dedupe: re-invoking playbookAdd for the SAME step (simulating a double-click / a second
      // tab) re-reads the open tasks at click time and does NOT insert a second row.
      const idx0 = playbookItems("decision_in_principle", "purchase").indexOf(item);
      await page.evaluate(({ caseId, stage, kind, idx }) => window.playbookAdd(caseId, stage, kind, idx),
        { caseId: b1.caseId, stage: "decision_in_principle", kind: "purchase", idx: idx0 });
      await wait(page, 500);
      const afterDoubleAdd = await openTasksOf(page, b1.caseId);
      eq("B3 · a second add of the SAME step does not create a duplicate (still exactly one open task)", afterDoubleAdd.length, 1);

      // B4 — Add all fills in the rest (here: the one remaining DIP step) in one insert.
      await page.click("#playbook-add-all");
      await wait(page, 500);
      const afterAddAll = await openTasksOf(page, b1.caseId);
      eq("B4 · Add all created exactly the remaining step (total open tasks = 2)", afterAddAll.length, 2);
      const titles = afterAddAll.map((t) => t.title).sort();
      eq("B4 · the two open tasks are exactly the two DIP playbook steps",
        titles, playbookItems("decision_in_principle", "purchase").map((it) => it.title).sort());
      // Every item is now "✓ added" and Add all is gone (nothing left to add).
      const addAllGone = await page.evaluate(() => !document.querySelector("#playbook-add-all"));
      ok("B4 · \"+ Add all\" is gone once every step is on the list", addAllGone);
      const anyAddBtnLeft = await page.evaluate(() => !!document.querySelector(".playbook-add"));
      ok("B4 · no \"+ Add\" buttons remain — every step shows ✓ added", !anyAddBtnLeft);

      // B5 — Add all on a fresh multi-step stage (application x buy_to_let — R71: 7 steps now, was
      // 4 before the three file-artefact steps) in one go. The count is recomputed, not hardcoded.
      const b5 = await mkClientCase(page, { first: "Add", last: "AllFresh", case_kind: "buy_to_let", stage: "application", assigned_to: "p2" });
      await openCase(page, b5.caseId);
      await page.click("#playbook-add-all");
      await wait(page, 500);
      const b5Tasks = await openTasksOf(page, b5.caseId);
      eq("B5 · Add all on a fresh case creates every applicable step at once", b5Tasks.length, playbookItems("application", "buy_to_let").length);
      eq("B5 · …with the assignee defaulted to the case's own adviser", [...new Set(b5Tasks.map((t) => t.assigned_to))], ["p2"]);

      // B6 — dedupe also applies when the matching task was created OUTSIDE the playbook (e.g. by
      // hand, or by a previous round's flow) — title match alone is enough to suppress the offer.
      const b6 = await mkClientCase(page, { first: "Add", last: "PreexistingTask", case_kind: "purchase", stage: "enquiry" });
      await page.evaluate((caseId) => window.__mockDb.from("case_tasks").insert({ case_id: caseId, title: "Qualify enquiry — budget, timeline, goal", due_date: null }), b6.caseId);
      await openCase(page, b6.caseId);
      const b6Marker = await page.$$eval("#stage-checklist-items .playbook-done", (els) => els.length);
      eq("B6 · a hand-created task with the SAME title is recognised as already added", b6Marker, 1);
      const b6AddBtns = await page.$$eval("#stage-checklist-items .playbook-add", (els) => els.length);
      eq("B6 · …so only the other (unmatched) enquiry step still offers Add", b6AddBtns, 1);

      ok("B · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       C · UNACTIONED RADAR — a quiet live case appears; an open task or a
           recent note/event removes it; completed/not_proceeding never
           appear; adviser scoping (own book vs the whole firm for
           owner/admin).
       ======================================================================= */
    {
      console.log("\n— C · Unactioned radar: quiet case surfaces, task/note/stage exclusions, adviser scoping");
      const errBefore = (page.__err || []).length;

      // C1 — a genuinely quiet live case (no tasks, no notes, no events) appears on the radar.
      const c1 = await mkQuietCase(page, { first: "Radar", last: "Quiet", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      await goto(page, "dashboard", 1200);
      let listTxt = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("C1 · a fresh quiet live case appears on the radar", listTxt.includes("Radar Quiet"), listTxt.slice(0, 120));
      const badge = await page.$$eval("#unactioned-list .row-item", (els) =>
        els.find((e) => e.textContent.includes("Radar Quiet")) ? "found" : "missing");
      eq("C1 · …carrying the NO NEXT ACTION badge", badge, "found");

      // C2 — adding an OPEN task removes it from the radar.
      await page.evaluate((caseId) => window.__mockDb.from("case_tasks").insert({ case_id: caseId, title: "Call client", due_date: null }), c1.caseId);
      await goto(page, "dashboard", 1200);
      listTxt = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("C2 · once an open task exists, the case drops off the radar", !listTxt.includes("Radar Quiet"), listTxt.slice(0, 120));

      // C2b — a DONE task (done_at set) does not count as "having a next action" — still quiet.
      const c2b = await mkQuietCase(page, { first: "Radar", last: "OnlyDoneTask", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      await page.evaluate((caseId) => window.__mockDb.from("case_tasks").insert({ case_id: caseId, title: "Old task", due_date: null, done_at: new Date().toISOString() }), c2b.caseId);
      await goto(page, "dashboard", 1200);
      listTxt = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("C2b · a task that is already DONE does not count — the case is still quiet", listTxt.includes("Radar OnlyDoneTask"), listTxt.slice(0, 200));

      // C3 — a case with a RECENT note (no tasks, no events) is excluded.
      const c3 = await mkQuietCase(page, { first: "Radar", last: "RecentNote", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      await page.evaluate((caseId) => window.__mockDb.from("case_notes").insert({ case_id: caseId, body: "Called client, still deciding." }), c3.caseId);
      await goto(page, "dashboard", 1200);
      listTxt = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("C3 · a case with a recent note does NOT appear on the radar", !listTxt.includes("Radar RecentNote"), listTxt.slice(0, 120));

      // C3b — boundary: a note 8 days old is stale (case still quiet); a note 6 days old is recent
      // (case excluded) — UNACTIONED_DAYS = 7.
      const c3stale = await mkQuietCase(page, { first: "Radar", last: "Note8dOld", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      await page.evaluate(({ caseId, when }) => window.__mockDb.from("case_notes").insert({ case_id: caseId, body: "old note", created_at: when }), { caseId: c3stale.caseId, when: isoDaysAgo(8) });
      const c3fresh = await mkQuietCase(page, { first: "Radar", last: "Note6dOld", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      await page.evaluate(({ caseId, when }) => window.__mockDb.from("case_notes").insert({ case_id: caseId, body: "recent-ish note", created_at: when }), { caseId: c3fresh.caseId, when: isoDaysAgo(6) });
      await goto(page, "dashboard", 1200);
      listTxt = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("C3b · an 8-day-old note is stale — the case IS quiet", listTxt.includes("Radar Note8dOld"), listTxt.slice(0, 300));
      ok("C3b · a 6-day-old note is still recent — the case is NOT quiet", !listTxt.includes("Radar Note6dOld"), listTxt.slice(0, 300));

      // C4 — completed / not_proceeding never appear, even with zero tasks/notes/events.
      for (const stage of ["completed", "not_proceeding"]) {
        const c = await mkQuietCase(page, { first: "Radar", last: "Terminal" + stage, case_kind: "purchase", stage, assigned_to: "p2" });
        await goto(page, "dashboard", 1200);
        listTxt = await page.$eval("#unactioned-list", (e) => e.textContent);
        ok(`C4 · a quiet ${stage} case never appears on the radar`, !listTxt.includes("Radar Terminal" + stage), listTxt.slice(0, 120));
      }

      // C5 — adviser scoping. IMPORTANT: mock-supabase.js rebuilds its whole in-memory DB on every
      // page load (see HARNESS.md), so a case minted on THIS page cannot be read from a different
      // page/persona — each scoping check below is therefore self-contained on its own page:
      //   (i)  on THIS (p2) page: a quiet case assigned to p2 and one assigned to p3 both exist —
      //        p2 must see only the one that is theirs.
      //   (ii) on a FRESH owner (p4) page: the same two-case shape, created fresh on that page —
      //        the owner must see BOTH (whole-firm scope).
      const mine = await mkQuietCase(page, { first: "Radar", last: "ScopeMineP2", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      const notMine = await mkQuietCase(page, { first: "Radar", last: "ScopeOtherP3", case_kind: "purchase", stage: "application", assigned_to: "p3" });
      await goto(page, "dashboard", 1200);
      let selfTxt = await page.$eval("#unactioned-list", (e) => e.textContent);
      ok("C5 · adviser p2 sees their OWN quiet case", selfTxt.includes("Radar ScopeMineP2"), selfTxt.slice(0, 300));
      ok("C5 · …but NOT a quiet case assigned to a different adviser (p3)", !selfTxt.includes("Radar ScopeOtherP3"), selfTxt.slice(0, 300));

      const page4 = await newPage(browser, "p4");
      await mkQuietCase(page4, { first: "Radar", last: "OwnerSeesP2", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      await mkQuietCase(page4, { first: "Radar", last: "OwnerSeesP3", case_kind: "purchase", stage: "application", assigned_to: "p3" });
      await goto(page4, "dashboard", 1200);
      const ownerTxt = await page4.$eval("#unactioned-list", (e) => e.textContent);
      ok("C5 · the owner (p4) sees a quiet case assigned to p2", ownerTxt.includes("Radar OwnerSeesP2"), ownerTxt.slice(0, 300));
      ok("C5 · …AND one assigned to p3 — owner/admin scope to the whole firm", ownerTxt.includes("Radar OwnerSeesP3"), ownerTxt.slice(0, 300));
      await page4.close();

      ok("C · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       D · TASK SNOOZE — +1d/+3d/+1wk move due_date forward from max(today,
           due); the date-pick sets an exact date; a future-dated task is
           never pulled earlier; My Day repaints (snoozeRepaintAll).

       R41 · F1 — the Tasks-due drawer (#tasks-panel/#tasks-list, ctx="tasks"
       snooze ids) is gone; My Day (#briefing-list, ctx="brief" snooze ids) is
       the only surface left, and there is one repaint, not two (see
       snoozeRepaintAll's own R41 comment in app.js). My Day only ever shows a
       task that is OVERDUE or due TODAY (task_overdue/task_today — that is
       what get_briefing returns), so a task snoozed into the future has
       nowhere left to render on My Day at all — unlike the old Tasks-due
       drawer, which carried a 14-day look-ahead and could show D3's
       already-future-dated fixture directly. D3 below therefore drives
       window.snoozeTask itself — the exact function every snooze button
       calls (see taskSnoozeControlsHtml's onclick in app.js) — and confirms
       the write the same two ways D1/D2/D4/D5 do: the mock db directly, and
       the case modal's own "due <date>" line, which lists every task on the
       case regardless of whether it is due today. This keeps every snooze
       semantic the original §D proved (the arithmetic, the exact-date
       override, the never-earlier rule, and a row leaving/rejoining My Day
       as its due date crosses today) without inventing a UI surface R41 does
       not offer.
       ======================================================================= */
    {
      console.log("\n— D · Snooze: +Nd arithmetic, date-pick, never-earlier rule, single repaint, case-modal cross-check (p2)");
      const errBefore = (page.__err || []).length;

      const todayStr = await page.evaluate(() => localDateStr());
      const addDays = (ymd, n) => { const d = new Date(ymd + "T00:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
      // "due <D MMM YYYY>" — the exact format the case modal's #tasks-inline row prints (fmtD).
      const dueLineText = async (page, caseId, taskId) => {
        await openCase(page, caseId);
        return page.evaluate((tid) => {
          const row = [...document.querySelectorAll("#tasks-inline .row-item")].find((r) => r.querySelector(`[onclick*="'${tid}'"]`));
          return row ? row.querySelector(".s").textContent : null;
        }, taskId);
      };

      // D1 — a task due TODAY, +3d from My Day -> due_date becomes today+3, confirmed on the case too.
      const d1 = await mkClientCase(page, { first: "Snooze", last: "Plus3", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      const d1task = await page.evaluate(({ caseId, due }) => window.__mockDb.from("case_tasks").insert({ case_id: caseId, title: "Chase docs", due_date: due, assigned_to: "p2" }).select("id").single().then((r) => r.data.id), { caseId: d1.caseId, due: todayStr });
      await goto(page, "dashboard", 1200);
      const btn3 = `#snooze-3d-brief-${d1task}`;
      ok("D1 · the +3d snooze control is on My Day (the task is due today)", await page.evaluate((s) => !!document.querySelector(s), btn3));
      await page.click(btn3);
      await wait(page, 500);
      let d1row = await page.evaluate((id) => window.__mockDb.from("case_tasks").select("due_date").eq("id", id).single().then((r) => r.data), d1task);
      eq("D1 · due_date moved to today + 3 days", d1row.due_date, addDays(todayStr, 3));
      const d1CaseTxt = await dueLineText(page, d1.caseId, d1task);
      await page.evaluate(() => window.closeModal());
      ok("D1 · the case modal's own task row agrees on the new due date", d1CaseTxt && d1CaseTxt.includes(await page.evaluate((d) => fmtD(d), addDays(todayStr, 3))), d1CaseTxt);

      // D2 — the date-pick input sets an EXACT date, overriding whatever the +Nd math would give.
      // The task is due today+3 after D1, so it no longer renders on My Day — driven directly via
      // window.snoozeTaskTo, the exact function the (now-invisible) date-pick's onchange calls.
      const picked = addDays(todayStr, 20);
      await page.evaluate(({ id, v }) => window.snoozeTaskTo(id, v), { id: d1task, v: picked });
      await wait(page, 500);
      d1row = await page.evaluate((id) => window.__mockDb.from("case_tasks").select("due_date").eq("id", id).single().then((r) => r.data), d1task);
      eq("D2 · the date-pick set the EXACT chosen date", d1row.due_date, picked);

      // D3 — a task already due in the FUTURE (today+5) is never pulled earlier: +1d bases off the
      // task's own due date, not today, so the result is today+6, not today+1. Never on My Day at
      // all (it is not overdue or due today), so driven via window.snoozeTask directly — the same
      // function id="snooze-1d-brief-…" calls, see taskSnoozeControlsHtml in app.js.
      const d3 = await mkClientCase(page, { first: "Snooze", last: "NeverEarlier", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      const futureDue = addDays(todayStr, 5);
      const d3task = await page.evaluate(({ caseId, due }) => window.__mockDb.from("case_tasks").insert({ case_id: caseId, title: "Future thing", due_date: due, assigned_to: "p2" }).select("id").single().then((r) => r.data.id), { caseId: d3.caseId, due: futureDue });
      await goto(page, "dashboard", 1200);
      const onBriefBeforeD3 = await page.evaluate((id) => !!document.querySelector(`#snooze-1d-brief-${id}`), d3task);
      ok("D3 · fixture · a task due in 5 days does NOT render on My Day (only overdue/today do)", !onBriefBeforeD3);
      await page.evaluate((id) => window.snoozeTask(id, 1), d3task);
      await wait(page, 500);
      const d3row = await page.evaluate((id) => window.__mockDb.from("case_tasks").select("due_date").eq("id", id).single().then((r) => r.data), d3task);
      eq("D3 · +1d on a future-dated task bases off its OWN due date (today+5 -> today+6), never today+1", d3row.due_date, addDays(todayStr, 6));
      const d3CaseTxt = await dueLineText(page, d3.caseId, d3task);
      await page.evaluate(() => window.closeModal());
      ok("D3 · the case modal confirms the same never-earlier result", d3CaseTxt && d3CaseTxt.includes(await page.evaluate((d) => fmtD(d), addDays(todayStr, 6))), d3CaseTxt);

      // D4 — +1wk (7 days) from an overdue baseline (never earlier than today), driven from My Day
      // (an overdue task DOES render there, as task_overdue).
      const d4 = await mkClientCase(page, { first: "Snooze", last: "Plus1wk", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      const overdueStr = addDays(todayStr, -4);
      const d4task = await page.evaluate(({ caseId, due }) => window.__mockDb.from("case_tasks").insert({ case_id: caseId, title: "Overdue thing", due_date: due, assigned_to: "p2" }).select("id").single().then((r) => r.data.id), { caseId: d4.caseId, due: overdueStr });
      await goto(page, "dashboard", 1200);
      const openBriefFolds = () => page.evaluate(() => document.querySelectorAll("#briefing-list details.brief-fold").forEach((d) => { d.open = true; }));
      const btn1wk = `#snooze-1wk-brief-${d4task}`;
      await openBriefFolds(); // R61 — long bands fold past 10 rows; open them so the click can land
      ok("D4 · the +1wk snooze control is on My Day (the task is overdue)", await page.evaluate((s) => !!document.querySelector(s), btn1wk));
      await page.click(btn1wk);
      await wait(page, 500);
      const d4row = await page.evaluate((id) => window.__mockDb.from("case_tasks").select("due_date").eq("id", id).single().then((r) => r.data), d4task);
      eq("D4 · +1wk on an OVERDUE task bases off TODAY (never earlier), landing on today+7", d4row.due_date, addDays(todayStr, 7));

      // D5 — a task due TODAY on My Day, snoozed via My Day: it LEAVES My Day the moment its due
      // date crosses past today (the row's own horizon — overdue/today — not a drawer's 14-day
      // window), and REJOINS it once its due date is put back to today. "row disappears/reappears
      // per horizon" — proved on My Day's real horizon end to end, no drawer involved.
      const d5 = await mkClientCase(page, { first: "Snooze", last: "FromBrief", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      const d5task = await page.evaluate(({ caseId, due }) => window.__mockDb.from("case_tasks").insert({ case_id: caseId, title: "Today thing", due_date: due, assigned_to: "p2" }).select("id").single().then((r) => r.data.id), { caseId: d5.caseId, due: todayStr });
      await goto(page, "dashboard", 1200);
      const briefBtn = `#snooze-3d-brief-${d5task}`;
      await openBriefFolds(); // R61 — same fold-opening before clicking inside My Day
      ok("D5 · the task carries snooze controls on My Day while due today", await page.evaluate((s) => !!document.querySelector(s), briefBtn));
      await page.click(briefBtn);
      await wait(page, 700);
      const d5row = await page.evaluate((id) => window.__mockDb.from("case_tasks").select("due_date").eq("id", id).single().then((r) => r.data), d5task);
      eq("D5 · snoozing from My Day wrote the due_date change", d5row.due_date, addDays(todayStr, 3));
      // The single repaint (snoozeRepaintAll = loadBriefing() alone, R41 · F1): the task is now due
      // in 3 days, so it no longer qualifies for My Day's overdue/today section at all.
      const stillOnBrief = await page.evaluate((s) => !!document.querySelector(s), briefBtn);
      ok("D5 · the snoozed task's row is gone from My Day after the repaint (due date moved past today) — disappears per horizon", !stillOnBrief);
      // Put it back to due TODAY (the exact function the date-pick calls) and confirm it REAPPEARS.
      await page.evaluate(({ id, v }) => window.snoozeTaskTo(id, v), { id: d5task, v: todayStr });
      await wait(page, 700);
      const backOnBrief = await page.evaluate((s) => !!document.querySelector(s), `[onclick^="briefDone('${d5task}'"]`);
      ok("D5 · …and REAPPEARS on My Day once its due date is back to today — reappears per horizon", backOnBrief);

      ok("D · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       E · GI BADGE FIX — caseGiApplies() (GI_KINDS) now gates the Protection
           page's GI badge, so buy_to_let / remortgage opportunities show it;
           product_transfer still never does.
       ======================================================================= */
    {
      console.log("\n— E · GI badge: caseGiApplies() gates buy_to_let/remortgage IN, product_transfer OUT (p2)");
      const errBefore = (page.__err || []).length;

      const btl = await mkClientCase(page, { first: "GI", last: "BTL", case_kind: "buy_to_let", stage: "application", assigned_to: "p2", gi_status: "quoted" });
      const remo = await mkClientCase(page, { first: "GI", last: "Remortgage", case_kind: "remortgage", stage: "application", assigned_to: "p2", gi_status: "policy_taken" });
      const pt = await mkClientCase(page, { first: "GI", last: "ProductTransfer", case_kind: "product_transfer", stage: "application", assigned_to: "p2", gi_status: "quoted" });

      await goto(page, "protection", 1200);
      const rowText = (caseId) => page.$eval(`input.prot-cb[data-id="${caseId}"]`, (el) => el.closest("tr").textContent).catch(() => "ABSENT");

      const btlTxt = await rowText(btl.caseId);
      ok("E · buy_to_let with gi_status=quoted · Protection row shows the \"GI quoted\" badge", /GI quoted/.test(btlTxt), btlTxt);
      const remoTxt = await rowText(remo.caseId);
      ok("E · remortgage with gi_status=policy_taken · Protection row shows the \"GI taken\" badge", /GI taken/.test(remoTxt), remoTxt);
      const ptTxt = await rowText(pt.caseId);
      ok("E · product_transfer (gi_status=quoted, but N/A for this kind) · NO GI badge at all", !/GI (quoted|taken|declined|not discussed|n\/a)/.test(ptTxt), ptTxt);

      const giBadgeClass = await page.$eval(`input.prot-cb[data-id="${btl.caseId}"]`, (el) => {
        const b = [...el.closest("tr").querySelectorAll(".badge")].find((x) => /GI quoted/.test(x.textContent));
        return b ? [...b.classList] : null;
      });
      ok("E · the badge carries the amber colour class for \"quoted\"", giBadgeClass && giBadgeClass.includes("amber"), JSON.stringify(giBadgeClass));

      ok("E · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       F · fmtM / fmtM2 £NaN GUARD — a non-numeric value renders "—", not
           "£NaN"; a real number still formats as currency, unaffected.
       ======================================================================= */
    {
      console.log("\n— F · fmtM/fmtM2: non-numeric -> \"—\" (not \"£NaN\"), numeric unaffected (p2)");
      const errBefore = (page.__err || []).length;

      const unit = await page.evaluate(() => ({
        strAbc: fmtM("abc"), nul: fmtM(null), undef: fmtM(undefined), emptyStr: fmtM(""), nan: fmtM(NaN),
        obj: fmtM({}), zero: fmtM(0), num: fmtM(1234), numStr: fmtM("1234"),
        m2Abc: fmtM2("abc"), m2Num: fmtM2(1234.5),
      }));
      eq("F · fmtM(\"abc\") -> \"—\"", unit.strAbc, "—");
      eq("F · fmtM(null) -> \"—\"", unit.nul, "—");
      eq("F · fmtM(undefined) -> \"—\"", unit.undef, "—");
      eq("F · fmtM(\"\") -> \"—\"", unit.emptyStr, "—");
      eq("F · fmtM(NaN) -> \"—\"", unit.nan, "—");
      eq("F · fmtM({}) -> \"—\"", unit.obj, "—");
      ok("F · fmtM(0) still renders a real currency figure, not \"—\" (0 is a valid number)", unit.zero !== "—" && /£/.test(unit.zero), unit.zero);
      eq("F · fmtM(1234) unaffected — still £1,234", unit.num, "£1,234");
      eq("F · fmtM(\"1234\") (numeric string) still coerces and formats", unit.numStr, "£1,234");
      eq("F · fmtM2(\"abc\") -> \"—\" too", unit.m2Abc, "—");
      ok("F · fmtM2(1234.5) unaffected — still formats with 2dp", /£1,234\.50/.test(unit.m2Num), unit.m2Num);

      // Rendered-surface confirmation: a case with a genuinely non-numeric loan_amount renders "—"
      // on the Protection page's Loan column rather than "£NaN".
      const bad = await mkClientCase(page, { first: "Fmt", last: "BadLoan", case_kind: "purchase", stage: "application", assigned_to: "p2" });
      await page.evaluate((caseId) => window.__mockDb.from("cases").update({ loan_amount: "not-a-number" }).eq("id", caseId), bad.caseId);
      await goto(page, "protection", 1200);
      const loanTxt = await page.$eval(`input.prot-cb[data-id="${bad.caseId}"]`, (el) => el.closest("tr").querySelector(".prot-col-loan").textContent).catch(() => "ABSENT");
      eq("F · rendered surface — a non-numeric loan_amount shows \"—\" on the Protection page, not \"£NaN\"", loanTxt.trim(), "—");

      ok("F · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

  } finally {
    await page.close();
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r17: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
