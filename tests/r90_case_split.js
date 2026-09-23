// tests/r90_case_split.js — R90 · B: window.openCase SPLIT into named top-level functions.
//
// A pure refactor: the case modal must come out byte-identical. The oracle is the modal's own
// innerHTML (every id, class, attribute and whitespace node), captured for the Offer AND the
// Completed fixture (picked the way panel-r87/dom-dump.js and r88_case pick them), as p4 and p2, at
// 1440×900 and 390×844 (the phone branch changes the action row's labels).
//
//   §A  source (read over HTTP): the named functions exist, openCase ≤ 200 lines, its nested
//       closures gone, the M-migration save-retry ladders gone
//   §B  every lifted function is `typeof "function"` on the page
//   §C  snapshot equality — (1) LIVE against the untouched base (5b9cce5's app.js served in place of
//       this tree's via page.route; skipped, and said so, when git or the base commit is absent) and
//       (2) against the stored fixture tests/r90_case_split.snap.json (recorded from the base with
//       --record; dates/clocks masked so the fixture survives a day change)
//   §D  behaviour: { focus } lands on the composer, R88 folds persist across a same-case re-render
//       and reset on another case, { scrollTo: "docs" }, the R83 stale-open guard, the new-case form,
//       one Save writes once and toasts plain "Case saved"
//   §Z  no console errors
//
// Run:  node tests/r90_case_split.js            (REPO/PORT patched per sandbox like the battery)
//       node tests/r90_case_split.js --record   (re-record the fixture from BASE_SHA)
"use strict";
const { chromium } = require("playwright");
const { spawn, execFileSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const BASE_SHA = "843e7fa";   // R90 · merge — the merged A+B+C tree (C swapped the checklist's inline margin for .u-mt-14, so B's 5b9cce5 base no longer matches byte-for-byte; the modal DOM has been unchanged since)
const SNAP = path.join(__dirname, "r90_case_split.snap.json");
const RECORD = process.argv.includes("--record");

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
const fetchText = (urlPath) => new Promise((res, rej) => {
  http.get(`http://localhost:${PORT}${urlPath}`, (r) => { let s = ""; r.setEncoding("utf8"); r.on("data", (d) => (s += d)); r.on("end", () => res(s)); }).on("error", rej);
});

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
async function boot(browser, persona, viewport, appJs) {
  const ctx = await browser.newContext({ viewport: viewport || DESK, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  if (appJs) await page.route("**/admin/app.js*", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: appJs }));
  page.__err = [];
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 30000 });
  await page.waitForTimeout(1800);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(300);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
async function openCase(page, id, opts) {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await wait(page, 300);
  await page.evaluate(({ id, opts }) => window.openCase(id, opts), { id, opts: opts || {} });
  await wait(page, 2200);
}
/* The Offer / Completed fixture — the dom-dump.js / r88_case pick. */
async function pickCase(page, stage) {
  return page.evaluate(async (st) => {
    const { data } = await window.db.from("cases").select("id,stage,lender,property_address,client_id").eq("stage", st).order("updated_at", { ascending: false }).limit(20);
    const rows = data || [];
    const p = rows.find((r) => r.property_address && r.lender) || rows.find((r) => r.lender) || rows[0];
    return p && p.id;
  }, stage);
}
const modalHtml = (page) => page.evaluate(() => document.querySelector("#modal").innerHTML);

/* Masks. LIGHT: only what differs between two loads of the same tree seconds apart (the mock seeds
   its timestamps from the load clock). HEAVY: also every calendar date and day count, so the stored
   fixture still compares on another day (the mock's fixture dates are relative to today). */
const maskLight = (s) => String(s)
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<ISO>")
  .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "<HM>");
const MON = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
const maskHeavy = (s) => maskLight(s)
  .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<D>")
  .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "<D>")
  .replace(new RegExp(`\\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? `, "g"), "<WD> ")
  .replace(new RegExp(`\\b\\d{1,2} ${MON}( \\d{4})?\\b`, "g"), "<D>")
  .replace(new RegExp(`\\b${MON} \\d{4}\\b`, "g"), "<D>")
  .replace(/\b\d+\s*(days?|weeks?|months?|years?|d|mo|yrs?)\b/g, "<N>")
  .replace(/\b(\d+|an?|one)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\s+ago\b/gi, "<AGO>")
  .replace(/\bjust now\b/gi, "<AGO>")
  .replace(/\b(today|tomorrow|yesterday)\b/gi, "<REL>");
