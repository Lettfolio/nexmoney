#!/usr/bin/env node
/* =============================================================================
   tests/r70_retention.js — acceptance tests for R70 build A, "Retention: reach
   and honesty" (panel findings H1, H2's confirm/repaint items, M5, L3, L4).

   What the R70 panel found, verified against production on 27 August:
     · the Retention list is capped at 100 rows sorted OLDEST-ended first, so the
       137 rates that lapsed in the last year — the only ones with a live
       conversation in them — can never be brought on screen, and the month chips
       all point FORWARD;
     · the R45 import guard stamped `rate_reminder_queued_at` on 1,711 completed
       cases with nothing queued and nothing sent, which the app rendered as a
       green "Reminder sent" badge and the bulk sweep read as "already reminded";
     · recording a rate-end outcome left the worked row on screen; the bulk
       "Start retention cases" verb fired one native confirm PER CASE.

     §A  CHIPS — "Ended · last 3 months" (ended3) and "Ended · last 12 months"
         (ended12) between "Ended" and "This month", computed off
         days_to_rate_end (−92…−1 / −366…−1), persisted under nx_ret_month, and
         the h3 saying each set ONCE under an ended-only window (L3).
     §B  SORT — #ret-sort-dir for EVERY persona (not just the money-holder),
         default most-recently-ended first, persisted under nx_ret_sortdir, with
         "ending soon" soonest-first in both directions and the year sub-heads
         working either way. Plus the capped footer naming the chips.
     §C  BADGE — reminderState() ×5: sent / queued-held / failed / guarded /
         marked / pending, on the page AND on Today's drawer (same helper, same
         feed shape), with the guarded row still WORKABLE.
     §D  GUARD SEMANTICS — a guarded case is eligible for the bulk reminder, the
         confirm names how many were imported with the back book (and says the
         hold is on — L4), and queueing clears reminder_guarded.
     §E  REPAINT — recording a rate-end outcome repaints the Retention list, so
         the worked row leaves without navigating away.
     §F  ONE CONFIRM — the bulk start opens exactly one overlay and no native
         dialog for four cases, pre-flights the sold-property check and names
         what it skipped.
     §G  M5 — the gi_referral_partner setting and its pre-fill.
     §H  No console errors, every persona.

   Run:  node /root/nx/tests/r70_retention.js
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

/* nx_ret_sortdir is R70's addition to the clear-list, for the same reason nx_ret_month was R64's:
   a suite that asserts a DEFAULT must never inherit a choice an earlier scenario made. */
const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_sortdir", "nx_wt_scope", "nx_board_adviser",
  "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc", "nx_drawer_retention"];

async function boot(browser, persona) {
  const page = await (await browser.newContext()).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.waitForTimeout(1500);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));

const goRetention = async (page, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate(() => window.nav("retention"));
  await page.waitForTimeout(ms == null ? 2200 : ms);
};
const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 1800 : ms);
};

let uniq = 0;
const tag = () => `R70X${Date.now().toString(36)}${++uniq}`;
const daysFrom = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/* One client + one case, inserted through the mock's own client so every default the app relies on
   (applyInsertDefaults — including R70's reminder_guarded) is applied exactly as production would. */
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const { data: cl, error: ce } = await db.from("clients").insert({
      first_name: o.first, last_name: o.last, email: o.email, phone: o.phone || null,
    }).select("id").single();
    if (ce) throw new Error("client insert: " + ce.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "completed", assigned_to: "p2" }, o.case || {});
    const { data: cs, error: se } = await db.from("cases").insert(row).select("id").single();
    if (se) throw new Error("case insert: " + se.message);
    if (o.email_row) {
      const { error: qe } = await db.from("email_queue").insert(Object.assign({
        case_id: cs.id, client_id: cl.id, email_type: "rate_end_reminder", to_email: o.email,
      }, o.email_row));
      if (qe) throw new Error("email_queue insert: " + qe.message);
    }
    if (o.guard) {
      const { error: ge } = await db.from("cases")
        .update({ reminder_guarded: true, rate_reminder_queued_at: new Date(Date.now() - 400 * 86400000).toISOString() })
        .eq("id", cs.id);
      if (ge) throw new Error("guard update: " + ge.message);
    }
    return { clientId: cl.id, caseId: cs.id };
  }, opts);
}

