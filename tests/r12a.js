#!/usr/bin/env node
/* =============================================================================
   tests/r12a.js — acceptance tests for ROUND 12a, all twelve defect fixes.

     D1/D2 (K-1/K-2) ONE LEAD, ONE ANSWER — the lead-adviser <select> that used
           to exist twice (My Day + the leads drawer) now shares one answer:
           LEAD_ADV_CHOICE, syncLeadRouting() and applyLeadAdvChoices(). Changing
           either copy updates the other; the "(lightest load)" note agrees on
           both; Accept reads the shared choice regardless of which panel's
           button was clicked.
     D2  (K-3) THE JOINT-ENQUIRY PROMPTS — Enter/Enter (empty answers) on the
           two-field joint-name prompt used to file the client under the WHOLE
           doubled name; empty answers are now treated like Cancel, per field,
           and the parsed guess stands. Cancel on the FIRST prompt skips the
           second prompt entirely.
     D3  THE FACT-FIND SEND PATH — opening the dialog inserts fact_finds with
           an explicit status:'created' (never the column default 'sent'); the
           real send goes through queueEmail → email_queue → the scoped
           process-emails run, which composes the email server-side (v12),
           advances the fact_finds row to 'sent' only after a genuine send,
           and throws (row goes 'failed') when site_url is not configured.
           The mailto fallback is signed correctly and leaves an honest note.
     D4  THE PROTECTION CHIP, ALWAYS — #cs-prot-warn renders for all five
           protection_status values, never disappears, and is never removed
           by the call-logger's "record the conversation" tick (repainted).
     D5  (K-5) A BOUNCE REACHES MY DAY — failed email/sms rows for a LIVE,
           owned case are merged into the briefing as kind:"comms_failed",
           scoped by Mine/All exactly like everything else, badged BOUNCED or
           NOT SENT by isBadContactError(), and never shown for a dead case.
     D6  (K-6) CANCELLING A QUEUED MESSAGE — a real Cancel button, on queued
           and failed rows, guarded on the status it was rendered with so a
           row that has since changed underneath it is left alone.
     D7  (K-7) THE EMAILS SUMMARY COUNTS THE RIGHT THING — "will send" is DUE
           queued rows (scheduled_for null or past), stated separately from
           DEFERRED ones, and the Queued chip's total is reconciled against it.
     D8  OPEN A CLIENT-UPLOADED DOCUMENT — a case_documents row with a
           storage_path gets a working "📎 Open" button (signed URL, 5 min);
           one received by email/in person (no storage_path) gets none.
     D9  THE QUOTE CLOCK MAY NEVER RUN BACKWARDS — protection_quoted_at is
           stamped on a genuine transition to 'quoted', backfilled once for a
           legacy quoted row with no date, and otherwise left exactly alone —
           never reset by re-applying "Quoted" to an already-quoted case.
     D10 A TASK WITH NO DATE IS ON NO LIST ANYWHERE — a task submitted with no
           due date picked defaults to tomorrow rather than being written with
           none; a due-chip pick always wins and the toast says which happened.
     D11 ONE DEFINITION OF "CLASH" — apptOverlaps(): same staff_id, half-open
           [start,end) intervals, shared by the editor's live notice, the
           save-time confirm and the diary's own ⚠, so back-to-back bookings
           are never flagged and different advisers at the same hour never are.
     D12 DONE, AND UNDONE — marking a task done stamps done_at, offers a
           10s Undo via the toast's new {label,onClick} action, and a done row
           in the case modal carries its own ↺ Reopen button.

   EVERY figure this file asserts is recomputed HERE, from fixture/synthetic
   rows read straight off __mockDb, in an implementation written separately
   from app.js's. Nothing is compared against app.js's own idea of the answer.
   Pure formatting helpers (fmtD, localDateStr, emailTypeLabel, smsTypeLabel)
   are called directly — they are top-level `const`/`function` bindings in the
   page's global scope and, in a classic (non-module) script, are reachable by
   page.evaluate() the same way they are typeable into the DevTools console,
   even the `const` ones that never attach to `window`. Using them to format a
   number/date for comparison is not "asking the app to grade itself" — that
   principle governs the business decisions (who is in a segment, which row
   should appear, what a status transition should do), which are always
   recomputed independently below.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r12a.js
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

/* newPage — dialog queue supports "dismiss", a bare string (used as the accept
   text for a prompt) or {type:"dismiss"|"accept", text}. Unlisted dialogs fall
   back to page.__dialogAnswer (default "accept", no text). Modelled on
   tests/r5_batch4.js / r5_batch5.js's __dialogPlan. */
