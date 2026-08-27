#!/usr/bin/env node
/* =============================================================================
   tests/r69_hf1.js — R69-HF1: PostgREST's 1,000-row ceiling is real; page past it.

   Production finding (27 Aug, proven in Daniel's browser against the live
   database):

     db.from('clients').select('id',{count:'exact'}).order('last_name').limit(20000)
       → data.length 1000, count 1161
     db.from('cases').select('id',{count:'exact'}).limit(20000)
       → data.length 1000, count 2015
     db.from('clients').select('id').order('last_name').range(1000,1999)
       → 161 rows

   Supabase runs PostgREST with `max-rows = 1000`. That is a HARD SERVER
   ceiling: `.limit(n)` can only ever ask for FEWER rows than the server will
   send, never more. R18/R23 introduced REPORTS_ROW_CAP = OWNER_ROW_CAP = 20000
   and hung `.limit(OWNER_ROW_CAP)` on ~32 owner-facing whole-table reads in the
   belief that it lifted the ceiling. It did not — so since the back-book import
   (1,161 clients / 2,015 cases) every one of those reads has silently returned
   the first 1,000 rows of its order, with no error and no notice: the case
   modal's client picker (ordered by surname — everything from "Whitcombe" on
   simply vanished, and a case whose client is not in the picker cannot be
   saved at all), the Clients page, Data health, Reports, the Retention feed,
   the Revolution/statement importers, the change-history CSV and error_events.

   The 69-case mock never reaches 1,000 rows, which is exactly why no suite ever
   caught it. admin/mock-supabase.js now ENFORCES the ceiling (MOCK_MAX_ROWS,
   default 1000, with __mock.setMaxRows/__mock.maxRows), and admin/app.js pages
   every one of those reads through readAll() instead.

   §A — readAll() itself: 2,300 synthetic rows walked in three 1,000-row
        `.range()` pages off ONE re-awaited builder, order preserved, count
        from the first page kept, the cap still biting exactly AT the cap, a
        mid-walk page error surfacing with the rows already in hand, and an
        empty table answering {data: [], error: null} in a single page.
   §B — the surfaces that were broken, at 1,200+ clients with the mock at its
        real 1,000 ceiling: the case modal's client picker holds a "Z" surname
        that sorts past row 1,000 and a case SAVES against it; the Clients page
        counts the whole book; Data health's tile counts are computed over
        every row; the Reports cap notice stays quiet (it always did — it never
        fired at 1,000, which is precisely how this stayed invisible).
   §C — the mock's ceiling behaves like the server's: `.limit(5000)` on 1,200
        rows returns 1,000, `.range(1000,1999)` returns 200, and count:'exact'
        still reports the TRUE 1,200.
   §D — no console errors / no new window.__errorLog entries anywhere above.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r69_hf1.js
         (expects a static server on 8099; starts one itself if absent)
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
  page.on("dialog", (d) => d.accept().catch(() => {}));
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    try {
      ["nx_ret_scope", "nx_ret_month", "nx_clients_adviser", "nx_pipe_segment", "nx_pipe_view"].forEach((k) => localStorage.removeItem(k));
    } catch (_) {}
  });
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const noNewErr = (page, before) => (page.__err || []).length === before;
const errLogLen = (page) => page.evaluate(() => (window.__errorLog ? window.__errorLog.length : -1));
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1200 : ms);
};
/* Heavy pages get poll-until-stable rather than a fixed sleep (same helper shape r29_scale uses). */
async function waitStable(page, sel, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 25000, interval = opts.interval || 300, stableFor = opts.stableFor || 700;
  const start = Date.now();
  let lastLen = -1, lastChange = Date.now();
  for (;;) {
    const len = await page.$eval(sel, (el) => el.innerHTML.length).catch(() => -1);
    if (len !== lastLen) { lastLen = len; lastChange = Date.now(); }
    if (Date.now() - lastChange >= stableFor && len > 0) return len;
    if (Date.now() - start > timeout) return lastLen;
    await wait(page, interval);
  }
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       §A · readAll() — the helper, against real mock tables through the real
            query builder (not a stub), so what is proven is the same code path
            production takes. `proc_rates` starts EMPTY and carries a numeric
            serial id, so 2,300 inserted rows are 2,300 rows in a known order
            with nothing from the fixture mixed in.
       ======================================================================= */
    const page = await newPage(browser, "p4"); // Daniel Potts, owner
    const errBeforeA = (page.__err || []).length;
    const logBeforeA = await errLogLen(page);

    console.log("\n— A · readAll() walks 2,300 synthetic rows in three 1,000-row pages (p4)");

    const seeded = await page.evaluate(async () => {
      const rows = [];
      // `rate` is a 0..1 proportion (proc_rates_rate_chk) — the row's identity here is its serial id.
      for (let i = 0; i < 2300; i++) rows.push({ lender: "L" + String(i).padStart(5, "0"), product: "P", rate: 0.004 });
      const res = await window.__mockDb.from("proc_rates").insert(rows).select("id");
      if (res.error) throw new Error("proc_rates insert failed: " + res.error.message);
      return res.data.length;
    });
    eq("A0 · 2,300 synthetic rows seeded (an insert's returning rows are NOT subject to max-rows, exactly as in PostgREST)", seeded, 2300);

    const a1 = await page.evaluate(async () => {
      const q = window.__mockDb.from("proc_rates").select("id,rate").order("id");
      const calls = [];
      const origRange = q.range.bind(q);
      q.range = function (from, to) { calls.push([from, to]); return origRange(from, to); };
      const r = await window.readAll(q);
      const ids = (r.data || []).map((x) => x.id);
      let ascending = true;
      for (let i = 1; i < ids.length; i++) if (!(ids[i] > ids[i - 1])) { ascending = false; break; }
      return { calls, len: ids.length, err: r.error, ascending, first: ids[0], last: ids[ids.length - 1] };
    });
    eq("A1 · every one of the 2,300 rows comes back (the .limit(20000) read returned 1,000)", a1.len, 2300);
    ok("A1 · …with no error", a1.err === null, JSON.stringify(a1.err));
    eq("A2 · exactly three pages, each a 1,000-row .range() window on ONE builder", a1.calls, [[0, 999], [1000, 1999], [2000, 2999]]);
    ok("A3 · order is preserved across the page boundaries — ids strictly ascending, 1 → 2300", a1.ascending && a1.first === 1 && a1.last === 2300, JSON.stringify({ first: a1.first, last: a1.last, ascending: a1.ascending }));

    const a4 = await page.evaluate(async () => {
      const q = window.__mockDb.from("proc_rates").select("id").order("id");
      const calls = [];
      const origRange = q.range.bind(q);
      q.range = function (from, to) { calls.push([from, to]); return origRange(from, to); };
      const r = await window.readAll(q, { cap: 1500 });
      const ids = (r.data || []).map((x) => x.id);
      return { calls, len: ids.length, last: ids[ids.length - 1], err: r.error };
    });
    eq("A4 · a cap stops the walk AT the cap, never past it — 1,500 rows", a4.len, 1500);
    eq("A4 · …and the last page asks only for the balance, not another whole 1,000", a4.calls, [[0, 999], [1000, 1499]]);
    ok("A4 · …so `rows.length === CAP` (what ownerCapHit/noteRowCap test) still means 'truncated'", a4.len === 1500 && a4.err === null, JSON.stringify(a4));

    const a5 = await page.evaluate(async () => {
      /* count:'exact' — PostgREST reports the TRUE total in content-range on every page regardless
         of the window, so readAll keeps the first page's and never has to ask twice. */
      const r = await window.readAll(window.__mockDb.from("proc_rates").select("id", { count: "exact" }).order("id"));
      return { count: r.count, len: (r.data || []).length };
    });
    eq("A5 · count:'exact' is preserved from the first page", a5.count, 2300);
    eq("A5 · …and the data is the whole set, not the first page", a5.len, 2300);

    const a6 = await page.evaluate(async () => {
      /* A hand-built thenable that answers page 1 and then fails, so the error path is exercised
         without having to break a real table. It is shaped exactly like a PostgrestBuilder:
         .range() mutates and returns itself, .then() fires a fresh request every time. */
      let n = 0;
      const fake = {
        windows: [],
        range: function (from, to) { this.windows.push([from, to]); return this; },
        then: function (res, rej) {
          n++;
          const out = n === 1
            ? { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null, count: 2300 }
            : { data: null, error: { message: "page two broke", code: "PGRST999" } };
          return Promise.resolve(out).then(res, rej);
        },
      };
      const r = await window.readAll(fake);
      return { err: r.error && r.error.message, rows: (r.data || []).length, count: r.count, windows: fake.windows, calls: n };
    });
    eq("A6 · a mid-walk page error surfaces as the read's error", a6.err, "page two broke");
    eq("A6 · …with the rows already in hand returned alongside it, not thrown away", a6.rows, 1000);
    eq("A6 · …and the walk stops there (two requests, not three)", a6.calls, 2);
    eq("A6 · …count from the good first page is kept", a6.count, 2300);

    const a7 = await page.evaluate(async () => {
      const q = window.__mockDb.from("duplicate_dismissals").select("*").order("id");
      let calls = 0;
      const origRange = q.range.bind(q);
      q.range = function (from, to) { calls++; return origRange(from, to); };
      const r = await window.readAll(q);
      return { calls, data: r.data, err: r.error };
    });
    eq("A7 · an empty table answers {data: [], error: null} …", { data: a7.data, err: a7.err }, { data: [], err: null });
    eq("A7 · …in exactly one page (a short page ends the walk)", a7.calls, 1);

    /* =======================================================================
       §C · THE MOCK'S CEILING ITSELF — the parity that makes every assertion
            above and below mean something. commission_lines starts EMPTY with
            a numeric serial id, so 1,200 rows are exactly 1,200 rows.
       ======================================================================= */
    console.log("\n— C · the mock enforces PostgREST's max-rows exactly as the server does (p4)");
    const cSeeded = await page.evaluate(async () => {
      // commission_lines.statement_id is NOT NULL — one parent statement, then its 1,200 lines.
      const st = await window.__mockDb.from("commission_statements")
        .insert({ ref: "R69HF1", statement_label: "R69-HF1 ceiling fixture", filename: "r69hf1.xlsx" }).select("id").single();
      if (st.error) throw new Error("statement insert failed: " + st.error.message);
      const rows = [];
      for (let i = 0; i < 1200; i++) rows.push({ statement_id: st.data.id, tran_type: "MORT", banked_gross: i });
      const res = await window.__mockDb.from("commission_lines").insert(rows).select("id");
      if (res.error) throw new Error("commission_lines insert failed: " + res.error.message);
      return res.data.length;
    });
    eq("C0 · 1,200 rows seeded", cSeeded, 1200);

    const c = await page.evaluate(async () => {
      const t = () => window.__mockDb.from("commission_lines");
      const lim5000 = await t().select("id").order("id").limit(5000);
      const noLimit = await t().select("id").order("id");
      const win = await t().select("id").order("id").range(1000, 1999);
      const bigWin = await t().select("id").order("id").range(0, 4999);
      const counted = await t().select("id", { count: "exact" }).order("id").limit(5000);
      const small = await t().select("id").order("id").limit(7);
      return {
        maxRows: window.__mock.maxRows(),
        lim5000: lim5000.data.length,
        noLimit: noLimit.data.length,
        win: win.data.length,
        winFirst: win.data[0] && win.data[0].id,
        bigWin: bigWin.data.length,
        count: counted.count,
        countedLen: counted.data.length,
        small: small.data.length,
      };
    });
    eq("C1 · __mock.maxRows() is 1000 by default — the value Supabase ships", c.maxRows, 1000);
    eq("C2 · .limit(5000) on 1,200 rows returns 1,000 — a limit ABOVE max-rows is clamped, silently", c.lim5000, 1000);
    eq("C3 · no limit at all also returns the first 1,000", c.noLimit, 1000);
    eq("C4 · .range(1000,1999) returns the remaining 200 — paging past the ceiling is the way through", c.win, 200);
    eq("C4 · …starting at row 1,001 of the ordered set", c.winFirst, 1001);
    eq("C5 · a .range() window WIDER than the ceiling is clamped to it, offset honoured", c.bigWin, 1000);
    eq("C6 · count:'exact' still reports the TRUE total — the only signal a truncated caller gets", c.count, 1200);
    eq("C6 · …while the data alongside it is still just 1,000 rows", c.countedLen, 1000);
    eq("C7 · a limit BELOW max-rows is untouched", c.small, 7);

    const c8 = await page.evaluate(async () => {
      const before = window.__mock.maxRows();
      const set = window.__mock.setMaxRows(25);
      const got = (await window.__mockDb.from("commission_lines").select("id").order("id")).data.length;
      const off = window.__mock.setMaxRows(0);
      const uncapped = (await window.__mockDb.from("commission_lines").select("id").order("id")).data.length;
      window.__mock.setMaxRows(before);
      return { set, got, off, uncapped, restored: window.__mock.maxRows() };
    });
    eq("C8 · __mock.setMaxRows(25) moves the ceiling", { set: c8.set, got: c8.got }, { set: 25, got: 25 });
    eq("C8 · __mock.setMaxRows(0) removes it entirely (for a test that wants the old unbounded mock)", { off: c8.off, uncapped: c8.uncapped }, { off: 0, uncapped: 1200 });
    eq("C8 · …and it restores cleanly", c8.restored, 1000);

    /* readAll over the SAME 1,200 rows: the whole point, end to end. */
    const c9 = await page.evaluate(async () => {
      const r = await window.readAll(window.__mockDb.from("commission_lines").select("id").order("id"));
      return { len: (r.data || []).length, err: r.error };
    });
    eq("C9 · readAll over the same table gets all 1,200 where a plain select gets 1,000", c9.len, 1200);
    ok("C9 · …with no error", c9.err === null, JSON.stringify(c9.err));

    console.log("\n— D(a) · console, page one");
    ok("D1 · no console errors across §A and §C", noNewErr(page, errBeforeA), JSON.stringify(page.__err));
    eq("D1 · no new window.__errorLog entries across §A and §C", await errLogLen(page), logBeforeA);
    await page.close();

    /* =======================================================================
       §B · THE BROKEN SURFACES, at production-like scale on a clean page.
            1,200 clients minted here, surnames spread A–Z so the picker's
            `.order("last_name")` genuinely interleaves them — which is what
            put "Whitcombe" past row 1,000 in the real book and out of the
            picker entirely.
       ======================================================================= */
    const p2 = await newPage(browser, "p4");
    const errBeforeB = (p2.__err || []).length;
    const logBeforeB = await errLogLen(p2);

    console.log("\n— B · 1,200 clients seeded, surnames spread A–Z, mock at its real 1,000 ceiling (p4)");

    const seed = await p2.evaluate(async () => {
      const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const FIRST = ["Alice", "Ben", "Cara", "Dev", "Elena", "Femi", "Greg", "Hana", "Ivan", "Jo"];
      const rows = [];
      for (let i = 0; i < 1200; i++) {
        const letter = ALPHA[i % 26];
        rows.push({
          first_name: FIRST[i % FIRST.length],
          // "Aardvark0000" … "Zaardvark1199" — one surname per letter, evenly spread, so an
          // ordered read genuinely has to travel the whole alphabet to reach the end.
          last_name: letter + "arksworth" + String(i).padStart(4, "0"),
          // Deliberately no email AND no phone on every seeded row, so Data health's
          // "Missing email & phone" tile has a count that can only be right if the read saw
          // all 1,200 — a truncated read cannot reach 1,200 by construction.
          email: null,
          phone: null,
        });
      }
      // The one row §B hangs on: a surname that sorts near the very end of the book.
      rows.push({ first_name: "Zoltan", last_name: "Zylstra", email: "zoltan.zylstra@example.com", phone: "07700 900999" });
      const res = await window.__mockDb.from("clients").insert(rows).select("id");
      if (res.error) throw new Error("client insert failed: " + res.error.message);

      // Ground truth, read the only way that can be trusted now: paged. Deliberately hand-rolled
      // rather than calling app.js's readAll, so the check stays independent of the code under test.
      const readAllRaw = async (table, cols, orderCols) => {
        const PAGE = 1000, out = [];
        for (let from = 0; from < 500000; from += PAGE) {
          let q = window.__mockDb.from(table).select(cols);
          (orderCols || ["id"]).forEach((c) => { q = q.order(c); });
          const r = await q.range(from, from + PAGE - 1);
          const got = (r && r.data) || [];
          for (let i = 0; i < got.length; i++) out.push(got[i]);
          if (got.length < PAGE) break;
        }
        return out;
      };
      const byName = await readAllRaw("clients", "id,last_name,first_name,email,phone", ["last_name", "id"]);
      const z = byName.find((c) => c.last_name === "Zylstra");
      return {
        inserted: res.data.length,
        totalClients: byName.length,
        missingBoth: byName.filter((c) => !c.email && !c.phone).length,
        zId: z && z.id,
        zRank: byName.findIndex((c) => c.last_name === "Zylstra"),
        maxRows: window.__mock.maxRows(),
      };
    });
    eq("B0 · 1,201 clients minted", seed.inserted, 1201);
    eq("B0 · the mock is at its real 1,000-row ceiling for every read below", seed.maxRows, 1000);
    ok("B0 · the book is now past the ceiling (1,251 clients with the fixture's 50)", seed.totalClients > 1000, seed.totalClients);
    ok("B1 · 'Zylstra' sorts PAST row 1,000 by surname — the exact shape that vanished in production",
      seed.zRank >= 1000, `rank ${seed.zRank} of ${seed.totalClients}`);

    // --- the case modal's client picker -------------------------------------
    await goto(p2, "pipeline", 1500);
    await p2.click("#new-case-btn");
    await wait(p2, 2500);
    const picker = await p2.evaluate((zId) => {
      const sel = document.querySelector("#case-client-select");
      if (!sel) return null;
      const opts = Array.from(sel.options);
      return {
        options: opts.length,
        hasZ: opts.some((o) => o.value === zId),
        zText: (opts.find((o) => o.value === zId) || {}).textContent || null,
        zStarts: opts.filter((o) => /^Z/.test((o.textContent || "").trim())).length,
      };
    }, seed.zId);
    ok("B2 · the case modal's client picker exists", !!picker, JSON.stringify(picker));
    eq("B2 · it holds EVERY client (1,251 + the placeholder + '+ New client…'), not the first 1,000",
      picker && picker.options, seed.totalClients + 2);
    ok("B3 · a client whose surname starts with 'Z' is in the picker", picker && picker.zStarts > 0, JSON.stringify(picker));
    ok("B3 · …specifically Zylstra, the one that sorts past row 1,000", picker && picker.hasZ, picker && picker.zText);

    // --- and a case actually SAVES against it -------------------------------
    const saveRes = await p2.evaluate(async (zId) => {
      const sel = document.querySelector("#case-client-select");
      sel.value = zId;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { picked: sel.value };
    }, seed.zId);
    eq("B4 · the picker accepts the Z client as the case's client", saveRes.picked, seed.zId);
    await p2.click("#modal-save");
    await wait(p2, 2000);
    const saved = await p2.evaluate(async (zId) => {
      const r = await window.__mockDb.from("cases").select("id,client_id,stage").eq("client_id", zId);
      return { rows: (r.data || []).length, stage: (r.data && r.data[0] && r.data[0].stage) || null, modalOpen: !document.querySelector("#modal-backdrop.hidden") };
    }, seed.zId);
    eq("B4 · the case SAVED against that client — the thing production could not do at all", saved.rows, 1);
    ok("B4 · …and it landed at a real stage", !!saved.stage, JSON.stringify(saved));
    await p2.evaluate(() => { if (window.closeModal) window.closeModal(); });
    await wait(p2, 400);

    // --- the Clients page counts the whole book -----------------------------
    await goto(p2, "clients", 800);
    await waitStable(p2, "#client-list");
    const clientsPage = await p2.evaluate(() => {
      const note = document.querySelector("#client-list .client-list-cap-note");
      return {
        note: note ? note.textContent.trim() : null,
        capNoticeHidden: (document.querySelector("#clients-cap-notice") || {}).classList
          ? document.querySelector("#clients-cap-notice").classList.contains("hidden") : null,
      };
    });
    const m = /Showing 100 of ([\d,]+)/.exec(clientsPage.note || "");
    ok("B5 · the Clients page shows its 'Showing 100 of N' render-cap note", !!m, clientsPage.note);
    eq("B5 · …and N is the WHOLE book, not the first 1,000", m ? Number(m[1].replace(/,/g, "")) : NaN, seed.totalClients);
    ok("B5 · #clients-cap-notice (OWNER_ROW_CAP=20,000) correctly stays hidden — a different, honest cap",
      clientsPage.capNoticeHidden === true, clientsPage.capNoticeHidden);

    // --- Data health counts every row ---------------------------------------
    await goto(p2, "data", 1500);
    await waitStable(p2, "#data-content", { timeout: 40000 });
    const dh = await p2.evaluate(() => {
      const tile = document.querySelector("#dh-tile-both .num");
      return {
        both: tile ? Number((tile.textContent || "").trim()) : NaN,
        capNoticeHidden: document.querySelector("#data-cap-notice")
          ? document.querySelector("#data-cap-notice").classList.contains("hidden") : null,
        rendered: (document.querySelector("#data-content") || {}).innerHTML ? document.querySelector("#data-content").innerHTML.length : 0,
      };
    });
    ok("B6 · Data health rendered at this scale", dh.rendered > 0, dh.rendered);
    eq("B6 · its 'Missing email & phone' tile counts EVERY row (1,200), not the first 1,000", dh.both, seed.missingBoth);
    ok("B6 · …and that ground truth is itself past the ceiling, so the check is not vacuous", seed.missingBoth > 1000, seed.missingBoth);
    ok("B6 · #data-cap-notice stays hidden — 1,251 is nowhere near OWNER_ROW_CAP", dh.capNoticeHidden === true, dh.capNoticeHidden);

    // --- Reports' cap notice stays quiet ------------------------------------
    await goto(p2, "reports", 2000);
    await waitStable(p2, "#page-reports", { timeout: 40000 });
    const rep = await p2.evaluate(() => {
      const el = document.querySelector("#report-cap-notice");
      return { hidden: el ? el.classList.contains("hidden") : null, text: el ? el.textContent.trim() : null };
    });
    ok("B7 · the Reports cap notice does NOT fire — it never did at 1,000, which is exactly how the truncation stayed invisible",
      rep.hidden === true, JSON.stringify(rep));

    console.log("\n— D(b) · console, page two");
    ok("D2 · no console errors across §B", noNewErr(p2, errBeforeB), JSON.stringify(p2.__err));
    eq("D2 · no new window.__errorLog entries across §B", await errLogLen(p2), logBeforeB);
    await p2.close();
  } catch (e) {
    failures.push("THREW: " + (e && e.stack || e));
    console.log("  ✗ THREW: " + (e && e.message || e));
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r69_hf1: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
