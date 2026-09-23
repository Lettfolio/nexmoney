/* ==========================================================================
   R90 · A — THE MIGRATION LAYER IS RETIRED (tests/r90_migrations.js)

   Every column, table and RPC the M1–M13 feature-detect layer probed is live in production
   (db/columns.json, db/_live_functions_snapshot.sql), so the app names them unconditionally.

   §A — source: no `*Supported()` probe is DEFINED anywhere; no probe / star-row sniffer / retired
        flag is REFERENCED outside openCase (slice B's region) and the one fenced compatibility
        block that answers openCase's names; no 42703 / 42P01 / 42883 string handling outside
        isMissingColumnError (and core.js's error_events gate); isMissingTableError and
        isMissingFunctionError are gone; isMissingColumnError keeps exactly its two
        non-migration callers outside openCase (the book's schema-drift retry, the firm export's
        unordered retry); no "needs migration" / "run migration" copy outside openCase; diary.js,
        import.js and vault.js carry no fallback at all.
   §B — the mock: m1–m13 are INERT (setMigrations / __mock.migrations / the pre-load seed), the
        columns, tables and RPCs they used to hide keep answering; m14 / m15 stay LIVE (their
        functions post-date the Sep-8 snapshot, so the app keeps those fallbacks); setMigrations()
        still busts the session Book (R85).
   R90 · D: openCase's probes are retired too — the fenced compatibility block is gone, so §A now
        scans the WHOLE of app.js (openCase included) and §C checks the eleven names are undefined.
   §C — in-page: the old probe names no longer exist; setMigrations({m3:false, …}) changes
        nothing visible on Pipeline (board and table), Data health, Diary and Today; the surfaces
        that used to hide behind a probe render; zero console errors.

   Run:  node tests/r90_migrations.js   (REPO/PORT patched per-sandbox like the rest of the battery)
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
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + String(detail).slice(0, 400) : ""}`); }
}

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
const rd = (f) => fs.readFileSync(path.join(REPO, "admin", f), "utf8");
/* Comments and template-comment holes out, string/regex literals kept: a probe named in prose
   (a round tag, a tombstone) is not a probe. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

/* openCase is R90 slice B's region; the fenced block beside the property-chip helpers answers the
   names it still uses. Both are located by their own markers, never by line number. */
function regions(app) {
  const ocA = app.indexOf("window.openCase = async function");
  const ocB = app.indexOf("/* ---------- R5-12 / B7", ocA);
  const shA = app.indexOf("/* R90 · A — THE MIGRATION LAYER IS RETIRED.");
  const shB = app.indexOf("/* ---- end R90 · A openCase compatibility block ---- */", shA);
  return { ocA, ocB, shA, shB };
}
function outside(app) {
  const r = regions(app);
  const cut = [[r.ocA, r.ocB], [r.shA, r.shB]].filter(([a, b]) => a >= 0 && b > a).sort((x, y) => x[0] - y[0]);
  let out = "", at = 0;
  cut.forEach(([a, b]) => { out += app.slice(at, a); at = b; });
  return out + app.slice(at);
}

const DESK = { width: 1440, height: 900 };
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));

async function boot(browser, persona, init) {
  const ctx = await browser.newContext({ viewport: DESK, locale: "en-GB", timezoneId: "Europe/London" });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.nav === "function" && document.querySelector("#app-view") && !document.querySelector("#app-view").classList.contains("hidden"), null, { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { try { if (window.tourEnd) window.tourEnd(false); } catch (e) { /* not open */ } });
  await page.waitForTimeout(300);
  return page;
}
async function go(page, where, ms) {
  await page.evaluate((w) => window.nav(w), where);
  await page.waitForTimeout(ms || 1500);
}
/* The visible text of a page, clocks masked (the same mask the R90 DOM oracle uses). */
const pageText = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return String(el ? el.innerText : "")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<ISO>")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?(\s*(am|pm|AM|PM)\b)?/g, "<HM>")
    .replace(/\b(\d+|an?|one)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\s+ago\b/gi, "<AGO>")
    .replace(/\bjust now\b/gi, "<AGO>");
}, sel);

