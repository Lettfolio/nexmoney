#!/usr/bin/env node
/* =============================================================================
   tests/r69_today.js — acceptance tests for R69 agent A ("Today")

   §A  A1 · M4 — MY DAY, GROUPED BY CASE. A case with more than one thing on it
       renders as ONE primary row (its highest-priority item, exactly as it
       rendered before, with its own actions) plus a `<details class="brief-more">`
       that is CLOSED by default and holds the case's other rows in full — same
       titles, same badges, same buttons. Proved end to end on a seeded case
       carrying three items (an overdue task, a task due today, an appointment
       that has started): one primary row, a two-item fold, every action button
       present inside it, and a ✓ Done pressed INSIDE the fold actually writing
       done_at. Plus the four rules around it: a case appears in exactly one
       band and it is the band of its highest-priority item (rows only move up);
       lead_new is never grouped and never folded; the band header's number is
       the row count and now says which unit it is ("17 rows · 28 items"); and
       the briefing's own .panel-sub says grouping happened, with the right
       number of grouped cases, only when it did.

       NOTE — the panel finding this item came from ("28 rows for 11 live cases,
       one case 4×") does not describe the code at cf04068: grouping by case has
       existed since BUILD 7d. What did not exist was showing the folded work —
       "+N more: fee" was a button whose other rows were not in the page at all
       until clicked, so their ✓ Done / Chase fee / Send reminder buttons were
       unreachable from the list. That is what §A pins.

   §B  A2 · L2 — TODAY ON A PHONE. At 390×844 the first #briefing-list row must
       start above 900px for an ADMIN (p1, who also carries the ops strip) and
       for an ADVISER (p3), and nothing may overflow the viewport horizontally.
       The KPI row is one horizontally scrolling line with every tile reachable;
       the ops chips are one scrolling line; two or more health banners collapse
       into a single-line strip (p4), one banner does not (p3).

   §C  A3 · L11 — "▶ Run now" ON THE STUCK-AUTOMATION BANNER. Admin/Owner only,
       running the SAME path as the Emails page's #run-now-btn — proved by the
       confirm text it puts up, which is that button's, word for word. After the
       run the heartbeat has moved and the banner has gone. An adviser sees the
       banner and no button.

   §D  A4 · L10 — loadUnactioned IS BOUNDED. Both of its reads carry
       .limit(OWNER_ROW_CAP), the cases read is ordered oldest-touched-first so
       the bound keeps the end the radar is for, and a bound that bites says so
       in a .panel-sub. Driven with __setOwnerRowCap, exactly like the R23
       owner-read notices.

   §E  No console/page errors for every persona touched.

   PERSONAS (mock-supabase.js): p1 Kim Martin = ADMIN, p2 Wayne Kellow and
   p3 Luke Richards = ADVISERS, p4 Daniel Potts = OWNER.

   Run:  node /root/nx/tests/r69_today.js   (expects a static server on 8099;
                                             starts one itself if absent)
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
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }

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

/* The localStorage clear-list every suite carries: a stored scope/window/filter/drawer state from
   a previous run must never decide what this one measures. nx_drawer_unactioned matters here —
   §D reads the radar panel, which is a drawer somebody may have collapsed. */
const NX_KEYS = ["nx_ret_month", "nx_ret_scope", "nx_wt_lastrun", "nx_clients_adviser", "nx_tour_done",
  "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_rateerc", "nx_drawer_revenue"];

