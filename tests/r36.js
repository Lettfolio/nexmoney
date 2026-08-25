#!/usr/bin/env node
/* =============================================================================
   tests/r36.js — acceptance tests for ROUND 36: three parallel builds merged —
   protection-on-client + client-row extras + protection search (A), searchable
   client/referrer/appointment pickers + a slim new-case form (B), and a bulk-task
   property picker for multi-case clients (C).

   What R36 shipped (build agents' verified summaries, see HEAD 5e67587):

   A — PROTECTION ON THE CLIENT RECORD, ROW EXTRAS, PROTECTION SEARCH
     1. Every case row on a client's drawer (grouped or not) now carries a
        `.cl-prot-chip` badge — `data-prot="<status>"`, coloured grey for
        not_discussed/declined, amber for discussed/quoted, green for
        policy_taken — reading straight off `protection_status`.
     2. The client LIST gains two row extras: `.client-prop-n` (a grey badge
        naming how many DISTINCT properties the client's cases sit on — shown
        only when >1, silent at 0/1), fed by a `,property_address` widening of
        the clients embed gated on propAddrSupported(); and `.client-lc-age`
        (a muted "last contact N days ago"/"no contact in 210 days" label) on
        EVERY row except the Cold segment's own rows, which keep their fuller
        "last contact 12 Mar (note)" line instead — never both.
     3. The Protection page gains `#prot-search` (debounced 250ms, same as
        `#board-search`): composes scope → search → status, the KPI tiles
        re-read against the search, and the empty state names the term when a
        search produced it.

   B — SEARCHABLE PICKERS + SLIM NEW-CASE FORM
     4. `upgradeSelectToCombobox` progressively enhances `#case-client-select`,
        `#case-referrer-select` and `#appt-client`: the native `<select>` stays
        in the DOM (hidden, class `combo-native`) as the value carrier; a
        `.combo-input` (role=combobox) + `.combo-list` (`.combo-opt`, pinned
        sentinels `.combo-pin` incl. `__new__`, capped at 12 real matches with
        a "N more — keep typing" line) sit beside it. Typing filters by
        token-AND across the option's whole text (so a FIRST name matches a
        "Last, First" option); ↑/↓ moves, Enter picks (writes `select.value`
        and fires a real `change`), Esc closes the list without touching the
        modal.
     5. The NEW-case form is now built from a `.case-core-grid` (client,
        property address, case kind, stage, assigned-to) shown above the fold,
        with the other ~39 fields folded into the SAME collapsed
        `<details class="case-details">` accordion the edit form has always
        used — one `<form id="case-form">`, so FormData still sees every field
        and an unopened accordion still writes its markup's defaults. The EDIT
        form is byte-identical to before: no `.case-core-grid`, every field
        inside the accordion.

   C — BULK-TASK PROPERTY PICKER
     6. `clientTaskTarget`'s `many_live` refusal now carries the live cases it
        refused to choose between (`{why:"many_live", choices}`). The bulk
        "＋ Add task…" flow on the Clients page resolves this BEFORE the
        confirm dialog: `#btaskc-pick-rows` holds one `.bulk-task-case-pick`
        select per ambiguous client (their own live cases, property · lender
        · stage, plus "Skip this one"), `#btaskc-pick-left` counts what is
        still to choose, `#btaskc-pick-ok` stays disabled until every select
        has a value, and `#btaskc-pick-cancel`/Escape aborts the WHOLE batch —
        nothing is written. An unambiguous-only selection never sees the
        overlay at all. Chosen clients flow into the SAME target list and the
        SAME write loop as single-case clients; a title-dedupe (matched by
        `playbookTitleKey` against each target case's OPEN tasks) means
        pressing the same batch twice adds nothing the second time, reported
        as "N already had that task open".

   §A drawer chips, list-row extras, protection search
   §B combobox behaviour, appt picker reveal, new/edit case form shape
   §C bulk-task case-resolution overlay
   §D no NEW console errors anywhere above

   EVERY figure this file asserts is either read straight back off the mock db
   or fixed by the test's OWN construction (never imported from app.js's own
   STAGES/KINDS/PROT_BADGE) — the standing "compute test expectations
   independently" rule.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r36.js
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
  page.__dialogAnswer = "accept";
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    if (page.__dialogAnswer === "dismiss") await d.dismiss(); else await d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const noNewErr = (page, before) => (page.__err || []).length === before;
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1000 : ms);
};

/* The full set of R36-relevant localStorage keys — cleared the same defensive way every suite in
   this harness clears them, so a real stored choice from a PREVIOUS suite's run can never leak
   into this one's starting state (see the standing rule in HARNESS.md). */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads",
  "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — same independent-of-fixture technique
   tests/r35.js/r34.js/r31.js/r25.js/r16.js already use: every assertion below
   is about a client/case this file created and fully controls.
   ------------------------------------------------------------------------- */
