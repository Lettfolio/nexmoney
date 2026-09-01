#!/usr/bin/env node
/* =============================================================================
   tests/r9_adv.js — acceptance tests for ROUND 9, the ADVOCACY ENGINE.

     R9-1  REFERRER ATTRIBUTION — the "Referred by (client)" picker on the case
           form (m11, feature-detected: no column ⇒ no field), the referrer on
           the case modal's identity line linking to that person's record, and
           the thank-you TASK offered when a referred case completes — on the
           referrer's most relevant case, by the same target rule the Clients
           page's bulk task already uses, assigned to the COMPLETING case's
           adviser, and never on a move that is not a completion.
     R9-2  ADVOCACY DASHBOARD (Reports, Owner-only) — review score by adviser
           with round-3's n<5 suppression, reviews per month, referrals per
           completion, top referrers with converted value under the owner money
           rule, and outstanding detractor follow-ups.
     R9-3  DETRACTOR VISIBILITY — "Review feedback (n/10)" notes rendered with
           the score banded and visible on the case AND on the client timeline,
           open review-feedback tasks surfaced distinctly in My Day, and the
           ~7-day review reminder described honestly on Emails and in Settings.
     R9-4  CLIENT RECORD — "Referred N clients" on a referrer, "Referred by
           <name>" on a referred client, and neither without the migration.

   EVERY figure this file asserts is recomputed HERE, from the fixture tables
   (cases / clients / case_tasks / case_notes / email_queue), in an
   implementation written separately from app.js's. Nothing is compared against
   app.js's own idea of the answer, and nothing date-relative is hardcoded —
   see the standing rules in HARNESS.md.

   Run:  node /root/nx/tests/r9_adv.js   (expects a static server on 8099;
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
const MIN_N = 5;                 // the round-3 conversion boundary, reused for review scores

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

/* Dialog handling matters more in this file than in most: a completion asks
   TWICE (the stage confirm, then the thank-you offer) and the difference
   between accepting both, accepting one, and accepting neither is the whole
   behaviour under test. `page.__answers` is a queue — an array of
   "accept"/"dismiss" consumed in order — falling back to __dialogAnswer. */
