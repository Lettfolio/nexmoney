#!/usr/bin/env node
/* =============================================================================
   tests/r79_locks.js — acceptance tests for R79 build B, "Trust the send"
   (items B1–B6).

     §A  EXPORT WITHOUT LIVE KEYS (B1). The firm export withholds every
         *token column's VALUE ("(withheld)") — fact_finds.token,
         cases.doc_token, cases.nps_token, clients.comms_token, and token
         diffs inside audit_log.changes — while per-table row counts still
         match __mockDb exactly; doc_token_expires_at (a date ABOUT a token)
         survives; the manifest and the on-screen summary both say
         "link tokens withheld".

     §B  30-DAY LINKS (B2). A fresh fact-find mint and a fresh doc-link mint
         both stamp expires_at / doc_token_expires_at = now()+30d (ISO); the
         seeded EXPIRED fact-find and doc link show "Link expired <date> —
         regenerate…"; Regenerate (house overlay, says the old link dies BY
         VALUE) writes a new token + fresh 30-day expiry and the old value is
         gone from the database; a valid link says "valid until"; a pre-R79
         link with no expiry says so; a SUBMITTED fact-find shows no link
         state at all.

     §C  BUST AFTER reassign_holdings (B3). With the board cache warm, the
         RPC-first handover path busts it eagerly; re-entering the board shows
         the new owner with ZERO manual refresh (no __bustBoardCache). The
         queueing-RPC call site (runQueueNow) busts too.

     §D  TOUR RESILIENCE (B4). A stray click outside the bubble no longer
         kills the tour; a click ON the spotlighted target advances it; a
         reload mid-tour resumes at the same step (nx_tour_step_<uid>);
         Finish still finishes (bubble gone, key cleared, mark_tour_seen).

     §E  WHAT'S-NEW FOR NEW ARRIVALS (B5). A first-ever sign-in (tour_seen_at
         null) shows NO band and stamps the current release; day two (tour
         done, marker current) stays quiet; a genuinely newer change (marker
         behind) shows again; an adviser NEVER sees owner-tagged entries; an
         owner does.

     §F  SIGN-OUT RELOADS (B6). The explicit #logout-btn click navigates
         (location.reload after auth signOut — the old page's heap/DOM is
         gone); the INVOLUNTARY signed-out path (R76 strip over an open
         modal) does NOT reload and the half-typed note survives.

   Run:  node /root/nx/tests/r79_locks.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — see HARNESS.md.)
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

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  return srv;
}

async function boot(browser, persona, opts) {
  const o = opts || {};
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1440, height: 900 } }, o.ctx || {}));
  const page = await ctx.newPage();
  page.__ctx = ctx;
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  if (o.skipTour !== false) await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  if (o.init) await page.addInitScript(o.init, o.initArg);
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const wait = (page, ms) => page.waitForTimeout(ms);
const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 2400 : ms);
};
const txt = (page, sel) => page.$eval(sel, (e) => (e.textContent || "").replace(/\s+/g, " ").trim()).catch(() => null);

const DAY = 86400000;
/* "about 30 days from now": the mint runs seconds before the assertion, so ±36h of slack is
   generous and still catches a wrong unit or a wrong sign. */
