#!/usr/bin/env node
/* =============================================================================
   tests/r16.js — acceptance tests for ROUND 16: BTL rental + ICR affordability,
   and the submit-to-lender tracker.

     ICR/YIELD    — one canonical helper in app.js (`btlIcr(c)`): rent*12 is the
                    annual rent; stressInterest is loan * stress% (stress
                    defaults to 5.5 when null/0/NaN, defaults never win over a
                    real value); icrPct is the annual rent as a ROUNDED INTEGER
                    percentage of stressInterest (null when there is no loan);
                    pass is icrPct >= required% (required defaults to 145);
                    yieldPct is annual rent as a percentage of property value,
                    rounded to ONE decimal place. No rent at all -> null,
                    meaning "nothing to assess yet", not a false/zero verdict.
     BTL BLOCK    — kind-gated to case_kind === 'buy_to_let' only, and re-gates
                    LIVE when the Type <select> changes without reopening the
                    modal (kindSel.onchange toggles #case-btl-block's "hidden"
                    class). The chip inside it (#btl-icr-chip) recomputes on
                    every keystroke in rent/loan/stress/required/value via a
                    form-level "input" listener, independent of Save.
     LENDER TRACK — application_status (submitted/underwriting/valuation/
                    offer_issued/null) plus lender_reference and
                    application_status_at. A header chip (#cs-lender-status)
                    and a board-card badge both render only inside the R15
                    relevance window (decision_in_principle/application/offer/
                    exchange) — LENDER_TRACK_STAGES. The chase nudge
                    (#cs-lender-chase) fires only for submitted/underwriting/
                    valuation whose application_status_at (falling back to
                    submitted_at) is >= LENDER_CHASE_DAYS (10) days old — never
                    for offer_issued or a null status, however old.
     SAVE         — application_status_at is stamped fresh only when
                    application_status actually CHANGES on that save (an
                    unrelated edit leaves an existing stamp untouched); a
                    submitted_at set for the FIRST time with an empty status
                    defaults the status to 'submitted' and stamps it too; the
                    BTL trio is coerced to numbers on write, exactly like every
                    other numeric field on the form.

   EVERY figure this file asserts (the ICR/yield formula, the status labels,
   the chase-day threshold) is recomputed HERE, independently of app.js's own
   btlIcr()/lenderChaseDays()/APP_STATUS_LABEL — see the standing rule in
   HARNESS.md. Every case this file opens is created fresh via mkClientCase
   (client_id + case in one round trip, exact column values under test never
   in doubt), never a fixture row — mirroring tests/r15.js's approach, and for
   the same reason: mock-supabase.js's whole in-memory DB is rebuilt per page
   load, so a caseId minted on one page is meaningless to another. The whole
   battery therefore runs on ONE shared `page`, never a fresh newPage() reusing
   an id another page created.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r16.js
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

/* Insert a client + case in one round trip, returning {clientId, caseId}. Every
   case this file opens comes from here — never a fixture row — exactly the
   pattern tests/r15.js's mkClientCase uses, extended with the R16 columns. */
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email || (`r16.${Math.random().toString(36).slice(2, 9)}@example.com`);
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Test", last_name: o.last || "R16Case", email, phone: o.phone || null })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = {
      client_id: cl.id, case_kind: o.case_kind || "buy_to_let", stage: o.stage || "application",
      assigned_to: o.assigned_to === undefined ? "p2" : o.assigned_to,
      lender: o.lender === undefined ? "Halifax" : o.lender,
    };
    ["loan_amount", "property_value", "monthly_rent", "icr_stress_rate", "icr_required_pct",
      "lender_reference", "application_status", "application_status_at", "submitted_at"]
      .forEach((k) => { if (o[k] !== undefined) row[k] = o[k]; });
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id };
  }, opts || {});
}

const hasClass = (page, sel, cls) => page.evaluate(({ sel, cls }) => {
  const el = document.querySelector(sel);
  return el ? el.classList.contains(cls) : null;
}, { sel, cls });

