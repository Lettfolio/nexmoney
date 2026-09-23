/* ==========================================================================
   R89 · A — OPERATIONS (R89-DESIGN slice A; panel 05 #6 #9 #10, 01 #4 #7 #10).

   What is pinned:
     · §A one heading: #page-operations shows ONE visible h2 ("Operations"); the three sections' old
       h2s (Email activity / Revolution sync / Bring in data / Data health) are gone as h2s; three
       tabs whose panels are the old page ids (#page-emails / #page-import / #page-data).
     · §B alias nav: nav("emails"|"import"|"data") and the ops chips land on the right tab; the ops
       chips and palette verbs say "Operations › …"; one "Go to Operations" verb + a verb per tab.
     · §C Data health once: no readiness list; the tiles are the header row and the to-do list
       (#dh-readiness .dh-check) has one row per check whose count == its tile's count == its list
       rows; no check's text is said twice; the head folds its list; a fix brings the row down.
     · §D adviser (p2): Operations and its aliases bounce to Today; the Firm group (Settings alone)
       does not fold; no Operations palette verbs.
     · §E phone 390: the active tab is in view and every tab is ≥44px; the to-do heads are ≥44px.
     · §F no console errors.
   Expectations are computed at runtime. Run: node tests/r89_operations.js (copy to /tmp and patch
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
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));
const go = async (page, id, ms) => { await page.evaluate((p) => window.nav(p), id); await page.waitForTimeout(ms == null ? 1200 : ms); };
const where = (page) => page.evaluate(() => ({ page: currentPage, tab: currentPageTab(), hash: location.hash, title: document.title }));
/* Data health, read once: tiles (counted band), to-do rows, the headline. */
const readDH = (page) => page.evaluate(() => {
  const vis = (el) => !!el && el.offsetParent !== null;
  const tiles = [...document.querySelectorAll("#dh-kpi-row .kpi[id^='dh-tile-']")].map((t) => ({
    id: t.id, band: t.dataset.band, clean: t.classList.contains("dh-clean"),
    n: Number(((t.querySelector(".num") || {}).textContent || "").trim().split(" ")[0]),
    lbl: ((t.querySelector(".lbl") || {}).textContent || "").replace(/[▾→]/g, "").trim(),
  }));
  const checks = [...document.querySelectorAll("#dh-readiness .dh-check")].map((c) => {
    const p = document.getElementById(c.dataset.panel);
    return {
      panel: c.dataset.panel, tile: c.dataset.tile || null, band: c.dataset.band, n: Number(c.dataset.n),
      clean: c.classList.contains("dh-clean"), vis: vis(c),
      name: ((c.querySelector(".dh-check-name") || {}).textContent || "").trim(),
      headH: c.querySelector(".dh-check-btn") ? c.querySelector(".dh-check-btn").getBoundingClientRect().height : 0,
      expanded: (c.querySelector(".dh-check-btn") || { getAttribute: () => null }).getAttribute("aria-expanded"),
      hidden: p ? p.classList.contains("hidden") : null,
      /* kit rows, or — for the two table lists — one table row per case / one block per address */
      rows: p ? (p.querySelectorAll(".row-item").length || p.querySelectorAll("tr[data-case]").length || p.querySelectorAll(".dh-sharedprop").length) : null,
      kit: p ? p.querySelectorAll(".row-item.kit-row").length : null,
      panelH3: p ? p.querySelectorAll("h3").length : null,
      inside: !!(p && c.contains(p)),
    };
  });
  const h = document.getElementById("dh-readiness-headline");
  return {
    tiles, checks,
    readinessItems: document.querySelectorAll(".dh-readiness-item").length,
    key: !!document.getElementById("dh-key"),
    headline: h ? { total: Number(h.dataset.total), checks: Number(h.dataset.checks), text: h.textContent } : null,
    sub: (document.getElementById("dh-page-sub") || {}).textContent || "",
  };
});

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* ================================================================== §A owner, one heading */
    console.log("\n§A · one heading, three tabs (p4)");
    const p4 = await boot(browser, "p4");
    await go(p4, "operations/emails", 2200);
    const head = await p4.evaluate(() => {
      const root = document.getElementById("page-operations");
      const h2s = [...root.querySelectorAll("h2")];
      return {
        visH2: h2s.filter((h) => h.offsetParent !== null).map((h) => h.textContent.trim()),
        allH2: h2s.map((h) => h.textContent.trim()),
        tabs: [...document.querySelectorAll("#operations-tabs > .seg-btn")].map((b) => ({ key: b.dataset.tab, label: b.textContent.trim() })),
        panels: ["emails", "import", "data"].map((k) => { const p = root.querySelector(`[data-tabpanel="${k}"]`); return p ? p.id : null; }),
      };
    });
    eq("A1 · exactly one visible h2 on Operations, and it says Operations", head.visH2, ["Operations"]);
    eq("A2 · …and no other h2 anywhere inside it (the old section h2s became tab labels)", head.allH2, ["Operations"]);
    eq("A3 · three tabs: emails / import / data", head.tabs.map((t) => t.key), ["emails", "import", "data"]);
    ok("A4 · the tab labels carry the sections' names", /Email/.test(head.tabs[0].label) && /Import/.test(head.tabs[1].label) && /Data health/.test(head.tabs[2].label), JSON.stringify(head.tabs));
    eq("A5 · each old page id is a tab panel", head.panels, ["page-emails", "page-import", "page-data"]);
    for (const k of ["import", "data"]) {
      await go(p4, "operations/" + k, 2600);
      const v = await p4.evaluate(() => [...document.querySelectorAll("#page-operations h2")].filter((h) => h.offsetParent !== null).map((h) => h.textContent.trim()));
      eq(`A6 · on the ${k} tab too, one visible h2`, v, ["Operations"]);
    }
    const doors = await p4.evaluate(() => ["rev-head", "import-ai-head"].map((id) => (document.getElementById(id) || {}).tagName));
    eq("A7 · Import's two doors are h3s under the page's h2", doors, ["H3", "H3"]);

    /* ================================================================== §B aliases, chips, palette */
    console.log("\n§B · aliases, ops chips, palette (p4)");
    for (const [alias, tab] of [["emails", "emails"], ["import", "import"], ["data", "data"]]) {
      await go(p4, alias, 1800);
      const w = await where(p4);
      ok(`B1 · nav("${alias}") lands on Operations › ${tab}`, w.page === "operations" && w.tab === tab && w.hash === "#operations/" + tab, JSON.stringify(w));
    }
    await go(p4, "dashboard", 3000);
    const chips = await p4.evaluate(() => ["ops-emails-queued", "ops-emails-failed", "ops-sms-queued"].map((id) => { const b = document.getElementById(id); return b ? { id, title: b.title, on: b.getAttribute("onclick") } : null; }));
    ok("B2 · the three mail chips exist on Today", chips.every(Boolean), JSON.stringify(chips));
    ok("B3 · …each names its destination as 'Operations › Emails & SMS'", chips.every((c) => c && /Operations › Emails & SMS/.test(c.title)), JSON.stringify(chips.map((c) => c && c.title)));
    ok("B3b · …and none still says 'the Emails page'", chips.every((c) => c && !/the Emails page/.test(c.title)));
    await p4.click("#ops-sms-queued"); await p4.waitForTimeout(1800);
    const afterChip = await where(p4);
    ok("B4 · the SMS chip lands on Operations › Emails & SMS", afterChip.page === "operations" && afterChip.tab === "emails", JSON.stringify(afterChip));
    ok("B5 · the tab title reads 'Operations › Emails & SMS'", /Operations › Emails & SMS/.test(afterChip.title), afterChip.title);
    const verbs = await p4.evaluate(() => PALETTE_VERBS.filter((v) => !v.when || v.when()).map((v) => ({ id: v.id, title: v.title })));
    const vt = (id) => (verbs.find((v) => v.id === id) || {}).title;
    eq("B6 · one 'Go to Operations' verb", vt("goto-operations"), "Go to Operations");
    eq("B7 · sub-verbs named by the tab titles", ["goto-emails", "goto-import", "goto-data"].map(vt), ["Operations › Emails & SMS", "Operations › Import", "Operations › Data health"]);
    ok("B8 · no verb still says 'Go to Emails'", !verbs.some((v) => /^Go to (Emails|Import|Data health)$/.test(v.title)), JSON.stringify(verbs.map((v) => v.title)));
    await p4.evaluate(() => PALETTE_VERBS.find((v) => v.id === "goto-data").run()); await p4.waitForTimeout(2600);
    const viaVerb = await where(p4);
    ok("B9 · the Data health verb lands on Operations › Data health", viaVerb.page === "operations" && viaVerb.tab === "data", JSON.stringify(viaVerb));
    const tour = await p4.evaluate(() => tourStepsFor("admin").filter((s) => /operations/.test(s.target)).map((s) => s.title));
    ok("B10 · the admin tour's Operations steps name their tab ('Operations › …')", tour.length === 2 && tour.every((t) => /^Operations › /.test(t)), JSON.stringify(tour));

    /* ================================================================== §C Data health once */
    console.log("\n§C · Data health once (p4)");
    const d = await readDH(p4);
    eq("C1 · no readiness list (.dh-readiness-item) anywhere", d.readinessItems, 0);
    ok("C2 · the Orange/Navy key is gone", !d.key);
    ok("C3 · the tiles are still the header row (counted + watch)", d.tiles.some((t) => t.band === "counted") && d.tiles.some((t) => t.band === "watch"), JSON.stringify(d.tiles.map((t) => t.band)));
    const counted = d.tiles.filter((t) => t.band === "counted");
    const byTile = Object.fromEntries(d.checks.filter((c) => c.tile).map((c) => [c.tile, c]));
    const withList = d.tiles.filter((t) => byTile[t.id]);
    ok("C4 · every tile with a list has exactly ONE to-do row", withList.length >= 15 && withList.every((t) => d.checks.filter((c) => c.tile === t.id).length === 1), JSON.stringify(withList.map((t) => t.id)));
    const mism = withList.filter((t) => byTile[t.id].n !== t.n);
    eq("C5 · each to-do row's count == its tile's count", mism.map((t) => [t.id, t.n, byTile[t.id].n]), []);
    const rowMism = withList.filter((t) => t.n <= 200 && byTile[t.id].rows !== t.n);
    eq("C6 · each check's list holds exactly as many rows as its tile counts", rowMism.map((t) => [t.id, t.n, byTile[t.id].rows]), []);
    const nonClean = counted.filter((t) => !t.clean);
    eq("C7 · the headline's check count == the non-clean counted tiles", d.headline && d.headline.checks, nonClean.length);
    eq("C8 · the headline's total == the sum of those tiles", d.headline && d.headline.total, nonClean.reduce((a, t) => a + t.n, 0));
    ok("C9 · the headline is inside the page's one line, and that line is ≤25 words", d.sub.includes(d.headline.text) && d.sub.trim().split(/\s+/).length <= 25, d.sub);
    const names = d.checks.map((c) => c.name.toLowerCase()).concat(d.tiles.map((t) => t.lbl.toLowerCase()));
    const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
    eq("C10 · no check's text appears twice on the page (tile labels + to-do names all distinct)", dupNames, []);
    ok("C11 · each panel's heading was lifted into its row (no h3 left inside a panel, one per head)", d.checks.every((c) => c.panelH3 === 0 && c.inside && c.name.length > 3), JSON.stringify(d.checks.filter((c) => c.panelH3 !== 0 || !c.inside).map((c) => c.panel)));
    ok("C12 · a clean check is folded away with its tile; every other row is on screen", d.checks.every((c) => (c.clean ? !c.vis : c.vis)), JSON.stringify(d.checks.map((c) => [c.panel, c.clean, c.vis])));
    ok("C13 · faults come first, worst first", (() => { const f = d.checks.filter((c) => c.band === "counted" && !c.clean).map((c) => c.n); return f.length > 1 && f.every((n, i) => i === 0 || f[i - 1] >= n) && d.checks.findIndex((c) => c.band !== "counted") > d.checks.map((c) => c.band).lastIndexOf("counted"); })(), JSON.stringify(d.checks.map((c) => [c.band, c.n])));
    const listRows = d.checks.filter((c) => c.rows > 0 && !["dh-dup-panel", "dh-waitingdocs-panel", "dh-sharedprop-panel"].includes(c.panel));
    ok("C14 · client / case rows are kit rows (rowItemHtml)", listRows.length > 5 && listRows.every((c) => c.kit === c.rows), JSON.stringify(listRows.map((c) => [c.panel, c.kit, c.rows])));
    const nameOpensClient = await p4.evaluate(() => [...document.querySelectorAll("#dh-readiness .kit-row .t")].slice(0, 40).every((t) => /openClient\(/.test(t.getAttribute("onclick") || "")));
    ok("C15 · a row's name opens the client (kit rule 1)", nameOpensClient);
    ok("C16 · the aria-expanded on every head agrees with its fold", d.checks.every((c) => (c.expanded === "true") === (c.hidden === false)), JSON.stringify(d.checks.map((c) => [c.panel, c.expanded, c.hidden])));
    /* fold / unfold by the head */
    const target = d.checks.find((c) => c.hidden && !c.clean && c.rows > 0);
    ok("C17pre · fixture sanity — a folded check with rows", !!target, JSON.stringify(d.checks.map((c) => [c.panel, c.hidden])));
    if (target) {
      await p4.click(`.dh-check[data-panel="${target.panel}"] .dh-check-btn`); await p4.waitForTimeout(300);
      const open = await p4.evaluate((id) => !document.getElementById(id).classList.contains("hidden"), target.panel);
      ok("C17 · the head unfolds its list", open);
      await p4.click(`.dh-check[data-panel="${target.panel}"] .dh-check-btn`); await p4.waitForTimeout(300);
      const shut = await p4.evaluate((id) => document.getElementById(id).classList.contains("hidden"), target.panel);
      ok("C18 · …and folds it again", shut);
    }
    /* an inline fix brings the tile, the row and the headline down together */
    const fixCheck = d.checks.find((c) => ["dh-rateend-panel", "dh-nocompleted-panel", "dh-address-panel"].includes(c.panel) && c.n > 0);
    ok("C19pre · fixture sanity — a date/address fix list with rows", !!fixCheck);
    if (fixCheck) {
      await p4.evaluate((id) => {
        const p = document.getElementById(id);
        const inp = p.querySelector(".dh-fix-input");
        inp.value = inp.type === "date" ? "2024-01-15" : "12 R89 Road, Bournemouth BH1 1AA";
        p.querySelector(".dh-fix-save").click();
      }, fixCheck.panel);
      await p4.waitForTimeout(1500);
      const d2 = await readDH(p4);
      const c2 = d2.checks.find((c) => c.panel === fixCheck.panel);
      const t2 = d2.tiles.find((t) => t.id === fixCheck.tile);
      eq("C19 · after a fix the row's count came down by one", c2.n, fixCheck.n - 1);
      eq("C20 · …the tile agrees with it", t2.n, c2.n);
      eq("C21 · …and the headline total came down by one", d2.headline.total, d.headline.total - 1);
    }
    await go(p4, "operations/data", 3000);
    const clean = await p4.evaluate(() => { const t = document.getElementById("dh-clean-toggle"); if (!t) return null; t.click(); return [...document.querySelectorAll("#dh-readiness .dh-check.dh-clean")].map((c) => c.offsetParent !== null); });
    ok("C22 · the clean-tile toggle brings the clean checks' rows back too", clean == null || (clean.length > 0 && clean.every(Boolean)), JSON.stringify(clean));
    eq("C23 · no console errors (p4)", realErr(p4), []);
    await p4.__ctx.close();

    /* ================================================================== §D adviser */
    console.log("\n§D · adviser (p2)");
    const p2 = await boot(browser, "p2");
    await p2.evaluate(() => { try { localStorage.setItem("nx_nav_firm_" + authUid, "closed"); localStorage.setItem("nx_nav_firm", "closed"); } catch (e) { /* */ } });
    for (const t of ["operations", "operations/data", "emails", "import", "data"]) {
      await go(p2, t, 1500);
      const w = await where(p2);
      eq(`D1 · adviser nav("${t}") bounces to Today`, w.page, "dashboard");
    }
    const nav2 = await p2.evaluate(() => {
      applyNavRole();
      const g = document.getElementById("nav-firm-group");
      return {
        opsHidden: document.querySelector('#topnav button[data-page="operations"]').classList.contains("hidden"),
        collapsed: g.classList.contains("collapsed"),
        toggleHidden: document.getElementById("nav-firm-toggle").classList.contains("hidden"),
        head: (() => { const h = document.getElementById("nav-firm-head"); return h && !h.classList.contains("hidden") ? h.textContent.trim() : null; })(),
        settingsVis: document.querySelector('#topnav button[data-page="settings"]').offsetParent !== null,
        verbs: PALETTE_VERBS.filter((v) => !v.when || v.when()).map((v) => v.id),
      };
    });
    ok("D2 · Operations is not in the adviser's sidebar", nav2.opsHidden);
    ok("D3 · the Firm group (Settings alone) does not fold, even with a stored 'closed'", !nav2.collapsed && nav2.settingsVis, JSON.stringify(nav2));
    ok("D4 · …its toggle steps aside for a plain 'Firm' label", nav2.toggleHidden && nav2.head === "Firm", JSON.stringify(nav2));
    ok("D5 · no Operations verbs in the adviser's palette", !nav2.verbs.some((v) => /^goto-(operations|emails|import|data)$/.test(v)), JSON.stringify(nav2.verbs));
    eq("D6 · no console errors (p2)", realErr(p2), []);
    await p2.__ctx.close();
    const p1 = await boot(browser, "p1");
    const nav1 = await p1.evaluate(() => ({ toggleHidden: document.getElementById("nav-firm-toggle").classList.contains("hidden"), headHidden: document.getElementById("nav-firm-head").classList.contains("hidden"), ops: document.querySelector('#topnav button[data-page="operations"]').offsetParent !== null }));
    ok("D7 · admin (p1): two Firm entries → the fold toggle stays, Operations visible", !nav1.toggleHidden && nav1.headHidden && nav1.ops, JSON.stringify(nav1));
    eq("D8 · no console errors (p1)", realErr(p1), []);
    await p1.__ctx.close();

    /* ================================================================== §E phone */
    console.log("\n§E · phone 390 (p4)");
    const ph = await boot(browser, "p4", { viewport: PHONE });
    await go(ph, "operations/data", 3200);
    const m = await ph.evaluate(() => {
      const strip = document.querySelector("#operations-tabs");
      const btns = [...strip.querySelectorAll(".seg-btn")];
      const act = strip.querySelector('.seg-btn[aria-pressed="true"]');
      const r = act.getBoundingClientRect(), s = strip.getBoundingClientRect();
      const heads = [...document.querySelectorAll("#dh-readiness .dh-check-btn")].filter((b) => b.offsetParent !== null).map((b) => b.getBoundingClientRect().height);
      return { key: act.dataset.tab, hs: btns.map((b) => b.getBoundingClientRect().height), inView: r.left >= s.left - 1 && r.right <= s.right + 1 && r.right <= window.innerWidth + 1, heads, overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    eq("E1 · the Data health tab is the pressed one", m.key, "data");
    ok("E2 · the active tab is in view", m.inView, JSON.stringify(m));
    ok("E3 · every tab is ≥44px tall", m.hs.every((h) => h >= 44), JSON.stringify(m.hs));
    ok("E4 · every to-do row head is ≥44px tall", m.heads.length > 0 && m.heads.every((h) => h >= 44), JSON.stringify(m.heads));
    ok("E5 · no horizontal page scroll", m.overflow <= 1, m.overflow);
    eq("E6 · no console errors (phone)", realErr(ph), []);
    await ph.__ctx.close();
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (e) { /* gone */ }
  }
  console.log(`\nR89 OPERATIONS: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  ✗ " + f));
  process.exit(failures.length ? 1 : 0);
})();
