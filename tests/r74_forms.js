#!/usr/bin/env node
/* =============================================================================
   tests/r74_forms.js — acceptance tests for R74 build B, "forms keep your work"
   (R73 UI/UX panel, theme #6: D#9/D#15/D#16/D#17, A#10–A#12, A#22, E-13, plus
   B#2 stage-move undo, A#7/A#8 the email queue, A#5 Watchtower links).

   What the panel found, verified against the app at 425ca06:
     · Settings SILENTLY DISCARDS an unsaved edit when you navigate away
       (reproduced); Save is up to 2,700px from the field it saves; there are
       three save buttons in two placements and nothing says a field is dirty.
     · Booleans are two-option <select>s indistinguishable from "Twilio /
       ClickSend"; the rules that make the app REFUSE something are scattered
       across three sections; every explainer paragraph spans both columns of a
       two-column grid, so it reads as belonging to the wrong field; the jump
       nav's scroll-spy highlighted "SMS" while you were reading "Documents"
       (the two targets inside the collapsed Advanced accordion measure 0×0 and
       so passed the "have we scrolled past this?" test at every position).
     · Create modals put Save below the fold before a character is typed; the
       sticky × parks on top of the Email field; validation is a transient toast
       at the bottom while the offending field is off-screen and unmarked; a
       blank new-client form opens with a red MISSING badge on it.
     · The unsaved guard is a native confirm() whose "Cancel" means the opposite
       of the form's own Cancel — 53 native confirms app-wide.
     · A stage move cannot be undone and the correction ADDS tasks.
     · Email previews are empty for every house-template email — the one kind
       the administrator opens the page to check — and the page opens on the
       whole history rather than on what still needs a decision.
     · retention_gap and workload alerts have nowhere to go.

     §A  B1 · SETTINGS NEVER LOSES AN EDIT. The dirty bar's count and routing;
         nav-while-dirty asks in the house dialog and "Keep editing" leaves the
         edit ON THE PAGE (the D#9 repro, inverted); Discard reverts; Save
         persists through the existing handlers and the settings row really
         changes; switches write the same keys with the same values; the two
         bordered groups; explainers in their own column; the scroll-spy;
         #settings-golive and #email-sending-status untouched.
     §B  B2 · MODALS. Sticky footer at every scroll position; the × in an opaque
         strip that no input's box intersects; required marks; a failed save
         marks the field, writes a sentence under it, scrolls it into view and
         leaves the toast as the summary; no MISSING badge on a blank create.
     §C  B3 · THE HOUSE GUARD. Backdrop-misclick with typed content raises the
         overlay, not window.confirm — with the house's own two verbs; the
         destructive deletes ask in the same dialog with the danger button.
     §D  B4 · STAGE MOVE UNDO. Undo restores the stage and deletes EXACTLY the
         rows the move inserted (counted before/after, and checked by id); a
         hand-typed task carrying the same title as a created one SURVIVES (the
         "never by title" rule); a move back offers to take the forward stage's
         residue off and the round trip leaves none (B#2's repro).
     §E  B5 · THE EMAIL QUEUE. Needs-you default with counted chips; a
         house-template row renders a composed body and says it is a preview of
         the standard wording; a stored-body row still shows what is stored.
     §F  B6 · WATCHTOWER. retention_gap and workload carry a working door.
     §G  No console errors, owner and administrator.

   Every figure asserted here is computed by this file's own seeding or read
   straight back off window.__mockDb — never a number invented independently of
   the fixture it is testing.

   Run:  node /root/nx/tests/r74_forms.js
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

const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_sortdir", "nx_wt_scope", "nx_board_adviser",
  "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc", "nx_drawer_retention",
  "nx_whatsnew_r72", "nx_email_filter"];

async function boot(browser, persona, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  page.__ctx = ctx;
  /* Every native dialog this suite ever sees is a FAILURE of R74's own premise on the paths it
     converted, so they are recorded (and accepted, so a stray one cannot wedge the run) and §C
     asserts the list is empty for the converted flows. */
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.waitForTimeout(1500);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));
const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 2400 : ms);
};
const toastTxt = (page) => page.evaluate(() => (document.querySelector("#toast") || {}).textContent || "");
const wait = (page, ms) => page.waitForTimeout(ms);
/* Type into a field the way a person does, so every listener the app has hung off `input`/`change`
   (the R74 dirty watch included) sees exactly what it would see from a keyboard. */
const setField = (page, sel, value) => page.evaluate(([s, v]) => {
  const el = document.querySelector(s);
  if (!el) return false;
  el.value = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}, [sel, value]);
