#!/usr/bin/env node
/* =============================================================================
   tests/r73_visible.js — acceptance tests for R73 build A, "The work is
   visible" (R73 UI/UX panel findings #1, #3, #4, #8, D#6, D#11, E#4).

   What the panel found, verified against the app on 28 August 2026:
     · THE DAY IS CAGED (#1). #briefing-list was a 340px window on 1,200–2,800px
       of content — Kim saw 4 of 48 rows — and the No-next-action radar was a
       181px list inside a 300px card, next door to a Watchtower with 60vh.
       Neither said it scrolled, and both cut through the middle of a row.
     · THE BULK BARS FIGHT THEIR USERS (#3). Watchtower's bar was `hidden` at
       zero selection, so the first tick inserted 53px and shoved every row
       under the cursor down by it — and then scrolled out of view exactly when
       rows were ticked. "Select all 5" on a FOLDED group selected five alerts
       sight-unseen with no feedback on the heading it came from. Pipeline's
       bar shoved the table down ~170px and re-printed a 60-word paragraph on
       every selection.
     · THE CASE MODAL'S ACTION BAR IS A WALL (#4). 135–170px of a 900px desktop
       viewport, 393px (47%) of a phone, pinned 40px below the top of its own
       scrollport so content slid through a visible gap above it.
     · THE PHONE LOSES THE PLOT (#8). tel:/sms: links 15px tall, snooze chips
       24px, retention verbs 21.5px, the log-call follow-up title 26px WIDE;
       Protection & GI and three Data health tables shipped 655–982px of
       desktop table into a 390px screen; the nav's scroll chevron never fired
       on first load, so half the nav — Retention included — was invisible.
     · OVERFLOW AND BROKEN GRIDS (D#6, D#11, E#4). The Reports and Settings tab
       strips scrolled with nothing you could press; Advocacy's grid put a
       five-column table in a 360px track and rendered "Open" as O/p/e/n; the
       board's ‹ arrow has been toggled in CSS since QW16 and never drawn.

     §A  A1 · UN-CAGE THE DAY. Both lists' caps, the whole-row cut, the "N more
         ↓" footer and what it counts, the band order (TODAY → URGENT → WORTH
         DOING — Daniel's decision of 28 Aug 2026), the two "Why? ▸"
         disclosures, and the leads bar counting the unambiguous SET.
     §B  A2 · STICKY BULK BARS. Watchtower's bar keeps its box at zero selection
         and every row's top is unmoved across the first tick; it is sticky
         inside the list's own scroller; Select-all on a folded group expands it
         and marks the heading. Pipeline's bar is docked below the table, the
         table does not move when a selection appears, and its paragraph is
         behind a ⓘ, closed.
     §C  A3 · THE CASE ACTION BAR. One row at 1440 on a live case and on a
         completed one; ≤96px at 390×844; the 40px pinning gap is gone; every
         act-* id still present and tiered; scroll-margin in force.
     §D  A4 · THE PHONE PASS. 44px measured on every target the round names;
         Protection and the three wide Data health tables render as cards with
         no sideways scroll; the nav chevron is lit on first paint; the band's
         why-list is its own line; the KPI strip is masked, not clipped.
     §E  A5 · OVERFLOW + GRIDS. The chip strips carry a chevron, shown only
         while scrollable; Advocacy is ≥340px tracks with the detractor block
         spanning two; the board has both arrows and snaps to columns.
     §F  No console or page errors on any of it.

   Every number asserted here is either measured live in the browser or read
   back off the same data the renderer used — never a figure invented
   independently of the fixture it is testing.

   Run:  node /root/nx/tests/r73_visible.js
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
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  return srv;
}

const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_sortdir", "nx_wt_scope", "nx_board_adviser",
  "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc", "nx_drawer_retention",
  "nx_ret_untouched"];

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };

async function boot(browser, persona, viewport) {
  const page = await (await browser.newContext(viewport ? { viewport } : undefined)).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.waitForTimeout(1600);
  /* The first-run tour (profiles.tour_seen_at null) opens an overlay over Today, on top of the
     very rows §A and §D measure. It is ended through the app's own exit — never by deleting its
     DOM — exactly as navigating away ends it. */
  await page.evaluate(() => { try { if (window.tourEnd) window.tourEnd(false); } catch (e) { /* not open */ } });
  await page.waitForTimeout(250);
  return page;
}
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));
const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 2400 : ms);
};
// Every visible box matching a selector, as {w,h} — the tap-target measurement §D is built on.
const boxes = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)]
  .filter((e) => e.getBoundingClientRect().width > 0)
  .map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }), sel);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* =======================================================================
     §A · A1 — UN-CAGE THE DAY (panel #1 + the owner's band-order decision)
     ==================================================================== */
  {
    console.log("\n— §A · A1 · the day is not a 340px window any more");
    const page = await boot(browser, "p1", DESK);

    const cage = await page.evaluate(() => {
      const l = document.getElementById("briefing-list");
      const foot = document.getElementById("briefing-list-cage");
      const rows = [...l.children].filter((e) => e.matches(".brief-row:not(.brief-subrow)"));
      const cut = l.clientHeight;
      const rel = (r) => r.offsetTop - l.offsetTop;
      return {
        clientH: cut, scrollH: l.scrollHeight, vh: window.innerHeight,
        footText: foot ? foot.textContent.replace(/\s+/g, " ").trim() : null,
        // A row that starts above the cut and ends below it has been sliced in half.
        sliced: rows.filter((r) => rel(r) < cut - 1 && rel(r) + r.offsetHeight > cut + 1).length,
        shown: rows.filter((r) => rel(r) + r.offsetHeight <= cut + 1).length,
        total: rows.length,
      };
    });
    ok("A1a · #briefing-list is no longer the 340px cage it was at e1a2490",
      cage.clientH > 340, JSON.stringify(cage));
    ok("A1b · …and stays inside min(62vh, 720px) plus the one row it rounds to",
      cage.clientH <= Math.min(cage.vh * 0.62, 720) + 160, JSON.stringify(cage));
    eq("A1c · the cut lands on a row boundary — no row is sliced in half", cage.sliced, 0);
    ok("A1d · a caged list carries a real “N more ↓” footer button",
      /^\d+ more rows ↓$/.test(cage.footText || ""), JSON.stringify(cage));
    /* The number comes from the DATA — the grouped-row count the renderer just used — and not
       from counting DOM nodes, which would also count band headings, folds and sub-rows. */
    eq("A1e · …counting exactly the rows the list holds but is not showing",
      Number((cage.footText || "0").match(/^(\d+)/)[1]), cage.total - cage.shown);

    const opened = await page.evaluate(async () => {
      document.querySelector("#briefing-list-cage .dash-cage-more").click();
      await new Promise((r) => setTimeout(r, 200));
      const l = document.getElementById("briefing-list");
      return {
        maxH: l.style.maxHeight, full: l.scrollHeight <= l.clientHeight + 1,
        foot: document.getElementById("briefing-list-cage").textContent.trim(),
      };
    });
    ok("A1f · pressing it opens the list in full", opened.maxH === "none" && opened.full === true, JSON.stringify(opened));
    ok("A1g · …and offers the way back", /Show less/.test(opened.foot), opened.foot);

    const radar = await page.evaluate(() => {
      const l = document.getElementById("unactioned-list");
      const foot = document.getElementById("unactioned-list-cage");
      return { clientH: l.clientHeight, scrollH: l.scrollHeight, foot: foot ? foot.textContent.replace(/\s+/g, " ").trim() : null };
    });
    ok("A1h · the No-next-action radar is un-caged too (it was a 181px list in a 300px card)",
      radar.clientH > 181, JSON.stringify(radar));
    ok("A1i · …and either shows everything, or says how many cases it is still holding back",
      radar.scrollH <= radar.clientH + 2 || /^\d+ more cases ↓$/.test(radar.foot || ""), JSON.stringify(radar));

    /* THE OWNER'S DECISION, 28 Aug 2026: TODAY → URGENT → WORTH DOING. Asserted on the band
       CLASSES, which are what a band's membership is defined by, not on their labels. */
    const bands = await page.evaluate(() => [...document.querySelectorAll("#briefing-list .brief-sec")]
      .map((s) => [...s.classList].find((c) => /^brief-sec-(hot|warm|rest)$/.test(c))));
    ok("A1j · My Day bands render TODAY first, then URGENT, then WORTH DOING",
      bands.length >= 2 && bands[0] === "brief-sec-warm" && bands[1] === "brief-sec-hot"
      && (bands.length < 3 || bands[2] === "brief-sec-rest"), JSON.stringify(bands));

    const why = await page.evaluate(() => {
      const g = document.querySelector("#briefing-group-sub details.why-fold");
      const l = document.querySelector("#leads-accept-bar-sub details.why-fold");
      return {
        groupFold: !!g, groupOpen: g ? g.open : null,
        groupText: (document.querySelector("#briefing-group-sub") || {}).textContent || "",
        leadFold: !!l, leadOpen: l ? l.open : null,
        leadText: (document.querySelector("#leads-accept-bar-sub") || {}).textContent || "",
        summary: g ? g.querySelector("summary").textContent.replace(/\s+/g, " ").trim() : null,
      };
    });
    ok("A1k · both of Today's explanatory paragraphs end in a “Why?” disclosure",
      why.groupFold && why.leadFold, JSON.stringify({ g: why.groupFold, l: why.leadFold }));
    eq("A1l · …closed by default", [why.groupOpen, why.leadOpen], [false, false]);
    ok("A1m · …labelled Why?", /Why\?/.test(why.summary || ""), why.summary);
    ok("A1n · …and NOTHING is lost: the whole sentence is still in the element's text",
      /\+N more/.test(why.groupText) && /New enquiries are never folded/.test(why.groupText)
      && /joint name/i.test(why.leadText) && /lightest desk/i.test(why.leadText), JSON.stringify(why).slice(0, 260));

    /* The leads bar counts the set it will actually accept. Ground truth is an INDEPENDENT
       re-implementation of the two rules classifyLeadsForAccept() applies — a joint name, and a
       lead whose email is already a client's — computed off the mock's own rows, exactly the way
       r15 re-implements CASE_ACTION_RULES rather than importing it. */
    const leads = await page.evaluate(async () => {
      const btn = document.querySelector("#leads-accept-all");
      const rowsEl = [...document.querySelectorAll('#briefing-list [onclick^="acceptLead("]')];
      const ids = rowsEl.map((b) => (b.getAttribute("onclick").match(/acceptLead\('([^']+)'/) || [])[1]).filter(Boolean);
      if (!btn || ids.length < 2) return { absent: true, n: ids.length };
      const { data: rows } = await window.__mockDb.from("leads").select("*").in("id", ids);
      const { data: clients } = await window.__mockDb.from("clients").select("id,email").order("id");
      const emails = new Set((clients || []).map((c) => String(c.email || "").trim().toLowerCase()).filter(Boolean));
      let ambiguous = 0;
      (rows || []).forEach((l) => {
        const nm = String(l.name || "");
        if (/&/.test(nm) || /\s\band\b\s/i.test(nm)) { ambiguous++; return; }
        if (l.email && emails.has(String(l.email).trim().toLowerCase())) { ambiguous++; return; }
      });
      return { absent: false, label: btn.textContent.trim(), total: (rows || []).length, ambiguous };
    });
    if (leads.absent) {
      ok(`A1o · (fixture has ${leads.n} new enquiries — the bar correctly needs two)`, true);
      ok("A1p · (same)", true);
    } else {
      const m = (leads.label || "").match(/Accept (\d+) unambiguous lead/);
      eq("A1o · the leads bar names the UNAMBIGUOUS count, not the inbox total",
        m ? Number(m[1]) : null, leads.total - leads.ambiguous);
      ok("A1p · …and names the remainder it is leaving for a person to decide",
        leads.ambiguous === 0
          ? !/needs? you/.test(leads.label)
          : new RegExp(`\\(${leads.ambiguous} needs? you\\)`).test(leads.label), JSON.stringify(leads));
    }
    ok("§A · no console/page errors", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
    await page.close();
  }

  /* =======================================================================
     §B · A2 — BULK BARS THAT STAY WITH YOU (panel #3)
     ==================================================================== */
  {
    console.log("\n— §B · A2 · sticky bulk bars, reserved height, select-all expands");
    const page = await boot(browser, "p1", DESK);
    await goPage(page, "dashboard");

    const before = await page.evaluate(() => {
      const bar = document.querySelector("#wt-bulk-bar");
      const cs = getComputedStyle(bar);
      return {
        h: Math.round(bar.getBoundingClientRect().height), vis: cs.visibility, pos: cs.position, top: cs.top,
        rows: [...document.querySelectorAll("#watchtower-list .wt-row")].slice(0, 6).map((r) => Math.round(r.getBoundingClientRect().top)),
      };
    });
    ok("B1a · the Watchtower bar RESERVES its height at zero selection",
      before.h > 0 && before.vis === "hidden", JSON.stringify(before));
    ok("B1b · …and is sticky to the top of the list's own scroller",
      before.pos === "sticky" && before.top === "0px", JSON.stringify(before));

    const after = await page.evaluate(async () => {
      const cb = document.querySelector("#watchtower-list .wt-cb");
      cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const bar = document.querySelector("#wt-bulk-bar");
      return {
        h: Math.round(bar.getBoundingClientRect().height), vis: getComputedStyle(bar).visibility,
        rows: [...document.querySelectorAll("#watchtower-list .wt-row")].slice(0, 6).map((r) => Math.round(r.getBoundingClientRect().top)),
        n: document.querySelector("#wt-bulk-n").textContent,
      };
    });
    eq("B1c · the first tick moves NOT ONE ROW (it used to shift every one of them 53px)", after.rows, before.rows);
    ok("B1d · …and the bar becomes visible, same height, with the count on it",
      after.vis === "visible" && after.h === before.h && after.n === "1", JSON.stringify(after));

    const fold = await page.evaluate(async () => {
      /* Start from an empty selection: the tick above landed in the first group, and pressing
         "Select all" on a group that is ALREADY fully ticked is the Clear press, which must NOT
         expand anything (nothing is being taken on trust on the way out). */
      document.querySelector("#wt-bulk-clear").click();
      await new Promise((r) => setTimeout(r, 200));
      const g = [...document.querySelectorAll(".wt-group")].find((x) => x.querySelector(".wt-group-all"));
      if (!g) return { skip: true };
      if (!g.classList.contains("wt-folded")) g.querySelector(".wt-group-head").click();
      await new Promise((r) => setTimeout(r, 200));
      const wasFolded = g.classList.contains("wt-folded");
      g.querySelector(".wt-group-all").click();
      await new Promise((r) => setTimeout(r, 300));
      const badge = g.querySelector(".wt-group-sel");
      return {
        skip: false, wasFolded,
        nowFolded: g.classList.contains("wt-folded"),
        tinted: g.classList.contains("wt-group-has-sel"),
        badge: badge && !badge.hidden ? badge.textContent.trim() : null,
      };
    });
    if (fold.skip) {
      ok("B2 · (no pickable Watchtower group in this fixture)", true);
    } else {
      ok("B2a · Select all on a FOLDED group expands it first — nothing is judged unseen",
        fold.wasFolded === true && fold.nowFolded === false, JSON.stringify(fold));
      ok("B2b · …the group's own heading says how many of its rows are ticked",
        /^· \d+ selected$/.test(fold.badge || ""), JSON.stringify(fold));
      ok("B2c · …and the band is marked while any of them are", fold.tinted === true, JSON.stringify(fold));
    }

    await goPage(page, "pipeline");
    await page.evaluate(() => { const b = document.querySelector("#view-toggle"); if (b && /Table view/.test(b.textContent)) b.click(); });
    await page.waitForTimeout(1500);
    const pipe = await page.evaluate(async () => {
      const tableTop = () => Math.round(document.querySelector("#pipe-scroll").getBoundingClientRect().top);
      const t0 = tableTop();
      const cb = document.querySelector("#pipe-table .bulk-cb");
      cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
      const dock = document.querySelector("#pipe-bulk-dock");
      const sub = document.querySelector("#pipe-bulk-sub");
      const kids = [...document.querySelector("#table-wrap").children].map((k) => k.id || k.className);
      return {
        t0, t1: tableTop(),
        dockPos: getComputedStyle(dock).position, dockBottom: getComputedStyle(dock).bottom,
        dockAfterTable: kids.indexOf("pipe-bulk-dock") > kids.findIndex((c) => /board-scroll-wrap/.test(c)),
        barHidden: document.querySelector("#pipe-bulk-bar").hidden,
        subHidden: sub.hidden, info: !!document.querySelector("#pipe-bulk-info"), subLen: sub.textContent.length,
      };
    });
    eq("B3a · ticking a pipeline row does not move the table (it used to drop ~170px)", pipe.t1, pipe.t0);
    ok("B3b · the bar is docked below the table and sticks to the bottom of it",
      pipe.dockAfterTable === true && pipe.dockPos === "sticky" && pipe.dockBottom === "0px", JSON.stringify(pipe));
    eq("B3c · …and is shown, as it always was, once something is ticked", pipe.barHidden, false);
    ok("B3d · its 60-word paragraph is behind a ⓘ, closed by default — and still there in full",
      pipe.info === true && pipe.subHidden === true && pipe.subLen > 200, JSON.stringify(pipe));
    const infoOpen = await page.evaluate(async () => {
      document.querySelector("#pipe-bulk-info").click();
      await new Promise((r) => setTimeout(r, 200));
      return { hidden: document.querySelector("#pipe-bulk-sub").hidden, expanded: document.querySelector("#pipe-bulk-info").getAttribute("aria-expanded") };
    });
    ok("B3e · …and one press opens it", infoOpen.hidden === false && infoOpen.expanded === "true", JSON.stringify(infoOpen));

    // This round is chrome, not behaviour: every verb is still on the bar with its own id.
    const missing = await page.evaluate(() => ["pipe-bulk-stage", "pipe-bulk-adviser", "pipe-bulk-rate", "pipe-bulk-retention",
      "pipe-bulk-chase", "pipe-bulk-docs", "pipe-bulk-playbook", "pipe-bulk-checklists", "pipe-bulk-task", "pipe-bulk-clear"]
      .filter((id) => !document.getElementById(id)));
    eq("B3f · every pipeline bulk verb is still on the bar, unchanged", missing, []);
    const wtVerbs = await page.evaluate(() => ["wt-bulk-snooze7", "wt-bulk-snooze30", "wt-bulk-dismiss", "wt-bulk-clear"]
      .filter((id) => !document.getElementById(id)));
    eq("B3g · …and so is every Watchtower one", wtVerbs, []);
    ok("§B · no console/page errors", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
    await page.close();
  }

  /* =======================================================================
     §C · A3 — THE CASE MODAL'S ACTION BAR (panel #4)
     ==================================================================== */
  const caseIds = { live: null, comp: null };
  {
    console.log("\n— §C · A3 · one row on a desktop, and no 40px pinning gap");
    const page = await boot(browser, "p2", DESK);
    Object.assign(caseIds, await page.evaluate(async () => {
      const { data } = await window.__mockDb.from("cases").select("id,stage,rate_end_date").order("id");
      return {
        live: ((data || []).find((c) => c.stage === "application" || c.stage === "offer") || {}).id || null,
        comp: ((data || []).find((c) => c.stage === "completed" && c.rate_end_date) || {}).id || null,
      };
    }));

    const readBar = async (id) => {
      await page.evaluate((i) => window.openCase(i), id);
      await page.waitForTimeout(1500);
      return page.evaluate(() => {
        const bar = document.querySelector("#cs-sticky-actions");
        const kids = [...bar.querySelectorAll(":scope > button, :scope > select, :scope > .cs-top-actions > *, :scope > .action-bar > button, :scope > .action-bar > .more-actions")]
          .filter((e) => e.getBoundingClientRect().width > 0);
        const bd = document.querySelector("#modal-backdrop");
        const tiers = {};
        document.querySelectorAll("[data-act-tier]").forEach((e) => { const t = e.getAttribute("data-act-tier"); tiers[t] = (tiers[t] || 0) + 1; });
        return {
          h: Math.round(bar.getBoundingClientRect().height),
          /* "One row" measured as the vertical spread of every control on the bar, not as the
             count of distinct `top` values: a <select> and a <button> on the same line sit two
             pixels apart because their boxes are different heights, and counting tops would
             report four rows for a bar that is plainly one. */
          spread: Math.round(Math.max(...kids.map((e) => e.getBoundingClientRect().bottom))
                           - Math.min(...kids.map((e) => e.getBoundingClientRect().top))),
          labels: kids.map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24)),
          moreToggle: (document.querySelector("#case-more-actions-toggle") || {}).textContent || null,
          backdropPadTop: getComputedStyle(bd).paddingTop,
          scrollPadTop: getComputedStyle(bd).scrollPaddingTop,
          modalMarginTop: getComputedStyle(document.querySelector(".modal")).marginTop,
          tiers,
        };
      });
    };

    if (caseIds.live) {
      const s = await readBar(caseIds.live);
      ok("C1a · a LIVE case's action bar is ONE row (135px / 3 rows at e1a2490)",
        s.spread <= 52 && s.h < 80, JSON.stringify(s));
      ok("C1b · …carrying Advance, the stage select, Log call and an Actions ▾ overflow",
        s.labels.some((l) => /^Advance to/.test(l)) && s.labels.some((l) => /Log call/.test(l))
        && /Actions/.test(s.moreToggle || ""), JSON.stringify(s.labels));
      ok("C1c · the backdrop's 40px pinning gap is gone — the scrollport starts at the top",
        s.backdropPadTop === "0px" && s.modalMarginTop === "40px", JSON.stringify(s));
      ok("C1d · …and the scrollport reserves room for the pinned bar, so nothing lands under it",
        parseInt(s.scrollPadTop, 10) >= 60, s.scrollPadTop);
      ok("C1e · the demoted stage actions are TIERED, not deleted — they are in Actions ▾ under their own heading",
        (s.tiers.stage || 0) > 0 && (s.tiers.rest || 0) > 0, JSON.stringify(s.tiers));
    }
    if (caseIds.comp) {
      const s = await readBar(caseIds.comp);
      ok("C2a · a COMPLETED case's bar is ONE row too (170px / 4 rows at e1a2490)",
        s.spread <= 52 && s.h < 80, JSON.stringify(s));
      ok("C2b · …and it is the rate-end decision that keeps the seat beside Log call",
        s.labels.some((l) => /Log call/.test(l))
        && s.labels.some((l) => /Start retention case|Rate-end outcome/.test(l)), JSON.stringify(s.labels));
      // Nothing is lost: every action the stage offers is still reachable in one press.
      const reachable = await page.evaluate(() => {
        const ids = ["act-write", "act-fee", "act-review", "act-reminder", "act-paid", "act-evidence"];
        return ids.filter((i) => !document.getElementById(i));
      });
      eq("C2c · every completed-stage action is still in the DOM with its own id", reachable, []);
    }
    ok("C · no console/page errors on the case modal", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
    await page.close();
  }
  {
    console.log("\n— §C2 · the same bar at 390×844, where the budget is 96px");
    const page = await boot(browser, "p2", PHONE);
    for (const [k, id] of Object.entries(caseIds)) {
      if (!id) continue;
      await page.evaluate((i) => window.openCase(i), id);
      await page.waitForTimeout(1600);
      const m = await page.evaluate(() => {
        const bar = document.querySelector("#cs-sticky-actions");
        const note = document.querySelector("#new-note");
        return {
          h: Math.round(bar.getBoundingClientRect().height),
          more: !!document.querySelector("#case-more-actions-toggle"),
          logcall: !!document.querySelector("#cs-logcall-btn"),
          stage: !!document.querySelector("#cs-stage-select"),
          noteMargin: note ? getComputedStyle(note).scrollMarginTop : null,
          docW: document.documentElement.scrollWidth,
        };
      });
      ok(`C3 · ${k} · the case bar costs ≤96px of the 844px screen (it was 231 / 393 at e1a2490)`,
        m.h <= 96, JSON.stringify(m));
      ok(`C3 · ${k} · …and still carries the stage, Log call and Actions ▾`,
        m.stage && m.logcall && m.more, JSON.stringify(m));
      ok(`C3 · ${k} · #new-note carries a scroll-margin so it cannot hide behind the bar`,
        parseInt(m.noteMargin || "0", 10) >= 60, String(m.noteMargin));
      ok(`C3 · ${k} · the modal creates no sideways scroll at 390px`, m.docW <= 390, String(m.docW));
      await page.evaluate(() => window.closeModal && window.closeModal());
      await page.waitForTimeout(300);
    }
    ok("§C · no console/page errors at 390px", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
    await page.close();
  }

  /* =======================================================================
     §D · A4 — THE PHONE PASS (panel #8)
     ==================================================================== */
  {
    console.log("\n— §D · A4 · 44px targets, cards instead of tables, and a nav chevron on load");
    const page = await boot(browser, "p1", PHONE);

    /* The chevron. `.sidebar::after` is the affordance and `.nav-scroll-end` switches it off;
       updateSidenavScrollHint() used to run before layout, so on first paint the strip measured
       0 wide, "at end" came back true, and the chevron was dark on exactly the load that needed
       it. Asserted as the panel would see it: the strip overflows AND the chevron is opaque. */
    const nav = await page.evaluate(() => {
      const sb = document.querySelector(".sidebar");
      return {
        overflows: sb.scrollWidth > sb.clientWidth + 1,
        atEnd: sb.classList.contains("nav-scroll-end"),
        opacity: getComputedStyle(sb, "::after").opacity,
      };
    });
    ok("D1 · the nav's scroll chevron is lit on FIRST paint (it never was before)",
      nav.overflows === true && nav.atEnd === false && Number(nav.opacity) > 0.5, JSON.stringify(nav));

    // The KPI strip fades its right edge instead of slicing the last tile mid-word.
    const kpi = await page.evaluate(() => {
      const el = document.getElementById("kpi-row");
      const cs = getComputedStyle(el);
      return { mask: (cs.maskImage || cs.webkitMaskImage || "none"), scrollable: el.scrollWidth > el.clientWidth + 1 };
    });
    ok("D2 · the KPI strip's right edge is masked, not clipped",
      kpi.scrollable === false || /gradient/.test(kpi.mask), JSON.stringify(kpi));

    // Today's own tap targets.
    const tel = await boxes(page, "#briefing-list .ret-row-tel .contact-link, #unactioned-list .ret-row-tel .contact-link");
    const sms = await boxes(page, "#briefing-list .row-sms-link, #unactioned-list .row-sms-link");
    const snooze = await boxes(page, "#briefing-list .snooze-btn");
    const lead = await boxes(page, "#briefing-list .brief-lead-actions .btn");
    ok("D3a · the tap-to-call chip is 44×44 (the tel: link was 91×15)",
      tel.length > 0 && tel.every((b) => b.h >= 44 && b.w >= 44), JSON.stringify(tel.slice(0, 4)));
    ok("D3b · the tap-to-text chip is ≥44px tall (it was 45×15)",
      sms.length > 0 && sms.every((b) => b.h >= 44), JSON.stringify(sms.slice(0, 4)));
    ok("D3c · the task snooze chips are ≥44px tall (they were 42×24)",
      snooze.length === 0 || snooze.every((b) => b.h >= 44), JSON.stringify(snooze.slice(0, 4)));
    ok("D3d · a lead's Accept and its ✕ are ≥44px tall",
      lead.length === 0 || lead.every((b) => b.h >= 44), JSON.stringify(lead.slice(0, 4)));

    // The URGENT band's colliding columns.
    const band = await page.evaluate(() => {
      const sec = document.querySelector("#briefing-list .brief-sec");
      if (!sec) return null;
      const why = sec.querySelector(".brief-sec-why");
      const n = sec.querySelector(".brief-sec-n");
      if (!why || !n) return null;
      const w = why.getBoundingClientRect(), c = n.getBoundingClientRect();
      return { onItsOwnLine: Math.round(w.top) >= Math.round(c.bottom) - 2, whyLines: Math.round(w.height / 18) };
    });
    ok("D4 · a band's type-list sits on its own line rather than colliding with the count",
      !band || band.onItsOwnLine === true, JSON.stringify(band));

    // The health banner: one line, with a real target on it.
    const notice = await page.evaluate(() => {
      const n = document.querySelector("#dash-notices .dash-notice");
      if (!n) return { none: true };
      const link = n.querySelector(".dash-notice-link");
      return {
        none: false, h: Math.round(n.getBoundingClientRect().height),
        linkH: link ? Math.round(link.getBoundingClientRect().height) : null,
        whyShown: !!n.querySelector(".dash-notice-why") && getComputedStyle(n.querySelector(".dash-notice-why")).display !== "none",
      };
    });
    /* 96px is the bound, and it is two lines by design: the headline on one (ellipsised at the
       end of a real sentence, with the whole of it in the element's title and read out in full by
       a screen reader) and its 44px controls on the other. Measured 90px against the 145px this
       banner cost at e1a2490, where it was four lines of wrapped prose and a 24px link. */
    ok("D5 · the ops health banner is a headline and a 44px control, not a four-line wall",
      notice.none || (notice.h <= 96 && (notice.linkH === null || notice.linkH >= 44)), JSON.stringify(notice));

    // Retention: the month chips become one scrolling line, and the row verbs are 44px.
    await goPage(page, "retention", 3200);
    const ret = await page.evaluate(() => {
      const chips = document.querySelector(".ret-month-chips");
      const kids = [...chips.children];
      // Vertical spread again, for the same reason C does it: the "Rate ends:" label and the
      // chips beside it are different heights and sit on the same line.
      const spread = Math.round(Math.max(...kids.map((c) => c.getBoundingClientRect().bottom))
                              - Math.min(...kids.map((c) => c.getBoundingClientRect().top)));
      return { h: Math.round(chips.getBoundingClientRect().height), spread, scrolls: chips.scrollWidth > chips.clientWidth + 1 };
    });
    ok("D6 · the rate-end month chips are ONE scrolling line (they wrapped to 158px)",
      ret.spread <= 52 && ret.h < 70, JSON.stringify(ret));
    const chips = await boxes(page, ".ret-row-chip");
    ok("D7 · the retention row verbs are ≥44px tall (they were 21.5px)",
      chips.length === 0 || chips.every((b) => b.h >= 44), JSON.stringify(chips.slice(0, 4)));

    // Protection: cards, not an 877px table inside a 364px box.
    await goPage(page, "protection", 3200);
    const prot = await page.evaluate(() => {
      const t = document.querySelector("#prot-list-table");
      const sc = document.querySelector("#prot-scroll");
      if (!t) return { none: true };
      const cells = [...t.querySelectorAll("tr.prot-row td")];
      /* The bulk-checkbox column has no heading, by design — it is a control, not a fact — so
         "every cell is labelled" is the wrong assertion. What matters is that the labels came
         off the header row at all, and that they are the column headings. */
      const labels = cells.map((c) => c.getAttribute("data-lbl")).filter((x) => x);
      return {
        none: false, tableW: Math.round(t.getBoundingClientRect().width),
        boxW: sc ? sc.clientWidth : null, sideScroll: sc ? sc.scrollWidth - sc.clientWidth : null,
        cellDisplay: cells[0] ? getComputedStyle(cells[0]).display : null,
        labels: [...new Set(labels)].slice(0, 8),
      };
    });
    ok("D8a · Protection & GI renders as cards, not an 877px table",
      prot.none || (prot.tableW <= prot.boxW + 2 && prot.cellDisplay === "block"), JSON.stringify(prot));
    ok("D8b · …with the lines labelled by the table's own column headings",
      prot.none || (prot.labels.includes("Client") && prot.labels.includes("Status") && prot.labels.includes("Loan")), JSON.stringify(prot));
    ok("D8c · …and no sideways scroll left to do", prot.none || prot.sideScroll <= 1, JSON.stringify(prot));

    // Data health: the three wide tables, same treatment.
    await goPage(page, "data", 4200);
    const dh = await page.evaluate(() => {
      document.querySelectorAll("#page-data .panel.hidden").forEach((p) => p.classList.remove("hidden"));
      const cards = [...document.querySelectorAll("#page-data table.mob-cards")];
      return {
        n: cards.length,
        widths: cards.map((t) => Math.round(t.getBoundingClientRect().width)),
        docW: document.documentElement.scrollWidth,
      };
    });
    ok("D9a · Data health's wide tables are card lists at 390px (they were 655–982px)",
      dh.n >= 3 && dh.widths.every((w) => w <= 390), JSON.stringify(dh));
    ok("D9b · …and the page has no horizontal overflow", dh.docW <= 390, String(dh.docW));

    // The log-call follow-up row, which collapsed to a 26px box that read as a checkbox.
    await goPage(page, "pipeline", 2600);
    const fu = await page.evaluate(async () => {
      const { data } = await window.__mockDb.from("cases").select("id,stage").order("id");
      const c = (data || []).find((x) => x.stage === "application" || x.stage === "offer");
      if (!c) return { none: true };
      window.openCase(c.id);
      await new Promise((r) => setTimeout(r, 1500));
      const btn = document.querySelector("#cs-logcall-btn");
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 700));
      const t = document.querySelector("#cs-call-fu-title");
      if (!t) return { none: true };
      const lbl = t.parentElement.querySelector(".cs-call-fu-lbl");
      const r = t.getBoundingClientRect();
      return {
        none: false, w: Math.round(r.width), h: Math.round(r.height),
        label: lbl ? lbl.textContent.trim() : null,
        saveH: Math.round((document.querySelector("#cs-call-save") || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
      };
    });
    ok("D10a · the follow-up title box is a real field, not a 26px square",
      fu.none || fu.w >= 200, JSON.stringify(fu));
    ok("D10b · …and it says what it is", fu.none || !!fu.label, JSON.stringify(fu));
    ok("D10c · the log-call footer buttons are ≥44px tall", fu.none || fu.saveH >= 44, JSON.stringify(fu));

    ok("§D · no console/page errors across the phone pass", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
    await page.close();
  }

  /* =======================================================================
     §E · A5 — OVERFLOW AFFORDANCES AND THE ADVOCACY GRID
     ==================================================================== */
  {
    console.log("\n— §E · A5 · chip-strip chevrons, the Advocacy grid, the board's pair");
    const page = await boot(browser, "p4", DESK);
    await goPage(page, "reports", 4200);

    const strips = await page.evaluate(() => {
      const out = {};
      [["rep-nav", "rep-nav-chips"], ["settings-jump", "settings-jump-chips"], ["reports-jump", "reports-jump-chips"]].forEach(([bid, wid]) => {
        const bar = document.getElementById(bid), wrap = document.getElementById(wid);
        if (!bar || !wrap || bar.hidden) { out[bid] = { hidden: true }; return; }
        const arrow = bar.querySelector(".chip-scroll-arrow");
        out[bid] = {
          hidden: false,
          overflows: wrap.scrollWidth > wrap.clientWidth + 1,
          isScrollable: bar.classList.contains("is-scrollable"),
          arrow: !!arrow,
          arrowVisible: arrow ? Number(getComputedStyle(arrow).opacity) > 0.5 : null,
        };
      });
      return out;
    });
    ok("E1a · the Reports jump strip carries a scroll chevron",
      strips["rep-nav"].hidden || strips["rep-nav"].arrow === true, JSON.stringify(strips["rep-nav"]));
    ok("E1b · …shown exactly when the strip has somewhere to scroll to",
      strips["rep-nav"].hidden || strips["rep-nav"].arrowVisible === strips["rep-nav"].overflows, JSON.stringify(strips["rep-nav"]));
    ok("E1c · …and so does the Reports SECTION strip, which had no affordance at all",
      strips["reports-jump"].hidden || strips["reports-jump"].arrow === true, JSON.stringify(strips["reports-jump"]));

    const atEnd = await page.evaluate(async () => {
      const bar = document.getElementById("rep-nav"), wrap = document.getElementById("rep-nav-chips");
      if (!bar || bar.hidden || wrap.scrollWidth <= wrap.clientWidth + 1) return { skip: true };
      wrap.scrollLeft = wrap.scrollWidth;
      wrap.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 200));
      const arrow = bar.querySelector(".chip-scroll-arrow");
      return { skip: false, atEnd: bar.classList.contains("chip-at-end"), arrowOpacity: Number(getComputedStyle(arrow).opacity) };
    });
    ok("E1d · …and it goes dark at the end of the strip, where there is nothing left to hint at",
      atEnd.skip || (atEnd.atEnd === true && atEnd.arrowOpacity < 0.5), JSON.stringify(atEnd));

    await page.evaluate(() => { const b = [...document.querySelectorAll(".rep-nav-chips .seg-btn")].find((x) => /advoc/i.test(x.textContent)); if (b) b.click(); });
    await page.waitForTimeout(2200);
    const adv = await page.evaluate(() => {
      const g = document.querySelector("#report-advocacy-grid");
      if (!g) return { none: true };
      const kids = [...g.children].map((c) => ({ id: c.id, w: Math.round(c.getBoundingClientRect().width) }));
      const btn = document.querySelector("#adv-detractor-table .adv-open-btn");
      const r = btn ? btn.getBoundingClientRect() : null;
      return {
        none: false, kids,
        tracks: getComputedStyle(g).gridTemplateColumns.split(" ").length,
        openBtn: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      };
    });
    if (!adv.none) {
      const det = adv.kids.find((k) => k.id === "adv-block-detractors");
      const other = adv.kids.find((k) => k.id === "adv-block-nps");
      ok("E2a · the Advocacy grid gives the detractor table two tracks",
        !det || !other || det.w > other.w * 1.6, JSON.stringify(adv.kids));
      ok("E2b · …so “Open” renders as a button and not as O/p/e/n",
        !adv.openBtn || (adv.openBtn.w > 40 && adv.openBtn.h < 60), JSON.stringify(adv.openBtn));
      ok("E2c · every track is at least 340px wide", adv.kids.every((k) => k.w >= 335), JSON.stringify(adv.kids));
    }

    await goPage(page, "pipeline", 2800);
    const board = await page.evaluate(() => {
      const wrap = document.querySelector("#board").closest(".board-scroll-wrap");
      const b = document.querySelector("#board");
      return {
        left: !!document.querySelector("#board-scroll-left"),
        right: !!wrap.querySelector(".board-scroll-arrow"),
        snap: getComputedStyle(b).scrollSnapType,
        canRight: wrap.classList.contains("can-scroll-right"),
        leftVisible: Number(getComputedStyle(document.querySelector("#board-scroll-left")).opacity) > 0.5,
      };
    });
    ok("E3a · the board carries BOTH arrows, anchored to the board card", board.left && board.right, JSON.stringify(board));
    ok("E3b · …the ‹ one hidden while there is nothing to the left", board.leftVisible === false, JSON.stringify(board));
    ok("E3c · …and the board snaps to column boundaries", /x/.test(board.snap), board.snap);

    ok("§E · no console/page errors", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
    await page.close();
  }

  /* =======================================================================
     §F · nothing this round touched made a noise anywhere else
     ==================================================================== */
  {
    console.log("\n— §F · a clean walk of every page, on three personas");
    for (const persona of ["p1", "p3", "p4"]) {
      const page = await boot(browser, persona, DESK);
      for (const p of ["dashboard", "pipeline", "clients", "retention", "protection", "diary", "reports", "data", "emails", "settings"]) {
        if (persona !== "p4" && p === "money") continue;
        await goPage(page, p, 1500);
      }
      ok(`F · ${persona} · no console/page errors on a full walk`, realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      eq(`F · ${persona} · and no native dialogs were opened`, page.__dialogs.length, 0);
      await page.close();
    }
  }

  await browser.close();
  if (srv) srv.kill();
  console.log("\n" + "=".repeat(64));
  console.log(`R73 VISIBLE: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
})();