async function insertClient(page, fields) {
  return page.evaluate(async (f) => {
    const db = window.__mockDb;
    const { data, error } = await db.from("clients").insert(f).select("id").single();
    if (error) throw new Error("client insert: " + error.message);
    return data.id;
  }, fields);
}
async function insertCase(page, fields) {
  return page.evaluate(async (f) => {
    const db = window.__mockDb;
    const { data, error } = await db.from("cases").insert(f).select("id").single();
    if (error) throw new Error("case insert: " + error.message);
    return data.id;
  }, fields);
}
async function mkClientCase(page, opts) {
  const o = opts || {};
  const clId = await insertClient(page, {
    first_name: o.first || "R36", last_name: o.last || ("Case" + Math.random().toString(36).slice(2, 8)),
    email: o.email || `r36.${Math.random().toString(36).slice(2, 9)}@example.com`, phone: "07700900000",
  });
  const row = Object.assign({ client_id: clId, case_kind: "buy_to_let", stage: "application", assigned_to: "p2" }, o.case || {});
  const caseId = await insertCase(page, row);
  return { clId, caseId };
}
const readCase = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", id).single();
  return data;
}, caseId);
const readTasksByTitle = (page, title) => page.evaluate(async (t) => {
  const { data } = await window.__mockDb.from("case_tasks").select("id,case_id,title,assigned_to,due_date");
  return (data || []).filter((x) => x.title === t);
}, title);
const openExistingCase = async (page, caseId) => {
  await page.evaluate((id) => window.openCase(id), caseId);
  await wait(page, 900);
};
const openNewCase = async (page) => {
  await page.evaluate(() => window.openCase(null));
  await wait(page, 700);
};

/* One case row inside a client's drawer, as it renders — used for the §A1 chip checks. Matched by
   the "openCase('<id>')" onclick every row's title carries (see clientCaseRowHtml). */
const caseRowChip = (page, caseId) => page.evaluate((id) => {
  const t = [...document.querySelectorAll("#modal .row-item .t")].find((e) => (e.getAttribute("onclick") || "").includes(`openCase('${id}')`));
  const row = t ? t.closest(".row-item") : null;
  const chip = row ? row.querySelector(".cl-prot-chip") : null;
  return chip ? { cls: chip.className, dataProt: chip.dataset.prot, text: chip.textContent.trim() } : null;
}, caseId);