async function newPage(browser, persona, viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  page.__dialogs = [];
  page.__answers = [];
  page.__dialogAnswer = "accept";
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    const want = page.__answers.length ? page.__answers.shift() : page.__dialogAnswer;
    if (want === "dismiss") await d.dismiss();
    else await d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
/* R76: completing a case interactively now opens the house Completed stage-entry overlay
   (#stage-completed-*) instead of a native confirm, and the referral thank-you offer is a house
   overlay too (#ovl-confirm-ok / #ovl-confirm-cancel). PLAYWRIGHT-AWAIT: the move promise must
   NOT be awaited inside page.evaluate while an overlay is up — fire it, drive the DOM, then read
   the stored promise. `referral` = "accept" | "decline" | null (no referral overlay expected). */
async function completeCase76(page, caseId, referral) {
  await page.evaluate((id) => { window.__r76mv = window.moveCaseToStage(id, "completed"); }, caseId);
  await page.waitForSelector("#stage-completed-ok", { timeout: 8000 });
  const completedBody = await page.$eval("#overlay-modal", (e) => e.textContent);
  await page.click("#stage-completed-ok");
  let referralBody = null;
  if (referral) {
    await page.waitForSelector("#ovl-confirm-ok", { timeout: 8000 });
    referralBody = await page.$eval("#overlay-modal", (e) => e.textContent);
    await page.click(referral === "accept" ? "#ovl-confirm-ok" : "#ovl-confirm-cancel");
  }
  const result = await page.evaluate(() => window.__r76mv);
  await page.waitForTimeout(1300);
  return { completedBody, referralBody, result };
}
const gotoReports = async (page) => { await page.evaluate(() => window.nav("reports")); await page.waitForTimeout(2200); };
const gotoToday = async (page) => { await page.evaluate(() => window.nav("dashboard")); await page.waitForTimeout(1400); };

/* ---------------------------------------------------------------------------
   GROUND TRUTH — the whole advocacy picture, recomputed from the fixture
   tables in this file. If app.js and this disagree about who referred whom,
   what an adviser's mean score is, or which tasks are review follow-ups, the
   run goes red and one of the two is wrong.
   ------------------------------------------------------------------------- */
const groundTruth = (page) => page.evaluate(async ({ MIN_N }) => {
  const db = window.__mockDb;
  const [cs, cl, tk, nt, eqr] = await Promise.all([
    db.from("cases").select("id,client_id,stage,assigned_to,nps_score,referrer_client_id,completed_at,review_requested_at,proc_fee,broker_fee,sols_fee"),
    db.from("clients").select("id,first_name,last_name"),
    db.from("case_tasks").select("id,title,case_id,assigned_to,due_date,done_at"),
    db.from("case_notes").select("id,case_id,body,created_at"),
    db.from("email_queue").select("id,case_id,email_type,status,sent_at"),
  ]);
  const cases = cs.data || [], clients = cl.data || [], tasks = tk.data || [], notes = nt.data || [], mails = eqr.data || [];
  const nameOf = (id) => { const c = clients.find((x) => x.id === id); return c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() : ""; };
  const LIVE = (s) => s !== "completed" && s !== "not_proceeding";
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  const monthOf = (d) => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit" }).format(new Date(d)).slice(0, 7) : null);

  // --- referrals ---------------------------------------------------------
  const referredCases = cases.filter((c) => c.referrer_client_id);
  const referredPeople = [...new Set(referredCases.map((c) => c.client_id).filter(Boolean))];
  const completed = cases.filter((c) => c.stage === "completed");
  // where a thank-you would land, per the "only case / only live case" rule
  const targetFor = (referrerId) => {
    const own = cases.filter((c) => c.client_id === referrerId);
    if (!own.length) return { why: "no_case" };
    if (own.length === 1) return { caseId: own[0].id };
    const live = own.filter((c) => LIVE(c.stage));
    if (live.length === 1) return { caseId: live[0].id };
    return { why: live.length > 1 ? "many_live" : "no_live" };
  };
  const referrals = referredCases.map((c) => ({
    caseId: c.id, stage: c.stage, adviser: c.assigned_to,
    client: nameOf(c.client_id), clientId: c.client_id,
    referrerId: c.referrer_client_id, referrer: nameOf(c.referrer_client_id),
    target: targetFor(c.referrer_client_id),
    expectTitle: `Thank ${nameOf(c.referrer_client_id)} for referring ${nameOf(c.client_id)}`,
  }));
  const byReferrer = {};
  referredCases.forEach((c) => {
    const k = c.referrer_client_id;
    byReferrer[k] = byReferrer[k] || { id: k, name: nameOf(k), people: [], cases: 0, done: 0, value: 0 };
    byReferrer[k].cases++;
    if (c.client_id && byReferrer[k].people.indexOf(c.client_id) < 0) byReferrer[k].people.push(c.client_id);
    if (c.stage === "completed") {
      byReferrer[k].done++;
      byReferrer[k].value += Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0);
    }
  });
  const topReferrers = Object.values(byReferrer)
    .map((v) => ({ id: v.id, name: v.name, referrals: v.people.length, done: v.done, value: v.value }))
    .sort((a, b) => b.referrals - a.referrals || b.value - a.value);

  // --- review scores -----------------------------------------------------
  const scoredAll = cases.filter((c) => c.nps_score != null);
  const scoredCompleted = completed.filter((c) => c.nps_score != null);
  const advMap = {};
  scoredCompleted.forEach((c) => {
    const k = c.assigned_to || "";
    advMap[k] = advMap[k] || [];
    advMap[k].push(Number(c.nps_score));
  });
  const npsByAdviser = Object.keys(advMap).map((k) => {
    const scores = advMap[k];
    return {
      id: k, n: scores.length,
      avg: Number((scores.reduce((s, x) => s + x, 0) / scores.length).toFixed(1)),
      detractors: scores.filter((x) => x <= 6).length,
      suppressed: scores.length < MIN_N,
    };
  }).sort((a, b) => b.n - a.n);

  // six calendar months ending on this one, oldest first
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(monthOf(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  // there is no capture-date column in this schema — the series therefore dates
  // by review_requested_at, and the panel has to SAY so
  const hasCaptureCol = ["review_score_at", "review_scored_at", "nps_scored_at", "nps_score_at", "reviewed_at"]
    .some((k) => cases.length && Object.prototype.hasOwnProperty.call(cases[0], k));
  const perMonth = months.map((mv) => scoredAll.filter((c) => monthOf(c.review_requested_at || c.completed_at) === mv).length);

  // --- detractor follow-ups ---------------------------------------------
  const isRevTask = (t) => /review\s+feedback/i.test(String(t || ""));
  const openRevTasks = tasks.filter((t) => !t.done_at && isRevTask(t.title)).map((t) => {
    const c = cases.find((x) => x.id === t.case_id);
    return { id: t.id, title: t.title, caseId: t.case_id, due: t.due_date, adviser: t.assigned_to, client: c ? nameOf(c.client_id) : "" };
  }).sort((a, b) => String(a.due || "").localeCompare(String(b.due || "")));
  const revNotes = notes.filter((n) => /^\s*review\s+feedback\s*\(\s*\d{1,2}\s*\/\s*10\s*\)/i.test(String(n.body || "")))
    .map((n) => ({ caseId: n.case_id, score: Number(/\((\d{1,2})\/10\)/.exec(n.body)[1]), body: n.body }));

  return {
    todayStr, months, perMonth, hasCaptureCol,
    nCases: cases.length, nCompleted: completed.length,
    referrals, referredCaseIds: referredCases.map((c) => c.id), referredPeople, topReferrers,
    ratio: completed.length ? Number((referredPeople.length / completed.length).toFixed(2)) : null,
    npsByAdviser, nScoredAll: scoredAll.length, nScoredCompleted: scoredCompleted.length,
    openRevTasks, revNotes,
    reviewRequestsSent: mails.filter((m) => m.email_type === "review_request" && m.status === "sent").length,
  };
}, { MIN_N });

const tasksOnCase = (page, caseId) => page.evaluate(async (cid) =>
  ((await window.__mockDb.from("case_tasks").select("id,title,due_date,assigned_to,done_at,created_by").eq("case_id", cid)).data || [])
    .map((t) => ({ title: t.title, due: t.due_date, adviser: t.assigned_to, done: !!t.done_at })), caseId);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       0 · FIXTURE SHAPE — stated once, so a later failure can be read as
       "the app is wrong" rather than "the fixtures moved under us"
       =================================================================== */
    let GT;
    {
      console.log("\n— R9 · fixture shape");
      const page = await newPage(browser, "p4");
      GT = await groundTruth(page);
      ok("fixture · at least one case carries a referrer", GT.referrals.length > 0, JSON.stringify(GT.referrals.length));
      ok("fixture · a referrer exists whose thank-you has ONE unambiguous target",
        GT.referrals.some((r) => !r.target.why), JSON.stringify(GT.referrals.map((r) => r.target)));
      ok("fixture · a referrer exists with NO unambiguous target (the decline-to-guess path)",
        GT.referrals.some((r) => !!r.target.why), JSON.stringify(GT.referrals.map((r) => r.target)));
      ok("fixture · the scored book spans detractors, passives and promoters",
        GT.npsByAdviser.length > 0 && GT.nScoredCompleted > 0
        && GT.npsByAdviser.some((a) => a.detractors > 0), JSON.stringify(GT.npsByAdviser));
      ok("fixture · at least one adviser is over the n<5 line and at least one under it",
        GT.npsByAdviser.some((a) => !a.suppressed) && GT.npsByAdviser.some((a) => a.suppressed),
        JSON.stringify(GT.npsByAdviser.map((a) => a.n)));
      ok("fixture · exactly one review-feedback note exists, and it is a detractor",
        GT.revNotes.length >= 1 && GT.revNotes.every((n) => n.score <= 6), JSON.stringify(GT.revNotes.map((n) => n.score)));
      ok("fixture · an open review-feedback call-back task exists", GT.openRevTasks.length >= 1, JSON.stringify(GT.openRevTasks));
      eq("fixture · this schema has NO column recording when a score came back", GT.hasCaptureCol, false);
      ok("no console errors (fixture read)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       1 · R9-1 · THE REFERRER FIELD — render, save, re-render
       =================================================================== */
    {
      console.log("\n— R9-1 · referrer set / save / render");
      const page = await newPage(browser, "p4");
      const ref = GT.referrals.find((r) => !r.target.why);

      // (a) the field exists, is labelled, and offers the book minus this case's own client
      await page.evaluate((id) => window.openCase(id), ref.caseId);
      await page.waitForTimeout(900);
      const field = await page.evaluate(() => {
        const s = document.querySelector("#case-referrer-select");
        if (!s) return null;
        const lab = document.querySelector("#case-referrer-field");
        return {
          value: s.value,
          label: (lab ? lab.textContent : "").replace(/\s+/g, " ").trim().slice(0, 40),
          nOpts: s.options.length,
          hint: (document.querySelector("#case-referrer-field") || {}).title || "",
          selText: (s.selectedOptions[0] || {}).text || "",
        };
      });
      ok("R9-1 · the case form renders a “Referred by (client)” picker", !!field && field.label.startsWith("Referred by (client)"), JSON.stringify(field));
      eq("R9-1 · it shows the referrer the case actually carries", field.value, ref.referrerId);
      ok("R9-1 · …by name, not by id", field.selText.includes(ref.referrer.split(" ").slice(-1)[0]), field.selText);
      ok("R9-1 · the hint says a thank-you TASK follows, and that nothing is emailed",
        /thank-you task/i.test(field.hint) && /nothing is emailed/i.test(field.hint), field.hint);
      const ownClientOffered = await page.evaluate(() => {
        const cid = document.querySelector("#case-client-select").value;
        return [...document.querySelector("#case-referrer-select").options].some((o) => o.value === cid && !o.hidden);
      });
      eq("R9-1 · a client is never offered as their own referrer", ownClientOffered, false);

      // (b) the identity line names the referrer and links to their record
      const idLine = await page.evaluate(() => {
        const e = document.querySelector("#cs-identity, .cs-identity");
        const r = document.querySelector("#cs-referrer");
        return { inIdentity: !!(e && r && e.contains(r)), text: r ? r.textContent.replace(/\s+/g, " ").trim() : "", href: r ? !!r.querySelector("a[data-client]") : false, target: r ? (r.querySelector("a[data-client]") || {}).dataset?.client : null };
      });
      ok("R9-1 · “Referred by <name>” sits on the case modal's identity line", idLine.inIdentity, JSON.stringify(idLine));
      ok("R9-1 · …naming the referrer", idLine.text.includes(ref.referrer), idLine.text);
      eq("R9-1 · …and linking to that person's record", idLine.target, ref.referrerId);

      // (c) set a referrer on a case that has none, save, reopen — it persisted
      const blank = await page.evaluate(async (skip) => {
        const { data } = await window.__mockDb.from("cases").select("id,client_id,referrer_client_id,stage");
        const c = data.find((x) => !x.referrer_client_id && x.stage !== "completed" && x.stage !== "not_proceeding" && skip.indexOf(x.id) < 0);
        return c ? c.id : null;
      }, GT.referredCaseIds);
      await page.evaluate((id) => window.openCase(id), blank);
      await page.waitForTimeout(800);
      eq("R9-1 · a case with no referrer renders no identity-line referrer", await page.evaluate(() => !!document.querySelector("#cs-referrer")), false);
      await page.evaluate((rid) => {
        const s = document.querySelector("#case-referrer-select");
        s.value = rid; s.dispatchEvent(new Event("change", { bubbles: true }));
      }, ref.referrerId);
      await page.click("#modal-save");
      await page.waitForTimeout(1200);
      const stored = await page.evaluate(async (id) => (await window.__mockDb.from("cases").select("referrer_client_id").eq("id", id)).data[0].referrer_client_id, blank);
      eq("R9-1 · Save writes referrer_client_id to the case", stored, ref.referrerId);
      await page.evaluate((id) => window.openCase(id), blank);
      await page.waitForTimeout(800);
      const reopened = await page.evaluate(() => ({
        sel: (document.querySelector("#case-referrer-select") || {}).value,
        line: (document.querySelector("#cs-referrer") || {}).textContent || "",
      }));
      eq("R9-1 · re-opening the case shows the saved referrer in the picker", reopened.sel, ref.referrerId);
      ok("R9-1 · …and on the identity line", reopened.line.includes(ref.referrer), reopened.line);
      ok("no console errors (referrer field)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       2 · R9-1 · FEATURE-DETECT OFF (m11 absent)
       =================================================================== */
    {
      console.log("\n— R9-1 · feature-detect · m11 absent");
      const page = await newPage(browser, "p4");
      const ref = GT.referrals.find((r) => !r.target.why);
      await page.evaluate(() => window.__mock.setMigrations({ m11: false }));
      await page.evaluate((id) => window.openCase(id), ref.caseId);
      await page.waitForTimeout(900);
      const off = await page.evaluate(() => ({
        field: !!document.querySelector("#case-referrer-select"),
        line: !!document.querySelector("#cs-referrer"),
        clientSelStillThere: !!document.querySelector("#case-client-select"),
        saveBtn: !!document.querySelector("#modal-save"),
      }));
      eq("R9-1 · without m11 no “Referred by” field is rendered at all", off.field, false);
      eq("R9-1 · …and no referrer appears on the identity line", off.line, false);
      ok("R9-1 · …while the rest of the case form is untouched", off.clientSelStillThere && off.saveBtn, JSON.stringify(off));
      // the case still saves — a missing reporting column must not cost the edit
      await page.click("#modal-save");
      await page.waitForTimeout(1000);
      ok("R9-1 · a case still saves on an un-migrated database", /saved/i.test(await toastText(page)), await toastText(page));

      await page.evaluate(() => window.closeModal && window.closeModal());
      await page.evaluate((cid) => window.openClient(cid), ref.referrerId);
      await page.waitForTimeout(900);
      eq("R9-4 · without m11 the client record shows no advocacy line", await page.evaluate(() => !!document.querySelector("#client-advocacy")), false);
      await page.evaluate(() => window.closeModal && window.closeModal());

      await gotoReports(page);
      const advOff = await page.evaluate(() => ({
        basis: (document.querySelector("#report-advocacy-basis") || {}).textContent || "",
        ratio: (document.querySelector("#adv-block-ratio") || {}).textContent || "",
        top: (document.querySelector("#adv-block-top") || {}).textContent || "",
        hasNumber: !!document.querySelector("#adv-ratio"),
      }));
      ok("R9-2 · the dashboard says m11 has not run rather than reporting a zero",
        /m11/.test(advOff.basis) && /m11/.test(advOff.ratio) && advOff.hasNumber === false, JSON.stringify(advOff).slice(0, 300));
      ok("R9-2 · …and the top-referrer block says the same", /m11/.test(advOff.top), advOff.top.slice(0, 160));
      ok("R9-2 · the review blocks still render without m11 (they do not depend on it)",
        (await page.evaluate(() => !!document.querySelector("#adv-nps-table"))) === true);
      ok("no console errors (m11 off)", !page.__err, JSON.stringify(page.__err));
      await page.evaluate(() => window.__mock.setMigrations({ m11: true }));
      await page.close();
    }

    /* ===================================================================
       3 · R9-1 · THE THANK-YOU TASK
       =================================================================== */
    {
      console.log("\n— R9-1 · thank-you task on completion");
      const ref = GT.referrals.find((r) => !r.target.why);
      const skip = GT.referrals.find((r) => !!r.target.why);

      // (a) accept both prompts → exactly one task, on the right case, right title, right adviser, due today
      /* R76: both prompts are house overlays now — the Completed stage-entry overlay first, then
         the referral offer. The claims are unchanged; only where the words live moved. */
      {
        const page = await newPage(browser, "p4");
        const before = await tasksOnCase(page, ref.target.caseId);
        const flow = await completeCase76(page, ref.caseId, "accept");
        const msgs = [flow.completedBody || "", flow.referralBody || ""];
        ok("R9-1 · the completion overlay warns that a thank-you will be offered",
          /referred/i.test(msgs[0]) && /thank-you task/i.test(msgs[0]), (msgs[0] || "").slice(0, 200));
        ok("R9-1 · …and states that no email is sent either way", /No email is sent to anybody either way/i.test(msgs[0] || ""), (msgs[0] || "").slice(-120));
        ok("R9-1 · a second (house) dialog ASKS before writing on the referrer's file",
          !!flow.referralBody && msgs[1].includes(ref.referrer) && msgs[1].includes(ref.client), (msgs[1] || "").slice(0, 200));
        ok("R9-1 · …naming the exact task, its due date and its assignee", /due today/i.test(msgs[1] || "") && /assigned to/i.test(msgs[1] || ""), (msgs[1] || "").slice(0, 220));
        eq("R9-1 · R76 — no native dialog anywhere in the flow", page.__dialogs.length, 0);
        const after = await tasksOnCase(page, ref.target.caseId);
        const made = after.filter((t) => !before.some((b) => b.title === t.title));
        eq("R9-1 · exactly one task is created", made.length, 1);
        eq("R9-1 · …titled “Thank <referrer> for referring <client>”", made[0].title, ref.expectTitle);
        eq("R9-1 · …assigned to the COMPLETING case's adviser", made[0].adviser, ref.adviser);
        eq("R9-1 · …due today", made[0].due, GT.todayStr);
        const elsewhere = await page.evaluate(async (t) => {
          const { data } = await window.__mockDb.from("case_tasks").select("case_id,title");
          return (data || []).filter((x) => x.title === t).map((x) => x.case_id);
        }, ref.expectTitle);
        eq("R9-1 · …and nowhere else", elsewhere, [ref.target.caseId]);
        ok("R9-1 · the move toast reports the thank-you rather than being overwritten by it",
          /Thank-you task created/i.test(await toastText(page)), await toastText(page));
        ok("no console errors (thank-you accept)", !page.__err, JSON.stringify(page.__err));
        await page.close();
      }

      // (b) decline the offer → the completion still happens, the referrer's file is untouched
      // R76: "decline" is now #ovl-confirm-cancel on the referral overlay.
      {
        const page = await newPage(browser, "p4");
        const before = await tasksOnCase(page, ref.target.caseId);
        await completeCase76(page, ref.caseId, "decline");
        eq("R9-1 · declining the offer writes no task", await tasksOnCase(page, ref.target.caseId), before);
        const stage = await page.evaluate(async (id) => (await window.__mockDb.from("cases").select("stage").eq("id", id)).data[0].stage, ref.caseId);
        eq("R9-1 · …and the case still completed", stage, "completed");
        await page.close();
      }

      // (c) NOT a completion → no prompt at all, no task
      {
        const page = await newPage(browser, "p4");
        const before = await tasksOnCase(page, ref.target.caseId);
        await page.evaluate((id) => window.moveCaseToStage(id, "exchange"), ref.caseId);
        await page.waitForTimeout(1400);
        eq("R9-1 · a move that is not a completion prompts nothing", page.__dialogs.length, 0);
        eq("R9-1 · …and creates no thank-you task", await tasksOnCase(page, ref.target.caseId), before);
        // …and neither does a completion on a case with NO referrer
        const plain = await page.evaluate(async (skipIds) => {
          const { data } = await window.__mockDb.from("cases").select("id,referrer_client_id,stage");
          const c = data.find((x) => !x.referrer_client_id && x.stage === "offer" && skipIds.indexOf(x.id) < 0);
          return c ? c.id : null;
        }, GT.referredCaseIds);
        if (plain) {
          page.__dialogs = [];
          /* R76: the ordinary completion pause is the house Completed overlay now — no native
             dialog at all, and no referral overlay follows for a case with no referrer. */
          const flow = await completeCase76(page, plain, null);
          eq("R9-1 · completing a case with no referrer raises no native dialog", page.__dialogs.length, 0);
          ok("R9-1 · …the Completed overlay appeared with no mention of a referral",
            !!flow.completedBody && !/referred|thank-you/i.test(flow.completedBody), (flow.completedBody || "").slice(0, 160));
          eq("R9-1 · …and no referral overlay followed",
            await page.evaluate(() => !!document.querySelector("#ovl-confirm-ok")), false);
        }
        ok("no console errors (non-completion)", !page.__err, JSON.stringify(page.__err));
        await page.close();
      }

      // (d) the referrer with several live cases — nothing is guessed, and it says why
      if (skip) {
        const page = await newPage(browser, "p4");
        /* R63 — this counted EVERY case_tasks row in the database before and after the move, which
           was a fair proxy for "no thank-you task was written" only while a stage move wrote
           nothing else. R63's H1b makes reaching a stage add that stage's playbook steps to the
           case being moved (three of them at Completed), so the whole-table count now moves for a
           reason that has nothing to do with referrals. The CLAIM is unchanged and is what is
           measured instead: no THANK-YOU task exists anywhere, on any case. */
        const thankCount = () => page.evaluate(async () => ((await window.__mockDb.from("case_tasks").select("id,title")).data || [])
          .filter((t) => /^Thank .* for referring /.test(t.title || "")).length);
        const beforeAll = await thankCount();
        /* R76: the completion pause is the house overlay; the ambiguous referrer still gets NO
           ask of its own (maybeQueueReferralThankYou explains in the toast instead). */
        await completeCase76(page, skip.caseId, null);
        eq("R9-1 · an ambiguous referrer is not offered a task at all (no referral overlay, no native dialog)",
          (await page.evaluate(() => !!document.querySelector("#ovl-confirm-ok"))) || page.__dialogs.length > 0, false);
        const afterAll = await thankCount();
        eq("R9-1 · …and no task is written anywhere", afterAll, beforeAll);
        const t = await toastText(page);
        ok("R9-1 · …but the toast names the referrer and says why nothing happened",
          t.includes(skip.referrer) && /no thank-you task created/i.test(t), t);
        ok("R9-1 · …and points at the fix (their record, by hand)", /by hand/i.test(t), t);
        await page.close();
      }

      // (e) idempotency — reopen and re-complete, still one task
      {
        const page = await newPage(browser, "p4");
        await completeCase76(page, ref.caseId, "accept");
        /* R76: reopening a settled case interactively is confirmTyped REOPEN now — the same gate
           the bulk path has had since R75. Fire unawaited, type the word, press the danger OK. */
        await page.evaluate((id) => { window.__r76re = window.moveCaseToStage(id, "offer"); }, ref.caseId);
        await page.waitForSelector("#ovl-typed-input", { timeout: 8000 });
        ok("R9-1 · R76 — reopening asks for the typed word REOPEN",
          await page.evaluate(() => /REOPEN/.test(document.querySelector("#ovl-typed-label").textContent)));
        await page.fill("#ovl-typed-input", "REOPEN");
        await page.click("#ovl-typed-ok");
        eq("R9-1 · R76 — the typed gate reopens the case", await page.evaluate(() => window.__r76re), "reopened");
        await page.waitForTimeout(1100);
        page.__dialogs = [];
        await completeCase76(page, ref.caseId, null);
        const t = await tasksOnCase(page, ref.target.caseId);
        eq("R9-1 · re-completing a reopened case does not stack a second thank-you",
          t.filter((x) => x.title === ref.expectTitle).length, 1);
        eq("R9-1 · …and does not re-ask (no referral overlay on the second completion)",
          await page.evaluate(() => !!document.querySelector("#ovl-confirm-ok")), false);
        await page.close();
      }

      // (f) the case FORM is the other route to Completed and behaves identically
      {
        const page = await newPage(browser, "p4");
        const before = await tasksOnCase(page, ref.target.caseId);
        await page.evaluate((id) => window.openCase(id), ref.caseId);
        await page.waitForTimeout(900);
        // R33 — scoped to #modal: Settings' new #diag-details shares the `.case-details` styling
        // class and, being static markup, is always in the DOM — an unscoped selector now matches
        // it first, leaving the actual modal's drawer (and the stage select inside it) collapsed.
        await page.evaluate(() => { document.querySelector("#modal .case-details").open = true; document.querySelector("#case-form").elements.stage.value = "completed"; });
        await page.click("#modal-save");
        // R76: the thank-you offer is a house overlay now — accept it as the old auto-accepted confirm did.
        await page.waitForSelector("#ovl-confirm-ok", { timeout: 8000 });
        await page.click("#ovl-confirm-ok");
        await page.waitForTimeout(1600);
        const after = await tasksOnCase(page, ref.target.caseId);
        const made = after.filter((t) => !before.some((b) => b.title === t.title));
        eq("R9-1 · completing from the case form offers the same thank-you", made.length, 1);
        eq("R9-1 · …with the same title", made[0].title, ref.expectTitle);
        eq("R9-1 · …the same adviser", made[0].adviser, ref.adviser);
        ok("no console errors (form completion)", !page.__err, JSON.stringify(page.__err));
        await page.close();
      }
    }

    /* ===================================================================
       4 · R9-2 · THE DASHBOARD, RECOMPUTED
       =================================================================== */
    {
      console.log("\n— R9-2 · advocacy dashboard figures");
      const page = await newPage(browser, "p4");
      await gotoReports(page);
      const shown = await page.evaluate(() => {
        const rows = (sel, cols) => [...document.querySelectorAll(sel + " tr")].slice(1)
          .map((tr) => cols.map((i) => (tr.children[i] || {}).textContent?.replace(/\s+/g, " ").trim() ?? ""));
        const npsTr = [...document.querySelectorAll("#adv-nps-table tr")].slice(1);
        return {
          hidden: document.querySelector("#report-advocacy-panel").classList.contains("hidden"),
          nps: npsTr.map((tr) => ({
            adviser: tr.dataset.adviser,
            n: Number(tr.children[1].textContent.trim()),
            avg: tr.children[2].textContent.replace(/\s+/g, " ").trim(),
            suppressed: !!tr.children[2].querySelector(".stat-weak"),
            marked: /n<5/.test(tr.children[2].textContent.replace(/\s+/g, "")),
            detractors: tr.children[3].textContent.trim(),
          })),
          ratio: (document.querySelector("#adv-ratio") || {}).textContent?.trim(),
          ratioBasis: (document.querySelector("#adv-ratio-basis") || {}).textContent?.replace(/\s+/g, " ").trim() || "",
          top: rows("#adv-top-table", [0, 1, 2, 3]),
          topHasValueCol: [...document.querySelectorAll("#adv-top-table th")].length === 4,
          seriesBars: [...document.querySelectorAll("#adv-block-series .adv-mon")].map((d) => ({
            lbl: d.querySelector(".adv-mlbl").textContent.trim(),
            n: Number(d.querySelector(".adv-mn").textContent.trim() || 0),
          })),
          seriesBasis: (document.querySelector("#adv-series-basis") || {}).textContent?.replace(/\s+/g, " ").trim() || "",
          detr: rows("#adv-detractor-table", [0, 1, 2, 3]),
          detrBasis: (document.querySelector("#adv-detractor-basis") || {}).textContent?.replace(/\s+/g, " ").trim() || "",
        };
      });
      eq("R9-2 · the panel is visible to the Owner", shown.hidden, false);

      // --- NPS by adviser ---
      eq("R9-2 · one row per adviser who has any scored completion", shown.nps.length, GT.npsByAdviser.length);
      eq("R9-2 · the score COUNTS match the fixtures", shown.nps.map((r) => [r.adviser, r.n]).sort(),
        GT.npsByAdviser.map((r) => [r.id, r.n]).sort());
      const avgOk = shown.nps.every((r) => {
        const g = GT.npsByAdviser.find((x) => x.id === r.adviser);
        return g && r.avg.startsWith(g.avg.toFixed(1));
      });
      ok("R9-2 · every mean is the fixtures' own mean, to one decimal", avgOk,
        JSON.stringify({ shown: shown.nps.map((r) => [r.adviser, r.avg]), truth: GT.npsByAdviser.map((r) => [r.id, r.avg]) }));
      const detrOk = shown.nps.every((r) => {
        const g = GT.npsByAdviser.find((x) => x.id === r.adviser);
        return g && String(g.detractors || "") === r.detractors;
      });
      ok("R9-2 · the detractor count per adviser matches (scores of 6 or below)", detrOk, JSON.stringify(shown.nps.map((r) => [r.adviser, r.detractors])));

      // --- n-suppression, on the boundary ---
      const suppOk = shown.nps.every((r) => r.suppressed === (r.n < MIN_N) && r.marked === (r.n < MIN_N));
      ok(`R9-2 · n<${MIN_N} is marked and greyed, n≥${MIN_N} is not — on every row`, suppOk,
        JSON.stringify(shown.nps.map((r) => ({ n: r.n, suppressed: r.suppressed, marked: r.marked }))));
      const boundaryLow = shown.nps.filter((r) => r.n === MIN_N - 1);
      const boundaryHigh = shown.nps.filter((r) => r.n === MIN_N);
      if (boundaryLow.length) ok(`R9-2 · boundary · n=${MIN_N - 1} IS marked`, boundaryLow.every((r) => r.marked), JSON.stringify(boundaryLow));
      if (boundaryHigh.length) ok(`R9-2 · boundary · n=${MIN_N} is NOT marked`, boundaryHigh.every((r) => !r.marked), JSON.stringify(boundaryHigh));
      ok(`R9-2 · the suppression rule is stated on screen, not just applied`,
        (await page.evaluate(() => (document.querySelector("#adv-block-nps") || {}).textContent || "")).replace(/\s+/g, "").includes("n<5"));

      // --- referrals per completion ---
      eq("R9-2 · referrals per completion is referred PEOPLE ÷ completions", shown.ratio, GT.ratio.toFixed(2));
      ok("R9-2 · …and the basis names both numbers it divided",
        shown.ratioBasis.includes(`${GT.referredPeople.length} referred client`) && shown.ratioBasis.includes(`${GT.nCompleted} completed case`),
        shown.ratioBasis.slice(0, 200));
      ok("R9-2 · …and says it counts people, not cases", /PEOPLE referred/.test(shown.ratioBasis), shown.ratioBasis.slice(0, 160));

      // --- top referrers ---
      eq("R9-2 · one row per referrer, most referrals first",
        shown.top.map((r) => [r[0], Number(r[1]), Number(r[2])]),
        GT.topReferrers.map((r) => [r.name, r.referrals, r.done]));
      const valueOk = shown.top.every((r, i) => {
        const want = GT.topReferrers[i].value;
        const got = Number(String(r[3]).replace(/[^0-9.]/g, "")) || 0;
        return Math.round(got) === Math.round(want);
      });
      ok("R9-2 · converted value is proc+broker+sols on the referred cases that COMPLETED", valueOk,
        JSON.stringify({ shown: shown.top.map((r) => r[3]), truth: GT.topReferrers.map((r) => r.value) }));

      // --- reviews per month ---
      eq(`R9-2 · the mini-series covers ${GT.months.length} months`, shown.seriesBars.length, GT.months.length);
      eq("R9-2 · each month's count matches an independent recomputation", shown.seriesBars.map((b) => b.n), GT.perMonth);
      ok("R9-2 · the series says WHICH date it counted on",
        /review_requested_at/.test(shown.seriesBasis), shown.seriesBasis.slice(0, 200));
      ok("R9-2 · …and admits that is when we ASKED, not when they answered",
        /when the request went out/i.test(shown.seriesBasis) && /records no date/i.test(shown.seriesBasis), shown.seriesBasis.slice(0, 260));

      // --- detractor follow-ups ---
      eq("R9-2 · one row per OPEN review-feedback task", shown.detr.length, GT.openRevTasks.length);
      eq("R9-2 · …naming the client and the task", shown.detr.map((r) => [r[0], r[1]]),
        GT.openRevTasks.map((t) => [t.client, t.title]));
      ok("R9-2 · …and the count is stated in words underneath",
        shown.detrBasis.includes(`${GT.openRevTasks.length} open review-feedback task`), shown.detrBasis.slice(0, 160));
      const opensCase = await page.evaluate(() => !!document.querySelector("#adv-detractor-table button[onclick^='openCase']"));
      ok("R9-2 · …each linked to the case that holds what the client said", opensCase);
      ok("no console errors (dashboard)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       5 · R9-2 · HONEST EMPTY STATES
       =================================================================== */
    {
      console.log("\n— R9-2 · empty states");
      const page = await newPage(browser, "p4");
      // Clear every score and every referrer, then re-render: the panel must say
      // so in words rather than drawing confident nothing.
      await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data } = await db.from("cases").select("id,nps_score,referrer_client_id");
        for (const c of data) {
          if (c.nps_score != null || c.referrer_client_id) await db.from("cases").update({ nps_score: null, referrer_client_id: null }).eq("id", c.id);
        }
        const { data: tk } = await db.from("case_tasks").select("id,title,done_at");
        for (const t of tk) if (/review\s+feedback/i.test(t.title || "") && !t.done_at) await db.from("case_tasks").update({ done_at: new Date().toISOString() }).eq("id", t.id);
      });
      await gotoReports(page);
      const empt = await page.evaluate(() => ({
        nps: (document.querySelector("#adv-block-nps") || {}).textContent?.replace(/\s+/g, " ").trim() || "",
        series: (document.querySelector("#adv-block-series") || {}).textContent?.replace(/\s+/g, " ").trim() || "",
        top: (document.querySelector("#adv-block-top") || {}).textContent?.replace(/\s+/g, " ").trim() || "",
        detr: (document.querySelector("#adv-block-detractors") || {}).textContent?.replace(/\s+/g, " ").trim() || "",
        ratio: (document.querySelector("#adv-ratio") || {}).textContent?.trim() || "",
        anyTable: !!document.querySelector("#adv-nps-table, #adv-top-table, #adv-detractor-table"),
        emptyBlocks: document.querySelectorAll("#report-advocacy-grid .adv-empty").length,
      }));
      eq("R9-2 · with nothing to show, no table is drawn at all", empt.anyTable, false);
      ok("R9-2 · the score block says no case has returned one yet", /no completed case has returned a review score/i.test(empt.nps), empt.nps.slice(0, 200));
      ok("R9-2 · …and points at the switch that starts it", /Settings/.test(empt.nps), empt.nps.slice(0, 220));
      ok("R9-2 · the series block says no scores fall in the window", /No scores fall in the last/i.test(empt.series), empt.series.slice(0, 180));
      ok("R9-2 · the top-referrer block says nobody has been recorded, and where the field is",
        /Nobody has been recorded as a referrer/i.test(empt.top) && /Referred by \(client\)/.test(empt.top), empt.top.slice(0, 220));
      ok("R9-2 · the detractor block distinguishes “none” from “all closed”",
        /nobody has scored us badly/i.test(empt.detr) && /rung back and closed/i.test(empt.detr), empt.detr.slice(0, 220));
      eq("R9-2 · a zero ratio is shown as 0.00, not as a dash or a crash", empt.ratio, "0.00");
      ok("R9-2 · four blocks render an explicit empty state", empt.emptyBlocks >= 4, String(empt.emptyBlocks));
      ok("no console errors (empty states)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       6 · R9-3 · DETRACTOR VISIBILITY
       =================================================================== */
    {
      console.log("\n— R9-3 · detractor notes, tasks and My Day");
      const page = await newPage(browser, "p4");
      const note = GT.revNotes[0];

      // (a) the note on the case, with the score banded and out of the sentence
      await page.evaluate((id) => window.openCase(id), note.caseId);
      await page.waitForTimeout(900);
      /* R40 — #notes-list and noteRowHtml's standalone .note/.note-review/.note-ic/.note-body
         markup are gone; a review-feedback note is now a .tl-row[data-cat] inside
         #case-events-list, distinguished by its ⭐ icon and the .review-score-chip embedded in
         .tl-title (chip class + text unchanged — reviewScoreChipHtml wasn't touched by R40). */
      const rendered = await page.evaluate(() => {
        const row = [...document.querySelectorAll("#case-events-list .tl-row")].find((r) => r.querySelector(".review-score-chip"));
        if (!row) return null;
        const chip = row.querySelector(".review-score-chip");
        const title = row.querySelector(".tl-title");
        const clone = title.cloneNode(true);
        clone.querySelectorAll(".review-score-chip, .chip, .note-refile-btn").forEach((n) => n.remove());
        return {
          cat: row.dataset.cat,
          chipCls: chip ? chip.className : "",
          chipTxt: chip ? chip.textContent.replace(/\s+/g, " ").trim() : "",
          icon: (row.querySelector(".tl-ic") || {}).textContent || "",
          body: clone.textContent.trim(),
          chipTitle: chip ? chip.getAttribute("title") || "" : "",
        };
      });
      ok("R9-3 · a “Review feedback (n/10)” note renders as its own kind of row (⭐ icon, score chip)", !!rendered && rendered.icon === "⭐" && /review-score-chip/.test(rendered.chipCls), JSON.stringify(rendered));
      ok("R9-3 · …banded by score (this one is a detractor)", /detractor/.test(rendered.chipCls), rendered.chipCls);
      eq("R9-3 · …with the score visible as a chip", rendered.chipTxt, `${note.score}/10 · detractor`);
      ok("R9-3 · …and the client's words kept verbatim beside it",
        note.body.endsWith(rendered.body) && rendered.body.length > 0, JSON.stringify({ body: rendered.body.slice(0, 60), src: note.body.slice(0, 80) }));
      ok("R9-3 · …the score is NOT left buried in the sentence", !/^Review feedback \(/.test(rendered.body), rendered.body.slice(0, 40));
      ok("R9-3 · …and the chip explains the three bands", /0–6 detractor, 7–8 passive, 9–10 promoter/.test(rendered.chipTitle), rendered.chipTitle);

      // (b) the same note on the client timeline
      const clientId = await page.evaluate(async (cid) => (await window.__mockDb.from("cases").select("client_id").eq("id", cid)).data[0].client_id, note.caseId);
      await page.evaluate(() => window.closeModal && window.closeModal());
      await page.evaluate((id) => window.openClient(id), clientId);
      await page.waitForTimeout(1000);
      const tl = await page.evaluate(() => {
        const chip = document.querySelector("#tl-list .review-score-chip");
        return chip ? { cls: chip.className, txt: chip.textContent.replace(/\s+/g, " ").trim(), row: chip.closest(".tl-row") ? (chip.closest(".tl-row").querySelector(".tl-ic") || {}).textContent : "" } : null;
      });
      ok("R9-3 · the client timeline shows the same banded score", !!tl && tl.txt === `${note.score}/10 · detractor`, JSON.stringify(tl));
      eq("R9-3 · …with its own icon rather than the generic note one", tl.row, "⭐");
      await page.evaluate(() => window.closeModal && window.closeModal());
      ok("no console errors (note rendering)", !page.__err, JSON.stringify(page.__err));
      await page.close();

      // (c) My Day — the task's owner sees it, distinctly, before it goes overdue
      const task = GT.openRevTasks[0];
      const ownerPersona = task.adviser;
      {
        const p2p = await newPage(browser, ownerPersona);
        const row = await p2p.evaluate(() => {
          const b = document.querySelector("#briefing-list .review-task-badge");
          const r = b ? b.closest(".row-item, .brief-row, div") : null;
          return b ? { badge: b.textContent.replace(/\s+/g, " ").trim(), title: b.getAttribute("title") || "", listTxt: (document.querySelector("#briefing-list") || {}).innerText || "" } : null;
        });
        ok("R9-3 · My Day surfaces the open review-feedback task", !!row, "no .review-task-badge in #briefing-list");
        ok("R9-3 · …with a distinct chip, not just another TODAY badge", /REVIEW FEEDBACK/.test(row.badge), row.badge);
        ok("R9-3 · …explaining what it is and why it is urgent", /unhappy client/i.test(row.title) && /call-back/i.test(row.title), row.title);
        ok("R9-3 · …naming the client in the row", row.listTxt.includes(task.client), row.listTxt.slice(0, 200));
        ok("R9-3 · …and offering the case, where the client's words are", /Open case/.test(row.listTxt), row.listTxt.slice(0, 300));
        ok("R9-3 · the task is surfaced BEFORE it is overdue (its due date is not yet past)",
          !task.due || task.due >= GT.todayStr, JSON.stringify({ due: task.due, today: GT.todayStr }));
        ok("no console errors (My Day, owner of the task)", !p2p.__err, JSON.stringify(p2p.__err));
        await p2p.close();
      }
      // …and a colleague does NOT, under "Mine"
      {
        const other = ["p2", "p3"].find((x) => x !== ownerPersona) || "p2";
        const p = await newPage(browser, other);
        eq("R9-3 · a colleague's My Day does not show somebody else's call-back under “Mine”",
          await p.evaluate(() => document.querySelectorAll("#briefing-list .review-task-badge").length), 0);
        await p.evaluate(() => window.setBriefScope("all"));
        await p.waitForTimeout(1200);
        ok("R9-3 · …but it is there under “All”",
          (await p.evaluate(() => document.querySelectorAll("#briefing-list .review-task-badge").length)) >= 1);
        ok("no console errors (My Day, colleague)", !p.__err, JSON.stringify(p.__err));
        await p.close();
      }
    }

    /* ===================================================================
       7 · R9-3 · THE REVIEW REMINDER, DESCRIBED HONESTLY
       =================================================================== */
    {
      console.log("\n— R9-3 · reminder copy");
      const page = await newPage(browser, "p4");
      await page.evaluate(() => window.nav("emails"));
      await page.waitForTimeout(1400);
      const em = await page.evaluate(() => (document.querySelector("#emails-r9-note") || {}).textContent?.replace(/\s+/g, " ").trim() || "");
      ok("R9-3 · the Emails page says an unanswered request is followed up", /followed up once/i.test(em), em.slice(0, 140));
      ok("R9-3 · …about a week later", /a week/i.test(em), em.slice(0, 200));
      ok("R9-3 · …once per case, never a third time", /One per case ever/i.test(em) && /never a third/i.test(em), em.slice(0, 320));
      ok("R9-3 · …out of the same 5-a-run budget, taken after new requests",
        /5-a-run budget/i.test(em) && /only after them/i.test(em), em.slice(0, 420));
      ok("R9-3 · …and that it is cancellable while queued", /cancel the row/i.test(em), em.slice(0, 560));
      ok("R9-3 · …and that an unhappy answer creates a task, not an email",
        /call-back task/i.test(em) && /nothing is sent back to the client/i.test(em), em.slice(-260));

      // the reminder actually appears in the queue, labelled distinctly
      const reminded = await page.evaluate(async () => {
        const before = ((await window.__mockDb.from("email_queue").select("id,email_type")).data || []).filter((e) => e.email_type === "review_reminder").length;
        await window.__mock.queueCommsExtras();
        await window.__mock.queueCommsExtras();
        const after = ((await window.__mockDb.from("email_queue").select("id,email_type")).data || []).filter((e) => e.email_type === "review_reminder").length;
        return { before, after };
      });
      ok("R9-3 · the automation really does queue review reminders", reminded.after > reminded.before, JSON.stringify(reminded));
      await page.evaluate(() => window.nav("dashboard"));
      await page.waitForTimeout(600);
      await page.evaluate(() => window.nav("emails"));
      await page.waitForTimeout(1500);
      const listTxt = await page.evaluate(() => (document.querySelector("#email-list") || {}).innerText || "");
      ok("R9-3 · a reminder row is labelled as the SECOND ask, not as another request",
        /Review reminder \(2nd ask\)/.test(listTxt), listTxt.slice(0, 300));
      ok("R9-3 · …and never renders as a raw type or “undefined”", !/review_reminder|undefined —/.test(listTxt));

      // settings copy + the setting itself
      await page.evaluate(() => window.nav("settings"));
      await page.waitForTimeout(1600);
      const st = await page.evaluate(() => ({
        nps: (document.querySelector("#nps-note") || {}).textContent?.replace(/\s+/g, " ").trim() || "",
        rem: (document.querySelector("#nps-reminder-note") || {}).textContent?.replace(/\s+/g, " ").trim() || "",
        field: !!document.querySelector("[name='review_reminder_days']"),
        fieldVal: (document.querySelector("[name='review_reminder_days']") || {}).value,
        label: [...document.querySelectorAll("#settings-form label")].map((l) => l.textContent.trim()).find((t) => /Review reminder if unanswered/i.test(t)) || "",
      }));
      ok("R9-3 · Settings exposes the reminder delay as a real, editable setting", st.field, "no review_reminder_days input");
      ok("R9-3 · …labelled for what it does", /Review reminder if unanswered/i.test(st.label), st.label);
      eq("R9-3 · …carrying the value the backend actually uses", st.fieldVal, "7");
      ok("R9-3 · Settings says clients are asked twice", /asked twice/i.test(st.rem), st.rem.slice(0, 140));
      ok("R9-3 · …naming the delay from the setting itself", st.rem.includes(st.fieldVal + " days"), st.rem.slice(0, 220));
      ok("R9-3 · …and saying how to turn the second ask off", /blank or 0/i.test(st.rem), st.rem.slice(-140));
      ok("R9-3 · the NPS copy says an unhappy score writes a note AND a task",
        /call-back task/i.test(st.nps) && /case timeline as a note/i.test(st.nps), st.nps.slice(0, 300));
      ok("R9-3 · …and names the detractor band the backend actually uses (6 or below)", /6 or below/.test(st.nps), st.nps.slice(0, 220));
      ok("no console errors (reminder copy)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       8 · R9-4 · THE CLIENT RECORD
       =================================================================== */
    {
      console.log("\n— R9-4 · advocacy on the client record");
      const page = await newPage(browser, "p4");
      const top = GT.topReferrers[0];
      const referredClient = GT.referrals[0];
      await page.evaluate((id) => window.openClient(id), top.id);
      await page.waitForTimeout(1000);
      const asReferrer = await page.evaluate(() => {
        const e = document.querySelector("#client-advocacy");
        return e ? { txt: e.textContent.replace(/\s+/g, " ").trim(), links: [...e.querySelectorAll("a[data-client]")].map((a) => a.dataset.client) } : null;
      });
      ok("R9-4 · a client who referred others carries an advocacy line", !!asReferrer, "no #client-advocacy");
      ok(`R9-4 · …reading “Referred ${top.referrals} client${top.referrals === 1 ? "" : "s"}”`,
        asReferrer.txt.includes(`Referred ${top.referrals} client${top.referrals === 1 ? "" : "s"}`), asReferrer.txt);

      await page.evaluate((id) => window.openClient(id), referredClient.clientId);
      await page.waitForTimeout(1000);
      const asReferred = await page.evaluate(() => {
        const e = document.querySelector("#client-advocacy");
        return e ? { txt: e.textContent.replace(/\s+/g, " ").trim(), links: [...e.querySelectorAll("a[data-client]")].map((a) => a.dataset.client) } : null;
      });
      ok("R9-4 · a referred client carries one too", !!asReferred, "no #client-advocacy");
      ok(`R9-4 · …reading “Referred by ${referredClient.referrer}”`,
        asReferred.txt.includes(`Referred by ${referredClient.referrer}`), asReferred.txt);
      eq("R9-4 · …linked to the referrer's own record", asReferred.links, [referredClient.referrerId]);

      // a client with neither gets no line at all — the modal has no room for "Referred 0 clients"
      const neither = await page.evaluate(async () => {
        const db = window.__mockDb;
        const [{ data: cs }, { data: cl }] = await Promise.all([
          db.from("cases").select("client_id,referrer_client_id"), db.from("clients").select("id"),
        ]);
        const sent = new Set(cs.map((c) => c.referrer_client_id).filter(Boolean));
        const got = new Set(cs.filter((c) => c.referrer_client_id).map((c) => c.client_id));
        return (cl.find((c) => !sent.has(c.id) && !got.has(c.id)) || {}).id || null;
      });
      await page.evaluate((id) => window.openClient(id), neither);
      await page.waitForTimeout(900);
      eq("R9-4 · a client with no advocacy at all gets no line", await page.evaluate(() => !!document.querySelector("#client-advocacy")), false);
      ok("no console errors (client record)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       9 · OWNER GATING — advisers and admins see no advocacy money
       =================================================================== */
    {
      console.log("\n— R9-2 · owner gating");
      const moneyStrings = GT.topReferrers.filter((r) => r.value > 0).map((r) => String(Math.round(r.value)));
      for (const persona of ["p1", "p2", "p3"]) {
        const page = await newPage(browser, persona);
        await gotoReports(page);
        const g = await page.evaluate(() => ({
          hidden: document.querySelector("#report-advocacy-panel").classList.contains("hidden"),
          grid: (document.querySelector("#report-advocacy-grid") || {}).innerHTML || "",
          basis: (document.querySelector("#report-advocacy-basis") || {}).textContent || "",
          anyBlock: document.querySelectorAll("#report-advocacy-grid .adv-block").length,
        }));
        eq(`R9-2 · ${persona} · the advocacy panel is hidden`, g.hidden, true);
        eq(`R9-2 · ${persona} · …and nothing is left rendered inside it`, g.anyBlock, 0);
        eq(`R9-2 · ${persona} · …not even the basis line`, g.basis.trim(), "");
        // Belt and braces: no referral money anywhere in this person's Reports page.
        const pageTxt = await page.evaluate(() => (document.querySelector("#page-reports") || {}).innerText || "");
        const leaked = moneyStrings.filter((s) => pageTxt.replace(/[,\s]/g, "").includes(s) && Number(s) > 999);
        eq(`R9-2 · ${persona} · no top-referrer value leaks onto the page`, leaked, []);
        ok(`R9-2 · ${persona} · …while the ordinary Reports content still renders`,
          (await page.evaluate(() => !!document.querySelector("#report-kpis").innerHTML)) === true);
        ok(`no console errors (gating · ${persona})`, !page.__err, JSON.stringify(page.__err));
        await page.close();
      }
      // …and the Owner does see it, with the money column present
      {
        const page = await newPage(browser, "p4");
        await gotoReports(page);
        const heads = await page.evaluate(() => [...document.querySelectorAll("#adv-top-table th")].map((t) => t.textContent.trim()));
        ok("R9-2 · the Owner's top-referrer table carries the Converted value column",
          heads.some((h) => /Converted value/i.test(h)), JSON.stringify(heads));
        await page.close();
      }
    }

    /* ===================================================================
       10 · VIEWPORTS — 390 and 1280 clean on everything this round adds
       =================================================================== */
    {
      console.log("\n— R9 · 390 / 1280 clean");
      const ref = GT.referrals.find((r) => !r.target.why);
      const note = GT.revNotes[0];
      for (const [w, h, tag] of [[390, 844, "390"], [1280, 800, "1280"]]) {
        const page = await newPage(browser, "p4", { width: w, height: h });
        const fits = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));

        await gotoReports(page);
        const m1 = await fits();
        eq(`R9 · no horizontal overflow on Reports (advocacy panel) at ${tag}`, m1.doc <= m1.win, true);
        const inside = await page.evaluate(() => {
          const p = document.querySelector("#report-advocacy-panel").getBoundingClientRect();
          return p.width > 0 && p.right <= window.innerWidth + 1;
        });
        ok(`R9 · the advocacy panel stays inside the viewport at ${tag}`, inside === true);
        const tablesFit = await page.evaluate(() => [...document.querySelectorAll("#report-advocacy-grid table")]
          .every((t) => t.getBoundingClientRect().right <= window.innerWidth + 1));
        ok(`R9 · its tables do not run off the edge at ${tag}`, tablesFit === true);

        await page.evaluate((id) => window.openCase(id), ref.caseId);
        await page.waitForTimeout(900);
        const m2 = await fits();
        eq(`R9 · no horizontal overflow with the referrer picker open at ${tag}`, m2.doc <= m2.win, true);
        const refFits = await page.evaluate(() => {
          const r = document.querySelector("#cs-referrer");
          return !r || r.getBoundingClientRect().right <= window.innerWidth + 1;
        });
        ok(`R9 · the “Referred by” pill wraps rather than clipping at ${tag}`, refFits === true);
        await page.evaluate(() => window.closeModal && window.closeModal());

        await page.evaluate((id) => window.openCase(id), note.caseId);
        await page.waitForTimeout(900);
        const m3 = await fits();
        eq(`R9 · no horizontal overflow with a review-feedback note on screen at ${tag}`, m3.doc <= m3.win, true);
        await page.evaluate(() => window.closeModal && window.closeModal());

        await gotoToday(page);
        await page.evaluate(() => window.setBriefScope("all"));
        await page.waitForTimeout(1300);
        const m4 = await fits();
        eq(`R9 · no horizontal overflow on My Day with the detractor row at ${tag}`, m4.doc <= m4.win, true);
        ok(`no console errors at ${tag}`, !page.__err, JSON.stringify(page.__err));
        await page.close();
      }
    }

  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (_) { } }
  }

  console.log("\n================================================================");
  console.log(`r9_adv: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
