#!/usr/bin/env node
/* =============================================================================
   tests/r75_diary.js — acceptance tests for R75 build A, "the diary works like
   a diary" (R73 UI/UX panel findings B#5, A#20, A#4, B#16/E-19, B#13, A#25/B#14,
   plus Daniel's 28 Aug decision that the Week view becomes the desktop default).

   What the panel found, and what this file holds to:
     · there was no week view at all — the working horizon of a broker's diary
       was the one shape the diary could not draw (B#5, decision 2);
     · today's month cell was painted in the brand ORANGE, two CSS rules above
       the RED that means "this day is double-booked", so orientation and alarm
       read the same at a glance (B#16 / E-19);
     · an appointment could only be moved by opening it and retyping its date
       (B#5) — no drag, and therefore no undo of a drag either;
     · Month → Day silently swapped the staff filter to yourself, so reading a
       colleague's month and pressing Day showed you your own day with nothing
       saying so (A#4, and #10's bug list);
     · the Day view's empty lane said nothing — not whose, not when (A#4);
     · "Log call" was a titled modal from Retention and an inline drawer from
       the case, with copy pointing at a button that did not exist (B#13);
     · "Case details" was forty-odd equal-weight fields in one run, and the LTV
       — the number a lender's criteria turn on — lived only inside a collapsed
       security fold that ALSO repeated the loan, the lender and the rate from
       the identity card six inches below it (A#25, B#14).

     §A  A1 · THE WEEK VIEW. Seven Mon–Sun lanes on one hour axis; today marked
         NAVY on both the week head and the month cell (never red/orange, which
         mean something else everywhere in this app); away bands carried; ‹ / ›
         move exactly seven days and Today returns to this week's Monday.
         DEFAULTS: desktop + empty storage → week; 390px + empty storage → day
         (R73 · A4, kept); a stored choice always wins over both.
     §B  A2(a)(b) · CLICK A SLOT. An empty month cell prefills the date; a week
         lane prefills date AND the half hour dropped on; a click on an .appt
         still opens that appointment. R72's defaultAssignee/whose-diary rule is
         re-asserted through the new prefill paths — the diary filter names the
         adviser and NOTHING in the new code passes a staff_id of its own.
     §C  A2(c) · DRAG TO MOVE. Blocks are draggable and carry their id; a real
         HTML5 drag onto another day moves the appointment; a month drop keeps
         the time of day, a week-lane drop takes the dropped half hour, and the
         duration survives both. The toast names old → new and its Undo restores
         the EXACT captured timestamps. A drop that would double-book asks in
         the house overlay and writes nothing when refused.
     §D  A3 · THE FILTER FOLLOWS YOU. Month → Week → Day keeps the person you
         picked. R34's initial default-to-me contract is unchanged. The Day view
         gets a real empty state naming whose diary, the date, and a prefilled
         "+ Appointment".
     §E  A4 · ONE LOG-CALL PRESENTATION. The case modal opens the same titled
         overlay Retention opens, ids and behaviours intact (chip-only save, the
         No-answer auto call-back, the protection tick, the follow-up assignee),
         and the copy names the button that is actually there.
     §F  A5 · THE CASE READS LIKE A FILE. Six .cs-sub-h group headings in order;
         the Buy-to-let group appears for a BTL case or wherever its fields hold
         values; LTV on the identity card; the four duplicated lines gone from
         the security fold, which keeps its identity rows.
     §G  No console errors and no native dialogs anywhere in the above.

   Every figure asserted here is either seeded by this file, read back off
   window.__mockDb, or read off app.js's own module state — never invented.

   Run:  node /root/nx/tests/r75_diary.js
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

/* Every localStorage key a page under test here can read. The four diary-view keys are per-user
   (nx_diaryview_<uid>) and MUST be cleared: half of §A is about what happens with NO stored
   choice, and a suite that inherits an earlier scenario's press is testing nothing. */
const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_untouched", "nx_wt_scope", "nx_board_adviser",
  "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_clients_adviser", "nx_drawer_rateerc",
  "nx_drawer_retention", "nx_drawer_unactioned", "nx_drawer_watchtower", "nx_brief_scope",
  "nx_diaryview_p1", "nx_diaryview_p2", "nx_diaryview_p3", "nx_diaryview_p4"];

const DESK = { width: 1400, height: 950 };
const PHONE = { width: 390, height: 844 };

async function boot(browser, persona, viewport, seedLs) {
  const ctx = await browser.newContext({ viewport: viewport || DESK });
  const page = await ctx.newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  if (seedLs) await page.evaluate((kv) => { Object.entries(kv).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }); }, seedLs);
  // The stored-choice scenarios need the app to READ the key, which happens once at showApp.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1700);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(300);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));

const goPage = async (page, name, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await page.waitForTimeout(ms == null ? 2200 : ms);
};
/* Which view is live, read the way a person reads it: off the segment that is lifted out of the
   track. app.js's diaryViewMode is a module-scope `let` and is deliberately NOT on window — the
   user-visible contract is the toggle, and that is what these assertions hold. */
