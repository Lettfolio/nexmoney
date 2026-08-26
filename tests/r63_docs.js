#!/usr/bin/env node
/* =============================================================================
   tests/r63_docs.js — acceptance tests for R63 (agent A: docs / comms parity)

     §A  CHASE COUNT — production has NO `docs_chase` email type: the chaser
         queues FURTHER `docs_request` rows, so the first document email on a
         case is the request and every one after it is a chase. 0 / 1 / 2 / 4
         non-cancelled docs_request rows must read as 0 / 0 / 1 / 3 chases, on
         the case screen AND in the mock's own chaser — and the 4-row case must
         take the overdue-TASK branch instead of a fifth email.
     §B  auto_stage_comms MIRROR — the mock now carries production's stage-change
         trigger: one docs_request at fact_find, submitted_update at application,
         offer_update at offer, completion_congrats at completed, each gated on
         its own setting ("1" AND "on" both mean on), skipped for a client with
         no email or suppress_automation, idempotent per case+type; and the
         "Chase solicitors for completion date" task at exchange, due
         today + solicitor_chase_days, assigned to the case's adviser, once.
     §C  SETTINGS bool10 — a row holding 'on' (which is what production actually
         holds) renders as On, not Off.
     §D  SMS COPY — the Emails page no longer claims SMS has no cron of its own;
         it names the daily 8:05am run the way the email summary names 8am.
     §E  FACT FIND CHECKLIST PROMPT (H2) — advancing to Fact Find on a case with
         no checklist offers the kind-filtered list pre-ticked, three-way exit:
         Save & advance creates the rows and moves, Skip moves and writes
         nothing, Don't advance leaves the stage alone; a case that already has
         a checklist is never asked.
     §F  NO CONSOLE ERRORS on every page this round touched, for p2 and p1.

   EVERY figure asserted here is recomputed in this file from the fixture
   tables, never read back off the app's own rendering — the standing rule in
   HARNESS.md. The one thing read off the page's scope is nothing at all: even
   docSuggestionsFor()'s answer is rebuilt here from the docs_list setting and
   the documented kind rules, so a change to either side shows up as a failure
   rather than as two copies of the same mistake agreeing.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r63_docs.js
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
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    if (page.__dialogAnswer === "dismiss") await d.dismiss(); else await d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const goto = async (page, pg, ms) => { await page.evaluate((p) => window.nav(p), pg); await wait(page, ms || 1200); };
const txt = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
const overlayOpen = (page) => page.evaluate(() => {
  const b = document.querySelector("#overlay-backdrop");
  return !!b && !b.classList.contains("hidden");
});

/* Insert a client + case in one round trip — same helper shape as tests/r12b.js. */
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email === undefined ? (`r63.${Math.random().toString(36).slice(2, 9)}@example.com`) : o.email;
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "R63", last_name: o.last || "Case", email, phone: null })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    if (o.suppress) {
      const { error } = await db.from("clients").update({ suppress_automation: true }).eq("id", cl.id);
      if (error) throw new Error("suppress: " + error.message);
    }
    const row = Object.assign({
      client_id: cl.id, case_kind: o.case_kind || "remortgage", stage: o.stage || "enquiry",
      assigned_to: o.assigned_to === undefined ? null : o.assigned_to,
    }, o.caseFields || {});
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id, email };
  }, opts || {});
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
const setSetting = (page, key, value) => page.evaluate(async ({ key, value }) => {
  const { error } = await window.__mockDb.from("settings").upsert([{ key, value }]);
  if (error) throw new Error("setting " + key + ": " + error.message);
}, { key, value });
const setStage = (page, caseId, stage) => page.evaluate(async ({ caseId, stage }) => {
  const { error } = await window.__mockDb.from("cases").update({ stage }).eq("id", caseId);
  if (error) throw new Error("stage: " + error.message);
}, { caseId, stage });

/* The chase-count rule, written out ONCE here as this suite's ground truth. It is deliberately
   NOT imported from the app — that is the whole point of a ground truth. */
