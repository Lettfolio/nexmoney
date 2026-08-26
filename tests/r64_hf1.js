#!/usr/bin/env node
/* =============================================================================
   tests/r64_hf1.js — R64-HF1: chunked .in() reads.

   Production finding (26 Aug, in Daniel's browser): PostgREST answers 400 Bad
   Request when an .in() list runs past ~500 UUIDs (the list travels in the
   URL). The Retention feed is 725+ cases and v_alerts is 1,000 rows, so
   loadPropContext's single `.in("id", ids)` failed silently — no property
   chips, no shared-property flags and none of R64's tel: links, with nothing
   in the console. The 69-case mock never reaches the limit, which is why no
   suite noticed. `inChunks(ids, build)` now splits every feed-sized batch read
   into slices of IN_CHUNK (150) and concatenates the rows.

   §A — inChunks splits: 400 ids → 3 queries (150/150/100), rows concatenated,
        duplicates and blanks removed first, an empty list makes no query.
   §B — an error in ONE slice surfaces as the read's error (the {data,error}
        shape every caller already handles).
   §C — loadPropContext over every fixture case PLUS 400 synthetic ids still
        resolves every fixture case (the real-shaped read, chunked).
   §D — the Retention page still renders tel: links and property chips for
        p4 (the surface that went dark in production).
   §E — no console errors.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r64_hf1.js
   ========================================================================== */
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;

let pass = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (n, a, e) => ok(n, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false)); r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}
async function newPage(browser, persona) {
  const page = await browser.newPage();
  page.on("dialog", async (d) => { await d.accept(); });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { try { ["nx_ret_scope", "nx_ret_month", "nx_clients_adviser"].forEach((k) => localStorage.removeItem(k)); } catch (_) {} });
  return page;
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {
    const page = await newPage(browser, "p4");

    console.log("\n— A · inChunks splits a 400-id list into 3 queries and concatenates");
    const a = await page.evaluate(async () => {
      const ids = Array.from({ length: 400 }, (_, i) => "00000000-0000-4000-8000-" + String(i).padStart(12, "0"));
      const withDupes = ids.concat(ids.slice(0, 20), [null, "", undefined]);
      let calls = 0; const sizes = [];
      const r = await window.inChunks(withDupes, (sl) => { calls++; sizes.push(sl.length); return window.__mockDb.from("cases").select("id").in("id", sl); });
      const empty = await window.inChunks([], () => { calls += 100; return null; });
      return { calls, sizes, err: r.error, rows: (r.data || []).length, emptyRows: (empty.data || []).length, emptyErr: empty.error };
    });
    eq("A1 · three queries for 400 distinct ids", a.calls, 3);
    eq("A2 · slice sizes 150 / 150 / 100 (duplicates and blanks dropped first)", a.sizes, [150, 150, 100]);
    ok("A3 · no error, no rows for ids that do not exist", a.err === null && a.rows === 0, JSON.stringify(a));
    ok("A4 · an empty list makes no query and returns {data:[], error:null}", a.calls === 3 && a.emptyRows === 0 && a.emptyErr === null);

    console.log("\n— B · one failing slice surfaces as the read's error");
    const b = await page.evaluate(async () => {
      const ids = Array.from({ length: 200 }, (_, i) => "00000000-0000-4000-8000-" + String(i).padStart(12, "0"));
      let n = 0;
      const r = await window.inChunks(ids, () => { n++; return n === 2 ? { data: null, error: { message: "slice two broke" } } : { data: [{ id: "x" + n }], error: null }; });
      return { err: r.error && r.error.message, rows: (r.data || []).map((x) => x.id) };
    });
    eq("B1 · the error object is the failing slice's", b.err, "slice two broke");
    eq("B2 · rows from the good slices are still returned", b.rows, ["x1"]);

    console.log("\n— C · loadPropContext resolves every fixture case even when padded past the chunk size");
    const c = await page.evaluate(async () => {
      const { data: cases } = await window.__mockDb.from("cases").select("id");
      const real = cases.map((x) => x.id);
      const pad = Array.from({ length: 400 }, (_, i) => "00000000-0000-4000-8000-" + String(i).padStart(12, "0"));
      const ctx = await window.loadPropContext(real.concat(pad));
      return { real: real.length, resolved: real.filter((id) => !!ctx.byId[id]).length, extra: Object.keys(ctx.byId).length - real.length };
    });
    ok("C1 · every real case resolved through a 469-id read", c.resolved === c.real && c.real > 0, JSON.stringify(c));
    eq("C2 · no phantom rows from the padding", c.extra, 0);

    console.log("\n— D · the Retention page renders tel: links and property chips (p4)");
    await page.evaluate(() => window.nav("retention"));
    await page.waitForTimeout(2500);
    const d = await page.evaluate(() => ({
      rows: document.querySelectorAll("#ret-rates-list .row-item").length,
      tel: document.querySelectorAll('#ret-rates-list a[href^="tel:"]').length,
      props: document.querySelectorAll("#ret-rates-list .row-prop").length,
    }));
    ok("D1 · rows render", d.rows > 0, JSON.stringify(d));
    ok("D2 · at least one tel: link (fixture clients have phones)", d.tel > 0, JSON.stringify(d));
    ok("D3 · at least one property chip", d.props > 0, JSON.stringify(d));

    console.log("\n— E · console");
    ok("E1 · no console errors", !(page.__err || []).length, JSON.stringify(page.__err));
    await page.close();
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(`\nR64_HF1: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