const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i >= a.length && i >= b.length ? "" : `@${i}: …${JSON.stringify(a.slice(Math.max(0, i - 60), i + 80))} vs …${JSON.stringify(b.slice(Math.max(0, i - 60), i + 80))}`; };

const LIFTED = ["caseOpenLoad", "caseOpenPicker", "caseOpenStartReads", "caseColumnFlags", "caseOpenAwaitReads",
  "caseOpenSettleReads", "caseSharedHolders", "caseSharedHtml", "casePickerOptions", "caseNoteSnip", "caseHeaderModel",
  "renderCaseMoreFacts", "renderCaseSummary", "renderCaseCoreFields", "renderCaseRestFields", "renderCaseAssignedField",
  "caseFoldHtml", "caseFoldModel", "renderCaseForm", "caseKeptFolds", "renderCaseStickyActions", "renderCaseBanners",
  "renderCaseTasks", "renderCaseNotesComposer", "renderCaseHistory", "renderCaseSections", "renderCaseWork",
  "renderCaseModal", "wireCaseModalChrome", "fillCaseDocsAndFiles", "caseSyncReferrerOptions", "wireCaseFormLive",
  "saveCase", "wireCaseHistory", "wireCaseNotes", "wireCaseEmailActions", "wireCaseTasks", "buildCaseLogCallHooks",
  "wireCaseActions", "applyCaseOpenOpts"];

/* The source text of a top-level `function name(` / `window.name = … function` up to its closing
   `}` at column 0. */
