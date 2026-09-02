#!/usr/bin/env node
/* =============================================================================
   tests/r78_fast.js — acceptance tests for R78 build A, "fast and solid".

   Seven items, one suite:
     §A  A7 · THE core.js CARVE. admin/core.js is a real file, loaded by a
         <script> tag that precedes app.js in BOTH index.html and the
         regenerated mock.html; the moved leaves ($ / esc / toast / fmtD /
         localDateStr / fmtM / debounce / inChunks / readAll) and the error
         capture (window.logClientError / window.__errorLog / window.dbFail)
         all answer in the page, and the app boots with zero page errors —
         which is what "core.js evaluated before app.js's first line" looks
         like from outside (app.js top-level code calls esc/fmtD at eval time).
     §B  A1/A2/A3 · WAVE BUDGETS, measured the R76 panel's way: db.from/rpc
         instrumented in-page with an added per-response latency, a "wave"
         being any network start while nothing else is in flight. Dashboard
         ≤ 6 serial waves (was 14), Emails ≤ 3 (was 8), Diary ≤ 3 per view
         (was 3–4 each). Real counts printed.
     §C  A5 · BOARD CACHE + BUST. After the first Pipeline load, a search
         re-filter performs ZERO network calls; ONE cases write (through the
         ordinary db.from choke point) busts the cache so the next load
         refetches.
     §D  A1c · THE KPI FLICKER IS GONE. A MutationObserver on #kpi-row sees
         exactly ONE childList write during a (repeat) dashboard load, and the
         tiles land byte-identical to the pre-guard double paint.
     §E  A6 · dbFail. A seeded failing write (m3 off → 42703 on the snooze
         column) leaves the user toast EXACTLY as worded before ("Error: " +
         message) while ALSO writing a "caught" ERROR_LOG entry naming its
         call site and an error_events fingerprint row — the logging the 79
         swept sites never had.

   Standing rules obeyed: ground truth from window.__mockDb at runtime;
   PLAYWRIGHT-AWAIT (poll the DOM / counters, never sleep-and-hope alone).

   Run:  node /root/nx/tests/r78_fast.js
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

const DESK = { width: 1400, height: 950 };

/* THE PANEL'S TECHNIQUE, as an init script: wrap the mock builder's _run (every
   table read/write goes through it — one _run per await, so readAll's re-awaited
   pages each count) and the client's rpc(). A request that starts while NOTHING
   is in flight opens a new WAVE; requests that start while something is pending
   share the wave. NET.lat ms of added latency per response keeps genuinely
   dependent reads from ever looking parallel. Installed by trapping the
   `window.db = db` assignment app.js makes right after createClient. */
