#!/usr/bin/env node
/* =============================================================================
   tests/r14.js — acceptance tests for ROUND 14: the company password safe
   (`vault_entries`) and the case modal's client security-check card.

     VAULT RLS   — SELECT is is_staff() AND (visible_to empty OR the caller's
                   role is named in it); INSERT/UPDATE any staff; DELETE
                   Owner/Administrator only. An introducer (p5) gets nothing.
     VAULT UI    — renders grouped by category with live per-group counts;
                   search matches name/owner/note/field label+value; category
                   chips filter with counts recomputed against the searched
                   set; secret fields render masked until Reveal, non-secret
                   fields render in clear immediately; a blank secret field
                   shows "—" with no Reveal/Copy controls.
     VAULT EDIT  — changing a field value and adding a new field, then saving,
                   round-trips through the mock DB and writes a masked
                   audit_log row (secret values → "(hidden)", non-secret kept).
     VAULT ADD   — a brand-new entry via the editor gets the right defaults
                   and a masked insert audit row; the "Who can see this" gate
                   only renders for Owner/Administrator, never an adviser.
     VAULT DEL   — Owner works (button, click, DB row gone, masked delete
                   audit); an adviser has no delete control AND a raw DB
                   delete attempt is refused (42501, row untouched).
     VAULT GATE  — Owner restricts an entry to ['owner']; it disappears for
                   an adviser; clearing the restriction brings it back.
     SEC CARD    — the case modal's security-check strip: name, DOB (or the
                   "(add DOB)" affordance when absent), property, home
                   address, loan amount, lender — every populated row carries
                   a copy control whose target matches what's shown.

   EVERY figure this file asserts is recomputed HERE, independently of
   app.js's own rendering — see the standing rule in HARNESS.md and every
   other suite in this directory. The vault's own fixtures are all fabricated
   test values (see mock-supabase.js's roundFourteenFixtures) — nothing here
   is a real credential.

   Run:  node /root/nx/tests/r14.js   (expects a static server on 8099;
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

async function newPage(browser, persona, opts) {
  const page = await browser.newPage();
  page.__dialogs = [];
  page.__dialogAnswer = "accept";
  page.__dialogPlan = [];
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    const next = page.__dialogPlan.length ? page.__dialogPlan.shift() : page.__dialogAnswer;
    if (next && typeof next === "object") { if (next.type === "dismiss") await d.dismiss(); else await d.accept(next.text); }
    else if (next === "dismiss") await d.dismiss();
    else await d.accept(typeof next === "string" ? next : undefined);
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  if (opts && opts.skipTour) await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const goto = async (page, pg, ms) => { await page.evaluate((p) => window.nav(p), pg); await wait(page, ms || 1000); };

async function readRow(page, table, filters) {
  return page.evaluate(async ({ table, filters }) => {
    let q = window.__mockDb.from(table).select("*");
    Object.entries(filters || {}).forEach(([k, v]) => { q = q.eq(k, v); });
    const { data } = await q.limit(1).single();
    return data;
  }, { table, filters });
}
async function readRows(page, table, filters) {
  return page.evaluate(async ({ table, filters }) => {
    let q = window.__mockDb.from(table).select("*");
    Object.entries(filters || {}).forEach(([k, v]) => { q = q.eq(k, v); });
    const { data } = await q;
    return data || [];
  }, { table, filters });
}
const readTableAs = (page, persona, table) => page.evaluate(({ persona, table }) => window.__mock.readTableAs(persona, table), { persona, table });
const lastAuditFor = (page, table, rowId) => page.evaluate(async ({ table, rowId }) => {
  const { data } = await window.__mockDb.from("audit_log").select("*").eq("table_name", table).eq("row_id", rowId);
  return (data || []).sort((a, b) => (a.happened_at < b.happened_at ? -1 : 1)).slice(-1)[0] || null;
}, { table, rowId });

/* --------------------------------------------------------------- friendly-
   category labels, reproduced independently of VAULT_CATS in app.js (the
   two must agree, but this file does not read app.js's constant — it
   asserts against the copy the page actually renders). */
const CAT_LABEL = { lender: "Lenders", protection: "Protection", gi: "GI", admin: "Admin & systems", contact: "Contacts", other: "Other" };
const CAT_ORDER = ["lender", "protection", "gi", "admin", "contact", "other"];

/* Independent re-implementation of vaultMatch()'s search predicate — name,
   owner_label, note, and every field's label+value, case-insensitive. */
function vaultRowMatches(r, qRaw) {
  const q = (qRaw || "").trim().toLowerCase();
  if (!q) return true;
  const hay = [r.name, r.owner_label, r.note]
    .concat((r.fields || []).reduce((a, f) => a.concat([f && f.label, f && f.value]), []))
    .filter((x) => x != null && x !== "")
    .join(" ").toLowerCase();
  return hay.indexOf(q) >= 0;
}
function groupCounts(rows) {
  const out = {};
  rows.forEach((r) => { const k = r.category || "other"; out[k] = (out[k] || 0) + 1; });
  return out;
}
/* fmtD/fmtM reproduced independently (en-GB day/short-month/year and GBP
   currency respectively) so the security-card assertions do not lean on
   app.js's own formatter. */
