#!/usr/bin/env node
/* =============================================================================
   tests/r15.js — acceptance tests for ROUND 15: the stage- & type-reactive
   case screen.

     ACTION BAR   — CASE_ACTION_RULES splits the case modal's eight original
                    action ids into a PRIMARY row (relevant to the case's
                    current stage) and a "More actions" overflow
                    (#case-more-actions, born class="hidden"). Every id is
                    ALWAYS in the DOM — gating only decides which row it
                    paints into — so nothing is ever unreachable, only
                    relocated. #case-more-actions-toggle opens the menu.
     RECORD REASON — the one NEW action id, #act-record-reason, exists in the
                    DOM only at stage=not_proceeding (primary/hero there),
                    absent everywhere else — it would be meaningless anywhere
                    a case has not stopped.
     SECTIONS     — the security card and Files card are wrapped, not
                    deleted, and hidden (class="hidden" on the wrapper) at
                    enquiry/fact_find; present from DIP onward. Documents
                    renders in full up to Exchange and collapses into a
                    <details> at completed/not_proceeding — #case-docs-body
                    exists either way.
     TYPE GATING  — a product_transfer case never shows a Solicitor field
                    (no conveyancing), an Exchanged-on field (same lender, no
                    exchange) or a primary Read-offer action, and its
                    Advance-to-next-stage button skips Exchange entirely
                    (offer → completed, not offer → exchange). GI/buildings
                    insurance only applies to purchase-shaped/owner-occupier
                    kinds, never a product transfer.
     WORDING      — the Documents and History section intros were CUT to a
                    bare heading + tooltip; neither section's old visible
                    paragraph copy survives as rendered text.

   EVERY figure this file asserts is recomputed HERE, independently of
   app.js's own CASE_ACTION_RULES/CASE_SECTION_RULES/GI_KINDS — see the
   standing rule in HARNESS.md. Every case this file opens is created fresh
   via mkClientCase (client_id + case in one round trip), never a fixture
   row, so the exact stage/kind/column combination under test is never in
   doubt.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r15.js
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
const wait = (page, ms) => page.waitForTimeout(ms);

/* Insert a client + case in one round trip, returning {clientId, caseId}. Every
   case this file opens comes from here — never a fixture row — so the exact
   stage/kind/column combination under test is never in doubt. */
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email || (`r15.${Math.random().toString(36).slice(2, 9)}@example.com`);
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Test", last_name: o.last || "R15Case", email, phone: o.phone || null })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const { data: cs, error: csErr } = await db.from("cases")
      .insert({
        client_id: cl.id, case_kind: o.case_kind || "remortgage", stage: o.stage || "enquiry",
        assigned_to: o.assigned_to === undefined ? "p2" : o.assigned_to,
        lender: o.lender === undefined ? "Halifax" : o.lender,
      })
      .select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id };
  }, opts || {});
}

/* Where does action #id currently live in the case modal — inside the
   #case-more-actions overflow menu, directly in the primary row, or not in
   the DOM at all? Structural (closest()), not layout-geometry, so it does
   not care whether the menu happens to be open when this is called.

   R73: the split this file tests is now THREE tiers, not two, and the answer
   is read off the button's own data-act-tier rather than off which box it
   sits in. R73 · A3 capped the visible row at the two or three actions a
   stage is actually about (the bar was 135px of a 900px viewport and 445px of
   a phone); the rest of a stage's actions moved into the overflow menu, under
   a heading naming the stage and ABOVE the actions that were never primary
   anywhere. So "primary" here means what it has always meant — CASE_ACTION_
   RULES says this action belongs at this stage — which is tier "top" (on the
   bar) or tier "stage" (first group of the menu). Tier "rest" is the overflow
   this file's PRIMARY_STAGES map calls "overflow". The assertion is unchanged
   in strength: every row below still distinguishes the stages an action
   belongs to from the ones it does not. */
const actionLocation = (page, id) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return "absent";
  const tier = el.getAttribute("data-act-tier");
  if (tier) return tier === "rest" ? "overflow" : "primary";
  return el.closest("#case-more-actions") ? "overflow" : "primary";
}, `#${id}`);
/* R73 · A3 — and the new, narrower question this round introduced: is the action on the BAR
   itself (tier "top"), or one press away in Actions ▾? Used by §A's new checks below. */
