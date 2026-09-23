#!/usr/bin/env node
/* =============================================================================
   tests/r88_today.js — acceptance tests for R88 slice A, "TODAY ONE WORKLIST"
   (R88-DESIGN §A; evidence panel-r87/02-today-case.md #2 and #11).

   Today used to carry three worklists — My Day, the Watchtower and the No-next-action radar —
   with three verb grammars over heavily overlapping cases. R88 folds the Watchtower's alerts and
   the radar's cases INTO My Day:

     §A  ONE LIST (p4, 1440×900). The radar panel is gone from the DOM; the Watchtower is a CLOSED
         <details id="watchtower-panel"> "Checks" drawer still holding #wt-bulk-bar, #watchtower-run,
         the snoozed view and the per-check groups; no visible row on Today lives outside
         #briefing-list. The merged row count is |My Day ∪ Watchtower ∪ radar| BY CASE (computed
         here from window.__todaySources and cross-checked against the mock's own tables), no
         case id is on two rows, every in-scope alert and radar case is somewhere on the list,
         bands follow severity (CRITICAL → Urgent, WARNING → Today, FYI / radar → Worth doing),
         critical alerts carry Snooze…/Dismiss and nothing else carries them, non-critical carry
         ✓ Done. The first .brief-row starts at ≤ 380px. Open on an appointment row and on a task
         row go to the same place (the case), and the ghost "Case" button is gone (02 #11).
     §B  THE MERGE ON SEEDED CASES (p4). A case with a task due today AND two alerts is ONE row
         (the task's), the alerts as sub-lines; a quiet case with a warning is ONE row headed by
         the alert with the radar as its sub-line; a quiet case alone is a Worth doing row whose
         one verb is "Add next step"; a quiet case with a critical is an Urgent row. Then the
         verbs: ✓ Done dismisses without a question; Dismiss on a critical demands a reason and
         logs it to the case; Snooze… on a critical opens the reason overlay; "Add next step"
         opens that case's task composer, focused.
     §C  THE PHONE (p4, 390×844): the first row is above the fold, nothing scrolls sideways, the
         sub-line verbs and the drawer's summary are 44px targets.
     §D  THE ADVISER (p2): sees only their own — every owned row is theirs, every folded-in alert
         and radar case is on a case assigned to them, no firm-level check; the radar stays their
         own even under All; the first row is at ≤ 380px.
     §E  no console / page errors on every page used above.

   Standing rules: expectations computed at runtime from window.__mockDb / the app's own sources,
   never pasted. Run: node tests/r88_today.js (copy to /tmp and patch REPO/PORT for a worktree).
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
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + String(detail).slice(0, 400) : ""}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

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

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function boot(browser, persona, o) {
  const opts = o || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || DESK, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#briefing-list .row-item, #briefing-list .empty"), null, { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { try { if (window.tourEnd) window.tourEnd(false); } catch (e) { /* not open */ } });
  await page.waitForTimeout(300);
  page.__ctx = ctx;
  return page;
}
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));
const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 1800 : ms);
};
async function insertRow(page, table, fields) {
  return page.evaluate(async ([t, f]) => {
    const { data, error } = await window.__mockDb.from(t).insert(f).select().single();
    if (error) throw new Error(`${t} insert: ` + error.message);
    return data;
  }, [table, fields]);
}
const tag = () => Math.random().toString(36).slice(2, 7);

/* The whole list, read from the DOM: every PRIMARY row (folded band rows included — they are in
   the DOM, just behind "Show the other N"), with what it merged. */
const readList = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll("#briefing-list .brief-row:not(.brief-subrow)")];
  const own = (r) => [...r.querySelectorAll(":scope > button, :scope > .brief-lead-actions > button, :scope > details > summary")];
  return rows.map((r) => ({
    case: r.dataset.case || null,
    lead: r.dataset.briefLead || null,   // R88 · fixer (10 D2)
    owner: r.dataset.briefOwner || null,
    alert: r.dataset.alertId || null,
    sev: r.dataset.sev || null,
    radar: r.dataset.radar || null,
    cls: [...r.classList].filter((c) => /^(hot|warm|brief-wt-row|unactioned-row)$/.test(c)),
    verbs: own(r).map((b) => b.textContent.trim()),
    onclicks: own(r).map((b) => b.getAttribute("onclick") || ""),
    sides: [...r.querySelectorAll(":scope > .row-main > .brief-side")].map((s) => ({
      alert: s.dataset.alertId || null, sev: s.dataset.sev || null, radar: s.dataset.radar || null,
      verbs: [...s.querySelectorAll("button")].map((b) => b.textContent.trim()),
      onclicks: [...s.querySelectorAll("button")].map((b) => b.getAttribute("onclick") || ""),
    })),
    band: (() => {   // the band heading this row sits under (walk back over siblings / out of a fold)
      let el = r.closest("details.brief-fold") || r;
      while (el && !(el.classList && el.classList.contains("brief-sec"))) el = el.previousElementSibling;
      return el ? [...el.classList].find((c) => /^brief-sec-(hot|warm|rest)$/.test(c)) || null : null;
    })(),
  }));
});
/* The expected row count from the sources: one row per case across all three, plus one per
   case-less item (a lead is never grouped, even with a case).
   R88 · fixer (10 D2): was "by case" only, which counted a lead twice — its lead_new row AND its
   lead_slow check (case_id null, lead_id set). Now BY CASE OR LEAD: a case-less check whose lead has
   a lead_new row joins that row, so it adds nothing. */
