#!/usr/bin/env node
/* =============================================================================
   tests/r71_backfill.js — acceptance tests for ROUND 71 agent A, "back-fill the
   book": the two Pipeline bulk verbs that put work onto cases nobody ever
   walked through the app, plus the two playbook changes that decide WHAT that
   work is for a product transfer and for a case at Application.

   THE DEFECT THIS ROUND IS ABOUT. Playbook tasks are written at exactly two
   moments (a lead is accepted, a case reaches a new stage) and a document
   checklist at exactly one (the Fact Find stage-entry prompt). All three are
   moments a case PASSES THROUGH — and the 2,015 cases in production did not
   pass through anything, they were imported from a spreadsheet. 127 of the 134
   live cases carry no open task, none has a checklist, and the whole document
   machine points at an empty set. On top of that, the 105 imported Enquiry
   cases are product transfers being handed the website-lead script ("qualify
   the enquiry", "book a fact-find"), and no playbook step anywhere named the
   three file artefacts the Files empty state has always asked for.

     §A  A1a · ＋ APPLY STAGE PLAYBOOKS — the bulk verb loops the existing
         idempotent writer over the selection: each case gets ITS current
         stage's steps for ITS kind, assigned to ITS OWN adviser (not the
         presser). ONE overlay confirm naming every skip (terminal cases, cases
         with no steps, cases that already have them all) and ZERO native
         confirms. Tally toast. Selection survives. Re-running writes nothing.
     §B  A1b · 🗂 BUILD CHECKLISTS — insertDocItems, the Fact Find prompt's own
         writer, over every selected case at Fact Find→Exchange with no
         case_documents row. Already-has-one and Enquiry/DIP are named and
         skipped. It creates rows and queues NO email — asserted against the
         queue, not just against the copy.
     §C  A2 · THE PRODUCT-TRANSFER ENQUIRY PLAYBOOK — three steps for
         product_transfer only, the first dated off the case's rate_end_date
         (min(today+3, rateEnd−42d), clamped to today, "soon" when there is no
         date at all); every other kind keeps the website script unchanged; the
         dated title is matched like any other step by the R63 stale rule.
     §D  A3 · THE THREE FILE ARTEFACTS — Application gains "Save the
         illustration/ESIS…", "Save the research/sourcing evidence" and
         "Draft + save the suitability letter" for every kind, on the stage-move
         path and on the bulk path alike.
     §E  no console errors anywhere above.

   EVERY figure asserted here — the playbook map, the due arithmetic, the
   product-transfer clamp, the firm's document list — is recomputed IN THIS FILE
   from the fixtures at runtime, never read out of app.js, per HARNESS.md's
   standing rule. Cases are created fresh and never taken from the fixtures.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node /root/nx/tests/r71_backfill.js
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

/* The same defensive localStorage clear + tour skip every recent suite does before depending on a
   default — the product tour is a modal overlay, and this file clicks real buttons. */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser", "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_ret_scope", "nx_ret_sortdir", "nx_ret_untouched", "nx_drawer_watchtower", "nx_drawer_unactioned",
  "nx_drawer_leads", "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
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

/* A client + case in one round trip. A case created this way has NO tasks and NO checklist on it:
   the writers are bound to acceptLead / moveCaseToStage / the Fact Find prompt, never to a plain
   insert — which is exactly the production shape this round exists for (an imported book). */
async function mkCase(page, o) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email === null ? null : (o.email || `r71.${Math.random().toString(36).slice(2, 9)}@example.com`);
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Ada", last_name: o.last || "R71Case", email }).select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = {
      client_id: cl.id, case_kind: o.case_kind || "purchase", stage: o.stage || "enquiry",
      assigned_to: o.assigned_to === undefined ? "p2" : o.assigned_to,
      lender: o.lender === undefined ? "Halifax" : o.lender,
      // Every stage from Application on is gated on a recorded protection status; without it a
      // stage move is refused and this file would be measuring the gate, not the playbook.
      protection_status: o.protection_status === undefined ? "not_needed" : o.protection_status,
    };
    if (o.rate_end_date !== undefined) row.rate_end_date = o.rate_end_date;
    if (o.completed_at !== undefined) row.completed_at = o.completed_at;
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    if (o.docs && o.docs.length) {
      for (const d of o.docs) await db.from("case_documents").insert({ case_id: cs.id, item: d.item, status: d.status || "requested" });
    }
    if (o.tasks && o.tasks.length) {
      for (const t of o.tasks) await db.from("case_tasks").insert({ case_id: cs.id, title: t, due_date: null, assigned_to: "p2" });
    }
    return { clientId: cl.id, caseId: cs.id };
  }, o || {});
}

