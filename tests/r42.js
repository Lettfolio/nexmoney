#!/usr/bin/env node
/* =============================================================================
   tests/r42.js — acceptance tests for ROUND 42: Reports regrouped into five
   labelled sections with a jump-nav, six report ledgers folded behind
   <details> drawers, basis-repeat prose trimmed, the CSV glyph unified, the
   Settings doc-chase note and the Emails explainer folded behind ⓘ
   expanders, and Data-Health's zero-count fault tiles hidden behind a
   clean-toggle (admin/app.js + admin/index.html + admin/admin.css only, no
   schema).

   What R42 shipped (see the change list this suite was written against):
    - #reports-jump (NEW, non-sticky) sits above #rep-nav (unchanged, sticky)
      on Reports: five buttons, #reports-nav-{mine,month,mi,money,quality},
      built by buildReportSectionNav() the same way #rep-nav's own chips are
      — read off which panels are visible, never re-testing MY_ROLE. Five
      slim h3#rsec-* headers now split the page into My numbers / This month
      / Pipeline MI / Money & book / Service & quality, in that DOM order,
      with three whole blocks (forecast/completions+introducers/LTV; lead
      response/NPS/advocacy/conveyancers) physically moved to match.
      REPORT_SECTIONS (app.js) declares the five groups; a section with
      nothing visible under it loses BOTH its button and its header.
    - Six <details class="report-ledger"> drawers, closed by default, each
      with a live count appended to its <summary> via a trailing
      span.ledger-n: #report-owed-table (.owed-case-row), #report-rateend-table
      (tr.rb-bucket-row), #report-nps-list (.nps-row — toggleNpsList() opens
      this drawer WHEN it reveals the whole NPS panel, by design, not a bug),
      #report-ltv, #report-conveyancer-body (tr[data-firm]), #report-introducers
      (REPORT_LEDGERS, app.js). #owed-csv-btn/#report-owed-buckets/
      #report-rateend-recover stay outside/usable with the drawer closed.
    - Prose: #month-legend's tail (which repeated #report-basis-legend's own
      earned/banked distinction) is gone — it now ends "…scoped to the month
      selected above (bases: see legend above)." #report-owed-basis no
      longer says "the same basis as 'Fees banked' above" nor recaps the
      basis definition in a parenthetical — it now ends "— basis: outstanding
      (see legend above)". #report-basis-legend itself is VERBATIM unchanged.
    - Glyph: every CSV control uses ⭳, not ⬇ — #owed-csv-btn ("⭳ CSV"),
      #csv-btn ("⭳ Download CSV"), #client-bulk-csv ("⭳ Export CSV"). Zero ⬇
      remain anywhere in the rendered app.
    - Settings: #doc-chase-note is now a <div> (was <p> — a <details> inside
      a <p> is parser-closed) holding one visible sentence with a
      docChaseDays() interpolation, plus <details id="doc-chase-more"><summary>
      ⓘ Full rules</summary> holding the original ~1,020-character paragraph,
      both interpolations intact.
    - Emails: the opening ~2,000 characters of standing prose is cut to two
      sentences; everything else — including the R8/R9 copy-audit paragraphs,
      reproduced WORD FOR WORD, ids intact — now sits inside
      <details id="emails-explainer">, closed by default.
    - Data Health: the 11 dhReadinessChecks tiles + #dh-tile-failed +
      #dh-tile-nopolicystart (13 fault tiles total) get class dh-clean +
      display:none the moment their count is 0 (dhFault(), app.js); the four
      informational tiles (waitingdocs/sharedprop/vulnerable/suppressed) and
      Clients-total are NEVER hidden, at any count. #dh-clean-toggle
      ("✓ N checks clean ▸" ⇄ "▾ hide", aria-expanded, Enter/Space) reveals
      them via .dh-show-clean on #dh-kpi-row; absent outright when nothing is
      clean. #dh-readiness (unchanged) already excludes every clean tile by
      construction (it only ever lists count>0 checks), so the two
      mechanisms can never disagree.

   §A  Reports section headers + jump nav — five h3#rsec-* in the fixed DOM
       order, REPORT_SECTIONS (read live) declares the same order/keys,
       #reports-jump is NOT sticky while #rep-nav IS, and clicking a visible
       chip scrolls the page and lands its header in the viewport.
   §B  Role gating — owner (p4): no "My numbers" button or header. Adviser
       (p2): no "Service & quality" button or header (and, in contrast, DOES
       still get "My numbers").
   §C  Six ledger drawers — closed by default, correct noun + live count on
       the summary, opening reveals renderer content.
   §D  #owed-csv-btn exports with its drawer closed, unaffected by drawer
       state either way.
   §E  #report-basis-legend — verbatim, exact string match.
   §F  #month-legend / #report-owed-basis — the new endings; the deleted
       phrases are gone.
   §G  Zero ⬇ anywhere rendered (Reports, Pipeline, Clients); the three CSV
       buttons all carry ⭳.
   §H  Doc-chase — the one-sentence note interpolates the setting; ⓘ Full
       rules opens to the original text, same interpolation, both places.
   §I  Emails — the opening paragraph is two sentences; the explainer is
       closed by default; opening it reveals the R8/R9 notes verbatim;
       the status chips and list are unaffected either way.
   §J  Data Health clean-tile fold — a genuinely zero-count fault tile is
       dh-clean + hidden; the toggle reveals it, flips its own label,
       flips aria-expanded, and works from the keyboard (Enter); a non-zero
       fault tile is never hidden; the four informational tiles are never
       hidden even when their own count is genuinely zero; the toggle is
       absent outright once nothing is clean; #dh-readiness's item list
       agrees exactly with which fault tiles are (and are not) folded away.

   EVERY figure this file asserts is either read straight back off the mock
   db, computed by the test's own construction/seeding, or read live off
   app.js's own module state (REPORT_SECTIONS, REPORT_LEDGERS) — never a
   number this file invented independently of the fixture/app it is testing
   against, the same standing rule tests/r38.js/r40.js/r41.js already follow.

   Run:  node /root/nx/tests/r42.js
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
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");

/* Same defensive localStorage clear every suite in this harness does before depending on a
   default — copied verbatim from tests/r38.js/r40.js/r41.js's own NX_KEYS. */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser"/* R64 · M9 — the Clients adviser filter persists now */, "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_ret_scope", "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads",
  "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

