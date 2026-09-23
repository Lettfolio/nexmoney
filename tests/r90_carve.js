/* ==========================================================================
   R90 · F — CARVE #3: admin/diary.js, admin/import.js, admin/vault.js (tests/r90_carve.js)

   §A — the files: each exists, parses, carries its own tag stamp; index.html AND mock.html load
        core → reports-money → diary → import → vault → app in that exact order; the seven tag
        literals are equal; no top-level declaration is duplicated across the six scripts; every
        moved declaration lives in its new file and NOT in app.js.
   §B — served = repo: md5 over HTTP == md5 on disk for all six JS files (the r81 §A idiom);
        `node build.js --hash` prints seven admin hashes, the three new files included.
   §C — in-page, p1/p2/p4: seven in-page tags equal, the handshake says "match"; each moved
        function answers `typeof === "function"` in the shared global scope; the Diary (week/day/
        month), Vault and (admin/owner) Operations › Import pages boot and paint with 0 errors.
   §D — the one load-order accommodation (R90 · F, the R81 · A1 recipe): the #import-file and
        #rev-file change bindings (run at DOMContentLoaded because app.js CREATES those inputs)
        still fire — a chosen file fills the box and the status line.
   §E — cold deep links (#diary, #vault, #operations/import) land and paint with 0 errors: the
        microtask argument for keeping app.js LAST holds with three more files ahead of it.

   Run:  node tests/r90_carve.js   (REPO/PORT patched per-sandbox like the rest of the battery)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
const rd = (f) => fs.readFileSync(path.join(REPO, "admin", f), "utf8");

const DESK = { width: 1440, height: 900 };
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));

async function boot(browser, persona, hash) {
  const ctx = await browser.newContext({ viewport: DESK, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(`${BASE}?as=${persona}${hash || ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.nav === "function" && document.querySelector("#app-view") && !document.querySelector("#app-view").classList.contains("hidden"), null, { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { try { if (window.tourEnd) window.tourEnd(false); } catch (e) { /* not open */ } });
  await page.waitForTimeout(300);
  return page;
}
const goPage = async (page, name, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await page.waitForTimeout(ms == null ? 1800 : ms);
};

/* What moved where — the names each file must declare (and app.js must not). */
const MOVED = {
  "diary.js": ["APPT_OUTCOMES", "APPT_OUTCOME_LABEL", "isApptOutcome", "apptOutcomeChipHtml", "apptWhenLabel", "writeApptOutcome",
    "diaryMonth", "adviserColor", "apptClientLine", "diaryViewMode", "diaryStaffVal", "loadDiaryForMode", "initDiaryViewFromPrefs",
    "setDiaryViewMode", "refreshDiaryView", "mondayOf"],
  "import.js": ["importRows", "impSyncAnalyseBtn", "runImport", "impAttachProperties", "REV_FIELDS", "revSyncReadBtn", "renderRevLastSync", "revReset"],
  "vault.js": ["VAULT_CATS", "loadVault", "renderVault", "openVaultEditor", "deleteVaultEntry"],
};
const FNS = ["isApptOutcome", "apptOutcomeChipHtml", "apptWhenLabel", "writeApptOutcome", "adviserColor", "apptClientLine",
  "loadDiaryForMode", "setDiaryViewMode", "refreshDiaryView", "initDiaryViewFromPrefs", "mondayOf",
  "impSyncAnalyseBtn", "runImport", "revSyncReadBtn", "renderRevLastSync", "revReset",
  "loadVault", "renderVault", "openVaultEditor", "deleteVaultEntry"];
const WIN_FNS = ["openAppt", "openApptFromCase", "diaryMoveAppt", "impParsePaste", "nexCopy", "clearVaultSearch", "quickApptOutcome"];

