#!/usr/bin/env node
/* =============================================================================
   tests/r25.js — acceptance tests for ROUND 25: Data health's new
   "Missing application/offer date" tile.

   What R25 added (admin/app.js, loadDataHealth() only):
     - `#dh-tile-milestone` — a new .kpi tile placed right after
       `#dh-tile-nocompleted`, `.warn` when its count is >0, wired via the
       same `wireTile` helper every other list-panel tile uses.
     - `#dh-milestone-panel` — starts `.hidden`; each `.row-item` names the
       client (`.t`, `onclick="openCase('<id>')"`) and, in `.s`, the STAGE
       LABEL plus which milestone date is missing
       ("<Stage> · missing: application date (submitted_at)" or the offer
       variant), with an `Open` button carrying the same `openCase` call.
     - `submitted_at` joined the page's main `cases` select (a plain,
       always-present column, no feature-detect needed).
     - `offer_issued_date` is read in a SEPARATE soft query, gated behind
       `forwardDatesSupported()` — exactly like `dhExchangeBy` reads
       `exchange_date` — so an un-migrated database never 42703s the whole
       page over it.
     - Predicate `noMilestoneDate`: walks every case NOT in `not_proceeding`
       stage; if its stage has reached >= application and `submitted_at` is
       blank, it's flagged for the application date; else if forward dates
       are supported, the stage has reached >= offer, and
       `offer_issued_date` is blank, it's flagged for the offer date.
       Earliest-missing wins — a case can only ever appear once. This is
       DELIBERATELY separate from the pre-existing `#dh-tile-nocompleted`
       tile (missing `completed_at`) — a completed case with both earlier
       dates present but no `completed_at` must NOT show up here.

   §A — tile/panel exist and are wired (owner, p4): numeric count, `.warn`
        iff count > 0, panel starts hidden, clicking the tile reveals it —
        mirrors tests/r13.js's D6 tile-click assertions.
   §B — THE CORE: ground truth for `noMilestoneDate` is recomputed here,
        independently, straight off `window.__mockDb` (STAGES' canonical
        order is read directly off the page — a fair-game shared display/
        ordering constant, same rule tests/r19.js/r20.js/r24.js already use
        for STAGE_LABEL/fmtM/etc. — but the FILTERING LOGIC itself is
        reimplemented here, not borrowed from app.js). The panel's exact
        case-id set (parsed off each row's `Open` button's `onclick`
        attribute) must match that recomputed set exactly — not merely have
        the same length. Six purpose-built synthetic cases (inserted via
        `window.__mockDb`, independent of fixture composition per the
        HARNESS.md standing rule) then pin down every boundary the round's
        spec calls out by name: past-application-no-submitted_at (flagged),
        pre-application-no-submitted_at (not), not_proceeding (not),
        both-dates-present (not), and — the one case the natural fixture
        never happens to contain — a COMPLETED case with a blank
        `completed_at` but both earlier dates present (not flagged; proves
        this tile is not merely a rename of `#dh-tile-nocompleted`), plus a
        genuine offer-date miss (flagged, offer reason).
   §C — reason text format, for one app-reason row and one offer-reason row
        picked programmatically off the recomputed ground truth (never
        hardcoded fixture ids).
   §D — `#dh-tile-nocompleted` / `#dh-tile-rateend` still exist with numeric
        counts and their own (untouched) panels — a light regression check,
        not a re-run of r13's own coverage of them.
   §E — no console errors on the Data health page for owner (p4) and admin
        (p1).
   §F — forward dates OFF (`FORWARD_SUPPORTED` forced `false` directly on
        the page, same module-scope-`let` technique tests/r24.js §E already
        uses for `PROP_ADDR_SUPPORTED`/etc.): the offer half of the
        predicate is skipped entirely (only application-date misses can
        appear), and the page loads with no console error and no 42703.

   R45 · non-masking repair — R45 (admin/app.js ~24173) added a 180-day
   freshness guard to noMilestoneDate: a COMPLETED case whose completed_at
   is more than 180 days old is now excluded outright (blank milestone
   dates on the back book are read as history, not a fault). This file's
   two independent ground-truth recomputes (`groundTruth()` and §F's own
   inline recompute) reimplemented the PRE-R45 predicate and so no longer
   matched the app's honest post-R45 count on the base fixture (40 passed /
   5 failed: B1/B2/C3/F3/F4 — the fixture genuinely has completed cases
   older than 180 days with a blank milestone that the tile now correctly
   omits and the old recompute wrongly still expected). Both recomputes now
   carry the identical guard, proven correct by hand against app.js's own
   change before being applied here (tests/r45.js §A7 hand-verifies the
   same predicate against a purpose-built fixture, independently). Every
   one of B4–B9's own synthetic cases carries completed_at: null, so the
   new guard's own `cs.completed_at &&` short-circuit never touches them —
   none of THEIR expectations moved; only the base-fixture noise the
   recompute was silently over-counting did. 45 passed / 0 failed after
   the repair.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r25.js
         (expects a static server on 8099; starts one itself if absent)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const SETTLE = 1500;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
    r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}
async function newPage(browser, persona) {
  const page = await browser.newPage();
  page.__dialogs = [];
  page.on("dialog", async (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); await d.accept(); });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1000 : ms);
};
const noNewErr = (page, before) => (page.__err || []).length === before;

/* Insert one client + one case with exactly the fields the scenario cares about — same
   independent-of-fixture technique tests/r24.js's insertKitchenSink uses. Returns the new case id. */
