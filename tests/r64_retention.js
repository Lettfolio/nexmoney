#!/usr/bin/env node
/* =============================================================================
   tests/r64_retention.js — acceptance tests for R64 "the Retention page becomes
   workable" (build A).

   The finding this round answers, from the R63 broker panel: the page named
   after a retention broker's job had no bulk verbs, no month filter and rows
   that could not be worked without opening the case modal — roughly ten clicks
   per rate-end, forty rate-ends a month.

     §A  BULK BAR — a checkbox per row in #ret-rates-list, "select all shown" +
         clear, and a .bulk-bar #ret-bulk-bar carrying the SAME three verbs the
         Pipeline table has had since R5/R7-2 (bulkQueueRateRemindersRun /
         bulkStartRetentionRun / bulkAddTaskRun). Hidden with nothing selected,
         exactly like the pipeline's. The verbs are proved by the rows they
         write in window.__mockDb — for exactly the selected ids, with the
         far-out and already-has-a-successor skips still applying.
     §B  MONTH CHIPS — #ret-month-chips (Ended · This month · Next month ·
         3 months · 6 months (all)) filtering by rate_end_date over Europe/London
         calendar months; the pick persisted in localStorage nx_ret_month and
         restored after a reload; the h3 counts and the ended/soon grouping
         computed on the FILTERED set; #ret-rates-sub naming the window.
     §C  WORKABLE ROW — a tel: link where the client has a number, "📞 Log call"
         opening the SAME panel the case modal uses (and writing the same note +
         follow-up task rows the modal writes), "📅 Book review" opening the
         diary's own editor prefilled with client, case, adviser and the title
         "Rate-end review".
     §D  R38 PARITY — Today's Rate & ERC drawer is UNCHANGED: no checkboxes, no
         chips, and its row markup is byte-identical to the page's row with the
         R64 action cluster removed.
     §E  No console errors on the Retention page for p2, p3, p4, p1.

   Run:  node /root/nx/tests/r64_retention.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — see HARNESS.md.)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

async function ensureServer() {
  const up = await new Promise((res) => {
    const req = http.get(`http://localhost:${PORT}/admin/mock.html`, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
  });
  if (up) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1200));
  return srv;
}

/* Every localStorage key this page can read. nx_ret_month is R64's addition — cleared here for
   the same reason nx_ret_scope is: a suite that depends on a default must not inherit a choice a
   previous scenario made. */
const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_wt_scope", "nx_board_adviser", "nx_diary_staff",
  "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc", "nx_drawer_retention"];

async function boot(browser, persona) {
  const page = await (await browser.newContext()).newPage();
  page.on("dialog", (d) => { (page.__dialogs = page.__dialogs || []).push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.waitForTimeout(1500);
  return page;
}
/* The tunnel/CDN noise every suite in this harness filters — the mock page loads no network
   assets of its own, but favicons and the sheetjs CDN tag are still in the markup. */
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));

const goRetention = async (page, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate(() => window.nav("retention"));
  await page.waitForTimeout(ms == null ? 2000 : ms);
};

let uniq = 0;
const tag = () => `R64X${Date.now().toString(36)}${++uniq}`;
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const { data: cl, error: ce } = await db.from("clients").insert({
      first_name: o.first, last_name: o.last, email: o.email, phone: o.phone,
    }).select("id").single();
    if (ce) throw new Error("client insert: " + ce.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "completed", assigned_to: "p2" }, o.case || {});
    const { data: cs, error: se } = await db.from("cases").insert(row).select("id").single();
    if (se) throw new Error("case insert: " + se.message);
    return { clientId: cl.id, caseId: cs.id };
  }, opts);
}
const rowsOf = (page, table, col, vals) => page.evaluate(async ({ t, c, v }) => {
  const { data } = await window.__mockDb.from(t).select("*");
  return (data || []).filter((r) => v.includes(r[c]));
}, { t: table, c: col, v: vals });

