#!/usr/bin/env node
/* =============================================================================
   tests/r68_mi.js — acceptance tests for R68 agent A ("MI + settings")

   §A  M7 · ADVISER TARGETS REACH THE ADVISER — Reports › My numbers grows a
       "Fees earned this month vs my target" bar plus two month/all-time KPIs
       (attach rate, retention conversion), all three computed by the SAME
       helpers the owner-only scoreboard uses. With no target set the card says
       so in words — never NaN, never 0%. With a target it reads
       "£X of £Y target · N%", independently recomputed here off __mockDb. The
       adviser's attach rate equals the scoreboard's row for the same person in
       the same month, and the scoreboard's own figures are unchanged.

   §B  M14 · CHANGE HISTORY CSV — a "⭳ CSV" button beside the Settings ›
       Change history filters exports the CURRENT FILTER across ALL pages, not
       the 25 rows on screen. Row counts are checked against __mockDb for the
       unfiltered log and for two different filters; the columns and the button
       label are pinned. Owner-only, like the panel.

   §C  M15 · EMAIL SENDING STATUS — one strip at the top of Settings that
       PROBES process-emails ({queue_ids: []}, the safe probe) and renders the
       three real states: NOT CONFIGURED (no Resend key), CONFIGURED but HELD,
       and LIVE. The owner's release control is REFUSED (not hidden) with no
       key; with a key it takes a typed SEND and writes email_hold = 'off'.
       An admin sees the strip and no button; an adviser sees no strip.

   §D  M16 · ADMIN OPS STRIP ON TODAY — #ops-strip chips for admin/owner only,
       each count checked against __mockDb, grey at zero and amber above it.

   §E  A5 · protection_referral_partner — the Settings field that never existed
       for a setting REFERRAL_META.protection has read since R66. It round-trips
       through the normal save path and pre-fills the protection referral
       overlay.

   §F  No console/page errors for every persona touched.

   NOTE ON PERSONAS: p1 Kim Martin is the ADMIN, p2 Wayne Kellow and p3 Luke
   Richards are ADVISERS, p4 Daniel Potts is the OWNER (see mock-supabase.js
   PERSONAS). Owner-only checks below use p4, admin-only checks use p1.

   Run:  node /root/nx/tests/r68_mi.js   (expects a static server on 8099;
                                          starts one itself if absent)
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
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }

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

/* The localStorage clear-list every suite carries: a stored scope/window/filter from a previous
   run must never decide what this one measures. R64 added nx_ret_month and nx_clients_adviser. */
const NX_KEYS = ["nx_ret_month", "nx_ret_scope", "nx_wt_lastrun", "nx_clients_adviser", "nx_tour_done"];
async function boot(browser, persona) {
  const ctx = await browser.newContext();
  await ctx.addInitScript((keys) => {
    try { keys.forEach((k) => localStorage.removeItem(k)); } catch (e) { /* private mode — the app copes, so must the test */ }
  }, NX_KEYS);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push("pageerror: " + String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console: " + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs|favicon/i.test(e));
const wait = (page, ms) => page.waitForTimeout(ms);
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, " ").trim() : null; }, sel);
const has = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);

async function goto(page, id) {
  await page.evaluate((p) => window.nav(p), id);
  await wait(page, 1400);
}
/* Seed a settings row AND make app.js re-read it. The mock's DB is per-page and in-memory, so a
   target has to be seeded inside the very session that reads it — and an ADVISER cannot write to
   settings (the mock enforces the real "owner only" policy, which is the point). So this is a
   FIXTURE NUDGE straight onto __mock.db, not a client write: it is the database arriving in that
   state, exactly as it would if the owner had set the target yesterday. __reloadSettings is
   app.js's sandbox-only re-read (beside __setOwnerRowCap) — what the Save button normally does. */
const setSettingLive = (page, key, value) => page.evaluate(async ({ key, value }) => {
  const rows = window.__mock.db.settings;
  const row = rows.filter((r) => r.key === key)[0];
  if (row) row.value = value;
  else rows.push({ key, value, updated_at: new Date().toISOString() });
  await window.__reloadSettings();
}, { key, value });
const readSetting = (page, key) => page.evaluate(async (k) => {
  const { data } = await window.__mockDb.from("settings").select("*").eq("key", k);
  return (data && data[0]) ? data[0].value : null;
}, key);

