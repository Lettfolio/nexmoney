/* ==========================================================================
   R89 · F — PAGE TABS, OPERATIONS, THE MONEY TAB, THE ALIASES (R89-DESIGN "Shared mechanics").

   The contract (panel-r87/TABS.md):
     · pageTabsHtml / activatePageTab in the kit block; PAGE_TABS / PAGE_TAB_LOADERS registries.
     · #page-operations holds #page-emails / #page-import / #page-data as tab panels; #page-reports
       holds #page-money as its owner-only "money" tab.
     · nav("emails"|"import"|"data") → Operations on that tab; nav("money") → Reports › Money.
     · #<page>/<tab> hashes both ways; a page hash with no tab = the stored tab, else the first.
     · the choice persists per user (nx_tab_<page>_<uid>); a tab loader runs once per tab, again on
       an explicit refresh (nav() is one).
     · role gates: Operations = Owner/Administrator; the Money TAB = Owner (an admin's #reports/money
       falls back to the first tab); an adviser bounces to Today.
     · phone 390: the active tab is in view and every tab is 44px.
   Expectations are computed at runtime. Run: node tests/r89_tabs.js (copy to /tmp and patch
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
const PHONE = { width: 390, height: 844 };

async function waitApp(page) {
  await page.waitForFunction(() => document.querySelector("#app-view") && !document.querySelector("#app-view").classList.contains("hidden") && typeof window.nav === "function", null, { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { try { if (window.tourEnd) window.tourEnd(false); } catch (e) { /* not open */ } });
  await page.waitForTimeout(300);
}
async function boot(browser, persona, o) {
  const opts = o || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || DESK, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}${opts.hash || ""}`, { waitUntil: "domcontentloaded" });
  await waitApp(page);
  page.__ctx = ctx;
  return page;
}
/* A cold load of a hash in the SAME context (so localStorage survives, as a reload would). */
async function reloadAt(page, persona, hash) {
  await page.goto(`${BASE}?as=${persona}${hash}`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });   // goto with only a hash change would not reload
  await waitApp(page);
}
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));
const go = async (page, id, ms) => {
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 900 : ms);
};
/* Where are we: page, tab, hash, which of the nested sections are visible, the strip. */
const where = (page) => page.evaluate(() => {
  const vis = (id) => { const el = document.getElementById(id); return !!el && !el.classList.contains("hidden") && el.offsetParent !== null; };
  const strip = (p) => [...document.querySelectorAll(`#${p}-tabs > .seg-btn`)].map((b) => ({ key: b.dataset.tab, label: b.textContent.trim(), pressed: b.getAttribute("aria-pressed") }));
  return {
    page: currentPage, tab: currentPageTab(), hash: location.hash, title: document.title,
    ops: vis("page-operations"), emails: vis("page-emails"), import: vis("page-import"), data: vis("page-data"),
    reports: vis("page-reports"), money: vis("page-money"), /* R89 · B: was the placeholder "all" panel; now "a Reports tab other than Money is on screen" (slice B split "all" into REPORT_SECTIONS' tabs) */
    all: !!document.querySelector('#page-reports > [data-tabpanel]:not([data-tabpanel="money"]):not(.hidden)'),
    dash: vis("page-dashboard"),
    opsStrip: strip("operations"), repStrip: strip("reports"),
    active: (document.querySelector("#topnav button.active") || {}).dataset ? document.querySelector("#topnav button.active").dataset.page : null,
  };
});
const pressed = (strip) => strip.filter((b) => b.pressed === "true").map((b) => b.key);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const pages = [];
  try {
    /* ------------------------------------------------------------------ A. owner, desktop */
    console.log("\nA · Owner (p4) — sidebar, aliases, hash, strip");
    const p4 = await boot(browser, "p4");
    pages.push(p4);

    /* A0 — loaders run once per tab: wrap the registered loaders BEFORE Operations is ever opened. */
    await p4.evaluate(() => {
      window.__tabCalls = {};
      ["operations", "reports"].forEach((pg) => Object.keys(PAGE_TAB_LOADERS[pg]).forEach((k) => {
        const f = PAGE_TAB_LOADERS[pg][k];
        PAGE_TAB_LOADERS[pg][k] = function () { window.__tabCalls[pg + "/" + k] = (window.__tabCalls[pg + "/" + k] || 0) + 1; return f.apply(this, arguments); };
      }));
    });
    const side = await p4.evaluate(() => ({
      pages: [...document.querySelectorAll("#topnav button[data-page]")].map((b) => b.dataset.page),
      opsVisible: (() => { const b = document.querySelector('#topnav button[data-page="operations"]'); return !!b && !b.classList.contains("hidden") && b.offsetParent !== null; })(),
      opsInFirm: !!document.querySelector('#nav-firm-group button[data-page="operations"]'),
      navMoney: !!document.getElementById("nav-money"),
    }));
    ok("A1 · the sidebar has no Emails / Import / Data health / Monday money entries", !side.pages.some((p) => ["emails", "import", "data", "money"].includes(p)), side.pages.join());
    ok("A2 · Operations is in the FIRM group and visible to the owner", side.opsInFirm && side.opsVisible, JSON.stringify(side));
    ok("A3 · #nav-money is gone", !side.navMoney);
    eq("A4 · the owner's sidebar is 10 entries", side.pages.length, 10);

    await go(p4, "emails");
    let w = await where(p4);
    ok("A5 · nav('emails') lands on Operations", w.page === "operations" && w.ops && w.active === "operations", JSON.stringify(w));
    ok("A6 · …on the Emails tab: #page-emails shown, #page-import / #page-data hidden", w.emails && !w.import && !w.data, JSON.stringify(w));
    eq("A7 · …hash is #operations/emails", w.hash, "#operations/emails");
    eq("A8 · the strip: three tabs in order", w.opsStrip.map((b) => b.label), ["Emails & SMS", "Import", "Data health"]);
    eq("A9 · aria-pressed on Emails only", pressed(w.opsStrip), ["emails"]);
    ok("A10 · the tab names itself in the browser tab", /^Operations › Emails & SMS · /.test(w.title), w.title);
    const calls1 = await p4.evaluate(() => ({ ...window.__tabCalls }));
    eq("A11 · arriving ran the Emails loader once, nothing else", calls1, { "operations/emails": 1 });
    await p4.evaluate(() => { const el = document.getElementById("email-list"); if (el) el.dataset.r89mark = "1"; });

    await p4.click("#operations-tabs-import");
    await p4.waitForTimeout(600);
    w = await where(p4);
    ok("A12 · clicking Import shows #page-import only", w.import && !w.emails && !w.data && w.page === "operations", JSON.stringify(w));
    eq("A13 · …hash follows: #operations/import", w.hash, "#operations/import");
    eq("A14 · …aria-pressed moves to Import", pressed(w.opsStrip), ["import"]);
    await p4.click("#operations-tabs-emails");
    await p4.waitForTimeout(500);
    await p4.click("#operations-tabs-import");
    await p4.waitForTimeout(500);
    await p4.click("#operations-tabs-emails");
    await p4.waitForTimeout(500);
    const calls2 = await p4.evaluate(() => ({ ...window.__tabCalls }));
    eq("A15 · switching back and forth ran each loader ONCE (lazy)", calls2, { "operations/emails": 1, "operations/import": 1 });
    ok("A16 · the Emails list was not re-rendered by switching back (DOM mark survives)", await p4.evaluate(() => document.getElementById("email-list").dataset.r89mark === "1"));
    await p4.evaluate(() => activatePageTab("operations", "emails", { refresh: true }));
    await p4.waitForTimeout(500);
    eq("A17 · { refresh: true } re-runs the loader", await p4.evaluate(() => window.__tabCalls["operations/emails"]), 2);

    await go(p4, "data");
    w = await where(p4);
    ok("A18 · nav('data') → Operations › Data health", w.page === "operations" && w.data && !w.emails && !w.import && w.hash === "#operations/data", JSON.stringify(w));
    eq("A19 · …nav() is an explicit refresh of the landing tab only", await p4.evaluate(() => ({ ...window.__tabCalls })), { "operations/emails": 2, "operations/import": 1, "operations/data": 1 });
    await go(p4, "import");
    w = await where(p4);
    ok("A20 · nav('import') → Operations › Import", w.page === "operations" && w.import && w.hash === "#operations/import", JSON.stringify(w));
    await go(p4, "operations/data");
    w = await where(p4);
    ok("A21 · nav('operations/data') — the hash form works in nav() too", w.data && w.hash === "#operations/data", JSON.stringify(w));

    await go(p4, "money", 1500);
    w = await where(p4);
    ok("A22 · nav('money') → Reports › Money: #page-money shown, the Reports panel hidden", w.page === "reports" && w.reports && w.money && !w.all, JSON.stringify(w));
    eq("A23 · …hash is #reports/money", w.hash, "#reports/money");
    eq("A24 · the owner's Reports strip offers Money, pressed", { keys: w.repStrip.map((b) => b.key), pressed: pressed(w.repStrip) }, { keys: ["month", "mi", "book", "quality", "referrals", "money"], pressed: ["money"] });   // R89 · B: was ["all","money"] — "all" is split into the section tabs
    ok("A25 · pageIsShown('money') on the Money tab; the sidebar highlights Reports", await p4.evaluate(() => pageIsShown("money") && pageIsShown("reports")) && w.active === "reports", JSON.stringify(w));
    eq("A26 · the Money loader ran once", await p4.evaluate(() => window.__tabCalls["reports/money"]), 1);
    await p4.click("#reports-tabs-month");   // R89 · B: was #reports-tabs-all (split into section tabs; This month is the owner's first)
    await p4.waitForTimeout(1500);
    w = await where(p4);
    ok("A27 · the Reports tab brings the reports panels back and hides #page-money", w.all && !w.money && w.hash === "#reports/month" && !(await p4.evaluate(() => pageIsShown("money"))), JSON.stringify(w));

    /* History: a page nav pushes, the tab travels with the entry. */
    await go(p4, "operations/data");
    await go(p4, "clients");
    await p4.evaluate(() => history.back());
    await p4.waitForTimeout(1200);
    w = await where(p4);
    ok("A28 · Back from Clients returns to Operations › Data health", w.page === "operations" && w.data && w.hash === "#operations/data", JSON.stringify(w));

    /* Persistence. */
    const store = await p4.evaluate(() => ({ key: userKey("nx_tab_operations"), v: localStorage.getItem(userKey("nx_tab_operations")), uid: authUid }));
    ok("A29 · the tab is stored per user as nx_tab_operations_<uid>", store.key === `nx_tab_operations_${store.uid}` && store.v === "data", JSON.stringify(store));
    await go(p4, "clients");
    await go(p4, "operations");
    w = await where(p4);
    ok("A30 · nav('operations') with no tab = the last one used (Data health)", w.data && w.hash === "#operations/data", JSON.stringify(w));

    await reloadAt(p4, "p4", "#operations");
    w = await where(p4);
    ok("A31 · reload at #operations → the stored tab (Data health)", w.page === "operations" && w.data && w.hash === "#operations/data", JSON.stringify(w));
    await reloadAt(p4, "p4", "#emails");
    w = await where(p4);
    ok("A32 · reload at the OLD #emails → Operations › Emails, hash rewritten", w.page === "operations" && w.emails && w.hash === "#operations/emails", JSON.stringify(w));
    await reloadAt(p4, "p4", "#operations/import");
    w = await where(p4);
    ok("A33 · reload at #operations/import → Import", w.import && w.hash === "#operations/import", JSON.stringify(w));
    await reloadAt(p4, "p4", "#money");
    w = await where(p4);
    ok("A34 · reload at the OLD #money → Reports › Money", w.page === "reports" && w.money && w.hash === "#reports/money", JSON.stringify(w));
    await reloadAt(p4, "p4", "#operations/nonsense");
    w = await where(p4);
    ok("A35 · an unknown tab in the hash falls back to the first tab", w.emails && w.hash === "#operations/emails", JSON.stringify(w));

    /* The helper itself. */
    const unit = await p4.evaluate(() => {
      const h = pageTabsHtml({ id: "t-x", tabs: [{ key: "a", label: "A <b>", count: 3 }, { key: "b", label: "B", when: () => false }, { key: "c", label: "C" }], active: "c" });
      const d = document.createElement("div"); d.innerHTML = h;
      const btns = [...d.querySelectorAll(".page-tabs.seg-strip > button.seg-btn[data-tab]")];
      return {
        keys: btns.map((b) => b.dataset.tab), ids: btns.map((b) => b.id), pressed: btns.map((b) => b.getAttribute("aria-pressed")),
        escaped: !d.querySelector("b") && btns[0].textContent.includes("A <b>"), count: (d.querySelector(".seg-count") || {}).textContent,
        single: pageTabsHtml({ tabs: [{ key: "a", label: "A" }, { key: "b", label: "B", when: () => false }] }),
        forced: !!pageTabsHtml({ tabs: [{ key: "a", label: "A" }], always: true }),
      };
    });
    eq("A36 · pageTabsHtml: when() false is not rendered; ids <id>-<key>; aria-pressed", { keys: unit.keys, ids: unit.ids, pressed: unit.pressed }, { keys: ["a", "c"], ids: ["t-x-a", "t-x-c"], pressed: ["false", "true"] });
    ok("A37 · pageTabsHtml escapes labels and renders the count chip", unit.escaped && unit.count === "3", JSON.stringify(unit));
    ok("A38 · one surviving tab renders no strip (unless always:true)", unit.single === "" && unit.forced, JSON.stringify(unit));

    /* ------------------------------------------------------------------ B. admin */
    console.log("\nB · Administrator (p1) — Operations yes, Money tab no");
    const p1 = await boot(browser, "p1");
    pages.push(p1);
    const s1 = await p1.evaluate(() => ({
      pages: [...document.querySelectorAll("#topnav button[data-page]")].filter((b) => !b.classList.contains("hidden")).map((b) => b.dataset.page),
    }));
    ok("B1 · Operations is on the admin's sidebar", s1.pages.includes("operations"), s1.pages.join());
    await go(p1, "reports", 1500);
    w = await where(p1);
    // R89 · B: was "no strip at all" (Reports had one non-Money tab); the admin now has four section tabs and still no Money
    ok("B2 · the admin's Reports has no Money tab", w.page === "reports" && w.all && w.repStrip.length === 4 && !w.repStrip.some((b) => b.key === "money") && !w.money, JSON.stringify(w));
    eq("B3 · …and the hash names the first tab (four tabs now)", w.hash, "#reports/month");   // R89 · B: was a bare #reports (one tab: no suffix)
    await go(p1, "money", 800);
    w = await where(p1);
    ok("B4 · nav('money') bounces the admin to Today, hash off #money", w.page === "dashboard" && w.dash && !/money/.test(w.hash), JSON.stringify(w));
    await reloadAt(p1, "p1", "#reports/money");
    w = await where(p1);
    ok("B5 · #reports/money for an admin falls back to the first tab, #page-money stays hidden", w.page === "reports" && w.all && !w.money && w.hash === "#reports/month", JSON.stringify(w));   // R89 · B: was "#reports" (one tab, no suffix); four tabs now → the first, This month
    eq("B6 · activatePageTab('reports','money') for an admin resolves to the first tab ('month')", await p1.evaluate(() => activatePageTab("reports", "money")), "month");   // R89 · B: was 'all'
    await go(p1, "import");
    w = await where(p1);
    ok("B7 · nav('import') works for the admin (Operations › Import)", w.page === "operations" && w.import && w.hash === "#operations/import", JSON.stringify(w));
    const p1key = await p1.evaluate(() => localStorage.getItem(userKey("nx_tab_operations")));
    eq("B8 · the admin's stored tab is her own key", p1key, "import");

    /* ------------------------------------------------------------------ C. adviser */
    console.log("\nC · Adviser (p2) — no Operations, no Money");
    const p2 = await boot(browser, "p2");
    pages.push(p2);
    const s2 = await p2.evaluate(() => [...document.querySelectorAll("#topnav button[data-page]")].filter((b) => !b.classList.contains("hidden")).map((b) => b.dataset.page));
    ok("C1 · Operations is hidden for an adviser", !s2.includes("operations"), s2.join());
    eq("C2 · the adviser's sidebar is 9 entries", s2.length, 9);
    for (const k of ["operations", "emails", "import", "data", "money"]) {
      await go(p2, k, 500);
      w = await where(p2);
      ok(`C3 · nav('${k}') bounces the adviser to Today`, w.page === "dashboard" && w.dash && !w.ops && w.hash === "#today", JSON.stringify(w));
    }
    await reloadAt(p2, "p2", "#operations/import");
    w = await where(p2);
    ok("C4 · a cold #operations/import lands the adviser on Today", w.page === "dashboard" && w.dash && w.hash === "#today", JSON.stringify(w));
    await go(p2, "reports", 1500);
    w = await where(p2);
    // R89 · B: was "no strip" — the adviser now has the section tabs (My numbers first), still no Money
    ok("C5 · the adviser's Reports: no Money", w.all && w.repStrip.length > 1 && !w.repStrip.some((b) => b.key === "money") && !w.money, JSON.stringify(w));

    /* ------------------------------------------------------------------ D. phone */
    console.log("\nD · Phone 390 (p4)");
    const ph = await boot(browser, "p4", { viewport: PHONE });
    pages.push(ph);
    await go(ph, "data", 1200);
    const m = await ph.evaluate(() => {
      const strip = document.getElementById("operations-tabs");
      const s = strip.getBoundingClientRect();
      const btns = [...strip.querySelectorAll(".seg-btn")];
      const act = strip.querySelector('.seg-btn[aria-pressed="true"]').getBoundingClientRect();
      return {
        hs: btns.map((b) => Math.round(b.getBoundingClientRect().height)),
        inStrip: act.left >= s.left - 1 && act.right <= s.right + 1,
        inView: act.left >= -1 && act.right <= window.innerWidth + 1,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    ok("D1 · every tab is ≥44px tall on a phone", m.hs.every((h) => h >= 44), JSON.stringify(m.hs));
    ok("D2 · the active tab (Data health) is in view inside the strip", m.inStrip && m.inView, JSON.stringify(m));
    ok("D3 · no horizontal page scroll", m.overflow <= 1, JSON.stringify(m));
    await go(ph, "money", 1500);
    const m2 = await ph.evaluate(() => {
      const b = document.querySelector('#reports-tabs .seg-btn[aria-pressed="true"]');
      const r = b.getBoundingClientRect();
      return { key: b.dataset.tab, h: Math.round(r.height), inView: r.left >= -1 && r.right <= window.innerWidth + 1 };
    });
    ok("D4 · the Money tab is pressed, 44px and in view on a phone", m2.key === "money" && m2.h >= 44 && m2.inView, JSON.stringify(m2));

    /* ------------------------------------------------------------------ E. console */
    console.log("\nE · Console");
    pages.forEach((pg, i) => ok(`E${i + 1} · no console errors (${["p4", "p1", "p2", "p4 phone"][i]})`, realErr(pg).length === 0, realErr(pg).join(" | ")));
  } catch (e) {
    failures.push("CRASH — " + (e && e.stack || e));
    console.log("CRASH", e);
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (_) { /* already gone */ }
  }
  console.log(`\nR89 TABS: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
