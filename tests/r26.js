#!/usr/bin/env node
/* =============================================================================
   tests/r26.js — acceptance tests for ROUND 26: per-adviser monthly fee
   targets.

   What R26 shipped (admin/app.js only, no schema, no index.html change):
     - `renderAdviserTargetsEditor(owner)` (app.js ~4841) — an owner-only
       editor built entirely in JS and injected right after `#settings-saved`
       on every `renderSettings()` run, removed outright for a non-owner.
       `#adviser-targets-section` contains one `.adv-target-input[data-staff
       ="<id>"]` per entry in `TEAM` (the STAFF_ROLES subset of PROFILES —
       owner/admin/adviser/staff, exactly what every other TEAM-driven
       dropdown in this app already iterates) and one `#adviser-targets-save`
       button. Saving builds `{staffId:number}` from every input with a
       finite value > 0 (blank/0/NaN dropped), upserts ONE settings row
       `key="adviser_fee_targets"`, `value=JSON.stringify(map)`, reloads
       settings, and — if Reports is the open page — re-renders it.
     - `adviserTargets()` (app.js ~4319) — defensive JSON parser for that one
       settings value; a missing/corrupt/non-object/array value degrades to
       `{}`.
     - The owner Reports scoreboard (`#report-advisers` inside
       `#report-scoreboard-panel`, itself gated on `showMoney()` === owner-
       only) gained a new "Target" `<th>` right after "Fees banked (paid)".
       Body cells carry `class="adv-target-cell" data-pct="<pct or empty
       string>"`. The attainment basis is `feeEarnedBroker`: the SUM of
       `broker_fee` over that adviser's cases whose `completed_at` falls in
       the selected report month (`mv`, default this calendar month) — paid
       or not, the same earned-on-completion basis as the firm "Fees earned
       vs target" bar, deliberately NOT the cash "Fees banked" column beside
       it. `pct = Math.round(earned / target * 100)`. No target set (or the
       Unassigned / off-team rows, whose `a.id` is falsy) → cell text "—",
       `data-pct=""`. The foot row (`#report-scoreboard-foot`) gets a
       matching Target `<td>` that sums earned/target ONLY over advisers who
       have a target set on both sides; if nobody has a target it is also
       "—".

   §A — owner (p4) Settings: `#adviser-targets-section` present, one
        `.adv-target-input[data-staff]` per TEAM member (checked against
        `window.TEAM` read straight off the page, never hardcoded against
        fixture composition per the HARNESS.md standing rule), and
        `#adviser-targets-save` present.
   §B — set a target via the input + Save; the persisted
        `settings.adviser_fee_targets` row is read back through
        `window.__mockDb` and matches the expected `{staffId:number}` JSON
        exactly; a fresh Settings render prefills the input from it.
   §C — THE CORE, non-zero pct arithmetic. A case assigned to a known
        adviser (p3) is seeded with a `broker_fee` and a `completed_at`
        dated inside the SAME calendar month Reports defaults to
        (`localMonthStr()`, read off the page — not hardcoded). The
        adviser's true `feeEarnedBroker` for that month is recomputed
        independently off `window.__mockDb` (summing `broker_fee` over every
        case assigned to them with `completed_at` in that month — the exact
        predicate the round's own spec names, reimplemented here, not
        borrowed from app.js), so the assertion holds regardless of what the
        surrounding fixture already contributes that month. A target is then
        set for that adviser and the Reports scoreboard is opened: the
        adviser's `.adv-target-cell[data-pct]` must equal
        `Math.round(earned/target*100)` and the cell text must read
        `<fmtM(earned)> / <fmtM(target)> <pct>%`.
   §D — an adviser with NO target shows "—" / `data-pct=""`; the Unassigned
        row shows "—" too.
   §E — column alignment: `#report-advisers`' header `<th>` count equals
        every body `<tr>`'s `<td>` count (summing `colspan`) equals the foot
        row's `<td>` count (summing `colspan`).
   §F — non-owner (p2): `#adviser-targets-section` is absent from Settings
        and `#report-scoreboard-panel` stays `.hidden` on Reports — no
        console error either page.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r26.js
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
   independent-of-fixture technique tests/r24.js's insertKitchenSink / tests/r25.js's insertCase
   use. Returns the new case id. */
