/* ============================================================================
   R81 · "Platform #2" — agent A battery (tests/r81_platform.js)

   §A — Carve #2 (A1): admin/reports-money.js exists, index.html AND mock.html
        load core.js → reports-money.js → app.js in that exact order, the
        SERVED bytes of all three JS files are md5-identical to the files on
        disk (the harness serves what the repo holds — no stale copy), and one
        function per moved family still answers on its own page: loadReports
        (#report-mine / #report-month-panel), loadMoneyPage (#money-banked),
        renderApptOutcomes (#report-outcomes-headline), the forecast line
        (#report-forecast-buckets), the mix panel (#report-mix).
   §B — A2: the Money page loads in ≤ 2 serial network waves (r78_fast's
        instrumentation, verbatim), and still paints its owner panels.
   §C — A3: the NX_BUILD_TAG handshake. All four tags equal on a clean load
        (in-page AND in the four source files — the merge-time partial-bump
        catch); a forced mismatch shows the non-dismissable strip and reloads
        exactly ONCE (observed via the __nxTagReload sandbox seam); a second
        mismatch with the guard set leaves the strip up, says hard-refresh,
        and does NOT loop; a match clears strip + guard.
   §D — A4: three converted dbFail sites (one in the moved file): the EXACT
        old wording still toasts AND window.__errorLog gains a "caught" entry.

   Run:  node tests/r81_platform.js   (spawns its own static server if 8099
   is free; REPO/PORT patched per-sandbox exactly like the rest of the battery)
   ========================================================================== */

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const crypto = require("crypto");
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