/* ---------------------------------------------------------------------------
   CSV capture — same technique tests/r20.js/r8_touch.js/r13.js already use:
   override URL.createObjectURL + <a download> click so nothing hits disk.
   ------------------------------------------------------------------------- */
async function armCsvCapture(page) {
  await page.evaluate(() => {
    window.__csvBlob = null; window.__csvName = null;
    if (!window.__csvArmed) {
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__csvBlob = b; try { return origCreate(b); } catch (e) { return "blob:captured"; } };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute("download")) { window.__csvName = this.getAttribute("download"); return; } return origClick.apply(this, arguments); };
      window.__csvArmed = true;
    }
  });
}
const resetCsvCapture = (page) => page.evaluate(() => { window.__csvBlob = null; window.__csvName = null; });
const readCsv = (page) => page.evaluate(async () => (window.__csvBlob ? await window.__csvBlob.text() : null));
const readCsvName = (page) => page.evaluate(() => window.__csvName);

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — same technique tests/r27.js's insertCase
   and tests/r38.js/r40.js/r41.js's own mk* helpers use.
   ------------------------------------------------------------------------- */
async function insertDeadbookCase(page, daysAgo) {
  return page.evaluate(async (daysAgo) => {
    const db = window.__mockDb;
    const past = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    const email = `r42.${Math.random().toString(36).slice(2, 9)}@example.com`;
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: "R42Deadbook", last_name: "Seed" + Date.now(), email, phone: "07700900000" })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const { data: cs, error: csErr } = await db.from("cases")
      .insert({ client_id: cl.id, case_kind: "purchase", stage: "application", expected_completion_date: past, rate_end_date: null })
      .select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return cs.id;
  }, daysAgo);
}
/* Wipes every case (waitingdocs/sharedprop both fall to 0 with no live cases to compute them
   over) and neutralises every client's is_vulnerable/suppress_automation flag (vulnerable/
   suppressed both fall to 0 too) WITHOUT deleting a single client row — a straight port of
   tests/r19.js's own wipeCases() technique, extended to cover the two boolean flags the
   informational tiles read, so nothing else on the page is left dangling. */
async function wipeToZeroInformational(page) {
  return page.evaluate(async () => {
    const db = window.__mockDb;
    await db.from("cases").delete();
    const { data: clients } = await db.from("clients").select("id");
    for (const c of clients || []) {
      await db.from("clients").update({ is_vulnerable: false, suppress_automation: false }).eq("id", c.id);
    }
    return (clients || []).length;
  });
}

/* Parse the readiness rollup's rows off the DOM — same technique tests/r31.js's readinessItems()
   uses: label, shown count, and the real tile id the row's inline onclick targets. */
async function readinessItems(page) {
  return page.$$eval("#dh-readiness .dh-readiness-item", (els) =>
    els.map((el) => {
      const label = el.querySelector(".dh-readiness-label");
      const count = el.querySelector(".dh-readiness-count");
      const onclick = el.getAttribute("onclick") || "";
      const m = onclick.match(/getElementById\('([^']+)'\)/);
      return { label: label ? label.textContent.trim() : "", count: count ? Number(count.textContent.trim()) : NaN, tileId: m ? m[1] : null };
    }));
}