async function newPage(browser, persona, viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
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
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const wait = (page, ms) => page.waitForTimeout(ms);

/* Insert a client + case in one round trip, returning {clientId, caseId, email}. */
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email || (`r12a.${Math.random().toString(36).slice(2, 9)}@example.com`);
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Test", last_name: o.last || "Client", email, phone: o.phone || null })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const { data: cs, error: csErr } = await db.from("cases")
      .insert({
        client_id: cl.id, case_kind: o.case_kind || "remortgage", stage: o.stage || "enquiry",
        assigned_to: o.assigned_to === undefined ? null : o.assigned_to,
      })
      .select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id, email };
  }, opts || {});
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {

    /* ===================================================================
       D1 / D2 · K-1/K-2 — ONE LEAD, ONE ANSWER (p4 Daniel, owner)
       =================================================================== */
    {
      console.log("\n— D1/D2 · K-1/K-2 · one lead-adviser choice shared by both panels");
      const page = await newPage(browser, "p4");

      const leadIds = await page.evaluate(async () => {
        const db = window.__mockDb;
        const mk = async (name, enquiry_type) => {
          // No phone on purpose — a fixture client ("Tom Beresford") already holds a
          // "07700 900xxx"-style number, and the near/exact client-match dialog (R5-10) would
          // otherwise fire on a coincidental digit match and silently attach the new case to a
          // pre-existing client instead of creating one, which is not what D1/D2 are testing.
          const { data, error } = await db.from("leads")
            .insert({ name, email: name.replace(/\s+/g, ".").toLowerCase() + "@example.com", phone: null, enquiry_type, message: "Test enquiry", status: "new" })
            .select("id").single();
          if (error) throw new Error(error.message);
          return data.id;
        };
        return { a: await mk("Freddie Ashcombe", "remortgage"), b: await mk("Nadia Whitlock", "purchase") };
      });

      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, 900);

      /* R41 · F1 — the New-website-leads drawer (#leads-list) is gone, so a lead's
         select.lead-adviser now renders EXACTLY ONCE, on its My Day row (#briefing-list). The
         two-copies-in-sync premise D1 used to exercise no longer applies (there is only one copy
         to go out of sync with), but the machinery it drove — LEAD_ADV_CHOICE, syncLeadRouting(),
         applyLeadAdvChoices() — is explicitly kept (see app.js's own R41 · F1 comment above
         leadRoutingHtml) because a repaint of My Day must still reconcile the row back to the
         human's choice rather than resetting it to the suggestion, and Accept must still read the
         LEAD's stored answer rather than a stale copy off the DOM. D1 now proves exactly that,
         single-panel. */
      const selCount = (id) => page.$$eval(`select.lead-adviser[data-lead="${id}"]`, (els) => els.length);
      eq("D1 · lead A's select now appears exactly ONCE (the leads drawer is gone)", await selCount(leadIds.a), 1);
      eq("D1 · lead B's select now appears exactly ONCE", await selCount(leadIds.b), 1);

      const selValue = (id) => page.$eval(`select.lead-adviser[data-lead="${id}"]`, (e) => e.value);
      const selOptions = (id) => page.$$eval(`select.lead-adviser[data-lead="${id}"]`, (els) => Array.prototype.map.call(els[0].options, (o) => o.value));
      const rrOf = (id) => page.$eval(`select.lead-adviser[data-lead="${id}"]`, (e) => e.dataset.rr || "");

      const optsA = await selOptions(leadIds.a);
      const rrA = await rrOf(leadIds.a);
      const notRr = optsA.find((v) => v !== rrA) || optsA[0];

      // Change the one copy away from the suggestion…
      await page.selectOption(`#briefing-list select.lead-adviser[data-lead="${leadIds.a}"]`, notRr);
      await wait(page, 200);
      eq("D1 · the choice took on the row", await selValue(leadIds.a), notRr);

      // K-2 — the "(lightest load)" note hides once the selection moves off the suggestion.
      const rrHidden = (id) => page.$eval(`.lead-rr[data-rr-for="${id}"]`, (e) => e.classList.contains("hidden"));
      eq("D1 · K-2 rr note hidden when away from the suggestion", await rrHidden(leadIds.a), true);

      // …and REPAINT My Day (toggle the scope segment twice — All then back to Mine, each a fresh
      // loadBriefing()/renderBriefing() — leads survive both scopes per R5-35's carve-out) without
      // touching the select directly. applyLeadAdvChoices() must reconcile the freshly-rendered row
      // back to LEAD_ADV_CHOICE, not the default suggestion — this is the one behaviour the K-1
      // machinery exists to preserve now that there is nothing left to "sync" against.
      await page.click("#brief-scope-all");
      await wait(page, 500);
      await page.click("#brief-scope-mine");
      await wait(page, 500);
      eq("D1 · K-1 the choice SURVIVES a My Day repaint (applyLeadAdvChoices reconciles to it)", await selValue(leadIds.a), notRr);
      eq("D1 · K-2 the rr note stays hidden across the repaint too", await rrHidden(leadIds.a), true);

      // Move it back onto the suggestion and confirm the note returns.
      await page.selectOption(`#briefing-list select.lead-adviser[data-lead="${leadIds.a}"]`, rrA);
      await wait(page, 200);
      eq("D1 · K-2 rr note reappears once back on the suggestion", await rrHidden(leadIds.a), false);

      // Now move lead A's choice to a specific, known adviser and Accept — Accept must read the
      // LEAD's stored answer (leadAdviserValue), not merely whatever the clicked row's own <select>
      // happens to show, which on a single-panel screen are the same DOM node but were historically
      // two different reads (see K-1's header comment above leadAdviserValue in app.js).
      await page.selectOption(`#briefing-list select.lead-adviser[data-lead="${leadIds.a}"]`, notRr);
      await wait(page, 200);
      const nameOfA = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("profiles").select("full_name").eq("id", id).single();
        return data && data.full_name;
      }, notRr);
      await page.click(`#briefing-list [onclick^="acceptLead('${leadIds.a}'"]`);
      await wait(page, 1200);
      const toastA = await toastText(page);
      ok("D1 · Accept uses the stored choice", toastA.includes(`Case created for Freddie Ashcombe`) && toastA.includes(`→ ${nameOfA}`), toastA);
      const caseAAssignedTo = await page.evaluate(async (leadId) => {
        const { data: lead } = await window.__mockDb.from("leads").select("converted_case_id").eq("id", leadId).single();
        const { data: cs } = await window.__mockDb.from("cases").select("assigned_to").eq("id", lead.converted_case_id).single();
        return cs.assigned_to;
      }, leadIds.a);
      eq("D1 · the case was actually created for that adviser", caseAAssignedTo, notRr);

      // Lead B: choose an adviser, Accept — the ordinary single-panel path, for a second lead.
      const optsB = await selOptions(leadIds.b);
      const rrB = await rrOf(leadIds.b);
      const notRrB = optsB.find((v) => v !== rrB && v !== notRr) || optsB.find((v) => v !== rrB) || optsB[0];
      const nameOfB = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("profiles").select("full_name").eq("id", id).single();
        return data && data.full_name;
      }, notRrB);
      await page.selectOption(`#briefing-list select.lead-adviser[data-lead="${leadIds.b}"]`, notRrB);
      await wait(page, 200);
      await page.click(`#briefing-list [onclick^="acceptLead('${leadIds.b}'"]`);
      await wait(page, 1200);
      const toastB = await toastText(page);
      ok("D1 · Accept for a second lead also uses its own stored choice", toastB.includes("Case created for Nadia Whitlock") && toastB.includes(`→ ${nameOfB}`), toastB);
      const caseBAssignedTo = await page.evaluate(async (leadId) => {
        const { data: lead } = await window.__mockDb.from("leads").select("converted_case_id").eq("id", leadId).single();
        const { data: cs } = await window.__mockDb.from("cases").select("assigned_to").eq("id", lead.converted_case_id).single();
        return cs.assigned_to;
      }, leadIds.b);
      eq("D1 · the second case was created for the chosen adviser", caseBAssignedTo, notRrB);

      /* -------------------------------------------------------------
         D2 · K-3 — the joint-enquiry name capture
         R76 · B3: the two native prompts are ONE #lead-joint-overlay now,
         prefilled with the parsed guess. K-3's property survives with the
         machine that caused it gone: accepting the defaults (the reflex
         input) accepts the GUESS, never the doubled raw name; an emptied
         field still falls back to the guess per field. Cancel is a real
         abort now (the enquiry goes back in the inbox) — the old "cancel
         proceeds with the guess" only ever existed because a native prompt
         cannot host a real Cancel; the abort contract is pinned in
         tests/r76_intake.js §C5, and (b) below pins it here too.
         ------------------------------------------------------------- */
      // (a) OK with everything untouched — the reflex input. The parsed guess must stand,
      //     not the doubled raw name, and no native prompt may fire.
      const lead1 = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("leads")
          .insert({ name: "Priscilla & Quentin Marchbank", email: "marchbank@example.com", phone: null, enquiry_type: "purchase", status: "new" })
          .select("id").single();
        return data.id;
      });
      const promptsBefore1 = page.__dialogs.filter((d) => d.type === "prompt").length;
      await page.evaluate((id) => { window.acceptLead(id, null); }, lead1);
      await wait(page, 1200);
      const ovl1 = await page.evaluate(() => ({
        open: !!document.querySelector("#lead-joint-overlay"),
        first: (document.querySelector("#ljo-first") || {}).value,
        last: (document.querySelector("#ljo-last") || {}).value,
      }));
      ok("D2 · K-3 the joint question is ONE overlay, prefilled with the guess — no prompts",
        ovl1.open === true && ovl1.first === "Priscilla" && ovl1.last === "Marchbank"
        && page.__dialogs.filter((d) => d.type === "prompt").length === promptsBefore1, JSON.stringify(ovl1));
      await page.click("#ljo-ok");
      await wait(page, 1600);
      const client1 = await page.evaluate(async (id) => {
        const { data: lead } = await window.__mockDb.from("leads").select("converted_case_id").eq("id", id).single();
        const { data: cs } = await window.__mockDb.from("cases").select("client_id").eq("id", lead.converted_case_id).single();
        const { data: cl } = await window.__mockDb.from("clients").select("first_name,last_name").eq("id", cs.client_id).single();
        const { data: notes } = await window.__mockDb.from("case_notes").select("body").eq("case_id", lead.converted_case_id);
        return { cl, notes: (notes || []).map((n) => n.body) };
      }, lead1);
      eq("D2 · the reflex OK files the PARSED GUESS, not the doubled raw name", client1.cl, { first_name: "Priscilla", last_name: "Marchbank" });
      ok("D2 · the case note records the second applicant", client1.notes.some((b) => b.includes("Joint applicant: Quentin Marchbank")), JSON.stringify(client1.notes));

      // (b) Cancel — R76: a real abort. Nothing is filed and the enquiry goes back in the inbox.
      const lead2 = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("leads")
          .insert({ name: "Rowena & Simon Etchingham", email: "etchingham@example.com", phone: null, enquiry_type: "remortgage", status: "new" })
          .select("id").single();
        return data.id;
      });
      await page.evaluate((id) => { window.acceptLead(id, null); }, lead2);
      await wait(page, 1200);
      await page.click("#ljo-cancel");
      await wait(page, 1400);
      const client2 = await page.evaluate(async (id) => {
        const { data: lead } = await window.__mockDb.from("leads").select("status,converted_case_id").eq("id", id).single();
        const { data: cl } = await window.__mockDb.from("clients").select("id").eq("last_name", "Etchingham");
        return { lead, made: (cl || []).length };
      }, lead2);
      eq("D2 · Cancel aborts: the enquiry is back in the inbox and nothing was filed",
        [client2.lead.status, client2.lead.converted_case_id, client2.made], ["new", null, 0]);

      // (c) Genuinely unparseable name — no guess to fall back to.
      const lead3 = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("leads")
          .insert({ name: "&", email: "unparseable@example.com", phone: null, enquiry_type: "other", status: "new" })
          .select("id").single();
        return data.id;
      });
      await page.evaluate((id) => { window.acceptLead(id, null); }, lead3);
      await wait(page, 1200);
      await page.click("#ljo-ok");
      await wait(page, 1600);
      const client3 = await page.evaluate(async (id) => {
        const { data: lead } = await window.__mockDb.from("leads").select("converted_case_id").eq("id", id).single();
        const { data: cs } = await window.__mockDb.from("cases").select("client_id").eq("id", lead.converted_case_id).single();
        const { data: cl } = await window.__mockDb.from("clients").select("first_name,last_name").eq("id", cs.client_id).single();
        const { data: notes } = await window.__mockDb.from("case_notes").select("body").eq("case_id", lead.converted_case_id);
        return { cl, notes: (notes || []).map((n) => n.body) };
      }, lead3);
      eq("D2 · an unparseable name still files the client (falls back to the raw name)", client3.cl, { first_name: "", last_name: "&" });
      ok("D2 · the note says the enquiry was unparsed as submitted", client3.notes.some((b) => b.includes("Joint enquiry as submitted: &")), JSON.stringify(client3.notes));

      ok("D1/D2 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D3 · THE FACT-FIND SEND PATH (p4 Daniel, owner; case adviser p3 Luke)
       =================================================================== */
    {
      console.log("\n— D3 · the digital fact-find send path (process-emails v12)");
      const page = await newPage(browser, "p4");

      const { clientId, caseId, email } = await mkClientCase(page, { first: "Priya", last: "Chandaria", stage: "fact_find", assigned_to: "p3" });
      await page.evaluate((id) => window.openCase(id), caseId);
      await wait(page, 900);

      await clickAction(page, "act-factfind");
      await wait(page, 500);
      const ffCreated = await page.evaluate(async (cid) => {
        const { data } = await window.__mockDb.from("fact_finds").select("*").eq("case_id", cid).order("created_at", { ascending: false }).limit(1).single();
        return data;
      }, caseId);
      eq("D3 · opening the dialog inserts fact_finds with an EXPLICIT status of 'created'", ffCreated.status, "created");
      const badge1 = await page.$eval("#ff-status-badge", (e) => ({ cls: e.className, text: e.textContent }));
      ok("D3 · the badge reads grey / \"not sent yet\" before any send", badge1.cls.includes("badge grey") && badge1.text === "not sent yet", JSON.stringify(badge1));

      await page.click("#ff-send");
      await wait(page, 1500);
      const sendDialog = page.__dialogs.slice(-1)[0];
      ok("D3 · the send confirm names the CASE's adviser, not the sender", sendDialog && sendDialog.message.includes("Signed off by: Luke Richards"), JSON.stringify(sendDialog));
      ok("D3 · the send confirm names the chase task and its due date", sendDialog && sendDialog.message.includes('Chase fact-find — Priya'), JSON.stringify(sendDialog));

      const after1 = await page.evaluate(async (cid) => {
        const db = window.__mockDb;
        const { data: em } = await db.from("email_queue").select("*").eq("case_id", cid).eq("email_type", "factfind").order("created_at", { ascending: false }).limit(1).single();
        const { data: ff } = await db.from("fact_finds").select("*").eq("case_id", cid).order("created_at", { ascending: false }).limit(1).single();
        const { data: notes } = await db.from("case_notes").select("body").eq("case_id", cid);
        const { data: tasks } = await db.from("case_tasks").select("title,due_date,assigned_to").eq("case_id", cid);
        return { em, ff, notes: (notes || []).map((n) => n.body), tasks };
      }, caseId);
      eq("D3 · the queued email actually sent", after1.em.status, "sent");
      eq("D3 · the fact_finds row is advanced to 'sent' only AFTER the real send", after1.ff.status, "sent");
      ok("D3 · the case note names the client and the signatory", after1.notes.some((b) => b === "Fact-find link emailed to Priya Chandaria — signed off by Luke Richards."), JSON.stringify(after1.notes));
      const expectDue = await page.evaluate(() => localDateStr(Date.now() + 3 * 86400000));
      ok("D3 · a 3-day chase task was written, assigned to the case's adviser", after1.tasks.some((t) => t.title === "Chase fact-find — Priya" && t.due_date === expectDue && t.assigned_to === "p3"), JSON.stringify(after1.tasks));

      const expectSentDate = await page.evaluate(() => fmtD(new Date().toISOString()));
      const badge2 = await page.$eval("#ff-status-badge", (e) => e.textContent);
      eq("D3 · reopening the dialog shows the SENT badge with a date, not just \"sent\"", badge2, `sent ${expectSentDate}`);

      // The mailto fallback — a fresh case so its own fact_finds row is untouched.
      const c2 = await mkClientCase(page, { first: "Callum", last: "Bretherton", stage: "fact_find", assigned_to: "p3" });
      await page.evaluate((id) => window.openCase(id), c2.caseId);
      await wait(page, 900);
      await clickAction(page, "act-factfind");
      await wait(page, 500);
      const mailtoUrl = await page.evaluate(() => new Promise((resolve) => {
        const orig = window.open;
        window.open = (url) => { window.open = orig; resolve(url); return null; };
        document.getElementById("ff-mail").click();
      }));
      await wait(page, 700);
      const bodyDecoded = decodeURIComponent((mailtoUrl.split("body=")[1] || "").split("&")[0]);
      ok("D3 · the mailto draft is signed off by the CASE's adviser, not the owner", bodyDecoded.includes("Thanks,\nLuke Richards"), bodyDecoded);
      const notes2 = await page.evaluate(async (cid) => (await window.__mockDb.from("case_notes").select("body").eq("case_id", cid)).data.map((n) => n.body), c2.caseId);
      ok("D3 · the mailto path leaves an honest \"cannot confirm\" note", notes2.some((b) => b.includes("the system cannot confirm it was sent. Signed off by Luke Richards.")), JSON.stringify(notes2));
      const ff2 = await page.evaluate(async (cid) => (await window.__mockDb.from("fact_finds").select("status").eq("case_id", cid).single()).data, c2.caseId);
      eq("D3 · the mailto path does NOT advance the fact_finds row to sent", ff2.status, "created");

      // Backend guard — no site_url configured, bypassing queueEmail's own client-side gate by
      // inserting the queue row directly (this exercises the SERVER-side guard, which is the
      // backstop for every route that doesn't come through the button).
      const c3 = await mkClientCase(page, { first: "Orla", last: "Fenwick", stage: "fact_find", assigned_to: "p3" });
      await page.evaluate(async () => { await window.__mockDb.from("settings").update({ value: "" }).eq("key", "site_url"); });
      const qId = await page.evaluate(async (o) => {
        const { data } = await window.__mockDb.from("email_queue").insert({ case_id: o.caseId, client_id: o.clientId, email_type: "factfind", to_email: o.email }).select("id").single();
        return data.id;
      }, c3);
      const runResult = await page.evaluate(async (id) => {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/process-emails`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queue_ids: [id] }) });
        return r.json();
      }, qId);
      const failedRow = await page.evaluate(async (id) => (await window.__mockDb.from("email_queue").select("status,error").eq("id", id).single()).data, qId);
      eq("D3 · with no site_url the row is sent to the SERVER-SIDE guard and fails", failedRow.status, "failed");
      eq("D3 · the row carries the EXACT throw string", failedRow.error, "site_url not set — cannot build the fact-find link");
      eq("D3 · process-emails itself reports the failure", runResult.failed, 1);

      // Restore site_url, then prove a pre-existing 'submitted' fact_finds row is never regressed.
      await page.evaluate(async () => { await window.__mockDb.from("settings").update({ value: "https://www.nexmoney.co.uk" }).eq("key", "site_url"); });
      const c4 = await mkClientCase(page, { first: "Marcus", last: "Iqbal", stage: "fact_find", assigned_to: "p3" });
      await page.evaluate(async (o) => {
        await window.__mockDb.from("fact_finds").insert({ case_id: o.caseId, client_id: o.clientId, status: "submitted", token: "ff-preexisting-token" });
      }, c4);
      const qId2 = await page.evaluate(async (o) => {
        const { data } = await window.__mockDb.from("email_queue").insert({ case_id: o.caseId, client_id: o.clientId, email_type: "factfind", to_email: o.email }).select("id").single();
        return data.id;
      }, c4);
      await page.evaluate(async (id) => {
        await fetch(`${SUPABASE_URL}/functions/v1/process-emails`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queue_ids: [id] }) });
      }, qId2);
      const after4 = await page.evaluate(async (o) => {
        const { data: em } = await window.__mockDb.from("email_queue").select("status").eq("id", o.qId2).single();
        const { data: ff } = await window.__mockDb.from("fact_finds").select("status").eq("case_id", o.caseId).single();
        return { em, ff };
      }, { qId2, caseId: c4.caseId });
      eq("D3 · the send itself still succeeds once site_url is restored", after4.em.status, "sent");
      eq("D3 · a fact_finds row already at 'submitted' is NEVER regressed to 'sent'", after4.ff.status, "submitted");

      ok("D3 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D4 · THE PROTECTION CHIP, ALWAYS (p4 Daniel)
       =================================================================== */
    {
      console.log("\n— D4 · #cs-prot-warn renders for every protection_status");
      const page = await newPage(browser, "p4");
      const { clientId, caseId } = await mkClientCase(page, { first: "Deepa", last: "Vora" });

      const expect = {
        not_discussed: ["cs-warn", "not discussed"],
        discussed: ["cs-warn", "discussed — no outcome yet"],
        policy_taken: ["cs-good", "policy taken"],
        declined: ["", "declined"],
      };
      for (const [status, [cls, text]] of Object.entries(expect)) {
        await page.evaluate(async (o) => { await window.__mockDb.from("cases").update({ protection_status: o.status }).eq("id", o.caseId); }, { status, caseId });
        await page.evaluate((id) => window.openCase(id), caseId);
        await wait(page, 700);
        const chip = await page.$eval("#cs-prot-warn", (e) => ({ cls: e.className.trim(), text: e.querySelector(".cs-val").textContent }));
        eq(`D4 · protection_status="${status}" renders "${text}"`, chip, { cls: `cs-stat ${cls}`.trim(), text });
      }
      // "quoted" with and without a quote date.
      await page.evaluate(async (o) => { await window.__mockDb.from("cases").update({ protection_status: "quoted", protection_quoted_at: null }).eq("id", o.caseId); }, { caseId });
      await page.evaluate((id) => window.openCase(id), caseId);
      await wait(page, 700);
      const quotedNoDate = await page.$eval("#cs-prot-warn .cs-val", (e) => e.textContent);
      eq("D4 · quoted, no date on file, still renders (no date in the text)", quotedNoDate, "quoted");
      const stampDate = await page.evaluate(() => fmtD(new Date().toISOString()));
      await page.evaluate(async (o) => { await window.__mockDb.from("cases").update({ protection_quoted_at: new Date().toISOString() }).eq("id", o.caseId); }, { caseId });
      await page.evaluate((id) => window.openCase(id), caseId);
      await wait(page, 700);
      const quotedWithDate = await page.$eval("#cs-prot-warn .cs-val", (e) => e.textContent);
      eq("D4 · quoted WITH a date renders \"quoted <date>\"", quotedWithDate, `quoted ${stampDate}`);

      ok("D4 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D5 · K-5 — A BOUNCE REACHES MY DAY (p4 Daniel)
       =================================================================== */
    {
      console.log("\n— D5 · K-5 · failed comms merged into the briefing");
      const page = await newPage(browser, "p4");

      const mine = await mkClientCase(page, { first: "Marcus", last: "Bell", stage: "enquiry", assigned_to: "p4" });
      const unassigned = await mkClientCase(page, { first: "Ross", last: "McKay", stage: "fact_find", assigned_to: null });
      const dead = await mkClientCase(page, { first: "Sonia", last: "Placeholder", stage: "completed", assigned_to: "p2" });

      await page.evaluate(async (o) => {
        const db = window.__mockDb;
        await db.from("email_queue").insert({ case_id: o.mine.caseId, client_id: o.mine.clientId, email_type: "docs_request", to_email: o.mine.email, status: "failed", error: "Bounced — invalid recipient address" });
        await db.from("sms_queue").insert({ case_id: o.unassigned.caseId, client_id: o.unassigned.clientId, sms_type: "appointment_reminder", to_phone: "07700900555", status: "failed", error: "Temporary send failure, try later" });
        await db.from("email_queue").insert({ case_id: o.dead.caseId, client_id: o.dead.clientId, email_type: "docs_request", to_email: o.dead.email, status: "failed", error: "Bounced — invalid recipient address" });
        await db.from("email_queue").insert({ case_id: null, client_id: null, email_type: "lead_ack", to_email: "ghost@example.com", status: "failed", error: "Bounced — invalid recipient address" });
      }, { mine, unassigned, dead });

      const rowsByName = async () => page.$$eval(".row-item.brief-row", (rs) => rs.map((r) => ({
        text: (r.querySelector(".t") || {}).textContent || "",
        badge: (r.querySelector(".badge") || {}).textContent || "",
      })));

      await page.evaluate(() => window.setBriefScope("mine"));
      await wait(page, 900);
      let rows = await rowsByName();
      ok("D5 · under \"Mine\", MY failed email is in the briefing, badged BOUNCED", rows.some((r) => r.text.includes("Marcus Bell") && r.badge === "BOUNCED"), JSON.stringify(rows));
      ok("D5 · under \"Mine\", an UNASSIGNED case's failed SMS is NOT shown", !rows.some((r) => r.text.includes("Ross McKay")), JSON.stringify(rows));
      ok("D5 · a dead (completed) case's failure never shows, even matching my own", !rows.some((r) => r.text.includes("Sonia Placeholder")), JSON.stringify(rows));

      await page.evaluate(() => window.setBriefScope("all"));
      await wait(page, 900);
      rows = await rowsByName();
      ok("D5 · under \"All\", the unassigned case's failed SMS now appears, badged NOT SENT", rows.some((r) => r.text.includes("Ross McKay") && r.badge === "NOT SENT"), JSON.stringify(rows));
      ok("D5 · under \"All\", the completed case's failure STILL never shows", !rows.some((r) => r.text.includes("Sonia Placeholder")), JSON.stringify(rows));
      ok("D5 · a case-less failed row (lead ack) is never merged in", !rows.some((r) => r.text.includes("ghost@example.com")), JSON.stringify(rows));

      ok("D5 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D6 · K-6 — CANCELLING A QUEUED MESSAGE (p1 Kim, admin)
       =================================================================== */
    {
      console.log("\n— D6 · K-6 · cancel on queued/failed email + SMS rows");
      const page = await newPage(browser, "p1");
      const cc = await mkClientCase(page, { first: "Harriet", last: "Osgood" });

      const ids = await page.evaluate(async (o) => {
        const db = window.__mockDb;
        const q1 = (await db.from("email_queue").insert({ case_id: o.caseId, client_id: o.clientId, email_type: "docs_request", to_email: o.email, status: "queued" }).select("id").single()).data.id;
        const q2 = (await db.from("sms_queue").insert({ case_id: o.caseId, client_id: o.clientId, sms_type: "appointment_reminder", to_phone: "07700900666", status: "queued" }).select("id").single()).data.id;
        const q3 = (await db.from("email_queue").insert({ case_id: o.caseId, client_id: o.clientId, email_type: "fee_request", to_email: o.email, status: "failed", error: "SMTP timeout" }).select("id").single()).data.id;
        const q4 = (await db.from("email_queue").insert({ case_id: o.caseId, client_id: o.clientId, email_type: "docs_request", to_email: o.email, status: "queued" }).select("id").single()).data.id;
        const q5 = (await db.from("sms_queue").insert({ case_id: o.caseId, client_id: o.clientId, sms_type: "appointment_reminder", to_phone: "07700900777", status: "sending" }).select("id").single()).data.id;
        return { q1, q2, q3, q4, q5 };
      }, cc);
      await page.evaluate(() => window.nav("emails"));
      await wait(page, 900);

      // Queued email — cancel.
      await page.click(`.em-cancel[data-id="${ids.q1}"]`);
      await wait(page, 900);
      const d1 = page.__dialogs.slice(-1)[0];
      ok("D6 · the queued-email cancel confirm says it will never send", d1 && /never send/.test(d1.message), JSON.stringify(d1));
      const row1 = await page.evaluate(async (id) => (await window.__mockDb.from("email_queue").select("status").eq("id", id).single()).data, ids.q1);
      eq("D6 · the queued email is now cancelled", row1.status, "cancelled");
      const notes1 = await page.evaluate(async (cid) => (await window.__mockDb.from("case_notes").select("body").eq("case_id", cid)).data.map((n) => n.body), cc.caseId);
      ok("D6 · a case note records who cancelled it", notes1.some((b) => b.includes("cancelled by Kim Martin") && b.includes("it will not send.")), JSON.stringify(notes1));

      // Queued SMS — cancel.
      await page.click(`.sms-cancel[data-id="${ids.q2}"]`);
      await wait(page, 900);
      const row2 = await page.evaluate(async (id) => (await window.__mockDb.from("sms_queue").select("status").eq("id", id).single()).data, ids.q2);
      eq("D6 · the queued SMS is now cancelled", row2.status, "cancelled");

      // Failed email — different confirm wording, still cancellable.
      await page.click(`.em-cancel[data-id="${ids.q3}"]`);
      await wait(page, 900);
      const d3 = page.__dialogs.slice(-1)[0];
      ok("D6 · the FAILED-email cancel confirm reads differently (stop retrying)", d3 && /Cancel this failed email/.test(d3.message) && /stops being retried and will never send/.test(d3.message), JSON.stringify(d3));
      const row3 = await page.evaluate(async (id) => (await window.__mockDb.from("email_queue").select("status").eq("id", id).single()).data, ids.q3);
      eq("D6 · the failed email is now cancelled", row3.status, "cancelled");

      // Race guard — status changed underneath the rendered button before the click lands.
      await page.evaluate(async (id) => { await window.__mockDb.from("email_queue").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id); }, ids.q4);
      await page.click(`.em-cancel[data-id="${ids.q4}"]`);
      await wait(page, 900);
      const t4 = await toastText(page);
      ok("D6 · a row that has already sent refuses the cancel, with a plain reason", t4.includes("is sent — only a queued or failed one can be cancelled"), t4);
      const row4 = await page.evaluate(async (id) => (await window.__mockDb.from("email_queue").select("status").eq("id", id).single()).data, ids.q4);
      eq("D6 · that row's status is untouched (never overwritten to cancelled)", row4.status, "sent");

      // The underlying guarded write: an update conditioned on a status that no longer matches
      // touches zero rows (this is the mechanism cancelQueuedRow's own guard relies on).
      const guardTest = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("email_queue").update({ status: "cancelled" }).eq("id", id).eq("status", "queued").select("id");
        return (data || []).length;
      }, ids.q4);
      eq("D6 · a status-guarded update matches zero rows once the status has moved on", guardTest, 0);

      // A "sending" SMS offers no Cancel button at all.
      const q5Btn = await page.$$eval(`.sms-cancel[data-id="${ids.q5}"]`, (els) => els.length);
      eq("D6 · a \"sending\" SMS renders no Cancel button — nothing here can recall it", q5Btn, 0);

      ok("D6 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D7 · K-7 — THE EMAILS SUMMARY COUNTS THE RIGHT THING (p1 Kim)
       =================================================================== */
    {
      console.log("\n— D7 · K-7 · em-summary: due vs deferred");
      const page = await newPage(browser, "p1");
      const cc = await mkClientCase(page, { first: "Ivo", last: "Sandringham" });

      /* R74: #em-summary now reads the hold and the cron heartbeat before it promises anything —
         while `email_hold` is on it says the mail is HELD and does not talk about the next run at
         all (panel D-25/A#9). This block is about the RUN'S OWN ARITHMETIC — which queued rows are
         due and which are deferred — so it sets the state in which a run can actually happen. The
         assertions below are untouched. The held and cron-stale wordings are covered by
         tests/r74_numbers.js §C. */
      await page.evaluate(async () => {
        const rows = window.__mock.db.settings;
        const row = rows.filter((r) => r.key === "email_hold")[0];
        if (row) row.value = "off"; else rows.push({ key: "email_hold", value: "off" });
        const cron = rows.filter((r) => r.key === "last_cron_run_at")[0];
        if (cron) cron.value = new Date().toISOString(); else rows.push({ key: "last_cron_run_at", value: new Date().toISOString() });
        await window.__reloadSettings();
      });

      const groundTruth = () => page.evaluate(async () => {
        const { data } = await window.__mockDb.from("email_queue").select("status,scheduled_for").order("created_at", { ascending: false }).limit(100);
        const nowIso = new Date().toISOString();
        const queued = (data || []).filter((e) => e.status === "queued");
        const nDue = queued.filter((e) => !e.scheduled_for || e.scheduled_for <= nowIso).length;
        return { nQueued: queued.length, nDue, nDeferred: queued.length - nDue };
      });

      await page.evaluate(() => window.nav("emails"));
      await wait(page, 900);
      const before = await groundTruth();
      let summary = await page.$eval("#em-summary", (e) => e.textContent);
      if (before.nDeferred > 0) {
        const m = summary.match(/send\s+(\d+)\s+of\s+the\s+(\d+)\s+queued/);
        ok("D7 · before insert: the summary already separates due from queued", !!m, summary);
        if (m) { eq("D7 · before insert: nDue matches independent ground truth", Number(m[1]), before.nDue); eq("D7 · before insert: nQueued matches independent ground truth", Number(m[2]), before.nQueued); }
      } else {
        ok("D7 · before insert: with nothing deferred, the summary states one plain queued count", new RegExp(`send.{0,3}${before.nQueued}\\b`).test(summary) || before.nQueued === 0, summary);
      }

      // Insert a deliberately-deferred queued row and re-check the delta.
      await page.evaluate(async (o) => {
        const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString();
        await window.__mockDb.from("email_queue").insert({ case_id: o.caseId, client_id: o.clientId, email_type: "docs_request", to_email: o.email, status: "queued", scheduled_for: tomorrow });
      }, cc);
      await page.evaluate(() => window.loadEmails());
      await wait(page, 900);
      const after = await groundTruth();
      summary = await page.$eval("#em-summary", (e) => e.textContent);
      eq("D7 · after inserting a deferred row, nQueued went up by exactly one", after.nQueued, before.nQueued + 1);
      eq("D7 · the DUE count is unaffected by a row scheduled for the future", after.nDue, before.nDue);
      const m2 = summary.match(/send\s+(\d+)\s+of\s+the\s+(\d+)\s+queued.*?\+(\d+)\s+deferred/s);
      ok("D7 · the summary now names due, total queued and the deferred delta, all correctly", !!m2 && Number(m2[1]) === after.nDue && Number(m2[2]) === after.nQueued && Number(m2[3]) === after.nDeferred, JSON.stringify({ summary, after }));

      ok("D7 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D8 · OPEN A CLIENT-UPLOADED DOCUMENT (p1 Kim)
       =================================================================== */
    {
      console.log("\n— D8 · client-uploaded document open (signed URL)");
      const page = await newPage(browser, "p1");

      const osei = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").select("id,first_name,last_name").ilike("last_name", "Osei").limit(1).single();
        const { data: cs } = await db.from("cases").select("id").eq("client_id", cl.id).limit(1).single();
        const { data: docs } = await db.from("case_documents").select("*").eq("case_id", cs.id);
        return { caseId: cs.id, docs };
      });
      const withPath = osei.docs.filter((d) => d.storage_path);
      const withoutPath = osei.docs.filter((d) => !d.storage_path);
      ok("D8 · the fixture case has at least two received items WITH a real storage_path", withPath.length >= 2, JSON.stringify(withPath.map((d) => d.item)));
      ok("D8 · the fixture case has at least one received item WITHOUT a storage_path (received by email)", withoutPath.length >= 1 && withoutPath.every((d) => (d.note || "").includes("Received by email")), JSON.stringify(withoutPath));

      await page.evaluate((id) => window.openCase(id), osei.caseId);
      await wait(page, 900);
      for (const d of withPath) {
        const n = await page.$$eval(`.doc-open[data-doc="${d.id}"]`, (els) => els.length);
        eq(`D8 · "${d.item}" (has storage_path) shows a 📎 Open button`, n, 1);
      }
      for (const d of withoutPath) {
        const n = await page.$$eval(`.doc-open[data-doc="${d.id}"]`, (els) => els.length);
        eq(`D8 · "${d.item}" (no storage_path — received by email) shows NO Open button`, n, 0);
      }

      const target = withPath[0];
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.click(`.doc-open[data-doc="${target.id}"]`),
      ]);
      const popupUrl = popup.url();
      await popup.close();
      // R13 · BUCKET CORRECTION — the real bucket is "client-docs", and
      // storage_path is already written WITH that prefix on it, so the
      // signed URL's path (independently computed, not via app's own
      // docBucketPath) is just the prefixed storage_path unchanged.
      ok("D8 · fixture storage_path already carries the client-docs/ prefix", target.storage_path.startsWith("client-docs/"), target.storage_path);
      const expectedFragment = encodeURIComponent(target.storage_path);
      ok("D8 · Open mints a signed URL scoped to the client-docs bucket and this exact path", popupUrl.includes(expectedFragment), JSON.stringify({ popupUrl, storage_path: target.storage_path }));

      ok("D8 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D8b · A LEGACY UN-PREFIXED storage_path SIGNS AGAINST client-docs
       WITHOUT DOUBLING THE PREFIX (app's docBucketPath handles both shapes)
       =================================================================== */
    {
      console.log("\n— D8b · legacy un-prefixed storage_path opens cleanly");
      const page = await newPage(browser, "p1");

      const legacy = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").select("id,last_name").ilike("last_name", "Osei").limit(1).single();
        const { data: cs } = await db.from("cases").select("id").eq("client_id", cl.id).limit(1).single();
        const legacyPath = "docs/legacy-" + cs.id + "/old-payslip.pdf";
        const { data: row } = await db.from("case_documents").insert({
          case_id: cs.id, item: "Legacy payslip (pre-R13 upload)", status: "received", storage_path: legacyPath
        }).select().single();
        return { caseId: cs.id, row, legacyPath };
      });

      await page.evaluate((id) => window.openCase(id), legacy.caseId);
      await wait(page, 900);
      const n = await page.$$eval(`.doc-open[data-doc="${legacy.row.id}"]`, (els) => els.length);
      eq("D8b · the legacy un-prefixed row still shows an Open button", n, 1);

      const [popup2] = await Promise.all([
        page.waitForEvent("popup"),
        page.click(`.doc-open[data-doc="${legacy.row.id}"]`),
      ]);
      const popupUrl2 = popup2.url();
      await popup2.close();
      // Independently-computed expectation: bucket "client-docs" + "/" + the
      // legacy path, exactly once — never "client-docs/client-docs/...".
      const expectedFragment2 = encodeURIComponent("client-docs/" + legacy.legacyPath);
      ok("D8b · signs against client-docs without doubling the prefix", popupUrl2.includes(expectedFragment2), JSON.stringify({ popupUrl2, expected: expectedFragment2 }));
      ok("D8b · no accidental double-prefix in the URL", !popupUrl2.includes(encodeURIComponent("client-docs/client-docs/")), popupUrl2);

      ok("D8b · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D9 · THE QUOTE CLOCK MAY NEVER RUN BACKWARDS (p2 Wayne, adviser)
       =================================================================== */
    {
      console.log("\n— D9 · protection_quoted_at: stamped once, never rewound");
      const page = await newPage(browser, "p2");
      const { caseId } = await mkClientCase(page, { first: "Benedict", last: "Ashworth" });

      const readCase = () => page.evaluate((id) => window.__mockDb.from("cases").select("protection_status,protection_quoted_at,protection_quoted_by").eq("id", id).single().then((r) => r.data), caseId);

      await page.evaluate((id) => window.setProtStatus(id, "quoted"), caseId);
      await wait(page, 400);
      const c1 = await readCase();
      eq("D9 · a genuine transition to quoted stamps protection_status", c1.protection_status, "quoted");
      ok("D9 · ...and stamps protection_quoted_at", !!c1.protection_quoted_at, JSON.stringify(c1));
      eq("D9 · ...and records who quoted it", c1.protection_quoted_by, "p2");

      const toast1 = await toastText(page);
      ok("D9 · the toast says the clock started today", toast1.includes("quote clock started today"), toast1);

      await page.evaluate((id) => window.setProtStatus(id, "quoted"), caseId);
      await wait(page, 400);
      const c2 = await readCase();
      eq("D9 · re-applying \"quoted\" to an ALREADY-quoted case never moves the date", c2.protection_quoted_at, c1.protection_quoted_at);
      const toast2 = await toastText(page);
      ok("D9 · ...and the toast says the existing date was left alone", toast2.includes("left as it is"), toast2);

      // Legacy backfill: already quoted, no date on record → stamp exactly once.
      await page.evaluate((id) => window.__mockDb.from("cases").update({ protection_quoted_at: null }).eq("id", id), caseId);
      await page.evaluate((id) => window.setProtStatus(id, "quoted"), caseId);
      await wait(page, 400);
      const c3 = await readCase();
      ok("D9 · an already-quoted case with NO date on file gets backfilled", !!c3.protection_quoted_at, JSON.stringify(c3));

      // Moving OFF quoted never clears the stamp.
      await page.evaluate((id) => window.setProtStatus(id, "declined"), caseId);
      await wait(page, 400);
      const c4 = await readCase();
      eq("D9 · protection_status moved to declined", c4.protection_status, "declined");
      eq("D9 · ...but the quote date is never cleared by a later status change", c4.protection_quoted_at, c3.protection_quoted_at);

      ok("D9 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D10 · A TASK WITH NO DATE IS ON NO LIST ANYWHERE (p2 Wayne)
       =================================================================== */
    {
      console.log("\n— D10 · dateless task submit defaults to tomorrow");
      const page = await newPage(browser, "p2");
      const { caseId } = await mkClientCase(page, { first: "Genevieve", last: "Okafor", assigned_to: "p2" });
      await page.evaluate((id) => window.openCase(id), caseId);
      await wait(page, 900);

      await page.fill("#new-task", "Chase ID verification");
      await page.press("#new-task", "Enter");
      await wait(page, 700);
      const expectTomorrow = await page.evaluate(() => localDateStr(Date.now() + 86400000));
      const toastNoDate = await toastText(page);
      eq("D10 · a task submitted with no date picked defaults its toast", toastNoDate, "Task added — due tomorrow (no date was picked)");
      const t1 = await page.evaluate(async (o) => (await window.__mockDb.from("case_tasks").select("due_date").eq("case_id", o).eq("title", "Chase ID verification").single()).data, caseId);
      eq("D10 · ...and its due_date is genuinely tomorrow", t1.due_date, expectTomorrow);

      // A due-chip pick always wins, and the toast names it.
      await page.click('.due-chip[data-days="3"]');
      const chipDate = await page.$eval("#new-task-due", (e) => e.value);
      await page.fill("#new-task", "Book valuation");
      await page.press("#new-task", "Enter");
      await wait(page, 700);
      const toastChip = await toastText(page);
      const expectFmt = await page.evaluate((d) => fmtD(d), chipDate);
      eq("D10 · a chip-picked due date is honoured, and the toast says which date", toastChip, `Task added — due ${expectFmt}`);
      const t2 = await page.evaluate(async (o) => (await window.__mockDb.from("case_tasks").select("due_date").eq("case_id", o).eq("title", "Book valuation").single()).data, caseId);
      eq("D10 · ...and the row itself carries that exact date", t2.due_date, chipDate);

      ok("D10 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D11 · ONE DEFINITION OF "CLASH" (p3 Luke — fresh persona, month view)
       =================================================================== */
    {
      console.log("\n— D11 · apptOverlaps(): same staff, half-open intervals");
      const page = await newPage(browser, "p3");

      // Pick an ODD day-of-month in the CURRENT month, clamped <=27: the fixture seeds 16
      // appointments on even days 2-28 (mock-supabase.js:2001, three of them piled onto day 28
      // alone via its Math.min(28,...) cap), so a plain "today+10" collides with that pile-up
      // whenever it lands on day >=28 — exactly the R17 rule already applied to tests/r12b.js's
      // B5 ("never key a fixture date off raw Date.now() near a day boundary, and never reuse
      // the even-day appt-seed days"). An odd day is never seeded and staying in the current
      // month keeps the cell one the diary reliably renders without spilling past its 3-tile cap.
      const dstr = await page.evaluate(() => {
        const d = new Date();
        let dom = Math.min(27, d.getDate() + 10);
        if (dom % 2 === 0) dom += 1;
        d.setDate(dom);
        return localDateStr(d);
      });
      const apptA = await page.evaluate(async (d) => {
        const start = new Date(d + "T14:00");
        const end = new Date(d + "T14:45");
        const { data } = await window.__mockDb.from("appointments")
          .insert({ title: "Valn appt", staff_id: "p2", starts_at: start.toISOString(), ends_at: end.toISOString() })
          .select("id").single();
        return data.id;
      }, dstr);
      const apptB_other_adviser = await page.evaluate(async (d) => {
        const start = new Date(d + "T14:00");
        const end = new Date(d + "T14:45");
        const { data } = await window.__mockDb.from("appointments")
          .insert({ title: "P3 appt", staff_id: "p3", starts_at: start.toISOString(), ends_at: end.toISOString() })
          .select("id").single();
        return data.id;
      }, dstr);

      // Live clash notice — overlapping, SAME adviser.
      await page.evaluate(() => window.openAppt());
      await wait(page, 500);
      await page.fill('#appt-form [name="title"]', "Protection review");
      await page.fill('#appt-form [name="date"]', dstr);
      await page.fill('#appt-form [name="time"]', "14:30");
      await page.selectOption('#appt-form [name="staff_id"]', "p2");
      await wait(page, 600);
      const clashNote = await page.$eval("#appt-clash-note", (e) => ({ hidden: e.classList.contains("hidden"), text: e.textContent }));
      ok("D11 · the live clash notice fires for an overlapping SAME-adviser slot", !clashNote.hidden && clashNote.text.includes('Clashes with "Valn appt" (14:00–14:45)') && clashNote.text.includes("Wayne Kellow is already booked"), JSON.stringify(clashNote));

      const dialogsBefore = page.__dialogs.length;
      await page.click("#modal-save");
      await wait(page, 900);
      const saveDialog = page.__dialogs[dialogsBefore];
      ok("D11 · saving over the clash asks for confirmation, naming the clashing appointment's full range", saveDialog && saveDialog.message.includes('already has "Valn appt" (14:00–14:45)') && saveDialog.message.includes("overlaps it. Book anyway?"), JSON.stringify(saveDialog));
      const savedToast = await toastText(page);
      ok("D11 · the save toast says the new appointment was double-booked over it", savedToast.includes("double-booked over"), savedToast);

      // Back-to-back — starts exactly when the PREVIOUS save (Protection review, 14:30–15:30,
      // saved above) ends: NOT a clash (half-open interval). 15:30 rather than 14:45 because the
      // clash-confirm above was accepted, so p2 now ALSO holds Protection review 14:30–15:30 and a
      // 14:45 start would genuinely overlap that one.
      await page.evaluate(() => window.openAppt());
      await wait(page, 500);
      await page.fill('#appt-form [name="title"]', "Follow-up call");
      await page.fill('#appt-form [name="date"]', dstr);
      await page.fill('#appt-form [name="time"]', "15:30");
      await page.selectOption('#appt-form [name="staff_id"]', "p2");
      await wait(page, 600);
      const clashNote2 = await page.$eval("#appt-clash-note", (e) => e.classList.contains("hidden"));
      ok("D11 · back-to-back (starts exactly when the other ends) shows NO live clash", clashNote2 === true);
      const dialogsBefore2 = page.__dialogs.length;
      await page.click("#modal-save");
      await wait(page, 900);
      eq("D11 · ...and saving it fires no confirm at all", page.__dialogs.length, dialogsBefore2);
      const savedToast2 = await toastText(page);
      ok("D11 · ...the save toast has no double-booked wording", savedToast2.includes("Appointment saved") && !savedToast2.includes("double-booked"), savedToast2);

      // Month grid — the p2/p2 pair clashes; the p3 appointment at the same hour does not.
      await page.evaluate(() => window.nav("diary"));
      await wait(page, 700);
      await page.click("#diary-view-month");
      await page.selectOption("#diary-staff", "all");
      await wait(page, 900);
      const cards = await page.$$eval(`.diary-day[data-date="${dstr}"] .appt`, (els) => els.map((e) => ({
        title: (e.querySelector(".at") ? e.textContent : e.textContent).trim(),
        clash: e.classList.contains("clash"),
        tagTitle: (e.querySelector(".clash-tag") || {}).title || null,
      })));
      const valnCard = cards.find((c) => c.title.includes("Valn appt"));
      const p3Card = cards.find((c) => c.title.includes("P3 appt"));
      ok("D11 · the month grid flags the SAME-adviser clashing pair", valnCard && valnCard.clash && valnCard.tagTitle && valnCard.tagTitle.includes("Clashes with"), JSON.stringify(valnCard));
      ok("D11 · the month grid does NOT flag a different adviser at the same hour", p3Card && !p3Card.clash, JSON.stringify(p3Card));

      ok("D11 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       D12 · DONE, AND UNDONE (p2 Wayne)
       =================================================================== */
    {
      console.log("\n— D12 · task done/undo — toast action + case-modal reopen");
      const page = await newPage(browser, "p2");
      const { caseId } = await mkClientCase(page, { first: "Rufus", last: "Danforth", assigned_to: "p2" });
      const today = await page.evaluate(() => localDateStr());
      const taskId = await page.evaluate(async (o) => {
        const { data } = await window.__mockDb.from("case_tasks").insert({ case_id: o.caseId, title: "Chase ID docs", due_date: o.today, assigned_to: "p2" }).select("id").single();
        return data.id;
      }, { caseId, today });

      await page.evaluate((id) => window.openCase(id), caseId);
      await wait(page, 900);
      await page.click(`[onclick="doneTaskInCase('${taskId}','${caseId}')"]`);
      await wait(page, 600);
      const t1 = await page.evaluate(async (id) => (await window.__mockDb.from("case_tasks").select("done_at").eq("id", id).single()).data, taskId);
      ok("D12 · marking done stamps done_at", !!t1.done_at, JSON.stringify(t1));
      const toastMsg = await page.$eval("#toast .toast-msg", (e) => e.textContent).catch(() => null);
      const toastActionLabel = await page.$eval("#toast-action", (e) => e.textContent).catch(() => null);
      eq("D12 · the toast reads \"Task done\"", toastMsg, "Task done");
      eq("D12 · ...with an Undo action", toastActionLabel, "Undo");
      const reopenBtnAfterDone = await page.$$eval(`[onclick="reopenTaskInCase('${taskId}','${caseId}')"]`, (els) => els.length);
      eq("D12 · the case-modal row now shows a ↺ Reopen button in place of ✓", reopenBtnAfterDone, 1);

      await page.click("#toast-action");
      await wait(page, 600);
      const t2 = await page.evaluate(async (id) => (await window.__mockDb.from("case_tasks").select("done_at").eq("id", id).single()).data, taskId);
      eq("D12 · clicking Undo reverts done_at to null", t2.done_at, null);
      const doneBtnAfterUndo = await page.$$eval(`[onclick="doneTaskInCase('${taskId}','${caseId}')"]`, (els) => els.length);
      eq("D12 · ...and the case modal repaints back to a ✓ button", doneBtnAfterUndo, 1);

      // Now do it again, but reopen via the case modal's own button rather than the toast.
      await page.click(`[onclick="doneTaskInCase('${taskId}','${caseId}')"]`);
      await wait(page, 600);
      await page.click(`[onclick="reopenTaskInCase('${taskId}','${caseId}')"]`);
      await wait(page, 600);
      const t3 = await page.evaluate(async (id) => (await window.__mockDb.from("case_tasks").select("done_at").eq("id", id).single()).data, taskId);
      eq("D12 · reopening directly from the case modal (not the toast) also clears done_at", t3.done_at, null);
      const reopenToast = await toastText(page);
      eq("D12 · ...with its own confirmation toast", reopenToast, "Task reopened — it is back on the list");

      /* R41 · F1 — the Tasks-due drawer (#tasks-panel/#tasks-list) and window.doneTask are both
         gone; My Day's own tick (window.briefDone, briefActions' "✓ Done") is now the ONLY drawer
         path onto this task, and it repaints My Day alone (see snoozeRepaintAll/briefDone's own
         R41 comment in app.js — the dual-repaint premise this block used to exercise no longer
         applies because there is one list of tasks left, not two).
         A FRESH case, deliberately: My Day (unlike the old, ungrouped Tasks-due drawer) groups
         same-case rows into one, folding everything but the highest-priority item behind a
         "+N more" toggle (BUILD 7d, groupBriefRows) — reusing `caseId` (which already carries
         today's reopened "Chase ID docs" task) would fold this task's own row out of sight
         entirely, which is not what this check is testing. */
      const secondCase = await mkClientCase(page, { first: "Rufus", last: "SecondCase", assigned_to: "p2" });
      const taskId2 = await page.evaluate(async (o) => {
        const { data } = await window.__mockDb.from("case_tasks").insert({ case_id: o.caseId, title: "Confirm rate switch", due_date: o.today, assigned_to: "p2" }).select("id").single();
        return data.id;
      }, { caseId: secondCase.caseId, today });
      await page.evaluate(() => closeModal());   // the case modal from above is still open
      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, 900);
      const before = await page.$eval("#briefing-list", (e) => e.textContent);
      ok("D12 · the fresh task is on My Day before it is done", before.includes("Confirm rate switch"), before);
      await page.click(`[onclick="briefDone('${taskId2}')"]`);
      await wait(page, 700);
      const afterDone = await page.$eval("#briefing-list", (e) => e.textContent);
      ok("D12 · marking it done from My Day removes it from that list", !afterDone.includes("Confirm rate switch"), afterDone);
      await page.click("#toast-action");
      await wait(page, 700);
      const afterUndo = await page.$eval("#briefing-list", (e) => e.textContent);
      ok("D12 · Undo puts it straight back on My Day", afterUndo.includes("Confirm rate switch"), afterUndo);

      ok("D12 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r12a: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
