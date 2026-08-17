#!/usr/bin/env node
/* =============================================================================
   tests/r11_ux.js — acceptance tests for ROUND 11 (dashboard / watchtower /
   reports jump nav / emails-sms status filters / client sort / lead discard
   reason).

     R11-A  DASHBOARD KPI STRIP moved above My Day — same tiles, new position.
            Owner sees 5 tiles (incl. the money "Fees outstanding" tile);
            adviser sees 4 (no money). DOM sibling order asserted directly:
            #today-heading -> #kpi-row -> #briefing-panel.
     R11-B  WATCHTOWER — severity chips (#wt-sev-all/crit/warn/info) with live
            counts of the whole working list (unresolved, unsnoozed); rows
            grouped one-per-rule, folded at >=4 items except the first group;
            aria-expanded on the group header; fold state survives a
            loadWatchtower() re-render (Run checks); the distinct
            #watchtower-filter-empty state; the "nothing has changed" toast
            copy quoting the panel's own numbers; .wt-scroll's height cap.
     R11-C  REPORTS JUMP NAV — #rep-nav sticky bar built after loadReports;
            owner gets the money chips and no "mine"; adviser gets mine/month/
            funnel/sources/live/months/introducers and no money chips;
            clicking scrolls with scroll-margin so the heading clears the bar;
            the active chip follows scroll position.
     R11-D  EMAILS/SMS STATUS CHIPS — #em-chip-… / #sms-chip-… with counts
            recomputed from the mock's email_queue/sms_queue (newest-100);
            #em-summary/#sms-summary text; the two filters are independent;
            dhGotoEmails() lands on Emails with the failed chip active.
     R11-E  CLIENTS SORT — #cl-sort (Name A-Z / Next rate end / Recently
            added); sort applies after segment filter, stable; a rate-year
            segment shows rate-end date + lender on every row, ascending by
            that date; bulk select still works under segment+sort.
     R11-F  LEAD DISCARD REASON — persisted to leads.discard_reason in the
            SAME update that discards; openLeadInToday surfaces it later.
     R11-REGRESSION — owner dashboard page height stays well clear of the
            pre-R11 ~3,249px layout, and nothing overflows horizontally at
            390px.

   Ground truth for every count/order below is recomputed here, independently,
   from the raw fixture tables via window.__mockDb — never read off the
   rendered DOM of a different panel, and never off what app.js itself
   decided (see HARNESS.md "Standing rules").

   Run:  node /root/nx/tests/r11_ux.js   (expects a static server on 8099;
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
  else { failures.push(name + (detail ? ` — ${JSON.stringify(detail)}` : "")); console.log(`  ✗ ${name}${detail ? " — " + JSON.stringify(detail) : ""}`); }
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

async function newPage(browser, persona, viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  page.__err = null;
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const gotoPage = async (page, p) => { await page.evaluate((x) => window.nav(x), p); await page.waitForTimeout(1200); };
const noErr = (page, label) => ok(`no console errors (${label})`, !page.__err, JSON.stringify(page.__err));

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {

    /* ===================================================================
       R11-A · DASHBOARD KPI STRIP
       =================================================================== */
    {
      console.log("\n— R11-A · KPI strip position + owner tiles (p4 Daniel, owner)");
      const page = await newPage(browser, "p4");

      const order = await page.evaluate(() => {
        const h = document.getElementById("today-heading");
        const kpi = document.getElementById("kpi-row");
        const brief = document.getElementById("briefing-panel");
        // R23 inserted a normally-hidden #dash-cap-notice between #kpi-row and #briefing-panel
        // (the "showing first 20,000 records" caveat, adjacent to the numbers it qualifies). The
        // R11 "numbers first" intent is unchanged — #kpi-row still immediately follows the heading
        // and the briefing still follows the numbers — so skip the optional hidden notice.
        let afterKpi = kpi && kpi.nextElementSibling;
        if (afterKpi && afterKpi.id === "dash-cap-notice") afterKpi = afterKpi.nextElementSibling;
        return {
          afterHeading: h && h.nextElementSibling && h.nextElementSibling.id,
          beforeBrief: afterKpi && afterKpi.id,
        };
      });
      eq("R11-A · #kpi-row sits immediately after #today-heading", order.afterHeading, "kpi-row");
      eq("R11-A · #kpi-row sits immediately before #briefing-panel (skipping R23's hidden cap-notice)", order.beforeBrief, "briefing-panel");

      const gt = await page.evaluate(async () => {
        const db = window.__mockDb;
        const [{ data: cases }, { data: alerts }, { data: settingsRows }] = await Promise.all([
          db.from("cases").select("id,stage,fee_status,broker_fee,completed_at"),
          db.from("v_alerts").select("*"),
          db.from("settings").select("*"),
        ]);
        const settings = Object.fromEntries((settingsRows || []).map((r) => [r.key, r.value]));
        const reminderMonths = Number(settings.rate_reminder_months) || 6;
        const active = (cases || []).filter((c) => !["completed", "not_proceeding"].includes(c.stage));
        const yr = new Date().getFullYear();
        const completed = (cases || []).filter((c) => c.completed_at && new Date(c.completed_at).getFullYear() === yr);
        const feesDue = (cases || []).filter((c) => ["not_requested", "requested"].includes(c.fee_status) && c.broker_fee > 0 && c.stage !== "not_proceeding");
        const feesDueTotal = feesDue.reduce((s, c) => s + Number(c.broker_fee || 0), 0);
        const ratesSoon = (alerts || []).filter((a) => a.days_to_rate_end != null && a.days_to_rate_end <= reminderMonths * 30);
        const ercFlags = (alerts || []).filter((a) => a.erc_outlasts_rate);
        const fmtM = (n) => Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
        return {
          active: active.length, completed: completed.length, yr, reminderMonths,
          ratesSoon: ratesSoon.length, ercFlags: ercFlags.length,
          feesDueN: feesDue.length, feesDueMoney: fmtM(feesDueTotal),
        };
      });

      const owner = await page.evaluate(() => [...document.querySelectorAll("#kpi-row .kpi")].map((k) => k.textContent.replace(/\s+/g, " ").trim()));
      eq("R11-A · owner sees 5 KPI tiles", owner.length, 5);
      ok("R11-A · tile 1 — Active cases, right number, right order", owner[0].includes("Active cases") && owner[0].startsWith(String(gt.active)), owner[0]);
      ok("R11-A · tile 2 — Completions this year", owner[1].includes(`Completions in ${gt.yr}`) && owner[1].startsWith(String(gt.completed)), owner[1]);
      ok("R11-A · tile 3 — Rates ending soon, using the real reminder window", owner[2].includes(`Rates ending ≤ ${gt.reminderMonths}mo`) && owner[2].startsWith(String(gt.ratesSoon)), owner[2]);
      ok("R11-A · tile 4 — ERC outlasts rate", owner[3].includes("ERC outlasts rate") && owner[3].startsWith(String(gt.ercFlags)), owner[3]);
      ok("R11-A · tile 5 (owner only) — Fees outstanding, money figure matches", owner[4].includes(gt.feesDueMoney) && owner[4].includes(`Fees outstanding (${gt.feesDueN})`), owner[4]);
      noErr(page, "owner KPI");

      /* R11-REGRESSION — the dashboard was ~3,249px before R11 moved the strip up; a generous
         ceiling that still catches a regression back to the old shape (~2,000px now). */
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      ok("R11-REGRESSION · owner dashboard height stays well under the pre-R11 ~3249px", height < 2600, height);

      const overflow1440 = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      ok("R11-REGRESSION · no horizontal overflow on the owner dashboard at 1440", overflow1440);

      await page.close();
    }

    {
      console.log("\n— R11-A · adviser gets no money tile (p2 Wayne, adviser)");
      const page = await newPage(browser, "p2");
      const adv = await page.evaluate(() => [...document.querySelectorAll("#kpi-row .kpi")].map((k) => k.textContent.replace(/\s+/g, " ").trim()));
      eq("R11-A · adviser sees 4 KPI tiles", adv.length, 4);
      ok("R11-A · adviser's 4 tiles are the non-money four, in the same order", adv[0].includes("Active cases") && adv[1].includes("Completions in") && adv[2].includes("Rates ending") && adv[3].includes("ERC outlasts rate"), adv);
      ok("R11-A · no tile mentions money at all for an adviser", !adv.some((t) => /Fees outstanding|£/.test(t)), adv);
      const advOrder = await page.evaluate(() => {
        const h = document.getElementById("today-heading");
        const brief = document.getElementById("briefing-panel");
        // Skip R23's hidden #dash-cap-notice between the numbers and the briefing (see the owner block above).
        let prev = brief.previousElementSibling;
        if (prev && prev.id === "dash-cap-notice") prev = prev.previousElementSibling;
        return { afterHeading: h.nextElementSibling.id, kpiBeforeBrief: prev.id };
      });
      eq("R11-A · same top-of-page order for an adviser", advOrder, { afterHeading: "kpi-row", kpiBeforeBrief: "kpi-row" });
      noErr(page, "adviser KPI");

      /* R11-REGRESSION — no horizontal overflow at 390px, on the persona most likely to be on a
         phone reading Watchtower. */
      const mob = await newPage(browser, "p2", { width: 390, height: 844 });
      const m = await mob.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      ok("R11-REGRESSION · no horizontal overflow on the dashboard at 390 (adviser)", m.doc <= m.win, m);
      noErr(mob, "390 dashboard");
      await mob.close();
      await page.close();
    }

    /* ===================================================================
       R11-B · WATCHTOWER — chips, groups, fold state, toast, scroll cap
       =================================================================== */
    {
      console.log("\n— R11-B · Watchtower severity chips + counts (p1 Kim, admin)");
      const page = await newPage(browser, "p1");
      await gotoPage(page, "dashboard");
      await page.evaluate(() => {
        const panel = document.getElementById("watchtower-panel");
        if (panel && panel.classList.contains("collapsed")) document.querySelector('#watchtower-panel h3').click();
      });
      await page.waitForTimeout(500);

      const gtWt = async () => page.evaluate(async () => {
        const { data } = await window.__mockDb.from("watch_alerts").select("*").is("resolved_at", null).order("created_at", { ascending: false });
        const nowIso = new Date().toISOString();
        const isSnoozed = (a) => !!a.snoozed_until && a.snoozed_until > nowIso;
        const SEV = { crit: 0, warn: 1, info: 2 };
        const sevKey = (a) => (a.severity === "crit" || a.severity === "warn") ? a.severity : "info";
        const all = (data || []).slice().sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3));
        const alerts = all.filter((a) => !isSnoozed(a));
        const snoozed = all.filter(isSnoozed);
        const sevCounts = { all: alerts.length, crit: 0, warn: 0, info: 0 };
        alerts.forEach((a) => { sevCounts[sevKey(a)]++; });
        const groups = [];
        const byRule = new Map();
        alerts.forEach((a) => {
          const rule = a.rule || "other";
          let g = byRule.get(rule);
          if (!g) { g = { rule, sev: sevKey(a), items: [] }; byRule.set(rule, g); groups.push(g); }
          g.items.push(a);
        });
        return { sevCounts, groups: groups.map((g) => ({ rule: g.rule, sev: g.sev, n: g.items.length })), snoozedN: snoozed.length };
      });
      const gt0 = await gtWt();

      const chips = await page.evaluate(() => [...document.querySelectorAll("#wt-filters .wt-sev-chip")].map((b) => ({
        id: b.id, sev: b.dataset.sev, active: b.classList.contains("active"), pressed: b.getAttribute("aria-pressed"), n: Number((b.querySelector(".seg-count") || {}).textContent || "-1"),
      })));
      eq("R11-B · four severity chips, correct ids, in order", chips.map((c) => c.id), ["wt-sev-all", "wt-sev-crit", "wt-sev-warn", "wt-sev-info"]);
      ok("R11-B · All is active by default", chips[0].active && chips[0].pressed === "true", chips[0]);
      chips.forEach((c) => eq(`R11-B · chip count matches ground truth · ${c.sev}`, c.n, gt0.sevCounts[c.sev]));

      /* R11-B · groups — one per rule, in first-appearance order, fold state correct */
      const domGroups = await page.evaluate(() => [...document.querySelectorAll("#watchtower-list .wt-group")].map((g, i) => ({
        key: g.dataset.wtKey, n: Number((g.querySelector(".wt-group-n") || {}).textContent || "-1"),
        folded: g.classList.contains("wt-folded"), expanded: g.querySelector(".wt-group-head").getAttribute("aria-expanded"),
      })));
      eq("R11-B · one DOM group per rule, same order as the ground truth", domGroups.map((g) => g.key.split("|")[0]), gt0.groups.map((g) => g.rule));
      domGroups.forEach((g, i) => {
        const wantN = gt0.groups[i].n;
        eq(`R11-B · group ${i} (${gt0.groups[i].rule}) row count`, g.n, wantN);
        if (i === 0) {
          ok(`R11-B · the FIRST group is always open, regardless of size`, !g.folded && g.expanded === "true", g);
        } else if (wantN >= 4) {
          ok(`R11-B · group ${i} (${gt0.groups[i].rule}, ${wantN} rows) folds by default (>=4)`, g.folded && g.expanded === "false", g);
        } else {
          ok(`R11-B · group ${i} (${gt0.groups[i].rule}, ${wantN} rows) stays open by default (<4)`, !g.folded && g.expanded === "true", g);
        }
      });
      /* the most severe group present leads the list */
      if (gt0.groups.length) {
        ok("R11-B · the list leads with its most severe group", gt0.groups[0].sev === (gt0.sevCounts.crit ? "crit" : gt0.sevCounts.warn ? "warn" : "info"), gt0.groups[0]);
      }

      /* R11-B · .wt-scroll caps the panel height so it cannot push the rest of Today off screen */
      const scrollCap = await page.evaluate(() => {
        const el = document.getElementById("watchtower-list");
        const cs = getComputedStyle(el);
        return { maxHeight: cs.maxHeight, vh: window.innerHeight };
      });
      const capPx = parseFloat(scrollCap.maxHeight);
      ok("R11-B · the alert list is height-capped near 60vh, not unbounded", capPx > 0 && Math.abs(capPx - scrollCap.vh * 0.6) < 2, scrollCap);

      /* R11-B · clicking a severity chip filters client-side: DOM row count for that severity
         matches ground truth, no fetch involved (the chip counts do not change). */
      await page.click("#wt-sev-crit");
      await page.waitForTimeout(400);
      const critRows = await page.evaluate(() => document.querySelectorAll("#watchtower-list .wt-row").length);
      eq("R11-B · Critical chip narrows the rows to exactly the critical ones", critRows, gt0.sevCounts.crit);
      const critActive = await page.evaluate(() => [...document.querySelectorAll("#wt-filters .wt-sev-chip.active")].map((b) => b.id));
      eq("R11-B · Critical chip becomes the only active one", critActive, ["wt-sev-crit"]);
      const chipsUnchanged = await page.evaluate(() => [...document.querySelectorAll("#wt-filters .wt-sev-chip")].map((b) => Number((b.querySelector(".seg-count") || {}).textContent)));
      eq("R11-B · the chip counts themselves do not change when filtering (whole-list counts)", chipsUnchanged, [gt0.sevCounts.all, gt0.sevCounts.crit, gt0.sevCounts.warn, gt0.sevCounts.info]);
      await page.click("#wt-sev-all");
      await page.waitForTimeout(400);
      noErr(page, "watchtower chips/groups");
      await page.close();
    }

    {
      console.log("\n— R11-B · fold-toggle survives a re-render, run-checks toast, filter-empty state (p1 Kim, admin)");
      const page = await newPage(browser, "p1");
      await gotoPage(page, "dashboard");
      await page.evaluate(() => {
        const panel = document.getElementById("watchtower-panel");
        if (panel && panel.classList.contains("collapsed")) document.querySelector('#watchtower-panel h3').click();
      });
      await page.waitForTimeout(500);

      /* find a folded group (there should be at least one non-first group with >=4 rows in this
         book — if not, this sub-check simply has nothing to toggle and is skipped honestly) */
      const foldedKey = await page.evaluate(() => {
        const g = [...document.querySelectorAll("#watchtower-list .wt-group.wt-folded")][0];
        return g ? g.dataset.wtKey : null;
      });
      if (foldedKey) {
        await page.evaluate((k) => document.querySelector(`.wt-group[data-wt-key="${k}"] .wt-group-head`).click(), foldedKey);
        await page.waitForTimeout(300);
        const openedNow = await page.evaluate((k) => {
          const g = document.querySelector(`.wt-group[data-wt-key="${k}"]`);
          return { folded: g.classList.contains("wt-folded"), expanded: g.querySelector(".wt-group-head").getAttribute("aria-expanded") };
        }, foldedKey);
        ok("R11-B · clicking a folded group's header opens it", !openedNow.folded && openedNow.expanded === "true", openedNow);

        /* Run checks re-renders the whole panel (loadWatchtower) — the manual open must survive it */
        await page.click("#watchtower-run");
        await page.waitForTimeout(1500);
        const afterRerender = await page.evaluate((k) => {
          const g = document.querySelector(`.wt-group[data-wt-key="${k}"]`);
          return g ? { folded: g.classList.contains("wt-folded"), expanded: g.querySelector(".wt-group-head").getAttribute("aria-expanded") } : null;
        }, foldedKey);
        ok("R11-B · the manually-opened group is STILL open after Run checks re-renders", afterRerender && !afterRerender.folded && afterRerender.expanded === "true", afterRerender);
      } else {
        console.log("    (no folded group in this book — fold-toggle-survives-rerender skipped honestly)");
      }

      /* R11-B · the run-checks toast, second press in the same session: nothing new/resolved,
         because loadDashboard() already ran the checker once on this page load. */
      const gtBefore = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("watch_alerts").select("*").is("resolved_at", null);
        const nowIso = new Date().toISOString();
        const isSnoozed = (a) => !!a.snoozed_until && a.snoozed_until > nowIso;
        const alerts = (data || []).filter((a) => !isSnoozed(a));
        const snoozed = (data || []).filter(isSnoozed);
        return { alerts: alerts.length, snoozed: snoozed.length };
      });
      await page.click("#watchtower-run");
      await page.waitForTimeout(1500);
      const toastTxt = await page.$eval("#toast", (e) => e.textContent).catch(() => "");
      ok("R11-B · a same-session re-run reports ‘nothing has changed’, not ‘0 new’", /^Checks re-run — nothing has changed since the last run\./.test(toastTxt), toastTxt);
      ok("R11-B · the toast quotes the PANEL's own open-alert count", toastTxt.includes(`${gtBefore.alerts} open alert`), { toastTxt, want: gtBefore.alerts });
      if (gtBefore.snoozed) ok("R11-B · the toast mentions the snoozed count too", toastTxt.includes(`plus ${gtBefore.snoozed} snoozed`), toastTxt);

      /* R11-B · the distinct filter-empty state: force a severity bucket to zero by snoozing
         every currently-unsnoozed alert of that severity via the DB directly (ground truth setup,
         not a UI action), then verify the panel says so and offers "Show all". */
      const emptied = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("watch_alerts").select("*").is("resolved_at", null).eq("severity", "info");
        const nowIso = new Date().toISOString();
        const toSnooze = (data || []).filter((a) => !a.snoozed_until || a.snoozed_until <= nowIso);
        const future = new Date(Date.now() + 30 * 86400000).toISOString();
        for (const a of toSnooze) {
          await window.__mockDb.from("watch_alerts").update({ snoozed_until: future }).eq("id", a.id);
        }
        return toSnooze.length;
      });
      await gotoPage(page, "dashboard"); // re-navigate -> loadDashboard -> loadWatchtower re-fetches
      await page.evaluate(() => {
        const panel = document.getElementById("watchtower-panel");
        if (panel && panel.classList.contains("collapsed")) document.querySelector('#watchtower-panel h3').click();
      });
      await page.waitForTimeout(500);
      const infoCountAfter = await page.evaluate(() => Number((document.querySelector("#wt-sev-info .seg-count") || {}).textContent || "-1"));
      eq("R11-B · (setup) the FYI chip now reads 0 after snoozing every FYI alert", infoCountAfter, 0);
      if (emptied > 0) {
        await page.click("#wt-sev-info");
        await page.waitForTimeout(400);
        const emptyState = await page.evaluate(() => {
          const el = document.getElementById("watchtower-filter-empty");
          return el ? el.textContent.trim() : null;
        });
        ok("R11-B · the distinct filter-empty state appears (not the ‘no problems’ one)", !!emptyState, emptyState);
        ok("R11-B · it says how many OTHER alerts are hidden by the filter, and offers Show all", !!emptyState && /other open alert/.test(emptyState) && /Show all/.test(emptyState), emptyState);
        await page.click('#watchtower-filter-empty button');
        await page.waitForTimeout(400);
        const backToAll = await page.evaluate(() => [...document.querySelectorAll("#wt-filters .wt-sev-chip.active")].map((b) => b.id));
        eq("R11-B · ‘Show all’ resets the filter back to All", backToAll, ["wt-sev-all"]);
      } else {
        console.log("    (every FYI alert was already snoozed — filter-empty setup skipped honestly)");
      }
      noErr(page, "watchtower toast/toggle/empty-state");
      await page.close();
    }

    /* ===================================================================
       R11-C · REPORTS JUMP NAV
       =================================================================== */
    {
      console.log("\n— R11-C · Reports jump nav (p4 Daniel, owner)");
      const page = await newPage(browser, "p4");
      await gotoPage(page, "reports");
      const ownerNav = await page.evaluate(() => {
        const bar = document.querySelector("#rep-nav");
        return {
          hidden: !bar || bar.hidden,
          sticky: bar ? getComputedStyle(bar).position : null,
          chips: [...document.querySelectorAll("#rep-nav-chips [data-rep-jump]")].map((b) => ({ id: b.id, key: b.dataset.repJump })),
        };
      });
      ok("R11-C · owner: the jump bar is visible", !ownerNav.hidden, ownerNav);
      ok("R11-C · owner: it is position:sticky", ownerNav.sticky === "sticky", ownerNav.sticky);
      ok("R11-C · owner: every chip id is rep-nav-*", ownerNav.chips.every((c) => c.id === `rep-nav-${c.key}`), ownerNav.chips);
      const ownerKeys = ownerNav.chips.map((c) => c.key);
      const MONEY_KEYS = ["owed", "rateend", "leadresp", "advocacy", "conveyancer", "forecast", "ltv", "advisers", "losses"];
      ok("R11-C · owner: sees every money chip", MONEY_KEYS.every((k) => ownerKeys.includes(k)), ownerKeys);
      ok("R11-C · owner: does NOT see the adviser-only ‘mine’ chip", !ownerKeys.includes("mine"), ownerKeys);

      /* clicking a deep chip scrolls, and scroll-margin keeps the heading clear of the sticky bar */
      const jump = await page.evaluate(async () => {
        document.getElementById("rep-nav-ltv").click();
        await new Promise((r) => setTimeout(r, 1400));
        const bar = document.querySelector("#rep-nav").getBoundingClientRect();
        const h = document.querySelector("#report-ltv-panel h3").getBoundingClientRect();
        return { barBottom: bar.bottom, headTop: h.top, y: window.scrollY,
                 active: [...document.querySelectorAll("#rep-nav-chips .seg-btn.active")].map((b) => b.id) };
      });
      ok("R11-C · clicking a chip actually scrolls the page", jump.y > 500, jump.y);
      ok("R11-C · the heading lands clear of the sticky bar (scroll-margin-top works)", jump.headTop >= jump.barBottom, jump);
      eq("R11-C · the clicked chip becomes the sole active one", jump.active, ["rep-nav-ltv"]);

      const topActive = await page.evaluate(async () => {
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 400));
        return [...document.querySelectorAll("#rep-nav-chips .seg-btn.active")].map((b) => b.id);
      });
      eq("R11-C · scrolling back to the top re-highlights the first chip", topActive, ["rep-nav-month"]);

      const midActive = await page.evaluate(async () => {
        const el = document.querySelector("#report-advocacy-panel");
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 40);
        await new Promise((r) => setTimeout(r, 400));
        return [...document.querySelectorAll("#rep-nav-chips .seg-btn.active")].map((b) => b.id);
      });
      eq("R11-C · scrolling to a section highlights that section's own chip", midActive, ["rep-nav-advocacy"]);
      noErr(page, "owner reports nav");
      await page.close();
    }

    {
      console.log("\n— R11-C · Reports jump nav money gate (p2 Wayne, adviser)");
      const page = await newPage(browser, "p2");
      await gotoPage(page, "reports");
      const advNav = await page.evaluate(() => {
        const MONEY_PANELS = ["#report-owed-panel", "#report-rateend-panel", "#report-leadresp-panel", "#report-advocacy-panel", "#report-conveyancer-panel", "#report-forecast-panel", "#report-ltv-panel", "#report-scoreboard-panel", "#report-losses-panel"];
        return {
          chips: [...document.querySelectorAll("#rep-nav-chips [data-rep-jump]")].map((b) => b.dataset.repJump),
          leaked: MONEY_PANELS.filter((s) => { const el = document.querySelector(s); return el && !el.classList.contains("hidden"); }),
          barHidden: (document.querySelector("#rep-nav") || {}).hidden,
        };
      });
      ok("R11-C · adviser: the bar is built", !advNav.barHidden);
      const MONEY_KEYS = ["owed", "rateend", "leadresp", "advocacy", "conveyancer", "forecast", "ltv", "advisers", "losses"];
      eq("R11-C · adviser: exactly mine/month/funnel/sources/live/months/introducers, no money", advNav.chips, ["mine", "month", "funnel", "sources", "live", "months", "introducers"]);
      ok("R11-C · adviser: no money panel is visible in the DOM either", advNav.leaked.length === 0, advNav.leaked);
      ok("R11-C · adviser: no money chip present", !advNav.chips.some((k) => MONEY_KEYS.includes(k)), advNav.chips);
      const wired = await page.evaluate(() => {
        const SEL = { mine: "#report-mine-panel", month: "#report-month-panel", funnel: "#report-funnel-panel", sources: "#report-sources-panel", live: "#report-live-note", months: "#report-months-panel", introducers: "#report-introducers-panel" };
        return [...document.querySelectorAll("#rep-nav-chips [data-rep-jump]")].every((b) => {
          const el = document.querySelector(SEL[b.dataset.repJump]);
          return el && el.offsetParent !== null;
        });
      });
      ok("R11-C · every adviser chip maps to a genuinely visible panel", wired);
      noErr(page, "adviser reports nav");
      await page.close();
    }

    /* ===================================================================
       R11-D · EMAILS / SMS STATUS CHIPS
       =================================================================== */
    {
      console.log("\n— R11-D · Email/SMS status chips + summaries (p1 Kim, admin)");
      const page = await newPage(browser, "p1");
      await gotoPage(page, "emails");

      const truth = await page.evaluate(async () => {
        const db = window.__mockDb;
        const [{ data: emails }, { data: sms }] = await Promise.all([
          db.from("email_queue").select("*").order("created_at", { ascending: false }).limit(100),
          db.from("sms_queue").select("*").order("created_at", { ascending: false }).limit(100),
        ]);
        const bucket = (rows, statuses) => {
          const c = { all: rows.length };
          statuses.forEach((s) => { c[s] = rows.filter((r) => r.status === s).length; });
          return c;
        };
        return {
          email: bucket(emails || [], ["queued", "sent", "failed", "cancelled"]),
          sms: bucket(sms || [], ["queued", "sending", "sent", "failed", "cancelled"]),
          nQueued: (emails || []).filter((e) => e.status === "queued").length,
          nSmsWaiting: (sms || []).filter((s) => s.status === "queued" || s.status === "sending").length,
        };
      });

      ok("R11-D · the old Failed-only checkbox is gone", await page.evaluate(() => !document.querySelector("#email-failed-only")));
      const emChips = await page.evaluate(() => [...document.querySelectorAll("#em-filters [data-em-status]")].map((b) => ({ id: b.id, k: b.dataset.emStatus, n: Number((b.querySelector(".seg-count") || {}).textContent || "-1"), active: b.classList.contains("active") })));
      eq("R11-D · five email chips: All/Queued/Sent/Failed/Cancelled", emChips.map((c) => c.k), ["all", "queued", "sent", "failed", "cancelled"]);
      ok("R11-D · email chip ids are em-chip-*", emChips.every((c) => c.id === `em-chip-${c.k}`), emChips);
      ok("R11-D · All is active by default", emChips[0].active);
      emChips.forEach((c) => eq(`R11-D · email chip count matches ground truth · ${c.k}`, c.n, truth.email[c.k]));

      const smsChips = await page.evaluate(() => [...document.querySelectorAll("#sms-filters [data-em-status]")].map((b) => ({ id: b.id, k: b.dataset.emStatus, n: Number((b.querySelector(".seg-count") || {}).textContent || "-1") })));
      eq("R11-D · six SMS chips: All/Queued/Sending/Sent/Failed/Cancelled", smsChips.map((c) => c.k), ["all", "queued", "sending", "sent", "failed", "cancelled"]);
      ok("R11-D · sms chip ids are sms-chip-*", smsChips.every((c) => c.id === `sms-chip-${c.k}`), smsChips);
      smsChips.forEach((c) => eq(`R11-D · sms chip count matches ground truth · ${c.k}`, c.n, truth.sms[c.k]));

      const emSummary = await page.$eval("#em-summary", (e) => e.textContent).catch(() => "");
      ok("R11-D · the email summary states the queued count and mentions 8am", emSummary.includes(String(truth.nQueued)) && /8am/.test(emSummary), emSummary);
      const smsSummary = await page.$eval("#sms-summary", (e) => e.textContent).catch(() => "");
      ok("R11-D · the SMS summary states how many are waiting, with no 8am claim", smsSummary.includes(String(truth.nSmsWaiting)), smsSummary);

      /* R11-D · the two filters are independent: narrowing the email list must not touch SMS */
      const beforeSmsRows = await page.evaluate(() => document.querySelectorAll("#sms-list .row-item[data-id], #sms-list .row-item").length);
      await page.click("#em-chip-failed");
      await page.waitForTimeout(1000);
      const afterFailed = await page.evaluate(() => ({
        active: [...document.querySelectorAll("#em-filters .seg-btn.active")].map((b) => b.id),
        emailBadges: [...document.querySelectorAll("#email-list .row-item")].map((r) => { const b = r.querySelector(".badge:not(.lead-email-chip)"); return b ? b.textContent.trim() : null; }).filter(Boolean),
        smsRows: document.querySelectorAll("#sms-list .row-item").length,
      }));
      eq("R11-D · Failed chip becomes active", afterFailed.active, ["em-chip-failed"]);
      ok("R11-D · only failed email rows remain", afterFailed.emailBadges.length === truth.email.failed && afterFailed.emailBadges.every((b) => b === "failed"), afterFailed);
      eq("R11-D · the SMS list is untouched by the email filter", afterFailed.smsRows, beforeSmsRows);

      await page.click("#sms-chip-failed");
      await page.waitForTimeout(1000);
      const afterSmsFailed = await page.evaluate(() => ({
        smsBadges: [...document.querySelectorAll("#sms-list .row-item .badge")].map((b) => b.textContent.trim()),
        emailBadges: [...document.querySelectorAll("#email-list .row-item")].map((r) => { const b = r.querySelector(".badge:not(.lead-email-chip)"); return b ? b.textContent.trim() : null; }).filter(Boolean),
      }));
      ok("R11-D · SMS Failed chip narrows only the SMS list", afterSmsFailed.smsBadges.length === truth.sms.failed && afterSmsFailed.smsBadges.every((b) => b === "failed"), afterSmsFailed.smsBadges);
      ok("R11-D · …and the email filter (still Failed) is undisturbed by it", afterSmsFailed.emailBadges.every((b) => b === "failed"), afterSmsFailed.emailBadges);

      /* reset before the dhGotoEmails check so a stale "failed" selection can't fake a pass */
      await page.click("#em-chip-all");
      await page.click("#sms-chip-all");
      await page.waitForTimeout(600);

      /* R11-D · dhGotoEmails() lands with the failed chip active */
      await gotoPage(page, "data");
      const dh = await page.evaluate(async () => {
        window.dhGotoEmails(true);
        await new Promise((r) => setTimeout(r, 1200));
        return {
          onEmails: [...document.querySelectorAll(".page:not(.hidden)")].map((p) => p.id).includes("page-emails"),
          active: [...document.querySelectorAll("#em-filters .seg-btn.active")].map((b) => b.id),
        };
      });
      ok("R11-D · dhGotoEmails(true) navigates to Emails", dh.onEmails, dh);
      eq("R11-D · …with the Failed chip pre-selected", dh.active, ["em-chip-failed"]);

      noErr(page, "emails/sms chips");
      await page.close();
    }

    /* ===================================================================
       R11-E · CLIENTS SORT
       =================================================================== */
    {
      console.log("\n— R11-E · Client list sort (p1 Kim, admin)");
      const page = await newPage(browser, "p1");
      await gotoPage(page, "clients");

      const sortOpts = await page.evaluate(() => [...document.querySelectorAll("#cl-sort option")].map((o) => o.value));
      eq("R11-E · three sort options in order", sortOpts, ["name", "rate_end", "recent"]);

      /* ground truth for the two computed orders, built independently from the raw tables */
      const gtClients = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: clients } = await db.from("clients").select("id,last_name,first_name,created_at").order("last_name");
        const { data: cases } = await db.from("cases").select("id,client_id,rate_end_date,lender");
        const casesOf = {};
        (cases || []).forEach((c) => { (casesOf[c.client_id] = casesOf[c.client_id] || []).push(c); });
        const todayStr = new Date().toISOString().slice(0, 10);
        const nextRateEnd = (id) => {
          let best = null;
          (casesOf[id] || []).forEach((c) => {
            const d = c.rate_end_date ? String(c.rate_end_date).slice(0, 10) : null;
            if (!d || d < todayStr) return;
            if (!best || d < best) best = d;
          });
          return best;
        };
        return { clients: clients || [], keys: (clients || []).map((c) => ({ id: c.id, key: nextRateEnd(c.id) })) };
      });
      /* default: name order, unchanged */
      const domNameOrder = await page.evaluate(() => [...document.querySelectorAll("#client-list .client-row")].map((r) => r.dataset.client));
      eq("R11-E · default sort is unchanged alphabetical order", domNameOrder, gtClients.clients.map((c) => c.id));

      /* rate_end: partition-then-concat replicates the app's stable comparator exactly */
      const withKey = gtClients.keys.filter((k) => k.key);
      const withoutKey = gtClients.keys.filter((k) => !k.key);
      withKey.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const expectedRateOrder = withKey.concat(withoutKey).map((k) => k.id);

      await page.selectOption("#cl-sort", "rate_end");
      await page.waitForTimeout(1000);
      const domRateOrder = await page.evaluate(() => [...document.querySelectorAll("#client-list .client-row")].map((r) => r.dataset.client));
      eq("R11-E · ‘Next rate end’ sorts ascending, no-rate-end clients stable at the bottom", domRateOrder, expectedRateOrder);
      const rateBits = await page.evaluate(() => [...document.querySelectorAll("#client-list .client-rateend")].map((e) => e.textContent.trim()));
      ok("R11-E · every row in this sort carries the rate-end fact", rateBits.length === domRateOrder.length, { got: rateBits.length, want: domRateOrder.length });

      /* recent: created_at desc */
      const expectedRecentOrder = gtClients.clients.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).map((c) => c.id);
      await page.selectOption("#cl-sort", "recent");
      await page.waitForTimeout(1000);
      const domRecentOrder = await page.evaluate(() => [...document.querySelectorAll("#client-list .client-row")].map((r) => r.dataset.client));
      eq("R11-E · ‘Recently added’ really is created_at desc", domRecentOrder, expectedRecentOrder);

      /* back to name for the segment tests */
      await page.selectOption("#cl-sort", "name");
      await page.waitForTimeout(700);

      /* segment first, sort second: pick the current-year rate-end segment and sort by rate end.
         Ground truth: members of that segment, ordered ascending by THEIR in-year rate date. */
      const yr = new Date().getFullYear();
      const gtSeg = await page.evaluate(async (year) => {
        const db = window.__mockDb;
        const { data: clients } = await db.from("clients").select("id,last_name").order("last_name");
        const { data: cases } = await db.from("cases").select("id,client_id,rate_end_date,lender");
        const casesOf = {};
        (cases || []).forEach((c) => { (casesOf[c.client_id] = casesOf[c.client_id] || []).push(c); });
        const inYearKey = (id) => {
          let best = null;
          (casesOf[id] || []).forEach((c) => {
            const d = c.rate_end_date ? String(c.rate_end_date).slice(0, 10) : null;
            if (!d || d.slice(0, 4) !== String(year)) return;
            if (!best || d < best) best = d;
          });
          return best;
        };
        const members = (clients || []).map((c) => ({ id: c.id, key: inYearKey(c.id) })).filter((c) => c.key);
        members.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return members.map((m) => m.id);
      }, yr);

      await page.evaluate((year) => {
        const chip = [...document.querySelectorAll("#client-segment .seg-btn")].find((b) => b.textContent.trim().startsWith(`Rate ends ${year}`));
        if (chip) chip.click();
      }, yr);
      await page.waitForTimeout(600);
      await page.selectOption("#cl-sort", "rate_end");
      await page.waitForTimeout(1000);
      const segSortedIds = await page.evaluate(() => [...document.querySelectorAll("#client-list .client-row")].map((r) => r.dataset.client));
      eq(`R11-E · segment ‘Rate ends ${yr}’ + sort ‘Next rate end’ composes correctly and is ascending`, segSortedIds, gtSeg);
      const segRateBits = await page.evaluate(() => document.querySelectorAll("#client-list .client-rateend").length);
      eq("R11-E · every row in a rate-end segment carries the rate-end date + lender", segRateBits, segSortedIds.length);

      /* bulk select still works under segment + sort */
      await page.click("#client-bulk-all");
      await page.waitForTimeout(500);
      const bulk = await page.evaluate(() => ({
        n: Number((document.querySelector("#client-bulk-n") || {}).textContent || "-1"),
        rows: document.querySelectorAll("#client-list .client-row.is-sel").length,
        barVisible: !document.querySelector("#client-bulk-bar").hasAttribute("hidden"),
      }));
      ok("R11-E · Select-all still selects every shown row under segment+sort", bulk.n === segSortedIds.length && bulk.rows === segSortedIds.length && bulk.barVisible, bulk);
      await page.evaluate(() => { const a = document.getElementById("client-bulk-all"); if (a && a.checked) a.click(); });

      /* back to All + Name A-Z, then check the cold segment still names last-contact and carries
         no rate-end noise (rate-end detail is a property of the segment/sort, not of ‘cold’) */
      await page.selectOption("#cl-sort", "name");
      await page.waitForTimeout(500);
      await page.evaluate(() => { const chip = [...document.querySelectorAll("#client-segment .seg-btn")].find((b) => b.dataset.seg === "all"); if (chip) chip.click(); });
      await page.waitForTimeout(500);
      await page.evaluate(() => { const chip = [...document.querySelectorAll("#client-segment .seg-btn")].find((b) => /Not contacted/.test(b.textContent)); if (chip) chip.click(); });
      await page.waitForTimeout(700);
      const cold = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#client-list .client-row")];
        return { n: rows.length, lc: rows.filter((r) => r.querySelector(".client-lastcontact")).length, rate: rows.filter((r) => r.querySelector(".client-rateend")).length };
      });
      ok("R11-E · the cold segment still shows last-contact on every row, with no rate-end noise", cold.n > 0 && cold.lc === cold.n && cold.rate === 0, cold);

      noErr(page, "clients sort");
      await page.close();
    }

    /* ===================================================================
       R11-F · LEAD DISCARD REASON
       =================================================================== */
    {
      console.log("\n— R11-F · discard reason persistence (p1 Kim, admin)");
      const page = await newPage(browser, "p1");
      await gotoPage(page, "dashboard");

      const first = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("leads").select("*").eq("status", "new").order("created_at");
        return (data || [])[0] || null;
      });
      ok("R11-F · (setup) there is a ‘new’ lead to discard", !!first, first);
      if (first) {
        const disc = await page.evaluate(async (leadId) => {
          const p = window.discardLead(leadId);
          await new Promise((r) => setTimeout(r, 700));
          const modalCopy = [...document.querySelectorAll(".panel-sub")].map((e) => e.textContent).filter((t) => /saved on the enquiry/i.test(t));
          document.getElementById("lead-discard-reason").value = "spoke_not_proceeding";
          document.getElementById("lead-discard-note").value = "Rang twice, staying with their current lender.";
          document.getElementById("lead-discard-ok").click();
          await p;
          await new Promise((r) => setTimeout(r, 900));
          const { data: after } = await window.__mockDb.from("leads").select("*").eq("id", leadId).single();
          return { modalCopy, discard_reason: after.discard_reason, status: after.status };
        }, first.id);
        ok("R11-F · the dialog states the reason is saved on the enquiry", disc.modalCopy.length > 0, disc.modalCopy);
        eq("R11-F · the lead is marked discarded", disc.status, "discarded");
        eq("R11-F · discard_reason is ‘code — note’, written in the same update", disc.discard_reason, "spoke_not_proceeding — Rang twice, staying with their current lender.");

        const shown = await page.evaluate(async (leadId) => {
          const seen = [];
          const orig = window.toast;
          window.toast = (m) => seen.push(m);
          await window.openLeadInToday(leadId);
          await new Promise((r) => setTimeout(r, 500));
          window.toast = orig;
          return seen;
        }, first.id);
        ok("R11-F · openLeadInToday surfaces the stored reason + note for a discarded lead", shown.some((m) => /was discarded — Spoke to them/.test(m) && m.includes("Rang twice")), shown);
      }

      /* a bare reason with no note stores just the code, and a no-contact reason still does not
         manufacture a contact timestamp */
      const second = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("leads").select("*").eq("status", "new").order("created_at");
        return (data || [])[0] || null;
      });
      if (second) {
        const disc2 = await page.evaluate(async (leadId) => {
          const beforeRow = await window.__mockDb.from("leads").select("*").eq("id", leadId).single();
          const p = window.discardLead(leadId);
          await new Promise((r) => setTimeout(r, 700));
          document.getElementById("lead-discard-reason").value = "spam";
          document.getElementById("lead-discard-ok").click();
          await p;
          await new Promise((r) => setTimeout(r, 800));
          const { data: after } = await window.__mockDb.from("leads").select("*").eq("id", leadId).single();
          return { before: beforeRow.data.first_contact_at, discard_reason: after.discard_reason, first_contact_at: after.first_contact_at };
        }, second.id);
        eq("R11-F · a bare code (no note) stores just the code", disc2.discard_reason, "spam");
        eq("R11-F · a no-contact reason does not manufacture a contact timestamp", disc2.first_contact_at, disc2.before);
      }

      noErr(page, "lead discard");
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r11_ux: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
