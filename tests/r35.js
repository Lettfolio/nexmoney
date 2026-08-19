#!/usr/bin/env node
/* =============================================================================
   tests/r35.js — acceptance tests for ROUND 35: the case identity pack
   (admin/app.js only, no schema — every path already existed; this round only
   changes what they render).

   What R35 shipped (build agent's verified summary):
     1. Board cards always show the case KIND. The `.cd` line is now `kind · lender`
        whenever the card carries an ADDRESS chip (previously the kind was dropped the
        moment any chip rendered at all, so an addressed remortgage and the BTL next to
        it on the board read identically apart from the lender). A hollow (no-address)
        chip already says the kind itself (propChip's fallback label), so `.cd` there
        stays `lender` only (or the kind alone if there is no lender) — never both.
     2. Same-property LIVE twins get a stage tail. Two live (non-terminal) cases for the
        same client_id + propKey, on a card that carries a real address chip, get
        ` <span class="case-tag">Stage label</span>` appended to `.cd`. Never on a solo
        card, never on a hollow (no-address) chip, and never counting a terminal case as
        a twin.
     3. BTL affordability never silently vanishes. `#cs-btl-icr` now renders for EVERY
        buy_to_let case (btlIcrOn): the ICR chip when there is a rent, an amber
        "Rent — not captured" badge + `#cs-btl-add-rent` button when there is not. The
        button opens `#modal .case-details` and focuses `[name=monthly_rent]` — the same
        gesture as the expected-completion nudge. Non-BTL cases are unchanged: no row.
     4. Retention self-nag stops. A LIVE retention successor (retention_source_case_id
        set, stage not terminal) is excluded from the Rate & ERC drawer feed — the list,
        the heading's scoped counts and the tooltip's firm-wide figures all move
        together. The SOURCE case's own row is untouched — it is what still offers
        "Start retention case" / carries the 🔁 badge.
     5. The modal grows a move-to-any-stage control: `#cs-stage-select` (class
        `card-stage-move`, same shape as the board card's own per-card select), all 8
        STAGES options with the current one selected, beside `#cs-advance-btn`. onchange
        routes through the single `moveCaseToStage` path — every guard (protection gate,
        lost-reason capture, reopen/complete confirms) still applies. `#case-mark-np`
        ("🚫 Mark not proceeding") sits in the case's More-actions overflow at every stage
        except not_proceeding itself, where "Record reason" already does that job.

   §A — BOARD KIND (p4, board-adviser "all"): an addressed remortgage card's `.cd`
        contains its kind + lender; an addressed BTL card's `.cd` contains "Buy to Let";
        a hollow (no-address, client has >1 case) chip already says the kind, so `.cd`
        prints the lender only — the kind is never repeated.
   §B — TWINS: two live same-client same-property cases (Duncan Armitage's own
        Application/Offer pair on 4 Seafield Gardens) both carry `.case-tag` with their
        own (different) stage label; a solo addressed card (Melanie Underhill's lone BTL
        application) carries none; completing one twin and reloading drops the remaining
        card's tag (twin count fell to 1).
   §C — BTL STATES: a BTL case with rent shows the ICR chip inside `#cs-btl-icr`
        unchanged; one without rent shows the amber "Rent — not captured" badge and
        `#cs-btl-add-rent`; clicking it opens Case details and focuses `monthly_rent`;
        saving a rent and reopening shows the chip; a non-BTL case has no `#cs-btl-icr`
        row at all.
   §D — RETENTION SELF-NAG: a seeded live case with a past rate_end_date assigned to the
        viewer shows up in `#alerts-rateerc`; seeding a live successor pointing at it,
        with the same past rate_end_date, leaves exactly one row for that client (the
        successor's id never appears) and the heading's scoped count is unchanged.
   §E — MODAL STAGE CONTROL: `#cs-stage-select` carries all 8 STAGES options with the
        current one selected; picking a legal backwards stage moves the case (verified
        against the mock db) and repaints the modal with the new value selected;
        `#case-mark-np` is reachable from the More-actions overflow on a live case and,
        after the confirm + lost-reason capture, lands the case on not_proceeding —
        reopening then shows the button gone.
   §F — no NEW console errors anywhere above (checked per block, same convention every
        suite in this harness uses).

   EVERY figure this file asserts is either read straight back off the mock db or
   composed from a fixed, independently-stated map (STAGE_LABEL, KIND_LABEL) — never
   imported from app.js's own STAGES/KINDS — per the standing "compute test expectations
   independently" rule in HARNESS.md.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r35.js
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
    if (next === "dismiss") await d.dismiss(); else await d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const noNewErr = (page, before) => (page.__err || []).length === before;
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1000 : ms);
};

/* R35's own R34-era localStorage keys this suite touches, cleared the same way tests/r34.js
   clears them: only a REAL stored choice may override the role default, so clearing them each
   time keeps every block's starting state honest. */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_diary_staff", "nx_views_v1",
  "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads", "nx_drawer_todayappts",
  "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue", "nx_nav_firm"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — the same independent-of-fixture technique
   tests/r34.js/r31.js/r25.js/r16.js already use, so every assertion below is
   about a case this file created and fully controls, not about the fixture's
   current, ever-shifting composition.
   ------------------------------------------------------------------------- */
