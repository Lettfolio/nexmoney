/* ==========================================================================
   R89 · B — REPORTS AS TABS (R89-DESIGN slice B; panel-r87/05-owner-admin.md #1 #2 #3 #7 #11 #12).

   The contract:
     · REPORT_SECTIONS are real tabs (pageTabsHtml / activatePageTab): the Owner gets This month /
       Pipeline MI / Money & book / Service & quality / Referrals out / Money; the Administrator the
       four that are not Owner-only; an adviser My numbers first. Who gets a tab is a role rule.
     · LAZY: only the tab on screen is painted; the others stay empty until opened.
     · ONE forecast: every figure stamped data-forecast carries the same number on every tab, and it
       equals an independent recompute with the MI weights (MI_STAGE_DEFAULT_WEIGHT + the history
       calibration) off the mock store. The 4-stage STAGE_WEIGHT forecast is gone.
     · ONE funnel (a Live / Created-in view toggle), ONE per-adviser table (a By adviser toggle).
     · The Money tab: statement drop zone first, Money owed drawn once (here), none of the six panels
       that restated Reports; the Money & book tile links to it.
     · Kim (p1) lands on This month; the "what you cannot see" line ≤ 20 words; no My numbers card.
     · Every tab ≤ 4,000px tall at 1440; #reports/<tab> hashes; no console errors on any tab.
   Expectations are computed at runtime. Run: node tests/r89_reports.js (copy to /tmp and patch
   REPO/PORT for a worktree).
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
async function waitApp(page) {
  await page.waitForFunction(() => document.querySelector("#app-view") && !document.querySelector("#app-view").classList.contains("hidden") && typeof window.nav === "function", null, { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { try { if (window.tourEnd) window.tourEnd(false); } catch (e) { /* not open */ } });
  await page.waitForTimeout(300);
}
async function boot(browser, persona, hash) {
  const ctx = await browser.newContext({ viewport: DESK, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}${hash || ""}`, { waitUntil: "domcontentloaded" });
  await waitApp(page);
  return page;
}
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));
const tabs = (page) => page.$$eval("#reports-tabs > .seg-btn", (els) => els.map((b) => ({ key: b.dataset.tab, pressed: b.getAttribute("aria-pressed") === "true" })));
const clickTab = async (page, key, ms) => { await page.click(`#reports-tabs-${key}`); await page.waitForTimeout(ms == null ? 1200 : ms); };
const html = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? el.innerHTML.trim() : null; }, sel);
const visible = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && el.offsetParent !== null; }, sel);
const height = (page) => page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
/* The per-adviser tables on screen: a visible table whose first header cell names a person. */
const advTablesShown = (page) => page.evaluate(() => [...document.querySelectorAll("#page-reports table")]
  .filter((t) => t.offsetParent !== null)
  .filter((t) => { const th = t.querySelector("th"); return th && /^(Adviser|Person)$/.test(th.textContent.trim()); }).length);
