#!/usr/bin/env node
/* =============================================================================
   tests/r78_hands.js — acceptance tests for R78 build B, "fast and solid"
   (items B1–B7).

     §A  OVERLAY FOCUS TRAP (B1). Tab cycles INSIDE an open confirmTyped —
         wrap-around both ways, never out into the sidebar — Escape still
         cancels, and closing restores focus even when the opener was
         repainted while the overlay was up (the id-twin fallback).

     §B  DIARY KEYBOARD ACCESS (B2). Every rendered appointment block in all
         THREE views (month .appt, week/day .appt-block) is focusable
         (tabindex=0, role=button, aria-label from the title) and Enter opens
         the appointment editor.

     §C  WEEK-ON-PHONE (B3). At 390×844 the week grid overflows sideways;
         after the paint, scrollLeft puts today's lane in view (lane offset
         minus the hour column) when today is in the rendered week, and the
         wrap carries the board's chevron classes/discs.

     §D  WEEKEND-AWARE SNOOZE (B4). A snooze that LANDS on Saturday/Sunday
         rolls to Monday with the toast clause; a snooze landing midweek does
         not; an EXPLICIT weekend date via snoozeTaskTo is untouched; the
         case modal's Due chips fill the rolled date; the dateless task
         default is weekend-aware with the branch-correct toast. Driven by
         computing the expected roll from today's weekday, so it passes on
         EVERY day of the week (no clock faking — none of the suites has any).

     §E  SMS SELECTION PARITY (B5). .sms-cb on queued/failed rows only,
         #sms-bulk-bar verbs, bulk cancel through the house overlay
         (#smscancel-ok) with case-note + status writes, retry scoped to the
         failed subset.

     §F  NITS (B7). £0 loan renders as null does on the case identity card
         (and the board still drops it); a 2099 rate end gets NO "rate
         coming" badge while a 30-day one does; the locale notice appears
         once under a non-en-GB browser locale (Playwright's default en-US),
         dismisses into nx_locale_note, and never paints under en-GB.

     §G  INTRODUCER PORTAL (B6) — STATIC. introducer.html runs against real
         Supabase, so the live reset email round-trip and the
         PASSWORD_RECOVERY event are untestable here; what IS pinned is the
         page's static contract: the Forgot-password button, the
         resetPasswordForEmail call redirecting to the INTRODUCER page, the
         recovery handler, the corrected lede, and the corrected invite copy
         in app.js.

   Run:  node /root/nx/tests/r78_hands.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — see HARNESS.md.)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

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

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  return srv;
}

async function boot(browser, persona, ctxOpts) {
  const page = await (await browser.newContext(Object.assign({ viewport: { width: 1440, height: 900 } }, ctxOpts || {}))).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));
const noNewErr = (page, before) => realErrs(page).length === (before || 0);

const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 2800 : ms);
};
const txt = (page, sel) => page.$eval(sel, (e) => (e.textContent || "").replace(/\s+/g, " ").trim()).catch(() => null);

let uniq = 0;
const tag = () => `R78${Date.now().toString(36)}${++uniq}`;

/* The suite's OWN calendar arithmetic — independent of app.js, so the expected
   roll is computed twice from two implementations and compared. */
