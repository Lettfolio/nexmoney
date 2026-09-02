#!/usr/bin/env node
/* =============================================================================
   tests/r65_pipeline.js — acceptance tests for ROUND 65 (agent A): the pipeline
   round. Sam's panel note was that "In stage" + the ⏳ waiting-on chip are the
   best triage data in the app — and that in PRODUCTION `waiting_on` is null on
   100% of live cases, is neither sortable nor filterable, the default view has
   no sort at all, `expected_completion_date` is fetched and shown nowhere, and
   the bulk bar can move and assign but cannot chase.

     §A  H7a · STAGE-ENTRY WAITING-ON. promptStageEntry asks "who is this case
         waiting on now?" at application / offer / exchange, ONLY when the case's
         waiting_on is empty and only behind docsSupported(). The Offer dialog
         carries the expiry question AND the waiting-on question in ONE dialog.
         Fact Find and DIP are unchanged (they ask what they always asked, and
         nothing more). Save & advance writes waiting_on (+ solicitor_firm in the
         same patch); Skip writes neither; the three-way exit is intact.
     §B  H7b · TWO SORTABLE COLUMNS. "Waiting on" and "Completing" join the
         pipeline table's cols; the chip MOVED out of the Stage cell (not
         copied); waiting-on sorts with the unanswered rows LAST; Completing
         renders the date, or the board's own amber "📅 no date" badge at
         offer/exchange, or a muted dash. A seeded starter view "Waiting on
         solicitor" pins that sort.
     §C  H7c · BOARD SORT + THE CURRENT DEFAULT. Every board column is ordered
         by days-in-stage DESCENDING (ties: least-recently-updated first), and
         picking the Current segment with NO stored view preference lands on the
         TABLE, with a .panel-sub saying why. An explicit toggle persists and
         from then on wins.
     §D  M11 · THE TWO BULK CHASE VERBS. "⚖️ Chase solicitors" writes exactly
         "Chase solicitors for completion date" (the string production's
         auto_stage_comms trigger and the Watchtower's exchange_no_chase rule
         both match on), due today, on the case's own adviser, ONCE — a second
         press names the skips and creates nothing. "📄 Send document request"
         queues a docs_request only for LIVE cases with outstanding checklist
         items and a client email, behind ONE confirm naming every recipient and
         every skip with its reason; and the Data-health "no send to all"
         sentence now points at that reviewed batch.
     §E  L4/L1 · The milestone <details> is OPEN at application/offer/exchange
         and closed elsewhere; the case modal's action row is one sticky bar at
         the top of the modal's scroll container, with every id intact. R40's
         case timeline and R61's protection bands still lay out.
     §F  L9 · At 390px the pipeline TABLE is a card list (the board's own card
         markup, one per row, in the table's sort order) with the segment /
         adviser / search / sort controls above it and NO horizontal page
         scroll. The board on mobile is untouched.
     §G  no console errors for p2 and p4 across the surfaces this round touched.

   Ground truth is recomputed here from window.__mockDb wherever a figure is
   asserted (the standing HARNESS.md rule): the stage-entry dates §C orders on
   are read back out of case_events by this file, and every case §A/§D acts on
   is minted by this file rather than lifted out of the fixture.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node /root/nx/tests/r65_pipeline.js
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

/* The same defensive localStorage clear every recent suite does before depending on a default,
   plus this round's two per-user pipeline keys — the segment and the board/table view — which
   §C is entirely about. They are namespaced with the signed-in id, so both persona forms are
   cleared. */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser", "nx_diary_staff", "nx_views_v1",
  "nx_nav_firm", "nx_import_blurb", "nx_ret_scope", "nx_ret_month",
  "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads", "nx_drawer_todayappts",
  "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => {
  keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
  ["p1", "p2", "p3", "p4"].forEach((u) => {
    try { localStorage.removeItem("nx_seg_" + u); localStorage.removeItem("nx_view_" + u); } catch (e) {}
  });
}, NX_KEYS);

async function newPage(browser, persona, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
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
const noNewErr = (page, before) => (page.__err || []).length === before;
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");

const goto = async (page, name, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await wait(page, ms == null ? 1400 : ms);
};

/* Mint a client + case in one round trip, with an optional stage-entry event at a chosen age.
   Deliberately NOT taken from the fixture: every figure below has to be one this file put there. */
async function mkCase(page, o) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email === null ? null : (o.email || `r65.${Math.random().toString(36).slice(2, 9)}@example.com`);
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Ada", last_name: o.last || "R65Case", email }).select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = {
      client_id: cl.id, case_kind: o.case_kind || "purchase", stage: o.stage || "enquiry",
      assigned_to: o.assigned_to === undefined ? "p2" : o.assigned_to,
      lender: o.lender === undefined ? "Halifax" : o.lender,
      // Every stage from Application on is gated on a recorded protection status — without it the
      // move is refused and this file would be measuring the gate, not the prompt.
      protection_status: o.protection_status === undefined ? "not_needed" : o.protection_status,
    };
    ["waiting_on", "solicitor_firm", "offer_expiry_date", "expected_completion_date"].forEach((k) => {
      if (o[k] !== undefined) row[k] = o[k];
    });
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    if (o.inStageDays != null) {
      // loadStageEntries takes the MAX created_at of stage_changed/stage_change/case_created, so
      // the auto-logged case_created row has to go or it would be "today".
      await db.from("case_events").delete().eq("case_id", cs.id);
      await db.from("case_events").insert({
        case_id: cs.id, event: "stage_changed",
        created_at: new Date(Date.now() - o.inStageDays * 86400000).toISOString(),
      });
    }
    if (o.updatedDaysAgo != null) {
      await db.from("cases").update({ updated_at: new Date(Date.now() - o.updatedDaysAgo * 86400000).toISOString() }).eq("id", cs.id);
    }
    if (o.docs && o.docs.length) {
      for (const d of o.docs) await db.from("case_documents").insert({ case_id: cs.id, item: d.item, status: d.status });
    }
    return { clientId: cl.id, caseId: cs.id };
  }, o || {});
}

const caseRow = (page, id) => page.evaluate(async (i) =>
  (await window.__mockDb.from("cases").select("*").eq("id", i).single()).data, id);
const tasksOf = (page, id) => page.evaluate(async (i) =>
  (await window.__mockDb.from("case_tasks").select("*").eq("case_id", i)).data || [], id);
const mailsOf = (page, id) => page.evaluate(async (i) =>
  (await window.__mockDb.from("email_queue").select("*").eq("case_id", i)).data || [], id);

/* Kick off an opt-in stage move and let its overlay paint. The promise is NOT awaited here — it
   only resolves once the dialog is answered, which is the point. */
