#!/usr/bin/env node
/* =============================================================================
   tests/r64_small.js — acceptance tests for the three small R64 items.

     §A  M5 · FAR-OUT GUARD ON THE BULK RATE-END REMINDER.
         bulkQueueRateRemindersRun filtered on "has an email" and "has a
         rate-end date" and nothing else, so a select-all on this table queued a
         client email about a rate ending in 2031 — the pipeline's Offer and
         Exchange rows carry the NEW mortgage's five-year fix. The 274-day rule
         the single-row control (rateErcFarOut, R7-2) and bulkStartRetentionRun
         have both applied for rounds now applies here too, and deliberately NOT
         as a silent skip: the rows it holds back are NAMED in the confirm under
         their own ⚠ block, the same shape the "already been reminded once"
         warning uses, because re-reminding early is sometimes a legitimate
         thing an operator means to do and they are entitled to see what is
         being withheld and why.
         The SINGLE-CASE paths are asserted as they were found and as they were
         left: queueEmail's #act-reminder WARNS in the same words and still
         sends if you say yes (one case, chosen by name, with a confirm in front
         of it, is a different act from a sweep); markRateReminded is untouched
         because it sends nothing at all — it clears the nag on a case whose
         successor already exists, which its own comment says outright.
     §B  M9 · THE CLIENTS PAGE OPENS ON THE PERSON READING IT.
         `clientAdviser` was module-level "all", never defaulted and never
         persisted — the last of the four adviser filters still opening on the
         whole firm for everybody. Now: ME for advising staff, "all" for the
         Owner and the Administrator, remembered under localStorage
         `nx_clients_adviser`, with a stored id validated against the options
         the select actually carries so a departed colleague's id falls back to
         the role default rather than filtering the page to nothing.
     §C  L5 · THE GONE-QUIET WINDOW IS A SETTING (`client_quiet_months`).
         Six months was a constant. One function reads the setting now
         (clientQuietMonths) and the chip label, the segment definition, the
         Retention "Gone quiet" panel, the cold predicate itself and the seeded
         saved view all read that one function. Blank / absent / rubbish ⇒ 6.
         The copy says outright that the window is a setting.
     §D  no console errors on p1–p4 across the pages these three items touch.

   Every figure asserted here is recomputed in this file from the mock DB rather
   than read back out of app.js's own constants, per the standing rule in
   HARNESS.md. Cases are seeded fresh (mkClientCase) rather than borrowed from
   the fixture wherever the DATE is the thing under test; mock-supabase.js
   rebuilds its DB on every page load, so an id minted on one page means nothing
   on the next.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r64_small.js
         (expects a static server on 8099; starts one itself if absent)
   ========================================================================== */
"use strict";

/* R73 · A3 — THE CASE ACTION BAR IS CAPPED NOW, so a stage action may be one press away.
   The bar was 135px of a 900px desktop viewport and 445px of an 844px phone because every action
   CASE_ACTION_RULES calls primary at a stage sat on it — twelve buttons on a completed case.
   R73 keeps the two or three the stage is actually about on the bar and moves the rest into the
   Actions ▾ menu, under a heading naming the stage; every act-* id is built exactly once, with
   the same label and the same handler, and every one is reachable in at most one extra press.
   Same shape r13 and r5_batch1 have used since R15: find out where the action currently is, open
   the overflow only if that is where it is, then click it exactly as before. */
async function r73OpenAction(page, id) {
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return true;                       // absent: let the click fail as it always would
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, `#${id}`);
  if (!visible) await page.click("#case-more-actions-toggle");
}


const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const SETTLE = 1600;
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

/* R64 · M9 — `nx_clients_adviser` joins this list, and it matters more than most of them: the
   Clients page now REMEMBERS an adviser pick, so a block that expects the whole firm's list has to
   start from a clean key exactly as the board's blocks have always had to. */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser", "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_ret_scope", "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads",
  "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
const lsGet = (page, k) => page.evaluate((key) => { try { return localStorage.getItem(key); } catch (e) { return null; } }, k);
const lsSet = (page, k, v) => page.evaluate(({ key, val }) => { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }, { key: k, val: v });

