#!/usr/bin/env node
/* =============================================================================
   tests/r33.js — acceptance tests for ROUND 33: a role-aware GROUPED sidebar
   + five small, independent quick wins (admin/app.js + admin/index.html +
   admin/admin.css only, no schema).

   What R33 shipped (build agent's verified summary):
     - `#topnav` regrouped under `.nav-group-head` labels (Work/Book/Money), plus
       a collapsible "Firm" group (`#nav-firm-group`: Emails/Import/Data health/
       Settings), toggled by `#nav-firm-toggle` (aria-expanded). Default state is
       a ROLE judgement, computed once at sign-in (applyNavRole(), app.js ~L4103):
       COLLAPSED for an adviser (p2/p3), EXPANDED for admin/owner (p1/p4) — unless
       the operator has already told us otherwise, in which case localStorage
       `nx_nav_firm` ("open"/"closed") beats the role default in BOTH directions.
       `nav(page)` (app.js ~L4374) additionally AUTO-EXPANDS the group — without
       writing to `nx_nav_firm` — whenever it lands on a page inside it, so the
       active tab is never hidden by a folded group; this expansion does not
       survive a reload once the operator has navigated away from that page (a
       reload while still ON that page's hash re-triggers the same auto-expand,
       which is why this suite navigates AWAY before reloading to prove the
       auto-expand itself was never persisted). All 12 `button[data-page]`s are
       unchanged and still live inside `#topnav` (R38 — this is now 13: the
       Retention nav button landed in the Book group, between Protection and
       the Money group heading; nothing about the grouping/collapse machinery
       this suite proves changed shape, so the count below was simply bumped
       by one — see the R38 non-masking repair note in HARNESS.md).
     - Diagnostics RELOCATED from Reports to Settings: `#report-diag-section`
       (and everything inside it — CSV/copy/clear/health, `#diag-error-table`,
       `#report-diag-persist-clear`, `#diag-persist-table`) now lives inside a
       `<details id="diag-details">` at the bottom of Settings, collapsed by
       default and hidden outright for an adviser (same `isAdminOrOwner()` gate
       it always had). `renderDiagnostics(null)` is now called from
       `renderSettings()` — with no Reports read behind it, so the "Records
       loaded" fragment is omitted rather than reported as a fake zero.
     - `#new-note` (the case-modal note box) is now a `<textarea>` — Enter still
       submits (Shift+Enter still newlines, unchanged binding), so no behaviour
       here is new beyond the retagging.
     - A new Settings field, `name="doc_chase_days"` ("Document chase interval"),
       finally gives an owner a way to SET the number `docChaseDays()` already
       read (`settings.doc_chase_days ?? 3`). Blank is a legitimate answer and
       means the 3-day default. Non-numeric input is blocked by the existing
       `SETTING_NUMERIC_FIELDS` machinery (drops the key from the upsert; the
       previously-saved value stands) — this suite doesn't re-prove that generic
       machinery (already covered elsewhere), only that THIS field is wired to it
       and that blank really does read back as 3 in the prose beneath it.
     - Import preview "rules" paragraph is now foldable: `#imp-review-blurb` +
       `#imp-blurb-toggle` ("Got it — collapse" / "Review rules ▸"), persisted
       via localStorage `nx_import_blurb` ("seen") — read once, folded on every
       later Analyse, re-openable per-session without clearing the flag.
     - `#diary-staff` and `#client-adviser`'s first option LABEL is now
       "All advisers" (matching `#board-adviser`, unchanged since R31) — the
       VALUE stays "all" and every branch that tests for it is untouched.

   §A — SIDEBAR GROUPING (adviser p2, owner p4). Collapsed-by-default for an
        adviser with its 4 buttons genuinely not visible; toggle opens it and
        persists that choice across a reload; clearing the key reverts to the
        role default; `window.nav('settings')` from collapsed auto-expands the
        group (settings tab gets .active + aria-current="page") WITHOUT
        persisting — proved by navigating away and reloading. Owner starts
        expanded, with Monday money visible. All 13 nav buttons present
        (R38 — was 12; the new Retention button in the Book group is the
        13th; see tests/r38.js for its own dedicated coverage).
   §B — DIAGNOSTICS RELOCATION. Owner: `#diag-details` present+collapsed on
        Settings; opening it renders `#report-diag-section` + both tables;
        Reports no longer nests `#report-diag-section` at all. Adviser:
        `#diag-details` stays hidden.
   §C — QUICK WINS: `#new-note` is a TEXTAREA and a real submit works; the new
        `doc_chase_days` field round-trips (5 → 5, blank → the note's prose
        reads "3"); the import blurb shows on a real Analyse, folds on click,
        stays folded on a second Analyse (persisted); `#diary-staff` and
        `#client-adviser`'s first option read exactly "All advisers".
   §D — no NEW console errors anywhere above (checked per-section, the same
        `page.__err` convention every other suite in this harness uses).

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r33.js
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
const clearNavFirm = (page) => page.evaluate(() => { try { localStorage.removeItem("nx_nav_firm"); } catch (e) { /* ignore */ } });
const clearImportBlurb = (page) => page.evaluate(() => { try { localStorage.removeItem("nx_import_blurb"); } catch (e) { /* ignore */ } });
const firmGroupCollapsed = (page) => page.evaluate(() => document.getElementById("nav-firm-group").classList.contains("collapsed"));