/* ---------------------------------------------------------------------------
   CSV capture — the technique r13/r20/r42 already use: override
   URL.createObjectURL + <a download> click so nothing hits disk, then read the
   Blob back as text. miCsv() is not window-exposed.
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
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}
function parseCsv(text) {
  const body = String(text || "").replace(/^﻿/, "");
  const lines = body.split("\n").filter((l) => l.length);
  return { header: parseCsvLine(lines[0] || ""), rows: lines.slice(1).map(parseCsvLine) };
}

const money = (n) => "£" + Math.round(Number(n) || 0).toLocaleString("en-GB");

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       §A · M7 — adviser targets reach the adviser
       =================================================================== */
    {
      console.log("\n— §A · M7 · Reports › My numbers (p3 Luke Richards, adviser)");
      const page = await boot(browser, "p3");
      await goto(page, "reports");

      ok("A0 · the adviser gets the My numbers card at all", await page.evaluate(() => !document.querySelector("#report-mine-panel").classList.contains("hidden")));
      ok("A0b · …and the new target container exists under the tiles", await has(page, "#report-mine-target"));

      /* Ground truth, computed here off __mockDb and NOT from the app: which month p3 actually
         completed cases in (so the month-scoped figures are exercised against real rows rather
         than a vacuous zero), and every figure the card must show for it. */
      const gt = await page.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases").select("*");
        const mine = (cases || []).filter((c) => c.assigned_to === "p3");
        const monthOf = (d) => String(d || "").slice(0, 7);
        const byMonth = {};
        mine.forEach((c) => { if (c.completed_at) byMonth[monthOf(c.completed_at)] = (byMonth[monthOf(c.completed_at)] || 0) + 1; });
        // The busiest completion month for p3 — the one where these figures say the most.
        const mv = Object.keys(byMonth).sort((a, b) => byMonth[b] - byMonth[a] || (a < b ? 1 : -1))[0] || null;
        const done = mv ? mine.filter((c) => c.completed_at && monthOf(c.completed_at) === mv) : [];
        const earned = done.reduce((s, c) => s + (Number(c.proc_fee) || 0) + (Number(c.broker_fee) || 0) + (Number(c.sols_fee) || 0), 0);
        const taken = done.filter((c) => c.protection_status === "policy_taken").length;
        const rets = mine.filter((c) => c.retention_source_case_id);
        const won = rets.filter((c) => c.stage === "completed").length;
        const lost = rets.filter((c) => c.stage === "not_proceeding").length;
        return {
          mv, nDone: done.length, earned, taken,
          attach: done.length ? Math.round((taken / done.length) * 100) : null,
          retWon: won, retLost: lost,
          retPct: (won + lost) ? Math.round((won / (won + lost)) * 100) : null,
        };
      });
      ok("A0c · the fixture gives p3 a month with completions to measure", !!gt.mv && gt.nDone > 0, JSON.stringify(gt));

      // Point the Reports month picker at that month; the card follows the picker.
      await page.evaluate((mv) => {
        const el = document.querySelector("#report-month");
        el.value = mv;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, gt.mv);
      await wait(page, 1500);

      /* --- with NO target set (the state the live firm is actually in) ---------- */
      const noTargetLine = await txt(page, "#report-mine-target");
      ok("A1 · with no target set the bar is replaced by a sentence that says so",
        await has(page, "#report-mine-target-none"), noTargetLine);
      ok("A1b · …in the words the role card asks for (no target yet, ask the owner, Settings › Adviser targets)",
        /no monthly target set for you yet/i.test(noTargetLine || "") && /ask the owner/i.test(noTargetLine || "") && /Adviser targets/i.test(noTargetLine || ""),
        noTargetLine);
      ok("A1c · …and NOT as NaN or a 0% that would read as a failure",
        !/NaN/.test(noTargetLine || "") && !/\b0%/.test(noTargetLine || ""), noTargetLine);
      ok("A1d · no bar is drawn when there is no target to draw one against",
        !(await has(page, "#report-mine-target .fee-bar")), noTargetLine);
      ok("A1e · …but the month's earned figure is still stated, so the reader is not left with nothing",
        (noTargetLine || "").includes(money(gt.earned)), JSON.stringify({ noTargetLine, want: money(gt.earned) }));

      const cardNoTarget = await txt(page, "#report-mine");
      ok("A1f · the whole card is NaN-free with no target set", !/NaN/.test(cardNoTarget || ""), cardNoTarget);

      /* --- the two new KPIs ---------------------------------------------------- */
      const attachTile = await txt(page, "#report-mine-attach");
      const retTile = await txt(page, "#report-mine-retention");
      ok("A2 · My attach rate renders for the picked month",
        (attachTile || "").includes(gt.attach == null ? "—" : `${gt.attach}%`), JSON.stringify({ attachTile, want: gt.attach }));
      ok("A2b · …with the bracket count beside it (n completions, not a bare percentage)",
        (attachTile || "").includes(`${gt.taken} of ${gt.nDone} completion`), attachTile);
      ok("A3 · My retention conversion renders",
        (retTile || "").includes(gt.retPct == null ? "—" : `${gt.retPct}%`), JSON.stringify({ retTile, want: gt.retPct }));
      ok("A3b · …stating the won/lost split it is built from",
        gt.retPct == null || (retTile || "").includes(`${gt.retWon} completed, ${gt.retLost} lost`), JSON.stringify({ retTile, gt }));

      /* --- the scope line names all three windows ------------------------------ */
      const scope = await txt(page, "#report-mine-scope");
      ok("A4 · the scope line says the banked tile is the calendar YEAR", /calendar year/i.test(scope || ""), scope);
      ok("A4b · …that the target bar and attach rate follow the MONTH picker", /follow the month picker/i.test(scope || ""), scope);
      ok("A4c · …and that retention conversion is all-time", /all-time/i.test(scope || ""), scope);

      /* --- now SET a target for p3 and re-render ------------------------------- */
      const TARGET = 9000;
      await setSettingLive(page, "adviser_fee_targets", JSON.stringify({ p3: TARGET }));
      await goto(page, "dashboard");
      await goto(page, "reports");
      await page.evaluate((mv) => {
        const el = document.querySelector("#report-month");
        el.value = mv;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, gt.mv);
      await wait(page, 1500);

      const barLine = await txt(page, "#report-mine-target");
      const wantPct = Math.round((gt.earned / TARGET) * 100);
      ok("A5 · with a target set the bar line appears", await has(page, "#report-mine-target-line"), barLine);
      ok("A5b · …reading “£X of £Y target · N%” with the figures recomputed here",
        (barLine || "").includes(`${money(gt.earned)} of ${money(TARGET)} target · ${wantPct}%`),
        JSON.stringify({ barLine, want: `${money(gt.earned)} of ${money(TARGET)} target · ${wantPct}%` }));
      ok("A5c · …carrying the SAME basis copy as the firm bar (earned · proc+broker+sols · by completion date)",
        /earned · proc\+broker\+sols · by completion date/.test(barLine || ""), barLine);
      ok("A5d · …and stating the completion count that basis is built on",
        (barLine || "").includes(`${gt.nDone} completion`), barLine);
      ok("A5e · a real bar is drawn now", await has(page, "#report-mine-target .fee-bar"));
      ok("A5f · no NaN anywhere on the card with a target set",
        !/NaN/.test((await txt(page, "#report-mine")) + " " + barLine), barLine);

      eq("A6 · no console errors for the adviser", realErr(page), []);
      await page.close();
    }

    /* ===================================================================
       §A2 · the scoreboard is UNCHANGED and agrees with My numbers
       =================================================================== */
    {
      console.log("\n— §A2 · the owner scoreboard still says the same thing (p4 Daniel, owner)");
      const page = await boot(browser, "p4");
      await goto(page, "reports");

      const gt = await page.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases").select("*");
        const mine = (cases || []).filter((c) => c.assigned_to === "p3");
        const monthOf = (d) => String(d || "").slice(0, 7);
        const byMonth = {};
        mine.forEach((c) => { if (c.completed_at) byMonth[monthOf(c.completed_at)] = (byMonth[monthOf(c.completed_at)] || 0) + 1; });
        const mv = Object.keys(byMonth).sort((a, b) => byMonth[b] - byMonth[a] || (a < b ? 1 : -1))[0] || null;
        const done = mv ? mine.filter((c) => c.completed_at && monthOf(c.completed_at) === mv) : [];
        const taken = done.filter((c) => c.protection_status === "policy_taken").length;
        const earned = done.reduce((s, c) => s + (Number(c.proc_fee) || 0) + (Number(c.broker_fee) || 0) + (Number(c.sols_fee) || 0), 0);
        return { mv, nDone: done.length, taken, earned, attach: done.length ? Math.round((taken / done.length) * 100) : null };
      });
      await page.evaluate((mv) => {
        const el = document.querySelector("#report-month");
        el.value = mv;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, gt.mv);
      await wait(page, 1500);

      ok("A7 · the owner sees the scoreboard", await page.evaluate(() => !document.querySelector("#report-scoreboard-panel").classList.contains("hidden")));
      ok("A7b · …and the owner gets NO My numbers card (showMoney already gives them more)",
        await page.evaluate(() => document.querySelector("#report-mine-panel").classList.contains("hidden")));

      // Luke's own row on the scoreboard, read out of the rendered table.
      const row = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#report-advisers tr")];
        const r = rows.find((tr) => /Luke Richards/.test(tr.textContent));
        if (!r) return null;
        const tds = [...r.querySelectorAll("td")].map((td) => td.innerText.replace(/\s+/g, " ").trim());
        return { tds, attachCell: tds[6] || "", targetCell: tds[4] || "" };
      });
      ok("A8 · Luke has a scoreboard row in that month", !!row, JSON.stringify(row));
      ok("A8b · the scoreboard's attach rate for Luke is exactly the independently computed figure",
        !!row && (gt.attach == null ? row.attachCell === "—" : row.attachCell.startsWith(`${gt.attach}%`) && row.attachCell.includes(`(${gt.taken}/${gt.nDone})`)),
        JSON.stringify({ cell: row && row.attachCell, want: gt }));
      ok("A8c · …and the Target cell still reads “—” while no target is set (never 0%)",
        !!row && row.targetCell === "—", JSON.stringify(row && row.targetCell));

      // Set a target and re-check that the scoreboard's Target cell uses the same earned figure.
      const TARGET = 9000;
      await setSettingLive(page, "adviser_fee_targets", JSON.stringify({ p3: TARGET }));
      await goto(page, "dashboard");
      await goto(page, "reports");
      await page.evaluate((mv) => {
        const el = document.querySelector("#report-month");
        el.value = mv;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, gt.mv);
      await wait(page, 1500);
      const targetCell = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#report-advisers tr")];
        const r = rows.find((tr) => /Luke Richards/.test(tr.textContent));
        return r ? [...r.querySelectorAll("td")][4].innerText.replace(/\s+/g, " ").trim() : null;
      });
      ok("A9 · the scoreboard Target cell measures the SAME earned figure the adviser's bar does",
        (targetCell || "").includes(`${money(gt.earned)} / ${money(TARGET)}`) && (targetCell || "").includes(`${Math.round((gt.earned / TARGET) * 100)}%`),
        JSON.stringify({ targetCell, want: `${money(gt.earned)} / ${money(TARGET)}` }));

      /* The firm retention KPI now reads the shared primitive — prove it did not move. */
      const firmRet = await page.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases").select("*");
        const rets = (cases || []).filter((c) => c.retention_source_case_id);
        const won = rets.filter((c) => c.stage === "completed").length;
        const lost = rets.filter((c) => c.stage === "not_proceeding").length;
        return (won + lost) ? Math.round((won / (won + lost)) * 100) + "%" : "—";
      });
      const kpiText = await txt(page, "#report-kpis");
      ok("A10 · the firm Retention conversion tile is unchanged by the refactor",
        (kpiText || "").includes(firmRet), JSON.stringify({ firmRet, kpiText: (kpiText || "").slice(0, 200) }));

      eq("A11 · no console errors for the owner on Reports", realErr(page), []);
      await page.close();
    }

    /* ===================================================================
       §A3 · the admin copy that was not true (Priya F2)
       =================================================================== */
    {
      console.log("\n— §A3 · Settings › Adviser targets, admin copy (p1 Kim, admin)");
      const page = await boot(browser, "p1");
      await goto(page, "settings");
      const note = await txt(page, "#adviser-targets-readonly");
      ok("A12 · the admin still gets the read-only targets section", !!note, JSON.stringify(note));
      ok("A12b · …and is no longer told they can see the adviser scoreboard on Reports",
        !/scoreboard you can see/i.test(note || ""), note);
      ok("A12c · …it says the scoreboard is Owner-only, which is what showMoney() actually does",
        /Owner-only/i.test(note || "") && /not on your Reports page/i.test(note || ""), note);
      ok("A12d · …and points at where the targets DO reach an adviser",
        /My numbers/i.test(note || ""), note);
      eq("A13 · no console errors for the admin on Settings", realErr(page), []);
      await page.close();
    }

    /* ===================================================================
       §B · M14 — change history CSV
       =================================================================== */
    {
      console.log("\n— §B · M14 · Settings › Change history CSV (p4 Daniel, owner)");
      const page = await boot(browser, "p4");
      await goto(page, "settings");

      ok("B1 · the owner gets the change-history panel", await page.evaluate(() => !document.querySelector("#change-history-panel").classList.contains("hidden")));
      const label = await page.evaluate(() => { const b = document.querySelector("#ch-csv"); return b ? b.textContent.trim() : null; });
      eq("B1b · the button is labelled “⭳ CSV” (house rule — never ⬇)", label, "⭳ CSV");
      ok("B1c · a line under the filters says the export covers every page, not just this one",
        /every change these filters match/i.test((await txt(page, "#ch-csv-note")) || ""), await txt(page, "#ch-csv-note"));

      const gt = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("audit_log").select("*");
        const all = data || [];
        const profileRows = all.filter((r) => r.table_name === "profiles").length;
        // "Tasks, notes & appointments" is a GROUP of three tables — the widest group filter.
        const workRows = all.filter((r) => ["case_tasks", "case_notes", "appointments"].includes(r.table_name)).length;
        return { total: all.length, profileRows, workRows };
      });
      ok("B1d · the fixture log is bigger than one page, so “all pages” means something",
        gt.total > 25, JSON.stringify(gt));

      await armCsvCapture(page);
      await resetCsvCapture(page);
      await page.click("#ch-csv");
      await wait(page, 900);
      const name = await readCsvName(page);
      const csv = parseCsv(await readCsv(page));
      ok("B2 · clicking CSV produced a download", !!name && csv.rows.length > 0, JSON.stringify({ name, rows: csv.rows.length }));
      ok("B2b · …named for the firm and the day", /^nexmoney-change-history-\d{4}-\d{2}-\d{2}\.csv$/.test(name || ""), name);
      eq("B2c · the columns are when / who / what changed / action / record / summary",
        csv.header, ["When", "Who", "What changed", "Action", "Record", "Summary"]);
      eq("B2d · unfiltered, the file holds EVERY row in the log — not the 25 on screen", csv.rows.length, gt.total);

      /* --- now filter, and prove the file follows the filter -------------------- */
      await page.evaluate(() => {
        const sel = document.querySelector("#ch-table");
        sel.value = "profiles";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await wait(page, 900);
      const pagerText = await txt(page, "#ch-pager");
      ok("B3 · the list itself now says how many the filter matches",
        (pagerText || "").includes(`of ${gt.profileRows} change`), JSON.stringify({ pagerText, want: gt.profileRows }));
      await resetCsvCapture(page);
      await page.click("#ch-csv");
      await wait(page, 900);
      const csv2 = parseCsv(await readCsv(page));
      eq("B3b · the CSV holds exactly the filtered count", csv2.rows.length, gt.profileRows);
      ok("B3c · …and every exported row really is a Login row",
        csv2.rows.length > 0 && csv2.rows.every((r) => r[2] === "Login"),
        JSON.stringify(csv2.rows.slice(0, 3)));

      // A multi-table group, to prove the group filter (.in) is applied to the export too.
      await page.evaluate(() => {
        const sel = document.querySelector("#ch-table");
        sel.value = "work";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await wait(page, 900);
      await resetCsvCapture(page);
      await page.click("#ch-csv");
      await wait(page, 900);
      const csv3 = parseCsv(await readCsv(page));
      eq("B4 · a multi-table group filter exports the whole group", csv3.rows.length, gt.workRows);
      ok("B4b · …and only that group",
        csv3.rows.every((r) => ["Task", "Note", "Appointment"].includes(r[2])), JSON.stringify(csv3.rows.slice(0, 3)));

      // A date filter that matches nothing must not produce an empty file.
      await page.evaluate(() => {
        const sel = document.querySelector("#ch-table");
        sel.value = "all";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const from = document.querySelector("#ch-from");
        from.value = "2099-01-01";
        from.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await wait(page, 900);
      await resetCsvCapture(page);
      await page.click("#ch-csv");
      await wait(page, 900);
      const empty = await readCsv(page);
      ok("B5 · a filter that matches nothing downloads nothing and says so", empty == null,
        JSON.stringify({ empty: (empty || "").slice(0, 80) }));

      eq("B6 · no console errors for the owner on Settings", realErr(page), []);
      await page.close();
    }
    {
      console.log("\n— §B2 · the CSV is owner-only, like the panel it lives in (p1 Kim, admin)");
      const page = await boot(browser, "p1");
      await goto(page, "settings");
      ok("B7 · the admin gets no change-history panel", await page.evaluate(() => document.querySelector("#change-history-panel").classList.contains("hidden")));
      ok("B7b · …so no CSV button is offered to them either",
        await page.evaluate(() => { const p = document.querySelector("#change-history-panel"); return p.classList.contains("hidden"); }));
      await page.close();
    }

    /* ===================================================================
       §C · M15 — the Email sending status strip
       =================================================================== */
    {
      console.log("\n— §C · M15 · Email sending status (p4 Daniel, owner)");
      const page = await boot(browser, "p4");
      await goto(page, "settings");
      await wait(page, 800);

      const pendingGt = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("email_queue").select("*");
        const now = new Date().toISOString();
        return (data || []).filter((e) => e.status === "queued" && (!e.scheduled_for || e.scheduled_for <= now)).length;
      });

      /* --- state 1: no Resend key (the harness default, and production's real state) --- */
      let state = await page.evaluate(() => (document.querySelector("#email-sending-line") || {}).dataset ? document.querySelector("#email-sending-line").dataset.state : null);
      let line = await txt(page, "#email-sending-status");
      eq("C1 · with no server key the strip reads NOT CONFIGURED", state, "no_key");
      ok("C1b · …in words: no Resend key on the server, N queued and waiting",
        /Email sending: NOT CONFIGURED/.test(line || "") && /no Resend key on the server/i.test(line || "") && (line || "").includes(`${pendingGt} email`),
        JSON.stringify({ line: (line || "").slice(0, 240), pendingGt }));
      ok("C1c · …and it is amber",
        await page.evaluate(() => document.querySelector("#email-sending-line").classList.contains("warn")));
      ok("C1d · the strip names when the automation last ran", /Last run /.test(line || ""), (line || "").slice(0, 240));
      ok("C1e · the owner is offered a Release control",
        await page.evaluate(() => { const b = document.querySelector("#email-hold-btn"); return !!b && b.dataset.action === "release"; }));

      /* --- releasing with no key is REFUSED, not silently ignored ---------------- */
      const toastText = await page.evaluate(async () => {
        document.querySelector("#email-hold-btn").click();
        await new Promise((r) => setTimeout(r, 600));
        const t = document.querySelector(".toast, #toast");
        return t ? t.textContent.replace(/\s+/g, " ").trim() : null;
      });
      ok("C2 · releasing with no key is refused in words, not by hiding the button",
        /nothing to release/i.test(toastText || "") && /no Resend key/i.test(toastText || ""), JSON.stringify(toastText));
      eq("C2b · …and email_hold is untouched", await readSetting(page, "email_hold"), "on");
      ok("C2c · …and no typed-keyword overlay was ever opened (it never got that far)",
        await page.evaluate(() => !document.querySelector("#typed-word")));

      /* --- state 2: key present, hold on ---------------------------------------- */
      await page.evaluate(() => window.__mock.setResendKey(true));
      await goto(page, "dashboard");
      await goto(page, "settings");
      await wait(page, 800);
      state = await page.evaluate(() => document.querySelector("#email-sending-line").dataset.state);
      line = await txt(page, "#email-sending-status");
      eq("C3 · with a key and the hold on, the strip reads CONFIGURED but HELD", state, "held");
      ok("C3b · …in words: nothing sends until the hold is released, N due now would send",
        /CONFIGURED but HELD/.test(line || "") && /nothing sends until the hold is released/i.test(line || "") && (line || "").includes(`${pendingGt} email`),
        JSON.stringify({ line: (line || "").slice(0, 240), pendingGt }));
      ok("C3c · …still amber", await page.evaluate(() => document.querySelector("#email-sending-line").classList.contains("warn")));

      /* --- releasing needs the typed keyword ------------------------------------ */
      await page.click("#email-hold-btn");
      await wait(page, 500);
      ok("C4 · the release opens a typed-keyword overlay (not a native prompt)", await has(page, "#typed-word"));
      const overlayText = await txt(page, "#overlay-modal");
      ok("C4b · …whose copy names the pending count from the probe",
        (overlayText || "").includes(`${pendingGt} of them`), JSON.stringify((overlayText || "").slice(0, 260)));
      ok("C4c · …and says every queued email due now goes out on the next daily run (~08:00 UK)",
        /08:00 UK time/i.test(overlayText || "") && /next automation run/i.test(overlayText || ""), (overlayText || "").slice(0, 260));

      // The wrong word must not release it.
      await page.fill("#typed-word", "send-it");
      await page.click("#typed-ok");
      await wait(page, 400);
      ok("C5 · the wrong word is refused and the overlay stays open", await has(page, "#typed-word"));
      eq("C5b · …and email_hold is still on", await readSetting(page, "email_hold"), "on");

      await page.fill("#typed-word", "SEND");
      await page.click("#typed-ok");
      await wait(page, 1200);
      eq("C6 · typing SEND writes email_hold = 'off'", await readSetting(page, "email_hold"), "off");
      state = await page.evaluate(() => document.querySelector("#email-sending-line").dataset.state);
      line = await txt(page, "#email-sending-status");
      eq("C6b · …and the strip re-renders as LIVE without a page reload", state, "live");
      ok("C6c · …in words: due emails send on the daily run", /Email sending: LIVE/.test(line || "") && /send on the daily run/i.test(line || ""), (line || "").slice(0, 200));
      ok("C6d · …and it is green now, not amber",
        await page.evaluate(() => { const e = document.querySelector("#email-sending-line"); return e.classList.contains("ok") && !e.classList.contains("warn"); }));
      ok("C6e · the control now offers to put it BACK on hold",
        await page.evaluate(() => document.querySelector("#email-hold-btn").dataset.action === "hold"));

      // Putting it back on hold needs no ceremony — it stops things happening.
      await page.click("#email-hold-btn");
      await wait(page, 1200);
      eq("C7 · putting it back on hold writes 'on' with no keyword", await readSetting(page, "email_hold"), "on");
      eq("C7b · …and the strip says HELD again", await page.evaluate(() => document.querySelector("#email-sending-line").dataset.state), "held");

      eq("C8 · no console errors through the whole hold flow", realErr(page), []);
      await page.close();
    }
    {
      console.log("\n— §C2 · who sees the strip (p1 admin, p3 adviser)");
      const admin = await boot(browser, "p1");
      await goto(admin, "settings");
      await wait(admin, 800);
      ok("C9 · the admin sees the strip", await admin.evaluate(() => !document.querySelector("#email-sending-status").classList.contains("hidden")));
      ok("C9b · …and gets NO release control — that is the Owner's switch",
        await admin.evaluate(() => !document.querySelector("#email-hold-btn")));
      ok("C9c · …but does see the state, which is their question first",
        /Email sending:/.test((await txt(admin, "#email-sending-status")) || ""));
      eq("C9d · no console errors for the admin", realErr(admin), []);
      await admin.close();

      const adv = await boot(browser, "p3");
      await goto(adv, "settings");
      await wait(adv, 800);
      ok("C10 · an adviser gets no strip at all",
        await adv.evaluate(() => document.querySelector("#email-sending-status").classList.contains("hidden")));
      eq("C10b · …and nothing is rendered inside it either",
        await adv.evaluate(() => document.querySelector("#email-sending-status").innerHTML), "");
      eq("C11 · no console errors for the adviser on Settings", realErr(adv), []);
      await adv.close();
    }
    {
      console.log("\n— §C3 · the caveat paragraphs point at the strip instead of restating it (p4)");
      const page = await boot(browser, "p4");
      await goto(page, "settings");
      const form = await page.evaluate(() => document.querySelector("#settings-form").innerText.replace(/\s+/g, " "));
      ok("C12 · no Settings paragraph still says the bare “Requires RESEND_API_KEY”",
        !/Requires RESEND_API_KEY/.test(form), form.slice(0, 200));
      ok("C12b · the owner-digest line points at the status strip instead",
        /Sent daily at ~07:30 UK time\. Needs email sending to be working \(see the Email sending status at the top of this page\)/.test(form),
        (form.match(/Sent daily[^.]*\.[^.]*\./) || [""])[0]);
      const docNote = await page.evaluate(() => {
        const d = document.querySelector("#doc-chase-more");
        if (d) d.open = true;
        const el = document.querySelector("#doc-chase-note");
        return el ? el.innerText.replace(/\s+/g, " ") : null;
      });
      ok("C12c · the document-chase rules point at it too, and keep the rule itself",
        /see the Email sending status at the top of this page/.test(docNote || "") && /nothing goes out, whatever this says/.test(docNote || ""),
        (docNote || "").slice(-200));
      await page.close();
    }

    /* ===================================================================
       §D · M16 — the admin ops strip on Today
       =================================================================== */
    {
      console.log("\n— §D · M16 · #ops-strip on Today (p1 Kim, admin)");
      const page = await boot(browser, "p1");
      await wait(page, 1200);
      ok("D1 · the admin gets the ops strip", await page.evaluate(() => !document.querySelector("#ops-strip").classList.contains("hidden")));
      ok("D1b · …with a line saying what it is", /The firm's plumbing/i.test((await txt(page, "#ops-strip-sub")) || ""));

      /* R11-1's adjacency is load-bearing and tests/r11_ux.js locks it — the strip must not have
         got between the heading and the numbers. */
      const order = await page.evaluate(() => {
        const h = document.getElementById("today-heading");
        return { afterHeading: h.nextElementSibling && h.nextElementSibling.id, beforeHeading: h.previousElementSibling && h.previousElementSibling.id };
      });
      eq("D2 · #kpi-row still sits immediately after #today-heading (R11-1 intact)", order.afterHeading, "kpi-row");
      eq("D2b · …and the ops strip sits above the title, with the health banners", order.beforeHeading, "ops-strip");

      const gt = await page.evaluate(async () => {
        const db = window.__mockDb;
        const [em, sms, leads, tasks, cases] = await Promise.all([
          db.from("email_queue").select("*"), db.from("sms_queue").select("*"),
          db.from("leads").select("*"), db.from("case_tasks").select("*"), db.from("cases").select("*"),
        ]);
        const LIVE = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
        return {
          emailsQueued: (em.data || []).filter((e) => e.status === "queued").length,
          emailsFailed: (em.data || []).filter((e) => e.status === "failed").length,
          smsQueued: (sms.data || []).filter((s) => s.status === "queued").length,
          leadsNew: (leads.data || []).filter((l) => l.status === "new").length,
          docsOverdue: (tasks.data || []).filter((t) => !t.done_at && /^Documents overdue — call /.test(t.title || "")).length,
          noAdviser: (cases.data || []).filter((c) => !c.assigned_to && LIVE.includes(c.stage)).length,
        };
      });
      const chips = await page.evaluate(() => {
        const o = {};
        document.querySelectorAll("#ops-strip .ops-chip").forEach((b) => {
          o[b.id] = { n: b.dataset.n, hot: b.classList.contains("hot"), text: b.innerText.replace(/\s+/g, " ").trim() };
        });
        return o;
      });
      const CHIP = {
        "ops-emails-queued": "emailsQueued", "ops-emails-failed": "emailsFailed",
        "ops-sms-queued": "smsQueued", "ops-leads-new": "leadsNew",
        "ops-unassigned": "noAdviser", "ops-docs-overdue": "docsOverdue",
      };
      eq("D3 · every chip rendered", Object.keys(chips).sort(), Object.keys(CHIP).sort());
      Object.keys(CHIP).forEach((id) => {
        const want = gt[CHIP[id]];
        eq(`D4 · ${id} counts exactly what __mockDb holds`, chips[id] && Number(chips[id].n), want);
        eq(`D4b · ${id} is ${want > 0 ? "amber" : "grey"} at ${want}`, chips[id] && chips[id].hot, want > 0);
      });
      ok("D5 · at least one chip is non-zero, so the colour rule is not vacuously passing",
        Object.keys(CHIP).some((id) => Number(chips[id].n) > 0), JSON.stringify(gt));
      ok("D5b · …and at least one is zero, so the grey half is proved too",
        Object.keys(CHIP).some((id) => Number(chips[id].n) === 0), JSON.stringify(gt));

      // The chip really is a link to the page that fixes it.
      await page.click("#ops-emails-queued");
      await wait(page, 1200);
      eq("D6 · the emails chip opens the Emails page",
        await page.evaluate(() => document.querySelector("#page-emails").classList.contains("hidden")), false);
      await goto(page, "dashboard");
      await page.click("#ops-unassigned");
      await wait(page, 1400);
      const pipe = await page.evaluate(() => ({
        onPipeline: !document.querySelector("#page-pipeline").classList.contains("hidden"),
        adviser: (document.querySelector("#board-adviser") || {}).value,
      }));
      eq("D6b · the unassigned-cases chip opens the Pipeline filtered to Unassigned", pipe, { onPipeline: true, adviser: "unassigned" });

      eq("D7 · no console errors for the admin on Today", realErr(page), []);
      await page.close();
    }
    {
      console.log("\n— §D2 · the ops strip is admin/owner only");
      const owner = await boot(browser, "p4");
      await wait(owner, 1200);
      ok("D8 · the owner gets it too", await owner.evaluate(() => !document.querySelector("#ops-strip").classList.contains("hidden")));
      await owner.close();
      for (const p of ["p2", "p3"]) {
        const adv = await boot(browser, p);
        await wait(adv, 1200);
        ok(`D9 · ${p} (adviser) never sees the ops strip`,
          await adv.evaluate(() => document.querySelector("#ops-strip").classList.contains("hidden")));
        eq(`D9b · ${p} · nothing is rendered inside it either`,
          await adv.evaluate(() => document.querySelector("#ops-strip").innerHTML), "");
        eq(`D9c · ${p} · no console errors on Today`, realErr(adv), []);
        await adv.close();
      }
    }

    /* ===================================================================
       §E · A5 — protection_referral_partner
       =================================================================== */
    {
      console.log("\n— §E · A5 · Settings › Protection referral partner (p4 Daniel, owner)");
      const page = await boot(browser, "p4");
      await goto(page, "settings");

      ok("E1 · the field exists, in the Protection & GI section",
        await page.evaluate(() => {
          const el = document.querySelector('#settings-form [name="protection_referral_partner"]');
          if (!el) return false;
          // Walk back to the nearest preceding <h3> to prove which section it is in.
          const heads = [...document.querySelectorAll("#settings-form h3")];
          let sec = null;
          heads.forEach((h) => { if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) sec = h.textContent.trim(); });
          return /Protection/.test(sec || "");
        }));
      ok("E1b · …with the note that says what it does and that blank is allowed",
        /firm or adviser a protection referral is addressed to by default/i.test((await txt(page, "#setting-note-protection_referral_partner")) || "")
        && /Leave it blank/i.test((await txt(page, "#setting-note-protection_referral_partner")) || ""),
        await txt(page, "#setting-note-protection_referral_partner"));
      ok("E1c · …and it starts empty, because production has never set one",
        await page.evaluate(() => document.querySelector('[name="protection_referral_partner"]').value) === "");

      // Round-trip it through the ordinary Save button.
      await page.fill('[name="protection_referral_partner"]', "Stonebridge Protect");
      await page.click("#save-settings-btn");
      await wait(page, 1200);
      eq("E2 · saving through the normal settings path writes the row",
        await readSetting(page, "protection_referral_partner"), "Stonebridge Protect");
      await goto(page, "dashboard");
      await goto(page, "settings");
      eq("E2b · …and it comes back on the next render",
        await page.evaluate(() => document.querySelector('[name="protection_referral_partner"]').value), "Stonebridge Protect");

      /* --- and the referral overlay actually pre-fills from it ------------------ */
      const caseId = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("*");
        const live = (data || []).find((c) => !["completed", "not_proceeding"].includes(c.stage));
        return live ? live.id : null;
      });
      ok("E3 · the fixture has a live case to refer from", !!caseId, JSON.stringify(caseId));
      await page.evaluate((id) => window.openCase(id), caseId);
      await wait(page, 1400);
      const hasBtn = await has(page, "#act-ref-protection");
      ok("E3b · the case offers “Refer for protection advice”", hasBtn);
      if (hasBtn) {
        await page.click("#act-ref-protection");
        await wait(page, 700);
        eq("E4 · the referral overlay pre-fills “Referred to” from the setting",
          await page.evaluate(() => (document.querySelector("#ref-to") || {}).value), "Stonebridge Protect");
        ok("E4b · …and says where the pre-fill came from, so it can be changed with confidence",
          await page.evaluate(() => !!document.querySelector(".ref-default-note")));
        await page.click("#ref-cancel");
        await wait(page, 400);
      }
      eq("E5 · no console errors through the settings/referral round-trip", realErr(page), []);
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (e) { /* already gone */ } }
  }

  console.log(`\nR68_MI: ${pass} checks, ${failures.length} failures`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