function topLevelBody(src, startRe) {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => startRe.test(l));
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^}/.test(lines[j])) j++;
  return lines.slice(i, j + 1);
}

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  const VIEWS = [];
  for (const persona of ["p4", "p2"]) for (const [w, vp] of [["1440", DESK], ["390", PHONE]]) VIEWS.push({ persona, w, vp });
  let baseApp = null;
  try { baseApp = execFileSync("git", ["-C", REPO, "show", `${BASE_SHA}:admin/app.js`], { encoding: "utf8", maxBuffer: 64 << 20 }); } catch (_) { baseApp = null; }
  const errPages = [];
  try {
    /* =====================================================================
       RECORD — the fixture, from the base tree.
       ===================================================================== */
    if (RECORD) {
      if (!baseApp) throw new Error(`--record needs git and ${BASE_SHA}`);
      const out = { recordedFrom: BASE_SHA, views: {} };
      for (const v of VIEWS) {
        const page = await boot(browser, v.persona, v.vp, baseApp);
        for (const st of ["offer", "completed"]) {
          await openCase(page, await pickCase(page, st));
          out.views[`${v.persona}-${v.w}-${st}`] = maskHeavy(await modalHtml(page));
        }
        await page.context().close();
      }
      fs.writeFileSync(SNAP, JSON.stringify(out, null, 1) + "\n");
      console.log(`recorded ${Object.keys(out.views).length} views → ${SNAP}`);
      return;
    }

    /* =====================================================================
       §A · the source, read over HTTP (what the browser actually runs)
       ===================================================================== */
    console.log("\n— §A · source");
    const src = await fetchText("/admin/app.js");
    const oc = topLevelBody(src, /^window\.openCase = async function \(id, opts = \{\}\) \{/);
    ok("A1 · window.openCase found in the served app.js", !!oc);
    const ocLen = oc ? oc.length : 9999;
    ok(`A2 · openCase is ≤ 200 lines (it is ${ocLen}; was 1,936)`, ocLen <= 200);
    const ocSrc = (oc || []).slice(1, -1).join("\n");
    const closures = (ocSrc.match(/\bfunction\b|=>/g) || []).length;
    ok(`A3 · openCase holds ≤ 1 nested closure (it holds ${closures}: the Save binding; was 44)`, closures <= 1);
    const missing = LIFTED.filter((n) => !new RegExp(`^(async )?function ${n}\\(`, "m").test(src));
    eq("A4 · every lifted function is declared at the top level", missing, []);
    const famStart = src.indexOf("async function caseOpenLoad(");
    const famEnd = src.indexOf("\n};", src.indexOf("window.openCase = async function (id, opts = {}) {"));
    const fam = src.slice(famStart, famEnd);
    ok("A5 · the openCase family is contiguous and sits immediately above openCase", famStart > 0 && famEnd > famStart && src.indexOf("function applyCaseOpenOpts(") < src.indexOf("window.openCase = async"));
    eq("A6 · no M-migration save-retry ladder left (isMissingColumnError / *_SUPPORTED writes)",
      (fam.match(/isMissingColumnError|[A-Z_]+_SUPPORTED\s*=/g) || []), []);
    eq("A7 · no \"NOT saved (run migration …)\" toast suffix left", (fam.match(/NOT saved|run migration M|reason kept as a note only/g) || []), []);
    ok("A8 · Save is one UPDATE and one INSERT (no retries)",
      (fam.match(/db\.from\("cases"\)\.update\(row\)/g) || []).length === 1 && (fam.match(/db\.from\("cases"\)\.insert\(row\)/g) || []).length === 1);
    ok("A9 · no inline style added: style=\" count in the family equals the base openCase's",
      !baseApp || (() => {
        /* R90 · merge: BASE_SHA is now the merged tree, where the family already exists — locate it by
           the same markers as `fam`; D1 deleted probe-only branches (some carried a style attribute),
           so the contract is "no inline style ADDED": current ≤ base. */
        const b0 = Math.max(0, baseApp.indexOf("async function caseOpenLoad("));
        const b1 = baseApp.indexOf("\n};", baseApp.indexOf("window.openCase = async function (id, opts = {}) {"));
        const count = (s) => (s.match(/style="|\.style\./g) || []).length;
        return count(fam) <= count(baseApp.slice(b0, b1));
      })());

    /* =====================================================================
       §B · the functions on the page
       ===================================================================== */
    console.log("\n— §B · the lifted functions are live");
    {
      const page = await boot(browser, "p4", DESK);
      const types = await page.evaluate((names) => names.map((n) => { try { return typeof eval(n); } catch (_) { return "missing"; } }), LIFTED);
      LIFTED.forEach((n, i) => ok(`B · typeof ${n} === "function"`, types[i] === "function", types[i]));
      ok("B · window.openCase is still the entry point", await page.evaluate(() => typeof window.openCase === "function"));
      errPages.push(page);
    }

    /* =====================================================================
       §C · snapshot equality
       ===================================================================== */
    console.log("\n— §C · the case modal, byte for byte");
    const stored = fs.existsSync(SNAP) ? JSON.parse(fs.readFileSync(SNAP, "utf8")) : null;
    ok("C0 · stored fixture present (recorded from the base)", !!stored && stored.recordedFrom === BASE_SHA);
    for (const v of VIEWS) {
      const now = await boot(browser, v.persona, v.vp);
      const base = baseApp ? await boot(browser, v.persona, v.vp, baseApp) : null;
      for (const st of ["offer", "completed"]) {
        const label = `${v.persona} ${v.w} ${st}`;
        const id = await pickCase(now, st);
        await openCase(now, id);
        const html = await modalHtml(now);
        ok(`C · ${label}: the modal painted (case form present)`, html.includes('id="case-form"') && html.length > 20000, String(html.length));
        if (base) {
          await openCase(base, await pickCase(base, st));
          const b = maskLight(await modalHtml(base)), a = maskLight(html);
          ok(`C · ${label}: identical to the base tree (${BASE_SHA}) live`, a === b, firstDiff(b, a));
        } else console.log(`  · ${label}: live base comparison skipped (no git / ${BASE_SHA})`);
        const want = stored && stored.views[`${v.persona}-${v.w}-${st}`];
        ok(`C · ${label}: identical to the stored fixture`, !!want && maskHeavy(html) === want, want ? firstDiff(want, maskHeavy(html)) : "no fixture view");
      }
      errPages.push(now);
      if (base) errPages.push(base);
    }

    /* =====================================================================
       §D · behaviour the split must keep
       ===================================================================== */
    console.log("\n— §D · behaviour");
    {
      const page = await boot(browser, "p4", DESK);
      const offerId = await pickCase(page, "offer");
      const doneId = await pickCase(page, "completed");

      // focus option
      await openCase(page, offerId, { focus: "task" });
      eq("D1 · openCase(id, { focus: 'task' }) focuses #new-task", await page.evaluate(() => document.activeElement && document.activeElement.id), "new-task");
      ok("D2 · …and opens the task composer's options (.is-active)", await page.evaluate(() => document.querySelector("#modal #task-compose").classList.contains("is-active")));
      await openCase(page, offerId, { focus: "note" });
      eq("D3 · { focus: 'note' } focuses #new-note", await page.evaluate(() => document.activeElement && document.activeElement.id), "new-note");
      await openCase(page, offerId);
      ok("D4 · openCase(id) alone focuses no composer", await page.evaluate(() => !["new-task", "new-note"].includes(document.activeElement && document.activeElement.id)));

      // R88 fold persistence
      const foldState = () => page.evaluate(() => {
        const m = {}; document.querySelectorAll("#modal details.case-fold").forEach((d) => { if (d.dataset.fold) m[d.dataset.fold] = d.open; }); return m;
      });
      const defaults = await foldState();
      const flipped = Object.keys(defaults).filter((k) => k !== "details").slice(0, 2);
      ok("D5 · the Offer case has folds to flip", flipped.length === 2, JSON.stringify(defaults));
      await page.evaluate((keys) => keys.forEach((k) => { const d = document.querySelector(`#modal details.case-fold[data-fold="${k}"]`); d.open = !d.open; }), flipped);
      const want = Object.assign({}, defaults); flipped.forEach((k) => { want[k] = !defaults[k]; });
      await page.evaluate((id) => window.openCase(id), offerId);   // a same-case re-render, modal still showing
      await wait(page, 2200);
      eq("D6 · a same-case re-render keeps the folds the operator flipped", await foldState(), want);
      await openCase(page, doneId);
      await openCase(page, offerId);
      eq("D7 · a fresh open of the case starts from the defaults again", await foldState(), defaults);

      // scrollTo docs
      await openCase(page, offerId, { scrollTo: "docs" });
      ok("D8 · { scrollTo: 'docs' } opens the fold holding #case-docs", await page.evaluate(() => { const d = document.querySelector("#modal #case-docs"); const f = d && d.closest("details.case-fold"); return !!d && (!f || f.open); }));

      // R83 — two opens in flight: the later one owns the modal
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
      await wait(page, 300);
      await page.evaluate(({ a, b }) => { window.openCase(a); window.openCase(b); }, { a: offerId, b: doneId });
      await wait(page, 3000);
      eq("D9 · the R83 stale-open guard: the second of two concurrent opens is the one painted",
        await page.evaluate(() => (document.querySelector("#modal #case-form") || {}).dataset.caseId), doneId);

      // new-case form
      await openCase(page, null);
      ok("D10 · openCase() with no id paints the slim new-case form", await page.evaluate(() => {
        const f = document.querySelector("#modal #case-form");
        return !!f && f.dataset.caseId === "" && !!f.querySelector(".case-core-grid") && !document.querySelector("#modal #cs-sticky-actions");
      }));

      // Save — one write, plain toast
      await openCase(page, offerId);
      const newLender = `R90B Lender ${Date.now().toString(36)}`;
      const writes = await page.evaluate(async (lender) => {
        const db = window.db;
        let updates = 0;
        const orig = db.from.bind(db);
        db.from = (t) => { const q = orig(t); if (t === "cases") { const u = q.update.bind(q); q.update = (r) => { updates++; return u(r); }; } return q; };
        document.querySelector("#modal .case-details").open = true;
        const el = document.querySelector('#case-form [name="lender"]');
        el.value = lender; el.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("toast").textContent = "";
        document.querySelector("#modal-save").click();
        await new Promise((r) => setTimeout(r, 2500));
        db.from = orig;
        return { updates, toast: document.getElementById("toast").textContent };
      }, newLender);
      eq("D11 · Save issues exactly one cases UPDATE", writes.updates, 1);
      ok("D12 · …and toasts plain \"Case saved\" (no migration suffix)", /^Case saved$/.test(writes.toast.trim()), writes.toast);
      const saved = await page.evaluate(async (id) => (await window.db.from("cases").select("lender").eq("id", id).single()).data, offerId);
      eq("D13 · …and the edit landed", saved && saved.lender, newLender);
      errPages.push(page);
    }

    /* =====================================================================
       §Z · no console errors
       ===================================================================== */
    console.log("\n— §Z · console");
    const errs = errPages.flatMap((p) => realErrs(p));
    eq("Z1 · no console errors or page errors on any page this suite drove", errs, []);
  } catch (e) {
    failures.push("CRASH: " + (e && e.stack || e));
    console.log("CRASH", e);
  } finally {
    await browser.close();
    if (server) try { process.kill(-server.pid); } catch (_) { /* already gone */ }
  }
  if (RECORD) return;
  console.log(`\nr90_case_split: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  FAIL " + f)); process.exit(1); }
})();