const actionTier = (page, id) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return el ? (el.getAttribute("data-act-tier") || "untiered") : "absent";
}, `#${id}`);

const hasClass = (page, sel, cls) => page.evaluate(({ sel, cls }) => {
  const el = document.querySelector(sel);
  return el ? el.classList.contains(cls) : null;
}, { sel, cls });

const openCase = async (page, caseId) => {
  await page.evaluate((id) => window.openCase(id), caseId);
  await wait(page, 900);
};

/* Independent re-implementation of CASE_ACTION_RULES's stage gate for the
   eight ORIGINAL action ids (excludes #act-view-offer, which only renders at
   all with an offer doc on the case, and #act-record-reason, the one NEW id
   this round adds). Kind overrides (product_transfer dropping act-offer) are
   tested separately in section D, not folded in here. */
const PRIMARY_STAGES = {
  "act-factfind": ["enquiry", "fact_find"],
  "act-appt": ["enquiry", "fact_find", "decision_in_principle", "application"],
  "act-offer": ["offer", "exchange", "completed"],
  "act-fee": ["completed"],
  "act-paid": ["completed"],
  "act-review": ["completed"],
  "act-reminder": ["completed"],
  "act-evidence": ["completed", "not_proceeding"],
};
const CORE_ACTIONS = Object.keys(PRIMARY_STAGES);
const ALL_STAGES = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange", "completed", "not_proceeding"];