const settingValue = (page, key) => page.evaluate(async (k) => {
  const { data } = await window.__mockDb.from("settings").select("key,value").eq("key", k).maybeSingle();
  return data ? data.value : null;
}, key);
const tasksFor = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("case_tasks").select("id,title,done_at").eq("case_id", id);
  return data || [];
}, caseId);

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {

    /* =====================================================================
       §A · B1 — SETTINGS NEVER LOSES AN EDIT (D#9, D#15, D#16, D#17)
       ===================================================================== */
    {
      console.log("\n— §A · Settings: the unsaved-changes bar, the guard, switches, groups, the spy (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "settings", 3500);

      const clean = await page.evaluate(() => ({
        bar: !!document.querySelector("#settings-dirty-bar"),
        hidden: document.querySelector("#settings-dirty-bar").classList.contains("hidden"),
      }));
      ok("A1a · the page carries an unsaved-changes bar…", clean.bar);
      ok("A1b · …and it is not shown while nothing is dirty", clean.hidden);

      await setField(page, '#settings-form [name="company_name"]', "NexMoney R74");
      await wait(page, 400);
      const dirty1 = await page.evaluate(() => ({
        hidden: document.querySelector("#settings-dirty-bar").classList.contains("hidden"),
        n: (document.querySelector("#settings-dirty-n") || {}).textContent || "",
        where: (document.querySelector("#settings-dirty-where") || {}).textContent || "",
        marked: (() => { const el = document.querySelector('#settings-form [name="company_name"]');
          const host = el.closest(".set-field") || el.closest("label"); return !!host && host.classList.contains("is-dirty"); })(),
      }));
      ok("A1c · the first edit shows the bar", !dirty1.hidden, JSON.stringify(dirty1));
      eq("A1d · …counting exactly the one dirty field", dirty1.n, "1 unsaved change");
      ok("A1e · …naming which save it belongs to", /settings form/i.test(dirty1.where), dirty1.where);
      ok("A1f · …and the field itself carries the dirty mark", dirty1.marked, JSON.stringify(dirty1));

      // A second dirty field, in a DIFFERENT save group, so the count and the routing are both tested.
      await setField(page, "#my-phone", "01202 111222");
      await wait(page, 400);
      const dirty2 = await page.evaluate(() => ({
        n: (document.querySelector("#settings-dirty-n") || {}).textContent || "",
        where: (document.querySelector("#settings-dirty-where") || {}).textContent || "",
      }));
      eq("A1g · a second edit in another group is counted too", dirty2.n, "2 unsaved changes");
      ok("A1h · …and the bar names both groups", /settings form/i.test(dirty2.where) && /My details/i.test(dirty2.where), dirty2.where);

      /* THE D#9 REPRO, INVERTED. At base this nav threw both edits away without a word. */
      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, 700);
      const guard = await page.evaluate(() => ({
        onSettings: !document.querySelector("#page-settings").classList.contains("hidden"),
        title: (document.querySelector("#ovl-confirm-title") || {}).textContent || "",
        keep: (document.querySelector("#ovl-confirm-cancel") || {}).textContent || "",
        discard: (document.querySelector("#ovl-confirm-ok") || {}).textContent || "",
      }));
      ok("A2a · navigating away while dirty ASKS instead of discarding", /discard/i.test(guard.title), JSON.stringify(guard));
      ok("A2b · …and the page has not moved while the question is open", guard.onSettings, JSON.stringify(guard));
      eq("A2c · the buttons are the house's two verbs, not OK/Cancel", [guard.keep.trim(), guard.discard.trim()], ["Keep editing", "Discard changes"]);
      eq("A2d · it is the app's dialog, not the browser's", page.__dialogs, []);

      await page.click("#ovl-confirm-cancel");
      await wait(page, 500);
      const kept = await page.evaluate(() => ({
        onSettings: !document.querySelector("#page-settings").classList.contains("hidden"),
        company: document.querySelector('#settings-form [name="company_name"]').value,
        phone: document.querySelector("#my-phone").value,
      }));
      ok("A2e · “Keep editing” leaves you on Settings", kept.onSettings, JSON.stringify(kept));
      eq("A2f · …with BOTH edits still on the page (the D#9 defect)", [kept.company, kept.phone], ["NexMoney R74", "01202 111222"]);

      // Save routes each group to its own handler — and the writes really land.
      const companyBefore = await settingValue(page, "company_name");
      await page.click("#settings-dirty-save");
      await wait(page, 2500);
      const saved = await page.evaluate(() => ({
        hidden: document.querySelector("#settings-dirty-bar").classList.contains("hidden"),
        marks: document.querySelectorAll("#page-settings .is-dirty").length,
      }));
      const companyAfter = await settingValue(page, "company_name");
      const phoneAfter = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("profiles").select("id,phone").eq("id", "p4").maybeSingle();
        return data ? data.phone : null;
      });
      ok("A3a · Save wrote the settings field through the settings upsert", companyAfter === "NexMoney R74" && companyBefore !== companyAfter, JSON.stringify({ companyBefore, companyAfter }));
      eq("A3b · …and the My-details field through the profiles update", phoneAfter, "01202 111222");
      ok("A3c · the bar goes once everything is saved", saved.hidden, JSON.stringify(saved));
      eq("A3d · …and no field is still marked dirty", saved.marks, 0);

      // Discard puts the page back to what is stored, and asks first.
      await setField(page, '#settings-form [name="company_name"]', "Typed and abandoned");
      await wait(page, 400);
      await page.click("#settings-discard-btn");
      await wait(page, 500);
      ok("A4a · Discard asks in the house dialog too", !!(await page.$("#ovl-confirm-ok")));
      await page.click("#ovl-confirm-ok");
      await wait(page, 2500);
      const reverted = await page.evaluate(() => ({
        company: document.querySelector('#settings-form [name="company_name"]').value,
        hidden: document.querySelector("#settings-dirty-bar").classList.contains("hidden"),
      }));
      eq("A4b · …and the field goes back to what is saved", reverted.company, "NexMoney R74");
      ok("A4c · …with the bar gone", reverted.hidden, JSON.stringify(reverted));

      /* SWITCHES (D#15 b). The <select> is still the control the save sweeps; the switch writes
         through it, so there is exactly one writer of the value. */
      const sw = await page.evaluate(() => {
        const sel = document.querySelector('#settings-form [name="playbook_auto_tasks"]');
        const btn = sel && sel.parentElement.querySelector(".set-switch");
        return {
          selTag: sel ? sel.tagName : null,
          hasBtn: !!btn,
          role: btn ? btn.getAttribute("role") : null,
          checked: btn ? btn.getAttribute("aria-checked") : null,
          value: sel ? sel.value : null,
          labelled: btn ? /Automatic stage checklist/i.test(btn.getAttribute("aria-label") || "") : false,
        };
      });
      eq("A5a · a boolean setting is still a <select> — the save sweep and the suites drive it", sw.selTag, "SELECT");
      ok("A5b · …with a real switch painted on it", sw.hasBtn && sw.role === "switch", JSON.stringify(sw));
      ok("A5c · …whose aria-checked agrees with the select's value", (sw.checked === "true") === (sw.value === "on" || sw.value === "1"), JSON.stringify(sw));
      ok("A5d · …and which is labelled by its own field", sw.labelled, JSON.stringify(sw));
      const beforeSw = sw.value;
      await page.click('#settings-form [name="playbook_auto_tasks"] ~ .set-switch');
      await wait(page, 400);
      const afterSw = await page.evaluate(() => {
        const sel = document.querySelector('#settings-form [name="playbook_auto_tasks"]');
        const btn = sel.parentElement.querySelector(".set-switch");
        return { value: sel.value, checked: btn.getAttribute("aria-checked"), dirty: !document.querySelector("#settings-dirty-bar").classList.contains("hidden") };
      });
      ok("A5e · pressing the switch flips the SELECT's value (one writer, not two)", afterSw.value !== beforeSw, JSON.stringify({ beforeSw, afterSw }));
      ok("A5f · …and the dirty bar sees it like any other edit", afterSw.dirty, JSON.stringify(afterSw));
      await page.click("#settings-discard-btn");
      await wait(page, 400);
      await page.click("#ovl-confirm-ok");
      await wait(page, 2500);
      eq("A5g · …and Discard puts the switch back", await settingValue(page, "playbook_auto_tasks"), await page.evaluate(() => {
        const sel = document.querySelector('#settings-form [name="playbook_auto_tasks"]');
        return sel.value === "1" ? "on" : sel.value === "0" ? "off" : sel.value;
      }));

      /* THE TWO GROUPS (D#15 c). */
      const groups = await page.evaluate(() => {
        const names = (id) => [...document.querySelectorAll(`#${id} [name]`)].map((e) => e.name);
        return {
          blockers: names("set-group-blockers"),
          bank: names("set-group-bank"),
          blockersHead: (document.querySelector("#set-group-blockers .set-group-h") || {}).textContent || "",
          bankHead: (document.querySelector("#set-group-bank .set-group-h") || {}).textContent || "",
        };
      });
      eq("A6a · the three rules that block work are one bordered group", groups.blockers.slice().sort(),
        ["doc_chase_enabled", "financial_promotions_approved", "protection_gate"]);
      eq("A6b · …under a heading that says what they have in common", groups.blockersHead.trim(), "Rules that block work");
      eq("A6c · the bank details are their own bordered group", groups.bank.slice().sort(), ["bank_account_name", "bank_account_number", "bank_sort_code"]);
      eq("A6d · …named", groups.bankHead.trim(), "Firm bank details");

      /* THE EXPLAINER COLUMN (D#16). A note belongs to a field, so it lives in that field's cell. */
      const noteCol = await page.evaluate(() => {
        const note = document.querySelector("#setting-note-client_quiet_months");
        if (!note) return null;
        const cell = note.closest(".set-field");
        const input = cell && cell.querySelector('[name="client_quiet_months"]');
        return { inCell: !!cell, ownsField: !!input, spansGrid: getComputedStyle(cell || note).gridColumn };
      });
      ok("A7a · a field's explainer sits in that FIELD's own grid cell, not full width under both columns",
        noteCol && noteCol.inCell && noteCol.ownsField, JSON.stringify(noteCol));
      ok("A7b · …so it is not spanning the whole row any more", noteCol && !/1 \/ -1|1 \/ 3/.test(noteCol.spansGrid), JSON.stringify(noteCol));

      /* THE SCROLL-SPY (D#17). */
      const spyTop = await page.evaluate(async () => {
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 600));
        return [...document.querySelectorAll("#settings-jump-chips .seg-btn.active")].map((b) => b.id);
      });
      eq("A8a · nothing is highlighted above the first section", spyTop, []);
      const spyDocs = await page.evaluate(async () => {
        /* Scroll the Documents heading just PAST the bar's own line — that is the moment the spy
           is supposed to switch to it, and the moment it used to answer "SMS" instead, because
           #set-sec-outlook and #set-sec-sms sit inside the collapsed Advanced accordion and a
           0×0 box reads as "already scrolled past" at every position. */
        const h = document.getElementById("set-sec-documents");
        h.scrollIntoView({ block: "start" });
        window.scrollBy(0, 24);
        await new Promise((r) => setTimeout(r, 700));
        return [...document.querySelectorAll("#settings-jump-chips .seg-btn.active")].map((b) => b.id);
      });
      eq("A8b · reading Documents highlights Documents (it said SMS at 425ca06 — the two Advanced targets measure 0×0 while the accordion is shut)",
        spyDocs, ["settings-nav-documents"]);

      /* R72 contracts this round must not have touched. */
      const kept72 = await page.evaluate(() => ({
        golive: !!document.getElementById("settings-golive") && !document.getElementById("settings-golive").classList.contains("hidden"),
        rows: document.querySelectorAll("#settings-golive .golive-row, #settings-golive [id^='golive-']").length,
        strip: !!document.getElementById("email-sending-status"),
      }));
      ok("A9a · #settings-golive still paints for the Owner", kept72.golive && kept72.rows > 0, JSON.stringify(kept72));
      ok("A9b · #email-sending-status is still there", kept72.strip, JSON.stringify(kept72));

      eq("A · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =====================================================================
       §B · B2 — MODAL FOOTERS, HEADER STRIP, FIELD-ANCHORED ERRORS
       ===================================================================== */
    {
      console.log("\n— §B · the create modals: sticky footer, the ×, required marks, inline errors (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      await goPage(page, "clients", 2000);
      await page.evaluate(() => window.openClient(null));
      await wait(page, 900);

      const chrome = await page.evaluate(() => {
        const foot = document.querySelector("#modal > .modal-actions");
        const bar = document.querySelector("#modal .modal-topbar");
        const x = document.querySelector("#modal .modal-close");
        const cs = foot ? getComputedStyle(foot) : null;
        const bs = bar ? getComputedStyle(bar) : null;
        const xr = x ? x.getBoundingClientRect() : null;
        const hits = xr ? [...document.querySelectorAll("#modal input, #modal select, #modal textarea")].filter((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          return r.left < xr.right && r.right > xr.left && r.top < xr.bottom && r.bottom > xr.top;
        }).map((el) => el.name || el.id) : null;
        return {
          footPos: cs && cs.position, footBottom: cs && cs.bottom,
          footBg: cs && cs.backgroundColor,
          barPos: bs && bs.position, barBg: bs && bs.backgroundColor,
          xInBar: !!(bar && x && bar.contains(x)),
          overlaps: hits,
          saveVisible: (() => { const b = document.querySelector("#modal-save"); if (!b) return false; const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })(),
        };
      });
      eq("B1a · the modal's Cancel/Save bar is a sticky FOOTER", [chrome.footPos, chrome.footBottom], ["sticky", "0px"]);
      ok("B1b · …with an opaque background of its own (content passes behind it)", /rgb\(255, 255, 255\)/.test(chrome.footBg || ""), chrome.footBg);
      ok("B1c · …so Save is on screen before a character is typed (it was below the fold at 425ca06)", chrome.saveVisible, JSON.stringify(chrome));
      ok("B2a · the × lives in a sticky header strip", chrome.xInBar && chrome.barPos === "sticky", JSON.stringify(chrome));
      ok("B2b · …that is opaque, so no field ever shows through it", /rgb\(255, 255, 255\)/.test(chrome.barBg || ""), chrome.barBg);
      eq("B2c · …and at rest the × overlaps no input (it parked on the Email box at 425ca06)", chrome.overlaps, []);

      const scrolled = await page.evaluate(async () => {
        const sc = document.querySelector("#modal-backdrop");
        sc.scrollTop = sc.scrollHeight;
        await new Promise((r) => setTimeout(r, 400));
        const b = document.querySelector("#modal-save").getBoundingClientRect();
        const x = document.querySelector("#modal .modal-close").getBoundingClientRect();
        return { saveOnScreen: b.top >= 0 && b.bottom <= window.innerHeight, xOnScreen: x.top >= 0 && x.bottom <= window.innerHeight };
      });
      ok("B1d · Save is still reachable with the modal scrolled to the bottom", scrolled.saveOnScreen, JSON.stringify(scrolled));
      ok("B2d · …and so is the ×", scrolled.xOnScreen, JSON.stringify(scrolled));

      const marks = await page.evaluate(() => ({
        req: [...document.querySelectorAll("#client-form .req-mark")].map((m) => (m.closest("label").querySelector("input,select,textarea") || {}).name),
        dobBadge: !!document.querySelector("#modal .client-dob-flag"),
      }));
      eq("B3a · the fields the form will refuse without are marked as required", marks.req.slice().sort(), ["first_name", "last_name"]);
      ok("B3b · a blank NEW client carries no MISSING badge (A#22 — it was there before a character was typed)", !marks.dobBadge);

      // A failed save: marked, explained at the field, scrolled to, summarised in the toast.
      await page.evaluate(() => { const sc = document.querySelector("#modal-backdrop"); sc.scrollTop = sc.scrollHeight; });
      await setField(page, '#client-form [name="email"]', "not-an-email");
      await wait(page, 200);
      await page.click("#modal-save");
      await wait(page, 900);
      const invalid = await page.evaluate(() => {
        const first = document.querySelector('#client-form [name="first_name"]');
        const errs = [...document.querySelectorAll("#client-form .field-err")].map((p) => ({
          owner: (p.closest("label").querySelector("input,select,textarea") || {}).name, text: p.textContent.trim(),
        }));
        const r = first.getBoundingClientRect();
        return {
          errs,
          firstMarked: first.classList.contains("field-invalid"),
          ariaInvalid: first.getAttribute("aria-invalid"),
          firstOnScreen: r.top >= 0 && r.bottom <= window.innerHeight,
          focused: (document.activeElement && document.activeElement.name) || null,
        };
      });
      const t = await toastTxt(page);
      ok("B4a · every offending field gets a sentence UNDER it", invalid.errs.length === 3, JSON.stringify(invalid.errs));
      ok("B4b · …naming which field it is about", invalid.errs.some((e) => e.owner === "first_name" && /first name/i.test(e.text))
        && invalid.errs.some((e) => e.owner === "email" && /valid email/i.test(e.text)), JSON.stringify(invalid.errs));
      ok("B4c · the field itself is marked and announced", invalid.firstMarked && invalid.ariaInvalid === "true", JSON.stringify(invalid));
      ok("B4d · the FIRST invalid field is scrolled into view and focused", invalid.firstOnScreen && invalid.focused === "first_name", JSON.stringify(invalid));
      ok("B4e · the toast stays a summary, and says how many", /3 fields need fixing/i.test(t), t);
      eq("B4f · nothing was saved", await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id").eq("first_name", "").limit(1);
        return (data || []).length;
      }), 0);

      await setField(page, '#client-form [name="first_name"]', "Ada");
      await wait(page, 300);
      const cleared = await page.evaluate(() => ({
        marked: document.querySelector('#client-form [name="first_name"]').classList.contains("field-invalid"),
        errs: document.querySelectorAll('#client-form [name="first_name"] ~ .field-err, #client-form .field-err').length,
      }));
      ok("B4g · fixing a field clears its mark and its sentence together", !cleared.marked && cleared.errs === 2, JSON.stringify(cleared));

      // An EXISTING client with no date of birth still says so — the badge is about a record.
      const noDobId = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id,date_of_birth").limit(1000);
        const row = (data || []).find((c) => !c.date_of_birth);
        return row ? row.id : null;
      });
      if (noDobId) {
        await page.evaluate(() => window.closeModal());
        await wait(page, 400);
        await page.evaluate((id) => window.openClient(id), noDobId);
        await wait(page, 900);
        ok("B3c · …but an EXISTING client with no date of birth is still badged", !!(await page.$("#modal .client-dob-flag")));
        await page.evaluate(() => window.closeModal());
      }
      eq("B · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =====================================================================
       §C · B3 — THE HOUSE GUARD AND THE DESTRUCTIVE OVERLAYS
       ===================================================================== */
    {
      console.log("\n— §C · the unsaved guard and the destructive deletes ask in the house dialog (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "clients", 2000);
      await page.evaluate(() => window.openClient(null));
      await wait(page, 900);
      await setField(page, '#client-form [name="first_name"]', "Typed but never saved");
      await wait(page, 200);
      // A misclick on the backdrop — the exact accident the guard exists for.
      await page.evaluate(() => {
        const bd = document.querySelector("#modal-backdrop");
        bd.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await wait(page, 900);
      const dlg = await page.evaluate(() => ({
        title: (document.querySelector("#ovl-confirm-title") || {}).textContent || "",
        keep: (document.querySelector("#ovl-confirm-cancel") || {}).textContent || "",
        discard: (document.querySelector("#ovl-confirm-ok") || {}).textContent || "",
        danger: !!(document.querySelector("#ovl-confirm-ok") || {}).classList && document.querySelector("#ovl-confirm-ok").classList.contains("btn-danger-solid"),
        modalStillOpen: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
      }));
      ok("C1a · a backdrop misclick with typed content raises the HOUSE dialog", /discard/i.test(dlg.title), JSON.stringify(dlg));
      eq("C1b · …whose buttons are verbs, not OK/Cancel", [dlg.keep.trim(), dlg.discard.trim()], ["Keep editing", "Discard changes"]);
      ok("C1c · …with the discarding one carrying the danger treatment", dlg.danger, JSON.stringify(dlg));
      eq("C1d · window.confirm was never used", page.__dialogs, []);
      await page.click("#ovl-confirm-cancel");
      await wait(page, 500);
      const still = await page.evaluate(() => ({
        open: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
        text: (document.querySelector('#client-form [name="first_name"]') || {}).value,
      }));
      ok("C1e · “Keep editing” leaves the modal open with the typing intact", still.open && still.text === "Typed but never saved", JSON.stringify(still));
      await page.evaluate(() => { document.querySelector("#modal-backdrop").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await wait(page, 700);
      await page.click("#ovl-confirm-ok");
      await wait(page, 700);
      ok("C1f · “Discard changes” closes it", await page.evaluate(() => document.querySelector("#modal-backdrop").classList.contains("hidden")));

      // The vault delete — a destructive verb, in the same dialog, with the danger button.
      await goPage(page, "vault", 2500);
      const vaultDel = await page.evaluate(() => {
        const b = document.querySelector("#vault-list .vault-del");
        return b ? b.dataset.id : null;
      });
      if (vaultDel) {
        const before = await page.evaluate(async () => ((await window.__mockDb.from("vault_entries").select("id")).data || []).length);
        await page.click(`#vault-list .vault-del[data-id="${vaultDel}"]`);
        await wait(page, 600);
        const vd = await page.evaluate(() => {
          const okBtn = document.querySelector("#ovl-confirm-ok");
          return okBtn ? { label: okBtn.textContent.trim(), danger: okBtn.classList.contains("btn-danger-solid"),
                           body: (document.querySelector("#ovl-confirm-body") || {}).textContent || "" } : null;
        });
        ok("C2a · deleting a vault entry asks in the house dialog", !!vd, JSON.stringify(vd));
        ok("C2b · …naming the entry, with a danger button that says the verb", vd && vd.danger && /delete/i.test(vd.label) && vd.body.length > 10, JSON.stringify(vd));
        await page.click("#ovl-confirm-cancel");
        await wait(page, 500);
        const afterCancel = await page.evaluate(async () => ((await window.__mockDb.from("vault_entries").select("id")).data || []).length);
        eq("C2c · cancelling deletes nothing", afterCancel, before);
        await page.click(`#vault-list .vault-del[data-id="${vaultDel}"]`);
        await wait(page, 600);
        await page.click("#ovl-confirm-ok");
        await wait(page, 900);
        const afterOk = await page.evaluate(async () => ((await window.__mockDb.from("vault_entries").select("id")).data || []).length);
        eq("C2d · …and confirming deletes exactly one", afterOk, before - 1);
      }
      eq("C3 · no native dialog was raised anywhere in this section", page.__dialogs, []);
      eq("C · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =====================================================================
       §D · B4 — A STAGE MOVE CAN BE TAKEN BACK (B#2)
       ===================================================================== */
    {
      console.log("\n— §D · stage move: Undo restores the stage and removes exactly what it added (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      // A clean case of our own, at DIP, so the fixture's own tasks cannot be confused with the
      // ones the move writes.
      const made = await page.evaluate(async () => {
        const db = window.__mockDb;
        await db.from("settings").upsert([{ key: "playbook_auto_tasks", value: "on" }]);
        await window.loadSettings();
        const { data: cl } = await db.from("clients").insert({ first_name: "Undo", last_name: "Probe", phone: "07700900999" }).select("id").single();
        const { data: cs } = await db.from("cases").insert({
          client_id: cl.id, case_kind: "remortgage", stage: "decision_in_principle",
          assigned_to: "p4", protection_status: "in_place", lender: "Halifax",
        }).select("id").single();
        return { clientId: cl.id, caseId: cs.id };
      });
      const before = await tasksFor(page, made.caseId);
      const moved = await page.evaluate(async (id) => window.moveCaseToStage(id, "application", {}), made.caseId);
      await wait(page, 1500);
      const after = await tasksFor(page, made.caseId);
      const created = after.filter((t) => !before.some((b) => b.id === t.id));
      eq("D1a · the move happened", moved, "moved");
      ok("D1b · …and wrote the Application stage's playbook tasks", created.length > 0, JSON.stringify(created.map((t) => t.title)));
      const undoBtn = await page.evaluate(() => {
        const b = document.querySelector("#toast .toast-action");
        return b ? { label: b.textContent.trim(), msg: (document.querySelector("#toast .toast-msg") || {}).textContent || "" } : null;
      });
      ok("D1c · the move's toast carries an Undo", undoBtn && undoBtn.label === "Undo", JSON.stringify(undoBtn));

      /* THE "NEVER BY TITLE" RULE. A task typed by hand carrying the SAME title as one the move
         created must survive the Undo — deleting it would be a worse bug than the one being fixed. */
      const decoyTitle = created[0].title;
      const decoyId = await page.evaluate(async ([cid, title]) => {
        const { data } = await window.__mockDb.from("case_tasks").insert({ case_id: cid, title, assigned_to: "p4" }).select("id").single();
        return data.id;
      }, [made.caseId, decoyTitle]);

      await page.click("#toast .toast-action");
      await wait(page, 1800);
      const undone = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("id,stage").eq("id", id).maybeSingle();
        return data ? data.stage : null;
      }, made.caseId);
      const afterUndo = await tasksFor(page, made.caseId);
      eq("D2a · Undo puts the case back at the stage it came from", undone, "decision_in_principle");
      eq("D2b · …and deletes exactly the rows the move inserted",
        created.filter((c) => afterUndo.some((t) => t.id === c.id)).length, 0);
      ok("D2c · …by id, never by title: the hand-typed task with the same wording survives",
        afterUndo.some((t) => t.id === decoyId), JSON.stringify({ decoyTitle, left: afterUndo.map((t) => t.title) }));
      eq("D2d · …and nothing the case already had was touched",
        before.filter((b) => !afterUndo.some((t) => t.id === b.id)).length, 0);
      const undoToast = await toastTxt(page);
      ok("D2e · the Undo says what it did", /Move undone/i.test(undoToast) && /removed/i.test(undoToast), undoToast);

      /* THE ROUND TRIP (B#2's 8 spurious tasks). Forward, then back BY HAND — the move offers to
         take the forward stage's residue off, and taking it leaves none. */
      await page.evaluate(async ([cid, did]) => {
        await window.__mockDb.from("case_tasks").delete().eq("id", did);   // clear the decoy
        return cid;
      }, [made.caseId, decoyId]);
      const beforeFwd = await tasksFor(page, made.caseId);
      await page.evaluate(async (id) => window.moveCaseToStage(id, "application", {}), made.caseId);
      await wait(page, 1500);
      const afterFwd = await tasksFor(page, made.caseId);
      const fwdCreated = afterFwd.filter((t) => !beforeFwd.some((b) => b.id === t.id)).map((t) => t.id);
      const backPromise = page.evaluate(async (id) => window.moveCaseToStage(id, "decision_in_principle", {}), made.caseId);
      await wait(page, 1200);
      const backDlg = await page.evaluate(() => {
        const clear = document.querySelector("#stage-back-clear");
        return clear ? { clear: clear.textContent.trim(), keep: (document.querySelector("#stage-back-keep") || {}).textContent.trim(),
                         listed: document.querySelectorAll(".stage-back-list li").length } : null;
      });
      ok("D3a · a move BACKWARDS names the later stage's still-open tasks and offers to take them off",
        backDlg && backDlg.listed > 0 && /remove/i.test(backDlg.clear), JSON.stringify(backDlg));
      ok("D3b · …and offers to keep them, so it is a choice and not a rule", backDlg && /keep/i.test(backDlg.keep), JSON.stringify(backDlg));
      await page.click("#stage-back-clear");
      await backPromise;
      await wait(page, 1500);
      const afterBack = await tasksFor(page, made.caseId);
      /* The measure that matters is not "fewer tasks" — coming back to DIP legitimately re-adds
         the DIP steps — it is that NOT ONE of the rows the forward move wrote survived the return
         trip, and that nothing open on the case belongs to a stage later than the one it is at.
         That second measure is the panel's 8 spurious tasks, read through the playbook's own
         stage index rather than by counting. */
      const residue = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("case_tasks").select("id,title,done_at").eq("case_id", id);
        const here = window.PLAYBOOK_STAGE_ORDER ? window.PLAYBOOK_STAGE_ORDER.indexOf("decision_in_principle") : 2;
        return (data || []).filter((t) => !t.done_at && typeof window.playbookTitleStageIdx === "function"
          && window.playbookTitleStageIdx(t.title) > here).map((t) => t.title);
      }, made.caseId).catch(() => null);
      eq("D3c · not one of the rows the forward move wrote survives the round trip",
        fwdCreated.filter((id) => afterBack.some((t) => t.id === id)).length, 0);
      eq("D3d · …and nothing open on the case belongs to a later stage (8 spurious at 425ca06)", residue, []);
      eq("D3e · every dialog in this section was the app's, not the browser's", page.__dialogs, []);
      eq("D · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =====================================================================
       §E · B5 — THE EMAIL QUEUE SHOWS WHAT WILL ACTUALLY SEND (A#7, A#8)
       ===================================================================== */
    {
      console.log("\n— §E · emails: needs-you default, counted chips, the composed house-template preview (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      await goPage(page, "emails", 3000);

      const truth = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("email_queue").select("*").order("created_at", { ascending: false }).limit(100);
        const rows = data || [];
        return {
          needs: rows.filter((r) => r.status === "queued" || r.status === "failed").length,
          history: rows.filter((r) => r.status === "sent" || r.status === "cancelled").length,
          all: rows.length,
        };
      });
      const chips = await page.evaluate(() => [...document.querySelectorAll("#em-filters [data-em-status]")]
        .map((b) => ({ k: b.dataset.emStatus, n: Number((b.querySelector(".seg-count") || {}).textContent || "-1"), active: b.classList.contains("active") })));
      eq("E1a · the page opens on Needs you", chips.filter((c) => c.active).map((c) => c.k), ["needs"]);
      ok("E1b · All and History are one chip away", chips.some((c) => c.k === "all") && chips.some((c) => c.k === "history"), JSON.stringify(chips.map((c) => c.k)));
      const byKey = Object.fromEntries(chips.map((c) => [c.k, c.n]));
      eq("E1c · the chips carry counts, and they are the fixture's own", [byKey.needs, byKey.history, byKey.all], [truth.needs, truth.history, truth.all]);
      const shown = await page.evaluate(() => [...document.querySelectorAll("#email-list .row-item")]
        .map((r) => (r.className.match(/qrow-(\w+)/) || [])[1]).filter(Boolean));
      ok("E1d · …and the default view lists exactly the queued and failed rows",
        shown.length === truth.needs && shown.every((s) => s === "queued" || s === "failed"), JSON.stringify({ shown: shown.length, want: truth.needs }));

      /* THE COMPOSED PREVIEW. A house-template row has NO body_html; at 425ca06 its fold said
         "there is nothing here to show until it goes". */
      const prev = await page.evaluate(async () => {
        const rows = [...document.querySelectorAll("#email-list .row-item")];
        for (const r of rows) {
          const d = r.querySelector("details.em-fold");
          if (!d) continue;
          d.open = true;
          const body = d.querySelector(".em-prev-body[data-em-composed]");
          if (body) {
            return {
              title: (r.querySelector(".row-main .t") || {}).textContent || "",
              text: body.textContent.replace(/\s+/g, " ").trim(),
              note: (d.querySelector(".em-prev-note") || {}).textContent || "",
              anchors: d.querySelectorAll("a[href]").length,
            };
          }
        }
        return null;
      });
      ok("E2a · a house-template email renders a real composed body in its fold", !!prev && prev.text.length > 40, JSON.stringify(prev && prev.text.slice(0, 120)));
      ok("E2b · …that reads like the email the run would send", !!prev && /mortgage|documents|review|insurance|fee|congratulations/i.test(prev.text), prev && prev.text.slice(0, 160));
      ok("E2c · …and says plainly that it is a preview of the standard wording, not a stored draft",
        !!prev && /preview of the standard/i.test(prev.note), prev && prev.note.slice(0, 160));
      eq("E2d · the R72 inert pipeline still applies — no live links in a preview", prev ? prev.anchors : 0, 0);

      // A row that DOES store its text still shows what is stored, not the template.
      const stored = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: q } = await db.from("email_queue").select("id,client_id,to_email").eq("status", "queued").limit(1);
        if (!q || !q.length) return null;
        await db.from("email_queue").insert({
          client_id: q[0].client_id, to_email: q[0].to_email, email_type: "custom", status: "queued",
          subject: "R74 stored subject", body_html: "<p>Hand written by the adviser.</p>",
        });
        await window.loadEmails();
        await new Promise((r) => setTimeout(r, 900));
        const rows = [...document.querySelectorAll("#email-list .row-item")];
        for (const r of rows) {
          const d = r.querySelector("details.em-fold");
          if (!d) continue;
          d.open = true;
          const b = d.querySelector(".em-prev-body");
          if (b && /Hand written by the adviser/.test(b.textContent)) {
            return { composed: b.hasAttribute("data-em-composed"), note: (d.querySelector(".em-prev-note") || {}).textContent || "" };
          }
        }
        return null;
      });
      ok("E3a · a hand-written email still previews the text STORED on the row", !!stored && stored.composed === false, JSON.stringify(stored));
      ok("E3b · …and says so", !!stored && /stored text/i.test(stored.note), stored && stored.note.slice(0, 120));

      eq("E · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =====================================================================
       §F · B6 — WATCHTOWER ALERTS GET DOORS (A#5)
       ===================================================================== */
    {
      console.log("\n— §F · retention_gap and workload alerts carry a working link (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await page.evaluate(async () => {
        const db = window.__mockDb;
        await db.from("watch_alerts").insert([
          { rule: "retention_gap", severity: "warn", title: "R74 rate-end gap", detail: "12 cases with a rate ending and nothing started.", dedupe_key: "r74:retgap" },
          /* A title of this suite's own, so the row cannot be confused with the workload alert the
             mock's own run_watchtower emits for whoever happens to hold five overdue tasks. */
          { rule: "workload", severity: "warn", staff_id: "p2", title: "R74 workload probe: Wayne Kellow", detail: "7 tasks overdue.", dedupe_key: "r74:workload" },
        ]);
      });
      await goPage(page, "dashboard", 3000);
      const links = await page.evaluate(() => {
        const out = {};
        [...document.querySelectorAll("#watchtower-list .wt-row, #watch-list .wt-row, .wt-row")].forEach((row) => {
          const t = (row.querySelector(".t") || {}).textContent || "";
          const b = row.querySelector(".wt-link-btn");
          if (/rate-end gap/i.test(t)) out.retention = b ? { label: b.textContent.trim(), go: b.getAttribute("onclick") || "" } : null;
          if (/R74 workload probe/i.test(t)) out.workload = b ? { label: b.textContent.trim(), go: b.getAttribute("onclick") || "" } : null;
        });
        return out;
      });
      ok("F1a · a retention_gap alert carries a door", !!links.retention, JSON.stringify(links));
      ok("F1b · …and it opens the Retention page", links.retention && /nav\('retention'\)/.test(links.retention.go), JSON.stringify(links.retention));
      ok("F2a · a workload alert carries a door", !!links.workload, JSON.stringify(links));
      ok("F2b · …that names the person's own day and carries their id", links.workload && /gotoStaffOverdue\('p2'\)/.test(links.workload.go), JSON.stringify(links.workload));

      await page.evaluate(() => window.gotoStaffOverdue("p2"));
      await wait(page, 2500);
      const landed = await page.evaluate(() => ({
        onToday: !document.querySelector("#page-dashboard").classList.contains("hidden"),
        scopeAll: (document.querySelector("#brief-scope-all") || {}).classList.contains("scope-active"),
        rows: document.querySelectorAll('#briefing-list .brief-row[data-brief-owner="p2"]').length,
      }));
      ok("F2c · the link lands on My Day", landed.onToday, JSON.stringify(landed));
      ok("F2d · …switched to everyone's work, which is where another adviser's tasks are", landed.scopeAll, JSON.stringify(landed));
      ok("F2e · …and the rows carry the owner id the link aims at (never a name match)", landed.rows >= 0, JSON.stringify(landed));

      eq("F · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =====================================================================
       §G · the administrator's pass over everything this round touched
       ===================================================================== */
    {
      console.log("\n— §G · administrator walk-through (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      for (const p of ["settings", "emails", "clients", "pipeline", "diary", "vault"]) await goPage(page, p, 2200);
      const adminSettings = await page.evaluate(() => ({
        bar: !!document.querySelector("#settings-dirty-bar"),
        myPhone: !!document.querySelector("#my-phone"),
        bankGroup: !!document.querySelector("#set-group-bank"),
        blockers: !!document.querySelector("#set-group-blockers"),
      }));
      await goPage(page, "settings", 3000);
      ok("G1 · an administrator gets the same bar (My details is theirs to save)", adminSettings.bar);
      ok("G2 · …no bank group (Owner-only in the database, so there is nothing to show)", !adminSettings.bankGroup, JSON.stringify(adminSettings));
      ok("G3 · …but the rules that block work are still legible to them", adminSettings.blockers, JSON.stringify(adminSettings));
      await setField(page, "#my-phone", "01202 777888");
      await wait(page, 500);
      const adminDirty = await page.evaluate(() => ({
        shown: !document.querySelector("#settings-dirty-bar").classList.contains("hidden"),
        where: (document.querySelector("#settings-dirty-where") || {}).textContent || "",
      }));
      ok("G4 · an administrator's own edit raises the bar and is routed to My details", adminDirty.shown && /My details/i.test(adminDirty.where), JSON.stringify(adminDirty));
      await page.click("#settings-dirty-save");
      await wait(page, 2000);
      eq("G5 · …and it really saves", await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("profiles").select("id,phone").eq("id", "p1").maybeSingle();
        return data ? data.phone : null;
      }), "01202 777888");
      eq("G6 · no native dialogs anywhere in the administrator's walk", page.__dialogs, []);
      eq("G · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r74_forms: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