/* The MI forecast, recomputed from the store the way the app now does (miForecastModel's rule). */
const recomputeForecast = (page) => page.evaluate(async () => {
  const { data } = await window.__mockDb.from("cases").select("*").order("id");
  const W = { enquiry: 0.1, fact_find: 0.2, decision_in_principle: 0.4, application: 0.6, offer: 0.85, exchange: 0.95 };
  const live = Object.keys(W);
  const fee = (c) => Number(c.broker_fee || 0) + Number(c.proc_fee || 0);
  let app = 0, off = 0, comp = 0, appC = 0, offC = 0;
  const byStage = Object.fromEntries(live.map((s) => [s, 0]));
  (data || []).forEach((c) => {
    if (live.includes(c.stage)) byStage[c.stage] += fee(c);
    if (c.submitted_at) app++;
    if (c.offer_issued_date) off++;
    if (c.completed_at) comp++;
    if (c.submitted_at && c.completed_at) appC++;
    if (c.offer_issued_date && c.completed_at) offC++;
  });
  const w = Object.assign({}, W);
  if (comp >= 5) { if (app >= 5) w.application = appC / app; if (off >= 5) w.offer = offC / off; }
  const total = live.reduce((s, st) => s + byStage[st] * w[st], 0);
  const fourStage = ["decision_in_principle", "application", "offer", "exchange"].reduce((s, st, i) => s + byStage[st] * [0.25, 0.5, 0.8, 0.95][i], 0);
  return { total, text: fmtM(total), fourStageText: fmtM(fourStage) };
});

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const pages = [];
  try {
    /* ------------------------------------------------------------------ A. Owner (p4) */
    console.log("\nA · Owner (p4) — tabs, lazy render, one forecast / funnel / adviser table");
    const p4 = await boot(browser, "p4");
    pages.push(p4);
    await p4.evaluate(() => nav("reports"));
    await p4.waitForTimeout(1800);
    const t4 = await tabs(p4);
    eq("A1 · the Owner's Reports offers five report tabs + Money, in order", t4.map((t) => t.key), ["month", "mi", "book", "quality", "referrals", "money"]);
    eq("A2 · …which is REPORT_SECTIONS' role rule plus the Money tab", await p4.evaluate(() => REPORT_SECTIONS.filter((s) => s[4]()).map((s) => s[0]).concat(isOwner() ? ["money"] : [])), t4.map((t) => t.key));
    eq("A3 · the Owner lands on This month", t4.filter((t) => t.pressed).map((t) => t.key), ["month"]);
    eq("A4 · …hash #reports/month", await p4.evaluate(() => location.hash), "#reports/month");
    ok("A5 · the section pills and their scroll-spy are gone (#reports-jump, buildReportSectionNav)", await p4.evaluate(() => !document.getElementById("reports-jump") && typeof buildReportSectionNav === "undefined" && typeof onRepJumpScroll === "undefined"));
    // Lazy: nothing outside This month is painted yet.
    for (const sel of ["#report-mi-funnel", "#report-mi-forecast-headline", "#report-kpis", "#report-forecast-headline", "#report-rateend-table", "#report-leadresp-headline", "#report-advocacy-grid", "#report-ref-groups", "#money-banked", "#report-owed-buckets"]) {
      eq(`A6 · lazy: ${sel} is empty until its tab is opened`, await html(p4, sel), "");
    }
    ok("A7 · …while This month IS painted (#month-kpis, #report-advisers)", ((await html(p4, "#month-kpis")) || "").length > 0 && ((await html(p4, "#report-advisers")) || "").length > 0);
    ok("A8 · only one report tab panel is on screen", await p4.evaluate(() => [...document.querySelectorAll("#page-reports > [data-tabpanel]")].filter((p) => !p.classList.contains("hidden")).length === 1));

    // One per-adviser table, four views.
    const views = await p4.$$eval("#report-adv-seg > .seg-btn", (els) => els.map((b) => b.dataset.seg));
    eq("A9 · the scoreboard's By adviser toggle offers four views to the Owner", views, ["month", "pipeline", "submitted", "activity"]);
    eq("A10 · one per-adviser table on This month", await advTablesShown(p4), 1);
    for (const v of ["pipeline", "submitted", "activity"]) {
      await p4.click(`#report-adv-view-${v}`);
      await p4.waitForTimeout(v === "activity" ? 1500 : 500);
      eq(`A11 · view "${v}": still exactly one per-adviser table on screen`, await advTablesShown(p4), 1);
    }
    ok("A12 · the MI scoreboard, #month-advisers and the adoption strip all live inside #report-scoreboard-panel", await p4.evaluate(() => ["#report-mi-scoreboard", "#month-advisers", "#report-adoption", "#report-advisers"].every((s) => !!document.querySelector("#report-scoreboard-panel " + s))));
    await p4.click("#report-adv-view-month");
    await p4.waitForTimeout(400);

    // Pipeline MI: one funnel with a view toggle.
    await clickTab(p4, "mi");
    eq("A13 · hash #reports/mi", await p4.evaluate(() => location.hash), "#reports/mi");
    ok("A14 · the MI tab is painted now (#report-mi-funnel)", ((await html(p4, "#report-mi-funnel")) || "").length > 0);
    eq("A15 · …Money & book is still unpainted (#report-kpis empty)", await html(p4, "#report-kpis"), "");
    const funnels = () => p4.evaluate(() => ({
      live: [...document.querySelectorAll("#report-mi-funnel .mi-bar-row")].some((e) => e.offsetParent !== null),
      cohort: [...document.querySelectorAll("#report-funnel .funnel-row, #report-funnel .empty")].some((e) => e.offsetParent !== null),
      panels: [...document.querySelectorAll("#page-reports .panel")].filter((p) => p.offsetParent !== null && /funnel/i.test((p.querySelector("h3") || {}).textContent || "")).length,
    }));
    let f = await funnels();
    ok("A16 · one funnel panel, showing the live view only", f.panels === 1 && f.live && !f.cohort, JSON.stringify(f));
    await p4.click("#report-funnel-view-cohort");
    await p4.waitForTimeout(300);
    f = await funnels();
    ok("A17 · the toggle swaps it for the month cohort — still one funnel on screen", f.panels === 1 && !f.live && f.cohort, JSON.stringify(f));
    await p4.click("#report-funnel-view-live");
    ok("A18 · the MI scoreboard is not drawn on the MI tab (it is the scoreboard's Pipeline view)", !(await p4.evaluate(() => { const p = document.querySelector('[data-tabpanel="mi"]'); return !!p.querySelector("#report-mi-scoreboard"); })));

    // Money & book: the same forecast, one number.
    await clickTab(p4, "book");
    eq("A19 · hash #reports/book", await p4.evaluate(() => location.hash), "#reports/book");
    ok("A20 · Money & book painted (#report-kpis tiles)", await p4.evaluate(() => document.querySelectorAll("#report-kpis .kpi").length > 3));
    const want = await recomputeForecast(p4);
    const fc = await p4.$$eval("[data-forecast]", (els) => els.map((e) => ({ t: e.textContent.trim(), tab: (e.closest("[data-tabpanel]") || {}).dataset.tabpanel })));
    ok("A21 · the forecast figure is drawn on Pipeline MI and on Money & book", fc.map((x) => x.tab).sort().join() === "book,mi", JSON.stringify(fc));
    eq("A22 · …and it is ONE number across all tabs", [...new Set(fc.map((x) => x.t))].length, 1);
    eq("A23 · …equal to an independent recompute with the MI weights off the store", fc[0] && fc[0].t, want.text);
    ok("A24 · the retired 4-stage figure appears nowhere on Reports (and its renderer is gone)", await p4.evaluate((t) => typeof renderForecastBuckets === "undefined" && !document.getElementById("page-reports").textContent.includes(t), want.fourStageText) || want.fourStageText === want.text, want.fourStageText);
    ok("A25 · Money & book says how it is counted behind a closed fold", await p4.evaluate(() => { const d = document.getElementById("report-forecast-how"); return !!d && d.tagName === "DETAILS" && !d.open && /Pipeline MI/.test(d.textContent); }));
    ok("A26 · Money owed is NOT drawn on Money & book — the tile links to it", !(await p4.evaluate(() => !!document.querySelector('[data-tabpanel="book"] #report-owed-panel'))) && await visible(p4, "#report-kpi-owed"));

    // Heights and console, every tab.
    const hs = {};
    for (const k of ["month", "mi", "book", "quality", "referrals", "money"]) {
      await clickTab(p4, k, 1500);
      hs[k] = await height(p4);
    }
    const tallest = Math.max(...Object.values(hs));
    console.log("    · heights at 1440:", JSON.stringify(hs));
    ok(`A27 · the tallest tab is ≤ 4,000px at 1440 (was 11,600 for the page) — ${tallest}px`, tallest <= 4000, JSON.stringify(hs));

    // Money tab.
    eq("A28 · hash #reports/money", await p4.evaluate(() => location.hash), "#reports/money");
    eq("A29 · the Money tab opens on the statement drop zone", await p4.evaluate(() => { const b = document.getElementById("money-body"); const first = [...b.children].find((c) => c.classList.contains("panel")); return first && first.id; }), "money-recon-panel");
    ok("A30 · …the drop zone is the first thing below the tab's head (above everything else in #money-body)", await p4.evaluate(() => { const z = document.getElementById("recon-file-slot").getBoundingClientRect().top; return [...document.querySelectorAll("#money-body .panel")].every((p) => p.id === "money-recon-panel" || p.getBoundingClientRect().top > z); }));
    const six = ["money-owed-panel", "money-rateends-panel", "money-cold-panel", "money-movement-panel", "money-leads-panel", "money-advisers-panel"];
    eq("A31 · none of the six panels that restated Reports exists", await p4.evaluate((ids) => ids.filter((id) => document.getElementById(id)), six), []);
    ok("A32 · Money owed is drawn once — here (#report-owed-panel inside #page-money, buckets painted)", await p4.evaluate(() => document.querySelectorAll("#report-owed-panel").length === 1 && !!document.querySelector("#page-money #report-owed-panel") && document.querySelectorAll("#report-owed-buckets .kpi").length > 0));
    ok("A33 · the link line names where the retired panels live", await p4.evaluate(() => ["money-link-rateend", "money-link-advisers", "money-link-sources"].every((id) => !!document.getElementById(id))));
    ok("A34 · the month picker is not offered on the Money tab", !(await visible(p4, "#report-month")));
    // The Money & book tile opens Money owed.
    await clickTab(p4, "book");
    await p4.click("#report-kpi-owed");
    await p4.waitForTimeout(1800);
    ok("A35 · the 'Owed on completed cases' tile opens Money owed on the Money tab", (await p4.evaluate(() => location.hash)) === "#reports/money" && await visible(p4, "#report-owed-panel"));
    // Deep hash + the level-2 strip.
    await p4.evaluate(() => nav("reports/quality"));
    await p4.waitForTimeout(1800);
    ok("A36 · nav('reports/quality') lands on Service & quality", (await p4.evaluate(() => currentPageTab("reports"))) === "quality" && await visible(p4, "#report-leadresp-panel"));
    // (the A35 deep link already asked for the strip — R87's rule — so press only if it is closed)
    if (await p4.evaluate(() => document.getElementById("rep-nav").hidden)) await p4.click("#reports-jump-toggle");
    await p4.waitForTimeout(300);
    ok("A37 · 'Panels ▾' opens a chip strip INSIDE the tab, listing only that tab's panels", await p4.evaluate(() => {
      const bar = document.getElementById("rep-nav"), tab = document.querySelector('[data-tabpanel="quality"]');
      const keys = [...document.querySelectorAll("#rep-nav-chips [data-rep-jump]")].map((b) => b.dataset.repJump);
      return !bar.hidden && tab.contains(bar) && keys.length >= 2 && keys.every((k) => REPORT_JUMP_SECTIONS.find((s) => s[0] === k) && tab.contains(document.querySelector(REPORT_JUMP_SECTIONS.find((s) => s[0] === k)[2])));
    }));
    ok("A38 · no console errors on any Owner tab", realErr(p4).length === 0, realErr(p4).join(" | "));

    // Reload straight onto a tab.
    const p4b = await boot(browser, "p4", "#reports/book");
    pages.push(p4b);
    await p4b.waitForTimeout(1200);
    ok("A39 · a cold load of #reports/book opens Money & book, painted", (await p4b.evaluate(() => currentPageTab("reports"))) === "book" && await p4b.evaluate(() => document.querySelectorAll("#report-kpis .kpi").length > 3));
    eq("A40 · …and This month stays unpainted", await html(p4b, "#month-kpis"), "");

    /* ------------------------------------------------------------------ R. One read per visit (R89 · fixer) */
    /* R89 · fixer — the verifier's P1 (11-r89-verification 2i): every tab click re-ran loadReports()
       because the repTabClick flag was reset before the kit's click handler read it. The contract is
       counted in READS now, not loader invocations: a from/rpc spy on the app's client (and a count
       of loadReports calls). Arriving = one shared read; clicking tabs = no shared read (Service &
       quality and Referrals out each make their own one-table read the first time they paint — that
       is theirs, not the shared read); an explicit refresh and a busting write read again. */
    console.log("\nR · one shared read per visit (from/rpc spy)");
    const pr = await boot(browser, "p4");
    pages.push(pr);
    await pr.evaluate(() => {
      window.__spy = []; window.__lr = 0;
      const _lr = window.loadReports;
      window.loadReports = function () { window.__lr++; return _lr.apply(this, arguments); };
      const d = window.db, f = d.from.bind(d), r = d.rpc.bind(d);
      d.from = (t) => { window.__spy.push("from:" + t); return f(t); };
      d.rpc = (n, ...a) => { window.__spy.push("rpc:" + n); return r(n, ...a); };
    });
    const take = () => pr.evaluate(() => { const o = { calls: window.__spy, lr: window.__lr }; window.__spy = []; window.__lr = 0; return o; });
    await pr.waitForTimeout(800);
    await take();   // background noise before the visit (none expected, not asserted)
    await pr.evaluate(() => nav("reports", true, "month"));
    await pr.waitForTimeout(2200);
    const arrive = await take();
    console.log(`    · arrive: ${arrive.calls.length} calls, loadReports ×${arrive.lr} — ${arrive.calls.join(" ")}`);
    ok("R1 · arriving at Reports runs the shared read once (loadReports ×1, it reads cases)", arrive.lr === 1 && arrive.calls.includes("from:cases") && arrive.calls.length > 0, JSON.stringify(arrive));
    const clickRun = {};
    for (const k of ["mi", "book", "month", "mi"]) {
      await clickTab(pr, k, 1000);
      const t = await take();
      clickRun[k + (clickRun[k] ? "2" : "")] = t;
    }
    const clickCalls = Object.values(clickRun).reduce((n, t) => n + t.calls.length, 0);
    const clickLr = Object.values(clickRun).reduce((n, t) => n + t.lr, 0);
    console.log(`    · 4 tab clicks (mi, book, month, mi): ${clickCalls} calls, loadReports ×${clickLr}`);
    eq("R2 · four tab clicks (Pipeline MI, Money & book, back to This month, MI again) make 0 reads", clickCalls, 0);
    eq("R3 · …and never re-run loadReports", clickLr, 0);
    ok("R4 · …while each tab is painted from the read in hand (#report-mi-funnel, #report-kpis)", ((await html(pr, "#report-mi-funnel")) || "").length > 0 && await pr.evaluate(() => document.querySelectorAll("#report-kpis .kpi").length > 3));
    await clickTab(pr, "quality", 1500);
    const q = await take();
    await clickTab(pr, "referrals", 1500);
    const rf = await take();
    console.log(`    · first open of quality: ${q.calls.join(" ") || "—"}; referrals: ${rf.calls.join(" ") || "—"}`);
    ok("R5 · Service & quality's first open reads only its own table (appointments) — no shared read", q.lr === 0 && q.calls.every((c) => c === "from:appointments"), JSON.stringify(q));
    ok("R6 · Referrals out's first open reads only its own table (referrals) — no shared read", rf.lr === 0 && rf.calls.every((c) => c === "from:referrals"), JSON.stringify(rf));
    for (const k of ["quality", "referrals"]) await clickTab(pr, k, 800);
    eq("R7 · re-opening those two tabs reads nothing", (await take()).calls.length, 0);
    await pr.evaluate(() => activatePageTab("reports", "book", { refresh: true }));
    await pr.waitForTimeout(2000);
    const refresh = await take();
    console.log(`    · refresh: ${refresh.calls.length} calls, loadReports ×${refresh.lr} — ${refresh.calls.join(" ")}`);
    ok("R8 · an explicit { refresh: true } re-reads (loadReports ×1)", refresh.lr === 1 && refresh.calls.length > 0, JSON.stringify(refresh));
    await pr.evaluate(() => nav("dashboard"));
    await pr.waitForTimeout(1500);
    await take();
    await pr.evaluate(() => nav("reports"));
    await pr.waitForTimeout(2000);
    const again = await take();
    ok("R9 · arriving again re-reads once, the same reads as the refresh", again.lr === 1 && JSON.stringify(again.calls.slice().sort()) === JSON.stringify(refresh.calls.slice().sort()), JSON.stringify(again) + " vs " + JSON.stringify(refresh));
    const onTab = await pr.evaluate(() => currentPageTab("reports"));
    const other = onTab === "mi" ? "book" : "mi";
    await clickTab(pr, other, 1000);
    eq(`R10 · …after which a click (${other}) reads nothing again`, (await take()).lr, 0);
    await pr.evaluate(() => bustBoardCache());   // what every cases/clients write does (the db.from choke point)
    await clickTab(pr, onTab, 1500);
    const bust = await take();
    ok("R11 · a write that busts the board cache stales the read: the next tab open reads again", bust.lr === 1 && bust.calls.length > 0, JSON.stringify(bust));
    ok("R12 · the repTabClick flag machinery is gone", await pr.evaluate(() => typeof repTabClick === "undefined"));
    ok("R13 · no console errors (read-count run)", realErr(pr).length === 0, realErr(pr).join(" | "));

    /* ------------------------------------------------------------------ B. Administrator (p1) */
    console.log("\nB · Administrator (p1) — Kim");
    const p1 = await boot(browser, "p1");
    pages.push(p1);
    await p1.evaluate(() => nav("reports"));
    await p1.waitForTimeout(1800);
    const t1 = await tabs(p1);
    eq("B1 · Kim's Reports: the four tabs that are not Owner-only (no Money, no Service & quality, no My numbers)", t1.map((t) => t.key), ["month", "mi", "book", "referrals"]);
    eq("B2 · Kim lands on This month", t1.filter((t) => t.pressed).map((t) => t.key), ["month"]);
    const note = await p1.evaluate(() => { const n = document.getElementById("report-money-note"); return { vis: n.offsetParent !== null, words: n.textContent.trim().split(/\s+/).length }; });
    ok(`B3 · the 'what you cannot see' line is one line of ≤ 20 words (${note.words})`, note.vis && note.words <= 20, JSON.stringify(note));
    ok("B4 · no My numbers card (no zero adviser card)", !(await visible(p1, "#report-mine-panel")));
    eq("B5 · Kim's adviser table offers Pipeline and Submitted views", await p1.$$eval("#report-adv-seg > .seg-btn", (els) => els.map((b) => b.dataset.seg)), ["pipeline", "submitted"]);
    eq("B6 · one per-adviser table on screen", await advTablesShown(p1), 1);
    ok("B7 · no money view, no adoption strip painted for her", (await html(p1, "#report-advisers")) === "" && (await html(p1, "#report-adoption")) === "");
    const h1 = {};
    for (const k of t1.map((t) => t.key)) { await clickTab(p1, k, 1500); h1[k] = await height(p1); }
    ok(`B8 · Kim's tallest tab ≤ 4,000px`, Math.max(...Object.values(h1)) <= 4000, JSON.stringify(h1));
    await clickTab(p1, "mi");
    const want1 = await recomputeForecast(p1);
    const fc1 = await p1.$$eval("[data-forecast]", (els) => els.map((e) => e.textContent.trim()));
    ok("B9 · Kim's forecast (Pipeline MI) is the same one number", fc1.length >= 1 && fc1.every((t) => t === want1.text), JSON.stringify(fc1) + " vs " + want1.text);
    await p1.evaluate(() => { location.hash = "#reports/money"; });
    await p1.waitForTimeout(1200);
    ok("B10 · #reports/money for Kim does not show #page-money", !(await visible(p1, "#page-money")));
    ok("B11 · no console errors on any of Kim's tabs", realErr(p1).length === 0, realErr(p1).join(" | "));

    /* ------------------------------------------------------------------ C. Adviser (p2) */
    console.log("\nC · Adviser (p2)");
    const p2 = await boot(browser, "p2");
    pages.push(p2);
    await p2.evaluate(() => nav("reports"));
    await p2.waitForTimeout(1800);
    const t2 = await tabs(p2);
    eq("C1 · an adviser gets My numbers first, no Owner tabs", t2.map((t) => t.key), ["mine", "month", "mi", "book", "referrals"]);
    eq("C2 · …and lands on My numbers", t2.filter((t) => t.pressed).map((t) => t.key), ["mine"]);
    await clickTab(p2, "month");
    ok("C3 · the adviser's scoreboard is the Submitted view only, with no toggle", (await html(p2, "#report-adv-views")) === "" && await visible(p2, "#month-advisers"));
    await clickTab(p2, "mi");
    ok("C4 · the adviser keeps a funnel (the month cohort), no live MI funnel", await visible(p2, "#report-funnel") && !(await visible(p2, "#report-mi-funnel")));
    eq("C5 · no forecast figure on an adviser's Reports", await p2.$$eval("[data-forecast]", (els) => els.filter((e) => e.offsetParent !== null).length), 0);
    ok("C6 · no console errors (adviser)", realErr(p2).length === 0, realErr(p2).join(" | "));
  } catch (e) {
    failures.push("CRASH — " + (e && e.stack || e));
    console.log("CRASH", e);
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (_) { /* already gone */ }
  }
  console.log(`\nR89 REPORTS: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
