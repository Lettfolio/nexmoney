#!/usr/bin/env node
/* =============================================================================
   tests/r27.js — acceptance tests for ROUND 27: Data health's new "dead-book"
   hygiene tile.

   What R27 added (admin/app.js, loadDataHealth() only — no schema, no
   index.html change):
     - `#dh-tile-deadbook` — a new .kpi tile placed right after
       `#dh-tile-milestone`, `.warn` when its count is >0, wired via the same
       `wireTile` helper every other list-panel tile uses.
     - `#dh-deadbook-panel` — starts `.hidden`; each `.row-item` names the
       client (`.t`, `onclick="openCase('<id>')"`) and, in `.s`, the STAGE
       LABEL plus the overdue reason ("<Stage> · expected completion N days
       ago" or "<Stage> · rate ended N days ago"), with an `Open` button
       carrying the same `openCase` call.
     - `expected_completion_date` and `rate_end_date` both already ride the
       page's main cases select (`caseRows`, app.js ~20477) — plain columns,
       no feature-detect needed, unlike R25's `offer_issued_date`.
     - Predicate `deadBook`: every case whose stage is NOT `completed` and
       NOT `not_proceeding` (and has a recognised stage rank), where EITHER
       `expected_completion_date` is strictly in the past (preferred reason:
       "expected completion N days ago") OR — only when that date is absent
       or not overdue — `rate_end_date` is strictly in the past ("rate ended
       N days ago"). Sorted most-overdue (largest N) first.

   §A — tile/panel exist and are wired (owner, p4): numeric count, `.warn`
        iff count > 0, placed immediately after `#dh-tile-milestone`, panel
        starts hidden, clicking the tile reveals it.
   §B — THE CORE: ground truth for `deadBook` is recomputed here,
        independently, straight off `window.__mockDb` (STAGES' canonical
        list is read directly off the page — a fair-game shared ordering
        constant, same rule tests/r19.js/r20.js/r25.js already use for
        STAGE_LABEL/etc. — but the FILTERING/day-math LOGIC itself is
        reimplemented here, not borrowed from app.js). The panel's exact
        case-id set (parsed off each row's `Open` button's `onclick`
        attribute) must match that recomputed set exactly — not merely have
        the same length. Seven purpose-built synthetic cases (inserted via
        `window.__mockDb`, independent of fixture composition per the
        HARNESS.md standing rule) pin down every boundary the round's spec
        calls out by name: a live case ~90 days past its expected completion
        date (flagged, "expected completion" reason, day count recomputed
        exactly and sanity-checked within a couple of days of 90); a live
        case with only a past rate-end date (flagged, "rate ended" reason);
        a live case whose expected-completion date is BOTH past AND paired
        with a past rate-end date (flagged with the PREFERRED
        "expected completion" reason, proving the preference order); a live
        case with a FUTURE expected-completion date and no rate-end date
        (not flagged); a COMPLETED case with a past rate-end date (not
        flagged — that date is legitimately in the past for a closed case);
        a not_proceeding case with a past expected-completion date (not
        flagged); and two more live overdue cases at deliberately different
        overdue amounts, used by §C to pin the sort order.
   §C — sort order: the more-overdue of the two §B sort cases renders ABOVE
        the less-overdue one in `#dh-deadbook-panel`.
   §D — `#dh-tile-milestone` / `#dh-tile-nocompleted` still exist with
        numeric counts and their own (untouched) panels still open on click
        — a light regression check, not a re-run of r13's/r25's own coverage
        of them.
   §E — no console errors on the Data health page for owner (p4) and admin
        (p1).

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r27.js
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
   independent-of-fixture technique tests/r25.js's insertCase uses. Returns the new case id. */
