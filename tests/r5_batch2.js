#!/usr/bin/env node
/* =============================================================================
   tests/r5_batch2.js — acceptance tests for PLAN-R5 Batch 2
   ("Case modal integrity — save, offer parse, fees, stage moves")

   One block per plan item:
     1. R5-3  the modal's own writes no longer poison the next Save; a genuine
              conflict offers a choice and Cancel keeps the operator's edits.
     2. R5-4  a parsed mortgage offer proposes a Current/Incoming diff and writes
              NOTHING until Apply; Discard writes nothing at all.
     3. R5-12 mark-fee-paid captures a real date per fee type; part payment leaves
              fee_status alone; a future date is refused.
     4. R5-20 Not Proceeding costs a reason — on the board move, on the Save path,
              and once for a bulk move (which also closes the cases' open tasks).
     5. R5-15 an expected completion in the past (or long after the offer expires)
              is questioned before it is saved.
     6. R5-34 a protection-gate refusal opens the case ON the protection select.
     7. R5-36 a new case is assigned to the signed-in adviser, not to nobody.
     8. R5-49 Log call outcome chips prefix the note; the protection tick records
              the conversation and unblocks the pipeline gate.

   Run:  node /root/nx/tests/r5_batch2.js   (expects a static server on 8099;
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

/* R15 — the case action bar is now stage/kind-reactive: only some of the 8
   action ids are PRIMARY (directly clickable) for a given case's stage; the
   rest live in the "More actions" overflow (#case-more-actions), which is
   display:none (via .hidden on the wrap's child) until the toggle is
   clicked. Every action id still exists in the DOM at every stage — this
   helper just finds out where it currently lives and opens the overflow
   first when needed, then clicks it exactly as before. */
async function clickAction(page, id) {
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, `#${id}`);
  if (!visible) await page.click("#case-more-actions-toggle");
  await page.click(`#${id}`);
}

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
    r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}

/* Dialogs are load-bearing in this batch (the conflict choice, the date warnings, the bulk
   confirm), so every page records what it was asked and answers from a plan: __dialogPlan is
   consumed in order, __dialogAnswer is the fallback. */
async function newPage(browser, persona) {
  const page = await browser.newPage();
  page.__dialogs = [];
  page.__dialogAnswer = "accept";
  page.__dialogPlan = [];
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    const next = page.__dialogPlan.length ? page.__dialogPlan.shift() : page.__dialogAnswer;
    if (next === "dismiss") await d.dismiss();
    else if (typeof next === "string" && next.startsWith("text:")) await d.accept(next.slice(5));
    else await d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const snapshot = (page, fn, arg) => page.evaluate(fn, arg);
const lastDialog = (page, re) => (page.__dialogs.filter((d) => re.test(d.message)).slice(-1)[0] || {}).message || "";
const caseRow = (page, id) => page.evaluate(async (cid) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", cid).single();
  return data;
}, id);
const notesFor = (page, id) => page.evaluate(async (cid) => {
  const { data } = await window.__mockDb.from("case_notes").select("body,created_at").eq("case_id", cid);
  return (data || []).map((n) => n.body);
}, id);
// R12b flake fix (R5-12) — this used to format with the Node PROCESS's own local timezone
// (getFullYear/getMonth/getDate), while the app's own "today" for this exact field
// (admin/app.js's `const today = localDateStr()`, just above the fee-date <input max=...>) is
// pinned to Europe/London. The two only disagreed for the hour 23:00–00:00 UTC (00:00–01:00
// London during BST) when the test happened to run in that window — a process-local UTC read
// says "still today", Europe/London says "already tomorrow". Root-caused, not tolerance-widened:
// dstr() now uses the identical Intl.DateTimeFormat("en-CA", {timeZone:"Europe/London"}) call
// localDateStr() does, so this test and the app can never read different clocks again.
const dstr = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + offsetDays * 86400000));
// The case form lives inside a collapsed <details> drawer — open it before driving its fields.
// R33 — scoped to #modal: Settings' new #diag-details shares the `.case-details` styling class
// and, being static markup, is always in the DOM — an unscoped selector now matches it first.
const openDetails = (page) => page.evaluate(() => { const d = document.querySelector("#modal .case-details"); if (d) d.open = true; });
const PDF = { name: "offer.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% mock offer\n%%EOF\n") };