const addDays = (ymd, n) => {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const rollWeekend = (ymd) => {
  const dow = new Date(ymd + "T12:00:00").getDay();
  if (dow === 6) return addDays(ymd, 2);
  if (dow === 0) return addDays(ymd, 1);
  return ymd;
};

async function mkCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const { data: cl, error: ce } = await db.from("clients").insert({
      first_name: o.first, last_name: o.last, email: o.email || `${o.last.toLowerCase()}@example.com`, phone: o.phone || "07700900123",
    }).select("id").single();
    if (ce) throw new Error("client insert: " + ce.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "application" }, o.case || {});
    const { data: cs, error: se } = await db.from("cases").insert(row).select("id").single();
    if (se) throw new Error("case insert: " + se.message);
    return { clientId: cl.id, caseId: cs.id };
  }, opts);
}

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {

    /* =====================================================================
       §A · B1 — the house overlays trap focus; close restores it
       ===================================================================== */
    {
      console.log("\n— §A · overlay focus trap: Tab wraps inside confirmTyped, Escape cancels, close-restore survives a repaint (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;

      // A confirmTyped raised fire-and-forget; the promise's answer is read back at the end.
      await page.evaluate(() => {
        window.__r78typed = window.confirmTyped({ title: "Delete this thing?", body: "It cannot come back.", keyword: "DELETE", okLabel: "Delete permanently" });
      });
      await page.waitForTimeout(400);
      const opened = await page.evaluate(() => ({
        up: !document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        focus: document.activeElement && document.activeElement.id,
      }));
      ok("§A1 · confirmTyped is up with its input focused", opened.up && opened.focus === "ovl-typed-input", JSON.stringify(opened));

      // Ten Tabs forward: every stop stays inside #overlay-modal — the sidebar is never reached.
      const stops = [];
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press("Tab");
        stops.push(await page.evaluate(() => {
          const el = document.activeElement;
          return {
            id: el && el.id, inOverlay: !!(el && el.closest && el.closest("#overlay-modal")),
            inSidebar: !!(el && el.closest && el.closest(".sidenav, .sidebar")),
          };
        }));
      }
      ok("§A2 · ten Tab presses never leave the overlay", stops.every((s) => s.inOverlay), JSON.stringify(stops));
      ok("§A2b · …and never reach the sidebar", stops.every((s) => !s.inSidebar), JSON.stringify(stops));
      ok("§A2c · …and the cycle re-visits the typed input (wrap-around, not a dead end)",
        stops.filter((s) => s.id === "ovl-typed-input").length >= 2, JSON.stringify(stops.map((s) => s.id)));

      // Shift+Tab from the FIRST control wraps to the LAST (the disabled OK is not focusable,
      // so with nothing typed the last enabled control is Cancel).
      await page.evaluate(() => document.querySelector("#ovl-typed-input").focus());
      await page.keyboard.press("Shift+Tab");
      const back = await page.evaluate(() => document.activeElement && document.activeElement.id);
      eq("§A3 · Shift+Tab from the first control wraps to the last enabled one", back, "ovl-typed-cancel");

      // Escape still cancels — the promise answers false and the overlay is gone.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const escd = await page.evaluate(async () => ({
        gone: document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        answer: await window.__r78typed,
      }));
      ok("§A4 · Escape cancels: overlay gone, promise answered false", escd.gone && escd.answer === false, JSON.stringify(escd));

      /* Close-restore with a REPAINTED opener: a button with an id takes focus, raises a
         confirmDestructive, is destroyed and rebuilt (same id) while the overlay is up — the
         old prevFocus node is out of the document — then Cancel closes the overlay. Focus must
         land on the id-twin, not fall to <body>. */
      await page.evaluate(() => {
        const host = document.createElement("div");
        host.id = "r78-repaint-host";
        host.innerHTML = `<button type="button" id="r78-opener">open</button>`;
        document.body.appendChild(host);
        document.getElementById("r78-opener").focus();
        window.__r78conf = window.confirmDestructive({ title: "Sure?", body: "test", okLabel: "Do it" });
      });
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        // The repaint: the focused opener node is thrown away and an id-twin takes its place.
        document.getElementById("r78-repaint-host").innerHTML = `<button type="button" id="r78-opener">open (repainted)</button>`;
      });
      await page.click("#ovl-confirm-cancel");
      await page.waitForTimeout(300);
      const restored = await page.evaluate(() => ({
        focusId: document.activeElement && document.activeElement.id,
        isBody: document.activeElement === document.body,
      }));
      eq("§A5 · close-restore lands on the repainted opener (id twin), not on <body>", restored.focusId, "r78-opener");
      await page.evaluate(() => { const h = document.getElementById("r78-repaint-host"); if (h) h.remove(); });

      ok("§A · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =====================================================================
       §B · B2 — every diary appointment block is keyboard-openable, 3 views
       ===================================================================== */
    {
      console.log("\n— §B · diary keyboard access: focusable blocks in month/week/day, Enter opens (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      const label = tag();

      // One appointment TODAY at 10:00, so all three views of "now" contain it.
      const seeded = await mkCase(page, { first: "Diary", last: `Keys${label}` });
      const apId = await page.evaluate(async ({ caseId, clientId, title }) => {
        const today = localDateStr();
        const { data, error } = await window.__mockDb.from("appointments").insert({
          title, case_id: caseId, client_id: clientId, staff_id: "p1",
          starts_at: today + "T10:00:00", ends_at: today + "T11:00:00",
        }).select("id").single();
        if (error) throw new Error(error.message);
        return data.id;
      }, { caseId: seeded.caseId, clientId: seeded.clientId, title: `Keyboard fact find ${label}` });

      await goPage(page, "diary", 3000);
      const audit = async (viewBtn, scopeSel) => {
        if (viewBtn) { await page.click(viewBtn); await page.waitForTimeout(2200); }
        return page.evaluate((sel) => {
          const blocks = [...document.querySelectorAll(sel)];
          return {
            n: blocks.length,
            focusable: blocks.filter((b) => b.getAttribute("tabindex") === "0").length,
            roled: blocks.filter((b) => b.getAttribute("role") === "button").length,
            labelled: blocks.filter((b) => /^Open appointment/.test(b.getAttribute("aria-label") || "")).length,
          };
        }, scopeSel);
      };

      const week = await audit("#diary-view-week", "#diary-week-view .appt-block");
      ok("§B1 · WEEK: every rendered block is focusable + role=button + labelled from the title",
        week.n > 0 && week.focusable === week.n && week.roled === week.n && week.labelled === week.n, JSON.stringify(week));
      const month = await audit("#diary-view-month", "#diary-grid .appt");
      ok("§B2 · MONTH: same, on the .appt tiles",
        month.n > 0 && month.focusable === month.n && month.roled === month.n && month.labelled === month.n, JSON.stringify(month));
      const day = await audit("#diary-view-day", "#diary-day-lane .appt-block");
      ok("§B3 · DAY: same, on the lane blocks",
        day.n > 0 && day.focusable === day.n && day.roled === day.n && day.labelled === day.n, JSON.stringify(day));

      // Enter on the seeded block opens the appointment editor with that appointment's title.
      await page.evaluate((id) => document.querySelector(`#diary-day-lane .appt-block[data-appt="${id}"]`).focus(), apId);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
      const openedAppt = await page.evaluate(() => ({
        modal: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
        title: (document.querySelector('#appt-form [name="title"]') || {}).value || "",
      }));
      ok("§B4 · Enter on a focused block opens THAT appointment's editor",
        openedAppt.modal && openedAppt.title === `Keyboard fact find ${label}`, JSON.stringify(openedAppt));
      await page.evaluate(() => window.closeModal());

      ok("§B · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =====================================================================
       §C · B3 — week on a phone: scrolled to today, chevrons present
       ===================================================================== */
    {
      console.log("\n— §C · 390×844 week view: scrollLeft puts today's lane in view; board-style chevrons (p1)");
      const page = await boot(browser, "p1", { viewport: { width: 390, height: 844 } });
      const errBefore = realErrs(page).length;

      await goPage(page, "diary", 3000);
      // The phone default is Day (R75); the week view is a press away.
      await page.click("#diary-view-week");
      await page.waitForTimeout(2500);

      const wk = await page.evaluate(() => {
        const host = document.querySelector("#diary-week-view");
        const wrap = document.querySelector("#diary-week-wrap");
        const lane = host.querySelector(".dw-lane.today");
        const hours = host.querySelector(".dw-hours");
        const hostRect = host.getBoundingClientRect();
        const laneRect = lane ? lane.getBoundingClientRect() : null;
        const laneLeft = lane ? laneRect.left - hostRect.left + host.scrollLeft : null;
        const expected = lane ? Math.max(0, Math.min(laneLeft - ((hours && hours.offsetWidth) || 0), host.scrollWidth - host.clientWidth)) : null;
        return {
          overflows: host.scrollWidth > host.clientWidth + 1,
          hasTodayLane: !!lane,
          scrollLeft: host.scrollLeft,
          expected,
          laneVisible: lane ? (laneRect.left >= hostRect.left - 2 && laneRect.left < hostRect.right) : null,
          wrapIsBoardWrap: !!wrap && wrap.classList.contains("board-scroll-wrap"),
          discs: wrap ? [!!wrap.querySelector(".board-scroll-arrow"), !!wrap.querySelector(".board-scroll-arrow-left")] : null,
          anyChevronClass: wrap ? (wrap.classList.contains("can-scroll-right") || wrap.classList.contains("can-scroll-left")) : false,
        };
      });
      ok("§C1 · fixture — at 390px the week grid genuinely overflows and today is in this week",
        wk.overflows && wk.hasTodayLane, JSON.stringify(wk));
      ok("§C2 · scrollLeft is the today-lane offset minus the hour column (±2px, clamped)",
        wk.expected != null && Math.abs(wk.scrollLeft - wk.expected) <= 2, JSON.stringify({ got: wk.scrollLeft, want: wk.expected }));
      ok("§C2b · …so today's lane is actually inside the viewport", wk.laneVisible === true, JSON.stringify(wk));
      ok("§C3 · the wrap is a board-scroll-wrap with both discs and a live can-scroll class",
        wk.wrapIsBoardWrap && wk.discs && wk.discs[0] && wk.discs[1] && wk.anyChevronClass, JSON.stringify(wk));

      // Paging to a week that does NOT hold today: the today-scroll must not fire — the scroller
      // keeps exactly the position it had (the element persists across the innerHTML repaint), so
      // an unchanged scrollLeft IS the proof that no write happened.
      const beforePrev = await page.evaluate(() => document.querySelector("#diary-week-view").scrollLeft);
      await page.click("#diary-prev");
      await page.waitForTimeout(2200);
      const prevWk = await page.evaluate(() => ({
        hasTodayLane: !!document.querySelector("#diary-week-view .dw-lane.today"),
        scrollLeft: document.querySelector("#diary-week-view").scrollLeft,
      }));
      ok("§C4 · a week without today fires no today-scroll (scrollLeft untouched by the repaint)",
        !prevWk.hasTodayLane && prevWk.scrollLeft === beforePrev, JSON.stringify({ beforePrev, prevWk }));

      // Leaving the week view takes the chevrons with it.
      await page.click("#diary-view-month");
      await page.waitForTimeout(1800);
      const offWeek = await page.evaluate(() => {
        const wrap = document.querySelector("#diary-week-wrap");
        return wrap.classList.contains("can-scroll-right") || wrap.classList.contains("can-scroll-left");
      });
      ok("§C5 · month view carries no stale week chevron classes", offWeek === false);

      ok("§C · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =====================================================================
       §D · B4 — weekend-aware snooze and quick-dues
       ===================================================================== */
    {
      console.log("\n— §D · weekend roll: snooze lands Monday with the toast clause; explicit dates untouched (p2)");
      const page = await boot(browser, "p2");
      const errBefore = realErrs(page).length;
      const todayStr = await page.evaluate(() => localDateStr());
      const label = tag();

      const mkTask = async (caseId, due) => page.evaluate(({ caseId, due }) =>
        window.__mockDb.from("case_tasks").insert({ case_id: caseId, title: "R78 roll probe", due_date: due, assigned_to: "p2" })
          .select("id").single().then((r) => r.data.id), { caseId, due });
      const dueOf = (id) => page.evaluate((id) =>
        window.__mockDb.from("case_tasks").select("due_date").eq("id", id).single().then((r) => r.data.due_date), id);
      const c1 = await mkCase(page, { first: "Roll", last: `Sat${label}` });

      /* D1 — a snooze engineered to LAND on Saturday, whatever today is: days-to-next-Saturday
         (7 when today IS Saturday). Expected = the Monday after; toast carries the clause. */
      const dow = new Date(todayStr + "T12:00:00").getDay();
      const toSat = ((6 - dow + 7) % 7) || 7;
      const t1 = await mkTask(c1.caseId, todayStr);
      await page.evaluate(({ id, days }) => window.snoozeTask(id, days), { id: t1, days: toSat });
      await page.waitForTimeout(600);
      const satLanding = addDays(todayStr, toSat);
      eq("§D1 · a snooze landing on Saturday is written as the following Monday", await dueOf(t1), rollWeekend(satLanding));
      const toast1 = await txt(page, "#toast");
      ok("§D1b · …and the toast says so: “Snoozed to Monday — skipped the weekend”",
        /^Snoozed to Monday — skipped the weekend/.test(toast1 || ""), toast1);

      // D2 — a snooze landing MIDWEEK (next Wednesday) does not roll and keeps the plain toast.
      const toWed = ((3 - dow + 7) % 7) || 7;
      const t2 = await mkTask(c1.caseId, todayStr);
      await page.evaluate(({ id, days }) => window.snoozeTask(id, days), { id: t2, days: toWed });
      await page.waitForTimeout(600);
      eq("§D2 · a midweek landing is untouched", await dueOf(t2), addDays(todayStr, toWed));
      const toast2 = await txt(page, "#toast");
      ok("§D2b · …with the plain snooze toast (no weekend clause)",
        /^Snoozed — now due /.test(toast2 || "") && !/weekend/.test(toast2 || ""), toast2);

      // D3 — an EXPLICIT Saturday through snoozeTaskTo stays Saturday: picked dates are the human's.
      const t3 = await mkTask(c1.caseId, todayStr);
      await page.evaluate(({ id, v }) => window.snoozeTaskTo(id, v), { id: t3, v: satLanding });
      await page.waitForTimeout(500);
      eq("§D3 · an explicitly PICKED Saturday is written as Saturday — only relative verbs roll", await dueOf(t3), satLanding);

      // D4 — the case modal's "Tomorrow" Due chip fills the date box with the ROLLED date.
      await page.evaluate((id) => window.openCase(id), c1.caseId);
      await page.waitForTimeout(2200);
      await page.click('#modal .due-chip[data-days="1"]');
      const chipVal = await page.$eval("#new-task-due", (e) => e.value);
      eq("§D4 · the Tomorrow chip fills the visible date box with the weekend-rolled date", chipVal, rollWeekend(addDays(todayStr, 1)));

      // D5 — the dateless quick-add default: due = rolled tomorrow, toast branch-correct.
      await page.$eval("#new-task-due", (e) => { e.value = ""; });
      await page.fill("#new-task", `Dateless roll probe ${label}`);
      await page.click("#add-task-btn");
      await page.waitForTimeout(800);
      const t5row = await page.evaluate(async (title) => {
        const { data } = await window.__mockDb.from("case_tasks").select("id,title,due_date");
        return (data || []).find((x) => x.title === title) || null;
      }, `Dateless roll probe ${label}`);
      const wantTomorrow = rollWeekend(addDays(todayStr, 1));
      ok("§D5 · a dateless task submit lands on the rolled tomorrow", t5row && t5row.due_date === wantTomorrow, JSON.stringify({ t5row, wantTomorrow }));
      const toast5 = await txt(page, "#toast");
      const rolled = wantTomorrow !== addDays(todayStr, 1);
      ok(`§D5b · …with the branch-correct toast (${rolled ? "weekend" : "plain"} today)`,
        rolled ? toast5 === "Task added — due Monday (no date was picked — skipped the weekend)"
          : toast5 === "Task added — due tomorrow (no date was picked)", toast5);
      await page.evaluate(() => window.closeModal());

      ok("§D · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =====================================================================
       §E · B5 — SMS selection parity
       ===================================================================== */
    {
      console.log("\n— §E · SMS queue: .sms-cb selection, house-overlay bulk cancel, failed-scoped retry (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      const label = tag();

      const person = await mkCase(page, { first: "Sms", last: `Bulk${label}`, phone: "07700900456" });
      const seed = await page.evaluate(async ({ clientId, caseId }) => {
        const db = window.__mockDb;
        const mk = async (status, withCase) => {
          const { data, error } = await db.from("sms_queue").insert({
            client_id: clientId, case_id: withCase ? caseId : null, sms_type: "appointment_reminder",
            to_phone: "07700900456", status, body: "r78 probe",
          }).select("id").single();
          if (error) throw new Error(error.message);
          return data.id;
        };
        return { q1: await mk("queued", true), q2: await mk("queued", false), f1: await mk("failed", true), s1: await mk("sent", false) };
      }, person);

      await goPage(page, "emails", 3200);
      const shape = await page.evaluate((ids) => {
        const cb = (id) => document.querySelector(`#sms-list .sms-cb[data-id="${id}"]`);
        return {
          q1: !!cb(ids.q1), q2: !!cb(ids.q2), f1: !!cb(ids.f1), s1: !!cb(ids.s1),
          sentRowHasGap: (() => {
            const box = document.querySelector(`#sms-list .sms-cb[data-id="${ids.s1}"]`);
            if (box) return false;
            // find the sent row by its badge + absence of checkbox — the gap keeps the gutter
            return [...document.querySelectorAll("#sms-list .row-item")].some((r) => r.querySelector(".sms-cb-gap"));
          })(),
          barHidden: document.querySelector("#sms-bulk-bar").hidden,
        };
      }, seed);
      ok("§E1 · queued and failed rows carry .sms-cb; sent rows a .sms-cb-gap; the bar starts hidden",
        shape.q1 && shape.q2 && shape.f1 && !shape.s1 && shape.sentRowHasGap && shape.barHidden, JSON.stringify(shape));

      // Select one queued + the failed one: bar shows 2, retry counts ONLY the failed subset.
      await page.check(`#sms-list .sms-cb[data-id="${seed.q1}"]`);
      await page.check(`#sms-list .sms-cb[data-id="${seed.f1}"]`);
      const bar = await page.evaluate(() => ({
        hidden: document.querySelector("#sms-bulk-bar").hidden,
        n: document.querySelector("#sms-bulk-n").textContent,
        cancelLbl: document.querySelector("#sms-bulk-cancel").textContent.trim(),
        retryLbl: document.querySelector("#sms-bulk-retry").textContent.trim(),
        retryDisabled: document.querySelector("#sms-bulk-retry").disabled,
      }));
      ok("§E2 · the bar counts the selection and scopes Retry to the failed subset",
        !bar.hidden && bar.n === "2" && bar.cancelLbl === "Cancel selected (2)" && bar.retryLbl === "Retry failed (1)" && !bar.retryDisabled,
        JSON.stringify(bar));

      // Bulk cancel: the HOUSE overlay (never a native confirm), then the guarded write + note.
      await page.click("#sms-bulk-cancel");
      await page.waitForTimeout(600);
      const ovl = await page.evaluate(() => ({
        up: !document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        ok: !!document.querySelector("#smscancel-ok"),
        cancel: !!document.querySelector("#smscancel-cancel"),
        body: (document.querySelector("#overlay-modal") || {}).textContent || "",
        nativeDialogs: (window.__nothing, null),
      }));
      ok("§E3 · bulk cancel confirms through the house overlay (#smscancel-ok), not a native confirm",
        ovl.up && ovl.ok && ovl.cancel && page.__dialogs.length === 0, JSON.stringify({ up: ovl.up, ok: ovl.ok, dialogs: page.__dialogs }));
      ok("§E3b · …whose copy says a cancelled SMS never sends and names the 8:05am run",
        /cancelled SMS never sends/i.test(ovl.body) && /8:05am/.test(ovl.body), ovl.body.slice(0, 260));
      await page.click("#smscancel-ok");
      await page.waitForTimeout(2200);
      const afterCancel = await page.evaluate(async (ids) => {
        const db = window.__mockDb;
        const st = async (id) => (await db.from("sms_queue").select("status").eq("id", id).single()).data.status;
        const { data: notes } = await db.from("case_notes").select("body,case_id");
        return {
          q1: await st(ids.q1), f1: await st(ids.f1), q2: await st(ids.q2), s1: await st(ids.s1),
          note: (notes || []).some((n) => /SMS to Sms Bulk/.test(n.body) && /\(bulk\)/.test(n.body)),
          toast: (document.getElementById("toast") || {}).textContent || "",
        };
      }, seed);
      ok("§E4 · the two selected rows are cancelled; the unselected queued row and the sent row are untouched",
        afterCancel.q1 === "cancelled" && afterCancel.f1 === "cancelled" && afterCancel.q2 === "queued" && afterCancel.s1 === "sent",
        JSON.stringify(afterCancel));
      ok("§E4b · the case-linked cancellation left a (bulk) case note", afterCancel.note === true, JSON.stringify(afterCancel));
      ok("§E4c · one summary toast", /^2 SMS cancelled — they will never send/.test(afterCancel.toast), afterCancel.toast);

      // Retry parity: select a failed + a queued row; Retry re-queues ONLY the failed one.
      const seed2 = await page.evaluate(async ({ clientId, caseId }) => {
        const db = window.__mockDb;
        const mk = async (status) => (await db.from("sms_queue").insert({
          client_id: clientId, case_id: caseId, sms_type: "appointment_reminder",
          to_phone: "07700900456", status, error: status === "failed" ? "undeliverable" : null, body: "r78 probe 2",
        }).select("id").single()).data.id;
        return { f2: await mk("failed"), q3: await mk("queued") };
      }, person);
      await goPage(page, "emails", 3000);
      await page.check(`#sms-list .sms-cb[data-id="${seed2.f2}"]`);
      await page.check(`#sms-list .sms-cb[data-id="${seed2.q3}"]`);
      await page.click("#sms-bulk-retry");
      await page.waitForTimeout(2500);
      const afterRetry = await page.evaluate(async (ids) => {
        const db = window.__mockDb;
        const row = async (id) => (await db.from("sms_queue").select("status,sent_at").eq("id", id).single()).data;
        return { f2: await row(ids.f2), q3: await row(ids.q3) };
      }, seed2);
      ok("§E5 · bulk Retry re-queues the failed row and leaves the queued one alone",
        afterRetry.f2.status === "queued" && afterRetry.q3.status === "queued" && !afterRetry.f2.sent_at, JSON.stringify(afterRetry));

      ok("§E · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =====================================================================
       §F · B7 — the nits: £0 loan, 2099 badge, locale notice
       ===================================================================== */
    {
      console.log("\n— §F · nits: £0 loan reads as not-recorded; 2099 gets no rate-coming badge; the locale notice (p4)");
      const page = await boot(browser, "p4");   // Playwright's default locale is en-US → the notice's home turf
      const errBefore = realErrs(page).length;
      const label = tag();

      // F1 — £0 loan on the case identity card renders exactly as null does ("—").
      const zero = await mkCase(page, { first: "Zero", last: `Loan${label}`, case: { loan_amount: 0, property_value: 300000 } });
      const nul = await mkCase(page, { first: "Null", last: `Loan${label}`, case: { loan_amount: null } });
      const loanStat = async (caseId) => {
        await page.evaluate((id) => window.openCase(id), caseId);
        await page.waitForTimeout(2200);
        const v = await page.evaluate(() => {
          const stat = [...document.querySelectorAll(".cs-stat")].find((s) => (s.querySelector(".cs-lbl") || {}).textContent === "Loan");
          return stat ? stat.querySelector(".cs-val").textContent.trim() : null;
        });
        await page.evaluate(() => window.closeModal());
        await page.waitForTimeout(400);
        return v;
      };
      const zeroVal = await loanStat(zero.caseId);
      const nullVal = await loanStat(nul.caseId);
      ok("§F1 · a £0 loan_amount renders on the identity card exactly as null does", zeroVal === nullVal && zeroVal === "—",
        JSON.stringify({ zeroVal, nullVal }));

      // F2 — gone-quiet badge: 2099 no badge, +30 days badge. Both clients are silent (no
      // contact rows at all), so both land on the cold list — r41 §H's own fixture shape.
      const todayStr = await page.evaluate(() => localDateStr());
      const far = await mkCase(page, { first: "R78far", last: `Rate${label}`, case: { rate_end_date: "2099-12-31" } });
      const soon = await mkCase(page, { first: "R78soon", last: `Rate${label}`, case: { rate_end_date: addDays(todayStr, 30) } });
      await goPage(page, "retention", 3200);
      const badges = await page.evaluate((ids) => {
        const rowOf = (cid) => {
          const t = document.querySelector(`#ret-cold-list .t[onclick="openClient('${cid}')"]`);
          return t ? t.closest(".row-item") : null;
        };
        const read = (cid) => {
          const r = rowOf(cid);
          return r ? { found: true, badge: [...r.querySelectorAll(".badge")].some((b) => /rate coming/.test(b.textContent)), rate: (r.querySelector(".client-rate-bit") || {}).textContent || "" } : { found: false };
        };
        return { far: read(ids.far), soon: read(ids.soon) };
      }, { far: far.clientId, soon: soon.clientId });
      ok("§F2 · fixture — both silent clients are on the gone-quiet list", badges.far.found && badges.soon.found, JSON.stringify(badges));
      ok("§F2b · the 2099 rate end still prints its date but wears NO “rate coming” badge",
        badges.far.found && !badges.far.badge && /2099/.test(badges.far.rate), JSON.stringify(badges.far));
      ok("§F2c · a rate ending in 30 days DOES wear the badge", badges.soon.found && badges.soon.badge === true, JSON.stringify(badges.soon));

      // F3 — the locale notice: present under en-US (this context), dismisses once, never returns.
      await goPage(page, "dashboard", 2600);
      const note1 = await page.evaluate(() => ({
        needed: window.localeNoticeNeeded(),
        shown: !!document.querySelector("#locale-note"),
        text: (document.querySelector("#locale-note") || {}).textContent || "",
      }));
      ok("§F3 · under a non-en-GB browser locale the note paints once on Today",
        note1.needed && note1.shown && /month-first \(m\/d\/y\)/.test(note1.text) && /this app displays them as/.test(note1.text),
        JSON.stringify(note1));
      await page.click("#locale-note-dismiss");
      await page.waitForTimeout(300);
      const note2 = await page.evaluate(() => ({
        shown: !!document.querySelector("#locale-note"),
        stored: (() => { try { return !!localStorage.getItem("nx_locale_note"); } catch (e) { return "ERR"; } })(),
        neededNow: window.localeNoticeNeeded(),
      }));
      ok("§F3b · “Got it” removes it, records nx_locale_note, and the gate answers false from then on",
        !note2.shown && note2.stored === true && note2.neededNow === false, JSON.stringify(note2));
      await page.evaluate(() => renderLocaleNotice());
      ok("§F3c · a repaint does not resurrect it", await page.evaluate(() => !document.querySelector("#locale-note")));

      ok("§F · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();

      // F4 — an en-GB browser never sees it (fresh context with the real locale).
      const gb = await boot(browser, "p1", { locale: "en-GB" });
      const gbNote = await gb.evaluate(() => ({
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        needed: window.localeNoticeNeeded(),
        shown: !!document.querySelector("#locale-note"),
      }));
      ok("§F4 · an en-GB browser locale gets no note at all", /^en-GB$/i.test(gbNote.locale) && !gbNote.needed && !gbNote.shown,
        JSON.stringify(gbNote));
      await gb.close();
    }

    /* =====================================================================
       §G · B6 — introducer portal reset, static contract
       ===================================================================== */
    {
      console.log("\n— §G · introducer.html: forgot-password + recovery + honest copy (static — the live Supabase round-trip is untestable here)");
      const html = fs.readFileSync(path.join(REPO, "admin", "introducer.html"), "utf8");
      ok("§G1 · the login card carries a “Forgot password?” button (#forgot-btn)",
        /id="forgot-btn"/.test(html) && /Forgot password\?/.test(html));
      ok("§G2 · it calls resetPasswordForEmail with redirectTo the INTRODUCER page, not the admin app",
        /resetPasswordForEmail\(email,\s*\{\s*redirectTo:\s*INTRODUCER_URL\s*\}\)/.test(html)
        && /const INTRODUCER_URL = new URL\(window\.location\.pathname, window\.location\.origin\)\.href/.test(html));
      ok("§G3 · the page handles PASSWORD_RECOVERY (waits for the event on a type=recovery hash, app.js's pattern)",
        /PASSWORD_RECOVERY/.test(html) && /type=recovery/.test(html) && /showRecovery/.test(html) && /updateUser\(\{\s*password/.test(html));
      ok("§G4 · the recovery takeover cannot crash the old submit handler (the login-email guard)",
        /if \(!\$\("#login-email"\)\) return;/.test(html));
      ok("§G5 · the lede stopped claiming real time: “Refreshed each time you sign in”",
        !/Updated in real time/.test(html) && /Refreshed each time you sign in/.test(html));
      const appjs = fs.readFileSync(path.join(REPO, "admin", "app.js"), "utf8");
      ok("§G6 · the invite copy sends introducers to the introducer page and its Forgot password?",
        /introducer page address/.test(appjs) && /introducer\.html/.test(appjs) && /“Forgot password\?” on that page/.test(appjs));
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(`\nr78_hands: ${pass} passed, ${failures.length} failed`);
  if (failures.length) failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