const fmtDGT = (d) => {
  if (!d) return "—";
  const t = new Date(d);
  return isNaN(t.getTime()) ? String(d) : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const fmtMGT = (n) => (n == null || n === "" ? "—" : Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }));

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {

    /* =======================================================================
       A · RLS ground truth + page render + per-persona visible counts
       ======================================================================= */
    {
      console.log("\n— A · vault RLS ground truth + grouped render");
      const page = await newPage(browser, "p4", { skipTour: true });

      // Ground truth: p4 (owner) matches every visible_to this fixture book
      // uses (null, or ['owner']), so an owner-scoped read is the full table.
      const groundTruth = await readTableAs(page, "p4", "vault_entries");
      eq("A1 · ground truth (owner) sees all 12 fixture rows", groundTruth.length, 12);
      const restricted = groundTruth.filter((r) => Array.isArray(r.visible_to) && r.visible_to.length);
      eq("A1 · exactly one row is gated (visible_to=['owner'])", restricted.map((r) => r.name), ["Test Admin Restricted"]);

      const ROLE_OF = { p1: "admin", p2: "adviser", p3: "adviser", p4: "owner" };
      for (const persona of ["p1", "p2", "p3", "p4"]) {
        const role = ROLE_OF[persona];
        const expected = groundTruth.filter((r) => !(Array.isArray(r.visible_to) && r.visible_to.length) || r.visible_to.indexOf(role) !== -1);
        const got = await readTableAs(page, persona, "vault_entries");
        eq(`A2 · readTableAs(${persona} ${role}) sees the right row count`, got.length, expected.length);
        eq(`A2 · readTableAs(${persona} ${role}) sees the right row ids`, got.map((r) => r.id).sort(), expected.map((r) => r.id).sort());
      }
      // p5 is an introducer — never staff, never gets a row regardless of visible_to.
      const p5rows = await readTableAs(page, "p5", "vault_entries");
      eq("A3 · an introducer (p5, not staff) sees zero vault rows", p5rows.length, 0);

      await page.close();
    }

    /* =======================================================================
       B · Vault page renders for every persona, grouped by category with
           correct counts, and the gated admin row is Owner-only
       ======================================================================= */
    {
      console.log("\n— B · vault page renders per persona · gated row visibility");
      const PERSONAS = [["p1", "admin"], ["p2", "adviser"], ["p3", "adviser"], ["p4", "owner"]];
      for (const [persona, role] of PERSONAS) {
        const page = await newPage(browser, persona, { skipTour: true });
        const rows = await readTableAs(page, persona, "vault_entries");
        await goto(page, "vault");
        ok(`B1 · ${persona} (${role}) — #page-vault is the active page`, await page.$eval("#page-vault", (e) => !e.classList.contains("hidden")));

        const groups = await page.$$eval("#vault-list .vault-group", (els) => els.map((g) => ({
          head: g.querySelector(".vault-group-head").childNodes[0].textContent.trim(),
          count: Number(g.querySelector(".seg-count").textContent.trim()),
          cards: g.querySelectorAll(".vault-card").length,
        })));
        const expectedCounts = groupCounts(rows);
        const gotCounts = {};
        groups.forEach((g) => {
          const key = Object.keys(CAT_LABEL).find((k) => CAT_LABEL[k] === g.head);
          gotCounts[key] = g.count;
          ok(`B2 · ${persona} — group "${g.head}" card count matches its header count`, g.cards === g.count, `${g.cards} cards vs header ${g.count}`);
        });
        eq(`B3 · ${persona} — grouped category counts match ground truth`, gotCounts, expectedCounts);

        const totalCards = await page.$$eval("#vault-list .vault-card", (els) => els.length);
        eq(`B4 · ${persona} — total rendered cards match visible row count`, totalCards, rows.length);

        const restrictedCard = await page.$$eval("#vault-list .vault-card .vault-name", (els) => els.some((e) => e.textContent.trim() === "Test Admin Restricted"));
        eq(`B5 · ${persona} — "Test Admin Restricted" (visible_to=['owner']) ${role === "owner" ? "IS" : "is NOT"} shown`, restrictedCard, role === "owner");

        ok(`B6 · ${persona} — no console errors on the vault page`, !page.__err, JSON.stringify(page.__err));
        await page.close();
      }
    }

    /* =======================================================================
       C · Search filters by name/owner/field value; category chips filter
           with live, search-aware counts
       ======================================================================= */
    {
      console.log("\n— C · search + category chips");
      const page = await newPage(browser, "p4", { skipTour: true });
      const all = await readTableAs(page, "p4", "vault_entries");
      await goto(page, "vault");

      // C1 — a term that only appears inside one SECRET field's value.
      await page.fill("#vault-search", "bluecar");
      await wait(page, 400);
      let names = await page.$$eval("#vault-list .vault-name", (els) => els.map((e) => e.textContent.trim()));
      const expectBluecar = all.filter((r) => vaultRowMatches(r, "bluecar")).map((r) => r.name).sort();
      eq("C1 · searching a secret field's value ('bluecar') filters to the one owning row", names.slice().sort(), expectBluecar);
      eq("C1 · exactly one card for 'bluecar'", names.length, 1);

      // C2 — case-insensitive.
      await page.fill("#vault-search", "BLUECAR");
      await wait(page, 400);
      names = await page.$$eval("#vault-list .vault-name", (els) => els.map((e) => e.textContent.trim()));
      eq("C2 · search is case-insensitive", names.slice().sort(), expectBluecar);

      // C3 — owner_label match.
      await page.fill("#vault-search", "Wayne");
      await wait(page, 400);
      names = await page.$$eval("#vault-list .vault-name", (els) => els.map((e) => e.textContent.trim()));
      const expectWayne = all.filter((r) => vaultRowMatches(r, "Wayne")).map((r) => r.name).sort();
      eq("C3 · searching an owner label ('Wayne') matches the right rows", names.slice().sort(), expectWayne);

      // C4 — chip counts recompute against the SEARCHED set, not the unfiltered book.
      await page.fill("#vault-search", "Test Bank");
      await wait(page, 400);
      const searched = all.filter((r) => vaultRowMatches(r, "Test Bank"));
      const chipCounts = await page.$$eval("#vault-segment .seg-btn", (els) => Object.fromEntries(
        els.map((b) => [b.dataset.seg, Number(b.querySelector(".seg-count").textContent.trim())])
      ));
      eq("C4 · 'All' chip count matches the searched-set size", chipCounts.all, searched.length);
      const expectedLenderChip = searched.filter((r) => (r.category || "other") === "lender").length;
      eq("C4 · 'lender' chip count matches the searched, category-filtered size", chipCounts.lender, expectedLenderChip);
      eq("C4 · 'gi' chip reads zero for a search with no GI hits", chipCounts.gi, 0);

      // C5 — clicking a category chip filters the list to just that category
      // (still honouring the live search text).
      await page.click('#vault-segment .seg-btn[data-seg="lender"]');
      await wait(page, 300);
      names = await page.$$eval("#vault-list .vault-name", (els) => els.map((e) => e.textContent.trim()));
      const expectedLenderNames = searched.filter((r) => (r.category || "other") === "lender").map((r) => r.name);
      eq("C5 · the 'lender' chip filters the list to lender-category rows only", names.length, expectedLenderNames.length);
      const activeChip = await page.$eval('#vault-segment .seg-btn[data-seg="lender"]', (e) => e.classList.contains("active"));
      ok("C5 · the clicked chip carries the active class", activeChip);

      // Clear back to All + no search so later sections start clean.
      await page.click('#vault-segment .seg-btn[data-seg="all"]');
      await page.fill("#vault-search", "");
      await wait(page, 300);

      ok("C6 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       D · Secret fields render masked; reveal shows the value; non-secret
           fields render in clear; a blank secret field shows "—" with no
           Reveal/Copy controls
       ======================================================================= */
    {
      console.log("\n— D · secret masking, reveal, and blank-secret state");
      const page = await newPage(browser, "p4", { skipTour: true });
      const bankA = await readRow(page, "vault_entries", { name: "Test Bank A", owner_label: "Daniel" });
      const pwField = bankA.fields.find((f) => f.secret && /pass/i.test(f.label));
      const userField = bankA.fields.find((f) => !f.secret);
      await goto(page, "vault");

      const cardSel = `#vault-list .vault-card[data-id="${bankA.id}"]`;
      // D1 — the secret field's displayed text is masked, never the raw value.
      const pwRow = await page.evaluateHandle((sel) => {
        const card = document.querySelector(sel);
        return [...card.querySelectorAll(".vault-field")].find((f) => f.querySelector(".vf-label").textContent.trim() === "Password");
      }, cardSel);
      const pwText = await page.evaluate((el) => el.querySelector(".vf-value").textContent, pwRow);
      ok("D1 · the Password field's shown text is masked bullets, not the real value", pwText === "••••••••" && pwText.indexOf(pwField.value) === -1, pwText);
      const pwDataVal = await page.evaluate((el) => el.querySelector(".vf-value").getAttribute("data-val"), pwRow);
      eq("D1 · the masked field's copy-target (data-val) IS the real secret value", pwDataVal, pwField.value);

      // D2 — reveal toggles the shown text to the real value and back.
      await page.evaluate((el) => el.querySelector(".vf-reveal").click(), pwRow);
      await wait(page, 150);
      let shown = await page.evaluate((el) => el.querySelector(".vf-value").textContent, pwRow);
      eq("D2 · clicking Reveal shows the real secret value", shown, pwField.value);
      await page.evaluate((el) => el.querySelector(".vf-reveal").click(), pwRow);
      await wait(page, 150);
      shown = await page.evaluate((el) => el.querySelector(".vf-value").textContent, pwRow);
      eq("D2 · clicking Reveal again re-masks it", shown, "••••••••");

      // D3 — a non-secret field renders in clear immediately, with no Reveal button.
      const userRow = await page.evaluateHandle((sel) => {
        const card = document.querySelector(sel);
        return [...card.querySelectorAll(".vault-field")].find((f) => f.querySelector(".vf-label").textContent.trim() === "Username");
      }, cardSel);
      const userText = await page.evaluate((el) => el.querySelector(".vf-value").textContent, userRow);
      eq("D3 · a non-secret field shows its real value with no masking", userText, userField.value);
      const userHasReveal = await page.evaluate((el) => !!el.querySelector(".vf-reveal"), userRow);
      ok("D3 · a non-secret field has no Reveal button", !userHasReveal);
      const userHasCopy = await page.evaluate((el) => !!el.querySelector(".vf-copy"), userRow);
      ok("D3 · a non-secret field still has a Copy button", userHasCopy);

      // D4 — a blank secret value shows "—" and offers neither Reveal nor Copy.
      const wifi = await readRow(page, "vault_entries", { name: "Test Office WiFi" });
      const blankField = wifi.fields.find((f) => f.secret && f.value === "");
      ok("D4 · fixture sanity — Test Office WiFi has an empty secret field", !!blankField);
      const wifiSel = `#vault-list .vault-card[data-id="${wifi.id}"]`;
      const blankRow = await page.evaluateHandle((sel) => {
        const card = document.querySelector(sel);
        return [...card.querySelectorAll(".vault-field")].find((f) => f.querySelector(".vf-label").textContent.trim() === "Password");
      }, wifiSel);
      const blankText = await page.evaluate((el) => el.querySelector(".vf-value").textContent.trim(), blankRow);
      eq("D4 · the blank secret field shows an em dash", blankText, "—");
      const blankHasBtns = await page.evaluate((el) => !!(el.querySelector(".vf-reveal") || el.querySelector(".vf-copy")), blankRow);
      ok("D4 · the blank secret field has neither Reveal nor Copy", !blankHasBtns);

      // A note-carrying row renders its note.
      const noteVal = await page.$eval(wifiSel + " .vault-note", (e) => e.textContent.trim()).catch(() => null);
      eq("D5 · the note field renders on the card", noteVal, wifi.note);

      ok("D6 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       E · Edit an entry: change a field value + add a field, save, read
           back, and the audit_log row masks the secret and keeps the clear
       ======================================================================= */
    {
      console.log("\n— E · edit an entry — round-trip + masked audit");
      const page = await newPage(browser, "p1", { skipTour: true });
      const before = await readRow(page, "vault_entries", { name: "Test GI" });
      const beforeUser = before.fields.find((f) => !f.secret);
      const beforePw = before.fields.find((f) => f.secret);
      await goto(page, "vault");

      await page.evaluate((id) => { const c = document.querySelector(`.vault-card[data-id="${id}"] .vault-edit`); c.click(); }, before.id);
      await wait(page, 400);
      ok("E1 · the editor overlay opens", await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden")));

      const NEW_PW = "test-pass-5-updated";
      const NEW_FIELD_LABEL = "Backup code", NEW_FIELD_VALUE = "test-backup-77";
      // Locate the Password row precisely and set its value; then add a new field row.
      await page.evaluate(({ pwLabel, newVal }) => {
        const rows = [...document.querySelectorAll("#overlay-modal .ve-field-row")];
        const pwRow = rows.find((r) => r.querySelector(".ve-f-label").value === pwLabel);
        const input = pwRow.querySelector(".ve-f-value");
        input.value = newVal;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, { pwLabel: beforePw.label, newVal: NEW_PW });
      await page.click("#overlay-modal #ve-add-field");
      await wait(page, 200);
      await page.evaluate(({ label, val }) => {
        const rows = [...document.querySelectorAll("#overlay-modal .ve-field-row")];
        const last = rows[rows.length - 1];
        last.querySelector(".ve-f-label").value = label;
        last.querySelector(".ve-f-value").value = val;
        last.querySelector(".ve-f-secret input").click();
      }, { label: NEW_FIELD_LABEL, val: NEW_FIELD_VALUE });

      await page.click("#overlay-modal #ve-save");
      await wait(page, 500);
      ok("E2 · the editor closes after saving", await page.evaluate(() => document.querySelector("#overlay-backdrop").classList.contains("hidden")));

      const after = await readRow(page, "vault_entries", { id: before.id });
      const afterPw = after.fields.find((f) => f.label === beforePw.label);
      const afterUser = after.fields.find((f) => f.label === beforeUser.label);
      const afterNew = after.fields.find((f) => f.label === NEW_FIELD_LABEL);
      eq("E3 · the edited field's value updated in the DB", afterPw && afterPw.value, NEW_PW);
      eq("E3 · the untouched non-secret field is unchanged", afterUser && afterUser.value, beforeUser.value);
      ok("E3 · the added field is present, secret, with the right value", !!afterNew && afterNew.secret === true && afterNew.value === NEW_FIELD_VALUE, JSON.stringify(afterNew));
      eq("E3 · the entry's field count grew by exactly one", after.fields.length, before.fields.length + 1);

      const audit = await lastAuditFor(page, "vault_entries", before.id);
      ok("E4 · an audit_log row was written for the update", audit && audit.action === "update", JSON.stringify(audit));
      const fchange = audit && audit.changes && audit.changes.fields;
      ok("E4 · the audit change carries an old/new diff shape for 'fields'", fchange && "old" in fchange && "new" in fchange);
      const newPwAudit = fchange && fchange.new.find((f) => f.label === beforePw.label);
      const oldPwAudit = fchange && fchange.old.find((f) => f.label === beforePw.label);
      eq("E4 · the audited NEW password value is masked", newPwAudit && newPwAudit.value, "(hidden)");
      eq("E4 · the audited OLD password value is masked too", oldPwAudit && oldPwAudit.value, "(hidden)");
      const newFieldAudit = fchange && fchange.new.find((f) => f.label === NEW_FIELD_LABEL);
      eq("E4 · the audited new secret field is masked", newFieldAudit && newFieldAudit.value, "(hidden)");
      const newUserAudit = fchange && fchange.new.find((f) => f.label === beforeUser.label);
      eq("E4 · the audited non-secret field is kept in the clear", newUserAudit && newUserAudit.value, beforeUser.value);

      ok("E5 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       F · Add a new entry via the editor; the gate control is
           Owner/Administrator-only
       ======================================================================= */
    {
      console.log("\n— F · add a new entry (+ delete it, same page) · the gate control is admin/owner-only");
      // NOTE — everything the Owner does to the row THIS SECTION CREATES stays on
      // ONE page/session throughout (create, inspect, delete). Every table here is
      // page-local JS memory (see HARNESS.md's "no sticky store" rule / the R5-5
      // and B6 tests) — a fresh page.goto() reseeds the mock's fixtures from
      // scratch, so a row minted on one page simply does not exist on another.
      const page = await newPage(browser, "p4", { skipTour: true });
      const before = await readRows(page, "vault_entries");
      await goto(page, "vault");

      await page.click("#new-vault-btn");
      await wait(page, 300);
      ok("F1 · the new-entry editor opens", await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden")));
      const gateVisibleOwner = await page.evaluate(() => !!document.querySelector("#overlay-modal .ve-gate"));
      ok("F2 · the Owner sees the 'Who can see this' gate control", gateVisibleOwner);

      const NAME = "Test New System";
      await page.fill("#overlay-modal #ve-name", NAME);
      await page.selectOption("#overlay-modal #ve-cat", "admin");
      await page.selectOption("#overlay-modal #ve-owner", "Daniel");
      await page.evaluate(() => {
        const rows = document.querySelectorAll("#overlay-modal .ve-field-row");
        rows[0].querySelector(".ve-f-label").value = "Username";
        rows[0].querySelector(".ve-f-value").value = "newsys-user";
      });
      await page.click("#overlay-modal #ve-add-field");
      await wait(page, 150);
      await page.evaluate(() => {
        const rows = document.querySelectorAll("#overlay-modal .ve-field-row");
        const last = rows[rows.length - 1];
        last.querySelector(".ve-f-label").value = "Password";
        last.querySelector(".ve-f-value").value = "test-pass-new1";
        last.querySelector(".ve-f-secret input").click();
      });
      await page.click("#overlay-modal #ve-save");
      await wait(page, 500);

      const after = await readRows(page, "vault_entries");
      eq("F3 · exactly one new row exists after saving", after.length, before.length + 1);
      const created = after.find((r) => r.name === NAME);
      ok("F3 · the new row was actually written", !!created);
      eq("F4 · applyInsertDefaults — sort_order defaults to 0", created.sort_order, 0);
      eq("F4 · applyInsertDefaults — visible_to defaults to null (left unticked)", created.visible_to, null);
      eq("F4 · the chosen category/owner were saved", [created.category, created.owner_label], ["admin", "Daniel"]);
      eq("F4 · both fields were saved with the right secret flags", created.fields.map((f) => [f.label, f.value, f.secret]),
        [["Username", "newsys-user", false], ["Password", "test-pass-new1", true]]);

      const audit = await lastAuditFor(page, "vault_entries", created.id);
      eq("F5 · an insert audit row was written", audit && audit.action, "insert");
      const auditPw = audit && audit.changes && audit.changes.fields && audit.changes.fields.find((f) => f.label === "Password");
      const auditUser = audit && audit.changes && audit.changes.fields && audit.changes.fields.find((f) => f.label === "Username");
      eq("F5 · the insert audit masks the secret field", auditPw && auditPw.value, "(hidden)");
      eq("F5 · the insert audit keeps the non-secret field in the clear", auditUser && auditUser.value, "newsys-user");

      // Re-render the vault list (the save already triggered loadVault(); this
      // confirms the new card is actually painted, with a delete control since
      // the current persona is the Owner) and delete it — all still this page.
      await wait(page, 300);
      const delSel = `#vault-list .vault-card[data-id="${created.id}"] .vault-del`;
      ok("F6 · the new card renders with a delete button for the Owner", !!(await page.$(delSel)));
      /* R74 · B3: the vault delete is guarded by the house overlay now, not a native confirm —
         the dialog names the entry and its confirming button carries the danger treatment. */
      await page.click(delSel);
      await wait(page, 400);
      const delDlg = await page.evaluate(() => {
        const ok = document.querySelector("#ovl-confirm-ok");
        return ok ? { label: ok.textContent.trim(), danger: ok.classList.contains("btn-danger-solid"),
                      body: (document.querySelector("#ovl-confirm-body") || {}).textContent || "" } : null;
      });
      ok("R74 · deleting a vault entry asks in the house overlay, not window.confirm", !!delDlg, JSON.stringify(delDlg));
      ok("R74 · …its confirming button is the danger one and names the verb", delDlg && delDlg.danger && /delete/i.test(delDlg.label), JSON.stringify(delDlg));
      await page.click("#ovl-confirm-ok");
      await wait(page, 500);
      const gone = await readRow(page, "vault_entries", { id: created.id });
      ok("F7 · the row is gone from the DB after the Owner deletes it", !gone);
      const delAudit = await lastAuditFor(page, "vault_entries", created.id);
      eq("F8 · a delete audit row was written", delAudit && delAudit.action, "delete");
      const delAuditPw = delAudit && delAudit.changes && (Array.isArray(delAudit.changes.fields) ? delAudit.changes.fields : []).find((f) => f.label === "Password");
      eq("F8 · the delete audit still masks the secret field", delAuditPw && delAuditPw.value, "(hidden)");

      ok("F9 · no console errors (owner)", !page.__err, JSON.stringify(page.__err));
      await page.close();

      // An adviser gets the editor but never the gate control (fresh page — this
      // check does not depend on anything the owner just created above).
      const advPage = await newPage(browser, "p2", { skipTour: true });
      await goto(advPage, "vault");
      await advPage.click("#new-vault-btn");
      await wait(advPage, 300);
      const gateVisibleAdviser = await advPage.evaluate(() => !!document.querySelector("#overlay-modal .ve-gate"));
      ok("F10 · an adviser does NOT see the 'Who can see this' gate control", !gateVisibleAdviser);
      await advPage.click("#overlay-modal #ve-cancel");
      ok("F11 · no console errors (adviser)", !advPage.__err, JSON.stringify(advPage.__err));
      await advPage.close();
    }

    /* =======================================================================
       G · Delete on the FIXTURE book — an adviser has no control anywhere on
           the page, and a raw DB delete attempt is refused. (These use the
           deterministically-reseeded fixture rows, not anything created in
           section F, so a fresh page is fine here.)
       ======================================================================= */
    {
      console.log("\n— G · delete on the fixture book: adviser is refused both ways");
      const advPage = await newPage(browser, "p2", { skipTour: true });
      await goto(advPage, "vault");
      const anyDeleteBtn = await advPage.$$eval("#vault-list .vault-del", (els) => els.length);
      eq("G1 · an adviser sees ZERO delete buttons anywhere on the vault page", anyDeleteBtn, 0);

      const bdmBefore = await readRow(advPage, "vault_entries", { name: "Test BDM" });
      const rawDel = await advPage.evaluate(async (id) => {
        const { error } = await window.__mockDb.from("vault_entries").delete().eq("id", id);
        return error;
      }, bdmBefore.id);
      ok("G2 · a raw DB delete attempt by an adviser is refused", rawDel && rawDel.code === "42501", JSON.stringify(rawDel));
      const bdmAfter = await readRow(advPage, "vault_entries", { name: "Test BDM" });
      ok("G2 · the row still exists after the refused delete", !!bdmAfter);
      ok("G3 · no console errors", !advPage.__err, JSON.stringify(advPage.__err));
      await advPage.close();
    }

    /* =======================================================================
       H · Gating via the UI — restrict, confirm it's gone for an adviser,
           clear it, confirm it returns. One page/session throughout (see the
           note in section F): the "confirm gone for an adviser" step uses
           `__mock.readTableAs()`, the harness's blessed mechanism for "would a
           DIFFERENT role see this row", exactly as tests/r5_batch4.js's B6
           check does for duplicate_dismissals — a literal second browser page
           would just reseed the seven-fixture book from scratch and never see
           this page's live edit at all.
       ======================================================================= */
    {
      console.log("\n— H · gating via the editor's 'Who can see this' control");
      const page = await newPage(browser, "p4", { skipTour: true });
      const gateTarget = await readRow(page, "vault_entries", { name: "Test BDM" });
      eq("H0 · fixture sanity — 'Test BDM' starts unrestricted", gateTarget.visible_to, null);
      await goto(page, "vault");

      // Restrict to Owner only.
      await page.evaluate((id) => document.querySelector(`.vault-card[data-id="${id}"] .vault-edit`).click(), gateTarget.id);
      await wait(page, 300);
      await page.click('#overlay-modal .ve-vt[value="owner"]');
      await page.click("#overlay-modal #ve-save");
      await wait(page, 500);
      const restrictedRow = await readRow(page, "vault_entries", { id: gateTarget.id });
      eq("H1 · visible_to is now ['owner'] after restricting", restrictedRow.visible_to, ["owner"]);

      // Owner's OWN re-render still shows it (owner matches the restriction).
      let ownerSeesIt = await page.$$eval("#vault-list .vault-name", (els, n) => els.some((e) => e.textContent.trim() === n), "Test BDM");
      ok("H2 · the Owner's own re-render still shows the row they just restricted to themself", ownerSeesIt);

      // An adviser's read of the SAME live row is now empty.
      const advTable = await readTableAs(page, "p2", "vault_entries");
      ok("H3 · an adviser's RLS-filtered read no longer includes the restricted row", !advTable.some((r) => r.id === gateTarget.id));
      const adminTable = await readTableAs(page, "p1", "vault_entries");
      ok("H3 · an ADMINISTRATOR's read no longer includes it either — only 'owner' was ticked", !adminTable.some((r) => r.id === gateTarget.id));

      // Clear the restriction — reopening the editor shows the box pre-ticked.
      await page.evaluate((id) => document.querySelector(`.vault-card[data-id="${id}"] .vault-edit`).click(), gateTarget.id);
      await wait(page, 300);
      const ownerTicked = await page.$eval('#overlay-modal .ve-vt[value="owner"]', (e) => e.checked);
      ok("H4 · the editor reopens with the Owner box already ticked", ownerTicked);
      await page.click('#overlay-modal .ve-vt[value="owner"]');
      await page.click("#overlay-modal #ve-save");
      await wait(page, 500);
      const clearedRow = await readRow(page, "vault_entries", { id: gateTarget.id });
      eq("H5 · visible_to is null again after clearing the restriction", clearedRow.visible_to, null);

      // An adviser's read of the live row includes it again.
      const advTable2 = await readTableAs(page, "p2", "vault_entries");
      ok("H6 · an adviser's RLS-filtered read includes the row again once cleared", advTable2.some((r) => r.id === gateTarget.id));

      ok("H7 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       I · Copy affordances — buttons present, and their copy target matches
           the value the field actually shows/holds
       ======================================================================= */
    {
      console.log("\n— I · copy affordances");
      const page = await newPage(browser, "p4", { skipTour: true });
      const bdm = await readRow(page, "vault_entries", { name: "Test BDM" });
      await goto(page, "vault");
      const cardSel = `#vault-list .vault-card[data-id="${bdm.id}"]`;

      // Every populated (non-secret) field on Test BDM carries a Copy button
      // whose target (the sibling .vf-value's data-val) equals the real value.
      const copyChecks = await page.$$eval(cardSel + " .vault-field", (rows) => rows.map((r) => {
        const val = r.querySelector(".vf-value");
        const copy = r.querySelector(".vf-copy");
        return { label: r.querySelector(".vf-label").textContent.trim(), hasCopy: !!copy, dataVal: val.getAttribute("data-val") };
      }));
      bdm.fields.forEach((f) => {
        const row = copyChecks.find((c) => c.label === f.label);
        ok(`I1 · "${f.label}" has a Copy button`, row && row.hasCopy, JSON.stringify(row));
        eq(`I1 · "${f.label}"'s copy target matches its real value`, row && row.dataVal, f.value);
      });

      // The password-shortcut button on a card with a password-like secret field.
      const bankA = await readRow(page, "vault_entries", { name: "Test Bank A", owner_label: "Luke" });
      const pwField = bankA.fields.find((f) => f.secret && /pass/i.test(f.label));
      const pwShortcutTarget = await page.$eval(`#vault-list .vault-card[data-id="${bankA.id}"] .vault-pw-copy`, (e) => e.getAttribute("data-nexcopy")).catch(() => null);
      eq("I2 · the '🔑 Copy password' shortcut's target is the real password value", pwShortcutTarget, pwField.value);

      // A secret field with a value carries BOTH Reveal and Copy.
      const secretRow = await page.evaluateHandle(({ sel, label }) => {
        const card = document.querySelector(sel);
        return [...card.querySelectorAll(".vault-field")].find((f) => f.querySelector(".vf-label").textContent.trim() === label);
      }, { sel: `#vault-list .vault-card[data-id="${bankA.id}"]`, label: pwField.label });
      const hasBoth = await page.evaluate((el) => !!(el.querySelector(".vf-reveal") && el.querySelector(".vf-copy")), secretRow);
      ok("I3 · a filled secret field carries both Reveal and Copy controls", hasBoth);

      ok("I4 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       J · The client security-check card on the case modal
       ======================================================================= */
    {
      console.log("\n— J · case modal client security-check card");
      const page = await newPage(browser, "p4", { skipTour: true });

      // Ground truth, computed independently: a case whose client HAS a DOB,
      // and one whose client does NOT — both found live off the fixtures.
      const found = await page.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases").select("*");
        const { data: clients } = await window.__mockDb.from("clients").select("*");
        const clientById = Object.fromEntries((clients || []).map((c) => [c.id, c]));
        const withDob = (cases || []).find((c) => {
          const cl = clientById[c.client_id];
          return cl && cl.date_of_birth && c.loan_amount != null && c.lender;
        });
        const withoutDob = (cases || []).find((c) => {
          const cl = clientById[c.client_id];
          return cl && !cl.date_of_birth;
        });
        return {
          withDob: withDob ? { caseId: withDob.id, client: clientById[withDob.client_id], kase: withDob } : null,
          withoutDob: withoutDob ? { caseId: withoutDob.id, client: clientById[withoutDob.client_id], kase: withoutDob } : null,
        };
      });
      ok("J0 · fixture sanity — a case with a DOB'd client exists", !!found.withDob);
      ok("J0 · fixture sanity — a case with a DOB-less client exists", !!found.withoutDob);

      // --- the DOB-present case ---
      await page.evaluate((id) => window.openCase(id), found.withDob.caseId);
      await wait(page, 700);
      ok("J1 · the security card renders", !!(await page.$("#case-sec-card")));

      // J1b — R14b: the card is COLLAPSED BY DEFAULT on every open.
      const expectedName = [found.withDob.client.first_name, found.withDob.client.last_name].filter(Boolean).join(" ");
      const collapsedState = await page.evaluate(() => {
        const card = document.querySelector("#case-sec-card");
        const grid = document.querySelector("#sec-grid");
        const toggle = document.querySelector("#sec-toggle");
        const who = document.querySelector("#case-sec-card .sec-who");
        return {
          hasCollapsedClass: card.classList.contains("sec-collapsed"),
          gridVisible: grid.offsetParent !== null && getComputedStyle(grid).display !== "none",
          ariaExpanded: toggle.getAttribute("aria-expanded"),
          who: who ? who.textContent.trim() : null,
        };
      });
      ok("J1b · the card is collapsed by default (.sec-collapsed present)", collapsedState.hasCollapsedClass);
      ok("J1b · #sec-grid is hidden while collapsed", !collapsedState.gridVisible);
      eq("J1b · the collapsed header's aria-expanded reads false", collapsedState.ariaExpanded, "false");
      eq("J1b · the collapsed header names the client in .sec-who", collapsedState.who, expectedName);

      // J1c — clicking the toggle expands it.
      await page.click("#sec-toggle");
      await wait(page, 200);
      const expandedState = await page.evaluate(() => {
        const card = document.querySelector("#case-sec-card");
        const grid = document.querySelector("#sec-grid");
        const toggle = document.querySelector("#sec-toggle");
        return {
          hasCollapsedClass: card.classList.contains("sec-collapsed"),
          gridVisible: grid.offsetParent !== null && getComputedStyle(grid).display !== "none",
          ariaExpanded: toggle.getAttribute("aria-expanded"),
        };
      });
      ok("J1c · clicking #sec-toggle removes .sec-collapsed", !expandedState.hasCollapsedClass);
      ok("J1c · #sec-grid is visible once expanded", expandedState.gridVisible);
      eq("J1c · aria-expanded now reads true", expandedState.ariaExpanded, "true");

      const rowsGot = await page.$$eval("#case-sec-card .sec-item", (els) => els.map((e) => ({
        label: e.querySelector(".sec-lbl").textContent.trim(),
        val: (() => { const v = e.querySelector(".sec-val").cloneNode(true); const b = v.querySelector(".sec-copy"); if (b) b.remove(); return v.textContent.trim(); })(),
        hasCopy: !!e.querySelector(".sec-copy"),
        copyTarget: e.querySelector(".sec-copy") ? e.querySelector(".sec-copy").getAttribute("data-nexcopy") : null,
      })));
      const nameRow = rowsGot.find((r) => r.label === "Name");
      eq("J2 · Name shows the client's full name", nameRow && nameRow.val, expectedName);
      ok("J2 · Name has a copy control matching what's shown", nameRow && nameRow.hasCopy && nameRow.copyTarget === expectedName);

      const dobRow = rowsGot.find((r) => r.label === "Date of birth");
      eq("J3 · DOB is formatted the same way independently (fmtD)", dobRow && dobRow.val, fmtDGT(found.withDob.client.date_of_birth));

      const loanRow = rowsGot.find((r) => r.label === "Loan amount");
      eq("J4 · Loan amount is formatted as GBP currency", loanRow && loanRow.val, fmtMGT(found.withDob.kase.loan_amount));
      ok("J4 · Loan amount has a matching copy control", loanRow && loanRow.hasCopy && loanRow.copyTarget === loanRow.val);

      const lenderRow = rowsGot.find((r) => r.label === "Lender");
      eq("J5 · Lender shows the case's lender", lenderRow && lenderRow.val, found.withDob.kase.lender);
      ok("J5 · Lender has a matching copy control", lenderRow && lenderRow.hasCopy && lenderRow.copyTarget === lenderRow.val);

      const homeRow = rowsGot.find((r) => r.label === "Home address");
      const expectedHome = found.withDob.client.address || "—";
      eq("J6 · Home address matches the client record (or the em dash)", homeRow && homeRow.val, expectedHome);

      // J6b — R14b: cases.mortgage_account_number. Recomputed from the SAME
      // live fixture read (found.withDob.kase), never hardcoded.
      const mortRow = rowsGot.find((r) => r.label === "Mortgage / account no.");
      const expectedMort = found.withDob.kase.mortgage_account_number || "—";
      ok("J6b · fixture sanity — this case carries a real mortgage/account number", !!found.withDob.kase.mortgage_account_number, JSON.stringify(found.withDob.kase.mortgage_account_number));
      eq("J6b · 'Mortgage / account no.' shows the fixture value", mortRow && mortRow.val, expectedMort);
      ok("J6b · it carries a matching copy control", mortRow && mortRow.hasCopy && mortRow.copyTarget === expectedMort);

      // Every row that has a real value carries a copy control; the empty
      // ones (em dash) do not.
      let allGood = true;
      rowsGot.forEach((r) => { if (r.val !== "—" && !r.hasCopy) allGood = false; });
      ok("J7 · every populated security-card row has a copy control", allGood, JSON.stringify(rowsGot));

      // --- the DOB-absent case ---
      await page.evaluate((id) => window.openCase(id), found.withoutDob.caseId);
      await wait(page, 700);
      // Collapsed again on this fresh open — expand before reading its rows.
      ok("J7b · the re-opened modal is collapsed again too", await page.$eval("#case-sec-card", (e) => e.classList.contains("sec-collapsed")));
      await page.click("#sec-toggle");
      await wait(page, 200);
      const rows2 = await page.$$eval("#case-sec-card .sec-item", (els) => els.map((e) => ({
        label: e.querySelector(".sec-lbl").textContent.trim(),
        val: (() => { const v = e.querySelector(".sec-val").cloneNode(true); const b = v.querySelector(".sec-copy"); if (b) b.remove(); return v.textContent.trim(); })(),
        hasCopy: !!e.querySelector(".sec-copy"),
        hasAddDob: !!e.querySelector(".sec-dob-add"),
      })));
      // J7c — the DOB-absent case's mortgage/account row: whatever the
      // fixture actually holds (usually null → "—"), recomputed, not assumed.
      const mortRow2 = rows2.find((r) => r.label === "Mortgage / account no.");
      const expectedMort2 = (found.withoutDob.kase.mortgage_account_number || "—");
      eq("J7c · the second case's mortgage/account row matches its own fixture value", mortRow2 && mortRow2.val, expectedMort2);
      eq("J7c · its copy control is present only when there's a real value", !!(mortRow2 && mortRow2.hasCopy), expectedMort2 !== "—");

      const dobRow2 = rows2.find((r) => r.label === "Date of birth");
      ok("J8 · the missing-DOB row shows the em dash", dobRow2 && dobRow2.val.indexOf("—") === 0, JSON.stringify(dobRow2));
      ok('J8 · the missing-DOB row offers the "(add DOB)" affordance', dobRow2 && dobRow2.hasAddDob);
      ok("J8 · the missing-DOB row has no copy control (there's nothing to copy)", dobRow2 && !dobRow2.hasCopy);
      const addDobHref = await page.$eval("#case-sec-card .sec-dob-add", (e) => e.getAttribute("onclick"));
      ok("J9 · the (add DOB) link targets THIS case's client id", addDobHref && addDobHref.indexOf(found.withoutDob.client.id) !== -1, addDobHref);

      ok("J10 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       K · Mock-level odds and ends: applyInsertDefaults directly, and a
           staff insert/update (not just via the editor) is accepted
       ======================================================================= */
    {
      console.log("\n— K · applyInsertDefaults + staff write policy, at the DB level");
      const page = await newPage(browser, "p3", { skipTour: true });
      const inserted = await page.evaluate(async () => {
        const { data, error } = await window.__mockDb.from("vault_entries").insert([{ name: "Test Minimal Row" }]).select().single();
        return { data, error };
      });
      ok("K1 · a minimal insert (name only) is accepted for an adviser (any staff may write)", !inserted.error, JSON.stringify(inserted.error));
      eq("K2 · applyInsertDefaults — category defaults to 'other'", inserted.data && inserted.data.category, "other");
      eq("K2 · applyInsertDefaults — fields defaults to []", inserted.data && inserted.data.fields, []);
      eq("K2 · applyInsertDefaults — visible_to defaults to null", inserted.data && inserted.data.visible_to, null);
      eq("K2 · applyInsertDefaults — sort_order defaults to 0", inserted.data && inserted.data.sort_order, 0);
      ok("K2 · created_at/updated_at were stamped", !!(inserted.data && inserted.data.created_at && inserted.data.updated_at));

      // Clean up so K's probe row doesn't linger in the fixture set for anyone re-running this file.
      const del = await page.evaluate(async (id) => {
        const { error } = await window.__mockDb.from("vault_entries").delete().eq("id", id);
        return error;
      }, inserted.data.id);
      ok("K3 · an adviser's own raw delete attempt is refused too (owner/admin only)", del && del.code === "42501", JSON.stringify(del));
      // Actually remove it as the owner, so the fixture book is clean for a second run.
      const owner = await newPage(browser, "p4", { skipTour: true });
      await owner.evaluate(async (id) => { await window.__mockDb.from("vault_entries").delete().eq("id", id); }, inserted.data.id);
      const stillThere = await readRow(owner, "vault_entries", { id: inserted.data.id });
      ok("K4 · the probe row is gone once the Owner deletes it", !stillThere);
      await owner.close();

      ok("K5 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (e) { try { server.kill(); } catch (_) { } } }
  }

  console.log("\n================================================================");
  console.log(`r14: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
