#!/usr/bin/env node
/* =============================================================================
   tests/r5_batch1.js — acceptance tests for PLAN-R5 Batch 1
   ("Outbound email safety & lead accept — the send path")

   Covers, one block per plan item:
     1. R5-1  scoped sends — a per-case action sends ONE row; the firm's queue is
              untouched; accepting a lead sends only the welcome; the firm-wide
              flush is Owner/Admin only and confirms count + recipients.
     2. R5-5  lead-adviser dropdown: no sticky store, siblings survive a repaint.
     3. R5-21 accepting a lead clears its My Day row without navigation.
     4. R5-13 rate-end reminder creates the follow-up chase task.
     5. R5-43 a no-address failure offers Fix contact and opens the CLIENT.
     6. R5-51 a queued row whose client changed email is flagged and re-addressable.
     7. R5-8  the send confirm names who the client will see it signed by.

   Run:  node /root/nx/tests/r5_batch1.js       (expects a static server on 8099;
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
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

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

/* Every page starts with a dialog recorder: confirm()/prompt() are load-bearing in
   this batch (the flush confirmation, the sign-off line, the joint-name prompts),
   so the text is captured and the default action is "say yes". */
async function newPage(browser, persona) {
  const page = await browser.newPage();
  page.__dialogs = [];
  page.__dialogAnswer = "accept";
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    if (page.__dialogAnswer === "dismiss") await d.dismiss();
    else await d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const snapshot = (page, fn) => page.evaluate(fn);

async function main() {
  let srv = null;
  if (!(await serverUp())) {
    srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
    await new Promise((r) => setTimeout(r, 1200));
  }
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       1 · R5-1 — a per-case send sends exactly one row (as p2, an adviser)
       + 4 · R5-13 chase task + 7 · R5-8 sign-off line, all on the same click
       =================================================================== */
    console.log("\n— R5-1/R5-13/R5-8 · scoped send from a case (p2 Wayne, ca017 Louise Garnham)");
    {
      const page = await newPage(browser, "p2");
      /* R79: the mock's SCOPED path now honours the hold like prod v18/v19 (r79_send §F), and the
         chase task is deliberately skipped while held (A4) — so this section's contract (send +
         task + full confirm wording) states the R76 precondition too: hold off, server key on. */
      await snapshot(page, async () => {
        const rows = window.__mock.db.settings;
        const row = rows.filter((r) => r.key === "email_hold")[0];
        if (row) row.value = "off"; else rows.push({ key: "email_hold", value: "off" });
        window.__mock.setResendKey(true);
        await window.__reloadSettings();
      });
      const before = await snapshot(page, async () => {
        const db = window.__mockDb;
        const { data: q } = await db.from("email_queue").select("id,status").eq("status", "queued");
        const { data: t } = await db.from("case_tasks").select("id");
        return { queuedIds: q.map((r) => r.id).sort(), tasks: t.length };
      });
      ok("fixture: several emails are queued firm-wide", before.queuedIds.length >= 4, `queued=${before.queuedIds.length}`);

      await page.evaluate(() => window.openCase("ca017"));
      await page.waitForTimeout(600);
      await clickAction(page, "act-reminder");
      await page.waitForTimeout(1200);

      const confirmMsg = (page.__dialogs.find((d) => d.type === "confirm") || {}).message || "";
      ok("R5-8 · the confirm names the signatory (case adviser Wayne Kellow)", /Signed off by:\s*Wayne Kellow/.test(confirmMsg), JSON.stringify(confirmMsg));
      ok("R5-13 · the confirm warns that a follow-up task will be created", /Follow up rate-end reminder/i.test(confirmMsg), JSON.stringify(confirmMsg));

      const after = await snapshot(page, async () => {
        const db = window.__mockDb;
        const { data: all } = await db.from("email_queue").select("id,status,email_type,case_id,sent_at");
        const { data: t } = await db.from("case_tasks").select("*").eq("case_id", "ca017");
        return {
          stillQueued: all.filter((r) => r.status === "queued").map((r) => r.id).sort(),
          sentNow: all.filter((r) => r.status === "sent" && r.case_id === "ca017" && r.email_type === "rate_end_reminder").map((r) => r.id),
          lastRun: window.__mock.lastEmailRun(),
          tasks: t,
        };
      });
      eq("R5-1 · exactly one email was sent by the click", after.sentNow.length, 1);
      eq("R5-1 · every other queued email is still queued", after.stillQueued, before.queuedIds);
      ok("R5-1 · process-emails was called scoped to that one row", after.lastRun && after.lastRun.scoped === true && after.lastRun.queue_ids && after.lastRun.queue_ids.length === 1,
        JSON.stringify(after.lastRun && { scoped: after.lastRun.scoped, ids: after.lastRun.queue_ids }));
      ok("R5-1 · the scoped run skipped the firm-wide queueing step", after.lastRun && after.lastRun.considered === 1, JSON.stringify(after.lastRun && after.lastRun.considered));

      const chase = (after.tasks || []).filter((t) => /^Follow up rate-end reminder/.test(t.title));
      eq("R5-13 · exactly one follow-up task was created", chase.length, 1);
      if (chase.length) {
        const t = chase[0];
        // R12b flake fix — app.js's own `chaseDue = localDateStr(Date.now() + 7*86400000)` is
        // Europe/London-pinned; a bare `.toISOString().slice(0,10)` is UTC, and the two only
        // disagreed for the hour 23:00–00:00 UTC (already tomorrow in London during BST). Root-
        // caused to read the identical clock, not widened into a tolerance.
        const want = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + 7 * 86400000));
        ok("R5-13 · the task is due in 7 days", t.due_date === want, `due_date=${t.due_date}, expected ${want}`);
        ok("R5-13 · the task is assigned to the case adviser (p2)", t.assigned_to === "p2", `assigned_to=${t.assigned_to}`);
        ok("R5-13 · the task names the client", /Louise/.test(t.title), t.title);
      }
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       1b · R5-1 — accepting a lead sends the welcome and nothing else
       (and a lead with NO email sends nothing at all)
       R41 · F1 — the New-website-leads drawer (#leads-list) is gone; a lead's Accept/routing
       select now lives once, on its My Day row (#briefing-list), which is where every selector
       in this section (and in §2/§3 below) now reaches for it.
       =================================================================== */
    console.log("\n— R5-1 · accept a lead (p1 Kim): only the welcome goes");
    {
      const page = await newPage(browser, "p1");
      /* R79: same precondition — the scoped welcome send now honours the hold like prod. */
      await snapshot(page, async () => {
        const rows = window.__mock.db.settings;
        const row = rows.filter((r) => r.key === "email_hold")[0];
        if (row) row.value = "off"; else rows.push({ key: "email_hold", value: "off" });
        window.__mock.setResendKey(true);
        await window.__reloadSettings();
      });
      const before = await snapshot(page, async () => {
        const { data: q } = await window.__mockDb.from("email_queue").select("id").eq("status", "queued");
        return q.map((r) => r.id).sort();
      });
      await page.evaluate(() => {
        const r = [...document.querySelectorAll("#briefing-list .row-item")].find((x) => /Owen Trelawney/.test(x.textContent));
        r.querySelector("button.btn-primary").click();
      });
      await page.waitForTimeout(1400);
      const after = await snapshot(page, async () => {
        const db = window.__mockDb;
        const { data: all } = await db.from("email_queue").select("*");
        const welcome = all.filter((r) => r.email_type === "welcome" && /trelawney/i.test(r.to_email || ""));
        return {
          stillQueued: all.filter((r) => r.status === "queued").map((r) => r.id).sort(),
          welcome: welcome.map((r) => ({ status: r.status })),
          lastRun: window.__mock.lastEmailRun(),
        };
      });
      eq("R5-1 · the welcome email exists and is sent", after.welcome, [{ status: "sent" }]);
      eq("R5-1 · nobody else's queued email was flushed", after.stillQueued, before);
      ok("R5-1 · the run was scoped to the welcome row", after.lastRun && after.lastRun.scoped === true && after.lastRun.considered === 1, JSON.stringify(after.lastRun && after.lastRun.considered));

      // …and a lead with no email address must not trigger a send at all.
      const runBefore = await snapshot(page, () => window.__mock.lastEmailRun().at);
      const hasNoEmailLead = await snapshot(page, () => [...document.querySelectorAll("#briefing-list .row-item")].some((r) => /Colin Sharratt/.test(r.textContent)));
      ok("fixture: the no-email lead (Colin Sharratt) is on screen", hasNoEmailLead === true);
      if (hasNoEmailLead) {
        await page.evaluate(() => {
          const r = [...document.querySelectorAll("#briefing-list .row-item")].find((x) => /Colin Sharratt/.test(x.textContent));
          r.querySelector("button.btn-primary").click();
        });
        await page.waitForTimeout(1400);
        const runAfter = await snapshot(page, () => window.__mock.lastEmailRun().at);
        ok("R5-1 · a lead with no email triggers no send at all", runAfter === runBefore, `${runBefore} → ${runAfter}`);
      }
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       1c · R5-1 — the firm-wide flush: hidden for an adviser, confirmed for
       an owner (count + named recipients), and a no-op on an empty queue
       =================================================================== */
    console.log("\n— R5-1 · the Run-automation-now button");
    {
      const p2 = await newPage(browser, "p2");
      // R33 — Emails now sits inside the collapsible "Firm" group, folded by default for an
      // adviser: a raw click on the nav button targets a display:none element for p2 and times
      // out. window.nav() is the same route the click handler ends up calling and auto-expands
      // the group when it lands on a page inside it, so it works unconditionally here.
      await p2.evaluate(() => window.nav("emails"));
      await p2.waitForTimeout(900);
      const advVisible = await p2.evaluate(() => {
        const b = document.querySelector("#run-now-btn");
        return !!b && !b.classList.contains("hidden") && b.offsetParent !== null;
      });
      ok("R5-1 · an adviser is not offered the firm-wide flush", advVisible === false);
      await p2.close();

      const p4 = await newPage(browser, "p4");
      await p4.click('.nav-link[data-page="emails"], [data-page="emails"]');
      await p4.waitForTimeout(900);
      const ownerVisible = await p4.evaluate(() => {
        const b = document.querySelector("#run-now-btn");
        return !!b && !b.classList.contains("hidden") && b.offsetParent !== null;
      });
      ok("R5-1 · the Owner is offered it", ownerVisible === true);

      /* R76 · B1 — the classic named-recipient consent flow this section pins is now, honestly,
         the HOLD-OFF flow: while settings.email_hold is on (the fixture's seed, production's real
         state), run-now raises a house overlay instead and v18's mock sends nothing — that path
         is pinned by tests/r76_intake.js §A. This section's contract (count + names + whole-firm
         + number-consented-is-number-sent) is unchanged, so it now states its own precondition:
         hold off, server key present. */
      await snapshot(p4, async () => {
        const rows = window.__mock.db.settings;
        const row = rows.filter((r) => r.key === "email_hold")[0];
        if (row) row.value = "off"; else rows.push({ key: "email_hold", value: "off" });
        /* PATCHED R82 · B4 — SECOND PRECONDITION, same shape as the hold-off one above and for the
           same reason. The mock's process-emails now mirrors v20's send-time financial-promotions
           refusal, so any queued referral_request / protection_offer / gi_exchange row is CANCELLED
           at send time while settings.financial_promotions_approved is off (the fixture default and
           production's state) — and the fixture holds two. The invariant this block exists for is
           "the number in the confirm is the number that goes out", and a promo refusal is a second,
           unrelated reason for those two numbers to differ; approving them here keeps the assertion
           about consent rather than about the compliance gate. That gate is pinned in its own right
           by tests/r82_mock.js §D, including this exact consequence. */
        const fp = rows.filter((r) => r.key === "financial_promotions_approved")[0];
        if (fp) fp.value = "on"; else rows.push({ key: "financial_promotions_approved", value: "on" });
        window.__mock.setResendKey(true);
        await window.__reloadSettings();
      });
      const queuedBefore = await snapshot(p4, async () => {
        const { data } = await window.__mockDb.from("email_queue").select("id,to_email,client_id").eq("status", "queued");
        return data.length;
      });
      p4.__dialogAnswer = "dismiss";           // cancel: nothing may be sent
      p4.__dialogs.length = 0;
      const sentBefore = await snapshot(p4, () => (window.__mock.lastEmailRun() || {}).sent || 0);
      await p4.click("#run-now-btn");
      await p4.waitForTimeout(1200);
      const msg = (p4.__dialogs.find((d) => d.type === "confirm") || {}).message || "";
      /* GATE-R5 G1I-Q1 — this used to assert the confirm named the rows ALREADY in the queue
         (`queuedBefore`, read before the click). That was the defect: an unscoped run does the
         queueing RPCs first and then flushes what they create, so the Owner consented to 5 and 22
         went out. The button now queues BEFORE it asks; the invariant under test is therefore the
         one that matters — the number in the confirm is the number that will be sent (checked
         against lastEmailRun() after the accepted run below). */
      const promised = Number((/Send ALL (\d+) queued email/.exec(msg) || [])[1] || 0);
      ok("R5-1 · the confirm states a count", promised > 0, JSON.stringify(msg));
      ok("R5-1 · the confirm lists recipients by name", /Recipients:\s*\S/.test(msg), JSON.stringify(msg));
      ok("R5-1 · the confirm says it covers the whole firm", /whole firm/i.test(msg), JSON.stringify(msg));
      // Cancelling must SEND nothing. (Queue length is no longer the proxy for that: the queueing
      // step the cron would have run tonight has already run, so rows may legitimately be waiting.)
      const afterCancel = await snapshot(p4, () => (window.__mock.lastEmailRun() || {}).sent || 0);
      eq("R5-1 · cancelling sends nothing", afterCancel, sentBefore);

      p4.__dialogAnswer = "accept";
      /* R8 — the promise has to be read from the run that was ACCEPTED, not from the cancelled
         one before it. Round 8's review-request drip queues at most five a run, so a second run
         legitimately creates the next five: comparing this run's send against the previous run's
         confirm was only ever accidentally valid, back when one run queued the entire eligible
         book and the run after it queued nothing. The property under test is unchanged and now
         actually stated — what THIS confirm says is what THIS click sends. */
      p4.__dialogs.length = 0;
      await p4.click("#run-now-btn");
      await p4.waitForTimeout(1600);
      const acceptedMsg = (p4.__dialogs.find((d) => d.type === "confirm") || {}).message || "";
      const promisedNow = Number((/Send ALL (\d+) queued email/.exec(acceptedMsg) || [])[1] || 0);
      const afterSend = await snapshot(p4, async () => {
        const { data } = await window.__mockDb.from("email_queue").select("id").eq("status", "queued");
        return { queued: data.length, run: window.__mock.lastEmailRun() };
      });
      ok("R5-1 · confirming does flush the queue", afterSend.queued < queuedBefore, `${queuedBefore} → ${afterSend.queued}`);
      ok("R5-1 · the number consented to is the number sent", afterSend.run && promisedNow > 0 && afterSend.run.sent === promisedNow,
        `confirm promised ${promisedNow}, sent ${afterSend.run && afterSend.run.sent}`);
      ok("R5-1 · the deliberate flush is UNscoped (the cron's behaviour)", afterSend.run && afterSend.run.scoped === false, JSON.stringify(afterSend.run && afterSend.run.scoped));

      // Empty queue → a toast, no round trip.
      p4.__dialogs.length = 0;
      const runAt = await snapshot(p4, () => window.__mock.lastEmailRun().at);
      await p4.click("#run-now-btn");
      await p4.waitForTimeout(1000);
      const emptyState = await snapshot(p4, () => ({ at: window.__mock.lastEmailRun().at, toast: (document.querySelector("#toast") || {}).textContent || "" }));
      eq("R5-1 · an empty queue asks nothing", p4.__dialogs.length, 0);
      ok("R5-1 · an empty queue calls nothing", emptyState.at === runAt, `${runAt} → ${emptyState.at}`);
      ok("R5-1 · an empty queue says so", /queue is empty/i.test(emptyState.toast), JSON.stringify(emptyState.toast));
      ok("no console errors", !p4.__err, JSON.stringify(p4.__err));
      await p4.close();
    }

    /* ===================================================================
       2 · R5-5 — lead-adviser dropdown cross-contamination
       3 · R5-21 — the stale My Day lead row
       =================================================================== */
    console.log("\n— R5-5/R5-21 · lead routing and the My Day row (p1 Kim)");
    {
      const page = await newPage(browser, "p1");

      /* R12b · W-9 — Kim is an Administrator, and W-9's rule is that role is NEVER a routing
         candidate: the default is the lightest-loaded ADVISING member of staff (adviser always a
         candidate; owner/staff only while they carry an open case), recomputed independently here
         from the same fixture tables the app reads (cases' open stage + case_tasks' 14-day undone
         horizon), never by calling the app's own leastLoadedAdviser(). "(me)" is a label on KIM'S
         OWN option in the list (wherever it sits) — it is never what gets PRE-SELECTED for her,
         because she never advises. */
      const leastLoadedGroundTruth = () => page.evaluate(async () => {
        const db = window.__mockDb;
        const STAFF_ROLES = ["owner", "admin", "adviser", "staff"];
        const { data: profiles } = await db.from("profiles").select("id,full_name,role").order("full_name");
        const { data: cases } = await db.from("cases").select("assigned_to,stage");
        const { data: tasks } = await db.from("case_tasks").select("assigned_to,due_date,done_at");
        const team = (profiles || []).filter((p) => STAFF_ROLES.includes(p.role));
        const openCases = {};
        (cases || []).forEach((c) => { if (c.assigned_to && c.stage !== "completed" && c.stage !== "not_proceeding") openCases[c.assigned_to] = (openCases[c.assigned_to] || 0) + 1; });
        const horizon = localDateStr(Date.now() + 14 * 86400000);   // pure formatting helper — see r12a.js precedent
        const openTasks = {};
        (tasks || []).forEach((t) => { if (t.assigned_to && !t.done_at && t.due_date && t.due_date <= horizon) openTasks[t.assigned_to] = (openTasks[t.assigned_to] || 0) + 1; });
        const isAdvising = (p) => p.role === "adviser" || (["owner", "staff"].includes(p.role) && (openCases[p.id] || 0) > 0);
        const pool = team.filter(isAdvising);
        let best = null;
        pool.forEach((p) => { const tot = (openCases[p.id] || 0) + (openTasks[p.id] || 0); if (!best || tot < best.tot) best = { id: p.id, tot }; });
        return { rr: best && best.id, poolIds: pool.map((p) => p.id) };
      });

      const gt0 = await leastLoadedGroundTruth();
      const initial = await page.evaluate(() => [...document.querySelectorAll("#briefing-list select.lead-adviser")].map((s) => ({ lead: s.dataset.lead, val: s.value, text: s.options[s.selectedIndex].text })));
      ok("R5-5 · every lead select defaults to the lightest-loaded ADVISING adviser, never Kim (admin)",
        initial.length >= 3 && initial.every((s) => s.val === gt0.rr && s.val !== "p1" && /· lightest load/.test(s.text) && !/\(me\)/.test(s.text)),
        JSON.stringify({ initial, gt0 }));

      const leadA = initial[1].lead;   // ld002 Owen Trelawney — routed to Wayne
      const leadB = initial[2].lead;   // ld003 Farida Bahri  — hand-changed to Luke
      const others = initial.filter((s) => s.lead !== leadA && s.lead !== leadB).map((s) => s.lead);

      await page.evaluate(([a, b]) => {
        const q = (id) => document.querySelector(`#briefing-list select.lead-adviser[data-lead="${id}"]`);
        q(a).value = "p2"; q(a).dispatchEvent(new Event("change", { bubbles: true }));
        q(b).value = "p3"; q(b).dispatchEvent(new Event("change", { bubbles: true }));
      }, [leadA, leadB]);

      const briefBefore = await page.evaluate((a) => (document.querySelector("#briefing-list").innerHTML.indexOf(`acceptLead('${a}'`) >= 0), leadA);
      ok("R5-21 · fixture: the lead also has a My Day row", briefBefore === true);

      await page.click(`#briefing-list .row-item:has(select[data-lead="${leadA}"]) button.btn-primary`);
      await page.waitForTimeout(1600);

      const post = await page.evaluate(async ([a, b, o]) => {
        const sels = [...document.querySelectorAll("#briefing-list select.lead-adviser")].map((s) => ({ lead: s.dataset.lead, val: s.value }));
        const { data: cases } = await window.__mockDb.from("cases").select("id,assigned_to,lead_source").order("created_at", { ascending: false }).limit(5);
        const { data: lead } = await window.__mockDb.from("leads").select("*").eq("id", a).single();
        return {
          sels,
          bVal: (sels.find((s) => s.lead === b) || {}).val,
          otherVals: sels.filter((s) => o.indexOf(s.lead) >= 0).map((s) => s.val),
          acceptedCaseAdviser: (cases.find((c) => c.id === lead.converted_case_id) || {}).assigned_to,
          briefStillHasA: document.querySelector("#briefing-list").innerHTML.indexOf(`acceptLead('${a}'`) >= 0,
          leadGone: sels.every((s) => s.lead !== a),
        };
      }, [leadA, leadB, others]);

      eq("R5-5 · the accepted lead went to the adviser its own row named", post.acceptedCaseAdviser, "p2");
      ok("R5-5 · the accepted lead has left the inbox", post.leadGone === true, JSON.stringify(post.sels));
      eq("R5-5 · a hand-changed sibling row keeps its choice through the repaint", post.bVal, "p3");
      ok("R5-5 · untouched sibling rows still default to the lightest-loaded adviser (no cross-contamination)", post.otherVals.every((v) => v === gt0.rr), JSON.stringify({ otherVals: post.otherVals, rr: gt0.rr }));
      ok("R5-21 · the accepted lead's My Day row disappeared without navigating", post.briefStillHasA === false);

      // …and nothing is remembered across a reload: every remaining lead is back to a freshly
      // recomputed suggestion (accepting leadA just gave p2 an extra open case, so the ground
      // truth is recomputed here rather than reused from gt0 — R5-5's "recomputed, never
      // remembered" rule, unchanged by W-9).
      await page.reload();
      await page.waitForTimeout(SETTLE);
      const gt1 = await leastLoadedGroundTruth();
      const reloaded = await page.evaluate(() => [...document.querySelectorAll("#briefing-list select.lead-adviser")].map((s) => s.value));
      ok("R5-5 · after a reload every lead defaults to the (recomputed) lightest-loaded adviser again — no sticky store, and never Kim", reloaded.length > 0 && reloaded.every((v) => v === gt1.rr && v !== "p1"), JSON.stringify({ reloaded, gt1 }));
      ok("R5-5 · the old localStorage routing key is gone", await page.evaluate(() => Object.keys(localStorage).every((k) => k.indexOf("nx_lead_adviser") !== 0)));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       5 · R5-43 — a no-address failure has a fix path
       =================================================================== */
    console.log("\n— R5-43 · the no-email failure (p1 Kim)");
    {
      const page = await newPage(browser, "p1");
      await page.click('[data-page="emails"]');
      await page.waitForTimeout(1000);
      const row = await page.evaluate(() => {
        const r = [...document.querySelectorAll("#email-list .row-item")].find((x) => /no email on file|no address on file/i.test(x.textContent));
        if (!r) return null;
        const fix = [...r.querySelectorAll("button")].find((b) => /Fix contact/i.test(b.textContent));
        /* R76 · B5 — the title's fix route goes through fixContactOpen() now (it records the
           failed queue row so the save can offer the retry), which itself opens the CLIENT via
           openClient — the fact under test is unchanged. */
        return { hasFix: !!fix, titleOpensClient: /fixContactOpen\('email'|openClient\(/.test((r.querySelector(".t") || {}).outerHTML || ""), text: r.textContent.replace(/\s+/g, " ").trim().slice(0, 90) };
      });
      ok("R5-43 · the no-address failure is on screen", !!row, "row not found");
      if (row) {
        ok("R5-43 · it offers Fix contact", row.hasFix === true, row.text);
        ok("R5-43 · its title opens the CLIENT, not the case", row.titleOpensClient === true, row.text);
      }
      await page.evaluate(() => {
        const r = [...document.querySelectorAll("#email-list .row-item")].find((x) => /no email on file|no address on file/i.test(x.textContent));
        [...r.querySelectorAll("button")].find((b) => /Fix contact/i.test(b.textContent)).click();
      });
      await page.waitForTimeout(1200);
      const landed = await page.evaluate(() => ({
        modalOpen: !!document.querySelector("#modal-backdrop:not(.hidden), #modal:not(.hidden)"),
        isClientForm: !!document.querySelector("#client-form"),
        focused: (document.activeElement && document.activeElement.getAttribute("name")) || "",
        detailsOpen: !!(document.querySelector("#modal .client-details") || {}).open,
      }));
      ok("R5-43 · the click lands on the client editor", landed.isClientForm === true, JSON.stringify(landed));
      ok("R5-43 · with the contact section open", landed.detailsOpen === true, JSON.stringify(landed));
      ok("R5-43 · and the cursor in the email field", landed.focused === "email", JSON.stringify(landed));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       6 · R5-51 — a queued row addressed to a since-changed email
       =================================================================== */
    console.log("\n— R5-51 · stale queued address (p1 Kim)");
    {
      const page = await newPage(browser, "p1");
      // Change a client's email while one of their emails is sitting queued.
      const target = await snapshot(page, async () => {
        const db = window.__mockDb;
        const { data: q } = await db.from("email_queue").select("*").eq("status", "queued");
        const row = q.find((r) => r.client_id && r.to_email && !/newdomain/.test(r.to_email));
        await db.from("clients").update({ email: "moved.house@example.com" }).eq("id", row.client_id);
        return { id: row.id, was: row.to_email, client: row.client_id };
      });
      await page.click('[data-page="emails"]');
      await page.waitForTimeout(1100);
      const flagged = await page.evaluate((id) => {
        const rows = [...document.querySelectorAll("#email-list .row-item")];
        const hit = rows.filter((r) => /address changed since queued/i.test(r.textContent));
        const mine = hit.find((r) => /moved\.house@example\.com/.test(r.textContent));
        return { count: hit.length, mine: !!mine, hasBtn: !!(mine && [...mine.querySelectorAll("button")].some((b) => /Use current address/i.test(b.textContent))) };
      }, target.id);
      ok("R5-51 · the changed-address row is badged", flagged.mine === true, JSON.stringify(flagged));
      ok("R5-51 · it offers Use current address", flagged.hasBtn === true, JSON.stringify(flagged));
      ok("R5-51 · the seeded stale-address row is badged too", flagged.count >= 2, `badged rows=${flagged.count}`);

      await page.evaluate(() => {
        const r = [...document.querySelectorAll("#email-list .row-item")].find((x) => /moved\.house@example\.com/.test(x.textContent));
        [...r.querySelectorAll("button")].find((b) => /Use current address/i.test(b.textContent)).click();
      });
      await page.waitForTimeout(1200);
      const fixed = await snapshot(page, async () => {
        const { data } = await window.__mockDb.from("email_queue").select("*").eq("to_email", "moved.house@example.com");
        return data.map((r) => ({ status: r.status }));
      });
      eq("R5-51 · the queued row now carries the current address, still unsent", fixed, [{ status: "queued" }]);
      const gone = await page.evaluate(() => [...document.querySelectorAll("#email-list .row-item")].some((r) => /moved\.house/.test(r.textContent) && /address changed since queued/i.test(r.textContent)));
      ok("R5-51 · the badge clears once corrected", gone === false);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) { /* already gone */ } }
  }

  console.log(`\nR5 BATCH 1: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  FAIL: " + f)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