function fetchBytes(urlPath) {
  return new Promise((res, rej) => {
    http.get(`http://localhost:${PORT}${urlPath}`, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => res({ status: r.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", rej);
  });
}
const md5 = (buf) => crypto.createHash("md5").update(buf).digest("hex");

const DESK = { width: 1400, height: 950 };

/* r78_fast's wave instrumentation, verbatim: wrap the mock builder's _run and the client's
   rpc(); a request that starts while NOTHING is in flight opens a new WAVE; 40ms of added
   latency per response keeps genuinely dependent reads from ever looking parallel. */
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
       §A · A1 — carve #2: files, order, served bytes, moved families answer
       ===================================================================== */
    console.log("\n— §A · A1 · three-file split: order, served md5s, one function per moved family");
    {
      const idx = fs.readFileSync(path.join(REPO, "admin", "index.html"), "utf8");
      const mock = fs.readFileSync(path.join(REPO, "admin", "mock.html"), "utf8");
      for (const [label, html] of [["index.html", idx], ["mock.html", mock]]) {
        const core = html.indexOf('<script src="/admin/core.js">');
        const rm = html.indexOf('<script src="/admin/reports-money.js">');
        const app = html.indexOf('<script src="/admin/app.js">');
        ok(`A1 · ${label} loads /admin/reports-money.js`, rm >= 0);
        ok(`A1 · ${label} order is core.js → reports-money.js → app.js (proven in the file's own comment)`,
          core >= 0 && rm > core && app > rm, `core@${core} rm@${rm} app@${app}`);
      }
      // The served set is the repo's set — md5 over HTTP vs md5 on disk, all three files.
      for (const f of ["core.js", "reports-money.js", "app.js"]) {
        const disk = md5(fs.readFileSync(path.join(REPO, "admin", f)));
        const got = await fetchBytes(`/admin/${f}`);
        ok(`A1 · served /admin/${f} is byte-identical to the repo copy (md5 ${disk.slice(0, 8)}…)`,
          got.status === 200 && md5(got.body) === disk, `status ${got.status} md5 ${md5(got.body).slice(0, 8)}`);
      }
      const appSrc = fs.readFileSync(path.join(REPO, "admin", "app.js"), "utf8");
      const rmSrc = fs.readFileSync(path.join(REPO, "admin", "reports-money.js"), "utf8");
      for (const sym of ["async function loadReports", "async function loadMoneyPage", "async function renderApptOutcomes", "function renderForecastBuckets", "function renderBusinessMix", "function renderPipelineMI", "async function renderReconPanel"]) {
        ok(`A1 · reports-money.js declares \`${sym}\``, rmSrc.includes(sym));
        ok(`A1 · app.js no longer declares \`${sym}\``, !appSrc.includes(sym));
      }

      // One function per moved family, exercised via its page as the Owner (p4 sees everything).
      const page = await boot(browser, "p4");
      await goPage(page, "reports", 3500);
      const rep = await page.evaluate(() => ({
        mine: (document.querySelector("#report-mine") || {}).innerHTML || "",
        month: (document.querySelector("#report-month-panel") || {}).innerHTML || "",
        outcomes: (document.querySelector("#report-outcomes-headline") || {}).innerHTML || "",
        forecast: (document.querySelector("#report-forecast-buckets") || {}).innerHTML || "",
        mix: (document.querySelector("#report-mix") || {}).innerHTML || "",
      }));
      ok("A1 · loadReports ran (monthly business panel rendered)", rep.month.length > 50, String(rep.month.length));
      ok("A1 · renderApptOutcomes rendered its headline (R77 · B1 contract)", rep.outcomes.length > 20, String(rep.outcomes.length));
      ok("A1 · renderForecastBuckets rendered the forecast buckets", rep.forecast.length > 20, String(rep.forecast.length));
      ok("A1 · renderBusinessMix rendered the mix panel (R77 · A4 contract)", rep.mix.length > 20, String(rep.mix.length));
      await goPage(page, "money", 3500);
      const mon = await page.evaluate(() => ({
        banked: (document.querySelector("#money-banked") || {}).innerHTML || "",
        owed: (document.querySelector("#money-owed") || {}).innerHTML || "",
        advisers: (document.querySelector("#money-advisers") || {}).innerHTML || "",
        recon: (document.querySelector("#recon-statements") || {}).innerHTML || "",
      }));
      ok("A1 · loadMoneyPage rendered the banked KPI strip", mon.banked.includes("kpi-headline"), mon.banked.slice(0, 80));
      ok("A1 · loadMoneyPage rendered money-owed", mon.owed.length > 20, String(mon.owed.length));
      ok("A1 · loadMoneyPage rendered the per-adviser strip", mon.advisers.length > 20, String(mon.advisers.length));
      ok("A1 · renderReconPanel painted the statements list (empty-state or rows)", mon.recon.length > 20, String(mon.recon.length));
      eq("A1 · the three-file app runs the Reports + Money pages with zero page errors", realErrs(page).length, 0);
      await page.context().close();
    }

    /* =====================================================================
       §B · A2 — Money page ≤ 2 serial waves (p4, instrumented)
       ===================================================================== */
    console.log("\n— §B · A2 · Money page ≤ 2 serial network waves (was 6) (p4)");
    {
      const page = await boot(browser, "p4", true);
      ok("B · instrumentation installed", await page.evaluate(() => window.__net.installed === true));
      await goPage(page, "clients", 1500);   // measure a clean re-entry, boot noise excluded
      await netReset(page);
      await page.evaluate(() => window.nav("money"));
      await netSettle(page);
      const mw = await netRead(page);
      console.log(`    · money load: ${mw.waves} waves, ${mw.calls} calls`);
      ok(`B · Money page ≤ 2 serial waves (was 6) — measured ${mw.waves}`, mw.waves > 0 && mw.waves <= 2, JSON.stringify(mw));
      // …and it still painted truthfully under the merged waves.
      const painted = await page.evaluate(() => ({
        banked: ((document.querySelector("#money-banked") || {}).innerHTML || "").includes("kpi-headline"),
        movement: ((document.querySelector("#money-movement") || {}).innerHTML || "").length > 20,
        cold: ((document.querySelector("#money-cold") || {}).innerHTML || "").length > 5,
      }));
      Object.entries(painted).forEach(([k, v]) => ok(`B · money panel painted after the 2-wave rewrite: ${k}`, v === true, String(v)));
      // The seq-guard exists and moves (the R78 idiom, applied by A2).
      const seqMoves = await page.evaluate(async () => {
        const a = moneyLoadSeq;
        const p = loadMoneyPage();
        const b = moneyLoadSeq;
        await p;
        return b === a + 1;
      });
      ok("B · moneyLoadSeq increments per load (stale loads return silently)", seqMoves === true);
      eq("B · zero page errors", realErrs(page).length, 0);
      await page.context().close();
    }

    /* =====================================================================
       §C · A3 — the NX_BUILD_TAG handshake
       ===================================================================== */
    console.log("\n— §C · A3 · build-tag handshake: equal on clean load; mismatch = strip + ONE reload; no loop");
    {
      // Merge-time catch: the four tag literals in the four SOURCE files are equal.
      const files = {
        "index.html": /window\.NX_BUILD_TAG\s*=\s*"([^"]+)"/,
        "core.js": /window\.__nxTag_core\s*=\s*"([^"]+)"/,
        "reports-money.js": /window\.__nxTag_reportsmoney\s*=\s*"([^"]+)"/,
        "app.js": /window\.__nxTag_app\s*=\s*"([^"]+)"/,
      };
      const found = {};
      for (const [f, re] of Object.entries(files)) {
        const m = fs.readFileSync(path.join(REPO, "admin", f), "utf8").match(re);
        found[f] = m ? m[1] : "(MISSING)";
      }
      const tagVals = Object.values(found);
      ok(`C · all four source files carry the SAME tag literal (${tagVals[0]}) — a partial bump fails here at merge time`,
        tagVals.every((v) => v !== "(MISSING)" && v === tagVals[0]), JSON.stringify(found));

      const page = await boot(browser, "p1");
      const clean = await page.evaluate(() => ({
        tags: [window.NX_BUILD_TAG, window.__nxTag_core, window.__nxTag_reportsmoney, window.__nxTag_app],
        verdict: window.__nxCheckBuildTags(),
        strip: !!document.getElementById("nx-tag-strip"),
        guard: (() => { try { return sessionStorage.getItem("nx_tag_reloaded"); } catch (_) { return "n/a"; } })(),
      }));
      ok("C · clean load: all four in-page tags equal and non-null", clean.tags.every((t) => t != null && t === clean.tags[0]), JSON.stringify(clean.tags));
      eq("C · clean load: compare says match", clean.verdict, "match");
      ok("C · clean load: no strip, no reload guard", !clean.strip && !clean.guard, JSON.stringify(clean));

      // Forced mismatch, first sighting: strip + ONE reload (via the sandbox seam), guard set.
      const first = await page.evaluate(() => {
        window.__reloads = 0;
        window.__nxTagReload = () => { window.__reloads++; };   // sandbox seam — observe, don't navigate
        window.__nxTag_app = "r00-stale";
        const verdict = window.__nxCheckBuildTags();
        const strip = document.getElementById("nx-tag-strip");
        return {
          verdict,
          stripText: strip ? strip.textContent : "(none)",
          reloads: window.__reloads,
          guard: (() => { try { return sessionStorage.getItem("nx_tag_reloaded"); } catch (_) { return "n/a"; } })(),
        };
      });
      eq("C · mismatch (first): compare says reloading", first.verdict, "reloading");
      eq("C · mismatch (first): the strip says exactly what is happening", first.stripText, "A new version of this app has part-loaded — reloading…");
      eq("C · mismatch (first): reload fired exactly ONCE", first.reloads, 1);
      eq("C · mismatch (first): the once-only guard is set", first.guard, "1");

      // Still mismatched with the guard set: strip stays, wording escalates, NO second reload.
      const second = await page.evaluate(() => {
        const verdict = window.__nxCheckBuildTags();
        const strip = document.getElementById("nx-tag-strip");
        return { verdict, stripText: strip ? strip.textContent : "(none)", reloads: window.__reloads };
      });
      eq("C · mismatch (guard set): compare says stuck — no loop", second.verdict, "stuck");
      ok("C · mismatch (guard set): strip stays up and names the hard refresh",
        second.stripText.includes("still mismatched") && second.stripText.includes("hard refresh (Ctrl+F5)"), second.stripText);
      eq("C · mismatch (guard set): NO further reload", second.reloads, 1);

      // Tags agree again (the reload landed the matching set): strip comes down, guard clears.
      const healed = await page.evaluate(() => {
        window.__nxTag_app = window.NX_BUILD_TAG;
        const verdict = window.__nxCheckBuildTags();
        return {
          verdict,
          strip: !!document.getElementById("nx-tag-strip"),
          guard: (() => { try { return sessionStorage.getItem("nx_tag_reloaded"); } catch (_) { return "n/a"; } })(),
        };
      });
      eq("C · healed: compare says match", healed.verdict, "match");
      ok("C · healed: strip removed and guard cleared (the NEXT deploy may reload once again)", !healed.strip && !healed.guard, JSON.stringify(healed));
      await page.context().close();
    }

    /* =====================================================================
       §D · A4 — three converted dbFail sites: exact wording + a log entry
       ===================================================================== */
    console.log("\n— §D · A4 · converted sites toast the OLD words and log (2 in app.js, 1 in reports-money.js)");
    {
      const page = await boot(browser, "p1");
      /* Force the db error at the table the site writes/reads, through the SAME db.from door the
         app uses, then put the door back. Each leg uses a DISTINCT forced message — dbFail's log
         de-dupes a repeated message inside 5s, and these three assertions each demand their own
         new entry. */

      // D1 · reopenTask (app.js) — case_tasks update refused.
      const d1 = await page.evaluate(async () => {
        const before = window.__errorLog.length;
        const orig = window.db.from.bind(window.db);
        window.db.from = (t) => {
          const b = orig(t);
          if (t === "case_tasks") {
            const fail = Promise.resolve({ data: null, error: { message: "forced-r81-d1" } });
            const failer = { eq: () => failer, in: () => failer, single: () => fail, select: () => failer, order: () => failer, then: fail.then.bind(fail) };
            ["update", "insert", "delete"].forEach((m) => { b[m] = () => failer; });
          }
          return b;
        };
        try { await window.reopenTask("00000000-0000-0000-0000-000000000000"); } finally { window.db.from = orig; }
        const last = window.__errorLog[window.__errorLog.length - 1] || {};
        return { txt: document.querySelector("#toast").textContent, grew: window.__errorLog.length === before + 1, kind: last.kind, where: last.where, msg: last.msg };
      });
      eq("D1 · reopenTask toasts the EXACT old wording", d1.txt, "Couldn't reopen that task — forced-r81-d1");
      ok("D1 · …and ERROR_LOG gained ONE caught entry (where=reopenTask)", d1.grew && d1.kind === "caught" && d1.where === "reopenTask" && d1.msg === "forced-r81-d1", JSON.stringify(d1));

      // D2 · refSetStatus (app.js) — referrals update refused.
      const d2 = await page.evaluate(async () => {
        const before = window.__errorLog.length;
        const orig = window.db.from.bind(window.db);
        window.db.from = (t) => {
          const b = orig(t);
          if (t === "referrals") {
            const fail = Promise.resolve({ data: null, error: { message: "forced-r81-d2" } });
            const failer = { eq: () => failer, in: () => failer, single: () => fail, select: () => failer, order: () => failer, then: fail.then.bind(fail) };
            ["update", "insert", "delete"].forEach((m) => { b[m] = () => failer; });
          }
          return b;
        };
        try { await window.refSetStatus("x", "y", "completed"); } finally { window.db.from = orig; }
        const last = window.__errorLog[window.__errorLog.length - 1] || {};
        return { txt: document.querySelector("#toast").textContent, grew: window.__errorLog.length === before + 1, kind: last.kind, where: last.where };
      });
      eq("D2 · refSetStatus toasts the EXACT old wording", d2.txt, "Couldn't update the referral: forced-r81-d2");
      ok("D2 · …and ERROR_LOG gained ONE caught entry (where=refSetStatus)", d2.grew && d2.kind === "caught" && d2.where === "refSetStatus", JSON.stringify(d2));

      // D3 · advPromoCallTask (reports-money.js — a MOVED site) — cases read refused.
      const d3 = await page.evaluate(async () => {
        const before = window.__errorLog.length;
        const orig = window.db.from.bind(window.db);
        window.db.from = (t) => {
          const b = orig(t);
          if (t === "cases") {
            const fail = Promise.resolve({ data: null, error: { message: "forced-r81-d3" } });
            const failer = { eq: () => failer, in: () => failer, single: () => fail, select: () => failer, order: () => failer, then: fail.then.bind(fail) };
            ["select"].forEach((m) => { b[m] = () => failer; });
          }
          return b;
        };
        try { await window.advPromoCallTask("00000000-0000-0000-0000-000000000000"); } finally { window.db.from = orig; }
        const last = window.__errorLog[window.__errorLog.length - 1] || {};
        return { txt: document.querySelector("#toast").textContent, grew: window.__errorLog.length === before + 1, kind: last.kind, where: last.where };
      });
      eq("D3 · advPromoCallTask (moved file) toasts the EXACT old wording", d3.txt, "Couldn't open that case — forced-r81-d3");
      ok("D3 · …and ERROR_LOG gained ONE caught entry (where=advPromoCallTask)", d3.grew && d3.kind === "caught" && d3.where === "advPromoCallTask", JSON.stringify(d3));

      eq("D · zero page errors while forcing failures", realErrs(page).length, 0);
      await page.context().close();
    }
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) {} }
  }

  console.log("\n================================================================");
  console.log(`r81_platform: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