function startMove(page, caseId, stage) {
  return page.evaluate(({ id, s }) => window.moveCaseToStage(id, s, { promptStageEntry: true }), { id: caseId, s: stage });
}
const overlayState = (page) => page.evaluate(() => {
  const box = document.querySelector("#overlay-modal");
  const open = !!box && !document.querySelector("#overlay-backdrop").classList.contains("hidden");
  if (!open) return { open: false };
  const sel = box.querySelector("#se-waiting");
  return {
    open: true,
    heading: (box.querySelector("h3") || {}).textContent || "",
    hasWaiting: !!sel,
    waitingOptions: sel ? [...sel.options].map((o) => o.value) : [],
    firmHidden: !!box.querySelector("#se-waiting-firm-field.hidden"),
    hasFirmInput: !!box.querySelector("#se-waiting-firm"),
    hasExpiry: !!box.querySelector("#se-expiry"),
    hasDocPicks: !!box.querySelector("#se-doc-suggested"),
    hasLender: !!box.querySelector("#se-lender"),
    threeWay: !!(box.querySelector("#se-cancel") && box.querySelector("#se-skip") && box.querySelector("#se-ok")),
    text: box.textContent.replace(/\s+/g, " ").trim(),
  };
});

/* Put the pipeline into a known state: a persona's board, table view, one segment, one search. */
async function pipelineTable(page, opts) {
  const o = opts || {};
  await goto(page, "pipeline", 1500);
  const isTable = await page.evaluate(() => !document.querySelector("#table-wrap").classList.contains("hidden"));
  if (!isTable) { await page.click("#view-toggle"); await wait(page, 1400); }
  if (o.search !== undefined) {
    await page.fill("#board-search", o.search);
    await wait(page, 1400);
  }
  await wait(page, 600);
}

const tableHeaders = (page) => page.$$eval("#pipe-table th", (els) =>
  els.map((e) => e.textContent.replace(/[▲▼]/g, "").trim()).filter(Boolean));

