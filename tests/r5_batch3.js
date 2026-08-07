#!/usr/bin/env node
/* =============================================================================
   tests/r5_batch3.js — acceptance tests for PLAN-R5 Batch 3
   ("Today, retention, client record")

   One block per plan item:
     1. R5-6  retention tells the truth about what creates these cases, and the
              already-ended rates get a manual "Start retention case" that
              replicates queue_automated_emails() for one case — queued, not sent.
     2. R5-9  a plain-titled appointment in My Day names the client (and does not
              double up a name someone already typed into the title).
     3. R5-25 two appointments in the same slot for the same adviser are flagged
              ⚠ / "double-booked" in My Day, not just in the diary.
     4. R5-28 with no bank details there is no dead-end "Chase fee" button — one
              explanatory badge instead, and the Owner gets a way to fix it.
     5. R5-35 "Mine" means mine: an ownerless task is invisible under Mine and
              labelled "unassigned" under All.
     6. R5-48 the appointment modal opens the client and the case it is about.
     7. R5-16 client-timeline rows are tagged by CASE (kind · lender), not kind.
     8. R5-53 a note added in the client timeline carries its author chip at once.
     9. R5-54 a task can be handed back to the Unassigned queue.

   Run:  node /root/nx/tests/r5_batch3.js  (expects a static server on 8099;
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

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
    r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}

/* Confirms are load-bearing here (the retention dialog names what it will create), so every page
   records what it was asked and answers from a plan; __dialogAnswer is the fallback. */
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
const lastDialog = (page, re) => (page.__dialogs.filter((d) => re.test(d.message)).slice(-1)[0] || {}).message || "";
/* The Today drawers open collapsed (autoDrawer) — a test that wants to click inside one opens it
   the same way a person would. */
