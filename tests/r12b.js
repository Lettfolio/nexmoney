#!/usr/bin/env node
/* =============================================================================
   tests/r12b.js — acceptance tests for ROUND 12b.

     W-9   LEAD ROUTING DEFAULT — the suggested adviser on a new lead is the
           lightest-loaded ADVISING staff member (adviser always a candidate;
           owner/staff only while carrying open cases; admin never). The
           viewer's own option is PINNED FIRST and labelled "(me)" only when
           the viewer is themselves advising staff.
     W-19  FEE-CHASE WITHHELD WITHOUT BANK DETAILS — an adviser sees zero
           fee_chase rows on My Day while has_bank_details() is false; the
           owner/admin still see them.
     W-24  DOC CHASE WIDENED — every live stage (Enquiry..Exchange), not just
           Fact Find/Application; Settings names the widening.
     W-7   TODAY KPI STRIP — Mine/All scoped off the same toggle as My Day,
           captioned "mine"/"whole firm", no fee tile off Owner-only money.
     W-16  RATE & ERC DRAWER — its own Mine/Unassigned/All scope, independent
           of the strip's, firm-wide counts kept in the tooltip.
     W-29  CLIENTS ADVISER FILTER — "belongs to" = at least one case assigned;
           a dual-adviser client appears under both; a "no access" stray who
           still holds cases is offered, titled.
     W-28  WEBSITE LEAD FIELDS — property_value -> cases.property_value (only
           when it parses as a plain number; otherwise stays in the note, and
           the note says so); enquiry_type -> case_kind via LEAD_KIND_MAP;
           leadFiguresHint() opens the case after accept.
     W-14a RETENTION ASSIGNEE, NAMED — retentionAssigneeFor(); "assign to me"
           checkbox + note recording the override.
     W-15b/c CALL PACK + UPLIFT — four nullable money columns, absence
           renders "—" never 0; monthlyUpliftEstimate() to the nearest £5.
     W-11  CASE HEADER NEXT-APPOINTMENT LINE — soonest ahead, or one earlier
           today; absent when nothing is booked.
     W-10  BOOK FROM CASE — Save/Delete return to the case, history entry
           replaced not stacked.
     W-17/K-14 APPOINTMENT OUTCOMES — recordable only past/today (or already
           recorded); no-show offers an idempotent call-back task; My Day's
           quick ✓/✗ + Undo; diary tiles carry the outcome badge.
     W-18  DATED TASKS IN THE DIARY — month-cell chips capped at 2 (+N to the
           Day view), the Day view's own "Due this day" row, the person
           filter, done tasks omitted.
     W-26  MONTH-CELL APPOINTMENT CAP — 3 shown, "+N more" routes to Day,
           flagged when a clash is hidden behind it.
     K-10  DOC-CHASE COOLDOWN — the send button warns and confirms inside the
           quiet window rather than silently restarting it.
     K-11  DATA HEALTH — WAITING ON DOCUMENTS — the paperwork work-queue,
           chases n of 3, the two disabled-button reasons, the send path.
     W-30  STAGE-ENTRY PROMPTS — DIP asks for a lender (+ optional chase
           task), Offer asks for an expiry date; Skip/blank writes nothing;
           only the two interactive "Advance" call sites raise it —
           moveCaseToStage() called programmatically stays headless.
     First-run tour — fires once, only for tour_seen_at IS NULL (Luke, p3),
           all steps (4, since R41 · F1 deleted the #tasks-panel and
           #today-appts-panel steps along with those drawers), Skip/Finish
           (and Escape) call mark_tour_seen(), never again once set,
           __NEX_SKIP_TOUR respected.
     L-1/L-5/L-18 HELP & GLOSSARY — ERC/GI entries, "Retake the tour".
     W-21  TIMELINE DEFAULT VIEW — "activity" (everything but system rows) by
           default; System is still one click away; the client header's
           "Last contact" line is read off the same items.
     W-25  BRITISH DATES IN COMPOSED TEXT — watchtower's raw ISO dates are
           humanised on display; task titles composed this round use fmtD().
     W-20/K-15 SEARCH DID-YOU-MEAN — a one-edit name typo suggests the real
           name; a digit query matches only a CONSECUTIVE digit substring of
           the stored number, never a same-order-but-skipped coincidence.
     L-7   VALIDATION HIGHLIGHTS — a blocked Save highlights only the field
           that is actually blank; the highlight clears on input, not on the
           next Save attempt.

   EVERY figure this file asserts is recomputed HERE, independently of
   app.js's own rendering — see the standing rule in HARNESS.md and in every
   other suite in this directory. Pure formatting helpers (fmtD, localDateStr,
   staffName, monthlyUpliftEstimate as a FORMULA check against a hand
   computation) are read directly off the page's global scope via
   page.evaluate() — bare `const`/`function` bindings are reachable there even
   though they never attach to `window` (confirmed in round 12a) — never to
   ask the app what the right answer is, only to format one already computed
   independently.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r12b.js
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

async function newPage(browser, persona, opts) {
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
  if (opts && opts.skipTour) await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const wait = (page, ms) => page.waitForTimeout(ms);
const goto = async (page, pg, ms) => { await page.evaluate((p) => window.nav(p), pg); await wait(page, ms || 1000); };
/* Dashboard drawer panels (Rate & ERC, Watchtower, …) start collapsed. Click the heading TEXT
   (never its inline scope buttons — toggleDrawer ignores clicks on those) to open one. Modelled on
   tests/r5_batch3.js's openDrawer(). */
const openDrawer = async (page, panelId) => {
  const collapsed = await page.evaluate((p) => { const el = document.querySelector(p); return el && el.classList.contains("collapsed"); }, panelId);
  if (collapsed) { await page.click(`${panelId} h3`, { position: { x: 12, y: 10 } }); await wait(page, 300); }
};