/* Read one column of the live table, by its header key. */
const columnCells = (page, key) => page.evaluate((k) => {
  const t = document.querySelector("#pipe-table");
  if (!t) return null;
  const ths = [...t.querySelector("tr").querySelectorAll("th")];
  const idx = ths.findIndex((th) => th.dataset.k === k);
  if (idx < 0) return null;
  return [...t.querySelectorAll("tr")].slice(1).map((tr) => {
    const tds = [...tr.querySelectorAll("td")];
    const cell = tds[idx];
    return cell ? cell.textContent.replace(/\s+/g, " ").trim() : "";
  });
}, key);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =====================================================================
       §A — the stage-entry waiting-on prompt
       ===================================================================== */
    console.log("\n— §A · H7a · “Who is this case waiting on now?” at Application / Offer / Exchange");
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;

      ok("A0 · the fixture has taken m10 — there is a case_documents table to gate on",
        await page.evaluate(async () => !(await window.__mockDb.from("case_documents").select("id").limit(1)).error));

      // ---- A1 · Application, waiting_on empty → the dialog asks
      const a1 = await mkCase(page, { last: "R65Wait", stage: "decision_in_principle", waiting_on: null });
      const mv1 = startMove(page, a1.caseId, "application");
      await wait(page, 1200);
      const s1 = await overlayState(page);
      ok("A1 · advancing to Application raises a dialog", s1.open, JSON.stringify(s1).slice(0, 200));
      ok("A1b · …that asks who the case is waiting on", s1.hasWaiting, JSON.stringify(s1.waitingOptions));
      eq("A1c · …offering exactly the case form's four values, plus a blank", s1.waitingOptions,
        ["", "client", "lender", "solicitor", "other"]);
      ok("A1d · …with the solicitor-firm box hidden until Solicitor is picked", s1.firmHidden && s1.hasFirmInput, JSON.stringify(s1));
      ok("A1e · …keeping the three-way exit (Don't advance / Skip / Save & advance)", s1.threeWay);
      ok("A1f · …and saying in plain English what the answer feeds", /⏳ chip|Waiting on/i.test(s1.text), s1.text.slice(0, 240));

      // pick Solicitor → the firm box appears; save → BOTH land in the same patch
      await page.selectOption("#se-waiting", "solicitor");
      await wait(page, 200);
      const firmShown = await page.evaluate(() => !document.querySelector("#se-waiting-firm-field").classList.contains("hidden"));
      ok("A1g · picking Solicitor reveals the firm box (the case form's own rule)", firmShown);
      await page.fill("#se-waiting-firm", "  Trelawny Conveyancing  ");
      await page.click("#se-ok");
      await mv1;
      await wait(page, 1200);
      const r1 = await caseRow(page, a1.caseId);
      eq("A1h · Save & advance moves the case AND writes waiting_on + solicitor_firm in one patch",
        [r1.stage, r1.waiting_on, r1.solicitor_firm], ["application", "solicitor", "Trelawny Conveyancing"]);
      ok("A1i · the move's own toast names the waiting-on answer", /waiting on solicitor/i.test(await toastText(page)), await toastText(page));

      // ---- A2 · already answered → no dialog at all
      // R77: "already answered" at Application now includes the expected completion date (the
      // R77 · A1b capture rides this dialog and can raise it alone) — seed it so the fact under
      // test stays "a fully-answered case is not asked again". The R77 field's own behaviour is
      // pinned in tests/r77_owner.js §B.
      const a2 = await mkCase(page, { last: "R65Wait", stage: "decision_in_principle", waiting_on: "lender", expected_completion_date: "2031-01-01" });
      const mv2 = startMove(page, a2.caseId, "application");
      await wait(page, 1100);
      const s2 = await overlayState(page);
      ok("A2 · a case that already names who it is waiting on is NOT asked again", !s2.open, JSON.stringify(s2).slice(0, 160));
      await mv2;
      await wait(page, 800);
      const r2 = await caseRow(page, a2.caseId);
      eq("A2b · …and it still advances, with waiting_on untouched", [r2.stage, r2.waiting_on], ["application", "lender"]);

      // ---- A3 · Exchange asks too
      const a3 = await mkCase(page, { last: "R65Wait", stage: "offer", waiting_on: null, offer_expiry_date: "2030-01-01" });
      const mv3 = startMove(page, a3.caseId, "exchange");
      await wait(page, 1200);
      const s3 = await overlayState(page);
      ok("A3 · advancing to Exchange asks the same question", s3.open && s3.hasWaiting, JSON.stringify(s3).slice(0, 200));
      ok("A3b · …and asks NOTHING else (no expiry, no checklist, no lender)", !s3.hasExpiry && !s3.hasDocPicks && !s3.hasLender, JSON.stringify(s3).slice(0, 200));
      // Skip writes nothing
      await page.click("#se-skip");
      await mv3;
      await wait(page, 1000);
      const r3 = await caseRow(page, a3.caseId);
      eq("A3c · Skip advances the case and writes NOTHING", [r3.stage, r3.waiting_on, r3.solicitor_firm], ["exchange", null, null]);

      // ---- A4 · Offer: ONE dialog carrying the expiry question AND the waiting-on question
      const a4 = await mkCase(page, { last: "R65Wait", stage: "application", waiting_on: null, offer_expiry_date: null });
      const mv4 = startMove(page, a4.caseId, "offer");
      await wait(page, 1200);
      const s4 = await overlayState(page);
      ok("A4 · the Offer dialog carries the offer-expiry question", s4.open && s4.hasExpiry, JSON.stringify(s4).slice(0, 200));
      ok("A4b · …AND the waiting-on question, in the SAME dialog", s4.hasWaiting, JSON.stringify(s4).slice(0, 200));
      const overlayCount = await page.$$eval("#overlay-modal", (e) => e.length);
      eq("A4c · one dialog per move, never two", overlayCount, 1);
      await page.fill("#se-expiry", "2031-03-04");
      await page.selectOption("#se-waiting", "lender");
      await page.click("#se-ok");
      await mv4;
      await wait(page, 1200);
      const r4 = await caseRow(page, a4.caseId);
      eq("A4d · Save writes BOTH halves of the one dialog", [r4.stage, r4.offer_expiry_date, r4.waiting_on],
        ["offer", "2031-03-04", "lender"]);

      // ---- A5 · Offer where the expiry is already recorded still asks the waiting-on half
      const a5 = await mkCase(page, { last: "R65Wait", stage: "application", waiting_on: null, offer_expiry_date: "2030-06-06" });
      const mv5 = startMove(page, a5.caseId, "offer");
      await wait(page, 1200);
      const s5 = await overlayState(page);
      ok("A5 · an offer whose expiry is already recorded is still asked who it is waiting on",
        s5.open && s5.hasWaiting && !s5.hasExpiry, JSON.stringify(s5).slice(0, 200));
      await page.click("#se-cancel");
      const res5 = await mv5;
      await wait(page, 800);
      const r5 = await caseRow(page, a5.caseId);
      eq("A5b · “Don't advance” cancels the move outright", [res5, r5.stage], ["cancelled", "application"]);

      // ---- A6 · a product transfer never offers Solicitor (the case form's exact rule)
      const a6 = await mkCase(page, { last: "R65Wait", stage: "decision_in_principle", case_kind: "product_transfer", waiting_on: null });
      const mv6 = startMove(page, a6.caseId, "application");
      await wait(page, 1200);
      const s6 = await overlayState(page);
      eq("A6 · a product transfer is not offered “Solicitor” (there is no conveyancing)",
        s6.waitingOptions, ["", "client", "lender", "other"]);
      await page.click("#se-skip");
      await mv6;
      await wait(page, 800);

      // ---- A7 · Fact Find and DIP are unchanged — they ask what they always asked, nothing more
      const a7 = await mkCase(page, { last: "R65Wait", stage: "enquiry", waiting_on: null });
      const mv7 = startMove(page, a7.caseId, "fact_find");
      await wait(page, 1200);
      const s7 = await overlayState(page);
      ok("A7 · Fact Find still raises its checklist prompt", s7.open && s7.hasDocPicks, JSON.stringify(s7).slice(0, 200));
      ok("A7b · …and does NOT gain the waiting-on question", !s7.hasWaiting, JSON.stringify(s7).slice(0, 200));
      await page.click("#se-skip");
      await mv7;
      await wait(page, 1000);

      const a8 = await mkCase(page, { last: "R65Wait", stage: "fact_find", lender: null, waiting_on: null });
      const mv8 = startMove(page, a8.caseId, "decision_in_principle");
      await wait(page, 1200);
      const s8 = await overlayState(page);
      ok("A8 · DIP still raises its lender prompt", s8.open && s8.hasLender, JSON.stringify(s8).slice(0, 200));
      ok("A8b · …and does NOT gain the waiting-on question", !s8.hasWaiting, JSON.stringify(s8).slice(0, 200));
      await page.click("#se-skip");
      await mv8;
      await wait(page, 1000);

      // ---- A9 · a programmatic move (no promptStageEntry) is untouched — the R12b contract
      const a9 = await mkCase(page, { last: "R65Wait", stage: "decision_in_principle", waiting_on: null });
      await page.evaluate((id) => window.moveCaseToStage(id, "application", {}), a9.caseId);
      await wait(page, 1000);
      const s9 = await overlayState(page);
      const r9 = await caseRow(page, a9.caseId);
      ok("A9 · a programmatic move raises no dialog and writes no waiting_on",
        !s9.open && r9.stage === "application" && !r9.waiting_on, JSON.stringify({ s9, w: r9.waiting_on }));

      ok("§A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §B — the two new sortable columns
       ===================================================================== */
    console.log("\n— §B · H7b · Waiting on / Completing as sortable columns");
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      await pipelineTable(page, {});
      const heads = await tableHeaders(page);
      ok("B1 · the table has a “Waiting on” column", heads.includes("Waiting on"), JSON.stringify(heads));
      ok("B2 · the table has a “Completing” column", heads.includes("Completing"), JSON.stringify(heads));
      ok("B3 · “Waiting on” sits beside “In stage” (the two halves of one triage question)",
        heads.indexOf("Waiting on") === heads.indexOf("In stage") + 1, JSON.stringify(heads));

      // the chip MOVED, not copied
      const chips = await page.evaluate(() => ({
        inWaitingCol: document.querySelectorAll("#pipe-table td.pipe-col-waiting .wait-chip").length,
        anywhere: document.querySelectorAll("#pipe-table .wait-chip").length,
        inStageCell: [...document.querySelectorAll("#pipe-table tr")].slice(1)
          .filter((tr) => { const td = tr.querySelectorAll("td"); return [...td].some((c, i) => i < 4 && !c.classList.contains("pipe-col-waiting") && c.querySelector(".wait-chip")); }).length,
      }));
      ok("B4 · every waiting chip is in the Waiting-on column", chips.anywhere > 0 && chips.inWaitingCol === chips.anywhere, JSON.stringify(chips));
      eq("B5 · …and none is left in the Stage cell (moved, not duplicated)", chips.inStageCell, 0);

      // BOARD_CASE_COLS carries expected_completion_date; waiting_on rides the docsSupported() gate
      const colsOk = await page.evaluate(() => ({
        base: BOARD_CASE_COLS.split(",").includes("expected_completion_date"),
        docsGate: DOCS_SUPPORTED,
      }));
      ok("B6 · expected_completion_date is in BOARD_CASE_COLS (no widening needed)", colsOk.base, JSON.stringify(colsOk));
      eq("B7 · waiting_on rides the m10 gate, which this fixture answers yes", colsOk.docsGate, true);

      // sorting: blanks last, ascending
      await page.evaluate(() => {
        const th = [...document.querySelectorAll("#pipe-table th[data-k]")].find((t) => t.dataset.k === "waiting_on");
        th.click();
      });
      await wait(page, 1500);
      const wcells = await columnCells(page, "waiting_on");
      const firstBlank = wcells.findIndex((t) => t === "—");
      const lastChip = wcells.map((t, i) => (t !== "—" ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
      ok("B8 · sorted on Waiting on, the answered rows come first…", lastChip >= 0, JSON.stringify(wcells.slice(0, 5)));
      ok("B8b · …and every unanswered row is below all of them (blanks last, never first)",
        firstBlank === -1 || firstBlank > lastChip, JSON.stringify({ firstBlank, lastChip, head: wcells.slice(0, 6), tail: wcells.slice(-3) }));
      /* Grouped, never interleaved — the assertion that actually matters. The sort KEY is
         waiting_on's stored value (client < lender < other < solicitor < the "zz" blank sentinel),
         which is NOT the alphabetical order of the printed labels ("someone else" is the label for
         "other"), so a lexical check on the rendered text would be testing the wrong thing. What
         the operator needs is that every case waiting on the same party sits in one run. */
      const asc = wcells.filter((t) => t !== "—").map((t) => t.replace(/^⏳\s*/, "").split(" · ")[0]);
      const runs = asc.filter((t, i) => i === 0 || t !== asc[i - 1]);
      ok("B8c · …and the answered rows are grouped by who, never interleaved",
        new Set(runs).size === runs.length, JSON.stringify(asc));

      // reversing the sort flips the arrow and the order
      const arrowBefore = await page.$eval('#pipe-table th[data-k="waiting_on"]', (e) => e.textContent.trim().slice(-1));
      await page.evaluate(() => {
        const th = [...document.querySelectorAll("#pipe-table th[data-k]")].find((t) => t.dataset.k === "waiting_on");
        th.click();
      });
      await wait(page, 1500);
      const arrowAfter = await page.$eval('#pipe-table th[data-k="waiting_on"]', (e) => e.textContent.trim().slice(-1));
      ok("B9 · clicking the header again reverses the sort", arrowBefore !== arrowAfter, `${arrowBefore} → ${arrowAfter}`);

      // Completing: a date, the board's own amber badge, or a dash — checked against ground truth
      await mkCase(page, { first: "Dated", last: "R65Comp", stage: "exchange", expected_completion_date: "2031-09-09", inStageDays: 3 });
      await mkCase(page, { first: "Undated", last: "R65Comp", stage: "offer", expected_completion_date: null, inStageDays: 3, offer_expiry_date: "2031-01-01" });
      await mkCase(page, { first: "Early", last: "R65Comp", stage: "enquiry", expected_completion_date: null, inStageDays: 1 });
      await pipelineTable(page, { search: "R65Comp" });
      const compCells = await page.evaluate(() => {
        const t = document.querySelector("#pipe-table");
        const ths = [...t.querySelector("tr").querySelectorAll("th")];
        const idx = ths.findIndex((th) => th.dataset.k === "expected_completion_date");
        const out = {};
        [...t.querySelectorAll("tr")].slice(1).forEach((tr) => {
          const name = tr.querySelector(".stick-col").textContent.trim();
          const cell = tr.querySelectorAll("td")[idx];
          out[name] = { text: cell.textContent.replace(/\s+/g, " ").trim(), amber: !!cell.querySelector(".badge.amber") };
        });
        return out;
      });
      const names = Object.keys(compCells);
      ok("B10 · the three seeded cases are on screen", names.length === 3, JSON.stringify(names));
      const withDate = Object.values(compCells).find((v) => /\d/.test(v.text) && !v.amber);
      ok("B11 · a recorded completion date renders as a date", !!withDate, JSON.stringify(compCells));
      const amber = Object.values(compCells).filter((v) => v.amber);
      eq("B12 · exactly one row wears the board's amber “no date” badge (the offer/exchange rule)", amber.length, 1);
      ok("B12b · …in the board's own words", amber[0] && /no date/i.test(amber[0].text), JSON.stringify(amber));
      const dash = Object.values(compCells).filter((v) => v.text === "—");
      eq("B13 · a pre-offer case with no date is a quiet dash, not an alarm", dash.length, 1);
      ok("B14 · sorting on Completing puts the dated rows above the undated ones",
        await page.evaluate(async () => {
          const th = [...document.querySelectorAll("#pipe-table th[data-k]")].find((t) => t.dataset.k === "expected_completion_date");
          th.click();
          await new Promise((r) => setTimeout(r, 1500));
          const t = document.querySelector("#pipe-table");
          const ths = [...t.querySelector("tr").querySelectorAll("th")];
          const idx = ths.findIndex((x) => x.dataset.k === "expected_completion_date");
          const cells = [...t.querySelectorAll("tr")].slice(1).map((tr) => tr.querySelectorAll("td")[idx].textContent.trim());
          const dated = cells.map((c, i) => (/\d{4}|\w{3} \d/.test(c) && !/no date/i.test(c) ? i : -1)).filter((i) => i >= 0);
          const undated = cells.map((c, i) => (!/\d/.test(c) || /no date/i.test(c) ? i : -1)).filter((i) => i >= 0);
          return !dated.length || !undated.length || Math.max(...dated) < Math.min(...undated);
        }));

      // the seeded starter view
      const views = await page.$$eval("#board-views option", (els) => els.map((e) => e.value).filter(Boolean));
      ok("B15 · a “Waiting on solicitor” starter view is seeded alongside the others",
        views.includes("Waiting on solicitor"), JSON.stringify(views));
      /* Read through savedViews(), not out of localStorage: R43 moved the store to the
         `saved_views` table and localStorage is only the fallback, so a localStorage read would be
         asserting against a store this deploy does not use. */
      const vfilters = await page.evaluate(() => {
        const v = savedViews("pipeline").find((x) => x.name === "Waiting on solicitor");
        return v ? v.filters : null;
      });
      ok("B16 · …and it pins the sort, the segment and the table view",
        vfilters && vfilters.sortKey === "waiting_on" && vfilters.segment === "current" && vfilters.view === "table",
        JSON.stringify(vfilters));
      await page.fill("#board-search", "");
      await wait(page, 1000);
      await page.selectOption("#board-views", "Waiting on solicitor");
      await wait(page, 1800);
      const applied = await page.evaluate(() => ({ sortKey, segment: pipelineSegment, view: pipelineView }));
      eq("B17 · applying it lands on the table, in Current, sorted on waiting_on",
        applied, { sortKey: "waiting_on", segment: "current", view: "table" });

      ok("§B · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §C — board sort, and what Current opens on
       ===================================================================== */
    console.log("\n— §C · H7c · The board has a sort; Current opens on the table");
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;

      // three cases, one stage, controlled ages — the order is then not a matter of opinion
      const c40 = await mkCase(page, { first: "Older", last: "R65Age", stage: "exchange", inStageDays: 40, updatedDaysAgo: 1 });
      const c25 = await mkCase(page, { first: "Middle", last: "R65Age", stage: "exchange", inStageDays: 25, updatedDaysAgo: 1 });
      const c10 = await mkCase(page, { first: "Newer", last: "R65Age", stage: "exchange", inStageDays: 10, updatedDaysAgo: 1 });
      await goto(page, "pipeline", 1500);
      const onBoard = await page.evaluate(() => !document.querySelector("#board").classList.contains("hidden"));
      if (!onBoard) { await page.click("#view-toggle"); await wait(page, 1400); }
      await page.fill("#board-search", "R65Age");
      await wait(page, 1600);
      const seeded = await page.$$eval('.col[data-stage="exchange"] .card', (els) => els.map((e) => e.dataset.id));
      eq("C1 · three seeded Exchange cards, oldest-in-stage first", seeded, [c40.caseId, c25.caseId, c10.caseId]);

      // and the whole board obeys it, against ground truth read back out of case_events
      await page.fill("#board-search", "");
      await wait(page, 1800);
      const boardOrder = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: evs } = await db.from("case_events").select("case_id,event,created_at");
        const entry = {};
        (evs || []).forEach((e) => {
          if (!e || !e.case_id || !e.created_at) return;
          if (!["stage_changed", "stage_change", "case_created"].includes(e.event)) return;
          if (!entry[e.case_id] || e.created_at > entry[e.case_id]) entry[e.case_id] = e.created_at;
        });
        const { data: cases } = await db.from("cases").select("id,updated_at");
        const upd = Object.fromEntries((cases || []).map((c) => [c.id, c.updated_at || ""]));
        const days = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : -1);
        const cols = [...document.querySelectorAll("#board .col")].map((col) => ({
          stage: col.dataset.stage,
          seq: [...col.querySelectorAll(".card")].map((card) => ({
            d: days(entry[card.dataset.id]), u: upd[card.dataset.id] || "",
          })),
        }));
        return cols;
      });
      const desc = boardOrder.every((col) => col.seq.every((x, i) => i === 0 || x.d <= col.seq[i - 1].d));
      ok("C2 · every board column runs days-in-stage DESCENDING", desc,
        JSON.stringify(boardOrder.map((c) => ({ s: c.stage, d: c.seq.map((x) => x.d) }))).slice(0, 400));
      const ties = boardOrder.every((col) => col.seq.every((x, i) => i === 0 || x.d !== col.seq[i - 1].d || x.u >= col.seq[i - 1].u));
      ok("C3 · …with ties broken by updated_at ascending (least recently touched first)", ties,
        JSON.stringify(boardOrder.map((c) => c.seq)).slice(0, 400));
      const populated = boardOrder.filter((c) => c.seq.length > 1).length;
      ok("C3b · at least two columns actually had more than one card to order", populated >= 2, populated);

      // ---- the Current default
      await clearNxKeys(page);
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "pipeline", 1600);
      const before = await page.evaluate(() => ({
        view: pipelineView, seg: pipelineSegment,
        stored: localStorage.getItem("nx_view_" + (ME && ME.id)),
      }));
      eq("C4 · with nothing stored the pipeline still opens on the BOARD (segment “all” is unchanged)",
        [before.view, before.seg, before.stored], ["board", "all", null]);
      await page.evaluate(() => [...document.querySelectorAll("#pipe-segment .seg-btn")].find((b) => b.dataset.seg === "current").click());
      await wait(page, 1800);
      const cur = await page.evaluate(() => ({
        view: pipelineView,
        tableShown: !document.querySelector("#table-wrap").classList.contains("hidden"),
        boardShown: !document.querySelector("#board").classList.contains("hidden"),
        why: !!document.querySelector("#pipe-current-why"),
        whyText: (document.querySelector("#pipe-current-why") || {}).textContent || "",
        stored: localStorage.getItem("nx_view_" + (ME && ME.id)),
      }));
      ok("C5 · picking Current with NO stored preference lands on the TABLE",
        cur.view === "table" && cur.tableShown && !cur.boardShown, JSON.stringify(cur).slice(0, 200));
      ok("C6 · …with a .panel-sub that says why, in plain English", cur.why && /board/i.test(cur.whyText) && /sort/i.test(cur.whyText), cur.whyText.slice(0, 200));
      eq("C7 · …and the default is NOT written to storage (only a real toggle is)", cur.stored, null);

      // an explicit toggle persists and from then on wins
      await page.click("#view-toggle");
      await wait(page, 1600);
      const tog = await page.evaluate(() => ({ view: pipelineView, stored: localStorage.getItem("nx_view_" + (ME && ME.id)) }));
      eq("C8 · pressing the toggle in Current gives the board, and stores that choice", [tog.view, tog.stored], ["board", "board"]);
      await page.evaluate(() => [...document.querySelectorAll("#pipe-segment .seg-btn")].find((b) => b.dataset.seg === "new").click());
      await wait(page, 1600);
      await page.evaluate(() => [...document.querySelectorAll("#pipe-segment .seg-btn")].find((b) => b.dataset.seg === "current").click());
      await wait(page, 1800);
      const back = await page.evaluate(() => ({ view: pipelineView, seg: pipelineSegment }));
      eq("C9 · coming back to Current now respects the stored choice — the default never argues",
        back, { view: "board", seg: "current" });

      ok("§C · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §D — the two bulk chase verbs
       ===================================================================== */
    console.log("\n— §D · M11 · Chase solicitors / Send document request, from the bulk bar");
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;

      const k1 = await mkCase(page, { first: "Ann", last: "R65Chase", stage: "exchange", assigned_to: "p2", inStageDays: 5 });
      const k2 = await mkCase(page, { first: "Ben", last: "R65Chase", stage: "exchange", assigned_to: "p3", inStageDays: 5 });
      const k3 = await mkCase(page, { first: "Cal", last: "R65Chase", stage: "offer", assigned_to: "p2", inStageDays: 5, offer_expiry_date: "2031-01-01" });
      // k3 already carries an open chase → it must be skipped BY NAME, not silently doubled
      await page.evaluate((id) => window.__mockDb.from("case_tasks").insert({
        case_id: id, title: "Chase solicitors for completion date", due_date: "2030-01-01", assigned_to: "p2",
      }), k3.caseId);

      await pipelineTable(page, { search: "R65Chase" });
      const rowN = await page.$$eval("#pipe-table .bulk-cb", (e) => e.length);
      eq("D0 · the three seeded cases are the whole table", rowN, 3);
      await page.click("#pipe-bulk-all");
      await wait(page, 400);
      ok("D1 · the bulk bar carries a “Chase solicitors” button", await page.$("#pipe-bulk-chase") !== null);
      ok("D1b · …and a “Send document request” button", await page.$("#pipe-bulk-docs") !== null);

      page.__dialogs.length = 0;
      await page.click("#pipe-bulk-chase");
      await wait(page, 2200);
      const chaseConfirm = (page.__dialogs.find((d) => d.type === "confirm") || {}).message || "";
      ok("D2 · one confirm, naming the exact title production's trigger matches on",
        chaseConfirm.includes("Chase solicitors for completion date"), chaseConfirm.slice(0, 200));
      ok("D2b · …naming the cases it will write to", /Ann|Ben/.test(chaseConfirm), chaseConfirm.slice(0, 300));
      ok("D2c · …and naming the one it is skipping, with the reason",
        /Cal/.test(chaseConfirm) && /already has an open/i.test(chaseConfirm), chaseConfirm.slice(0, 400));

      const t1 = await tasksOf(page, k1.caseId), t2 = await tasksOf(page, k2.caseId), t3 = await tasksOf(page, k3.caseId);
      const chases = (t) => t.filter((x) => x.title === "Chase solicitors for completion date");
      eq("D3 · the task is created EXACTLY once on each eligible case, with the exact title",
        [chases(t1).length, chases(t2).length], [1, 1]);
      eq("D3b · …and the case that already had one still has exactly one", chases(t3).length, 1);
      const today = await page.evaluate(() => localDateStr());
      eq("D4 · due today", chases(t1)[0].due_date, today);
      eq("D5 · assigned to the CASE's adviser, not to whoever ran the batch",
        [chases(t1)[0].assigned_to, chases(t2)[0].assigned_to], ["p2", "p3"]);
      ok("D6 · the toast tallies what it did and what it skipped",
        /task/i.test(await toastText(page)) && /skipped/i.test(await toastText(page)), await toastText(page));

      // idempotent: a second sweep over the same rows creates nothing
      await pipelineTable(page, { search: "R65Chase" });
      await page.click("#pipe-bulk-all");
      await wait(page, 400);
      page.__dialogs.length = 0;
      await page.click("#pipe-bulk-chase");
      await wait(page, 2200);
      const again = await tasksOf(page, k1.caseId);
      eq("D7 · running it again creates nothing — the open task is the idempotency key", chases(again).length, 1);
      ok("D7b · …and says so rather than silently doing nothing", /already/i.test(await toastText(page)), await toastText(page));

      /* ---- the document request ---- */
      const d1 = await mkCase(page, { first: "Dee", last: "R65Docs", stage: "application", assigned_to: "p2",
        docs: [{ item: "Passport", status: "requested" }, { item: "Payslip", status: "received" }] });
      const d2 = await mkCase(page, { first: "Eve", last: "R65Docs", stage: "application", assigned_to: "p2",
        docs: [{ item: "Passport", status: "received" }] });                                  // nothing outstanding
      const d3 = await mkCase(page, { first: "Fay", last: "R65Docs", stage: "application", assigned_to: "p2" }); // no checklist
      const d4 = await mkCase(page, { first: "Gus", last: "R65Docs", stage: "application", assigned_to: "p2", email: null,
        docs: [{ item: "Passport", status: "requested" }] });                                  // no email
      const d5 = await mkCase(page, { first: "Hal", last: "R65Docs", stage: "completed", assigned_to: "p2",
        docs: [{ item: "Passport", status: "requested" }] });                                  // not live
      const d6 = await mkCase(page, { first: "Ivy", last: "R65Docs", stage: "application", assigned_to: "p2",
        docs: [{ item: "Passport", status: "requested" }] });                                  // already queued, unsent
      await page.evaluate(async (o) => {
        const db = window.__mockDb;
        const { data: cs } = await db.from("cases").select("client_id").eq("id", o.caseId).single();
        const { data: cl } = await db.from("clients").select("email").eq("id", cs.client_id).single();
        await db.from("email_queue").insert({ case_id: o.caseId, client_id: cs.client_id, email_type: "docs_request", to_email: cl.email, status: "queued" });
      }, d6);

      await pipelineTable(page, { search: "R65Docs" });
      // the Completed segment is a different table; keep the live four in view and act on them
      const shown = await page.$$eval("#pipe-table .bulk-cb", (e) => e.length);
      ok("D8 · the seeded document cases are on screen", shown >= 5, shown);
      await page.click("#pipe-bulk-all");
      await wait(page, 400);
      page.__dialogs.length = 0;
      await page.click("#pipe-bulk-docs");
      await wait(page, 2600);
      const docConfirm = (page.__dialogs.filter((d) => d.type === "confirm").pop() || {}).message || "";
      eq("D9 · ONE confirm for the whole batch", page.__dialogs.filter((d) => d.type === "confirm").length, 1);
      ok("D9b · …naming who gets one, with their address and what is outstanding",
        /Dee/.test(docConfirm) && /outstanding/i.test(docConfirm), docConfirm.slice(0, 400));
      ok("D9c · …naming the case with nothing outstanding, and why",
        /Eve/.test(docConfirm) && /nothing outstanding/i.test(docConfirm), docConfirm.slice(0, 600));
      ok("D9d · …naming the case with no checklist, and why",
        /Fay/.test(docConfirm) && /no document checklist/i.test(docConfirm), docConfirm.slice(0, 600));
      ok("D9e · …naming the case with no email, and why",
        /Gus/.test(docConfirm) && /no email/i.test(docConfirm), docConfirm.slice(0, 800));
      ok("D9f · …and naming the case whose request is already queued and unsent",
        /Ivy/.test(docConfirm) && /already queued/i.test(docConfirm), docConfirm.slice(0, 800));

      const m1 = (await mailsOf(page, d1.caseId)).filter((m) => m.email_type === "docs_request");
      const m2 = (await mailsOf(page, d2.caseId)).filter((m) => m.email_type === "docs_request");
      const m3 = (await mailsOf(page, d3.caseId)).filter((m) => m.email_type === "docs_request");
      const m4 = (await mailsOf(page, d4.caseId)).filter((m) => m.email_type === "docs_request");
      const m5 = (await mailsOf(page, d5.caseId)).filter((m) => m.email_type === "docs_request");
      const m6 = (await mailsOf(page, d6.caseId)).filter((m) => m.email_type === "docs_request");
      eq("D10 · exactly the eligible case is queued", m1.length, 1);
      eq("D10b · nothing outstanding → nothing queued", m2.length, 0);
      eq("D10c · no checklist → nothing queued", m3.length, 0);
      eq("D10d · no email → nothing queued", m4.length, 0);
      eq("D10e · a completed case → nothing queued", m5.length, 0);
      eq("D10f · an unsent request already in the queue → nothing added (idempotent)", m6.length, 1);
      ok("D11 · the queued row is a production email type", m1[0] && m1[0].email_type === "docs_request", JSON.stringify(m1[0] || {}));

      /* And the OTHER direction, which is the production chase rule (R63 · A1: prod chases are
         FURTHER docs_request rows, there is no docs_chase type). A request that has already GONE
         must not block the next one — "already queued" means still sitting unsent, not "this case
         has ever been written to". */
      const sentState = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("email_queue").select("id,sent_at,status").eq("case_id", id).eq("email_type", "docs_request");
        return (data || []).map((m) => ({ sent: !!m.sent_at, status: m.status }));
      }, d1.caseId);
      ok("D12 · the batch's one send actually released the row it queued", sentState.some((m) => m.sent || m.status === "sent"), JSON.stringify(sentState));
      await pipelineTable(page, { search: "R65Docs" });
      await page.click("#pipe-bulk-all");
      await wait(page, 400);
      page.__dialogs.length = 0;
      await page.click("#pipe-bulk-docs");
      await wait(page, 2600);
      const second = page.__dialogs.map((d) => d.message).join(" | ");
      const m1b = (await mailsOf(page, d1.caseId)).filter((m) => m.email_type === "docs_request");
      ok("D12b · a case whose request has already gone can be chased again — a further docs_request row",
        m1b.length === 2, JSON.stringify(m1b.map((m) => m.status)));
      ok("D12c · …and the still-unsent one is STILL named as a skip, not written to twice",
        /Ivy/.test(second) && /already queued/i.test(second), second.slice(0, 500));
      eq("D12d · …with exactly one row on it, still", (await mailsOf(page, d6.caseId)).filter((m) => m.email_type === "docs_request").length, 1);

      // the Data-health copy is kept honest
      await goto(page, "data", 2600);
      const dh = await page.$eval("#dh-waitingdocs-panel", (e) => e.textContent.replace(/\s+/g, " ")).catch(() => "");
      ok("D13 · Data health still refuses a send-to-all on its own list", /no .send to all./i.test(dh), dh.slice(0, 200));
      ok("D13b · …and now points at the reviewed batch on the Pipeline bulk bar",
        /Pipeline/.test(dh) && /Send document request/.test(dh), dh.slice(0, 600));

      ok("§D · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §E — milestones open by stage, and the sticky action bar
       ===================================================================== */
    console.log("\n— §E · L4/L1 · Milestones open where they are the thing being read; one sticky action row");
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const mk = async (stage, extra) => (await mkCase(page, Object.assign({ last: "R65Mile", stage }, extra || {}))).caseId;
      const eEnq = await mk("enquiry");
      const eApp = await mk("application");
      const eOff = await mk("offer", { offer_expiry_date: "2031-01-01" });
      const eExc = await mk("exchange");
      const eCmp = await mk("completed");
      const openState = async (id) => {
        await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
        await page.evaluate((i) => window.openCase(i), id);
        await wait(page, 1400);
        return page.evaluate(() => {
          const d = document.querySelector("#case-milestones");
          return d ? d.open : null;
        });
      };
      eq("E1 · Enquiry — closed (nothing has happened yet)", await openState(eEnq), false);
      eq("E2 · Application — open", await openState(eApp), true);
      eq("E3 · Offer — open", await openState(eOff), true);
      eq("E4 · Exchange — open", await openState(eExc), true);
      eq("E5 · Completed — closed again", await openState(eCmp), false);

      // the sticky action row
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
      await page.evaluate((i) => window.openCase(i), eApp);
      await wait(page, 1500);
      const sticky = await page.evaluate(() => {
        const bar = document.querySelector("#cs-sticky-actions");
        if (!bar) return null;
        const cs = getComputedStyle(bar);
        const scroller = document.querySelector("#modal-backdrop");
        const sc = getComputedStyle(scroller);
        return {
          position: cs.position, top: cs.top,
          // R74: the height of the modal's new sticky × strip, which is what the bar pins below.
          topbarH: Math.round((document.querySelector("#modal .modal-topbar") || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
          bg: cs.backgroundColor, border: cs.borderBottomWidth,
          scrollerOverflow: sc.overflowY,
          modalScrolls: getComputedStyle(document.querySelector("#modal")).overflowY,
          firstInModalBody: (() => {
            const modal = document.querySelector("#modal");
            // R74: the × now lives in a sticky header STRIP of its own (panel A#11), so the strip
            // is chrome to be skipped here exactly as the bare button was.
            const kids = [...modal.children].filter((k) => !k.classList.contains("modal-close") && !k.classList.contains("modal-topbar"));
            return kids.findIndex((k) => k.id === "cs-sticky-actions") <= 1;
          })(),
          ids: {
            logcall: !!bar.querySelector("#cs-logcall-btn"),
            advance: !!bar.querySelector("#cs-advance-btn"),
            stageSel: !!bar.querySelector("#cs-stage-select"),
            appt: !!bar.querySelector("#act-appt") || !!bar.querySelector("#case-more-actions #act-appt"),
            more: !!bar.querySelector("#case-more-actions-toggle"),
            actionBar: !!bar.querySelector("#case-action-bar"),
          },
        };
      });
      ok("E6 · the action row exists", !!sticky, "no #cs-sticky-actions");
      /* R74 (panel A#11): the bar still pins to the top of the scrollport, but BELOW the modal's
         new close-button strip rather than sharing the top edge with a floating × (which is what
         its 72px right-hand gutter used to exist for). Re-pointed at the measured strip height, so
         this still asserts "immediately under the top chrome, with nothing above it but the strip". */
      eq("E7 · it is position:sticky, pinned under the modal's header strip", [sticky.position, sticky.top], ["sticky", sticky.topbarH + "px"]);
      ok("E7b · …and that strip is the only thing above it", sticky.topbarH > 0 && sticky.topbarH <= 60, String(sticky.topbarH));
      ok("E8 · …of the element that ACTUALLY scrolls (#modal-backdrop, not .modal)",
        sticky.scrollerOverflow === "auto" && sticky.modalScrolls === "visible", JSON.stringify(sticky));
      ok("E9 · …carrying the modal's own background and a hairline",
        sticky.bg !== "rgba(0, 0, 0, 0)" && parseFloat(sticky.border) > 0, JSON.stringify({ bg: sticky.bg, b: sticky.border }));
      ok("E10 · it is at the TOP of the modal, not below the whole history", sticky.firstInModalBody);
      eq("E11 · every action id survives the move (Log call · Advance · stage select · Book appointment · More actions)",
        sticky.ids, { logcall: true, advance: true, stageSel: true, appt: true, more: true, actionBar: true });
      // the buttons still WORK from their new home
      await page.click("#cs-logcall-btn");
      await wait(page, 700);
      ok("E12 · Log call still opens its panel from the sticky bar",
        await page.evaluate(() => !document.querySelector("#cs-logcall-panel").classList.contains("hidden")));

      // R40's case timeline and R61's protection bands still lay out
      const tl = await page.evaluate(() => ({
        filters: document.querySelectorAll("#case-tl-filters .tl-filter").length,
        list: !!document.querySelector("#case-events-list"),
        rows: document.querySelectorAll("#case-events-list .tl-item, #case-events-list .tl-row").length,
      }));
      ok("E13 · R40's case timeline still renders (both filter chips + the list)", tl.filters === 2 && tl.list, JSON.stringify(tl));
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
      await goto(page, "protection", 2200);
      const bands = await page.evaluate(() => {
        const t = document.querySelector("#prot-list-table");
        if (!t) return null;
        return {
          bands: [...t.querySelectorAll("tr.prot-band")].length,
          contract: [...t.querySelectorAll("tr")].filter((r) => r.querySelector(".prot-cb"))
            .every((r) => r.querySelector(".prot-actions button") && r.querySelector(".prot-status-set")),
        };
      });
      ok("E14 · R61's protection bands still lay out", bands && bands.bands >= 2 && bands.contract, JSON.stringify(bands));

      ok("§E · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §F — 390px: the table becomes a card list
       ===================================================================== */
    console.log("\n— §F · L9 · At 390px the pipeline table is a card list");
    {
      const page = await newPage(browser, "p1", { width: 390, height: 780 });
      const errBefore = (page.__err || []).length;
      await goto(page, "pipeline", 1600);
      const isTable = await page.evaluate(() => !document.querySelector("#table-wrap").classList.contains("hidden"));
      if (!isTable) { await page.click("#view-toggle"); await wait(page, 1800); }
      const m = await page.evaluate(() => ({
        cards: document.querySelectorAll("#pipe-card-list .card").length,
        table: !!document.querySelector("#pipe-table"),
        sortSel: !!document.querySelector("#pipe-mobile-sort"),
        sortDir: !!document.querySelector("#pipe-mobile-sortdir"),
        seg: document.querySelectorAll("#pipe-segment .seg-btn").length,
        search: !!document.querySelector("#board-search"),
        adviser: !!document.querySelector("#board-adviser"),
        csv: !!document.querySelector("#csv-btn"),
        stagePickers: document.querySelectorAll("#pipe-card-list .card-stage-move").length,
        pageW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
      }));
      ok("F1 · the table renders as cards, not a table", m.cards > 0 && !m.table, JSON.stringify(m));
      ok("F2 · one card per row, each with the board's own stage picker", m.stagePickers === m.cards, JSON.stringify(m));
      ok("F3 · the segment / adviser / search controls are still above it", m.seg >= 3 && m.search && m.adviser, JSON.stringify(m));
      ok("F4 · …and an explicit sort control replaces the column headers a card list has not got",
        m.sortSel && m.sortDir, JSON.stringify(m));
      eq("F5 · no horizontal page scroll at 390px", m.pageW, m.winW);

      // the cards follow the TABLE's sort order
      const groundTruth = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data } = await db.from("cases").select("id,waiting_on,solicitor_firm,stage");
        return Object.fromEntries((data || []).map((c) => [c.id, (c.waiting_on || "zz") + "|" + (c.solicitor_firm || "")]));
      });
      await page.selectOption("#pipe-mobile-sort", "waiting_on");
      await wait(page, 1800);
      const order = await page.$$eval("#pipe-card-list .card", (els) => els.map((e) => e.dataset.id));
      const keys = order.map((id) => groundTruth[id]);
      ok("F6 · picking a sort re-orders the cards on the table's own sort key",
        keys.every((k, i) => i === 0 || k >= keys[i - 1]), JSON.stringify(keys.slice(0, 8)));
      const afterSort = await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth);
      ok("F6b · …and still nothing scrolls sideways", afterSort);

      // the board on mobile is untouched
      await page.click("#view-toggle");
      await wait(page, 1800);
      const b = await page.evaluate(() => ({
        board: !document.querySelector("#board").classList.contains("hidden"),
        cards: document.querySelectorAll("#board .card").length,
        pickers: document.querySelectorAll("#board .card .card-stage-move").length,
        // #table-wrap keeps its last-rendered markup and is simply hidden — exactly as it has
        // always kept #pipe-table — so what matters is that the table view is not on screen.
        tableWrapHidden: document.querySelector("#table-wrap").classList.contains("hidden"),
        listVisible: !!document.querySelector("#table-wrap:not(.hidden) #pipe-card-list"),
      }));
      ok("F7 · the board on mobile is unchanged — cards with their per-card stage picker",
        b.board && b.cards > 0 && b.pickers === b.cards, JSON.stringify(b));
      ok("F7b · …and the card list is not on screen beside it", b.tableWrapHidden && !b.listVisible, JSON.stringify(b));

      ok("§F · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §G — the other personas
       ===================================================================== */
    console.log("\n— §G · No console errors for p2 and p4 across the surfaces this round touched");
    for (const persona of ["p2", "p4"]) {
      const page = await newPage(browser, persona);
      const errBefore = (page.__err || []).length;
      await goto(page, "pipeline", 1600);
      await page.evaluate(() => [...document.querySelectorAll("#pipe-segment .seg-btn")].find((b) => b.dataset.seg === "current").click());
      await wait(page, 1700);
      const cur = await page.evaluate(() => ({
        view: pipelineView,
        heads: [...document.querySelectorAll("#pipe-table th")].map((t) => t.textContent.replace(/[▲▼]/g, "").trim()),
      }));
      eq(`G · ${persona} · Current opens on the table`, cur.view, "table");
      ok(`G · ${persona} · with both new columns`, cur.heads.includes("Waiting on") && cur.heads.includes("Completing"), JSON.stringify(cur.heads));
      await page.evaluate(() => [...document.querySelectorAll("#pipe-segment .seg-btn")].find((b) => b.dataset.seg === "completed").click());
      await wait(page, 1700);
      const comp = await page.$$eval("#pipe-table th", (e) => e.map((x) => x.textContent.replace(/[▲▼]/g, "").trim()).filter(Boolean));
      ok(`G · ${persona} · the Completed table is untouched (no Waiting on / Completing)`,
        !comp.includes("Waiting on") && !comp.includes("Completing"), JSON.stringify(comp));
      await goto(page, "data", 2600);
      await goto(page, "dashboard", 2000);
      ok(`G · ${persona} · no console errors across pipeline / data health / dashboard`, noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r65_pipeline: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