/* Exact strings copied byte-for-byte off admin/index.html (textContent, tags stripped) — the
   ground truth §E/§F/§I compare against, not something this file invented. */
const BASIS_LEGEND_TEXT = "Three money bases on this page, headline first — earned (the headline): proc + broker + sols fee value on a case, counted in the month it completed, paid or not · outstanding: earned but not yet received — whether it has been invoiced or is still to be invoiced · cash (banked) (secondary): money actually received, counted in the month it was paid. Every figure below says which one it is.";
const MONTH_LEGEND_TEXT = "Proc £ = procuration fee (paid by the lender) · Broker £ = fee charged to the client · Sols £ = solicitor referral fee. Figures on this panel are scoped to the month selected above (bases: see legend above).";
const OWED_BASIS_ENDING = "— basis: outstanding (see legend above)";
const EMAILS_FIRST_P_TEXT = "The 8am cron job sends whatever is sitting in the email queue. Sending the whole firm's queue early is an Owner / Administrator action.";
const EMAILS_R8_NOTE_TEXT = "Review requests are dripped: the automation queues at most 5 per run, oldest completion first, so a back-catalogue of completed cases doesn't land on your review page in one afternoon. The rest wait for the next run. · Annual reviews send no email. When the annual-review setting is on, each completion anniversary creates a call task (“Annual review call — …”) for the case's adviser; it appears in My Day and on the case, and nothing here.";
const EMAILS_R9_NOTE_TEXT = "An unanswered review request is followed up once. About a week after a review request that was actually sent and never answered (the exact gap is the “Review reminder if unanswered” setting), one reminder is queued — shown below as Review reminder (2nd ask). One per case ever, never a third, and it comes out of the same 5-a-run budget as the requests, taken only after them: a client who has never been asked always goes before one who is being asked twice. If somebody should not be asked again, cancel the row while it is still queued: press Cancel on it, confirm, and the email never sends — its status becomes cancelled, and where the row belongs to a case the cancellation is written onto that case's timeline with your name. · An unhappy answer creates work, not an email. A score of 6 or below raises a call-back task for the case's adviser and writes the client's own words onto the case timeline; nothing is sent back to the client automatically.";

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       §A · REPORTS SECTION HEADERS + JUMP NAV
       ======================================================================= */
    {
      console.log("\n— §A · five h3#rsec-* headers in DOM order; REPORT_SECTIONS agrees; #reports-jump is not sticky while #rep-nav is; chips scroll (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      await goto(page, "reports", 2200);

      const headIds = await page.$$eval("h3.report-section-head", (els) => els.map((e) => e.id));
      eq("§A1 · exactly the five rsec ids, in DOM order", headIds, ["rsec-mine", "rsec-month", "rsec-mi", "rsec-money", "rsec-quality"]);

      const sections = await page.evaluate(() => REPORT_SECTIONS.map((s) => s[0]));
      eq("§A2 · REPORT_SECTIONS declares the same five keys in the same order", sections, ["mine", "month", "mi", "money", "quality"]);

      const posInfo = await page.evaluate(() => ({
        jumpPos: getComputedStyle(document.getElementById("reports-jump")).position,
        repNavPos: getComputedStyle(document.getElementById("rep-nav")).position,
      }));
      ok("§A3 · #reports-jump is NOT position:sticky", posInfo.jumpPos !== "sticky", posInfo.jumpPos);
      eq("§A4 · #rep-nav IS still position:sticky (R11-4, unchanged)", posInfo.repNavPos, "sticky");

      // Owner sees month/mi/money/quality (mine is theirs to lose — see §B) — click every one of
      // them and prove the page actually moves and the target header lands in view.
      const keys = await page.evaluate(() => [...document.querySelectorAll("#reports-jump-chips [data-reports-jump]")].map((b) => b.dataset.reportsJump));
      eq("§A5 · owner's visible chip set is exactly month/mi/money/quality", keys, ["month", "mi", "money", "quality"]);

      for (const key of keys) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await wait(page, 200);
        const before = await page.evaluate(() => window.scrollY);
        await page.click(`#reports-nav-${key}`);
        await wait(page, 1000);
        const after = await page.evaluate((k) => {
          const head = document.getElementById(`rsec-${k}`);
          const r = head.getBoundingClientRect();
          return { y: window.scrollY, top: r.top, bottom: r.bottom, vh: window.innerHeight };
        }, key);
        ok(`§A6 · clicking #reports-nav-${key} scrolls the page`, after.y > before, { before, after });
        ok(`§A7 · …and #rsec-${key} lands inside the viewport`, after.top >= -2 && after.top <= after.vh, after);
      }

      ok("§A · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §B · ROLE GATING — owner loses "My numbers" (button + header), adviser
            loses "Service & quality" (button + header); each role still gets
            the section that is genuinely theirs.
       ======================================================================= */
    {
      console.log("\n— §B · owner: no My-numbers button/header; adviser: no Service & quality button/header, but DOES keep My numbers (p4, p2)");
      const owner = await newPage(browser, "p4");
      const errOwner = (owner.__err || []).length;
      await goto(owner, "reports", 2200);
      const ownerState = await owner.evaluate(() => ({
        mineBtn: !!document.getElementById("reports-nav-mine"),
        mineHeadHidden: document.getElementById("rsec-mine").classList.contains("hidden"),
      }));
      ok("§B1 · owner: #reports-nav-mine is absent", !ownerState.mineBtn);
      ok("§B2 · owner: #rsec-mine carries .hidden", ownerState.mineHeadHidden);
      ok("§B · owner: no console errors", noNewErr(owner, errOwner), JSON.stringify(owner.__err));
      await owner.close();

      const adv = await newPage(browser, "p2");
      const errAdv = (adv.__err || []).length;
      await goto(adv, "reports", 2200);
      const advState = await adv.evaluate(() => ({
        qualityBtn: !!document.getElementById("reports-nav-quality"),
        qualityHeadHidden: document.getElementById("rsec-quality").classList.contains("hidden"),
        mineBtn: !!document.getElementById("reports-nav-mine"),
        mineHeadHidden: document.getElementById("rsec-mine").classList.contains("hidden"),
      }));
      ok("§B3 · adviser: #reports-nav-quality is absent", !advState.qualityBtn);
      ok("§B4 · adviser: #rsec-quality carries .hidden", advState.qualityHeadHidden);
      ok("§B5 · adviser: …in contrast, #reports-nav-mine IS present (their own numbers)", advState.mineBtn);
      ok("§B6 · adviser: …and #rsec-mine does NOT carry .hidden", !advState.mineHeadHidden);
      ok("§B · adviser: no console errors", noNewErr(adv, errAdv), JSON.stringify(adv.__err));
      await adv.close();
    }

    /* =======================================================================
       §C · SIX LEDGER DRAWERS — closed by default, correct noun + live
            count, opening reveals renderer content.
       ======================================================================= */
    {
      console.log("\n— §C · six report-ledger drawers: closed by default, summary states the live count, opening reveals content (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "reports", 2200);

      const ledgers = await page.evaluate(() => REPORT_LEDGERS);
      eq("§C0 · REPORT_LEDGERS names exactly the six known drawers", ledgers.map((l) => l[0]),
        ["#report-owed-table", "#report-rateend-table", "#report-nps-list", "#report-ltv", "#report-conveyancer-body", "#report-introducers"]);

      for (const [sel, rowSel, noun] of ledgers) {
        const before = await page.evaluate(({ sel }) => {
          const box = document.querySelector(sel);
          const det = box.closest("details.report-ledger");
          return { detExists: !!det, open: det ? det.open : null, summary: det ? det.querySelector("summary").textContent : null };
        }, { sel });
        ok(`§C1 · ${sel}'s drawer exists`, before.detExists, before);
        ok(`§C2 · ${sel}'s drawer is closed by default`, before.open === false, before);

        const n = await page.$$eval(`${sel} ${rowSel}`, (els) => els.length);
        const wantTail = n ? ` — ${n} ${noun}${n === 1 ? "" : "s"}` : "";
        ok(`§C3 · ${sel}'s summary ends with the live count ("${wantTail || "(none)"}")`,
          (before.summary || "").endsWith(wantTail || (before.summary || "")), { summary: before.summary, wantTail, n });

        if (sel === "#report-nps-list") {
          // R42 — toggleNpsList() opens THIS drawer as a side-effect of revealing the whole panel
          // (the panel itself is opt-in, reached only via the "Avg review score ▾" tile).
          const tile = await page.$("#report-nps-tile");
          ok("§C4 · #report-nps-tile (Avg review score) exists to reveal the NPS panel", !!tile);
          if (tile) {
            await page.click("#report-nps-tile");
            await wait(page, 400);
            const after = await page.evaluate(() => {
              const det = document.getElementById("report-nps-list").closest("details.report-ledger");
              const panel = document.getElementById("report-nps-panel");
              return { open: det.open, panelHidden: panel.classList.contains("hidden"), rows: document.querySelectorAll("#report-nps-list .nps-row").length };
            });
            ok("§C5 · …reveals the panel", !after.panelHidden, after);
            ok("§C6 · …and opens the ledger drawer along with it", after.open === true, after);
            if (n > 0) ok("§C7 · …with the respondent rows actually present", after.rows === n, { rows: after.rows, n });
          }
        } else {
          await page.click(`details.report-ledger:has(${sel}) summary`);
          await wait(page, 300);
          const after = await page.evaluate((sel) => {
            const det = document.querySelector(sel).closest("details.report-ledger");
            return { open: det.open, html: document.querySelector(sel).innerHTML.length };
          }, sel);
          ok(`§C8 · clicking ${sel}'s summary opens the drawer`, after.open === true, after);
          if (n > 0) ok(`§C9 · …and the renderer's content is present inside it`, after.html > 0, after);
        }
      }

      ok("§C · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §D · #owed-csv-btn — usable with its drawer closed, and stays closed.
       ======================================================================= */
    {
      console.log("\n— §D · #owed-csv-btn exports with the ledger drawer closed, and leaves it closed (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "reports", 2200);
      await armCsvCapture(page);

      const before = await page.evaluate(() => document.getElementById("report-owed-table").closest("details.report-ledger").open);
      ok("§D1 · the money-owed ledger drawer starts closed", before === false, before);

      await resetCsvCapture(page);
      await page.click("#owed-csv-btn");
      await wait(page, 500);
      const csvName = await readCsvName(page);
      const csvText = await readCsv(page);
      ok("§D2 · clicking the CSV button with the drawer closed still produces a file", !!csvName && !!csvText, { csvName, hasText: !!csvText });
      const todayISO = await page.evaluate(() => new Date().toISOString().slice(0, 10));
      ok("§D3 · …named for today's date", (csvName || "").startsWith(`money-owed-`) && (csvName || "").includes(todayISO), csvName);
      const toast = await toastText(page);
      ok("§D4 · …and confirms with a toast naming what was exported", /Exported/.test(toast), toast);

      const after = await page.evaluate(() => document.getElementById("report-owed-table").closest("details.report-ledger").open);
      eq("§D5 · the drawer is still closed — the export never opened it", after, false);

      ok("§D · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §E · #report-basis-legend — verbatim, exact.
       ======================================================================= */
    {
      console.log("\n— §E · #report-basis-legend is byte-for-byte unchanged (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "reports", 2200);
      const legend = await page.$eval("#report-basis-legend", (e) => ({ tag: e.tagName, text: e.textContent }));
      eq("§E1 · <p id=\"report-basis-legend\"> tag unchanged", legend.tag, "P");
      eq("§E2 · its text is exactly the R5-17 legend, verbatim", legend.text, BASIS_LEGEND_TEXT);
      ok("§E · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §F · #month-legend / #report-owed-basis — the new, trimmed endings.
       ======================================================================= */
    {
      console.log("\n— §F · #month-legend / #report-owed-basis carry R42's new endings, the deleted repeats are gone (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "reports", 2200);

      const monthLegend = await page.$eval("#month-legend", (e) => e.textContent);
      eq("§F1 · #month-legend is exactly the trimmed text", monthLegend, MONTH_LEGEND_TEXT);
      ok("§F2 · …and does not carry the deleted basis-repeat tail", !/Fees banked \(paid\)/.test(monthLegend) && !/is the fee value earned/.test(monthLegend), monthLegend);

      const owedBasis = await page.$eval("#report-owed-basis", (e) => e.textContent.trim());
      ok("§F3 · #report-owed-basis ends with the new, shorter basis line", owedBasis.endsWith(OWED_BASIS_ENDING), owedBasis);
      ok("§F4 · …and no longer says 'the same basis as … above'", !/the same basis as/.test(owedBasis), owedBasis);
      ok("§F5 · …nor recaps 'Fees banked' by name", !/Fees banked/.test(owedBasis), owedBasis);

      ok("§F · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §G · ZERO ⬇ ANYWHERE RENDERED; the three CSV controls all carry ⭳.
       ======================================================================= */
    {
      console.log("\n— §G · zero ⬇ glyphs anywhere on Reports/Pipeline/Clients; #owed-csv-btn/#csv-btn/#client-bulk-csv all carry ⭳ (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      await goto(page, "reports", 2000);
      const reportsHas = await page.evaluate(() => document.getElementById("page-reports").innerHTML.includes("⬇"));
      ok("§G1 · no ⬇ on Reports", !reportsHas);
      const owedTxt = await page.$eval("#owed-csv-btn", (e) => e.textContent.trim());
      eq("§G2 · #owed-csv-btn reads \"⭳ CSV\"", owedTxt, "⭳ CSV");

      await goto(page, "pipeline", 2000);
      const pipeHas = await page.evaluate(() => document.getElementById("page-pipeline") ? document.getElementById("page-pipeline").innerHTML.includes("⬇") : document.body.innerHTML.includes("⬇"));
      ok("§G3 · no ⬇ on Pipeline", !pipeHas);
      const csvBtn = await page.$("#csv-btn");
      if (csvBtn) {
        const csvTxt = await page.$eval("#csv-btn", (e) => e.textContent.trim());
        eq("§G4 · #csv-btn reads \"⭳ Download CSV\"", csvTxt, "⭳ Download CSV");
      } else {
        ok("§G4 · #csv-btn not present on this render (empty pipeline) — skipped, not failed", true);
      }

      await goto(page, "clients", 2000);
      const clientsHas = await page.evaluate(() => document.getElementById("page-clients") ? document.getElementById("page-clients").innerHTML.includes("⬇") : document.body.innerHTML.includes("⬇"));
      ok("§G5 · no ⬇ on Clients", !clientsHas);
      const bulkCsvTxt = await page.$eval("#client-bulk-csv", (e) => e.textContent.trim()).catch(() => null);
      if (bulkCsvTxt != null) eq("§G6 · #client-bulk-csv reads \"⭳ Export CSV\"", bulkCsvTxt, "⭳ Export CSV");
      else ok("§G6 · #client-bulk-csv not in DOM on this render — skipped, not failed", true);

      ok("§G · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §H · DOC-CHASE — the one-sentence note interpolates the setting; ⓘ
            Full rules opens to the original text with the same interpolation.
       ======================================================================= */
    {
      console.log("\n— §H · #doc-chase-note: one sentence + ⓘ Full rules, both interpolating doc_chase_days (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "settings", 2200);

      const tag = await page.$eval("#doc-chase-note", (e) => e.tagName);
      eq("§H1 · #doc-chase-note is now a <div>", tag, "DIV");

      await page.fill('input[name="doc_chase_days"]', "9");
      await page.click("#save-settings-btn");
      await wait(page, 700);
      await page.evaluate(() => window.renderSettings());
      await wait(page, 500);

      const shortP = await page.evaluate(() => document.querySelector("#doc-chase-note > p").textContent);
      ok("§H2 · the visible sentence interpolates the saved setting (\"every 9 days\")", /every 9 days/.test(shortP), shortP);
      ok("§H3 · …and is a single, short sentence (no full-rules prose leaked out)", shortP.length < 200 && !/Enquiry through Exchange/.test(shortP), shortP);

      const moreOpen = await page.$eval("#doc-chase-more", (e) => e.open);
      eq("§H4 · #doc-chase-more starts closed", moreOpen, false);
      const summaryTxt = await page.$eval("#doc-chase-more summary", (e) => e.textContent.trim());
      eq("§H5 · its summary reads \"ⓘ Full rules\"", summaryTxt, "ⓘ Full rules");

      await page.click("#doc-chase-more summary");
      await wait(page, 300);
      const moreOpenAfter = await page.$eval("#doc-chase-more", (e) => e.open);
      ok("§H6 · clicking it opens the full rules", moreOpenAfter);
      const fullTxt = await page.$eval("#doc-chase-more p", (e) => e.textContent);
      ok("§H7 · …carrying the SAME interpolation (\"every 9 days\")", /every 9 days/.test(fullTxt), fullTxt);
      ok("§H8 · …and the original full rules (the live-stage widening, the checklist requirement, the sender requirement)", /Enquiry through Exchange/.test(fullTxt) && /Requires email sending to be set up/.test(fullTxt), fullTxt);
      // #doc-chase-note keeps its id, and textContent traverses into a closed <details> too, so a
      // reader of the whole note (open or not) always sees both interpolations at once.
      const wholeNoteTxt = await page.$eval("#doc-chase-note", (e) => e.textContent);
      const nineCount = (wholeNoteTxt.match(/every 9 days/g) || []).length;
      eq("§H9 · #doc-chase-note's full textContent carries the interpolation exactly twice (sentence + full rules)", nineCount, 2);

      ok("§H · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §I · EMAILS EXPLAINER — short opening paragraph, closed by default,
            opening reveals the R8/R9 notes verbatim; chips/list unaffected.
       ======================================================================= */
    {
      console.log("\n— §I · Emails: short opening paragraph, #emails-explainer closed by default, opens to the verbatim R8/R9 notes, chips/list unaffected (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "emails", 2200);

      const firstP = await page.$eval("#page-emails > p.panel-sub", (e) => e.textContent);
      eq("§I1 · the opening paragraph is exactly the two-sentence version", firstP, EMAILS_FIRST_P_TEXT);
      ok("§I2 · …i.e. exactly two sentences", firstP.split(". ").length === 2, firstP);

      const tag = await page.$eval("#emails-explainer", (e) => e.tagName);
      eq("§I3 · #emails-explainer is a <details>", tag, "DETAILS");
      const openBefore = await page.$eval("#emails-explainer", (e) => e.open);
      eq("§I4 · …closed by default", openBefore, false);

      const chipsBefore = await page.$$eval("#em-filters [role], #em-filters button, #em-filters .seg-btn", (els) => els.length).catch(() => 0);
      const chipsBeforeAlt = chipsBefore || (await page.$eval("#em-filters", (e) => e.children.length));
      const listRowsBefore = await page.$eval("#email-list", (e) => e.children.length);
      ok("§I5 · the status chips are already populated before the explainer is touched", chipsBeforeAlt > 0, chipsBeforeAlt);
      ok("§I6 · the email list is already populated too", listRowsBefore > 0, listRowsBefore);

      await page.click("#emails-explainer summary");
      await wait(page, 300);
      const openAfter = await page.$eval("#emails-explainer", (e) => e.open);
      ok("§I7 · clicking the summary opens it", openAfter);

      const r8 = await page.$eval("#emails-r8-note", (e) => e.textContent);
      eq("§I8 · #emails-r8-note is verbatim, exact", r8, EMAILS_R8_NOTE_TEXT);
      const r9 = await page.$eval("#emails-r9-note", (e) => e.textContent);
      eq("§I9 · #emails-r9-note is verbatim, exact", r9, EMAILS_R9_NOTE_TEXT);

      const chipsAfter = await page.$eval("#em-filters", (e) => e.children.length);
      const listRowsAfter = await page.$eval("#email-list", (e) => e.children.length);
      eq("§I10 · the status chips are unaffected by opening the explainer", chipsAfter, chipsBeforeAlt);
      eq("§I11 · the email list is unaffected too", listRowsAfter, listRowsBefore);

      ok("§I · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §J · DATA HEALTH — the clean-tile fold.
       ======================================================================= */
    {
      console.log("\n— §J1 · a genuinely zero-count fault tile is dh-clean + hidden; the toggle reveals it, flips label + aria-expanded, works from Enter (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "data", 2200);

      // Fixture sanity — read live which tiles are clean rather than assume: the base fixture is
      // deliberately shaped so #dh-tile-deadbook is the ONE fault tile sitting at zero (see the
      // R42 known-broken repair to tests/r27.js §A, which hits this exact tile the exact same way).
      const cleanIds = await page.$$eval("#dh-kpi-row .kpi.dh-clean", (els) => els.map((e) => e.id));
      eq("§J1a · fixture sanity — exactly one clean fault tile, #dh-tile-deadbook", cleanIds, ["dh-tile-deadbook"]);

      const tileVisBefore = await page.$eval("#dh-tile-deadbook", (e) => e.offsetParent !== null);
      ok("§J1b · #dh-tile-deadbook starts hidden (display:none via .dh-clean)", !tileVisBefore);

      const toggle = await page.$("#dh-clean-toggle");
      ok("§J1c · #dh-clean-toggle exists", !!toggle);
      const ariaBefore = await page.$eval("#dh-clean-toggle", (e) => e.getAttribute("aria-expanded"));
      eq("§J1d · …starts aria-expanded=false", ariaBefore, "false");
      const lblBefore = await page.$eval("#dh-clean-toggle-lbl", (e) => e.textContent);
      eq("§J1e · …labelled \"✓ 1 check clean ▸\"", lblBefore, "✓ 1 check clean ▸");

      await page.click("#dh-clean-toggle");
      await wait(page, 250);
      const ariaAfter = await page.$eval("#dh-clean-toggle", (e) => e.getAttribute("aria-expanded"));
      eq("§J1f · clicking flips aria-expanded to true", ariaAfter, "true");
      const lblAfter = await page.$eval("#dh-clean-toggle-lbl", (e) => e.textContent);
      eq("§J1g · …and the label flips to \"▾ hide\"", lblAfter, "▾ hide");
      const tileVisAfter = await page.$eval("#dh-tile-deadbook", (e) => e.offsetParent !== null);
      ok("§J1h · #dh-tile-deadbook is now visible", tileVisAfter);
      const rowShowClean = await page.$eval("#dh-kpi-row", (e) => e.classList.contains("dh-show-clean"));
      ok("§J1i · #dh-kpi-row carries .dh-show-clean while revealed", rowShowClean);

      // Collapse again by keyboard — focus + Enter, not a click.
      await page.focus("#dh-clean-toggle");
      await page.keyboard.press("Enter");
      await wait(page, 250);
      const ariaCollapsed = await page.$eval("#dh-clean-toggle", (e) => e.getAttribute("aria-expanded"));
      eq("§J1j · Enter on the focused toggle collapses it again (aria-expanded=false)", ariaCollapsed, "false");
      const lblCollapsed = await page.$eval("#dh-clean-toggle-lbl", (e) => e.textContent);
      eq("§J1k · …and the label reverts to \"✓ 1 check clean ▸\"", lblCollapsed, "✓ 1 check clean ▸");
      const tileVisCollapsed = await page.$eval("#dh-tile-deadbook", (e) => e.offsetParent !== null);
      ok("§J1l · #dh-tile-deadbook is hidden again", !tileVisCollapsed);

      ok("§J1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §J2 · a NON-zero fault tile is never hidden, toggle open or closed (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "data", 2200);

      const before = await page.evaluate(() => {
        const e = document.getElementById("dh-tile-milestone");
        const num = Number(e.querySelector(".num").textContent);
        return { clean: e.classList.contains("dh-clean"), visible: e.offsetParent !== null, num };
      });
      ok("§J2a · fixture sanity — #dh-tile-milestone's own count is genuinely > 0", before.num > 0, before.num);
      ok("§J2b · …so it carries no dh-clean class", !before.clean, before);
      ok("§J2c · …and is visible before the toggle is ever touched", before.visible, before);

      await page.click("#dh-clean-toggle");
      await wait(page, 250);
      const after = await page.evaluate(() => {
        const e = document.getElementById("dh-tile-milestone");
        return { clean: e.classList.contains("dh-clean"), visible: e.offsetParent !== null };
      });
      ok("§J2d · …still no dh-clean class with the toggle open", !after.clean, after);
      ok("§J2e · …still visible with the toggle open", after.visible, after);

      ok("§J2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §J3 · the four informational tiles are never hidden, even when their own count is genuinely 0 (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      const nClients = await wipeToZeroInformational(page);
      ok("§J3 · fixture sanity — clients survive the wipe (only cases were deleted)", nClients > 0, nClients);
      await goto(page, "data", 2200);

      const INFO_IDS = ["dh-tile-waitingdocs", "dh-tile-sharedprop", "dh-tile-vulnerable", "dh-tile-suppressed"];
      for (const id of INFO_IDS) {
        const info = await page.evaluate((id) => {
          const e = document.getElementById(id);
          if (!e) return null;
          return { num: Number(e.querySelector(".num").textContent), clean: e.classList.contains("dh-clean"), visible: e.offsetParent !== null };
        }, id);
        ok(`§J3a · #${id} exists`, !!info, info);
        if (info) {
          eq(`§J3b · #${id}'s own count is genuinely 0`, info.num, 0);
          ok(`§J3c · #${id} carries no dh-clean class at count 0`, !info.clean, info);
          ok(`§J3d · #${id} is still visible at count 0`, info.visible, info);
        }
      }
      ok("§J3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §J4 · #dh-readiness's item list agrees exactly with which of the 11 dhReadinessChecks tiles are (and are not) folded away (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "data", 2200);

      const READINESS_TILE_IDS = ["dh-tile-email", "dh-tile-phone", "dh-tile-both", "dh-tile-invalid-email",
        "dh-tile-invalid-phone", "dh-tile-unassigned", "dh-tile-nofee", "dh-tile-rateend",
        "dh-tile-nocompleted", "dh-tile-milestone", "dh-tile-deadbook"];
      const cleanStates = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.getElementById(id).classList.contains("dh-clean")])), READINESS_TILE_IDS);
      const items = await readinessItems(page);
      const listedIds = new Set(items.map((it) => it.tileId));

      for (const id of READINESS_TILE_IDS) {
        const clean = cleanStates[id];
        const listed = listedIds.has(id);
        ok(`§J4 · ${id}: clean (folded) ⇔ absent from #dh-readiness — got clean=${clean}, listed=${listed}`, clean !== listed, { id, clean, listed });
      }
      const nonCleanCount = READINESS_TILE_IDS.filter((id) => !cleanStates[id]).length;
      eq("§J4b · #dh-readiness lists exactly as many items as there are non-clean readiness tiles", items.length, nonCleanCount);

      ok("§J4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §J5 · the toggle is absent outright once nothing is left clean (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "data", 2200);

      const cleanBefore = await page.$$eval("#dh-kpi-row .kpi.dh-clean", (els) => els.map((e) => e.id));
      eq("§J5a · fixture sanity — the one clean tile is #dh-tile-deadbook, same as §J1", cleanBefore, ["dh-tile-deadbook"]);
      ok("§J5b · fixture sanity — the toggle exists while something is clean", !!(await page.$("#dh-clean-toggle")));

      // Seed exactly one deadBook-matching case — turns the sole clean tile non-clean, leaving
      // dhCleanN at 0.
      await insertDeadbookCase(page, 90);
      await goto(page, "data", 2200);

      const cleanAfter = await page.$$eval("#dh-kpi-row .kpi.dh-clean", (els) => els.map((e) => e.id));
      eq("§J5c · no tile is clean any more", cleanAfter, []);
      const toggleAfter = await page.$("#dh-clean-toggle");
      ok("§J5d · #dh-clean-toggle is absent outright", !toggleAfter);

      ok("§J5 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r42: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
