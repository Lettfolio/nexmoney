#!/usr/bin/env node
/* =============================================================================
   tests/r45.js — acceptance tests for ROUND 45: post-import Data Health
   honesty — a milestone-date freshness window, and mock-supabase's rate-end
   quality metric brought to full parity with the (just-migrated) prod
   get_data_quality RPC.

   What R45 changed (admin/app.js + admin/mock-supabase.js only, no schema):

     1. `noMilestoneDate` (app.js ~24173, the "Missing application/offer
        date" tile #dh-tile-milestone / panel #dh-milestone-panel, R25's
        own predicate) gained ONE new guard, evaluated before the existing
        stage-rank check: a COMPLETED case whose `completed_at` is MORE
        THAN 180 days old is now EXCLUDED outright — its blank
        submitted_at/offer_issued_date is read as history (nobody is going
        to backfill a years-old completion), not a fault still worth
        chasing. This is deliberately narrower than "any completed case":
          - live stages (enquiry…exchange) are UNCHANGED — the guard only
            ever fires for stage === "completed".
          - not_proceeding is unaffected — it was already excluded outright
            one line above, for an unrelated reason.
          - a completed case with completed_at ≤180 days old still shows —
            the window is FRESHNESS, not "completed at all".
          - a completed case with NO completed_at (`null`) is NOT touched
            by the new guard (`cs.completed_at &&` short-circuits before
            `daysSince` ever runs) — it keeps showing here exactly as
            before. That's #dh-tile-nocompleted's own fault to resolve
            first; once a completion date lands, THIS rule takes over.
        Boundary is `daysSince(completed_at) > 180`, i.e. exactly 180 days
        is still INCLUDED and 181 is the first EXCLUDED day.

     2. `completed_missing_rate_end` (mock-supabase.js ~4670, the RPC value
        `#dh-tile-rateend`'s `.num` renders directly) went from a bare
        "completed && !rate_end_date" count to full parity with prod:
        excludes rate_type 'tracker'/'variable' (no fixed end to chase),
        retention successors (`retention_source_case_id` set — the
        question belongs to the source case), non-mortgage records
        (`loan_amount` null AND no `mortgage_account_number` — not a
        mortgage at all), and a completed deal SUPERSEDED by a newer
        completed deal on the same property for the same client
        (normalized-address match, later `completed_at` — the back-book
        import writes exactly this shape on a remortgage-with-us). The
        base fixture's own honest value is unchanged by this round (both
        formulas land on 1 — see §B7's fixture-sanity check) but the two
        formulas diverge the moment any of the four exclusions is actually
        in play, which is what §B's synthetic cases exist to prove.

   §A — MILESTONE FRESHNESS WINDOW (#dh-tile-milestone / #dh-milestone-panel)
        A1 — completed, completed_at 200 days ago, blank submitted_at: NOT
             in the ground truth, NOT in the panel.
        A2 — completed, completed_at 30 days ago, blank submitted_at: IS
             in the ground truth, IS in the panel.
        A3 — live application-stage case, blank submitted_at: listed
             (freshness guard never fires off stage=completed).
        A4 — not_proceeding, blank everything: never listed.
        A5 — completed with completed_at NULL (no completion date at all)
             and blank submitted_at: STILL listed — the new guard only
             fires when completed_at is actually present, so the two tiles
             never trade the same case's fault back and forth.
        A6 — boundary: completed_at exactly 180 days ago → listed; exactly
             181 days ago → not listed (the first excluded day).
        A7 — full-fixture ground truth (independently reimplemented from
             the round's own spec, not borrowed from app.js) matches the
             tile's count AND the panel's exact case-id set, with all six
             synthetic cases from A1–A6 folded into one shared fixture.

   §B — RATE-END RPC PARITY (`get_data_quality().completed_missing_rate_end`,
        which #dh-tile-rateend's `.num` renders verbatim)
        B1 — tracker rate_type: excluded.
        B2 — variable rate_type: excluded.
        B3 — retention successor (retention_source_case_id set): excluded.
        B4 — non-mortgage record (loan_amount null, no
             mortgage_account_number): excluded.
        B5 — superseded pair: the OLDER of two completed deals on the same
             client + normalized property address is excluded; the NEWER
             one (itself unsuperseded) counts.
        B6 — a genuine completed mortgage, no rate_end_date, no property
             address at all (so no superseded-pair match is even possible):
             counted.
        B7 — fixture sanity: on the untouched base fixture the OLD naive
             formula (completed && !rate_end_date) and the NEW parity
             formula already agree (both 1) — R45 did not move the
             headline number on this fixture; §B1–B6 are what actually
             exercises the four new exclusions.
        B8 — full ground truth (independently reimplemented from the RPC's
             own doc comment, not borrowed from mock-supabase.js) over the
             base fixture PLUS every B1–B6 synthetic case matches the
             live RPC's `completed_missing_rate_end` exactly, and the
             tile's own `.num` matches the RPC value it is wired to.

   §C — FOLLOW-UP FIX VERIFICATION: tile / panel / readiness-rollup PARITY
        (`#dh-tile-rateend` / `#dh-rateend-panel` / #dh-readiness's own
        "Completed, no rate-end" row). §B above only ever checked the RPC
        value against a from-scratch ground truth; it never looked at the
        PANEL's rendered rows or the READINESS ROLLUP's count at all — which
        is exactly where the round's own documented inconsistency lived (the
        panel/rollup used to read a wholly separate, un-migrated predicate
        with none of the four exclusions). This section is the direct
        regression test for the follow-up fix (admin/app.js ~L23994-24029)
        that pointed `noRateEnd` — the client-side list BOTH the panel and
        the readiness rollup render off — at the same four exclusions as the
        RPC, so all three surfaces should now agree by construction.
        C1–C5 — one fixture seeded with one of each of the four exclusion
             families (tracker, retention successor, non-mortgage,
             superseded-by-newer) plus one genuine gap: tile `.num`, the
             panel's rendered row COUNT, the panel's exact row-id SET, and
             the readiness rollup's count all agree with a from-scratch
             ground truth (reusing §B's `rateEndGroundTruth`, since nothing
             in C1–C5 touches the one corner where that ground truth and the
             "correct" predicate diverge — see C8–C10).
        C6–C7 — a SAME-DAY pair (identical `completed_at`, same client +
             normalized property): the supersede rule requires STRICTLY
             newer (`>`, not `>=`), so a tie supersedes neither — both cases
             count, and both appear in the panel.
        C8–C10 — **a genuine, precise, NOT-fixed-here defect, reported per
             the round brief rather than papered over.** An UNDATED
             completed case (no `completed_at` at all) with no rate-end,
             superseded-in-address-only by a newer DATED completed case at
             the same client+property: admin/app.js's client-side predicate
             explicitly guards this (`cs.completed_at &&` before ever
             comparing dates — see its own R45 comment, "an undated
             completion is never treated as superseded"), so the PANEL and
             the READINESS ROLLUP correctly keep counting it (C8, C9 —
             passing). mock-supabase.js's `get_data_quality` RPC has NO such
             guard: its supersede check is bare
             `String(n.completed_at||"") > String(c.completed_at||"")`,
             and in JS string comparison an empty string sorts before EVERY
             non-empty one, so whenever the case under test has no
             `completed_at`, that comparison is true for ANY other
             completed case sharing its client+property — regardless of
             whether that other case is actually chronologically newer, or
             even has a real date at all. The RPC therefore WRONGLY excludes
             the undated case, so the TILE'S number (driven by the RPC)
             comes out one lower than the panel/rollup it sits directly
             above (C10 — this is the one check in this file expected to
             FAIL, and is left failing on purpose: forcing it green would
             misrepresent a real bug as passing behaviour). This is a
             narrower re-opening of the exact defect the follow-up fix was
             meant to close — tile shows N, click through, get N+1 rows —
             just now triggered by an undated completion rather than a
             wholesale missing predicate. Root cause: mock-supabase.js
             ~L4681-4686's supersede clause is missing the same
             `c.completed_at &&` short-circuit admin/app.js's own
             `noRateEnd` already has. Out of this round's fix scope (the
             round's own commit touched admin/app.js only) and out of this
             pass's file-commit scope (tests + HARNESS.md only) — flagging
             for whoever next touches `get_data_quality` to add the missing
             guard, the same one-line shape as the other repairs in this
             file's history.

   EVERY figure this file asserts is either read straight back off the mock
   db/RPC, computed by the test's own construction/seeding, or read live off
   app.js's own module state (STAGES) — never a number this file invented
   independently of the fixture/app it is testing against, the same
   standing rule tests/r25.js/r38.js/r40.js/r41.js/r42.js already follow.

   Run:  node /root/nx/tests/r45.js
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
  await wait(page, ms == null ? 1500 : ms);
};
const noNewErr = (page, before) => (page.__err || []).length === before;

/* Days-ago → an ISO date string, same technique tests/r27.js/r42.js already use for their own
   date-boundary seeding. Date-only (no time-of-day component), so daysSince()'s floor() lands on
   the intended day regardless of what time of day this suite happens to run at. */
