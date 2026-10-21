/* ==========================================================================
   R93 · C — WEBSITE › SEO (R93-CONTRACT "Admin UI — slice C").

   The contract:
     · #page-site-seo paints from the LATEST seo_snapshots day: four tiles (pages / errors·warnings /
       PSI average / search clicks or "Connect"), ONE table (one row per audited page) with issue chips
       coloured by level (message in title) that open a <details> of issues + broken links on row click.
     · Top queries (gsc_query, ≤20, clicks desc) when gsc_connected, else the three-line Connect panel.
     · Header strip "Last audit <when> · <n>s" + Run audit now → db.functions.invoke("seo-snapshot",
       { body: { force: true } }) with a disabled/spinner state, then a re-read. Empty state: one line + button.
     · No inline styles; every top-level name in the C fence is seo-prefixed.
   Expectations are computed at runtime from window.__mock.db.seo_snapshots.
   Run: node tests/r93_seo.js   (NX_REPO / NX_PORT override the defaults for a worktree)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const REPO = process.env.NX_REPO || "/root/nx";
const PORT = Number(process.env.NX_PORT || 8099);
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
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await waitApp(page);
  return page;
}
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));
const openSeo = async (page) => {
  await page.evaluate(() => window.nav("site/seo"));
  await page.waitForFunction(() => document.querySelector("#seo-head, #seo-empty"), null, { timeout: 10000 });
  await page.waitForTimeout(300);
};
const repaint = async (page) => {
  await page.evaluate(() => loadSiteSeo({ refresh: true }));
  await page.waitForTimeout(300);
};
/* The fixture truth for the latest day, read back out of the mock. */
const truth = (page) => page.evaluate(() => {
  const all = window.__mock.db.seo_snapshots || [];
  const day = all.map((r) => r.day).sort().pop() || null;
  const rows = all.filter((r) => r.day === day);
  const by = (k) => rows.filter((r) => r.kind === k);
  return {
    day,
    summary: (by("summary")[0] || {}).data || null,
    audits: by("audit").map((r) => ({ page: r.page, d: r.data })),
    queries: by("gsc_query").map((r) => Object.assign({ query: r.page }, r.data)),
  };
});

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const pages = [];
  try {
    /* ------------------------------------------------------------------ S. static */
    console.log("\nS · Static — fence, names, inline styles");
    const site = fs.readFileSync(path.join(REPO, "admin", "site.js"), "utf8");
    const a = site.indexOf("/* ===== R93 · C SEO ===== */"), b = site.indexOf("/* ===== END R93 · C SEO ===== */");
    ok("S1 · the C fence exists, once", a > 0 && b > a && site.indexOf("/* ===== R93 · C SEO ===== */", a + 1) < 0);
    const fence = site.slice(a, b);
    const tops = [...fence.matchAll(/^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/gm)].map((m) => m[1] || m[2]);
    const bad = tops.filter((n) => n !== "loadSiteSeo" && !/^(seo|SEO_)/.test(n));
    ok("S2 · every top-level name in the fence is seo-prefixed (loadSiteSeo is the registered loader)", tops.length > 5 && !bad.length, bad.join());
    ok("S3 · no inline style attribute in the fence", !/style\s*=\s*["'`]|\.style\./.test(fence));
    const css = fs.readFileSync(path.join(REPO, "admin", "admin.css"), "utf8");
    const ca = css.indexOf("/* ===== R93 · C CSS ===== */"), cb = css.indexOf("/* ===== END R93 · C CSS ===== */"), cu = css.indexOf("/* R90 · C utilities");
    ok("S4 · the C CSS fence sits above the R90 utilities block", ca > 0 && cb > ca && cb < cu);
    ok("S5 · the fence reads the latest day with ≤ 2 seo_snapshots queries", (fence.match(/from\("seo_snapshots"\)/g) || []).length === 2);

    /* ------------------------------------------------------------------ A. owner, desktop */
    console.log("\nA · Owner (p4) — tiles, table, chips, queries, run");
    const p4 = await boot(browser, "p4");
    pages.push(p4);
    await openSeo(p4);
    const T = await truth(p4);
    ok("A0 · fixtures carry a summary, audits and queries", !!T.summary && T.audits.length > 0 && T.queries.length > 0, JSON.stringify({ s: !!T.summary, a: T.audits.length, q: T.queries.length }));

    const tiles = await p4.evaluate(() => [...document.querySelectorAll("#seo-tiles > .kpi")].map((k) => ({ id: k.id, num: k.querySelector(".num").textContent.trim(), cls: k.className })));
    eq("A1 · four tiles, in order", tiles.map((t) => t.id), ["seo-tile-pages", "seo-tile-issues", "seo-tile-psi", "seo-tile-gsc"]);
    const fmt = (n) => Math.round(n).toLocaleString("en-GB");
    eq("A2 · Pages audited = summary.pages", tiles[0] && tiles[0].num, fmt(T.summary.pages));
    eq("A3 · Errors · warnings = the summary's", tiles[1] && tiles[1].num, `${fmt(T.summary.errors)} · ${fmt(T.summary.warnings)}`);
    ok("A3b · the issues tile is red while there are errors", tiles[1] && (T.summary.errors ? /\bbad\b/.test(tiles[1].cls) : true), tiles[1] && tiles[1].cls);
    eq("A4 · Performance = the PSI average", tiles[2] && tiles[2].num, String(Math.round(T.summary.psi_avg)));
    eq("A5 · Search clicks = summary.gsc.clicks", tiles[3] && tiles[3].num, fmt(T.summary.gsc.clicks));

    const head = await p4.evaluate(() => ({ text: (document.querySelector("#seo-head .seo-last") || {}).textContent || "", btn: !!document.querySelector("#seo-head #seo-run:not([disabled])") }));
    ok("A6 · header strip reads 'Last audit <when> · <n>s' with the Run button", /^Last audit .+ · \d+\.\ds$/.test(head.text) && head.btn, JSON.stringify(head));

    const tbl = await p4.evaluate(() => {
      const rows = [...document.querySelectorAll("#seo-table tr.seo-row")];
      return {
        tables: document.querySelectorAll("#page-site-seo table").length,
        heads: [...document.querySelectorAll("#seo-table tr:first-child th")].map((t) => t.textContent.trim()),
        rows: rows.map((r) => ({
          page: r.dataset.page,
          chips: [...r.querySelectorAll(".seo-iss > summary .seo-chip")].map((c) => ({ code: c.dataset.code, level: c.dataset.level, red: c.classList.contains("red"), amber: c.classList.contains("amber"), title: c.getAttribute("title") })),
          hasDetails: !!r.querySelector("details.seo-iss"),
          statusChip: [...r.querySelectorAll(".seo-page .badge.red")].map((x) => x.textContent.trim()),
        })),
      };
    });
    eq("A7 · column headers", tbl.heads, ["Page", "Title", "Description", "H1", "Words", "PSI", "Clicks", "Position", "Issues"]);
    ok("A8 · the audit is ONE table (the queries list is not a table)", tbl.tables === 1, String(tbl.tables));
    eq("A9 · one row per audited page", tbl.rows.map((r) => r.page).sort(), T.audits.map((x) => x.page).sort());
    /* Chips: one per issue code; level colour; title = every message for that code. */
    let chipOk = true, chipWhy = "";
    T.audits.forEach((au) => {
      const row = tbl.rows.find((r) => r.page === au.page);
      const want = {};
      (au.d.issues || []).forEach((i) => { const w = want[i.code] || (want[i.code] = { level: "warn", msgs: [] }); if (i.level === "error") w.level = "error"; w.msgs.push(i.msg); });
      const got = row ? row.chips : [];
      if (got.length !== Object.keys(want).length) { chipOk = false; chipWhy += `${au.page}: ${got.length} chips vs ${Object.keys(want).length}; `; return; }
      got.forEach((c) => {
        const w = want[c.code];
        if (!w || c.level !== w.level || (w.level === "error" ? !c.red : !c.amber) || c.title !== w.msgs.join("\n")) { chipOk = false; chipWhy += `${au.page}:${c.code}; `; }
      });
    });
    ok("A10 · issue chips: one per code, red = error / amber = warn, hover title = the messages", chipOk, chipWhy);
    const httpErr = T.audits.find((x) => (x.d.issues || []).some((i) => i.code === "http_error"));
    ok("A11 · the http_error page has a row, an HTTP error chip and its status in red", !!httpErr && (() => { const r = tbl.rows.find((x) => x.page === httpErr.page); return r && r.chips.some((c) => c.code === "http_error" && c.red) && r.statusChip.includes(String(httpErr.d.status)); })(), httpErr && httpErr.page);
    const clean = T.audits.filter((x) => !(x.d.issues || []).length && !(x.d.broken_links || []).length).map((x) => x.page);
    ok("A12 · a clean page has no <details>", clean.every((pg) => { const r = tbl.rows.find((x) => x.page === pg); return r && !r.hasDetails; }), clean.join());

    /* Row click opens the issue list and broken links. */
    const brk = T.audits.find((x) => (x.d.broken_links || []).length);
    const ex = await p4.evaluate((pg) => {
      const tr = document.querySelector(`#seo-table tr.seo-row[data-page="${CSS.escape(pg)}"]`);
      const det = tr.querySelector("details.seo-iss");
      const before = det.open;
      tr.querySelector("td.seo-page").click();
      const after = det.open;
      const hrefs = [...det.querySelectorAll(".seo-broken code")].map((c) => c.textContent);
      const items = det.querySelectorAll(".seo-iss-list li").length;
      tr.querySelector("td.seo-page").click();
      return { before, after, hrefs, items, closed: !det.open };
    }, brk.page);
    ok("A13 · a row click opens its <details> and a second click closes it", !ex.before && ex.after && ex.closed, JSON.stringify(ex));
    eq("A14 · the opened row lists its broken links", ex.hrefs, brk.d.broken_links.map((l) => l.href));
    eq("A15 · …and every issue", ex.items, brk.d.issues.length);

    /* Top queries, clicks desc, ≤ 20. */
    const q = await p4.evaluate(() => ({
      names: [...document.querySelectorAll("#seo-queries .kit-row .t")].map((t) => t.textContent.trim()),
      connect: !!document.getElementById("seo-connect"),
    }));
    const wantQ = T.queries.slice().sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions).slice(0, 20).map((x) => x.query);
    eq("A16 · Top queries: clicks desc, ≤ 20, kit rows", q.names, wantQ);
    ok("A17 · no Connect panel while Search Console is connected", !q.connect);

    /* Run audit now: the invoke, the disabled/spinner state, the re-read. */
    await p4.evaluate(() => {
      window.__seoT = { invokes: [], reads: 0 };
      const inv = db.functions.invoke.bind(db.functions);
      db.functions.invoke = function (name, o) {
        window.__seoT.invokes.push({ name, body: o && o.body });
        return new Promise((r) => setTimeout(r, 400)).then(() => inv(name, o));
      };
      const from = db.from.bind(db);
      db.__seoFrom = from;
      db.from = function (t) { if (t === "seo_snapshots") window.__seoT.reads++; return from(t); };
    });
    await p4.click("#seo-run");
    await p4.waitForTimeout(80);
    const busy = await p4.evaluate(() => { const b = document.getElementById("seo-run"); return { disabled: b.disabled, spin: !!b.querySelector(".seo-spin"), busy: b.getAttribute("aria-busy") }; });
    ok("A18 · while running the button is disabled with a spinner", busy.disabled && busy.spin && busy.busy === "true", JSON.stringify(busy));
    await p4.click("#seo-run", { force: true }).catch(() => {});
    await p4.waitForFunction(() => { const b = document.getElementById("seo-run"); return b && !b.disabled; }, null, { timeout: 10000 });
    await p4.waitForTimeout(300);
    const run = await p4.evaluate(() => ({ t: window.__seoT, toast: (document.getElementById("toast") || {}).textContent || "", mi: (window.__mockInvokes || []).filter((x) => x.name === "seo-snapshot").length }));
    eq("A19 · exactly one invoke, of seo-snapshot with { force: true }", run.t.invokes, [{ name: "seo-snapshot", body: { force: true } }]);
    ok("A20 · the mock recorded the invoke too (window.__mockInvokes)", run.mi >= 1, String(run.mi));
    ok("A21 · after the run the tab re-read seo_snapshots (2 reads)", run.t.reads === 2, String(run.t.reads));
    ok("A22 · a toast says it finished", /Audit finished/.test(run.toast), run.toast);
    /* A failing function toasts the failure and re-enables the button. */
    await p4.evaluate(() => { db.functions.invoke = () => Promise.resolve({ data: null, error: { message: "boom" } }); });
    await p4.click("#seo-run");
    await p4.waitForTimeout(400);
    const fail = await p4.evaluate(() => ({ toast: (document.getElementById("toast") || {}).textContent || "", enabled: !document.getElementById("seo-run").disabled }));
    ok("A23 · a function error toasts 'Audit failed: …' and the button comes back", /Audit failed: boom/.test(fail.toast) && fail.enabled, JSON.stringify(fail));
    /* R93 · fixer: a 403 reads the function's body, as sitePublish does. */
    await p4.evaluate(() => { db.functions.invoke = () => Promise.resolve({ data: null, error: { message: "Edge Function returned a non-2xx status code", context: { json: async () => ({ ok: false, error: "second factor required" }) } } }); });
    await p4.click("#seo-run");
    await p4.waitForTimeout(400);
    const mfa = await p4.evaluate(() => (document.getElementById("toast") || {}).textContent || "");
    ok("A23b · a 403 toasts the body: 'Audit failed: second factor required'", /Audit failed: second factor required/.test(mfa), mfa);

    const inl = await p4.evaluate(() => document.getElementById("page-site-seo").querySelectorAll("[style]").length);
    eq("A24 · no inline style in the painted tab", inl, 0);

    /* ------------------------------------------------------------------ B. not connected */
    console.log("\nB · Search Console / PSI not connected");
    await p4.evaluate(() => {
      const s = window.__mock.db.seo_snapshots.filter((r) => r.kind === "summary").sort((x, y) => String(y.day).localeCompare(String(x.day)))[0];
      window.__seoSaved = JSON.stringify(s.data);
      s.data = Object.assign({}, s.data, { gsc_connected: false, gsc: null, psi_connected: false, psi_avg: null });
    });
    await repaint(p4);
    const nc = await p4.evaluate(() => ({
      gsc: document.querySelector("#seo-tile-gsc .num").textContent.trim(),
      psi: document.querySelector("#seo-tile-psi .num").textContent.trim(),
      steps: [...document.querySelectorAll("#seo-connect li")].map((l) => l.textContent.trim()),
      queries: !!document.getElementById("seo-queries"),
    }));
    eq("B1 · the clicks tile reads Connect", nc.gsc, "Connect");
    eq("B2 · Performance reads — until PSI is connected", nc.psi, "—");
    ok("B3 · the three-line Connect panel replaces Top queries", nc.steps.length === 3 && /service account/i.test(nc.steps[0]) && /GSC_SERVICE_ACCOUNT/.test(nc.steps[2]) && !nc.queries, JSON.stringify(nc));
    await p4.evaluate(() => { const s = window.__mock.db.seo_snapshots.filter((r) => r.kind === "summary").sort((x, y) => String(y.day).localeCompare(String(x.day)))[0]; s.data = JSON.parse(window.__seoSaved); });

    /* R93 · fixer: the run's persisted step failures → one "n notes" chip, messages in its title. */
    const chip0 = await p4.evaluate(() => !!document.querySelector("#seo-head .seo-notes"));
    await p4.evaluate(() => {
      const s = window.__mock.db.seo_snapshots.filter((r) => r.kind === "summary").sort((x, y) => String(y.day).localeCompare(String(x.day)))[0];
      s.data = Object.assign({}, s.data, { run_errors: ["psi /faq: 429 rate limited", "links: budget reached, 12 of 40 not checked"] });
    });
    await repaint(p4);
    const nt = await p4.evaluate(() => { const c = document.querySelector("#seo-head .seo-notes"); return c && { text: c.textContent, title: c.getAttribute("title") }; });
    ok("B4 · no notes chip on a clean run; persisted run_errors show as one “2 notes” chip with the messages in its title", !chip0 && nt && nt.text === "2 notes" && nt.title === "psi /faq: 429 rate limited\nlinks: budget reached, 12 of 40 not checked", JSON.stringify(nt));
    await p4.evaluate(() => { const s = window.__mock.db.seo_snapshots.filter((r) => r.kind === "summary").sort((x, y) => String(y.day).localeCompare(String(x.day)))[0]; s.data = JSON.parse(window.__seoSaved); });

    /* ------------------------------------------------------------------ C. empty */
    console.log("\nC · No snapshot yet");
    await p4.evaluate(() => { window.__seoAll = window.__mock.db.seo_snapshots.splice(0); });
    await repaint(p4);
    const em = await p4.evaluate(() => ({
      empty: !!document.getElementById("seo-empty"),
      btn: !!document.querySelector("#seo-empty #seo-run"),
      table: !!document.getElementById("seo-table"),
      tiles: !!document.getElementById("seo-tiles"),
      text: document.querySelector("#seo-empty .empty-state-h") && document.querySelector("#seo-empty .empty-state-h").textContent.trim(),
    }));
    ok("C1 · empty state: one line + the Run button, no tiles or table", em.empty && em.btn && !em.table && !em.tiles && !!em.text, JSON.stringify(em));
    await p4.evaluate(() => { window.__mock.db.seo_snapshots.push(...window.__seoAll); db.from = db.__seoFrom; });
    await repaint(p4);

    /* ------------------------------------------------------------------ D. admin + phone */
    console.log("\nD · Administrator (p1) and phone");
    const p1 = await boot(browser, "p1");
    pages.push(p1);
    await openSeo(p1);
    const p1n = await p1.evaluate(() => ({ tiles: document.querySelectorAll("#seo-tiles > .kpi").length, rows: document.querySelectorAll("#seo-table tr.seo-row").length }));
    ok("D1 · an administrator sees the tiles and the table", p1n.tiles === 4 && p1n.rows === T.audits.length, JSON.stringify(p1n));
    const ph = await boot(browser, "p4", { viewport: PHONE });
    pages.push(ph);
    await openSeo(ph);
    const pm = await ph.evaluate(() => ({ overflow: document.documentElement.scrollWidth - window.innerWidth, rows: document.querySelectorAll("#seo-table tr.seo-row").length }));
    ok("D2 · phone 390: the table renders and the page does not scroll sideways", pm.rows === T.audits.length && pm.overflow <= 1, JSON.stringify(pm));

    /* ------------------------------------------------------------------ E. console */
    console.log("\nE · Console");
    pages.forEach((pg, i) => ok(`E${i + 1} · no console errors (${["p4", "p1", "p4 phone"][i]})`, realErr(pg).length === 0, realErr(pg).join(" | ")));
  } catch (e) {
    failures.push("CRASH — " + (e && e.stack || e));
    console.log("CRASH", e);
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (_) { /* already gone */ }
  }
  console.log(`\nR93 SEO: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
