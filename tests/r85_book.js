#!/usr/bin/env node
/* =============================================================================
   tests/r85_book.js — acceptance tests for R85 build A, "One book" (the session
   data layer for `cases` + `clients`, the write choke point that keeps it fresh,
   and get_dashboard_counts()).

   Contract under test: /root/nx/R85-DESIGN.md (bookLoad / bustBookCache /
   bookCases / bookClients / bookPeek / sortRows, BOOK_CASE_COLS,
   BOOK_CLIENT_COLS, BOOK_STALE_MS) — implemented in admin/app.js beside
   boardCache, hooks in admin/reports-money.js's __isMock block.

     §A  ONE BOOK. Today → Pipeline → Retention → Reports → Data health →
         Clients: the `cases` table is walked whole EXACTLY ONCE for the tour
         (a "walk page" = a cases _run with no filter, not head, not single,
         not a 1-row probe); `clients` likewise. Real counts printed.
         NOTE (R85 · A): until the consumer agents land their conversions
         (readDashboardCases, loadReports, loadDataHealth, loadClientData…)
         this section is EXPECTED RED — the assertions state the final
         contract on purpose. Everything from §B on is green against build A.
     §B  BUST → INCREMENTAL. A cases update through db.from marks the book
         dirty; the next Pipeline load performs exactly ONE cases request,
         carrying an `updated_at gte` filter, and the changed row is what
         renders. A delete forces a FULL walk.
     §C  A COLLEAGUE'S WRITE (seeded straight into __mock.db, past the choke
         point) shows on the next nav once the snapshot is older than
         BOOK_STALE_MS (__setBookStaleMs(0)) — one incremental request.
     §D  CAP. __setOwnerRowCap(50) → capHit, the board's cap notice shows, and
         every later bust is a FULL reload (a capped snapshot cannot merge).
     §E  get_dashboard_counts. The ops strip's chips equal the fixture counts
         with ONE rpc and ZERO head:true probes / profiles / settings reads;
         the first-run tour still fires for Luke; the what's-new band still
         shows; with the function switched off (m13) the OLD reads answer and
         the chips still equal the fixture; a non-staff caller gets 42501.
     §F  FAILURE HONESTY. A failing incremental sync (__mock.failNextSelect)
         serves the OLD snapshot, stays dirty, logs to __errorLog and
         error_events, and the page still renders; the next sync heals. A
         42703 naming a column on a FULL load is retried once without it.
     §G  NO CONSOLE ERRORS / __errorLog empty on every page, plus the choke
         point's RPC door and reloadPipelineFresh busting the book.

   Standing rules obeyed: ground truth from window.__mockDb / __mock.db at
   runtime; PLAYWRIGHT-AWAIT (poll, never sleep-and-hope alone).

   Run:  node /root/nx/tests/r85_book.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — HARNESS.md.)
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

const DESK = { width: 1400, height: 950 };

/* r78_fast's in-page instrumentation, extended: every mock _run is LOGGED with the builder's
   table / op / filter count / head / single / limit / range, plus which `gte` columns it
   carries (the builder's gte is wrapped to note them), and every rpc with its name. */
const NET_INIT = `
  (() => {
    const NET = { pending: 0, waves: 0, calls: 0, active: false, lat: 40, installed: false, log: [] };
    window.__net = NET;
    const delay = (res) => new Promise((r) => setTimeout(() => { NET.pending--; r(res); }, NET.lat));
    const note = () => { if (NET.pending === 0) NET.waves++; NET.pending++; NET.calls++; };
    function install(client) {
      if (NET.installed || !client || typeof client.from !== "function") return;
      NET.installed = true;
      try {
        const proto = Object.getPrototypeOf(client.from("clients"));
        const origGte = proto.gte;
        proto.gte = function (col, val) { (this._r85gte = this._r85gte || []).push([col, val]); return origGte.apply(this, arguments); };
        const origRun = proto._run;
        proto._run = function () {
          NET.log.push({ kind: "from", table: this._table, op: this._op || "select", preds: (this._preds || []).length,
            head: !!this._head, single: !!this._single, limit: this._limit, range: this._range ? this._range.slice() : null,
            gte: (this._r85gte || []).map((g) => g[0]), cols: this._columns });
          if (!NET.active) return origRun.apply(this, arguments);
          note();
          return origRun.apply(this, arguments).then(delay);
        };
      } catch (e) {}
      try {
        const origRpc = client.rpc.bind(client);
        client.rpc = function (name) {
          NET.log.push({ kind: "rpc", name });
          if (!NET.active) return origRpc.apply(null, arguments);
          note();
          return origRpc.apply(null, arguments).then(delay);
        };
      } catch (e) {}
    }
    Object.defineProperty(window, "db", {
      configurable: true,
      get() { return this.__dbReal; },
      set(v) { this.__dbReal = v; install(v); },
    });
  })();
`;