const daysAgoISO = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* Insert one client + one case with exactly the fields the scenario cares about — same
   independent-of-fixture technique tests/r24.js's insertKitchenSink / tests/r25.js's insertCase
   use. Returns the new case id. */
async function insertCase(page, o) {
  return page.evaluate(async (opts) => {
    const db = window.__mockDb;
    const email = `r45.${Math.random().toString(36).slice(2, 9)}@example.com`;
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
/* Same as insertCase but lets a scenario name an existing client_id (needed for §B5's superseded
   pair, which must sit on the SAME client to trigger the RPC's own client_id match). */
async function insertCaseForClient(page, clientId, fields) {
  return page.evaluate(async ({ clientId, fields }) => {
    const db = window.__mockDb;
    const row = Object.assign({ client_id: clientId, case_kind: "purchase" }, fields);
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return cs.id;
  }, { clientId, fields });
}

/* §A ground truth — independently reimplemented from the round's own spec (R25's predicate PLUS
   the new R45 freshness guard), not borrowed from app.js. STAGES' canonical order is read directly
   off the page (a fair-game shared ordering constant, same rule tests/r25.js already applies to
   the identical predicate). */
async function milestoneGroundTruth(page) {
  return page.evaluate(async () => {
    const { data: cases } = await window.__mockDb.from("cases")
      .select("id,stage,submitted_at,offer_issued_date,completed_at");
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
      if (rank >= appRank && !c.submitted_at) expected.push(c.id);
      else if (fwdOn && rank >= offerRank && !c.offer_issued_date) expected.push(c.id);
    });
    return expected;
  });
}
async function milestonePanelIds(page) {
  return page.$$eval("#dh-milestone-panel .row-item button", (els) =>
    els.map((b) => { const m = (b.getAttribute("onclick") || "").match(/openCase\('([^']+)'\)/); return m ? m[1] : null; }).filter(Boolean));
}

/* §B ground truth — independently reimplemented from the RPC's own R45 doc comment (tracker/
   variable, retention successor, non-mortgage, superseded-by-newer-same-property), not copied from
   mock-supabase.js's actual filter body. */
async function rateEndGroundTruth(page) {
  return page.evaluate(async () => {
    const { data: cases } = await window.__mockDb.from("cases")
      .select("id,stage,rate_end_date,rate_type,retention_source_case_id,loan_amount,mortgage_account_number,property_address,client_id,completed_at");
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const all = cases || [];
    const out = [];
    all.forEach((c) => {
      if (c.stage !== "completed" || c.rate_end_date) return;
      const rt = String(c.rate_type || "");
      if (rt === "tracker" || rt === "variable") return;
      if (c.retention_source_case_id) return;
      if (c.loan_amount == null && !c.mortgage_account_number) return;
      const key = norm(c.property_address);
      if (key) {
        const superseded = all.some((n) => n.id !== c.id && n.client_id === c.client_id && n.stage === "completed" &&
          norm(n.property_address) === key && String(n.completed_at || "") > String(c.completed_at || ""));
        if (superseded) return;
      }
      out.push(c.id);
    });
    return out;
  });
}
const getDQ = (page) => page.evaluate(async () => (await window.__mockDb.rpc("get_data_quality")).data);

/* §C — the readiness rollup's own "Completed, no rate-end" row: find it by its exact label text
   (the rollup only ever renders rows for non-zero counts, sorted worst-first, so locating by label
   rather than position is the only reliable way in — same technique tests/r42.js's §J4 uses). */
async function rateEndRollupCount(page) {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("#dh-readiness .dh-readiness-item"));
    const row = items.find((el) => (el.querySelector(".dh-readiness-label") || {}).textContent === "Completed, no rate-end");
    return row ? Number(row.querySelector(".dh-readiness-count").textContent) : null;
  });
}
function rateEndPanelIds(page) {
  return page.$$eval("#dh-rateend-panel .row-item button", (els) =>
    els.map((b) => { const m = (b.getAttribute("onclick") || "").match(/openCase\('([^']+)'\)/); return m ? m[1] : null; }).filter(Boolean));
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
       §A · MILESTONE FRESHNESS WINDOW
       ======================================================================= */
    {
      console.log("\n— §A · noMilestoneDate's new R45 freshness guard (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "data");

      const sOldCompleted = await insertCase(page, {
        first: "R45Old", last: "CompletedNoMilestone",
        fields: { stage: "completed", submitted_at: null, offer_issued_date: null, completed_at: daysAgoISO(200) },
      });
      const sFreshCompleted = await insertCase(page, {
        first: "R45Fresh", last: "CompletedNoMilestone",
        fields: { stage: "completed", submitted_at: null, offer_issued_date: null, completed_at: daysAgoISO(30) },
      });
      const sLiveApp = await insertCase(page, {
        first: "R45Live", last: "ApplicationNoSub",
        fields: { stage: "application", submitted_at: null, offer_issued_date: null, completed_at: null },
      });
      const sNotProceeding = await insertCase(page, {
        first: "R45Dropped", last: "NotProceeding",
        fields: { stage: "not_proceeding", submitted_at: null, offer_issued_date: null, completed_at: null },
      });
      const sNoCompletedAt = await insertCase(page, {
        first: "R45NoDate", last: "CompletedNoCompletedAt",
        fields: { stage: "completed", submitted_at: null, offer_issued_date: null, completed_at: null },
      });
      const sBoundary180 = await insertCase(page, {
        first: "R45Boundary", last: "Exactly180",
        fields: { stage: "completed", submitted_at: null, offer_issued_date: null, completed_at: daysAgoISO(180) },
      });
      const sBoundary181 = await insertCase(page, {
        first: "R45Boundary", last: "Exactly181",
        fields: { stage: "completed", submitted_at: null, offer_issued_date: null, completed_at: daysAgoISO(181) },
      });

      await goto(page, "data");
      const gt = await milestoneGroundTruth(page);
      const gtSet = new Set(gt);
      const panelIds = await milestonePanelIds(page);
      const panelSet = new Set(panelIds);
      const tileNum = await page.$eval("#dh-tile-milestone .num", (e) => Number(e.textContent));

      ok("§A1 · completed 200 days ago, blank submitted_at — NOT in ground truth", !gtSet.has(sOldCompleted));
      ok("§A1 · …and NOT in the panel", !panelSet.has(sOldCompleted));

      ok("§A2 · completed 30 days ago, blank submitted_at — IS in ground truth", gtSet.has(sFreshCompleted));
      ok("§A2 · …and IS in the panel", panelSet.has(sFreshCompleted));

      ok("§A3 · live application-stage, blank submitted_at — listed (freshness guard is completed-only)", gtSet.has(sLiveApp) && panelSet.has(sLiveApp));

      ok("§A4 · not_proceeding, blank everything — never listed", !gtSet.has(sNotProceeding) && !panelSet.has(sNotProceeding));

      ok("§A5 · completed with completed_at NULL (no completion date at all) — still listed (guard doesn't fire without a date)", gtSet.has(sNoCompletedAt) && panelSet.has(sNoCompletedAt));

      ok("§A6 · exactly 180 days ago — still listed (boundary is > 180, not >=)", gtSet.has(sBoundary180) && panelSet.has(sBoundary180));
      ok("§A6 · exactly 181 days ago — the first excluded day", !gtSet.has(sBoundary181) && !panelSet.has(sBoundary181));

      eq("§A7 · tile count matches the full-fixture ground truth", tileNum, gt.length);
      eq("§A7 · panel's exact case-id set matches ground truth (not merely the same length)", panelIds.slice().sort(), gt.slice().sort());
      eq("§A7 · no duplicate rows in the panel", panelIds.length, new Set(panelIds).size);

      ok("§A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §B · RATE-END RPC PARITY
       ======================================================================= */
    {
      console.log("\n— §B · completed_missing_rate_end's four new R45 exclusions (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "data");

      // §B7 fixture sanity, BEFORE any synthetic seeding — the round's own claim that the base
      // fixture's honest number didn't move: old naive formula and new parity formula must already
      // agree here.
      const baseGT = await rateEndGroundTruth(page);
      const baseNaive = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,stage,rate_end_date");
        return (data || []).filter((c) => c.stage === "completed" && !c.rate_end_date).length;
      });
      const baseDQ = await getDQ(page);
      eq("§B7 · fixture sanity — base fixture: new parity ground truth", baseGT.length, baseNaive);
      eq("§B7 · …matches the OLD naive formula (completed && !rate_end_date)", baseGT.length, baseNaive);
      eq("§B7 · …and matches the live RPC's completed_missing_rate_end", baseDQ.completed_missing_rate_end, baseGT.length);

      const sTracker = await insertCase(page, {
        first: "R45Tracker", last: "NoFixedEnd",
        fields: { stage: "completed", rate_type: "tracker", rate_end_date: null, loan_amount: 180000, completed_at: daysAgoISO(10) },
      });
      const sVariable = await insertCase(page, {
        first: "R45Variable", last: "NoFixedEnd",
        fields: { stage: "completed", rate_type: "variable", rate_end_date: null, loan_amount: 180000, completed_at: daysAgoISO(10) },
      });

      // §B3 — retention successor: needs a genuine source case to point at, so its own stage's
      // rate_end_date is irrelevant to what we're proving (the source needn't even be completed).
      const sSource = await insertCase(page, {
        first: "R45Source", last: "RetentionOrigin",
        fields: { stage: "completed", rate_type: "fixed", rate_end_date: "2024-01-01", loan_amount: 150000, completed_at: daysAgoISO(400) },
      });
      const sSuccessor = await insertCase(page, {
        first: "R45Successor", last: "InheritsTheQuestion",
        fields: { stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 150000, retention_source_case_id: sSource, completed_at: daysAgoISO(10) },
      });

      const sNonMortgage = await insertCase(page, {
        first: "R45NonMortgage", last: "NoLoanNoAccount",
        fields: { stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: null, mortgage_account_number: null, completed_at: daysAgoISO(10) },
      });

      // §B5 — superseded pair: two completed deals, SAME client, SAME (normalized) property, the
      // older one further back in time. insertCaseForClient pins both to one client_id — the RPC's
      // superseded match is client_id-scoped, not just address-scoped.
      const sSupersededOlder = await insertCase(page, {
        first: "R45Superseded", last: "OlderDeal",
        fields: { stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 160000, property_address: "12 Example Street, Bournemouth BH1 1AA", completed_at: daysAgoISO(900) },
      });
      const supersededClientId = await page.evaluate(async (caseId) => {
        const { data } = await window.__mockDb.from("cases").select("client_id").eq("id", caseId).single();
        return data.client_id;
      }, sSupersededOlder);
      const sSupersededNewer = await insertCaseForClient(page, supersededClientId, {
        stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 175000,
        property_address: "12 EXAMPLE street, Bournemouth BH1 1AA", completed_at: daysAgoISO(10),
      });

      const sGenuine = await insertCase(page, {
        first: "R45Genuine", last: "CountedMortgage",
        fields: { stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 210000, property_address: null, completed_at: daysAgoISO(10) },
      });

      await goto(page, "data");
      const gt = await rateEndGroundTruth(page);
      const gtSet = new Set(gt);
      const dq = await getDQ(page);
      const tileNum = await page.$eval("#dh-tile-rateend .num", (e) => Number(e.textContent));

      ok("§B1 · tracker rate_type — excluded", !gtSet.has(sTracker));
      ok("§B2 · variable rate_type — excluded", !gtSet.has(sVariable));
      ok("§B3 · retention successor (retention_source_case_id set) — excluded", !gtSet.has(sSuccessor));
      ok("§B3 · …its source case is unaffected by the exclusion (it has its own rate_end_date anyway)", !gtSet.has(sSource));
      ok("§B4 · non-mortgage record (no loan_amount, no mortgage_account_number) — excluded", !gtSet.has(sNonMortgage));
      ok("§B5 · superseded pair — the OLDER deal is excluded", !gtSet.has(sSupersededOlder));
      ok("§B5 · …the NEWER deal (itself unsuperseded) counts", gtSet.has(sSupersededNewer));
      ok("§B6 · genuine completed mortgage, no rate_end, no property address — counted", gtSet.has(sGenuine));

      eq("§B8 · full ground truth matches the live RPC's completed_missing_rate_end exactly", dq.completed_missing_rate_end, gt.length);
      eq("§B8 · …and the tile's own .num matches the RPC value it renders", tileNum, dq.completed_missing_rate_end);

      ok("§B · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §C · TILE / PANEL / READINESS-ROLLUP PARITY — the follow-up fix
       ======================================================================= */
    {
      console.log("\n— §C · noRateEnd (panel + readiness rollup) now mirrors the RPC predicate (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "data");

      // C1–C5 fixture: one of each of the four exclusion families, plus one genuine gap.
      await insertCase(page, {
        first: "R45C", last: "Tracker",
        fields: { stage: "completed", rate_type: "tracker", rate_end_date: null, loan_amount: 180000, completed_at: daysAgoISO(10) },
      });
      const cSource = await insertCase(page, {
        first: "R45C", last: "RetentionOrigin",
        fields: { stage: "completed", rate_type: "fixed", rate_end_date: "2024-06-01", loan_amount: 150000, completed_at: daysAgoISO(400) },
      });
      await insertCase(page, {
        first: "R45C", last: "RetentionSuccessor",
        fields: { stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 150000, retention_source_case_id: cSource, completed_at: daysAgoISO(10) },
      });
      await insertCase(page, {
        first: "R45C", last: "NonMortgage",
        fields: { stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: null, mortgage_account_number: null, completed_at: daysAgoISO(10) },
      });
      const cOlder = await insertCase(page, {
        first: "R45C", last: "SupersededOlder",
        fields: { stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 160000, property_address: "77 Parity Road, Bournemouth BH1 2AA", completed_at: daysAgoISO(900) },
      });
      const cOlderClient = await page.evaluate(async (id) => (await window.__mockDb.from("cases").select("client_id").eq("id", id).single()).data.client_id, cOlder);
      const cNewer = await insertCaseForClient(page, cOlderClient, {
        stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 178000,
        property_address: "77 PARITY road, Bournemouth BH1 2AA", completed_at: daysAgoISO(10),
      });
      const cGenuine = await insertCase(page, {
        first: "R45C", last: "GenuineGap",
        fields: { stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 220000, property_address: null, completed_at: daysAgoISO(5) },
      });

      await goto(page, "data");
      let gt = await rateEndGroundTruth(page);
      let gtSet = new Set(gt);
      let tileNum = await page.$eval("#dh-tile-rateend .num", (e) => Number(e.textContent));
      let panelIds = await rateEndPanelIds(page);
      let rollup = await rateEndRollupCount(page);

      eq("§C1 · tile .num matches the from-scratch full-fixture ground truth", tileNum, gt.length);
      eq("§C2 · panel's rendered row COUNT matches the same ground truth", panelIds.length, gt.length);
      eq("§C3 · panel's exact row-id SET matches the ground truth (not merely the same length)", panelIds.slice().sort(), gt.slice().sort());
      eq("§C4 · readiness rollup's count matches the same ground truth", rollup, gt.length);
      eq("§C5 · tile, panel and rollup all agree with each other directly", [tileNum, panelIds.length, rollup], [gt.length, gt.length, gt.length]);
      ok("§C · sanity — the older superseded deal is excluded, the newer and the genuine gap both count",
        !gtSet.has(cOlder) && gtSet.has(cNewer) && gtSet.has(cGenuine));

      // C6–C7 — same-day pair: strictly-newer only, so a tie supersedes neither.
      const sameDayClient = await page.evaluate(async () => {
        const email = `r45.${Math.random().toString(36).slice(2, 9)}@example.com`;
        const { data: cl } = await window.__mockDb.from("clients").insert({ first_name: "R45C", last_name: "SameDay", email, phone: "07700900000" }).select("id").single();
        return cl.id;
      });
      const sdA = await insertCaseForClient(page, sameDayClient, {
        stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 165000,
        property_address: "3 Tie Break Close, Poole BH15 2AA", completed_at: "2025-05-01",
      });
      const sdB = await insertCaseForClient(page, sameDayClient, {
        stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 168000,
        property_address: "3 TIE BREAK close, Poole BH15 2AA", completed_at: "2025-05-01",
      });

      await goto(page, "data");
      gt = await rateEndGroundTruth(page);
      gtSet = new Set(gt);
      tileNum = await page.$eval("#dh-tile-rateend .num", (e) => Number(e.textContent));
      panelIds = await rateEndPanelIds(page);
      rollup = await rateEndRollupCount(page);

      ok("§C6 · same-day pair — BOTH deals count (a tie supersedes neither)", gtSet.has(sdA) && gtSet.has(sdB));
      ok("§C7 · …and both appear in the panel", panelIds.includes(sdA) && panelIds.includes(sdB));
      eq("§C7 · …with tile/panel/rollup still all agreeing after the same-day pair", [tileNum, panelIds.length, rollup], [gt.length, gt.length, gt.length]);

      // C8–C10 — undated completion superseded-in-address-only by a newer DATED deal: a REAL,
      // PRECISE, NOT-fixed-here defect in mock-supabase.js's RPC (see the header note above). C8/C9
      // are expected to PASS (the panel/rollup are correct); C10 is expected to FAIL (the RPC is
      // not) and is left failing on purpose rather than adjusted to hide it.
      const undatedClient = await page.evaluate(async () => {
        const email = `r45.${Math.random().toString(36).slice(2, 9)}@example.com`;
        const { data: cl } = await window.__mockDb.from("clients").insert({ first_name: "R45C", last_name: "Undated", email, phone: "07700900000" }).select("id").single();
        return cl.id;
      });
      const uOlderUndated = await insertCaseForClient(page, undatedClient, {
        stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 172000,
        property_address: "8 Backbook Terrace, Christchurch BH23 3AA", completed_at: null,
      });
      await insertCaseForClient(page, undatedClient, {
        stage: "completed", rate_type: "fixed", rate_end_date: null, loan_amount: 179000,
        property_address: "8 BACKBOOK terrace, Christchurch BH23 3AA", completed_at: "2025-02-01",
      });

      await goto(page, "data");
      tileNum = await page.$eval("#dh-tile-rateend .num", (e) => Number(e.textContent));
      panelIds = await rateEndPanelIds(page);
      rollup = await rateEndRollupCount(page);

      ok("§C8 · undated completion is never treated as superseded — panel keeps counting it", panelIds.includes(uOlderUndated));
      eq("§C9 · …and the readiness rollup agrees with the panel", rollup, panelIds.length);
      eq("§C10 · KNOWN DEFECT (mock-supabase.js get_data_quality, not fixed this pass) — tile should equal panel/rollup here too; the RPC's supersede check has no completed_at guard so it wrongly drops the undated case, undercounting by 1", tileNum, panelIds.length);

      ok("§C · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r45: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