async function insertCase(page, o) {
  return page.evaluate(async (opts) => {
    const db = window.__mockDb;
    const email = `r27.${Math.random().toString(36).slice(2, 9)}@example.com`;
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

/* Date helpers — computed ON THE PAGE (Date.now() there, not in the node process) so the seeded
   ISO date strings and the ground-truth day-math below share exactly the same clock app.js's own
   `daysSince` reads from. */
const dateDaysAgo = (page, n) => page.evaluate((n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10), n);
const dateDaysAhead = (page, n) => page.evaluate((n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10), n);

/* Independently recompute the deadBook set straight off window.__mockDb. STAGES' canonical list is
   read directly off the page (a fair-game shared ordering constant, same rule as STAGE_LABEL
   elsewhere in this harness) but the FILTERING and day-math LOGIC is reimplemented here from the
   round's own spec, not borrowed from app.js's `deadBook`/`daysSince`. */
async function groundTruth(page) {
  return page.evaluate(async () => {
    const { data: cases } = await window.__mockDb.from("cases")
      .select("id,stage,expected_completion_date,rate_end_date,clients!client_id(first_name,last_name)")
      .order("id");
    const stageKeys = new Set(STAGES.map((s) => s[0]));
    const daysSince = (iso) => {
      if (!iso) return null;
      const t = new Date(iso).getTime();
      if (isNaN(t)) return null;
      return Math.floor((Date.now() - t) / 86400000);
    };
    const expected = [];
    (cases || []).forEach((c) => {
      if (c.stage === "completed" || c.stage === "not_proceeding") return;
      if (!stageKeys.has(c.stage)) return;
      const name = (c.clients ? [c.clients.first_name, c.clients.last_name].filter(Boolean).join(" ") : "") || "(no name)";
      let overdueDays = null, reason = null;
      const ecdDays = daysSince(c.expected_completion_date);
      const redDays = daysSince(c.rate_end_date);
      if (c.expected_completion_date && ecdDays > 0) {
        overdueDays = ecdDays;
        reason = "expected completion " + overdueDays + " days ago";
      } else if (c.rate_end_date && redDays > 0) {
        overdueDays = redDays;
        reason = "rate ended " + overdueDays + " days ago";
      }
      if (reason == null) return;
      expected.push({ id: c.id, stage: c.stage, reason, overdueDays, name });
    });
    expected.sort((a, b) => b.overdueDays - a.overdueDays);
    return { expected };
  });
}

/* Parse the panel's actual rows, IN DOM ORDER: case id off the Open button's onclick, reason text
   off .s. */
async function panelRows(page) {
  return page.$$eval("#dh-deadbook-panel .row-item", (els) =>
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
      console.log("\n— A · #dh-tile-deadbook / #dh-deadbook-panel present and wired (p4)");
      page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "data");

      const tileExists = await page.$("#dh-tile-deadbook");
      ok("A1 · #dh-tile-deadbook exists", !!tileExists);
      const num = await page.$eval("#dh-tile-deadbook .num", (e) => Number(e.textContent));
      ok("A2 · its count is a sane non-negative number off the base fixture", Number.isFinite(num) && num >= 0, num);

      const panelExists = await page.$("#dh-deadbook-panel");
      ok("A3 · #dh-deadbook-panel exists", !!panelExists);
      const hiddenBefore = await page.$eval("#dh-deadbook-panel", (e) => e.classList.contains("hidden"));
      ok("A4 · the panel starts hidden", hiddenBefore);

      const hasWarn = await page.$eval("#dh-tile-deadbook", (e) => e.classList.contains("warn"));
      eq("A5 · .warn class present iff count > 0", hasWarn, num > 0);

      /* R74: the tile wall is no longer in write-order — it is sorted by count, biggest first,
         inside two labelled bands ("Counts toward the N" / "Watchlist"), because a wall of
         twenty-two tiles in the order fifteen rounds happened to write them buried the biggest
         number wherever it fell (panel D#7/D#8). A fixed neighbour is therefore no longer a
         contract and asserting one would pin the defect. What IS the contract — and what this
         round's spec actually meant by "placed after X" — is that the tile is on the wall, in the
         band that counts toward the readiness headline, alongside dh-tile-milestone. Not weakened: this
         says strictly more about the tile than "it has a particular sibling" did. */
      const orderOk = await page.evaluate(() => {
        const row = document.getElementById("dh-kpi-row");
        const kids = [...row.children];
        const me = document.getElementById("dh-tile-deadbook");
        const sib = document.getElementById("dh-tile-milestone");
        if (!me || !sib) return false;
        const bandOf = (el) => {
          let n = el.previousElementSibling;
          while (n) { if (n.classList.contains("dh-band-h")) return n.dataset.band; n = n.previousElementSibling; }
          return null;
        };
        return kids.indexOf(me) >= 0 && bandOf(me) === "counted" && bandOf(sib) === "counted";
      });
      ok("A6 · on the tile wall, in the band that counts toward the readiness headline (with #dh-tile-milestone)", orderOk);

      /* R42 · F5 — on the base fixture #dh-tile-deadbook's count is 0, so R42's clean-tile fold
         (admin/app.js dhFault()) now hides it behind #dh-clean-toggle (display:none via
         .kpi.dh-clean, revealed by .dh-show-clean on #dh-kpi-row). A hidden tile is not
         Playwright-clickable — reveal it via the toggle first (proving the toggle itself works,
         which this suite would otherwise never touch), THEN click the tile exactly as before. */
      const cleanToggle = await page.$("#dh-clean-toggle");
      ok("A6b · #dh-clean-toggle exists (the deadbook tile is clean on the base fixture)", !!cleanToggle);
      if (cleanToggle) {
        const ariaBefore = await page.$eval("#dh-clean-toggle", (e) => e.getAttribute("aria-expanded"));
        eq("A6c · toggle starts collapsed (aria-expanded=false)", ariaBefore, "false");
        const tileVisibleBefore = await page.$eval("#dh-tile-deadbook", (e) => e.offsetParent !== null);
        ok("A6d · #dh-tile-deadbook starts hidden (dh-clean, folded away)", !tileVisibleBefore);
        await page.click("#dh-clean-toggle");
        await wait(page, 200);
        const ariaAfter = await page.$eval("#dh-clean-toggle", (e) => e.getAttribute("aria-expanded"));
        eq("A6e · clicking the toggle expands it (aria-expanded=true)", ariaAfter, "true");
        const tileVisibleAfter = await page.$eval("#dh-tile-deadbook", (e) => e.offsetParent !== null);
        ok("A6f · #dh-tile-deadbook is now visible", tileVisibleAfter);
      }

      await page.click("#dh-tile-deadbook");
      await wait(page, 400);
      const hiddenAfter = await page.$eval("#dh-deadbook-panel", (e) => e.classList.contains("hidden"));
      ok("A7 · clicking the tile reveals the panel", !hiddenAfter);

      ok("A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       B · PREDICATE CORRECTNESS — THE CORE
       ======================================================================= */
    let sMoreOverdue, sLessOverdue;
    {
      console.log("\n— B · deadBook predicate matches an independent recompute, exactly (p4, same page)");
      const errBeforeB = (page.__err || []).length;

      const [d90, d40, d200, d10, dFuture30, d100] = await Promise.all([
        dateDaysAgo(page, 90), dateDaysAgo(page, 40), dateDaysAgo(page, 200),
        dateDaysAgo(page, 10), dateDaysAhead(page, 30), dateDaysAgo(page, 100),
      ]);

      // Live, ~90 days past expected completion, no rate-end date — the headline case.
      const sExpectedPast = await insertCase(page, {
        first: "R27App", last: "ExpectedPast90",
        fields: { stage: "application", expected_completion_date: d90, rate_end_date: null },
      });
      // Live, no expected-completion date at all, rate-end date in the past — falls through to the
      // rate-end reason.
      const sRateEndPast = await insertCase(page, {
        first: "R27Offer", last: "RateEndPastOnly",
        fields: { stage: "offer", expected_completion_date: null, rate_end_date: d40 },
      });
      // Live, BOTH dates in the past — must be flagged with the PREFERRED expected-completion
      // reason, not the rate-end one.
      const sBothPastPrefersExpected = await insertCase(page, {
        first: "R27Exchange", last: "BothPastPrefersExpected",
        fields: { stage: "exchange", expected_completion_date: d90, rate_end_date: d40 },
      });
      // Live, expected-completion date in the FUTURE, no rate-end date — not overdue at all.
      const sFuture = await insertCase(page, {
        first: "R27Exchange", last: "FutureNotOverdue",
        fields: { stage: "exchange", expected_completion_date: dFuture30, rate_end_date: null },
      });
      // COMPLETED, past rate-end date — legitimately in the past for a closed case; must NOT be
      // flagged (that's the whole point of excluding completed/not_proceeding).
      const sCompletedPastRateEnd = await insertCase(page, {
        first: "R27Completed", last: "PastRateEndOnly",
        fields: { stage: "completed", expected_completion_date: null, rate_end_date: d100, completed_at: d100 },
      });
      // not_proceeding, past expected-completion date — dropped cases owe no forward date.
      const sNotProceedingPast = await insertCase(page, {
        first: "R27Dropped", last: "PastDateNotProceeding",
        fields: { stage: "not_proceeding", expected_completion_date: d90, rate_end_date: null },
      });
      // Two more overdue live cases, at deliberately different overdue amounts — used by §C to pin
      // the sort order (most-overdue first).
      sMoreOverdue = await insertCase(page, {
        first: "R27Sort", last: "MoreOverdue200",
        fields: { stage: "application", expected_completion_date: d200, rate_end_date: null },
      });
      sLessOverdue = await insertCase(page, {
        first: "R27Sort", last: "LessOverdue10",
        fields: { stage: "application", expected_completion_date: d10, rate_end_date: null },
      });

      await goto(page, "data");
      const gt = await groundTruth(page);
      const rows = await panelRows(page);
      const shownNum = await page.$eval("#dh-tile-deadbook .num", (e) => Number(e.textContent));

      eq("B1 · tile count matches the recomputed ground-truth count", shownNum, gt.expected.length);
      const gtIds = gt.expected.map((c) => c.id).sort();
      const rowIds = rows.map((r) => r.id).sort();
      eq("B2 · panel's exact case-id set matches ground truth (not merely the same length)", rowIds, gtIds);
      eq("B3 · no duplicate rows (one row per flagged case)", rowIds.length, new Set(rowIds).size);

      const gtSet = new Set(gtIds);
      const rowSet = new Set(rowIds);
      ok("B4 · ~90-days-overdue expected-completion case IS listed", gtSet.has(sExpectedPast) && rowSet.has(sExpectedPast));
      ok("B5 · rate-end-only overdue case IS listed", gtSet.has(sRateEndPast) && rowSet.has(sRateEndPast));
      ok("B6 · both-dates-past case IS listed", gtSet.has(sBothPastPrefersExpected) && rowSet.has(sBothPastPrefersExpected));
      ok("B7 · a FUTURE expected-completion date, no rate-end date, is NOT listed", !gtSet.has(sFuture) && !rowSet.has(sFuture));
      ok("B8 · a COMPLETED case with a past rate-end date is NOT listed", !gtSet.has(sCompletedPastRateEnd) && !rowSet.has(sCompletedPastRateEnd));
      ok("B9 · a not_proceeding case with a past date is NOT listed", !gtSet.has(sNotProceedingPast) && !rowSet.has(sNotProceedingPast));
      ok("B10 · both sort-order seed cases ARE listed", gtSet.has(sMoreOverdue) && gtSet.has(sLessOverdue) && rowSet.has(sMoreOverdue) && rowSet.has(sLessOverdue));

      const gtById = Object.fromEntries(gt.expected.map((c) => [c.id, c]));
      const rowTextById = Object.fromEntries(rows.map((r) => [r.id, r.text]));

      // Reason text + day-count math, for the headline ~90-day case.
      const expReason = rowTextById[sExpectedPast] || "";
      ok("C1 · expected-completion row's .s mentions 'expected completion'", /expected completion/.test(expReason));
      const expDaysMatch = expReason.match(/expected completion (\d+) days ago/);
      ok("C2 · reason text carries a numeric day count", !!expDaysMatch);
      const expDaysShown = expDaysMatch ? Number(expDaysMatch[1]) : NaN;
      eq("C3 · shown day count matches the independent recompute exactly", expDaysShown, gtById[sExpectedPast] && gtById[sExpectedPast].overdueDays);
      ok("C4 · shown day count is within tolerance of the ~90 days seeded", Math.abs(expDaysShown - 90) <= 2, expDaysShown);

      // Reason text for the rate-end-only case.
      const rateReason = rowTextById[sRateEndPast] || "";
      ok("C5 · rate-end-only row's .s mentions 'rate ended'", /rate ended/.test(rateReason));
      ok("C6 · rate-end-only row's .s does NOT mention 'expected completion' (no such date on this case)", !/expected completion/.test(rateReason));
      const rateDaysMatch = rateReason.match(/rate ended (\d+) days ago/);
      const rateDaysShown = rateDaysMatch ? Number(rateDaysMatch[1]) : NaN;
      eq("C7 · rate-end day count matches the independent recompute exactly", rateDaysShown, gtById[sRateEndPast] && gtById[sRateEndPast].overdueDays);

      // Preference order — both dates in the past, expected-completion wins.
      const bothReason = rowTextById[sBothPastPrefersExpected] || "";
      ok("C8 · both-dates-past row prefers the 'expected completion' reason", /expected completion/.test(bothReason));
      ok("C9 · both-dates-past row does NOT show the 'rate ended' reason", !/rate ended/.test(bothReason));

      // Stage label prefix, sampled off one row.
      const stageLabel = await page.evaluate((s) => STAGE_LABEL[s], gtById[sExpectedPast].stage);
      eq("C10 · row text is exactly '<Stage> · <reason>'", expReason, `${stageLabel} · ${gtById[sExpectedPast].reason}`);

      ok("B/C · no console errors after inserts + reload", noNewErr(page, errBeforeB), JSON.stringify(page.__err));
    }

    /* =======================================================================
       C · SORT ORDER — most-overdue first
       ======================================================================= */
    {
      console.log("\n— C · sort order: more-overdue case renders ABOVE the less-overdue one");
      const rows = await panelRows(page);
      const idxMore = rows.findIndex((r) => r.id === sMoreOverdue);
      const idxLess = rows.findIndex((r) => r.id === sLessOverdue);
      ok("C11 · both sort-order rows found in the panel", idxMore !== -1 && idxLess !== -1, { idxMore, idxLess });
      ok("C12 · the ~200-days-overdue case renders ABOVE the ~10-days-overdue case", idxMore !== -1 && idxLess !== -1 && idxMore < idxLess, { idxMore, idxLess });
    }
    await page.close();

    /* =======================================================================
       D · EXISTING DH TILES UNAFFECTED (light check — r13.js/r25.js own full
           coverage of these; this just proves R27 didn't perturb them)
       ======================================================================= */
    {
      console.log("\n— D · #dh-tile-milestone / #dh-tile-nocompleted still present and functioning (p4)");
      const pageD = await newPage(browser, "p4");
      const errBefore = (pageD.__err || []).length;
      await goto(pageD, "data");

      const msTile = await pageD.$("#dh-tile-milestone");
      ok("D1 · #dh-tile-milestone still exists", !!msTile);
      const msNum = await pageD.$eval("#dh-tile-milestone .num", (e) => Number(e.textContent));
      ok("D2 · its count is still a non-negative number", Number.isFinite(msNum) && msNum >= 0, msNum);
      const msPanel = await pageD.$("#dh-milestone-panel");
      ok("D3 · #dh-milestone-panel still exists", !!msPanel);

      const ncTile = await pageD.$("#dh-tile-nocompleted");
      ok("D4 · #dh-tile-nocompleted still exists", !!ncTile);
      const ncNum = await pageD.$eval("#dh-tile-nocompleted .num", (e) => Number(e.textContent));
      ok("D5 · its count is still a non-negative number", Number.isFinite(ncNum) && ncNum >= 0, ncNum);
      const ncPanel = await pageD.$("#dh-nocompleted-panel");
      ok("D6 · #dh-nocompleted-panel still exists", !!ncPanel);

      await pageD.click("#dh-tile-milestone");
      await wait(pageD, 300);
      const msPanelShown = await pageD.$eval("#dh-milestone-panel", (e) => !e.classList.contains("hidden"));
      ok("D7 · clicking #dh-tile-milestone still reveals its panel", msPanelShown);

      await pageD.click("#dh-tile-nocompleted");
      await wait(pageD, 300);
      const ncPanelShown = await pageD.$eval("#dh-nocompleted-panel", (e) => !e.classList.contains("hidden"));
      ok("D8 · clicking #dh-tile-nocompleted still reveals its panel", ncPanelShown);

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
      const adminTile = await pageAdmin.$("#dh-tile-deadbook");
      ok("E3 · #dh-tile-deadbook also renders for admin", !!adminTile);
      await pageAdmin.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r27: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