/* Calendar-month helpers, mid-month so a one-hour timezone offset can never move the month. */
function monthYmd(offset, day) {
  const t = new Date();
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + offset, day == null ? 15 : day));
  return d.toISOString().slice(0, 10);
}
const daysFrom = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const pageRowIds = (page) => page.evaluate(() =>
  [...document.querySelectorAll("#ret-rates-list .row-item .t[onclick]")]
    .map((el) => (el.getAttribute("onclick").match(/openCase\('([^']+)'\)/) || [])[1]).filter(Boolean));

async function selectRows(page, ids) {
  await page.evaluate((list) => {
    list.forEach((id) => {
      const cb = document.querySelector(`#ret-rates-list .ret-cb[data-id="${id}"]`);
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
    });
  }, ids);
  await page.waitForTimeout(250);
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* ======================================================================
     §A · THE BULK BAR
     ====================================================================== */
  console.log("— §A · bulk bar on the Retention rates panel");
  {
    const page = await boot(browser, "p1");        // admin: All scope, sees firm money
    /* Four seeds, each a completed case with a client email, so they are eligible for the
       reminder sweep; the last two exist to prove the two skips still bite. */
    const t = tag();
    const ended1 = await mkClientCase(page, { first: "R64A", last: "Endedone" + t, email: `a1.${t}@example.com`, phone: "07700900111", case: { lender: "Halifax", rate_percent: 1.99, rate_end_date: daysFrom(-40), completed_at: daysFrom(-800), loan_amount: 210000, property_address: "1 R64 Way, Testtown TE6 4AA" } });
    const ended2 = await mkClientCase(page, { first: "R64A", last: "Endedtwo" + t, email: `a2.${t}@example.com`, phone: "07700900222", case: { lender: "Nationwide", rate_percent: 2.19, rate_end_date: daysFrom(-25), completed_at: daysFrom(-750), loan_amount: 180000, property_address: "2 R64 Way, Testtown TE6 4AB" } });
    /* Far out: 300 days to the rate end is past the nine-month "too early" rule. It is on the page
       at all because its ERC outlasts the rate — the ERC half of the feed carries no day cap. */
    const farOut = await mkClientCase(page, { first: "R64A", last: "Farout" + t, email: `a3.${t}@example.com`, phone: "07700900333", case: { lender: "Barclays", rate_percent: 4.1, rate_end_date: daysFrom(300), erc_end_date: daysFrom(400), completed_at: daysFrom(-100), loan_amount: 300000, property_address: "3 R64 Way, Testtown TE6 4AC" } });
    /* Already has a retention successor. */
    const hasSucc = await mkClientCase(page, { first: "R64A", last: "Hassucc" + t, email: `a4.${t}@example.com`, phone: "07700900444", case: { lender: "Skipton", rate_percent: 2.5, rate_end_date: daysFrom(-15), completed_at: daysFrom(-900), loan_amount: 150000, property_address: "4 R64 Way, Testtown TE6 4AD" } });
    await page.evaluate(async (o) => {
      await window.__mockDb.from("cases").insert({
        client_id: o.clientId, case_kind: "remortgage", stage: "enquiry", assigned_to: "p2",
        retention_source_case_id: o.caseId, property_address: "4 R64 Way, Testtown TE6 4AD",
      });
    }, hasSucc);

    await goRetention(page, 2400);
    const ids = await pageRowIds(page);
    ok("§A0 · fixture — all four seeded cases reach the Retention rates panel",
      [ended1, ended2, farOut, hasSucc].every((x) => ids.includes(x.caseId)),
      JSON.stringify({ seeded: [ended1.caseId, ended2.caseId, farOut.caseId, hasSucc.caseId], shown: ids.length }));

    const bar0 = await page.evaluate(() => {
      const b = document.getElementById("ret-bulk-bar");
      return { exists: !!b, hidden: b ? b.hidden : null, cbs: document.querySelectorAll("#ret-rates-list .ret-cb").length, selall: !!document.getElementById("ret-bulk-all") };
    });
    ok("§A1a · every rate row carries a .ret-cb checkbox", bar0.cbs === (await pageRowIds(page)).length && bar0.cbs > 0, JSON.stringify(bar0));
    ok("§A1b · a 'select all shown' checkbox sits above the list", bar0.selall);
    ok("§A1c · #ret-bulk-bar exists and is HIDDEN with nothing selected", bar0.exists && bar0.hidden === true, JSON.stringify(bar0));

    await selectRows(page, [ended1.caseId]);
    const bar1 = await page.evaluate(() => ({
      hidden: document.getElementById("ret-bulk-bar").hidden,
      n: document.getElementById("ret-bulk-n").textContent,
      verbs: ["ret-bulk-rate", "ret-bulk-retention", "ret-bulk-task", "ret-bulk-clear"].filter((i) => !!document.getElementById(i)),
    }));
    ok("§A1d · one tick reveals the bar", bar1.hidden === false, JSON.stringify(bar1));
    eq("§A1e · …and it counts the selection", bar1.n, "1");
    eq("§A1f · the bar carries all three verbs plus Clear", bar1.verbs.length, 4);

    await page.click("#ret-bulk-clear");
    await page.waitForTimeout(1600);
    const bar2 = await page.evaluate(() => ({ hidden: document.getElementById("ret-bulk-bar").hidden, checked: document.querySelectorAll("#ret-rates-list .ret-cb:checked").length }));
    ok("§A1g · Clear empties the selection and hides the bar again", bar2.hidden === true && bar2.checked === 0, JSON.stringify(bar2));

    await page.click("#ret-bulk-all");
    await page.waitForTimeout(1800);
    const bar3 = await page.evaluate(() => ({
      n: Number(document.getElementById("ret-bulk-n").textContent),
      rows: document.querySelectorAll("#ret-rates-list .ret-cb").length,
      checked: document.querySelectorAll("#ret-rates-list .ret-cb:checked").length,
    }));
    ok("§A1h · 'select all shown' selects exactly the rows on screen", bar3.n === bar3.rows && bar3.checked === bar3.rows && bar3.rows > 0, JSON.stringify(bar3));
    await page.click("#ret-bulk-clear");
    await page.waitForTimeout(1600);

    /* --- ⏰ Queue rate-end reminders, on exactly two of the four --- */
    await selectRows(page, [ended1.caseId, ended2.caseId]);
    await page.click("#ret-bulk-rate");
    await page.waitForTimeout(3000);
    const queued = await rowsOf(page, "email_queue", "case_id", [ended1.caseId, ended2.caseId, farOut.caseId, hasSucc.caseId]);
    const reminders = queued.filter((q) => q.email_type === "rate_end_reminder");
    ok("§A2a · a rate_end_reminder is queued for exactly the two selected cases",
      reminders.length === 2 && reminders.every((q) => [ended1.caseId, ended2.caseId].includes(q.case_id)),
      JSON.stringify(reminders.map((q) => ({ c: q.case_id, t: q.email_type }))));
    const fuTasks = (await rowsOf(page, "case_tasks", "case_id", [ended1.caseId, ended2.caseId])).filter((t2) => /^Follow up rate-end reminder/.test(t2.title || ""));
    eq("§A2b · …each one leaves the R5-13 follow-up task behind", fuTasks.length, 2);
    const stamped = await rowsOf(page, "cases", "id", [ended1.caseId, ended2.caseId]);
    ok("§A2c · …and both source cases are stamped as reminded", stamped.every((c) => !!c.rate_reminder_queued_at), JSON.stringify(stamped.map((c) => c.rate_reminder_queued_at)));
    const untouched = await rowsOf(page, "email_queue", "case_id", [farOut.caseId, hasSucc.caseId]);
    eq("§A2d · nothing was queued for the two cases that were NOT selected", untouched.length, 0);
    const selAfter = await page.evaluate(() => ({ hidden: document.getElementById("ret-bulk-bar").hidden, checked: document.querySelectorAll("#ret-rates-list .ret-cb:checked").length }));
    ok("§A2e · the selection is cleared and the page repainted after the verb", selAfter.hidden === true && selAfter.checked === 0, JSON.stringify(selAfter));

    /* --- 🔁 Start retention cases, with both skips in the selection --- */
    const t2 = tag();
    const fresh = await mkClientCase(page, { first: "R64A", last: "Fresh" + t2, email: `a5.${t2}@example.com`, phone: "07700900555", case: { lender: "Coventry", rate_percent: 2.05, rate_end_date: daysFrom(-8), completed_at: daysFrom(-700), loan_amount: 250000, property_address: "5 R64 Way, Testtown TE6 4AE" } });
    await goRetention(page, 2400);
    await selectRows(page, [fresh.caseId, farOut.caseId, hasSucc.caseId]);
    await page.click("#ret-bulk-retention");
    /* R70 · A3 PATCH — the batch's ONE confirm is now the shared overlay (#bulkret-ok), not a
       native confirm(), and the per-case dialogs are gone with it: 50 rows used to open 51
       dialogs. The verbs, the skips and the writes below are unchanged, so everything §A3a-c
       asserts still holds — only the act of agreeing moved. See §A3d. */
    await page.waitForTimeout(1500);
    await page.click("#bulkret-ok");
    await page.waitForTimeout(4000);
    const succ = await page.evaluate(async (o) => {
      const { data } = await window.__mockDb.from("cases").select("*");
      const by = (src) => (data || []).filter((c) => c.retention_source_case_id === src);
      return { fresh: by(o.fresh).length, farOut: by(o.farOut).length, hasSucc: by(o.hasSucc).length };
    }, { fresh: fresh.caseId, farOut: farOut.caseId, hasSucc: hasSucc.caseId });
    eq("§A3a · a retention successor is created for the eligible selected case", succ.fresh, 1);
    eq("§A3b · the far-out case (rate 300 days away) is still skipped as too early", succ.farOut, 0);
    eq("§A3c · the case that already had a successor does not get a second one", succ.hasSucc, 1);
    /* R70 · A3 PATCH — was "the operator was asked to confirm, exactly as the single-case button
       does" (one native confirm per case). The batch asks ONCE, on the overlay, and asks no native
       dialog at all; the single-case button is untouched and still asks per case. */
    ok("§A3d · the operator was asked once, on the batch overlay, and never in a native dialog",
      !(page.__dialogs || []).some((d) => d.type === "confirm" && /retention case/i.test(d.message)),
      JSON.stringify((page.__dialogs || []).slice(-3)));

    /* --- ＋ Add task… --- */
    await goRetention(page, 2400);
    await selectRows(page, [ended1.caseId, ended2.caseId]);
    await page.click("#ret-bulk-task");
    await page.waitForTimeout(1200);
    const overlayUp = await page.evaluate(() => !!document.getElementById("btask-title"));
    ok("§A4a · '＋ Add task…' opens the SAME bulk-task overlay the pipeline bar opens", overlayUp);
    const TASK_TITLE = "R64 chase the rate-end review " + t;
    await page.fill("#btask-title", TASK_TITLE);
    await page.click("#btask-ok");
    await page.waitForTimeout(3000);
    const added = (await rowsOf(page, "case_tasks", "case_id", [ended1.caseId, ended2.caseId, farOut.caseId])).filter((x) => x.title === TASK_TITLE);
    eq("§A4b · one task per selected case, and only for the selected cases", added.length, 2);
    ok("§A4c · each task lands on that case's own adviser", added.every((x) => x.assigned_to === "p2"), JSON.stringify(added.map((x) => x.assigned_to)));

    ok("§A · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §B · THE MONTH CHIPS
     ====================================================================== */
  console.log("\n— §B · month chips");
  {
    /* p4 (owner) so the money lines render — §B3d re-proves R61's "basis said once" sentence is
       still in the subtitle after R64 appended the window copy to it. */
    const page = await boot(browser, "p4");
    const t = tag();
    const mk = (label, caseFields) => mkClientCase(page, {
      first: "R64B", last: label + t, email: `b.${label}.${t}@example.com`.toLowerCase(), phone: "07700900900",
      case: Object.assign({ lender: "Halifax", rate_percent: 2.4, completed_at: daysFrom(-600), loan_amount: 200000 }, caseFields),
    });
    const thisM = await mk("Thismonth", { rate_end_date: monthYmd(0), property_address: "10 R64 Month Rd, Testtown TE6 5AA" });
    const nextM = await mk("Nextmonth", { rate_end_date: monthYmd(1), property_address: "11 R64 Month Rd, Testtown TE6 5AB" });
    const plus2 = await mk("Plustwo", { rate_end_date: monthYmd(2), property_address: "12 R64 Month Rd, Testtown TE6 5AC" });
    const plus5 = await mk("Plusfive", { rate_end_date: monthYmd(5), property_address: "13 R64 Month Rd, Testtown TE6 5AD" });
    const oldEnd = await mk("Longended", { rate_end_date: monthYmd(-14), property_address: "14 R64 Month Rd, Testtown TE6 5AE" });

    await goRetention(page, 2400);
    const chips = await page.evaluate(() => [...document.querySelectorAll("#ret-month-chips .ret-month-chip")].map((b) => ({ k: b.dataset.month, label: b.textContent.replace(/\s+/g, " ").trim(), on: b.classList.contains("scope-active") })));
    /* R70 · A1 PATCH — was five chips ("ended,this,next,3mo,all"). Two lapsed WINDOWS were added
       between "Ended" and "This month" ("Ended · last 3 months" / "Ended · last 12 months"),
       because "Ended" on the real book is 593 rows back to 2017 and the 137 that lapsed in the
       last year are the only ones with a live conversation in them. Order and the rest of the
       row are unchanged. */
    eq("§B1a · seven chips, in the order the brief names them", chips.map((c) => c.k).join(","), "ended,ended3,ended12,this,next,3mo,all");
    ok("§B1b · the last chip ('6 months (all)') is the default — the page's original behaviour",
      chips[6] && chips[6].on && !chips.slice(0, 6).some((c) => c.on), JSON.stringify(chips));

    const pick = async (k) => { await page.click(`#ret-month-chips .ret-month-chip[data-month="${k}"]`); await page.waitForTimeout(2200); return pageRowIds(page); };
    const all = await pageRowIds(page);
    ok("§B2a · under '6 months (all)' every seeded case is shown",
      [thisM, nextM, plus2, plus5, oldEnd].every((x) => all.includes(x.caseId)), JSON.stringify(all.length));

    const endedSet = await pick("ended");
    ok("§B2b · 'Ended' shows the long-ended rate…", endedSet.includes(oldEnd.caseId));
    ok("§B2c · …and none of the rates still running", ![nextM, plus2, plus5].some((x) => endedSet.includes(x.caseId)), JSON.stringify(endedSet.length));

    const thisSet = await pick("this");
    ok("§B2d · 'This month' shows the rate ending this calendar month", thisSet.includes(thisM.caseId));
    ok("§B2e · …and not next month's, nor the +2 or +5 ones",
      ![nextM, plus2, plus5].some((x) => thisSet.includes(x.caseId)), JSON.stringify(thisSet.length));
    ok("§B2f · …nor the one that ended fourteen months ago", !thisSet.includes(oldEnd.caseId));

    const nextSet = await pick("next");
    ok("§B2g · 'Next month' shows next month's rate only",
      nextSet.includes(nextM.caseId) && ![thisM, plus2, plus5, oldEnd].some((x) => nextSet.includes(x.caseId)), JSON.stringify(nextSet.length));

    const threeSet = await pick("3mo");
    ok("§B2h · '3 months' = this month + the next two",
      [thisM, nextM, plus2].every((x) => threeSet.includes(x.caseId)) && ![plus5, oldEnd].some((x) => threeSet.includes(x.caseId)),
      JSON.stringify(threeSet.length));

    /* Sub-copy names the window that is in force. */
    const subs = {};
    for (const k of ["ended", "next", "3mo", "all"]) { await pick(k); subs[k] = await page.evaluate(() => document.getElementById("ret-rates-sub").textContent); }
    ok("§B3a · the sub says 'Ended' means already matured", /ALREADY ended/.test(subs.ended), subs.ended.slice(-140));
    ok("§B3b · the sub names the actual month for 'Next month'", /Showing only rates ending in [A-Z][a-z]+ \d{4}\./.test(subs.next), subs.next.slice(-140));
    ok("§B3c · the sub names all three months for '3 months'", /Showing rates ending in .+, .+ and .+\./.test(subs["3mo"]), subs["3mo"].slice(-160));
    ok("§B3d · the R61 'basis said once' sentence survives the addition", /value at risk/.test(subs.all) && /proxy/.test(subs.all), subs.all.slice(0, 120));
    ok("§B3e · the sub still names the scope it composes with", /Showing every adviser's cases|Showing your cases/.test(subs.all), subs.all.slice(0, 160));

    /* h3 counts + grouping, on the filtered set. */
    await pick("ended");
    const hEnded = await page.evaluate(() => ({
      h3: document.getElementById("ret-rates-h3").textContent.replace(/\s+/g, " ").trim(),
      groupCount: Number(document.querySelector("#ret-rates-list .ret-group-h.ret-g-ended .count")?.textContent || -1),
      rows: document.querySelectorAll("#ret-rates-list .row-item").length,
      soonHead: document.querySelectorAll("#ret-rates-list .ret-group-h.ret-g-soon").length,
    }));
    const endedBadge = Number((hEnded.h3.match(/(\d+) already ended/) || [])[1]);
    ok("§B4a · the h3 'already ended' badge counts the FILTERED rows, not the whole feed",
      endedBadge === hEnded.rows && endedBadge === hEnded.groupCount, JSON.stringify(hEnded));
    eq("§B4b · …and under 'Ended' there is no 'Ending soon' group at all", hEnded.soonHead, 0);

    await pick("next");
    const hNext = await page.evaluate(() => ({
      h3: document.getElementById("ret-rates-h3").textContent.replace(/\s+/g, " ").trim(),
      endedHead: document.querySelectorAll("#ret-rates-list .ret-group-h.ret-g-ended").length,
      soonCount: Number(document.querySelector("#ret-rates-list .ret-group-h.ret-g-soon .count")?.textContent || -1),
      rows: document.querySelectorAll("#ret-rates-list .row-item").length,
    }));
    ok("§B4c · under 'Next month' nothing has ended, so the Ended group is gone", hNext.endedHead === 0 && !/already ended/.test(hNext.h3), JSON.stringify(hNext));
    eq("§B4d · …and the 'Ending soon' group counts exactly the rows on screen", hNext.soonCount, hNext.rows);
    const windowBadge = Number((hNext.h3.match(/(\d+) in the \d+-month window/) || [])[1] || 0);
    ok("§B4e · the 'in the N-month window' badge never outruns the rows it sits above",
      windowBadge <= hNext.rows + 0 || windowBadge === 0, JSON.stringify({ windowBadge, rows: hNext.rows }));

    /* Persistence. */
    const stored = await page.evaluate(() => localStorage.getItem("nx_ret_month"));
    eq("§B5a · the pick is stored in localStorage nx_ret_month", stored, "next");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    await goRetention(page, 2400);
    const after = await page.evaluate(() => ({
      stored: localStorage.getItem("nx_ret_month"),
      on: [...document.querySelectorAll("#ret-month-chips .ret-month-chip")].filter((b) => b.classList.contains("scope-active")).map((b) => b.dataset.month),
      sub: document.getElementById("ret-rates-sub").textContent,
    }));
    eq("§B5b · …and survives a reload", after.stored, "next");
    eq("§B5c · …with the chip still shown as the active one", after.on.join(","), "next");
    ok("§B5d · …and the sub still names that window", /Showing only rates ending in /.test(after.sub), after.sub.slice(-120));

    ok("§B · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §C · THE WORKABLE ROW
     ====================================================================== */
  console.log("\n— §C · workable row: tel link, Log call, Book review");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    const withPhone = await mkClientCase(page, { first: "R64C", last: "Withphone" + t, email: `c1.${t}@example.com`, phone: "07700 900 321", case: { lender: "Halifax", rate_percent: 2.1, rate_end_date: daysFrom(-20), completed_at: daysFrom(-800), loan_amount: 190000, property_address: "20 R64 Row, Testtown TE6 6AA" } });
    const noPhone = await mkClientCase(page, { first: "R64C", last: "Nophone" + t, email: `c2.${t}@example.com`, phone: null, case: { lender: "Skipton", rate_percent: 2.2, rate_end_date: daysFrom(-18), completed_at: daysFrom(-810), loan_amount: 175000, property_address: "21 R64 Row, Testtown TE6 6AB" } });
    const modalCase = await mkClientCase(page, { first: "R64C", last: "Modalpath" + t, email: `c3.${t}@example.com`, phone: "07700 900 654", case: { lender: "Nationwide", rate_percent: 2.3, rate_end_date: daysFrom(-16), completed_at: daysFrom(-820), loan_amount: 165000, property_address: "22 R64 Row, Testtown TE6 6AC" } });
    await goRetention(page, 2400);

    const rowBits = await page.evaluate((o) => {
      const row = (id) => [...document.querySelectorAll("#ret-rates-list .row-item")]
        .find((r) => (r.querySelector(".t[onclick]") || {}).getAttribute && r.querySelector(".t[onclick]").getAttribute("onclick").includes(`'${id}'`));
      const r1 = row(o.a), r2 = row(o.b);
      const tel = r1 && r1.querySelector(".ret-row-tel a[href^='tel:']");
      return {
        tel: tel ? tel.getAttribute("href") : null,
        telText: tel ? tel.textContent : null,
        noTel: r2 ? !r2.querySelector(".ret-row-tel") : null,
        logcall: !!(r1 && r1.querySelector("button[onclick*='retLogCall']")),
        book: !!(r1 && r1.querySelector("button[onclick*='retBookReview']")),
        quiet: !!(r1 && r1.querySelector(".ret-row-acts.hover-quiet")),
      };
    }, { a: withPhone.caseId, b: noPhone.caseId });
    eq("§C1a · a client with a number gets a real tel: link on the row", rowBits.tel, "tel:07700900321");
    eq("§C1b · …printed as the number the record holds", rowBits.telText, "07700 900 321");
    ok("§C1c · a client with no number gets no dead phone affordance", rowBits.noTel === true);
    ok("§C1d · the row carries both chips", rowBits.logcall && rowBits.book, JSON.stringify(rowBits));
    ok("§C1e · …in a hover-quiet cluster (R61's card-advance manners)", rowBits.quiet);

    /* --- Log call, from the row --- */
    await page.click(`#ret-rates-list button[onclick*="retLogCall('${withPhone.caseId}')"]`);
    await page.waitForTimeout(1200);
    const overlay = await page.evaluate(() => ({
      panel: !!document.getElementById("ret-logcall-panel"),
      note: !!document.getElementById("cs-call-note"),
      chips: document.querySelectorAll("#ret-logcall-panel #cs-call-outcome-chips .tl-chip").length,
      prot: !!document.getElementById("cs-call-prot"),
      fu: !!document.getElementById("cs-call-fu-title"),
      save: !!document.getElementById("cs-call-save"),
      modalUp: !document.getElementById("modal-backdrop").classList.contains("hidden"),
    }));
    ok("§C2a · the row chip opens the SAME log-call panel the case modal carries (same ids)",
      overlay.panel && overlay.note && overlay.chips === 4 && overlay.prot && overlay.fu && overlay.save, JSON.stringify(overlay));
    ok("§C2b · …as an overlay, without opening the case modal", overlay.modalUp === false);
    await page.click("#ret-logcall-panel #cs-call-outcome-chips .tl-chip[data-outcome='No answer']");
    await page.fill("#cs-call-note", "tried the mobile, will retry Thursday");
    await page.fill("#cs-call-fu-title", "Ring back about the rate end");
    await page.click("#cs-call-save");
    await page.waitForTimeout(2800);
    const wroteRow = await page.evaluate(async (id) => {
      const { data: notes } = await window.__mockDb.from("case_notes").select("*");
      const { data: tasks } = await window.__mockDb.from("case_tasks").select("*");
      return {
        notes: (notes || []).filter((n) => n.case_id === id).map((n) => n.body),
        tasks: (tasks || []).filter((x) => x.case_id === id).map((x) => ({ title: x.title, assigned_to: x.assigned_to })),
        overlayGone: document.getElementById("overlay-backdrop").classList.contains("hidden"),
      };
    }, withPhone.caseId);
    eq("§C2c · the call is filed as ONE 'Call: <outcome> — <note>' note on that case",
      wroteRow.notes.filter((b) => /^Call: /.test(b)).join("|"), "Call: No answer — tried the mobile, will retry Thursday");
    eq("§C2d · …and the optional follow-up task is written on the same case", wroteRow.tasks.filter((x) => x.title === "Ring back about the rate end").length, 1);
    eq("§C2e · …assigned to the case's adviser, not to whoever took the call", (wroteRow.tasks.find((x) => x.title === "Ring back about the rate end") || {}).assigned_to, "p2");
    ok("§C2f · the overlay closes on save", wroteRow.overlayGone);

    /* --- the same inputs through the CASE MODAL, to prove one writer --- */
    await page.evaluate((id) => window.openCase(id), modalCase.caseId);
    await page.waitForTimeout(2200);
    await page.click("#cs-logcall-btn");
    await page.waitForTimeout(400);
    await page.click("#cs-logcall-panel #cs-call-outcome-chips .tl-chip[data-outcome='No answer']");
    await page.fill("#cs-call-note", "tried the mobile, will retry Thursday");
    await page.fill("#cs-call-fu-title", "Ring back about the rate end");
    await page.click("#cs-call-save");
    await page.waitForTimeout(2200);
    const wroteModal = await page.evaluate(async (id) => {
      const { data: notes } = await window.__mockDb.from("case_notes").select("*");
      const { data: tasks } = await window.__mockDb.from("case_tasks").select("*");
      return {
        notes: (notes || []).filter((n) => n.case_id === id).map((n) => n.body).filter((b) => /^Call: /.test(b)),
        tasks: (tasks || []).filter((x) => x.case_id === id).map((x) => ({ title: x.title, assigned_to: x.assigned_to })),
      };
    }, modalCase.caseId);
    eq("§C3a · the case modal's own Log call writes the identical note body",
      wroteModal.notes.join("|"), wroteRow.notes.filter((b) => /^Call: /.test(b)).join("|"));
    eq("§C3b · …and the identical follow-up task, on the same assignee rule",
      JSON.stringify(wroteModal.tasks.filter((x) => x.title === "Ring back about the rate end")),
      JSON.stringify(wroteRow.tasks.filter((x) => x.title === "Ring back about the rate end")));
    await page.evaluate(() => window.closeModal && window.closeModal());
    await page.waitForTimeout(600);

    /* --- Book review, from the row --- */
    await goRetention(page, 2400);
    await page.click(`#ret-rates-list button[onclick*="retBookReview('${withPhone.caseId}')"]`);
    await page.waitForTimeout(2000);
    const prefill = await page.evaluate(() => {
      const f = document.getElementById("appt-form");
      if (!f) return null;
      return {
        title: f.elements.title.value,
        client: f.elements.client_id.value,
        caseId: f.elements.case_id ? f.elements.case_id.value : null,
        staff: f.elements.staff_id.value,
        isNew: (document.querySelector("#modal h3") || {}).textContent,
      };
    });
    ok("§C4a · '📅 Book review' opens the diary's own appointment editor", !!prefill && /New appointment/.test(prefill.isNew), JSON.stringify(prefill));
    eq("§C4b · …prefilled with the title the firm uses for this meeting", prefill && prefill.title, "Rate-end review");
    eq("§C4c · …with the client prefilled", prefill && prefill.client, withPhone.clientId);
    eq("§C4d · …with the case prefilled", prefill && prefill.caseId, withPhone.caseId);
    eq("§C4e · …and the adviser who owns the case", prefill && prefill.staff, "p2");
    await page.click("#modal-save");
    await page.waitForTimeout(2200);
    const appt = await page.evaluate(async (id) => {
      const { data } = await window.__mockDb.from("appointments").select("*");
      return (data || []).filter((a) => a.case_id === id).map((a) => ({ title: a.title, staff: a.staff_id, client: a.client_id }));
    }, withPhone.caseId);
    eq("§C4f · saving writes the appointment against the right case", appt.length, 1);
    eq("§C4g · …with the prefilled title and adviser intact", JSON.stringify(appt[0] || {}), JSON.stringify({ title: "Rate-end review", staff: "p2", client: withPhone.clientId }));

    ok("§C · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §D · R38 PARITY — TODAY'S DRAWER IS UNTOUCHED
     ====================================================================== */
  console.log("\n— §D · the Today drawer keeps its R38 markup");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    /* Soon, not long-ended, so it clears the drawer's R47 recency floor and appears on both. */
    const both = await mkClientCase(page, { first: "R64D", last: "Parity" + t, email: `d.${t}@example.com`, phone: "07700900777", case: { lender: "Halifax", rate_percent: 2.11, rate_end_date: daysFrom(45), completed_at: daysFrom(-500), loan_amount: 222000, property_address: "30 R64 Parity Cl, Testtown TE6 7AA" } });
    await page.evaluate(() => window.nav("dashboard"));
    await page.waitForTimeout(2600);
    const drawer = await page.evaluate((id) => {
      const row = [...document.querySelectorAll("#alerts-rateerc .row-item")]
        .find((r) => (r.querySelector(".t[onclick]") || {}).getAttribute && r.querySelector(".t[onclick]").getAttribute("onclick").includes(`'${id}'`));
      if (!row) return null;
      return {
        html: row.outerHTML,
        main: row.querySelector(".row-main").innerHTML,
        cbs: document.querySelectorAll("#alerts-rateerc .ret-cb").length,
        acts: document.querySelectorAll("#alerts-rateerc .ret-row-acts").length,
        logcall: document.querySelectorAll("#alerts-rateerc button[onclick*='retLogCall']").length,
        book: document.querySelectorAll("#alerts-rateerc button[onclick*='retBookReview']").length,
        bar: !!document.querySelector("#alerts-rateerc .bulk-bar"),
      };
    }, both.caseId);
    ok("§D0 · fixture — the seeded case reaches Today's Rate & ERC drawer", !!drawer, "row not found");
    eq("§D1a · no drawer row carries a selection checkbox", drawer && drawer.cbs, 0);
    eq("§D1b · no drawer row carries the R64 action cluster", drawer && drawer.acts, 0);
    ok("§D1c · no drawer row carries the Log call / Book review chips", drawer && drawer.logcall === 0 && drawer.book === 0, JSON.stringify(drawer && { l: drawer.logcall, b: drawer.book }));
    ok("§D1d · no bulk bar leaks into the drawer", drawer && drawer.bar === false);

    await goRetention(page, 2400);
    const pageRow = await page.evaluate((id) => {
      const row = [...document.querySelectorAll("#ret-rates-list .row-item")]
        .find((r) => (r.querySelector(".t[onclick]") || {}).getAttribute && r.querySelector(".t[onclick]").getAttribute("onclick").includes(`'${id}'`));
      if (!row) return null;
      const clone = row.cloneNode(true);
      /* R70 · B2 (merge-time patch, one selector) — `.ret-row-lastc` joins the two R64 page-only
         elements this parity check has always lifted out. The "last contact 3 days ago (LR)" /
         "never contacted" clause is deliberately PAGE-ONLY: rendering it needs the five scoped
         comms reads in lastContactByClient(), which a fifteen-row morning glance does not earn.
         The tel:/sms: pair, by contrast, is on BOTH surfaces from R70 on, so it is NOT stripped —
         it is compared, byte for byte, like everything else. No assertion is weakened: the whole
         row is still compared, and a row that differs anywhere else still fails. */
      clone.querySelectorAll(".ret-cb, .ret-row-acts, .ret-row-lastc").forEach((n) => n.remove());
      clone.classList.remove("is-sel");
      return { main: clone.querySelector(".row-main").innerHTML, html: clone.outerHTML };
    }, both.caseId);
    /* The lender favicon's onerror handler writes style="display:none" at runtime, on whichever
       surface has been on screen longest — normalised out so this compares MARKUP, not timing.

       R69 · B1/L3 — that handler now REMOVES the failed <img> instead of hiding it, and remembers
       the domain so later paints emit none at all. The timing skew this line has always existed to
       absorb is therefore structural rather than an attribute: whichever of the two surfaces was
       painted before the favicon failed still carries the whole <img class="lfav">, and the one
       painted after carries nothing. So the tag itself is normalised out of BOTH sides — the same
       normalisation this line already performed, one level up. Nothing else is relaxed: every
       other byte of both rows is still compared, and a row that differs anywhere else still
       fails. */
    const norm = (s) => String(s || "")
      .replace(/ style="display: none;"/g, "")
      .replace(/<img class="lfav"[^>]*>/g, "");
    ok("§D2a · with the R64 additions removed, the page row's body is byte-identical to the drawer's",
      !!pageRow && !!drawer && norm(pageRow.main) === norm(drawer.main),
      JSON.stringify({ page: norm(pageRow && pageRow.main).slice(0, 220), drawer: norm(drawer && drawer.main).slice(0, 220) }));
    ok("§D2b · …and so is the whole row element",
      !!pageRow && !!drawer && norm(pageRow.html) === norm(drawer.html),
      JSON.stringify({ page: norm(pageRow && pageRow.html).slice(0, 260), drawer: norm(drawer && drawer.html).slice(0, 260) }));
    ok("§D · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §E · EVERY PERSONA OPENS THE PAGE CLEAN
     ====================================================================== */
  console.log("\n— §E · no console errors, every persona");
  for (const persona of ["p2", "p3", "p4", "p1"]) {
    const page = await boot(browser, persona);
    await goRetention(page, 2400);
    const seen = await page.evaluate(() => ({
      chips: document.querySelectorAll("#ret-month-chips .ret-month-chip").length,
      bar: !!document.getElementById("ret-bulk-bar"),
      barHidden: document.getElementById("ret-bulk-bar") ? document.getElementById("ret-bulk-bar").hidden : null,
      selall: !!document.getElementById("ret-bulk-all"),
    }));
    eq(`§E · ${persona} sees the seven month chips`, seen.chips, 7);   // R70 · A1 — five + the two lapsed windows
    ok(`§E · ${persona} sees a hidden bulk bar and a select-all`, seen.bar && seen.barHidden === true && seen.selall, JSON.stringify(seen));
    ok(`§E · ${persona} opens Retention with no console errors`, realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  console.log(`\n================================================================`);
  console.log(`r64_retention: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  ✗ " + f));
  if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
