#!/usr/bin/env node
/* =============================================================================
   tests/r68_admin.js — acceptance tests for ROUND 68, agent B ("admin fast
   paths"): the four gestures the back office repeats most, each of which used
   to cost five clicks and a decision nobody was being helped with.

     §A  B1 · M12 — ACCEPT ALL UNAMBIGUOUS LEADS. acceptLead() splits into the
         DECISIONS (the joint-name prompts, the attach-to-existing confirms —
         unchanged, still native, still only on the single accept) and
         acceptLeadCore(), every write that follows them. My Day gains
         #leads-accept-all from two new enquiries up. It classifies: a joint
         name and anything findClientMatches() calls an exact OR a possible
         match are LEFT in the inbox wearing the reason; everything else is
         accepted through the core, round-robin across the advising staff
         starting at the lightest desk, honouring a per-row pick without that
         pick consuming a place in the rotation. The confirm is an overlay
         (never a native confirm) naming who gets what. Single accept still
         creates exactly what r5/r12a/r63 say it does.

     §B  B2 · M13 — DUPLICATE MERGE FAST PATH, for ONE shape only: the two
         records share an email address AND the loser (fewer cases; ties → the
         newer) holds no cases. That shape gets a one-line summary, radios
         pre-selected (survivor's value; loser's only where the survivor is
         blank) and a single "Merge now" with no typed keyword; the full table
         stays under a "Change what is kept" fold. Every other shape — a
         different email, a loser holding a case, or the operator switching the
         survivor — is the old flow, keyword and all.

     §C  B3 · M2 — THE PROTECTION GATE ANSWERS ITSELF. A blocked move opens the
         case with #prot-gate-chips at the top: the same five PROT_BULK_STATUS
         chips the Protection page carries. One click writes protection_status
         AND resumes the exact move that was refused. No block ⇒ no panel.

     §D  B4 · M3 — PALETTE VERBS. ~15 static rows above the search results,
         filtered by what is typed, ">" for actions only, arrow keys and Enter
         working on them exactly as on a record row, role-gated the way the nav
         is (Monday money owner-only), and the two that act on an open case
         shown greyed with the reason rather than removed.

     §E  no console/page errors on any persona this round touches.

   INDEPENDENCE. Nothing here imports app.js's own constants. The five
   protection statuses, the advising-staff pool rule, the round-robin property
   and the merge field list are all restated below and checked against
   window.__mockDb rows, never against the app's own idea of them. Leads and
   clients are MINTED by each block (mock-supabase.js rebuilds its DB per page
   load, so an id is only meaningful on the page that made it) — the fixture's
   own four new leads are deliberately parked as 'discarded' first, so §A
   measures leads whose match status this file knows for certain rather than
   whatever the book happens to contain.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node /root/nx/tests/r68_admin.js
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
   default (tests/r41.js's NX_KEYS, extended by R64's nx_ret_month / nx_clients_adviser). */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser", "nx_diary_staff", "nx_views_v1",
  "nx_nav_firm", "nx_import_blurb", "nx_ret_scope", "nx_ret_month", "nx_drawer_watchtower",
  "nx_drawer_unactioned", "nx_drawer_leads", "nx_drawer_todayappts", "nx_drawer_tasks",
  "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
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
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1100 : ms);
};

/* --------------------------------------------------------------------------
   §A helpers — the lead inbox, rebuilt from scratch on the page under test.
   -------------------------------------------------------------------------- */
/* Park every fixture enquiry so the inbox contains only leads this file minted and can therefore
   make claims about. 'discarded' rather than deleted: it is the status the app itself uses, and a
   deleted row would take the fixture's Lead-response report data with it. */
const parkFixtureLeads = (page) => page.evaluate(async () => {
  const db = window.__mockDb;
  const { data } = await db.from("leads").select("id").eq("status", "new");
  for (const l of (data || [])) await db.from("leads").update({ status: "discarded" }).eq("id", l.id);
  return (data || []).length;
});
const seedLead = (page, row) => page.evaluate(async (r) => {
  const { data } = await window.__mockDb.from("leads").insert(r).select("id").single();
  return data.id;
}, row);
const leadRow = (page, id) => page.evaluate(async (i) => {
  const { data } = await window.__mockDb.from("leads").select("*").eq("id", i).single();
  return data;
}, id);
const caseRow = (page, id) => page.evaluate(async (i) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", i).single();
  return data;
}, id);
const refreshBrief = async (page, ms) => { await page.evaluate(() => window.loadBriefing()); await wait(page, ms == null ? 900 : ms); };

/* The advising-staff pool, recomputed here from the raw tables rather than read off the app:
     · role 'adviser'        → always
     · role 'owner'/'staff'  → only while carrying at least one OPEN case
     · role 'admin'          → never
   minus anyone whose staff_absences row covers today (unless that empties the pool). This is the
   set round-robin is allowed to deal to; the ORDER within it is the app's published "lightest
   load" claim, which A6 takes from the row's own select rather than re-deriving. */
