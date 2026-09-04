#!/usr/bin/env node
/* =============================================================================
   tests/r5_batch9.js — acceptance tests for PLAN-R5 Batch 9
   ("STRETCH: Diary day view", R5-31 + Wayne's wish)

   One block per plan item:
     1. Month/Day toggle exists, defaults to Month, and switches the visible container.
     2. Day view: two overlapping appointments (the seeded 10:00 clash for p2, today)
        render side-by-side, both flagged with the ⚠ clash marker.
     3. Day view's adviser filter defaults to the signed-in adviser (ME.id), while
        Month's own "Everyone" default is untouched — and the month grid is
        pixel-identical (same innerHTML) after toggling to Day and back to Month.
     4. Click block → openAppt(existing id). Click an empty slot → new appointment
        prefilled with a time derived from the click position.
     5. Persisted per user via lsSet — a fresh load after switching to Day stays on Day.
     6. No week view was added this round (no week-view affordance in the DOM).

   Run:  node /root/nx/tests/r5_batch9.js  (expects a static server on 8099;
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
  page.__dialogAnswer = "accept";
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    if (page.__dialogAnswer === "dismiss") await d.dismiss();
    else await d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const gotoDiary = async (page) => {
  await page.click('[data-page="diary"]');
  await page.waitForTimeout(1000);
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
       1 · Toggle exists, defaults to Month, Day container starts hidden
       =================================================================== */
    console.log("\n— Month/Day toggle (p2 Wayne, adviser)");
    {
      const page = await newPage(browser, "p2");
      // R34 · W2 — an adviser's Month AND Day now both open on their own id by default (see
      // tests/r34.js §C), so Month's own "Everyone" default this block exists to prove is no
      // longer what a fresh load lands on. Pre-seeding the stored filter as "all" restores the
      // ORIGINAL scenario this check guards — Month keeping its own remembered value untouched by
      // Day's separate default — without pretending R34 didn't change the plain default.
      // PATCHED R82 · A4 — nx_diary_staff is namespaced per signed-in user now (the bare key is
      // dropped at sign-in), so the pre-seed has to be written under p2's own key to survive.
      await page.evaluate(() => { try { localStorage.setItem("nx_diary_staff_p2", "all"); } catch (e) { /* ignore */ } });
      await page.reload();
      await page.waitForTimeout(SETTLE);
      await gotoDiary(page);

      /* R75 · A1 — THE DESKTOP DEFAULT IS WEEK NOW (owner decision, 28 Aug 2026: "the diary gets
         a Week view and it becomes the desktop default"). This block's original point — that a
         first load lands on a KNOWN view and shows exactly that one container — is unchanged and
         asserted just as strictly; only which view that is has changed, deliberately. The phone
         default (Day, R73 · A4) and "a stored choice always wins" are covered in tests/r75_diary
         §A2, so nothing this check used to prove has been dropped. */
      const initial = await page.evaluate(() => ({
        monthActive: document.querySelector("#diary-view-month").classList.contains("scope-active"),
        weekActive: document.querySelector("#diary-view-week").classList.contains("scope-active"),
        dayActive: document.querySelector("#diary-view-day").classList.contains("scope-active"),
        gridHidden: document.querySelector("#diary-grid").classList.contains("hidden"),
        weekViewHidden: document.querySelector("#diary-week-view").classList.contains("hidden"),
        dayViewHidden: document.querySelector("#diary-day-view").classList.contains("hidden"),
      }));
      eq("defaults to Week on first load (R75 — desktop default)", initial,
        { monthActive: false, weekActive: true, dayActive: false, gridHidden: true, weekViewHidden: false, dayViewHidden: true });

      /* R75 · A1 — the month grid has not been PAINTED yet on a load that opens on Week, so the
         "pixel-identical when toggled back" comparison below has to start from a real month
         render. Press Month first, then capture. */
      await page.click("#diary-view-month");
      await page.waitForTimeout(900);
      const monthHtmlBefore = await page.evaluate(() => document.querySelector("#diary-grid").innerHTML);

      await page.click("#diary-view-day");
      await page.waitForTimeout(800);
      const afterToggle = await page.evaluate(() => ({
        monthActive: document.querySelector("#diary-view-month").classList.contains("scope-active"),
        dayActive: document.querySelector("#diary-view-day").classList.contains("scope-active"),
        gridHidden: document.querySelector("#diary-grid").classList.contains("hidden"),
        dayViewHidden: document.querySelector("#diary-day-view").classList.contains("hidden"),
      }));
      eq("switches the visible container to Day", afterToggle, { monthActive: false, dayActive: true, gridHidden: true, dayViewHidden: false });

      /* =================================================================
         3 (part) · R75 · A3 — THE FILTER FOLLOWS YOU ACROSS THE TOGGLE.
         The original rule here was "Day view defaults to the signed-in adviser", implemented as a
         silent swap of #diary-staff on every view change. Panel finding A#4: reading Wayne's month
         and pressing Day showed you YOUR day, with nothing saying so. R34 already opens the whole
         diary on the signed-in adviser for anybody who advises, so the swap only ever overrode a
         choice somebody had just made. It is deleted; the filter now carries. Same strength, the
         opposite expectation — this is the contract change, not a weakened check.
         ================================================================= */
      const staffSel = await page.evaluate(() => document.querySelector("#diary-staff").value);
      eq("Day view KEEPS the person Month was being read under (R75 · A3)", staffSel, "all");

      /* =================================================================
         3 (part) · toggle back to Month → pixel-identical grid, and the
         "Everyone" default Month started with is restored untouched.
         ================================================================= */
      await page.click("#diary-view-month");
      await page.waitForTimeout(800);
      const backToMonth = await page.evaluate(() => ({
        staffSel: document.querySelector("#diary-staff").value,
        gridHidden: document.querySelector("#diary-grid").classList.contains("hidden"),
        dayViewHidden: document.querySelector("#diary-day-view").classList.contains("hidden"),
      }));
      // R75 · A3 — same value, for the new reason: nothing ever re-points the select on a toggle.
      eq("Month is still on 'all'/Everyone — the toggle never re-points the filter", backToMonth.staffSel, "all");
      ok("Month grid is visible again, Day view hidden", !backToMonth.gridHidden && backToMonth.dayViewHidden);
      const monthHtmlAfter = await page.evaluate(() => document.querySelector("#diary-grid").innerHTML);
      eq("month grid is pixel-identical after toggling to Day and back", monthHtmlAfter, monthHtmlBefore);

      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       2 · Overlapping appointments render side-by-side with ⚠
       (fixture: today, p2 has two 10:00 appointments — Ruby Sinclair
       10:00-11:00 and Duncan Armitage 10:00-10:45 — that overlap; a third,
       Marcus Bell at 14:00, does not overlap with anything)
       =================================================================== */
    console.log("\n— Day view: overlapping appointments render side-by-side with ⚠ (p2 Wayne, adviser)");
    {
      const page = await newPage(browser, "p2");
      await gotoDiary(page);
      await page.click("#diary-view-day");
      await page.waitForTimeout(800);

      const blocks = await page.evaluate(() => [...document.querySelectorAll("#diary-day-lane .appt-block")].map((b) => ({
        text: b.textContent.trim(),
        clash: b.classList.contains("clash"),
        left: b.style.left,
        width: b.style.width,
        hasWarning: b.textContent.includes("⚠"),
      })));
      eq("today's 3 appointments for p2 all rendered as blocks", blocks.length, 3);

      const rubyBlock = blocks.find((b) => /Ruby Sinclair/.test(b.text));
      const duncanBlock = blocks.find((b) => /Duncan Armitage/.test(b.text));
      const marcusBlock = blocks.find((b) => /Fact find call|Protection review/.test(b.text) && !/Ruby|Duncan/.test(b.text));

      ok("Ruby's 10:00 appointment is flagged as clashing", rubyBlock && rubyBlock.clash && rubyBlock.hasWarning, JSON.stringify(rubyBlock));
      ok("Duncan's 10:00 appointment is flagged as clashing", duncanBlock && duncanBlock.clash && duncanBlock.hasWarning, JSON.stringify(duncanBlock));
      ok("the two clashing blocks sit at different horizontal offsets (side-by-side, not stacked)",
        rubyBlock && duncanBlock && rubyBlock.left !== duncanBlock.left, JSON.stringify({ rubyBlock, duncanBlock }));
      ok("both clashing blocks are narrower than a full-width block (each got its own column)",
        rubyBlock && duncanBlock && /calc\(50%/.test(rubyBlock.width) && /calc\(50%/.test(duncanBlock.width),
        JSON.stringify({ rubyBlock, duncanBlock }));
      ok("the 14:00 appointment (no overlap) is NOT flagged as clashing",
        marcusBlock && !marcusBlock.clash && !marcusBlock.hasWarning, JSON.stringify(marcusBlock));
      ok("…and is rendered full-width", marcusBlock && !/calc\(50%/.test(marcusBlock.width), JSON.stringify(marcusBlock));

      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       4 · Click block → openAppt(existing); click empty slot → new appt
       prefilled with a time derived from the click position
       =================================================================== */
    console.log("\n— Day view: click behaviours (p2 Wayne, adviser)");
    {
      const page = await newPage(browser, "p2");
      await gotoDiary(page);
      await page.click("#diary-view-day");
      await page.waitForTimeout(800);

      // Click an existing block → opens the appointment modal for that record.
      const rubyLocator = page.locator("#diary-day-lane .appt-block", { hasText: "Ruby Sinclair" });
      await rubyLocator.first().click();
      await page.waitForTimeout(600);
      const modalTitle = await page.evaluate(() => (document.querySelector("#modal h3") || {}).textContent || "");
      const modalTitleField = await page.evaluate(() => (document.querySelector('#appt-form [name="title"]') || {}).value || "");
      eq("clicking a block opens the Appointment modal", modalTitle, "Appointment");
      ok("…for the correct appointment (Ruby Sinclair's)", /Ruby Sinclair/.test(modalTitleField), modalTitleField);
      await page.click("#modal-cancel");
      await page.waitForTimeout(400);

      // Click an empty slot — the gap between the 10:00-11:00 clash and the 14:00 appointment,
      // i.e. around 13:00, which is both genuinely empty AND within the default viewport (a point
      // near the foot of the 08:00-19:00 axis can fall outside a 720px-tall viewport and silently
      // hit nothing) → New appointment, prefilled with a time derived from the click position.
      const laneBox = await page.evaluate(() => {
        const el = document.querySelector("#diary-day-lane");
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, width: r.width, height: r.height };
      });
      // 13:00 is 5 hours after the 08:00 axis start, at 60px/hour → 300px down from the top.
      await page.mouse.click(laneBox.left + laneBox.width / 2, laneBox.top + 300);
      await page.waitForTimeout(600);
      const newModalTitle = await page.evaluate(() => (document.querySelector("#modal h3") || {}).textContent || "");
      const newDate = await page.evaluate(() => (document.querySelector('#appt-form [name="date"]') || {}).value || "");
      const newTime = await page.evaluate(() => (document.querySelector('#appt-form [name="time"]') || {}).value || "");
      eq("clicking an empty slot opens New appointment", newModalTitle, "New appointment");
      ok("…prefilled with today's date", /^\d{4}-\d{2}-\d{2}$/.test(newDate), newDate);
      ok("…prefilled with a time close to the click position (~13:00)", /^1[23]:(00|30)$/.test(newTime), newTime);
      await page.click("#modal-cancel");
      await page.waitForTimeout(400);

      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       5 · Persisted per user via lsSet
       =================================================================== */
    console.log("\n— Day view choice is persisted per user (p2 Wayne, adviser)");
    {
      const page = await newPage(browser, "p2");
      await gotoDiary(page);
      await page.click("#diary-view-day");
      await page.waitForTimeout(600);
      await page.reload();
      await page.waitForTimeout(SETTLE);
      await gotoDiary(page);
      const dayActive = await page.evaluate(() => document.querySelector("#diary-view-day").classList.contains("scope-active"));
      const dayViewVisible = await page.evaluate(() => !document.querySelector("#diary-day-view").classList.contains("hidden"));
      ok("a fresh load after choosing Day stays on Day", dayActive && dayViewVisible, JSON.stringify({ dayActive, dayViewVisible }));

      // Different persona, same browser/localStorage → not affected by p2's stored preference
      // (the key is namespaced by user id, matching the existing pipeline-prefs pattern).
      await page.close();
      const page2 = await newPage(browser, "p3");
      await gotoDiary(page2);
      // R75 · A1 — the key is still namespaced per user; the untouched default is Week now.
      const p3WeekActive = await page2.evaluate(() => document.querySelector("#diary-view-week").classList.contains("scope-active"));
      ok("a different persona is unaffected by p2's stored choice — still on the Week default", p3WeekActive);
      ok("no console errors", !page2.__err, JSON.stringify(page2.__err));
      await page2.close();
    }

    /* ===================================================================
       6 · R75 · A1 — THE WEEK VIEW EXISTS NOW.
       This block used to assert the opposite ("no week view was added this round"), which was a
       true statement about batch 9 and a scope fence, not a design decision. Daniel took that
       decision on 28 Aug 2026 and R75 built it, so the fence is re-pointed at the shipped shape
       rather than deleted — the Diary page must still have exactly ONE view toggle with exactly
       the views the app actually has. Full week-view coverage lives in tests/r75_diary.js §A.
       =================================================================== */
    console.log("\n— The Week view is part of the toggle now (p2 Wayne, adviser)");
    {
      const page = await newPage(browser, "p2");
      await gotoDiary(page);
      const toggleButtons = await page.evaluate(() => [...document.querySelectorAll("#diary-view-toggle button")].map((b) => b.textContent.trim()));
      eq("the toggle is exactly Month | Week | Day", toggleButtons, ["Month", "Week", "Day"]);
      const week = await page.evaluate(() => ({
        container: !!document.querySelector("#diary-week-view"),
        lanes: document.querySelectorAll("#diary-week-view .dw-lane").length,
        heads: document.querySelectorAll("#diary-week-view .dw-head").length,
      }));
      eq("the Week view draws seven lanes and seven heads", [week.container, week.lanes, week.heads], [true, 7, 7]);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (e) {} }
  }

  console.log(`\nBATCH 9: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