const ALL_OFF = { m1: false, m2: false, m3: false, m4: false, m5: false, m6: false, m7: false, m10: false, m11: false, m12: false, m13: false };
const ALL_ON = { m1: true, m2: true, m3: true, m4: true, m5: true, m6: true, m7: true, m10: true, m11: true, m12: true, m13: true };

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* ------------------------------------------------------------------ §A */
    console.log("§A — source");
    const app = rd("app.js");
    const pageFiles = ["diary.js", "import.js", "vault.js", "reports-money.js", "core.js"];
    /* R90 · D: was stripComments(outside(app)) — openCase and the compatibility block cut out; now the
       block is deleted and openCase carries no probe, so the whole file is scanned. */
    const code = { "app.js": stripComments(app) };
    pageFiles.forEach((f) => { code[f] = stripComments(rd(f)); });
    const r = regions(app);
    /* R90 · D: was "both fences are found" — now openCase is found and the compatibility block is gone. */
    ok("A0 · openCase is found and the R90 · A compatibility block is gone (both markers absent)", r.ocA > 0 && r.ocB > r.ocA && r.shA < 0 && r.shB < 0 && !/openCase compatibility block|migratedYes|migratedNoop/.test(app), JSON.stringify(r));

    const defs = Object.entries(code).flatMap(([f, s]) => (s.match(/(?:async\s+)?function\s+[A-Za-z]+Supported\s*\(/g) || []).map((m) => f + ": " + m));
    ok("A1 · no `*Supported()` probe is DEFINED in any admin script", defs.length === 0, JSON.stringify(defs));

    const calls = Object.entries(code).flatMap(([f, s]) => (s.match(/\b[a-z][A-Za-z]*Supported\s*\(/g) || []).map((m) => f + ": " + m));
    ok("A2 · no `*Supported(` call anywhere (openCase included, R90 · D)", calls.length === 0, JSON.stringify(calls));

    const RETIRED_FLAGS = ["PROP_ADDR_SUPPORTED", "REFERRER_SUPPORTED", "DOCS_SUPPORTED", "CARE_SUPPORTED", "CASE_FILES_SUPPORTED",
      "CALLPACK_SUPPORTED", "POLICY_START_SUPPORTED", "MORTGAGE_ACCT_SUPPORTED", "FORWARD_SUPPORTED", "BTL_ICR_SUPPORTED",
      "LENDER_TRACK_SUPPORTED", "REMINDER_GUARD_SUPPORTED", "LEAD_SLA_SUPPORTED", "LEAD_DISCARD_REASON_SUPPORTED",
      "ABSENCES_SUPPORTED", "PROT_QUOTE_SUPPORTED", "PROFILE_CONTACT_SUPPORTED"];
    const flagHits = Object.entries(code).flatMap(([f, s]) => RETIRED_FLAGS.filter((k) => new RegExp("\\b" + k + "\\b").test(s)).map((k) => f + ": " + k));
    ok("A3 · no retired `*_SUPPORTED` flag is read or written anywhere (openCase included, R90 · D)", flagHits.length === 0, JSON.stringify(flagHits));

    const sniff = Object.entries(code).flatMap(([f, s]) => (s.match(/\bnote[A-Za-z]+FromStarRow\b/g) || []).map((m) => f + ": " + m));
    ok("A4 · no star-row sniffer (note*FromStarRow) anywhere (openCase included, R90 · D)", sniff.length === 0, JSON.stringify(sniff));

    ok("A5 · runCombinedSupportProbe and its promise are gone", !/runCombinedSupportProbe|COMBINED_PROBE_PROMISE/.test(Object.values(code).join("\n")));

    ok("A6 · isMissingTableError and isMissingFunctionError are gone (no non-migration caller remained)",
      !/isMissingTableError|isMissingFunctionError/.test(stripComments(app) + Object.values(code).join("\n")));

    const colCallers = (code["app.js"].match(/isMissingColumnError\s*\(/g) || []).length - 1;   // minus the definition
    const colDef = /function isMissingColumnError\s*\(/.test(code["app.js"]);
    ok("A7 · isMissingColumnError is kept for exactly its two non-migration callers outside openCase (book drift retry, export retry)",
      colDef && colCallers === 2 && /bookReadTable[\s\S]{0,600}isMissingColumnError/.test(code["app.js"]) && /exportReadTable[\s\S]{0,900}isMissingColumnError/.test(code["app.js"]),
      `callers=${colCallers}`);

    const codeLits = Object.entries(code).flatMap(([f, s]) => {
      const hits = [];
      s.split("\n").forEach((l) => { if (/["'`](42703|42P01|42883)["'`]/.test(l)) hits.push(f + ": " + l.trim().slice(0, 100)); });
      return hits;
    });
    const allowed = (h) => /isMissingColumnError|return !!e && \(e\.code === "42703"/.test(h) || /^core\.js: .*errorEventsOff/.test(h);
    ok("A8 · no 42703 / 42P01 / 42883 string handling outside isMissingColumnError (and core.js's error_events gate)", codeLits.every(allowed), JSON.stringify(codeLits.filter((h) => !allowed(h))));

    const toastHits = Object.entries(code).flatMap(([f, s]) => (s.match(/needs? migration|run migration|migration M\d|no [a-z_ -]*column yet|has no [a-z_ ]*table yet/gi) || []).map((m) => f + ": " + m));
    ok("A9 · no \"needs migration\" / \"run migration\" / \"no … column yet\" copy outside openCase", toastHits.length === 0, JSON.stringify(toastHits));

    const pageFallbacks = ["diary.js", "import.js", "vault.js"].filter((f) => /isMissing[A-Za-z]*Error|42703|42P01|Supported\(|_SUPPORTED/.test(code[f]));
    ok("A10 · diary.js, import.js and vault.js carry no migration fallback at all", pageFallbacks.length === 0, JSON.stringify(pageFallbacks));

    const mock = rd("mock-supabase.js");
    ok("A11 · the mock no longer carries MIGRATION_COLUMNS / MIGRATION_TABLES / undefinedColumn / disabledColumns",
      !/MIGRATION_COLUMNS|MIGRATION_TABLES|function undefinedColumn|function disabledColumns|function tableIsMissing/.test(mock));
    ok("A12 · the mock's live flags are exactly m14 and m15", /LIVE_MIGRATION_FLAGS = \["m14", "m15"\]/.test(mock));

    /* ------------------------------------------------------------------ §B */
    console.log("§B — the mock");
    const p4 = await boot(browser, "p4");
    const b = await p4.evaluate(async (a) => {
      const db = window.__mockDb;
      const flags = window.__mock.setMigrations(a.off);
      const allOn = Object.keys(a.off).every((k) => flags[k] === true && window.__mock.migrations[k] === true);
      const id = (await db.from("cases").select("id").limit(1)).data[0].id;
      const star = (await db.from("cases").select("*").eq("id", id)).data[0];
      const w = await db.from("cases").update({ property_address: "12 Retired Layer Road, BH1 1AA" }).eq("id", id).select("id,property_address");
      const docs = await db.from("case_documents").select("id").limit(1);
      const dd = await db.from("duplicate_dismissals").select("id").limit(1);
      const wa = await db.from("watch_alerts").select("id,snoozed_until").limit(1);
      const prof = await db.from("profiles").select("id,phone,email_signoff").limit(1);
      const sa = await db.rpc("get_staff_activity");
      const dc = await db.rpc("get_dashboard_counts");
      window.__mock.setMigrations(a.on);
      return {
        allOn,
        starCols: ["property_address", "referrer_client_id", "waiting_on", "solicitor_firm", "doc_token", "lost_reason", "broker_fee_paid_at"].every((k) => k in star),
        writeOk: !w.error && w.data && w.data[0] && w.data[0].property_address === "12 Retired Layer Road, BH1 1AA",
        tablesOk: !docs.error && !dd.error && !wa.error && !prof.error && prof.data[0] && ("phone" in prof.data[0]),
        rpcsOk: !sa.error && !dc.error,
      };
    }, { off: ALL_OFF, on: ALL_ON });
    ok("B1 · setMigrations({m1…m13:false}) is inert: every flag still reads ON (return value and __mock.migrations)", b.allOn, JSON.stringify(b));
    ok("B2 · …a select(\"*\") still carries every column the M2/M7/M10/M11 flags used to hide", b.starCols, JSON.stringify(b));
    ok("B3 · …a write naming property_address lands (was 42703 with m7 off)", b.writeOk, JSON.stringify(b));
    ok("B4 · …case_documents / duplicate_dismissals / watch_alerts snooze / profiles contact all answer (were 42P01 / 42703)", b.tablesOk, JSON.stringify(b));
    ok("B5 · …get_staff_activity and get_dashboard_counts answer (were 42883 with m12 / m13 off)", b.rpcsOk, JSON.stringify(b));

    const live = await p4.evaluate(async () => {
      const db = window.__mockDb;
      window.__mock.setMigrations({ m14: false });
      const off = await db.rpc("get_team_mfa");
      window.__mock.setMigrations({ m14: true });
      const on = await db.rpc("get_team_mfa");
      return { offCode: off.error && off.error.code, onOk: !on.error };
    });
    ok("B6 · m14 stays LIVE: OFF ⇒ get_team_mfa is 42883, ON again ⇒ it answers (db/r86 post-dates the snapshot)", live.offCode === "42883" && live.onOk, JSON.stringify(live));

    const bust = await p4.evaluate(async () => {
      await window.bookLoad();
      const before = window.__bookStats();
      window.__mock.setMigrations({ m3: false });
      const dirty = window.__bookStats().dirty;
      await window.bookLoad();
      const after = window.__bookStats();
      window.__mock.setMigrations({ m3: true });
      return { full: dirty && dirty.full === true, reloaded: after.fullLoads === before.fullLoads + 1 };
    });
    ok("B7 · setMigrations() still busts the session Book as a delete (R85): dirty.full, then one full reload", bust.full && bust.reloaded, JSON.stringify(bust));
    await p4.context().close();

    const seeded = await boot(browser, "p4", () => { window.__mockMigrations = { m7: false, m10: false, m12: false }; });
    const s = await seeded.evaluate(() => ({ m7: window.__mock.migrations.m7, m10: window.__mock.migrations.m10, m12: window.__mock.migrations.m12 }));
    ok("B8 · the pre-load seed window.__mockMigrations is inert for m1–m13 too", s.m7 === true && s.m10 === true && s.m12 === true, JSON.stringify(s));
    await seeded.context().close();

    /* ------------------------------------------------------------------ §C */
    console.log("§C — in-page");
    const page = await boot(browser, "p4");
    const shim = await page.evaluate(async () => {
      const names = ["propAddrSupported", "referrerSupported", "docsSupported", "callPackSupported", "policyStartSupported",
        "caseFilesSupported", "forwardDatesSupported", "mortgageAcctSupported", "btlIcrSupported", "lenderTrackSupported", "protQuoteSupported"];
      const out = {};
      // eslint-disable-next-line no-eval
      for (const n of names) { try { (0, eval)(n); out[n] = "defined"; } catch (e) { out[n] = e instanceof ReferenceError ? "gone" : String(e); } }
      return out;
    });
    /* R90 · D: was "the eleven names openCase still calls resolve and answer true" — the block is deleted. */
    ok("C1 · the eleven old openCase probe names are no longer defined anywhere (ReferenceError)", Object.values(shim).every((v) => v === "gone"), JSON.stringify(shim));

    /* Visible parity: the same page, painted before and after every inert flag is flipped OFF. */
    const snap = async (where, sel, prep) => {
      if (prep) await page.evaluate(prep);
      await go(page, where, 2200);
      return pageText(page, sel);
    };
    const views = [
      ["pipeline", "#page-pipeline", () => { try { localStorage.setItem("nx_pipe_view", "board"); } catch (e) { /* */ } }],
      ["data", "#page-data", null],
      ["diary", "#page-diary", null],
      ["dashboard", "#page-dashboard", null],
    ];
    const before = {};
    for (const [w, sel, prep] of views) before[w] = await snap(w, sel, prep);
    await page.evaluate((off) => window.__mock.setMigrations(off), ALL_OFF);
    const after = {};
    for (const [w, sel, prep] of views) after[w] = await snap(w, sel, prep);
    await page.evaluate((on) => window.__mock.setMigrations(on), ALL_ON);
    ok("C2 · setMigrations({m1…m13:false}) changes nothing visible on Pipeline", before.pipeline.length > 50 && before.pipeline === after.pipeline, `${before.pipeline.length} vs ${after.pipeline.length}`);
    ok("C3 · …nor on Data health", before.data.length > 50 && before.data === after.data, `${before.data.length} vs ${after.data.length}`);
    ok("C4 · …nor on the Diary", before.diary.length > 20 && before.diary === after.diary, `${before.diary.length} vs ${after.diary.length}`);
    ok("C5 · …nor on Today", before.dashboard.length > 20 && before.dashboard === after.dashboard, `${before.dashboard.length} vs ${after.dashboard.length}`);

    const surfaces = await page.evaluate(async () => {
      window.nav("data");
      await new Promise((r) => setTimeout(r, 2500));
      const ids = ["dh-tile-address", "dh-tile-sharedprop", "dh-tile-vulnerable", "dh-tile-suppressed", "dh-tile-nopolicystart"];
      const tiles = ids.filter((id) => !document.getElementById(id));
      window.nav("diary");
      await new Promise((r) => setTimeout(r, 1800));
      const abs = document.querySelector("#diary-absence-panel");
      return { missingTiles: tiles, absText: abs ? abs.innerText : "(none)" };
    });
    ok("C6 · Data health renders the five tiles that used to hide behind a probe", surfaces.missingTiles.length === 0, JSON.stringify(surfaces.missingTiles));
    ok("C7 · the Diary's absence panel never renders the retired \"no staff_absences table\" state", !/has no staff_absences table|no <code>staff_absences<\/code>/i.test(surfaces.absText) && !/table yet/.test(surfaces.absText), surfaces.absText.slice(0, 160));

    /* The table's column list is built from the rows; "all columns" mode shows every column the
       table can offer, so Property and Waiting on (the two columns the M7 / m10 gates used to drop)
       must both be there. */
    const table = await page.evaluate(async () => {
      window.nav("pipeline");
      await new Promise((r) => setTimeout(r, 2000));
      const prevMode = localStorage.getItem(PIPE_COLS_KEY);
      localStorage.setItem(PIPE_COLS_KEY, "all");
      pipelineView = "table";   // eslint-disable-line no-undef
      await loadPipeline();       // eslint-disable-line no-undef
      await new Promise((r) => setTimeout(r, 800));
      const heads = [...document.querySelectorAll("#table-wrap th")].map((th) => th.textContent.trim());
      if (prevMode == null) localStorage.removeItem(PIPE_COLS_KEY); else localStorage.setItem(PIPE_COLS_KEY, prevMode);
      pipelineView = "board";   // eslint-disable-line no-undef
      return heads;
    });
    ok("C8 · the pipeline table offers Property and Waiting on (no M7 / m10 gate left to drop them)",
      table.some((h) => /^Property/.test(h)) && table.some((h) => /^Waiting on/.test(h)), JSON.stringify(table));

    ok("C9 · zero console errors across the whole run", realErrs(page).length === 0, JSON.stringify(realErrs(page)));
    await page.context().close();
  } catch (e) {
    failures.push("crashed: " + (e && e.stack || e));
    console.log("  ✗ crashed", e);
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) { /* */ } }
  }
  console.log(`\nR90 · A migrations: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
})();