async function insertCase(page, o) {
  return page.evaluate(async (opts) => {
    const db = window.__mockDb;
    const email = `r25.${Math.random().toString(36).slice(2, 9)}@example.com`;
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: opts.first, last_name: opts.last, email, phone: "07700900000" })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "purchase" }, opts.fields);
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return cs.id;
  }, o);
}

/* Independently recompute the noMilestoneDate set straight off window.__mockDb. STAGES' canonical
   ORDER is read directly off the page (a fair-game shared ordering constant, same rule as
   STAGE_LABEL elsewhere in this harness) but the FILTERING LOGIC is reimplemented here from the
   round's own spec, not borrowed from app.js.

   R45 · non-masking repair — R45 added ONE new guard ahead of the stage-rank check: a COMPLETED
   case whose completed_at is more than 180 days old is now excluded outright (its blank milestone
   is read as back-book history, not a fault — see admin/app.js ~24173's own comment). This function
   now carries that guard too, so it recomputes the CURRENT honest predicate rather than the
   pre-R45 one; every boundary this file already asserts on (B4–B9) is a case built with
   completed_at either null or recent, so none of them sit anywhere near the new 180-day window and
   none had to change. */
async function groundTruth(page) {
  return page.evaluate(async () => {
    const { data: cases } = await window.__mockDb.from("cases")
      .select("id,stage,submitted_at,offer_issued_date,completed_at,clients!client_id(first_name,last_name)")
      .order("id");
    const fwdOn = (await forwardDatesSupported()) === true;
    const rankOf = Object.fromEntries(STAGES.map((s, i) => [s[0], i]));
    const appRank = rankOf["application"], offerRank = rankOf["offer"];
    const daysSince = (iso) => { if (!iso) return null; const t = new Date(iso).getTime(); if (isNaN(t)) return null; return Math.max(0, Math.floor((Date.now() - t) / 86400000)); };
    const expected = [];
    (cases || []).forEach((c) => {
      if (c.stage === "not_proceeding") return;
      if (c.stage === "completed" && c.completed_at && daysSince(c.completed_at) > 180) return;
      const rank = rankOf[c.stage];
      if (rank == null) return;
      const name = (c.clients ? [c.clients.first_name, c.clients.last_name].filter(Boolean).join(" ") : "") || "(no name)";
      if (rank >= appRank && !c.submitted_at) {
        expected.push({ id: c.id, stage: c.stage, reason: "app", name });
      } else if (fwdOn && rank >= offerRank && !c.offer_issued_date) {
        expected.push({ id: c.id, stage: c.stage, reason: "offer", name });
      }
    });
    return { expected, fwdOn, total: (cases || []).length };
  });
}