const openCase = async (page, caseId) => {
  await page.evaluate((id) => window.openCase(id), caseId);
  await wait(page, 900);
  // The case-details <details> starts COLLAPSED on an existing case (only a brand-new case is
  // born open — see admin/app.js `<details class="case-details" ${id ? "" : "open"}>`), which
  // hides every field inside it (Type, the BTL block, the lender tracker fields…) from Playwright's
  // actionability checks even though $eval can still read their text. Force it open on every
  // openCase() so fill()/selectOption() work the same way for a freshly-created case as for one
  // opened cold, exactly the pattern tests/r13.js uses ahead of its own form edits.
  // R33 — scoped to #modal: Settings' new #diag-details also carries the shared `.case-details`
  // disclosure-styling class and, unlike Settings' own General/Advanced sections, is STATIC markup
  // present in the DOM from initial page load (not only once Settings has been rendered) — so an
  // unscoped querySelector(".case-details") now matches IT first, leaving the modal's own section
  // (and everything inside it) collapsed and un-interactable. Same fix app.js's own internal
  // $(".case-details") call sites needed — see the R33 notes.
  await page.evaluate(() => { const d = document.querySelector("#modal .case-details"); if (d) d.open = true; });
};

const readCase = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", id).single();
  return data;
}, caseId);

const isoDaysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();
const browserNow = (page) => page.evaluate(() => Date.now());

/* ---------------------------------------------------------------------------
   Independent re-implementation of the R16 SPEC formulas — never imported
   from app.js. See HARNESS.md's standing rule.
   ------------------------------------------------------------------------- */
function icrCalc({ rent, loan, stress, req, val }) {
  rent = Number(rent); loan = Number(loan);
  stress = Number(stress) || 5.5; req = Number(req) || 145; val = Number(val);
  if (!rent || rent <= 0) return null;
  const annualRent = rent * 12;
  const stressInterest = loan > 0 ? loan * (stress / 100) : 0;
  const icrPct = stressInterest > 0 ? Math.round(annualRent / stressInterest * 100) : null;
  const pass = icrPct != null ? icrPct >= req : null;
  const yieldPct = val > 0 ? Math.round(annualRent / val * 1000) / 10 : null;
  return { icrPct, pass, yieldPct, annualRent, req };
}
/* The exact chip text app.js's btlIcrChipHtml produces for a given result. */
function chipText(r) {
  if (!r) return "";
  let txt;
  if (r.icrPct == null) txt = "ICR — add loan amount";
  else if (r.pass) txt = `ICR ${r.icrPct}% ✓`;
  else txt = `ICR ${r.icrPct}% · needs ${r.req}% ✗`;
  const y = r.yieldPct != null ? ` · Yield ${r.yieldPct}%` : "";
  return txt + y;
}
function chipClass(r) {
  if (!r) return null;
  if (r.icrPct == null) return "grey";
  return r.pass ? "green" : "red";
}
const APP_STATUS_LABEL = { submitted: "Submitted", underwriting: "Underwriting", valuation: "Valuation", offer_issued: "Offer issued" };
const CHASEABLE = ["submitted", "underwriting", "valuation"];
const LENDER_CHASE_DAYS = 10;
const LENDER_TRACK_STAGES = ["decision_in_principle", "application", "offer", "exchange"];
function statusChipText(status, submittedAt) {
  const icon = status === "offer_issued" ? "📄" : status === "submitted" ? "📤" : "🏦";
  const dateSuffix = status === "submitted" && submittedAt ? " " + fmtD(submittedAt) : "";
  return `${icon} ${APP_STATUS_LABEL[status]}${dateSuffix}`;
}
/* Same d/M/yy-ish shape app.js's fmtD uses is not needed exactly — the header
   date-suffix check below only fires when submitted_at is deliberately left
   unset, so fmtD is never actually exercised; kept only for completeness. */
