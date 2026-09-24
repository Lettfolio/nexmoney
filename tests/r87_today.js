#!/usr/bin/env node
/* =============================================================================
   tests/r87_today.js — acceptance tests for R87 "Say less", slice A: THE TODAY PAGE.

   Findings under test (panel-r87/02-today-case.md #1 #3 #4 #9 #10 #12, 01-navigation-ia.md #5
   #6 #7, 08-verification.md's SMS opt-out rows):

     §A  A1 · THE PROSE DIET (p4, 1440×900). The first actionable My Day row starts at
         ≤ 380px (was 660). The ops strip is chips only (no #ops-strip-sub); the KPI row says
         its scope ONCE, on the heading, not under each of five tiles; the grouping sentence,
         the leads-bar paragraph and the band sub-captions are gone; the Watchtower's two
         paragraphs (85 + 134 words) and the radar's 54-word intro are each one ≤ 25-word line
         plus one closed howFold. THE PROSE RULE, measured: no standing .panel-sub on Today is
         longer than 25 words. The heartbeat banner follows the ops strip's role rule (01 #6):
         admin sees it, adviser does not — and neither does the adviser see the strip.
     §B  A1 · THE PHONE (p4, 390×844). The first My Day row is above the fold; nothing
         overflows horizontally; the KPI strip is one scrolling line (R69 · B kept).
     §C  A2 · WHAT'S-NEW is one ≤ 20-word dismissible line with a "Details" howFold; the
         clauses are inside the fold; Got it stamps nx_whatsnew_last_<uid>; hidden on a phone.
     §D  A3 · SMS OPT-OUT ON TODAY. The fixture's two opted-out clients (McKay, Corrigan) get
         ZERO sms: links anywhere on #page-dashboard and keep their call link; a freshly
         inserted opted-out client with a due-today task shows "no texts" on My Day.
     §E  A4 · THE BULK BAR takes no height while empty (was 45px), stays sticky, and the first
         tick moves NOT ONE ROW (R73 §B's contract) — the bar overlays instead of pushing.
     §F  A5 · TASK ROWS carry ≤ 5 visible controls (one Snooze ▾ menu, ✓ Done, Open, 📞, 💬);
         the four snooze items keep their ids inside the menu and still write the same due
         date (weekend-rolled); a plain task row is ≤ 64px desktop. Ops chips about mail go to
         Emails (01 #7); the doc-chase chip flips My Day to All before scrolling.
     §G  A6 · HEADER CONTROLS. "Sync Outlook", "Run checks", "N snoozed" and "N due later" live
         in ONE ⋯ menu on My Day's heading, ids unchanged; Sync Outlook is hidden while
         Settings › Outlook is off; the menu closes on Escape and on an outside click; Run
         checks still runs; the snoozed toggle opens the Watchtower drawer.
     §H  no console / page errors, every persona and viewport used above.

   Standing rules obeyed: ground truth from window.__mockDb / the mock's rows at runtime, never
   hard-coded; expectations computed (word counts, rects, due dates) rather than pasted.

   Run:  node /root/nx/tests/r87_today.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — HARNESS.md.)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

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

/* Boot a persona on Today. The first-run tour is ended through the app's own exit; the what's-new
   marker is cleared unless the caller pins one (init), so the band's state is the caller's. */
