#!/usr/bin/env node
/* =============================================================================
   tests/r5_batch6.js — acceptance tests for PLAN-R5 Batch 6
   ("Reports: comparisons, honest labels, lost panel, drill-down")

   One block per plan item:
     1. S8 / R5-19  every month KPI carries a month-on-month and a year-on-year delta chip;
                    a prior period we hold NO rows for reads "no data", never "−100%"; the
                    adviser table gains a previous-month column pair; the completions chart
                    draws the prior calendar year as a second, muted series.
     2. R5-17       every money figure states its basis, and NOTHING it labels changed value.
     3. B3 / R5-20  losses grouped by lost_reason with a "(not recorded)" bucket for legacy
                    rows, Σ loan / Σ fees lost / by-adviser, month-scoped with an all-time
                    toggle, Owner-only.
     4. B7          cash figures key off each fee type's OWN paid date, so a split-paid case
                    lands each £ in its true month, and a future-dated payment is excluded
                    from this month's collected figure with a footnote.
     5. S7 / R5-47  the Avg review score tile expands into the list of respondents, worst
                    first, detractors tinted, each name opening its case.
     6. R5-2        the attribution basis is stated on both adviser surfaces.
     7. (guard)     M2 turned OFF: Reports still renders — legacy single fee_paid_at, an
                    all-"(not recorded)" losses panel, no console errors.

   Run:  node /root/nx/tests/r5_batch6.js   (expects a static server on 8099;
                                             starts one itself if absent)
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

async function openReports(page) {
  await page.click('[data-page="reports"]');
  await page.waitForTimeout(1200);
}
// Re-run the whole Reports load against a different month, exactly as the picker does.
async function setMonth(page, mv) {
  await page.evaluate((m) => {
    document.querySelector("#report-month").value = m;
    document.querySelector("#report-month").dispatchEvent(new Event("change", { bubbles: true }));
  }, mv);
  await page.waitForTimeout(1200);
}
const txt = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).innerText || "", sel);

// The fixture "now" as the app sees it, plus everything the expectations are computed from.
async function fixture(page) {
  return page.evaluate(async () => {
    const { data } = await window.__mockDb.from("cases").select("*");
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const mv = now.getFullYear() + "-" + pad(now.getMonth() + 1);
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return {
      cases: data,
      todayIso: now.toISOString().slice(0, 10),
      thisMv: mv,
      prevMv: prev.getFullYear() + "-" + pad(prev.getMonth() + 1),
      yr: now.getFullYear(),
    };
  });
}
const money = (n) => Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
/* The app's own month labelling (monthShortLabel in app.js): "Jun" for a month-on-month chip,
   "Jul 25" with the two-digit year for a year-on-year one. Derived rather than typed out, so the
   expectations follow the calendar the fixtures are seeded against instead of the calendar the
   test was written on. */
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortMonth = (mv) => MONTH_SHORT[Number(String(mv).slice(5, 7)) - 1];
const shortMonthYear = (mv) => shortMonth(mv) + " " + String(mv).slice(2, 4);
/* mv shifted by n months, as "YYYY-MM" */
const shiftMv = (mv, n) => {
  const d = new Date(Number(String(mv).slice(0, 4)), Number(String(mv).slice(5, 7)) - 1 + n, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
};

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore", detached: true });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       1 · S8 / R5-19 — MoM + YoY deltas
       =================================================================== */
    console.log("\n— S8 / R5-19 · month-on-month and year-on-year deltas (p4 Daniel, owner)");
    {
      const page = await newPage(browser, "p4");
      await openReports(page);
      const fx = await fixture(page);
      const inM = (d, m) => !!d && String(d).slice(0, 7) === m;
      const subNow = fx.cases.filter((c) => inM(c.submitted_at, fx.thisMv)).length;
      const subPrev = fx.cases.filter((c) => inM(c.submitted_at, fx.prevMv)).length;
      const expectedPct = Math.round(((subNow - subPrev) / subPrev) * 100);

      const kpis = await txt(page, "#month-kpis");
      /* The property under test is "the chip states the real month-on-month change", so both the
         percentage AND the month it names are derived from the fixture rows at run time.
         This used to read `[subNow, subPrev]` against the literal [4, 8] and the chip against the
         literal "▼ −50% vs Jun" — the numbers the NOW-relative fixtures happened to produce on the
         day the plan's worked example was written. They drift with the calendar and with every
         fixture added (round 6's multi-property cases move them again), and neither literal was
         ever what the test was actually about. */
      ok("fixture · there is a real month-on-month comparison to make",
        subPrev > 0 && subNow > 0, JSON.stringify({ subNow, subPrev, thisMv: fx.thisMv, prevMv: fx.prevMv }));
      const wantChip = `${expectedPct > 0 ? "▲ +" : expectedPct < 0 ? "▼ −" : "= "}${Math.abs(expectedPct)}% vs ${shortMonth(fx.prevMv)}`;
      ok("S8 · the applications tile carries the month-on-month chip",
        kpis.includes(wantChip), JSON.stringify({ wantChip, got: kpis.slice(0, 160) }));
      const chipCount = await page.evaluate(() =>
        [...document.querySelectorAll("#month-kpis .kpi")].map((k) => k.querySelectorAll(".kpi-delta .delta").length));
      ok("S8 · every KPI tile carries exactly two chips (MoM · YoY)", chipCount.length === 4 && chipCount.every((n) => n === 2), JSON.stringify(chipCount));

      /* "No data" vs "a fall to zero" — the property this block is really about.
         R8 — the three months these chips are read in used to be hardcoded to (this month − 12)
         and (− 24), which held only while the prior-year twin of the current month was empty.
         Round 8's annual-review fixtures complete a case on TODAY's date one year and two years
         back — deliberately, because that is what the anniversary touch fires on — so that month
         is not empty any more and never can be again, whatever the calendar says. The months are
         therefore DERIVED from the fixture rows now, exactly like every other expectation in this
         file: one month whose year-earlier twin holds nothing (its YoY chip must say "no data"),
         one empty month whose year-earlier twin holds something (its YoY chip must compute a real
         fall), and one month with nothing on either side (every chip "no data"). */
      const rowMonths = new Set();
      fx.cases.forEach((c) => ["submitted_at", "completed_at", "created_at"]
        .forEach((k) => { if (c[k]) rowMonths.add(String(c[k]).slice(0, 7)); }));
      const hasRows = (mv) => rowMonths.has(mv);
      const months = [];
      for (let back = 0; back <= 30; back++) months.push(shiftMv(fx.thisMv, -back));
      const chipsNow = (p) => p.evaluate(() =>
        [...document.querySelectorAll("#month-kpis .kpi")].map((k) => [...k.querySelectorAll(".kpi-delta .delta")]
          .map((d) => ({ cls: d.className, text: d.textContent.trim() }))));

      const completionsIn = (mv) => fx.cases.filter((c) => inM(c.completed_at, mv)).length;
      const noDataYoyMv = months.find((mv) => hasRows(mv) && !hasRows(shiftMv(mv, -12)));
      const deadPairMv = months.find((mv) => !hasRows(mv) && !hasRows(shiftMv(mv, -1)));
      /* "A real fall" needs a month whose year-earlier twin holds rows (so no chip may read
         "no data") and a metric that was something then and is nothing now (so a chip must read
         −100%). Completions are that metric: an empty month qualifies, and so does a busy month
         with nothing completed in it yet, which is what the first days of a month look like. */
      const fallMv = months.find((mv) => hasRows(shiftMv(mv, -12)) && completionsIn(mv) === 0 && completionsIn(shiftMv(mv, -12)) > 0);
      ok("fixture · the book holds a month with rows whose year-earlier twin has none, an empty month whose twin has rows, and a month empty on both sides",
        !!noDataYoyMv && !!deadPairMv && !!fallMv, JSON.stringify({ noDataYoyMv, deadPairMv, fallMv }));

      // A month that HAS rows, a year after one that has none: the chip must say so rather than
      // computing a fall of 100% from a period we simply have no history for.
      await setMonth(page, noDataYoyMv);
      const noDataChips = (await chipsNow(page)).map((k) => k[1]);
      ok(`S8 · ${noDataYoyMv} · every year-on-year chip reads 'no data' (${shiftMv(noDataYoyMv, -12)} holds no rows)`,
        noDataChips.length === 4 && noDataChips.every((c) => /delta none/.test(c.cls) && c.text === `no data vs ${shortMonthYear(shiftMv(noDataYoyMv, -12))}`),
        JSON.stringify(noDataChips));

      // An empty month whose previous month is empty too: "no data", NOT a −100% collapse from a
      // zero we never had.
      await setMonth(page, deadPairMv);
      const momChips = (await chipsNow(page)).map((k) => k[0]);
      const emptyPrevMv = shiftMv(deadPairMv, -1);
      ok(`S8 · ${deadPairMv} · every month-on-month chip reads 'no data' (${emptyPrevMv} holds no rows)`,
        momChips.length === 4 && momChips.every((c) => /delta none/.test(c.cls) && c.text === `no data vs ${shortMonth(emptyPrevMv)}`),
        JSON.stringify(momChips));
      ok("S8 · … and not one of them reads −100%", !momChips.some((c) => c.text.includes("−100%")), JSON.stringify(momChips));
      // The distinction has to work in BOTH directions: an empty month whose year-earlier twin
      // DOES hold rows is a real fall, not a "no data".
      await setMonth(page, fallMv);
      const yoyChips = (await chipsNow(page)).map((k) => k[1]);
      const fallFromMv = shiftMv(fallMv, -12);
      ok(`S8 · … while ${fallMv}, whose year-earlier twin ${fallFromMv} holds rows, computes a real fall`,
        yoyChips.some((c) => c.text.includes(`−100% vs ${shortMonthYear(fallFromMv)}`)) && yoyChips.every((c) => !/delta none/.test(c.cls)),
        JSON.stringify(yoyChips));
      // A month with no history on either side: every chip must be "no data".
      await setMonth(page, (fx.yr - 3) + "-05");
      const dead = await page.evaluate(() => ({
        chips: document.querySelectorAll("#month-kpis .kpi-delta .delta").length,
        none: document.querySelectorAll("#month-kpis .kpi-delta .delta.none").length,
        text: (document.querySelector("#month-kpis") || {}).innerText || "",
      }));
      eq("S8 · a month with no history on either side — every chip is a 'no data' chip", dead.none, dead.chips);
      ok("S8 · … and none of them invents a percentage", !/%/.test(dead.text), JSON.stringify(dead.text));
      await setMonth(page, fx.thisMv);

      // Adviser table: a previous-month column pair, values matching the same arithmetic.
      const advTable = await txt(page, "#month-advisers");
      /* HARNESS RULE (never hardcode a date-relative value) — the abbreviation was
         written as a literal "JUN", which was only true in the month the assertion
         was authored. The header names the PREVIOUS month, so derive it from
         fx.prevMv like every other month string in this file. */
      const prevAbbr = shortMonth(fx.prevMv).toUpperCase();
      ok("S8 · the adviser table gains a previous-month column pair",
        advTable.includes(`COMPLETED (${prevAbbr})`) && advTable.includes(`COMPLETED £ (${prevAbbr})`), JSON.stringify({ prevAbbr, head: advTable.slice(0, 200) }));
      const prevRow = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#month-advisers table tr")].slice(1);
        return rows.map((r) => [...r.children].map((td) => td.textContent.trim()));
      });
      const wantPrev = {};
      fx.cases.filter((c) => inM(c.completed_at, fx.prevMv)).forEach((c) => {
        const k = c.assigned_to || "-";
        wantPrev[k] = wantPrev[k] || { n: 0, tot: 0 };
        wantPrev[k].n++;
        wantPrev[k].tot += Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0);
      });
      // Luke Richards (p3) is the row the fixture guarantees has both months.
      const lukeRow = prevRow.find((r) => /Luke Richards/.test(r[0]));
      ok("S8 · Luke's previous-month pair matches the raw data",
        !!lukeRow && lukeRow[7] === String((wantPrev.p3 || { n: 0 }).n) && lukeRow[8] === money((wantPrev.p3 || { tot: 0 }).tot),
        JSON.stringify({ lukeRow, want: wantPrev.p3 }));

      // Completions chart: a second, muted series for the prior calendar year.
      const chart = await page.evaluate((yr) => {
        const rows = [...document.querySelectorAll("#report-months .mchart-row")];
        return {
          title: (document.querySelector("#report-months-title") || {}).textContent || "",
          rows: rows.length,
          prevBars: rows.map((r, i) => ({ m: i, w: (r.querySelector(".mchart-fill.prev") || {}).style?.width || "0%" }))
            .filter((x) => x.w !== "0%").map((x) => x.m),
          curBars: rows.map((r, i) => ({ m: i, w: (r.querySelector(".mchart-fill:not(.prev)") || {}).style?.width || "0%" }))
            .filter((x) => x.w !== "0%").map((x) => x.m),
        };
      }, fx.yr);
      const wantPrevMonths = [...new Set(fx.cases.filter((c) => c.completed_at && Number(String(c.completed_at).slice(0, 4)) === fx.yr - 1)
        .map((c) => new Date(c.completed_at).getMonth()))].sort((a, b) => a - b);
      eq("S8 · the chart title names both years", chart.title, `Completions by month — ${fx.yr} vs ${fx.yr - 1}`);
      ok("fixture · the prior calendar year has completions to draw", wantPrevMonths.length >= 3, JSON.stringify(wantPrevMonths));
      eq("S8 · the prior-year series draws in exactly the months it has completions", chart.prevBars, wantPrevMonths);
      ok("S8 · the current-year series is untouched beside it", chart.curBars.length >= 5, JSON.stringify(chart.curBars));
      eq("S8 · no console errors", page.__err || [], []);
      await page.close();
    }

    /* ===================================================================
       2 · R5-17 — every money figure states its basis (no calculation changes)
       =================================================================== */
    console.log("\n— R5-17 · honest labels on every money figure (p4)");
    {
      const page = await newPage(browser, "p4");
      await openReports(page);
      const fx = await fixture(page);
      const pageText = await txt(page, "#page-reports");
      const strings = [
        "cash · proc+broker+sols · by paid date",     // monthly fee target bar
        "(broker only · cash · this month)",          // adviser scoreboard "Fees banked (paid)"
        "(broker only · cash · YTD)",                 // Fees banked <year> tile
        "(earned · all fee types)",                   // Submitted £ / Completed £ tiles
        "(weighted · proc+broker, excl. sols)",       // commission forecast
        "(all-time · earned · completed cases)",      // introducer Revenue column
      ];
      strings.forEach((s) => ok(`R5-17 · label present: "${s}"`, pageText.includes(s)));
      ok("R5-17 · '(earned · all fee types)' labels BOTH earned tiles",
        (pageText.match(/\(earned · all fee types\)/g) || []).length === 2,
        String((pageText.match(/\(earned · all fee types\)/g) || []).length));
      const legend = await txt(page, "#report-basis-legend");
      ok("R5-17 · one legend links the three bases",
        /earned/i.test(legend) && /outstanding/i.test(legend) && /cash \(banked\)/i.test(legend), JSON.stringify(legend));

      // The Protection page's Est. £ carries R5-57's label half.
      await page.click('[data-page="protection"]');
      await page.waitForTimeout(1000);
      const prot = await txt(page, "#prot-summary");
      ok("R5-17 · Protection Est. commission states it is not loan-based",
        prot.includes("(probability-weighted average, not loan-based)"), JSON.stringify(prot));
      await openReports(page);

      // …and the labelled figures still equal the same arithmetic they always did.
      const inM = (d, m) => !!d && String(d).slice(0, 7) === m;
      const sum = (rows) => rows.reduce((s, c) => s + Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0), 0);
      const wantSub = sum(fx.cases.filter((c) => inM(c.submitted_at, fx.thisMv)));
      const wantDone = sum(fx.cases.filter((c) => inM(c.completed_at, fx.thisMv)));
      const kpiNums = await page.evaluate(() => [...document.querySelectorAll("#month-kpis .kpi .num")].map((n) => n.textContent.trim()));
      eq("R5-17 · Submitted £ unchanged by the labelling", kpiNums[1], money(wantSub));
      eq("R5-17 · Completed £ unchanged by the labelling", kpiNums[3], money(wantDone));
      eq("R5-17 · no console errors", page.__err || [], []);
      await page.close();
    }

    /* ===================================================================
       3 · B3 / R5-20 — losses by reason
       =================================================================== */
    console.log("\n— B3 / R5-20 · losses by reason panel (p4 owner, then p2 adviser)");
    {
      const page = await newPage(browser, "p4");
      await openReports(page);
      const fx = await fixture(page);
      const lost = fx.cases.filter((c) => c.stage === "not_proceeding");
      const unrecorded = lost.filter((c) => !c.lost_reason);
      ok("fixture · lost cases include both recorded reasons and legacy blanks",
        lost.length >= 4 && unrecorded.length >= 1 && lost.length > unrecorded.length,
        JSON.stringify({ lost: lost.length, unrecorded: unrecorded.length }));

      ok("B3 · the losses panel is on the page for the owner",
        await page.evaluate(() => !document.querySelector("#report-losses-panel").classList.contains("hidden")));
      const monthScope = await txt(page, "#report-losses-scope");
      ok("B3 · month scope explains how a loss is dated",
        /stage change/i.test(monthScope) && /last touched/i.test(monthScope), JSON.stringify(monthScope));

      // All time: one row per reason, plus the "(not recorded)" bucket for the legacy rows.
      await page.click("#report-losses-scope-btn");
      await page.waitForTimeout(400);
      const table = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#report-losses table tr")].slice(1);
        return rows.map((r) => [...r.children].map((td) => td.textContent.trim()));
      });
      const body = table.filter((r) => r[0] !== "Total");
      const wantBuckets = {};
      lost.forEach((c) => {
        const k = c.lost_reason || "(not recorded)";
        wantBuckets[k] = wantBuckets[k] || { n: 0, loan: 0, fees: 0 };
        wantBuckets[k].n++;
        wantBuckets[k].loan += Number(c.loan_amount || 0);
        wantBuckets[k].fees += Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0);
      });
      eq("B3 · all-time view groups into one row per distinct reason", body.length, Object.keys(wantBuckets).length);
      const notRecorded = body.find((r) => r[0] === "(not recorded)");
      ok("B3 · legacy rows land in the '(not recorded)' bucket, they are not dropped",
        !!notRecorded && notRecorded[1] === String(wantBuckets["(not recorded)"].n),
        JSON.stringify({ notRecorded, want: wantBuckets["(not recorded)"] }));
      eq("B3 · '(not recorded)' Σ loan matches the raw data", notRecorded[2], money(wantBuckets["(not recorded)"].loan));
      eq("B3 · '(not recorded)' Σ fees lost matches the raw data", notRecorded[3], money(wantBuckets["(not recorded)"].fees));
      const wentDirect = body.find((r) => /Went direct/.test(r[0]));
      ok("B3 · a recorded reason is labelled in words, not as its enum value",
        !!wentDirect && wentDirect[1] === String(wantBuckets.went_direct.n), JSON.stringify(wentDirect));
      ok("B3 · every row carries a by-adviser breakdown", body.every((r) => r[4] && /\d/.test(r[4])), JSON.stringify(body.map((r) => r[4])));
      const totalRow = table.find((r) => r[0] === "Total");
      eq("B3 · the total reconciles with every lost case", totalRow[1], String(lost.length));

      // …and back to the month scope, which must be a strict subset.
      await page.click("#report-losses-scope-btn");
      await page.waitForTimeout(400);
      const monthTotal = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#report-losses table tr")];
        const t = rows.find((r) => /Total/.test(r.children[0].textContent));
        return t ? Number(t.children[1].textContent.trim()) : null;
      });
      ok("B3 · the month scope is a subset of all time", monthTotal !== null && monthTotal > 0 && monthTotal < lost.length,
        JSON.stringify({ monthTotal, allTime: lost.length }));
      eq("B3 · no console errors", page.__err || [], []);
      await page.close();

      const adviser = await newPage(browser, "p2");
      await openReports(adviser);
      const advView = await adviser.evaluate(() => ({
        losses: document.querySelector("#report-losses-panel").classList.contains("hidden"),
        legend: document.querySelector("#report-basis-legend").classList.contains("hidden"),
        /* R5-F1 — the adviser's own "My numbers" card, which is what makes the money-basis
           legend relevant to them (see below). */
        myNumbers: !document.querySelector("#report-mine-panel").classList.contains("hidden"),
        myNumbersFigures: document.querySelector("#report-mine").innerText,
        kpis: document.querySelector("#month-kpis").innerText,
        target: document.querySelector("#month-fee-target").innerText,
        deltas: document.querySelectorAll("#month-kpis .kpi-delta .delta").length,
        nps: !!document.querySelector("#report-nps-tile"),
      }));
      ok("B3 · an adviser does not see the losses panel (Σ fees lost is firm money)", advView.losses);
      /* This assertion used to be "… nor the money-basis legend, which describes figures they
         can't see". That was true when Batch 6 was written and an adviser had no money figures on
         the page at all. It is not true of the DEPLOYED app: R5-F1 gave advisers a "My numbers"
         card that quotes all three bases (earned / outstanding / cash banked) for their OWN cases,
         and app.js:7305 shows the legend for exactly that reason
             basisLegend.classList.toggle("hidden", !money && !showMyNumbers())
         The property being protected is unchanged — the legend must never describe money that
         isn't on the page — so it is now asserted in that form: the adviser has their own money
         card, therefore the legend belongs. */
      ok("B3 · … and the adviser DOES get their own money card (R5-F1)",
        advView.myNumbers && /£/.test(advView.myNumbersFigures), JSON.stringify(advView.myNumbersFigures || "").slice(0, 200));
      ok("B3 · … so the money-basis legend is shown to them — it describes figures they CAN see",
        advView.legend === false, JSON.stringify({ legendHidden: advView.legend, myNumbers: advView.myNumbers }));
      ok("B3 · … and none of Batch 6's new surfaces leak a £ figure to them",
        !/£/.test(advView.kpis) && advView.target === "", JSON.stringify(advView));
      eq("B3 · the operational delta chips still reach the adviser", advView.deltas, 4);
      ok("B3 · … as does the review-score drill-down (not a money figure)", advView.nps);
      eq("B3 · no console errors for the adviser", adviser.__err || [], []);
      await adviser.close();
    }

    /* ===================================================================
       4 · B7 — cash figures use per-fee-type paid dates
       =================================================================== */
    console.log("\n— B7 · per-fee-type cash dates and the future-date clamp (p4)");
    {
      const page = await newPage(browser, "p4");
      await openReports(page);
      const fx = await fixture(page);
      const split = fx.cases.filter((c) => c.broker_fee_paid_at && c.proc_fee_paid_at
        && String(c.broker_fee_paid_at).slice(0, 7) !== String(c.proc_fee_paid_at).slice(0, 7))[0];
      ok("fixture · one case is split-paid across two months", !!split,
        split && JSON.stringify({ id: split.id, broker: split.broker_fee_paid_at, proc: split.proc_fee_paid_at }));
      const future = fx.cases.filter((c) => c.broker_fee_paid_at && String(c.broker_fee_paid_at).slice(0, 10) > fx.todayIso);
      ok("fixture · one case carries a future-dated payment", future.length === 1, JSON.stringify(future.map((c) => c.id)));

      // What the target bar SHOULD show, per fee type on its own date, future payments excluded.
      const cashIn = (mv, clamp) => {
        let total = 0, futureN = 0;
        fx.cases.forEach((c) => {
          [["proc_fee", "proc_fee_paid_at"], ["broker_fee", "broker_fee_paid_at"], ["sols_fee", "sols_fee_paid_at"]].forEach(([amtC, dtC]) => {
            const amt = Number(c[amtC] || 0);
            if (!amt) return;
            const d = c[dtC] || c.fee_paid_at;
            if (!d || String(d).slice(0, 7) !== mv) return;
            if (clamp && String(d).slice(0, 10) > fx.todayIso) { futureN++; return; }
            total += amt;
          });
        });
        return { total, futureN };
      };
      // The pre-B7 figure: every fee on the case bucketed by the single legacy date.
      const legacyIn = (mv) => fx.cases.filter((c) => c.fee_paid_at && String(c.fee_paid_at).slice(0, 7) === mv)
        .reduce((s, c) => s + Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0), 0);

      const barText = async () => (await txt(page, "#month-fee-target"));
      /* The bar carries TWO figures: the earned headline (by completion date) and the cash
         line ("Also — total fees collected …"). Only the second one is B7's subject, so the
         cash expectations read that line rather than the whole bar — otherwise a month where
         the earned total happens to coincide with a cash figure reads as a false result. */
      const cashLineOf = (bar) => (bar.split("\n").find((l) => /collected/i.test(l)) || bar);
      const thisBar = await barText();
      const wantThis = cashIn(fx.thisMv, true);
      ok("B7 · this month's collected figure counts each fee on its own paid date",
        cashLineOf(thisBar).includes(money(wantThis.total)), JSON.stringify({ thisBar, want: money(wantThis.total) }));
      ok("B7 · … and it is NOT the old single-date figure",
        wantThis.total !== legacyIn(fx.thisMv) && !cashLineOf(thisBar).includes(money(legacyIn(fx.thisMv))),
        JSON.stringify({ perType: wantThis.total, legacy: legacyIn(fx.thisMv) }));

      /* The future-dated payment is seeded a few days out from "now", so on a month end it
         lands in the FOLLOWING month. Derive the month that actually holds it from the fixture
         instead of assuming it is the current one, then assert the clamp and footnote there. */
      const futureMv = (() => {
        const months = [];
        fx.cases.forEach((c) => {
          [["proc_fee", "proc_fee_paid_at"], ["broker_fee", "broker_fee_paid_at"], ["sols_fee", "sols_fee_paid_at"]].forEach(([amtC, dtC]) => {
            if (!Number(c[amtC] || 0)) return;
            const d = c[dtC] || c.fee_paid_at;
            if (d && String(d).slice(0, 10) > fx.todayIso) months.push(String(d).slice(0, 7));
          });
        });
        return months.sort()[0] || fx.thisMv;
      })();
      let futureBar = thisBar;
      if (futureMv !== fx.thisMv) { await setMonth(page, futureMv); futureBar = await barText(); }
      const wantFuture = cashIn(futureMv, true);
      ok("B7 · the future-dated payment is excluded and footnoted",
        futureBar.includes(`excludes future-dated payments (${wantFuture.futureN})`) && wantFuture.futureN > 0,
        JSON.stringify({ futureMv, futureBar, futureN: wantFuture.futureN }));
      if (futureMv !== fx.thisMv) await setMonth(page, fx.thisMv);
      ok("B7 · the split case's proc fee is counted in THIS month",
        String(split.proc_fee_paid_at).slice(0, 7) === fx.thisMv);

      await setMonth(page, fx.prevMv);
      const prevBar = await barText();
      const wantPrev = cashIn(fx.prevMv, true);
      ok("B7 · … and its broker fee is counted in the month before",
        String(split.broker_fee_paid_at).slice(0, 7) === fx.prevMv && prevBar.includes(money(wantPrev.total)),
        JSON.stringify({ prevBar, want: money(wantPrev.total) }));
      ok("B7 · the previous month's bar carries no future-date footnote",
        !prevBar.includes("excludes future-dated payments"), JSON.stringify(prevBar));
      await setMonth(page, fx.thisMv);

      // Scoreboard: broker cash, per-type date, future payments excluded.
      const board = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#report-advisers table tr")].slice(1);
        return rows.map((r) => [...r.children].map((td) => td.textContent.trim()));
      });
      const brokerCash = {};
      fx.cases.forEach((c) => {
        const amt = Number(c.broker_fee || 0);
        if (!amt) return;
        const d = c.broker_fee_paid_at || c.fee_paid_at;
        if (!d || String(d).slice(0, 7) !== fx.thisMv || String(d).slice(0, 10) > fx.todayIso) return;
        brokerCash[c.assigned_to || "-"] = (brokerCash[c.assigned_to || "-"] || 0) + amt;
      });
      const danRow = board.find((r) => /Daniel Potts/.test(r[0]));
      eq("B7 · the scoreboard's Fees banked column is broker cash on the broker date",
        danRow && danRow[3], money(brokerCash.p4 || 0));

      // Fees banked YTD: the tile is firm-wide, get_reports is per staff adviser (so it drops
      // cases held by someone with no access). What must agree is the BASIS — M5's
      // coalesce(broker_fee_paid_at, fee_paid_at) — adviser for adviser.
      const brokerYtdFor = (id) => fx.cases.reduce((s, c) => {
        const d = c.broker_fee_paid_at || c.fee_paid_at;
        return c.assigned_to === id && d && Number(String(d).slice(0, 4)) === fx.yr ? s + Number(c.broker_fee || 0) : s;
      }, 0);
      const rpcAdvisers = await page.evaluate(async () => {
        const { data } = await window.__mockDb.rpc("get_reports");
        return data.advisers || [];
      });
      const mismatched = rpcAdvisers.filter((a) => Math.round(brokerYtdFor(a.staff_id)) !== Math.round(Number(a.fees_banked_ytd || 0)));
      eq("B7 · every adviser's YTD matches M5's coalesce, adviser for adviser", mismatched.map((a) => a.name), []);
      const kpiYtd = await page.evaluate(() => {
        const tile = [...document.querySelectorAll("#report-kpis .kpi")].find((k) => /Fees banked/i.test(k.textContent));
        return tile ? tile.querySelector(".num").textContent.trim() : null;
      });
      const firmYtd = fx.cases.reduce((s, c) => {
        const d = c.broker_fee_paid_at || c.fee_paid_at;
        return d && Number(String(d).slice(0, 4)) === fx.yr ? s + Number(c.broker_fee || 0) : s;
      }, 0);
      eq("B7 · the Fees banked YTD tile is firm-wide broker cash on the same basis", kpiYtd, money(firmYtd));
      const offStaff = firmYtd - rpcAdvisers.reduce((s, a) => s + Number(a.fees_banked_ytd || 0), 0);
      ok("B7 · … and the gap to get_reports is exactly the fees held by non-staff/unassigned cases",
        Math.round(offStaff) === Math.round(fx.cases.reduce((s, c) => {
          const d = c.broker_fee_paid_at || c.fee_paid_at;
          const staff = rpcAdvisers.some((a) => a.staff_id === c.assigned_to);
          return !staff && d && Number(String(d).slice(0, 4)) === fx.yr ? s + Number(c.broker_fee || 0) : s;
        }, 0)), String(offStaff));
      eq("B7 · no console errors", page.__err || [], []);
      await page.close();
    }

    /* ===================================================================
       5 · S7 / R5-47 — review score drill-down
       =================================================================== */
    console.log("\n— S7 / R5-47 · review score drill-down (p4)");
    {
      const page = await newPage(browser, "p4");
      await openReports(page);
      const fx = await fixture(page);
      const scored = fx.cases.filter((c) => c.nps_score != null).sort((a, b) => a.nps_score - b.nps_score);
      /* R9 — was "six". The round-9 advocacy fixtures took the scored book from 6 to 12 and gave
         it a real spread (4 → 10, detractors, passives and promoters), because a review dashboard
         drawn from six scores that are all 6, 8 or 9 can say nothing about a firm. The count is
         still asserted exactly, so a fixture drifting silently still fails here; what it has to be
         has moved. */
      ok("fixture · twelve cases carry a review score, spanning detractors, passives and promoters",
        scored.length === 12
        && scored.some((c) => c.nps_score <= 6)
        && scored.some((c) => c.nps_score === 7 || c.nps_score === 8)
        && scored.some((c) => c.nps_score >= 9),
        JSON.stringify(scored.map((c) => c.nps_score)));

      ok("S7 · the list is collapsed until the tile is clicked",
        await page.evaluate(() => document.querySelector("#report-nps-panel").classList.contains("hidden")));
      await page.click("#report-nps-tile");
      await page.waitForTimeout(400);
      const list = await page.evaluate(() => ({
        hidden: document.querySelector("#report-nps-panel").classList.contains("hidden"),
        rows: [...document.querySelectorAll("#report-nps-list .nps-row")].map((r) => ({
          score: r.querySelector(".nps-score").textContent.trim(),
          name: r.querySelector(".linkish").textContent.trim(),
          detractor: r.classList.contains("detractor"),
          meta: r.querySelector(".nps-meta").textContent.trim(),
        })),
        scope: (document.querySelector("#report-nps-scope") || {}).textContent || "",
      }));
      /* R9 — was a hardcoded 6. The property under test is "every respondent appears", which is a
         statement about the fixtures, not about the number six: read the count off the fixtures at
         run time, the way the standing rule in HARNESS.md requires. */
      eq("S7 · the tile expands to every respondent", list.rows.length, scored.length);
      eq("S7 · sorted ascending — the worst score is first", list.rows.map((r) => Number(r.score.split("/")[0])),
        scored.map((c) => Number(c.nps_score)));
      // The top row is the lowest score in the fixture, and it is tinted as a detractor.
      const top = list.rows[0];
      const topCase = scored[0];
      const topName = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("id,clients(first_name,last_name)").eq("id", id);
        const cl = data[0].clients;
        return [cl.first_name, cl.last_name].filter(Boolean).join(" ");
      }, topCase.id);
      eq("S7 · the top row is the fixture's lowest score", top.score, `${topCase.nps_score}/10`);
      eq("S7 · … named", top.name, topName);
      ok("S7 · detractors (6 or below) are tinted",
        list.rows.every((r) => r.detractor === (Number(r.score.split("/")[0]) <= 6)),
        JSON.stringify(list.rows.map((r) => [r.score, r.detractor])));
      ok("S7 · each row names the adviser", list.rows.every((r) => r.meta.length > 2), JSON.stringify(list.rows.map((r) => r.meta)));

      // …and the name opens that case.
      await page.click("#report-nps-list .nps-row .linkish");
      await page.waitForTimeout(900);
      const opened = await page.evaluate(() => {
        const m = document.querySelector("#case-modal") || document.querySelector(".modal:not(.hidden)");
        return { open: !!m && !m.classList.contains("hidden"), text: m ? m.innerText.slice(0, 200) : "" };
      });
      ok("S7 · clicking a respondent opens their case", opened.open && opened.text.includes(topName.split(" ")[0]),
        JSON.stringify(opened).slice(0, 220));
      eq("S7 · no console errors", page.__err || [], []);
      await page.close();
    }

    /* ===================================================================
       6 · R5-2 — attribution basis stated on both adviser surfaces
       =================================================================== */
    console.log("\n— R5-2 · attribution footnote (p4)");
    {
      const page = await newPage(browser, "p4");
      await openReports(page);
      const NOTE = "Figures follow the adviser currently on each case; completed cases keep their adviser when someone leaves.";
      const monthFoot = await txt(page, "#month-advisers");
      const boardScope = await page.evaluate(() => (document.querySelector("#report-scoreboard-scope") || {}).textContent || "");
      ok("R5-2 · the month adviser table states the attribution basis", monthFoot.includes(NOTE), JSON.stringify(monthFoot.slice(-160)));
      ok("R5-2 · the adviser scoreboard states the attribution basis", boardScope.includes(NOTE), JSON.stringify(boardScope.slice(-160)));
      eq("R5-2 · no console errors", page.__err || [], []);
      await page.close();
    }

    /* ===================================================================
       7 · guard — M2 not applied: Reports degrades, it does not break
       =================================================================== */
    console.log("\n— guard · older database (M2 off): feature-detection degrades cleanly");
    {
      const page = await newPage(browser, "p4");
      await page.evaluate(() => window.__mock.setMigrations({ m2: false }));
      await openReports(page);
      const fx = await fixture(page);
      const rendered = await page.evaluate(() => ({
        kpis: (document.querySelector("#month-kpis") || {}).innerText || "",
        bar: (document.querySelector("#month-fee-target") || {}).innerText || "",
        losses: (document.querySelector("#report-losses") || {}).innerText || "",
        lossHidden: document.querySelector("#report-losses-panel").classList.contains("hidden"),
      }));
      ok("guard · the month card still renders", rendered.kpis.includes("APPLICATIONS SUBMITTED"), JSON.stringify(rendered.kpis.slice(0, 80)));
      // Without the per-type columns every fee falls back to the single legacy date.
      const legacyTotal = fx.cases.filter((c) => c.fee_paid_at && String(c.fee_paid_at).slice(0, 7) === fx.thisMv
        && String(c.fee_paid_at).slice(0, 10) <= fx.todayIso)
        .reduce((s, c) => s + Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0), 0);
      ok("guard · cash falls back to the single legacy fee_paid_at", rendered.bar.includes(money(legacyTotal)),
        JSON.stringify({ bar: rendered.bar, want: money(legacyTotal) }));
      ok("guard · the losses panel still renders, all in the '(not recorded)' bucket",
        !rendered.lossHidden && rendered.losses.includes("(not recorded)") && !/Went direct/.test(rendered.losses),
        JSON.stringify(rendered.losses));
      eq("guard · no console errors on an un-migrated database", page.__err || [], []);
      await page.evaluate(() => window.__mock.setMigrations({ m2: true }));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (_) {} }
  }

  console.log(`\nBATCH 6: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