/* A client-list row, by client id (data-client on .client-row — see loadClients). */
const clientRow = (page, clientId) => page.evaluate((id) => {
  const row = document.querySelector(`.client-row[data-client="${id}"]`);
  if (!row) return null;
  const propBadge = row.querySelector(".client-prop-n");
  const lcAge = row.querySelector(".client-lc-age");
  const lastContact = row.querySelector(".client-lastcontact");
  const nextFact = row.querySelector(".client-next");
  return {
    propBadgeText: propBadge ? propBadge.textContent.trim() : null,
    lcAgeText: lcAge ? lcAge.textContent.trim() : null,
    nextText: nextFact ? nextFact.textContent.trim() : null,
    lastContactText: lastContact ? lastContact.textContent.trim() : null,
  };
}, clientId);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       A1 · DRAWER CHIPS — .cl-prot-chip on every case row, grouped or not
       ======================================================================= */
    {
      console.log("\n— A1 · client drawer case rows carry .cl-prot-chip, right class + data-prot, grouped rows too (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const clId = await insertClient(page, { first_name: "R36A1", last_name: "Chips", email: `r36a1.${Date.now()}@example.com`, phone: "07700900000" });
      // A solo case, no protection conversation at all — the fallback grey "None".
      const noneCaseId = await insertCase(page, { client_id: clId, case_kind: "remortgage", stage: "application", assigned_to: "p2", protection_status: "not_discussed", property_address: "1 R36A1 Chip Street, Bournemouth BH1 1AA" });
      // Two cases sharing ONE property — forces the GROUPED (.cprop-group) render path, and each
      // still carries its own chip (quoted amber, policy green).
      const quotedCaseId = await insertCase(page, { client_id: clId, case_kind: "buy_to_let", stage: "application", assigned_to: "p2", protection_status: "quoted", property_address: "2 R36A1 Chip Road, Bournemouth BH2 2BB" });
      const policyCaseId = await insertCase(page, { client_id: clId, case_kind: "buy_to_let", stage: "offer", assigned_to: "p2", protection_status: "policy_taken", property_address: "2 R36A1 Chip Road, Bournemouth BH2 2BB" });
      // A declined case, on its own property — the OTHER grey (a finished conversation).
      const declinedCaseId = await insertCase(page, { client_id: clId, case_kind: "purchase", stage: "enquiry", assigned_to: "p2", protection_status: "declined", property_address: "3 R36A1 Chip Avenue, Bournemouth BH3 3CC" });

      await page.evaluate((id) => window.openClient(id), clId);
      await wait(page, 900);

      const groupCount = await page.evaluate(() => document.querySelectorAll("#modal .cprop-group").length);
      ok("A1 · this client's 4 cases across 3 properties render GROUPED (.cprop-group)", groupCount >= 2, groupCount);

      const none = await caseRowChip(page, noneCaseId);
      ok("A1a · not_discussed → grey \"None\"", !!none && /\bgrey\b/.test(none.cls) && none.dataProt === "not_discussed" && /None/.test(none.text), JSON.stringify(none));

      const quoted = await caseRowChip(page, quotedCaseId);
      ok("A1b · quoted → amber \"Quoted\" (grouped row)", !!quoted && /\bamber\b/.test(quoted.cls) && quoted.dataProt === "quoted" && /Quoted/.test(quoted.text), JSON.stringify(quoted));

      const policy = await caseRowChip(page, policyCaseId);
      ok("A1c · policy_taken → green \"Policy\" (grouped row, sibling to the quoted one)", !!policy && /\bgreen\b/.test(policy.cls) && policy.dataProt === "policy_taken" && /Policy/.test(policy.text), JSON.stringify(policy));

      const declined = await caseRowChip(page, declinedCaseId);
      ok("A1d · declined → grey \"Declined\" (a finished conversation, not a gap)", !!declined && /\bgrey\b/.test(declined.cls) && declined.dataProt === "declined" && /Declined/.test(declined.text), JSON.stringify(declined));

      ok("A1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       A2 · CLIENT-LIST ROW EXTRAS — .client-prop-n, .client-lc-age, cold suppression
       ======================================================================= */
    {
      console.log("\n— A2 · client list: multi-property badge, last-contact age on every row, cold segment keeps its own line only (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const multiId = await insertClient(page, { first_name: "R36A2", last_name: "Multi", email: `r36a2multi.${Date.now()}@example.com`, phone: "07700900000" });
      await insertCase(page, { client_id: multiId, case_kind: "remortgage", stage: "application", assigned_to: "p2", property_address: "10 R36A2 Multi Street, Bournemouth BH1 1AA" });
      await insertCase(page, { client_id: multiId, case_kind: "buy_to_let", stage: "application", assigned_to: "p2", property_address: "11 R36A2 Multi Road, Bournemouth BH2 2BB" });

      const soloId = await insertClient(page, { first_name: "R36A2", last_name: "Solo", email: `r36a2solo.${Date.now()}@example.com`, phone: "07700900000" });
      await insertCase(page, { client_id: soloId, case_kind: "remortgage", stage: "application", assigned_to: "p2", property_address: "12 R36A2 Solo Avenue, Bournemouth BH3 3CC" });

      await goto(page, "clients", 1000);

      const multiRow = await clientRow(page, multiId);
      eq("A2a · a 2-property client's row carries \"2 properties\"", multiRow && multiRow.propBadgeText, "2 properties");
      const soloRow = await clientRow(page, soloId);
      eq("A2b · a 1-property client's row carries NO .client-prop-n badge (noise at n<2)", soloRow && soloRow.propBadgeText, null);

      /* R61 — CONTRACT CHANGE: "no contact in 210 days" was true of nearly the whole imported
         book, so the row no longer prints it (a fact true of everybody is noise, not news). The
         .client-lc-age span now renders ONLY when a contact IS recorded; the silent rows carry
         the R61 .client-next current-fact instead (here: the live case's kind and stage). */
      ok("A2c · a no-comms client's row carries NO .client-lc-age (R61 — silence is not news)",
        multiRow && multiRow.lcAgeText === null, JSON.stringify(multiRow));
      ok("A2d · …and instead carries the R61 current-fact span (live case → kind at stage)",
        soloRow && soloRow.nextText != null && /at /.test(soloRow.nextText), JSON.stringify(soloRow));

      // Switch to the Cold segment — neither client has any comms in the fixture, so both qualify.
      await page.click('#client-segment [data-seg="cold"]');
      await wait(page, 700);
      const multiCold = await clientRow(page, multiId);
      ok("A2e · in the Cold segment the row shows the RICHER .client-lastcontact line",
        multiCold && multiCold.lastContactText != null, JSON.stringify(multiCold));
      eq("A2f · …and NOT the muted .client-lc-age — never both on the same row", multiCold && multiCold.lcAgeText, null);
      ok("A2g · the property badge is unaffected by which segment is active", multiCold && multiCold.propBadgeText === "2 properties", JSON.stringify(multiCold));

      ok("A2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       A3 · PROTECTION SEARCH — #prot-search composes with scope/filter, KPIs follow
       ======================================================================= */
    {
      console.log("\n— A3 · #prot-search narrows the table + KPI tiles, empty state names the term, composes with the status filter (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);

      const uniq = "Zqxvthirtysix" + Date.now();
      const target = await insertClient(page, { first_name: uniq, last_name: "ProtSearch", email: `r36a3.${Date.now()}@example.com`, phone: "07700900000" });
      await insertCase(page, { client_id: target, case_kind: "remortgage", stage: "application", assigned_to: "p2", protection_status: "quoted" });

      await goto(page, "protection", 900);
      await page.click("#prot-scope-all");
      await wait(page, 600);

      const kpiCount = (p) => p.$eval("#prot-kpi-count", (e) => Number(e.textContent) || 0);
      const rowCount = (p) => p.$$eval("#prot-list-table .prot-client", (els) => els.length);

      const countBefore = await kpiCount(page);
      const rowsBefore = await rowCount(page);
      ok("fixture · the unfiltered \"all\" scope shows more than just our one seeded row", rowsBefore > 1 && countBefore === rowsBefore, JSON.stringify({ countBefore, rowsBefore }));

      await page.fill("#prot-search", uniq);
      await wait(page, 450);
      const rowsAfter = await rowCount(page);
      const namesAfter = await page.$$eval("#prot-list-table .prot-client", (els) => els.map((e) => e.textContent));
      eq("A3a · typing the unique name narrows the table to exactly that one row", rowsAfter, 1);
      ok("A3b · …and it is the right row", namesAfter.every((n) => n.includes(uniq)), JSON.stringify(namesAfter));
      const countAfter = await kpiCount(page);
      eq("A3c · the KPI tile follows the search (Opportunities == rows shown)", countAfter, 1);

      await page.fill("#prot-search", "");
      await wait(page, 450);
      const rowsCleared = await rowCount(page);
      eq("A3d · clearing the search restores the full unfiltered count", rowsCleared, rowsBefore);

      const nonsense = "zzzz-nobody-r36-" + Date.now();
      await page.fill("#prot-search", nonsense);
      await wait(page, 450);
      const emptyMsg = await page.$eval("#prot-table .empty", (e) => e.textContent).catch(() => "");
      ok("A3e · a nonsense term empties the table and NAMES the term in the empty state", emptyMsg.includes(nonsense), emptyMsg);

      // Composes with the status filter: search for our client while the drop-down is on "quoted"
      // (matches) and then re-set it to "completed" (our seeded case is live, so it should vanish).
      await page.fill("#prot-search", uniq);
      await page.selectOption("#prot-filter", "quoted");
      await wait(page, 450);
      eq("A3f · search ∩ \"Quoted\" filter still finds the row (it IS quoted)", await rowCount(page), 1);
      await page.selectOption("#prot-filter", "completed");
      await wait(page, 450);
      eq("A3g · search ∩ \"Completed\" filter finds nothing (the row is live, not completed)", await rowCount(page), 0);

      ok("A3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B1 · COMBOBOX — filtering, Enter selects, dependent effect fires
       ======================================================================= */
    {
      console.log("\n— B1 · #case-client-select becomes a searchable combobox; Enter writes the select + fires a real change (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const uniqFirst = "Zqxbcombo" + Date.now();
      const clId = await insertClient(page, { first_name: uniqFirst, last_name: "PickMe", email: `r36b1.${Date.now()}@example.com`, phone: "07700900000" });

      await openNewCase(page);
      const native = await page.evaluate(() => {
        const s = document.querySelector("#case-client-select");
        const inp = document.querySelector("#case-client-select-combo");
        return { hasCombo: !!inp, nativeStillInDom: !!s, nativeHidden: s ? getComputedStyle(s).display === "none" : null, nativeIsCombo: s ? s.classList.contains("combo-native") : null };
      });
      ok("B1a · .combo-input exists for the client picker, and the native select stays in the DOM (hidden)",
        native.hasCombo && native.nativeStillInDom && native.nativeHidden && native.nativeIsCombo, JSON.stringify(native));

      // Type a FIRST name — the one thing a native "Last, First" select's own type-ahead cannot find.
      await page.click("#case-client-select-combo");
      await page.type("#case-client-select-combo", uniqFirst.slice(0, 8));
      await wait(page, 200);
      const filtered = await page.evaluate(() => [...document.querySelectorAll("#case-client-select-combo-list .combo-opt:not(.combo-pin)")].map((e) => e.textContent));
      ok("B1b · the filtered list contains our client, found by a FIRST-name fragment", filtered.some((t) => t.includes(uniqFirst)), JSON.stringify(filtered));

      await page.keyboard.press("Enter");
      await wait(page, 300);
      const picked = await page.evaluate(() => document.querySelector("#case-client-select").value);
      eq("B1c · Enter writes the underlying select's value", picked, clId);
      const inputText = await page.evaluate(() => document.querySelector("#case-client-select-combo").value);
      ok("B1d · …and the visible input shows the client's name", inputText.includes(uniqFirst) || inputText.includes("PickMe"), inputText);

      // Dependent effect — a REAL change event fired: syncReferrerOptions() hides this client from
      // the referrer picker so nobody can refer themselves.
      const referrerHidden = await page.evaluate((id) => {
        const o = [...document.querySelectorAll("#case-referrer-select option")].find((x) => x.value === id);
        return o ? o.hidden : null;
      }, clId);
      eq("B1e · picking the client via the combobox fires a real change — the referrer list hides them", referrerHidden, true);

      ok("B1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B2 · COMBOBOX — "+ New client…" pinned even on no match, reveals the inline fields
       ======================================================================= */
    {
      console.log("\n— B2 · __new__ stays pinned however nonsense the search, and picking it reveals #nc-new-client-fields (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      await openNewCase(page);
      await page.click("#case-client-select-combo");
      await page.type("#case-client-select-combo", "zzzz-no-such-client-r36-" + Date.now());
      await wait(page, 200);
      const pinnedTexts = await page.evaluate(() => [...document.querySelectorAll("#case-client-select-combo-list .combo-opt.combo-pin")].map((e) => e.textContent.trim()));
      ok("B2a · \"+ New client…\" is still offered on a search with zero real matches", pinnedTexts.some((t) => t.includes("New client")), JSON.stringify(pinnedTexts));

      const beforePick = await page.evaluate(() => document.querySelector("#nc-new-client-fields").classList.contains("hidden"));
      eq("fixture · the inline new-client fields start hidden", beforePick, true);

      const clicked = await page.evaluate(() => {
        const list = document.querySelector("#case-client-select-combo-list");
        const el = [...list.querySelectorAll(".combo-opt")].find((x) => x.textContent.includes("New client"));
        if (!el) return false;
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return true;
      });
      ok("B2b · the pinned \"+ New client…\" row was found and picked", clicked);
      await wait(page, 300);
      const afterPick = await page.evaluate(() => ({
        val: document.querySelector("#case-client-select").value,
        fieldsHidden: document.querySelector("#nc-new-client-fields").classList.contains("hidden"),
      }));
      eq("B2c · picking it writes __new__ onto the underlying select", afterPick.val, "__new__");
      eq("B2d · …and reveals #nc-new-client-fields", afterPick.fieldsHidden, false);

      ok("B2 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B3 · COMBOBOX — Escape closes the list only; the modal stays open
       ======================================================================= */
    {
      console.log("\n— B3 · Escape on an open combo list closes the LIST, not the modal (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      await openNewCase(page);
      await page.click("#case-client-select-combo");
      await page.type("#case-client-select-combo", "abc");
      await wait(page, 200);
      const openBefore = await page.evaluate(() => !document.querySelector("#case-client-select-combo-list").classList.contains("hidden"));
      ok("fixture · the list is open before Escape", openBefore);

      await page.keyboard.press("Escape");
      await wait(page, 250);
      const state = await page.evaluate(() => ({
        listHidden: document.querySelector("#case-client-select-combo-list").classList.contains("hidden"),
        modalOpen: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
      }));
      eq("B3a · Escape closes the combo list", state.listHidden, true);
      eq("B3b · …and the modal is still open — Escape did not bubble to close it", state.modalOpen, true);

      ok("B3 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B4 · APPOINTMENT PICKER — choosing a client reveals #appt-case-wrap
       ======================================================================= */
    {
      console.log("\n— B4 · #appt-client is a combobox too; choosing a client reveals #appt-case-wrap (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const uniqFirst = "Zqxvappt" + Date.now();
      const clId = await mkClientCase(page, { first: uniqFirst, last: "ApptPick", case: { case_kind: "purchase", stage: "application", assigned_to: "p2", property_address: "5 R36B4 Appt Street, Bournemouth BH5 5EE" } });

      await page.evaluate(() => window.openAppt(null));
      await wait(page, 700);
      const wrapBefore = await page.evaluate(() => document.querySelector("#appt-case-wrap").classList.contains("hidden"));
      eq("fixture · #appt-case-wrap starts hidden on a blank appointment", wrapBefore, true);

      const hasCombo = await page.evaluate(() => !!document.querySelector("#appt-client-combo"));
      ok("B4a · #appt-client is upgraded to a combobox", hasCombo);

      await page.click("#appt-client-combo");
      await page.type("#appt-client-combo", uniqFirst.slice(0, 8));
      await wait(page, 200);
      await page.keyboard.press("Enter");
      await wait(page, 400);

      const after = await page.evaluate((id) => ({
        val: document.querySelector("#appt-client").value,
        wrapHidden: document.querySelector("#appt-case-wrap").classList.contains("hidden"),
      }), clId.clId);
      eq("B4b · picking the client via the combobox writes the select", after.val, clId.clId);
      eq("B4c · …and reveals #appt-case-wrap", after.wrapHidden, false);

      ok("B4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B5 · NEW-CASE FORM SHAPE — .case-core-grid vs the accordion, defaults still write
       ======================================================================= */
    {
      console.log("\n— B5 · new case: .case-core-grid holds the core five, the accordion holds the rest, unopened accordion still writes defaults (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const uniq = "Zqxvcore" + Date.now();
      const clId = await insertClient(page, { first_name: uniq, last_name: "CoreGrid", email: `r36b5.${Date.now()}@example.com`, phone: "07700900000" });

      await openNewCase(page);
      const shape = await page.evaluate(() => {
        const core = document.querySelector("#modal .case-core-grid");
        const details = document.querySelector("#modal .case-details");
        const inCore = (sel) => !!(core && core.querySelector(sel));
        const inDetails = (sel) => !!(details && details.querySelector(sel));
        return {
          coreExists: !!core, detailsExists: !!details, detailsOpen: details ? details.open : null,
          coreHasClient: inCore("#case-client-select"), coreHasProp: inCore('[name="property_address"]'),
          coreHasKind: inCore('[name="case_kind"]'), coreHasStage: inCore('[name="stage"]'), coreHasAssignee: inCore('[name="assigned_to"]'),
          coreHasLender: inCore('[name="lender"]'),
          detailsHasLender: inDetails('[name="lender"]'), detailsHasLoan: inDetails('[name="loan_amount"]'),
          detailsHasClient: inDetails("#case-client-select"),
        };
      });
      ok("B5a · .case-core-grid exists, collapsed", shape.coreExists);
      ok("B5b · …and holds client, property, kind, stage, assigned-to", shape.coreHasClient && shape.coreHasProp && shape.coreHasKind && shape.coreHasStage && shape.coreHasAssignee, JSON.stringify(shape));
      ok("B5c · …but NOT lender — that belongs to the rest of the form", !shape.coreHasLender, JSON.stringify(shape));
      eq("B5d · details.case-details is present and closed on a new case", { exists: shape.detailsExists, open: shape.detailsOpen }, { exists: true, open: false });
      ok("B5e · the accordion holds lender / loan_amount — the other ~39 fields", shape.detailsHasLender && shape.detailsHasLoan, JSON.stringify(shape));
      ok("B5f · the client select is NOT duplicated inside the accordion", !shape.detailsHasClient, JSON.stringify(shape));

      // Fill only the core fields, via the combobox for the client, and Save WITHOUT ever opening
      // the accordion — the case must still write its markup's defaults for the rest-fields.
      await page.click("#case-client-select-combo");
      await page.type("#case-client-select-combo", uniq.slice(0, 8));
      await wait(page, 200);
      await page.keyboard.press("Enter");
      await wait(page, 200);
      await page.selectOption('#case-form [name="case_kind"]', "remortgage");
      await page.selectOption('#case-form [name="stage"]', "application");
      const accordionOpen = await page.evaluate(() => document.querySelector("#modal .case-details").open);
      eq("fixture · the accordion was never opened before Save", accordionOpen, false);
      await page.click("#modal-save");
      await wait(page, 900);

      const saved = await page.evaluate(async (cid) => {
        const { data } = await window.__mockDb.from("cases").select("*").eq("client_id", cid).order("created_at", { ascending: false }).limit(1);
        return data[0];
      }, clId);
      ok("B5g · the new case was written", !!saved && saved.case_kind === "remortgage" && saved.stage === "application", JSON.stringify(saved));
      eq("B5h · a REST field never touched (protection_status) still wrote its markup default", saved.protection_status, "not_discussed");
      eq("B5i · gi_status too", saved.gi_status, "not_discussed");

      ok("B5 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B6 · EDIT-CASE FORM SHAPE — byte-identical: no .case-core-grid, everything in the accordion
       ======================================================================= */
    {
      console.log("\n— B6 · editing an EXISTING case: NO .case-core-grid — every field, including client, is in the accordion (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const seed = await mkClientCase(page, { first: "R36B6", last: "Edit", case: { case_kind: "purchase", stage: "enquiry", assigned_to: "p2" } });
      await openExistingCase(page, seed.caseId);
      const shape = await page.evaluate(() => {
        const core = document.querySelector("#modal .case-core-grid");
        const details = document.querySelector("#modal .case-details");
        return {
          coreExists: !!core,
          detailsExists: !!details,
          clientInDetails: !!(details && details.querySelector("#case-client-select")),
          kindInDetails: !!(details && details.querySelector('[name="case_kind"]')),
          oneForm: document.querySelectorAll("#modal form#case-form").length,
        };
      });
      eq("B6a · .case-core-grid is ABSENT on the edit form", shape.coreExists, false);
      ok("B6b · the client select and case-kind select both live inside the (one) accordion, as before", shape.detailsExists && shape.clientInDetails && shape.kindInDetails, JSON.stringify(shape));
      eq("B6c · still exactly one <form id=\"case-form\">", shape.oneForm, 1);

      ok("B6 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C · BULK-TASK CASE-RESOLUTION OVERLAY
       ======================================================================= */
    {
      console.log("\n— C · bulk \"＋ Add task…\": the picker overlay for multi-case clients only, Continue gating, exact case landing, __skip, cancel, dedupe, unambiguous skip (p1)");
      const page = await newPage(browser, "p1");
      const errBefore = (page.__err || []).length;
      const tag = "R36C" + Date.now();

      // Single-case client — unambiguous.
      const single = await mkClientCase(page, { first: tag, last: "Single", case: { case_kind: "remortgage", stage: "application", assigned_to: "p2", property_address: "20 " + tag + " Single Street, Bournemouth BH1 1AA" } });
      // No-case client.
      const noCaseId = await insertClient(page, { first_name: tag, last_name: "NoCase", email: `${tag}.nocase@example.com`, phone: "07700900000" });
      // Multi-case (many_live) client — two LIVE cases on two different properties.
      const multiClientId = await insertClient(page, { first_name: tag, last_name: "Multi", email: `${tag}.multi@example.com`, phone: "07700900000" });
      const multiCaseA = await insertCase(page, { client_id: multiClientId, case_kind: "remortgage", stage: "application", assigned_to: "p2", lender: "R36LenderA", property_address: "21 " + tag + " Multi Road, Bournemouth BH2 2BB" });
      const multiCaseB = await insertCase(page, { client_id: multiClientId, case_kind: "buy_to_let", stage: "offer", assigned_to: "p3", lender: "R36LenderB", property_address: "22 " + tag + " Multi Avenue, Bournemouth BH3 3CC" });

      const selectClients = async (ids) => {
        await goto(page, "clients", 900);
        for (const id of ids) {
          await page.$$eval("#client-list .client-cb", (cbs, cid) => { const cb = cbs.find((x) => x.dataset.id === cid); if (cb) cb.click(); }, id);
        }
        await wait(page, 350);
      };

      /* ---- C1: unambiguous-only selection never sees the overlay ------------------------------ */
      await selectClients([single.clId, noCaseId]);
      await page.click("#client-bulk-task");
      await wait(page, 500);
      const noOverlay = await page.evaluate(() => !document.querySelector("#btaskc-pick-rows"));
      ok("C1a · single + no-case clients only: the picker overlay never appears", noOverlay);
      const confirmVisible1 = await page.evaluate(() => !!document.querySelector("#btaskc-title"));
      ok("C1b · …the confirm dialog shows straight away", confirmVisible1);
      // close it — this block only tests that the overlay was skipped
      await page.click("#btaskc-cancel");
      await wait(page, 300);
      await page.$$eval("#client-list .client-cb", (cbs) => cbs.forEach((c) => { if (c.checked) c.click(); }));
      await wait(page, 300);

      /* ---- C2/C3: the picker appears for the multi-case client ONLY, gates Continue, and the
              chosen case is exactly where the task lands ------------------------------------- */
      await selectClients([single.clId, multiClientId]);
      await page.click("#client-bulk-task");
      await wait(page, 500);
      const pickRows = await page.evaluate(() => [...document.querySelectorAll("#btaskc-pick-rows .btaskc-pick-row")].map((r) => r.textContent.replace(/\s+/g, " ").trim()));
      eq("C2a · exactly one picker row (for the multi-case client only)", pickRows.length, 1);
      ok("C2b · …and it names that client", pickRows[0].includes(tag) && pickRows[0].includes("Multi"), pickRows[0]);
      const okDisabledAtStart = await page.$eval("#btaskc-pick-ok", (b) => b.disabled);
      eq("C2c · #btaskc-pick-ok starts disabled", okDisabledAtStart, true);

      const caseOptValues = await page.$$eval("#btaskc-pick-rows .bulk-task-case-pick option", (os) => os.map((o) => o.value));
      ok("fixture · both live cases are offered in the picker's select", caseOptValues.includes(multiCaseA) && caseOptValues.includes(multiCaseB), JSON.stringify(caseOptValues));

      await page.selectOption("#btaskc-pick-rows .bulk-task-case-pick", multiCaseA);
      await wait(page, 150);
      const okEnabledAfter = await page.$eval("#btaskc-pick-ok", (b) => b.disabled);
      eq("C2d · choosing a case enables #btaskc-pick-ok", okEnabledAfter, false);
      const leftText = await page.$eval("#btaskc-pick-left", (e) => e.textContent);
      ok("C2e · #btaskc-pick-left counts what will get a task", /will get a task/.test(leftText), leftText);

      await page.click("#btaskc-pick-ok");
      await wait(page, 400);
      const dlgAfterPick = await page.$eval("#overlay-modal", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("C3a · the picker is replaced by the confirm dialog, counting both fileable clients", /Add a task to 2 client/.test(dlgAfterPick), dlgAfterPick.slice(0, 200));

      const TITLE1 = tag + " — book the annual review call";
      await page.fill("#btaskc-title", TITLE1);
      await page.click("#btaskc-ok");
      await wait(page, 700);

      const made1 = await readTasksByTitle(page, TITLE1);
      eq("C3b · exactly 2 tasks were written", made1.length, 2);
      const madeCaseIds = made1.map((t) => t.case_id).sort();
      eq("C3c · one landed on the single-case client's own case, the other on the EXACT case chosen in the picker (not its sibling)",
        madeCaseIds, [single.caseId, multiCaseA].sort());
      ok("C3d · the sibling live case never got a task", made1.every((t) => t.case_id !== multiCaseB), JSON.stringify(made1));

      await page.$$eval("#client-list .client-cb", (cbs) => cbs.forEach((c) => { if (c.checked) c.click(); }));
      await wait(page, 300);

      /* ---- C4: __skip works, and the summary names it — paired with the (unambiguous) single-
              case client so the confirm's Add button has at least one real target to enable it. */
      await selectClients([single.clId, multiClientId]);
      await page.click("#client-bulk-task");
      await wait(page, 500);
      await page.selectOption("#btaskc-pick-rows .bulk-task-case-pick", "__skip");
      await wait(page, 150);
      const leftAfterSkip = await page.$eval("#btaskc-pick-left", (e) => e.textContent);
      ok("C4a · #btaskc-pick-left reflects the skip", /skipped/.test(leftAfterSkip), leftAfterSkip);
      await page.click("#btaskc-pick-ok");
      await wait(page, 400);
      const dlgSkip = await page.$eval("#overlay-modal", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("C4b · the confirm names the client as skipped (several live cases)", /several live cases/i.test(dlgSkip), dlgSkip.slice(0, 400));
      ok("C4b2 · …and counts the OTHER (unambiguous) client as a real target", /Add a task to 1 client/.test(dlgSkip), dlgSkip.slice(0, 200));
      const TITLE2 = tag + " — skip flow";
      await page.fill("#btaskc-title", TITLE2);
      await page.click("#btaskc-ok");
      await wait(page, 700);
      const made2 = await readTasksByTitle(page, TITLE2);
      eq("C4c · the task landed only on the unambiguous client's own case", made2.map((t) => t.case_id), [single.caseId]);
      const t2 = await toastText(page);
      ok("C4d · the toast names the skip", /skipped/.test(t2), t2);

      await page.$$eval("#client-list .client-cb", (cbs) => cbs.forEach((c) => { if (c.checked) c.click(); }));
      await wait(page, 300);

      /* ---- C5: cancel / Escape writes NOTHING, for the whole batch -------------------------- */
      const beforeCancelCount = (await readTasksByTitle(page, tag + " — never written")).length;
      await selectClients([single.clId, multiClientId]);
      await page.click("#client-bulk-task");
      await wait(page, 500);
      ok("fixture · the picker is up before cancelling", await page.evaluate(() => !!document.querySelector("#btaskc-pick-rows")));
      await page.click("#btaskc-pick-cancel");
      await wait(page, 400);
      const overlayGoneAfterCancel = await page.evaluate(() => document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      ok("C5a · Cancel closes the WHOLE flow — no confirm dialog follows", overlayGoneAfterCancel);
      const madeCancel = await readTasksByTitle(page, tag + " — never written");
      eq("C5b · nothing was written by Cancel", madeCancel.length, beforeCancelCount);

      await page.$$eval("#client-list .client-cb", (cbs) => cbs.forEach((c) => { if (c.checked) c.click(); }));
      await wait(page, 300);
      await selectClients([multiClientId]);
      await page.click("#client-bulk-task");
      await wait(page, 500);
      await page.keyboard.press("Escape");
      await wait(page, 400);
      const overlayGoneAfterEsc = await page.evaluate(() => document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      ok("C5c · Escape also aborts the whole batch", overlayGoneAfterEsc);

      await page.$$eval("#client-list .client-cb", (cbs) => cbs.forEach((c) => { if (c.checked) c.click(); }));
      await wait(page, 300);

      /* ---- C6: re-run the SAME title → 0 new, "already had that task open" ------------------ */
      await selectClients([single.clId]);
      await page.click("#client-bulk-task");
      await wait(page, 500);
      const beforeRerun = (await readTasksByTitle(page, TITLE1)).length;
      await page.fill("#btaskc-title", TITLE1); // TITLE1 is already open on single.caseId from C3
      await page.click("#btaskc-ok");
      await wait(page, 700);
      const afterRerun = await readTasksByTitle(page, TITLE1);
      eq("C6a · pressing the same title again writes NO new task", afterRerun.length, beforeRerun);
      const t6 = await toastText(page);
      ok("C6b · the toast says it already had that task open", /already had that task open/.test(t6), t6);

      ok("C · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r36: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