async function newPage(browser, persona) {
  const page = await browser.newPage();
  await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
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
  await clearNxKeys(page);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const lastDialog = (page, re) => (page.__dialogs.filter((d) => !re || re.test(d.message)).slice(-1)[0] || {}).message || "";
const noNewErr = (page, before) => (page.__err || []).length === before;

async function goto(page, pageName, settle) {
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, settle || 1400);
}
// Pipeline in table view, "All" segment — every seeded case is then selectable (r5_batch5's helper).
async function pipelineTable(page) {
  await page.evaluate(() => window.nav("pipeline"));
  await wait(page, 900);
  const isBoard = await page.evaluate(() => !document.querySelector("#board").classList.contains("hidden"));
  if (isBoard) { await page.click("#view-toggle"); await wait(page, 800); }
  const seg = await page.$('.seg-btn[data-seg="all"]');
  if (seg) { await seg.click(); await wait(page, 800); }
  const stillBoard = await page.evaluate(() => !document.querySelector("#board").classList.contains("hidden"));
  if (stillBoard) { await page.click("#view-toggle"); await wait(page, 800); }
}

const dayStr = (offset) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

/* One client, N completed cases, each with its own rate-end date. Completed because that is the
   state a rate-end sweep is run over, and because #act-reminder is stage-gated to it. */
async function mkRateCases(page, offsets, opts) {
  return page.evaluate(async ({ offsets, opts }) => {
    const db = window.__mockDb;
    const tag = Math.random().toString(36).slice(2, 8);
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: opts.first || "Rita", last_name: opts.last || ("Rateend" + tag), email: opts.email === null ? null : (opts.email || `rita.${tag}@example.com`) })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const ids = [];
    for (const o of offsets) {
      const d = new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
      const { data: cs, error } = await db.from("cases").insert({
        client_id: cl.id, case_kind: "remortgage", stage: "completed", lender: "Halifax",
        assigned_to: "p2", protection_status: "not_needed", rate_end_date: d,
      }).select("id").single();
      if (error) throw new Error("case insert: " + error.message);
      ids.push(cs.id);
    }
    return { clientId: cl.id, ids };
  }, { offsets, opts: opts || {} });
}

// Every rate_end_reminder row currently in the queue, by case.
const reminderRows = (page) => page.evaluate(async () => {
  const { data } = await window.__mockDb.from("email_queue").select("case_id,email_type,status,to_email");
  return (data || []).filter((r) => r.email_type === "rate_end_reminder").map((r) => ({ case_id: r.case_id, status: r.status }));
});
const stampsFor = (page, ids) => page.evaluate(async (ids) => {
  const { data } = await window.__mockDb.from("cases").select("id,rate_reminder_queued_at").in("id", ids);
  return Object.fromEntries((data || []).map((c) => [c.id, !!c.rate_reminder_queued_at]));
}, ids);