/* mock-supabase.js's whole in-memory DB is built fresh by the IIFE that runs
   when admin/mock.html loads — i.e. it is PER-PAGE, not shared across tabs.
   A caseId minted on one page.goto() is meaningless to a different page
   instance. Every section below therefore runs on ONE shared `page` for the
   whole file, exactly like a single continuous session would — never a
   fresh newPage() reusing an id another page created. */
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
       A · PER-STAGE ACTION BAR — every core action lands in the row
           PRIMARY_STAGES says it should, at every one of the eight stages,
           for an ordinary (non-product-transfer) case.
       ======================================================================= */
    const stageCaseId = {};
    {
      console.log("\n— A · per-stage action bar: primary vs overflow, all 8 stages × 8 actions (p2)");
      const errBefore = (page.__err || []).length;
      for (const stage of ALL_STAGES) {
        const { caseId } = await mkClientCase(page, { first: "Stage", last: stage, case_kind: "remortgage", stage });
        stageCaseId[stage] = caseId;
        await openCase(page, caseId);
        for (const id of CORE_ACTIONS) {
          const expected = PRIMARY_STAGES[id].includes(stage) ? "primary" : "overflow";
          const got = await actionLocation(page, id);
          eq(`A · ${stage} · #${id} is ${expected}`, got, expected);
        }
      }
      // The two headline examples from the brief, called out explicitly.
      await openCase(page, stageCaseId.enquiry);
      eq("A · at enquiry, act-factfind is PRIMARY", await actionLocation(page, "act-factfind"), "primary");
      eq("A · at enquiry, act-fee is in the OVERFLOW", await actionLocation(page, "act-fee"), "overflow");
      eq("A · at enquiry, act-paid is in the OVERFLOW", await actionLocation(page, "act-paid"), "overflow");
      eq("A · at enquiry, act-review is in the OVERFLOW", await actionLocation(page, "act-review"), "overflow");
      await openCase(page, stageCaseId.completed);
      eq("A · at completed, act-fee is PRIMARY", await actionLocation(page, "act-fee"), "primary");
      eq("A · at completed, act-paid is PRIMARY", await actionLocation(page, "act-paid"), "primary");
      eq("A · at completed, act-review is PRIMARY", await actionLocation(page, "act-review"), "primary");
      eq("A · at completed, act-factfind is in the OVERFLOW (reverse of enquiry)", await actionLocation(page, "act-factfind"), "overflow");

      /* R73 · A3 — the third tier, asserted directly so the new contract is pinned rather than
         merely tolerated by the widened helper above. A stage action that is not one of the two
         or three the bar shows must be tier "stage": in the menu, but named as belonging here,
         and never demoted all the way to "rest". */
      eq("A · R73 · at completed, act-fee is a STAGE action in Actions ▾ (not on the bar)", await actionTier(page, "act-fee"), "stage");
      eq("A · R73 · …and act-factfind, which belongs to no completed case, is tier rest", await actionTier(page, "act-factfind"), "rest");
      await openCase(page, stageCaseId.enquiry);
      eq("A · R73 · at enquiry, act-factfind is a STAGE action and act-fee is tier rest",
        [await actionTier(page, "act-factfind"), await actionTier(page, "act-fee")], ["stage", "rest"]);

      ok("A · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       B · RECORD-REASON — the one NEW id. In the DOM (primary) only at
           not_proceeding; absent everywhere else.
       ======================================================================= */
    {
      console.log("\n— B · #act-record-reason exists only at not_proceeding (p2)");
      const errBefore = (page.__err || []).length;
      await openCase(page, stageCaseId.not_proceeding);
      eq("B · at not_proceeding, act-record-reason is PRIMARY", await actionLocation(page, "act-record-reason"), "primary");
      await openCase(page, stageCaseId.completed);
      eq("B · at completed, act-record-reason is ABSENT from the DOM entirely", await actionLocation(page, "act-record-reason"), "absent");
      await openCase(page, stageCaseId.enquiry);
      eq("B · at enquiry, act-record-reason is ABSENT from the DOM entirely", await actionLocation(page, "act-record-reason"), "absent");
      ok("B · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       C · OVERFLOW ESCAPE HATCH — every one of the eight core action ids is
           reachable in the DOM at BOTH enquiry and completed (opposite ends
           of the relevance spectrum), and the toggle actually opens the menu.
       ======================================================================= */
    {
      console.log("\n— C · every action id survives in the DOM at enquiry AND completed; toggle opens the menu (p2)");
      const errBefore = (page.__err || []).length;
      for (const stage of ["enquiry", "completed"]) {
        await openCase(page, stageCaseId[stage]);
        for (const id of CORE_ACTIONS) {
          const got = await actionLocation(page, id);
          ok(`C · ${stage} · #${id} exists in the DOM (as ${got})`, got === "primary" || got === "overflow", got);
        }
        const beforeHidden = await hasClass(page, "#case-more-actions", "hidden");
        ok(`C · ${stage} · the overflow menu starts closed (class="hidden")`, beforeHidden === true);
        await page.click("#case-more-actions-toggle");
        await wait(page, 200);
        const afterHidden = await hasClass(page, "#case-more-actions", "hidden");
        ok(`C · ${stage} · clicking the toggle opens it (hidden removed)`, afterHidden === false);
        // Every overflow action is now genuinely visible (not just present in the DOM).
        const overflowIds = CORE_ACTIONS.filter((id) => !PRIMARY_STAGES[id].includes(stage));
        for (const id of overflowIds) {
          const visible = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }, `#${id}`);
          ok(`C · ${stage} · overflow action #${id} is actually visible once the menu is open`, visible);
        }
      }
      ok("C · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       D · SECTION VISIBILITY — security card + Files hidden (wrapper
           class="hidden") at enquiry/fact_find; present (no hidden class)
           from DIP through every later stage including both terminals.
           Documents renders full up to Exchange, collapses to a <details>
           at completed/not_proceeding — #case-docs-body exists either way.
       ======================================================================= */
    {
      console.log("\n— D · security card + Files hidden at enquiry/fact_find, present DIP→terminal; Documents compacts at completed/not_proceeding (p2)");
      const errBefore = (page.__err || []).length;
      const HIDDEN_STAGES = ["enquiry", "fact_find"];
      const VISIBLE_STAGES = ["decision_in_principle", "application", "offer", "exchange", "completed", "not_proceeding"];
      for (const stage of HIDDEN_STAGES) {
        await openCase(page, stageCaseId[stage]);
        eq(`D · ${stage} · #case-sec-wrap carries class="hidden"`, await hasClass(page, "#case-sec-wrap", "hidden"), true);
        eq(`D · ${stage} · #case-files carries class="hidden"`, await hasClass(page, "#case-files", "hidden"), true);
      }
      for (const stage of VISIBLE_STAGES) {
        await openCase(page, stageCaseId[stage]);
        eq(`D · ${stage} · #case-sec-wrap has NO class="hidden"`, await hasClass(page, "#case-sec-wrap", "hidden"), false);
        eq(`D · ${stage} · #case-files has NO class="hidden"`, await hasClass(page, "#case-files", "hidden"), false);
      }
      // Documents: <div> (full) up to Exchange, <details> (compact) at completed/not_proceeding.
      const FULL_DOC_STAGES = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
      const COMPACT_DOC_STAGES = ["completed", "not_proceeding"];
      for (const stage of FULL_DOC_STAGES) {
        await openCase(page, stageCaseId[stage]);
        const tag = await page.evaluate(() => { const e = document.querySelector("#case-docs"); return e ? e.tagName : null; });
        eq(`D · ${stage} · Documents renders in full (a <div>, not <details>)`, tag, "DIV");
        ok(`D · ${stage} · #case-docs-body exists`, await page.evaluate(() => !!document.querySelector("#case-docs-body")));
      }
      for (const stage of COMPACT_DOC_STAGES) {
        await openCase(page, stageCaseId[stage]);
        const tag = await page.evaluate(() => { const e = document.querySelector("#case-docs"); return e ? e.tagName : null; });
        eq(`D · ${stage} · Documents collapses (a <details>)`, tag, "DETAILS");
        ok(`D · ${stage} · #case-docs-body still exists inside it`, await page.evaluate(() => !!document.querySelector("#case-docs-body")));
      }
      ok("D · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       E · PRODUCT-TRANSFER TYPE GATING — no Solicitor field, no Exchanged-on
           field, Read-offer stays in the overflow even AT the offer stage
           (the one kind override caseActionIsPrimary applies), the "Solicitor"
           waiting-on option is dropped from the <select>, and the Advance
           button skips Exchange (offer → completed, not offer → exchange).
           A same-stage remortgage case is opened alongside each check as the
           control, to prove the gate is about kind, not stage.
       ======================================================================= */
    {
      console.log("\n— E · product_transfer: no Solicitor field, no Exchanged-on field, Read-offer stays overflow, Advance skips Exchange (p2)");
      const errBefore = (page.__err || []).length;
      const ptOffer = await mkClientCase(page, { first: "PT", last: "AtOffer", case_kind: "product_transfer", stage: "offer" });
      const remortOffer = stageCaseId.offer; // the remortgage control case from section A, same stage

      await openCase(page, ptOffer.caseId);
      eq("E · PT · #case-solicitor-field carries class=\"hidden\"", await hasClass(page, "#case-solicitor-field", "hidden"), true);
      eq("E · PT · #case-exchange-field carries class=\"hidden\" EVEN AT the offer stage", await hasClass(page, "#case-exchange-field", "hidden"), true);
      eq("E · PT · act-offer stays in the OVERFLOW despite being at the offer stage", await actionLocation(page, "act-offer"), "overflow");
      const ptSolicitorOption = await page.evaluate(() => !!document.querySelector('#case-waiting-select option[value="solicitor"]'));
      ok("E · PT · the \"Solicitor\" waiting-on option is dropped from the select", !ptSolicitorOption);
      const ptAdvanceText = await page.$eval("#cs-advance-btn", (e) => e.textContent).catch(() => "");
      ok("E · PT · Advance targets Completed, not Exchange", /Completed/.test(ptAdvanceText) && !/Exchange/.test(ptAdvanceText), ptAdvanceText);

      await openCase(page, remortOffer);
      eq("E · control (remortgage, same offer stage) · #case-solicitor-field has NO class=\"hidden\"", await hasClass(page, "#case-solicitor-field", "hidden"), false);
      eq("E · control · #case-exchange-field has NO class=\"hidden\" at the offer stage", await hasClass(page, "#case-exchange-field", "hidden"), false);
      eq("E · control · act-offer IS primary at the offer stage for an ordinary case", await actionLocation(page, "act-offer"), "primary");
      const remortSolicitorOption = await page.evaluate(() => !!document.querySelector('#case-waiting-select option[value="solicitor"]'));
      ok("E · control · the \"Solicitor\" waiting-on option IS offered", remortSolicitorOption);
      const remortAdvanceText = await page.$eval("#cs-advance-btn", (e) => e.textContent).catch(() => "");
      ok("E · control · Advance targets Exchange, the ordinary next stage", /Exchange/.test(remortAdvanceText), remortAdvanceText);

      ok("E · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       F · GI / BUILDINGS INSURANCE GATE — applies to remortgage + buy_to_let
           (GI_KINDS), never to product_transfer.
       ======================================================================= */
    {
      console.log("\n— F · GI/buildings insurance field: present for remortgage + buy_to_let, absent for product_transfer (p2)");
      const errBefore = (page.__err || []).length;
      const remort = await mkClientCase(page, { first: "GI", last: "Remortgage", case_kind: "remortgage", stage: "enquiry" });
      const btl = await mkClientCase(page, { first: "GI", last: "BuyToLet", case_kind: "buy_to_let", stage: "enquiry" });
      const pt = await mkClientCase(page, { first: "GI", last: "ProductTransfer", case_kind: "product_transfer", stage: "enquiry" });

      await openCase(page, remort.caseId);
      eq("F · remortgage · #gi-status-label has NO class=\"hidden\"", await hasClass(page, "#gi-status-label", "hidden"), false);
      await openCase(page, btl.caseId);
      eq("F · buy_to_let · #gi-status-label has NO class=\"hidden\"", await hasClass(page, "#gi-status-label", "hidden"), false);
      await openCase(page, pt.caseId);
      eq("F · product_transfer · #gi-status-label carries class=\"hidden\"", await hasClass(page, "#gi-status-label", "hidden"), true);

      ok("F · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       G · WORDING — the Documents and History section intros were CUT; a
           bare heading + tooltip replaces the old visible paragraph. Checked
           two ways: the exact old sentence is gone from the rendered text,
           and the <p class="panel-sub"> element that used to carry it is
           gone from the section entirely (Files, deliberately UNCUT, keeps
           its one-line <p>, so this is not "no <p> anywhere in the modal").
       ======================================================================= */
    {
      console.log("\n— G · Documents/History intro copy was cut, not just reworded (p2)");
      const errBefore = (page.__err || []).length;
      await openCase(page, stageCaseId.enquiry); // Documents in full form here
      const docsText = await page.$eval("#case-docs", (e) => e.textContent).catch(() => "");
      ok("G · the old Documents intro sentence is gone from rendered text", !/what this client has been asked for/i.test(docsText), docsText.slice(0, 120));
      const docsIntroP = await page.evaluate(() => !!document.querySelector("#case-docs > p.panel-sub"));
      ok("G · #case-docs has no <p class=\"panel-sub\"> intro element", !docsIntroP);

      const historyText = await page.$eval("#case-history", (e) => e.textContent).catch(() => "");
      ok("G · the old History intro sentence is gone from rendered text", !/written by the database as the case progresses/i.test(historyText), historyText.slice(0, 160));
      const historyIntroP = await page.evaluate(() => !!document.querySelector("#case-history > p.panel-sub"));
      ok("G · #case-history has no <p class=\"panel-sub\"> intro element", !historyIntroP);

      // Files, by contrast, keeps its (shortened) one-line <p> — the cut was selective.
      await openCase(page, stageCaseId.decision_in_principle); // Files visible here
      const filesIntroP = await page.evaluate(() => !!document.querySelector("#case-files > p.panel-sub"));
      ok("G · #case-files STILL has its (shortened) intro <p> — Files was not cut, only Documents/History", filesIntroP);

      ok("G · no console errors", noNewErr(errBefore), JSON.stringify(page.__err));
    }

  } finally {
    await page.close();
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r15: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
