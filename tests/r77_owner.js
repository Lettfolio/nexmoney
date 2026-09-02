#!/usr/bin/env node
/* =============================================================================
   tests/r77_owner.js — acceptance tests for R77 build A, "the owner decides".

   Four items, all owner-surface (Reports/Money walked as p4; capture as p1):
     §A  A1a · THE FORECAST MEETS THE TARGET. #report-forecast-target-line says
         "≤30 days weighted £X vs monthly target £T → gap £Y" (both gap
         directions; unset target names Settings instead of inventing a gap),
         and #report-forecast-none-line ("N cases (£Z weighted) have no
         expected completion date") drives the EXISTING toggleForecastNoneList.
     §B  A1b · EXPECTED-COMPLETION CAPTURE. The application and offer
         stage-entry prompts carry an optional #se-expected date field —
         prefilled from the case, saved on advance, blank/Skip never blocks
         and never writes, unchanged prefill writes nothing, Exchange gains
         nothing.
     §C  A2a · THE LEAD-SOURCE DATALIST. #case-lead-sources offers the book's
         distinct sources, case-insensitively deduped to the majority casing;
         the input stays free text.
     §D  A2b · LEAD SOURCES READ. The panel gains the Losses panel's
         This-month / All-time toggle (#report-sources-scope-btn) with its own
         scope line, and grouping is case-insensitive ("google" and "Google"
         are one row, displayed in the book's majority casing). Revenue column
         and convCell honesty untouched.
     §E  A3 · THE COVERAGE GUARD. A later milestone counting more cases than
         an earlier one, or a velocity row with n≤1, prints the honest clause
         ("date coverage too thin — N cases are missing application/offer
         dates → fix in Data health") linking to Data health's
         #dh-milestone-panel — never an impossible %, never a hidden row.
     §F  A4 · BUSINESS MIX BY CASE TYPE. #report-mix-panel in Money & book:
         completions YTD + live pipeline by case_kind, broker-fee sums and
         averages that reconcile against the seeded fixtures, "(not recorded)"
         for a blank kind, CSV affordance, owner-only.

   Every figure asserted is computed from window.__mockDb at runtime — never
   invented. PLAYWRIGHT-AWAIT: moves that raise dialogs are fired UNAWAITED
   (window.__r77mv) and the DOM is polled.

   Run:  node /root/nx/tests/r77_owner.js
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

const DESK = { width: 1400, height: 950 };

async function boot(browser, persona) {
  const ctx = await browser.newContext({ viewport: DESK });
  const page = await ctx.newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(300);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const noNewErr = (page, before) => realErrs(page).length === before;
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const wait = (page, ms) => page.waitForTimeout(ms);
const goPage = async (page, name, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await page.waitForTimeout(ms == null ? 2000 : ms);
};
const overlayOpen = (page) => page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden"));
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function mkCase(page, o) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "Rae", last_name: o.last || "R77Case", email: `r77.${Math.random().toString(36).slice(2, 9)}@example.com` }).select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = {
      client_id: cl.id, case_kind: o.case_kind || "purchase", stage: o.stage || "enquiry",
      assigned_to: o.assigned_to === undefined ? "p2" : o.assigned_to,
      lender: o.lender === undefined ? "Halifax" : o.lender,
      protection_status: o.protection_status === undefined ? "discussed" : o.protection_status,
    };
    ["waiting_on", "solicitor_firm", "offer_expiry_date", "expected_completion_date", "broker_fee"].forEach((k) => {
      if (o[k] !== undefined) row[k] = o[k];
    });
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { caseId: cs.id, clientId: cl.id };
  }, o);
}
const caseRow = (page, id) => page.evaluate(async (id) =>
  (await window.__mockDb.from("cases").select("*").eq("id", id).single()).data, id);
// PLAYWRIGHT-AWAIT — fire the move, never await it in evaluate; the dialog is driven by the DOM.
const startMove = (page, id, stage) => page.evaluate(([id, stage]) => {
  window.__r77mv = window.moveCaseToStage(id, stage, { promptStageEntry: true });
}, [id, stage]);
const finishMove = (page) => page.evaluate(() => window.__r77mv);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  try {
    /* =====================================================================
       §A · A1a — the forecast meets the target (p4, owner)
       ===================================================================== */
    console.log("\n— §A · A1a · #report-forecast-target-line: gap both ways, unset target, no-date clause (p4)");
    {
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "reports", 2500);

      // Expected figures from the mock db, by the panel's own documented rules.
      const exp = await page.evaluate(async () => {
        const { data: all } = await window.__mockDb.from("cases").select("*").order("id");
        const W = { decision_in_principle: 0.25, application: 0.5, offer: 0.8, exchange: 0.95 };
        const d30 = localDateStr(Date.now() + 30 * 86400000);
        let h30 = 0, noneN = 0, noneW = 0;
        (all || []).forEach((c) => {
          const w = W[c.stage];
          if (w == null) return;
          const g = (Number(c.broker_fee || 0) + Number(c.proc_fee || 0)) * w;
          if (!c.expected_completion_date) { noneN++; noneW += g; }
          else if (String(c.expected_completion_date).slice(0, 10) <= d30) h30 += g;
        });
        const target = Number(settings.monthly_fee_target || 0);
        const gap = target - h30;
        return {
          target,
          line: `≤30 days weighted ${fmtM(h30)} vs monthly target ${fmtM(target)} → ` +
            (gap > 0 ? `gap ${fmtM(gap)}` : `${fmtM(-gap)} ahead of target`),
          none: `${noneN} case${noneN === 1 ? "" : "s"} (${fmtM(noneW)} weighted) ${noneN === 1 ? "has" : "have"} no expected completion date`,
          noneN,
        };
      });
      eq("A0 · fixture sanity: settings.monthly_fee_target is the £9,500 the round is about", exp.target, 9500);

      const lineTxt = norm(await page.$eval("#report-forecast-target-line", (e) => e.textContent));
      eq("A1 · the gap line states ≤30-days weighted vs the monthly target, gap named", lineTxt, norm(exp.line));

      ok("A2 · fixture sanity: some live cases have no expected completion date", exp.noneN > 0, exp.noneN);
      const noneTxt = norm(await page.$eval("#report-forecast-none-line", (e) => e.textContent));
      eq("A2b · the no-date clause counts the cases and their weighted £", noneTxt, norm(exp.none));

      // The clause drives the EXISTING toggle: the "No date" drill list opens and closes.
      const listHiddenBefore = await page.$eval("#report-forecast-none-list", (e) => e.classList.contains("hidden"));
      ok("A3 · the no-date drill list starts hidden", listHiddenBefore);
      await page.click("#report-forecast-none-line");
      await wait(page, 200);
      const listShown = await page.$eval("#report-forecast-none-list", (e) => !e.classList.contains("hidden"));
      const btnLabel = await page.$eval("#report-forecast-none-toggle", (e) => e.textContent.trim());
      ok("A3b · clicking the clause opens the list via toggleForecastNoneList (button flips to Hide)", listShown && btnLabel === "▾ Hide", JSON.stringify({ listShown, btnLabel }));

      // Gap the OTHER way: a tiny target puts the forecast ahead.
      await page.evaluate(async () => {
        await window.__mockDb.from("settings").update({ value: "1" }).eq("key", "monthly_fee_target");
        await loadSettings();
      });
      await goPage(page, "dashboard", 800);
      await goPage(page, "reports", 2500);
      const aheadTxt = norm(await page.$eval("#report-forecast-target-line", (e) => e.textContent));
      ok("A4 · with a tiny target the same line reads \"£X ahead of target\", never a negative gap",
        /vs monthly target £1 → £[\d,]+ ahead of target$/.test(aheadTxt), aheadTxt);

      // Unset target: say so and point at Settings — no invented gap against zero.
      await page.evaluate(async () => {
        await window.__mockDb.from("settings").update({ value: "" }).eq("key", "monthly_fee_target");
        await loadSettings();
      });
      await goPage(page, "dashboard", 800);
      await goPage(page, "reports", 2500);
      const unsetTxt = norm(await page.$eval("#report-forecast-target-line", (e) => e.textContent));
      eq("A5 · no target set: the line says so and points at Settings › Targets",
        unsetTxt, "No monthly fee target is set, so there is no gap to read this against — set one in Settings › Targets.");
      ok("A5b · …with a live Settings link", !!(await page.$("#report-forecast-target-set")));

      ok("§A · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =====================================================================
       §B · A1b — expected-completion capture on the stage-entry prompts (p1)
       ===================================================================== */
    console.log("\n— §B · A1b · #se-expected on the application/offer prompts: saves, prefills, never blocks (p1)");
    {
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;

      // B1 · application, waiting already answered, no expected date → the field alone raises the dialog
      const b1 = await mkCase(page, { stage: "decision_in_principle", waiting_on: "lender" });
      await startMove(page, b1.caseId, "application");
      await wait(page, 1200);
      ok("B1 · advancing to Application with no expected date raises the dialog", await overlayOpen(page));
      const b1state = await page.evaluate(() => ({
        expected: !!document.querySelector("#se-expected"),
        waiting: !!document.querySelector("#se-waiting"),
        threeWay: !!(document.querySelector("#se-cancel") && document.querySelector("#se-skip") && document.querySelector("#se-ok")),
      }));
      ok("B1b · …carrying #se-expected but NOT re-asking the answered waiting-on question", b1state.expected && !b1state.waiting, JSON.stringify(b1state));
      ok("B1c · …with the three-way exit intact", b1state.threeWay);
      await page.fill("#se-expected", "2027-03-15");
      await page.click("#se-ok");
      await finishMove(page);
      await wait(page, 900);
      const r1 = await caseRow(page, b1.caseId);
      eq("B1d · Save & advance moves the case AND writes expected_completion_date",
        [r1.stage, r1.expected_completion_date], ["application", "2027-03-15"]);
      ok("B1e · the move's own toast is the receipt", /expected completion/.test(await toastText(page)), await toastText(page));

      // B2 · blank is allowed and never blocks
      const b2 = await mkCase(page, { stage: "decision_in_principle", waiting_on: "lender" });
      await startMove(page, b2.caseId, "application");
      await wait(page, 1100);
      await page.click("#se-ok");   // field left blank
      await finishMove(page);
      await wait(page, 800);
      const r2 = await caseRow(page, b2.caseId);
      eq("B2 · Save with the field blank still advances and writes NOTHING",
        [r2.stage, r2.expected_completion_date], ["application", null]);

      // B3 · Skip advances and writes nothing
      const b3 = await mkCase(page, { stage: "decision_in_principle", waiting_on: "lender" });
      await startMove(page, b3.caseId, "application");
      await wait(page, 1100);
      await page.click("#se-skip");
      await finishMove(page);
      await wait(page, 800);
      const r3 = await caseRow(page, b3.caseId);
      eq("B3 · Skip advances and writes nothing", [r3.stage, r3.expected_completion_date], ["application", null]);

      // B4 · offer: the field rides the one dialog, PREFILLED, and a change is saved
      const b4 = await mkCase(page, { stage: "application", waiting_on: null, expected_completion_date: "2027-01-01", offer_expiry_date: null });
      await startMove(page, b4.caseId, "offer");
      await wait(page, 1200);
      const b4pre = await page.$eval("#se-expected", (e) => e.value).catch(() => null);
      eq("B4 · the Offer dialog prefills #se-expected with the case's current date", b4pre, "2027-01-01");
      const b4count = await page.$$eval("#overlay-modal", (e) => e.length);
      eq("B4b · one dialog per move, never two", b4count, 1);
      await page.fill("#se-expiry", "2030-05-05");
      await page.fill("#se-expected", "2027-02-02");
      await page.click("#se-ok");
      await finishMove(page);
      await wait(page, 900);
      const r4 = await caseRow(page, b4.caseId);
      eq("B4c · Save writes the expiry AND the corrected expected date in one patch",
        [r4.stage, r4.offer_expiry_date, r4.expected_completion_date], ["offer", "2030-05-05", "2027-02-02"]);

      // B5 · everything already answered → no dialog at all (the "already answered" discipline)
      const b5 = await mkCase(page, { stage: "application", waiting_on: "lender", expected_completion_date: "2027-01-01", offer_expiry_date: "2030-01-01" });
      await startMove(page, b5.caseId, "offer");
      await wait(page, 1100);
      ok("B5 · an offer with expiry, waiting-on AND expected date all recorded is asked NOTHING", !(await overlayOpen(page)));
      await finishMove(page);
      await wait(page, 800);
      const r5 = await caseRow(page, b5.caseId);
      eq("B5b · …and it still advances, untouched", [r5.stage, r5.expected_completion_date], ["offer", "2027-01-01"]);

      // B6 · Exchange gains nothing — its waiting-on-only dialog is untouched
      const b6 = await mkCase(page, { stage: "offer", waiting_on: null, expected_completion_date: null, offer_expiry_date: "2030-01-01" });
      await startMove(page, b6.caseId, "exchange");
      await wait(page, 1200);
      const b6state = await page.evaluate(() => ({
        open: !document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        waiting: !!document.querySelector("#se-waiting"),
        expected: !!document.querySelector("#se-expected"),
      }));
      ok("B6 · the Exchange dialog still asks waiting-on and does NOT gain the expected field",
        b6state.open && b6state.waiting && !b6state.expected, JSON.stringify(b6state));
      await page.click("#se-skip");
      await finishMove(page);
      await wait(page, 800);

      // B7 · an UNCHANGED prefill writes nothing (no pointless write, no receipt)
      const b7 = await mkCase(page, { stage: "application", waiting_on: "lender", expected_completion_date: "2027-05-05", offer_expiry_date: null });
      await startMove(page, b7.caseId, "offer");
      await wait(page, 1200);
      const b7pre = await page.$eval("#se-expected", (e) => e.value).catch(() => null);
      eq("B7 · prefill present on the expiry-raised dialog", b7pre, "2027-05-05");
      await page.click("#se-ok");   // expiry left blank, expected left untouched
      await finishMove(page);
      await wait(page, 900);
      const r7 = await caseRow(page, b7.caseId);
      eq("B7b · Save with everything untouched advances and re-writes nothing",
        [r7.stage, r7.expected_completion_date, r7.offer_expiry_date], ["offer", "2027-05-05", null]);
      ok("B7c · …and the toast claims no expected-completion write", !/expected completion/.test(await toastText(page)), await toastText(page));

      ok("§B · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =====================================================================
       §C · A2a — the lead-source datalist on the case form (p1)
       ===================================================================== */
    console.log("\n— §C · A2a · #case-lead-sources: the book's sources, case-insensitively deduped (p1)");
    {
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;

      const expSources = await page.evaluate(async () => {
        const { data: rows } = await window.__mockDb.from("cases").select("lead_source").order("id");
        const seen = new Map();
        (rows || []).forEach((r) => {
          const v = r && r.lead_source ? String(r.lead_source).trim() : "";
          if (!v) return;
          const k = v.toLowerCase();
          let vars = seen.get(k);
          if (!vars) { vars = new Map(); seen.set(k, vars); }
          vars.set(v, (vars.get(v) || 0) + 1);
        });
        return [...seen.values()].map((vars) => {
          let best = null, bestN = -1;
          vars.forEach((n, variant) => { if (n > bestN) { best = variant; bestN = n; } });
          return best;
        }).sort((a, b) => a.localeCompare(b));
      });
      ok("C0 · fixture sanity: the book carries casing variants (a lowercase 'google' row exists)",
        await page.evaluate(async () => {
          const { data } = await window.__mockDb.from("cases").select("lead_source");
          return (data || []).some((r) => r.lead_source === "google") && (data || []).some((r) => r.lead_source === "WEBSITE");
        }));

      await page.evaluate(() => window.openCase(null));
      await wait(page, 900);
      const input = await page.evaluate(() => {
        const i = document.querySelector('#case-form [name="lead_source"]');
        return i ? { tag: i.tagName, list: i.getAttribute("list") } : null;
      });
      eq("C1 · the lead-source field stays a free-text input, now wired to the datalist",
        input, { tag: "INPUT", list: "case-lead-sources" });
      const opts = await page.$$eval("#case-lead-sources option", (els) => els.map((o) => o.value));
      eq("C2 · the datalist offers the book's distinct sources, deduped to the majority casing", opts, expSources);
      const googleVariants = opts.filter((o) => o.toLowerCase() === "google");
      eq("C3 · exactly ONE Google entry, in its majority casing — never 'google' beside 'Google'", googleVariants, ["Google"]);
      ok("C4 · the WEBSITE row merged into 'Website' the same way", opts.includes("Website") && !opts.includes("WEBSITE"), JSON.stringify(opts));

      ok("§C · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =====================================================================
       §D · A2b — Lead sources: All-time toggle + case-insensitive grouping (p4)
       ===================================================================== */
    console.log("\n— §D · A2b · #report-sources: scope toggle, case-insensitive rows, Revenue kept (p4)");
    {
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "reports", 2500);

      const scope1 = await page.$eval("#report-sources-scope", (e) => e.textContent.trim());
      ok("D1 · default scope line unchanged (this-month wording)",
        /^Set the lead source on cases to build this up\. Scoped to leads created in /.test(scope1), scope1);
      const btn1 = await page.$eval("#report-sources-scope-btn", (e) => e.textContent.trim());
      eq("D1b · the toggle offers All time (the Losses panel's exact control)", btn1, "All time");

      const exp = await page.evaluate(async () => {
        const { data: all } = await window.__mockDb.from("cases").select("*").order("id");
        const map = new Map();   // lower key → {cases, variants}
        (all || []).forEach((c) => {
          const raw = (c.lead_source || "").trim();
          const k = raw ? raw.toLowerCase() : "(not set)";
          let v = map.get(k);
          if (!v) { v = { cases: 0, variants: new Map() }; map.set(k, v); }
          v.cases++;
          if (raw) v.variants.set(raw, (v.variants.get(raw) || 0) + 1);
        });
        const rows = {};
        map.forEach((v, k) => {
          let best = k === "(not set)" ? "(not set)" : null, bestN = -1;
          v.variants.forEach((n, variant) => { if (n > bestN) { best = variant; bestN = n; } });
          rows[best] = v.cases;
        });
        return { total: (all || []).length, rows };
      });

      await page.click("#report-sources-scope-btn");
      await wait(page, 400);
      const scope2 = await page.$eval("#report-sources-scope", (e) => e.textContent.trim());
      ok("D2 · All time flips the scope line, states the count, and says the grouping rule",
        scope2.startsWith("Set the lead source on cases to build this up. Every case on the book, all time (" + exp.total + ").")
        && /grouped case-insensitively/.test(scope2), scope2);
      eq("D2b · the button now offers the way back", await page.$eval("#report-sources-scope-btn", (e) => e.textContent.trim()), "This month");

      const table = await page.$$eval("#report-sources table tr", (trs) => trs.slice(1).map((tr) => {
        const tds = [...tr.querySelectorAll("td")];
        return [tds[0].textContent.trim(), Number(tds[1].textContent.trim())];
      }));
      const got = Object.fromEntries(table);
      const sortEntries = (o) => Object.entries(o).sort((a, b) => a[0].localeCompare(b[0]));
      eq("D3 · all-time rows: every source exactly once, case-insensitively merged, counts exact", sortEntries(got), sortEntries(exp.rows));
      ok("D3-order · the table stays sorted by case count, biggest first",
        table.every((r, i) => i === 0 || table[i - 1][1] >= r[1]), JSON.stringify(table));
      ok("D3b · no lowercase 'google' or shouting 'WEBSITE' row survives", !("google" in got) && !("WEBSITE" in got), JSON.stringify(Object.keys(got)));
      const gTotal = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("lead_source");
        return (data || []).filter((r) => (r.lead_source || "").trim().toLowerCase() === "google").length;
      });
      eq("D3c · the merged Google row counts BOTH casings", got.Google, gTotal);

      const heads = await page.$$eval("#report-sources table tr:first-child th", (els) => els.map((e) => e.textContent.trim()));
      ok("D4 · the owner's Revenue column and Conversion honesty survive the rework",
        heads.includes("Revenue") && heads.includes("Conversion"), JSON.stringify(heads));

      // Back to this-month: the toggle round-trips.
      await page.click("#report-sources-scope-btn");
      await wait(page, 400);
      ok("D5 · toggling back restores the month scope line",
        /Scoped to leads created in /.test(await page.$eval("#report-sources-scope", (e) => e.textContent)), "");

      ok("§D · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =====================================================================
       §E · A3 — the Pipeline MI coverage guard (p4)
       ===================================================================== */
    console.log("\n— §E · A3 · never print 3000%: the coverage clause on conversion + velocity, linking Data health (p4)");
    {
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "reports", 2500);

      const exp = await page.evaluate(async () => {
        const { data: all } = await window.__mockDb.from("cases").select("*").order("id");
        const ranks = Object.fromEntries(STAGES.map(([k], i) => [k, i]));
        const appR = ranks.application, offR = ranks.offer;
        let reachedApp = 0, reachedOffer = 0, reachedCompleted = 0, miss = 0;
        const vAppOffer = [], vOfferComp = [];
        (all || []).forEach((c) => {
          if (c.submitted_at) reachedApp++;
          if (c.offer_issued_date) reachedOffer++;
          if (c.completed_at) reachedCompleted++;
          if (c.stage !== "not_proceeding") {
            const r = ranks[c.stage];
            if (r != null && r >= appR && !c.submitted_at) miss++;
            else if (r != null && r >= offR && !c.offer_issued_date) miss++;
          }
          const d = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
          if (c.submitted_at && c.offer_issued_date) { const g = d(c.submitted_at, c.offer_issued_date); if (!isNaN(g) && g >= 0) vAppOffer.push(g); }
          if (c.offer_issued_date && c.completed_at) { const g = d(c.offer_issued_date, c.completed_at); if (!isNaN(g) && g >= 0) vOfferComp.push(g); }
        });
        return { reachedApp, reachedOffer, reachedCompleted, miss, nAppOffer: vAppOffer.length, nOfferComp: vOfferComp.length };
      });
      ok("E0 · fixture sanity: the mock book has the production hole — completions outnumber offer dates",
        exp.reachedCompleted > exp.reachedOffer && exp.miss > 0, JSON.stringify(exp));
      const clause = `date coverage too thin — ${exp.miss} case${exp.miss === 1 ? " is" : "s are"} missing application/offer dates → fix in Data health`;

      const convRows = await page.$$eval("#report-mi-conversion table tr", (trs) => trs.slice(1).map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
      eq("E1 · the Completed row keeps its COUNT (never hidden)", convRows[3][1], String(exp.reachedCompleted));
      eq("E1b · …and its impossible % is replaced by the exact clause", convRows[3][2], clause);
      ok("E1c · no cell anywhere in the conversion table prints a % over 100",
        !convRows.some((r) => r.some((cell) => { const m = cell.match(/^(\d+)%$/); return m && Number(m[1]) > 100; })), JSON.stringify(convRows));

      const velRows = await page.$$eval("#report-mi-velocity table tr", (trs) => trs.slice(1).map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
      const appOfferRow = velRows.find((r) => r[0] === "Application → offer");
      const offerCompRow = velRows.find((r) => r[0] === "Offer → completion");
      ok("E2 · fixture sanity: both offer-anchored velocity rows are n≤1 on this book",
        exp.nAppOffer <= 1 && exp.nOfferComp <= 1, JSON.stringify(exp));
      eq("E2b · an n≤1 velocity row swaps its numbers for the clause, keeping its n",
        [appOfferRow[1], appOfferRow[appOfferRow.length - 1]], [clause, String(exp.nAppOffer)]);
      eq("E2c · …both of them", [offerCompRow[1], offerCompRow[offerCompRow.length - 1]], [clause, String(exp.nOfferComp)]);
      const wellFedRow = velRows.find((r) => r[0] === "Created → completion (total)");
      ok("E2d · a well-dated transition keeps its real median (the guard replaces nothing it needn't)",
        /^\d+d$/.test(wellFedRow[1]), JSON.stringify(wellFedRow));

      // The clause is a LINK: it lands on Data health with the milestone list revealed.
      await page.click("#report-mi-conversion .mi-coverage-clause");
      await wait(page, 1800);
      const landed = await page.evaluate(() => ({
        dataPage: !document.querySelector("#page-data").classList.contains("hidden"),
        panelShown: !!document.querySelector("#dh-milestone-panel") && !document.querySelector("#dh-milestone-panel").classList.contains("hidden"),
      }));
      ok("E3 · clicking the clause opens Data health with the missing-milestone list revealed",
        landed.dataPage && landed.panelShown, JSON.stringify(landed));

      ok("§E · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =====================================================================
       §F · A4 — the business-mix table (p4 owner; hidden from an adviser)
       ===================================================================== */
    console.log("\n— §F · A4 · #report-mix-panel: completions YTD + live pipeline by case_kind, sums reconcile (p4)");
    {
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;

      // Seed one kind-less live case so the "(not recorded)" honesty row exists to assert.
      await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").insert({ first_name: "Nok", last_name: "R77Kindless", email: "r77.kindless@example.com" }).select("id").single();
        await db.from("cases").insert({ client_id: cl.id, stage: "enquiry", broker_fee: 250, assigned_to: "p2" });
      });
      await goPage(page, "reports", 2500);

      const exp = await page.evaluate(async () => {
        const { data: all } = await window.__mockDb.from("cases").select("*").order("id");
        const LIVE = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
        const yr = localDateStr().slice(0, 4);
        const KINDMAP = { purchase: "Purchase", remortgage: "Remortgage", product_transfer: "Product Transfer", buy_to_let: "Buy to Let", first_time_buyer: "First Time Buyer", other: "Other" };
        const ORDER = Object.keys(KINDMAP);
        const agg = new Map();
        const bump = (c, slot) => {
          const k = (c.case_kind || "").trim();
          let a = agg.get(k);
          if (!a) { a = { kind: k, doneN: 0, doneFees: 0, liveN: 0, liveFees: 0 }; agg.set(k, a); }
          a[slot + "N"]++; a[slot + "Fees"] += Number(c.broker_fee || 0);
        };
        (all || []).forEach((c) => {
          if (c.completed_at && localDateStr(c.completed_at).slice(0, 4) === yr) bump(c, "done");
          if (LIVE.includes(c.stage)) bump(c, "live");
        });
        const orderOf = (k) => { if (!k) return ORDER.length + 1; const i = ORDER.indexOf(k); return i === -1 ? ORDER.length : i; };
        const list = [...agg.values()].sort((a, b) => orderOf(a.kind) - orderOf(b.kind) || a.kind.localeCompare(b.kind));
        const avg = (f, n) => (n ? fmtM(Math.round(f / n)) : "—");
        return {
          rows: list.map((a) => [a.kind ? KINDMAP[a.kind] || a.kind : "(not recorded)",
            String(a.doneN), fmtM(a.doneFees), avg(a.doneFees, a.doneN), String(a.liveN), fmtM(a.liveFees), avg(a.liveFees, a.liveN)]),
          totDoneN: list.reduce((s, a) => s + a.doneN, 0),
          totLiveFees: fmtM(list.reduce((s, a) => s + a.liveFees, 0)),
        };
      });

      const shown = await page.$eval("#report-mix-panel", (e) => !e.classList.contains("hidden"));
      ok("F1 · the panel is on the owner's page, in Money & book", shown);
      const inNav = await page.evaluate(() => {
        const s = REPORT_SECTIONS.find((x) => x[0] === "money");
        return s && s[3].includes("#report-mix-panel") && REPORT_JUMP_SECTIONS.some((x) => x[0] === "mix");
      });
      ok("F1b · …and the jump nav knows it (money section + its own chip entry)", inNav);

      const table = await page.$$eval("#report-mix table tr", (trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())).filter((r) => r.length));
      const bodyRows = table.slice(0, -1);
      eq("F2 · every kind row matches the seeded fixtures — label, counts, broker-fee sums, averages", bodyRows, exp.rows);
      const notRec = bodyRows.find((r) => r[0] === "(not recorded)");
      ok("F3 · a case with no kind keeps its row, labelled honestly, last", !!notRec && bodyRows[bodyRows.length - 1][0] === "(not recorded)", JSON.stringify(bodyRows.map((r) => r[0])));
      const foot = table[table.length - 1];
      ok("F4 · the Total row reconciles (completions YTD count + live fee sum)",
        foot[0] === "Total" && foot[1] === String(exp.totDoneN) && foot[5] === exp.totLiveFees, JSON.stringify({ foot, exp: [exp.totDoneN, exp.totLiveFees] }));

      ok("F5 · the CSV affordance its neighbours carry", !!(await page.$("#report-mix-csv")));

      // Owner-only: an adviser gets neither the panel nor its chip.
      const p2 = await boot(browser, "p2");
      await goPage(p2, "reports", 2500);
      const advHidden = await p2.$eval("#report-mix-panel", (e) => e.classList.contains("hidden"));
      ok("F6 · an adviser's Reports hides the panel (showMoney gate, like its neighbours)", advHidden);
      await p2.close();

      ok("§F · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) { /* already gone */ } }
  }

  console.log(`\nR77-A owner: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  FAIL: " + f)); process.exit(1); }
})();