async function boot(browser, persona, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({ viewport: DESK });
  const page = await ctx.newPage();
  await page.addInitScript(NET_INIT);
  if (o.init) await page.addInitScript(o.init);
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  if (!o.keepTour) {
    await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
    await page.waitForTimeout(300);
  }
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
/* R85 · B contract change — the NEUTRAL HOP between a write and the observed nav. Build A used the
   diary, whose only cases read was loadPropContext's fresh `.in("id")`; R85 · B6 serves
   loadPropContext from the book, so a diary hop would itself perform the sync (or consume the armed
   failNextSelect) and the Pipeline nav under test would see nothing. The vault reads vault_entries
   only — the one page that never touches cases or clients. §G's page list still walks the diary. */
const HOP = "vault";
const goPage = async (page, name, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await page.waitForTimeout(ms == null ? 1500 : ms);
};
/* Settle = nothing in flight AND the call counter has not moved for `quiet` ms. */
async function netSettle(page, quiet = 700, capMs = 20000) {
  const t0 = Date.now();
  let last = -1, lastAt = Date.now();
  for (;;) {
    const { pending, calls } = await page.evaluate(() => ({ pending: window.__net.pending, calls: window.__net.log.length }));
    if (calls !== last) { last = calls; lastAt = Date.now(); }
    if (pending === 0 && Date.now() - lastAt >= quiet) return;
    if (Date.now() - t0 > capMs) return;
    await page.waitForTimeout(80);
  }
}
const netReset = (page) => page.evaluate(() => { window.__net.waves = 0; window.__net.calls = 0; window.__net.log = []; window.__net.active = true; });
const netLog = (page) => page.evaluate(() => window.__net.log.slice());
/* A whole-table WALK page on `table`: a select with no filter, not a count probe, not a
   single-row read, not a 1-row feature probe. readAll's pages each count (one _run per page). */
const isWalk = (t) => (e) => e.kind === "from" && e.table === t && e.op === "select" && e.preds === 0 && !e.head && !e.single && !(e.limit != null && e.limit <= 1 && !e.range);
const casesReads = (log) => log.filter((e) => e.kind === "from" && e.table === "cases" && e.op === "select" && !e.head);
const stats = (page) => page.evaluate(() => window.__bookStats());

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  try {
    /* =====================================================================
       §A · ONE BOOK — the whole tour walks `cases` once and `clients` once (p4)
       ===================================================================== */
    console.log("\n— §A · ONE BOOK · Today → Pipeline → Retention → Reports → Data health → Clients walks each table ONCE (p4)");
    console.log("    (EXPECTED RED on build A alone — green once the consumer agents' conversions land)");
    {
      const page = await boot(browser, "p4");
      ok("A0 · instrumentation installed (mock _run + rpc wrapped)", await page.evaluate(() => window.__net.installed === true));
      ok("A0 · the Book API is present (bookLoad/bustBookCache/bookCases/bookClients/bookPeek/sortRows)", await page.evaluate(() =>
        [bookLoad, bustBookCache, bookCases, bookClients, bookPeek, sortRows].every((f) => typeof f === "function")));
      ok("A0 · BOOK_CASE_COLS / BOOK_CLIENT_COLS / BOOK_STALE_MS declared", await page.evaluate(() =>
        typeof BOOK_CASE_COLS === "string" && BOOK_CASE_COLS.split(",").length >= 60 && typeof BOOK_CLIENT_COLS === "string" && BOOK_STALE_MS === 60000));
      // Fresh session: bust as a delete so the tour starts from a cold book and counts its ONE walk.
      await goPage(page, HOP, 1200);
      /* R85 · B contract change — boot lands on Today, which now loads the book (readDashboardCases
         is a book consumer), so the tour's ONE full load is asserted as a DELTA over the count at
         the bust, not as an absolute 1. */
      const fullBeforeTour = (await stats(page)).fullLoads;
      await page.evaluate(() => window.__bustBookCache("delete"));
      /* R85 · C contract change — boot lands on Today, and Today is book-backed now (loadProtection,
         loadBriefing, loadWatchtower, loadUnactioned — and B's readDashboardCases), so the book has
         ALREADY had one full load before the bust above. A3 counts the TOUR's full loads: the delta
         from here, not the session's cumulative total. */
      const fullLoadsBefore = (await stats(page)).fullLoads;
      await netReset(page);
      for (const p of ["dashboard", "pipeline", "retention", "reports", "data", "clients"]) {
        await page.evaluate((x) => window.nav(x), p);
        await netSettle(page);
      }
      const log = await netLog(page);
      const cw = log.filter(isWalk("cases")).length, kw = log.filter(isWalk("clients")).length;
      const cr = casesReads(log).length;
      console.log(`    · cases walk pages: ${cw} · clients walk pages: ${kw} · all cases selects: ${cr} · total calls: ${log.length}`);
      const walkers = log.filter(isWalk("cases")).map((e) => String(e.cols).slice(0, 60));
      console.log(`    · cases walkers: ${JSON.stringify(walkers)}`);
      eq("A1 · the whole tour walks `cases` EXACTLY once (one full-book page; fixture < 1,000 rows)", cw, 1);
      eq("A2 · …and `clients` EXACTLY once", kw, 1);
      const st = await stats(page);
      eq("A3 · the book reports one full load for the tour", st.fullLoads - fullLoadsBefore, 1);   // R85 · C contract change — delta (see above)
      ok("A4 · the book holds every fixture case and client", await page.evaluate(() => {
        const b = window.__bookPeek(); const c = window.__mock.counts();
        return b && b.cases.length === c.cases && b.clients.length === c.clients;
      }));
      ok("A5 · rows carry the synthesised embeds (case.clients superset shape; client.cases reverse embed, created_at desc)", await page.evaluate(() => {
        const b = window.__bookPeek();
        const c = b.cases.find((x) => x.client_id);
        const keys = ["id", "first_name", "last_name", "email", "phone", "sms_opt_out", "comms_optout", "is_vulnerable", "suppress_automation"];
        const embedOk = c && c.clients && keys.every((k) => Object.prototype.hasOwnProperty.call(c.clients, k)) && c.clients.id === c.client_id;
        const cl = b.clients.find((x) => x.cases && x.cases.length >= 2);
        const revOk = cl && cl.cases.every((x) => x.client_id === cl.id) && cl.cases.every((x, i, a) => i === 0 || a[i - 1].created_at >= x.created_at)
          && cl.cases.every((x) => b.caseById.get(x.id) === x);
        return !!(embedOk && revOk);
      }));
      ok("A6 · arrays in the stable order (cases by id asc, clients by last_name,id) and shared with the maps", await page.evaluate(() => {
        const b = window.__bookPeek();
        const idsOk = b.cases.every((x, i, a) => i === 0 || a[i - 1].id <= x.id);
        const clOk = b.clients.every((x, i, a) => i === 0 || (a[i - 1].last_name || "") < (x.last_name || "") || ((a[i - 1].last_name || "") === (x.last_name || "") && a[i - 1].id <= x.id));
        const shared = b.cases.every((x) => b.caseById.get(x.id) === x) && b.clients.every((x) => b.clientById.get(x.id) === x);
        return idsOk && clOk && shared;
      }));
      ok("A7 · sortRows returns a COPY in server order (desc ⇒ nulls first, asc ⇒ nulls last, stable ties)", await page.evaluate(() => {
        const rows = [{ id: "b", v: 2 }, { id: "a", v: null }, { id: "c", v: 1 }, { id: "d", v: 2 }];
        const d = sortRows(rows, "v", "desc"), a = sortRows(rows, "v", "asc"), m = sortRows(rows, [["v", "desc"], "id"]);
        return rows[0].id === "b" && d.map((r) => r.id).join("") === "abdc" && a.map((r) => r.id).join("") === "cbda" && m.map((r) => r.id).join("") === "abdc";
      }));
      eq("A · no page errors on the tour", realErrs(page).length, 0);
      await page.context().close();
    }

    /* =====================================================================
       §B · BUST → INCREMENTAL SYNC; DELETE → FULL (p4, Pipeline)
       ===================================================================== */
    console.log("\n— §B · a cases write busts → ONE `updated_at gte` request; a delete → a full walk (p4)");
    {
      const page = await boot(browser, "p4");
      await goPage(page, "pipeline", 1500);
      await netSettle(page);
      const before = await stats(page);
      ok("B0 · the board loaded from the book (loaded, not dirty)", before.loaded && !before.dirty.cases && !before.dirty.clients, JSON.stringify(before));
      const caseId = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,stage").eq("stage", "application").limit(1);
        return data[0].id;
      });
      // The write goes through the app's own db.from (the choke point): __mockDb IS window.db.
      await page.evaluate(async (id) => { await window.db.from("cases").update({ lender: "R85 Bank" }).eq("id", id); }, caseId);
      const dirty = await stats(page);
      ok("B1 · the update marked the book dirty for cases (and only cases)", dirty.dirty.cases === true && dirty.dirty.clients === false && dirty.dirty.full === false, JSON.stringify(dirty.dirty));
      await goPage(page, HOP, 800);
      await netReset(page);
      await page.evaluate(() => window.nav("pipeline"));
      await netSettle(page);
      const log = await netLog(page);
      const cases = casesReads(log);
      eq("B2 · the next Pipeline load performs EXACTLY ONE cases request", cases.length, 1);
      ok("B3 · …carrying an `updated_at` gte filter (incremental, not a refetch)", cases[0] && cases[0].gte.includes("updated_at") && cases[0].preds === 1, JSON.stringify(cases[0]));
      eq("B4 · …and no clients request at all (clients were not dirty)", log.filter((e) => e.kind === "from" && e.table === "clients").length, 0);
      const after = await stats(page);
      ok("B5 · bookStats: one sync, ≥1 row merged, clean again, same full-load count", after.syncs === before.syncs + 1 && after.lastSyncRows >= 1 && !after.dirty.cases && after.fullLoads === before.fullLoads, JSON.stringify(after));
      ok("B6 · the changed row is what the book holds…", await page.evaluate((id) => window.__bookPeek().caseById.get(id).lender === "R85 Bank", caseId));
      ok("B7 · …and what the board renders", await page.evaluate(() => document.body.textContent.includes("R85 Bank")));
      ok("B8 · a repeat load with nothing dirty performs ZERO cases requests", await (async () => {
        await goPage(page, HOP, 600); await netReset(page); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
        return casesReads(await netLog(page)).length === 0;
      })());
      // A delete → FULL walk.
      const scratch = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").insert({ first_name: "Del", last_name: "R85Scratch", email: "del.r85@example.com" }).select("id").single();
        const { data: cs } = await db.from("cases").insert({ client_id: cl.id, case_kind: "purchase", stage: "enquiry", lender: "Scratch Bank" }).select("id").single();
        return { clientId: cl.id, caseId: cs.id };
      });
      await goPage(page, HOP, 600); await netReset(page); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      const insLog = await netLog(page);
      ok("B9 · …cases + clients each ONE gte request after the inserts", casesReads(insLog).length === 1 && casesReads(insLog)[0].gte.includes("updated_at")
        && insLog.filter((e) => e.kind === "from" && e.table === "clients" && e.op === "select").length === 1, JSON.stringify(insLog.filter((e) => e.kind === "from" && (e.table === "cases" || e.table === "clients"))));
      ok("B10 · the inserted case is in the book with its embed synthesised", await page.evaluate((s) => { const c = window.__bookPeek().caseById.get(s.caseId); return !!(c && c.clients && c.clients.last_name === "R85Scratch"); }, scratch));
      const fullBefore = (await stats(page)).fullLoads;
      await page.evaluate(async (s) => { await window.db.from("cases").delete().eq("id", s.caseId); }, scratch);
      ok("B11 · a delete marks the book for a FULL reload", (await stats(page)).dirty.full === true);
      await goPage(page, HOP, 600); await netReset(page); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      const delLog = await netLog(page);
      ok("B12 · the next load is a full walk (no gte; one page each of cases and clients)", delLog.filter(isWalk("cases")).length === 1 && delLog.filter(isWalk("clients")).length === 1 && casesReads(delLog).every((e) => !e.gte.length), JSON.stringify(delLog.filter((e) => e.table === "cases")));
      const st2 = await stats(page);
      ok("B13 · fullLoads +1, the deleted row is gone from the book", st2.fullLoads === fullBefore + 1 && await page.evaluate((s) => !window.__bookPeek().caseById.has(s.caseId), scratch), JSON.stringify(st2));
      eq("B · no page errors", realErrs(page).length, 0);
      await page.context().close();
    }

    /* =====================================================================
       §C · A COLLEAGUE'S WRITE — bounded staleness (p4)
       ===================================================================== */
    console.log("\n— §C · a colleague's write (seeded past the choke point) renders after BOOK_STALE_MS (p4)");
    {
      const page = await boot(browser, "p4");
      await goPage(page, "pipeline", 1500);
      await netSettle(page);
      const st0 = await stats(page);
      // Straight into the fixture — no db.from, so nothing in this tab busts anything.
      const caseId = await page.evaluate(() => {
        const c = window.__mock.db.cases.find((x) => x.stage === "offer");
        c.lender = "Colleague Bank"; c.updated_at = new Date().toISOString();
        return c.id;
      });
      await goPage(page, HOP, 600); await netReset(page); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      ok("C1 · inside the staleness window the board serves the snapshot (0 cases requests, colleague's change not yet visible)",
        casesReads(await netLog(page)).length === 0 && !(await stats(page)).dirty.cases);
      await page.evaluate(() => window.__setBookStaleMs(0));
      await goPage(page, HOP, 600); await netReset(page); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      const log = await netLog(page);
      ok("C2 · past the window: ONE incremental cases request (gte updated_at)", casesReads(log).length === 1 && casesReads(log)[0].gte.includes("updated_at"), JSON.stringify(casesReads(log)));
      ok("C3 · (a stale sync covers BOTH tables — one clients gte request too)", log.filter((e) => e.kind === "from" && e.table === "clients" && e.op === "select" && e.gte.includes("updated_at")).length === 1);
      ok("C4 · the colleague's change is in the book and on the board", await page.evaluate((id) => window.__bookPeek().caseById.get(id).lender === "Colleague Bank" && document.body.textContent.includes("Colleague Bank"), caseId));
      const st1 = await stats(page);
      ok("C5 · one sync, no full load", st1.syncs === st0.syncs + 1 && st1.fullLoads === st0.fullLoads, JSON.stringify(st1));
      ok("C6 · syncedAt is the max updated_at in the snapshot (server clock), and it moved to the colleague's stamp", await page.evaluate((id) => {
        const b = window.__bookPeek(); const c = b.caseById.get(id);
        const max = b.cases.concat(b.clients).reduce((m, r) => (r.updated_at > m ? r.updated_at : m), "");
        return b.syncedAt === max && c.updated_at === max;
      }, caseId));
      await page.evaluate(() => window.__setBookStaleMs(60000));
      eq("C · no page errors", realErrs(page).length, 0);
      await page.context().close();
    }

    /* =====================================================================
       §D · CAP — capped snapshot ⇒ capHit, notice, full syncs (p4)
       ===================================================================== */
    console.log("\n— §D · __setOwnerRowCap(50): capHit, board notice, every bust is a full reload (p4)");
    {
      const page = await boot(browser, "p4");
      await goPage(page, "pipeline", 1500);
      await netSettle(page);
      await page.evaluate(() => window.__setOwnerRowCap(50));
      ok("D1 · a cap change forces a full reload (dirty.full)", (await stats(page)).dirty.full === true);
      await netReset(page); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      const st = await stats(page);
      ok("D2 · capHit is true and the book holds exactly the cap of cases", st.capHit === true && st.cases === 50, JSON.stringify(st));
      ok("D3 · the board's cap notice shows (R23's ownerCapHit reads the book rows' length)", await page.evaluate(() => { const n = document.querySelector("#board-cap-notice"); return n && !n.classList.contains("hidden") && /first 50/.test(n.textContent); }));
      const full0 = st.fullLoads;
      await page.evaluate(() => window.__bustBookCache("cases"));
      await goPage(page, HOP, 600); await netReset(page); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      const log = await netLog(page);
      ok("D4 · under the cap a plain bust is a FULL reload, never a merge (no gte; fullLoads +1)", casesReads(log).every((e) => !e.gte.length) && log.filter(isWalk("cases")).length === 1 && (await stats(page)).fullLoads === full0 + 1, JSON.stringify(casesReads(log)));
      await page.evaluate(() => window.__setOwnerRowCap(5000));
      await goPage(page, HOP, 600); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      const st2 = await stats(page);
      ok("D5 · cap restored: the whole book is back and capHit is false", st2.capHit === false && st2.cases === (await page.evaluate(() => window.__mock.counts().cases)), JSON.stringify(st2));
      eq("D · no page errors", realErrs(page).length, 0);
      await page.context().close();
    }

    /* =====================================================================
       §E · get_dashboard_counts — one rpc, same chips, tour + what's-new
       ===================================================================== */
    console.log("\n— §E · get_dashboard_counts: ops strip = fixture counts via ONE rpc; tour and what's-new still fire (p1 / p3)");
    {
      const page = await boot(browser, "p1");
      await goPage(page, "clients", 1200);
      await netReset(page);
      await page.evaluate(() => window.nav("dashboard"));
      await netSettle(page);
      await page.waitForFunction(() => document.querySelectorAll("#ops-strip .ops-chip").length >= 6, { timeout: 15000 });
      const log = await netLog(page);
      const rpcs = log.filter((e) => e.kind === "rpc" && e.name === "get_dashboard_counts").length;
      eq("E1 · exactly ONE get_dashboard_counts rpc per dashboard load", rpcs, 1);
      const heads = log.filter((e) => e.kind === "from" && e.head && ["email_queue", "sms_queue", "leads", "case_tasks", "watch_alerts"].includes(e.table));
      eq("E2 · ZERO head:true count probes (the five strip counts + the watchtower total came off the rpc)", heads.length, 0);
      eq("E3 · ZERO profiles reads (tour gate + what's-new band came off the rpc)", log.filter((e) => e.kind === "from" && e.table === "profiles").length, 0);
      eq("E4 · ZERO settings reads (the heartbeat keys came off the rpc)", log.filter((e) => e.kind === "from" && e.table === "settings").length, 0);
      const want = await page.evaluate(() => {
        const D = window.__mock.db;
        const live = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
        return {
          "ops-emails-queued": D.email_queue.filter((e) => e.status === "queued").length,
          "ops-emails-failed": D.email_queue.filter((e) => e.status === "failed").length,
          "ops-sms-queued": D.sms_queue.filter((e) => e.status === "queued").length,
          "ops-leads-new": D.leads.filter((l) => l.status === "new").length,
          "ops-unassigned": D.cases.filter((c) => !c.assigned_to && live.includes(c.stage)).length,
          "ops-docs-overdue": D.case_tasks.filter((t) => t.done_at == null && /^Documents overdue — call /.test(String(t.title || ""))).length,
        };
      });
      const got = await page.evaluate(() => { const o = {}; document.querySelectorAll("#ops-strip .ops-chip").forEach((c) => { o[c.id] = Number(c.dataset.n); }); return o; });
      console.log(`    · chips: ${JSON.stringify(got)}`);
      eq("E5 · every ops chip equals the fixture count computed the old way", got, want);
      ok("E6 · the rpc's own answer matches the fixture (mock parity, field by field)", await page.evaluate(async (w) => {
        const { data, error } = await window.__mockDb.rpc("get_dashboard_counts");
        if (error) return false;
        const D = window.__mock.db;
        const me = D.profiles.find((p) => p.id === window.__mock.persona);
        const hb = {}; D.settings.forEach((s) => { if (["last_cron_run_at", "last_full_export_at"].includes(s.key)) hb[s.key] = s.value; });
        return data.queued_emails === w["ops-emails-queued"] && data.failed_emails === w["ops-emails-failed"] && data.queued_sms === w["ops-sms-queued"]
          && data.new_leads === w["ops-leads-new"] && data.docs_overdue_tasks === w["ops-docs-overdue"]
          && data.open_watch_alerts === D.watch_alerts.filter((a) => a.resolved_at == null).length
          && data.tour_seen_at === (me && me.tour_seen_at != null ? me.tour_seen_at : null)
          && JSON.stringify(data.heartbeat) === JSON.stringify(hb);
      }, want));
      ok("E7 · the heartbeat banner still reads the settings keys (settings.last_cron_run_at populated off the rpc)", await page.evaluate(() => typeof settings.last_cron_run_at !== "undefined"));
      ok("E8 · the watchtower's open total came off the rpc and matches the fixture", await page.evaluate(() => wtLast && wtLast.openTotal === window.__mock.db.watch_alerts.filter((a) => a.resolved_at == null).length));
      ok("E9 · the what's-new band shows for a returning user (p1: tour seen, no marker)", await page.evaluate(() => { const b = document.querySelector("#whatsnew-band"); return b && !b.classList.contains("hidden") && /New since you were last here/.test(b.textContent); }));
      // Fallback: the function switched off (an older database) → the old reads answer, same chips.
      await page.evaluate(() => window.__mock.setMigrations({ m13: false }));
      await goPage(page, "clients", 800);
      await netReset(page);
      await page.evaluate(() => window.nav("dashboard"));
      await netSettle(page);
      await page.waitForFunction(() => document.querySelectorAll("#ops-strip .ops-chip").length >= 6, { timeout: 15000 });
      const flog = await netLog(page);
      ok("E10 · with get_dashboard_counts absent (m13 off) the rpc answers 42883 and the FIVE head:true probes run instead",
        flog.filter((e) => e.kind === "rpc" && e.name === "get_dashboard_counts").length === 1 && flog.filter((e) => e.kind === "from" && e.head && ["email_queue", "sms_queue", "leads", "case_tasks"].includes(e.table)).length === 5);
      ok("E11 · …and the profiles row + settings keys are read the old way", flog.filter((e) => e.kind === "from" && e.table === "profiles").length >= 2 && flog.filter((e) => e.kind === "from" && e.table === "settings").length >= 1);
      const got2 = await page.evaluate(() => { const o = {}; document.querySelectorAll("#ops-strip .ops-chip").forEach((c) => { o[c.id] = Number(c.dataset.n); }); return o; });
      eq("E12 · the chips are byte-identical on the fallback path", got2, want);
      await page.evaluate(() => window.__mock.setMigrations({ m13: true }));
      eq("E · no page errors (p1)", realErrs(page).length, 0);
      await page.context().close();

      // The tour still fires once for Luke (tour_seen_at null) — off the rpc.
      const p3 = await boot(browser, "p3", { keepTour: true });
      await p3.waitForFunction(() => !!document.querySelector("#tour-bubble"), { timeout: 10000 }).catch(() => {});
      ok("E13 · the first-run tour fires for Luke (tour_seen_at null) with the flag read off the rpc", await p3.evaluate(() => !!document.querySelector("#tour-bubble")));
      ok("E14 · …off ONE get_dashboard_counts call during boot (and no profiles read naming tour_seen_at)", await p3.evaluate(() =>
        window.__net.log.filter((e) => e.kind === "rpc" && e.name === "get_dashboard_counts").length === 1
        && window.__net.log.filter((e) => e.kind === "from" && e.table === "profiles" && /tour_seen_at/.test(String(e.cols))).length === 0));
      await p3.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
      await p3.waitForTimeout(400);
      ok("E15 · the r12b contract holds: after Finish/Skip the DB flag alone refuses a re-ask (fresh promise per load, never cached)", await p3.evaluate(async () => {
        tourFired = false; await maybeStartTour(); await new Promise((r) => setTimeout(r, 400)); return !document.querySelector("#tour-bubble");
      }));
      eq("E · no page errors (p3)", realErrs(p3).length, 0);
      await p3.context().close();

      // Non-staff: the introducer persona (p5 fails the staff gate) gets 42501 from the function itself.
      const p5 = await boot(browser, "p5");
      const guard = await p5.evaluate(async () => { const r = await window.__mockDb.rpc("get_dashboard_counts"); return { code: r.error && r.error.code, data: r.data }; });
      eq("E16 · a non-staff caller is refused with 42501 (staff-guarded like get_briefing, but raising)", guard, { code: "42501", data: null });
      await p5.context().close();
    }

    /* =====================================================================
       §F · FAILURE HONESTY — a failing sync serves the old snapshot (p4)
       ===================================================================== */
    console.log("\n— §F · a failing incremental sync keeps the old snapshot, stays dirty, logs; a 42703 on a full load retries without the column (p4)");
    {
      const page = await boot(browser, "p4");
      await goPage(page, "pipeline", 1500);
      await netSettle(page);
      const st0 = await stats(page);
      const errBefore = await page.evaluate(() => window.__errorLog.length);
      const evBefore = await page.evaluate(() => window.__mock.db.error_events.length);
      const caseId = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id").eq("stage", "application").limit(1);
        return data[0].id;
      });
      await page.evaluate(async (id) => { await window.db.from("cases").update({ lender: "Unseen Bank" }).eq("id", id); }, caseId);
      // Arm the failure AFTER leaving for the neutral hop (R85 · B: the vault — the diary's
      // property-context read is now a book read and would itself be the sync); the Pipeline
      // load's first cases read is the sync.
      await goPage(page, HOP, 600);
      await page.evaluate(() => window.__mock.failNextSelect("cases"));
      await netReset(page); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      const st1 = await stats(page);
      ok("F1 · the failed sync is counted, the snapshot is the OLD one (same syncedAt, no full load), and it STAYS dirty", st1.failedSyncs === st0.failedSyncs + 1 && st1.syncedAt === st0.syncedAt && st1.fullLoads === st0.fullLoads && st1.dirty.cases === true, JSON.stringify(st1));
      ok("F2 · the page still renders from the old snapshot (cards on the board, no load-error state)", await page.evaluate(() => document.querySelectorAll("#board .case-card, #board .card").length > 0 && !/statement timeout/.test(document.querySelector("#board").textContent)));
      ok("F3 · the old row is what shows (stale beats blank)", await page.evaluate((id) => window.__bookPeek().caseById.get(id).lender !== "Unseen Bank", caseId));
      ok("F4 · __errorLog gained a 'caught' entry from bookSync…", await page.evaluate((n) => window.__errorLog.length > n && window.__errorLog.some((e) => e.kind === "caught" && e.where === "bookSync" && /timeout/.test(e.msg)), errBefore));
      await page.waitForFunction((n) => window.__mock.db.error_events.length > n, evBefore, { timeout: 5000 }).catch(() => {});
      ok("F5 · …and an error_events row was fingerprinted", await page.evaluate((n) => window.__mock.db.error_events.length > n, evBefore));
      ok("F6 · no user-facing toast for a sync failure (the consumer's own copy stays the one voice)", await page.evaluate(() => !document.body.textContent.includes("Something went wrong — a diagnostic was logged")));
      // The next load heals: the sync runs again (still dirty) and the write lands.
      await goPage(page, HOP, 600); await netReset(page); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      const st2 = await stats(page);
      ok("F7 · the next load retries the sync and the change lands", st2.syncs === st1.syncs + 1 && !st2.dirty.cases && await page.evaluate((id) => window.__bookPeek().caseById.get(id).lender === "Unseen Bank", caseId), JSON.stringify(st2));
      // A 42703 naming a column, on a FULL load: retried once with that column dropped.
      await goPage(page, HOP, 600);
      await page.evaluate(() => { window.__bustBookCache("delete"); window.__mock.failNextSelect("cases", { code: "42703", message: "column cases.nps_score does not exist" }); });
      const errBefore2 = await page.evaluate(() => window.__errorLog.length);
      await netReset(page); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      const st3 = await stats(page);
      ok("F8 · the full load retried ONCE without the named column (two cases walk pages; nps_score dropped from the session select)",
        (await netLog(page)).filter(isWalk("cases")).length === 2 && !st3.caseSelect.split(",").includes("nps_score") && st3.caseSelect.split(",").length === (await page.evaluate(() => BOOK_CASE_COLS.split(",").length)) - 1, JSON.stringify({ sel: st3.caseSelect.slice(0, 80), n: st3.caseSelect.split(",").length }));
      ok("F9 · the book loaded (fullLoads +1, rows present, no error state) and logged the dropped column", st3.fullLoads === st2.fullLoads + 1 && st3.cases > 0 && await page.evaluate((n) => window.__errorLog.length > n && window.__errorLog.some((e) => e.where === "bookLoad" && /nps_score/.test(e.msg)), errBefore2), JSON.stringify(st3));
      ok("F10 · a failed FULL load returns an empty snapshot with error, toasts via dbFail, and leaves the book null for the next caller", await page.evaluate(async () => {
        window.__bustBookCache("delete");
        window.__mock.failNextSelect("clients");
        const before = window.__errorLog.length;
        const snap = await bookLoad();
        const nulled = window.__bookPeek() === null;
        const logged = window.__errorLog.length > before && window.__errorLog.some((e) => e.where === "book");
        const again = await bookLoad();
        return !!(snap.error && snap.cases.length === 0 && nulled && logged && !again.error && again.cases.length > 0);
      }));
      eq("F · no page errors", realErrs(page).length, 0);
      await page.context().close();
    }

    /* =====================================================================
       §G · NO CONSOLE ERRORS, __errorLog empty on every page; the RPC door;
            reloadPipelineFresh busts the book (p4 / p1)
       ===================================================================== */
    console.log("\n— §G · clean console + empty __errorLog on every page; the rpc choke point; reloadPipelineFresh (p4)");
    {
      const page = await boot(browser, "p4");
      for (const p of ["dashboard", "pipeline", "retention", "protection", "reports", "money", "data", "clients", "emails", "diary", "settings"]) {
        await page.evaluate((x) => window.nav(x), p);
        await netSettle(page, 500, 12000);
        eq(`G1 · ${p}: zero page/console errors`, realErrs(page).length, 0);
        eq(`G1 · ${p}: __errorLog empty`, await page.evaluate(() => window.__errorLog.length), 0);
      }
      await goPage(page, "pipeline", 1200);
      await netSettle(page);
      ok("G2 · a READ rpc (has_bank_details) does not bust the book", await page.evaluate(async () => { await window.db.rpc("has_bank_details"); const s = window.__bookStats(); return !s.dirty.cases && !s.dirty.clients; }));
      ok("G3 · a WRITER rpc (queue_comms_extras) busts it through the rpc door", await page.evaluate(async () => { await window.db.rpc("queue_comms_extras"); const s = window.__bookStats(); return s.dirty.cases && s.dirty.clients; }));
      ok("G4 · BOOK_WRITER_RPCS lists the three cases/clients writers", await page.evaluate(() => JSON.stringify(BOOK_WRITER_RPCS.slice().sort()) === JSON.stringify(["queue_automated_emails", "queue_comms_extras", "reassign_holdings"])));
      await goPage(page, HOP, 600); await page.evaluate(() => window.nav("pipeline")); await netSettle(page);
      const syncs0 = (await stats(page)).syncs;
      await netReset(page);
      await page.evaluate(() => reloadPipelineFresh());
      await netSettle(page);
      const rl = await netLog(page);
      ok("G5 · reloadPipelineFresh() busts the BOOK too — the reload performs an incremental cases + clients sync, not a cached repaint", casesReads(rl).length === 1 && casesReads(rl)[0].gte.includes("updated_at") && (await stats(page)).syncs === syncs0 + 1, JSON.stringify(casesReads(rl)));
      ok("G6 · a clients write busts clients only (and the board's embed repaints from the synced client)", await page.evaluate(async () => {
        const c = window.__bookPeek().cases.find((x) => x.client_id && x.stage === "application");
        await window.db.from("clients").update({ last_name: "Bookface" }).eq("id", c.client_id);
        const s = window.__bookStats();
        if (!(s.dirty.clients && !s.dirty.cases)) return false;
        await bookLoad();
        const b = window.__bookPeek();
        return b.caseById.get(c.id).clients.last_name === "Bookface" && b.clientById.get(c.client_id).cases.some((x) => x.id === c.id);
      }));
      ok("G7 · concurrent callers share ONE in-flight load", await page.evaluate(async () => {
        window.__bustBookCache("delete");
        const f0 = window.__bookStats().fullLoads;
        const [a, b, c] = await Promise.all([bookLoad(), bookCases(), bookClients()]);
        return a === window.__bookPeek() && b === a.cases && c === a.clients && window.__bookStats().fullLoads === f0 + 1;
      }));
      eq("G · no page errors", realErrs(page).length, 0);
      await page.context().close();
    }
  } catch (e) {
    failures.push("UNCAUGHT: " + (e && e.stack || e));
    console.log("UNCAUGHT", e);
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (_) {} }
  }

  console.log(`\nR85_BOOK: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  ✗ " + f));
  process.exit(failures.length ? 1 : 0);
})();