const expectedRows = (src) => {
  const keys = new Set(); const leads = new Set(); let nulls = 0;
  src.brief.forEach((it) => {
    if (it.kind === "lead_new" && it.lead_id) { nulls++; leads.add(it.lead_id); }
    else if (!it.case_id || it.kind === "lead_new") nulls++; else keys.add(it.case_id);
  });
  src.wt.forEach((a) => { if (a.case_id) keys.add(a.case_id); else if (!(a.lead_id && leads.has(a.lead_id))) nulls++; });
  src.radar.forEach((c) => keys.add(c));
  return { n: keys.size + nulls, cases: keys.size, leads: leads.size };
};

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* =====================================================================
       §A — ONE LIST (p4 owner, 1440×900)
       ===================================================================== */
    console.log("\n— §A · Today has one worklist, merged by case (p4, 1440×900)");
    {
      const page = await boot(browser, "p4");
      const shape = await page.evaluate(() => {
        const d = document.getElementById("watchtower-panel");
        const visibleRows = [...document.querySelectorAll("#page-dashboard .row-item")].filter((r) => r.checkVisibility());
        const lists = new Set(visibleRows.map((r) => (r.closest("[id$='-list']") || { id: "?" }).id));
        return {
          radarPanel: !!document.getElementById("unactioned-panel"), radarList: !!document.getElementById("unactioned-list"),
          isDetails: d && d.tagName, open: d && d.open,
          inDrawer: ["wt-bulk-bar", "watchtower-run", "watchtower-snoozed", "watchtower-snoozed-toggle", "wt-filters", "watchtower-list"].map((id) => { const e = document.getElementById(id); return !!(e && e.closest("#watchtower-panel")); }),
          groups: document.querySelectorAll("#watchtower-panel .wt-group-head").length,
          runInMenu: !!document.querySelector("#brief-more #watchtower-run"),
          lists: [...lists], visible: visibleRows.length,
          drawerRowsVisible: [...document.querySelectorAll("#watchtower-list .wt-row")].filter((r) => r.checkVisibility()).length,
        };
      });
      eq("A1 · the No-next-action radar panel and its list are gone from the DOM", [shape.radarPanel, shape.radarList], [false, false]);
      ok("A2 · #watchtower-panel is a CLOSED <details> (the Checks drawer)", shape.isDetails === "DETAILS" && shape.open === false, JSON.stringify(shape));
      ok("A3 · …still holding the bulk bar, Run checks, the snoozed view + toggle, the chips and the list", shape.inDrawer.every(Boolean), JSON.stringify(shape.inDrawer));
      ok("A4 · …and the per-check group headings (in the DOM, folded away)", shape.groups > 0 && shape.drawerRowsVisible === 0, JSON.stringify(shape));
      ok("A5 · Run checks left My Day's ⋯ menu (it is a drawer control now)", !shape.runInMenu);
      ok("A6 · Today shows exactly ONE worklist: every visible row is in #briefing-list", shape.visible > 0 && shape.lists.length === 1 && shape.lists[0] === "briefing-list", JSON.stringify(shape.lists));

      const src = await page.evaluate(() => window.__todaySources());
      const rows = await readList(page);
      const exp = expectedRows(src);
      ok("A7 · fixture · all three sources feed the list (My Day items, alerts, radar cases)", src.brief.length > 0 && src.wt.length > 0 && src.radar.length > 0, JSON.stringify({ b: src.brief.length, w: src.wt.length, r: src.radar.length }));
      eq("A8 · merged row count = |My Day ∪ Watchtower ∪ radar| by case OR lead (R88 · fixer: was by case)", rows.length, exp.n);
      const caseIds = rows.map((r) => r.case).filter(Boolean);
      eq("A9 · no case id appears on two rows", caseIds.length, new Set(caseIds).size);
      eq("A9b · …and every case in the union has its row", new Set(caseIds).size, exp.cases);
      /* R88 · fixer (10 D2) — …and no LEAD on two rows: a lead_slow check is a sub-line on its lead's row. */
      const leadIds = rows.map((r) => r.lead).filter(Boolean);
      eq("A9c · no lead appears on two rows (the lead_new row carries its check as a sub-line)", leadIds.length, new Set(leadIds).size);
      const leadChecks = src.wt.filter((a) => !a.case_id && a.lead_id && exp.leads > 0 && src.brief.some((b) => b.kind === "lead_new" && b.lead_id === a.lead_id));
      const leadSideOk = leadChecks.every((a) => rows.some((r) => r.lead === a.lead_id && !r.alert && r.sides.some((sd) => sd.alert === a.id)));
      ok("A9d · every lead check whose lead has a row is a sub-line on that row, the lead's own verbs still the head", leadChecks.length > 0 && leadSideOk, JSON.stringify(leadChecks.map((a) => a.lead_id)));

      /* Cross-check the sources against the mock's own tables — the merge must not drop or invent. */
      const truth = await page.evaluate(async () => {
        const now = new Date().toISOString();
        const { data: al } = await window.__mockDb.from("watch_alerts").select("id,resolved_at,snoozed_until");
        const open = (al || []).filter((a) => !a.resolved_at && !(a.snoozed_until && a.snoozed_until > now)).map((a) => a.id);
        const db = window.__mockDb;
        const [{ data: cases }, { data: tasks }, { data: notes }, { data: events }] = await Promise.all([
          db.from("cases").select("*"), db.from("case_tasks").select("case_id,done_at,title,created_at"), db.from("case_notes").select("case_id,created_at"), db.from("case_events").select("case_id,created_at")]);
        const since = Date.now() - 7 * 86400000;
        const act = {};
        [...(notes || []), ...(events || [])].forEach((r) => { const t = new Date(r.created_at).getTime(); if (!act[r.case_id] || t > act[r.case_id]) act[r.case_id] = t; });
        const live = (c) => (tasks || []).some((t) => t.case_id === c.id && !t.done_at && !isStalePlaybookTask(t, c.stage));
        const quiet = (cases || []).filter((c) => c.stage !== "completed" && c.stage !== "not_proceeding" && !live(c) && !(act[c.id] && act[c.id] >= since));
        return { open, quiet: quiet.length };
      });
      eq("A10 · every open, un-snoozed alert in the book is folded in (owner, All)", src.wt.map((a) => a.id).sort(), truth.open.slice().sort());
      eq("A11 · the radar's in-scope total matches a recount of quiet live cases", src.radarTotal, truth.quiet);
      const allAlertIds = rows.flatMap((r) => [r.alert].concat(r.sides.map((s) => s.alert))).filter(Boolean);
      eq("A12 · every folded-in alert is on the list exactly once (a row head or a sub-line)", allAlertIds.slice().sort(), src.wt.map((a) => a.id).sort());
      const radarIds = rows.flatMap((r) => [r.radar].concat(r.sides.map((s) => s.radar))).filter(Boolean);
      eq("A13 · every radar case is on the list exactly once", [...new Set(radarIds)].sort(), src.radar.slice().sort());

      /* Severity → band, and the verbs that go with it. */
      const heads = rows.filter((r) => r.alert);
      const bandOf = { crit: "brief-sec-hot", warn: "brief-sec-warm", info: "brief-sec-rest" };
      ok("A14 · an alert-headed row sits in its severity's band (CRITICAL → Urgent, WARNING → Today, FYI → Worth doing)",
        heads.length > 0 && heads.every((r) => r.band === bandOf[r.sev]), JSON.stringify(heads.map((r) => [r.sev, r.band])));
      const critSideRows = rows.filter((r) => r.sides.some((x) => x.sev === "crit"));
      ok("A14b · a row carrying a CRITICAL sub-line is in Urgent whatever its head is (rows only ever move up)",
        critSideRows.every((r) => r.band === "brief-sec-hot"), JSON.stringify(critSideRows.map((r) => [r.case, r.band])));
      const radarHeads = rows.filter((r) => r.cls.includes("unactioned-row"));
      ok("A15 · a radar-headed row sits in Worth doing", radarHeads.length > 0 && radarHeads.every((r) => r.band === "brief-sec-rest"), JSON.stringify(radarHeads.map((r) => r.band)));
      const alertUnits = rows.flatMap((r) => [...(r.alert ? [{ sev: r.sev, onclicks: r.onclicks, synth: /^synth:/.test(r.alert) }] : []), ...r.sides.filter((s) => s.alert).map((s) => ({ sev: s.sev, onclicks: s.onclicks, synth: /^synth:/.test(s.alert) }))]);
      const crit = alertUnits.filter((u) => u.sev === "crit"), nonCrit = alertUnits.filter((u) => u.sev !== "crit" && !u.synth);
      ok("A16 · fixture · there are critical and non-critical alerts to judge", crit.length > 0 && nonCrit.length > 0, JSON.stringify({ crit: crit.length, non: nonCrit.length }));
      ok("A17 · every CRITICAL alert carries Snooze… and Dismiss (the mandatory-reason pair), and no ✓ Done",
        crit.every((u) => u.onclicks.some((o) => /^snoozeAlert\(/.test(o)) && u.onclicks.some((o) => /^resolveAlert\(/.test(o)) && !u.onclicks.some((o) => /wtDoneAlert/.test(o))), JSON.stringify(crit.slice(0, 3)));
      ok("A18 · every non-critical alert carries ✓ Done and neither Snooze… nor Dismiss",
        nonCrit.every((u) => u.onclicks.some((o) => /^wtDoneAlert\(/.test(o)) && !u.onclicks.some((o) => /snoozeAlert|resolveAlert/.test(o))), JSON.stringify(nonCrit.slice(0, 3)));
      const snoozeOutsideCrit = await page.evaluate(() => [...document.querySelectorAll("#briefing-list [onclick^='snoozeAlert('], #briefing-list [onclick^='resolveAlert(']")]
        .filter((b) => !/,'crit',/.test(b.getAttribute("onclick"))).length);
      eq("A19 · …so no Snooze… / Dismiss on My Day belongs to a non-critical rule", snoozeOutsideCrit, 0);
      ok("A20 · a radar-only row carries Open and ONE verb, “Add next step” (no Done, no Snooze)",
        radarHeads.every((r) => r.verbs.length === 2 && r.verbs[0] === "Open" && r.verbs[1] === "Add next step"), JSON.stringify(radarHeads.slice(0, 2).map((r) => r.verbs)));

      /* 02 #11 — one meaning per verb. */
      const verbs = await page.evaluate(() => {
        const rowOf = (b) => b.closest(".brief-row");
        const appt = [...document.querySelectorAll("#briefing-list .brief-row .t[onclick^='openAppt(']")].map((t) => t.closest(".brief-row"));
        const task = [...document.querySelectorAll("#briefing-list [onclick^='briefDone(']")].map(rowOf);
        const openOf = (r) => { const b = [...r.children].find((x) => x.tagName === "BUTTON" && x.textContent.trim() === "Open"); return b ? b.getAttribute("onclick") : null; };
        return {
          appt: appt.map((r) => ({ open: openOf(r), caseAttr: r.dataset.case || null })),
          task: task.slice(0, 5).map((r) => ({ open: openOf(r), caseAttr: r.dataset.case || null })),
          ghostCase: [...document.querySelectorAll("#briefing-list button")].filter((b) => b.textContent.trim() === "Case").length,
        };
      });
      const withCase = verbs.appt.filter((a) => a.caseAttr);
      ok("A21 · fixture · appointment rows with a case, and task rows, are on My Day", withCase.length > 0 && verbs.task.length > 0, JSON.stringify(verbs));
      ok("A22 · “Open” on an appointment row opens its CASE — the same place “Open” goes on a task row (02 #11)",
        withCase.every((a) => a.open === `openCase('${a.caseAttr}')`) && verbs.task.filter((t) => t.caseAttr).every((t) => t.open === `openCase('${t.caseAttr}')`), JSON.stringify(verbs));
      eq("A23 · …and the ghost “Case” button is gone from every row", verbs.ghostCase, 0);

      const firstTop = await page.evaluate(() => { const r = document.querySelector("#briefing-list .brief-row"); return r ? Math.round(r.getBoundingClientRect().top) : null; });
      ok("A24 · the first .brief-row starts at ≤ 380px", firstTop != null && firstTop <= 380, `top=${firstTop}`);

      /* The drawer: summary opens it, toggleDrawer (the old API) closes it, the class mirrors. */
      await page.click("#watchtower-panel > summary");
      await page.waitForTimeout(300);
      const opened = await page.evaluate(() => ({ open: document.getElementById("watchtower-panel").open, collapsed: document.getElementById("watchtower-panel").classList.contains("collapsed"), run: document.getElementById("watchtower-run").checkVisibility(), rows: [...document.querySelectorAll("#watchtower-list .wt-row")].filter((r) => r.checkVisibility()).length }));
      ok("A25 · pressing “Checks” opens the drawer: Run checks and the triage rows are visible, .collapsed cleared", opened.open && !opened.collapsed && opened.run && opened.rows > 0, JSON.stringify(opened));
      await page.evaluate(() => window.toggleDrawer(null, "watchtower"));
      await page.waitForTimeout(200);
      const closed = await page.evaluate(() => document.getElementById("watchtower-panel").open);
      eq("A26 · toggleDrawer(null,'watchtower') still closes it (the class and <details> stay in step)", closed, false);
      await page.evaluate(() => { try { localStorage.removeItem("nx_drawer_watchtower"); } catch (e) {} });

      /* Scope: flip to Mine — the folded-in items follow My Day's toggle. */
      await page.click("#brief-scope-mine");
      await page.waitForTimeout(1500);
      const mine = await page.evaluate(() => {
        const s = window.__todaySources();
        const bk = window.__bookPeek();
        const adv = (id) => { const c = bk && bk.caseById && bk.caseById.get(id); return c ? c.assigned_to : null; };
        return { scope: s.scope, wtBad: s.wt.filter((a) => a.case_id && adv(a.case_id) !== "p4").length, radarBad: s.radar.filter((id) => adv(id) !== "p4").length, radar: s.radar.length, wt: s.wt.length, rows: document.querySelectorAll("#briefing-list .brief-row:not(.brief-subrow)").length };
      });
      ok("A27 · under Mine the folded-in alerts and radar cases are all on the owner's own cases", mine.scope === "mine" && mine.wtBad === 0 && mine.radarBad === 0, JSON.stringify(mine));
      const srcMine = await page.evaluate(() => window.__todaySources());
      eq("A28 · …and the list still has exactly one row per case in the union", mine.rows, expectedRows(srcMine).n);
      /* R88 · fixer (10 1k) — one Mine|All on Today: the drawer's own toggle is hidden and mirrors My Day's. */
      const wtSeg = await page.evaluate(() => { const m = document.getElementById("wt-scope-mine"), a = document.getElementById("wt-scope-all"); return { ids: !!m && !!a, hidden: !!m && !m.checkVisibility() && !a.checkVisibility(), minePressed: m && m.getAttribute("aria-pressed"), scope: window.__todaySources().scope }; });
      ok("A28b · #wt-scope-mine / -all stay in the DOM, hidden, and mirror My Day's scope (Mine pressed)", wtSeg.ids && wtSeg.hidden && wtSeg.minePressed === "true" && wtSeg.scope === "mine", JSON.stringify(wtSeg));
      ok("§A · no console/page errors (p4)", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.__ctx.close();
    }

    /* R88 · fixer (10 D1) — a STORED pre-R88 drawer preference. R33's toggleDrawer wrote
       nx_drawer_watchtower = "open" for anyone who ever opened the Watchtower; honouring it re-opened
       the Checks drawer on every boot — its alerts on screen twice. The key is dropped at sign-in and
       no longer read, so the drawer is born closed and Today has one list. */
    console.log("\n— §A · a stored nx_drawer_watchtower = open does not re-open the Checks drawer (p4)");
    {
      const ctx = await browser.newContext({ viewport: DESK, locale: "en-GB", timezoneId: "Europe/London" });
      await ctx.addInitScript(() => { try { if (!sessionStorage.getItem("r88fx")) { sessionStorage.setItem("r88fx", "1"); localStorage.setItem("nx_drawer_watchtower", "open"); } } catch (e) { /* storage blocked */ } });
      const page = await ctx.newPage();
      page.__err = [];
      page.on("pageerror", (e) => page.__err.push(String(e)));
      await page.goto(`${BASE}?as=p4`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#briefing-list .row-item, #briefing-list .empty"), null, { timeout: 30000 });
      await page.waitForTimeout(2500);
      const st = await page.evaluate(() => {
        const d = document.getElementById("watchtower-panel");
        const vis = [...document.querySelectorAll("#page-dashboard .row-item")].filter((r) => r.checkVisibility());
        return { open: d.open, collapsed: d.classList.contains("collapsed"), key: localStorage.getItem("nx_drawer_watchtower"),
          lists: [...new Set(vis.map((r) => (r.closest("[id$='-list']") || { id: "?" }).id))], wtRows: [...document.querySelectorAll("#watchtower-list .wt-row")].filter((r) => r.checkVisibility()).length };
      });
      ok("A29 · the Checks drawer is born closed despite the stored \"open\"", st.open === false && st.wtRows === 0, JSON.stringify(st));
      eq("A30 · the stale key is removed at sign-in", st.key, null);
      ok("A31 · …and Today still shows exactly one worklist", st.lists.length === 1 && st.lists[0] === "briefing-list", JSON.stringify(st.lists));
      ok("A32 · no page errors (stored-pref boot)", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await ctx.close();
    }

    /* =====================================================================
       §B — THE MERGE ON SEEDED CASES, AND THE VERBS (p4)
       ===================================================================== */
    console.log("\n— §B · seeded cases merge to one row each; the verbs do what they say (p4)");
    {
      const page = await boot(browser, "p4");
      const t = tag();
      const today = await page.evaluate(() => localDateStr());
      /* A rate end well outside every rate window (no rate_urgent item on My Day), so the radar
         row's rate line can be read without My Day claiming the case for another reason. */
      const later = await page.evaluate(() => localDateStr(Date.now() + 400 * 86400000));
      const mk = async (last, stage, extra) => {
        const cl = await insertRow(page, "clients", { first_name: "R88", last_name: last + t, email: `r88.${last.toLowerCase()}.${t}@example.com`, phone: "07700 9008" + String(Math.floor(Math.random() * 90) + 10) });
        const cs = await insertRow(page, "cases", Object.assign({ client_id: cl.id, case_kind: "remortgage", stage, assigned_to: "p4" }, extra || {}));
        await page.evaluate(async (id) => { await window.__mockDb.from("case_events").delete().eq("case_id", id); await window.__mockDb.from("case_notes").delete().eq("case_id", id); }, cs.id);
        return { clientId: cl.id, caseId: cs.id };
      };
      const alert = (caseId, severity, n) => insertRow(page, "watch_alerts", { rule: "r88_probe_" + severity + n, severity, case_id: caseId, title: `R88 probe ${severity} ${n} — something to check`, detail: "Seeded by r88_today.", dedupe_key: `r88:${severity}:${n}:${caseId}` });
      const X = await mk("Tasked", "fact_find");
      await insertRow(page, "case_tasks", { case_id: X.caseId, title: "Ring about the valuation", due_date: today, assigned_to: "p4" });
      const xCrit = await alert(X.caseId, "crit", 1);
      const xWarn = await alert(X.caseId, "warn", 2);
      /* fact_find on purpose (r87_today §D's note): the mock's get_briefing adds a "protection not
         discussed" item to an application/offer case, which would give these quiet cases a My Day row. */
      const Y = await mk("QuietWarn", "fact_find");
      const yWarn = await alert(Y.caseId, "warn", 3);
      const Z = await mk("QuietOnly", "fact_find", { rate_end_date: later, lender: "Skipton" });
      const W = await mk("QuietCrit", "fact_find");
      const wCrit = await alert(W.caseId, "crit", 4);
      await goPage(page, "pipeline", 600);
      await goPage(page, "dashboard", 3000);
      /* A long band folds its tail behind "Show the other N" (R61); open them the way a person does
         so every seeded row can be pressed. The open state survives repaints (briefFoldOpen). */
      await page.evaluate(() => { document.querySelectorAll("#briefing-list details.brief-fold").forEach((d) => { d.open = true; }); window.dashCageOpen["briefing-list"] = true; });
      await page.waitForTimeout(200);
      const rows = await readList(page);
      const byCase = (id) => rows.filter((r) => r.case === id);
      const x = byCase(X.caseId), y = byCase(Y.caseId), z = byCase(Z.caseId), w = byCase(W.caseId);
      eq("B1 · each seeded case is ONE row", [x.length, y.length, z.length, w.length], [1, 1, 1, 1]);
      ok("B2 · the tasked case's row is headed by its TASK (the alerts never take over a My Day row) — and rides UP to Urgent with its critical (rows only move up)",
        x[0] && !x[0].alert && x[0].onclicks.some((o) => /^briefDone\(/.test(o)) && x[0].band === "brief-sec-hot" && x[0].cls.includes("hot"), JSON.stringify(x[0]));
      ok("B3 · …its two alerts are sub-lines on that row: the critical with Snooze…/Dismiss, the warning with ✓ Done",
        x[0] && x[0].sides.length === 2
        && x[0].sides.some((s) => s.alert === xCrit.id && s.verbs.join("|") === "⏰ Snooze…|Dismiss")
        && x[0].sides.some((s) => s.alert === xWarn.id && s.verbs.join("|") === "✓ Done"), JSON.stringify(x[0] && x[0].sides));
      ok("B4 · a quiet case with a warning is one row headed by the alert, in Today, the radar as its sub-line",
        y[0] && y[0].alert === yWarn.id && y[0].band === "brief-sec-warm" && y[0].sides.length === 1 && y[0].sides[0].radar === Y.caseId && y[0].sides[0].verbs.join("|") === "Add next step", JSON.stringify(y[0]));
      ok("B5 · a quiet case alone is a Worth doing row whose verbs are Open + Add next step",
        z[0] && z[0].cls.includes("unactioned-row") && z[0].band === "brief-sec-rest" && z[0].verbs.join("|") === "Open|Add next step", JSON.stringify(z[0]));
      ok("B6 · a quiet case with a CRITICAL is an Urgent row (hot) with Snooze…/Dismiss, the radar as its sub-line",
        w[0] && w[0].alert === wCrit.id && w[0].band === "brief-sec-hot" && w[0].cls.includes("hot") && w[0].verbs.includes("⏰ Snooze…") && w[0].verbs.includes("Dismiss") && w[0].sides.some((s) => s.radar === W.caseId), JSON.stringify(w[0]));
      const rate = await page.evaluate((id) => { const r = document.querySelector(`#briefing-list .brief-row[data-case="${id}"]`); const e = r && r.querySelector(".unactioned-rate"); return e ? e.textContent : null; }, Z.caseId);
      ok("B7 · the radar row keeps its rate line (lender + “rate ends …”)", !!rate && /Skipton — rate ends /.test(rate), rate);

      /* ✓ Done — no question asked. */
      let dialogs = 0;
      page.on("dialog", async (d) => { dialogs++; await d.accept("R88 probe — reason given"); });
      await page.click(`#briefing-list .brief-side[data-alert-id="${xWarn.id}"] button`);
      await page.waitForTimeout(1500);
      const afterDone = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("watch_alerts").select("resolved_at").eq("id", id).single();
        return { resolved: !!(data && data.resolved_at), still: !!document.querySelector(`#briefing-list [data-alert-id="${id}"]`) };
      }, xWarn.id);
      ok("B8 · ✓ Done on a warning resolves it with no dialog, and the line leaves My Day", afterDone.resolved && !afterDone.still && dialogs === 0, JSON.stringify({ ...afterDone, dialogs }));
      /* Dismiss on a critical — the reason is required and logged. */
      await page.click(`#briefing-list .brief-side[data-alert-id="${xCrit.id}"] .brief-wt-dismiss`);
      await page.waitForTimeout(1500);
      const afterDismiss = await page.evaluate(async ([id, caseId]) => {
        const { data } = await window.__mockDb.from("watch_alerts").select("resolved_at").eq("id", id).single();
        const { data: notes } = await window.__mockDb.from("case_notes").select("body").eq("case_id", caseId);
        return { resolved: !!(data && data.resolved_at), note: (notes || []).some((n) => /Watchtower alert dismissed by .*R88 probe — reason given/.test(n.body)) };
      }, [xCrit.id, X.caseId]);
      ok("B9 · Dismiss on a critical asks for a reason (the prompt) and writes it to the case", dialogs === 1 && afterDismiss.resolved && afterDismiss.note, JSON.stringify({ ...afterDismiss, dialogs }));
      /* Snooze… on a critical — the mandatory-reason overlay. */
      await page.click(`#briefing-list .brief-row[data-alert-id="${wCrit.id}"] > .brief-wt-snooze`);
      await page.waitForTimeout(500);
      const ovl = await page.evaluate(() => ({ reason: !!document.getElementById("snooze-reason"), vis: !!(document.getElementById("snooze-reason") && document.getElementById("snooze-reason").checkVisibility()) }));
      ok("B10 · Snooze… on a critical opens the snooze overlay with its required reason box", ovl.reason && ovl.vis, JSON.stringify(ovl));
      await page.click("#snooze-ok");
      await page.waitForTimeout(200);
      const err = await page.evaluate(() => (document.getElementById("snooze-err") || {}).textContent || "");
      ok("B11 · …and refuses to snooze without a date and a reason", /Choose a date|reason is required/i.test(err), err);
      await page.click("#snooze-cancel");
      await page.waitForTimeout(300);
      /* Add next step → the case's task composer, focused. */
      await page.click(`#briefing-list .brief-row[data-case="${Z.caseId}"] > .brief-add-step`);
      await page.waitForTimeout(1800);
      const composer = await page.evaluate(() => {
        const inp = document.getElementById("new-task");
        const r = inp ? inp.getBoundingClientRect() : null;
        return { modal: currentModal && currentModal.type, id: currentModal && currentModal.id, has: !!inp, focused: document.activeElement === inp, inView: !!r && r.top >= 0 && r.bottom <= window.innerHeight };
      });
      ok("B12 · “Add next step” opens THAT case's task composer, focused and in view",
        composer.modal === "case" && composer.id === Z.caseId && composer.has && composer.focused && composer.inView, JSON.stringify(composer));
      await page.fill("#new-task", "Ring about the product transfer");
      await page.click("#add-task-btn");
      await page.waitForTimeout(900);
      await page.evaluate(() => window.closeModal && window.closeModal());
      await goPage(page, "pipeline", 600);
      await goPage(page, "dashboard", 3000);
      const zAfter = await page.evaluate((id) => ({ radar: !!document.querySelector(`#briefing-list [data-radar="${id}"]`), src: window.__todaySources().radar.includes(id) }), Z.caseId);
      ok("B13 · …and once it has a next step the case leaves the no-next-action set", !zAfter.radar && !zAfter.src, JSON.stringify(zAfter));
      ok("§B · no console/page errors", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.__ctx.close();
    }

    /* =====================================================================
       §C — THE PHONE (p4, 390×844)
       ===================================================================== */
    console.log("\n— §C · the phone (p4, 390×844)");
    {
      const page = await boot(browser, "p4", { viewport: PHONE });
      const m = await page.evaluate(() => {
        const r = document.querySelector("#briefing-list .brief-row");
        const sideBtns = [...document.querySelectorAll("#briefing-list .brief-side button")].filter((b) => b.checkVisibility());
        const sum = document.querySelector("#watchtower-panel > summary");
        return {
          top: r ? Math.round(r.getBoundingClientRect().top) : null,
          sw: document.documentElement.scrollWidth, vw: window.innerWidth,
          sideN: sideBtns.length, sideMin: sideBtns.length ? Math.min(...sideBtns.map((b) => Math.round(b.getBoundingClientRect().height))) : null,
          sumH: sum ? Math.round(sum.getBoundingClientRect().height) : null,
        };
      });
      ok("C1 · the first My Day row is above the fold on a phone", m.top != null && m.top < 844, JSON.stringify(m));
      ok("C2 · nothing scrolls sideways", m.sw <= m.vw, JSON.stringify(m));
      ok("C3 · every sub-line verb is a 44px tap target", m.sideN > 0 && m.sideMin >= 44, JSON.stringify(m));
      ok("C4 · the Checks drawer's summary is a 44px tap target", m.sumH >= 44, JSON.stringify(m));
      ok("§C · no console/page errors (phone)", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.__ctx.close();
    }

    /* =====================================================================
       §D — THE ADVISER (p2) SEES ONLY THEIR OWN
       ===================================================================== */
    console.log("\n— §D · an adviser's one list is their own (p2)");
    {
      const page = await boot(browser, "p2");
      const d = await page.evaluate(() => {
        const s = window.__todaySources();
        const bk = window.__bookPeek();
        const adv = (id) => { const c = bk && bk.caseById && bk.caseById.get(id); return c ? c.assigned_to : null; };
        const rows = [...document.querySelectorAll("#briefing-list .brief-row:not(.brief-subrow)")];
        const first = rows[0];
        return {
          scope: s.scope, wt: s.wt.length, radar: s.radar.length,
          wtOther: s.wt.filter((a) => !a.synth && (!a.case_id || adv(a.case_id) !== "p2")).length,
          radarOther: s.radar.filter((id) => adv(id) !== "p2").length,
          ownersOther: rows.map((r) => r.dataset.briefOwner).filter((o) => o && o !== "p2").length,
          rows: rows.length, exp: null, src: s,
          top: first ? Math.round(first.getBoundingClientRect().top) : null,
        };
      });
      eq("D1 · an adviser's My Day starts on Mine", d.scope, "mine");
      ok("D2 · fixture · p2 has alerts and quiet cases of their own on the list", d.wt > 0 && d.radar > 0, JSON.stringify({ wt: d.wt, radar: d.radar }));
      eq("D3 · every folded-in alert is on a case assigned to p2 — no firm-level check, nobody else's", d.wtOther, 0);
      eq("D4 · every radar case is p2's", d.radarOther, 0);
      eq("D5 · no row on the list is owned by anybody else", d.ownersOther, 0);
      eq("D6 · p2's merged row count is the union by case of their three sources", d.rows, expectedRows(d.src).n);
      ok("D7 · p2's first row is at ≤ 380px", d.top != null && d.top <= 380, `top=${d.top}`);
      await page.click("#brief-scope-all");
      await page.waitForTimeout(1500);
      const all = await page.evaluate(() => {
        const s = window.__todaySources();
        const bk = window.__bookPeek();
        const adv = (id) => { const c = bk && bk.caseById && bk.caseById.get(id); return c ? c.assigned_to : null; };
        return { scope: s.scope, radarOther: s.radar.filter((id) => adv(id) !== "p2").length, wtFirm: s.wt.filter((a) => !a.case_id).length };
      });
      ok("D8 · under All the radar is STILL p2's own book (R17's rule), and no firm-level check appears", all.scope === "all" && all.radarOther === 0 && all.wtFirm === 0, JSON.stringify(all));
      ok("§D · no console/page errors (p2)", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.__ctx.close();
    }
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  }

  console.log(`\nR88 TODAY: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
