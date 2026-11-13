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
    ok("S5 · every seo_snapshots read goes through seoQ() (R100: day, its rows, the week-older snapshot, one series)", (fence.match(/from\("seo_snapshots"\)/g) || []).length === 1 && (fence.match(/seoQ\(\)\./g) || []).length === 4);

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
        tables: document.querySelectorAll("#page-site-seo table.seo-table").length,
        heads: [...document.querySelectorAll("#seo-table tr:first-child th")].map((t) => t.textContent.trim()),
        rows: rows.map((r) => ({
          page: r.dataset.page,
          chips: [...r.querySelectorAll(".seo-iss > summary .seo-chip")].map((c) => ({ code: c.dataset.code, level: c.dataset.level, red: c.classList.contains("red"), amber: c.classList.contains("amber"), title: c.getAttribute("title") })),
          hasDetails: !!r.querySelector("details.seo-iss"),
          statusChip: [...r.querySelectorAll(".seo-page .badge.red")].map((x) => x.textContent.trim()),
        })),
      };
    });
    eq("A7 · column headers", tbl.heads, ["Page", "Title", "Description", "H1", "Words", "PSI", "Clicks", "Position", "Change", "Issues"]);
    ok("A8 · the audit is ONE table", tbl.tables === 1, String(tbl.tables));
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
      names: [...document.querySelectorAll("#seo-queries tr.seo-qrow td.seo-q")].map((t) => t.textContent.trim()),
      connect: !!document.getElementById("seo-connect"),
    }));
    const wantQ = T.queries.slice().sort((x, y) => y.impressions - x.impressions).slice(0, 25).map((x) => x.query);
    eq("A16 · Search queries: impressions desc, ≤ 25 until Show all (R100)", q.names, wantQ);
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
    ok("A21 · after the run the tab re-read seo_snapshots (4 reads: day, rows, week-older, series)", run.t.reads === 4, String(run.t.reads));
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

    /* ------------------------------------------------------------------ F. R100 — history, change, queries, recommendations */
    console.log("\nF · R100 — history chart, Change, queries table, recommendations");
    const pf = await boot(browser, "p4");
    pages.push(pf);
    await openSeo(pf);
    const snap = () => pf.evaluate(() => ({
      scope: (document.getElementById("seo-scope") || {}).value,
      charts: [...document.querySelectorAll("#seo-charts .seo-chart")].map((c) => ({ m: c.dataset.metric, v: c.querySelector(".seo-chart-v").textContent.trim(), bars: c.querySelectorAll(".seo-bar").length, line: (c.querySelector(".seo-line") || { getAttribute: () => "" }).getAttribute("d").length })),
      n: Number((document.getElementById("seo-charts") || { dataset: {} }).dataset.n || 0),
      active: [...document.querySelectorAll("[data-seo-range].active")].map((b) => b.dataset.seoRange),
      empty: !!document.getElementById("seo-hist-empty"),
    }));
    const h0 = await snap();
    const TH = await pf.evaluate(() => {
      const rows = window.__mock.db.seo_snapshots.filter((r) => r.kind === "gsc_day");
      return { n: rows.length, clicks: rows.reduce((t, r) => t + r.data.clicks, 0), imp: rows.reduce((t, r) => t + r.data.impressions, 0) };
    });
    eq("F1 · the chart opens on the whole site, 90 days", [h0.scope, h0.active], ["site", ["90"]]);
    eq("F2 · three charts on one axis: clicks, impressions, position", h0.charts.map((c) => c.m), ["clicks", "impressions", "position"]);
    eq("F3 · the clicks and impressions totals are the fixture's sums", [h0.charts[0].v, h0.charts[1].v], [fmt(TH.clicks), fmt(TH.imp)]);
    ok("F4 · bars for the days with impressions, a drawn position line, one point per day", h0.charts[1].bars === TH.n && h0.charts[2].line > 20 && h0.n >= TH.n, JSON.stringify(h0));
    ok("F5 · one y-scale per chart: no svg carries two series", await pf.evaluate(() => [...document.querySelectorAll(".seo-svg")].every((s) => !(s.querySelector(".seo-bar") && s.querySelector(".seo-line")))));
    await pf.click('[data-seo-range="28"]');
    await pf.waitForFunction(() => document.querySelector('[data-seo-range="28"].active'), null, { timeout: 5000 });
    const h28 = await snap();
    ok("F6 · 28 days narrows the axis to 28 points", h28.n === 28 && h28.active[0] === "28", JSON.stringify(h28));
    await pf.click('#seo-table tr.seo-row[data-page="/remortgage-bournemouth"] .seo-hist-btn');
    await pf.waitForFunction(() => document.getElementById("seo-scope").value === "page:/remortgage-bournemouth", null, { timeout: 5000 });
    const hp = await snap();
    ok("F7 · a page's History button charts that page and leaves its issues closed", hp.charts.length === 3 && hp.charts[1].bars > 0 && await pf.evaluate(() => !document.querySelector('#seo-table tr.seo-row[data-page="/remortgage-bournemouth"] details[open]')), JSON.stringify(hp));
    await pf.click('#seo-queries tr.seo-qrow[data-key="mortgage broker bournemouth"] td.seo-q');
    await pf.waitForFunction(() => document.getElementById("seo-scope").value === "query:mortgage broker bournemouth", null, { timeout: 5000 });
    ok("F8 · a query row charts that query", (await snap()).charts[1].bars > 0);
    await pf.selectOption("#seo-scope", "page:/contact");
    await pf.waitForFunction(() => document.getElementById("seo-hist-empty"), null, { timeout: 5000 });
    ok("F9 · a page with no daily rows says so instead of drawing an empty chart", (await snap()).empty);
    await pf.selectOption("#seo-scope", "site");
    await pf.waitForFunction(() => document.getElementById("seo-charts"), null, { timeout: 5000 });
    await pf.waitForTimeout(900);   // the smooth scroll back to the chart
    const box = await (await pf.$(".seo-svg")).boundingBox();
    await pf.mouse.move(box.x + box.width * 0.4, box.y + 10);
    await pf.mouse.move(box.x + box.width * 0.5, box.y + 12);
    await pf.waitForTimeout(100);
    const hov = await pf.evaluate(() => ({ t: document.getElementById("seo-hover").textContent, x: [...document.querySelectorAll(".seo-cross")].map((l) => l.getAttribute("x1")) }));
    ok("F10 · hovering reads out the date and all three figures, with one crosshair in every chart", /\d+ \w+ · \d+ clicks? · [\d,]+ impressions · position [\d.—]+/.test(hov.t) && hov.x.length === 3 && new Set(hov.x).size === 1 && Number(hov.x[0]) > 0, JSON.stringify(hov));

    const chg = await pf.evaluate(() => {
      const cell = (sel) => { const c = document.querySelector(sel); return c ? { t: c.textContent.trim(), green: c.classList.contains("green"), red: c.classList.contains("red"), title: c.getAttribute("title") } : null; };
      return {
        home: cell('#seo-table tr.seo-row[data-page="/"] .seo-delta'), remo: cell('#seo-table tr.seo-row[data-page="/remortgage-bournemouth"] .seo-delta'),
        btl: cell('#seo-table tr.seo-row[data-page="/buy-to-let-mortgages-dorset"] .seo-delta'), q: cell('#seo-queries tr.seo-qrow[data-key="mortgage broker bournemouth"] .seo-delta'),
      };
    });
    ok("F11 · Change: 12.9 → 11.4 is ▲ 1.5 green, 13.0 → 14.2 is ▼ 1.2 red, a page unseen a week earlier is 'new'", chg.home && chg.home.t === "▲ 1.5" && chg.home.green && chg.home.title === "Position 12.9 a week earlier" && chg.remo.t === "▼ 1.2" && chg.remo.red && chg.btl.t === "new", JSON.stringify(chg));
    ok("F12 · the same on a query: 7.8 → 6.3 is ▲ 1.5", chg.q && chg.q.t === "▲ 1.5" && chg.q.green, JSON.stringify(chg.q));

    const qt = await pf.evaluate(() => ({ heads: [...document.querySelectorAll("#seo-queries tr:first-child th")].map((t) => t.textContent.trim()), page: document.querySelector('#seo-queries tr.seo-qrow[data-key="mortgage broker bournemouth"] td.seo-qpage').textContent.trim() }));
    eq("F13 · queries table columns, sorted by impressions", qt.heads, ["Query", "Clicks", "Impressions ↓", "CTR", "Position", "Change", "Page"]);
    eq("F14 · the Page column names the ranking page and counts the others", qt.page, "/ +1");
    await pf.click('#seo-queries th[data-seo-sort="position"]');
    const byPos = await pf.evaluate(() => [...document.querySelectorAll("#seo-queries tr.seo-qrow td.seo-q")].map((t) => t.textContent.trim()));
    eq("F15 · a header click sorts by that column (position, worst first)", byPos, T.queries.slice().sort((x, y) => y.position - x.position).map((x) => x.query));
    await pf.fill("#seo-qfilter", "remortgage");
    const fl = await pf.evaluate(() => ({ rows: [...document.querySelectorAll("#seo-queries tr.seo-qrow td.seo-q")].map((t) => t.textContent.trim()), focus: document.activeElement.id }));
    ok("F16 · the filter narrows the rows and keeps its focus", fl.rows.length === 1 && fl.rows[0] === "remortgage bournemouth" && fl.focus === "seo-qfilter", JSON.stringify(fl));

    const recs = await pf.evaluate(() => [...document.querySelectorAll("#seo-recs .seo-rec")].map((r) => ({ label: r.querySelector(".badge").textContent.trim(), q: r.querySelector(".seo-rec-q").textContent.trim(), a: r.querySelector(".seo-rec-a").textContent.trim() })));
    const rec = (q) => recs.find((r) => r.q === q) || {};
    eq("F17 · one recommendation per rule, most actionable first", recs.map((r) => r.label), ["Nearly page one", "Nearly page one", "Two pages competing", "Page one, few clicks", "Seen but buried", "Seen but buried", "Old address"]);
    ok("F18 · nearly page one: names the page that already targets it, or says where to add the phrase", /^\/buy-to-let-mortgages-dorset already targets this/.test(rec("buy to let mortgage dorset").a) && /title and main heading of \/\./.test(rec("mortgage adviser christchurch").a), JSON.stringify(recs.slice(0, 2)));
    ok("F19 · two pages competing names both; the brand query earns no recommendation", /^\/ and \/mortgages both show/.test(rec("mortgage broker bournemouth").a) && !recs.some((r) => r.q === "nexmoney"));
    ok("F20 · an old address still listed by Google is flagged", rec("/mortgages/shared-ownership").label === "Old address");
    await pf.evaluate(() => { const s = window.__mock.db.seo_snapshots.filter((r) => r.kind === "summary").sort((x, y) => String(y.day).localeCompare(String(x.day)))[0]; s.data = Object.assign({}, s.data, { gsc_connected: false, gsc: null }); });
    await repaint(pf);
    ok("F21 · without Search Console there is no history panel and no recommendations", await pf.evaluate(() => !document.getElementById("seo-history") && !document.getElementById("seo-recs") && !!document.getElementById("seo-connect")));
    eq("F22 · no inline style in the R100 markup", await pf.evaluate(() => document.getElementById("page-site-seo").querySelectorAll("[style]").length), 0);

    /* ------------------------------------------------------------------ E. console */
    console.log("\nE · Console");
    pages.forEach((pg, i) => ok(`E${i + 1} · no console errors (${["p4", "p1", "p4 phone", "p4 R100"][i]})`, realErr(pg).length === 0, realErr(pg).join(" | ")));
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