const tasksOf = (page, id) => page.evaluate(async (i) =>
  (await window.__mockDb.from("case_tasks").select("*").eq("case_id", i)).data || [], id);
const openTitlesOf = async (page, id) =>
  (await tasksOf(page, id)).filter((t) => !t.done_at).map((t) => t.title).sort();
const docsOf = (page, id) => page.evaluate(async (i) =>
  (await window.__mockDb.from("case_documents").select("*").eq("case_id", i)).data || [], id);
const mailsOf = (page, id) => page.evaluate(async (i) =>
  (await window.__mockDb.from("email_queue").select("*").eq("case_id", i)).data || [], id);

const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1200 : ms);
};
const openCase = async (page, caseId) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((id) => window.openCase(id), caseId);
  await wait(page, 1100);
};
const move = async (page, caseId, stage, ms) => {
  const r = await page.evaluate(({ id, s }) => window.moveCaseToStage(id, s, {}), { id: caseId, s: stage });
  await wait(page, ms == null ? 1400 : ms);
  return r;
};

/* Put the pipeline into a known state: table view, one search. Same helper shape as r65_pipeline. */
async function pipelineTable(page, search, segment) {
  await goto(page, "pipeline", 1600);
  /* "All", always: this file deliberately seeds terminal cases (they are the ones the playbook verb
     must REFUSE), and every other segment filters them off screen before they can be ticked. */
  const seg = segment || "all";
  const segSel = `#pipe-segment .seg-btn[data-seg="${seg}"]`;
  if (await page.$(segSel)) {
    const active = await page.$eval(segSel, (e) => e.classList.contains("active"));
    if (!active) { await page.click(segSel); await wait(page, 1600); }
  }
  const isTable = await page.evaluate(() => !document.querySelector("#table-wrap").classList.contains("hidden"));
  if (!isTable) { await page.click("#view-toggle"); await wait(page, 1400); }
  if (search !== undefined) { await page.fill("#board-search", search); await wait(page, 1500); }
  await wait(page, 500);
}
/* Tick exactly these case ids in the table (never "select all" — the Completed segment and the
   fixtures both put rows on screen this file has no business writing to). */
async function tickRows(page, ids) {
  let n = 0;
  for (const id of ids) {
    const sel = `#pipe-table .bulk-cb[data-id="${id}"]`;
    if (await page.$(sel)) { await page.check(sel); n++; }
  }
  await wait(page, 400);
  return n;
}
const overlay = (page) => page.evaluate(() => {
  const box = document.querySelector("#overlay-modal");
  const bd = document.querySelector("#overlay-backdrop");
  const open = !!box && !!bd && !bd.classList.contains("hidden");
  if (!open) return { open: false, text: "" };
  return {
    open: true,
    heading: (box.querySelector("h3") || {}).textContent || "",
    text: box.textContent.replace(/\s+/g, " ").trim(),
    hasPlaybookOk: !!box.querySelector("#bulkpb-ok"),
    hasDocsOk: !!box.querySelector("#bulkdocs-ok"),
  };
});

/* ---------------------------------------------------------------------------
   Independent re-implementation of the R17/R63/R71 playbook map and the R71
   product-transfer date rule. Never imported from app.js — see the header.
   ------------------------------------------------------------------------- */