async function insertCase(page, o) {
  return page.evaluate(async (opts) => {
    const db = window.__mockDb;
    const email = `r26.${Math.random().toString(36).slice(2, 9)}@example.com`;
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

/* Read the persisted adviser_fee_targets settings row straight off window.__mockDb, defensively
   parsed the same way adviserTargets() does. */
async function readTargetsRow(page) {
  return page.evaluate(async () => {
    const { data } = await window.__mockDb.from("settings").select("*");
    const row = (data || []).find((r) => r.key === "adviser_fee_targets");
    if (!row) return { present: false, value: null, parsed: null };
    let parsed = null;
    try { parsed = JSON.parse(row.value); } catch (e) { parsed = "PARSE_ERROR"; }
    return { present: true, value: row.value, parsed };
  });
}

/* Independently recompute one adviser's feeEarnedBroker for month mv straight off
   window.__mockDb: sum of broker_fee over every case assigned_to that adviser whose
   completed_at falls inside mv (YYYY-MM). This is the round's own spec, reimplemented here,
   not borrowed from app.js. */
async function earnedForMonth(page, staffId, mv) {
  return page.evaluate(async ({ staffId, mv }) => {
    const { data } = await window.__mockDb.from("cases").select("id,assigned_to,broker_fee,completed_at");
    return (data || []).reduce((s, c) => {
      if (c.assigned_to !== staffId) return s;
      if (!c.completed_at || String(c.completed_at).slice(0, 7) !== mv) return s;
      return s + (Number(c.broker_fee) || 0);
    }, 0);
  }, { staffId, mv });
}

async function setTargetsViaEditor(page, map) {
  // Fill every known input, clearing ones not present in `map` (0/blank means "no target").
  await page.evaluate((map) => {
    document.querySelectorAll(".adv-target-input").forEach((el) => {
      const id = el.dataset.staff;
      el.value = Object.prototype.hasOwnProperty.call(map, id) ? String(map[id]) : "";
    });
  }, map);
  await page.click("#adviser-targets-save");
  await wait(page, 700);
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
       A · SETTINGS EDITOR PRESENT / WIRED (owner, p4)
       ======================================================================= */
    let page;
    {
      console.log("\n— A · #adviser-targets-section present and wired on Settings (p4)");
      page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "settings");

      const sectionExists = await page.$("#adviser-targets-section");
      ok("A1 · #adviser-targets-section exists", !!sectionExists);

      const teamIds = await page.evaluate(() => TEAM.map((p) => p.id));
      const inputIds = await page.$$eval(".adv-target-input[data-staff]", (els) => els.map((e) => e.dataset.staff));
      eq("A2 · exactly one .adv-target-input[data-staff] per TEAM member (order-independent)", inputIds.slice().sort(), teamIds.slice().sort());
      eq("A3 · no duplicate staff inputs", inputIds.length, new Set(inputIds).size);

      const saveBtn = await page.$("#adviser-targets-save");
      ok("A4 · #adviser-targets-save exists", !!saveBtn);

      ok("A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       B · SAVE PERSISTS settings.adviser_fee_targets, PREFILL ROUND-TRIPS
       ======================================================================= */
    let p2Id, p3Id;
    {
      console.log("\n— B · saving the editor persists settings.adviser_fee_targets, prefill round-trips (p4)");
      const errBefore = (page.__err || []).length;

      const staffIds = await page.evaluate(() => TEAM.map((p) => p.id));
      // p2/p3 are the two advisers this fixture always carries (see HARNESS.md persona list);
      // resolve their real TEAM ids rather than hardcoding, in case fixture ids ever change.
      const roles = await page.evaluate(() => TEAM.map((p) => ({ id: p.id, role: p.role })));
      const advisers = roles.filter((r) => r.role === "adviser").map((r) => r.id);
      ok("B0 · fixture carries at least two advisers to work with", advisers.length >= 2, JSON.stringify(roles));
      [p2Id, p3Id] = advisers;

      const targetMap = {}; targetMap[p2Id] = 8000;
      await setTargetsViaEditor(page, targetMap);

      const persisted = await readTargetsRow(page);
      ok("B1 · settings.adviser_fee_targets row now exists", persisted.present);
      eq("B2 · its value is valid JSON", typeof persisted.parsed === "object" && persisted.parsed !== null, true);
      eq("B3 · persisted map is exactly {p2:8000} (blank/0 inputs dropped)", persisted.parsed, targetMap);

      // Reload Settings from scratch and confirm the input is prefilled from the persisted value.
      await goto(page, "dashboard");
      await goto(page, "settings");
      const prefilled = await page.$eval(`.adv-target-input[data-staff="${p2Id}"]`, (e) => e.value);
      eq("B4 · reloading Settings prefills the saved adviser's input from settings.adviser_fee_targets", prefilled, "8000");
      const otherPrefill = await page.$eval(`.adv-target-input[data-staff="${p3Id}"]`, (e) => e.value);
      eq("B5 · an adviser with no target still prefills blank", otherPrefill, "");

      ok("B · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       C · THE CORE — non-zero pct arithmetic on a seeded current-month
           broker-fee completion, independently recomputed.
       ======================================================================= */
    {
      console.log("\n— C · Target column pct arithmetic, seeded current-month completion (p4)");
      const errBefore = (page.__err || []).length;

      const mv = await page.evaluate(() => localMonthStr());
      ok("C0 · resolved the current report month", /^\d{4}-\d{2}$/.test(mv), mv);

      const earnedBefore = await earnedForMonth(page, p3Id, mv);

      // Seed a case for p3, completed_at inside mv, a distinctive broker fee.
      const seededFee = 1237;
      const day = "12";
      const completedAt = `${mv}-${day}T09:00:00.000Z`;
      const caseId = await insertCase(page, {
        first: "R26Target", last: "SeededCompletion",
        fields: { stage: "completed", assigned_to: p3Id, broker_fee: seededFee, completed_at: completedAt, submitted_at: `${mv}-01T09:00:00.000Z` },
      });

      const earnedAfter = await earnedForMonth(page, p3Id, mv);
      eq("C1 · independent recompute of p3's feeEarnedBroker rose by exactly the seeded fee", earnedAfter, earnedBefore + seededFee);
      ok("C2 · earned total is non-zero (the arithmetic below is meaningfully exercised)", earnedAfter > 0, earnedAfter);

      // Set p3's target to a value that will NOT divide evenly, so a truncation-vs-rounding bug
      // in the pct formula is actually exercised.
      const target = Math.max(100, Math.round(earnedAfter / 1.37 / 100) * 100 + 37);
      const targetMap = {}; targetMap[p2Id] = 8000; targetMap[p3Id] = target;
      await setTargetsViaEditor(page, targetMap);
      const persisted = await readTargetsRow(page);
      eq("C3 · p3's target persisted correctly alongside p2's", persisted.parsed, targetMap);

      const expectedPct = Math.round((earnedAfter / target) * 100);
      const fmtVals = await page.evaluate(({ e, t }) => ({ e: fmtM(e), t: fmtM(t) }), { e: earnedAfter, t: target });

      await goto(page, "reports");
      // Report month defaults to `mv` already (loadReports() picks up localMonthStr() when the
      // picker has no value yet) — assert that rather than assume it.
      const pickerVal = await page.$eval("#report-month", (e) => e.value);
      eq("C4 · Reports' month picker defaults to the same month the completion was seeded into", pickerVal, mv);

      const cellSel = `#report-advisers .adv-target-cell[data-pct]`;
      // Locate p3's row by its adviser link (advName() renders a button carrying the staff id).
      const p3Cell = await page.evaluate((p3Id) => {
        const btn = document.querySelector(`#report-advisers button[onclick*="reportGotoAdviser('${p3Id}')"]`);
        const row = btn ? btn.closest("tr") : null;
        const cell = row ? row.querySelector(".adv-target-cell") : null;
        return cell ? { pct: cell.getAttribute("data-pct"), text: cell.textContent.replace(/\s+/g, " ").trim() } : null;
      }, p3Id);
      ok("C5 · found p3's scoreboard row and Target cell", !!p3Cell, JSON.stringify(p3Cell));
      if (p3Cell) {
        eq("C6 · data-pct equals Math.round(earned/target*100), computed independently", Number(p3Cell.pct), expectedPct);
        ok("C7 · cell text reads '<earned> / <target> <pct>%'", p3Cell.text.indexOf(`${fmtVals.e} / ${fmtVals.t}`) === 0 && p3Cell.text.indexOf(`${expectedPct}%`) > -1, JSON.stringify({ text: p3Cell.text, fmtVals, expectedPct }));
      }

      ok("C · no console errors after seeding + saving + reload", noNewErr(page, errBefore), JSON.stringify(page.__err));
      // NOTE: deliberately NOT closing/reopening `page` here — mock-supabase.js's whole DB and
      // `settings` live in that page's own in-memory JS state, reinitialized fresh on every
      // navigation to mock.html. §D/§E continue on this SAME page (via the SPA `goto()` helper,
      // which does not reload the document) so the case seeded and the targets saved above are
      // still there to assert against.
    }

    /* =======================================================================
       D · NO TARGET → "—" / data-pct=""; UNASSIGNED ROW → "—"
       (same page/session as §B/§C — see the note above)
       ======================================================================= */
    {
      console.log("\n— D · no-target adviser and the Unassigned row both show \"—\" (p4, same page)");
      const errBefore = (page.__err || []).length;
      await goto(page, "reports");

      // p2/p3 have targets (from §B/§C); pick an ADVISER row with NO target — any TEAM id not in
      // the persisted map, excluding the synthetic "unassigned" id so D1-D3 and D4-D5 test two
      // genuinely different rows. Read the persisted map back rather than assume which ids these are.
      const persisted = await readTargetsRow(page);
      const targetedIds = Object.keys(persisted.parsed || {});
      const noTargetCell = await page.evaluate((targetedIds) => {
        const rows = [...document.querySelectorAll("#report-advisers tr")].slice(1, -1); // drop header + foot
        for (const tr of rows) {
          const btn = tr.querySelector("button[onclick^=\"reportGotoAdviser\"]");
          const id = btn ? (btn.getAttribute("onclick").match(/reportGotoAdviser\('([^']+)'\)/) || [])[1] : null;
          if (id && id !== "unassigned" && !targetedIds.includes(id)) {
            const cell = tr.querySelector(".adv-target-cell");
            if (cell) return { id, pct: cell.getAttribute("data-pct"), text: cell.textContent.trim() };
          }
        }
        return null;
      }, targetedIds);
      ok("D1 · found an adviser row with no target set", !!noTargetCell, JSON.stringify(noTargetCell));
      if (noTargetCell) {
        eq("D2 · its Target cell text is \"—\"", noTargetCell.text, "—");
        eq("D3 · its data-pct is the empty string", noTargetCell.pct, "");
      }

      const unassignedCell = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#report-advisers tr")];
        const row = rows.find((tr) => /Unassigned/.test(tr.textContent));
        if (!row) return { present: false };
        const cell = row.querySelector(".adv-target-cell");
        return cell ? { present: true, pct: cell.getAttribute("data-pct"), text: cell.textContent.trim() } : { present: true, cellMissing: true };
      });
      if (unassignedCell.present && !unassignedCell.cellMissing) {
        eq("D4 · the Unassigned row's Target cell text is \"—\"", unassignedCell.text, "—");
        eq("D5 · the Unassigned row's data-pct is the empty string", unassignedCell.pct, "");
      } else {
        // The Unassigned row only renders when it has open/completed/fees/trend activity — the
        // fixture is deterministic-random but not guaranteed to seed it; note rather than fail if
        // truly absent, since that is itself a legitimate app.js filter (see mkAdvRow's `.filter`).
        ok("D4/D5 · Unassigned row not present this run (legitimate — mkAdvRow filters rows with zero activity)", true);
      }

      ok("D · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
    }

    /* =======================================================================
       E · COLUMN ALIGNMENT — header/body/foot <td>/<th> counts agree
       (same page/session as §B/§C/§D)
       ======================================================================= */
    {
      console.log("\n— E · #report-advisers header/body/foot column counts agree, accounting for colspans (p4, same page)");
      const errBefore = (page.__err || []).length;
      await goto(page, "reports");

      const counts = await page.evaluate(() => {
        const colspanSum = (tr) => [...tr.children].reduce((s, td) => s + (Number(td.getAttribute("colspan")) || 1), 0);
        const table = document.querySelector("#report-advisers table");
        if (!table) return null;
        const headerRow = table.querySelector("tr");
        const footRow = document.querySelector("#report-scoreboard-foot");
        const bodyRows = [...table.querySelectorAll("tr")].filter((tr) => tr !== headerRow && tr.id !== "report-scoreboard-foot");
        return {
          header: headerRow ? colspanSum(headerRow) : null,
          foot: footRow ? colspanSum(footRow) : null,
          body: bodyRows.map(colspanSum),
        };
      });
      ok("E0 · #report-advisers table is present with rows to check", !!counts && counts.body.length > 0, JSON.stringify(counts));
      if (counts) {
        eq("E1 · header <th> colspan-sum is 10", counts.header, 10);
        ok("E2 · every body row's <td> colspan-sum equals the header's", counts.body.every((n) => n === counts.header), JSON.stringify(counts));
        eq("E3 · foot row's <td> colspan-sum equals the header's", counts.foot, counts.header);
      }

      ok("E · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       F · NON-OWNER (p2): editor absent, scoreboard panel stays hidden
       ======================================================================= */
    {
      console.log("\n— F · non-owner (p2): #adviser-targets-section absent, #report-scoreboard-panel stays hidden");
      const pageF = await newPage(browser, "p2");
      const errBeforeSettings = (pageF.__err || []).length;
      await goto(pageF, "settings");
      const sectionAbsent = await pageF.$("#adviser-targets-section");
      ok("F1 · #adviser-targets-section is absent from Settings for a non-owner", !sectionAbsent);
      ok("F · no console errors on Settings (p2)", noNewErr(pageF, errBeforeSettings), JSON.stringify(pageF.__err));

      const errBeforeReports = (pageF.__err || []).length;
      await goto(pageF, "reports");
      const boardHidden = await pageF.$eval("#report-scoreboard-panel", (e) => e.classList.contains("hidden"));
      ok("F2 · #report-scoreboard-panel stays hidden for a non-owner", boardHidden);
      ok("F · no console errors on Reports (p2)", noNewErr(pageF, errBeforeReports), JSON.stringify(pageF.__err));

      await pageF.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r26: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