const isAbout30d = (iso) => {
  const t = new Date(iso || 0).getTime();
  return t > Date.now() + 28.5 * DAY && t < Date.now() + 31.5 * DAY;
};

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* =======================================================================
     §A · B1 — the export withholds every link token, counts intact (p4)
     ===================================================================== */
  {
    console.log("\n— §A · export without live keys (p4 Daniel)");
    const page = await boot(browser, "p4");

    /* Arm the blob capture BEFORE the export (r13's technique, verbatim). */
    await page.evaluate(() => {
      window.__blob = null;
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__blob = b; try { return origCreate(b); } catch (e) { return "blob:captured"; } };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute("download")) return; return origClick.apply(this, arguments); };
    });

    /* Ground truth + two in-session token writes, so the export has to withhold values that were
       written through every path a real book has: fixtures, a direct nps_token write, and an
       audited doc_token CHANGE (whose old AND new values land in audit_log.changes). */
    const gt = await page.evaluate(async () => {
      const db = window.__mockDb;
      const anyCase = (await db.from("cases").select("id").eq("stage", "application").limit(1)).data[0];
      await db.from("cases").update({ nps_token: "nps-probe-r79-77aa" }).eq("id", anyCase.id);
      const quirkeCase = (await db.from("cases").select("id").eq("doc_token", "doc-quirke-90b7ae")).data[0];
      await db.from("cases").update({ doc_token: "doc-probe-r79-88bb" }).eq("id", quirkeCase.id);
      const ffs = (await db.from("fact_finds").select("token")).data.map((f) => f.token).filter(Boolean);
      const docs = (await db.from("cases").select("doc_token")).data.map((c) => c.doc_token).filter(Boolean);
      const comms = (await db.from("clients").select("comms_token")).data.map((c) => c.comms_token).filter(Boolean);
      return { counts: window.__mock.counts(), ffs, docs, comms };
    });
    ok("§A0 · fixture · seeded tokens exist to be withheld (fact-finds, doc links, comms tokens)",
      gt.ffs.length >= 2 && gt.docs.length >= 2 && gt.comms.length >= 40,
      JSON.stringify({ ffs: gt.ffs.length, docs: gt.docs.length, comms: gt.comms.length }));

    await goPage(page, "settings");
    await page.click("#firm-export-btn");
    await wait(page, 700);
    ok("§A1 · the export still asks first (R74's house confirm, not weakened)", !!(await page.$("#ovl-confirm-ok")));
    await page.click("#ovl-confirm-ok");
    await wait(page, 1200);

    const blobText = await page.evaluate(async () => (window.__blob ? await window.__blob.text() : null));
    ok("§A2 · exporting produced the JSON file", !!blobText, "no blob captured");
    const file = JSON.parse(blobText || "{}");

    // Row counts identical — withholding VALUES, never rows.
    const countTables = ["clients", "cases", "fact_finds", "audit_log"];
    const mismatch = countTables.filter((t) => (file.counts || {})[t] !== gt.counts[t]);
    ok("§A3 · per-table counts still match __mockDb exactly on the token-bearing tables",
      mismatch.length === 0, JSON.stringify({ mismatch, file: file.counts, gt: gt.counts }));

    // No token VALUE anywhere in the raw blob — fixtures, the nps probe, and BOTH sides of the
    // audited doc_token change (old value "doc-quirke-90b7ae" now lives only in audit_log.changes).
    const everyToken = [...gt.ffs, ...gt.docs, ...gt.comms, "nps-probe-r79-77aa", "doc-probe-r79-88bb", "doc-quirke-90b7ae"];
    const leaked = everyToken.filter((t) => blobText.includes(t));
    eq("§A4 · NO token value appears anywhere in the blob (fact-find, doc, nps, comms, audit diffs)", leaked, []);

    ok("§A5 · withheld values read \"(withheld)\" — the column and row survive",
      (file.tables.fact_finds || []).length === gt.counts.fact_finds
      && (file.tables.fact_finds || []).every((f) => f.token === "(withheld)")
      && (file.tables.cases || []).some((c) => c.doc_token === "(withheld)"),
      JSON.stringify((file.tables.fact_finds || []).map((f) => f.token)));
    ok("§A6 · clients.comms_token is withheld on every row that had one",
      (file.tables.clients || []).filter((c) => c.comms_token === "(withheld)").length === gt.comms.length,
      JSON.stringify((file.tables.clients || []).slice(0, 3).map((c) => c.comms_token)));
    // A date ABOUT a token is not a token: the expiry stamps survive, so the file still says when
    // links died even though it can no longer say what they were.
    ok("§A7 · doc_token_expires_at survives beside a withheld doc_token",
      (file.tables.cases || []).some((c) => c.doc_token === "(withheld)" && c.doc_token_expires_at && c.doc_token_expires_at !== "(withheld)"),
      JSON.stringify((file.tables.cases || []).filter((c) => c.doc_token).map((c) => ({ t: c.doc_token, e: c.doc_token_expires_at }))));
    ok("§A8 · the manifest names the withholding", /link tokens withheld/i.test(file.tokens_withheld || ""), file.tokens_withheld);
    const resultTxt = await txt(page, "#firm-export-result");
    ok("§A9 · the on-screen summary says \"link tokens withheld\"", /link tokens withheld/i.test(resultTxt || ""), resultTxt);
    ok("§A10 · the vault is still not in the file", !("vault_entries" in (file.tables || {})) && !("vault_entries" in (file.counts || {})),
      JSON.stringify(Object.keys(file.counts || {})));

    eq("§A · no console/page errors", realErrs(page), []);
    await page.__ctx.close();
  }

  /* =======================================================================
     §B · B2 — 30-day links: stamping, honest display, regenerate (p1 Kim)
     ===================================================================== */
  {
    console.log("\n— §B · 30-day links (p1 Kim, admin — staff can regenerate)");
    const page = await boot(browser, "p1");

    /* B1 · a FRESH fact-find mint stamps +30d. */
    const fresh = await page.evaluate(async () => {
      const db = window.__mockDb;
      const withFf = new Set((await db.from("fact_finds").select("case_id")).data.map((f) => f.case_id));
      const c = (await db.from("cases").select("id,client_id,stage").eq("stage", "decision_in_principle")).data
        .filter((x) => !withFf.has(x.id))[0];
      await window.factFind(c.id, c.client_id);
      await new Promise((r) => setTimeout(r, 400));
      const row = (await db.from("fact_finds").select("*").eq("case_id", c.id).single()).data;
      return { row, caseId: c.id, clientId: c.client_id };
    });
    ok("§B1a · opening the dialog on a bare case mints a token", !!fresh.row && !!fresh.row.token && fresh.row.token.length >= 18, JSON.stringify(fresh.row && fresh.row.token));
    ok("§B1b · …and stamps expires_at = now()+30d (ISO)", isAbout30d(fresh.row && fresh.row.expires_at), JSON.stringify(fresh.row && fresh.row.expires_at));
    const freshState = await txt(page, "#ff-link-state");
    ok("§B1c · the dialog says \"Link valid until <date>\"", /Link valid until /.test(freshState || ""), freshState);
    ok("§B1d · a valid link still offers Regenerate (rotation is not only for the dead)", !!(await page.$("#ff-regen")));

    /* B2 · the SEEDED EXPIRED fact-find shows the expired state and regenerates. */
    const expiredFix = await page.evaluate(async () => {
      const db = window.__mockDb;
      const row = (await db.from("fact_finds").select("*").eq("token", "ff-demo-0002-sent").single()).data;
      return row;
    });
    ok("§B2a · fixture · the seeded expired fact-find exists (sent, expires_at in the past)",
      !!expiredFix && expiredFix.status === "sent" && new Date(expiredFix.expires_at) < new Date(), JSON.stringify(expiredFix && { s: expiredFix.status, e: expiredFix.expires_at }));
    await page.evaluate((o) => window.factFind(o.case_id, o.client_id), expiredFix);
    await wait(page, 700);
    const expState = await txt(page, "#ff-link-state");
    ok("§B2b · the dialog says \"Link expired <date> — regenerate to send a fresh one\"",
      /Link expired /.test(expState || "") && /regenerate to send a fresh one/i.test(expState || ""), expState);

    await page.evaluate(() => document.querySelector("#ff-regen").click());
    await wait(page, 600);
    const regenBody = await txt(page, "#ovl-confirm-body");
    ok("§B2c · Regenerate confirms through the HOUSE overlay and says the old link dies BY VALUE",
      !!(await page.$("#ovl-confirm-ok")) && /current link stops working immediately/i.test(regenBody || "") && /old address itself becomes invalid/i.test(regenBody || ""), regenBody);
    await page.click("#ovl-confirm-ok");
    await wait(page, 900);
    const regen = await page.evaluate(async (o) => {
      const db = window.__mockDb;
      const row = (await db.from("fact_finds").select("*").eq("id", o.id).single()).data;
      const oldValue = (await db.from("fact_finds").select("id").eq("token", "ff-demo-0002-sent")).data;
      return { row, oldValueRows: oldValue.length };
    }, expiredFix);
    ok("§B2d · regenerating mints a NEW token on the same row", regen.row.token !== "ff-demo-0002-sent" && regen.row.token.length >= 18, JSON.stringify(regen.row.token));
    ok("§B2e · …with a fresh 30-day expiry", isAbout30d(regen.row.expires_at), JSON.stringify(regen.row.expires_at));
    eq("§B2f · the OLD token value is gone from the database — invalidated by value", regen.oldValueRows, 0);
    const afterState = await txt(page, "#ff-link-state");
    ok("§B2g · the reopened dialog now says valid-until", /Link valid until /.test(afterState || ""), afterState);

    /* B3 · a SUBMITTED fact-find shows NO link state — the link has done its job. */
    const submitted = await page.evaluate(async () => (await window.__mockDb.from("fact_finds").select("case_id,client_id").eq("token", "ff-demo-0001-submitted").single()).data);
    await page.evaluate((o) => window.factFind(o.case_id, o.client_id), submitted);
    await wait(page, 700);
    eq("§B3 · a submitted fact-find shows no expiry line and no Regenerate", { state: await page.$("#ff-link-state"), regen: await page.$("#ff-regen") }, { state: null, regen: null });
    await page.evaluate(() => window.closeModal());

    /* B4 · the DOCS link: expired fixture on the case screen. */
    const quirke = await page.evaluate(async () => {
      const db = window.__mockDb;
      const c = (await db.from("cases").select("id,doc_token,doc_token_expires_at").eq("doc_token", "doc-quirke-90b7ae").single()).data;
      return c;
    });
    ok("§B4a · fixture · Quirke's doc link is seeded EXPIRED", !!quirke && new Date(quirke.doc_token_expires_at) < new Date(), JSON.stringify(quirke));
    await page.evaluate((id) => window.openCase(id), quirke.id);
    await wait(page, 1400);
    const dState = await txt(page, "#docs-link-state");
    ok("§B4b · the docs area says \"Link expired <date> — regenerate to send a fresh one\"",
      /Link expired /.test(dState || "") && /regenerate to send a fresh one/i.test(dState || ""), dState);
    ok("§B4c · …and offers ↻ Regenerate link", !!(await page.$("#docs-link-regen")));

    await page.click("#docs-link-regen");
    await wait(page, 600);
    const dRegenBody = await txt(page, "#ovl-confirm-body");
    ok("§B4d · the docs regenerate confirm also says the old link dies by value",
      /current link stops working immediately/i.test(dRegenBody || ""), dRegenBody);
    await page.click("#ovl-confirm-ok");
    await wait(page, 1100);
    const dRegen = await page.evaluate(async (id) => {
      const db = window.__mockDb;
      const row = (await db.from("cases").select("doc_token,doc_token_expires_at").eq("id", id).single()).data;
      const oldRows = (await db.from("cases").select("id").eq("doc_token", "doc-quirke-90b7ae")).data;
      return { row, oldRows: oldRows.length };
    }, quirke.id);
    ok("§B4e · a new doc token with a fresh 30-day expiry", dRegen.row.doc_token !== "doc-quirke-90b7ae" && isAbout30d(dRegen.row.doc_token_expires_at), JSON.stringify(dRegen.row));
    eq("§B4f · the old doc token value is gone from the database", dRegen.oldRows, 0);
    const dAfter = await txt(page, "#docs-link-state");
    ok("§B4g · the repainted docs area says valid-until", /Link valid until /.test(dAfter || ""), dAfter);

    /* B5 · a FRESH doc-link mint stamps +30d (Amery, the no-token fixture). */
    const amery = await page.evaluate(async () => {
      const db = window.__mockDb;
      const cl = (await db.from("clients").select("id").eq("last_name", "Amery")).data[0];
      return (await db.from("cases").select("id,doc_token").eq("client_id", cl.id)).data.filter((c) => !c.doc_token)[0];
    });
    await page.evaluate(() => window.closeModal());
    await page.evaluate((id) => window.openCase(id), amery.id);
    await wait(page, 1400);
    await page.click("#docs-link-btn");
    await wait(page, 900);
    const minted = await page.evaluate(async (id) => (await window.__mockDb.from("cases").select("doc_token,doc_token_expires_at").eq("id", id).single()).data, amery.id);
    ok("§B5a · Create upload link mints token AND stamps doc_token_expires_at = now()+30d",
      !!minted.doc_token && minted.doc_token.length >= 18 && isAbout30d(minted.doc_token_expires_at), JSON.stringify(minted));
    const mintWarn = await txt(page, "#docs-link-warn");
    ok("§B5b · the bearer warning now names the stop date instead of \"does not expire\"",
      /stops working on /i.test(mintWarn || "") && /Anyone with this link can upload/i.test(mintWarn || "") && !/does not expire on its own/i.test(mintWarn || ""), mintWarn);
    // put Amery back the way the fixtures left her (r9_docs' own cleanup rule)
    await page.evaluate(async (id) => { await window.__mockDb.from("cases").update({ doc_token: null, doc_token_expires_at: null }).eq("id", id); }, amery.id);

    /* B6 · a LEGACY link (Osei — token, no expiry) is stated plainly, not guessed. */
    const osei = await page.evaluate(async () => (await window.__mockDb.from("cases").select("id,doc_token,doc_token_expires_at").eq("doc_token", "doc-osei-2d64f0").single()).data);
    eq("§B6a · fixture · Osei's link predates expiries", osei.doc_token_expires_at, null);
    await page.evaluate(() => window.closeModal());
    await page.evaluate((id) => window.openCase(id), osei.id);
    await wait(page, 1400);
    const legacyState = await txt(page, "#docs-link-state");
    ok("§B6b · a pre-R79 link says it has no expiry and never stops on its own",
      /no expiry date/i.test(legacyState || "") && /predates 30-day links/i.test(legacyState || ""), legacyState);
    await page.evaluate(() => window.closeModal());

    /* B7 · Ellingham's still-valid seeded link reads valid-until (the third state, untouched). */
    const ell = await page.evaluate(async () => (await window.__mockDb.from("cases").select("id").eq("doc_token", "doc-ellingham-4f21c8").single()).data);
    await page.evaluate((id) => window.openCase(id), ell.id);
    await wait(page, 1400);
    const ellState = await txt(page, "#docs-link-state");
    ok("§B7 · a seeded in-date link says \"Link valid until <date>\"", /Link valid until /.test(ellState || ""), ellState);

    eq("§B · no console/page errors", realErrs(page), []);
    await page.__ctx.close();
  }

  /* =======================================================================
     §C · B3 — reassign_holdings busts the board cache (p4 Daniel)
     ===================================================================== */
  {
    console.log("\n— §C · book handover busts the board cache (p4 Daniel)");
    const page = await boot(browser, "p4");
    await goPage(page, "pipeline");
    const warm = await page.evaluate(() => ({
      cached: !!boardCache,
      p2live: (boardCache ? boardCache.cases : []).filter((c) => c.assigned_to === "p2" && !["completed", "not_proceeding"].includes(c.stage)).length,
    }));
    ok("§C1 · the board cache is warm after the pipeline paints", warm.cached && warm.p2live > 0, JSON.stringify(warm));

    const tally = await page.evaluate(async () => {
      const t = await reassignHoldingsRpc("p2", "p3");
      return { t, cachedAfter: !!boardCache };
    });
    ok("§C2 · the RPC path moved the book (server-side transaction)", tally.t && tally.t.cases === warm.p2live, JSON.stringify(tally.t));
    eq("§C3 · the cache is busted EAGERLY at the call site — no __bustBoardCache, no write-wrap", tally.cachedAfter, false);

    /* Re-enter the board with zero manual refresh: the repopulated snapshot must show the new
       owner. (At base this walk served the STALE snapshot — the runtime-proven defect.) */
    await goPage(page, "dashboard", 1600);
    await goPage(page, "pipeline");
    const after = await page.evaluate(() => ({
      cached: !!boardCache,
      p2live: (boardCache ? boardCache.cases : []).filter((c) => c.assigned_to === "p2" && !["completed", "not_proceeding"].includes(c.stage)).length,
      p3live: (boardCache ? boardCache.cases : []).filter((c) => c.assigned_to === "p3" && !["completed", "not_proceeding"].includes(c.stage)).length,
    }));
    ok("§C4 · the re-entered board holds the handover — zero live cases left on the leaver",
      after.cached && after.p2live === 0 && after.p3live >= warm.p2live, JSON.stringify(after));

    /* The OTHER cases-writing rpc call site: runQueueNow queues via queue_automated_emails /
       queue_comms_extras (retention successors + stamps are cases writes) and must bust too.
       Fired and then CANCELLED at its confirm — queueing is not sending. */
    const qBust = await page.evaluate(async () => {
      boardCache = { cases: [], stageEntry: {} };   // re-warm artificially; only the bust matters
      window.runQueueNow();
      await new Promise((r) => setTimeout(r, 1200));
      const busted = !boardCache;
      const cancel = document.querySelector("#ovl-confirm-cancel");
      if (cancel) cancel.click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return busted;
    });
    eq("§C5 · the queueing-RPC call site (runQueueNow) busts the cache eagerly too", qBust, true);
    await wait(page, 600);

    eq("§C · no console/page errors", realErrs(page), []);
    await page.__ctx.close();
  }

  /* =======================================================================
     §D · B4 — tour resilience (p3 Luke, the tour_seen_at:null persona)
     ===================================================================== */
  {
    console.log("\n— §D · the tour survives a stray click and resumes after a reload (p3 Luke)");
    const page = await boot(browser, "p3", { skipTour: false });
    await wait(page, 800);
    eq("§D1 · the first-run tour fires at step 1", await txt(page, ".tour-step-n"), "1 of 4");

    /* A STRAY click — outside the bubble, outside the spotlighted target — used to tourEnd(false)
       silently (repro'd at base). Now it does nothing. */
    await page.evaluate(() => document.querySelector("#today-heading").click());
    await wait(page, 400);
    eq("§D2 · a stray click no longer kills the tour — still step 1", await txt(page, ".tour-step-n"), "1 of 4");

    /* A click ON the spotlighted target counts as doing the step. */
    await page.evaluate(() => document.querySelector("#briefing-panel").click());
    await wait(page, 400);
    eq("§D3 · clicking the spotlighted target advances the tour", await txt(page, ".tour-step-n"), "2 of 4");
    const savedStep = await page.evaluate(() => localStorage.getItem("nx_tour_step_p3"));
    eq("§D4 · progress is remembered under nx_tour_step_<uid>", savedStep, "1");

    /* A reload mid-tour resumes at the SAME step — not step 1 (the base defect: restart from 1
       on every visit until explicitly finished). */
    await page.reload({ waitUntil: "networkidle" });
    await wait(page, 2400);
    eq("§D5 · a reload resumes the tour at step 2, not step 1", await txt(page, ".tour-step-n"), "2 of 4");

    /* Finish still finishes exactly as today: bubble gone, mark_tour_seen, and (new) the
       progress key is cleared so nothing resumes a finished tour. */
    for (let i = 0; i < 6 && await page.$("#tour-next"); i++) {
      const last = (await txt(page, "#tour-next")) === "Finish";
      await page.click("#tour-next");
      await wait(page, 350);
      if (last) break;
    }
    const done = await page.evaluate(async () => ({
      bubble: !!document.querySelector("#tour-bubble"),
      key: localStorage.getItem("nx_tour_step_p3"),
      seen: (await window.__mockDb.from("profiles").select("tour_seen_at").eq("id", "p3").single()).data.tour_seen_at,
    }));
    ok("§D6 · Finish closes the tour, records mark_tour_seen, and clears the resume key",
      done.bubble === false && done.key === null && done.seen != null, JSON.stringify(done));

    eq("§D · no console/page errors", realErrs(page), []);
    await page.__ctx.close();

    /* A FRESH browser (clean storage) starts at step 1 — no stale resume leaks across people. */
    const p2 = await boot(browser, "p3", { skipTour: false });
    await wait(p2, 800);
    eq("§D7 · a clean browser still starts at step 1", await txt(p2, ".tour-step-n"), "1 of 4");
    await p2.__ctx.close();
  }

  /* =======================================================================
     §E · B5 — what's-new: first arrivals, day two, role tags
     ===================================================================== */
  {
    console.log("\n— §E · what's-new never greets a brand-new user, and entries carry roles");
    /* E1 · FIRST-EVER sign-in (p3, tour_seen_at null): no band, marker stamped current. */
    const page = await boot(browser, "p3");
    const first = await page.evaluate(() => ({
      hidden: document.getElementById("whatsnew-band").classList.contains("hidden"),
      html: (document.getElementById("whatsnew-band").innerHTML || "").trim().length,
      marker: localStorage.getItem("nx_whatsnew_last_p3"),
    }));
    ok("§E1 · a first-ever sign-in shows NO what's-new and silently stamps the current release",
      first.hidden && first.html === 0 && first.marker === "79", JSON.stringify(first));

    /* E2 · DAY TWO: the tour is done (tour_seen_at set), the marker is current — still quiet.
       The old behaviour greeted exactly this person with changes predating their existence. */
    const dayTwo = await page.evaluate(async () => {
      await window.__mockDb.rpc("mark_tour_seen");
      await renderWhatsNewBand();
      return {
        hidden: document.getElementById("whatsnew-band").classList.contains("hidden"),
        html: (document.getElementById("whatsnew-band").innerHTML || "").trim().length,
      };
    });
    ok("§E2 · day two stays quiet — nothing is newer than they are", dayTwo.hidden && dayTwo.html === 0, JSON.stringify(dayTwo));

    /* E3 · …until a REAL newer change: wind the marker back and the band returns. */
    const newer = await page.evaluate(async () => {
      localStorage.setItem("nx_whatsnew_last_p3", "72");
      await renderWhatsNewBand();
      const el = document.getElementById("whatsnew-band");
      return { hidden: el.classList.contains("hidden"), text: (el.textContent || "").replace(/\s+/g, " ").trim() };
    });
    ok("§E3 · a genuinely newer release shows the band again", !newer.hidden && /New since you were last here/.test(newer.text), JSON.stringify(newer));
    eq("§E · no console/page errors (p3)", realErrs(page), []);
    await page.__ctx.close();

    /* E4 · ROLE TAGS: an adviser (p2, returning, marker at 72 so only R79 entries show) NEVER
       sees the owner-tagged entry; the all-roles R79 entry still reaches them. */
    const adv = await boot(browser, "p2", { init: () => { try { localStorage.setItem("nx_whatsnew_last_p2", "72"); } catch (e) {} } });
    const advBand = await adv.evaluate(() => {
      const el = document.getElementById("whatsnew-band");
      return { hidden: el.classList.contains("hidden"), text: (el.textContent || "").replace(/\s+/g, " ").trim() };
    });
    ok("§E4a · the adviser gets the all-roles entry", !advBand.hidden && /30 days/.test(advBand.text), JSON.stringify(advBand));
    ok("§E4b · …and NEVER the owner-tagged one (exports are not their screen)", !/exports withhold/i.test(advBand.text), advBand.text);
    await adv.__ctx.close();

    /* E5 · the owner DOES see the owner-tagged entry, and dismissing stamps the marker. */
    const own = await boot(browser, "p4", { init: () => { try { localStorage.setItem("nx_whatsnew_last_p4", "72"); } catch (e) {} } });
    const ownBand = await own.evaluate(() => (document.getElementById("whatsnew-band").textContent || "").replace(/\s+/g, " ").trim());
    ok("§E5a · the owner sees the owner-tagged entry", /exports withhold/i.test(ownBand), ownBand);
    await own.click("#whatsnew-dismiss");
    await wait(own, 300);
    const dismissed = await own.evaluate(() => ({
      hidden: document.getElementById("whatsnew-band").classList.contains("hidden"),
      marker: localStorage.getItem("nx_whatsnew_last_p4"),
    }));
    ok("§E5b · dismissing hides it and stamps the current release", dismissed.hidden && dismissed.marker === "79", JSON.stringify(dismissed));
    await own.__ctx.close();

    /* E6 · a pre-marker returning user who dismissed the R72 line under the LEGACY key is
       treated as seen-up-to-72: only the R79 entries come back. */
    const leg = await boot(browser, "p4", { init: () => { try { localStorage.setItem("nx_whatsnew_r72", "seen"); } catch (e) {} } });
    const legBand = await leg.evaluate(() => (document.getElementById("whatsnew-band").textContent || "").replace(/\s+/g, " ").trim());
    ok("§E6 · the legacy nx_whatsnew_r72 dismissal is honoured — no R72 clauses, R79 ones only",
      !/bulk playbooks/i.test(legBand) && !/go-live list/i.test(legBand) && /30 days/.test(legBand), legBand);
    await leg.__ctx.close();
  }

  /* =======================================================================
     §F · B6 — explicit sign-out reloads; the involuntary path does not
     ===================================================================== */
  {
    console.log("\n— §F · sign-out reloads (p1 Kim)");
    const page = await boot(browser, "p1");
    await page.evaluate(() => { window.__heapMarker = "previous-user-residue"; });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.click("#logout-btn"),
    ]).catch(() => { failures.push("§F1 · logout did not navigate"); });
    await wait(page, 2000);
    const reloaded = await page.evaluate(() => ({
      marker: window.__heapMarker || null,   // a reload tears the old page down; the marker dies with it
    }));
    eq("§F1 · the explicit sign-out RELOADED the page — the prior user's heap/DOM is gone", reloaded.marker, null);
    /* HARNESS NOTE: the mock signs the ?as= persona straight back in on the fresh load (SIGNED_OUT
       is in-memory), so "the login screen comes up clean" is a production fact this harness cannot
       hold — the navigation itself, and the teardown it proves, is the pinned contract. */
    eq("§F · no console/page errors", realErrs(page), []);
    await page.__ctx.close();

    /* The INVOLUNTARY path — R76's strip over open work — must NOT reload. */
    console.log("\n— §F · the involuntary signed-out strip path does NOT reload");
    const p2 = await boot(browser, "p1");
    const caseId = await p2.evaluate(async () =>
      (await window.__mockDb.from("cases").select("id").eq("stage", "application").limit(1)).data[0].id);
    await p2.evaluate((id) => window.openCase(id), caseId);
    await wait(p2, 1400);
    await p2.evaluate(() => {
      window.__heapMarker = "still-here";
      document.querySelector("#new-note").value = "half-typed note the strip must preserve";
      window.__mockDb.auth.signOut();   // token expiry / sign-out in another tab
    });
    await wait(p2, 1200);
    const strip = await p2.evaluate(() => ({
      marker: window.__heapMarker,
      strip: !document.querySelector("#signedout-strip").classList.contains("hidden"),
      note: (document.querySelector("#new-note") || {}).value,
    }));
    ok("§F2 · no reload: the page (and the half-typed note under the R76 strip) survives",
      strip.marker === "still-here" && strip.strip === true && strip.note === "half-typed note the strip must preserve",
      JSON.stringify(strip));
    await p2.__ctx.close();
  }

  await browser.close();
  if (srv) try { srv.kill(); } catch (e) { /* already gone */ }
  console.log(`\nR79 locks: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