async function boot(browser, persona, opts) {
  const ctx = await browser.newContext((opts && opts.viewport) ? { viewport: opts.viewport } : {});
  await ctx.addInitScript((keys) => {
    try { keys.forEach((k) => localStorage.removeItem(k)); } catch (e) { /* private mode — the app copes, so must the test */ }
  }, NX_KEYS);
  const page = await ctx.newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push(d.message()); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push("pageerror: " + String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console: " + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs|favicon/i.test(e));
const wait = (page, ms) => page.waitForTimeout(ms);

async function goto(page, id, ms) {
  await page.evaluate((p) => window.nav(p), id);
  await wait(page, ms || 1400);
}
/* nav() to the page you are already on still re-runs its loader (r17 relies on this too), but a
   bounce through another page is the honest way to prove a whole reload picked a change up. */
async function reloadDashboard(page) {
  await goto(page, "pipeline", 900);
  await goto(page, "dashboard", 1600);
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const addDays = (str, n) => {
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};

/* ---------------------------------------------------------------------------
   THE FIXTURE §A is built on. Three items, one case, one adviser (whoever is
   signed in), so the whole group lands in My Day's default "Mine" scope:
     · a task 3 days overdue      → task_overdue, pri 10  → the PRIMARY row
     · a task due today           → task_today
     · an appointment that started 5 minutes ago → appt_today
   Written straight through __mockDb (the app's own client), so every default
   the mock applies on insert applies here too.
   ------------------------------------------------------------------------ */
async function seedGroupedCase(page, staffId) {
  return page.evaluate(async ({ staffId, today, overdue }) => {
    const db = window.__mockDb;
    const { data: cl } = await db.from("clients")
      .insert({ first_name: "R69", last_name: "Grouped", email: "r69.grouped@example.com", phone: "07700900169" })
      .select("id").single();
    const { data: cs } = await db.from("cases")
      .insert({ client_id: cl.id, case_kind: "purchase", stage: "application", assigned_to: staffId })
      .select("id").single();
    const { data: tOver } = await db.from("case_tasks")
      .insert({ case_id: cs.id, title: "R69 overdue chase", due_date: overdue, assigned_to: staffId })
      .select("id").single();
    const { data: tToday } = await db.from("case_tasks")
      .insert({ case_id: cs.id, title: "R69 call today", due_date: today, assigned_to: staffId })
      .select("id").single();
    const started = new Date(Date.now() - 5 * 60000).toISOString();
    const { data: ap } = await db.from("appointments")
      .insert({ client_id: cl.id, case_id: cs.id, title: "R69 review meeting", starts_at: started, ends_at: started, staff_id: staffId })
      .select("id").single();
    return { clientId: cl.id, caseId: cs.id, taskOverdue: tOver.id, taskToday: tToday.id, apptId: ap.id };
  }, { staffId, today: todayStr(), overdue: addDays(todayStr(), -3) });
}

/* One read of everything §A asserts about the seeded case, taken in the page so the DOM is only
   walked once. `bandOf` climbs to the row's own child-of-#briefing-list (which may be the R61
   "show the other N" fold rather than the row itself) and walks back to the nearest band head —
   that is what "which band is this case in" actually means in this markup. */
function readGroup(page, caseId) {
  return page.evaluate((cid) => {
    const list = document.querySelector("#briefing-list");
    const primaries = [...list.querySelectorAll(".brief-row:not(.brief-subrow)")];
    const mine = primaries.filter((r) => r.innerHTML.includes(`'${cid}'`));
    const bandOf = (el) => {
      let node = el;
      while (node && node.parentElement !== list) node = node.parentElement;
      while (node) {
        if (node.classList && node.classList.contains("brief-sec")) {
          return [...node.classList].find((c) => c.startsWith("brief-sec-") && c !== "brief-sec-n" && c !== "brief-sec-ic" && c !== "brief-sec-why" && c !== "brief-sec-unit") || null;
        }
        node = node.previousElementSibling;
      }
      return null;
    };
    const row = mine[0] || null;
    const det = row ? row.querySelector("details.brief-more") : null;
    const subs = det ? [...det.querySelectorAll(".brief-subrow")] : [];
    return {
      primaryCount: mine.length,
      primaryTitle: row ? (row.querySelector(".row-main .t") || {}).textContent : null,
      primaryBadges: row ? [...row.querySelectorAll(":scope > .badge")].map((b) => b.textContent.trim()) : [],
      band: row ? bandOf(row) : null,
      hasFold: !!det,
      foldOpen: det ? det.open : null,
      summary: det ? det.querySelector("summary").textContent.replace(/\s+/g, " ").trim() : null,
      subCount: subs.length,
      subTitles: subs.map((s) => (s.querySelector(".row-main .t") || {}).textContent.trim()),
      subBadges: subs.map((s) => [...s.querySelectorAll(".badge")].map((b) => b.textContent.trim()).join("|")),
      subActionHtml: subs.map((s) => s.innerHTML),
      // Is any part of the case anywhere else in the list? (rows only ever move up, never twice)
      mentions: primaries.filter((r) => r.innerHTML.includes(`'${cid}'`)).length,
    };
  }, caseId);
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* =======================================================================
     §A · A1/M4 — My Day grouped by case
     ===================================================================== */
  {
    console.log("— §A · A1/M4 · My Day grouped by case (p1 Kim, admin)");
    const page = await boot(browser, "p1");
    const fx = await seedGroupedCase(page, "p1");
    await reloadDashboard(page);

    const g = await readGroup(page, fx.caseId);
    eq("A1 · the three-item case renders as exactly ONE primary row", g.primaryCount, 1);
    ok("A1 · …and that row is the highest-priority item (the overdue task), unchanged",
      /R69 overdue chase/.test(g.primaryTitle || "") && g.primaryBadges.join(" ").includes("OVERDUE"),
      JSON.stringify({ t: g.primaryTitle, b: g.primaryBadges }));
    ok("A1 · the other rows on the case are behind a <details class=\"brief-more\">", g.hasFold, JSON.stringify(g));
    eq("A1 · …which is CLOSED by default", g.foldOpen, false);
    /* GROUND TRUTH, not a hand-counted number: whatever get_briefing returns for this case must be
       on screen exactly once — one primary row plus one folded row each. (The seeded three pick up
       a fourth, protection_hot, because a new purchase case with no protection recorded is a
       protection opportunity — which is precisely the kind of row this item exists to stop
       hiding.) */
    const rpcRows = await page.evaluate(async (cid) => {
      const { data } = await window.__mockDb.rpc("get_briefing", { p_scope: "all" });
      return (data || []).filter((r) => r.case_id === cid).map((r) => r.kind).sort();
    }, fx.caseId);
    ok("A1 · fixture · the seeded case really does carry three or more briefing rows", rpcRows.length >= 3, JSON.stringify(rpcRows));
    eq("A1 · every row the feed has for this case is on screen — one primary + the rest folded, nothing dropped",
      1 + g.subCount, rpcRows.length);
    ok("A1 · the summary counts them and names what they are, in words",
      new RegExp(`^\\+${g.subCount} more on this case:`).test(g.summary || "")
      && /task today/.test(g.summary || "") && /appointment/.test(g.summary || ""),
      g.summary);
    ok("A1 · the folded rows are the rows themselves — same titles",
      g.subTitles.some((t) => /R69 call today/.test(t)) && g.subTitles.some((t) => /R69 review meeting/.test(t)),
      JSON.stringify(g.subTitles));
    ok("A1 · …carrying their own badges (TODAY / APPT), not the primary row's",
      g.subBadges.join(" ").includes("TODAY") && g.subBadges.join(" ").includes("APPT"),
      JSON.stringify(g.subBadges));
    /* THE POINT OF THE WHOLE ITEM: no action is lost. The task-due-today row inside the fold has
       the same snooze cluster + ✓ Done a top-level task row has, and the started appointment has
       its ✓/✗ outcome pair — the exact buttons briefActions/apptQuickOutcomeHtml build. */
    const html = g.subActionHtml.join(" ");
    ok("A1 · the folded task keeps its ✓ Done", html.includes(`briefDone('${fx.taskToday}')`), html.slice(0, 300));
    ok("A1 · …and its snooze cluster", html.includes(`snooze-1d-brief-${fx.taskToday}`) && html.includes(`snooze-1wk-brief-${fx.taskToday}`));
    ok("A1 · the folded appointment keeps its ✓/✗ outcome pair", html.includes(`quickApptOutcome('${fx.apptId}','attended'`) && html.includes(`quickApptOutcome('${fx.apptId}','no_show'`));
    eq("A1 · the case appears in exactly ONE place in the list", g.mentions, 1);
    eq("A1 · …in the band of its highest-priority item (Urgent — rows only ever move up)", g.band, "brief-sec-hot");

    /* …and the buttons are not merely IN the markup: open the fold with a real click on its
       summary and press one. (R61's band fold is opened first, exactly as tests/r17.js does, so
       the click can land — a long Urgent band folds past ten rows and this case is in it.) */
    const doneSel = `#briefing-list [onclick^="briefDone('${fx.taskToday}')"]`;
    ok("A1 · while the fold is closed the folded ✓ Done is not clickable", (await page.locator(doneSel).isVisible()) === false);
    await page.evaluate(() => document.querySelectorAll("#briefing-list details.brief-fold").forEach((d) => { d.open = true; }));
    await wait(page, 200);
    const rowLoc = page.locator("#briefing-list .brief-row:not(.brief-subrow)")
      .filter({ has: page.locator(`[onclick^="briefDone('${fx.taskOverdue}')"]`) });
    await rowLoc.locator("details.brief-more > summary").click();
    await wait(page, 300);
    ok("A1 · clicking the summary opens the fold", await rowLoc.locator("details.brief-more").evaluate((d) => d.open));
    ok("A1 · …and the folded ✓ Done becomes a real, clickable button", await page.locator(doneSel).isVisible());
    await page.click(doneSel);
    await wait(page, 1200);
    const doneAt = await page.evaluate(async (tid) => {
      const { data } = await window.__mockDb.from("case_tasks").select("done_at").eq("id", tid).single();
      return data ? data.done_at : null;
    }, fx.taskToday);
    ok("A1 · ✓ Done pressed INSIDE the fold marks the task done — no action is lost by folding", !!doneAt, String(doneAt));

    /* Leads are never grouped and never folded (R61's rule, restated for the fold). */
    const leads = await page.evaluate(() => ({
      inFolds: document.querySelectorAll("#briefing-list details.brief-more .brief-subrow select.lead-adviser").length,
      leadBadgesInFolds: [...document.querySelectorAll("#briefing-list details.brief-more .brief-subrow")].filter((r) => /NEW LEAD/.test(r.textContent)).length,
      leadRows: document.querySelectorAll("#briefing-list select.lead-adviser").length,
      leadRowsTopLevel: [...document.querySelectorAll("#briefing-list select.lead-adviser")].filter((s) => !s.closest(".brief-subrow")).length,
    }));
    ok("A1 · fixture · there are lead rows on this My Day to test the rule with", leads.leadRows > 0, JSON.stringify(leads));
    eq("A1 · no lead is ever inside a case fold", leads.inFolds + leads.leadBadgesInFolds, 0);
    eq("A1 · every lead row is a top-level row", leads.leadRowsTopLevel, leads.leadRows);

    /* The band header: the number is the ROW count (what r61 §A2 adds up) and the header now says
       which unit that is, naming the item total beside it whenever the two differ. */
    const bands = await page.evaluate(() => {
      const list = document.querySelector("#briefing-list");
      const out = [];
      let cur = null;
      [...list.children].forEach((el) => {
        if (el.classList.contains("brief-sec")) {
          cur = { n: Number(el.querySelector(".brief-sec-n").textContent), unit: el.querySelector(".brief-sec-unit").textContent.trim(), rows: 0, items: 0 };
          out.push(cur);
          return;
        }
        if (!cur) return;
        const primaries = el.matches(".brief-row:not(.brief-subrow)") ? [el] : [...el.querySelectorAll(".brief-row:not(.brief-subrow)")];
        cur.rows += primaries.length;
        primaries.forEach((r) => { cur.items += 1 + r.querySelectorAll(".brief-subrow").length; });
      });
      return out;
    });
    ok("A1 · fixture · more than one band is in play", bands.length > 1, JSON.stringify(bands));
    ok("A1 · every band's count chip is its ROW count", bands.every((b) => b.n === b.rows), JSON.stringify(bands));
    ok("A1 · …and the header says which unit that is, naming the item total when it differs",
      bands.every((b) => b.unit.startsWith(b.n === 1 ? "row" : "rows") && (b.items > b.rows ? b.unit.includes(`${b.items} items`) : !/items/.test(b.unit))),
      JSON.stringify(bands));

    /* The R61 10-row band cap still applies, and it applies to GROUPED rows. */
    const cap = await page.evaluate(() => {
      const out = [];
      let cur = null;
      [...document.querySelector("#briefing-list").children].forEach((el) => {
        if (el.classList.contains("brief-sec")) { cur = { shown: 0, folded: 0, leadsShown: 0 }; out.push(cur); return; }
        if (!cur) return;
        if (el.matches("details.brief-fold")) { cur.folded += el.querySelectorAll(".brief-row:not(.brief-subrow)").length; return; }
        if (el.matches(".brief-row:not(.brief-subrow)")) { cur.shown += 1; if (el.querySelector("select.lead-adviser")) cur.leadsShown += 1; }
      });
      return out;
    });
    ok("A1 · no band shows more than 10 rows outside its fold, leads excepted (R61's cap, on grouped rows)",
      cap.every((b) => b.shown - b.leadsShown <= 10), JSON.stringify(cap));

    /* The subtitle says grouping happened, and counts the grouped cases honestly. */
    const subInfo = await page.evaluate(() => {
      const el = document.querySelector("#briefing-group-sub");
      return {
        hidden: el ? el.classList.contains("hidden") : null,
        text: el ? el.textContent.replace(/\s+/g, " ").trim() : null,
        folds: document.querySelectorAll("#briefing-list details.brief-more").length,
      };
    });
    eq("A1 · the briefing's .panel-sub is shown when grouping happened", subInfo.hidden, false);
    ok("A1 · …and says so in plain English, naming how many cases and that leads are exempt",
      /Rows for the same case are grouped/.test(subInfo.text || "")
      && /\+N more/.test(subInfo.text || "")
      && /New enquiries are never folded/.test(subInfo.text || ""), subInfo.text);
    ok("A1 · …with the grouped-case count the list actually shows",
      new RegExp(`— ${subInfo.folds} cases? here`).test(subInfo.text || ""), JSON.stringify(subInfo));

    /* An adviser with nothing grouped must not be told about a fold they cannot see. Driven by
       emptying the fold-worthy half of the list rather than hunting for a persona that happens
       to have none: setBriefScope repaints from the same items. */
    const noGroup = await page.evaluate(async () => {
      // Strip every case that has more than one briefing item by completing its extra tasks is
      // heavy-handed; instead assert the rule the renderer states, on the renderer's own input.
      const el = document.querySelector("#briefing-group-sub");
      const folds = document.querySelectorAll("#briefing-list details.brief-more").length;
      return { folds, hidden: el.classList.contains("hidden") };
    });
    ok("A1 · the subtitle's shown/hidden state tracks whether anything is grouped at all",
      (noGroup.folds > 0) === (noGroup.hidden === false), JSON.stringify(noGroup));

    ok("§A · no console/page errors", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
    await page.close();
  }

  /* =======================================================================
     §B · A2/L2 — Today on a phone (390 × 844)
     ===================================================================== */
  {
    console.log("\n— §B · A2/L2 · Today at 390×844");
    for (const persona of ["p1", "p3"]) {
      const page = await boot(browser, persona, { viewport: { width: 390, height: 844 } });
      await goto(page, "dashboard", 1600);
      const m = await page.evaluate(() => {
        const first = document.querySelector("#briefing-list .row-item");
        const kpi = document.querySelector("#kpi-row");
        const tiles = [...document.querySelectorAll("#kpi-row .kpi")];
        const tops = [...new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().top)))];
        /* R78: the one-time date-locale note (#locale-note, B7c) paints on this page under
           Playwright's default en-US context — a dismissible strip an en-GB office never sees.
           Its measured height is deducted so this stays a pin on the page's OWN shape. */
        const localeNote = document.getElementById("locale-note");
        const localeNoteH = localeNote ? localeNote.getBoundingClientRect().height : 0;
        return {
          firstRowTop: first ? Math.round(first.getBoundingClientRect().top + window.scrollY - localeNoteH) : null,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          tiles: tiles.length,
          tileRows: tops.length,
          kpiScrollable: kpi ? kpi.scrollWidth > kpi.clientWidth + 1 : null,
          kpiClient: kpi ? kpi.clientWidth : null,
          opsHidden: document.querySelector("#ops-strip").classList.contains("hidden"),
          opsChipRows: new Set([...document.querySelectorAll("#ops-strip .ops-chip")].map((c) => Math.round(c.getBoundingClientRect().top))).size,
          opsChips: document.querySelectorAll("#ops-strip .ops-chip").length,
        };
      });
      ok(`B · ${persona} · the first My Day row starts above 900px (was ~1,170 / ~900 at cf04068)`,
        m.firstRowTop != null && m.firstRowTop < 900, JSON.stringify(m));
      ok(`B · ${persona} · nothing overflows the viewport horizontally`,
        m.scrollWidth <= 390 && m.bodyScrollWidth <= 390, JSON.stringify({ d: m.scrollWidth, b: m.bodyScrollWidth }));
      eq(`B · ${persona} · the KPI tiles are one row, not a three-deep grid`, m.tileRows, 1);
      ok(`B · ${persona} · …and that row scrolls, so every tile is reachable`, m.kpiScrollable === true, JSON.stringify(m));
      if (persona === "p1") {
        ok("B · p1 · the ops strip's chips are one scrolling line (they wrapped onto four)",
          m.opsHidden === false && m.opsChips >= 6 && m.opsChipRows === 1, JSON.stringify(m));
      } else {
        ok("B · p3 · an adviser still gets no ops strip at all", m.opsHidden === true, JSON.stringify(m));
      }
      // Every tile is genuinely reachable: scroll the strip to its end and read the last tile back.
      const lastTile = await page.evaluate(() => {
        const kpi = document.querySelector("#kpi-row");
        kpi.scrollLeft = kpi.scrollWidth;
        const tiles = [...kpi.querySelectorAll(".kpi")];
        const last = tiles[tiles.length - 1];
        const r = last.getBoundingClientRect();
        const k = kpi.getBoundingClientRect();
        return { visible: r.right <= k.right + 2 && r.left >= k.left - 2, label: (last.querySelector(".lbl") || {}).textContent };
      });
      ok(`B · ${persona} · scrolling the strip reaches the last tile in full`, lastTile.visible === true, JSON.stringify(lastTile));
      ok(`B · ${persona} · no console/page errors on the phone viewport`, realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.close();
    }

    // The banner strip: two notices collapse to one line, one notice does not.
    const owner = await boot(browser, "p4", { viewport: { width: 390, height: 844 } });
    await goto(owner, "dashboard", 1600);
    const nf = await owner.evaluate(() => {
      const fold = document.querySelector("#dash-notices details.dash-notice-fold");
      const strip = document.querySelector("#dash-notices");
      return {
        notices: document.querySelectorAll("#dash-notices .dash-notice").length,
        hasFold: !!fold,
        open: fold ? fold.open : null,
        summary: fold ? fold.querySelector("summary").textContent.replace(/\s+/g, " ").trim() : null,
        summaryH: fold ? Math.round(fold.querySelector("summary").getBoundingClientRect().height) : null,
        stripH: Math.round(strip.getBoundingClientRect().height),
        cronInside: !!(fold && fold.querySelector("#dash-cron-notice")),
        exportInside: !!(fold && fold.querySelector("#dash-export-notice")),
      };
    });
    ok("B · p4 · the owner's two health banners collapse into one strip", nf.notices >= 2 && nf.hasFold === true, JSON.stringify(nf));
    eq("B · …closed by default", nf.open, false);
    ok("B · …whose summary names both, on one line", /2 things to look at/.test(nf.summary || "") && nf.summaryH != null && nf.summaryH < 48, JSON.stringify(nf));
    ok("B · …with both banners themselves inside it, untouched", nf.cronInside && nf.exportInside, JSON.stringify(nf));
    ok("B · …and the whole strip now costs one line, not four", nf.stripH < 60, JSON.stringify(nf));
    ok("B · p4 · no console/page errors", realErr(owner).length === 0, realErr(owner).join(" | ").slice(0, 300));
    await owner.close();

    const adv = await boot(browser, "p3", { viewport: { width: 390, height: 844 } });
    await goto(adv, "dashboard", 1400);
    const one = await adv.evaluate(() => ({
      notices: document.querySelectorAll("#dash-notices .dash-notice").length,
      hasFold: !!document.querySelector("#dash-notices details.dash-notice-fold"),
      cronDirect: !!document.querySelector("#dash-notices > #dash-cron-notice"),
    }));
    ok("B · p3 · ONE notice is left exactly as it was — no expander to click through", one.notices === 1 && one.hasFold === false && one.cronDirect, JSON.stringify(one));
    await adv.close();
  }

  /* =======================================================================
     §C · A3/L11 — "▶ Run now" on the stuck-automation banner
     ===================================================================== */
  {
    console.log("\n— §C · A3/L11 · Run now on the stuck-automation banner");
    const page = await boot(browser, "p1");
    await goto(page, "dashboard", 1500);
    const before = await page.evaluate(() => {
      const btn = document.querySelector("#dash-cron-run-btn");
      return {
        notice: !!document.querySelector("#dash-cron-notice[data-state='stale']"),
        btn: !!btn,
        label: btn ? btn.textContent.trim() : null,
        title: btn ? btn.getAttribute("title") : null,
        inNotice: !!(btn && btn.closest("#dash-cron-notice")),
      };
    });
    ok("C1 · fixture · the 3-day-old heartbeat renders the stale banner", before.notice, JSON.stringify(before));
    ok("C1 · an ADMIN gets a ▶ Run now button on it", before.btn && before.inNotice && /Run now/.test(before.label || ""), JSON.stringify(before));
    ok("C1 · …whose title says an unscoped run queues, stamps the heartbeat, and sends nothing while sending is held",
      /queues/i.test(before.title || "") && /heartbeat/i.test(before.title || "") && /held/i.test(before.title || "") && /sends nothing/i.test(before.title || ""),
      before.title);

    /* R76 · B1 — the same-consent contract this block pins (C2: the Emails page's own confirm,
       word for word) is the HOLD-OFF flow now: while email_hold is on — the fixture's seed —
       runQueueNow raises the honest held overlay instead and the v18-parity mock sends nothing
       (both pinned by tests/r76_intake.js §A). State the precondition this block always silently
       relied on: hold off, server key present, so the run can actually send. */
    await page.evaluate(async () => {
      const rows = window.__mock.db.settings;
      const row = rows.filter((r) => r.key === "email_hold")[0];
      if (row) row.value = "off"; else rows.push({ key: "email_hold", value: "off" });
      window.__mock.setResendKey(true);
      await window.__reloadSettings();
    });
    const cronBefore = await page.evaluate(async () => {
      const { data } = await window.__mockDb.from("settings").select("value").eq("key", "last_cron_run_at").single();
      return data ? data.value : null;
    });
    page.__dialogs.length = 0;
    await page.click("#dash-cron-run-btn");
    await wait(page, 2500);
    const confirmTxt = page.__dialogs.join("\n");
    ok("C2 · it asks the Emails page's own question, word for word — same path, same consent",
      /Send ALL \d+ queued email/.test(confirmTxt)
      && /Recipients:/.test(confirmTxt)
      && /This sends for the whole firm, not just your cases\./.test(confirmTxt)
      && /Cancel sends nothing/.test(confirmTxt), confirmTxt.slice(0, 400));
    const after = await page.evaluate(async () => {
      const { data } = await window.__mockDb.from("settings").select("value").eq("key", "last_cron_run_at").single();
      return {
        cron: data ? data.value : null,
        lastRun: window.__mock.lastEmailRun(),
        noticeGone: !document.querySelector("#dash-cron-notice"),
        btnGone: !document.querySelector("#dash-cron-run-btn"),
      };
    });
    ok("C2 · the run actually ran, unscoped (the cron's own behaviour)", after.lastRun && after.lastRun.scoped === false, JSON.stringify(after.lastRun));
    ok("C2 · …so the heartbeat moved to now", after.cron !== cronBefore && Math.abs(Date.now() - new Date(after.cron).getTime()) < 120000, JSON.stringify({ cronBefore, cron: after.cron }));
    ok("C2 · …and the banner re-rendered itself away", after.noticeGone && after.btnGone, JSON.stringify(after));
    ok("§C · no console/page errors (admin)", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
    await page.close();

    const advPage = await boot(browser, "p3");
    await goto(advPage, "dashboard", 1500);
    const advState = await advPage.evaluate(() => ({
      notice: !!document.querySelector("#dash-cron-notice[data-state='stale']"),
      btn: !!document.querySelector("#dash-cron-run-btn"),
      checkLink: !!document.querySelector("#dash-cron-notice .dash-notice-link"),
    }));
    ok("C3 · an adviser still sees the banner…", advState.notice && advState.checkLink, JSON.stringify(advState));
    ok("C3 · …and never the ▶ Run now button (they cannot flush the firm's queue)", advState.btn === false, JSON.stringify(advState));
    ok("§C · no console/page errors (adviser)", realErr(advPage).length === 0, realErr(advPage).join(" | ").slice(0, 300));
    await advPage.close();
  }

  /* =======================================================================
     §D · A4/L10 — loadUnactioned is bounded, and says when the bound bites
     ===================================================================== */
  {
    console.log("\n— §D · A4/L10 · the No-next-action radar is bounded (p4 owner — the whole firm's book)");
    const page = await boot(browser, "p4");
    await goto(page, "dashboard", 1600);

    const baseCap = await page.evaluate(() => OWNER_ROW_CAP);
    ok("D1 · the radar reads to the house owner cap, not to an unbounded full table", baseCap >= 1000, String(baseCap));
    const normal = await page.evaluate(() => ({
      hidden: document.querySelector("#unactioned-cap-notice").classList.contains("hidden"),
      text: document.querySelector("#unactioned-cap-notice").textContent,
      rows: document.querySelectorAll("#unactioned-list .row-item").length,
      ids: [...document.querySelectorAll("#unactioned-list .row-item .t")].map((t) => (t.getAttribute("onclick") || "").replace(/[^']*'([^']+)'.*/, "$1")),
    }));
    ok("D1 · at the normal cap the notice is silent", normal.hidden === true && normal.text === "", JSON.stringify(normal));
    ok("D1 · fixture · the radar has rows to compare against", normal.rows > 0, JSON.stringify(normal));

    // The oldest-touched live cases, straight from the mock — what the ordered read must keep.
    const oldest3 = await page.evaluate(async () => {
      const { data } = await window.__mockDb.from("cases").select("id,stage,updated_at");
      return (data || [])
        .filter((c) => c.stage !== "completed" && c.stage !== "not_proceeding")
        .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
        .slice(0, 3).map((c) => c.id);
    });

    await page.evaluate(() => window.__setOwnerRowCap(3));
    await reloadDashboard(page);
    const capped = await page.evaluate(() => ({
      hidden: document.querySelector("#unactioned-cap-notice").classList.contains("hidden"),
      text: document.querySelector("#unactioned-cap-notice").textContent.replace(/\s+/g, " ").trim(),
      ids: [...document.querySelectorAll("#unactioned-list .row-item .t")].map((t) => (t.getAttribute("onclick") || "").replace(/[^']*'([^']+)'.*/, "$1")),
    }));
    ok("D2 · a cap that bites renders the notice", capped.hidden === false, JSON.stringify(capped));
    ok("D2 · …saying how many rows it read and that the radar may be incomplete",
      /Showing the first 3/.test(capped.text) && /radar may be incomplete/i.test(capped.text), capped.text);
    ok("D2 · the capped read keeps the OLDEST-touched cases — which is what the radar is for",
      capped.ids.length > 0 && capped.ids.every((id) => oldest3.includes(id)),
      JSON.stringify({ shown: capped.ids, oldest3 }));

    await page.evaluate((n) => window.__setOwnerRowCap(n), baseCap);
    await reloadDashboard(page);
    const restored = await page.evaluate(() => ({
      hidden: document.querySelector("#unactioned-cap-notice").classList.contains("hidden"),
      rows: document.querySelectorAll("#unactioned-list .row-item").length,
    }));
    ok("D3 · back at the normal cap the notice goes quiet again", restored.hidden === true, JSON.stringify(restored));
    eq("D3 · …and the radar's own count is unchanged by any of this", restored.rows, normal.rows);
    ok("§D · no console/page errors", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
    await page.close();
  }

  await browser.close();
  if (srv) { try { process.kill(-srv.pid); } catch (e) { /* the server was somebody else's */ } }

  console.log(`\nR69 TODAY: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