const chasesFrom = (mails) => {
  const live = (mails || []).filter((m) => m.status !== "cancelled");
  return live.filter((m) => m.email_type === "docs_chase").length
    + Math.max(0, live.filter((m) => m.email_type === "docs_request").length - 1);
};

/* docSuggestionsFor(kind), rebuilt from the firm's docs_list setting and the documented kind
   rules, so "the prompt pre-ticks the right things" is checked against an independent answer. */
const DROP = {
  remortgage: [/deposit/i, /memorandum/i, /gift/i],
  product_transfer: [/deposit/i, /memorandum/i, /gift/i, /bank statement/i],
  buy_to_let: [/gift/i],
};
const EXTRA = {
  purchase: ["Memorandum of sale", "Proof of deposit"],
  first_time_buyer: ["Proof of deposit", "Gifted deposit letter"],
  buy_to_let: ["Tenancy agreement", "Portfolio schedule"],
  remortgage: ["Current mortgage statement"],
  product_transfer: ["Current mortgage statement"],
  other: [],
};
function suggestionsGT(docsList, kind) {
  const base = String(docsList || "").split("|").map((s) => s.trim()).filter(Boolean);
  const drop = DROP[kind] || [];
  const suggested = [], dropped = [];
  base.forEach((i) => (drop.some((re) => re.test(i)) ? dropped : suggested).push(i));
  const seen = new Set(suggested.map((s) => s.toLowerCase()));
  (EXTRA[kind] || []).forEach((i) => {
    if (seen.has(i.toLowerCase()) || drop.some((re) => re.test(i))) return;
    seen.add(i.toLowerCase());
    suggested.push(i);
  });
  return { suggested, dropped };
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {

    /* =====================================================================
       §A · THE CHASE COUNT RULE
       ===================================================================== */
    {
      // p4 (owner): §A flips `doc_chase_enabled` to run the chaser, and settings writes are
      // Owner-only at the database, exactly as they are in production.
      console.log("\n— §A · chases are further docs_request rows, not a docs_chase type (p4)");
      const page = await newPage(browser, "p4");

      // Four cases, identical but for how many document REQUESTS have gone out. Each has a real
      // checklist with something outstanding, or the chase line never gets past "no checklist".
      const mk = async (label, nRequests, opts) => {
        const c = await mkClientCase(page, { first: "Chase", last: label, stage: "application", assigned_to: "p2", caseFields: { protection_status: "discussed" } });
        await page.evaluate(async ({ caseId, clientId, n, email, cancelled }) => {
          const db = window.__mockDb;
          const now = Date.now();
          const iso = (d) => new Date(d).toISOString();
          await db.from("case_documents").insert([
            { case_id: caseId, item: "Photo ID", status: "requested", requested_at: iso(now - 40 * 86400000) },
            { case_id: caseId, item: "Last 3 payslips", status: "requested", requested_at: iso(now - 40 * 86400000) },
          ]);
          for (let i = 0; i < n; i++) {
            const at = iso(now - (30 - i * 7) * 86400000);
            await db.from("email_queue").insert({
              case_id: caseId, client_id: clientId, email_type: "docs_request", to_email: email,
              subject: i ? "Still waiting on your documents" : "Your document checklist",
              status: "sent", sent_at: at, scheduled_for: at, created_at: at,
            });
          }
          if (cancelled) {
            const at = iso(now - 2 * 86400000);
            await db.from("email_queue").insert({
              case_id: caseId, client_id: clientId, email_type: "docs_request", to_email: email,
              subject: "Still waiting on your documents", status: "cancelled",
              sent_at: null, scheduled_for: at, created_at: at,
            });
          }
        }, { caseId: c.caseId, clientId: c.clientId, n: nRequests, email: c.email, cancelled: !!(opts && opts.cancelled) });
        return c;
      };
      const c0 = await mk("Zero", 0);
      const c1 = await mk("One", 1);
      const c2 = await mk("Two", 2);
      const c4 = await mk("Four", 4);
      const cCancel = await mk("Cancelled", 2, { cancelled: true });

      // Ground truth, recomputed from the rows themselves.
      for (const [label, c, want] of [["0 rows", c0, 0], ["1 row", c1, 0], ["2 rows", c2, 1], ["4 rows", c4, 3]]) {
        const mails = await readRows(page, "email_queue", { case_id: c.caseId });
        eq(`A1 · ground truth · ${label} → ${want} chase(s)`, chasesFrom(mails), want);
      }

      const chaseLine = async (caseId) => {
        await page.evaluate((id) => window.openCase(id), caseId);
        await wait(page, 700);
        const t = await txt(page, "#docs-chase-line");
        await page.evaluate(() => window.closeModal());
        await wait(page, 250);
        return t;
      };
      const l0 = await chaseLine(c0.caseId);
      ok("A2 · a case with NO document email reads 0 of 3", /0 of 3 chases sent/.test(l0), l0);
      const l1 = await chaseLine(c1.caseId);
      ok("A3 · ONE docs_request is the request, not a chase — still 0 of 3", /0 of 3 chases sent/.test(l1), l1);
      const l2 = await chaseLine(c2.caseId);
      ok("A4 · TWO docs_request rows read as 1 of 3 chases sent", /1 of 3 chases sent/.test(l2), l2);
      const l4 = await chaseLine(c4.caseId);
      ok("A5 · FOUR docs_request rows read as chases exhausted (3 of 3)", /Chases exhausted — 3 of 3 sent/.test(l4), l4);
      const lc = await chaseLine(cCancel.caseId);
      ok("A6 · a CANCELLED docs_request never reached the client, so it never chased — still 1 of 3",
        /1 of 3 chases sent/.test(lc), lc);

      /* The mock's own chaser must apply the SAME rule: the 4-row case is out of chases and gets
         the overdue TASK, not a fifth email; the 2-row case is still inside its budget. */
      await setSetting(page, "doc_chase_enabled", "on");
      const before = await readRows(page, "email_queue", {});
      const beforeIds = new Set(before.map((r) => r.id));
      const extras = await page.evaluate(() => window.__mock.queueCommsExtras());
      ok("A7 · the chase run actually did something (not a vacuous pass)",
        (extras.doc_chases_queued + extras.doc_overdue_tasks) > 0, JSON.stringify(extras));

      const after4 = await readRows(page, "email_queue", { case_id: c4.caseId });
      eq("A8 · the exhausted case gets NO fifth document email", after4.length, 4);
      const tasks4 = await readRows(page, "case_tasks", { case_id: c4.caseId });
      const overdue4 = tasks4.filter((t) => !t.done_at && /^Documents overdue — call /.test(t.title || ""));
      eq("A9 · …it gets the overdue call task instead, exactly once", overdue4.length, 1);

      const after2 = await readRows(page, "email_queue", { case_id: c2.caseId });
      const new2 = after2.filter((r) => !beforeIds.has(r.id));
      eq("A10 · the 2-chase case is still inside its budget and gets one more email", new2.length, 1);
      eq("A11 · …and that email is a docs_request, not an invented docs_chase type",
        new2.map((r) => r.email_type), ["docs_request"]);
      eq("A12 · …carrying the chase SUBJECT, which is what tells it from the first ask",
        new2.map((r) => r.subject), ["Still waiting on your documents"]);
      const nowChases = chasesFrom(await readRows(page, "email_queue", { case_id: c2.caseId }));
      eq("A13 · …so the case is now on 2 of 3 chases by the same rule the app counts with", nowChases, 2);

      ok("A14 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §B · THE auto_stage_comms MIRROR
       ===================================================================== */
    {
      console.log("\n— §B · the mock's stage-change trigger queues the four stage emails and the exchange task (p4)");
      const page = await newPage(browser, "p4");

      // auto_offer_update ships seeded "0"; set it to 'on' — the OTHER spelling — so this block
      // proves both halves of the two-spellings rule in one pass.
      await setSetting(page, "auto_offer_update", "on");
      const full = await mkClientCase(page, { first: "Trigger", last: "Full", stage: "enquiry", assigned_to: "p2" });
      for (const s of ["fact_find", "application", "offer", "completed"]) {
        await setStage(page, full.caseId, s);
      }
      const fullMails = await readRows(page, "email_queue", { case_id: full.caseId });
      const typeCount = (rows, t) => rows.filter((r) => r.email_type === t).length;
      eq("B1 · fact_find queued exactly one docs_request", typeCount(fullMails, "docs_request"), 1);
      eq("B2 · application queued exactly one submitted_update", typeCount(fullMails, "submitted_update"), 1);
      eq("B3 · offer queued exactly one offer_update (setting spelled 'on')", typeCount(fullMails, "offer_update"), 1);
      eq("B4 · completed queued exactly one completion_congrats", typeCount(fullMails, "completion_congrats"), 1);
      eq("B5 · …and nothing else at all", fullMails.length, 4);
      eq("B6 · every row is addressed to the client's own address",
        [...new Set(fullMails.map((r) => r.to_email))], [full.email]);

      // Idempotent: back to Offer and forward again leaves one of each, not two.
      await setStage(page, full.caseId, "offer");
      await setStage(page, full.caseId, "completed");
      const againMails = await readRows(page, "email_queue", { case_id: full.caseId });
      eq("B7 · moving back to Offer and forward again queues nothing new (idempotent per case+type)",
        againMails.length, 4);

      // Setting OFF ("0") — the seeded spelling for off.
      await setSetting(page, "auto_offer_update", "0");
      const offCase = await mkClientCase(page, { first: "Trigger", last: "Settingoff", stage: "application", assigned_to: "p2" });
      await setStage(page, offCase.caseId, "offer");
      const offMails = await readRows(page, "email_queue", { case_id: offCase.caseId });
      eq("B8 · with auto_offer_update = \"0\", arriving at Offer queues nothing", offMails.length, 0);
      await setSetting(page, "auto_offer_update", "on");

      // Suppressed client — the email is withheld, silently.
      const supp = await mkClientCase(page, { first: "Trigger", last: "Suppressed", stage: "enquiry", assigned_to: "p2", suppress: true });
      await setStage(page, supp.caseId, "fact_find");
      eq("B9 · a suppress_automation client is never queued a stage email",
        (await readRows(page, "email_queue", { case_id: supp.caseId })).length, 0);

      // No email address at all — nothing to send to.
      const noMail = await mkClientCase(page, { first: "Trigger", last: "Noemail", stage: "enquiry", assigned_to: "p2", email: "" });
      await setStage(page, noMail.caseId, "fact_find");
      eq("B10 · a client with no email address is never queued a stage email",
        (await readRows(page, "email_queue", { case_id: noMail.caseId })).length, 0);

      // The exchange solicitor task.
      const days = Number(await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("key,value").eq("key", "solicitor_chase_days").single();
        return data ? data.value : "7";
      }));
      const dueGT = await page.evaluate((d) => {
        const x = new Date(Date.now() + d * 86400000);
        const p = (n) => String(n).padStart(2, "0");
        return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate());
      }, days);
      const exch = await mkClientCase(page, { first: "Trigger", last: "Exchange", stage: "offer", assigned_to: "p3" });
      await setStage(page, exch.caseId, "exchange");
      const exTasks = (await readRows(page, "case_tasks", { case_id: exch.caseId }))
        .filter((t) => /^Chase solicitors/.test(t.title || ""));
      eq("B11 · arriving at Exchange raises exactly one solicitor-chase task", exTasks.length, 1);
      eq("B12 · …titled the way the watchtower's LIKE 'Chase solicitors%' rule expects",
        exTasks[0] && exTasks[0].title, "Chase solicitors for completion date");
      eq("B13 · …due today + solicitor_chase_days", exTasks[0] && exTasks[0].due_date, dueGT);
      eq("B14 · …assigned to the case's own adviser", exTasks[0] && exTasks[0].assigned_to, "p3");
      await setStage(page, exch.caseId, "offer");
      await setStage(page, exch.caseId, "exchange");
      const exTasks2 = (await readRows(page, "case_tasks", { case_id: exch.caseId }))
        .filter((t) => /^Chase solicitors/.test(t.title || ""));
      eq("B15 · re-entering Exchange with the task still open raises no second one", exTasks2.length, 1);

      // A save that does not move the stage must queue nothing at all.
      const quiet = await mkClientCase(page, { first: "Trigger", last: "Nostagechange", stage: "fact_find", assigned_to: "p2" });
      await page.evaluate(async (id) => { await window.__mockDb.from("cases").update({ lender: "Skipton" }).eq("id", id); }, quiet.caseId);
      eq("B16 · editing a case without changing its stage queues nothing",
        (await readRows(page, "email_queue", { case_id: quiet.caseId })).length, 0);

      ok("B17 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §C · SETTINGS — bool10 rows holding 'on'
       ===================================================================== */
    {
      console.log("\n— §C · a bool10 setting stored as 'on' renders as On (p4)");
      const page = await newPage(browser, "p4");
      /* Production holds these five as 'on'/'off'; the Settings FORM writes "1"/"0". Store the
         production spelling on one that ships seeded OFF, then make the app re-read the settings
         table (loadSettings is a top-level function declaration in app.js, so it is reachable by
         bare name here) before rendering the page — the mock DB is per-page, so a reload would
         throw the change away with the rest of the fixture. */
      await setSetting(page, "auto_offer_update", "on");
      await setSetting(page, "auto_referral", "0");
      await page.evaluate(async () => { await loadSettings(); });
      await goto(page, "settings", 1400);
      const sel = await page.evaluate(() => {
        const read = (k) => {
          const el = document.querySelector(`select[name="${k}"]`);
          if (!el) return null;
          return { value: el.value, label: (el.options[el.selectedIndex] || {}).textContent };
        };
        return {
          on: read("auto_offer_update"),        // stored 'on'  → must render On
          one: read("auto_docs_request"),       // stored "1"   → must render On
          off: read("auto_referral"),           // stored "0"   → must render Off
        };
      });
      eq("C1 · a row stored as 'on' renders as On", sel.on, { value: "1", label: "On" });
      eq("C2 · a row stored as \"1\" still renders as On", sel.one, { value: "1", label: "On" });
      eq("C3 · a row stored as \"0\" still renders as Off", sel.off, { value: "0", label: "Off" });
      ok("C4 · no console errors on Settings", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §D · SMS COPY — the queue is on a cron, and the page says so
       ===================================================================== */
    {
      console.log("\n— §D · the Emails page stops claiming SMS has no cron of its own (p1)");
      const page = await newPage(browser, "p1");
      await goto(page, "emails", 1600);
      const smsSummary = await txt(page, "#sms-summary");
      ok("D1 · the SMS summary renders", smsSummary.length > 0, smsSummary);
      ok("D2 · it no longer says SMS is not on a cron / nothing goes until somebody presses Send",
        !/no cron|not on the 8am cron|until somebody presses/i.test(smsSummary), smsSummary);
      ok("D3 · it names WHEN queued SMS go, the way the email summary names its run",
        /8:05\s*am/i.test(smsSummary), smsSummary);
      const emSummary = await txt(page, "#em-summary");
      ok("D4 · the email summary still names its own 8am run (unchanged)", /8am/i.test(emSummary), emSummary);
      const anySms = await page.evaluate(() =>
        [...document.querySelectorAll("#sms-list .row-item")].length);
      ok("D5 · the SMS list still renders its rows", anySms > 0, String(anySms));
      ok("D6 · nowhere on the page still carries the old 'no cron' claim",
        !/SMS is not on the 8am cron/i.test(await page.evaluate(() => document.body.innerText)));
      ok("D7 · no console errors on Emails", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §E · THE FACT FIND CHECKLIST PROMPT (H2)
       ===================================================================== */
    {
      console.log("\n— §E · advancing to Fact Find offers the kind-filtered checklist (p2)");
      const page = await newPage(browser, "p2");
      const docsList = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("key,value").eq("key", "docs_list").single();
        return data ? data.value : "";
      });
      const GT = suggestionsGT(docsList, "product_transfer");
      ok("E0 · the fixture's firm list yields a genuinely NARROWED product-transfer list",
        GT.suggested.length > 0 && GT.dropped.length > 0, JSON.stringify(GT));

      const openAdvance = async (c) => {
        await page.evaluate((id) => window.openCase(id), c.caseId);
        await wait(page, 700);
        await page.click("#cs-advance-btn");
        await wait(page, 700);
      };

      // E1 — the prompt appears, pre-ticked with exactly the kind's suggestions.
      const save = await mkClientCase(page, { first: "Factfind", last: "Savecase", stage: "enquiry", assigned_to: "p2", case_kind: "product_transfer" });
      await openAdvance(save);
      ok("E1 · the Fact Find stage-entry prompt opens on a case with no checklist", await overlayOpen(page));
      const picks = await page.evaluate(() => ({
        ticked: [...document.querySelectorAll("#se-doc-suggested input:checked")].map((i) => i.value),
        suggested: [...document.querySelectorAll("#se-doc-suggested input")].map((i) => i.value),
        dropped: [...document.querySelectorAll("#se-doc-dropped input")].map((i) => i.value),
        droppedTicked: [...document.querySelectorAll("#se-doc-dropped input:checked")].length,
        copy: (document.querySelector("#overlay-box") || document.body).innerText,
      }));
      eq("E2 · the suggested list is exactly docSuggestionsFor(kind).suggested", picks.suggested, GT.suggested);
      eq("E3 · …and every one of them is pre-ticked", picks.ticked, GT.suggested);
      eq("E4 · the dropped items are offered but NOT ticked", picks.dropped, GT.dropped);
      eq("E5 · …none of them pre-ticked", picks.droppedTicked, 0);
      ok("E6 · the prompt says in plain English why an empty checklist matters",
        /no checklist is never chased/i.test(picks.copy), picks.copy.slice(0, 300));
      ok("E7 · all three exits are offered", await page.evaluate(() =>
        !!document.querySelector("#se-cancel") && !!document.querySelector("#se-skip") && !!document.querySelector("#se-ok")));

      await page.click("#se-ok");
      await wait(page, 1200);
      const savedCase = await readRow(page, "cases", save.caseId);
      eq("E8 · Save & advance moves the case to Fact Find", savedCase.stage, "fact_find");
      const savedDocs = await readRows(page, "case_documents", { case_id: save.caseId });
      eq("E9 · …and creates one checklist row per ticked item",
        savedDocs.map((d) => d.item).sort(), GT.suggested.slice().sort());
      eq("E10 · …every one of them outstanding, the way Add items… writes them",
        [...new Set(savedDocs.map((d) => d.status))], ["requested"]);
      ok("E11 · …each stamped with a requested_at", savedDocs.every((d) => !!d.requested_at));
      const savedToast = await toastText(page);
      ok("E12 · the move's own toast says how many checklist items were added",
        new RegExp(`${GT.suggested.length} checklist items added`).test(savedToast), savedToast);

      // E13 — Skip advances and writes nothing.
      const skip = await mkClientCase(page, { first: "Factfind", last: "Skipcase", stage: "enquiry", assigned_to: "p2", case_kind: "product_transfer" });
      await openAdvance(skip);
      ok("E13 · the prompt opens for the second case too", await overlayOpen(page));
      await page.click("#se-skip");
      await wait(page, 1200);
      eq("E14 · Skip still advances the stage", (await readRow(page, "cases", skip.caseId)).stage, "fact_find");
      eq("E15 · …and writes no checklist at all",
        (await readRows(page, "case_documents", { case_id: skip.caseId })).length, 0);

      // E16 — Don't advance leaves the case exactly where it was.
      const cancel = await mkClientCase(page, { first: "Factfind", last: "Cancelcase", stage: "enquiry", assigned_to: "p2", case_kind: "product_transfer" });
      await openAdvance(cancel);
      await page.click("#se-cancel");
      await wait(page, 1200);
      eq("E16 · Don't advance leaves the stage alone", (await readRow(page, "cases", cancel.caseId)).stage, "enquiry");
      eq("E17 · …and writes no checklist", (await readRows(page, "case_documents", { case_id: cancel.caseId })).length, 0);

      // E18 — a case that already has a checklist is never asked.
      const has = await mkClientCase(page, { first: "Factfind", last: "Haschecklist", stage: "enquiry", assigned_to: "p2", case_kind: "product_transfer" });
      await page.evaluate(async (id) => {
        await window.__mockDb.from("case_documents")
          .insert({ case_id: id, item: "Photo ID", status: "requested", requested_at: new Date().toISOString() });
      }, has.caseId);
      await openAdvance(has);
      ok("E18 · a case that already has a checklist raises NO prompt", !(await overlayOpen(page)));
      await wait(page, 900);
      eq("E19 · …and advances straight through", (await readRow(page, "cases", has.caseId)).stage, "fact_find");
      eq("E20 · …with its existing checklist untouched (no second copy of the list)",
        (await readRows(page, "case_documents", { case_id: has.caseId })).length, 1);

      // E21 — the kind gating actually differs: a first-time buyer gets a LONGER list than a PT.
      const ftbGT = suggestionsGT(docsList, "first_time_buyer");
      const ftb = await mkClientCase(page, { first: "Factfind", last: "Ftbcase", stage: "enquiry", assigned_to: "p2", case_kind: "first_time_buyer" });
      await openAdvance(ftb);
      const ftbPicks = await page.evaluate(() =>
        [...document.querySelectorAll("#se-doc-suggested input:checked")].map((i) => i.value));
      eq("E21 · a first-time buyer's pre-ticked list is its OWN kind's list, not the PT one", ftbPicks, ftbGT.suggested);
      ok("E22 · …and it genuinely differs from the product transfer's",
        JSON.stringify(ftbPicks) !== JSON.stringify(GT.suggested), JSON.stringify({ ftbPicks, pt: GT.suggested }));
      await page.click("#se-cancel");
      await wait(page, 600);

      // E23 — the programmatic path stays headless, exactly as the DIP/Offer prompts do.
      const headless = await mkClientCase(page, { first: "Factfind", last: "Headlesscase", stage: "enquiry", assigned_to: "p2", case_kind: "product_transfer" });
      const res = await page.evaluate((id) => window.moveCaseToStage(id, "fact_find", { skipReload: true }), headless.caseId);
      await wait(page, 600);
      eq("E23 · a programmatic moveCaseToStage() to Fact Find still just moves", res, "moved");
      ok("E24 · …raising no overlay", !(await overlayOpen(page)));
      eq("E25 · …and creating no checklist behind anybody's back",
        (await readRows(page, "case_documents", { case_id: headless.caseId })).length, 0);

      ok("E26 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §F · NO CONSOLE ERRORS ON THE TOUCHED PAGES
       ===================================================================== */
    {
      console.log("\n— §F · the pages this round touched stay clean for p2 and p1");
      for (const persona of ["p2", "p1"]) {
        const page = await newPage(browser, persona);
        for (const pg of ["dashboard", "pipeline", "clients", "emails", "data", "settings"]) {
          await goto(page, pg, 1100);
        }
        ok(`F · ${persona} · no console errors across dashboard/pipeline/clients/emails/data/settings`,
          !page.__err, JSON.stringify(page.__err));
        await page.close();
      }
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log(`\nR63_DOCS: ${pass} checks, ${failures.length} failures`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