const CSV = `Name,Email,Phone,Stage,Lender,Rate,Fee
Duncan Armitage,duncan.armitage@example.com,07700 900102,offer,Halifax,4.29,495`;

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       A · SIDEBAR GROUPING — adviser (p2) default collapsed, toggle/persist,
           role default restored, auto-expand-not-persisted
       ======================================================================= */
    {
      console.log("\n— A1 · Firm group collapsed by default for an adviser (p2), group heads present");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await clearNavFirm(page);
      await page.reload();
      await wait(page, SETTLE);

      const state = await page.evaluate(() => {
        const g = document.getElementById("nav-firm-group");
        const btns = [...g.querySelectorAll("button[data-page]")].map((b) => ({ page: b.dataset.page, visible: b.offsetParent !== null }));
        const heads = [...document.querySelectorAll(".nav-group-head")].map((h) => h.textContent.trim());
        return { collapsed: g.classList.contains("collapsed"), btns, heads, toggleExpanded: document.getElementById("nav-firm-toggle").getAttribute("aria-expanded") };
      });
      ok("A1a · #nav-firm-group has .collapsed for an adviser by default", state.collapsed, JSON.stringify(state));
      eq("A1b · #nav-firm-toggle reports aria-expanded=\"false\"", state.toggleExpanded, "false");
      const pages = state.btns.map((b) => b.page).sort();
      eq("A1c · the collapsed group's 4 buttons are emails/import/data/settings", pages, ["data", "emails", "import", "settings"]);
      ok("A1d · none of the group's 4 buttons are actually visible while collapsed", state.btns.every((b) => !b.visible), JSON.stringify(state.btns));
      eq("A1e · the three group-head labels read Work/Book/Money, in order", state.heads, ["Work", "Book", "Money"]);

      console.log("\n— A2 · toggling opens the group and persists across a reload");
      await page.click("#nav-firm-toggle");
      await wait(page, 300);
      const afterClick = await page.evaluate(() => ({
        collapsed: document.getElementById("nav-firm-group").classList.contains("collapsed"),
        expanded: document.getElementById("nav-firm-toggle").getAttribute("aria-expanded"),
        visible: [...document.querySelectorAll("#nav-firm-group button[data-page]")].every((b) => b.offsetParent !== null),
        ls: localStorage.getItem("nx_nav_firm"),
      }));
      ok("A2a · clicking the toggle un-collapses the group", !afterClick.collapsed, JSON.stringify(afterClick));
      eq("A2b · toggle now reports aria-expanded=\"true\"", afterClick.expanded, "true");
      ok("A2c · the 4 buttons are now genuinely visible", afterClick.visible, JSON.stringify(afterClick));
      eq("A2d · the choice is written to localStorage as \"open\"", afterClick.ls, "open");

      await page.reload();
      await wait(page, SETTLE);
      ok("A2e · after a reload the group is STILL open (persisted choice beats the role default)", !(await firmGroupCollapsed(page)));

      console.log("\n— A3 · clearing the stored choice reverts to the (adviser) role default");
      await clearNavFirm(page);
      await page.reload();
      await wait(page, SETTLE);
      ok("A3 · clearing nx_nav_firm + reload restores the collapsed adviser default", await firmGroupCollapsed(page));

      console.log("\n— A4 · window.nav('settings') from collapsed auto-expands, WITHOUT persisting");
      await page.evaluate(() => window.nav("settings"));
      await wait(page, 500);
      const autoExpand = await page.evaluate(() => {
        const btn = document.querySelector('#topnav button[data-page="settings"]');
        return {
          collapsed: document.getElementById("nav-firm-group").classList.contains("collapsed"),
          active: btn.classList.contains("active"),
          ariaCurrent: btn.getAttribute("aria-current"),
          ls: localStorage.getItem("nx_nav_firm"),
        };
      });
      ok("A4a · landing on Settings auto-expands the (collapsed) Firm group", !autoExpand.collapsed, JSON.stringify(autoExpand));
      ok("A4b · the Settings tab carries .active", autoExpand.active, JSON.stringify(autoExpand));
      eq("A4c · …and aria-current=\"page\"", autoExpand.ariaCurrent, "page");
      eq("A4d · the auto-expand did NOT write to localStorage", autoExpand.ls, null);

      // Navigate AWAY first — reloading while still sitting on #settings would re-trigger the
      // very same auto-expand nav() just did, which would prove nothing about persistence either
      // way. Navigating off it first, then reloading, is what actually isolates "was this
      // remembered" from "did I just land somewhere that auto-expands".
      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, 300);
      await page.reload();
      await wait(page, SETTLE);
      ok("A4e · after navigating away + reloading, the group is collapsed again (the auto-expand was never persisted)", await firmGroupCollapsed(page));

      ok("A · no console errors (p2)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— A5 · owner (p4): Firm group expanded by default, Monday money visible, 13 nav buttons total (R38 — was 12; +Retention)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNavFirm(page);
      await page.reload();
      await wait(page, SETTLE);

      ok("A5a · #nav-firm-group is NOT collapsed for an owner by default", !(await firmGroupCollapsed(page)));
      const navMoneyVisible = await page.evaluate(() => document.getElementById("nav-money").offsetParent !== null);
      ok("A5b · #nav-money (Monday money) is visible for the owner", navMoneyVisible);
      const totalBtns = await page.evaluate(() => document.querySelectorAll("#topnav button[data-page]").length);
      eq("A5c · #topnav still has all 13 data-page buttons (R38 added Retention to the Book group)", totalBtns, 13);
      const allInsideTopnav = await page.evaluate(() =>
        [...document.querySelectorAll("button[data-page]")].every((b) => document.getElementById("topnav").contains(b)));
      ok("A5d · every data-page button lives inside #topnav", allInsideTopnav);

      ok("A5 · no console errors (p4)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B · DIAGNOSTICS RELOCATION — Settings (owner), hidden (adviser),
           genuinely gone from Reports
       ======================================================================= */
    {
      console.log("\n— B1 · #diag-details on Settings: present, collapsed, opens onto the real panel (p4, owner)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "settings");

      const before = await page.evaluate(() => {
        const det = document.getElementById("diag-details");
        return det ? { hidden: det.classList.contains("hidden"), open: det.hasAttribute("open") } : null;
      });
      ok("B1a · #diag-details exists on Settings", !!before, JSON.stringify(before));
      ok("B1b · #diag-details is NOT hidden for the owner", before && !before.hidden, JSON.stringify(before));
      ok("B1c · #diag-details starts collapsed (no open attribute)", before && !before.open, JSON.stringify(before));

      await page.evaluate(() => document.getElementById("diag-details").setAttribute("open", ""));
      await wait(page, 400);
      const opened = await page.evaluate(() => {
        const sec = document.getElementById("report-diag-section");
        return {
          secHidden: sec ? sec.classList.contains("hidden") : null,
          secVisible: sec ? sec.offsetParent !== null : false,
          errTable: !!document.getElementById("diag-error-table"),
          persistTable: !!document.getElementById("diag-persist-table"),
          clearBtn: !!document.getElementById("report-diag-persist-clear"),
        };
      });
      ok("B1d · opening the details reveals #report-diag-section (not .hidden)", opened.secHidden === false, JSON.stringify(opened));
      ok("B1e · #report-diag-section is actually visible on screen", opened.secVisible, JSON.stringify(opened));
      ok("B1f · #diag-error-table (session log) renders inside it", opened.errTable, JSON.stringify(opened));
      ok("B1g · #diag-persist-table (cross-session log) renders inside it", opened.persistTable, JSON.stringify(opened));
      ok("B1h · #report-diag-persist-clear is present", opened.clearBtn, JSON.stringify(opened));

      console.log("\n— B2 · Reports no longer nests #report-diag-section at all (p4)");
      await goto(page, "reports");
      const onReports = await page.evaluate(() => !!document.querySelector("#page-reports #report-diag-section"));
      ok("B2 · #report-diag-section is not nested inside #page-reports", !onReports);

      ok("B · no console errors (p4)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— B3 · #diag-details stays hidden on Settings for an adviser (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      await goto(page, "settings");
      const hidden = await page.evaluate(() => document.getElementById("diag-details")?.classList.contains("hidden"));
      ok("B3 · #diag-details is hidden for an adviser", hidden === true);
      ok("B · no console errors (p2)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C · QUICK WINS
       ======================================================================= */
    {
      console.log("\n— C1 · #new-note is a TEXTAREA and a real note submits (p4, owner)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await page.evaluate(() => window.openCase("ca017"));
      await wait(page, 1000);
      const tag = await page.evaluate(() => document.getElementById("new-note")?.tagName);
      eq("C1a · #new-note is a <textarea>", tag, "TEXTAREA");
      const NOTE_TEXT = "r33 quick-win probe note " + Date.now();
      await page.fill("#new-note", NOTE_TEXT);
      await page.click("#add-note-btn");
      await wait(page, 600);
      // R40 — #notes-list is gone; the note now lands in the unified History timeline at
      // #case-events-list (as a .tl-row), so the presence check moves there.
      const submitted = await page.evaluate((t) => document.getElementById("case-events-list").textContent.includes(t), NOTE_TEXT);
      ok("C1b · the typed note appears in #case-events-list after Add", submitted);
      const cleared = await page.$eval("#new-note", (e) => e.value);
      eq("C1c · the textarea clears itself after a successful submit", cleared, "");
      ok("C1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.evaluate(() => window.closeModal && window.closeModal());
      await page.close();
    }

    {
      console.log("\n— C2 · Settings doc_chase_days round-trips: 5 → 5, blank → prose reads 3 (p4, owner)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "settings");

      const inputExists = await page.$("input[name=\"doc_chase_days\"]");
      ok("C2a · the Document chase interval field is present", !!inputExists);

      await page.fill('input[name="doc_chase_days"]', "5");
      await page.click("#save-settings-btn");
      await wait(page, 700);
      await page.evaluate(() => window.renderSettings());
      await wait(page, 400);
      const val5 = await page.$eval('input[name="doc_chase_days"]', (e) => e.value);
      const note5 = await page.$eval("#doc-chase-note", (e) => e.textContent);
      eq("C2b · saving \"5\" round-trips to the input on re-render", val5, "5");
      ok("C2c · the prose beneath now reads \"every 5 days\"", /every 5 days/.test(note5), note5);

      await page.fill('input[name="doc_chase_days"]', "");
      await page.click("#save-settings-btn");
      await wait(page, 700);
      await page.evaluate(() => window.renderSettings());
      await wait(page, 400);
      const noteBlank = await page.$eval("#doc-chase-note", (e) => e.textContent);
      ok("C2d · saving blank makes the prose read the 3-day default", /every 3 days/.test(noteBlank), noteBlank);

      ok("C2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— C3 · import preview blurb: shown on Analyse, folds on click, stays folded on re-Analyse (p4, owner)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearImportBlurb(page);
      await goto(page, "import");

      await page.fill("#import-text", CSV);
      await page.click("#analyse-btn");
      await wait(page, 1200);
      const before = await page.evaluate(() => {
        const p = document.getElementById("imp-review-blurb");
        const btn = document.getElementById("imp-blurb-toggle");
        return { hidden: p && p.classList.contains("hidden"), btnText: btn && btn.textContent, ariaExpanded: btn && btn.getAttribute("aria-expanded") };
      });
      ok("C3a · #imp-review-blurb is visible on a fresh Analyse", before.hidden === false, JSON.stringify(before));
      eq("C3b · #imp-blurb-toggle reads \"Got it — collapse\"", before.btnText, "Got it — collapse");
      eq("C3c · #imp-blurb-toggle reports aria-expanded=\"true\"", before.ariaExpanded, "true");

      await page.click("#imp-blurb-toggle");
      await wait(page, 300);
      const afterToggle = await page.evaluate(() => ({
        hidden: document.getElementById("imp-review-blurb").classList.contains("hidden"),
        btnText: document.getElementById("imp-blurb-toggle").textContent,
        ariaExpanded: document.getElementById("imp-blurb-toggle").getAttribute("aria-expanded"),
        ls: localStorage.getItem("nx_import_blurb"),
      }));
      ok("C3d · clicking the toggle collapses the blurb", afterToggle.hidden, JSON.stringify(afterToggle));
      eq("C3e · the toggle now reads \"Review rules ▸\"", afterToggle.btnText, "Review rules ▸");
      eq("C3f · …and aria-expanded=\"false\"", afterToggle.ariaExpanded, "false");
      eq("C3g · the choice is persisted to localStorage.nx_import_blurb", afterToggle.ls, "seen");

      await page.fill("#import-text", CSV);
      await page.click("#analyse-btn");
      await wait(page, 1200);
      const afterReanalyse = await page.evaluate(() => document.getElementById("imp-review-blurb").classList.contains("hidden"));
      ok("C3h · the blurb stays folded on a second Analyse (the fold was remembered)", afterReanalyse);

      ok("C3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— C4 · #diary-staff / #client-adviser first option reads \"All advisers\" (p4, owner)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "diary");
      const diaryFirst = await page.evaluate(() => document.getElementById("diary-staff").options[0].textContent);
      eq("C4a · #diary-staff's first option reads exactly \"All advisers\"", diaryFirst, "All advisers");

      await goto(page, "clients", 1500);
      const clientFirst = await page.evaluate(() => document.getElementById("client-adviser").options[0].textContent);
      eq("C4b · #client-adviser's first option reads exactly \"All advisers\"", clientFirst, "All advisers");

      ok("C4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r33: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