const PT_PREFIX = "Ring client — rate ends";
const PLAYBOOK = {
  enquiry: [
    { title: "Qualify enquiry — budget, timeline, goal", dueOffsetDays: 0, notKinds: ["product_transfer"] },
    { title: "Book fact-find appointment", dueOffsetDays: 2, notKinds: ["product_transfer"] },
    { titlePrefix: PT_PREFIX, dueRule: "rate_end_call", onlyKinds: ["product_transfer"] },
    { title: "Confirm current lender + balance", dueRule: "after_rate_end_call", onlyKinds: ["product_transfer"] },
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
    // R71 · A3 — the three file artefacts, every kind
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
function pbItems(stage, kind) {
  return (PLAYBOOK[stage] || []).filter((it) =>
    (!it.notKinds || !it.notKinds.includes(kind)) &&
    (!it.onlyKinds || it.onlyKinds.includes(kind)));
}
// Local YYYY-MM-DD the way the app's localDateStr does — never toISOString().
function dstr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// A calendar walk from a YYYY-MM-DD, noon-anchored — the app's tomorrowDateStr construction.
function shiftStr(base, days) {
  const d = new Date(base + "T12:00:00");
  d.setDate(d.getDate() + days);
  return dstr(d.getTime());
}
const PT_LEAD = 42, PT_WAIT = 3;
// The clamp, recomputed: at the latest today+3, at the latest rateEnd−42d, never before today.
function ptCallDue(rateEnd, today) {
  const latest = shiftStr(today, PT_WAIT);
  if (!rateEnd) return latest;
  const lead = shiftStr(rateEnd, -PT_LEAD);
  const pick = lead < latest ? lead : latest;
  return pick < today ? today : pick;
}
// stage × kind × case → [{title, due}], resolved exactly as the app must.
function pbPlan(stage, kind, ctx) {
  const o = ctx || {};
  const today = o.today;
  const rateEnd = o.rateEnd || null;
  let callDue = null;
  return pbItems(stage, kind).map((it) => {
    let due, title = it.title;
    if (it.dueRule === "rate_end_call") { due = ptCallDue(rateEnd, today); callDue = due; title = rateEnd ? `${it.titlePrefix} ${o.rateEndBritish}` : `${it.titlePrefix} soon`; }
    else if (it.dueRule === "after_rate_end_call") due = shiftStr(callDue || ptCallDue(rateEnd, today), 1);
    else due = shiftStr(today, it.dueOffsetDays);
    return { title, due };
  });
}
const pbTitles = (stage, kind, ctx) => pbPlan(stage, kind, ctx).map((p) => p.title).sort();

/* The firm's document list, recomputed from the SETTINGS ROW in the fixtures plus the app's kind
   rules — so §B measures the writer, not a list this file invented. */
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
       §A · A1a — ＋ APPLY STAGE PLAYBOOKS, over a deliberately mixed selection.
       p1 (Kim, admin) presses it, and every task must land on the CASE's
       adviser — never on Kim.
       ======================================================================= */
    {
      console.log("\n— §A · A1a · bulk “Apply stage playbooks” (p1 admin presses; p2/p3 own the cases)");
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const today = await page.evaluate(() => localDateStr());

      const a1 = await mkCase(page, { first: "Ann", last: "R71Pb", stage: "application", case_kind: "purchase", assigned_to: "p3" });
      const a2 = await mkCase(page, { first: "Ben", last: "R71Pb", stage: "offer", case_kind: "purchase", assigned_to: "p2" });
      // already has every Fact Find step open → counted as "already had their steps", never written to
      const a3 = await mkCase(page, { first: "Cal", last: "R71Pb", stage: "fact_find", case_kind: "purchase", assigned_to: "p2",
        tasks: pbItems("fact_find", "purchase").map((it) => it.title) });
      // terminal → named and skipped, NOT given the Completed playbook
      const a4 = await mkCase(page, { first: "Dee", last: "R71Pb", stage: "completed", case_kind: "purchase", assigned_to: "p2",
        completed_at: new Date(Date.now() - 30 * DAY_MS).toISOString() });

      await pipelineTable(page, "R71Pb");
      const ticked = await tickRows(page, [a1.caseId, a2.caseId, a3.caseId, a4.caseId]);
      ok("A0 · fixture — all four seeded cases are selectable in the table", ticked === 4, String(ticked));
      ok("A0b · the bulk bar carries the “Apply stage playbooks” button", await page.$("#pipe-bulk-playbook") !== null);
      ok("A0c · …and a .panel-sub sentence explaining what the bar's verbs do",
        await page.$eval("#pipe-bulk-sub", (e) => /back-fill|send nothing/i.test(e.textContent)).catch(() => false));

      page.__dialogs.length = 0;
      await page.click("#pipe-bulk-playbook");
      await wait(page, 2200);
      const ov = await overlay(page);
      ok("A1 · ONE overlay confirm opens (not a native dialog)", ov.open && ov.hasPlaybookOk, JSON.stringify(ov).slice(0, 200));
      eq("A1b · …and ZERO native confirm()/alert() were raised", page.__dialogs.length, 0);
      ok("A2 · the confirm names the cases it will write to, with the step count and the case's own adviser",
        /Ann/.test(ov.text) && /Ben/.test(ov.text) && /Wayne|Luke/.test(ov.text), ov.text.slice(0, 400));
      ok("A2b · …names the case that already has every step, and says nothing is written to it",
        /Cal/.test(ov.text) && /already have their steps/i.test(ov.text), ov.text.slice(0, 600));
      ok("A2c · …names the terminal case and why it is skipped",
        /Dee/.test(ov.text) && /settled case gets no new steps/i.test(ov.text), ov.text.slice(0, 800));
      ok("A2d · …and says plainly that nothing is emailed",
        /Nothing is emailed/i.test(ov.text), ov.text.slice(0, 400));

      await page.click("#bulkpb-ok");
      await wait(page, 3000);

      const expA1 = pbPlan("application", "purchase", { today });
      eq("A3 · the Application case gets exactly its stage's steps",
        await openTitlesOf(page, a1.caseId), expA1.map((p) => p.title).sort());
      const a1Rows = await tasksOf(page, a1.caseId);
      for (const p of expA1) {
        const row = a1Rows.find((t) => t.title === p.title);
        eq(`A4 · “${p.title}” is due ${p.due}`, row && row.due_date, p.due);
      }
      eq("A5 · every task on it is assigned to the CASE's adviser (p3), not the presser (p1)",
        [...new Set(a1Rows.map((t) => t.assigned_to))], ["p3"]);
      eq("A5b · …and created_by the person who pressed the button (p1)",
        [...new Set(a1Rows.map((t) => t.created_by))], ["p1"]);
      eq("A6 · the Offer case gets its own stage's steps, on its own adviser (p2)",
        await openTitlesOf(page, a2.caseId), pbTitles("offer", "purchase", { today }));
      eq("A6b · …assigned to p2", [...new Set((await tasksOf(page, a2.caseId)).map((t) => t.assigned_to))], ["p2"]);
      eq("A7 · the case that already had its steps gains nothing — one row per title, still",
        (await tasksOf(page, a3.caseId)).length, pbItems("fact_find", "purchase").length);
      eq("A8 · the terminal case is untouched — no Completed playbook was written to it",
        (await tasksOf(page, a4.caseId)).length, 0);

      const tA = await toastText(page);
      const expWritten = expA1.length + pbItems("offer", "purchase").length;
      ok(`A9 · the toast tallies what it wrote (“${expWritten} tasks written across 2 cases”)`,
        new RegExp(`${expWritten} tasks written across 2 cases`).test(tA), tA);
      ok("A9b · …and how many already had their steps", /1 case already had their steps/i.test(tA), tA);
      ok("A9c · …and how many were skipped, with the reason", /1 skipped/i.test(tA) && /Dee/.test(tA), tA);

      // R65 bulk-bar convention: the selection is still there afterwards, so the second back-fill
      // verb can be run over the same batch without re-ticking four boxes.
      await wait(page, 800);
      const stillSelected = await page.evaluate((ids) =>
        ids.filter((id) => { const cb = document.querySelector(`#pipe-table .bulk-cb[data-id="${id}"]`); return cb && cb.checked; }).length,
      [a1.caseId, a2.caseId, a3.caseId, a4.caseId]);
      eq("A10 · the selection survives the run (all four still ticked after the repaint)", stillSelected, 4);
      ok("A10b · …and the bulk bar is still on screen", await page.$eval("#pipe-bulk-bar", (e) => !e.hidden));

      // A11 — idempotent. A second press over the same rows writes nothing and says so.
      page.__dialogs.length = 0;
      const before = (await tasksOf(page, a1.caseId)).length;
      await page.click("#pipe-bulk-playbook");
      await wait(page, 2400);
      const ov2 = await overlay(page);
      ok("A11 · running it again finds nothing to write and never opens a confirm", !ov2.open, JSON.stringify(ov2).slice(0, 200));
      ok("A11b · …and says so", /Nothing to write/i.test(await toastText(page)), await toastText(page));
      eq("A11c · …and the first case's task count is unchanged", (await tasksOf(page, a1.caseId)).length, before);
      eq("A11d · still zero native dialogs", page.__dialogs.length, 0);

      ok("§A · no console errors", (page.__err || []).length === errBefore, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §B · A1b — 🗂 BUILD CHECKLISTS.
       ======================================================================= */
    {
      console.log("\n— §B · A1b · bulk “Build checklists” (p1 admin)");
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const docsList = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("value").eq("key", "docs_list").maybeSingle();
        return (data && data.value) || "";
      });
      ok("B0 · fixture — the firm's document list in Settings is not empty", docsList.length > 0, docsList.slice(0, 80));

      const b1 = await mkCase(page, { first: "Eve", last: "R71Dc", stage: "application", case_kind: "purchase", assigned_to: "p2" });
      const b2 = await mkCase(page, { first: "Fay", last: "R71Dc", stage: "offer", case_kind: "remortgage", assigned_to: "p3" });
      const b3 = await mkCase(page, { first: "Gus", last: "R71Dc", stage: "application", case_kind: "purchase", assigned_to: "p2",
        docs: [{ item: "Passport", status: "requested" }] });                     // already curated
      const b4 = await mkCase(page, { first: "Hal", last: "R71Dc", stage: "enquiry", case_kind: "product_transfer", assigned_to: "p2" });
      const b5 = await mkCase(page, { first: "Ivy", last: "R71Dc", stage: "decision_in_principle", case_kind: "purchase", assigned_to: "p2" });
      const b6 = await mkCase(page, { first: "Jon", last: "R71Dc", stage: "completed", case_kind: "purchase", assigned_to: "p2",
        completed_at: new Date(Date.now() - 40 * DAY_MS).toISOString() });

      await pipelineTable(page, "R71Dc");
      const ticked = await tickRows(page, [b1, b2, b3, b4, b5, b6].map((r) => r.caseId));
      ok("B0b · fixture — all six seeded cases are selectable", ticked === 6, String(ticked));
      ok("B0c · the bulk bar carries the “Build checklists” button", await page.$("#pipe-bulk-checklists") !== null);

      page.__dialogs.length = 0;
      await page.click("#pipe-bulk-checklists");
      await wait(page, 2400);
      const ov = await overlay(page);
      ok("B1 · ONE overlay confirm opens", ov.open && ov.hasDocsOk, JSON.stringify(ov).slice(0, 200));
      eq("B1b · …and ZERO native confirm()/alert()", page.__dialogs.length, 0);
      ok("B2 · it names the cases it will build on, with the item count and the case type",
        /Eve/.test(ov.text) && /Fay/.test(ov.text), ov.text.slice(0, 400));
      ok("B2b · …names the case that already has a checklist, with its size",
        /Gus/.test(ov.text) && /already has a checklist/i.test(ov.text), ov.text.slice(0, 700));
      ok("B2c · …names the Enquiry case and says a checklist there is premature",
        /Hal/.test(ov.text) && /premature/i.test(ov.text), ov.text.slice(0, 900));
      ok("B2d · …names the DIP case for the same reason",
        /Ivy/.test(ov.text), ov.text.slice(0, 900));
      ok("B2e · …names the completed case as not live", /Jon/.test(ov.text) && /not a live case/i.test(ov.text), ov.text.slice(0, 900));
      ok("B3 · the confirm states that NOTHING is emailed by this verb",
        /Nothing is emailed by this/i.test(ov.text), ov.text.slice(0, 500));
      ok("B3b · …and explains that it is what switches the document machine on",
        /never chased/i.test(ov.text), ov.text.slice(0, 700));

      await page.click("#bulkdocs-ok");
      await wait(page, 3000);

      const expB1 = docSuggested(docsList, "purchase");
      const expB2 = docSuggested(docsList, "remortgage");
      eq("B4 · the purchase case's rows are exactly the firm's list narrowed to a purchase",
        (await docsOf(page, b1.caseId)).map((d) => d.item).sort(), [...expB1].sort());
      eq("B4b · the remortgage case's rows are the remortgage narrowing (no deposit/memorandum)",
        (await docsOf(page, b2.caseId)).map((d) => d.item).sort(), [...expB2].sort());
      const b1Docs = await docsOf(page, b1.caseId);
      eq("B5 · every row is created as outstanding", [...new Set(b1Docs.map((d) => d.status))], ["requested"]);
      ok("B5b · …and stamped requested_at", b1Docs.every((d) => !!d.requested_at), JSON.stringify(b1Docs[0]));
      eq("B6 · the case that already had a checklist still has exactly its one curated item",
        (await docsOf(page, b3.caseId)).map((d) => d.item), ["Passport"]);
      eq("B6b · the Enquiry case got nothing", (await docsOf(page, b4.caseId)).length, 0);
      eq("B6c · the DIP case got nothing", (await docsOf(page, b5.caseId)).length, 0);
      eq("B6d · the completed case got nothing", (await docsOf(page, b6.caseId)).length, 0);

      // The claim "nothing is emailed" measured against the queue, not against the copy.
      const mails = [];
      for (const r of [b1, b2, b3, b4, b5, b6]) mails.push((await mailsOf(page, r.caseId)).length);
      eq("B7 · NOT ONE email row was written for any of the six cases", mails, [0, 0, 0, 0, 0, 0]);

      const tB = await toastText(page);
      ok("B8 · the toast tallies checklists, items and that nothing was emailed",
        /2 checklists built/i.test(tB) && new RegExp(`${expB1.length + expB2.length} items`).test(tB) && /nothing emailed/i.test(tB), tB);
      ok("B8b · …and names the four skips", /4 skipped/i.test(tB), tB);

      // B9 — idempotent: the two cases it just built on are now "already has a checklist".
      page.__dialogs.length = 0;
      await page.click("#pipe-bulk-checklists");
      await wait(page, 2400);
      ok("B9 · a second press finds nothing to build and opens no confirm", !(await overlay(page)).open);
      ok("B9b · …and says so", /Nothing to build/i.test(await toastText(page)), await toastText(page));
      eq("B9c · …and the first case's checklist is unchanged", (await docsOf(page, b1.caseId)).length, expB1.length);
      eq("B9d · still zero native dialogs", page.__dialogs.length, 0);

      ok("§B · no console errors", (page.__err || []).length === errBefore, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §C · A2 — THE PRODUCT-TRANSFER ENQUIRY PLAYBOOK.
       ======================================================================= */
    {
      console.log("\n— §C · A2 · a product transfer at Enquiry gets its own three steps, dated off the rate end");
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const today = await page.evaluate(() => localDateStr());
      const british = (d) => page.evaluate((x) => fmtD(x), d);

      /* Three rate-end shapes, each exercising a different arm of the clamp:
           far  — rate ends in 400 days: nothing pulls the call forward, so today+3
           mid  — rate ends in 44 days:  rateEnd−42d = today+2, which is SOONER than today+3
           past — rate ends in 9 days:   rateEnd−42d is in the past, so it clamps to TODAY
         plus one product transfer with no rate end at all, which is what an un-imported one is. */
      const far = shiftStr(today, 400), mid = shiftStr(today, 44), soonEnd = shiftStr(today, 9);
      const c1 = await mkCase(page, { first: "Kay", last: "R71Pt", stage: "enquiry", case_kind: "product_transfer", assigned_to: "p3", rate_end_date: far });
      const c2 = await mkCase(page, { first: "Lee", last: "R71Pt", stage: "enquiry", case_kind: "product_transfer", assigned_to: "p2", rate_end_date: mid });
      const c3 = await mkCase(page, { first: "Mia", last: "R71Pt", stage: "enquiry", case_kind: "product_transfer", assigned_to: "p2", rate_end_date: soonEnd });
      const c4 = await mkCase(page, { first: "Ned", last: "R71Pt", stage: "enquiry", case_kind: "product_transfer", assigned_to: "p2", rate_end_date: null });
      // …and one purchase at the same stage, to prove the website script is untouched for every
      // other kind — the one assertion that stops this round quietly rewriting the enquiry playbook.
      const c5 = await mkCase(page, { first: "Oli", last: "R71Pt", stage: "enquiry", case_kind: "purchase", assigned_to: "p2" });

      await pipelineTable(page, "R71Pt");
      const ticked = await tickRows(page, [c1, c2, c3, c4, c5].map((r) => r.caseId));
      ok("C0 · fixture — all five enquiry cases are selectable", ticked === 5, String(ticked));
      await page.click("#pipe-bulk-playbook");
      await wait(page, 2200);
      ok("C0b · the confirm opens", (await overlay(page)).hasPlaybookOk);
      await page.click("#bulkpb-ok");
      await wait(page, 3200);

      const farBritish = await british(far);
      const exp1 = pbPlan("enquiry", "product_transfer", { today, rateEnd: far, rateEndBritish: farBritish });
      eq("C1 · a product transfer at Enquiry gets exactly the three PT steps — and neither website step",
        await openTitlesOf(page, c1.caseId), exp1.map((p) => p.title).sort());
      const t1 = await tasksOf(page, c1.caseId);
      ok("C1b · the call step's TITLE carries the rate-end date in British form",
        t1.some((t) => t.title === `${PT_PREFIX} ${farBritish}`), JSON.stringify(t1.map((t) => t.title)) + " · wanted " + farBritish);
      for (const p of exp1) {
        eq(`C2 · far-out rate: “${p.title}” is due ${p.due}`, (t1.find((t) => t.title === p.title) || {}).due_date, p.due);
      }
      eq("C2b · …so the call itself is today+3 (nothing pulls it forward)",
        (t1.find((t) => t.title.startsWith(PT_PREFIX)) || {}).due_date, shiftStr(today, PT_WAIT));

      const t2 = await tasksOf(page, c2.caseId);
      eq("C3 · a rate ending in 44 days pulls the call forward to rate end − 42d (today+2)",
        (t2.find((t) => t.title.startsWith(PT_PREFIX)) || {}).due_date, shiftStr(today, 2));
      eq("C3b · …and “Confirm current lender + balance” lands the day after that call",
        (t2.find((t) => t.title === "Confirm current lender + balance") || {}).due_date, shiftStr(today, 3));
      eq("C3c · …while “Issue recommendation” stays a week out",
        (t2.find((t) => t.title === "Issue recommendation") || {}).due_date, shiftStr(today, 7));

      const t3 = await tasksOf(page, c3.caseId);
      eq("C4 · a rate ending inside six weeks clamps the call to TODAY, never a date in the past",
        (t3.find((t) => t.title.startsWith(PT_PREFIX)) || {}).due_date, today);
      eq("C4b · …and the follow-up is tomorrow", (t3.find((t) => t.title === "Confirm current lender + balance") || {}).due_date, shiftStr(today, 1));

      const t4 = await tasksOf(page, c4.caseId);
      ok("C5 · a product transfer with NO rate end says “rate ends soon” rather than inventing a date",
        t4.some((t) => t.title === `${PT_PREFIX} soon`), JSON.stringify(t4.map((t) => t.title)));
      eq("C5b · …and its call is simply today+3", (t4.find((t) => t.title.startsWith(PT_PREFIX)) || {}).due_date, shiftStr(today, PT_WAIT));

      eq("C6 · every other kind keeps the website Enquiry script, unchanged",
        await openTitlesOf(page, c5.caseId), pbTitles("enquiry", "purchase", { today }));
      const t5 = await tasksOf(page, c5.caseId);
      ok("C6b · …and gets nothing titled “Ring client — rate ends …”",
        !t5.some((t) => t.title.startsWith(PT_PREFIX)), JSON.stringify(t5.map((t) => t.title)));

      /* C7 — the dated title is a playbook step like any other as far as the R63 stale rule is
         concerned: carried into a later stage it is an EARLIER-stage step, and the case modal says
         so. This is the one thing a title built at write time could have broken. */
      await move(page, c2.caseId, "fact_find", 2000);
      await openCase(page, c2.caseId);
      const stale = await page.evaluate((pre) => {
        const rows = [...document.querySelectorAll("#tasks-inline .row-item")];
        const row = rows.find((r) => (r.textContent || "").includes(pre));
        return row ? { chip: !!row.querySelector(".task-stale-chip"), text: row.textContent.replace(/\s+/g, " ").trim() } : null;
      }, PT_PREFIX);
      ok("C7 · the dated call step, still open on a case now at Fact Find, wears the “earlier stage” chip",
        !!stale && stale.chip, JSON.stringify(stale));
      ok("C7b · …and the row says which stage it came from", !!stale && /an? Enquiry step/i.test(stale.text), JSON.stringify(stale));
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      /* C8 — re-applying cannot double the call step even though its title is not a constant: the
         prefix is the idempotency key, so a case whose rate end has since been CORRECTED (a
         different date, therefore a different title) still matches its own open step. */
      await page.evaluate(async ({ id, d }) => { await window.__mockDb.from("cases").update({ rate_end_date: d }).eq("id", id); }, { id: c1.caseId, d: shiftStr(today, 380) });
      await pipelineTable(page, "R71Pt");
      await tickRows(page, [c1.caseId]);
      page.__dialogs.length = 0;
      await page.click("#pipe-bulk-playbook");
      await wait(page, 2400);
      const ovC = await overlay(page);
      if (ovC.open) { await page.click("#bulkpb-ok"); await wait(page, 2200); }
      eq("C8 · a corrected rate end does not produce a SECOND “Ring client …” task",
        (await tasksOf(page, c1.caseId)).filter((t) => t.title.startsWith(PT_PREFIX)).length, 1);
      eq("C8b · …and no native dialog was raised doing it", page.__dialogs.length, 0);

      ok("§C · no console errors", (page.__err || []).length === errBefore, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §D · A3 — THE THREE FILE ARTEFACTS AT APPLICATION.
       ======================================================================= */
    {
      console.log("\n— §D · A3 · Application now asks for the illustration, the research and the suitability letter");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      const today = await page.evaluate(() => localDateStr());
      const FILE_STEPS = [
        ["Save the illustration/ESIS to the case file", 1],
        ["Save the research/sourcing evidence", 2],
        ["Draft + save the suitability letter", 5],
      ];

      // (a) the stage-move path — the moment R63 writes a stage's steps
      const d1 = await mkCase(page, { first: "Pia", last: "R71File", stage: "decision_in_principle", case_kind: "purchase", assigned_to: "p2" });
      await move(page, d1.caseId, "application", 2000);
      const d1Titles = await openTitlesOf(page, d1.caseId);
      eq("D1 · moving a case to Application writes its stage's steps, the three file artefacts included",
        d1Titles, pbTitles("application", "purchase", { today }));
      const d1Rows = await tasksOf(page, d1.caseId);
      for (const [title, off] of FILE_STEPS) {
        eq(`D2 · “${title}” is due today + ${off}d`, (d1Rows.find((t) => t.title === title) || {}).due_date, shiftStr(today, off));
      }

      // (b) they are NOT kind-gated: a product transfer at Application gets them too
      const d2 = await mkCase(page, { first: "Quy", last: "R71File", stage: "decision_in_principle", case_kind: "product_transfer", assigned_to: "p2" });
      await move(page, d2.caseId, "application", 2000);
      const d2Titles = await openTitlesOf(page, d2.caseId);
      eq("D3 · a product transfer at Application gets them as well (a PT file is still a file)",
        d2Titles, pbTitles("application", "product_transfer", { today }));
      ok("D3b · …and still no valuation step", !d2Titles.includes("Instruct valuation"), JSON.stringify(d2Titles));

      // (c) and a buy-to-let keeps its ICR step alongside them
      const d3 = await mkCase(page, { first: "Rex", last: "R71File", stage: "decision_in_principle", case_kind: "buy_to_let", assigned_to: "p2" });
      await move(page, d3.caseId, "application", 2000);
      eq("D4 · a buy-to-let at Application keeps ICR and gains the three",
        await openTitlesOf(page, d3.caseId), pbTitles("application", "buy_to_let", { today }));

      // (d) the case modal's own Stage checklist offers them (R17's by-hand path, still intact)
      const d4 = await mkCase(page, { first: "Sam", last: "R71File", stage: "application", case_kind: "purchase", assigned_to: "p2" });
      await openCase(page, d4.caseId);
      const chk = await page.evaluate(() => {
        const el = document.querySelector("#stage-checklist-items");
        return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
      });
      for (const [title] of FILE_STEPS) {
        ok(`D5 · the case's Stage checklist offers “${title}”`, chk.includes(title), chk.slice(0, 400));
      }
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      // (e) and they ride the bulk verb, which is how the imported book actually gets them
      await pipelineTable(page, "R71File");
      await tickRows(page, [d4.caseId]);
      await page.click("#pipe-bulk-playbook");
      await wait(page, 2200);
      ok("D6 · the bulk verb offers to write them onto a case that never moved", (await overlay(page)).hasPlaybookOk);
      await page.click("#bulkpb-ok");
      await wait(page, 2600);
      eq("D6b · …and does", await openTitlesOf(page, d4.caseId), pbTitles("application", "purchase", { today }));

      ok("§D · no console errors", (page.__err || []).length === errBefore, JSON.stringify(page.__err));
      await page.close();
    }

  } catch (e) {
    failures.push("EXCEPTION: " + (e && e.stack ? e.stack : e));
    console.log("  ✗ EXCEPTION", e);
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log(`\nR71 BACKFILL: ${pass} checks, ${failures.length} failures`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