async function main() {
  let srv = null;
  if (!(await serverUp())) {
    srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
    await new Promise((r) => setTimeout(r, 1200));
  }
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       1 · R5-3 — the case modal's own writes must not read as somebody
       else's edit, and a real conflict must never discard typing
       =================================================================== */
    console.log("\n— R5-3 · sending an email from the modal, then saving it (p3 Luke, ca033 Duncan Armitage)");
    {
      const page = await newPage(browser, "p3");
      const before = await caseRow(page, "ca033");
      ok("fixture: ca033 has a rate-end date and a contactable client", !!before.rate_end_date, JSON.stringify(before.rate_end_date));

      await page.evaluate(() => window.openCase("ca033"));
      await page.waitForTimeout(700);
      await clickAction(page, "act-reminder");     // stamps rate_reminder_queued_at on the case row
      await page.waitForTimeout(1200);
      const stamped = await caseRow(page, "ca033");
      ok("the send stamped the case (so the row moved under the open form)", !!stamped.rate_reminder_queued_at
        && stamped.updated_at !== before.updated_at, `updated_at ${before.updated_at} → ${stamped.updated_at}`);

      await openDetails(page);
      await page.selectOption("#case-form select[name='protection_status']", "quoted");
      page.__dialogs = [];
      await page.click("#modal-save");
      await page.waitForTimeout(900);
      const saved = await caseRow(page, "ca033");
      eq("R5-3 · the edit saved (protection is quoted in the database)", saved.protection_status, "quoted");
      const toastTxt = await page.textContent("#toast");
      ok("R5-3 · the toast says it saved", /Case saved/.test(toastTxt || ""), JSON.stringify(toastTxt));
      ok("R5-3 · no false edit-conflict was raised", !page.__dialogs.some((d) => /changed elsewhere/i.test(d.message)),
        JSON.stringify(page.__dialogs.map((d) => d.message)));
      const modalShut = await page.evaluate(() => document.querySelector("#modal-backdrop").classList.contains("hidden"));
      ok("R5-3 · a successful save closes the modal", modalShut === true);
      await page.close();
    }

    console.log("\n— R5-3 · a GENUINE concurrent edit offers a choice, and Cancel keeps the edits on screen");
    {
      const page = await newPage(browser, "p3");
      await page.evaluate(() => window.openCase("ca034"));
      await page.waitForTimeout(700);
      // Type into the form, then have "somebody else" change the same case underneath.
      await openDetails(page);
      await page.fill("#case-form input[name='product_name']", "MY UNSAVED EDIT");
      await page.evaluate(async () => {
        await window.__mockDb.from("cases").update({ lender: "Someone Else Bank" }).eq("id", "ca034");
      });
      page.__dialogs = [];
      page.__dialogPlan = ["dismiss"];            // Cancel = keep editing
      await page.click("#modal-save");
      await page.waitForTimeout(900);
      const msg = lastDialog(page, /changed elsewhere/i);
      ok("R5-3 · the conflict is explained as a choice, not an order", /OK = reload/.test(msg) && /Cancel = keep editing/.test(msg), JSON.stringify(msg));
      const stillOpen = await page.evaluate(() => ({
        open: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
        product: (document.querySelector("#case-form input[name='product_name']") || {}).value,
      }));
      eq("R5-3 · Cancel keeps the modal open with the typed value intact", stillOpen, { open: true, product: "MY UNSAVED EDIT" });
      const midway = await caseRow(page, "ca034");
      ok("R5-3 · nothing was written by the refused save", midway.product_name !== "MY UNSAVED EDIT" && midway.lender === "Someone Else Bank",
        JSON.stringify({ product: midway.product_name, lender: midway.lender }));

      // Saving again is a deliberate overwrite and must now succeed (no unwinnable loop).
      page.__dialogPlan = [];
      await page.click("#modal-save");
      await page.waitForTimeout(900);
      const after = await caseRow(page, "ca034");
      eq("R5-3 · pressing Save again writes the operator's version", after.product_name, "MY UNSAVED EDIT");
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       2 · R5-4 — the AI-read offer proposes; it does not write
       =================================================================== */
    console.log("\n— R5-4 · offer parse renders a diff and writes nothing until Apply (ca043)");
    {
      const page = await newPage(browser, "p3");
      const before = await caseRow(page, "ca043");
      await page.evaluate(() => window.openCase("ca043"));
      await page.waitForTimeout(700);
      await page.setInputFiles("#offer-file", PDF);
      await page.waitForTimeout(1800);

      const diff = await page.evaluate(() => {
        const panel = document.querySelector("#offer-diff");
        if (!panel || panel.classList.contains("hidden")) return null;
        return [...panel.querySelectorAll("tbody tr")].map((tr) => ({
          field: tr.children[0].textContent.trim(),
          current: tr.children[1].textContent.trim(),
          incoming: tr.children[2].textContent.trim(),
          conflict: /conflict/.test(tr.children[2].textContent),
          ticked: tr.querySelector("input[type=checkbox]").checked,
          id: tr.querySelector("input[type=checkbox]").id,
        }));
      });
      ok("R5-4 · the diff panel rendered with rows", !!diff && diff.length >= 5, JSON.stringify(diff && diff.length));
      const lenderRow = (diff || []).find((r) => r.field === "Lender");
      ok("R5-4 · Current vs Incoming are both shown for the lender", !!lenderRow && /Aldermore/.test(lenderRow.current) && /Coventry/.test(lenderRow.incoming), JSON.stringify(lenderRow));
      ok("R5-4 · a value that would overwrite is flagged as a conflict and starts UNticked",
        !!lenderRow && lenderRow.conflict === true && lenderRow.ticked === false, JSON.stringify(lenderRow));
      const emptyRows = (diff || []).filter((r) => /— empty —/.test(r.current));
      ok("R5-4 · fields that are empty today are pre-ticked", emptyRows.length > 0 && emptyRows.every((r) => r.ticked === true),
        JSON.stringify(emptyRows.map((r) => [r.field, r.ticked])));

      const midParse = await caseRow(page, "ca043");
      const notesMid = await notesFor(page, "ca043");
      ok("R5-4 · NOTHING was written at parse time (fields, offer_doc_path and note all untouched)",
        midParse.lender === before.lender && !midParse.offer_doc_path && !notesMid.some((n) => /From mortgage offer/.test(n)),
        JSON.stringify({ lender: midParse.lender, doc: midParse.offer_doc_path, notes: notesMid.filter((n) => /offer/i.test(n)) }));

      /* Tick the lender conflict as well.
         UPDATED (round 6.4) — this counted 3 because ca043 had two empty fields the
         offer could fill (ERC end date, offer expiry). `parse-offer` was redeployed
         this round and now returns the security address off the offer letter, which
         ca043 also has empty, so there are three pre-ticked empties and the count is
         4. Nothing about the rule changed — "fields that are empty today are
         pre-ticked" is asserted above and still passes — so the expectation is
         updated to the number of empty fields the parse can now fill, and the new
         one is named rather than absorbed into a bare count. */
      await page.click(`#${lenderRow.id}`);
      const expected = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#offer-diff tbody tr")].filter((tr) => tr.querySelector("input").checked);
        return rows.map((tr) => tr.children[0].textContent.trim());
      });
      eq("R5-4 · four fields are selected for apply", expected.length, 4);
      ok("R5-4 · …and the property address the offer names is one of them",
        expected.indexOf("Property address") >= 0, JSON.stringify(expected));

      page.__dialogs = [];
      await page.click("#offer-apply");
      await page.waitForTimeout(1400);
      const after = await caseRow(page, "ca043");
      const notesAfter = await notesFor(page, "ca043");
      eq("R5-4 · the ticked lender persisted", after.lender, "Coventry Building Society");
      ok("R5-4 · the other two ticked fields persisted", !!after.erc_end_date && !!after.offer_expiry_date,
        JSON.stringify({ erc: after.erc_end_date, expiry: after.offer_expiry_date, applied: expected }));
      ok("R5-4 · unticked conflicts were NOT applied", Number(after.loan_amount) === Number(before.loan_amount) && Number(after.term_years) === Number(before.term_years),
        JSON.stringify({ loan: after.loan_amount, term: after.term_years }));
      ok("R5-4 · the document is attached in the same write", !!after.offer_doc_path, JSON.stringify(after.offer_doc_path));
      ok("R5-4 · the AI-read note was written on apply", notesAfter.some((n) => /^From mortgage offer \(AI-read\)/.test(n)), JSON.stringify(notesAfter.slice(0, 3)));
      ok("R5-4 · no conflict dialog was raised by the apply", !page.__dialogs.length, JSON.stringify(page.__dialogs));
      const drawer = await page.evaluate(() => {
        // R33 — scoped to #modal (see openDetails above — the same collision applies here).
        const d = document.querySelector("#modal .case-details");
        return { open: !!(d && d.open), panelGone: !!document.querySelector("#offer-diff") && document.querySelector("#offer-diff").classList.contains("hidden") };
      });
      eq("R5-4 · the case re-opens with the details drawer open and the proposal cleared", drawer, { open: true, panelGone: true });
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— R5-4 · Discard writes nothing at all (ca047)");
    {
      const page = await newPage(browser, "p3");
      const before = await caseRow(page, "ca047");
      const notesBefore = await notesFor(page, "ca047");
      await page.evaluate(() => window.openCase("ca047"));
      await page.waitForTimeout(700);
      await page.setInputFiles("#offer-file", PDF);
      await page.waitForTimeout(1800);
      ok("the diff is on screen before discarding", await page.evaluate(() => !document.querySelector("#offer-diff").classList.contains("hidden")));
      await page.click("#offer-discard");
      await page.waitForTimeout(700);
      const after = await caseRow(page, "ca047");
      const notesAfter = await notesFor(page, "ca047");
      ok("R5-4 · Discard leaves the case exactly as it was", after.lender === before.lender && after.rate_percent === before.rate_percent
        && !after.offer_doc_path && notesAfter.length === notesBefore.length,
        JSON.stringify({ lender: after.lender, doc: after.offer_doc_path, notes: notesAfter.length - notesBefore.length }));
      ok("R5-4 · the proposal panel is cleared away", await page.evaluate(() => document.querySelector("#offer-diff").classList.contains("hidden")));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       3 · R5-12 / B7 — mark fee paid, per type, with real dates
       =================================================================== */
    console.log("\n— R5-12 · part payment: broker paid, proc not (ca027 · proc £1,400 + broker £495)");
    {
      const page = await newPage(browser, "p2");
      const before = await caseRow(page, "ca027");
      ok("fixture: ca027 has a proc fee and a broker fee, unpaid", Number(before.proc_fee) > 0 && Number(before.broker_fee) > 0 && before.fee_status !== "paid",
        JSON.stringify({ proc: before.proc_fee, broker: before.broker_fee, status: before.fee_status }));

      await page.evaluate(() => window.openCase("ca027"));
      await page.waitForTimeout(700);
      await clickAction(page, "act-paid");
      await page.waitForTimeout(500);
      const rows = await page.evaluate(() => [...document.querySelectorAll("#overlay-modal .ovl-fee-row")].map((r) => ({
        key: r.querySelector(".fee-chk").dataset.key, text: r.textContent.replace(/\s+/g, " ").trim(),
      })));
      eq("R5-12 · one row per fee type that has an amount", rows.map((r) => r.key), ["proc", "broker"]);
      ok("R5-12 · each row names its amount", /£1,400/.test(rows[0].text) && /£495/.test(rows[1].text), JSON.stringify(rows.map((r) => r.text)));
      const maxAttr = await page.evaluate(() => document.querySelector("#overlay-modal .fee-date").getAttribute("max"));
      eq("R5-12 · the date input cannot be set past today in the UI", maxAttr, dstr(0));

      const brokerDate = dstr(-7);
      await page.uncheck("#overlay-modal .fee-chk[data-key='proc']");
      await page.fill("#overlay-modal .fee-date[data-key='broker']", brokerDate);
      const btnLabel = await page.textContent("#fee-ok");
      ok("R5-12 · the button totals only what is ticked", /£495/.test(btnLabel || ""), JSON.stringify(btnLabel));
      await page.click("#fee-ok");
      await page.waitForTimeout(1000);

      const mid = await caseRow(page, "ca027");
      ok("R5-12 · the broker fee carries the date the money arrived", String(mid.broker_fee_paid_at || "").slice(0, 10) === brokerDate,
        JSON.stringify(mid.broker_fee_paid_at));
      eq("R5-12 · the unticked proc fee has no date", mid.proc_fee_paid_at, null);
      eq("R5-12 · a part-paid case does NOT read as paid", mid.fee_status, before.fee_status);
      eq("R5-12 · and the legacy single date is not stamped either", mid.fee_paid_at, null);

      // …now the proc fee arrives, later. The case completes and takes the LATER date.
      await page.waitForTimeout(300);
      await clickAction(page, "act-paid");
      await page.waitForTimeout(500);
      const shown = await page.evaluate(() => [...document.querySelectorAll("#overlay-modal .ovl-fee-row")].map((r) => ({
        key: r.querySelector(".fee-chk").dataset.key, disabled: r.querySelector(".fee-chk").disabled,
      })));
      ok("R5-12 · the already-paid broker fee is shown but locked", (shown.find((r) => r.key === "broker") || {}).disabled === true, JSON.stringify(shown));

      // A future date is refused rather than banked.
      await page.fill("#overlay-modal .fee-date[data-key='proc']", dstr(3));
      await page.click("#fee-ok");
      await page.waitForTimeout(400);
      const err = await page.textContent("#fee-err");
      ok("R5-12 · a future payment date is refused with a reason", /future/i.test(err || ""), JSON.stringify(err));
      const stillThere = await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      ok("R5-12 · the capture stays open so the date can be corrected", stillThere === true);
      const untouched = await caseRow(page, "ca027");
      eq("R5-12 · nothing was written by the refused attempt", untouched.proc_fee_paid_at, null);

      const procDate = dstr(-1);
      await page.fill("#overlay-modal .fee-date[data-key='proc']", procDate);
      await page.click("#fee-ok");
      await page.waitForTimeout(1000);
      const done = await caseRow(page, "ca027");
      ok("R5-12 · the proc fee carries its own, later date", String(done.proc_fee_paid_at || "").slice(0, 10) === procDate, JSON.stringify(done.proc_fee_paid_at));
      eq("R5-12 · every fee is now paid, so the case reads paid", done.fee_status, "paid");
      eq("R5-12 · the legacy date is the LAST payment", String(done.fee_paid_at || "").slice(0, 10), procDate);
      const shownDates = await page.evaluate(() => {
        const el = [...document.querySelectorAll("#case-form .s")].find((x) => /^Paid:/.test(x.textContent));
        return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
      });
      ok("R5-12 · the case details show both paid dates read-only", !!shownDates && /Proc fee/.test(shownDates) && /Broker fee/.test(shownDates), JSON.stringify(shownDates));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       4 · R5-20 / B3 — Not Proceeding costs a reason
       =================================================================== */
    console.log("\n— R5-20 · a single move cannot happen without a reason (ca028)");
    {
      const page = await newPage(browser, "p1");
      const before = await caseRow(page, "ca028");
      // Start the move, then try to confirm with no reason chosen.
      await page.evaluate(() => { window.__moveResult = window.moveCaseToStage("ca028", "not_proceeding"); });
      await page.waitForTimeout(600);
      ok("R5-20 · the reason capture opens", await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden")));
      await page.click("#lost-ok");
      await page.waitForTimeout(300);
      const err = await page.textContent("#lost-err");
      ok("R5-20 · confirming with no reason is refused", /choose a reason/i.test(err || ""), JSON.stringify(err));
      // Cancel aborts the move entirely.
      await page.click("#lost-cancel");
      await page.waitForTimeout(600);
      const cancelled = await caseRow(page, "ca028");
      eq("R5-20 · cancelling the capture cancels the move", cancelled.stage, before.stage);
      eq("R5-20 · …and writes nothing", await page.evaluate(() => window.__moveResult), "cancelled");

      // Now do it properly. (Fire-and-store: the call does not settle until the capture is answered.)
      await page.evaluate(() => { window.__moveResult = window.moveCaseToStage("ca028", "not_proceeding"); });
      await page.waitForTimeout(600);
      await page.selectOption("#lost-reason", "went_direct");
      await page.fill("#lost-note", "Lender called them first");
      await page.click("#lost-ok");
      await page.waitForTimeout(1000);
      const after = await caseRow(page, "ca028");
      eq("R5-20 · the case moved", after.stage, "not_proceeding");
      eq("R5-20 · the reason is stored on the case", after.lost_reason, "went_direct");
      eq("R5-20 · so is the note", after.lost_detail, "Lender called them first");
      const notes = await notesFor(page, "ca028");
      ok("R5-20 · the case history says what happened, in words",
        notes.some((n) => /^Not proceeding — Went direct to the lender: Lender called them first$/.test(n)), JSON.stringify(notes.slice(0, 3)));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— R5-20 · the Save path asks too (stage select → Not Proceeding, ca020)");
    {
      const page = await newPage(browser, "p1");
      await page.evaluate(() => window.openCase("ca020"));
      await page.waitForTimeout(700);
      await openDetails(page);
      await page.selectOption("#case-form select[name='stage']", "not_proceeding");
      await page.click("#modal-save");
      await page.waitForTimeout(600);
      ok("R5-20 · saving into Not Proceeding opens the same capture",
        await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden")));
      await page.selectOption("#lost-reason", "rate_price");
      await page.click("#lost-ok");
      await page.waitForTimeout(1200);
      const after = await caseRow(page, "ca020");
      eq("R5-20 · the save landed with the reason attached", [after.stage, after.lost_reason], ["not_proceeding", "rate_price"]);
      const notes = await notesFor(page, "ca020");
      ok("R5-20 · with the matching history note", notes.some((n) => n === "Not proceeding — Rate or price"), JSON.stringify(notes.slice(0, 3)));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— R5-20 · a bulk move asks once, stamps all, and closes their open tasks");
    {
      const page = await newPage(browser, "p1");
      await page.click('[data-page="pipeline"]');
      await page.waitForTimeout(900);
      const isBoard = await page.evaluate(() => !document.querySelector("#board").classList.contains("hidden"));
      if (isBoard) { await page.click("#view-toggle"); await page.waitForTimeout(900); }
      // Three live cases that are on screen and carry open tasks.
      const picked = await page.evaluate(async () => {
        const ids = [...document.querySelectorAll("#pipe-table .bulk-cb")].map((cb) => cb.dataset.id);
        const { data: cases } = await window.__mockDb.from("cases").select("id,stage").in("id", ids);
        const { data: tasks } = await window.__mockDb.from("case_tasks").select("id,case_id,done_at");
        const live = (cases || []).filter((c) => c.stage !== "completed" && c.stage !== "not_proceeding"
          && (tasks || []).some((t) => t.case_id === c.id && !t.done_at));
        return live.slice(0, 3).map((c) => c.id);
      });
      eq("fixture: three live cases with open tasks are selectable", picked.length, 3);
      const openBefore = await page.evaluate(async (ids) => {
        const { data } = await window.__mockDb.from("case_tasks").select("id,case_id,done_at").in("case_id", ids);
        return (data || []).filter((t) => !t.done_at).length;
      }, picked);
      ok("fixture: they have open tasks between them", openBefore >= 3, String(openBefore));

      for (const id of picked) await page.check(`#pipe-table .bulk-cb[data-id="${id}"]`);
      page.__dialogs = [];
      await page.selectOption("#pipe-bulk-stage", "not_proceeding");
      await page.waitForTimeout(700);
      ok("R5-20 · the batch is asked for ONE reason", await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden")));
      await page.selectOption("#lost-reason", "another_broker");
      await page.fill("#lost-note", "Undercut on fee");
      await page.click("#lost-ok");
      await page.waitForTimeout(1600);

      const confirmMsg = lastDialog(page, /Move 3 case/);
      ok("R5-20 · the confirm names the reason it is about to stamp on all three",
        /Used another broker/.test(confirmMsg) && /Undercut on fee/.test(confirmMsg), JSON.stringify(confirmMsg));
      ok("R5-20 · …and warns that their open tasks will close", /open tasks will be closed/i.test(confirmMsg), JSON.stringify(confirmMsg));

      const result = await page.evaluate(async (ids) => {
        const { data: cases } = await window.__mockDb.from("cases").select("id,stage,lost_reason,lost_detail").in("id", ids);
        const { data: tasks } = await window.__mockDb.from("case_tasks").select("id,case_id,done_at").in("case_id", ids);
        const { data: notes } = await window.__mockDb.from("case_notes").select("case_id,body").in("case_id", ids);
        return {
          stages: (cases || []).map((c) => c.stage),
          reasons: (cases || []).map((c) => c.lost_reason),
          details: (cases || []).map((c) => c.lost_detail),
          openTasks: (tasks || []).filter((t) => !t.done_at).length,
          notes: (notes || []).filter((n) => /^Not proceeding — Used another broker/.test(n.body)).length,
        };
      }, picked);
      eq("R5-20 · all three moved", result.stages, ["not_proceeding", "not_proceeding", "not_proceeding"]);
      eq("R5-20 · all three carry the same reason", result.reasons, ["another_broker", "another_broker", "another_broker"]);
      eq("R5-20 · all three carry the same note", result.details, ["Undercut on fee", "Undercut on fee", "Undercut on fee"]);
      eq("R5-20 · each got a case-history line", result.notes, 3);
      eq("R5-20 · none of them is still nagging anybody with an open task", result.openTasks, 0);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       5 · R5-15 — past / impossible completion dates are questioned
       =================================================================== */
    console.log("\n— R5-15 · expected completion sanity (ca046, an Offer case)");
    {
      const page = await newPage(browser, "p2");
      const before = await caseRow(page, "ca046");
      await page.evaluate(() => window.openCase("ca046"));
      await page.waitForTimeout(700);
      await openDetails(page);
      await page.fill("#case-expected-completion", "2025-01-15");
      page.__dialogs = [];
      page.__dialogPlan = ["dismiss"];
      await page.click("#modal-save");
      await page.waitForTimeout(800);
      ok("R5-15 · a past expected completion is questioned before saving", /is in the past/.test(lastDialog(page, /past/)), JSON.stringify(page.__dialogs));
      const kept = await page.evaluate(() => ({
        open: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
        value: (document.querySelector("#case-expected-completion") || {}).value,
      }));
      eq("R5-15 · cancelling keeps the operator in the form with their date", kept, { open: true, value: "2025-01-15" });
      const unsaved = await caseRow(page, "ca046");
      eq("R5-15 · and nothing was written", unsaved.expected_completion_date, before.expected_completion_date);

      // …and a completion long after the offer expires gets its own warning.
      const wayLate = dstr(120);
      await page.fill("#case-form input[name='offer_expiry_date']", dstr(20));
      await page.fill("#case-expected-completion", wayLate);
      page.__dialogs = [];
      page.__dialogPlan = ["dismiss"];
      await page.click("#modal-save");
      await page.waitForTimeout(800);
      ok("R5-15 · a completion more than 30 days past offer expiry is questioned",
        /more than 30 days after the offer expires/.test(lastDialog(page, /offer expires/)), JSON.stringify(page.__dialogs));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       6 · R5-34 — the protection gate routes to its own fix
       =================================================================== */
    console.log("\n— R5-34 · a blocked move opens the case on the protection select (ca038 Yvonne Kerr)");
    {
      const page = await newPage(browser, "p1");
      const res = await page.evaluate(() => window.moveCaseToStage("ca038", "application"));
      await page.waitForTimeout(1200);
      eq("R5-34 · the move is still blocked", res, "blocked");
      const state = await page.evaluate(() => {
        const sel = document.querySelector("#case-form select[name='protection_status']");
        // R33 — scoped to #modal (see openDetails above — the same collision applies here).
        const det = document.querySelector("#modal .case-details");
        return {
          modalOpen: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
          caseId: (document.querySelector("#case-form") || {}).dataset ? document.querySelector("#case-form").dataset.caseId : null,
          drawerOpen: !!(det && det.open),
          highlighted: !!sel && /red/.test(sel.style.borderColor || ""),
          focused: !!sel && document.activeElement === sel,
        };
      });
      eq("R5-34 · the refusal lands on the field that unblocks it", state,
        { modalOpen: true, caseId: "ca038", drawerOpen: true, highlighted: true, focused: true });
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       7 · R5-36 — a new case starts on me
       =================================================================== */
    console.log("\n— R5-36 · + New case pre-selects the signed-in adviser");
    {
      for (const persona of ["p2", "p1"]) {
        const page = await newPage(browser, persona);
        await page.click('[data-page="pipeline"]');
        await page.waitForTimeout(700);
        await page.click("#new-case-btn");
        await page.waitForTimeout(700);
        const got = await page.evaluate(() => ({
          value: (document.querySelector("#case-form select[name='assigned_to']") || {}).value,
          me: window.__mock.personas[window.__mock.persona].id,
          label: (() => { const s = document.querySelector("#case-form select[name='assigned_to']"); return s ? s.options[s.selectedIndex].textContent : null; })(),
        }));
        ok(`R5-36 · ${persona}: Assigned to defaults to the signed-in user (${got.label})`, got.value === got.me, JSON.stringify(got));
        ok("no console errors", !page.__err, JSON.stringify(page.__err));
        await page.close();
      }
    }

    /* ===================================================================
       8 · R5-49 — Log call outcome chips + protection tick
       =================================================================== */
    console.log("\n— R5-49 · log a call with an outcome chip and the protection tick (ca030)");
    {
      const page = await newPage(browser, "p3");
      const before = await caseRow(page, "ca030");
      eq("fixture: ca030 has no protection conversation recorded", before.protection_status, "not_discussed");
      const blockedFirst = await page.evaluate(() => window.moveCaseToStage("ca030", "offer"));
      await page.waitForTimeout(900);
      eq("fixture: the pipeline gate currently blocks it", blockedFirst, "blocked");

      await page.evaluate(() => window.openCase("ca030"));
      await page.waitForTimeout(700);
      await page.click("#cs-logcall-btn");
      await page.waitForTimeout(300);
      const chips = await page.evaluate(() => [...document.querySelectorAll("#cs-call-outcome-chips .tl-chip")].map((b) => b.dataset.outcome));
      eq("R5-49 · the four outcomes are one click each", chips,
        ["No answer", "Left voicemail", "Spoke — will call back", "Spoke — actioned"]);
      await page.click('#cs-call-outcome-chips .tl-chip[data-outcome="Spoke — actioned"]');
      await page.fill("#cs-call-note", "agreed to send the offer pack");
      await page.check("#cs-call-prot");
      await page.click("#cs-call-save");
      await page.waitForTimeout(1200);

      const notes = await notesFor(page, "ca030");
      ok("R5-49 · the chip prefixes the saved note", notes.some((n) => n === "Call: Spoke — actioned — agreed to send the offer pack"), JSON.stringify(notes.slice(0, 3)));
      const after = await caseRow(page, "ca030");
      eq("R5-49 · the tick recorded the protection conversation", after.protection_status, "discussed");
      const formVal = await page.evaluate(() => (document.querySelector("#case-form select[name='protection_status']") || {}).value);
      eq("R5-49 · the open form moved with it (a later Save can't undo it)", formVal, "discussed");
      // …and the very next Save must still work: the modal wrote the case row itself (R5-3).
      page.__dialogs = [];
      await openDetails(page);
      await page.fill("#case-form input[name='product_name']", "Post-call product");
      await page.click("#modal-save");
      await page.waitForTimeout(900);
      const saved = await caseRow(page, "ca030");
      eq("R5-3 + R5-49 · saving straight after the tick is not a false conflict", [saved.product_name, saved.protection_status], ["Post-call product", "discussed"]);

      const nowMoves = await page.evaluate(() => window.moveCaseToStage("ca030", "offer"));
      await page.waitForTimeout(900);
      eq("R5-49 · the pipeline gate now passes", nowMoves, "moved");
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
    /* ===================================================================
       9 · Feature detection — the same two flows against a database that
       has NOT had migration M2 applied (older DB tolerated, per the plan)
       =================================================================== */
    console.log("\n— M2 feature-detect · per-fee dates and lost reasons degrade instead of failing");
    {
      const page = await newPage(browser, "p1");
      await page.evaluate(() => window.__mock.setMigrations({ m2: false }));

      // (a) Mark fee paid falls back to the single legacy date and says why.
      await page.evaluate(() => window.openCase("ca011"));
      await page.waitForTimeout(700);
      page.__dialogs = [];
      await clickAction(page, "act-paid");
      await page.waitForTimeout(900);
      const feeMsg = lastDialog(page, /M2|paid/i);
      ok("M2 · the fee capture explains the missing migration instead of erroring", /migration M2/i.test(feeMsg), JSON.stringify(feeMsg));
      const feeCase = await caseRow(page, "ca011");
      eq("M2 · the legacy write still lands", feeCase.fee_status, "paid");
      ok("M2 · with the legacy single date", !!feeCase.fee_paid_at, JSON.stringify(feeCase.fee_paid_at));

      // (b) A Not-Proceeding move still records the reason — as a note.
      const notesBefore = await notesFor(page, "ca031");
      await page.evaluate(() => { window.__moveResult = window.moveCaseToStage("ca031", "not_proceeding"); });
      await page.waitForTimeout(700);
      await page.selectOption("#lost-reason", "valuation");
      await page.click("#lost-ok");
      await page.waitForTimeout(1200);
      const moved = await caseRow(page, "ca031");
      eq("M2 · the move still happens on an un-migrated database", moved.stage, "not_proceeding");
      eq("M2 · …and returns a clean result, not an error", await page.evaluate(() => window.__moveResult), "moved");
      const notesAfter = await notesFor(page, "ca031");
      ok("M2 · the reason survives as a case-history note", notesAfter.length === notesBefore.length + 1
        && notesAfter.some((n) => n === "Not proceeding — Valuation problem"), JSON.stringify(notesAfter.slice(0, 2)));
      const toastTxt = await page.textContent("#toast");
      ok("M2 · and the operator is told the column is missing", /migration M2/i.test(toastTxt || ""), JSON.stringify(toastTxt));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       10 · M7 (round 6) — cases.property_address, and the multi-property
       shape the fixtures now carry. Nothing in the deployed app reads this
       column yet; what is under test is that the harness models it the way
       production does — nullable, un-backfilled and switchable off — and
       that the fixture book contains the awkward shapes (one client / many
       properties, one property / many cases, one address / two clients)
       rather than one tidy address per client.
       =================================================================== */
    console.log("\n— M7 · property_address parity and the multi-property fixtures");
    {
      const page = await newPage(browser, "p1");
      const shape = await page.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases").select("id,client_id,property_address,created_at,stage,case_kind");
        const { data: clients } = await window.__mockDb.from("clients").select("id,first_name,last_name");
        const nameOf = Object.fromEntries(clients.map((c) => [c.id, `${c.first_name} ${c.last_name}`]));
        const byClient = {}, byAddress = {};
        cases.forEach((c) => {
          if (!c.property_address) return;
          (byClient[c.client_id] = byClient[c.client_id] || []).push(c);
          (byAddress[c.property_address] = byAddress[c.property_address] || []).push(c);
        });
        const distinct = (rows) => new Set(rows.map((r) => r.property_address)).size;
        return {
          total: cases.length,
          withAddress: cases.filter((c) => c.property_address).length,
          /* clients holding cases on 2+ DIFFERENT properties, biggest first */
          multiProperty: Object.keys(byClient)
            .map((id) => ({ who: nameOf[id], properties: distinct(byClient[id]), cases: byClient[id].length }))
            .filter((x) => x.properties >= 2)
            .sort((a, b) => b.properties - a.properties),
          /* one property carrying more than one case for the SAME client */
          samePropertyRepeatCase: Object.keys(byAddress)
            .map((a) => ({ address: a, owners: new Set(byAddress[a].map((c) => c.client_id)), cases: byAddress[a] }))
            .filter((x) => x.owners.size === 1 && x.cases.length >= 2)
            .map((x) => ({ address: x.address, cases: x.cases.length, distinctDates: new Set(x.cases.map((c) => c.created_at)).size })),
          /* the landmine: one address, two unrelated clients */
          sharedAddress: Object.keys(byAddress)
            .map((a) => ({ address: a, clients: [...new Set(byAddress[a].map((c) => nameOf[c.client_id]))] }))
            .filter((x) => x.clients.length >= 2),
        };
      });
      ok("M7 fixture · at least four clients hold cases on several distinct properties",
        shape.multiProperty.length >= 4, JSON.stringify(shape.multiProperty));
      ok("M7 fixture · one of them is a portfolio landlord with five properties",
        shape.multiProperty.some((x) => x.properties >= 5), JSON.stringify(shape.multiProperty));
      ok("M7 fixture · a property carries more than one case for the same client, at different times",
        shape.samePropertyRepeatCase.some((x) => x.cases >= 2 && x.distinctDates >= 2), JSON.stringify(shape.samePropertyRepeatCase));
      ok("M7 fixture · and one address is shared by TWO different clients (sold between them)",
        shape.sharedAddress.length >= 1 && shape.sharedAddress.every((x) => x.clients.length === 2), JSON.stringify(shape.sharedAddress));
      ok("M7 fixture · most of the book still has no property address (no backfill)",
        shape.total - shape.withAddress > shape.withAddress, JSON.stringify({ total: shape.total, withAddress: shape.withAddress }));

      const detect = await page.evaluate(async () => {
        const db = window.__mockDb;
        const seeded = (await db.from("cases").select("id,property_address")).data.filter((c) => c.property_address)[0];
        window.__mock.setMigrations({ m7: false });
        const write = await db.from("cases").update({ property_address: "1 Nowhere Road" }).eq("id", seeded.id);
        const insert = await db.from("cases").insert({ client_id: "cl001", stage: "enquiry", property_address: "2 Nowhere Road" });
        const read = (await db.from("cases").select("*").eq("id", seeded.id)).data[0];
        const named = (await db.from("cases").select("id,property_address").eq("id", seeded.id)).data[0];
        window.__mock.setMigrations({ m7: true });
        const back = (await db.from("cases").select("*").eq("id", seeded.id)).data[0];
        return {
          writeCode: write.error && write.error.code,
          writeMsg: write.error && write.error.message,
          insertCode: insert.error && insert.error.code,
          omittedFromStar: !("property_address" in read),
          omittedWhenNamed: !("property_address" in (named || {})),
          was: seeded.property_address,
          restored: back.property_address,
        };
      });
      eq("M7 · with the migration off, an UPDATE naming the column is 42703", detect.writeCode, "42703");
      ok("M7 · … and says which column does not exist", /property_address/.test(detect.writeMsg || ""), JSON.stringify(detect.writeMsg));
      eq("M7 · … an INSERT naming it is refused the same way", detect.insertCode, "42703");
      ok("M7 · … and SELECTs simply do not return it", detect.omittedFromStar && detect.omittedWhenNamed, JSON.stringify(detect));
      eq("M7 · the refused write changed nothing — the value is intact when it comes back", detect.restored, detect.was);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) {} }
  }

  console.log(`\nR5 BATCH 2: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