// Push a setting into the mock and make the running app re-read it, without a reload (a reload
// would rebuild the mock DB from scratch and take the setting with it).
async function setSettingLive(page, key, value) {
  await page.evaluate(async ({ key, value }) => {
    const { error } = await window.__mockDb.from("settings").upsert([{ key, value }]);
    if (error) throw new Error("settings upsert: " + error.message);
    await window.loadSettings();
  }, { key, value });
  await wait(page, 250);
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore", detached: true });
    server.unref();
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {

    /* =====================================================================
       §A · M5 — the far-out guard on the bulk rate-end reminder
       ===================================================================== */
    console.log("\n— §A1 · four selected cases: 30d / 200d / 400d / already ended (p1)");
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const { ids } = await mkRateCases(page, [30, 200, 400, -30]);
      const [soon, mid, farOut, ended] = ids;

      await pipelineTable(page);
      const onScreen = await page.evaluate((ids) => ids.filter((id) => !!document.querySelector(`#pipe-table .bulk-cb[data-id="${id}"]`)), ids);
      eq("fixture · all four seeded cases are selectable on the pipeline table", onScreen.length, 4);

      const before = await reminderRows(page);
      for (const id of ids) await page.check(`#pipe-table .bulk-cb[data-id="${id}"]`);
      page.__dialogs = [];
      await page.click("#pipe-bulk-rate");
      await wait(page, 2000);

      const msg = lastDialog(page, /rate-end reminder/);
      ok("§A1a · the confirm queues THREE, not four — the 400-day rate is held back",
        /Queue 3 rate-end reminders\?/.test(msg), JSON.stringify(msg));
      ok("§A1b · …under a named ⚠ “Too early … (not queued)” block, not a silent skip",
        /⚠ Too early — rate ends in more than nine months \(not queued\), 1 of them/.test(msg), JSON.stringify(msg));
      ok("§A1c · …which NAMES the client and the months, the way the “already reminded” block names its rows",
        /· .+ — rate ends in 13 months \(/.test(msg), JSON.stringify(msg));
      ok("§A1d · …and does NOT report it as “skipped: no email/no rate-end date” (a different sentence, a different decision)",
        !/1 skipped/.test(msg), JSON.stringify(msg));
      ok("§A1e · …and still lists the three it IS queueing for", /Queueing for:\n· /.test(msg), JSON.stringify(msg));

      const after = await reminderRows(page);
      const mine = after.filter((r) => ids.includes(r.case_id));
      eq("§A2a · exactly three reminder rows were written", mine.length, 3);
      ok("§A2b · …one each for the 30-day, 200-day and already-ended rates",
        [soon, mid, ended].every((id) => mine.some((r) => r.case_id === id)), JSON.stringify(mine));
      ok("§A2c · …and NONE for the 400-day rate", !mine.some((r) => r.case_id === farOut), JSON.stringify(mine));
      ok("§A2d · every row is queued, nothing sent", mine.every((r) => r.status === "queued"), JSON.stringify(mine));
      eq("§A2e · the firm's other reminder rows are untouched", after.length - mine.length, before.length);

      const stamps = await stampsFor(page, ids);
      ok("§A2f · the three queued cases are stamped rate_reminder_queued_at",
        stamps[soon] && stamps[mid] && stamps[ended], JSON.stringify(stamps));
      eq("§A2g · the held-back case is NOT stamped — it stays eligible for the sweep that is due", stamps[farOut], false);

      const tasks = await page.evaluate(async (ids) => {
        const { data } = await window.__mockDb.from("case_tasks").select("case_id,title");
        return (data || []).filter((t) => ids.includes(t.case_id) && /^Follow up rate-end reminder — /.test(t.title)).map((t) => t.case_id);
      }, ids);
      eq("§A2h · three follow-up tasks, none on the held-back case", tasks.sort().join(","), [soon, mid, ended].sort().join(","));

      const toast = await toastText(page);
      ok("§A2i · the toast tallies the held-back row by name of the rule", /1 too early \(rate more than nine months out\)/.test(toast), toast);
      ok("§A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §A3 · a selection that is ENTIRELY too early writes nothing and says why (p1)");
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const { ids } = await mkRateCases(page, [400, 500]);
      await pipelineTable(page);
      const before = await reminderRows(page);
      for (const id of ids) await page.check(`#pipe-table .bulk-cb[data-id="${id}"]`);
      page.__dialogs = [];
      await page.click("#pipe-bulk-rate");
      await wait(page, 1600);

      eq("§A3a · no confirm was ever raised — there is nothing to confirm", page.__dialogs.length, 0);
      const toast = await toastText(page);
      ok("§A3b · the toast says too early, and does NOT blame a missing email address",
        /Nothing to queue/.test(toast) && /too early/.test(toast) && !/no email/.test(toast), toast);
      ok("§A3c · …and names the months out for the cases it is holding", /in 13 months|in 16 months/.test(toast), toast);
      const after = await reminderRows(page);
      eq("§A3d · not one row was written", after.length, before.length);
      const stamps = await stampsFor(page, ids);
      ok("§A3e · …and nothing was stamped", Object.values(stamps).every((v) => v === false), JSON.stringify(stamps));
      ok("§A3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §A4 · the SINGLE-CASE send warns in the same words and still sends (p1)");
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const { ids } = await mkRateCases(page, [400, 200]);
      const [farOut, mid] = ids;

      // Read the wording first, send nothing.
      page.__dialogPlan = ["dismiss"];
      await page.evaluate((id) => window.openCase(id), farOut);
      await wait(page, 1000);
      page.__dialogs = [];
      await r73OpenAction(page, "act-reminder"); await page.click("#act-reminder");
      await wait(page, 800);
      const farMsg = lastDialog(page, /Send rate-end reminder/);
      ok("§A4a · the single-case confirm carries the same ⚠ Too early line, with the months named",
        /⚠ Too early — this rate ends in 13 months \(/.test(farMsg), JSON.stringify(farMsg));
      ok("§A4b · …says the reminder window will reach the case on its own", /reminder window will reach this case on its own/.test(farMsg), JSON.stringify(farMsg));
      ok("§A4c · …and says the decision is still the sender's (it warns, it does not refuse)",
        /Send anyway only if you have a reason to write now/.test(farMsg), JSON.stringify(farMsg));
      const afterDismiss = await reminderRows(page);
      ok("§A4d · dismissing the confirm queues nothing", !afterDismiss.some((r) => r.case_id === farOut), JSON.stringify(afterDismiss));

      // A rate inside the window gets no warning at all — the line is news, not boilerplate.
      await page.evaluate(() => window.closeModal());
      await wait(page, 400);
      page.__dialogPlan = ["dismiss"];
      await page.evaluate((id) => window.openCase(id), mid);
      await wait(page, 1000);
      page.__dialogs = [];
      await r73OpenAction(page, "act-reminder"); await page.click("#act-reminder");
      await wait(page, 800);
      const midMsg = lastDialog(page, /Send rate-end reminder/);
      ok("§A4e · a 200-day rate gets NO too-early line", !/Too early/.test(midMsg) && /Signed off by: /.test(midMsg), JSON.stringify(midMsg));

      // …and saying yes on the far-out one still sends. This is the deliberate half of the design.
      await page.evaluate(() => window.closeModal());
      await wait(page, 400);
      page.__dialogAnswer = "accept";
      page.__dialogPlan = [];
      await page.evaluate((id) => window.openCase(id), farOut);
      await wait(page, 1000);
      await r73OpenAction(page, "act-reminder"); await page.click("#act-reminder");
      await wait(page, 1200);
      const afterAccept = await reminderRows(page);
      ok("§A4f · accepting the warning DOES queue it — one deliberate case is not a sweep",
        afterAccept.some((r) => r.case_id === farOut), JSON.stringify(afterAccept));
      ok("§A4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §A5 · markRateReminded is left exactly as it was found: it is not a send (p1)");
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const { ids } = await mkRateCases(page, [600]);
      const before = await reminderRows(page);
      await page.evaluate((id) => window.markRateReminded(id), ids[0]);
      await wait(page, 900);
      const after = await reminderRows(page);
      eq("§A5a · marking a 600-day-out case as reminded queues NO email at all", after.length, before.length);
      const stamps = await stampsFor(page, ids);
      eq("§A5b · …it only stamps the case, which is the whole point of that control", stamps[ids[0]], true);
      ok("§A5c · …and says so", /no email was sent/i.test(await toastText(page)), await toastText(page));
      ok("§A5 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §B · M9 — the Clients page opens on the person reading it
       ===================================================================== */
    // Ground truth for "scoped to p2": recomputed here from the mock DB, not read off the page.
    const clientsOfAdviser = (page, who) => page.evaluate(async (who) => {
      const { data } = await window.__mockDb.from("clients").select("id, cases!client_id(assigned_to)");
      return (data || []).filter((c) => (c.cases || []).some((x) => x.assigned_to === who)).map((c) => c.id).sort();
    }, who);

    console.log("\n— §B1 · an adviser opens on their own clients (p2)");
    {
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await goto(page, "clients", 1800);
      eq("§B1a · #client-adviser opens on the signed-in adviser", await page.$eval("#client-adviser", (e) => e.value), "p2");
      eq("§B1b · …and nothing was written to storage by the DEFAULT itself", await lsGet(page, "nx_clients_adviser"), null);

      const shown = await page.$$eval("#client-list .client-row", (rows) => rows.map((r) => r.dataset.client).sort());
      const expected = await clientsOfAdviser(page, "p2");
      ok("§B1c · the rows really are p2's book, recomputed from the database",
        shown.length > 0 && JSON.stringify(shown) === JSON.stringify(expected.slice(0, shown.length).sort()) && shown.every((id) => expected.includes(id)),
        JSON.stringify({ shown: shown.length, expected: expected.length }));
      eq("§B1d · …every client on screen has at least one case of p2's", shown.filter((id) => !expected.includes(id)).length, 0);

      const allChip = await page.evaluate(() => {
        const b = document.querySelector('#client-segment .seg-btn[data-seg="all"]');
        return b ? Number(b.querySelector(".seg-count").textContent) : null;
      });
      eq("§B1e · the “All” chip counts the FILTERED book, not the firm's", allChip, expected.length);

      const note = await page.$eval("#client-adv-note", (e) => ({ hidden: e.classList.contains("hidden"), text: e.textContent }));
      ok("§B1f · the note under the control says the page opened on your own clients and how to leave",
        !note.hidden && /opens on your own clients/.test(note.text) && /All advisers/.test(note.text), JSON.stringify(note));
      ok("§B1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §B2 · the Administrator and the Owner run the firm, so they open on All (p1, p4)");
    for (const persona of ["p1", "p4"]) {
      const page = await newPage(browser, persona);
      const errBefore = (page.__err || []).length;
      await goto(page, "clients", 1800);
      eq(`§B2 · ${persona} opens on "all"`, await page.$eval("#client-adviser", (e) => e.value), "all");
      const noteHidden = await page.$eval("#client-adv-note", (e) => e.classList.contains("hidden"));
      eq(`§B2 · ${persona} · …and the scope note stays hidden (nothing is narrowed)`, noteHidden, true);
      const shown = await page.$$eval("#client-list .client-row", (rows) => rows.length);
      ok(`§B2 · ${persona} · …and more clients are on screen than any one adviser holds`, shown > (await clientsOfAdviser(page, "p2")).length, String(shown));
      ok(`§B2 · ${persona} · no console errors`, noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §B3 · a pick persists across a reload, and clearing the key restores the default (p2)");
    {
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await goto(page, "clients", 1800);
      await page.selectOption("#client-adviser", "all");
      await wait(page, 900);
      eq("§B3a · picking All advisers persists nx_clients_adviser", await lsGet(page, "nx_clients_adviser"), "all");

      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "clients", 1800);
      eq("§B3b · …and the page opens on it next time, not back on the adviser's own book",
        await page.$eval("#client-adviser", (e) => e.value), "all");

      await page.selectOption("#client-adviser", "p3");
      await wait(page, 900);
      eq("§B3c · picking a COLLEAGUE persists too", await lsGet(page, "nx_clients_adviser"), "p3");
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "clients", 1800);
      eq("§B3d · …and is what the page opens on", await page.$eval("#client-adviser", (e) => e.value), "p3");

      await clearNxKeys(page);
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "clients", 1800);
      eq("§B3e · clearing the key genuinely restores the role default (p2's own book)",
        await page.$eval("#client-adviser", (e) => e.value), "p2");
      ok("§B3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §B4 · a stored id the select cannot honour falls back to the role default (p2, p1)");
    {
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await lsSet(page, "nx_clients_adviser", "pZZ-not-a-person");
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "clients", 1800);
      eq("§B4a · a bogus stored id does not stick — p2 falls back to their own book",
        await page.$eval("#client-adviser", (e) => e.value), "p2");
      const optHasGhost = await page.$$eval("#client-adviser option", (os) => os.some((o) => o.value === "pZZ-not-a-person"));
      eq("§B4b · …and no ghost option was invented to carry it", optHasGhost, false);
      const shown = await page.$$eval("#client-list .client-row", (rows) => rows.length);
      ok("§B4c · …so the list is not empty (the failure mode this guard exists for)", shown > 0, String(shown));
      ok("§B4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      await lsSet(page, "nx_clients_adviser", "pZZ-not-a-person");
      await page.reload();
      await wait(page, SETTLE);
      await goto(page, "clients", 1800);
      eq("§B4d · the same bogus id on an Administrator falls back to All",
        await page.$eval("#client-adviser", (e) => e.value), "all");
      ok("§B4d · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §B5 · the bulk bar acts on the filtered list, not the firm's (p2)");
    {
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await goto(page, "clients", 1800);
      const expected = await clientsOfAdviser(page, "p2");
      await page.evaluate(() => {
        document.querySelectorAll("#client-list .client-cb").forEach((cb) => { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); });
      });
      await wait(page, 800);
      const n = await page.$eval("#client-bulk-n", (e) => Number(e.textContent)).catch(() => null);
      eq("§B5 · select-all on the Clients page selects the adviser's book only", n, expected.length);
      ok("§B5 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §C · L5 — the gone-quiet window as a setting
       ===================================================================== */
    console.log("\n— §C1 · the seeded default is six months and every surface says six (p1)");
    {
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const seeded = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("key,value").eq("key", "client_quiet_months").single();
        return data ? data.value : null;
      });
      eq("§C1a · the fixture seeds client_quiet_months", seeded, "6");

      await goto(page, "clients", 1800);
      const chip = await page.evaluate(() => {
        const b = document.querySelector('#client-segment .seg-btn[data-seg="cold"]');
        return b ? b.textContent : null;
      });
      ok("§C1b · the Clients chip reads “Not contacted 6+ months”", /Not contacted 6\+ months/.test(chip || ""), JSON.stringify(chip));

      await page.evaluate(() => document.querySelector('#client-segment .seg-btn[data-seg="cold"]').click());
      await wait(page, 1200);
      const def = await page.$eval("#client-seg-def", (e) => e.textContent);
      ok("§C1c · the segment definition prints the 6-month window", /6-month window/.test(def), def);
      ok("§C1d · …and says outright that the window is a SETTING, and where", /is a setting/.test(def) && /Gone-quiet window/.test(def), def);
      ok("§C1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §C2 · setting it to 3 moves the line to ~90 days, everywhere at once (p4 — settings writes are Owner-gated by RLS)");
    {
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      /* A client last contacted 120 days ago: cold on a three-month window, warm on a six-month
         one. Recomputed here rather than trusting the app's own arithmetic. */
      const probe = await page.evaluate(async () => {
        const db = window.__mockDb;
        const tag = Math.random().toString(36).slice(2, 8);
        const { data: cl } = await db.from("clients").insert({ first_name: "Quinn", last_name: "Quiet" + tag, email: `quinn.${tag}@example.com` }).select("id").single();
        const { data: cs } = await db.from("cases").insert({ client_id: cl.id, case_kind: "remortgage", stage: "completed", assigned_to: "p2", protection_status: "not_needed" }).select("id").single();
        // Wipe the auto-logged creation note/event trail, then plant ONE note 120 days old.
        await db.from("case_notes").delete().eq("case_id", cs.id);
        await db.from("case_notes").insert({ case_id: cs.id, body: "Call: reviewed the fix", created_at: new Date(Date.now() - 120 * 86400000).toISOString() });
        return { clientId: cl.id, caseId: cs.id };
      });

      const coldIds = async () => {
        await page.evaluate(() => window.loadClients("", { force: true }));
        await wait(page, 1200);
        return page.evaluate(() => [...document.querySelectorAll("#client-list .client-row")].map((r) => r.dataset.client));
      };

      await goto(page, "clients", 1800);
      await page.evaluate(() => document.querySelector('#client-segment .seg-btn[data-seg="cold"]').click());
      await wait(page, 1200);
      const at6 = await coldIds();
      eq("§C2a · at six months the 120-day-quiet client is NOT cold", at6.includes(probe.clientId), false);

      await setSettingLive(page, "client_quiet_months", "3");
      const at3 = await coldIds();
      eq("§C2b · at three months the same client IS cold — the predicate moved with the setting", at3.includes(probe.clientId), true);

      const chip = await page.evaluate(() => document.querySelector('#client-segment .seg-btn[data-seg="cold"]').textContent);
      ok("§C2c · the chip label moved with it", /Not contacted 3\+ months/.test(chip), chip);

      const def = await page.$eval("#client-seg-def", (e) => e.textContent);
      ok("§C2d · the definition prints 3, not 6", /3-month window/.test(def) && !/6-month window/.test(def), def);
      // The printed cutoff date must be ~90 days back, computed here from scratch.
      const printed = (def.match(/last contact is before ([0-9]{1,2} [A-Za-z]{3,9} [0-9]{4})/) || [])[1] || "";
      const printedMs = Date.parse(printed + " 12:00:00");
      const daysBack = Math.round((Date.now() - printedMs) / DAY_MS);
      ok("§C2e · …and the cutoff date it prints really is ~90 days ago", daysBack >= 88 && daysBack <= 93, JSON.stringify({ printed, daysBack }));

      // The Retention page's Gone-quiet panel reads the same one function.
      await goto(page, "retention", 2200);
      const sub = await page.$eval("#ret-cold-sub", (e) => e.textContent);
      ok("§C2f · the Retention “Gone quiet” panel prints 3 too", /3-month window/.test(sub) && /is a setting/.test(sub), sub);
      const inPanel = await page.evaluate((id) => [...document.querySelectorAll("#ret-cold-list .row-item .t")].some((t) => (t.getAttribute("onclick") || "").includes(id)), probe.clientId);
      eq("§C2g · …and the same client is on it", inPanel, true);
      ok("§C2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §C3 · blank / rubbish / zero all mean six months (p4)");
    {
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "clients", 1800);
      for (const [val, label] of [["", "blank"], ["not a number", "rubbish"], ["0", "zero"]]) {
        await setSettingLive(page, "client_quiet_months", val);
        await page.evaluate(() => window.loadClients("", { force: true }));
        await wait(page, 1000);
        const chip = await page.evaluate(() => document.querySelector('#client-segment .seg-btn[data-seg="cold"]').textContent);
        ok(`§C3 · ${label} ⇒ the six-month default`, /Not contacted 6\+ months/.test(chip), chip);
      }
      // …and a real number is honoured after all that.
      await setSettingLive(page, "client_quiet_months", "12");
      await page.evaluate(() => window.loadClients("", { force: true }));
      await wait(page, 1000);
      const chip12 = await page.evaluate(() => document.querySelector('#client-segment .seg-btn[data-seg="cold"]').textContent);
      ok("§C3 · a valid 12 is honoured", /Not contacted 12\+ months/.test(chip12), chip12);
      ok("§C3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §C4 · the Settings form carries the field, labelled and explained (p4)");
    {
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "settings", 2200);
      const field = await page.evaluate(() => {
        const el = document.querySelector('[name="client_quiet_months"]');
        if (!el) return null;
        const label = el.closest("label");
        return { type: el.type, value: el.value, label: label ? label.textContent.trim() : "" };
      });
      ok("§C4a · the field is on the Settings form", !!field, JSON.stringify(field));
      eq("§C4b · …as a number input (so a bad value is blocked on save, like every other numeric setting)", field && field.type, "number");
      ok("§C4c · …labelled as the gone-quiet window, with blank = 6 stated", /Gone-quiet window/.test(field.label) && /blank = 6/.test(field.label), field.label);
      eq("§C4d · …showing the seeded value", field.value, "6");
      const note = await page.$eval("#setting-note-client_quiet_months", (e) => e.textContent).catch(() => "");
      ok("§C4e · …with a note naming every surface it drives", /Not contacted/.test(note) && /Gone quiet/.test(note) && /Blank means 6 months/.test(note), note);
      // It sits with the other numeric touch settings rather than off on its own.
      const order = await page.evaluate(() => [...document.querySelectorAll('#settings-form [name]')].map((e) => e.name));
      const iRate = order.indexOf("rate_reminder_months"), iQuiet = order.indexOf("client_quiet_months");
      ok("§C4f · …next to the rate-reminder lead time, not orphaned", iRate >= 0 && iQuiet === iRate + 1, JSON.stringify({ iRate, iQuiet }));
      ok("§C4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    console.log("\n— §C5 · the seeded saved view's NAME follows the setting (p2)");
    {
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await goto(page, "clients", 2000);
      const names = await page.$$eval("#client-views option", (os) => os.map((o) => o.value));
      ok("§C5 · at six months the starter view is still “My cold clients (6mo+)”",
        names.includes("My cold clients (6mo+)"), JSON.stringify(names));
      ok("§C5 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =====================================================================
       §D · no console errors on any persona, across the pages this round touches
       ===================================================================== */
    console.log("\n— §D · clean console for p1–p4 over pipeline / clients / retention / settings");
    for (const persona of ["p1", "p2", "p3", "p4"]) {
      const page = await newPage(browser, persona);
      for (const p of ["dashboard", "pipeline", "clients", "retention", "settings"]) {
        await goto(page, p, 1400);
      }
      ok(`§D · ${persona} — no console errors across the round's five pages`, !(page.__err || []).length, JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (e) { /* ignore */ } }
  }

  console.log(`\nR64 SMALL: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
  process.exit(0);
})();