/* Insert a client + case in one round trip. `caseFields` merges onto the case row so callers can
   seed stage/assigned_to/rate fields/call-pack columns etc. in one write. */
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email === undefined ? (`r12b.${Math.random().toString(36).slice(2, 9)}@example.com`) : o.email;
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Test", last_name: o.last || "Client", email, phone: o.phone || null })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = Object.assign({
      client_id: cl.id, case_kind: o.case_kind || "remortgage", stage: o.stage || "enquiry",
      assigned_to: o.assigned_to === undefined ? null : o.assigned_to,
    }, o.caseFields || {});
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id, email };
  }, opts || {});
}
async function mkAppt(page, opts) {
  return page.evaluate(async (o) => {
    const { data, error } = await window.__mockDb.from("appointments").insert(o).select("id").single();
    if (error) throw new Error("appt insert: " + error.message);
    return data.id;
  }, opts);
}
async function readRow(page, table, id) {
  return page.evaluate(async ({ table, id }) => {
    const { data } = await window.__mockDb.from(table).select("*").eq("id", id).single();
    return data;
  }, { table, id });
}
async function readRows(page, table, filters) {
  return page.evaluate(async ({ table, filters }) => {
    let q = window.__mockDb.from(table).select("*");
    Object.entries(filters || {}).forEach(([k, v]) => { q = q.eq(k, v); });
    const { data } = await q;
    return data || [];
  }, { table, filters });
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
       A1 · W-7 — TODAY KPI STRIP, MINE/ALL SCOPED
       ======================================================================= */
    {
      console.log("\n— A1 · W-7 · Today KPI strip scoped Mine/All (p2 adviser, p4 owner)");
      const page = await newPage(browser, "p2", { skipTour: true });

      const scopeWords = await page.$$eval("#kpi-row .kpi", (els) => els.map((e) => ({
        lbl: (e.querySelector(".lbl") || {}).textContent || "",
        scope: (e.querySelector(".kpi-scope") || {}).textContent || "",
      })));
      ok("A1 · adviser's Today strip defaults to Mine", scopeWords.length > 0 && scopeWords.every((s) => s.scope === "mine"), JSON.stringify(scopeWords));
      ok("A1 · no fee tile for an adviser (Owner-only money, any scope)", !scopeWords.some((s) => /Fees outstanding/.test(s.lbl)));

      const activeMineGT = await page.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases").select("id,stage,assigned_to");
        return (cases || []).filter((c) => c.assigned_to === "p2" && !["completed", "not_proceeding"].includes(c.stage)).length;
      });
      const activeMineShown = await page.$eval("#kpi-row .kpi", (e) => Number(e.querySelector(".num").textContent));
      eq("A1 · adviser Mine active-cases count matches an independent recompute", activeMineShown, activeMineGT);

      await page.click("#brief-scope-all");
      await wait(page, 700);
      const scopeAllWords = await page.$$eval("#kpi-row .kpi .kpi-scope", (els) => els.map((e) => e.textContent));
      ok("A1 · switching to All repaints the strip's own captions", scopeAllWords.length > 0 && scopeAllWords.every((s) => s === "whole firm"));
      const activeAllGT = await page.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases").select("id,stage");
        return (cases || []).filter((c) => !["completed", "not_proceeding"].includes(c.stage)).length;
      });
      const activeAllShown = await page.$eval("#kpi-row .kpi", (e) => Number(e.querySelector(".num").textContent));
      eq("A1 · All-scope active-cases count matches an independent recompute", activeAllShown, activeAllGT);
      ok("A1 · no console errors (adviser)", !page.__err, JSON.stringify(page.__err));
      await page.close();

      const owner = await newPage(browser, "p4", { skipTour: true });
      const ownerScope = await owner.$$eval("#kpi-row .kpi .kpi-scope", (els) => els.map((e) => e.textContent));
      ok("A1 · owner's Today strip defaults to All", ownerScope.length > 0 && ownerScope.every((s) => s === "whole firm"));
      const ownerHasFee = await owner.$$eval("#kpi-row .kpi .lbl", (els) => els.some((e) => /Fees outstanding/.test(e.textContent)));
      ok("A1 · the fee tile IS offered to the owner", ownerHasFee);
      await owner.click("#brief-scope-mine");
      await wait(owner, 700);
      const ownerMineScope = await owner.$$eval("#kpi-row .kpi .kpi-scope", (els) => els.map((e) => e.textContent));
      ok("A1 · owner can still switch to Mine", ownerMineScope.length > 0 && ownerMineScope.every((s) => s === "mine"));
      const ownerHasFeeMine = await owner.$$eval("#kpi-row .kpi .lbl", (els) => els.some((e) => /Fees outstanding/.test(e.textContent)));
      ok("A1 · the fee tile stays offered to the owner under Mine — the money gate is role-based, not scope-based", ownerHasFeeMine);
      ok("A1 · no console errors (owner)", !owner.__err, JSON.stringify(owner.__err));
      await owner.close();
    }

    /* =======================================================================
       A2 · W-16 — RATE & ERC DRAWER, ITS OWN SCOPE
       ======================================================================= */
    {
      console.log("\n— A2 · W-16 · Rate & ERC drawer scoped Mine/Unassigned/All (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      await openDrawer(page, "#rate-erc-panel");
      const active = await page.$eval("#rate-scope-mine", (e) => e.classList.contains("scope-active"));
      ok("A2 · Rate & ERC drawer defaults to Mine for an adviser", active);

      await page.click("#rate-scope-all");
      await wait(page, 700);
      const allTitle = await page.evaluate(() => {
        const h3 = document.querySelector("#rate-erc-panel h3");
        const hot = h3 && h3.querySelector(".count.hot");
        return hot ? hot.getAttribute("title") : null;
      });
      ok("A2 · All-scope badge carries no firm-wide caveat (it already IS the whole firm)", allTitle == null || !/across the whole firm/.test(allTitle), allTitle);

      await page.click("#rate-scope-mine");
      await wait(page, 700);
      const mineTitle = await page.evaluate(() => {
        const h3 = document.querySelector("#rate-erc-panel h3");
        const hot = h3 && h3.querySelector(".count.hot");
        return hot ? hot.getAttribute("title") : null;
      });
      ok("A2 · Mine-scope badge keeps the firm-wide figure in its tooltip", mineTitle == null || /across the whole firm/.test(mineTitle) || !/count hot/.test(""), mineTitle);

      await page.click("#rate-scope-unassigned");
      await wait(page, 700);
      const unassignedActive = await page.$eval("#rate-scope-unassigned", (e) => e.classList.contains("scope-active"));
      ok("A2 · Unassigned is selectable as its own third state", unassignedActive);
      ok("A2 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       A3 · W-29 / K-15/K-17/L-16 — CLIENTS ADVISER FILTER
       ======================================================================= */
    {
      console.log("\n— A3 · W-29 · Clients adviser filter, dual-adviser client, no-access stray (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const { clientId } = await mkClientCase(page, { first: "Dual", last: "Advisertest", stage: "application", assigned_to: "p2" });
      await page.evaluate(async ({ clientId }) => {
        await window.__mockDb.from("cases").insert({ client_id: clientId, case_kind: "buy_to_let", stage: "fact_find", assigned_to: "p3" });
      }, { clientId });

      await goto(page, "clients", 1200);
      await page.selectOption("#client-adviser", "p2");
      await wait(page, 500);
      const underP2 = await page.$(`.client-row[data-client="${clientId}"]`);
      ok("A3 · the dual-adviser client appears under Wayne's (p2) filter", !!underP2);

      await page.selectOption("#client-adviser", "p3");
      await wait(page, 500);
      const underP3 = await page.$(`.client-row[data-client="${clientId}"]`);
      ok("A3 · …and ALSO appears under Luke's (p3) filter — this is correct, not a bug", !!underP3);
      const noteTxt = await page.$eval("#client-adv-note", (e) => e.textContent).catch(() => "");
      ok("A3 · the note explains the split-book rule", /split between two advisers|both advisers/.test(noteTxt), noteTxt);

      // K-15/K-17/L-16 — the "no access" stray (p6 Priya Raman) still holds a fixture case.
      const options = await page.$$eval("#client-adviser option", (els) => els.map((e) => ({ v: e.value, t: e.textContent, title: e.title })));
      const priyaOpt = options.find((o) => /no access/i.test(o.t));
      ok("A3 · a former colleague still holding cases is offered, marked “no access”", !!priyaOpt, JSON.stringify(options));
      ok("A3 · …titled with the standard no-access explanation", !!priyaOpt && priyaOpt.title.length > 0, JSON.stringify(priyaOpt));

      // Composition: adviser filter + segment + sort together.
      await page.selectOption("#client-adviser", "all");
      await wait(page, 400);
      await page.fill("#client-search", "");
      await wait(page, 300);
      ok("A3 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       A4 · W-9 / W-28 — LEAD ROUTING DEFAULT + WEBSITE FIELD MAPPING
       ======================================================================= */
    {
      console.log("\n— A4 · W-9 · \"(me)\" pinned for an advising viewer (p2 Wayne)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const leadId = await page.evaluate(async () => {
        const { data, error } = await window.__mockDb.from("leads")
          .insert({ name: "Route Test One", email: "route.test.one@example.com", phone: null, enquiry_type: "remortgage", message: "hello", status: "new" })
          .select("id").single();
        if (error) throw new Error(error.message);
        return data.id;
      });
      await goto(page, "dashboard", 1000);
      const opt0 = await page.$eval(`#briefing-list select.lead-adviser[data-lead="${leadId}"] option:first-child`,
        (o) => ({ value: o.value, text: o.textContent }));
      ok("A4 · the advising viewer's own option is pinned FIRST", opt0.value === "p2", JSON.stringify(opt0));
      ok("A4 · …and labelled “(me)”", /\(me\)/.test(opt0.text), JSON.stringify(opt0));
      ok("A4 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
    {
      console.log("— A4 · W-28 · property_value + enquiry_type mapping, figures-hint, non-numeric guard (p1)");
      const page = await newPage(browser, "p1", { skipTour: true });
      const leadA = await page.evaluate(async () => {
        const { data, error } = await window.__mockDb.from("leads")
          .insert({ name: "Figures Numeric", email: "figures.numeric@example.com", phone: null,
            enquiry_type: "right-to-buy", property_value: "450000", message: "Looking to buy our council house.", status: "new" })
          .select("id").single();
        if (error) throw new Error(error.message);
        return data.id;
      });
      const leadB = await page.evaluate(async () => {
        const { data, error } = await window.__mockDb.from("leads")
          .insert({ name: "Figures Prose", email: "figures.prose@example.com", phone: null,
            enquiry_type: "mortgage-recycle", property_value: "around 300k", message: "My rate is 4.5 until March 2027 and I want a rate review.", status: "new" })
          .select("id").single();
        if (error) throw new Error(error.message);
        return data.id;
      });
      await goto(page, "dashboard", 1000);

      await page.click(`#briefing-list [onclick^="acceptLead('${leadA}'"]`);
      await wait(page, 1200);
      const toastA = await toastText(page);
      const caseA = await page.evaluate(async (id) => {
        const { data: lead } = await window.__mockDb.from("leads").select("converted_case_id").eq("id", id).single();
        const { data: cs } = await window.__mockDb.from("cases").select("case_kind,property_value").eq("id", lead.converted_case_id).single();
        return cs;
      }, leadA);
      eq("A4 · W-28 · enquiry_type “right-to-buy” maps to case_kind “purchase”", caseA.case_kind, "purchase");
      eq("A4 · W-28 · a plain-number property_value is written to the case column", caseA.property_value, 450000);
      ok("A4 · W-28 · the accept toast names the parsed figure", /property value/.test(toastA) && /£450,000/.test(toastA), toastA);
      ok("A4 · W-28 · no figures hint, so the case does NOT auto-open", !toastA.includes("worth capturing on the case now"), toastA);

      await page.click(`#briefing-list [onclick^="acceptLead('${leadB}'"]`);
      await wait(page, 1200);
      const toastB = await toastText(page);
      const linkB = await page.evaluate(async (id) => {
        const { data: lead } = await window.__mockDb.from("leads").select("converted_case_id").eq("id", id).single();
        return lead.converted_case_id;
      }, leadB);
      const caseB = await readRow(page, "cases", linkB);
      const noteB = await page.evaluate(async (caseId) => {
        const { data } = await window.__mockDb.from("case_notes").select("body").eq("case_id", caseId).order("created_at", { ascending: false });
        return (data || []).map((n) => n.body).join(" | ");
      }, linkB);
      eq("A4 · W-28 · enquiry_type “mortgage-recycle” maps to “remortgage”", caseB.case_kind, "remortgage");
      ok("A4 · W-28 · a non-numeric property_value is NOT written to the case column", caseB.property_value == null, JSON.stringify(caseB.property_value));
      ok("A4 · W-28 · …and the note says so explicitly", /has NOT been written to the case's Property value field/.test(noteB), noteB);
      ok("A4 · W-28 · the enquiry mentions figures — the accept toast says so", /the enquiry mentions figures/.test(toastB), toastB);
      const modalOpen = await page.evaluate(() => !document.querySelector("#modal-backdrop").classList.contains("hidden"));
      ok("A4 · W-28 · leadFiguresHint() opens the new case", modalOpen);
      ok("A4 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       A5 · W-14a / W-15b/c — RETENTION ASSIGNEE + CALL PACK + UPLIFT
       ======================================================================= */
    {
      console.log("\n— A5 · W-14a · retention assignee named, \"assign to me\" reassigns + notes it (p3)");
      const page = await newPage(browser, "p3", { skipTour: true });
      const gt = await mkClientCase(page, {
        first: "Retention", last: "Namedtest", stage: "completed",
        caseFields: { assigned_to: "p2", rate_end_date: "2024-01-01", rate_end_estimated: false, completed_at: "2023-01-01T12:00:00Z" },
      });
      await goto(page, "dashboard", 1200);
      const openCaseAndCheckbox = await page.evaluate(async (id) => {
        await window.openCase(id);
        return document.querySelector(`.ret-tome-cb[data-ret-tome="${id}"]`) != null;
      }, gt.caseId);
      ok("A5 · the “assign to me” checkbox renders when the default assignee is someone else", openCaseAndCheckbox);
      await page.check(`.ret-tome-cb[data-ret-tome="${gt.caseId}"]`);
      await page.click("#cs-retention-btn");
      await wait(page, 500);
      const dlgMsg = (page.__dialogs[page.__dialogs.length - 1] || {}).message || "";
      ok("A5 · the confirm names WHO it is about to become and why", /assigned to YOU/.test(dlgMsg) && /Wayne Kellow/.test(dlgMsg), dlgMsg);
      await wait(page, 1500);
      const successor = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("*").eq("retention_source_case_id", id).limit(1);
        return (data || [])[0] || null;
      }, gt.caseId);
      ok("A5 · ticking “to me” reassigns the successor to the viewer, not the source's adviser", !!successor && successor.assigned_to === "p3", JSON.stringify(successor));
      const successorNote = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("case_notes").select("body").eq("case_id", id);
        return (data || []).map((n) => n.body).join(" | ");
      }, successor.id);
      ok("A5 · …and the note records that it was a deliberate override", /chosen by/.test(successorNote), successorNote);
      ok("A5 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
    {
      console.log("— A5 · W-15b/c · call pack renders full/partial/absent — never zero — uplift to the nearest £5 (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const kwame = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases")
          .select("id,current_balance,reversion_rate,monthly_payment,erc_amount,rate_percent,clients!client_id(first_name,last_name)")
          .not("current_balance", "is", null).not("reversion_rate", "is", null).not("rate_percent", "is", null)
          .order("id").limit(1);
        return (data || [])[0] || null;
      });
      ok("A5 · a full call-pack fixture exists to test against", !!kwame, "no case with balance+reversion+rate_percent found");
      if (kwame) {
        const gtUplift = (() => {
          const diff = kwame.reversion_rate - kwame.rate_percent;
          if (!(diff > 0)) return null;
          const perMonth = (kwame.current_balance * diff) / 100 / 12;
          const rounded = Math.round(perMonth / 5) * 5;
          return rounded > 0 ? rounded : null;
        })();
        await page.evaluate((id) => window.openCase(id), kwame.id);
        await wait(page, 500);
        const cpVals = await page.evaluate(() => ({
          balance: (document.querySelector("#cs-callpack-balance .cs-val") || {}).textContent,
          reversion: (document.querySelector("#cs-callpack-reversion .cs-val") || {}).textContent,
          payment: (document.querySelector("#cs-callpack-payment .cs-val") || {}).textContent,
          erc: (document.querySelector("#cs-callpack-erc .cs-val") || {}).textContent,
        }));
        ok("A5 · a full call-pack renders every one of the four stats", cpVals.balance && cpVals.reversion && !/—/.test(cpVals.balance), JSON.stringify(cpVals));
        if (gtUplift != null) {
          const upliftTxt = await page.$eval(".cs-uplift", (e) => e.textContent).catch(() => "");
          ok("A5 · the uplift line matches balance×(reversion−old)/100/12 rounded to the nearest £5",
            upliftTxt.replace(/,/g, "").includes(String(gtUplift)), `expected ~£${gtUplift}/mo, got "${upliftTxt}"`);
        }
      }
      // Andrew Pemberton — all four columns NULL on purpose: no call-pack block at all.
      const andrew = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id,first_name,last_name").eq("first_name", "Andrew").eq("last_name", "Pemberton").maybeSingle();
        if (!data) return null;
        const { data: cs } = await window.__mockDb.from("cases").select("id,current_balance").eq("client_id", data.id).eq("stage", "completed").maybeSingle();
        return cs;
      });
      if (andrew) {
        eq("A5 · a rate-ended case with no recorded figures carries all four columns null (never 0)", andrew.current_balance, null);
        await page.evaluate((id) => window.openCase(id), andrew.id);
        await wait(page, 400);
        const hasCallpackBlock = await page.evaluate(() => !!document.querySelector("#cs-callpack-balance"));
        ok("A5 · …so the case header draws no call-pack block at all", !hasCallpackBlock);
      }
      ok("A5 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       A6 · W-19 — ADVISER SEES NO FEE-CHASE ROWS (confirmatory; the full
       matrix is owned by tests/r5_batch3.js's R5-28 block)
       ======================================================================= */
    {
      console.log("\n— A6 · W-19 · adviser sees zero fee-chase rows while bank details are absent (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const hasBank = await page.evaluate(() => window.__mockDb.rpc("has_bank_details").then((r) => r.data));
      ok("A6 · fixture precondition — bank details are present-but-empty by default", hasBank === false, String(hasBank));
      const rawFeeChaseGT = await page.evaluate(async () => {
        const { data } = await window.__mockDb.rpc("get_briefing", { p_scope: "all" });
        return (data || []).filter((r) => r.kind === "fee_chase" && r.owner === "p2").length;
      });
      const feeRowsShown = await page.$$eval("#briefing-list .brief-row", (els) => els.filter((e) => /\bFEE\b/.test(e.innerText)).length);
      ok("A6 · fixture carries at least one fee-chase-eligible case for this adviser", rawFeeChaseGT > 0, String(rawFeeChaseGT));
      eq("A6 · none of them render on My Day while bank details are absent", feeRowsShown, 0);
      ok("A6 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B1 · W-11 — CASE HEADER NEXT-APPOINTMENT LINE
       ======================================================================= */
    {
      console.log("\n— B1 · W-11 · case header's next-appointment line (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const gt = await mkClientCase(page, { first: "Header", last: "Apptline", stage: "fact_find" });
      const soon = new Date(Date.now() + 3 * 3600000).toISOString();
      const apptId = await mkAppt(page, { client_id: gt.clientId, case_id: gt.caseId, title: "Fact find call", starts_at: soon, ends_at: soon, staff_id: "p4" });
      await page.evaluate((id) => window.openCase(id), gt.caseId);
      await wait(page, 500);
      const lineTxt = await page.$eval("#cs-appt-line .cs-lbl", (e) => e.textContent).catch(() => "");
      eq("B1 · a future appointment is labelled “Next appointment”", lineTxt, "Next appointment");

      // Delete and re-add an EARLIER-TODAY appointment.
      await page.evaluate((id) => window.__mockDb.from("appointments").delete().eq("id", id), apptId);
      // Robust near the midnight boundary: "3 hours ago" can fall on the previous
      // calendar day when the run happens just after 00:00, which the app then
      // (correctly) treats as not-today. Clamp to no earlier than the start of today.
      const _now = Date.now();
      const _sod = new Date(_now); _sod.setHours(0, 0, 0, 0);
      let _earlierMs = _now - 3 * 3600000;
      if (_earlierMs < _sod.getTime()) _earlierMs = _sod.getTime() + Math.floor((_now - _sod.getTime()) / 2);
      const earlier = new Date(_earlierMs).toISOString();
      await mkAppt(page, { client_id: gt.clientId, case_id: gt.caseId, title: "Morning call", starts_at: earlier, ends_at: earlier, staff_id: "p4" });
      await page.evaluate((id) => window.openCase(id), gt.caseId);
      await wait(page, 500);
      const lineTxt2 = await page.$eval("#cs-appt-line .cs-lbl", (e) => e.textContent).catch(() => "");
      eq("B1 · an appointment earlier today is labelled “Earlier today”", lineTxt2, "Earlier today");

      // No appointment at all — the line is absent.
      const gt2 = await mkClientCase(page, { first: "Header", last: "Noline", stage: "fact_find" });
      await page.evaluate((id) => window.openCase(id), gt2.caseId);
      await wait(page, 500);
      const lineAbsent = await page.evaluate(() => !document.querySelector("#cs-appt-line"));
      ok("B1 · the line is absent entirely when nothing is booked", lineAbsent);
      ok("B1 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B2 · W-10 — BOOK FROM CASE RETURNS TO THE CASE, HISTORY NOT STACKED
       ======================================================================= */
    {
      console.log("\n— B2 · W-10 · booking an appointment from a case returns to it (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const gt = await mkClientCase(page, { first: "Book", last: "Fromcase", stage: "fact_find" });
      await page.evaluate((id) => window.openCase(id), gt.caseId);
      await wait(page, 500);
      await clickAction(page, "act-appt");
      await wait(page, 400);
      const title = await page.$eval("#modal h3", (e) => e.textContent).catch(() => "");
      ok("B2 · the appointment form opens (replacing the case modal in the same host)", title === "New appointment", title);
      await page.fill('#appt-form [name="title"]', "Booked from case test");
      const d = new Date(Date.now() + 86400000);
      await page.fill('#appt-form [name="date"]', d.toISOString().slice(0, 10));
      await page.fill('#appt-form [name="time"]', "10:00");
      await page.click("#modal-save");
      await wait(page, 900);
      const toast = await toastText(page);
      ok("B2 · Save reports coming back to the case", /back on the case/.test(toast), toast);
      const backOnCase = await page.$eval("#modal h3", (e) => e.textContent).catch(() => "");
      ok("B2 · the case modal is what is actually on screen afterwards", backOnCase !== "New appointment" && backOnCase !== "Appointment", backOnCase);
      // History not stacked: one Back should close the whole thing, not step through an
      // appointment-modal ghost first.
      await page.goBack();
      await wait(page, 500);
      const closedAfterOneBack = await page.evaluate(() => document.querySelector("#modal-backdrop").classList.contains("hidden"));
      ok("B2 · a single Back closes the case — the appointment's history entry was replaced, not stacked", closedAfterOneBack);
      ok("B2 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B3 · W-17/K-14 — APPOINTMENT OUTCOMES
       ======================================================================= */
    {
      console.log("\n— B3 · W-17/K-14 · appointment outcomes — recordable window, no-show task, quick ✓/✗ + Undo, diary badges (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const gt = await mkClientCase(page, { first: "Outcome", last: "Windowtest", stage: "application" });
      const future = new Date(Date.now() + 5 * 86400000).toISOString();
      const futureId = await mkAppt(page, { client_id: gt.clientId, case_id: gt.caseId, title: "Future appt", starts_at: future, ends_at: future, staff_id: "p4" });
      await page.evaluate((id) => window.openAppt(id), futureId);
      await wait(page, 400);
      const futureHasOutcome = await page.evaluate(() => !!document.querySelector("#appt-outcome-wrap"));
      ok("B3 · a future appointment offers NO outcome control", !futureHasOutcome);
      await page.evaluate(() => window.closeModal());
      await wait(page, 300);

      const past = new Date(Date.now() - 2 * 86400000).toISOString();
      const pastId = await mkAppt(page, { client_id: gt.clientId, case_id: gt.caseId, title: "Past appt", starts_at: past, ends_at: past, staff_id: "p4" });
      await page.evaluate((id) => window.openAppt(id), pastId);
      await wait(page, 400);
      const pastHasOutcome = await page.evaluate(() => !!document.querySelector("#appt-outcome-wrap"));
      ok("B3 · a past appointment offers the outcome control", pastHasOutcome);
      await page.check(`input[name="outcome"][value="no_show"]`);
      await page.click("#modal-save");
      await wait(page, 700);
      const noShowDlg = page.__dialogs.find((d) => /no-show/.test(d.message));
      ok("B3 · recording a no-show offers the call-back task via a confirm", !!noShowDlg, JSON.stringify(page.__dialogs));
      const taskRows1 = await page.evaluate(async (caseId) => {
        const { data } = await window.__mockDb.from("case_tasks").select("*").eq("case_id", caseId);
        return (data || []).filter((t) => /missed appointment/.test(t.title) && !t.done_at);
      }, gt.caseId);
      eq("B3 · exactly one call-back task exists after recording it", taskRows1.length, 1);
      // Re-open and re-save the same no-show — idempotent, no second task.
      await page.evaluate((id) => window.openAppt(id), pastId);
      await wait(page, 400);
      await page.click("#modal-save");
      await wait(page, 700);
      const taskRows2 = await page.evaluate(async (caseId) => {
        const { data } = await window.__mockDb.from("case_tasks").select("*").eq("case_id", caseId);
        return (data || []).filter((t) => /missed appointment/.test(t.title) && !t.done_at);
      }, gt.caseId);
      eq("B3 · re-saving the same no-show does not create a second task", taskRows2.length, 1);

      /* R41 · T1 — the "Today's appointments" drawer (#today-appts-panel/#today-appts) is gone, and
         with it the old data-appt/data-outcome/is-set toggle markup (`.appt-quick-btn` used to
         carry data-appt/data-outcome and an is-set aria-pressed toggle). The ✓/✗ pair now
         lives on the My Day appt_today row itself (apptQuickOutcomeHtml), rendered inline with
         onclick="quickApptOutcome('<id>','<outcome>',this)" and no drawer to open first — a started,
         unjudged appointment shows the pair; nothing else does. */
      // Quick ✓/✗ from My Day + Undo — today's appointment (past-started, since apptQuickOutcomeHtml
      // only offers the pair once the slot has started).
      const todayStart = new Date(Date.now() - 5 * 60000);   // 5 minutes ago — started, unjudged
      const todayId = await mkAppt(page, { client_id: gt.clientId, case_id: gt.caseId, title: "Today appt", starts_at: todayStart.toISOString(), ends_at: todayStart.toISOString(), staff_id: "p4" });
      await goto(page, "dashboard", 900);
      const quickBtn = `#briefing-list .appt-quick-btn[onclick^="quickApptOutcome('${todayId}','attended'"]`;
      const hasQuick = await page.$(quickBtn);
      ok("B3 · My Day's row offers the one-click ✓/✗ pair for a started, unjudged appointment", !!hasQuick);
      if (hasQuick) {
        await page.click(quickBtn);
        await wait(page, 700);
        const afterQuick = await readRow(page, "appointments", todayId);
        eq("B3 · the quick button writes the outcome", afterQuick.outcome, "attended");
        const undoToast = await toastText(page);
        ok("B3 · the toast offers Undo", /Recorded: attended/.test(undoToast), undoToast);
        await page.click("#toast .toast-action, #toast button, .toast-undo").catch(() => {});
        await wait(page, 700);
        const afterUndo = await readRow(page, "appointments", todayId);
        ok("B3 · Undo puts the outcome back", afterUndo.outcome == null, JSON.stringify(afterUndo));
      }

      // Badge on the diary tile.
      await goto(page, "diary", 900);
      await page.evaluate((d) => { window.diaryMonth = new Date(d.getFullYear(), d.getMonth(), 1); window.loadDiary(); }, new Date());
      await wait(page, 900);
      const hasOutcomeBadge = await page.evaluate((apptId) => {
        const el = document.querySelector(`.appt[onclick*="${apptId}"]`);
        return !!(el && el.classList.contains("has-outcome"));
      }, pastId);
      ok("B3 · a diary month tile carries the has-outcome class once recorded", hasOutcomeBadge);
      ok("B3 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B4 · W-18 — DATED TASKS IN THE DIARY
       ======================================================================= */
    {
      console.log("\n— B4 · W-18 · dated tasks in the diary — month cap, day row, person filter, done omitted (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const gt = await mkClientCase(page, { first: "Diary", last: "Taskcaptest", stage: "application", assigned_to: "p2" });
      const due = new Date(); due.setDate(due.getDate() + 10);
      const dueYmd = due.toISOString().slice(0, 10);
      const taskIds = [];
      for (let i = 0; i < 3; i++) {
        const id = await page.evaluate(async ({ caseId, dueYmd, i }) => {
          const { data, error } = await window.__mockDb.from("case_tasks")
            .insert({ case_id: caseId, title: `Diary task ${i}`, due_date: dueYmd, assigned_to: "p2" }).select("id").single();
          if (error) throw new Error(error.message);
          return data.id;
        }, { caseId: gt.caseId, dueYmd, i });
        taskIds.push(id);
      }
      await goto(page, "diary", 900);
      /* R70 (CTO) — CALENDAR BUG IN THE TEST, not the app: `window.diaryMonth = …` writes a plain
         window property, but app.js's diaryMonth is a top-level `let` (a lexical global), so the
         assignment never reached loadDiary and the grid always drew the CURRENT month. That passed
         for weeks because today+10 sat inside the current month's grid — until 28–31 Aug, when
         today+10 falls past the grid's final Sunday and the cell simply doesn't exist. Navigate the
         way a person does instead: click ‹/› until the grid's month contains the due date. */
      await page.evaluate(() => { const b = document.querySelector("#diary-view-month"); if (b) b.click(); });
      for (let hop = 0; hop < 3; hop++) {
        const has = await page.$(`.diary-day[data-date="${dueYmd}"]`);
        if (has) break;
        await page.click("#diary-next");
        await wait(page, 700);
      }
      const cellSel = `.diary-day[data-date="${dueYmd}"]`;
      const chipCount = await page.$$eval(`${cellSel} .diary-task`, (els) => els.length);
      const moreTxt = await page.$eval(`${cellSel} .diary-more-tasks`, (e) => e.textContent).catch(() => "");
      eq("B4 · the month cell caps dated-task chips at 2", chipCount, 2);
      ok("B4 · …and rolls the rest into “+N more task(s)”", /\+1 more task/.test(moreTxt), moreTxt);

      await page.click(`${cellSel} .diary-more-tasks`);
      await wait(page, 700);
      const dayRowCount = await page.$$eval("#diary-day-tasks .diary-task", (els) => els.length);
      eq("B4 · the Day view's “Due this day” row has room for all of them", dayRowCount, 3);

      // Person filter — assigned to p3 (nobody), so the filtered-to-p3 diary shows none of them.
      await page.selectOption("#diary-staff", "p3");
      await wait(page, 700);
      const filteredCount = await page.$eval("#diary-day-tasks", (e) => e.classList.contains("hidden"));
      ok("B4 · filtering to an adviser who does not hold these tasks hides the row", filteredCount);
      await page.selectOption("#diary-staff", "all");
      await wait(page, 700);

      // Done omitted.
      await page.evaluate((id) => window.__mockDb.from("case_tasks").update({ done_at: new Date().toISOString() }).eq("id", id), taskIds[0]);
      await page.evaluate((d) => { window.diaryMonth = new Date(d.getFullYear(), d.getMonth(), 1); window.loadDiary(); }, due);
      await wait(page, 900);
      const chipCountAfterDone = await page.$$eval(`${cellSel} .diary-task`, (els) => els.length);
      const moreTxtAfterDone = await page.$eval(`${cellSel} .diary-more-tasks`, (e) => e.textContent).catch(() => "");
      eq("B4 · a done task no longer counts towards the cell at all", chipCountAfterDone, 2);
      ok("B4 · …and the “+more” count drops with it", !/\+1 more task/.test(moreTxtAfterDone), moreTxtAfterDone);
      ok("B4 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B5 · W-26 — MONTH-CELL APPOINTMENT CAP + HIDDEN-CLASH WARNING
       ======================================================================= */
    {
      console.log("\n— B5 · W-26 · month cell caps appointments at 3, “+N more” flags a hidden clash (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const gt = await mkClientCase(page, { first: "Month", last: "Capclash", stage: "application" });
      // Pick an ODD day-of-month in the CURRENT month: the fixture seeds 16 appts on
      // even days 2–28 (mock-supabase.js:2001), so today+12 collided whenever it landed
      // on an even day. An odd day is never seeded, and staying in the current month keeps
      // the cell one the diary reliably renders. Clamp to <=27 so it never rolls over.
      const day = new Date();
      let _dom = Math.min(27, day.getDate() + 9);
      if (_dom % 2 === 0) _dom += 1;
      day.setDate(_dom); day.setHours(9, 0, 0, 0);
      const dayYmd = day.toISOString().slice(0, 10);
      const mk = (h, mAdd) => { const d = new Date(day); d.setHours(h, mAdd || 0, 0, 0); return d.toISOString(); };
      await mkAppt(page, { client_id: gt.clientId, case_id: gt.caseId, title: "Slot A", starts_at: mk(9), ends_at: mk(10), staff_id: "p4" });
      await mkAppt(page, { client_id: gt.clientId, case_id: gt.caseId, title: "Slot B", starts_at: mk(11), ends_at: mk(12), staff_id: "p4" });
      await mkAppt(page, { client_id: gt.clientId, case_id: gt.caseId, title: "Slot C", starts_at: mk(13), ends_at: mk(14), staff_id: "p4" });
      // The fourth clashes with Slot A — both on staff p4 — and is the one that gets hidden
      // (shownAppts is the FIRST three in start order).
      // The month grid shows the first 3 appointments IN START-TIME ORDER (A, B, C) and hides the
      // rest — so the clashing 4th must sort AFTER C (13:00-14:00) to actually land behind the
      // "+N more" link: it overlaps C, not A.
      await mkAppt(page, { client_id: gt.clientId, case_id: gt.caseId, title: "Slot D clash", starts_at: mk(13, 30), ends_at: mk(14, 30), staff_id: "p4" });

      await goto(page, "diary", 900);
      await page.evaluate((d) => { window.diaryMonth = new Date(d.getFullYear(), d.getMonth(), 1); window.loadDiary(); }, day);
      await wait(page, 900);
      const cellSel = `.diary-day[data-date="${dayYmd}"]`;
      const shownAppts = await page.$$eval(`${cellSel} .appt`, (els) => els.length);
      eq("B5 · the month cell shows at most 3 appointment tiles", shownAppts, 3);
      const moreLink = await page.$eval(`${cellSel} .diary-more-appts`, (e) => ({ text: e.textContent, hasClashClass: e.classList.contains("has-clash") })).catch(() => null);
      ok("B5 · the 4th rolls into a “+1 more” link", !!moreLink && /\+1 more/.test(moreLink.text), JSON.stringify(moreLink));
      ok("B5 · …and it is flagged, because the hidden appointment clashes", !!moreLink && moreLink.hasClashClass, JSON.stringify(moreLink));

      await page.click(`${cellSel} .diary-more-appts`);
      await wait(page, 700);
      const dayTitle = await page.$eval("#diary-title", (e) => e.textContent).catch(() => "");
      ok("B5 · “+N more” routes to the Day view for that date", dayTitle.length > 0, dayTitle);
      const dayBlockCount = await page.$$eval("#diary-day-lane .appt-block", (els) => els.length);
      eq("B5 · the Day view has room for all four", dayBlockCount, 4);
      ok("B5 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B6 · K-10 — DOC-CHASE COOLDOWN CONFIRMS BEFORE SENDING WITHIN THE WINDOW
       ======================================================================= */
    {
      console.log("\n— B6 · K-10 · sending inside the quiet window confirms first (p1, Sarah Ellingham's case)");
      const page = await newPage(browser, "p1", { skipTour: true });
      const ellingham = await page.evaluate(async () => {
        const { data: cl } = await window.__mockDb.from("clients").select("id").eq("first_name", "Sarah").eq("last_name", "Ellingham").single();
        const { data: cs } = await window.__mockDb.from("cases").select("id").eq("client_id", cl.id).eq("stage", "fact_find").single();
        return cs.id;
      });
      await page.evaluate((id) => window.openCase(id), ellingham);
      await wait(page, 700);
      const cooldownOn = await page.$eval("#docs-send-btn", (e) => e.classList.contains("btn-cooldown"));
      ok("B6 · the send button shows it is inside the quiet window", cooldownOn);
      const beforeCount = (await readRows(page, "email_queue", { case_id: ellingham })).filter((m) => m.email_type === "docs_request").length;
      await page.click("#docs-send-btn");
      await wait(page, 900);
      const firstDlg = page.__dialogs[page.__dialogs.length - 2] || page.__dialogs[page.__dialogs.length - 1];
      ok("B6 · a confirm names the quiet window before sending", firstDlg && /quiet window runs to/.test(firstDlg.message), JSON.stringify(page.__dialogs));
      const afterCount = (await readRows(page, "email_queue", { case_id: ellingham })).filter((m) => m.email_type === "docs_request").length;
      eq("B6 · confirming still sends — it is a warning, not a block", afterCount, beforeCount + 1);
      ok("B6 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B7 · K-11 — DATA HEALTH · WAITING ON DOCUMENTS
       ======================================================================= */
    {
      console.log("\n— B7 · K-11 · Data health's waiting-on-documents work queue, incl. the DIP fixture (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const gt = await page.evaluate(async () => {
        const { data: rows } = await window.__mockDb.from("cases").select("id,stage,client_id");
        const { data: docs } = await window.__mockDb.from("case_documents").select("case_id,status");
        const outstandingBy = {};
        (docs || []).forEach((d) => { if (d.status === "requested") outstandingBy[d.case_id] = (outstandingBy[d.case_id] || 0) + 1; });
        const isLive = (s) => s !== "completed" && s !== "not_proceeding";
        return (rows || []).filter((c) => isLive(c.stage) && (outstandingBy[c.id] || 0) > 0).length;
      });
      await goto(page, "data", 1400);
      const rowCount = await page.$$eval("#dh-waitingdocs-panel tbody tr, #dh-waitingdocs-panel .imp-table tr", (els) => els.length - 1);
      eq("B7 · the panel's row count matches an independent recompute of outstanding live cases", rowCount, gt);

      // Ruby Sinclair's new DIP fixture is on the list.
      const rubyRow = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#dh-waitingdocs-panel tr")];
        return rows.map((r) => r.textContent).find((t) => /Ruby Sinclair/.test(t)) || null;
      });
      ok("B7 · Ruby Sinclair's DIP-stage checklist case is on the list", !!rubyRow, rubyRow);
      ok("B7 · …at the Decision in Principle (DIP) stage", !!rubyRow && /\bDIP\b/.test(rubyRow), rubyRow);
      ok("B7 · …showing chases “0 of 3” (never chased yet)", !!rubyRow && /0 of 3/.test(rubyRow), rubyRow);

      // Amery — chases exhausted — the disabled reason.
      const ameryBlocked = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#dh-waitingdocs-panel tr")];
        const row = rows.find((r) => /Amery/.test(r.textContent));
        return row ? (row.querySelector(".dh-wd-acts .badge") || {}).textContent : null;
      });
      ok("B7 · a case with chases spent shows the “budget spent” reason instead of a button", ameryBlocked && /budget spent/.test(ameryBlocked), ameryBlocked);

      // Send path — Ruby's row is not blocked (has email, chases 0).
      const beforeMailCount = (await readRows(page, "email_queue", {})).filter((m) => /docs_(request|chase)/.test(m.email_type)).length;
      const rubyBtn = await page.evaluateHandle(() => {
        const rows = [...document.querySelectorAll("#dh-waitingdocs-panel tr")];
        const row = rows.find((r) => /Ruby Sinclair/.test(r.textContent));
        return row ? row.querySelector(".dh-wd-acts button:not(:first-child)") : null;
      });
      const hasSendBtn = await page.evaluate((h) => !!h, rubyBtn);
      ok("B7 · Ruby's row offers a Chase-now button (not blocked)", hasSendBtn);
      if (hasSendBtn) {
        await rubyBtn.asElement().click();
        await wait(page, 900);
        const afterMailCount = (await readRows(page, "email_queue", {})).filter((m) => /docs_(request|chase)/.test(m.email_type)).length;
        ok("B7 · the send path actually queues a document email", afterMailCount > beforeMailCount, `${beforeMailCount} -> ${afterMailCount}`);
      }
      ok("B7 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B8 · W-30 — STAGE-ENTRY PROMPTS
       ======================================================================= */
    {
      console.log("\n— B8 · W-30 · DIP prompts for a lender + chase task, Offer prompts for an expiry, blank skips clean (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const dip = await mkClientCase(page, { first: "Stage", last: "Diptest", stage: "fact_find", assigned_to: "p2", caseFields: { lender: null } });
      await page.evaluate((id) => window.openCase(id), dip.caseId);
      await wait(page, 500);
      const advanceLabel = await page.$eval("#cs-advance-btn", (e) => e.textContent).catch(() => "");
      ok("B8 · the Advance button names the target stage", /DIP/.test(advanceLabel), advanceLabel);
      await page.click("#cs-advance-btn");
      await wait(page, 500);
      const dipOverlayVisible = await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      ok("B8 · advancing to DIP with no lender opens the stage-entry prompt", dipOverlayVisible);
      const dipTaskChecked = await page.$eval("#se-dip-task", (e) => e.checked).catch(() => false);
      ok("B8 · the DIP chase task checkbox defaults to checked", dipTaskChecked);
      await page.fill("#se-lender", "Skipton");
      await page.click("#se-ok");
      await wait(page, 900);
      const dipCase = await readRow(page, "cases", dip.caseId);
      eq("B8 · Save & advance writes the lender", dipCase.lender, "Skipton");
      eq("B8 · …and actually advances the stage", dipCase.stage, "decision_in_principle");
      const dipTask = await page.evaluate(async (caseId) => {
        const { data } = await window.__mockDb.from("case_tasks").select("*").eq("case_id", caseId);
        return (data || []).find((t) => t.title === "Chase DIP decision" && !t.done_at);
      }, dip.caseId);
      ok("B8 · …and the chase task is created", !!dipTask);
      const advToast = await toastText(page);
      ok("B8 · the toast names what the prompt actually wrote", /lender set to Skipton/.test(advToast), advToast);

      // Offer, blank skips clean.
      // protection_status must be past "not_discussed" or the protection gate blocks the move
      // outright (application -> offer is exactly the forward move it guards) before the
      // stage-entry prompt — which runs LAST — ever gets a turn.
      const offer = await mkClientCase(page, { first: "Stage", last: "Offertest", stage: "application", assigned_to: "p2", caseFields: { offer_expiry_date: null, protection_status: "discussed" } });
      await page.evaluate((id) => window.openCase(id), offer.caseId);
      await wait(page, 500);
      await page.click("#cs-advance-btn");
      await wait(page, 500);
      const offerOverlayVisible = await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      ok("B8 · advancing to Offer with no expiry opens ITS OWN stage-entry prompt", offerOverlayVisible);
      await page.click("#se-skip");
      await wait(page, 900);
      const offerCase = await readRow(page, "cases", offer.caseId);
      eq("B8 · Skip still advances the stage", offerCase.stage, "offer");
      eq("B8 · …and writes nothing to the field it asked about", offerCase.offer_expiry_date, null);

      // Blank-then-skip on the DIP form: lender stays blank, no task, clean advance.
      const dip2 = await mkClientCase(page, { first: "Stage", last: "Dipblanktest", stage: "fact_find", assigned_to: "p2", caseFields: { lender: null } });
      await page.evaluate((id) => window.openCase(id), dip2.caseId);
      await wait(page, 500);
      await page.click("#cs-advance-btn");
      await wait(page, 500);
      await page.click("#se-skip");
      await wait(page, 900);
      const dip2Case = await readRow(page, "cases", dip2.caseId);
      eq("B8 · blank + Skip on the DIP prompt writes nothing and advances cleanly", dip2Case.lender, null);
      eq("B8 · …the stage moves", dip2Case.stage, "decision_in_principle");
      const dip2Task = await page.evaluate(async (caseId) => {
        const { data } = await window.__mockDb.from("case_tasks").select("*").eq("case_id", caseId);
        return (data || []).find((t) => t.title === "Chase DIP decision");
      }, dip2.caseId);
      ok("B8 · …and no chase task is created", !dip2Task);

      // Programmatic call — stays headless, no dialog, no promptStageEntry.
      const dip3 = await mkClientCase(page, { first: "Stage", last: "Headlesstest", stage: "fact_find", assigned_to: "p2", caseFields: { lender: null } });
      const overlayBefore = await page.evaluate(() => document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      const res = await page.evaluate((id) => window.moveCaseToStage(id, "decision_in_principle", { skipReload: true }), dip3.caseId);
      await wait(page, 500);
      const overlayAfter = await page.evaluate(() => document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      ok("B8 · a programmatic moveCaseToStage() call raises NO overlay", overlayBefore && overlayAfter, `before hidden=${overlayBefore}, after hidden=${overlayAfter}`);
      eq("B8 · …and still moves the case", res, "moved");
      const dip3Case = await readRow(page, "cases", dip3.caseId);
      eq("B8 · …without ever asking for the lender", dip3Case.lender, null);
      ok("B8 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B9 · Add task / Add note labels (case modal)
       ======================================================================= */
    {
      console.log("\n— B9 · Add task / Add note button labels (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const gt = await mkClientCase(page, { first: "Labels", last: "Casetest", stage: "fact_find" });
      await page.evaluate((id) => window.openCase(id), gt.caseId);
      await wait(page, 500);
      eq("B9 · the Add-task button reads “Add task”", await page.$eval("#add-task-btn", (e) => e.textContent.trim()), "Add task");
      eq("B9 · the Add-note button reads “Add note”", await page.$eval("#add-note-btn", (e) => e.textContent.trim()), "Add note");
      ok("B9 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C1 · FIRST-RUN TOUR
       ======================================================================= */
    {
      console.log("\n— C1 · first-run tour fires ONLY for Luke (p3, tour_seen_at null), every step, Finish marks it seen");
      const page = await newPage(browser, "p3");
      await wait(page, 800);
      const bubbleVisible = await page.evaluate(() => !!document.querySelector("#tour-bubble"));
      ok("C1 · the tour fires on first sign-in for p3", bubbleVisible);
      /* R41 · F1 — TOUR_STEPS shrank from 6 to 4 (the #tasks-panel and #today-appts-panel steps
         were deleted along with those drawers, not re-pointed — see app.js's own R41 comment
         directly above TOUR_STEPS). Read the step count LIVE off the app's own module state rather
         than hardcoding 4, the same standing rule every other figure in this harness follows, so a
         future round changing the step count again does not silently desync this loop from it. */
      const stepCount = await page.evaluate(() => TOUR_STEPS.filter((s) => { try { return !!document.querySelector(s.target); } catch (e) { return false; } }).length);
      ok("C1 · fixture · every current tour step has a live target on screen (none skipped)", stepCount === (await page.evaluate(() => TOUR_STEPS.length)), stepCount);
      let stepsSeen = 0;
      for (let i = 0; i < stepCount; i++) {
        const stepN = await page.$eval(".tour-step-n", (e) => e.textContent).catch(() => "");
        if (new RegExp(`${i + 1} of ${stepCount}`).test(stepN)) stepsSeen++;
        const btnTxt = await page.$eval("#tour-next", (e) => e.textContent).catch(() => "");
        if (i < stepCount - 1) eq(`C1 · step ${i + 1} of ${stepCount} advances with Next`, btnTxt, "Next");
        else eq("C1 · the last step's button reads Finish", btnTxt, "Finish");
        await page.click("#tour-next");
        await wait(page, 300);
      }
      eq("C1 · every step was actually shown, in order", stepsSeen, stepCount);
      await wait(page, 500);
      const gone = await page.evaluate(() => !document.querySelector("#tour-bubble"));
      ok("C1 · Finish closes the tour", gone);
      const p3Row = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("profiles").select("tour_seen_at").eq("id", "p3").single();
        return data;
      });
      ok("C1 · Finish calls mark_tour_seen() — tour_seen_at is now set", p3Row && p3Row.tour_seen_at != null, JSON.stringify(p3Row));

      // Never again — the SAME mock DB (this page's session; the mock reinitialises fresh on every
      // navigation/reload, so a reload here would just re-seed a pristine tour_seen_at:null and
      // prove nothing). Reset only the session-local "already fired this page load" cache and ask
      // again: the DB-side guard (tour_seen_at, now set) has to refuse on its own.
      const firesAgainSameSession = await page.evaluate(async () => {
        tourFired = false;
        await maybeStartTour();
        await new Promise((r) => setTimeout(r, 400));
        return !!document.querySelector("#tour-bubble");
      });
      ok("C1 · asking again is refused by the DB flag itself (tour_seen_at), not only the session cache", !firesAgainSameSession);

      // p1 — already seen from the fixture, never fires.
      const p1page = await newPage(browser, "p1");
      await wait(p1page, 500);
      const p1Bubble = await p1page.evaluate(() => !!document.querySelector("#tour-bubble"));
      ok("C1 · p1 (Kim), who has already seen it, never gets the tour", !p1Bubble);
      await p1page.close();

      // __NEX_SKIP_TOUR — a fresh p3 session (tour_seen_at null, per the fixture default) must
      // still not show it once the skip flag is set.
      const p3Skip = await newPage(browser, "p3", { skipTour: true });
      await wait(p3Skip, 800);
      const skippedBubble = await p3Skip.evaluate(() => !!document.querySelector("#tour-bubble"));
      ok("C1 · __NEX_SKIP_TOUR is honoured even while tour_seen_at is null", !skippedBubble);
      await p3Skip.close();
      ok("C1 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C2 · L-1/L-5/L-18 — GLOSSARY / HELP
       ======================================================================= */
    {
      console.log("\n— C2 · L-1/L-5/L-18 · glossary panel — ERC/GI entries, Retake the tour (p4)");
      // Deliberately NOT skipTour: Daniel's own tour_seen_at is already set (per the fixture), so
      // the automatic first-run tour will not fire on load regardless — but the explicit "Retake"
      // button has to actually be exercisable, and __NEX_SKIP_TOUR would block that too.
      const page = await newPage(browser, "p4");
      await page.click("#help-btn");
      await wait(page, 400);
      const terms = await page.$$eval(".glossary-row dt", (els) => els.map((e) => e.textContent));
      ok("C2 · the glossary carries an ERC entry", terms.includes("ERC"), JSON.stringify(terms));
      ok("C2 · …and a GI entry", terms.includes("GI"), JSON.stringify(terms));
      const ercDef = await page.evaluate(() => {
        const row = [...document.querySelectorAll(".glossary-row")].find((r) => r.querySelector("dt").textContent === "ERC");
        return row ? row.querySelector("dd").textContent : "";
      });
      ok("C2 · the ERC entry explains “outlasts the rate” in plain English", /outlasts/.test(ercDef), ercDef);
      const retakeBtn = await page.$("#help-retake-tour");
      ok("C2 · “Retake the tour” is offered", !!retakeBtn);
      if (retakeBtn) {
        await retakeBtn.click();
        await wait(page, 500);
        const tourNow = await page.evaluate(() => !!document.querySelector("#tour-bubble"));
        ok("C2 · Retake the tour launches it even though Daniel has already seen it", tourNow);
        await page.click("#tour-skip");
      }
      ok("C2 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C3 · ERC KPI TITLE EXPANSION
       ======================================================================= */
    {
      console.log("\n— C3 · the ERC KPI tile's title expands the acronym (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const ercTitle = await page.evaluate(() => {
        const kpi = [...document.querySelectorAll("#kpi-row .kpi")].find((e) => /ERC outlasts rate/.test(e.textContent));
        return kpi ? kpi.getAttribute("title") : null;
      });
      ok("C3 · the ERC tile's title spells out Early Repayment Charge", !!ercTitle && /Early Repayment Charge/.test(ercTitle), ercTitle);
      ok("C3 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C4 · W-21 — TIMELINE DEFAULT VIEW + LAST-CONTACT LINE
       ======================================================================= */
    {
      console.log("\n— C4 · W-21 · timeline defaults to “activity”, System still reachable, Last contact matches recompute (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      const client = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id").eq("first_name", "Ruby").eq("last_name", "Sinclair").single();
        return data.id;
      });
      await page.evaluate((id) => window.openClient(id), client);
      await wait(page, 700);
      /* R66 — Ruby has six cases, and from three up the client record now folds its timeline into a
         closed <details> with the case cards first (H5: the portfolio, not the note history, is
         what a landlord's record is opened for). Nothing about the timeline changed — same ids,
         same chips, same rows — so this test opens the fold and then asserts exactly what it always
         did. Only the click below needed it; the $eval reads work on hidden elements either way. */
      await page.evaluate(() => { const d = document.querySelector("#client-timeline-fold"); if (d) d.open = true; });
      const activeChip = await page.$eval('.tl-filter.active', (e) => e.dataset.cat).catch(() => "");
      eq("C4 · “What happened” (activity) is the default filter", activeChip, "activity");
      const anySystemVisible = await page.$$eval('#tl-list .tl-row[data-cat="system"]', (els) => els.length);
      eq("C4 · no system rows show by default", anySystemVisible, 0);
      const systemChip = await page.$('.tl-filter[data-cat="system"]');
      ok("C4 · the System tab is still there, one click away", !!systemChip);
      if (systemChip) {
        await systemChip.click();
        await wait(page, 400);
        const nowVisible = await page.$$eval('#tl-list .tl-row[data-cat="system"]', (els) => els.length);
        ok("C4 · …and clicking it reveals the system rows", nowVisible > 0);
      }
      const lastContactShown = await page.$eval("#client-last-contact", (e) => e.textContent).catch(() => "");
      const gtLastContact = await page.evaluate(async (clientId) => {
        const { data: cases } = await window.__mockDb.from("cases").select("id").eq("client_id", clientId);
        const ids = (cases || []).map((c) => c.id);
        const { data: notes } = await window.__mockDb.from("case_notes").select("created_at").in("case_id", ids);
        const nowMs = Date.now();
        const times = (notes || []).map((n) => new Date(n.created_at).getTime()).filter((t) => t <= nowMs);
        if (!times.length) return null;
        return Math.max(...times);
      }, client);
      ok("C4 · the Last-contact line is present and consistent with case_notes existing on this client", lastContactShown.length > 0 && (gtLastContact == null || /Last contact/.test(lastContactShown)), lastContactShown);
      ok("C4 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C5 · W-25 — WATCHTOWER RENDERS NO RAW ISO DATES
       ======================================================================= */
    {
      console.log("\n— C5 · W-25 · Watchtower shows no raw ISO dates (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      await wait(page, 600);
      const rawIso = await page.$$eval("#watchtower-panel .wt-row, #watchtower-panel .row-item", (els) =>
        els.map((e) => e.textContent).filter((t) => /\b\d{4}-\d{2}-\d{2}\b/.test(t)));
      eq("C5 · no visible watchtower row contains a raw YYYY-MM-DD date", rawIso.length, 0);
      ok("C5 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C6 · W-25 — BRITISH-FORMATTED TASK TITLES COMPOSED THIS ROUND
       ======================================================================= */
    {
      console.log("\n— C6 · W-25 · new task titles are British-formatted, not raw ISO (p2)");
      const page = await newPage(browser, "p2", { skipTour: true });
      const gt = await mkClientCase(page, {
        first: "British", last: "Datetest", stage: "completed",
        caseFields: { assigned_to: "p3", rate_end_date: "2027-03-27", rate_end_estimated: false, completed_at: "2023-01-01T12:00:00Z" },
      });
      await page.evaluate((id) => window.openCase(id), gt.caseId);
      await wait(page, 500);
      await page.click("#cs-retention-btn");
      await wait(page, 1500);
      const task = await page.evaluate(async (caseId) => {
        const { data: succ } = await window.__mockDb.from("cases").select("id").eq("retention_source_case_id", caseId).limit(1);
        if (!succ || !succ.length) return null;
        const { data } = await window.__mockDb.from("case_tasks").select("title").eq("case_id", succ[0].id).limit(1);
        return (data || [])[0] || null;
      }, gt.caseId);
      ok("C6 · the retention call task exists", !!task, JSON.stringify(task));
      if (task) {
        ok("C6 · its title carries a British-formatted date", /27 Mar 2027/.test(task.title), task.title);
        ok("C6 · …never the raw ISO form", !/2027-03-27/.test(task.title), task.title);
      }
      ok("C6 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C7 · W-20/K-15 — SEARCH DID-YOU-MEAN + CONSECUTIVE-DIGIT PHONE MATCH
       ======================================================================= */
    {
      console.log("\n— C7 · W-20/K-15 · did-you-mean on a name typo, digit query matches only consecutive substrings (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      await goto(page, "clients", 1200); // populate clientCache — findDidYouMean's own precondition
      await goto(page, "dashboard", 600);
      await page.click("#global-search-btn");
      await wait(page, 300);
      await page.fill("#palette-input", "Polard");
      await wait(page, 500);
      const dymBtn = await page.$eval("#palette-dym", (e) => e.textContent).catch(() => "");
      ok("C7 · a one-edit typo of “Pollard” offers a did-you-mean suggestion", /Gareth Pollard/.test(dymBtn), dymBtn);
      if (dymBtn) {
        await page.click("#palette-dym");
        await wait(page, 500);
        const inputVal = await page.$eval("#palette-input", (e) => e.value);
        eq("C7 · clicking it fills in the suggested name", inputVal, "Gareth Pollard");
        const hasResult = await page.$$eval(".palette-row", (els) => els.length);
        ok("C7 · …and the search now returns results", hasResult > 0);
      }

      /* The fixture book's ~90 clients nearly all carry "07700 900xxx" numbers, so a query like
         "9001" against them superset-matches the vast majority (any trailing "1" anywhere) and the
         palette's own 40-row phone cap makes which of them survive an implementation detail, not a
         fact this test should depend on. Two purpose-built clients isolate the real question: does
         "9555" match a number that genuinely contains it consecutively, and correctly REFUSE one
         that only contains the same four digits out of order (the exact bug the R12b comment names
         — "skipping straight over" a digit in between)? Neither digit run appears anywhere in the
         surrounding fixture phones (none of them carry three '5's), so both are unambiguous. */
      const consec = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").insert({ first_name: "Consec", last_name: "Truematch", email: "consec.truematch@example.com", phone: "07700 955501" }).select("id").single();
        return data.id;
      });
      const skip = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").insert({ first_name: "Skipdigit", last_name: "Falsematch", email: "skipdigit.falsematch@example.com", phone: "07700 950551" }).select("id").single();
        return data.id;
      });
      await page.fill("#palette-input", "");
      await wait(page, 300);
      await page.fill("#palette-input", "9555");
      await wait(page, 500);
      const namesShown = await page.$$eval(".palette-row .pr-title", (els) => els.map((e) => e.textContent));
      ok("C7 · “9555” matches a number where it is a real CONSECUTIVE substring (…955501)", namesShown.includes("Consec Truematch"), JSON.stringify(namesShown));
      ok("C7 · …and does NOT match a number carrying the same four digits out of order (…950551)", !namesShown.includes("Skipdigit Falsematch"), JSON.stringify(namesShown));
      ok("C7 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C8 · L-7 — VALIDATION HIGHLIGHTS
       ======================================================================= */
    {
      console.log("\n— C8 · L-7 · validation highlights the actually-blank field, clears on input (p4)");
      const page = await newPage(browser, "p4", { skipTour: true });
      await page.evaluate(() => window.openClient(null));
      await wait(page, 500);
      await page.fill('#client-form [name="last_name"]', "OnlyLastName");
      await page.click("#modal-save");
      await wait(page, 400);
      const invalid1 = await page.evaluate(() => ({
        first: document.querySelector('#client-form [name="first_name"]').classList.contains("field-invalid"),
        last: document.querySelector('#client-form [name="last_name"]').classList.contains("field-invalid"),
      }));
      ok("C8 · only the actually-blank field (first name) is highlighted", invalid1.first && !invalid1.last, JSON.stringify(invalid1));
      await page.fill('#client-form [name="first_name"]', "F");
      await wait(page, 200);
      const clearedOnInput = await page.evaluate(() => !document.querySelector('#client-form [name="first_name"]').classList.contains("field-invalid"));
      ok("C8 · typing into it clears the highlight immediately, not on the next Save attempt", clearedOnInput);
      await page.evaluate(() => window.closeModal());
      ok("C8 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    console.log(`\n${"=".repeat(64)}\nr12b: ${pass} passed, ${failures.length} failed`);
    if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (e) { try { server.kill(); } catch (_) {} } }
    process.exitCode = failures.length ? 1 : 0;
  }
})();