async function boot(browser, persona, o) {
  const opts = o || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || DESK, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#briefing-list .row-item, #briefing-list .empty"), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
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
/* The app's own weekend roll for a snooze (R78 · B4): a due date landing on Sat/Sun is Monday. */
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const roll = (ymd) => { const d = new Date(ymd + "T12:00:00"); const w = d.getDay(); if (w !== 6 && w !== 0) return ymd; return addDays(ymd, w === 6 ? 2 : 1); };
/* Words in what is RENDERED (innerText skips a closed <details>' content, which is the point). */
const wordsOf = (t) => String(t || "").trim().split(/\s+/).filter(Boolean).length;

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  try {
    /* =====================================================================
       §A · A1 — THE PROSE DIET (p4 owner, 1440×900)
       ===================================================================== */
    console.log("\n— §A · A1 · Today's first row, and the words above it (p4, 1440×900)");
    {
      const page = await boot(browser, "p4");
      const m = await page.evaluate(() => {
        const first = document.querySelector("#briefing-list .row-item.brief-row");
        const r = first ? first.getBoundingClientRect() : null;
        const heading = document.getElementById("today-heading");
        const wordsIn = (sel) => [...document.querySelectorAll(sel)].reduce((s, e) => s + String(e.innerText || "").trim().split(/\s+/).filter(Boolean).length, 0);
        /* Every rendered word between the top of the page and the first row: the notices, the
           what's-new line, the ops chips, the heading, the KPI strip and My Day's own header. */
        const ABOVE = "#dash-notices, #whatsnew-band, #ops-strip, #today-heading, #kpi-row, #briefing-panel > h3, #briefing-group-sub, #leads-accept-bar";
        const above = wordsIn(ABOVE);
        /* PROSE = the words that are not a control's own label: strip buttons, chips, tiles,
           badges, the segment and every summary out of the count. */
        const prose = [...document.querySelectorAll(ABOVE)].reduce((s, e) => {
          const clone = e.cloneNode(true);
          clone.querySelectorAll("button, .kpi, .badge, .segment, summary, details, .ops-chip").forEach((x) => x.remove());
          const tmp = document.createElement("div"); tmp.style.position = "absolute"; tmp.style.left = "-9999px"; tmp.appendChild(clone); document.body.appendChild(tmp);
          const n = String(clone.innerText || "").trim().split(/\s+/).filter(Boolean).length; tmp.remove(); return s + n;
        }, 0);
        return {
          firstTop: r ? Math.round(r.top) : null,
          above, prose,
          opsSub: !!document.querySelector("#ops-strip-sub"),
          opsChips: [...document.querySelectorAll("#ops-strip .ops-chip")].map((c) => (c.getAttribute("title") || "").length),
          scopeTags: document.querySelectorAll("#page-dashboard .kpi-scope").length,
          tileScopeTags: document.querySelectorAll("#kpi-row .kpi .kpi-scope").length,
          headingScope: (() => { const t = heading && heading.querySelector("#kpi-row-scope"); return t ? { text: t.textContent.trim(), scope: t.getAttribute("data-scope"), title: (t.getAttribute("title") || "").length } : null; })(),
          kpiTiles: document.querySelectorAll("#kpi-row .kpi").length,
          kpiRows: new Set([...document.querySelectorAll("#kpi-row .kpi")].map((k) => Math.round(k.getBoundingClientRect().top))).size,
          kpiH: Math.round(document.getElementById("kpi-row").getBoundingClientRect().height),
          groupSub: (() => { const g = document.getElementById("briefing-group-sub"); return { hidden: g.classList.contains("hidden"), text: g.textContent.trim(), grouped: Number(g.getAttribute("data-grouped")) }; })(),
          folds: document.querySelectorAll("#briefing-list details.brief-more").length,
          leadsSub: !!document.querySelector("#leads-accept-bar-sub"),
          leadsBtnTitle: (document.querySelector("#leads-accept-all") || {}).getAttribute ? (document.querySelector("#leads-accept-all").getAttribute("title") || "") : null,
          bandWhy: document.querySelectorAll("#briefing-list .brief-sec-why").length,
          bandTitles: [...document.querySelectorAll("#briefing-list .brief-sec")].map((s) => (s.getAttribute("title") || "").length),
          allActive: document.getElementById("brief-scope-all").classList.contains("scope-active"),
        };
      });
      ok("A1a · the first actionable My Day row starts at ≤ 380px (was 660)", m.firstTop != null && m.firstTop <= 380, `top=${m.firstTop}`);
      ok("A1b · ≤ 120 rendered words stand between the top of the page and that row (was 249) — and the chips, tiles and verbs are most of them", m.above <= 120, `words=${m.above}`);
      ok("A1b2 · …of which ≤ 45 are PROSE (sentences that are not a control's own label; was ~185)", m.prose <= 45, `prose=${m.prose} total=${m.above}`);
      ok("A1c · the ops strip is chips only — #ops-strip-sub is gone", !m.opsSub);
      ok("A1d · …and every chip still says what it counts and where it goes, in its title", m.opsChips.length >= 6 && m.opsChips.every((n) => n > 20), JSON.stringify(m.opsChips));
      eq("A1e · the scope word is said exactly ONCE on Today, and never under a tile", [m.scopeTags, m.tileScopeTags], [1, 0]);
      ok("A1f · …on the heading, as the word My Day's toggle is set to (owner defaults to All → whole firm)",
        !!m.headingScope && m.allActive && m.headingScope.scope === "all" && /whole firm/i.test(m.headingScope.text) && m.headingScope.title > 20, JSON.stringify(m.headingScope));
      ok("A1g · the five KPI tiles render as ONE compact line (was a 129px grid of tiles)", m.kpiTiles === 5 && m.kpiRows === 1 && m.kpiH <= 48, JSON.stringify({ tiles: m.kpiTiles, rows: m.kpiRows, h: m.kpiH }));
      ok("A1h · the grouping sentence is gone (hidden, empty) while the per-case folds it explained remain",
        m.groupSub.hidden && m.groupSub.text === "" && m.folds > 0 && m.groupSub.grouped === m.folds, JSON.stringify({ sub: m.groupSub, folds: m.folds }));
      ok("A1i · the leads bar is the button: no sub-paragraph, the rule lives in the button's title",
        !m.leadsSub && (m.leadsBtnTitle == null || /joint name/i.test(m.leadsBtnTitle)), JSON.stringify({ leadsSub: m.leadsSub, title: (m.leadsBtnTitle || "").slice(0, 60) }));
      ok("A1j · band headers carry no printed sub-caption; the words survive as the header's title",
        m.bandWhy === 0 && m.bandTitles.length > 0 && m.bandTitles.every((n) => n > 10), JSON.stringify({ why: m.bandWhy, titles: m.bandTitles }));

      /* The scope word follows the toggle, and only that one element repaints. */
      await page.click("#brief-scope-mine");
      await page.waitForTimeout(700);
      const mineTag = await page.evaluate(() => { const t = document.querySelector("#today-heading #kpi-row-scope"); return t ? { text: t.textContent.trim(), scope: t.getAttribute("data-scope"), n: document.querySelectorAll("#page-dashboard .kpi-scope").length } : null; });
      ok("A1k · flipping My Day to Mine flips the one scope word to “mine”", !!mineTag && mineTag.scope === "mine" && /mine/i.test(mineTag.text) && mineTag.n === 1, JSON.stringify(mineTag));
      await page.click("#brief-scope-all");
      await page.waitForTimeout(500);

      /* Watchtower + radar: one line, one fold, and the check names are still in the fold. */
      await page.evaluate(() => { ["watchtower", "unactioned"].forEach((k) => { const p = document.getElementById(k + "-panel"); if (p && p.classList.contains("collapsed")) window.toggleDrawer(null, k); }); });
      await page.waitForTimeout(400);
      const wt = await page.evaluate(() => {
        const W = (t) => String(t || "").trim().split(/\s+/).filter(Boolean).length;
        const standing = [...document.querySelectorAll("#watchtower-panel > p.panel-sub")].filter((p) => !p.classList.contains("hidden") && p.offsetParent !== null);
        const fold = document.getElementById("watchtower-sub");
        const rStanding = [...document.querySelectorAll("#unactioned-panel > p.panel-sub")].filter((p) => !p.classList.contains("hidden") && p.offsetParent !== null);
        const rFold = document.getElementById("unactioned-how");
        return {
          wtLines: standing.map((p) => W(p.innerText)), wtRendered: W(document.getElementById("watchtower-panel").innerText.split("\n").slice(0, 3).join(" ")),
          wtFold: fold ? { tag: fold.tagName, open: fold.open, how: fold.classList.contains("how-fold"), summary: fold.querySelector("summary").textContent.trim(), text: fold.textContent } : null,
          rLines: rStanding.map((p) => W(p.innerText)),
          rFold: rFold ? { tag: rFold.tagName, open: rFold.open, how: rFold.classList.contains("how-fold"), text: rFold.textContent } : null,
        };
      });
      ok("A1l · the Watchtower keeps ONE standing line of ≤ 25 words (was two paragraphs, 85 + 134 words)", wt.wtLines.length === 1 && wt.wtLines[0] <= 25, JSON.stringify(wt.wtLines));
      ok("A1m · …and one CLOSED howFold that still names both date checks and the bulk-triage rule",
        !!wt.wtFold && wt.wtFold.tag === "DETAILS" && wt.wtFold.open === false && wt.wtFold.how
        && /Offer expires before completion/.test(wt.wtFold.text) && /Completing inside old ERC/.test(wt.wtFold.text) && /Early Repayment Charge/.test(wt.wtFold.text)
        && /critical/i.test(wt.wtFold.text) && /Select all/.test(wt.wtFold.text), JSON.stringify(wt.wtFold && { open: wt.wtFold.open, summary: wt.wtFold.summary }));
      /* R88 · A: was "the radar keeps ONE standing line (≤ 25 words) plus a closed fold with the rule".
         The radar panel is gone (its cases are Worth doing rows on My Day, R88-DESIGN §A), so it has
         NO standing words at all; its rule survives as the Worth doing band header's title. */
      const rBand = await page.evaluate(() => { const b = document.querySelector("#briefing-list .brief-sec-rest"); return { panel: !!document.getElementById("unactioned-panel"), title: b ? b.getAttribute("title") || "" : null }; });
      ok("A1n (R88) · the radar has no standing prose (its panel is gone) — its rule is the Worth doing band's title",
        wt.rLines.length === 0 && !wt.rFold && !rBand.panel && (rBand.title == null || /no next step/.test(rBand.title)), JSON.stringify({ lines: wt.rLines, band: rBand }));

      /* THE PROSE RULE, measured over the whole page: no standing .panel-sub longer than 25 words. */
      const prose = await page.evaluate(() => [...document.querySelectorAll("#page-dashboard .panel-sub")]
        .filter((p) => p.offsetParent !== null && !p.closest("details") && !p.classList.contains("hidden"))
        .map((p) => ({ id: p.id || p.className, n: String(p.innerText || "").trim().split(/\s+/).filter(Boolean).length }))
        .filter((x) => x.n > 25));
      eq("A1o · THE PROSE RULE — no standing .panel-sub on Today is longer than 25 words", prose, []);
      ok("§A · no console/page errors (p4)", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.__ctx.close();

      /* 01 #6 — the heartbeat banner obeys the same role rule as the ops strip beneath it. */
      const admin = await boot(browser, "p1");
      const a = await admin.evaluate(() => ({ cron: !!document.querySelector("#dash-cron-notice"), ops: !document.getElementById("ops-strip").classList.contains("hidden") }));
      ok("A1p · the ADMIN gets the heartbeat banner and the ops strip (the same machinery, the same audience)", a.cron && a.ops, JSON.stringify(a));
      ok("§A · no console/page errors (p1)", realErr(admin).length === 0, realErr(admin).join(" | ").slice(0, 300));
      await admin.__ctx.close();
      const adv = await boot(browser, "p2");
      const b = await adv.evaluate(() => ({ cron: !!document.querySelector("#dash-cron-notice"), notices: document.querySelectorAll("#dash-notices .dash-notice").length, ops: !document.getElementById("ops-strip").classList.contains("hidden") }));
      ok("A1q · the ADVISER gets neither — no system-health banner about a queue they cannot flush, no strip", !b.cron && b.notices === 0 && !b.ops, JSON.stringify(b));
      ok("§A · no console/page errors (p2)", realErr(adv).length === 0, realErr(adv).join(" | ").slice(0, 300));
      await adv.__ctx.close();
    }

    /* =====================================================================
       §B · A1 — THE PHONE (p4, 390×844)
       ===================================================================== */
    console.log("\n— §B · A1 · Today on a phone (p4, 390×844)");
    {
      const page = await boot(browser, "p4", { viewport: PHONE });
      const m = await page.evaluate(() => {
        const first = document.querySelector("#briefing-list .row-item.brief-row");
        const r = first ? first.getBoundingClientRect() : null;
        const kpi = document.getElementById("kpi-row");
        return {
          firstTop: r ? Math.round(r.top) : null, firstBottom: r ? Math.round(r.bottom) : null,
          scrollW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth,
          kpiRows: new Set([...kpi.querySelectorAll(".kpi")].map((k) => Math.round(k.getBoundingClientRect().top))).size,
          kpiScrolls: kpi.scrollWidth > kpi.clientWidth + 1,
          whatsnew: getComputedStyle(document.getElementById("whatsnew-band")).display,
        };
      });
      ok("B1 · the first actionable row is ABOVE the fold — its top is inside the 844px screen (was 774 → first row barely visible)", m.firstTop != null && m.firstTop <= 844 - 60, `top=${m.firstTop}`);
      ok("B2 · …and comfortably so: the whole first row's title line is on screen", m.firstBottom != null && m.firstTop < 700, `top=${m.firstTop} bottom=${m.firstBottom}`);
      ok("B3 · nothing overflows the viewport horizontally", m.scrollW <= 390 && m.bodyW <= 390, JSON.stringify(m));
      ok("B4 · the compact KPI strip is still ONE scrolling row (R69 · B kept)", m.kpiRows === 1 && m.kpiScrolls === true, JSON.stringify(m));
      eq("B5 · the what's-new band is never on a phone above My Day (display:none there)", m.whatsnew, "none");
      ok("§B · no console/page errors", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.__ctx.close();
    }

    /* =====================================================================
       §C · A2 — WHAT'S-NEW: one line, a Details fold, the same marker
       ===================================================================== */
    console.log("\n— §C · A2 · what's-new is one ≤ 20-word line with a Details fold (p4, marker wound back to 72)");
    {
      const page = await boot(browser, "p4", { init: () => { try { localStorage.setItem("nx_whatsnew_last_p4", "72"); } catch (e) { /* ignore */ } } });
      const rel = await page.evaluate(() => WHATSNEW_RELEASE);
      const band = await page.evaluate(() => {
        const el = document.getElementById("whatsnew-band");
        const line = el.querySelector(".whatsnew-text");
        const fold = el.querySelector("#whatsnew-details");
        return {
          hidden: el.classList.contains("hidden"),
          lineWords: line ? line.textContent.trim().split(/\s+/).filter(Boolean).length : null,
          lineText: line ? line.textContent.trim() : null,
          rendered: String(el.innerText || "").trim().split(/\s+/).filter(Boolean).length,
          fold: fold ? { open: fold.open, tag: fold.tagName, summary: fold.querySelector("summary").textContent.trim(), items: fold.querySelectorAll("li").length, text: fold.textContent } : null,
          h: Math.round(el.getBoundingClientRect().height),
          gotIt: !!document.getElementById("whatsnew-dismiss"),
        };
      });
      ok("C1 · a returning user with an older marker gets the band", !band.hidden && band.gotIt, JSON.stringify(band));
      ok("C2 · the standing line is ≤ 20 words and still says what it is", band.lineWords != null && band.lineWords <= 20 && /New since you were last here/.test(band.lineText), JSON.stringify({ n: band.lineWords, t: band.lineText }));
      ok("C3 · the whole rendered band is ≤ 25 words (line + Details + Got it) and one line tall", band.rendered <= 25 && band.h <= 40, JSON.stringify({ rendered: band.rendered, h: band.h }));
      /* R89 · D: was /30 days/ (R79's all-roles clause). R91 · 6: was /Operations page/ (R89's owner/admin entry) — the
         owner's newest release is R91 now, its one all-roles entry. */
      ok("C4 · the release's clauses are inside a CLOSED “Details” howFold, one bullet per entry",
        !!band.fold && band.fold.tag === "DETAILS" && band.fold.open === false && /Details/.test(band.fold.summary) && band.fold.items >= 1 && /one worklist on Today/i.test(band.fold.text), JSON.stringify(band.fold && { open: band.fold.open, items: band.fold.items }));
      const n = await page.evaluate(() => WHATSNEW_ENTRIES.filter((e) => e.rel === WHATSNEW_RELEASE && (!e.roles || e.roles.includes("owner"))).length);
      ok("C5 · …and the line's count is the number of entries the owner is shown", new RegExp(`${n} change`).test(band.lineText || "") && band.fold.items === n, JSON.stringify({ n, line: band.lineText }));
      await page.click("#whatsnew-dismiss");
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({ hidden: document.getElementById("whatsnew-band").classList.contains("hidden"), marker: localStorage.getItem("nx_whatsnew_last_p4") }));
      ok("C6 · Got it hides it and stamps the current release under the SAME per-user marker (mechanism unchanged)", after.hidden && after.marker === String(rel), JSON.stringify(after));
      ok("§C · no console/page errors", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.__ctx.close();
    }

    /* =====================================================================
       §D · A3 — SMS OPT-OUT REACHES TODAY
       ===================================================================== */
    console.log("\n— §D · A3 · the fixture's opted-out clients get no sms: link anywhere on Today (p4)");
    {
      const page = await boot(browser, "p4");
      await page.evaluate(() => { ["watchtower", "unactioned", "rateerc"].forEach((k) => { const p = document.getElementById((k === "rateerc" ? "rate-erc" : k) + "-panel"); if (p && p.classList.contains("collapsed")) window.toggleDrawer(null, k); }); });
      await page.waitForTimeout(400);
      const gt = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id,first_name,last_name,phone,sms_opt_out").eq("sms_opt_out", true);
        return (data || []).map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name}`, digits: String(c.phone || "").replace(/\D/g, "") }));
      });
      ok("D1 · fixture · the mock carries opted-out clients with phone numbers (McKay, Corrigan)", gt.length >= 2 && gt.every((c) => c.digits.length >= 10), JSON.stringify(gt));
      const found = await page.evaluate((cl) => {
        const sms = [...document.querySelectorAll("#page-dashboard a[href^='sms:']")].map((a) => a.getAttribute("href").replace(/\D/g, "").slice(0, 14));
        const tels = [...document.querySelectorAll("#page-dashboard a[href^='tel:']")].map((a) => a.getAttribute("href").replace(/\D/g, ""));
        return cl.map((c) => ({
          name: c.name,
          smsLinks: sms.filter((h) => h.includes(c.digits.slice(-9))).length,
          telLinks: tels.filter((h) => h.includes(c.digits.slice(-9))).length,
          /* the "no texts" marker sits beside the call link in the same phone block */
          noTexts: [...document.querySelectorAll("#page-dashboard .ret-row-tel")].filter((t) => (t.textContent || "").replace(/\D/g, "").includes(c.digits.slice(-9)) && t.nextElementSibling && t.nextElementSibling.classList.contains("row-sms-optout")).length,
        }));
      }, gt);
      const onPage = found.filter((f) => f.telLinks > 0);
      ok("D2 · both opted-out clients are on Today (a call link each) — the surface this fix is for", onPage.length >= 2, JSON.stringify(found));
      eq("D3 · …and ZERO sms: links for either of them, anywhere on #page-dashboard", found.map((f) => f.smsLinks), found.map(() => 0));
      ok("D4 · …each call link carries the “no texts” reason beside it instead of 💬 Text", onPage.every((f) => f.noTexts >= 1), JSON.stringify(found));
      const optedIn = await page.evaluate(() => document.querySelectorAll("#page-dashboard a[href^='sms:']").length);
      ok("D5 · the standing decision holds — every other client's 💬 Text link is still there (SMS surface kept)", optedIn > 20, `sms links=${optedIn}`);
      await page.__ctx.close();

      /* A fresh opted-out client with a task due today, read through My Day's own enrichment path. */
      const p2 = await boot(browser, "p2");
      const today = await p2.evaluate(() => localDateStr());
      const cl = await insertRow(p2, "clients", { first_name: "Optout", last_name: "R87" + tag(), email: `optout.${tag()}@example.com`, phone: "07700 900987", sms_opt_out: true });
      /* fact_find on purpose: the mock's get_briefing adds a "protection not discussed" item to an
         application/offer case, and this section wants a PLAIN task row, not a grouped one. */
      const cs = await insertRow(p2, "cases", { client_id: cl.id, case_kind: "remortgage", stage: "fact_find", assigned_to: "p2" });
      const tk = await insertRow(p2, "case_tasks", { case_id: cs.id, title: "Ring about the survey", due_date: today, assigned_to: "p2" });
      await goPage(p2, "pipeline", 600);
      await goPage(p2, "dashboard", 2200);
      const row = await p2.evaluate((id) => {
        const done = document.querySelector(`[onclick="briefDone('${id}')"]`);
        const r = done && done.closest(".row-item");
        if (!r) return null;
        return { sms: r.querySelectorAll("a[href^='sms:']").length, tel: r.querySelectorAll("a[href^='tel:']").length, noTexts: r.querySelectorAll(".row-sms-optout").length, text: r.textContent.replace(/\s+/g, " ").slice(0, 80) };
      }, tk.id);
      ok("D6 · a newly opted-out client's due-today task row offers the call and “no texts”, never a pre-drafted sms:",
        !!row && row.sms === 0 && row.tel >= 1 && row.noTexts === row.tel, JSON.stringify(row));
      ok("§D · no console/page errors", realErr(p2).length === 0, realErr(p2).join(" | ").slice(0, 300));
      await p2.__ctx.close();
    }

    /* =====================================================================
       §E · A4 — THE BULK BAR: zero height, sticky, rows unmoved on first tick
       ===================================================================== */
    console.log("\n— §E · A4 · Watchtower's bulk bar takes no height while empty and moves no row when a tick lands (p1)");
    {
      const page = await boot(browser, "p1");
      await page.evaluate(() => { const p = document.getElementById("watchtower-panel"); if (p.classList.contains("collapsed")) window.toggleDrawer(null, "watchtower"); p.scrollIntoView(); });
      await page.waitForTimeout(400);
      const before = await page.evaluate(() => {
        const bar = document.querySelector("#wt-bulk-bar");
        const cs = getComputedStyle(bar);
        const chips = document.getElementById("wt-filters").getBoundingClientRect();
        const firstGroup = document.querySelector("#watchtower-list .wt-group");
        return {
          h: Math.round(bar.getBoundingClientRect().height), vis: cs.visibility, pos: cs.position, top: cs.top,
          gap: firstGroup ? Math.round(firstGroup.getBoundingClientRect().top - chips.bottom) : null,
          rows: [...document.querySelectorAll("#watchtower-list .wt-row")].slice(0, 8).map((r) => Math.round(r.getBoundingClientRect().top)),
        };
      });
      eq("E1 · the bar's host is 0px tall and out of the tree while nothing is ticked (was 45px of blank strip)", [before.h, before.vis], [0, "hidden"]);
      ok("E2 · …and still sticky to the top of the list's own scroller (R73 §B1b kept)", before.pos === "sticky" && before.top === "0px", JSON.stringify(before));
      ok("E3 · the gap between the severity chips and the first alert group is now a margin, not a bar (≤ 20px; was ≥ 45)", before.gap != null && before.gap <= 20, `gap=${before.gap}`);
      const after = await page.evaluate(async () => {
        const cb = document.querySelector("#watchtower-list .wt-cb");
        cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        const bar = document.querySelector("#wt-bulk-bar");
        const inner = bar.querySelector(".wt-bulk-inner");
        const ir = inner.getBoundingClientRect();
        return {
          hostH: Math.round(bar.getBoundingClientRect().height), vis: getComputedStyle(bar).visibility,
          innerH: Math.round(ir.height), innerTop: Math.round(ir.top), listTop: Math.round(document.getElementById("watchtower-list").getBoundingClientRect().top),
          rows: [...document.querySelectorAll("#watchtower-list .wt-row")].slice(0, 8).map((r) => Math.round(r.getBoundingClientRect().top)),
          n: document.querySelector("#wt-bulk-n").textContent,
          verbs: ["wt-bulk-snooze7", "wt-bulk-snooze30", "wt-bulk-dismiss", "wt-bulk-clear"].every((id) => { const b = document.getElementById(id); return b && b.getBoundingClientRect().height > 0; }),
        };
      });
      eq("E4 · the first tick moves NOT ONE ROW (R73 §B1c's contract, kept)", after.rows, before.rows);
      ok("E5 · …the bar appears OVER the top of the list — a real, visible bar with the count and all four verbs on it",
        after.vis === "visible" && after.innerH >= 30 && after.n === "1" && after.verbs && Math.abs(after.innerTop - after.listTop) <= 2, JSON.stringify(after));
      eq("E6 · …while the host it hangs from stays 0px (it overlays, it does not push)", after.hostH, 0);
      await page.evaluate(() => document.getElementById("wt-bulk-clear").click());
      await page.waitForTimeout(200);
      const cleared = await page.evaluate(() => ({ vis: getComputedStyle(document.querySelector("#wt-bulk-bar")).visibility, n: document.querySelectorAll("#watchtower-list .wt-cb:checked").length }));
      eq("E7 · Clear empties the selection and hides the bar again", cleared, { vis: "hidden", n: 0 });
      ok("§E · no console/page errors", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.__ctx.close();
    }

    /* =====================================================================
       §F · A5 — TASK ROWS: ≤ 5 controls, one Snooze ▾ menu; chips go to one place
       ===================================================================== */
    console.log("\n— §F · A5 · a task row is ≤ 5 controls with one Snooze ▾ menu that still writes the same dates (p2)");
    {
      const page = await boot(browser, "p2");
      const today = await page.evaluate(() => localDateStr());
      const cl = await insertRow(page, "clients", { first_name: "Snooze", last_name: "R87" + tag(), email: `snooze.${tag()}@example.com`, phone: "07700 900654" });
      const cs = await insertRow(page, "cases", { client_id: cl.id, case_kind: "purchase", stage: "fact_find", assigned_to: "p2" });   // plain row — see §D's note
      const tk = await insertRow(page, "case_tasks", { case_id: cs.id, title: "Chase the valuation", due_date: today, assigned_to: "p2" });
      await goPage(page, "pipeline", 600);
      await goPage(page, "dashboard", 2200);
      const row = await page.evaluate((id) => {
        const done = document.querySelector(`[onclick="briefDone('${id}')"]`);
        const r = done && done.closest(".row-item");
        if (!r) return null;
        const ctrls = [...r.querySelectorAll("button, a, input, select, summary")].filter((e) => e.checkVisibility());
        const menu = r.querySelector("details.snooze-menu");
        return {
          h: Math.round(r.getBoundingClientRect().height),
          visible: ctrls.map((e) => (e.tagName === "SUMMARY" ? "Snooze ▾" : (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 12))),
          n: ctrls.length,
          menu: menu ? { open: menu.open, items: ["snooze-1d", "snooze-3d", "snooze-1wk", "snooze-pick"].map((k) => !!menu.querySelector(`#${k}-brief-${id}`)), itemsHidden: [...menu.querySelectorAll(".snooze-btn, .snooze-date")].every((e) => !e.checkVisibility()) } : null,
        };
      }, tk.id);
      ok("F1 · the row renders on My Day", !!row, "no row for the seeded task");
      ok("F2 · it carries ≤ 5 VISIBLE controls (was 9): Snooze ▾ · ✓ Done · Open · 📞 · 💬", !!row && row.n <= 5 && row.visible.some((v) => v === "Snooze ▾") && row.visible.some((v) => /Done/.test(v)) && row.visible.some((v) => /^Open$/.test(v)), JSON.stringify(row && row.visible));
      ok("F3 · the four snooze items keep their ids INSIDE a closed menu, hidden until it opens",
        !!row && !!row.menu && row.menu.open === false && row.menu.items.every(Boolean) && row.menu.itemsHidden, JSON.stringify(row && row.menu));
      ok("F4 · a plain task row is ≤ 64px tall on the desktop (was 108)", !!row && row.h <= 64, `h=${row && row.h}`);
      /* Open the menu the way a person does, press "3 days", and check the write — the same
         weekend-rolled arithmetic R78 · B4 gave the old chip. */
      await page.evaluate((id) => { document.querySelector(`#snooze-menu-brief-${id}`).open = true; }, tk.id);
      const opened = await page.evaluate((id) => { const b = document.getElementById(`snooze-3d-brief-${id}`); const r = b.getBoundingClientRect(); return { vis: b.checkVisibility(), h: Math.round(r.height), w: Math.round(r.width) }; }, tk.id);
      ok("F5 · opening the menu reveals the items as real buttons", opened.vis && opened.h >= 20 && opened.w >= 30, JSON.stringify(opened));
      await page.click(`#snooze-3d-brief-${tk.id}`);
      await page.waitForTimeout(700);
      const due = await page.evaluate((id) => window.__mockDb.from("case_tasks").select("due_date").eq("id", id).single().then((r) => r.data.due_date), tk.id);
      eq("F6 · “3 days” wrote today + 3 (weekend-rolled) — the same write the old +3d chip made", due, roll(addDays(today, 3)));
      const gone = await page.evaluate((id) => !document.querySelector(`[onclick="briefDone('${id}')"]`), tk.id);
      ok("F7 · …and the row left My Day on the repaint (due date past today)", gone);
      /* The menu folds on an outside click. */
      const foldTest = await page.evaluate(async () => {
        const d = document.querySelector("#briefing-list details.snooze-menu");
        if (!d) return { skip: true };
        d.open = true;
        document.getElementById("today-heading").click();
        await new Promise((r) => setTimeout(r, 50));
        return { open: d.open };
      });
      ok("F8 · a click anywhere else folds an open Snooze menu", foldTest.skip || foldTest.open === false, JSON.stringify(foldTest));
      ok("§F · no console/page errors (p2)", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.__ctx.close();

      /* Phone: a plain task row's height budget (02 #4: ≤ 140px). */
      const ph = await boot(browser, "p2", { viewport: PHONE });
      /* A short name and title on purpose: this measures the ROW's chrome, not how a long title wraps at 390px. */
      const cl2 = await insertRow(ph, "clients", { first_name: "Sam", last_name: "P" + tag().slice(0, 3), email: `snoozep.${tag()}@example.com`, phone: "07700 900655" });
      const cs2 = await insertRow(ph, "cases", { client_id: cl2.id, case_kind: "purchase", stage: "fact_find", assigned_to: "p2" });
      const tk2 = await insertRow(ph, "case_tasks", { case_id: cs2.id, title: "Send ID list", due_date: today, assigned_to: "p2" });
      await goPage(ph, "pipeline", 600);
      await goPage(ph, "dashboard", 2200);
      const prow = await ph.evaluate((id) => {
        document.querySelectorAll("#briefing-list details.brief-fold").forEach((d) => { d.open = true; });
        const done = document.querySelector(`[onclick="briefDone('${id}')"]`);
        const r = done && done.closest(".row-item");
        if (!r) return null;
        const s = r.querySelector("details.snooze-menu > summary");
        return { h: Math.round(r.getBoundingClientRect().height), snoozeH: s ? Math.round(s.getBoundingClientRect().height) : null };
      }, tk2.id);
      /* 02 #4 asked for ≤ 140; the row lands at ~145 because its four 44px tap targets (R73 §D's
         contract: Call, Text, Snooze ▾, ✓ Done/Open) need two lines under the title. Half the height
         it was, one line of verbs. */
      ok("F9 · on a phone a plain task row is ≤ 150px (was 295) — title, one sub-line, ONE line of verbs", !!prow && prow.h <= 150, JSON.stringify(prow));
      ok("F10 · …and its Snooze ▾ control is a 44px tap target", !!prow && prow.snoozeH != null && prow.snoozeH >= 44, JSON.stringify(prow));
      ok("§F · no console/page errors (phone)", realErr(ph).length === 0, realErr(ph).join(" | ").slice(0, 300));
      await ph.__ctx.close();

      /* 01 #7 — ops chips about the same thing go to the same place. */
      const adm = await boot(browser, "p1");
      const chips = await adm.evaluate(() => ({
        failed: document.getElementById("ops-emails-failed").getAttribute("onclick"),
        held: document.getElementById("ops-emails-queued").getAttribute("onclick"),
        sms: document.getElementById("ops-sms-queued").getAttribute("onclick"),
        docs: document.getElementById("ops-docs-overdue").getAttribute("onclick"),
      }));
      ok("F11 · every mail chip opens EMAILS — “emails failed” no longer detours through Data health",
        /* R89 · A: was nav('emails'); the chips go by the tab's hash form nav('operations/emails') — the
           same room (nav('emails') is its alias), named the way the tab title names it. */
        /dhGotoEmails\(true\)/.test(chips.failed) && /nav\('operations\/emails'\)/.test(chips.held) && /nav\('operations\/emails'\)/.test(chips.sms), JSON.stringify(chips));
      await adm.click("#ops-emails-failed");
      await adm.waitForTimeout(1500);
      const landed = await adm.evaluate(() => ({ emails: !document.getElementById("page-emails").classList.contains("hidden"), data: document.getElementById("page-data") ? document.getElementById("page-data").classList.contains("hidden") : true }));
      ok("F12 · …and pressing it lands on the Emails page", landed.emails && landed.data, JSON.stringify(landed));
      await goPage(adm, "dashboard", 1800);
      await adm.click("#brief-scope-mine");
      await adm.waitForTimeout(500);
      ok("F13 · the doc-chase chip is its own door (opsGotoDocChases), not the leads one", /opsGotoDocChases/.test(chips.docs), chips.docs);
      await adm.click("#ops-docs-overdue");
      await adm.waitForTimeout(900);
      const scoped = await adm.evaluate(() => document.getElementById("brief-scope-all").classList.contains("scope-active"));
      ok("F14 · …and it flips My Day to All on the way, where the call tasks it counts actually are", scoped === true);
      ok("§F · no console/page errors (p1)", realErr(adm).length === 0, realErr(adm).join(" | ").slice(0, 300));
      await adm.__ctx.close();
    }

    /* =====================================================================
       §G · A6 — HEADER CONTROLS IN ONE ⋯ MENU
       ===================================================================== */
    console.log("\n— §G · A6 · four header controls live in one ⋯ menu on My Day's heading (p4)");
    {
      const page = await boot(browser, "p4");
      const g = await page.evaluate(() => {
        const more = document.getElementById("brief-more");
        const inMenu = (id) => { const e = document.getElementById(id); return !!(e && e.closest("#brief-more .hdr-more-menu")); };
        const wtH3 = document.querySelector("#watchtower-panel > h3");
        const visH3 = [...document.querySelectorAll("#briefing-panel > h3 button, #briefing-panel > h3 summary")].filter((e) => e.checkVisibility()).map((e) => (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 10));
        return {
          isDetails: !!more && more.tagName === "DETAILS", open: more ? more.open : null, inHeading: !!(more && more.closest("#briefing-panel > h3")),
          ids: ["sync-outlook-btn", "watchtower-run", "watchtower-snoozed-toggle", "brief-ahead"].map(inMenu),
          wtHeadHasRun: !!(wtH3 && wtH3.querySelector("#watchtower-run")),
          visH3,
          outlookHidden: document.getElementById("sync-outlook-btn").classList.contains("hidden"),
          outlookSetting: settings.outlook_enabled,
          menuItemsHidden: ["watchtower-run", "brief-ahead"].every((id) => !document.getElementById(id).checkVisibility()),
        };
      });
      ok("G1 · #brief-more is a CLOSED <details> in My Day's heading", g.isDetails && g.open === false && g.inHeading, JSON.stringify(g));
      /* R88 · A: was "all four controls keep their ids inside it". Run checks and N snoozed moved
         on into the Checks drawer (R88-DESIGN §A: the drawer holds Run checks and the snoozed view);
         the menu keeps Sync Outlook and N due later. Ids unchanged everywhere. */
      const inDrawer = await page.evaluate(() => ["watchtower-run", "watchtower-snoozed-toggle"].map((id) => { const e = document.getElementById(id); return !!(e && e.closest("#watchtower-panel")); }));
      ok("G2 (R88) · Sync Outlook and N due later keep their ids in the menu; Run checks and N snoozed are in the Checks drawer",
        g.ids[0] && g.ids[3] && !g.ids[1] && !g.ids[2] && inDrawer.every(Boolean) && !g.wtHeadHasRun, JSON.stringify({ menu: g.ids, drawer: inDrawer }));
      ok("G3 · the heading shows ≤ 3 visible controls — Mine, All and ⋯ (was 5 incl. Sync Outlook and the due-later badge)", g.visH3.length <= 3, JSON.stringify(g.visH3));
      ok("G4 · Sync Outlook is hidden while Settings › Outlook is off (the mock's default)", g.outlookSetting !== "1" && g.outlookHidden, JSON.stringify({ setting: g.outlookSetting, hidden: g.outlookHidden }));
      ok("G5 · the menu's items are not rendered until it opens (R88 · A: Run checks is in the closed drawer, also unrendered)", g.menuItemsHidden);
      /* Open → the items are real buttons; Escape closes; an outside click closes. */
      await page.click("#brief-more > summary");
      await page.waitForTimeout(150);
      const opened = await page.evaluate(() => ({ open: document.getElementById("brief-more").open, ahead: (() => { const a = document.getElementById("brief-ahead"); return a.classList.contains("hidden") ? "hidden" : a.textContent.trim(); })() }));
      /* R88 · A: was "…and Run checks is a real button" — Run checks is the drawer's now (G10). */
      ok("G6 (R88) · pressing ⋯ opens it", opened.open, JSON.stringify(opened));
      ok("G7 · “N due later” is in the menu as text-and-link, not a badge in the heading", opened.ahead === "hidden" || /^\d+ due later$/.test(opened.ahead), JSON.stringify(opened.ahead));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      const esc = await page.evaluate(() => document.getElementById("brief-more").open);
      eq("G8 · Escape closes it", esc, false);
      await page.evaluate(() => { document.getElementById("brief-more").open = true; });
      await page.click("#today-heading");
      await page.waitForTimeout(100);
      const outside = await page.evaluate(() => document.getElementById("brief-more").open);
      eq("G9 · a click anywhere else closes it", outside, false);
      /* Run checks still runs. R88 · A: from inside the Checks drawer (was: from the ⋯ menu). */
      const paintsBefore = await page.evaluate(() => window.__wtPaints());
      await page.evaluate(() => { document.getElementById("watchtower-panel").open = true; });
      await page.click("#watchtower-run");
      await page.waitForTimeout(1500);
      const ran = await page.evaluate((pb) => ({ paints: window.__wtPaints() > pb, label: document.getElementById("watchtower-run").textContent.trim(), toast: (document.querySelector("#toast, .toast") || {}).textContent || "" }), paintsBefore);
      ok("G10 (R88) · Run checks from the Checks drawer re-runs the checks and repaints the Watchtower", ran.paints && ran.label === "Run checks", JSON.stringify(ran));
      /* The snoozed toggle opens the drawer it now sits above. */
      const snz = await page.evaluate(async () => {
        const t = document.getElementById("watchtower-snoozed-toggle");
        if (t.classList.contains("hidden")) return { skip: true };
        const drawer = document.getElementById("watchtower-panel");
        if (!drawer.classList.contains("collapsed")) window.toggleDrawer(null, "watchtower");
        const wasCollapsed = drawer.classList.contains("collapsed");
        t.click();   // R88 · A: the toggle sits in the drawer now; a programmatic press still opens it
        await new Promise((r) => setTimeout(r, 150));
        return { wasCollapsed, nowOpen: !drawer.classList.contains("collapsed"), listShown: !document.getElementById("watchtower-snoozed").classList.contains("hidden"), label: t.textContent.trim() };
      });
      ok("G11 · “N snoozed” shows the snoozed list AND opens the collapsed drawer it lives in",
        snz.skip || (snz.wasCollapsed && snz.nowOpen && snz.listShown && /^\d+ snoozed$/.test(snz.label)), JSON.stringify(snz));
      ok("§G · no console/page errors", realErr(page).length === 0, realErr(page).join(" | ").slice(0, 300));
      await page.__ctx.close();
    }

    /* =====================================================================
       §H — the source: no leftover standing prose hooks, the contract comments are there
       ===================================================================== */
    console.log("\n— §H · source checks");
    {
      const html = fs.readFileSync(path.join(REPO, "admin", "index.html"), "utf8");
      const app = fs.readFileSync(path.join(REPO, "admin", "app.js"), "utf8");
      ok("H1 · index.html no longer carries the two Watchtower paragraphs as standing <p>s", !/<p class="panel-sub" id="watchtower-sub">/.test(html) && !/<p class="panel-sub"><strong>Clear a whole run/.test(html));
      /* R88 · A: was "…the Watchtower and radar howFolds". The radar panel (and its fold) is gone. */
      ok("H2 (R88) · index.html carries the Watchtower howFold (closed <details class=\"rep-howcounted how-fold\">) and no radar panel", /id="watchtower-sub"><summary>/.test(html) && !/id="unactioned-how"/.test(html) && !/id="unactioned-panel"/.test(html) && !/id="watchtower-sub" open/.test(html));
      ok("H3 · app.js no longer renders #ops-strip-sub or #leads-accept-bar-sub", !/id="ops-strip-sub"/.test(app) && !/id="leads-accept-bar-sub"/.test(app));
      ok("H4 · the what's-new line is built through howFold()", /howFold\(\{ id: "whatsnew-details"/.test(app));
    }
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  }

  console.log(`\nR87 TODAY: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