async function insertClient(page, fields) {
  return page.evaluate(async (f) => {
    const db = window.__mockDb;
    const { data, error } = await db.from("clients").insert(f).select("id").single();
    if (error) throw new Error("client insert: " + error.message);
    return data.id;
  }, fields);
}
async function insertCase(page, fields) {
  return page.evaluate(async (f) => {
    const db = window.__mockDb;
    const { data, error } = await db.from("cases").insert(f).select("id").single();
    if (error) throw new Error("case insert: " + error.message);
    return data.id;
  }, fields);
}
async function mkClientCase(page, opts) {
  const o = opts || {};
  const clId = await insertClient(page, {
    first_name: o.first || "R35", last_name: o.last || ("Case" + Math.random().toString(36).slice(2, 8)),
    email: o.email || `r35.${Math.random().toString(36).slice(2, 9)}@example.com`, phone: "07700900000",
  });
  const row = Object.assign({ client_id: clId, case_kind: "buy_to_let", stage: "application", assigned_to: "p2" }, o.case || {});
  const caseId = await insertCase(page, row);
  return { clId, caseId };
}
const readCase = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", id).single();
  return data;
}, caseId);
const openCase = async (page, caseId) => {
  await page.evaluate((id) => window.openCase(id), caseId);
  await wait(page, 900);
  // R33 — scoped to #modal: an unscoped ".case-details" can hit Settings' own disclosure first.
  await page.evaluate(() => { const d = document.querySelector("#modal .case-details"); if (d) d.open = true; });
};
const localDate = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().slice(0, 10);
const DAY = 86400000;

/* Independent (never-imported) label maps, exactly the standing rule this harness follows. */
const STAGES = [
  ["enquiry", "Enquiry"], ["fact_find", "Fact Find"], ["decision_in_principle", "DIP"],
  ["application", "Application"], ["offer", "Offer"], ["exchange", "Exchange"],
  ["completed", "Completed"], ["not_proceeding", "Not Proceeding"],
];
const STAGE_LABEL = Object.fromEntries(STAGES);