const openDrawer = async (page, panelId) => {
  const collapsed = await page.evaluate((p) => document.querySelector(p).classList.contains("collapsed"), panelId);
  // Click the heading TEXT, not its inline scope buttons (toggleDrawer ignores button clicks).
  if (collapsed) { await page.click(`${panelId} h3`, { position: { x: 12, y: 10 } }); await page.waitForTimeout(300); }
};

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore", detached: true });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       1 · R5-6 — retention: match the live backend, add the manual path
       =================================================================== */
    console.log("\n— R5-6 · retention (p1 Kim)");
    {
      const page = await newPage(browser, "p1");

      const copy = await page.evaluate(() => document.querySelector("#retention-stats").textContent);
      ok("R5-6 · the stats line no longer claims nothing creates these", !/Nothing creates these/i.test(copy), copy);
      ok("R5-6 · it says the backend creates them automatically", /Created automatically when a completed client's rate enters the reminder window/.test(copy), copy);
      ok("R5-6 · …and names the manual path for rates already past", /open the case and press Start retention case/.test(copy), copy);

      /* Fixture check — ca018 (Kwame Boateng) is completed, his rate ended months ago (so the
         nightly RPC will never pick it up) and he has no successor yet. */
      const fixture = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,stage,lender,rate_end_date,rate_reminder_queued_at,client_id,assigned_to,retention_source_case_id");
        const src = data.find((c) => c.id === "ca018");
        const sources = new Set(data.filter((c) => c.retention_source_case_id).map((c) => c.retention_source_case_id));
        const alreadyLinked = data.find((c) => c.stage === "completed" && sources.has(c.id));
        return {
          stage: src.stage, ended: src.rate_end_date < new Date().toISOString().slice(0, 10),
          /* the source's own rate-end date, read at run time. The fixtures are
             seeded relative to "now", so any literal date here is only ever
             right on the day it was written down. */
          rateEnd: src.rate_end_date,
          lender: src.lender,
          queued: src.rate_reminder_queued_at, adviser: src.assigned_to,
          openRetention: data.filter((c) => c.retention_source_case_id && !["completed", "not_proceeding"].includes(c.stage)).length,
          alreadyLinkedId: alreadyLinked ? alreadyLinked.id : null,
          sentBefore: null,
        };
      });
      ok("fixture · ca018 is completed with a rate that has already ended and no reminder", fixture.stage === "completed" && fixture.ended && fixture.queued === null, JSON.stringify(fixture));
      eq("fixture · the retention KPI starts at 2 open", fixture.openRetention, 2);

      /* the button is offered in the case modal … */
      await page.evaluate(() => window.openCase("ca018"));
      await page.waitForTimeout(700);
      ok("R5-6 · the completed case's header offers Start retention case", await page.evaluate(() => !!document.querySelector("#cs-retention-btn")));
      await page.evaluate(() => window.closeModal());
      await page.waitForTimeout(300);

      /* … and absent where a successor already exists */
      if (fixture.alreadyLinkedId) {
        await page.evaluate((cid) => window.openCase(cid), fixture.alreadyLinkedId);
        await page.waitForTimeout(700);
        ok("R5-6 · no button on a case that already has a retention case", await page.evaluate(() => !document.querySelector("#cs-retention-btn")));
        await page.evaluate(() => window.closeModal());
        await page.waitForTimeout(300);
      } else ok("R5-6 · fixture has a case with an existing successor", false, "none found");

      const sentBefore = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id,status")).data.filter((e) => e.status === "sent").length);

      /* … and on the Rate & ERC row */
      await openDrawer(page, "#rate-erc-panel");
      const hasRowBtn = await page.evaluate(() => document.querySelector("#alerts-rateerc").innerHTML.indexOf("startRetentionCase('ca018'") >= 0);
      ok("R5-6 · the Rate & ERC row offers it too", hasRowBtn);
      await page.click("#alerts-rateerc button.btn-retention[onclick*=\"'ca018'\"]");
      await page.waitForTimeout(2200);

      const dlg = lastDialog(page, /retention case for/i);
      ok("R5-6 · the confirm names the client and everything it will create",
        /Kwame Boateng/.test(dlg) && /Enquiry/.test(dlg) && /Call client — rate ends/.test(dlg) && /QUEUED/.test(dlg) && /nothing is sent now/.test(dlg), JSON.stringify(dlg));

      const after = await page.evaluate(async (sentBefore) => {
        const db = window.__mockDb;
        const { data: cases } = await db.from("cases").select("*");
        const succ = cases.find((c) => c.retention_source_case_id === "ca018");
        const { data: tasks } = await db.from("case_tasks").select("*").eq("case_id", succ ? succ.id : "__none__");
        const { data: notes } = await db.from("case_notes").select("*").eq("case_id", succ ? succ.id : "__none__");
        const { data: q } = await db.from("email_queue").select("*").eq("case_id", succ ? succ.id : "__none__");
        const { data: all } = await db.from("email_queue").select("id,status");
        const src = cases.find((c) => c.id === "ca018");
        return {
          succ: succ ? { id: succ.id, stage: succ.stage, kind: succ.case_kind, adviser: succ.assigned_to, lender: succ.lender, rate: succ.rate_end_date, source: succ.retention_source_case_id } : null,
          tasks: tasks.map((t) => ({ title: t.title, due: t.due_date, who: t.assigned_to })),
          noteBodies: notes.map((n) => n.body),
          queued: q.map((e) => ({ type: e.email_type, status: e.status, sent: e.sent_at })),
          srcStamped: !!src.rate_reminder_queued_at,
          openRetention: cases.filter((c) => c.retention_source_case_id && !["completed", "not_proceeding"].includes(c.stage)).length,
          statsLine: document.querySelector("#retention-stats").textContent,
          rowBtnGone: document.querySelector("#alerts-rateerc").innerHTML.indexOf("startRetentionCase('ca018'") < 0,
          sentDelta: all.filter((e) => e.status === "sent").length - sentBefore,
        };
      }, sentBefore);

      ok("R5-6 · a linked enquiry case now exists", !!after.succ && after.succ.stage === "enquiry" && after.succ.source === "ca018", JSON.stringify(after.succ));
      /* The property is "the successor inherits the SOURCE's lender, rate-end date and adviser",
         so every side of it is read from the source case at run time. It used to assert the
         literal 2026-03-17, which is simply what ca018's NOW-relative rate_end_date happened to
         evaluate to on the day the test was written. */
      ok("R5-6 · it carries the source's lender / rate-end and its adviser",
        !!after.succ && after.succ.lender === fixture.lender && after.succ.rate === fixture.rateEnd && after.succ.adviser === fixture.adviser,
        JSON.stringify({ got: after.succ, want: { lender: fixture.lender, rate: fixture.rateEnd, adviser: fixture.adviser } }));
      eq("R5-6 · the call task was created, dated and assigned", after.tasks.map((t) => [t.title.slice(0, 11), t.who]), [["Call client", fixture.adviser]]);
      ok("R5-6 · a task due date is never in the past", after.tasks[0] && after.tasks[0].due > new Date().toISOString().slice(0, 10), JSON.stringify(after.tasks));
      ok("R5-6 · the case history says where the case came from", after.noteBodies.some((b) => /Retention case started from the completed case/.test(b)), JSON.stringify(after.noteBodies));
      eq("R5-6 · exactly one rate-end reminder exists, QUEUED and unsent", after.queued, [{ type: "rate_end_reminder", status: "queued", sent: null }]);
      eq("R5-6 · nothing was sent (R5-1 discipline)", after.sentDelta, 0);
      ok("R5-6 · the source case stops nagging (rate_reminder_queued_at stamped)", after.srcStamped);
      eq("R5-6 · the retention KPI moved 2 open → 3 open", after.openRetention, 3);
      ok("R5-6 · the stats line repainted", /^3 open/.test(after.statsLine), after.statsLine);
      ok("R5-6 · the button has gone from the Rate & ERC row", after.rowBtnGone);

      /* the successor is recognisable as a retention case, and the source's My Day nag has gone */
      await page.evaluate((cid) => window.openCase(cid), after.succ.id);
      await page.waitForTimeout(700);
      const succModal = await page.evaluate(() => document.querySelector("#modal").innerText);
      ok("R5-6 · the new case is badged 🔁 Retention opportunity", /🔁 Retention opportunity/.test(succModal), succModal.slice(0, 120));
      await page.evaluate(() => window.closeModal());
      await page.waitForTimeout(400);
      const nagGone = await page.evaluate(() => document.querySelector("#briefing-list").innerHTML.indexOf("briefQueueEmail('ca018'") < 0);
      ok("R5-6 · My Day no longer offers a bare Send reminder on the source case", nagGone);

      /* RES-1 — the dedupe was a non-atomic check-then-insert guarded only by a per-DOM-button
         btn.disabled, so the same case fired from two surfaces (or the ev-null bulk/programmatic
         path) raced through and produced TWO successors + two client reminders. The in-flight lock
         keyed by source caseId must let ONLY ONE of two concurrent silent starts through. */
      const conc = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cases } = await db.from("cases").select("*");
        const sources = new Set(cases.filter((c) => c.retention_source_case_id).map((c) => c.retention_source_case_id));
        const cand = cases.find((c) => c.stage === "completed" && c.rate_end_date && !sources.has(c.id) && c.id !== "ca018");
        if (!cand) return { err: "no eligible completed case for the concurrency probe" };
        const [a, b] = await Promise.all([
          window.startRetentionCase(cand.id, null, { silent: true }),
          window.startRetentionCase(cand.id, null, { silent: true }),
        ]);
        const { data: after } = await db.from("cases").select("id,retention_source_case_id");
        const { data: q } = await db.from("email_queue").select("case_id,email_type");
        const succIds = after.filter((c) => c.retention_source_case_id === cand.id).map((c) => c.id);
        return {
          candId: cand.id,
          successors: succIds.length,
          statuses: [a && a.status, b && b.status].sort(),
          reminders: q.filter((e) => succIds.includes(e.case_id) && e.email_type === "rate_end_reminder").length,
        };
      });
      ok("RES-1 · two concurrent silent starts create exactly ONE successor", conc.successors === 1, JSON.stringify(conc));
      eq("RES-1 · one start is refused as busy, the other created", conc.statuses, ["busy", "created"]);
      ok("RES-1 · only one client rate-end reminder is queued (no duplicate email)", conc.reminders <= 1, JSON.stringify(conc));

      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       2 · R5-9  — appointments name the client
       3 · R5-25 — clash flag in My Day
       =================================================================== */
    console.log("\n— R5-9/R5-25 · My Day appointments (p2 Wayne)");
    {
      const page = await newPage(browser, "p2");
      const rows = await page.evaluate(() => [...document.querySelectorAll("#briefing-list .brief-row")]
        .filter((r) => /APPT/.test(r.innerText))
        .map((r) => ({ title: r.querySelector(".t").textContent.trim(), tip: r.querySelector(".t").getAttribute("title") || "" })));

      const marcus = rows.find((r) => /Marcus Bell/.test(r.title));
      ok("R5-9 · a plain-titled appointment names the client", !!marcus && /^Protection review — Marcus Bell/.test(marcus.title), JSON.stringify(rows));
      const ruby = rows.find((r) => /Ruby Sinclair/.test(r.title));
      ok("R5-9 · a title that already has the name is not doubled up",
        !!ruby && (ruby.title.match(/Ruby Sinclair/g) || []).length === 1, ruby && ruby.title);

      const clashing = rows.filter((r) => /^⚠/.test(r.title));
      eq("R5-25 · exactly the two 10:00 appointments are flagged", clashing.length, 2);
      ok("R5-25 · both flagged rows explain themselves on hover", clashing.every((r) => r.tip === "double-booked"), JSON.stringify(clashing));
      ok("R5-25 · the 14:00 appointment is not flagged", marcus && !/^⚠/.test(marcus.title) && marcus.tip !== "double-booked", JSON.stringify(marcus));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       4 · R5-28 — no dead-end Chase fee
       =================================================================== */
    console.log("\n— R5-28 / R12b·W-19 · the fee-chase gate (p2 adviser, p4 owner)");
    {
      const page = await newPage(browser, "p2");
      /* R12b · W-19 — with bank details missing, a fee_chase row is now WITHHELD ENTIRELY from an
         adviser (not shown-but-disabled, as R5-28 originally had it): "a row with nothing an
         adviser can do to it is not a row". Ground truth is the RAW get_briefing RPC output,
         scoped "mine" server-side exactly as the app's own default scope is — read directly, before
         the app's own client-side W-19 filter runs — so the check proves the row is genuinely being
         withheld, not merely absent for lack of data. */
      const state = await page.evaluate(async () => {
        // R5-35's rule (below, in this same file): "mine" means owner === me, strictly — the RPC's
        // own p_scope:"mine" is laxer (it also hands back ownerless rows, the way lead_new alone is
        // meant to survive app.js's own post-filter), so p_scope:"all" is read here and then the
        // exact same narrowing app.js applies is redone independently.
        const { data: raw } = await window.__mockDb.rpc("get_briefing", { p_scope: "all" });
        const rawFeeChase = (raw || []).filter((r) => r.kind === "fee_chase" && r.owner === "p2");
        const rows = [...document.querySelectorAll("#briefing-list .brief-row")].filter((r) => /\bFEE\b/.test(r.innerText));
        return {
          rawFeeChaseCount: rawFeeChase.length,
          feeRows: rows.length,
          chaseButtons: rows.filter((r) => /Chase fee/.test(r.innerText)).length,
          badges: rows.filter((r) => /fee requests blocked — no bank details/.test(r.innerText)).length,
        };
      });
      ok("fixture · the RPC itself still has fee-chase rows for this adviser's book (proves W-19 is withholding, not lacking data)", state.rawFeeChaseCount > 0, JSON.stringify(state));
      eq("R12b · W-19 an adviser with missing bank details sees NO fee-chase rows at all — not shown-and-disabled", state.feeRows, 0);
      eq("R12b · W-19 …so there are no dead-end Chase fee buttons either", state.chaseButtons, 0);
      eq("R12b · W-19 …and no blocked-badge rows either — the row itself is gone, not just its button", state.badges, 0);

      /* with the details set, the rows (and their Chase fee buttons) return — this half is R5-28's
         original behaviour and is unchanged by W-19 (same page, so the fixture DB survives). */
      await page.evaluate(() => {
        window.__mock.db.settings.forEach((s) => {
          if (s.key === "bank_account_name") s.value = "NexMoney Ltd";
          if (s.key === "bank_sort_code") s.value = "20-00-00";
          if (s.key === "bank_account_number") s.value = "12345678";
        });
      });
      await page.click('#topnav button[data-page="pipeline"]');
      await page.waitForTimeout(600);
      await page.click('#topnav button[data-page="dashboard"]');
      await page.waitForTimeout(SETTLE + 500);
      const restored = await page.evaluate(() => {
        const allRows = [...document.querySelectorAll("#briefing-list .brief-row")];
        const rows = allRows.filter((r) => /\bFEE\b/.test(r.innerText));
        // groupBriefRows folds a case's other items behind "+N more: <kind> · <kind>" when a
        // higher-priority item (e.g. an overdue task) on the SAME case wins the row — so a
        // fee_chase item can be present but not carry its own top-level FEE badge. Count those
        // collapsed mentions too ("+1 more: fee") so the total is checked against the RPC count.
        const collapsedFeeMentions = allRows.filter((r) => !/\bFEE\b/.test(r.innerText) && /\bmore:.*\bfee\b/i.test(r.innerText)).length;
        return { feeRows: rows.length, collapsedFeeMentions, chase: rows.filter((r) => /Chase fee/.test(r.innerText)).length, badges: rows.filter((r) => /blocked/.test(r.innerText)).length };
      });
      eq("R5-28 · with bank details set, every fee-chase row from the RPC is accounted for (own row or folded into a +N more)", restored.feeRows + restored.collapsedFeeMentions, state.rawFeeChaseCount);
      ok("R5-28 · with bank details set the Chase fee buttons return, and no badges remain", restored.chase > 0 && restored.chase === restored.feeRows && restored.badges === 0, JSON.stringify(restored));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();

      const owner = await newPage(browser, "p4");
      const ownerState = await owner.evaluate(() => {
        const rows = [...document.querySelectorAll("#briefing-list .brief-row")].filter((r) => /\bFEE\b/.test(r.innerText));
        return { rows: rows.length, links: rows.filter((r) => /Open Settings/.test(r.innerText)).length };
      });
      ok("R5-28 · the Owner — the one person who can fix it — is offered Settings",
        ownerState.rows > 0 && ownerState.links === ownerState.rows, JSON.stringify(ownerState));
      await owner.click("#briefing-list .brief-row button:has-text('Open Settings')");
      await owner.waitForTimeout(900);
      ok("R5-28 · …and the link goes there", await owner.evaluate(() => !document.querySelector("#page-settings").classList.contains("hidden")));
      ok("no console errors", !owner.__err, JSON.stringify(owner.__err));
      await owner.close();
    }

    /* ===================================================================
       5 · R5-35 — "Mine" means mine
       =================================================================== */
    console.log("\n— R5-35 · scope honesty (p3 Luke)");
    {
      const page = await newPage(browser, "p3");
      const fix = await page.evaluate(async () => {
        const { data: tasks } = await window.__mockDb.from("case_tasks").select("id,title,assigned_to,done_at,due_date,case_id");
        const t = tasks.find((x) => x.id === "tk015");
        const { data: cases } = await window.__mockDb.from("cases").select("id,assigned_to");
        return { title: t && t.title, owner: t && t.assigned_to, caseOwner: t && (cases.find((c) => c.id === t.case_id) || {}).assigned_to };
      });
      ok("fixture · tk015 is an unassigned task on Wayne's case", fix.owner === null && fix.caseOwner === "p2", JSON.stringify(fix));

      const mine = await page.evaluate((t) => ({
        hasIt: document.querySelector("#briefing-list").innerText.indexOf(t) >= 0,
        anyOwnerless: [...document.querySelectorAll("#briefing-list .brief-row")].some((r) => /unassigned/.test(r.innerText)),
      }), fix.title);
      ok("R5-35 · the ownerless task is invisible under Mine", mine.hasIt === false);

      await page.click("#brief-scope-all");
      await page.waitForTimeout(SETTLE);
      const all = await page.evaluate((t) => {
        const row = [...document.querySelectorAll("#briefing-list .brief-row")].find((r) => r.innerText.indexOf(t) >= 0);
        return { hasIt: !!row, text: row ? row.innerText.replace(/\n/g, " · ") : "" };
      }, fix.title);
      ok("R5-35 · it is visible under All", all.hasIt, all.text);
      ok("R5-35 · …and labelled unassigned there", /unassigned/.test(all.text), all.text);

      /* every row still shown under Mine really is Luke's */
      await page.click("#brief-scope-mine");
      await page.waitForTimeout(SETTLE);
      const strict = await page.evaluate(() => {
        const items = window.__lastBriefItemsProbe || null;
        return items;
      });
      const rpcCheck = await page.evaluate(async () => {
        const { data } = await window.__mockDb.rpc("get_briefing", { p_scope: "mine" });
        const ownerless = data.filter((i) => i.owner == null && i.kind !== "lead_new");
        return { ownerlessFromRpc: ownerless.length, kinds: [...new Set(ownerless.map((i) => i.kind))] };
      });
      ok("R5-35 · the RPC still hands back ownerless rows (so the fix is the post-filter)", rpcCheck.ownerlessFromRpc > 0, JSON.stringify(rpcCheck));
      ok("R5-35 · leads (the firm's shared inbox, no owner by nature) stay in My Day",
        await page.evaluate(() => /NEW LEAD/.test(document.querySelector("#briefing-list").innerText)));
      ok("no console errors", !page.__err, JSON.stringify(page.__err) + JSON.stringify(strict));
      await page.close();
    }

    /* ===================================================================
       6 · R5-48 — the appointment modal links out
       =================================================================== */
    console.log("\n— R5-48 · appointment → client / case (p2 Wayne)");
    {
      const page = await newPage(browser, "p2");
      const appt = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("appointments").select("*");
        const today = new Date().toISOString().slice(0, 10);
        const a = data.find((x) => String(x.starts_at).slice(0, 10) === today && x.client_id && x.case_id);
        const { data: cl } = await window.__mockDb.from("clients").select("first_name,last_name").eq("id", a.client_id).single();
        return { id: a.id, client: [cl.first_name, cl.last_name].join(" "), caseId: a.case_id };
      });
      await page.evaluate((id) => window.openAppt(id), appt.id);
      await page.waitForTimeout(700);
      const btns = await page.evaluate(() => ({
        client: !!document.querySelector("#appt-open-client"), case: !!document.querySelector("#appt-open-case"),
      }));
      ok("R5-48 · the appointment offers Open client and Open case", btns.client && btns.case, JSON.stringify(btns));
      await page.click("#appt-open-client");
      await page.waitForTimeout(900);
      const landed = await page.evaluate(() => document.querySelector("#modal").innerText.slice(0, 400));
      ok("R5-48 · one click lands on the client's record", landed.indexOf(appt.client) >= 0 || /Timeline/.test(landed), landed.slice(0, 120));
      const nameOk = await page.evaluate((n) => document.querySelector("#modal").innerText.indexOf(n) >= 0, appt.client);
      ok("R5-48 · …and it is the right client", nameOk, appt.client);

      await page.evaluate(() => window.closeModal());
      await page.waitForTimeout(300);
      await page.evaluate((id) => window.openAppt(id), appt.id);
      await page.waitForTimeout(700);
      await page.click("#appt-open-case");
      await page.waitForTimeout(900);
      const caseOk = await page.evaluate(() => /Log call/.test(document.querySelector("#modal").innerText));
      ok("R5-48 · Open case lands on the case modal", caseOk);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       7 · R5-16 — timeline rows labelled by case
       8 · R5-53 — author chip on the in-place note
       =================================================================== */
    console.log("\n— R5-16/R5-53 · the client timeline (p2 Wayne)");
    {
      const page = await newPage(browser, "p2");
      const ruby = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id,first_name,last_name");
        const r = data.find((c) => c.first_name === "Ruby" && c.last_name === "Sinclair");
        const { data: cs } = await window.__mockDb.from("cases").select("id,case_kind,lender").eq("client_id", r.id);
        return { id: r.id, btl: cs.filter((c) => c.case_kind === "buy_to_let").map((c) => c.lender) };
      });
      ok("fixture · Ruby has four buy-to-lets with different lenders", ruby.btl.length === 4 && new Set(ruby.btl).size === 4, JSON.stringify(ruby.btl));

      await page.evaluate((id) => window.openClient(id), ruby.id);
      await page.waitForTimeout(1200);
      /* UPDATED (round 6) — R5-16 asked for one thing: a timeline row must say WHICH
         of Ruby's cases it belongs to. It was written when the only answer available
         was the kind · lender tag (`.tl-case`), so it asserted that tag directly.
         Round 6.1 gave every one of Ruby's cases a property address, and the timeline
         now prints the property CHIP on any row that has one, keeping `.tl-case` as
         the fallback for the cases with no address — so on Ruby the old selector
         correctly matches nothing at all. The requirement is unchanged; it is
         asserted here against what now carries it. */
      const chips = await page.evaluate(() =>
        [...new Set([...document.querySelectorAll("#tl-list .tl-row .tl-prop .pc-txt")].map((e) => e.textContent.trim()).filter(Boolean))]);
      ok("R5-16 · the timeline rows are distinguishable by case (property chip, round 6)",
        chips.length >= 2 && new Set(chips).size === chips.length, JSON.stringify(chips));
      const fallbackTag = await page.evaluate((lender) =>
        window.timelineCaseLabel({ case_kind: "buy_to_let", lender: lender }), ruby.btl[0]);
      eq("R5-16 · a tag still reads \"Buy to Let · <lender>\" where there is no address", fallbackTag, `Buy to Let · ${ruby.btl[0]}`);

      /* R5-53 — the quick composer's in-place row must carry the author chip immediately.
         UPDATED (round 6.2) — R6FIX-1 stopped the composer silently defaulting the
         target case on a multi-case client, because a mis-defaulted note now STATES a
         property to the next reader. Ruby has six cases, so Add is blocked until one
         is chosen; choosing one is part of adding a note, so the test does it. */
      const target = await page.evaluate(() => {
        const sel = document.querySelector("#tl-case");
        if (!sel) return "no-selector";
        const opt = [...sel.querySelectorAll("option")].find((o) => o.value);
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return opt.value;
      });
      ok("R5-53 · fixture · a target case is chosen before adding (no silent default)", !!target, String(target));
      await page.fill("#tl-note", "Rang about the survey");
      await page.click("#tl-add-btn");
      await page.waitForTimeout(900);
      const firstRow = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#tl-list .tl-row")];
        const r = rows.find((x) => /Rang about the survey/.test(x.innerText));
        return r ? { html: r.querySelector(".tl-title").innerHTML, chip: !!r.querySelector(".tl-title .chip"), title: (r.querySelector(".tl-title .chip") || {}).title || "" } : null;
      });
      ok("R5-53 · the new note carries an author chip straight away", !!firstRow && firstRow.chip, JSON.stringify(firstRow));
      ok("R5-53 · the chip names the author", firstRow && /Wayne Kellow/.test(firstRow.title), firstRow && firstRow.title);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       9 · R5-54 — return a task to Unassigned
       =================================================================== */
    console.log("\n— R5-54 · handing a task back (p2 Wayne)");
    {
      const page = await newPage(browser, "p2");
      await openDrawer(page, "#tasks-panel");
      const target = await page.evaluate(() => {
        const row = [...document.querySelectorAll("#tasks-list .row-item")].find((r) => r.querySelector(".chip-set"));
        if (!row) return null;
        const m = row.querySelector(".chip-set").getAttribute("onclick").match(/openReassign\(event,'([^']+)','([^']*)'/);
        return { taskId: m[1], current: m[2] };
      });
      ok("fixture · the Tasks panel has an assigned task with a reassign chip", !!target && !!target.current, JSON.stringify(target));

      await page.click("#tasks-list .row-item .chip-set");
      await page.waitForTimeout(300);
      const optionText = await page.evaluate(() => {
        const sel = document.querySelector("#tasks-list select.task-reassign");
        return sel ? sel.options[0].textContent.trim() : null;
      });
      eq("R5-54 · the reassign menu offers unassigned first", optionText, "— unassigned —");

      await page.evaluate(() => {
        const sel = document.querySelector("#tasks-list select.task-reassign");
        sel.value = "";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(1200);
      const row = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("case_tasks").select("assigned_to").eq("id", id).single();
        return data;
      }, target.taskId);
      eq("R5-54 · the task really is unassigned now", row.assigned_to, null);

      await page.click("#tasks-scope-unassigned");
      await page.waitForTimeout(SETTLE);
      const inUnassigned = await page.evaluate((id) => document.querySelector("#tasks-list").innerHTML.indexOf(id) >= 0, target.taskId);
      ok("R5-54 · it now appears in the Tasks panel's Unassigned scope", inUnassigned);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch (_) { } }
  }

  console.log(`\nBATCH3: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