/* The ids currently painted, in the order they are painted — the order IS the assertion in §B. */
const pageRowIds = (page) => page.evaluate(() =>
  [...document.querySelectorAll("#ret-rates-list .row-item .t[onclick]")]
    .map((el) => (el.getAttribute("onclick").match(/openCase\('([^']+)'\)/) || [])[1]).filter(Boolean));

const rowOf = (page, id, root) => page.evaluate((o) => {
  const r = [...document.querySelectorAll(`${o.root} .row-item`)].find((x) => {
    const t = x.querySelector(".t[onclick]");
    return t && t.getAttribute("onclick").includes(`'${o.id}'`);
  });
  if (!r) return null;
  const b = r.querySelector(".ret-rem-badge");
  return {
    badge: b ? b.textContent.trim() : null,
    key: b ? b.dataset.rem : null,
    cls: b ? b.className : null,
    title: b ? b.getAttribute("title") : null,
    start: !!r.querySelector("button[onclick*='startRetentionCase']"),
    mark: !!r.querySelector("button[onclick*='markRateReminded']"),
  };
}, { id, root: root || "#ret-rates-list" });

async function selectRows(page, ids) {
  await page.evaluate((list) => {
    list.forEach((id) => {
      const cb = document.querySelector(`#ret-rates-list .ret-cb[data-id="${id}"]`);
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
    });
  }, ids);
  await page.waitForTimeout(300);
}
const pickChip = async (page, k) => {
  await page.click(`#ret-month-chips .ret-month-chip[data-month="${k}"]`);
  await page.waitForTimeout(2200);
};
const caseRow = (page, id) => page.evaluate(async (i) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", i).single();
  return data;
}, id);
const toastText = (page) => page.evaluate(() => (document.getElementById("toast") || {}).textContent || "");

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* ======================================================================
     §A · THE TWO LAPSED WINDOWS
     ====================================================================== */
  console.log("— §A · chips: Ended · last 3 months / last 12 months");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    const mk = (label, days, extra) => mkClientCase(page, {
      first: "R70A", last: label + t, email: `a.${label}.${t}@example.com`.toLowerCase(), phone: "07700900700",
      case: Object.assign({ lender: "Halifax", rate_percent: 2.4, loan_amount: 200000, completed_at: daysFrom(-900),
        rate_end_date: daysFrom(days), property_address: `${label} R70 Chip Rd, Testtown TE7 ${label.slice(0, 1)}AA` }, extra || {}),
    });
    const d5 = await mk("Five", -5);
    const d40 = await mk("Forty", -40);
    const d100 = await mk("Hundred", -100);
    const d400 = await mk("Fourhundred", -400);
    const d1500 = await mk("Fifteenhundred", -1500);
    const soon = await mk("Soon", 40);
    await goRetention(page, 2600);

    const chips = await page.evaluate(() => [...document.querySelectorAll("#ret-month-chips .ret-month-chip")]
      .map((b) => ({ k: b.dataset.month, label: b.textContent.replace(/\s+/g, " ").trim(), n: Number((b.querySelector(".count") || {}).textContent || -1) })));
    eq("§A1a · the two lapsed windows sit between 'Ended' and 'This month'",
      chips.map((c) => c.k).join(","), "ended,ended3,ended12,this,next,3mo,all");
    ok("§A1b · …labelled in the words the panel used", /Ended · last 3 months/.test(chips[1].label) && /Ended · last 12 months/.test(chips[2].label), JSON.stringify(chips.map((c) => c.label)));
    ok("§A1c · every chip carries the count it would show", chips.every((c) => c.n >= 0), JSON.stringify(chips));

    await pickChip(page, "ended3");
    const in3 = await pageRowIds(page);
    ok("§A2a · 'last 3 months' holds the −5 and −40 day rates", in3.includes(d5.caseId) && in3.includes(d40.caseId), JSON.stringify(in3.length));
    ok("§A2b · …and NOT −100, −400 or −1500", ![d100, d400, d1500].some((x) => in3.includes(x.caseId)));
    ok("§A2c · …and nothing that has not ended yet", !in3.includes(soon.caseId));
    eq("§A2d · the chip's own count matches the rows it drew", in3.length, chips[1].n);

    await pickChip(page, "ended12");
    const in12 = await pageRowIds(page);
    ok("§A3a · 'last 12 months' holds −5, −40 and −100", [d5, d40, d100].every((x) => in12.includes(x.caseId)), JSON.stringify(in12.length));
    ok("§A3b · …and still excludes −400 and −1500", ![d400, d1500].some((x) => in12.includes(x.caseId)));
    eq("§A3c · the chip's own count matches the rows it drew", in12.length, chips[2].n);

    await pickChip(page, "ended");
    const inEnded = await pageRowIds(page);
    ok("§A4a · plain 'Ended' still holds the whole lapsed book, −1500 included",
      [d5, d40, d100, d400, d1500].every((x) => inEnded.includes(x.caseId)), JSON.stringify(inEnded.length));
    ok("§A4b · the two windows are strict subsets of it", in3.every((x) => inEnded.includes(x)) && in12.every((x) => inEnded.includes(x)));

    /* L3 — the h3 counted the same rows under two labels on an ended-only window. */
    const h3Ended = await page.evaluate(() => document.getElementById("ret-rates-h3").textContent.replace(/\s+/g, " ").trim());
    const endedBadge = Number((h3Ended.match(/(\d+) already ended/) || [])[1]);
    ok("§A5a · L3 — under 'Ended' the h3 says the set ONCE: no second '… in the N-month window' badge",
      endedBadge === inEnded.length && !/in the \d+-month window/.test(h3Ended), h3Ended.slice(0, 200));
    await pickChip(page, "ended3");
    const h3E3 = await page.evaluate(() => document.getElementById("ret-rates-h3").textContent.replace(/\s+/g, " ").trim());
    ok("§A5b · …same on 'Ended · last 3 months'", !/in the \d+-month window/.test(h3E3), h3E3.slice(0, 200));
    await pickChip(page, "all");
    const h3All = await page.evaluate(() => document.getElementById("ret-rates-h3").textContent.replace(/\s+/g, " ").trim());
    ok("§A5c · …and the window badge is back where it means something (6 months (all))",
      /in the \d+-month window/.test(h3All) && /already ended/.test(h3All), h3All.slice(0, 200));

    /* The sub names the window in words, like every other chip. */
    await pickChip(page, "ended3");
    const sub3 = await page.evaluate(() => document.getElementById("ret-rates-sub").textContent);
    ok("§A6a · the sub says which lapsed window is in force", /ended in the last 3 months/i.test(sub3), sub3.slice(-160));
    await pickChip(page, "ended12");
    const sub12 = await page.evaluate(() => document.getElementById("ret-rates-sub").textContent);
    ok("§A6b · …and for the 12-month one, pointing at where the older ones went", /last 12 months/i.test(sub12) && /under “Ended”/.test(sub12), sub12.slice(-200));

    /* Persistence, through the existing key. */
    eq("§A7a · the pick is stored under the existing nx_ret_month key",
      await page.evaluate(() => localStorage.getItem("nx_ret_month")), "ended12");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    await goRetention(page, 2400);
    const activeAfter = await page.evaluate(() => (document.querySelector("#ret-month-chips .ret-month-chip.scope-active") || {}).dataset?.month);
    eq("§A7b · …and survives a reload", activeAfter, "ended12");
    ok("§A · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §B · THE SORT DIRECTION — for everyone, not just the owner
     ====================================================================== */
  console.log("\n— §B · sort direction (p3, an adviser with no money on screen)");
  {
    const page = await boot(browser, "p3");
    const t = tag();
    const mk = (label, days) => mkClientCase(page, {
      first: "R70B", last: label + t, email: `b.${label}.${t}@example.com`.toLowerCase(), phone: "07700900701",
      case: { lender: "Skipton", rate_percent: 2.1, loan_amount: 150000, assigned_to: "p3", completed_at: daysFrom(-900),
        rate_end_date: daysFrom(days), property_address: `${label} R70 Sort Rd, Testtown TE7 ${label.slice(0, 1)}AB` },
    });
    const newest = await mk("Newest", -3);
    const middle = await mk("Middle", -200);
    const oldest = await mk("Oldest", -1200);
    const soonA = await mk("Soona", 20);
    const soonB = await mk("Soonb", 90);
    /* The year sub-heads only appear once the Ended group is worth breaking up (>8 rows — R61's
       rule), so the group is filled out across four calendar years on purpose. */
    for (const [i, d] of [-60, -160, -300, -520, -700, -880, -1000, -1400].entries()) {
      await mk("Filler" + i, d);
    }
    await goRetention(page, 3200);

    const btn = await page.evaluate(() => {
      const b = document.getElementById("ret-sort-dir");
      return b ? { label: b.textContent.trim(), pressed: b.getAttribute("aria-pressed"), title: b.getAttribute("title") } : null;
    });
    ok("§B1a · an adviser gets a date-direction control at all (it is not behind the money gate)", !!btn, JSON.stringify(btn));
    ok("§B1b · …and the money sort is still owner-only, so this is the only one they see",
      await page.evaluate(() => !document.getElementById("ret-rates-sort")));
    ok("§B1c · the default is most-recently-ended first", /Most recently ended first/i.test((btn || {}).label || ""), JSON.stringify(btn));
    ok("§B1d · the control explains what it does, in English", /freshest lapse/i.test((btn || {}).title || "") && /soonest-first/i.test((btn || {}).title || ""), (btn || {}).title);

    const order = await pageRowIds(page);
    const pos = (id) => order.indexOf(id);
    ok("§B2a · ENDED rows read newest-lapsed first (−3 before −200 before −1200)",
      pos(newest.caseId) < pos(middle.caseId) && pos(middle.caseId) < pos(oldest.caseId),
      JSON.stringify({ n: pos(newest.caseId), m: pos(middle.caseId), o: pos(oldest.caseId) }));
    ok("§B2b · …while 'ending soon' still reads soonest-first (+20 before +90)",
      pos(soonA.caseId) < pos(soonB.caseId), JSON.stringify({ a: pos(soonA.caseId), b: pos(soonB.caseId) }));
    ok("§B2c · …and every ended row still comes before every row that has not ended",
      pos(oldest.caseId) < pos(soonA.caseId), JSON.stringify(order.length));

    const yearsDesc = await page.evaluate(() => [...document.querySelectorAll("#ret-rates-list .ret-year-h")].map((e) => e.textContent.trim()));
    ok("§B2d · the year sub-heads survive the reversal (descending years)",
      yearsDesc.length > 1 && yearsDesc.join(",") === [...yearsDesc].sort().reverse().join(","), JSON.stringify(yearsDesc));

    await page.click("#ret-sort-dir");
    await page.waitForTimeout(2200);
    const btn2 = await page.evaluate(() => document.getElementById("ret-sort-dir").textContent.trim());
    ok("§B3a · one click flips the label to 'Oldest first'", /Oldest first/i.test(btn2), btn2);
    const order2 = await pageRowIds(page);
    const pos2 = (id) => order2.indexOf(id);
    ok("§B3b · …and the ended rows reverse (−1200 before −200 before −3)",
      pos2(oldest.caseId) < pos2(middle.caseId) && pos2(middle.caseId) < pos2(newest.caseId),
      JSON.stringify({ o: pos2(oldest.caseId), m: pos2(middle.caseId), n: pos2(newest.caseId) }));
    ok("§B3c · …while 'ending soon' is untouched by the flip", pos2(soonA.caseId) < pos2(soonB.caseId));
    const yearsAsc = await page.evaluate(() => [...document.querySelectorAll("#ret-rates-list .ret-year-h")].map((e) => e.textContent.trim()));
    ok("§B3d · the year sub-heads work in this direction too (ascending years)",
      yearsAsc.length > 1 && yearsAsc.join(",") === [...yearsAsc].sort().join(","), JSON.stringify(yearsAsc));

    eq("§B4a · the direction is stored under nx_ret_sortdir",
      await page.evaluate(() => localStorage.getItem("nx_ret_sortdir")), "oldest");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    await goRetention(page, 2400);
    ok("§B4b · …and survives a reload", /Oldest first/i.test(await page.evaluate(() => document.getElementById("ret-sort-dir").textContent)));
    ok("§B · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* --- the capped footer names the chips, not "the scope control" --------- */
  console.log("\n— §B5 · the 100-row cap names the way out of it");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    /* 110 lapsed rates in one go: the cap is the whole H1 finding, and it only bites past 100. */
    await page.evaluate(async (o) => {
      const db = window.__mockDb;
      for (let i = 0; i < 110; i++) {
        const { data: cl } = await db.from("clients").insert({
          first_name: "R70Cap", last_name: `Row${i}${o.t}`, email: `cap.${i}.${o.t}@example.com`.toLowerCase(), phone: "07700900702",
        }).select("id").single();
        await db.from("cases").insert({
          client_id: cl.id, case_kind: "remortgage", stage: "completed", assigned_to: "p2",
          lender: "Barclays", rate_percent: 2.2, loan_amount: 120000,
          completed_at: new Date(Date.now() - 900 * 86400000).toISOString().slice(0, 10),
          rate_end_date: new Date(Date.now() - (5 + i * 4) * 86400000).toISOString().slice(0, 10),
          property_address: `${i} R70 Cap Rd, Testtown TE7 9ZZ`,
        });
      }
    }, { t });
    await goRetention(page, 4000);
    const capped = await page.evaluate(() => {
      const rows = document.querySelectorAll("#ret-rates-list .row-item").length;
      const foot = [...document.querySelectorAll("#ret-rates-list .empty")].map((e) => e.textContent).join(" ");
      return { rows, foot };
    });
    ok("§B5a · the list is still capped at 100 rows", capped.rows === 100, JSON.stringify(capped.rows));
    ok("§B5b · the footer names the CHIPS that reach the rest, by their own labels",
      /Ended · last 3 months/.test(capped.foot) && /Ended · last 12 months/.test(capped.foot), capped.foot.slice(0, 260));
    ok("§B5c · …and the direction control, so the other end of the list is reachable too",
      /Most recently ended first|Oldest first/.test(capped.foot), capped.foot.slice(0, 260));
    ok("§B5d · …and it no longer sends the reader to 'the scope control'", !/scope control/.test(capped.foot), capped.foot.slice(0, 260));
    ok("§B5 · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §C · THE HONEST BADGE
     ====================================================================== */
  console.log("\n— §C · reminderState: five badges, one helper");
  {
    const page = await boot(browser, "p4");   // owner: sees the whole firm
    const t = tag();
    const mk = (label, opts) => mkClientCase(page, Object.assign({
      first: "R70C", last: label + t, email: `c.${label}.${t}@example.com`.toLowerCase(), phone: "07700900703",
      case: { lender: "Nationwide", rate_percent: 2.3, loan_amount: 180000, completed_at: daysFrom(-900),
        rate_end_date: daysFrom(-30), property_address: `${label} R70 Badge Rd, Testtown TE7 3AA` },
    }, opts));
    const sent = await mk("Sent", { email_row: { status: "sent", sent_at: new Date(Date.now() - 5 * 86400000).toISOString() } });
    const queued = await mk("Queued", { email_row: { status: "queued" } });
    const failed = await mk("Failed", { email_row: { status: "failed", error: "550 bounced" } });
    const guarded = await mk("Guarded", { guard: true });
    const pending = await mk("Pending", {});
    const marked = await mk("Marked", {});
    await page.evaluate((id) => window.__mockDb.from("cases").update({ rate_reminder_queued_at: new Date().toISOString() }).eq("id", id), marked.caseId);
    await goRetention(page, 3000);

    const rSent = await rowOf(page, sent.caseId);
    eq("§C1a · a case with a SENT rate_end_reminder reads 'Reminder sent'", (rSent || {}).badge, "Reminder sent");
    ok("§C1b · …in green, with the date in the title", /green/.test((rSent || {}).cls || "") && /sent to this client on/i.test((rSent || {}).title || ""), JSON.stringify(rSent));

    const rQueued = await rowOf(page, queued.caseId);
    eq("§C2a · a QUEUED reminder reads 'Reminder queued — held' while sending is on hold", (rQueued || {}).badge, "Reminder queued — held");
    ok("§C2b · …and the title says where the hold lives (L4)", /ON HOLD \(Settings › Email sending\)/.test((rQueued || {}).title || ""), (rQueued || {}).title);

    const rFailed = await rowOf(page, failed.caseId);
    eq("§C3a · a FAILED reminder reads 'Reminder failed'", (rFailed || {}).badge, "Reminder failed");
    ok("§C3b · …in red, saying nobody has heard from us", /red/.test((rFailed || {}).cls || "") && /nobody has heard from us/i.test((rFailed || {}).title || ""), JSON.stringify(rFailed));

    const rGuard = await rowOf(page, guarded.caseId);
    eq("§C4a · an IMPORT-GUARDED stamp reads 'No reminder sent', not 'Reminder sent'", (rGuard || {}).badge, "No reminder sent");
    ok("§C4b · …with the sentence that explains the import guard",
      /Imported with the back book; the automation was told to leave this case alone\. Work it from here\./.test((rGuard || {}).title || ""), (rGuard || {}).title);
    ok("§C4c · …and the row is WORKABLE: the 🔁 Start retention case button is still there", (rGuard || {}).start === true, JSON.stringify(rGuard));

    const rMarked = await rowOf(page, marked.caseId);
    eq("§C5a · a stamp with no email row and no guard reads 'Marked reminded'", (rMarked || {}).badge, "Marked reminded");
    ok("§C5b · …and that row is NOT offered as unworked (the stamp was a decision)", (rMarked || {}).start === false, JSON.stringify(rMarked));

    const rPending = await rowOf(page, pending.caseId);
    eq("§C6a · nothing at all still reads 'Reminder pending'", (rPending || {}).badge, "Reminder pending");
    ok("§C6b · …and offers the Start retention case button", (rPending || {}).start === true, JSON.stringify(rPending));
    ok("§C6c · a case that HAS been written to is not offered as unworked",
      (rSent || {}).start === false && (rQueued || {}).start === false, JSON.stringify({ s: rSent, q: rQueued }));

    /* The fixture's own import-guarded back book (mock-supabase.js) — the production shape. */
    const fixtureGuard = await page.evaluate(async () => {
      const { data } = await window.__mockDb.from("v_alerts").select("*");
      return (data || []).filter((a) => a.reminder_guarded).map((a) => a.case_id);
    });
    ok("§C7a · the mock seeds an import-guarded back book (stamp set, nothing ever queued)", fixtureGuard.length >= 3, JSON.stringify(fixtureGuard));
    const fixRow = await rowOf(page, fixtureGuard[0]);
    ok("§C7b · a fixture guarded row reads the same as a seeded one", fixRow && fixRow.badge === "No reminder sent", JSON.stringify(fixRow));

    /* Today's Rate & ERC drawer shares renderRateErcRow — and now shares the feed's email map. */
    await goPage(page, "dashboard", 2600);
    await page.evaluate(() => { const d = document.querySelector("#rate-erc-panel details, #rate-erc-panel"); if (d && d.tagName === "DETAILS") d.open = true; });
    await page.waitForTimeout(600);
    /* Parity, not a second implementation: every completed row the drawer draws must carry the
       badge the page draws for that same case. The drawer shows fifteen rows in a different order,
       so the comparison is by case id over whatever it happens to be showing. */
    const drawerBadges = await page.evaluate(() => {
      const out = {};
      [...document.querySelectorAll("#alerts-rateerc .row-item")].forEach((r) => {
        const t = r.querySelector(".t[onclick]"), b = r.querySelector(".ret-rem-badge");
        const id = t && (t.getAttribute("onclick").match(/openCase\('([^']+)'\)/) || [])[1];
        if (id && b) out[id] = b.textContent.trim();
      });
      return out;
    });
    ok("§C8a · Today's Rate & ERC drawer draws reminder badges from the same helper",
      Object.keys(drawerBadges).length > 0, JSON.stringify(drawerBadges).slice(0, 200));
    await goRetention(page, 3000);
    const pageBadges = await page.evaluate((ids) => {
      const out = {};
      [...document.querySelectorAll("#ret-rates-list .row-item")].forEach((r) => {
        const t = r.querySelector(".t[onclick]"), b = r.querySelector(".ret-rem-badge");
        const id = t && (t.getAttribute("onclick").match(/openCase\('([^']+)'\)/) || [])[1];
        if (id && b && ids.includes(id)) out[id] = b.textContent.trim();
      });
      return out;
    }, Object.keys(drawerBadges));
    const disagree = Object.keys(pageBadges).filter((id) => pageBadges[id] !== drawerBadges[id]);
    ok("§C8b · …and never tells the same client's story two different ways",
      Object.keys(pageBadges).length > 0 && disagree.length === 0,
      JSON.stringify({ compared: Object.keys(pageBadges).length, disagree: disagree.map((id) => [id, drawerBadges[id], pageBadges[id]]) }));
    ok("§C · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §D · GUARD SEMANTICS IN THE BULK SWEEP
     ====================================================================== */
  console.log("\n— §D · a guarded case is eligible, named, and un-guarded by the queueing");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    const mk = (label, opts) => mkClientCase(page, Object.assign({
      first: "R70D", last: label + t, email: `d.${label}.${t}@example.com`.toLowerCase(), phone: "07700900704",
      case: { lender: "Coventry", rate_percent: 2.6, loan_amount: 210000, completed_at: daysFrom(-800),
        rate_end_date: daysFrom(-25), property_address: `${label} R70 Guard Rd, Testtown TE7 4AA` },
    }, opts));
    const g1 = await mk("Guardone", { guard: true });
    const g2 = await mk("Guardtwo", { guard: true });
    const plain = await mk("Plain", {});
    await goRetention(page, 2800);
    await selectRows(page, [g1.caseId, g2.caseId, plain.caseId]);
    await page.click("#ret-bulk-rate");
    await page.waitForTimeout(3000);

    const dlg = (page.__dialogs || []).map((d) => d.message).join("\n---\n");
    ok("§D1a · the guarded cases are IN the sweep, not held back as 'already reminded'",
      /Queue 3 rate-end reminders/.test(dlg), dlg.slice(0, 200));
    ok("§D1b · the confirm names how many were imported with the back book and never reminded",
      /2 of these were imported with the back book/.test(dlg) && /NEVER been reminded/.test(dlg), dlg.slice(0, 700));
    ok("§D1c · …and does NOT claim they have already been reminded once",
      !/already been reminded once/.test(dlg), dlg.slice(0, 700));
    ok("§D1d · L4 — while sending is on hold the confirm says so instead of promising a send",
      /ON HOLD \(Settings › Email sending\)/.test(dlg) && !/They send with the next automation run/.test(dlg), dlg.slice(0, 300));

    const after = await page.evaluate(async (ids) => {
      const db = window.__mockDb;
      const { data: cs } = await db.from("cases").select("id,rate_reminder_queued_at,reminder_guarded").in("id", ids);
      const { data: eq } = await db.from("email_queue").select("case_id,email_type,status").in("case_id", ids);
      return { cases: cs, queued: (eq || []).filter((e) => e.email_type === "rate_end_reminder") };
    }, [g1.caseId, g2.caseId, plain.caseId]);
    eq("§D2a · a reminder is queued for all three, guarded ones included", after.queued.length, 3);
    ok("§D2b · every one of them is now stamped", (after.cases || []).every((c) => !!c.rate_reminder_queued_at), JSON.stringify(after.cases));
    ok("§D2c · …and the import guard is CLEARED by the same write — the badge stops saying 'no reminder sent'",
      (after.cases || []).every((c) => c.reminder_guarded === false), JSON.stringify(after.cases));

    await goRetention(page, 2600);
    const rG1 = await rowOf(page, g1.caseId);
    eq("§D3 · the row now reads the truth: a reminder is queued and held", (rG1 || {}).badge, "Reminder queued — held");
    ok("§D · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* --- the single-case paths clear the guard too -------------------------- */
  console.log("\n— §D4 · the single-case paths clear the guard as well");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    const mk = (label, opts) => mkClientCase(page, Object.assign({
      first: "R70D4", last: label + t, email: `d4.${label}.${t}@example.com`.toLowerCase(), phone: "07700900705",
      case: { lender: "Halifax", rate_percent: 2.7, loan_amount: 190000, completed_at: daysFrom(-800),
        rate_end_date: daysFrom(-18), property_address: `${label} R70 Single Rd, Testtown TE7 5AA` },
    }, opts));
    const startCase = await mk("Startone", { guard: true });
    const markCase = await mk("Markone", { guard: true });
    await goRetention(page, 2800);
    await page.evaluate((id) => window.startRetentionCase(id, null, { silent: true, assumeConfirmed: true }), startCase.caseId);
    await page.waitForTimeout(2000);
    const s1 = await caseRow(page, startCase.caseId);
    ok("§D4a · starting a retention case stamps the source and clears its guard",
      !!s1.rate_reminder_queued_at && s1.reminder_guarded === false, JSON.stringify({ st: !!s1.rate_reminder_queued_at, g: s1.reminder_guarded }));
    await page.evaluate((id) => window.markRateReminded(id), markCase.caseId);
    await page.waitForTimeout(1500);
    const s2 = await caseRow(page, markCase.caseId);
    ok("§D4b · 'mark as reminded' clears the guard too — a person has now decided about it",
      !!s2.rate_reminder_queued_at && s2.reminder_guarded === false, JSON.stringify({ st: !!s2.rate_reminder_queued_at, g: s2.reminder_guarded }));
    await goRetention(page, 2600);
    eq("§D4c · …and that row reads 'Marked reminded', never 'Reminder sent'", ((await rowOf(page, markCase.caseId)) || {}).badge, "Marked reminded");
    ok("§D4 · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §E · REPAINT AFTER AN OUTCOME
     ====================================================================== */
  console.log("\n— §E · the worked row leaves the list without navigating away");
  {
    const page = await boot(browser, "p4");
    const t = tag();
    const c = await mkClientCase(page, {
      first: "R70E", last: "Outcome" + t, email: `e.${t}@example.com`.toLowerCase(), phone: "07700900706",
      case: { lender: "Skipton", rate_percent: 2.9, loan_amount: 175000, completed_at: daysFrom(-800),
        rate_end_date: daysFrom(-12), property_address: `1 R70 Outcome Rd, Testtown TE7 6AA` },
    });
    await goRetention(page, 2800);
    ok("§E1a · the case is on the Retention list to start with", (await pageRowIds(page)).includes(c.caseId));
    await page.evaluate((id) => window.openCase(id), c.caseId);
    await page.waitForTimeout(1500);
    ok("§E1b · the completed, rate-tracked case offers 📌 Rate-end outcome",
      await page.evaluate(() => !!document.querySelector("#act-rate-outcome")));
    await page.click("#act-rate-outcome");
    await page.waitForTimeout(900);
    await page.evaluate(() => { document.querySelector('#overlay-modal input[name="reo-kind"][value="sold"]').click(); });
    await page.click("#overlay-modal #reo-ok");
    await page.waitForTimeout(2500);
    const sold = await caseRow(page, c.caseId);
    ok("§E2a · the outcome is recorded (rate tracking closed, property marked sold)",
      sold.rate_end_date == null && !!sold.property_sold_at, JSON.stringify({ r: sold.rate_end_date, s: sold.property_sold_at }));
    await page.evaluate(() => window.closeModal());
    await page.waitForTimeout(1200);
    const stillThere = await pageRowIds(page);
    ok("§E2b · the worked row has LEFT the list, with no navigation at all", !stillThere.includes(c.caseId), JSON.stringify(stillThere.length));
    ok("§E2c · …and the page underneath is still the Retention page",
      await page.evaluate(() => !document.getElementById("page-retention").classList.contains("hidden")));
    ok("§E · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §F · ONE BATCH CONFIRM
     ====================================================================== */
  console.log("\n— §F · four cases, one overlay, no native dialogs");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    const mk = (label, extra) => mkClientCase(page, {
      first: "R70F", last: label + t, email: `f.${label}.${t}@example.com`.toLowerCase(), phone: "07700900707",
      case: Object.assign({ lender: "Barclays", rate_percent: 2.4, loan_amount: 160000, completed_at: daysFrom(-800),
        rate_end_date: daysFrom(-22), property_address: `${label} R70 Batch Rd, Testtown TE7 7AA` }, extra || {}),
    });
    const a1 = await mk("Onea", { property_address: "1 R70 Batch Rd, Testtown TE7 7AA" });
    const a2 = await mk("Twob", { property_address: "2 R70 Batch Rd, Testtown TE7 7AB" });
    const a3 = await mk("Threec", { property_address: "3 R70 Batch Rd, Testtown TE7 7AC" });
    const a4 = await mk("Fourd", { property_address: "4 R70 Batch Rd, Testtown TE7 7AD" });
    const dialogsBefore = page.__dialogs.length;
    await goRetention(page, 3000);
    await selectRows(page, [a1.caseId, a2.caseId, a3.caseId, a4.caseId]);
    await page.click("#ret-bulk-retention");
    await page.waitForTimeout(2500);
    const overlay = await page.evaluate(() => {
      const box = document.getElementById("overlay-modal");
      return box ? { up: true, text: box.textContent.replace(/\s+/g, " ").trim(), ok: !!document.getElementById("bulkret-ok"), lists: box.querySelectorAll(".bulk-confirm-ul").length } : { up: false };
    });
    ok("§F1a · ONE overlay opens for the whole batch", overlay.up && overlay.ok, JSON.stringify(overlay).slice(0, 200));
    eq("§F1b · …and not a single native dialog was opened", page.__dialogs.length - dialogsBefore, 0);
    ok("§F1c · the overlay names every case it is about to start", overlay.text.includes("Onea") && overlay.text.includes("Fourd"), overlay.text.slice(0, 300));
    ok("§F1d · …and says what it creates, in the words the single-case dialog used",
      /new Enquiry linked back|linked back to the completed case/i.test(overlay.text), overlay.text.slice(0, 300));
    ok("§F1e · L4 — and that the reminders will wait, because sending is on hold",
      /ON HOLD \(Settings › Email sending\)/.test(overlay.text), overlay.text.slice(-200));
    await page.click("#bulkret-ok");
    await page.waitForTimeout(6000);
    const made = await page.evaluate(async (ids) => {
      const { data } = await window.__mockDb.from("cases").select("id,retention_source_case_id");
      return ids.map((id) => (data || []).filter((c) => c.retention_source_case_id === id).length);
    }, [a1.caseId, a2.caseId, a3.caseId, a4.caseId]);
    ok("§F2a · all four retention cases are created from the one confirmation", made.join(",") === "1,1,1,1", JSON.stringify(made));
    eq("§F2b · …and still not one native dialog", page.__dialogs.length - dialogsBefore, 0);
    ok("§F2c · the R64 tally toast still reports the batch", /retention cases created/i.test(await toastText(page)), await toastText(page));
    ok("§F · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* --- the sold pre-flight, named in that one confirm --------------------- */
  console.log("\n— §F3 · the sold-property check moves into the batch confirm");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    const ADDR = `9 R70 Sold Rd, Testtown TE7 8AA`;
    const src = await mkClientCase(page, {
      first: "R70F3", last: "Seller" + t, email: `f3.seller.${t}@example.com`.toLowerCase(), phone: "07700900708",
      case: { lender: "Halifax", rate_percent: 2.4, loan_amount: 160000, completed_at: daysFrom(-800),
        rate_end_date: daysFrom(-20), property_address: ADDR, created_at: new Date(Date.now() - 900 * 86400000).toISOString() },
    });
    const clean = await mkClientCase(page, {
      first: "R70F3", last: "Clean" + t, email: `f3.clean.${t}@example.com`.toLowerCase(), phone: "07700900709",
      case: { lender: "Halifax", rate_percent: 2.4, loan_amount: 150000, completed_at: daysFrom(-800),
        rate_end_date: daysFrom(-21), property_address: `10 R70 Sold Rd, Testtown TE7 8AB` },
    });
    /* Another client, a NEWER case, same building, past fact-find — the propSoldWarning shape. */
    await mkClientCase(page, {
      first: "R70F3", last: "Buyer" + t, email: `f3.buyer.${t}@example.com`.toLowerCase(), phone: "07700900710",
      case: { case_kind: "purchase", stage: "offer", lender: "NatWest", loan_amount: 240000,
        property_address: ADDR, created_at: new Date().toISOString() },
    });
    await goRetention(page, 3000);
    await selectRows(page, [src.caseId, clean.caseId]);
    await page.click("#ret-bulk-retention");
    await page.waitForTimeout(2500);
    const txt = await page.evaluate(() => (document.getElementById("overlay-modal") || {}).textContent || "");
    ok("§F3a · the batch confirm names the case that looks sold, and says it will be skipped",
      /looks? sold and will be skipped/i.test(txt) && txt.includes("Seller"), txt.replace(/\s+/g, " ").slice(0, 400));
    ok("§F3b · …naming the other client's newer case, which is the evidence", /Buyer/.test(txt), txt.replace(/\s+/g, " ").slice(0, 400));
    ok("§F3c · …and the clean case is still in the 'Starting with' list", txt.includes("Clean"), txt.replace(/\s+/g, " ").slice(0, 400));
    await page.click("#bulkret-ok");
    await page.waitForTimeout(4000);
    const made = await page.evaluate(async (ids) => {
      const { data } = await window.__mockDb.from("cases").select("id,retention_source_case_id");
      return ids.map((id) => (data || []).filter((c) => c.retention_source_case_id === id).length);
    }, [src.caseId, clean.caseId]);
    eq("§F3d · the sold-looking case is NOT started", made[0], 0);
    eq("§F3e · …and the clean one is", made[1], 1);
    ok("§F3f · the tally names the sold skip, so it can be overturned by hand on the row",
      /possibly sold/i.test(await toastText(page)), await toastText(page));
    ok("§F3 · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §G · M5 — the GI referral partner setting
     ====================================================================== */
  console.log("\n— §G · gi_referral_partner (M5)");
  {
    const page = await boot(browser, "p4");   // owner: the only role that can save settings
    await goPage(page, "settings", 2200);
    const field = await page.evaluate(() => {
      const el = document.querySelector('#settings-form [name="gi_referral_partner"]');
      if (!el) return null;
      const lab = el.closest("label");
      return { value: el.value, type: el.type, label: lab ? lab.textContent.trim() : "", title: lab ? lab.getAttribute("title") : "" };
    });
    ok("§G1a · Settings has a GI referral partner box, beside the protection one", !!field, JSON.stringify(field));
    eq("§G1b · …empty by default (a pre-filled guess is worse than no pre-fill)", (field || {}).value, "");
    ok("§G1c · …explained in plain English where it sits",
      /pre-fills the “Referred to” box/i.test((field || {}).title || ""), (field || {}).title);
    const note = await page.evaluate(() => (document.getElementById("setting-note-gi_referral_partner") || {}).textContent || "");
    ok("§G1d · …with the standing note saying what it does and that blank is fine",
      /buildings & contents referral is addressed to by default/i.test(note) && /Leave it blank/i.test(note), note.slice(0, 200));
    ok("§G1e · the protection setting it was copied from is still there",
      await page.evaluate(() => !!document.querySelector('#settings-form [name="protection_referral_partner"]')));

    await page.fill('[name="gi_referral_partner"]', "Paymentshield");
    await page.click("#save-settings-btn");
    await page.waitForTimeout(1800);
    eq("§G2a · it saves to the settings table", await page.evaluate(async () => {
      const { data } = await window.__mockDb.from("settings").select("key,value").eq("key", "gi_referral_partner");
      return (data && data[0] && data[0].value) || null;
    }), "Paymentshield");
    await goPage(page, "settings", 2000);
    eq("§G2b · …and comes back on the next render",
      await page.evaluate(() => document.querySelector('[name="gi_referral_partner"]').value), "Paymentshield");

    const giCase = await page.evaluate(async () => {
      const { data } = await window.__mockDb.from("cases").select("id,stage,case_kind,gi_status");
      const c = (data || []).find((x) => ["offer", "exchange", "completed"].includes(x.stage)
        && ["purchase", "first_time_buyer", "buy_to_let", "remortgage"].includes(x.case_kind));
      return c ? c.id : null;
    });
    ok("§G3a · the fixture has a case that can take a GI referral", !!giCase, JSON.stringify(giCase));
    await page.evaluate((id) => window.openCase(id), giCase);
    await page.waitForTimeout(1600);
    const hasGi = await page.evaluate(() => !!document.querySelector("#act-ref-gi"));
    ok("§G3b · the case offers 🏠 Refer for buildings/contents", hasGi);
    if (hasGi) {
      await page.click("#act-ref-gi");
      await page.waitForTimeout(800);
      eq("§G4a · the GI referral overlay pre-fills 'Referred to' from the setting",
        await page.evaluate(() => (document.querySelector("#ref-to") || {}).value), "Paymentshield");
      const refNote = await page.evaluate(() => (document.querySelector(".ref-default-note") || {}).textContent || "");
      ok("§G4b · …and says WHICH setting it came from, now that there are two",
        /GI referral partner/i.test(refNote), refNote);
      await page.click("#ref-cancel");
      await page.waitForTimeout(400);
    }
    ok("§G · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §H · EVERY PERSONA OPENS THE PAGE CLEAN
     ====================================================================== */
  console.log("\n— §H · no console errors, every persona");
  for (const persona of ["p1", "p2", "p3", "p4"]) {
    const page = await boot(browser, persona);
    await goRetention(page, 2600);
    const seen = await page.evaluate(() => ({
      chips: document.querySelectorAll("#ret-month-chips .ret-month-chip").length,
      dir: !!document.getElementById("ret-sort-dir"),
      badges: document.querySelectorAll("#ret-rates-list .ret-rem-badge").length,
    }));
    eq(`§H · ${persona} sees the seven month chips`, seen.chips, 7);
    ok(`§H · ${persona} gets the date-direction control`, seen.dir);
    ok(`§H · ${persona} — no console errors on Retention`, realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  await browser.close();
  if (srv) { try { process.kill(-srv.pid); } catch (e) { /* ignore */ } }
  console.log("\n================================================================");
  console.log(`r70_retention: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  ✗ " + f));
  process.exit(failures.length ? 1 : 0);
})();