/* Top-level declared names of a classic script, by the column-0 convention every file in admin/ keeps. */
function topDecls(src) {
  const out = [];
  const re = /^(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm;
  let m;
  while ((m = re.exec(src))) out.push(m[1] || m[2]);
  return out;
}
const declares = (src, name) => new RegExp(`^(?:async\\s+)?(?:function\\*?\\s+|const\\s+|let\\s+|var\\s+|class\\s+)${name.replace(/\$/g, "\\$")}\\b`, "m").test(src);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* =====================================================================
       §A — files, order, tags, declarations
       ===================================================================== */
    console.log("\n— §A · the six-script split: files, order, seven tags, no duplicate declarations");
    {
      const SIX = ["core.js", "reports-money.js", "diary.js", "import.js", "vault.js", "app.js"];
      const srcs = Object.fromEntries(SIX.map((f) => [f, rd(f)]));
      for (const f of ["diary.js", "import.js", "vault.js"]) {
        let parsed = true, err = "";
        try { new vm.Script(srcs[f], { filename: f }); } catch (e) { parsed = false; err = String(e); }
        ok(`A1 · admin/${f} exists and parses as a classic script`, parsed, err);
        ok(`A1 · ${f}'s head banner names the order and the definition-time rule`,
          /SCRIPT ORDER: core\.js → reports-money\.js → diary\.js → import\.js → vault\.js →\s+app\.js/.test(srcs[f]) && /DEFINITION-TIME RULE/.test(srcs[f]));
      }
      const idx = rd("index.html"), mock = rd("mock.html");
      for (const [label, html] of [["index.html", idx], ["mock.html", mock]]) {
        const at = SIX.map((f) => html.indexOf(`<script src="/admin/${f}">`));
        ok(`A2 · ${label} loads core → reports-money → diary → import → vault → app, in that order`,
          at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1])), JSON.stringify(at));
      }
      const tagRe = { "index.html": /window\.NX_BUILD_TAG\s*=\s*"([^"]+)"/, "core.js": /window\.__nxTag_core\s*=\s*"([^"]+)"/,
        "reports-money.js": /window\.__nxTag_reportsmoney\s*=\s*"([^"]+)"/, "diary.js": /window\.__nxTag_diary\s*=\s*"([^"]+)"/,
        "import.js": /window\.__nxTag_import\s*=\s*"([^"]+)"/, "vault.js": /window\.__nxTag_vault\s*=\s*"([^"]+)"/, "app.js": /window\.__nxTag_app\s*=\s*"([^"]+)"/ };
      const tags = Object.fromEntries(Object.entries(tagRe).map(([f, re]) => { const m = (f === "index.html" ? idx : srcs[f]).match(re); return [f, m ? m[1] : null]; }));
      const tv = Object.values(tags);
      ok(`A3 · the seven tag literals are equal (${tv[0]})`, tv.length === 7 && tv.every((t) => t && t === tv[0]), JSON.stringify(tags));
      ok("A3 · app.js's boot compare names all seven tags", /const vals = \[window\.NX_BUILD_TAG, window\.__nxTag_core, window\.__nxTag_reportsmoney, window\.__nxTag_diary, window\.__nxTag_import, window\.__nxTag_vault, window\.__nxTag_app\]/.test(srcs["app.js"]));
      // A duplicate top-level const/let across classic scripts is a SyntaxError that kills the later one.
      const seen = {}, dups = [];
      for (const f of SIX) for (const n of topDecls(srcs[f])) { if (seen[n] && seen[n] !== f) dups.push(`${n} (${seen[n]} & ${f})`); seen[n] = seen[n] || f; }
      eq("A4 · no top-level name is declared in two of the six scripts", dups, []);
      for (const [f, names] of Object.entries(MOVED)) {
        const inNew = names.filter((n) => !declares(srcs[f], n));
        const inApp = names.filter((n) => declares(srcs["app.js"], n));
        eq(`A5 · ${f} declares its moved names (${names.length})`, inNew, []);
        eq(`A5 · app.js no longer declares any of ${f}'s names`, inApp, []);
      }
      ok("A6 · app.js keeps the shared drop zone + its four eval-time mounts (Money's zones use it)",
        declares(srcs["app.js"], "mountDropZone") && (srcs["app.js"].match(/^mountDropZone\(/gm) || []).length === 4);
      ok("A6 · import.js's two drop-zone bindings are the tagged DOMContentLoaded accommodation",
        (srcs["import.js"].match(/R90 · F — LOAD-ORDER ACCOMMODATION/g) || []).length === 2
        && /document\.addEventListener\("DOMContentLoaded", wireImportFileInput\)/.test(srcs["import.js"])
        && /document\.addEventListener\("DOMContentLoaded", wireRevFileInput\)/.test(srcs["import.js"]));
      ok("A7 · build.js FILES map lists the three new files", ["diary.js", "import.js", "vault.js"].every((f) => fs.readFileSync(path.join(REPO, "build.js"), "utf8").includes(`"admin/${f}": "js"`)));
    }

    /* =====================================================================
       §B — served bytes == repo; build --hash prints seven admin files
       ===================================================================== */
    console.log("\n— §B · served = repo (md5), build --hash covers seven admin files");
    {
      for (const f of ["core.js", "reports-money.js", "diary.js", "import.js", "vault.js", "app.js"]) {
        const disk = md5(fs.readFileSync(path.join(REPO, "admin", f)));
        const got = await fetchBytes(`/admin/${f}`);
        ok(`B1 · served /admin/${f} is byte-identical to the repo copy (md5 ${disk.slice(0, 8)}…)`, got.status === 200 && md5(got.body) === disk, `status ${got.status}`);
      }
      let out = "";
      try { out = execFileSync("node", ["build.js", "--hash"], { cwd: REPO, encoding: "utf8" }); } catch (e) { out = String(e); }
      const admin = out.split("\n").filter((l) => /^[0-9a-f]{64}\s+admin\//.test(l)).map((l) => l.trim().split(/\s+/)[1]);
      eq("B2 · build.js --hash prints the seven admin files", admin, ["admin/core.js", "admin/reports-money.js", "admin/diary.js", "admin/import.js", "admin/vault.js", "admin/app.js", "admin/admin.css"]);
    }

    /* =====================================================================
       §C — in-page, per persona
       ===================================================================== */
    for (const persona of ["p1", "p2", "p4"]) {
      console.log(`\n— §C · ${persona}: tags, moved globals, Diary / Vault / Import boot clean`);
      const page = await boot(browser, persona);
      const g = await page.evaluate(({ FNS, WIN_FNS }) => ({
        tags: [window.NX_BUILD_TAG, window.__nxTag_core, window.__nxTag_reportsmoney, window.__nxTag_diary, window.__nxTag_import, window.__nxTag_vault, window.__nxTag_app],
        verdict: window.__nxCheckBuildTags(),
        // eslint-disable-next-line no-eval
        fns: FNS.filter((n) => { try { return (0, eval)(`typeof ${n}`) !== "function"; } catch (e) { return true; } }),
        win: WIN_FNS.filter((n) => typeof window[n] !== "function"),
        label: typeof APPT_OUTCOME_LABEL === "object" && APPT_OUTCOME_LABEL.no_show === "No-show",
        month: diaryMonth instanceof Date,
        chip: apptOutcomeChipHtml("attended").includes("appt-outcome-attended"),
      }), { FNS, WIN_FNS });
      ok(`C1 · ${persona}: seven in-page tags equal, compare says match`, g.tags.every((t) => t != null && t === g.tags[0]) && g.verdict === "match", JSON.stringify(g));
      eq(`C2 · ${persona}: every moved top-level function answers typeof === "function"`, g.fns, []);
      eq(`C2 · ${persona}: every moved window.* verb is a function`, g.win, []);
      ok(`C3 · ${persona}: the outcome vocabulary and diaryMonth are live in the shared scope`, g.label && g.month && g.chip, JSON.stringify(g));
      for (const mode of ["week", "day", "month"]) {
        await goPage(page, "diary", 1500);
        await page.evaluate((m) => setDiaryViewMode(m), mode);
        await page.waitForTimeout(1500);
        const d = await page.evaluate((m) => {
          const vis = (s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0; };
          return { shown: !document.querySelector("#page-diary").classList.contains("hidden"), mode: diaryViewMode, view: vis(m === "month" ? "#diary-grid" : m === "week" ? "#diary-week-view" : "#diary-day-view") };
        }, mode);
        ok(`C4 · ${persona}: Diary ${mode} view paints (diary.js)`, d.shown && d.mode === mode && d.view, JSON.stringify(d));
      }
      await goPage(page, "vault", 2000);
      const v = await page.evaluate(() => ({ shown: !document.querySelector("#page-vault").classList.contains("hidden"), list: (document.querySelector("#vault-list") || {}).innerHTML || "" }));
      ok(`C5 · ${persona}: Vault paints its list (vault.js)`, v.shown && v.list.length > 20, `${v.shown} ${v.list.length}`);
      const admin = await page.evaluate(() => isAdminOrOwner());   // the persona's role, read at runtime
      if (admin) {
        await goPage(page, "operations/import", 2200);
        const im = await page.evaluate(() => ({ tab: (pageTabActive || {}).operations, last: ((document.querySelector("#rev-lastsync") || {}).textContent || "").trim(), shown: !document.querySelector("#page-import").classList.contains("hidden") }));
        ok(`C6 · ${persona}: Operations › Import paints renderRevLastSync's line (import.js)`, im.shown && im.tab === "import" && im.last.length > 10, JSON.stringify(im));
      } else {
        await goPage(page, "operations/import", 1500);
        const cur = await page.evaluate(() => currentPage);
        eq(`C6 · ${persona} (adviser): Operations › Import still bounces to Today (the gate is app.js's, unchanged)`, cur, "dashboard");
      }
      eq(`C7 · ${persona}: zero page errors across the three carved pages`, realErrs(page), []);
      await page.context().close();
    }

    /* =====================================================================
       §D — the DOMContentLoaded bindings on the two drop-zone inputs
       ===================================================================== */
    console.log("\n— §D · #import-file / #rev-file change bindings (bound at DCL) still fire");
    {
      const page = await boot(browser, "p4");
      await goPage(page, "operations/import", 2000);
      await page.setInputFiles("#import-file", { name: "r90-import.csv", mimeType: "text/csv", buffer: Buffer.from("first_name,last_name\nR90,Carve\n") });
      await page.waitForTimeout(800);
      const a = await page.evaluate(() => ({ text: $("#import-text").value, status: $("#import-status").textContent, btn: $("#analyse-btn").disabled }));
      ok("D1 · a file chosen on #import-file fills #import-text (import.js's handler ran)", a.text.includes("R90,Carve"), JSON.stringify(a));
      ok("D1 · …and the status line names it, and ✨ Analyse enables", /Loaded r90-import\.csv/.test(a.status) && a.btn === false, JSON.stringify(a));
      await page.setInputFiles("#rev-file", { name: "r90-rev.csv", mimeType: "text/csv", buffer: Buffer.from("Client ID,Forename\n1,R90\n") });
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => ({ text: $("#rev-text").value, status: $("#rev-status").textContent }));
      ok("D2 · a file chosen on #rev-file fills #rev-text and names it (Revolution handler ran)", r.text.includes("Client ID") && /Loaded r90-rev\.csv/.test(r.status), JSON.stringify(r));
      const readout = await page.evaluate(() => { const z = document.querySelector("#import-file"); const w = z && z.closest(".drop-zone, .dz, [class*='drop']"); return w ? w.textContent : ""; });
      ok("D3 · the drop zone's own readout listener (bound first, by app.js) still reports the file", /r90-import\.csv/.test(readout), readout.slice(0, 120));
      eq("D4 · zero page errors", realErrs(page), []);
      await page.context().close();
    }

    /* =====================================================================
       §E — cold deep links into the carved pages
       ===================================================================== */
    console.log("\n— §E · cold deep links (#diary, #vault, #operations/import) land clean");
    for (const [hash, sel] of [["#diary", "#page-diary"], ["#vault", "#page-vault"], ["#operations/import", "#page-import"]]) {
      const page = await boot(browser, "p4", hash);
      await page.waitForTimeout(800);
      const s = await page.evaluate((q) => ({ shown: !document.querySelector(q).classList.contains("hidden"), page: currentPage }), sel);
      ok(`E1 · cold ${hash} shows ${sel}`, s.shown, JSON.stringify(s));
      eq(`E1 · cold ${hash}: zero page errors`, realErrs(page), []);
      await page.context().close();
    }
  } catch (e) {
    failures.push("CRASH " + (e && e.stack || e));
    console.log("CRASH", e);
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (_) { /* gone */ }
  }
  console.log("\n================================================================");
  console.log(`r90_carve: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