const activeDiaryView = (page) => page.evaluate(() => {
  const on = ["month", "week", "day"].filter((m) => document.querySelector("#diary-view-" + m).classList.contains("scope-active"));
  return on.length === 1 ? on[0] : on.join("+");
});
const closeAll = async (page) => {
  await page.evaluate(() => {
    const ov = document.querySelector("#overlay-backdrop");
    if (ov && !ov.classList.contains("hidden")) { const c = document.querySelector("#ovl-confirm-cancel") || document.querySelector("#cs-call-cancel"); if (c) c.click(); }
    if (window.closeModal) window.closeModal();
  });
  await page.waitForTimeout(350);
};

let uniq = 0;
const tag = () => `R75A${Date.now().toString(36)}${++uniq}`;
/* Europe/London calendar date, computed in the TEST — never borrowed from app.js, which is the
   thing under test. Same helper shape r70_calls uses. */
const londonYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d || new Date());
const pad2 = (n) => String(n).padStart(2, "0");
const ymdOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function mondayOfLocal(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

async function mkClientCase(page, o) {
  return page.evaluate(async (opt) => {
    const db = window.__mockDb;
    const { data: cl, error: ce } = await db.from("clients").insert({
      first_name: opt.first, last_name: opt.last, email: opt.email || null, phone: opt.phone === undefined ? null : opt.phone,
    }).select("id").single();
    if (ce) throw new Error("client insert: " + ce.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "application", assigned_to: "p2" }, opt.case || {});
    const { data: cs, error: se } = await db.from("cases").insert(row).select("id").single();
    if (se) throw new Error("case insert: " + se.message);
    return { clientId: cl.id, caseId: cs.id };
  }, o);
}
async function mkAppt(page, row) {
  return page.evaluate(async (r) => {
    const { data, error } = await window.__mockDb.from("appointments").insert(r).select("id").single();
    if (error) throw new Error("appt insert: " + error.message);
    return data.id;
  }, row);
}
const apptRow = (page, id) => page.evaluate(async (i) => {
  const { data } = await window.__mockDb.from("appointments").select("*").eq("id", i).single();
  return data;
}, id);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* =======================================================================
     §A · A1 — THE WEEK VIEW, AND WHAT OPENS ON IT
     ==================================================================== */
  {
    console.log("\n— §A · A1 · the week view, today in navy, and the three defaults");
    const page = await boot(browser, "p2", DESK);
    await goPage(page, "diary", 2600);

    // A1 — the owner decision: a desktop with no stored choice opens on WEEK.
    const opened = await page.evaluate(() => ({
      weekActive: document.querySelector("#diary-view-week").classList.contains("scope-active"),
      weekSelected: document.querySelector("#diary-view-week").getAttribute("aria-selected"),
      weekShown: !document.querySelector("#diary-week-view").classList.contains("hidden"),
      gridHidden: document.querySelector("#diary-grid").classList.contains("hidden"),
      dayHidden: document.querySelector("#diary-day-view").classList.contains("hidden"),
    }));
    eq("A1 · a desktop with no stored choice opens the diary on WEEK", opened,
      { weekActive: true, weekSelected: "true", weekShown: true, gridHidden: true, dayHidden: true });

    // A2 — the toggle is a three-way now, in scale order.
    eq("A2 · the toggle reads Month | Week | Day",
      await page.$$eval("#diary-view-toggle button", (els) => els.map((b) => b.textContent.trim())), ["Month", "Week", "Day"]);

    // A3 — seven lanes, seven consecutive dates, starting on Monday.
    const lanes = await page.$$eval("#diary-week-view .dw-lane", (els) => els.map((e) => e.dataset.date));
    eq("A3 · the week grid draws exactly seven lanes", lanes.length, 7);
    const expectMon = ymdOf(mondayOfLocal(new Date()));
    eq("A3b · …starting on this week's Monday", lanes[0], expectMon);
    const consecutive = lanes.every((d, i) => {
      if (i === 0) return true;
      const prev = new Date(lanes[i - 1] + "T12:00:00");
      prev.setDate(prev.getDate() + 1);
      return ymdOf(prev) === d;
    });
    ok("A3c · …and the seven are consecutive days", consecutive, lanes.join(","));
    eq("A3d · every lane has a head cell beside it",
      await page.$$eval("#diary-week-view .dw-head", (e) => e.length), 7);
    ok("A3e · the heads are H3, so the page's heading levels do not skip (R73 · B1)",
      await page.$$eval("#diary-week-view .dw-head h3.diary-day-h", (e) => e.length) === 7);

    // A4 — TODAY IS NAVY. --navy is #00488c → rgb(0, 72, 140).
    const todayPaint = await page.evaluate(() => {
      const head = document.querySelector("#diary-week-view .dw-head.today");
      const lane = document.querySelector("#diary-week-view .dw-lane.today");
      if (!head || !lane) return { missing: true };
      const cs = getComputedStyle(head);
      return { shadow: cs.boxShadow, tag: !!head.querySelector(".dw-today-tag"), laneDate: lane.dataset.date };
    });
    ok("A4 · today's week column is marked", !todayPaint.missing && todayPaint.tag, JSON.stringify(todayPaint));
    eq("A4b · …and it is the Europe/London today", todayPaint.laneDate, londonYmd());
    ok("A4c · …painted NAVY, never red or orange", /rgb\(0,\s*72,\s*140\)/.test(todayPaint.shadow || ""), String(todayPaint.shadow));

    // A5 — the month grid's today cell was orange; it is navy now. A double-booked today keeps
    // its red border (a clash IS an alarm), so the class is removed before the border is read.
    await page.click("#diary-view-month");
    await page.waitForTimeout(1400);
    const monthToday = await page.evaluate(() => {
      const cell = document.querySelector("#diary-grid .diary-day.today");
      if (!cell) return { missing: true };
      const hadClash = cell.classList.contains("has-clash");
      cell.classList.remove("has-clash");
      const c = getComputedStyle(cell).borderTopColor;
      if (hadClash) cell.classList.add("has-clash");
      return { colour: c, hadClash };
    });
    eq("A5 · the month grid's today cell is navy (was --orange)", monthToday.colour, "rgb(0, 72, 140)");

    // A6 — the away band carries into the week head. Luke (p3) has a fixture absence spanning
    // today; read under "All advisers" so the band names him.
    await page.selectOption("#diary-staff", "all");
    await page.waitForTimeout(900);
    await page.click("#diary-view-week");
    await page.waitForTimeout(1400);
    const bands = await page.$$eval("#diary-week-view .dw-head .diary-away", (els) => els.map((e) => e.textContent.trim()));
    ok("A6 · an away band shows on the week head for the day it covers", bands.length > 0, JSON.stringify(bands));

    // A7 — ‹ / › move a WEEK, and Today comes back to this week's Monday.
    await page.click("#diary-next");
    await page.waitForTimeout(1200);
    const nextMon = await page.$eval("#diary-week-view .dw-lane", (e) => e.dataset.date);
    const wantNext = new Date(expectMon + "T12:00:00"); wantNext.setDate(wantNext.getDate() + 7);
    eq("A7 · › moves the week view on by exactly seven days", nextMon, ymdOf(wantNext));
    await page.click("#diary-prev");
    await page.click("#diary-prev");
    await page.waitForTimeout(1400);
    const prevMon = await page.$eval("#diary-week-view .dw-lane", (e) => e.dataset.date);
    const wantPrev = new Date(expectMon + "T12:00:00"); wantPrev.setDate(wantPrev.getDate() - 7);
    eq("A7b · ‹ moves it back by exactly seven days", prevMon, ymdOf(wantPrev));
    await page.click("#diary-today");
    await page.waitForTimeout(1200);
    eq("A7c · Today returns to this week's Monday",
      await page.$eval("#diary-week-view .dw-lane", (e) => e.dataset.date), expectMon);

    ok("§A · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    eq("§A · and no native dialogs", page.__dialogs.length, 0);
    await page.close();
  }
  {
    console.log("\n— §A2 · the two other defaults: a phone opens on Day, a stored choice always wins");
    const phone = await boot(browser, "p3", PHONE);
    await goPage(phone, "diary", 2600);
    eq("A8 · a phone (390px) with no stored choice still opens on DAY (R73 · A4 kept)",
      await activeDiaryView(phone), "day");
    ok("A8b · no console errors on the phone", realErrs(phone).length === 0, realErrs(phone).join(" | ").slice(0, 200));
    await phone.close();

    const stored = await boot(browser, "p2", DESK, { nx_diaryview_p2: "month" });
    await goPage(stored, "diary", 2600);
    eq("A9 · a stored MONTH beats the desktop week default", await activeDiaryView(stored), "month");
    await stored.close();

    const storedWeek = await boot(browser, "p3", PHONE, { nx_diaryview_p3: "week" });
    await goPage(storedWeek, "diary", 2600);
    eq("A9b · …and a stored WEEK beats the phone day default", await activeDiaryView(storedWeek), "week");
    ok("A9c · no console errors", realErrs(storedWeek).length === 0, realErrs(storedWeek).join(" | ").slice(0, 200));
    await storedWeek.close();
  }

  /* =======================================================================
     §B · A2(a)(b) — CLICK A SLOT TO BOOK
     ==================================================================== */
  {
    console.log("\n— §B · A20 · clicking an empty cell / lane opens the modal already filled in");
    const page = await boot(browser, "p1", DESK);   // Kim the administrator books for other people
    const t = tag();
    const gt = await mkClientCase(page, { first: "R75", last: "Slotclick" + t, case: { assigned_to: "p2" } });
    const monday = mondayOfLocal(new Date());
    const wed = new Date(monday); wed.setDate(wed.getDate() + 2);
    const apptId = await mkAppt(page, {
      client_id: gt.clientId, case_id: gt.caseId, title: "Slotclick fact find " + t,
      starts_at: new Date(wed.getFullYear(), wed.getMonth(), wed.getDate(), 15, 0).toISOString(),
      ends_at: new Date(wed.getFullYear(), wed.getMonth(), wed.getDate(), 15, 45).toISOString(),
      staff_id: "p2",
    });
    await goPage(page, "diary", 2600);

    // B1 — the month grid: an empty part of a cell prefills that date.
    await page.click("#diary-view-month");
    await page.waitForTimeout(1400);
    const cellDate = ymdOf(wed);
    await page.evaluate((d) => {
      const cell = document.querySelector(`.diary-day[data-date="${d}"]`);
      cell.click();                 // the cell itself, not an .appt inside it
    }, cellDate);
    await page.waitForTimeout(900);
    const b1 = await page.evaluate(() => ({
      h3: (document.querySelector("#modal h3") || {}).textContent || "",
      date: (document.querySelector('#appt-form [name="date"]') || {}).value || "",
    }));
    eq("B1 · clicking an empty month cell opens New appointment", b1.h3, "New appointment");
    eq("B1b · …prefilled with that cell's date", b1.date, cellDate);
    await closeAll(page);

    // B2 — a click on the appointment itself still opens the appointment (unchanged).
    await page.evaluate((id) => { document.querySelector(`.appt[data-appt="${id}"]`).click(); }, apptId);
    await page.waitForTimeout(900);
    eq("B2 · clicking an .appt still opens that appointment, not a new one",
      await page.evaluate(() => (document.querySelector("#modal h3") || {}).textContent || ""), "Appointment");
    await closeAll(page);

    // B3 — the week lane: date AND the half hour that was clicked.
    await page.click("#diary-view-week");
    await page.waitForTimeout(1500);
    const laneBox = await page.evaluate((d) => {
      const lane = document.querySelector(`#diary-week-view .dw-lane[data-date="${d}"]`);
      const r = lane.getBoundingClientRect();
      return { x: r.left + r.width / 2, top: r.top };
    }, cellDate);
    // 13:00 is five hours below the 08:00 axis start, at 60px an hour.
    await page.mouse.click(laneBox.x, laneBox.top + 300);
    await page.waitForTimeout(900);
    const b3 = await page.evaluate(() => ({
      h3: (document.querySelector("#modal h3") || {}).textContent || "",
      date: (document.querySelector('#appt-form [name="date"]') || {}).value || "",
      time: (document.querySelector('#appt-form [name="time"]') || {}).value || "",
      who: (document.querySelector('#appt-form [name="staff_id"]') || {}).value || "",
    }));
    eq("B3 · clicking a week lane opens New appointment", b3.h3, "New appointment");
    eq("B3b · …prefilled with that lane's date", b3.date, cellDate);
    ok("B3c · …and the half hour that was clicked (~13:00)", /^1[23]:(00|30)$/.test(b3.time), b3.time);
    /* R72 · B1 (H4) — the whose-diary rule. Nothing in the new prefill paths passes a staff_id, so
       openAppt's own default decides: the diary filter when it names a person, else the booker.
       Kim is filtered to "All advisers" here, so it is Kim. */
    eq("B3d · with the filter on All advisers the booking is the booker's (R72 default intact)", b3.who, "p1");
    await closeAll(page);

    // B4 — and with the filter naming a person, the slot books into THEIR diary and says so.
    await page.selectOption("#diary-staff", "p2");
    await page.waitForTimeout(1400);
    await page.mouse.click(laneBox.x, laneBox.top + 300);
    await page.waitForTimeout(900);
    const b4 = await page.evaluate(() => ({
      who: (document.querySelector('#appt-form [name="staff_id"]') || {}).value || "",
      note: ((document.querySelector("#appt-whose-note") || {}).textContent || "").trim(),
    }));
    eq("B4 · a slot clicked while filtered to Wayne books into Wayne's diary", b4.who, "p2");
    ok("B4b · …and R72's “not your diary” line still says so", /Wayne/.test(b4.note), b4.note);
    await closeAll(page);

    ok("§B · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    eq("§B · and no native dialogs", page.__dialogs.length, 0);
    await page.close();
  }

  /* =======================================================================
     §C · A2(c) — DRAG TO MOVE, CLASH, UNDO
     ==================================================================== */
  {
    console.log("\n— §C · B5 · drag to move: a real drop, a clash that asks, an Undo that restores exactly");
    const page = await boot(browser, "p2", DESK);
    const t = tag();
    const gt = await mkClientCase(page, { first: "R75", last: "Dragmove" + t, case: { assigned_to: "p2" } });
    const monday = mondayOfLocal(new Date());
    const tue = new Date(monday); tue.setDate(tue.getDate() + 1);
    const thu = new Date(monday); thu.setDate(thu.getDate() + 3);
    const at = (d, h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m || 0).toISOString();
    const movingId = await mkAppt(page, {
      client_id: gt.clientId, case_id: gt.caseId, title: "Dragme " + t,
      starts_at: at(tue, 15, 0), ends_at: at(tue, 15, 45), staff_id: "p2",
    });
    // A blocker on Thursday at 11:00–12:00, so a drop onto 11:00 there is a genuine clash.
    await mkAppt(page, {
      client_id: gt.clientId, case_id: gt.caseId, title: "Blocker " + t,
      starts_at: at(thu, 11, 0), ends_at: at(thu, 12, 0), staff_id: "p2",
    });
    await goPage(page, "diary", 2600);

    // C1 — the affordance exists on both renderers.
    const drag = await page.evaluate(() => ({
      week: [...document.querySelectorAll("#diary-week-view .appt-block")].every((e) => e.getAttribute("draggable") === "true" && !!e.dataset.appt),
      weekN: document.querySelectorAll("#diary-week-view .appt-block[draggable='true'][data-appt]").length,
      laneTitle: (document.querySelector("#diary-week-view .dw-lane") || {}).title || "",
    }));
    ok("C1 · every week block is draggable and carries its id", drag.week && drag.weekN > 0, JSON.stringify(drag));
    ok("C1b · the lane names the keyboard route, because dragging is pointer-only",
      /open it and change the date/i.test(drag.laneTitle), drag.laneTitle);

    // C2 — a REAL HTML5 drag from Tuesday's lane onto Thursday's, dropped at ~14:00.
    const boxes = await page.evaluate(({ id, thuD }) => {
      const b = document.querySelector(`#diary-week-view .appt-block[data-appt="${id}"]`);
      const lane = document.querySelector(`#diary-week-view .dw-lane[data-date="${thuD}"]`);
      const rb = b.getBoundingClientRect(), rl = lane.getBoundingClientRect();
      return { from: { x: rb.left + rb.width / 2, y: rb.top + 6 }, laneX: rl.left + rl.width / 2, laneTop: rl.top };
    }, { id: movingId, thuD: ymdOf(thu) });
    await page.mouse.move(boxes.from.x, boxes.from.y);
    await page.mouse.down();
    await page.mouse.move(boxes.laneX, boxes.laneTop + 360, { steps: 12 });   // 08:00 + 6h = 14:00
    await page.mouse.up();
    await page.waitForTimeout(1600);
    const moved = await apptRow(page, movingId);
    const movedLocal = new Date(moved.starts_at);
    eq("C2 · the drag moved the appointment to the day it was dropped on", ymdOf(movedLocal), ymdOf(thu));
    ok("C2b · …at the half hour it was dropped on (~14:00)",
      /^1[34]:(00|30)$/.test(`${pad2(movedLocal.getHours())}:${pad2(movedLocal.getMinutes())}`),
      `${movedLocal.getHours()}:${movedLocal.getMinutes()}`);
    eq("C2c · …and the 45-minute duration survived the move",
      Math.round((new Date(moved.ends_at) - movedLocal) / 60000), 45);

    // C3 — the toast names both slots and offers Undo.
    const toastTxt = await page.$eval("#toast", (e) => e.textContent || "");
    ok("C3 · the toast names old → new", /→/.test(toastTxt) && /Dragme/.test(toastTxt), toastTxt.slice(0, 160));
    ok("C3b · …and offers an Undo", !!(await page.$("#toast-action")), toastTxt.slice(0, 160));

    // C4 — Undo restores the EXACT captured timestamps, not a recomputed guess.
    await page.click("#toast-action");
    await page.waitForTimeout(1600);
    const back = await apptRow(page, movingId);
    eq("C4 · Undo restores the exact original start", back.starts_at, at(tue, 15, 0));
    eq("C4b · …and the exact original end", back.ends_at, at(tue, 15, 45));

    // C5 — a MONTH-cell drop changes the day and keeps the time of day.
    await page.click("#diary-view-month");
    await page.waitForTimeout(1500);
    const fri = new Date(monday); fri.setDate(fri.getDate() + 4);
    await page.evaluate(async ({ id, d }) => { await window.diaryMoveAppt(id, { date: d }); }, { id: movingId, d: ymdOf(fri) });
    await page.waitForTimeout(1500);
    const monthMoved = await apptRow(page, movingId);
    const mm = new Date(monthMoved.starts_at);
    eq("C5 · a month-cell drop moves the day…", ymdOf(mm), ymdOf(fri));
    eq("C5b · …and keeps the time of day (15:00), because a month cell has no time in it",
      `${pad2(mm.getHours())}:${pad2(mm.getMinutes())}`, "15:00");

    // C6 — a drop that would double-book ASKS, in the house overlay, and writes nothing on refusal.
    const beforeClash = await apptRow(page, movingId);
    const askP = page.evaluate(({ id, d }) => window.diaryMoveAppt(id, { date: d, time: "11:00" }), { id: movingId, d: ymdOf(thu) });
    await page.waitForTimeout(1200);
    const asked = await page.evaluate(() => ({
      open: !document.querySelector("#overlay-backdrop").classList.contains("hidden"),
      title: ((document.querySelector("#ovl-confirm-title") || {}).textContent || "").trim(),
      body: ((document.querySelector("#ovl-confirm-body") || {}).textContent || "").trim(),
    }));
    ok("C6 · a clashing drop asks first, in the house overlay", asked.open, JSON.stringify(asked));
    ok("C6b · …naming the appointment it would collide with", /Blocker/.test(asked.body), asked.body.slice(0, 200));
    await page.click("#ovl-confirm-cancel");
    await askP;
    await page.waitForTimeout(900);
    const afterRefuse = await apptRow(page, movingId);
    eq("C6c · refusing the clash writes nothing at all", afterRefuse.starts_at, beforeClash.starts_at);
    eq("C6d · …and no native confirm was used", page.__dialogs.length, 0);

    // C7 — accepting it books over the clash, exactly as the save path always allowed.
    const askP2 = page.evaluate(({ id, d }) => window.diaryMoveAppt(id, { date: d, time: "11:00" }), { id: movingId, d: ymdOf(thu) });
    await page.waitForTimeout(1200);
    await page.click("#ovl-confirm-ok");
    await askP2;
    await page.waitForTimeout(1500);
    const clashed = new Date((await apptRow(page, movingId)).starts_at);
    eq("C7 · accepting the clash moves it (warn, never block — defect 5)",
      `${ymdOf(clashed)} ${pad2(clashed.getHours())}:${pad2(clashed.getMinutes())}`, `${ymdOf(thu)} 11:00`);

    ok("§C · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  /* =======================================================================
     §D · A3 — THE FILTER FOLLOWS YOU, AND THE DAY VIEW SAYS WHOSE
     ==================================================================== */
  {
    console.log("\n— §D · A4 · the staff filter carries across views, and the empty day says whose it is");
    const page = await boot(browser, "p1", DESK);   // admin: their role default is "all"
    await goPage(page, "diary", 2600);
    await page.click("#diary-view-month");
    await page.waitForTimeout(1300);
    await page.selectOption("#diary-staff", "p3");   // deliberately read Luke's diary
    await page.waitForTimeout(1300);
    eq("D1 · Month is showing the person who was picked", await page.$eval("#diary-staff", (e) => e.value), "p3");
    await page.click("#diary-view-day");
    await page.waitForTimeout(1500);
    eq("D1b · Month → Day KEEPS that person (the silent swap to me is gone)",
      await page.$eval("#diary-staff", (e) => e.value), "p3");
    await page.click("#diary-view-week");
    await page.waitForTimeout(1500);
    eq("D1c · Day → Week keeps them too", await page.$eval("#diary-staff", (e) => e.value), "p3");
    await page.click("#diary-view-month");
    await page.waitForTimeout(1500);
    eq("D1d · …and Week → Month, so the filter never moves on its own",
      await page.$eval("#diary-staff", (e) => e.value), "p3");

    // D2 — the Day view's empty state. Walk forward to a day with nothing on it.
    await page.click("#diary-view-day");
    await page.waitForTimeout(1400);
    for (let i = 0; i < 8; i++) {
      const blocks = await page.$$eval("#diary-day-lane .appt-block", (e) => e.length);
      if (blocks === 0) break;
      await page.click("#diary-next");
      await page.waitForTimeout(900);
    }
    const empty = await page.evaluate(() => {
      const el = document.querySelector("#diary-day-empty");
      return el ? { text: el.textContent.replace(/\s+/g, " ").trim(), btn: !!el.querySelector("#diary-day-empty-add") } : null;
    });
    ok("D2 · an empty Day view carries a real empty state", !!empty, JSON.stringify(empty));
    ok("D2b · …naming whose diary it is", !!empty && /Luke Richards/.test(empty.text), empty && empty.text.slice(0, 140));
    ok("D2c · …and the date", !!empty && /\d{4}/.test(empty.text), empty && empty.text.slice(0, 140));
    ok("D2d · …with a “+ Appointment” button on it", !!empty && empty.btn);
    const dayShown = await page.$eval("#diary-title", (e) => e.textContent);
    await page.click("#diary-day-empty-add");
    await page.waitForTimeout(900);
    const d2 = await page.evaluate(() => ({
      h3: (document.querySelector("#modal h3") || {}).textContent || "",
      date: (document.querySelector('#appt-form [name="date"]') || {}).value || "",
      who: (document.querySelector('#appt-form [name="staff_id"]') || {}).value || "",
    }));
    eq("D2e · …that opens New appointment", d2.h3, "New appointment");
    ok("D2f · …prefilled with the day being read", dayShown.indexOf(String(new Date(d2.date + "T12:00:00").getDate())) >= 0, `${dayShown} / ${d2.date}`);
    eq("D2g · …in the diary of the person the filter names (R72 default intact)", d2.who, "p3");
    await closeAll(page);
    ok("§D · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }
  {
    console.log("\n— §D2 · R34's initial default-to-me contract is untouched by any of this");
    const adv = await boot(browser, "p2", DESK);
    await goPage(adv, "diary", 2400);
    eq("D3 · an adviser's diary still OPENS on their own id (r34 §C1b)", await adv.$eval("#diary-staff", (e) => e.value), "p2");
    await adv.close();
    const own = await boot(browser, "p4", DESK);
    await goPage(own, "diary", 2400);
    eq("D3b · …and the owner's still opens on “all” (r34 §C2b)", await own.$eval("#diary-staff", (e) => e.value), "all");
    ok("D3c · no console errors", realErrs(own).length === 0, realErrs(own).join(" | ").slice(0, 200));
    await own.close();
  }

  /* =======================================================================
     §E · A4 — ONE LOG-CALL PRESENTATION, TWO ENTRY POINTS
     ==================================================================== */
  {
    console.log("\n— §E · B13 · the case modal's Log call is the modal Retention opens");
    const page = await boot(browser, "p2", DESK);
    const t = tag();
    const gt = await mkClientCase(page, { first: "Logcall", last: "Sameform" + t, phone: "07700900931", case: { assigned_to: "p2", stage: "application" } });

    // E1 — from the case.
    await page.evaluate((id) => window.openCase(id), gt.caseId);
    await page.waitForTimeout(2000);
    await page.click("#cs-logcall-btn");
    await page.waitForTimeout(800);
    const e1 = await page.evaluate(() => {
      const box = document.querySelector("#overlay-modal");
      const panel = document.querySelector("#overlay-modal #cs-logcall-panel");
      return {
        overlayOpen: !document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        title: ((box.querySelector("h3") || {}).textContent || "").trim(),
        panelInOverlay: !!panel,
        cancel: ((box.querySelector("#cs-call-cancel") || {}).textContent || "").trim(),
        save: ((box.querySelector("#cs-call-save") || {}).textContent || "").trim(),
        chips: box.querySelectorAll("#cs-call-outcome-chips .tl-chip").length,
        prot: !!box.querySelector("#cs-call-prot"),
        fu: !!box.querySelector("#cs-call-fu-title") && !!box.querySelector("#cs-call-fu-due") && !!box.querySelector("#cs-call-fu-assignee"),
        fuRow: !!box.querySelector(".cs-call-fu-row"),
        caseStillOpen: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
        help: (box.querySelector("#cs-call-help") || {}).textContent || "",
      };
    });
    ok("E1 · the case modal's Log call opens the titled overlay", e1.overlayOpen && e1.panelInOverlay, JSON.stringify(e1));
    ok("E1b · …titled “📞 Log a call — <name>”", /^📞 Log a call — Logcall Sameform/.test(e1.title), e1.title);
    eq("E1c · …with Cancel and Save call both visible", [e1.cancel, e1.save], ["Cancel", "Save call"]);
    eq("E1d · …the four outcome chips", e1.chips, 4);
    ok("E1e · …the protection tick and the whole follow-up row (incl. R73's stacking row)",
      e1.prot && e1.fu && e1.fuRow, JSON.stringify(e1));
    ok("E1f · …and the case modal is still open underneath it", e1.caseStillOpen);
    ok("E2 · the copy names the button that is actually there (“Save call”, not “Save”)",
      /press Save call/.test(e1.help.replace(/\s+/g, " ")), e1.help.replace(/\s+/g, " ").slice(0, 120));

    // E3 — the behaviours. A chip on its own saves, and No answer books the call-back.
    await page.click("#overlay-modal #cs-call-outcome-chips .tl-chip[data-outcome='No answer']");
    await page.waitForTimeout(400);
    const prefill = await page.evaluate(() => ({
      title: document.querySelector("#cs-call-fu-title").value,
      due: document.querySelector("#cs-call-fu-due").value,
      assignee: document.querySelector("#cs-call-fu-assignee").value,
    }));
    eq("E3 · “No answer” still pre-fills the call-back (R70 · B1)", prefill.title, "Call again");
    const wantDue = londonYmd(new Date(Date.now() + 86400000));
    eq("E3b · …dated tomorrow, Europe/London", prefill.due, wantDue);
    eq("E3c · …assigned to the case's own adviser (R72 defaultAssignee)", prefill.assignee, "p2");
    await page.click("#overlay-modal #cs-call-save");
    await page.waitForTimeout(2200);
    const wrote = await page.evaluate(async (id) => {
      const { data: notes } = await window.__mockDb.from("case_notes").select("*");
      const { data: tasks } = await window.__mockDb.from("case_tasks").select("*");
      return {
        notes: (notes || []).filter((n) => n.case_id === id).map((n) => n.body).filter((b) => /^Call: /.test(b)),
        tasks: (tasks || []).filter((x) => x.case_id === id && x.title === "Call again").map((x) => x.assigned_to),
        overlayGone: document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        caseStillOpen: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
      };
    }, gt.caseId);
    eq("E4 · a chip with no typed note saves as “Call: <outcome>”", wrote.notes, ["Call: No answer"]);
    eq("E4b · …and books the call-back on the case's adviser", wrote.tasks, ["p2"]);
    ok("E4c · the overlay closes on save and the case stays open", wrote.overlayGone && wrote.caseStillOpen, JSON.stringify(wrote));
    await closeAll(page);

    // E5 — the SAME shape from Retention's row chip, which is the other entry point.
    const e5 = await page.evaluate(async (id) => {
      window.retLogCall(id);
      await new Promise((r) => setTimeout(r, 1800));
      const box = document.querySelector("#overlay-modal");
      const out = {
        title: ((box.querySelector("h3") || {}).textContent || "").trim(),
        panel: !!box.querySelector("#ret-logcall-panel"),
        cancel: ((box.querySelector("#cs-call-cancel") || {}).textContent || "").trim(),
        save: ((box.querySelector("#cs-call-save") || {}).textContent || "").trim(),
        chips: box.querySelectorAll("#cs-call-outcome-chips .tl-chip").length,
      };
      const c = box.querySelector("#cs-call-cancel"); if (c) c.click();
      return out;
    }, gt.caseId);
    ok("E5 · Retention's entry point opens the same titled modal", /^📞 Log a call — /.test(e5.title) && e5.panel, JSON.stringify(e5));
    eq("E5b · …with the identical Cancel / Save call pair", [e5.cancel, e5.save], ["Cancel", "Save call"]);
    eq("E5c · …and the identical four chips", e5.chips, 4);

    ok("§E · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    eq("§E · and no native dialogs", page.__dialogs.length, 0);
    await page.close();
  }

  /* =======================================================================
     §F · A5 — THE CASE READS LIKE A FILE
     ==================================================================== */
  {
    console.log("\n— §F · A25 / B14 · six group headings, LTV on the identity card, no duplicates in the fold");
    const page = await boot(browser, "p4", DESK);
    const t = tag();
    const btl = await mkClientCase(page, {
      first: "Sub", last: "Headbtl" + t,
      case: { case_kind: "buy_to_let", stage: "application", loan_amount: 240000, property_value: 400000, monthly_rent: 1500, lender: "Skipton", rate_percent: 4.2 },
    });
    const plain = await mkClientCase(page, {
      first: "Sub", last: "Headplain" + t,
      case: { case_kind: "remortgage", stage: "application", loan_amount: 150000, property_value: 300000 },
    });
    const rented = await mkClientCase(page, {
      first: "Sub", last: "Headrent" + t,
      case: { case_kind: "remortgage", stage: "application", loan_amount: 100000, property_value: 250000, monthly_rent: 900 },
    });
    const novalue = await mkClientCase(page, {
      first: "Sub", last: "Headnoval" + t,
      case: { case_kind: "remortgage", stage: "application", loan_amount: 100000 },
    });

    const openAndRead = async (caseId) => {
      await closeAll(page);
      await page.evaluate((id) => window.openCase(id), caseId);
      await page.waitForTimeout(2100);
      await page.evaluate(() => { const d = document.querySelector("#modal .case-details"); if (d) d.open = true; });
      await page.waitForTimeout(500);
      return page.evaluate(() => ({
        heads: [...document.querySelectorAll("#modal .cs-sub-h")].map((h) => ({ text: h.textContent.trim(), hidden: h.classList.contains("hidden"), tag: h.tagName })),
        ltv: (document.querySelector("#cs-ltv .cs-val") || {}).textContent || null,
        btlBlockHidden: (document.querySelector("#case-btl-block") || {}).classList
          ? document.querySelector("#case-btl-block").classList.contains("hidden") : null,
        secLabels: [...document.querySelectorAll("#sec-grid .sec-lbl")].map((e) => e.textContent.trim()),
      }));
    };

    const b = await openAndRead(btl.caseId);
    eq("F1 · the case-details fold carries six group headings", b.heads.length, 6);
    eq("F1b · …in the order a case is worked", b.heads.map((h) => h.text),
      ["The mortgage", "Buy-to-let", "Dates & progress", "Fees", "Protection & GI", "Where it came from"]);
    eq("F1c · …as H4s, one level under the modal's own H3", [...new Set(b.heads.map((h) => h.tag))], ["H4"]);
    ok("F2 · the Buy-to-let group is shown on a BTL case", !b.heads[1].hidden && b.btlBlockHidden === false, JSON.stringify(b.heads[1]));
    eq("F3 · LTV joins the identity card, next to LOAN and VALUE", b.ltv, "60%");

    const p = await openAndRead(plain.caseId);
    ok("F2b · …and hidden on a remortgage with none of its fields filled", p.heads[1].hidden && p.btlBlockHidden === true, JSON.stringify(p.heads[1]));
    eq("F3b · LTV is computed, not stored (150k / 300k)", p.ltv, "50%");

    const r = await openAndRead(rented.caseId);
    ok("F2c · …but SHOWN on a non-BTL case that already holds a rent (a stored value is never orphaned)",
      !r.heads[1].hidden && r.btlBlockHidden === false, JSON.stringify(r.heads[1]));

    const nv = await openAndRead(novalue.caseId);
    eq("F4 · no LTV at all where the property value is missing — never “0%”", nv.ltv, null);

    // F5 — the security fold is a phone-verification aid again.
    eq("F5 · the security fold keeps exactly its identity rows", p.secLabels,
      ["Name", "Date of birth", "Property", "Home address", "Mortgage / account no.", "Product"]);
    ok("F5b · …and no longer repeats the loan, the lender, the rate or the LTV from the header",
      !p.secLabels.some((l) => /Loan amount|Lender|^Rate$|^LTV$/.test(l)), p.secLabels.join(","));

    await closeAll(page);
    ok("§F · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    eq("§F · and no native dialogs", page.__dialogs.length, 0);
    await page.close();
  }

  /* =======================================================================
     §G · a clean walk, on the three views, on three personas
     ==================================================================== */
  {
    console.log("\n— §G · nothing this round touched made a noise anywhere else");
    for (const persona of ["p1", "p2", "p4"]) {
      const page = await boot(browser, persona, DESK);
      await goPage(page, "diary", 2400);
      for (const v of ["month", "week", "day"]) {
        await page.click(`#diary-view-${v}`);
        await page.waitForTimeout(1200);
      }
      for (const p of ["dashboard", "pipeline", "clients", "retention", "diary", "reports"]) await goPage(page, p, 1500);
      ok(`G · ${persona} · all three diary views plus a page walk, no console errors`,
        realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
      eq(`G · ${persona} · and no native dialogs`, page.__dialogs.length, 0);
      await page.close();
    }
  }

  await browser.close();
  if (srv) { try { process.kill(-srv.pid); } catch (e) { try { srv.kill(); } catch (e2) { /* ignore */ } } }
  console.log("\n" + "=".repeat(64));
  console.log(`R75 DIARY: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
})();