function fmtD(d) { return d; }
function chaseExpected(status, days) {
  if (!CHASEABLE.includes(status)) return null;
  if (days < LENDER_CHASE_DAYS) return null;
  return `⏰ In ${APP_STATUS_LABEL[status]} ${days} days — chase the lender`;
}

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
       A · ICR / YIELD — the canonical formula, several fixtures incl. muted
           (no loan) and null (no rent), the exact chip text and colour class.
       ======================================================================= */
    {
      console.log("\n— A · ICR/yield calc: exact integer %, pass/fail, 1dp yield, chip text + colour (p2)");
      const errBefore = (page.__err || []).length;

      const CASES = [
        { name: "A1 · fail (defaults)", rent: 1200, loan: 200000, stress: null, req: null, val: null },
        { name: "A2 · pass (defaults)", rent: 1500, loan: 200000, stress: null, req: null, val: null },
        { name: "A3 · muted — rent present, no loan", rent: 1200, loan: 0, stress: null, req: null, val: null },
        { name: "A4 · null — no rent at all", rent: 0, loan: 200000, stress: null, req: null, val: null },
        { name: "A5 · fail (defaults) with property value -> yield suffix", rent: 1200, loan: 200000, stress: null, req: null, val: 300000 },
        { name: "A6 · custom stress + required override the defaults", rent: 1200, loan: 100000, stress: 3, req: 110, val: null },
        { name: "A7 · zero stress/required fall back to defaults (0 is falsy)", rent: 1200, loan: 200000, stress: 0, req: 0, val: null },
        { name: "A8 · pass, value set -> yield with a trailing-zero-dropped 1dp figure", rent: 1500, loan: 154000, stress: null, req: null, val: 224000 },
      ];

      for (const t of CASES) {
        const r = icrCalc({ rent: t.rent, loan: t.loan, stress: t.stress, req: t.req, val: t.val });
        const { caseId } = await mkClientCase(page, {
          first: "ICR", last: t.name.replace(/[^a-z0-9]/gi, ""), case_kind: "buy_to_let", stage: "application",
          loan_amount: t.loan || null, property_value: t.val || null,
          monthly_rent: t.rent || null, icr_stress_rate: t.stress, icr_required_pct: t.req,
        });
        await openCase(page, caseId);
        const blockChip = await page.$eval("#btl-icr-chip", (e) => e.textContent).catch(() => "ERR");
        eq(`${t.name} · block chip text`, blockChip, chipText(r));
        if (r) {
          const cls = await page.evaluate(() => {
            const el = document.querySelector("#btl-icr-chip .icr-chip");
            return el ? [...el.classList] : null;
          });
          ok(`${t.name} · block chip carries the "${chipClass(r)}" colour class`, cls && cls.includes(chipClass(r)), JSON.stringify(cls));
          const headerChip = await page.$eval("#cs-btl-icr .cs-val", (e) => e.textContent).catch(() => "ABSENT");
          eq(`${t.name} · header echo (#cs-btl-icr) matches the block chip`, headerChip, chipText(r));
        } else {
          /* R35 §3 — affordability never silently vanishes: a BTL case with NO rent at all used to
             drop #cs-btl-icr entirely (the row required btlIcr(c), which is null with no rent), so
             the one case where affordability is genuinely UNKNOWN looked identical to a non-BTL
             case with nothing to say. The row is now always drawn for a BTL case: the amber
             "Rent — not captured" badge plus the #cs-btl-add-rent fix-it button take its place.
             Stronger than the old absence check, not a work-around of it — see the R35 notes. */
          const row = await page.evaluate(() => {
            const el = document.querySelector("#cs-btl-icr");
            const amber = el ? el.querySelector(".badge.amber") : null;
            return el ? { present: true, amberText: amber ? amber.textContent : null, hasAddBtn: !!document.querySelector("#cs-btl-add-rent") } : { present: false };
          });
          ok(`${t.name} · no rent at all -> #cs-btl-icr is PRESENT (R35 §3 — affordability never silently vanishes)`, row.present, JSON.stringify(row));
          eq(`${t.name} · …with the amber "Rent — not captured" badge`, row.amberText, "Rent — not captured");
          ok(`${t.name} · …and the #cs-btl-add-rent button`, row.hasAddBtn, JSON.stringify(row));
        }
      }
      ok("A · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       B · BTL BLOCK KIND-GATING — present only for buy_to_let, hidden (not
           removed) for every other kind, and re-gates LIVE on the Type select
           without reopening the modal.
       ======================================================================= */
    {
      console.log("\n— B · BTL block: buy_to_let only, static + live via kindSel (p2)");
      const errBefore = (page.__err || []).length;

      const btl = await mkClientCase(page, { first: "Kind", last: "BTL", case_kind: "buy_to_let", stage: "application", monthly_rent: 1200 });
      await openCase(page, btl.caseId);
      eq("B · buy_to_let · #case-btl-block has NO class=\"hidden\"", await hasClass(page, "#case-btl-block", "hidden"), false);

      for (const kind of ["remortgage", "purchase", "product_transfer", "first_time_buyer"]) {
        const c = await mkClientCase(page, { first: "Kind", last: kind, case_kind: kind, stage: "application" });
        await openCase(page, c.caseId);
        eq(`B · ${kind} · #case-btl-block carries class="hidden"`, await hasClass(page, "#case-btl-block", "hidden"), true);
      }

      // Live toggle, on the buy_to_let case reopened.
      await openCase(page, btl.caseId);
      eq("B · live · reopened buy_to_let case starts visible", await hasClass(page, "#case-btl-block", "hidden"), false);
      await page.selectOption('#case-form [name="case_kind"]', "remortgage");
      await wait(page, 150);
      eq("B · live · switching Type to remortgage hides the block WITHOUT reopening the modal", await hasClass(page, "#case-btl-block", "hidden"), true);
      await page.selectOption('#case-form [name="case_kind"]', "buy_to_let");
      await wait(page, 150);
      eq("B · live · switching Type back to buy_to_let shows the block again", await hasClass(page, "#case-btl-block", "hidden"), false);

      // The live chip recomputes on input alone, no Save involved.
      await page.fill('#case-form [name="monthly_rent"]', "1200");
      await page.fill('#case-form [name="loan_amount"]', "200000");
      await wait(page, 150);
      const liveChip = await page.$eval("#btl-icr-chip", (e) => e.textContent);
      eq("B · live · the chip recomputes on input alone (no Save) to the exact fail figure", liveChip, chipText(icrCalc({ rent: 1200, loan: 200000 })));

      ok("B · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       C · LENDER TRACKER — the select is present with the right options, and
           the header status chip renders the right icon+label per status,
           gated to the R15 relevance window (LENDER_TRACK_STAGES).
       ======================================================================= */
    {
      console.log("\n— C · lender tracker: select options, header status chip per status, stage-window gating (p2)");
      const errBefore = (page.__err || []).length;

      const anyCase = await mkClientCase(page, { first: "Sel", last: "Options", case_kind: "remortgage", stage: "application" });
      await openCase(page, anyCase.caseId);
      const options = await page.$$eval('#case-form [name="application_status"] option', (els) => els.map((e) => ({ value: e.value, label: e.textContent })));
      eq("C · application_status select options are exactly [—, submitted, underwriting, valuation, offer_issued]", options, [
        { value: "", label: "— not submitted —" },
        { value: "submitted", label: "Submitted" },
        { value: "underwriting", label: "Underwriting" },
        { value: "valuation", label: "Valuation" },
        { value: "offer_issued", label: "Offer issued" },
      ]);

      for (const status of ["submitted", "underwriting", "valuation", "offer_issued"]) {
        const c = await mkClientCase(page, {
          first: "Status", last: status, case_kind: "remortgage", stage: "offer",
          application_status: status, application_status_at: isoDaysAgo(1), lender_reference: "REF-" + status,
        });
        await openCase(page, c.caseId);
        const headerText = await page.$eval("#cs-lender-status .cs-val", (e) => e.textContent).catch(() => "ABSENT");
        eq(`C · status "${status}" · header chip reads "${statusChipText(status, null)}"`, headerText, statusChipText(status, null));
      }

      // Stage-window gating — a chaseable status OUTSIDE the window (enquiry / completed / not_proceeding)
      // never renders the header chip at all, even though application_status is set.
      for (const stage of ["enquiry", "fact_find", "completed", "not_proceeding"]) {
        const c = await mkClientCase(page, { first: "Outside", last: stage, case_kind: "remortgage", stage, application_status: "underwriting", application_status_at: isoDaysAgo(1) });
        await openCase(page, c.caseId);
        const absent = await page.evaluate(() => !document.querySelector("#cs-lender-status"));
        ok(`C · stage "${stage}" (outside LENDER_TRACK_STAGES) · #cs-lender-status is ABSENT despite a set status`, absent);
      }

      // null status -> no header chip.
      const nullStatus = await mkClientCase(page, { first: "Null", last: "Status", case_kind: "remortgage", stage: "application" });
      await openCase(page, nullStatus.caseId);
      ok("C · null application_status · #cs-lender-status is ABSENT", await page.evaluate(() => !document.querySelector("#cs-lender-status")));

      // submitted + a real submitted_at date -> the header echoes the date too.
      const submittedWithDate = await mkClientCase(page, {
        first: "Submitted", last: "WithDate", case_kind: "remortgage", stage: "application",
        application_status: "submitted", application_status_at: isoDaysAgo(1), submitted_at: "2026-06-15",
      });
      await openCase(page, submittedWithDate.caseId);
      const withDateText = await page.$eval("#cs-lender-status .cs-val", (e) => e.textContent);
      ok("C · submitted status with submitted_at set · the header echoes the date too", /📤 Submitted/.test(withDateText) && withDateText.includes("15"), withDateText);

      ok("C · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       D · CHASE NUDGE — fires only for submitted/underwriting/valuation whose
           application_status_at is >= LENDER_CHASE_DAYS (10) days old; never
           for offer_issued or a null status, however old; and only inside the
           same stage window the status chip uses.
       ======================================================================= */
    {
      console.log("\n— D · chase nudge: the 10-day boundary, chaseable-status set, offer_issued/null excluded, stage-window gated (p2)");
      const errBefore = (page.__err || []).length;

      // Boundary: 9 days -> no nudge, 10 days -> nudge, 15 days -> nudge, per chaseable status.
      for (const status of CHASEABLE) {
        const c9 = await mkClientCase(page, { first: "Nudge9", last: status, case_kind: "remortgage", stage: "application", application_status: status, application_status_at: isoDaysAgo(9) });
        await openCase(page, c9.caseId);
        const absent9 = await page.evaluate(() => !document.querySelector("#cs-lender-chase"));
        ok(`D · "${status}" at 9 days · NO chase nudge yet (below the 10-day threshold)`, absent9);

        const c10 = await mkClientCase(page, { first: "Nudge10", last: status, case_kind: "remortgage", stage: "application", application_status: status, application_status_at: isoDaysAgo(10) });
        await openCase(page, c10.caseId);
        const text10 = await page.$eval("#cs-lender-chase", (e) => e.textContent).catch(() => "ABSENT");
        eq(`D · "${status}" at exactly 10 days · chase nudge fires with the exact wording`, text10, chaseExpected(status, 10));

        const c15 = await mkClientCase(page, { first: "Nudge15", last: status, case_kind: "remortgage", stage: "application", application_status: status, application_status_at: isoDaysAgo(15) });
        await openCase(page, c15.caseId);
        const text15 = await page.$eval("#cs-lender-chase", (e) => e.textContent).catch(() => "ABSENT");
        eq(`D · "${status}" at 15 days · chase nudge fires with the exact wording`, text15, chaseExpected(status, 15));
      }

      // offer_issued, however old, never chases.
      const offerIssuedOld = await mkClientCase(page, { first: "NoChase", last: "OfferIssued", case_kind: "remortgage", stage: "offer", application_status: "offer_issued", application_status_at: isoDaysAgo(40) });
      await openCase(page, offerIssuedOld.caseId);
      ok("D · offer_issued at 40 days · NO chase nudge, ever", await page.evaluate(() => !document.querySelector("#cs-lender-chase")));

      // null status, however old (fallback submitted_at unset too) -> never chases.
      const nullOld = await mkClientCase(page, { first: "NoChase", last: "NullStatus", case_kind: "remortgage", stage: "application" });
      await openCase(page, nullOld.caseId);
      ok("D · null status · NO chase nudge", await page.evaluate(() => !document.querySelector("#cs-lender-chase")));

      // Chaseable status, old timestamp, but OUTSIDE the stage window -> no nudge (gated the same as the chip).
      const outsideWindow = await mkClientCase(page, { first: "NoChase", last: "OutsideStage", case_kind: "remortgage", stage: "completed", application_status: "underwriting", application_status_at: isoDaysAgo(20) });
      await openCase(page, outsideWindow.caseId);
      ok("D · chaseable status, 20 days old, but stage=completed (outside the window) · NO chase nudge", await page.evaluate(() => !document.querySelector("#cs-lender-chase")));

      // application_status_at absent falls back to submitted_at.
      const fallback = await mkClientCase(page, { first: "Fallback", last: "SubmittedAt", case_kind: "remortgage", stage: "application", application_status: "submitted", submitted_at: (() => { const d = new Date(Date.now() - 12 * DAY_MS); return d.toISOString().slice(0, 10); })() });
      await openCase(page, fallback.caseId);
      const fallbackText = await page.$eval("#cs-lender-chase", (e) => e.textContent).catch(() => "ABSENT");
      ok("D · no application_status_at · falls back to submitted_at (12 days ago -> chases)", /⏰ In Submitted \d+ days — chase the lender/.test(fallbackText), fallbackText);

      ok("D · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       E · SAVE BEHAVIOUR — application_status_at is stamped fresh ONLY on an
           actual status change; an unrelated edit leaves an existing stamp
           untouched; a first-time submitted_at with a blank status defaults
           the status to 'submitted' and stamps it; the BTL trio is coerced to
           numbers on write.
       ======================================================================= */
    {
      console.log("\n— E · Save: application_status_at stamping rules, submitted_at-implies-submitted, numeric coercion (p2)");
      const errBefore = (page.__err || []).length;

      // E1 — a fresh case, status blank -> setting it stamps application_status_at to now.
      const e1 = await mkClientCase(page, { first: "Save", last: "StampOnChange", case_kind: "remortgage", stage: "application" });
      await openCase(page, e1.caseId);
      const beforeE1 = await readCase(page, e1.caseId);
      eq("E1 · fixture sanity — starts with no status and no stamp", [beforeE1.application_status, beforeE1.application_status_at], [null, null]);
      await page.selectOption('#case-form [name="application_status"]', "underwriting");
      const nowE1 = await browserNow(page);
      await page.click("#modal-save");
      await wait(page, 700);
      const afterE1 = await readCase(page, e1.caseId);
      eq("E1 · application_status was written", afterE1.application_status, "underwriting");
      ok("E1 · application_status_at was stamped to (approximately) now", afterE1.application_status_at && Math.abs(new Date(afterE1.application_status_at).getTime() - nowE1) < 20000, afterE1.application_status_at);

      // E2 — an existing status, changed on save -> the OLD stamp is replaced with a new one.
      const oldStamp = isoDaysAgo(5);
      const e2 = await mkClientCase(page, { first: "Save", last: "ChangeReStamps", case_kind: "remortgage", stage: "application", application_status: "submitted", application_status_at: oldStamp });
      await openCase(page, e2.caseId);
      await page.selectOption('#case-form [name="application_status"]', "underwriting");
      const nowE2 = await browserNow(page);
      await page.click("#modal-save");
      await wait(page, 700);
      const afterE2 = await readCase(page, e2.caseId);
      eq("E2 · application_status changed to underwriting", afterE2.application_status, "underwriting");
      ok("E2 · application_status_at moved to a fresh timestamp, not the old one", afterE2.application_status_at !== oldStamp && Math.abs(new Date(afterE2.application_status_at).getTime() - nowE2) < 20000, afterE2.application_status_at);

      // E3 — an existing status, UNCHANGED on save (only an unrelated field edited) -> the stamp is untouched.
      const fixedStamp = isoDaysAgo(5);
      const e3 = await mkClientCase(page, { first: "Save", last: "UnchangedNoRestamp", case_kind: "remortgage", stage: "application", application_status: "submitted", application_status_at: fixedStamp, lender_reference: "OLD-REF" });
      await openCase(page, e3.caseId);
      await page.fill('#case-form [name="lender_reference"]', "NEW-REF-123");
      await page.click("#modal-save");
      await wait(page, 700);
      const afterE3 = await readCase(page, e3.caseId);
      eq("E3 · the unrelated field (lender_reference) was written", afterE3.lender_reference, "NEW-REF-123");
      eq("E3 · application_status is still 'submitted' (never touched by this save)", afterE3.application_status, "submitted");
      eq("E3 · application_status_at is EXACTLY the old stamp — an unrelated edit did not reset the chase clock", afterE3.application_status_at, fixedStamp);

      // E4 — submitted_at set for the FIRST time with status left blank -> defaults to 'submitted' + stamps.
      const e4 = await mkClientCase(page, { first: "Save", last: "SubmittedImpliesStatus", case_kind: "remortgage", stage: "application" });
      await openCase(page, e4.caseId);
      const startVal = await page.$eval('#case-form [name="application_status"]', (e) => e.value);
      eq("E4 · fixture sanity — the status select starts on the blank option", startVal, "");
      await page.fill('#case-form [name="submitted_at"]', "2026-07-01");
      const nowE4 = await browserNow(page);
      await page.click("#modal-save");
      await wait(page, 700);
      const afterE4 = await readCase(page, e4.caseId);
      eq("E4 · submitted_at was written", afterE4.submitted_at, "2026-07-01");
      eq("E4 · application_status defaulted to 'submitted'", afterE4.application_status, "submitted");
      ok("E4 · application_status_at was stamped to (approximately) now", afterE4.application_status_at && Math.abs(new Date(afterE4.application_status_at).getTime() - nowE4) < 20000, afterE4.application_status_at);

      // E5 — a submitted_at already on the case is NOT "first time"; a save that leaves the status blank
      // must not retroactively invent a status for a case that never had one recorded before this round.
      const e5 = await mkClientCase(page, { first: "Save", last: "AlreadyHadSubmittedAt", case_kind: "remortgage", stage: "application", submitted_at: "2026-01-05" });
      await openCase(page, e5.caseId);
      await page.fill('#case-form [name="lender"]', "Skipton");
      await page.click("#modal-save");
      await wait(page, 700);
      const afterE5 = await readCase(page, e5.caseId);
      eq("E5 · lender was written (proves the save actually ran)", afterE5.lender, "Skipton");
      eq("E5 · application_status is still null — submitted_at was already on the case, not set for the first time", afterE5.application_status, null);

      // E6 — the BTL trio is coerced to numbers on write, exactly like every other numeric field.
      const e6 = await mkClientCase(page, { first: "Save", last: "NumericCoercion", case_kind: "buy_to_let", stage: "application" });
      await openCase(page, e6.caseId);
      await page.fill('#case-form [name="loan_amount"]', "175000");
      await page.fill('#case-form [name="property_value"]', "240000");
      await page.fill('#case-form [name="monthly_rent"]', "1234");
      await page.fill('#case-form [name="icr_stress_rate"]', "4.25");
      await page.fill('#case-form [name="icr_required_pct"]', "120");
      await page.click("#modal-save");
      await wait(page, 700);
      const afterE6 = await readCase(page, e6.caseId);
      eq("E6 · monthly_rent stored as a NUMBER", [typeof afterE6.monthly_rent, afterE6.monthly_rent], ["number", 1234]);
      eq("E6 · icr_stress_rate stored as a NUMBER", [typeof afterE6.icr_stress_rate, afterE6.icr_stress_rate], ["number", 4.25]);
      eq("E6 · icr_required_pct stored as a NUMBER", [typeof afterE6.icr_required_pct, afterE6.icr_required_pct], ["number", 120]);

      ok("E · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       F · BOARD CARD — the tracked-status badge (SPEC16 §B: "and on the board
           card"), and the untouched fallback ("📤 sub {date}") when no status
           is tracked, proving R16 did not regress the R12b badge outright —
           it only supersedes it when a status is actually set.
       ======================================================================= */
    {
      console.log("\n— F · board card: the tracked-status badge, and the old “📤 sub” fallback when untracked (p2)");
      const errBefore = (page.__err || []).length;

      const tracked = await mkClientCase(page, {
        first: "Board", last: "Tracked", case_kind: "remortgage", stage: "offer",
        application_status: "valuation", application_status_at: isoDaysAgo(1),
      });
      const untracked = await mkClientCase(page, {
        first: "Board", last: "Untracked", case_kind: "remortgage", stage: "offer",
        submitted_at: "2026-05-10",
      });
      await page.evaluate(() => window.nav("pipeline"));
      await wait(page, 1200);
      const trackedText = await page.$eval(`.card[data-id="${tracked.caseId}"]`, (e) => e.textContent).catch(() => "ABSENT");
      ok("F · a tracked status (valuation) shows 🏦 Valuation on the board card", /🏦\s*Valuation/.test(trackedText), trackedText);
      const untrackedText = await page.$eval(`.card[data-id="${untracked.caseId}"]`, (e) => e.textContent).catch(() => "ABSENT");
      ok("F · no status set · the board card falls back to the ORIGINAL “📤 sub {date}” badge", /📤\s*sub/.test(untrackedText), untrackedText);

      ok("F · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

  } finally {
    await page.close();
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r16: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