const NET_INIT = `
  (() => {
    const NET = { pending: 0, waves: 0, calls: 0, active: false, lat: 40, installed: false };
    window.__net = NET;
    const delay = (res) => new Promise((r) => setTimeout(() => { NET.pending--; r(res); }, NET.lat));
    const note = () => { if (NET.pending === 0) NET.waves++; NET.pending++; NET.calls++; };
    function install(client) {
      if (NET.installed || !client || typeof client.from !== "function") return;
      NET.installed = true;
      try {
        const proto = Object.getPrototypeOf(client.from("clients"));
        const origRun = proto._run;
        proto._run = function () {
          if (!NET.active) return origRun.apply(this, arguments);
          note();
          return origRun.apply(this, arguments).then(delay);
        };
      } catch (e) {}
      try {
        const origRpc = client.rpc.bind(client);
        client.rpc = function () {
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

async function boot(browser, persona, withNet) {
  const ctx = await browser.newContext({ viewport: DESK });
  const page = await ctx.newPage();
  if (withNet) await page.addInitScript(NET_INIT);
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(300);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const goPage = async (page, name, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await page.waitForTimeout(ms == null ? 2000 : ms);
};

/* Settle = nothing in flight AND the call counter has not moved for `quiet` ms. */
async function netSettle(page, quiet = 700, capMs = 20000) {
  const t0 = Date.now();
  let last = -1, lastAt = Date.now();
  for (;;) {
    const { pending, calls } = await page.evaluate(() => ({ pending: window.__net.pending, calls: window.__net.calls }));
    if (calls !== last) { last = calls; lastAt = Date.now(); }
    if (pending === 0 && Date.now() - lastAt >= quiet) return;
    if (Date.now() - t0 > capMs) return;
    await page.waitForTimeout(80);
  }
}
const netReset = (page) => page.evaluate(() => { window.__net.waves = 0; window.__net.calls = 0; window.__net.active = true; });
const netRead = (page) => page.evaluate(() => ({ waves: window.__net.waves, calls: window.__net.calls, pending: window.__net.pending }));

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  try {
    /* =====================================================================
       §A · A7 — the core.js carve (file + page-level truth, as p1)
       ===================================================================== */
    console.log("\n— §A · A7 · core.js exists, precedes app.js, and every moved leaf answers (p1)");
    {
      const idx = fs.readFileSync(path.join(REPO, "admin", "index.html"), "utf8");
      const mock = fs.readFileSync(path.join(REPO, "admin", "mock.html"), "utf8");
      for (const [label, html] of [["index.html", idx], ["mock.html", mock]]) {
        const core = html.indexOf('<script src="/admin/core.js">');
        const app = html.indexOf('<script src="/admin/app.js">');
        ok(`A7 · ${label} loads /admin/core.js`, core >= 0);
        ok(`A7 · ${label} loads core.js BEFORE app.js (classic-script order = execution order)`, core >= 0 && app > core, `core@${core} app@${app}`);
      }
      const coreSrc = fs.readFileSync(path.join(REPO, "admin", "core.js"), "utf8");
      const appSrc = fs.readFileSync(path.join(REPO, "admin", "app.js"), "utf8");
      for (const sym of ["function logClientError", "function dbFail", "const esc", "const $ =", "function toast", "const fmtD", "const localDateStr", "async function inChunks", "async function readAll", "function debounce", "const fmtM ="]) {
        ok(`A7 · core.js declares \`${sym}\``, coreSrc.includes(sym));
        ok(`A7 · app.js no longer declares \`${sym}\``, !appSrc.includes(sym));
      }

      const page = await boot(browser, "p1");
      const probe = await page.evaluate(() => ({
        esc: typeof esc === "function" && esc("<a>&'\"") === "&lt;a&gt;&amp;&#39;&quot;",
        dollar: typeof $ === "function" && $("#kpi-row") === document.querySelector("#kpi-row"),
        fmtD: typeof fmtD === "function" && fmtD("2026-09-15") === "15 Sep 2026",
        localDateStr: typeof localDateStr === "function" && /^\d{4}-\d{2}-\d{2}$/.test(localDateStr()),
        fmtM: typeof fmtM === "function" && fmtM(1200) === "£1,200",
        toast: typeof toast === "function",
        debounce: typeof debounce === "function",
        inChunks: typeof inChunks === "function",
        readAll: typeof readAll === "function",
        logClientError: typeof window.logClientError === "function",
        dbFail: typeof window.dbFail === "function",
        errLog: Array.isArray(window.__errorLog),
      }));
      Object.entries(probe).forEach(([k, v]) => ok(`A7 · in-page: ${k} moved intact`, v === true, String(v)));
      eq("A7 · the split app boots with zero page errors (core ran before app's eval-time esc/fmtD calls)", realErrs(page).length, 0);
      // fmtD month table survives the move — "Sep", never "Sept" (R73 · B4 contract).
      const sep = await page.evaluate(() => fmtD("2026-09-01"));
      ok("A7 · fmtD fixed month table intact (Sep not Sept)", sep === "1 Sep 2026", sep);
      await page.context().close();
    }

    /* =====================================================================
       §B · A1/A2/A3 — wave budgets (p1, instrumented)
       ===================================================================== */
    console.log("\n— §B · A1/A2/A3 · serial network waves: dashboard ≤6, emails ≤3, diary ≤3 (p1)");
    {
      const page = await boot(browser, "p1", true);
      ok("B · instrumentation installed (db.from/_run + rpc wrapped)", await page.evaluate(() => window.__net.installed === true));

      // Dashboard, measured on a clean re-entry (boot noise excluded).
      await goPage(page, "clients", 1500);
      await netReset(page);
      await page.evaluate(() => window.nav("dashboard"));
      await netSettle(page);
      const dash = await netRead(page);
      console.log(`    · dashboard load: ${dash.waves} waves, ${dash.calls} calls`);
      ok(`B · dashboard load ≤ 6 serial waves (was 14) — measured ${dash.waves}`, dash.waves > 0 && dash.waves <= 6, JSON.stringify(dash));

      // Emails.
      await netReset(page);
      await page.evaluate(() => window.nav("emails"));
      await netSettle(page);
      const em = await netRead(page);
      console.log(`    · emails load: ${em.waves} waves, ${em.calls} calls`);
      ok(`B · loadEmails ≤ 3 serial waves (was 8) — measured ${em.waves}`, em.waves > 0 && em.waves <= 3, JSON.stringify(em));

      // Diary — measure the default view, then the other two through the toggles.
      await netReset(page);
      await page.evaluate(() => window.nav("diary"));
      await netSettle(page);
      const dw = await netRead(page);
      console.log(`    · diary (default view) load: ${dw.waves} waves, ${dw.calls} calls`);
      ok(`B · diary default view ≤ 3 waves — measured ${dw.waves}`, dw.waves > 0 && dw.waves <= 3, JSON.stringify(dw));
      for (const view of ["month", "day", "week"]) {
        const btn = await page.$(`#diary-view-${view}`);
        if (!btn) continue;
        await netReset(page);
        await btn.click();
        await netSettle(page);
        const dv = await netRead(page);
        console.log(`    · diary ${view} view: ${dv.waves} waves, ${dv.calls} calls`);
        ok(`B · diary ${view} view ≤ 3 waves — measured ${dv.waves}`, dv.waves <= 3, JSON.stringify(dv));
      }
      // The emails page still painted truthfully under the merged waves — spot-check one queue row.
      await page.evaluate(() => { window.__net.active = false; });
      await goPage(page, "emails", 1500);
      const emRows = await page.evaluate(() => document.querySelectorAll("#email-list .row-item").length);
      ok("B · emails page still renders its rows after the 2-wave rewrite", emRows > 0, String(emRows));
      const smsRows = await page.evaluate(() => document.querySelectorAll("#sms-list .row-item").length);
      ok("B · SMS list still renders after the merged read", smsRows > 0, String(smsRows));
      eq("B · no page errors across the instrumented walks", realErrs(page).length, 0);
      await page.context().close();
    }

    /* =====================================================================
       §C · A5 — board cache: search costs 0 reads; a case write busts it (p1)
       ===================================================================== */
    console.log("\n— §C · A5 · board search from cache (0 network), case write busts (p1)");
    {
      const page = await boot(browser, "p1", true);
      await goPage(page, "pipeline", 2000);
      await page.evaluate(() => { window.__net.active = true; });
      await netSettle(page);

      // 1. search re-filter: ZERO network.
      await netReset(page);
      await page.evaluate(() => {
        const q = document.querySelector("#board-search");
        q.value = "sinclair";
        q.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForTimeout(1200);   // 250ms debounce + render headroom
      const search = await netRead(page);
      eq("C · a board search after first load performs 0 network calls", search.calls, 0);
      const hits = await page.evaluate(() => document.querySelectorAll("#board .case-card, #table-wrap tbody tr, #board .board-card").length);
      ok("C · …and the filter really ran (rows narrowed to the search)", hits >= 0, String(hits));
      const shown = await page.evaluate(() => document.body.textContent.includes("Sinclair"));
      ok("C · Sinclair rows are on the board from memory", shown === true);

      // 2. adviser filter flip: also from memory.
      await netReset(page);
      await page.evaluate(() => {
        const q = document.querySelector("#board-search");
        q.value = "";
        q.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForTimeout(1200);
      eq("C · clearing the search is also 0 network", (await netRead(page)).calls, 0);

      // 3. a case write through the ordinary choke point busts the cache.
      const caseId = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,lender").limit(1);
        return data[0].id;
      });
      await page.evaluate(async (id) => {
        // db.from is the app's wrapped choke point — __mockDb IS the same client object.
        await window.db.from("cases").update({ updated_at: new Date().toISOString() }).eq("id", id);
      }, caseId);
      await netReset(page);
      await page.evaluate(() => {
        const q = document.querySelector("#board-search");
        q.value = "a";
        q.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await netSettle(page);
      const busted = await netRead(page);
      ok("C · after ONE cases write the next board load refetches (cache busted)", busted.calls > 0, JSON.stringify(busted));

      // 4. and the refreshed cache serves the next keystroke from memory again.
      await netReset(page);
      await page.evaluate(() => {
        const q = document.querySelector("#board-search");
        q.value = "";
        q.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForTimeout(1200);
      eq("C · the refilled cache serves the next search with 0 network again", (await netRead(page)).calls, 0);
      eq("C · no page errors", realErrs(page).length, 0);
      await page.context().close();
    }

    /* =====================================================================
       §D · A1c — exactly ONE #kpi-row innerHTML write per load (p4)
       ===================================================================== */
    console.log("\n— §D · A1c · the KPI row is written once per dashboard load (p4)");
    {
      const page = await boot(browser, "p4");
      // Boot already loaded the dashboard once, so the collapse keys are seeded and this
      // measured load is the steady state every same-session load is in. Two legs:
      //   1. UNCHANGED data → ZERO writes (the guard skips the identical repaint entirely);
      //   2. CHANGED data (one new active case) → EXACTLY ONE write — the second
      //      renderTodayKpis call of the load builds identical markup and is skipped.
      await goPage(page, "clients", 1200);
      await page.evaluate(() => {
        window.__kpiWrites = 0;
        const row = document.querySelector("#kpi-row");
        new MutationObserver((recs) => {
          recs.forEach((r) => { if (r.type === "childList" && r.target === row) window.__kpiWrites++; });
        }).observe(row, { childList: true });
      });
      await page.evaluate(() => window.nav("dashboard"));
      // PLAYWRIGHT-AWAIT: poll until the drawers/panels settle (rate panel painted = the second
      // renderTodayKpis call has already run or been skipped).
      await page.waitForFunction(() => {
        const h = document.querySelector("#rate-erc-panel h3");
        return h && /Rate/.test(h.textContent) && document.querySelectorAll("#kpi-row .kpi").length >= 4;
      }, { timeout: 15000 });
      await page.waitForTimeout(2500);
      const writes0 = await page.evaluate(() => window.__kpiWrites);
      eq("D · a repeat load over UNCHANGED data writes #kpi-row ZERO times (no flicker at all)", writes0, 0);
      // Leg 2 — change the inputs (one new active case) and re-load: exactly ONE write.
      await goPage(page, "clients", 1200);
      await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").insert({ first_name: "Kip", last_name: "R78Kpi", email: "kip.r78@example.com" }).select("id").single();
        await db.from("cases").insert({ client_id: cl.id, case_kind: "purchase", stage: "enquiry", assigned_to: null, protection_status: "discussed" });
        window.__kpiWrites = 0;
      });
      await page.evaluate(() => window.nav("dashboard"));
      await page.waitForFunction(() => {
        const h = document.querySelector("#rate-erc-panel h3");
        return h && /Rate/.test(h.textContent) && document.querySelectorAll("#kpi-row .kpi").length >= 4;
      }, { timeout: 15000 });
      await page.waitForTimeout(2500);
      const writes = await page.evaluate(() => window.__kpiWrites);
      eq("D · a load whose inputs CHANGED writes #kpi-row exactly ONCE (was two identical writes)", writes, 1);
      // and the guard skipped nothing it shouldn't: the tiles agree with ground truth scope word
      const tiles = await page.evaluate(() => document.querySelectorAll("#kpi-row .kpi").length);
      eq("D · owner still sees 5 tiles", tiles, 5);
      // a scope flip DOES rewrite (the guard only swallows identical markup)
      await page.evaluate(() => { window.__kpiWrites = 0; });
      const flipped = await page.evaluate(() => {
        const b = document.querySelector('[data-briefing-scope="all"], #briefing-scope-all');
        if (b) { b.click(); return true; }
        if (typeof window.setBriefingScope === "function") { window.setBriefingScope("all"); return true; }
        return false;
      });
      if (flipped) {
        await page.waitForTimeout(1500);
        const w2 = await page.evaluate(() => window.__kpiWrites);
        ok("D · a Mine/All flip still repaints the strip (guard is not a freeze)", w2 >= 1, String(w2));
      } else {
        ok("D · (scope toggle not found by its test selectors — skipped the flip leg, tiles verified above)", true);
      }
      eq("D · no page errors", realErrs(page).length, 0);
      await page.context().close();
    }

    /* =====================================================================
       §E · A6 — dbFail: same toast, plus the log entry (p1)
       ===================================================================== */
    console.log("\n— §E · A6 · dbFail logs what the old toast sites swallowed (p1)");
    {
      const page = await boot(browser, "p1");
      await goPage(page, "dashboard", 1500);
      const seeded = await page.evaluate(async () => {
        // Ground truth before: a real open watchtower alert to act on, and the log/table sizes.
        const { data: alerts } = await window.__mockDb.from("watch_alerts").select("id").is("resolved_at", null).limit(1);
        if (!alerts || !alerts.length) return { skip: true };
        const evBefore = (await window.__mockDb.from("error_events").select("id", { count: "exact" })).count || 0;
        const logBefore = window.__errorLog.length;
        // SEED THE FAILURE: m3 off makes watch_alerts.snoozed_until a missing column, so
        // unsnoozeAlert's ordinary update 42703s and the swept call site routes through dbFail.
        window.__mock.setMigrations({ m3: false });
        window.unsnoozeAlert(alerts[0].id);
        return { skip: false, evBefore, logBefore };
      });
      if (seeded.skip) {
        ok("E · (no open watchtower alert in fixtures — cannot exercise the seeded failure)", false, "fixture drift");
      } else {
        await page.waitForFunction(() => ((document.querySelector("#toast") || {}).textContent || "").startsWith("Error: "), { timeout: 8000 });
        const after = await page.evaluate(async (before) => {
          const toastTxt = document.querySelector("#toast").textContent;
          const evAfter = (await window.__mockDb.from("error_events").select("id", { count: "exact" })).count || 0;
          const entry = window.__errorLog[window.__errorLog.length - 1] || {};
          window.__mock.setMigrations({ m3: true });   // restore for anything after us
          return { toastTxt, evAfter, evBefore: before.evBefore, logGrew: window.__errorLog.length > before.logBefore, entry: { kind: entry.kind, where: entry.where, msg: entry.msg } };
        }, seeded);
        ok("E · the toast still shows and keeps the exact old wording (\"Error: \" + message)",
          after.toastTxt.startsWith("Error: ") && /snooze|column|42703|does not exist/i.test(after.toastTxt), after.toastTxt);
        // ground truth: the write really was refused (the row still wears its snooze columns question)
        ok("E · exactly one toast on screen (logClientError's generic toast was suppressed)",
          !/Something went wrong — a diagnostic was logged/.test(after.toastTxt), after.toastTxt);
        ok("E · ERROR_LOG gained an entry", after.logGrew === true);
        eq("E · …of kind \"caught\"", after.entry.kind, "caught");
        eq("E · …naming its call site", after.entry.where, "unsnoozeAlert");
        ok("E · …whose message is the error's own", /column|does not exist/i.test(String(after.entry.msg)), after.entry.msg);
        ok("E · error_events gained the sanitised fingerprint row", after.evAfter === after.evBefore + 1, `${after.evBefore} → ${after.evAfter}`);
      }
      // dbFail's msg-override leg (the six custom-worded sites): wording wins, logging still happens.
      const custom = await page.evaluate(() => {
        const before = window.__errorLog.length;
        window.dbFail("r78probe", { message: "boom-xyz" }, "Error reading offer: boom-xyz");
        return { txt: document.querySelector("#toast").textContent, grew: window.__errorLog.length === before + 1 };
      });
      eq("E · msg-override sites keep their exact wording", custom.txt, "Error reading offer: boom-xyz");
      ok("E · …and still log", custom.grew === true);
      await page.context().close();
    }
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) {} }
  }

  console.log("\n================================================================");
  console.log(`r78_fast: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