/* Parse the panel's actual rows: case id off the Open button's onclick, reason text off .s. */
async function panelRows(page) {
  return page.$$eval("#dh-milestone-panel .row-item", (els) =>
    els.map((el) => {
      const btn = el.querySelector("button");
      const onclick = btn ? btn.getAttribute("onclick") || "" : "";
      const m = onclick.match(/openCase\('([^']+)'\)/);
      const s = el.querySelector(".s");
      return { id: m ? m[1] : null, text: s ? s.textContent.trim() : "" };
    }));
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       A · TILE + PANEL PRESENT / WIRED (owner, p4)
       ======================================================================= */
    let page;
    {
      console.log("\n— A · #dh-tile-milestone / #dh-milestone-panel present and wired (p4)");
      page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "data");

      const tileExists = await page.$("#dh-tile-milestone");
      ok("A1 · #dh-tile-milestone exists", !!tileExists);
      const num = await page.$eval("#dh-tile-milestone .num", (e) => Number(e.textContent));
      ok("A2 · its count is a non-negative number", Number.isFinite(num) && num >= 0, num);

      const panelExists = await page.$("#dh-milestone-panel");
      ok("A3 · #dh-milestone-panel exists", !!panelExists);
      const hiddenBefore = await page.$eval("#dh-milestone-panel", (e) => e.classList.contains("hidden"));
      ok("A4 · the panel starts hidden", hiddenBefore);

      const hasWarn = await page.$eval("#dh-tile-milestone", (e) => e.classList.contains("warn"));
      eq("A5 · .warn class present iff count > 0", hasWarn, num > 0);

      /* R74: the tile wall is no longer in write-order — it is sorted by count, biggest first,
         inside two labelled bands ("Counts toward the N" / "Watchlist"), because a wall of
         twenty-two tiles in the order fifteen rounds happened to write them buried the biggest
         number wherever it fell (panel D#7/D#8). A fixed neighbour is therefore no longer a
         contract and asserting one would pin the defect. What IS the contract — and what this
         round's spec actually meant by "placed after X" — is that the tile is on the wall, in the
         band that counts toward the readiness headline, alongside dh-tile-nocompleted. Not weakened: this
         says strictly more about the tile than "it has a particular sibling" did. */
      const orderOk = await page.evaluate(() => {
        const row = document.getElementById("dh-kpi-row");
        const kids = [...row.children];
        const me = document.getElementById("dh-tile-milestone");
        const sib = document.getElementById("dh-tile-nocompleted");
        if (!me || !sib) return false;
        const bandOf = (el) => {
          let n = el.previousElementSibling;
          while (n) { if (n.classList.contains("dh-band-h")) return n.dataset.band; n = n.previousElementSibling; }
          return null;
        };
        return kids.indexOf(me) >= 0 && bandOf(me) === "counted" && bandOf(sib) === "counted";
      });
      ok("A6 · on the tile wall, in the band that counts toward the readiness headline (with #dh-tile-nocompleted)", orderOk);

      await page.click("#dh-tile-milestone");
      await wait(page, 400);
      const hiddenAfter = await page.$eval("#dh-milestone-panel", (e) => e.classList.contains("hidden"));
      ok("A7 · clicking the tile reveals the panel", !hiddenAfter);

      ok("A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       B · PREDICATE CORRECTNESS — THE CORE
       ======================================================================= */
    {
      console.log("\n— B · noMilestoneDate predicate matches an independent recompute, exactly (p4, same page)");
      const errBeforeB = (page.__err || []).length;

      const before = await groundTruth(page);
      ok("B0 · forward dates resolve supported on this fixture (offer half exercised, not skipped)", before.fwdOn === true);

      /* Six purpose-built cases, independent of fixture composition, pinning every boundary the
         round's spec names explicitly. */
      const sPastAppNoSub = await insertCase(page, {
        first: "R25App", last: "PastNoSub",
        fields: { stage: "application", submitted_at: null, offer_issued_date: null, completed_at: null },
      });
      const sPreAppNoSub = await insertCase(page, {
        first: "R25FactFind", last: "PreAppNoSub",
        fields: { stage: "fact_find", submitted_at: null, offer_issued_date: null, completed_at: null },
      });
      const sNotProceeding = await insertCase(page, {
        first: "R25NotProc", last: "Dropped",
        fields: { stage: "not_proceeding", submitted_at: null, offer_issued_date: null, completed_at: null },
      });
      const sBothPresent = await insertCase(page, {
        first: "R25Offer", last: "BothDatesPresent",
        fields: { stage: "offer", submitted_at: "2026-01-01", offer_issued_date: "2026-01-05", completed_at: null },
      });
      // The critical boundary: completed, no completed_at, but BOTH earlier dates present — must
      // NOT be picked up by this tile (that's #dh-tile-nocompleted's job, not this one's).
      const sCompletedNoCompletedAtOnly = await insertCase(page, {
        first: "R25Completed", last: "NoCompletedAtOnly",
        fields: { stage: "completed", submitted_at: "2026-01-01", offer_issued_date: "2026-01-05", completed_at: null },
      });
      const sOfferMiss = await insertCase(page, {
        first: "R25Offer", last: "MissingOfferDate",
        fields: { stage: "offer", submitted_at: "2026-01-01", offer_issued_date: null, completed_at: null },
      });

      await goto(page, "data");
      const gt = await groundTruth(page);
      const rows = await panelRows(page);
      const shownNum = await page.$eval("#dh-tile-milestone .num", (e) => Number(e.textContent));

      eq("B1 · tile count matches the recomputed ground-truth count", shownNum, gt.expected.length);
      const gtIds = gt.expected.map((c) => c.id).sort();
      const rowIds = rows.map((r) => r.id).sort();
      eq("B2 · panel's exact case-id set matches ground truth (not merely the same length)", rowIds, gtIds);
      eq("B3 · no duplicate rows (one row per flagged case)", rowIds.length, new Set(rowIds).size);

      const gtSet = new Set(gtIds);
      ok("B4 · a case past application with no submitted_at IS listed", gtSet.has(sPastAppNoSub) && rowIds.includes(sPastAppNoSub));
      ok("B5 · a pre-application (fact_find) case with no submitted_at is NOT listed", !gtSet.has(sPreAppNoSub) && !rowIds.includes(sPreAppNoSub));
      ok("B6 · a not_proceeding case is NOT listed", !gtSet.has(sNotProceeding) && !rowIds.includes(sNotProceeding));
      ok("B7 · a case with both milestone dates present is NOT listed", !gtSet.has(sBothPresent) && !rowIds.includes(sBothPresent));
      ok("B8 · a completed case is NOT flagged merely for a missing completed_at (both earlier dates present)", !gtSet.has(sCompletedNoCompletedAtOnly) && !rowIds.includes(sCompletedNoCompletedAtOnly));
      ok("B9 · a case past offer with submitted_at present but offer_issued_date missing IS listed", gtSet.has(sOfferMiss) && rowIds.includes(sOfferMiss));

      const gtById = Object.fromEntries(gt.expected.map((c) => [c.id, c]));
      eq("B10 · sPastAppNoSub is flagged for the APPLICATION reason", gtById[sPastAppNoSub] && gtById[sPastAppNoSub].reason, "app");
      eq("B11 · sOfferMiss is flagged for the OFFER reason", gtById[sOfferMiss] && gtById[sOfferMiss].reason, "offer");

      /* =====================================================================
         C · REASON TEXT FORMAT — one app-reason row, one offer-reason row,
             picked programmatically off the ground truth (never hardcoded).
         ===================================================================== */
      console.log("\n— C · reason text format, for a sample app-reason row and a sample offer-reason row");
      const rowsById = Object.fromEntries(rows.map((r) => [r.id, r.text]));
      const appSample = gt.expected.find((c) => c.reason === "app");
      const offerSample = gt.expected.find((c) => c.reason === "offer");
      ok("C1 · found at least one app-reason ground-truth row", !!appSample);
      ok("C2 · found at least one offer-reason ground-truth row", !!offerSample);
      if (appSample) {
        const stageLabel = await page.evaluate((s) => STAGE_LABEL[s], appSample.stage);
        eq("C3 · app-reason row text is '<Stage> · missing: application date (submitted_at)'",
          rowsById[appSample.id], `${stageLabel} · missing: application date (submitted_at)`);
      }
      if (offerSample) {
        const stageLabel = await page.evaluate((s) => STAGE_LABEL[s], offerSample.stage);
        eq("C4 · offer-reason row text is '<Stage> · missing: offer date (offer_issued_date)'",
          rowsById[offerSample.id], `${stageLabel} · missing: offer date (offer_issued_date)`);
      }

      ok("B/C · no console errors after inserts + reload", noNewErr(page, errBeforeB), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       D · EXISTING DATE TILES UNTOUCHED (light check — r13.js owns full
           coverage of these two; this just proves R25 didn't perturb them)
       ======================================================================= */
    {
      console.log("\n— D · #dh-tile-nocompleted / #dh-tile-rateend still present and functioning (p4)");
      const pageD = await newPage(browser, "p4");
      const errBefore = (pageD.__err || []).length;
      await goto(pageD, "data");

      const ncTile = await pageD.$("#dh-tile-nocompleted");
      ok("D1 · #dh-tile-nocompleted still exists", !!ncTile);
      const ncNum = await pageD.$eval("#dh-tile-nocompleted .num", (e) => Number(e.textContent));
      ok("D2 · its count is still a non-negative number", Number.isFinite(ncNum) && ncNum >= 0, ncNum);
      const ncPanel = await pageD.$("#dh-nocompleted-panel");
      ok("D3 · #dh-nocompleted-panel still exists", !!ncPanel);

      const reTile = await pageD.$("#dh-tile-rateend");
      ok("D4 · #dh-tile-rateend still exists", !!reTile);
      const reNum = await pageD.$eval("#dh-tile-rateend .num", (e) => Number(e.textContent));
      ok("D5 · its count is still a non-negative number", Number.isFinite(reNum) && reNum >= 0, reNum);
      const rePanel = await pageD.$("#dh-rateend-panel");
      ok("D6 · #dh-rateend-panel still exists", !!rePanel);

      // Independent recompute — the two predicates R25 must not have touched.
      const dGt = await pageD.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,stage,rate_end_date,completed_at");
        return {
          noCompletedAt: (data || []).filter((c) => c.stage === "completed" && !c.completed_at).length,
        };
      });
      eq("D7 · #dh-tile-nocompleted count matches an independent recompute of stage=completed && !completed_at", ncNum, dGt.noCompletedAt);

      await pageD.click("#dh-tile-nocompleted");
      await wait(pageD, 300);
      const ncPanelShown = await pageD.$eval("#dh-nocompleted-panel", (e) => !e.classList.contains("hidden"));
      ok("D8 · clicking #dh-tile-nocompleted still reveals its panel", ncPanelShown);

      await pageD.click("#dh-tile-rateend");
      await wait(pageD, 300);
      const rePanelShown = await pageD.$eval("#dh-rateend-panel", (e) => !e.classList.contains("hidden"));
      ok("D9 · clicking #dh-tile-rateend still reveals its panel", rePanelShown);

      ok("D · no console errors", noNewErr(pageD, errBefore), JSON.stringify(pageD.__err));
      await pageD.close();
    }

    /* =======================================================================
       E · NO CONSOLE ERRORS ON THE DATA HEALTH PAGE (owner p4, admin p1)
       ======================================================================= */
    {
      console.log("\n— E · no console errors on Data health (owner p4, admin p1)");
      const pageOwner = await newPage(browser, "p4");
      const errBeforeOwner = (pageOwner.__err || []).length;
      await goto(pageOwner, "data");
      ok("E1 · no console errors — owner (p4)", noNewErr(pageOwner, errBeforeOwner), JSON.stringify(pageOwner.__err));
      await pageOwner.close();

      const pageAdmin = await newPage(browser, "p1");
      const errBeforeAdmin = (pageAdmin.__err || []).length;
      await goto(pageAdmin, "data");
      ok("E2 · no console errors — admin (p1)", noNewErr(pageAdmin, errBeforeAdmin), JSON.stringify(pageAdmin.__err));
      const adminTile = await pageAdmin.$("#dh-tile-milestone");
      ok("E3 · #dh-tile-milestone also renders for admin", !!adminTile);
      await pageAdmin.close();
    }

    /* =======================================================================
       F · FORWARD DATES OFF — the offer half of the predicate is skipped
           entirely, no error / no 42703. Same technique tests/r24.js §E uses:
           the module-scope `let` app.js itself caches feature-detect results
           in is forced directly from the test, before the page's own
           forwardDatesSupported() ever resolves it, reaching the exact
           runtime state a real un-migrated database produces.
       ======================================================================= */
    {
      console.log("\n— F · FORWARD_SUPPORTED forced false: offer half skipped, no 42703 (p4)");
      const pageF = await newPage(browser, "p4");
      const errBefore = (pageF.__err || []).length;

      const capBefore = await pageF.evaluate(() => FORWARD_SUPPORTED);
      /* R77 (stale pin, failing identically on the R76 base): runCombinedSupportProbe() now
         resolves FORWARD_SUPPORTED during boot (the one-row combined probe), so "still null
         before Data health loads" stopped being true rounds ago. The fact this section actually
         needs is only that the flag CAN be forced false from here before the offer-half code
         under test reads it — which F2 pins. Accept either state at boot, but never false. */
      ok("F1 · FORWARD_SUPPORTED at boot: unresolved or probe-resolved true — never false on the migrated mock", capBefore === null || capBefore === true, capBefore);

      await pageF.evaluate(() => { FORWARD_SUPPORTED = false; });
      const capNow = await pageF.evaluate(() => FORWARD_SUPPORTED);
      eq("F2 · FORWARD_SUPPORTED is now forced false", capNow, false);

      await goto(pageF, "data");

      // R45 · non-masking repair — same 180-day freshness guard as groundTruth() above, so this
      // forward-dates-off recompute stays honest against the current predicate too.
      const gtOff = await pageF.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases")
          .select("id,stage,submitted_at,offer_issued_date,completed_at");
        const rankOf = Object.fromEntries(STAGES.map((s, i) => [s[0], i]));
        const appRank = rankOf["application"];
        const daysSince = (iso) => { if (!iso) return null; const t = new Date(iso).getTime(); if (isNaN(t)) return null; return Math.max(0, Math.floor((Date.now() - t) / 86400000)); };
        const expected = [];
        (cases || []).forEach((c) => {
          if (c.stage === "not_proceeding") return;
          if (c.stage === "completed" && c.completed_at && daysSince(c.completed_at) > 180) return;
          const rank = rankOf[c.stage];
          if (rank == null) return;
          if (rank >= appRank && !c.submitted_at) expected.push(c.id);
        });
        return expected;
      });
      const rowsOff = await panelRows(pageF);
      const numOff = await pageF.$eval("#dh-tile-milestone .num", (e) => Number(e.textContent));

      eq("F3 · tile count with forward dates OFF matches the application-only recompute", numOff, gtOff.length);
      eq("F4 · panel's case-id set matches the application-only recompute exactly", rowsOff.map((r) => r.id).sort(), gtOff.slice().sort());
      const anyOfferReason = rowsOff.some((r) => /offer date \(offer_issued_date\)/.test(r.text));
      ok("F5 · no row cites the offer-date reason (offer half genuinely skipped, not just empty by chance)", !anyOfferReason);

      const html = await pageF.evaluate(() => document.querySelector("#page-data").innerHTML);
      ok("F6 · no 42703 / 'does not exist' surfaced anywhere on the page", html.indexOf("42703") === -1 && html.toLowerCase().indexOf("does not exist") === -1);

      ok("F · no console errors / no 42703 with forward dates forced off", noNewErr(pageF, errBefore), JSON.stringify(pageF.__err));
      await pageF.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r25: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