/* The board's own DOM shape: pull a card's `.cd` text and its chip's `.pc-txt` (if any). */
const cardShape = (page, caseId) => page.evaluate((id) => {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (!card) return null;
  const chip = card.querySelector(".prop-chip");
  return {
    cd: (card.querySelector(".cd") || {}).textContent || "",
    chipTxt: chip ? (chip.querySelector(".pc-txt") || {}).textContent || "" : null,
    chipHollow: chip ? chip.classList.contains("prop-chip-none") : null,
    hasTag: !!card.querySelector(".case-tag"),
    tagText: (card.querySelector(".case-tag") || {}).textContent || null,
    stageCol: card.closest(".col") ? card.closest(".col").dataset.stage : null,
  };
}, caseId);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       A · BOARD KIND (p4, board-adviser "all")
       ======================================================================= */
    {
      console.log("\n— A · addressed cards show kind + lender; a hollow chip's kind is never repeated (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await page.reload();
      await wait(page, SETTLE);

      const remo = await mkClientCase(page, {
        first: "R35A", last: "Remo", case: {
          case_kind: "remortgage", stage: "application", assigned_to: "p2", lender: "R35TestLenderA",
          property_address: "1 R35KindOne Street, Bournemouth BH1 1AA",
        },
      });
      const btl = await mkClientCase(page, {
        first: "R35A", last: "Btl", case: {
          case_kind: "buy_to_let", stage: "application", assigned_to: "p2", lender: "R35TestLenderB",
          property_address: "2 R35KindTwo Street, Bournemouth BH2 2BB",
        },
      });
      // The hollow-chip client needs a SECOND case (so clientCaseCount > 1) that carries a real
      // address (propFallbackWorthIt requires the client's book to hold at least one addressed
      // case) — the card under test itself carries none.
      const hollowClient = await insertClient(page, { first_name: "R35A", last_name: "Hollow", email: `r35.hollow.${Date.now()}@example.com`, phone: "07700900000" });
      await insertCase(page, { client_id: hollowClient, case_kind: "purchase", stage: "enquiry", assigned_to: "p2", property_address: "3 R35KindThree Street, Bournemouth BH3 3CC" });
      const hollowCaseId = await insertCase(page, { client_id: hollowClient, case_kind: "buy_to_let", stage: "application", assigned_to: "p2", lender: "R35TestLenderC", property_address: null });

      await goto(page, "pipeline");
      await page.selectOption("#board-adviser", "all");
      await wait(page, 500);

      const remoCard = await cardShape(page, remo.caseId);
      ok("A1a · the addressed remortgage card's chip carries the address, not the kind", remoCard && remoCard.chipTxt && !/Remortgage/i.test(remoCard.chipTxt), JSON.stringify(remoCard));
      ok("A1b · …and .cd names the kind AND the lender", remoCard && /Remortgage/.test(remoCard.cd) && /R35TestLenderA/.test(remoCard.cd), JSON.stringify(remoCard));

      const btlCard = await cardShape(page, btl.caseId);
      ok("A2 · the addressed BTL card's .cd contains \"Buy to Let\" (and the lender)", btlCard && /Buy to Let/.test(btlCard.cd) && /R35TestLenderB/.test(btlCard.cd), JSON.stringify(btlCard));

      const hollowCard = await cardShape(page, hollowCaseId);
      ok("A3a · the hollow (no-address) chip says the kind itself", hollowCard && hollowCard.chipHollow && hollowCard.chipTxt === "Buy to Let", JSON.stringify(hollowCard));
      eq("A3b · …and .cd prints ONLY the lender — the kind is not repeated a second time", hollowCard && hollowCard.cd, "R35TestLenderC");
      ok("A3c · (so \"Buy to Let\" appears exactly once between the chip and the line, never twice)", hollowCard && !/Buy to Let/.test(hollowCard.cd), JSON.stringify(hollowCard));

      ok("A · no console errors (p4)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B · TWINS — same client, same property, two live cases
       ======================================================================= */
    {
      console.log("\n— B · live same-client/same-property twins carry .case-tag; a solo card doesn't; completing one drops the other's tag (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "pipeline");
      await page.selectOption("#board-adviser", "all");
      await wait(page, 500);

      // Duncan Armitage's own fixture pair — the R35 comment's own worked example: an
      // Application case and an Offer case, both live, both on 4 Seafield Gardens.
      const duncan = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").select("id").eq("email", "duncan.armitage@example.com").single();
        const { data: cs } = await db.from("cases").select("id,stage,property_address").eq("client_id", cl.id).in("stage", ["application", "offer"]);
        return { clientId: cl.id, cases: cs };
      });
      const appCase = duncan.cases.find((c) => c.stage === "application");
      const offerCase = duncan.cases.find((c) => c.stage === "offer");
      ok("fixture · Duncan Armitage has a live Application + Offer pair on the same property", !!appCase && !!offerCase && appCase.property_address === offerCase.property_address, JSON.stringify(duncan));

      const appCardBefore = await cardShape(page, appCase.id);
      const offerCardBefore = await cardShape(page, offerCase.id);
      eq("B1a · the Application twin carries .case-tag \"Application\"", appCardBefore && appCardBefore.tagText, "Application");
      eq("B1b · the Offer twin carries .case-tag \"Offer\" — the DIFFERENT stage of its sibling", offerCardBefore && offerCardBefore.tagText, "Offer");

      // Melanie Underhill's lone BTL application — the only LIVE case at that address for that
      // client (her other case, on a different address, is Completed and so terminal anyway).
      const underhill = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").select("id").eq("email", "melanie.underhill@example.com").single();
        const { data: cs } = await db.from("cases").select("id,stage").eq("client_id", cl.id).eq("stage", "application");
        return { clientId: cl.id, caseId: cs[0] && cs[0].id };
      });
      ok("fixture · Melanie Underhill's BTL application case was found", !!underhill.caseId, JSON.stringify(underhill));
      const soloCard = await cardShape(page, underhill.caseId);
      ok("B2 · a solo addressed card carries NO .case-tag", soloCard && !soloCard.hasTag, JSON.stringify(soloCard));

      // Complete the Offer twin directly (bypassing the confirm dialog — this block is testing
      // the board's twin-count logic, not the completion flow, which R9-1/T1-8 already cover).
      // A real page.reload() would rebuild the mock db's whole in-memory fixture from scratch
      // (see HARNESS.md) and silently undo this update along with it — re-navigating to the same
      // page within the same session is the "come back and look again" this step actually needs.
      await page.evaluate(async (id) => {
        await window.__mockDb.from("cases").update({ stage: "completed", completed_at: new Date().toISOString() }).eq("id", id);
      }, offerCase.id);
      // nav() always re-runs the page's loader unconditionally, even re-entering the same page —
      // this is the "come back and look again" this step needs, without the mock db reset a real
      // page.reload() would cause (see the comment above).
      await goto(page, "pipeline");
      await page.selectOption("#board-adviser", "all");
      await wait(page, 500);

      const appCardAfter = await cardShape(page, appCase.id);
      ok("B3 · once its twin completes (twin count fell to 1) the remaining card's tag disappears", appCardAfter && !appCardAfter.hasTag, JSON.stringify(appCardAfter));
      const completedCard = await cardShape(page, offerCase.id);
      ok("B3b · …and the now-completed card carries no tag either (terminal, no longer a twin)", completedCard && !completedCard.hasTag, JSON.stringify(completedCard));

      ok("B · no console errors (p4)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C · BTL AFFORDABILITY STATES
       ======================================================================= */
    {
      console.log("\n— C · #cs-btl-icr: rent present (unchanged), rent missing (amber + add-rent), non-BTL (absent) (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const withRent = await mkClientCase(page, { first: "R35C", last: "Rent", case: { case_kind: "buy_to_let", stage: "application", loan_amount: 200000, monthly_rent: 1500 } });
      await openCase(page, withRent.caseId);
      const rentRow = await page.evaluate(() => {
        const el = document.querySelector("#cs-btl-icr");
        return el ? { html: el.innerHTML, hasChip: !!el.querySelector(".icr-chip"), hasAmber: !!el.querySelector(".badge.amber") } : null;
      });
      ok("C1a · a BTL case WITH rent shows #cs-btl-icr as the ICR chip (unchanged behaviour)", rentRow && rentRow.hasChip && !rentRow.hasAmber, JSON.stringify(rentRow));

      const noRent = await mkClientCase(page, { first: "R35C", last: "NoRent", case: { case_kind: "buy_to_let", stage: "application", loan_amount: 200000, monthly_rent: null } });
      await openCase(page, noRent.caseId);
      const noRentRow = await page.evaluate(() => {
        const el = document.querySelector("#cs-btl-icr");
        const amber = el ? el.querySelector(".badge.amber") : null;
        const btn = document.querySelector("#cs-btl-add-rent");
        return { present: !!el, amberText: amber ? amber.textContent : null, hasBtn: !!btn };
      });
      ok("C2a · a BTL case WITHOUT rent still renders #cs-btl-icr (R35 §3 — never silently absent)", noRentRow.present, JSON.stringify(noRentRow));
      eq("C2b · …with the amber \"Rent — not captured\" badge", noRentRow.amberText, "Rent — not captured");
      ok("C2c · …and the #cs-btl-add-rent button", noRentRow.hasBtn, JSON.stringify(noRentRow));

      await page.click("#cs-btl-add-rent");
      await wait(page, 300);
      const afterAdd = await page.evaluate(() => {
        const det = document.querySelector("#modal .case-details");
        const active = document.activeElement;
        return { open: det && det.open, focusedName: active && active.getAttribute && active.getAttribute("name") };
      });
      ok("C3a · clicking \"add\" opens #modal .case-details", afterAdd.open === true, JSON.stringify(afterAdd));
      eq("C3b · …and focuses [name=monthly_rent]", afterAdd.focusedName, "monthly_rent");

      await page.fill('#case-form [name="monthly_rent"]', "1300");
      await page.click("#modal-save");
      await wait(page, 900);
      const saved = await readCase(page, noRent.caseId);
      eq("C4a · the rent was saved", Number(saved.monthly_rent), 1300);
      await openCase(page, noRent.caseId);
      const reopened = await page.evaluate(() => {
        const el = document.querySelector("#cs-btl-icr");
        return { hasChip: !!(el && el.querySelector(".icr-chip")), hasAmber: !!(el && el.querySelector(".badge.amber")) };
      });
      ok("C4b · reopening now shows the ICR chip, not the amber badge", reopened.hasChip && !reopened.hasAmber, JSON.stringify(reopened));

      const nonBtl = await mkClientCase(page, { first: "R35C", last: "NonBtl", case: { case_kind: "remortgage", stage: "application", loan_amount: 200000 } });
      await openCase(page, nonBtl.caseId);
      const nonBtlAbsent = await page.evaluate(() => !document.querySelector("#cs-btl-icr"));
      ok("C5 · a non-BTL case has no #cs-btl-icr row at all", nonBtlAbsent);

      ok("C · no console errors (p2)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       D · RETENTION SELF-NAG
       ======================================================================= */
    {
      console.log("\n— D · a live retention successor stops re-nagging the Rate & ERC drawer (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await page.reload();
      await wait(page, SETTLE);

      const pastRate = localDate(-30 * DAY);
      const src = await mkClientCase(page, {
        first: "R35D", last: "Source", case: { case_kind: "remortgage", stage: "application", assigned_to: "p2", rate_end_date: pastRate, lender: "R35DLender" },
      });
      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, SETTLE);

      const rowsFor = (page, caseId) => page.evaluate((id) => [...document.querySelectorAll("#alerts-rateerc .row-item")]
        .filter((r) => (r.querySelector(".t") && r.querySelector(".t").getAttribute("onclick") || "").includes(`openCase('${id}')`)), caseId);
      const readCount = (page) => page.evaluate(() => {
        const el = document.querySelector("#rate-erc-panel h3 .count.hot");
        return el ? Number((el.textContent.match(/(\d+)/) || [])[1]) : 0;
      });

      const srcRowsBefore = await page.evaluate((id) => [...document.querySelectorAll("#alerts-rateerc .row-item")]
        .filter((r) => (((r.querySelector(".t") || {}).getAttribute && r.querySelector(".t").getAttribute("onclick")) || "").includes(`'${id}'`)).length, src.caseId);
      ok("D1 · the seeded live source case shows up in #alerts-rateerc", srcRowsBefore >= 1, JSON.stringify(srcRowsBefore));
      const countAfterSrc = await readCount(page);

      const succ = await mkClientCase(page, {
        first: "R35D", last: "Successor", case: {
          case_kind: "remortgage", stage: "enquiry", assigned_to: "p2", rate_end_date: pastRate,
          lender: "R35DLender", retention_source_case_id: src.caseId,
        },
      });
      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, SETTLE);

      const countAfterSucc = await readCount(page);
      eq("D2a · the heading's scoped \"ending soon\" count is unchanged — the successor added no new alert", countAfterSucc, countAfterSrc);
      const succRows = await page.evaluate((id) => [...document.querySelectorAll("#alerts-rateerc .row-item")]
        .filter((r) => (((r.querySelector(".t") || {}).getAttribute && r.querySelector(".t").getAttribute("onclick")) || "").includes(`'${id}'`)).length, succ.caseId);
      eq("D2b · the live successor's own id never appears in the drawer", succRows, 0);
      const srcRowsAfter = await page.evaluate((id) => [...document.querySelectorAll("#alerts-rateerc .row-item")]
        .filter((r) => (((r.querySelector(".t") || {}).getAttribute && r.querySelector(".t").getAttribute("onclick")) || "").includes(`'${id}'`)).length, src.caseId);
      eq("D2c · the source's own row is untouched — exactly one row for it, same as before", srcRowsAfter, 1);

      ok("D · no console errors (p2)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       E · MODAL STAGE CONTROL
       ======================================================================= */
    {
      console.log("\n— E · #cs-stage-select (all 8 stages, current selected, legal backward move) + #case-mark-np (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const c = await mkClientCase(page, { first: "R35E", last: "Stage", case: { case_kind: "remortgage", stage: "offer", assigned_to: "p2", protection_status: "not_discussed" } });
      await openCase(page, c.caseId);

      const selState = await page.evaluate(() => {
        const sel = document.querySelector("#cs-stage-select");
        if (!sel) return null;
        return {
          opts: [...sel.options].map((o) => ({ value: o.value, selected: o.selected })),
          cls: sel.className,
        };
      });
      ok("E1a · #cs-stage-select exists and carries class card-stage-move", selState && /\bcard-stage-move\b/.test(selState.cls), JSON.stringify(selState));
      eq("E1b · it carries all 8 STAGES, in order", selState && selState.opts.map((o) => o.value), STAGES.map(([k]) => k));
      const selectedNow = selState && selState.opts.filter((o) => o.selected).map((o) => o.value);
      eq("E1c · the current stage (offer) is the one selected", selectedNow, ["offer"]);

      // A legal BACKWARDS move — offer -> application — needs no confirm (not completed, not a
      // reopening out of a terminal stage) and never trips the protection gate (which only guards
      // FORWARD moves), so it is the cleanest way to exercise the control end-to-end.
      await page.selectOption("#cs-stage-select", "application");
      await wait(page, 700);
      const afterMove = await readCase(page, c.caseId);
      eq("E2a · the case's stage genuinely changed in the mock db", afterMove.stage, "application");
      const repainted = await page.evaluate(() => {
        const sel = document.querySelector("#cs-stage-select");
        return sel ? [...sel.options].filter((o) => o.selected).map((o) => o.value) : null;
      });
      eq("E2b · the modal repainted — #cs-stage-select now shows \"application\" selected", repainted, ["application"]);

      // #case-mark-np, from the More-actions overflow, on a still-live case.
      const npVisible = await page.evaluate(() => !!document.querySelector("#case-mark-np"));
      ok("E3a · #case-mark-np is present for a live case", npVisible);
      await page.click("#case-more-actions-toggle");
      await wait(page, 250);
      const npReachable = await page.evaluate(() => {
        const menu = document.querySelector("#case-more-actions");
        const btn = document.querySelector("#case-mark-np");
        return { menuOpen: menu && !menu.classList.contains("hidden"), btnVisible: !!(btn && btn.offsetParent) };
      });
      ok("E3b · the overflow opens and #case-mark-np is reachable inside it", npReachable.menuOpen && npReachable.btnVisible, JSON.stringify(npReachable));

      await page.click("#case-mark-np");
      await wait(page, 600);
      ok("E3c · the confirm names the consequence", /Mark this case as Not proceeding/i.test((page.__dialogs.slice(-1)[0] || {}).message || ""), JSON.stringify(page.__dialogs.slice(-1)));
      ok("E3d · the lost-reason capture opens next", await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden")));
      await page.selectOption("#lost-reason", "rate_price");
      await page.click("#lost-ok");
      await wait(page, 900);

      const afterNp = await readCase(page, c.caseId);
      eq("E4a · the case landed on not_proceeding", afterNp.stage, "not_proceeding");
      eq("E4b · …with the reason recorded", afterNp.lost_reason, "rate_price");
      const npGone = await page.evaluate(() => !document.querySelector("#case-mark-np"));
      ok("E4c · reopening the (now not_proceeding) case shows #case-mark-np gone", npGone);

      ok("E · no console errors (p2)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r35: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