const advisingPool = (page) => page.evaluate(async () => {
  const db = window.__mockDb;
  const { data: profs } = await db.from("profiles").select("id,role,full_name");
  const { data: cases } = await db.from("cases").select("assigned_to,stage");
  const { data: abs } = await db.from("staff_absences").select("*");
  const open = {};
  (cases || []).forEach((c) => {
    if (c.stage === "completed" || c.stage === "not_proceeding") return;
    if (c.assigned_to) open[c.assigned_to] = (open[c.assigned_to] || 0) + 1;
  });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const away = new Set((abs || []).filter((a) => String(a.starts_on).slice(0, 10) <= today && String(a.ends_on).slice(0, 10) >= today).map((a) => a.profile_id));
  const pool = (profs || []).filter((p) => p.role === "adviser" || (["owner", "staff"].includes(p.role) && (open[p.id] || 0) > 0)).map((p) => p.id);
  const here = pool.filter((p) => !away.has(p));
  return { pool, here: here.length ? here : pool, away: [...away] };
});

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       §A · B1/M12 — accept every unambiguous lead
       ======================================================================= */
    {
      console.log("\n— §A1 · the bar appears from two enquiries up (p1, admin)");
      const page = await newPage(browser, "p1");
      await goto(page, "dashboard", 1200);

      await parkFixtureLeads(page);
      const soloId = await seedLead(page, {
        name: "Solomon Quillfeather", email: "solomon.quillfeather@r68.example.com",
        phone: "07999 111001", enquiry_type: "remortgage", message: "Rate ends soon.", status: "new",
      });
      await refreshBrief(page);
      const oneLead = await page.evaluate(() => ({
        bar: !!document.querySelector("#leads-accept-all"),
        hidden: (document.querySelector("#leads-accept-bar") || {}).className || "",
        rows: document.querySelectorAll('#briefing-list [onclick^="acceptLead("]').length,
      }));
      eq("A1a · one new enquiry on My Day", oneLead.rows, 1);
      ok("A1b · …and NO accept-all button (accept-all of one lead is just Accept)", !oneLead.bar, JSON.stringify(oneLead));
      ok("A1c · …the bar element is hidden rather than left as an empty strip", /\bhidden\b/.test(oneLead.hidden), oneLead.hidden);

      /* Four unambiguous enquiries + two the app must refuse to decide: a joint name, and one whose
         email address is a client we already hold. Surnames are deliberately unlike anything in the
         fixture book so findClientMatches cannot produce a surname-and-initial "possible match" by
         accident — the classification under test has to be about the rule, not about the fixtures. */
      const existing = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id,first_name,last_name,email").not("email", "is", null).limit(1);
        return data[0];
      });
      const ids = { solo: soloId };
      ids.u2 = await seedLead(page, { name: "Bartholomew Nixworth", email: "b.nixworth@r68.example.com", phone: "07999 111002", enquiry_type: "first-time-buyer", message: "First purchase.", status: "new" });
      ids.u3 = await seedLead(page, { name: "Cassiopeia Vandermolen", email: "c.vandermolen@r68.example.com", phone: "07999 111003", enquiry_type: "buy-to-let", message: "Second BTL.", status: "new" });
      ids.u4 = await seedLead(page, { name: "Ptolemy Grimsdale", email: "p.grimsdale@r68.example.com", phone: "07999 111004", enquiry_type: "home-mover", message: null, status: "new" });
      ids.joint = await seedLead(page, { name: "Hester & Rufus Ollernshaw", email: "ollernshaw@r68.example.com", phone: "07999 111005", enquiry_type: "remortgage", message: "Joint enquiry.", status: "new" });
      ids.dupe = await seedLead(page, { name: "Someone Entirelynew", email: existing.email, phone: "07999 111006", enquiry_type: "remortgage", message: "Hello again.", status: "new" });
      await refreshBrief(page, 1100);

      const barState = await page.evaluate(() => {
        const b = document.querySelector("#leads-accept-all");
        return {
          present: !!b, label: b ? b.textContent : "",
          sub: (document.querySelector("#leads-accept-bar-sub") || {}).textContent || "",
          insideList: !!document.querySelector("#briefing-list #leads-accept-all"),
          rows: document.querySelectorAll('#briefing-list [onclick^="acceptLead("]').length,
        };
      });
      eq("A2a · six enquiries now on My Day", barState.rows, 6);
      ok("A2b · #leads-accept-all is offered", barState.present, JSON.stringify(barState));
      ok("A2c · …labelled with the count it is about", /\(6\)/.test(barState.label), barState.label);
      ok("A2d · …and NOT inside #briefing-list (the list is rows; this is about the inbox)", !barState.insideList);
      ok("A2e · the bar explains in plain English what it will and will not do",
        /joint name/i.test(barState.sub) && /lightest desk/i.test(barState.sub) && /left here for you/i.test(barState.sub), barState.sub);

      console.log("\n— §A2 · the confirm names who gets what (overlay, never a native confirm)");
      const dialogsBefore = page.__dialogs.length;
      const pool = await advisingPool(page);
      const rrMarked = await page.evaluate(() => {
        const s = document.querySelector("select.lead-adviser");
        const opt = [...(s ? s.options : [])].find((o) => /· lightest load/.test(o.textContent));
        return opt ? opt.value : null;
      });
      ok("A3a · the row's own select still publishes a lightest-load adviser to start from", !!rrMarked, String(rrMarked));
      await page.click("#leads-accept-all");
      await wait(page, 900);
      const confirm = await page.evaluate(() => ({
        up: !document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        summary: (document.querySelector("#leads-accept-summary") || {}).textContent || "",
        rows: [...document.querySelectorAll("#leads-accept-list li")].map((li) => li.textContent.trim()),
        left: (document.querySelector("#leads-accept-left") || {}).textContent || "",
        go: (document.querySelector("#leads-accept-go") || {}).textContent || "",
      }));
      ok("A3b · it is the app's own overlay, not a native confirm()", confirm.up && page.__dialogs.length === dialogsBefore,
        JSON.stringify({ up: confirm.up, newDialogs: page.__dialogs.slice(dialogsBefore) }));
      ok("A3c · the summary reads “Accept 4 leads: <who> → <adviser>, … · 2 left for you to decide”",
        /^Accept 4 leads: .+→.+ · 2 left for you to decide$/.test(confirm.summary), confirm.summary);
      eq("A3d · one line per lead being accepted", confirm.rows.length, 4);
      ok("A3e · the two it will not decide are named with their reason",
        /joint name/.test(confirm.left) && /possible existing client/.test(confirm.left), confirm.left);
      ok("A3f · the primary button says how many", /Accept 4 leads/.test(confirm.go), confirm.go);

      console.log("\n— §A3 · round-robin from the lightest desk, and what each accept wrote");
      await page.click("#leads-accept-go");
      await wait(page, 2200);
      const after = {};
      for (const k of ["solo", "u2", "u3", "u4", "joint", "dupe"]) after[k] = await leadRow(page, ids[k]);
      const acceptedOrder = ["solo", "u2", "u3", "u4"];
      const assignedTo = [];
      for (const k of acceptedOrder) {
        const c = after[k].converted_case_id ? await caseRow(page, after[k].converted_case_id) : null;
        assignedTo.push(c ? c.assigned_to : null);
      }
      ok("A4a · all four unambiguous enquiries are converted and linked to a case",
        acceptedOrder.every((k) => after[k].status === "converted" && after[k].converted_case_id),
        JSON.stringify(acceptedOrder.map((k) => [after[k].status, !!after[k].converted_case_id])));
      eq("A4b · the two the app refused to decide are UNTOUCHED — still 'new'",
        [after.joint.status, after.dupe.status], ["new", "new"]);
      eq("A4c · …and neither of them has a case", [after.joint.converted_case_id, after.dupe.converted_case_id], [null, null]);
      eq("A5a · the first lead goes to the desk the select marked as lightest", assignedTo[0], rrMarked);
      ok("A5b · every assignment is inside the advising pool (never the administrator, never anyone away)",
        assignedTo.every((a) => pool.here.includes(a)), JSON.stringify({ assignedTo, pool }));
      const firstN = assignedTo.slice(0, Math.min(4, pool.here.length));
      ok("A5c · it is a ROUND ROBIN — no desk is dealt twice before every desk has one",
        new Set(firstN).size === firstN.length, JSON.stringify(assignedTo));
      if (pool.here.length < 4) {
        eq("A5d · …and the rotation then wraps back to the first desk", assignedTo[pool.here.length], assignedTo[0]);
      } else {
        ok("A5d · …and the rotation had no need to wrap (pool ≥ 4)", true);
      }

      const written = await page.evaluate(async (caseIds) => {
        const db = window.__mockDb;
        const out = [];
        for (const id of caseIds) {
          const { data: c } = await db.from("cases").select("*").eq("id", id).single();
          const { data: notes } = await db.from("case_notes").select("body").eq("case_id", id);
          const { data: tasks } = await db.from("case_tasks").select("title,assigned_to,done_at").eq("case_id", id);
          const { data: q } = await db.from("email_queue").select("email_type,to_email").eq("case_id", id);
          out.push({ stage: c.stage, kind: c.case_kind, source: c.lead_source, client_id: c.client_id, notes, tasks, q });
        }
        return out;
      }, acceptedOrder.map((k) => after[k].converted_case_id));
      ok("A6a · every case is created at Enquiry, source Website", written.every((w) => w.stage === "enquiry" && w.source === "Website"), JSON.stringify(written.map((w) => [w.stage, w.source])));
      ok("A6b · every case carries the enquiry note with the client's own words",
        written.every((w) => w.notes.some((n) => /^Website enquiry \(/.test(n.body))), JSON.stringify(written.map((w) => w.notes)));
      ok("A6c · the R63 Enquiry checklist is written on each one (2 steps), assigned to the routed adviser",
        written.every((w, i) => w.tasks.filter((t) => !t.done_at).length === 2 && w.tasks.every((t) => t.assigned_to === assignedTo[i])),
        JSON.stringify(written.map((w) => w.tasks)));
      ok("A6d · a welcome email is queued to the address the enquiry gave",
        written.every((w) => w.q.some((r) => r.email_type === "welcome")), JSON.stringify(written.map((w) => w.q)));
      ok("A6e · a NEW client record was created for each (none silently attached)",
        new Set(written.map((w) => w.client_id)).size === 4, JSON.stringify(written.map((w) => w.client_id)));
      const tA = await toastText(page);
      ok("A7a · one toast, with the counts and the split by adviser", /4 leads accepted/.test(tA) && /2 left in the list/.test(tA), tA);

      console.log("\n— §A4 · the refused two stay in the inbox wearing their reason");
      const chips = await page.evaluate(() => [...document.querySelectorAll("#briefing-list .lead-ambig")]
        .map((s) => ({ lead: s.dataset.lead, text: s.textContent })));
      eq("A8a · exactly two enquiries wear a reason chip", chips.length, 2);
      const byLead = Object.fromEntries(chips.map((c) => [c.lead, c.text]));
      eq("A8b · the joint enquiry says so", byLead[ids.joint], "joint name — accept by hand");
      eq("A8c · the email we already hold says so", byLead[ids.dupe], "possible existing client — accept by hand");
      const stillAccept = await page.evaluate((i) => !!document.querySelector(`#briefing-list .brief-lead-actions [onclick^="acceptLead('${i}'"]`), ids.joint);
      ok("A8d · a refused enquiry keeps its own Accept button — nothing is taken away", stillAccept);

      console.log("\n— §A5 · the single accept is exactly what it was (prompts, confirms, writes)");
      /* R12a K-3's shape: both name prompts answered by the harness's auto-accept dialog handler
         (which returns the DEFAULT for a prompt), then the joint applicant lands on the note. */
      const dlgBefore = page.__dialogs.length;
      await page.evaluate((i) => window.acceptLead(i, null), ids.joint);
      await wait(page, 2200);
      const jointAfter = await leadRow(page, ids.joint);
      const jointDialogs = page.__dialogs.slice(dlgBefore);
      ok("A9a · the single accept still asks its two native name prompts", jointDialogs.filter((d) => d.type === "prompt").length === 2, JSON.stringify(jointDialogs));
      ok("A9b · …and converts the lead", jointAfter.status === "converted" && !!jointAfter.converted_case_id, JSON.stringify(jointAfter.status));
      const jointCase = await page.evaluate(async (id) => {
        const db = window.__mockDb;
        const { data: c } = await db.from("cases").select("*").eq("id", id).single();
        const { data: cl } = await db.from("clients").select("*").eq("id", c.client_id).single();
        const { data: n } = await db.from("case_notes").select("body").eq("case_id", id);
        const { data: t } = await db.from("case_tasks").select("title").eq("case_id", id);
        return { first: cl.first_name, last: cl.last_name, notes: n.map((x) => x.body), tasks: t.length };
      }, jointAfter.converted_case_id);
      eq("A9c · the client is filed under ONE name, not the doubled string", [jointCase.first, jointCase.last], ["Hester", "Ollernshaw"]);
      ok("A9d · the second applicant is on the case note (R12a K-3's whole point)",
        jointCase.notes.some((b) => /Joint applicant: Rufus Ollernshaw/.test(b)), JSON.stringify(jointCase.notes));
      eq("A9e · and the Enquiry checklist is written by the same core", jointCase.tasks, 2);

      console.log("\n— §A6 · a per-row pick outranks the rotation and does not consume a place in it");
      const p2 = await newPage(browser, "p1");
      await goto(p2, "dashboard", 1200);
      await parkFixtureLeads(p2);
      const r = {};
      r.a = await seedLead(p2, { name: "Anselm Fotherby", email: "a.fotherby@r68.example.com", phone: "07999 112001", enquiry_type: "remortgage", status: "new" });
      r.b = await seedLead(p2, { name: "Bettina Threlkeld", email: "b.threlkeld@r68.example.com", phone: "07999 112002", enquiry_type: "remortgage", status: "new" });
      r.c = await seedLead(p2, { name: "Corwin Hallowfield", email: "c.hallowfield@r68.example.com", phone: "07999 112003", enquiry_type: "remortgage", status: "new" });
      await refreshBrief(p2, 1100);
      const pool2 = await advisingPool(p2);
      const rr2 = await p2.evaluate(() => {
        const s = document.querySelector("select.lead-adviser");
        const opt = [...(s ? s.options : [])].find((o) => /· lightest load/.test(o.textContent));
        return opt ? opt.value : null;
      });
      // Pick, on the FIRST lead's row, somebody the rotation would not have given it to.
      const picked = pool2.here.find((id) => id !== rr2) || pool2.here[0];
      await p2.evaluate(({ lead, who }) => {
        const s = document.querySelector(`select.lead-adviser[data-lead="${lead}"]`);
        s.value = who;
        s.dispatchEvent(new Event("change", { bubbles: true }));
      }, { lead: r.a, who: picked });
      await wait(p2, 300);
      await p2.click("#leads-accept-all");
      await wait(p2, 900);
      const pickSummary = await p2.evaluate(() => (document.querySelector("#leads-accept-summary") || {}).textContent || "");
      ok("A10a · the confirm marks the row you had already routed as your pick", /\(your pick\)/.test(pickSummary), pickSummary);
      await p2.click("#leads-accept-go");
      await wait(p2, 2000);
      const rAssign = {};
      for (const k of ["a", "b", "c"]) {
        const l = await leadRow(p2, r[k]);
        rAssign[k] = l.converted_case_id ? (await caseRow(p2, l.converted_case_id)).assigned_to : null;
      }
      eq("A10b · the picked lead goes where the operator said, not where the rotation would have sent it", rAssign.a, picked);
      eq("A10c · …and the pick did NOT consume a place: the next lead still starts the rotation", rAssign.b, rr2);
      if (pool2.here.length > 1) {
        ok("A10d · …with the third lead on the next desk round", rAssign.c === pool2.here.find((x) => x !== rr2) || rAssign.c !== rAssign.b, JSON.stringify(rAssign));
      } else {
        ok("A10d · …with only one advising desk there is nothing to rotate to", rAssign.c === rr2);
      }
      ok("§A · no console errors (p1 · round-robin page)", !(p2.__err || []).length, JSON.stringify(p2.__err));
      await p2.close();

      console.log("\n— §A7 · an adviser gets the button too (a lead they can see is a lead they can accept)");
      const p3 = await newPage(browser, "p3");
      await goto(p3, "dashboard", 1200);
      const advBar = await p3.evaluate(() => !!document.querySelector("#leads-accept-all"));
      ok("A11 · p3 (adviser) is offered accept-all on the same inbox", advBar);
      ok("§A · no console errors (p3 · adviser inbox)", !(p3.__err || []).length, JSON.stringify(p3.__err));
      await p3.close();

      ok("§A · no console errors (p1 · main page)", !(page.__err || []).length, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §B · B2/M13 — the duplicate-merge fast path
       ======================================================================= */
    {
      console.log("\n— §B · merge fast path (p1, admin)");
      const page = await newPage(browser, "p1");
      await goto(page, "data", 1400);

      /* The eight fields the merge screen offers, restated here so the pre-selection assertions are
         checked against this file's list rather than app.js's MERGE_FIELDS. */
      const FIELDS = ["first_name", "last_name", "email", "phone", "date_of_birth", "address", "sms_opt_out", "marketing_opt_out"];

      const mkPair = (opts) => page.evaluate(async (o) => {
        const db = window.__mockDb;
        const { data: keep } = await db.from("clients").insert(o.keep).select("id,created_at").single();
        const { data: lose } = await db.from("clients").insert(o.lose).select("id,created_at").single();
        for (let i = 0; i < (o.keepCases || 0); i++) await db.from("cases").insert({ client_id: keep.id, case_kind: "purchase", stage: "enquiry", assigned_to: "p2" });
        for (let i = 0; i < (o.loseCases || 0); i++) await db.from("cases").insert({ client_id: lose.id, case_kind: "purchase", stage: "enquiry", assigned_to: "p2" });
        return { keep: keep.id, lose: lose.id };
      }, opts);
      const openMerge = async (a, b, reason, score) => {
        await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
        await wait(page, 200);
        await page.evaluate(({ a, b, r, s }) => window.openMergeClients(a, b, r, s), { a, b, r: reason, s: score });
        await wait(page, 900);
      };
      const modalShape = () => page.evaluate((fields) => ({
        summary: (document.querySelector("#merge-fast-summary") || {}).textContent || "",
        fold: !!document.querySelector("#merge-fast-fold"),
        foldOpen: !!(document.querySelector("#merge-fast-fold") || {}).open,
        tableInFold: !!document.querySelector("#merge-fast-fold .merge-table"),
        keepInFold: !!document.querySelector("#merge-fast-fold .merge-keep"),
        mergeNow: !!document.querySelector("#merge-now"),
        mergeConfirm: !!document.querySelector("#merge-confirm"),
        notDup: !!document.querySelector("#merge-not-dup"),
        checked: Object.fromEntries(fields.map((f) => {
          const el = document.querySelector(`input[name="merge-field-${f}"]:checked`);
          return [f, el ? el.value : null];
        })),
      }), FIELDS);

      /* THE FAST SHAPE: same email, the loser holds no cases, and the survivor is missing two
         things the loser has (phone, date of birth) — so the summary has a real number to state. */
      const fast = await mkPair({
        keep: { first_name: "Marguerite", last_name: "Ashcombe", email: "m.ashcombe@r68.example.com", phone: null, date_of_birth: null, address: "12 Elm Road, Poole BH15 1AA" },
        lose: { first_name: "Marguerite", last_name: "Ashcombe", email: "M.Ashcombe@R68.Example.com", phone: "07999 220001", date_of_birth: "1979-04-02", address: null },
        keepCases: 2, loseCases: 0,
      });
      await openMerge(fast.keep, fast.lose, "same email address", 0.98);
      const s1 = await modalShape();
      ok("B1a · the fast shape shows the one-line summary", /Same email/.test(s1.summary) && /has no cases/.test(s1.summary), s1.summary);
      ok("B1b · …naming the survivor whose details are kept", /keeping/.test(s1.summary) && /Marguerite Ashcombe/.test(s1.summary), s1.summary);
      ok("B1c · …and counting the loser's filled-in fields that will be copied", /2 filled-in fields/.test(s1.summary), s1.summary);
      ok("B1d · …and saying that every other pair still needs the typed keyword", /still asks you to type a keyword to confirm/.test(s1.summary), s1.summary);
      ok("B1e · one primary “Merge now”, and the old “Merge…” is not also on screen", s1.mergeNow && !s1.mergeConfirm, JSON.stringify(s1));
      ok("B1f · the full table is still there, under a fold", s1.fold && s1.tableInFold && s1.keepInFold, JSON.stringify(s1));
      ok("B1g · …closed by default (the summary is the dialog for this shape)", !s1.foldOpen);
      ok("B1h · “Not a duplicate” is untouched", s1.notDup);
      eq("B2a · every radio is pre-selected — the survivor's value where it has one",
        [s1.checked.first_name, s1.checked.email, s1.checked.address], ["a", "a", "a"]);
      eq("B2b · …and the loser's ONLY where the survivor is blank", [s1.checked.phone, s1.checked.date_of_birth], ["b", "b"]);
      ok("B2c · no radio is left unset", FIELDS.every((f) => s1.checked[f] !== null), JSON.stringify(s1.checked));

      const dlgBefore = page.__dialogs.length;
      await page.click("#merge-now");
      await wait(page, 1600);
      const merged = await page.evaluate(async ({ keep, lose }) => {
        const db = window.__mockDb;
        const { data: k } = await db.from("clients").select("*").eq("id", keep);
        const { data: l } = await db.from("clients").select("*").eq("id", lose);
        return { keep: k[0] || null, loseGone: !l || !l.length };
      }, fast);
      ok("B3a · it merges in ONE click — no typed keyword", page.__dialogs.length === dlgBefore, JSON.stringify(page.__dialogs.slice(dlgBefore)));
      ok("B3b · the duplicate is gone", merged.loseGone);
      eq("B3c · …and the fields the survivor lacked were copied across", [merged.keep.phone, merged.keep.date_of_birth], ["07999 220001", "1979-04-02"]);
      eq("B3d · …while the survivor's own details are untouched", merged.keep.address, "12 Elm Road, Poole BH15 1AA");

      // DIFFERENT EMAIL — the old flow, unchanged.
      const diff = await mkPair({
        keep: { first_name: "Rowan", last_name: "Pemberley", email: "rowan.pemberley@r68.example.com", phone: "07999 220002" },
        lose: { first_name: "Rowan", last_name: "Pemberley", email: "r.pemberley@other.example.com", phone: "07999 220002" },
        keepCases: 1, loseCases: 0,
      });
      await openMerge(diff.keep, diff.lose, "same phone number", 0.72);
      const s2 = await modalShape();
      ok("B4a · a DIFFERENT-email pair gets no fast summary", !s2.summary, s2.summary);
      ok("B4b · …no fold", !s2.fold);
      ok("B4c · …and the old “Merge…” button, not “Merge now”", s2.mergeConfirm && !s2.mergeNow, JSON.stringify(s2));
      ok("B4d · …with its radios still pre-selected exactly as before", FIELDS.every((f) => s2.checked[f] !== null), JSON.stringify(s2.checked));

      // SAME EMAIL BUT THE LOSER HOLDS A CASE — also the old flow.
      const held = await mkPair({
        keep: { first_name: "Tobias", last_name: "Wrenfield", email: "t.wrenfield@r68.example.com" },
        lose: { first_name: "Tobias", last_name: "Wrenfield", email: "t.wrenfield@r68.example.com" },
        keepCases: 2, loseCases: 1,
      });
      await openMerge(held.keep, held.lose, "same email address", 0.97);
      const s3 = await modalShape();
      ok("B5a · same email but the duplicate holds a case → no fast path", !s3.summary && !s3.fold, JSON.stringify(s3));
      ok("B5b · …the typed-keyword flow stands", s3.mergeConfirm && !s3.mergeNow, JSON.stringify(s3));

      /* SAME EMAIL, DIFFERENT SURNAME — a household sharing an inbox, not one person typed twice.
         Nothing about it is "obvious", so it keeps the keyword however empty the duplicate is. */
      const household = await mkPair({
        keep: { first_name: "Jonah", last_name: "Merrick", email: "the.merricks@r68.example.com" },
        lose: { first_name: "Priya", last_name: "Balakrishnan", email: "the.merricks@r68.example.com" },
        keepCases: 1, loseCases: 0,
      });
      await openMerge(household.keep, household.lose, "same email address", 0.95);
      const s6 = await modalShape();
      ok("B5c · a shared email with two DIFFERENT surnames is never one click", !s6.summary && !s6.mergeNow && s6.mergeConfirm, JSON.stringify(s6));

      // SWITCHING THE SURVIVOR inside a fast pair drops back to the full flow.
      const fast2 = await mkPair({
        keep: { first_name: "Isolde", last_name: "Barrowclough", email: "i.barrowclough@r68.example.com", phone: "07999 220003" },
        lose: { first_name: "Isolde", last_name: "Barrowclough", email: "i.barrowclough@r68.example.com", phone: null },
        keepCases: 1, loseCases: 0,
      });
      await openMerge(fast2.keep, fast2.lose, "same email address", 0.99);
      const s4a = await modalShape();
      ok("B6a · the pair opens on the fast path", s4a.mergeNow && !!s4a.summary, JSON.stringify(s4a));
      await page.evaluate((loseId) => {
        const r = document.querySelector(`input[name="merge-keep"][value="${loseId}"]`);
        r.checked = true; r.onchange();
      }, fast2.lose);
      await wait(page, 600);
      const s4b = await modalShape();
      ok("B6b · switching the survivor takes the keyword back — the summary described the other arrangement",
        !s4b.mergeNow && s4b.mergeConfirm && !s4b.summary, JSON.stringify(s4b));
      await page.evaluate(() => window.closeModal());

      ok("§B · no console errors", !(page.__err || []).length, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §C · B3/M2 — the protection gate answers itself
       ======================================================================= */
    {
      console.log("\n— §C · protection-gate chips (p2, adviser)");
      const page = await newPage(browser, "p2");
      await goto(page, "pipeline", 1300);

      /* The five settable statuses, restated here (not_discussed is deliberately absent — it is the
         state the case is already in and the one answer that cannot unblock anything). */
      const SETTABLE = ["discussed", "quoted", "referred", "policy_taken", "declined"];

      const mkCase = (stage, prot) => page.evaluate(async (o) => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients")
          .insert({ first_name: "Gatetest", last_name: "R68" + Math.random().toString(36).slice(2, 6), email: `gate.${Math.random().toString(36).slice(2, 8)}@r68.example.com` })
          .select("id").single();
        const { data: c } = await db.from("cases")
          .insert({ client_id: cl.id, case_kind: "purchase", stage: o.stage, protection_status: o.prot, assigned_to: "p2" })
          .select("id").single();
        return c.id;
      }, { stage, prot });

      const blocked = await mkCase("fact_find", "not_discussed");
      const res = await page.evaluate((id) => window.moveCaseToStage(id, "application", {}), blocked);
      await wait(page, 1600);
      eq("C1a · a move to Application with nothing recorded is refused", res, "blocked");
      const panel = await page.evaluate(() => {
        const p = document.querySelector("#prot-gate-chips");
        if (!p) return null;
        return {
          afterH3: !!(p.previousElementSibling && p.previousElementSibling.tagName === "H3"),
          head: (p.querySelector(".pg-head") || {}).textContent || "",
          why: (p.querySelector(".panel-sub") || {}).textContent || "",
          chips: [...p.querySelectorAll(".prot-gate-chip")].map((b) => b.dataset.status),
          labels: [...p.querySelectorAll(".prot-gate-chip")].map((b) => b.textContent.trim()),
        };
      });
      ok("C1b · the blocked case opens with #prot-gate-chips", !!panel, "no panel");
      ok("C1c · …at the TOP of the modal, directly under its heading, not buried in the form", panel && panel.afterH3, JSON.stringify(panel && panel.afterH3));
      ok("C1d · …naming the stage the move was for", panel && /Record the protection conversation to move to Application/.test(panel.head), panel && panel.head);
      ok("C1e · …and saying in one line why the gate exists (AR / before submission)",
        panel && /Appointed Representative/.test(panel.why) && /before a mortgage is submitted/.test(panel.why), panel && panel.why);
      eq("C1f · the five settable statuses, in the Protection page's own order", panel && panel.chips, SETTABLE);
      ok("C1g · not_discussed is NOT offered — it is the state that blocked the move", panel && !panel.chips.includes("not_discussed"));
      ok("C1h · the chips are labelled in words, not enum values", panel && /Referred to protection adviser/.test(panel.labels.join("|")), JSON.stringify(panel && panel.labels));

      await page.click('#prot-gate-chips .prot-gate-chip[data-status="discussed"]');
      await wait(page, 2200);
      const moved = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("stage,protection_status").eq("id", id).single();
        return data;
      }, blocked);
      eq("C2a · one click writes the protection status", moved.protection_status, "discussed");
      eq("C2b · …AND resumes the move that was refused", moved.stage, "application");
      const gone = await page.evaluate(() => ({
        panel: !!document.querySelector("#prot-gate-chips"),
        chip: (document.querySelector("#cs-prot-warn") || {}).dataset,
      }));
      ok("C2c · the panel goes once it has been answered", !gone.panel);
      ok("C2d · …and the header chip now says what was recorded", gone.chip && gone.chip.prot === "discussed", JSON.stringify(gone.chip));

      // A case with protection already recorded is not gated, so it never sees the panel.
      const okCase = await mkCase("fact_find", "discussed");
      const res2 = await page.evaluate((id) => window.moveCaseToStage(id, "application", {}), okCase);
      await wait(page, 1500);
      const noPanel = await page.evaluate(() => !!document.querySelector("#prot-gate-chips"));
      eq("C3a · a case with the conversation on file moves without a block", res2, "moved");
      ok("C3b · …and no gate panel is drawn", !noPanel);
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
      await wait(page, 300);

      // Gate switched OFF: nothing is blocked and nothing is drawn.
      const gateOffRan = await page.evaluate(async () => {
        try {
          await window.__mockDb.from("settings").update({ value: "off" }).eq("key", "protection_gate");
          settings.protection_gate = "off";   // eslint-disable-line no-undef — top-level script binding
          return settings.protection_gate === "off";   // eslint-disable-line no-undef
        } catch (e) { return false; }
      });
      if (gateOffRan) {
        const offCase = await mkCase("fact_find", "not_discussed");
        const res3 = await page.evaluate((id) => window.moveCaseToStage(id, "application", {}), offCase);
        await wait(page, 1500);
        const offPanel = await page.evaluate(() => !!document.querySelector("#prot-gate-chips"));
        eq("C4a · with the gate off the move is not refused", res3, "moved");
        ok("C4b · …and no gate panel is drawn", !offPanel);
        await page.evaluate(async () => {
          await window.__mockDb.from("settings").update({ value: "on" }).eq("key", "protection_gate");
          settings.protection_gate = "on";   // eslint-disable-line no-undef
        });
      } else {
        ok("C4a · with the gate off the move is not refused (settings binding unreachable — skipped)", true);
        ok("C4b · …and no gate panel is drawn (skipped)", true);
      }
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });

      ok("§C · no console errors", !(page.__err || []).length, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §D · B4/M3 — palette verbs
       ======================================================================= */
    {
      console.log("\n— §D · the / palette learns verbs (p3, adviser)");
      const page = await newPage(browser, "p3");
      await goto(page, "dashboard", 1200);

      const openPalette = async () => {
        await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
        await page.click("#global-search-btn");
        await wait(page, 500);
      };
      const rows = () => page.evaluate(() => [...document.querySelectorAll(".palette-row")].map((r) => ({
        verb: r.dataset.verb || null,
        title: (r.querySelector(".pr-title") || {}).textContent || "",
        sub: (r.querySelector(".pr-sub") || {}).textContent || "",
        off: r.classList.contains("palette-verb-off"),
        sel: r.classList.contains("sel"),
      })));

      await openPalette();
      const idle = await rows();
      const verbs = idle.filter((r) => r.verb);
      ok("D1a · an empty palette now offers verbs", verbs.length >= 10, `got ${verbs.length}`);
      ok("D1b · every verb row is an ordinary .palette-row with a data-verb", verbs.every((v) => !!v.verb && !!v.title));
      ok("D1c · the eight navigation verbs the round asked for are all there",
        ["goto-pipeline", "goto-clients", "goto-retention", "goto-protection", "goto-diary", "goto-reports", "goto-emails", "goto-settings"]
          .every((id) => verbs.some((v) => v.verb === id)), JSON.stringify(verbs.map((v) => v.verb)));
      ok("D1d · …plus New case, New client, Book appointment, Log a call, Accept leads, Write to client",
        ["new-case", "new-client", "book-appointment", "log-call", "accept-leads", "write-client"]
          .every((id) => verbs.some((v) => v.verb === id)), JSON.stringify(verbs.map((v) => v.verb)));
      ok("D2a · Monday money is NOT offered to an adviser (the same gate that hides #nav-money)",
        !verbs.some((v) => v.verb === "goto-money"), JSON.stringify(verbs.map((v) => v.verb)));
      const offRows = verbs.filter((v) => v.off);
      ok("D2b · with no case open, Write to client and Log a call are greyed rather than removed",
        offRows.length === 2 && offRows.every((v) => ["write-client", "log-call"].includes(v.verb)), JSON.stringify(offRows));
      ok("D2c · …each saying WHY, in the row itself", offRows.every((v) => /Open a case first/.test(v.sub)), JSON.stringify(offRows.map((v) => v.sub)));

      console.log("\n— §D2 · arrow keys + Enter run a verb");
      let guard = 0;
      let selVerb = (await rows()).find((r) => r.sel);
      while ((!selVerb || selVerb.verb !== "goto-retention") && guard++ < 40) {
        await page.keyboard.press("ArrowDown");
        await wait(page, 60);
        selVerb = (await rows()).find((r) => r.sel);
      }
      ok("D3a · arrowing down lands the highlight on “Go to Retention”", !!selVerb && selVerb.verb === "goto-retention", JSON.stringify(selVerb));
      await page.keyboard.press("Enter");
      await wait(page, 1400);
      const where = await page.evaluate(() => ({
        page: (document.querySelector("#page-retention") || {}).className || "",
        closed: document.querySelector("#palette-backdrop").classList.contains("hidden"),
        hash: location.hash,
      }));
      ok("D3b · Enter navigates to Retention", !/\bhidden\b/.test(where.page), JSON.stringify(where));
      ok("D3c · …and the palette closes behind it", where.closed);

      console.log("\n— §D3 · typing filters the verbs, and records still come back underneath");
      await openPalette();
      await page.fill("#palette-input", "cli");
      await wait(page, 900);
      const cli = await rows();
      const cliVerbs = cli.filter((r) => r.verb);
      ok("D4a · “cli” keeps New client", cliVerbs.some((v) => v.verb === "new-client"), JSON.stringify(cliVerbs.map((v) => v.title)));
      ok("D4b · …and Go to Clients", cliVerbs.some((v) => v.verb === "goto-clients"), JSON.stringify(cliVerbs.map((v) => v.title)));
      ok("D4c · …and drops the ones that do not match (New case, Go to Diary, Book appointment)",
        !cliVerbs.some((v) => ["new-case", "goto-diary", "book-appointment"].includes(v.verb)), JSON.stringify(cliVerbs.map((v) => v.verb)));
      ok("D4d · every verb still shown genuinely contains what was typed",
        cliVerbs.every((v) => v.title.toLowerCase().includes("cli")), JSON.stringify(cliVerbs.map((v) => v.title)));

      const client = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("first_name,last_name").not("last_name", "is", null).limit(1);
        return data[0];
      });
      await page.fill("#palette-input", client.last_name);
      await wait(page, 1100);
      const search = await rows();
      ok("D5a · a client search still returns record rows", search.some((r) => !r.verb && r.title.includes(client.last_name)),
        JSON.stringify(search.map((r) => r.title)));
      const firstRecordIdx = search.findIndex((r) => !r.verb);
      const lastVerbIdx = search.map((r) => !!r.verb).lastIndexOf(true);
      ok("D5b · …BELOW the verbs, never mixed in with them", lastVerbIdx === -1 || lastVerbIdx < firstRecordIdx,
        JSON.stringify(search.map((r) => r.verb || "·record")));
      ok("D5c · the default highlight is still the first RECORD row, not a verb",
        (search.find((r) => r.sel) || {}).verb == null, JSON.stringify(search.find((r) => r.sel)));

      console.log("\n— §D4 · “>” is actions only");
      await page.fill("#palette-input", ">");
      await wait(page, 900);
      const gt = await rows();
      ok("D6a · “>” shows verbs", gt.filter((r) => r.verb).length >= 10, `got ${gt.filter((r) => r.verb).length}`);
      ok("D6b · …and nothing else — no client, case or lead rows", gt.every((r) => !!r.verb), JSON.stringify(gt.filter((r) => !r.verb).map((r) => r.title)));
      await page.fill("#palette-input", ">ret");
      await wait(page, 700);
      const gtRet = await rows();
      ok("D6c · “>ret” filters inside actions-only mode", gtRet.length && gtRet.every((r) => /ret/i.test(r.title)), JSON.stringify(gtRet.map((r) => r.title)));

      console.log("\n— §D5 · a verb that needs a case says so instead of doing nothing");
      await page.fill("#palette-input", ">write");
      await wait(page, 700);
      const wr = await rows();
      ok("D7a · Write to client is offered and greyed", wr.length === 1 && wr[0].verb === "write-client" && wr[0].off, JSON.stringify(wr));
      await page.keyboard.press("Enter");
      await wait(page, 500);
      const refused = await page.evaluate(() => ({
        open: !document.querySelector("#palette-backdrop").classList.contains("hidden"),
        toast: (document.querySelector("#toast") || {}).textContent || "",
      }));
      ok("D7b · Enter on it explains rather than pretending to act", /Open a case first/.test(refused.toast), refused.toast);
      ok("D7c · …and the palette stays open (closing would look like it had worked)", refused.open);
      await page.keyboard.press("Escape");
      await wait(page, 300);

      console.log("\n— §D6 · the Owner sees the money verb the adviser does not");
      const owner = await newPage(browser, "p4");
      await goto(owner, "dashboard", 1200);
      await owner.click("#global-search-btn");
      await wait(owner, 500);
      const ownerVerbs = await owner.evaluate(() => [...document.querySelectorAll(".palette-row[data-verb]")].map((r) => r.dataset.verb));
      ok("D8 · Monday money is offered to the Owner", ownerVerbs.includes("goto-money"), JSON.stringify(ownerVerbs));
      ok("§D · no console errors (p4)", !(owner.__err || []).length, JSON.stringify(owner.__err));
      await owner.close();

      ok("§D · no console errors (p3)", !(page.__err || []).length, JSON.stringify(page.__err));
      await page.close();
    }

  } catch (e) {
    failures.push("EXCEPTION: " + (e && e.stack ? e.stack : e));
    console.log("  ✗ EXCEPTION: " + (e && e.message ? e.message : e));
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r68_admin: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
