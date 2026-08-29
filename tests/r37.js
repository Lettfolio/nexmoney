#!/usr/bin/env node
/* =============================================================================
   tests/r37.js — acceptance tests for ROUND 37: 12 polish items off the R32
   panel, plus one CTO follow-up (the board duplicate hint's email widening).

   What R37 shipped (see admin/app.js, admin/index.html, admin/admin.css):

    1. K2   — `openCase(id, {scrollTo:"docs"})`: Data health's "Waiting on
              documents" row Open button opens the case AND scrolls/expands
              onto `#modal #case-docs` (the details variant is opened first
              at completed/not_proceeding). `openCase(id)` with no second
              argument is unchanged.
    2. P-settings — Settings jump-nav: `#settings-jump` (built hidden) +
              `#settings-jump-chips` with `#settings-nav-<key>` chips, read
              off the RENDERED page (never declared), so a role only ever
              sees a chip for a section it actually has. New anchors
              `#set-sec-*` + `#introducers-panel`. Clicking a chip scrolls to
              its section and opens every `<details>` the target sits
              inside first.
    3. P1-corrected — funnel scope labels: `#report-mi-funnel-panel`'s sub
              now says "Everything LIVE right now, by stage" (+ a cross-ref
              to the month-cohort funnel); `#report-funnel-scope` (now
              innerHTML) says "Cases CREATED in <month>…", with a cross-ref
              back to Pipeline MI ONLY for admin/owner (Pipeline MI is
              isAdminOrOwner-gated, so an adviser is never pointed at a
              section they cannot see).
    4. L7   — starter saved views: when `localStorage.nx_views_v1` is ABSENT
              and ME is known, seedStarterViews() writes 2 pipeline views
              ("My live cases"/"Live cases — everyone", segment "current";
              "Unassigned leads", adviser "unassigned", segment "new") + 1
              clients view ("My cold clients (Nmo+)"/"Cold clients (Nmo+)",
              segment "cold") — role-appropriate names/adviser pinning. The
              seeded set is WRITTEN, so a delete sticks; a corrupt-but-PRESENT
              key is left alone (no seeding).
    5. W9   — board duplicate hint `.card-dupe-hint` ("dupe?", amber): flags
              a card whose client shares a normalised EMAIL or an exact
              sorted-tokens NAME key with another client_id on the board's
              FULL read (not the filtered/searched one). The board's clients
              embed widened to carry `email` for this (the CTO follow-up —
              see the R37 non-masking repair to tests/r24.js).
    6. W10  — protection commission capture is now an overlay, not prompt():
              `#prot-comm-box` / `-input` / `-err` / `-save` / `-skip` /
              `-cancel`, prefilled from the case's existing commission or
              settings.protection_avg_commission. Save writes the figure;
              Skip writes the status with the commission column OMITTED
              (an existing figure survives); Cancel/Escape write nothing;
              invalid input shows `#prot-comm-err` and the overlay stays (no
              re-nag / no lost attempt). Consumers: setProtStatus and
              bulkSetProtStatus (see the R37 non-masking repair to
              tests/r5_batch5.js §S3c).
    7. W11  — appointment title quick-picks: `#appt-title-chips` with
              `.appt-title-chip[data-appt-title]` (5 titles) fill `#appt-title`
              (still free text, `name="title"` unchanged) and dispatch a real
              `input` event.
    8. K4   — vault rows: `.vault-user` — a muted, monospace, NEVER-secret
              login token in `.vault-card-title`, lifted from a field the
              entry itself marked non-secret. The 3 "Test Bank A" rows show
              daniel.p / luke.r / wayne.k.
    9. K5   — Data health's stuck-emails banner reduced to a one-line
              pointer: `#dh-stuck-notice` + `#dh-stuck-link` → nav('emails').
              Today's banner and the Emails page keep the full sentence.
   10. L10  — rate-end sort tail: `.client-rateend-more` "(+N more)" inside
              `.client-rateend`, now rendered in the plain "Next rate end"
              SORT view too (previously only inside a "Rate ends YYYY"
              segment), reusing clientNextRateEnd's own count.
   11. P3   — admin sees the per-adviser targets section READ-ONLY:
              `#adviser-targets-section` renders for admin too, every
              `.adv-target-input` disabled, `#adviser-targets-readonly` lock
              note present, NO `#adviser-targets-save`. Owner unchanged
              (editable + Save). Adviser still gets no section at all — see
              the R37 non-masking note on tests/r26.js §F, which already
              covers that half of this and needed no edit.
   12. item 22 — `#report-money-note` (ADMIN ONLY) now names the owner-only
              money panels explicitly, so an admin's Reports page reads as
              "stops on purpose" rather than "failed to load". Owner sees no
              note (unchanged); adviser sees the base note with no admin
              sentence appended (unchanged).

   §1  doc deep-link (K2)             §7  appointment title chips (W11)
   §2  settings jump nav (P-settings) §8  vault login token (K4)
   §3  funnel scope labels (P1)       §9  DH stuck banner (K5)
   §4  starter saved views (L7)       §10 rate-end sort tail (L10)
   §5  board duplicate hint (W9)      §11 admin read-only targets (P3)
   §6  protection commission overlay  §12 admin money note (item 22)
       (W10)
   §13 no NEW console errors anywhere above

   EVERY figure this file asserts is either read straight back off the mock
   db, computed by the test's own construction, or read live off app.js's own
   module state (settings.protection_avg_commission, CLIENT_SEG_CONTACT_MONTHS)
   — never a number this file invented independently of the fixture/app it is
   testing against — the standing "compute test expectations independently"
   rule, applied the same way tests/r24.js/r36.js already do.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r37.js
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

/* Every R37-relevant (and R31/R34-relevant) localStorage key, cleared the same defensive way
   every suite in this harness clears them — see the standing rule in HARNESS.md. Each newPage()
   call is already a fresh, isolated browser context (so these keys are absent by construction),
   but a test that explicitly sets one of them mid-block clears it again before moving on. */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser"/* R64 · M9 — the Clients adviser filter persists now */, "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads",
  "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — same independent-of-fixture technique
   tests/r36.js/r35.js/r34.js/r31.js already use.
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
    first_name: o.first || "R37", last_name: o.last || ("Case" + Math.random().toString(36).slice(2, 8)),
    email: o.email !== undefined ? o.email : `r37.${Math.random().toString(36).slice(2, 9)}@example.com`, phone: "07700900000",
  });
  const row = Object.assign({ client_id: clId, case_kind: "remortgage", stage: "application", assigned_to: "p2" }, o.case || {});
  const caseId = await insertCase(page, row);
  return { clId, caseId };
}
const readCase = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", id).single();
  return data;
}, caseId);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       §1 · K2 — DOC DEEP-LINK: the Data health "Waiting on documents" row's
           Open button opens the case scrolled onto its Documents checklist
       ======================================================================= */
    {
      console.log("\n— §1a · DH waiting-docs row Open button → modal opens with #case-docs in view (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const seed = await mkClientCase(page, {
        first: "R37S1", last: "DocsDeep" + Date.now(), email: `r37s1.${Date.now()}@example.com`,
        case: { case_kind: "remortgage", stage: "application", assigned_to: "p2" },
      });
      await page.evaluate(async (caseId) => {
        const now = new Date().toISOString();
        await window.__mockDb.from("case_documents").insert([
          { case_id: caseId, item: "R37 Bank statements", status: "requested", requested_at: now },
        ]);
      }, seed.caseId);

      await goto(page, "data", 1400);
      const rowSel = `tr[data-case="${seed.caseId}"]`;
      await page.waitForSelector(rowSel, { timeout: 5000 }).catch(() => {});
      const rowPresent = await page.$(rowSel);
      ok("fixture · the seeded case appears in the Waiting on documents table", !!rowPresent);

      const modalClosedBefore = await page.evaluate(() => document.querySelector("#modal-backdrop").classList.contains("hidden"));
      ok("fixture · no modal is open yet", modalClosedBefore);

      await page.click(`${rowSel} .dh-wd-acts button`);
      await wait(page, 1200);

      const after = await page.evaluate(() => {
        const docs = document.querySelector("#modal #case-docs");
        const backdrop = document.querySelector("#modal-backdrop");
        return {
          modalOpen: backdrop ? !backdrop.classList.contains("hidden") : false,
          docsTag: docs ? docs.tagName : null,
          docsTop: docs ? docs.getBoundingClientRect().top : null,
        };
      });
      ok("§1a · the case modal opened", after.modalOpen, JSON.stringify(after));
      ok("§1a · this case is live, so #case-docs is the full (non-<details>) variant", after.docsTag === "DIV", after.docsTag);
      ok("§1a · #case-docs has been scrolled into view (near the top of the viewport)", after.docsTop != null && after.docsTop < 400, JSON.stringify(after));

      ok("§1 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §1b · openCase(id) with NO opts is unchanged (does not force-scroll); openCase(id,{scrollTo:'docs'}) on a completed case opens the DETAILS variant (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const plain = await mkClientCase(page, { first: "R37S1", last: "Plain" + Date.now(), case: { stage: "application", assigned_to: "p2" } });
      await page.evaluate((id) => window.openCase(id), plain.caseId);
      await wait(page, 900);
      const plainState = await page.evaluate(() => {
        const docs = document.querySelector("#modal #case-docs");
        return { docsTop: docs ? docs.getBoundingClientRect().top : null };
      });
      ok("§1b · a plain openCase(id) (no opts) opens at the top — #case-docs is NOT forced into view near the top",
        plainState.docsTop != null && plainState.docsTop > 400, JSON.stringify(plainState));
      await page.evaluate(() => window.closeModal && window.closeModal());
      await wait(page, 300);

      const done = await mkClientCase(page, { first: "R37S1", last: "Completed" + Date.now(), case: { stage: "completed", assigned_to: "p2", completed_at: new Date().toISOString() } });
      await page.evaluate((id) => window.openCase(id, { scrollTo: "docs" }), done.caseId);
      await wait(page, 1200);
      const doneState = await page.evaluate(() => {
        const docs = document.querySelector("#modal #case-docs");
        return { tag: docs ? docs.tagName : null, open: docs ? docs.open : null, top: docs ? docs.getBoundingClientRect().top : null };
      });
      ok("§1b · a completed case's #case-docs is the compact <details> variant", doneState.tag === "DETAILS", JSON.stringify(doneState));
      ok("§1b · …and openCase(id,{scrollTo:'docs'}) opens it (details.open === true)", doneState.open === true, JSON.stringify(doneState));
      ok("§1b · …and scrolls it into view", doneState.top != null && doneState.top < 400, JSON.stringify(doneState));

      ok("§1b · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §2 · P-settings — SETTINGS JUMP NAV: role-aware chip count, scroll,
           and opening a <details>-wrapped target
       ======================================================================= */
    {
      console.log("\n— §2 · Settings jump nav: owner 14 > admin 12 > adviser 9 chips, correct sets (p4/p1/p2)");
      const readChips = async (page) => page.evaluate(() => {
        const bar = document.querySelector("#settings-jump");
        return {
          barHidden: bar ? bar.hidden : null,
          keys: [...document.querySelectorAll("#settings-jump-chips [data-settings-jump]")].map((b) => b.dataset.settingsJump),
          idsMatch: [...document.querySelectorAll("#settings-jump-chips [data-settings-jump]")].every((b) => b.id === `settings-nav-${b.dataset.settingsJump}`),
        };
      });

      const owner = await newPage(browser, "p4");
      const errOwner = (owner.__err || []).length;
      await goto(owner, "settings", 1500);
      const ownerChips = await readChips(owner);
      ok("§2a · owner: the jump bar is visible", ownerChips.barHidden === false, JSON.stringify(ownerChips));
      ok("§2a · owner: every chip id is settings-nav-<key>", ownerChips.idsMatch, JSON.stringify(ownerChips));
      eq("§2a · owner sees all 14 sections", ownerChips.keys.slice().sort(),
        ["advanced", "comms", "diag", "digest", "documents", "export", "history", "introducers", "mydetails", "outlook", "protection", "sms", "targets", "team"].slice().sort());

      const admin = await newPage(browser, "p1");
      const errAdmin = (admin.__err || []).length;
      await goto(admin, "settings", 1500);
      const adminChips = await readChips(admin);
      eq("§2b · admin: 12 sections — export and history (both Owner-only) are the only two missing",
        adminChips.keys.slice().sort(),
        ["advanced", "comms", "diag", "digest", "documents", "introducers", "mydetails", "outlook", "protection", "sms", "targets", "team"].slice().sort());

      const adv = await newPage(browser, "p2");
      const errAdv = (adv.__err || []).length;
      await goto(adv, "settings", 1500);
      const advChips = await readChips(adv);
      eq("§2c · adviser: 9 sections — export/history/team/diag/targets are all gone too",
        advChips.keys.slice().sort(),
        ["advanced", "comms", "digest", "documents", "introducers", "mydetails", "outlook", "protection", "sms"].slice().sort());

      ok("§2d · owner > admin > adviser, strictly", ownerChips.keys.length > adminChips.keys.length && adminChips.keys.length > advChips.keys.length,
        JSON.stringify({ owner: ownerChips.keys.length, admin: adminChips.keys.length, adviser: advChips.keys.length }));

      /* Clicking a plain (non-<details>) chip scrolls its section into view. */
      const scrollRes = await owner.evaluate(async () => {
        const before = document.querySelector("#set-sec-documents").getBoundingClientRect().top;
        document.getElementById("settings-nav-documents").click();
        await new Promise((r) => setTimeout(r, 1200));
        const after = document.querySelector("#set-sec-documents").getBoundingClientRect().top;
        const active = [...document.querySelectorAll("#settings-jump-chips .seg-btn.active")].map((b) => b.id);
        return { before, after, active };
      });
      ok("§2e · clicking a chip scrolls its target near the top of the viewport", scrollRes.after < 250, JSON.stringify(scrollRes));
      eq("§2f · the clicked chip becomes the sole active one", scrollRes.active, ["settings-nav-documents"]);

      /* Clicking a chip whose target lives inside a collapsed <details> opens that details first. */
      const beforeOpen = await owner.evaluate(() => document.getElementById("set-sec-advanced").open);
      eq("fixture · the Advanced accordion starts collapsed", beforeOpen, false);
      const detailsRes = await owner.evaluate(async () => {
        document.getElementById("settings-nav-outlook").click();
        await new Promise((r) => setTimeout(r, 1200));
        const det = document.getElementById("set-sec-advanced");
        const target = document.getElementById("set-sec-outlook");
        return { open: det.open, top: target.getBoundingClientRect().top };
      });
      ok("§2g · a chip for a <details>-wrapped section opens that details", detailsRes.open === true, JSON.stringify(detailsRes));
      ok("§2h · …and still scrolls the (now-visible) target into view", detailsRes.top < 250, JSON.stringify(detailsRes));

      ok("§2 · no console errors (owner)", noNewErr(owner, errOwner), JSON.stringify(owner.__err));
      ok("§2 · no console errors (admin)", noNewErr(admin, errAdmin), JSON.stringify(admin.__err));
      ok("§2 · no console errors (adviser)", noNewErr(adv, errAdv), JSON.stringify(adv.__err));
      await owner.close(); await admin.close(); await adv.close();
    }

    /* =======================================================================
       §3 · P1-corrected — FUNNEL SCOPE LABELS
       ======================================================================= */
    {
      console.log("\n— §3 · Pipeline MI's funnel sub says LIVE right now; #report-funnel-scope says CREATED in <month>, cross-ref admin/owner only (p4/p2)");
      const owner = await newPage(browser, "p4");
      const errOwner = (owner.__err || []).length;
      await goto(owner, "reports", 1500);
      const ownerText = await owner.evaluate(() => ({
        miSub: document.querySelector("#report-mi-funnel-panel .panel-sub") ? document.querySelector("#report-mi-funnel-panel .panel-sub").textContent : null,
        scope: document.querySelector("#report-funnel-scope") ? document.querySelector("#report-funnel-scope").innerHTML : null,
      }));
      ok("§3a · owner: the MI funnel panel's sub says the LIVE-right-now scope", ownerText.miSub && /LIVE right now/.test(ownerText.miSub), ownerText.miSub);
      ok("§3b · owner: #report-funnel-scope says cases CREATED in <month>", ownerText.scope && /Cases CREATED in/.test(ownerText.scope), ownerText.scope);
      ok("§3c · owner: …and cross-refs Pipeline MI (owner can see it)", ownerText.scope && /Pipeline MI/.test(ownerText.scope), ownerText.scope);

      const adv = await newPage(browser, "p2");
      const errAdv = (adv.__err || []).length;
      await goto(adv, "reports", 1500);
      const advText = await adv.evaluate(() => ({
        miPanelVisible: (() => { const el = document.querySelector("#report-mi-funnel-panel"); return el ? el.offsetParent !== null : false; })(),
        scope: document.querySelector("#report-funnel-scope") ? document.querySelector("#report-funnel-scope").innerHTML : null,
      }));
      ok("fixture · adviser: Pipeline MI is not visible at all", !advText.miPanelVisible, JSON.stringify(advText));
      ok("§3d · adviser: #report-funnel-scope still says CREATED in <month>", advText.scope && /Cases CREATED in/.test(advText.scope), advText.scope);
      ok("§3e · adviser: …but carries NO cross-reference to Pipeline MI (they cannot see it)", !!advText.scope && !/Pipeline MI/.test(advText.scope), advText.scope);

      ok("§3 · no console errors (owner)", noNewErr(owner, errOwner), JSON.stringify(owner.__err));
      ok("§3 · no console errors (adviser)", noNewErr(adv, errAdv), JSON.stringify(adv.__err));
      await owner.close(); await adv.close();
    }

    /* =======================================================================
       §4 · L7 — STARTER SAVED VIEWS
       ======================================================================= */
    {
      console.log("\n— §4a · owner, fresh (no nx_views_v1 key): starter pipeline + client views seeded, apply + persist-after-delete (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      const months = await page.evaluate(() => clientQuietMonths());   /* R64 · L5 — the starter view's name comes from the `client_quiet_months` SETTING now, not from the constant (which is only its default), so the expectation is read from the same function the label is built from. Same value (6) on the seeded fixture. */

      const keyAbsentAtStart = await page.evaluate(() => localStorage.getItem("nx_views_v1"));
      eq("fixture · nx_views_v1 is genuinely absent on a fresh context", keyAbsentAtStart, null);

      await goto(page, "pipeline", 1400);
      const boardOpts = await page.$$eval("#board-views option", (os) => os.map((o) => o.value));
      ok("§4a · #board-views was seeded with \"Live cases — everyone\"", boardOpts.includes("Live cases — everyone"), JSON.stringify(boardOpts));
      ok("§4a · …and \"Unassigned leads\"", boardOpts.includes("Unassigned leads"), JSON.stringify(boardOpts));

      await goto(page, "clients", 1400);
      const clientOpts = await page.$$eval("#client-views option", (os) => os.map((o) => o.value));
      const coldName = `Cold clients (${months}mo+)`;
      ok("§4a · #client-views was seeded with the owner's cold-clients starter", clientOpts.includes(coldName), JSON.stringify({ clientOpts, coldName }));

      // Applying a seeded pipeline view actually restores its captured filters.
      await goto(page, "pipeline", 1000);
      await page.fill("#board-search", "some unrelated text");
      await page.selectOption("#board-adviser", "all");
      await wait(page, 400);
      await page.selectOption("#board-views", "Unassigned leads");
      await wait(page, 700);
      const restored = await page.evaluate(() => ({ search: document.querySelector("#board-search").value, adviser: document.querySelector("#board-adviser").value }));
      eq("§4b · applying \"Unassigned leads\" restores #board-search to empty", restored.search, "");
      eq("§4b · …and #board-adviser to \"unassigned\"", restored.adviser, "unassigned");

      // Deleting a starter view — it stays deleted, no re-seed.
      // R43 · non-masking repair — the starter store moved to `public.saved_views` (one row per
      // user_id/scope/name); a page.reload() wipes the mock's WHOLE in-memory table (it is
      // page-local JS memory, the same "no sticky store" fact tests/r5_batch1.js's R5-5 already
      // documents for `leads`), which is not "the delete stuck", it is "the delete never happened
      // because nothing survived to check" — a fresh reload lands on an EMPTY table with no local
      // key either, which reseeds all three starters from scratch (Unassigned leads included),
      // exactly the false-negative shape this repair removes. The ORIGINAL claim — a starter,
      // once deleted, is not handed back by a later read in the SAME session — is instead proven
      // by forcing a second, same-session read directly: reset loadSavedViews()'s own re-entry
      // guard (`viewsLoadStarted`, a top-level `let` in app.js — readable/writable by bare
      // identifier from page.evaluate, the same fact tests/r43.js's §7 leans on) and call it
      // again, rather than reloading the page. The table still holds the ONE remaining starter +
      // the `_meta` marker (2 rows, not zero), which is exactly why R43 never re-seeds it.
      /* R74 · B3: deleting a saved view is a destructive verb and asks in the HOUSE overlay now,
         not window.confirm — so stubbing window.confirm no longer answers anything. Answered the
         way a person would, on the dialog's own danger button. */
      await page.click("#board-view-del");
      await wait(page, 400);
      ok("R74 · §4 · the saved-view delete asks in the house overlay", !!(await page.$("#ovl-confirm-ok")));
      await page.click("#ovl-confirm-ok");
      await wait(page, 500);
      const afterDel = await page.$$eval("#board-views option", (os) => os.map((o) => o.value));
      ok("§4c · deleting the applied starter removes it from #board-views", !afterDel.includes("Unassigned leads"), JSON.stringify(afterDel));
      await page.evaluate(async () => { viewsLoadStarted = false; await window.loadSavedViews(); });
      await wait(page, 500);
      const afterReread = await page.$$eval("#board-views option", (os) => os.map((o) => o.value));
      ok("§4d · …and it is STILL gone after a second same-session read — the delete stuck, no re-seed", !afterReread.includes("Unassigned leads"), JSON.stringify(afterReread));
      ok("§4d · …while the OTHER starter (never deleted) is still there", afterReread.includes("Live cases — everyone"), JSON.stringify(afterReread));

      ok("§4 · no console errors (owner)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §4e · adviser, fresh: starter views get the role-appropriate \"My …\" names, pinned to the adviser (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      const months = await page.evaluate(() => clientQuietMonths());   /* R64 · L5 — the starter view's name comes from the `client_quiet_months` SETTING now, not from the constant (which is only its default), so the expectation is read from the same function the label is built from. Same value (6) on the seeded fixture. */

      await goto(page, "pipeline", 1400);
      const boardOpts = await page.$$eval("#board-views option", (os) => os.map((o) => o.value));
      ok("§4e · adviser's pipeline starter reads \"My live cases\" (not \"Live cases — everyone\")",
        boardOpts.includes("My live cases") && !boardOpts.includes("Live cases — everyone"), JSON.stringify(boardOpts));
      ok("§4e · …and still has \"Unassigned leads\" (that one is role-neutral)", boardOpts.includes("Unassigned leads"), JSON.stringify(boardOpts));

      // R43 · non-masking repair — the starter seed on a fresh, un-migrated persona lands in the
      // saved_views TABLE (db mode), not localStorage — the ORIGINAL claim (the pipeline-view
      // starter is pinned to the signed-in adviser's own id) is only provable against the store
      // that seed actually wrote to.
      const rows = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("saved_views").select("scope,name,filters");
        return data || [];
      });
      const mine = rows.find((v) => v.scope === "pipeline" && v.name === "My live cases");
      ok("§4f · …and it is pinned to the signed-in adviser (p2), not \"all\"", mine && mine.filters && mine.filters.adviser === "p2", JSON.stringify(mine));

      await goto(page, "clients", 1200);
      const clientOpts = await page.$$eval("#client-views option", (os) => os.map((o) => o.value));
      eq("§4g · adviser's client starter reads \"My cold clients (Nmo+)\"", clientOpts.includes(`My cold clients (${months}mo+)`), true);

      ok("§4 · no console errors (adviser)", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §4h · a PRESENT-but-empty nx_views_v1 key never gets seeded (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await page.evaluate(() => { try { localStorage.setItem("nx_views_v1", JSON.stringify({ clients: [], pipeline: [] })); } catch (e) { /* ignore */ } });
      await goto(page, "pipeline", 1400);
      const boardOpts = await page.$$eval("#board-views option", (os) => os.map((o) => o.value));
      eq("§4h · #board-views stays at just the placeholder — a present-but-empty key is never re-seeded", boardOpts, [""]);
      const store = await page.evaluate(() => JSON.parse(localStorage.getItem("nx_views_v1") || "null"));
      eq("§4h · …and the store itself is unchanged (still both arrays empty)", store, { clients: [], pipeline: [] });

      ok("§4 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await clearNxKeys(page);
      await page.close();
    }

    /* =======================================================================
       §5 · W9 — BOARD DUPLICATE HINT (`.card-dupe-hint`)
       ======================================================================= */
    {
      console.log("\n— §5 · board-adviser \"all\": a same-email pair (different names) both flag; a same-email SOLO client does not (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const tag = "R37S5" + Date.now();
      const sharedEmail = `${tag}.shared@example.com`;

      // Two DIFFERENT client_ids, deliberately different surnames (so the NAME key does NOT
      // match), sharing one email — exactly the Debbie/Deborah Ashworth shape in the fixture.
      const a = await mkClientCase(page, { first: tag, last: "DupeAlpha", email: sharedEmail, case: { case_kind: "remortgage", stage: "application", assigned_to: "p2" } });
      const b = await mkClientCase(page, { first: tag, last: "DupeBeta", email: sharedEmail, case: { case_kind: "purchase", stage: "enquiry", assigned_to: "p3" } });
      // A solo client with its own unique email — the negative control.
      const solo = await mkClientCase(page, { first: tag, last: "SoloNoHint", email: `${tag}.solo@example.com`, case: { case_kind: "remortgage", stage: "application", assigned_to: "p2" } });

      await goto(page, "pipeline", 1000);
      await page.selectOption("#board-adviser", "all");
      await wait(page, 600);
      await page.fill("#board-search", tag);
      await wait(page, 600);

      const hint = (id) => page.evaluate((cid) => {
        const card = document.querySelector(`.card[data-id="${cid}"]`);
        return card ? !!card.querySelector(".card-dupe-hint") : null;
      }, id);
      ok("§5a · the first same-email client's card carries .card-dupe-hint", await hint(a.caseId));
      ok("§5b · the second same-email client's card carries .card-dupe-hint too", await hint(b.caseId));
      ok("§5c · the solo (unique-email) client's card carries NO .card-dupe-hint", (await hint(solo.caseId)) === false);

      const badgeTitle = await page.evaluate((cid) => {
        const card = document.querySelector(`.card[data-id="${cid}"]`);
        const b2 = card ? card.querySelector(".card-dupe-hint") : null;
        return b2 ? { text: b2.textContent.trim(), title: b2.title } : null;
      }, a.caseId);
      ok("§5d · the hint reads \"dupe?\" and its title names the possible-duplicate check", badgeTitle && badgeTitle.text === "dupe?" && /possible duplicate/i.test(badgeTitle.title), JSON.stringify(badgeTitle));

      ok("§5 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §6 · W10 — PROTECTION COMMISSION OVERLAY (setProtStatus)
       ======================================================================= */
    {
      console.log("\n— §6a · policy_taken opens the overlay prefilled from settings.protection_avg_commission; Save writes the figure (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      const avg = await page.evaluate(() => Number(settings && settings.protection_avg_commission) || 0);

      const seed = await mkClientCase(page, { first: "R37S6", last: "Save" + Date.now(), case: { stage: "application", assigned_to: "p2", protection_status: "quoted" } });
      await page.evaluate((id) => { window.__r37p = window.setProtStatus(id, "policy_taken"); }, seed.caseId);
      await wait(page, 700);
      const overlay = await page.evaluate(() => {
        const box = document.querySelector("#prot-comm-box");
        const input = document.querySelector("#prot-comm-input");
        return box ? { present: true, inputVal: input ? input.value : null } : { present: false };
      });
      ok("§6a · the overlay appears", overlay.present, JSON.stringify(overlay));
      ok("§6a · …prefilled with the firm average (no existing figure on this case)", overlay.present && String(avg) === String(overlay.inputVal), JSON.stringify({ avg, overlay }));

      await page.fill("#prot-comm-input", "1250");
      await page.click("#prot-comm-save");
      await wait(page, 700);
      const c1 = await readCase(page, seed.caseId);
      eq("§6a · Save writes the status", c1.protection_status, "policy_taken");
      eq("§6a · …and the commission typed", c1.protection_commission, 1250);
      const t1 = await toastText(page);
      ok("§6a · the toast confirms the commission recorded", /commission £1,250 recorded/i.test(t1), t1);

      ok("§6a · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §6b · Skip writes the status but OMITS the commission column — an existing figure on the case survives (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const seed = await mkClientCase(page, { first: "R37S6", last: "Skip" + Date.now(), case: { stage: "application", assigned_to: "p2", protection_status: "quoted", protection_commission: 500 } });
      await page.evaluate((id) => { window.__r37p = window.setProtStatus(id, "policy_taken"); }, seed.caseId);
      await wait(page, 700);
      const prefill = await page.$eval("#prot-comm-input", (e) => e.value);
      eq("§6b · the overlay prefills from the case's OWN existing figure, not the firm average", prefill, "500");

      await page.click("#prot-comm-skip");
      await wait(page, 700);
      const c2 = await readCase(page, seed.caseId);
      eq("§6b · Skip still writes the status", c2.protection_status, "policy_taken");
      eq("§6b · …and the existing commission is left exactly as it was", c2.protection_commission, 500);
      const t2 = await toastText(page);
      ok("§6b · the toast says no commission figure was recorded", /no commission figure recorded/i.test(t2), t2);

      ok("§6b · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    {
      console.log("\n— §6c · Cancel writes nothing at all; invalid input shows #prot-comm-err and the overlay stays open (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      const seed = await mkClientCase(page, { first: "R37S6", last: "Cancel" + Date.now(), case: { stage: "application", assigned_to: "p2", protection_status: "quoted" } });
      const before = await readCase(page, seed.caseId);
      await page.evaluate((id) => { window.__r37p = window.setProtStatus(id, "policy_taken"); }, seed.caseId);
      await wait(page, 700);
      await page.click("#prot-comm-cancel");
      await wait(page, 500);
      const afterCancel = await readCase(page, seed.caseId);
      eq("§6c · Cancel leaves protection_status exactly as it was", afterCancel.protection_status, before.protection_status);
      eq("§6c · …and protection_commission untouched", afterCancel.protection_commission, before.protection_commission);
      const overlayGone = await page.evaluate(() => document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      ok("§6c · the overlay itself closed", overlayGone);

      // Escape is the same exit as Cancel.
      await page.evaluate((id) => { window.__r37p = window.setProtStatus(id, "policy_taken"); }, seed.caseId);
      await wait(page, 700);
      await page.keyboard.press("Escape");
      await wait(page, 500);
      const afterEsc = await readCase(page, seed.caseId);
      eq("§6c · Escape also writes nothing", [afterEsc.protection_status, afterEsc.protection_commission], [before.protection_status, before.protection_commission]);

      /* Invalid input. The box is a native type="number" input, so a real browser refuses to let
         "abc" be TYPED into it at all — page.fill's realistic keystrokes hit exactly that wall,
         which is itself a form of validation. The two invalid shapes an operator actually CAN get
         into the field are blank (cleared) and zero/negative (syntactically a number, semantically
         not a commission) — both routes into askProtectionCommission's own fail() branch, and both
         are exercised here. */
      await page.evaluate((id) => { window.__r37p = window.setProtStatus(id, "policy_taken"); }, seed.caseId);
      await wait(page, 700);
      await page.fill("#prot-comm-input", "0");
      await page.click("#prot-comm-save");
      await wait(page, 400);
      const errState = await page.evaluate(() => ({
        overlayStillUp: !document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        errText: document.querySelector("#prot-comm-err") ? document.querySelector("#prot-comm-err").textContent : null,
      }));
      ok("§6d · a zero commission keeps the overlay open (no re-nag loop, no lost attempt)", errState.overlayStillUp, JSON.stringify(errState));
      ok("§6d · …and shows an error next to the box (\"not a number above zero\")", !!errState.errText && /above zero/i.test(errState.errText), JSON.stringify(errState));

      // Blank is the other invalid shape — its own, differently-worded fail message.
      await page.fill("#prot-comm-input", "");
      await page.click("#prot-comm-save");
      await wait(page, 400);
      const blankErrState = await page.evaluate(() => ({
        overlayStillUp: !document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        errText: document.querySelector("#prot-comm-err") ? document.querySelector("#prot-comm-err").textContent : null,
      }));
      ok("§6d · a blank figure ALSO keeps the overlay open", blankErrState.overlayStillUp, JSON.stringify(blankErrState));
      ok("§6d · …with its own \"Enter a figure\" message — no re-nag toast, just the inline error", !!blankErrState.errText && /Enter a figure/i.test(blankErrState.errText), JSON.stringify(blankErrState));

      const afterInvalid = await readCase(page, seed.caseId);
      eq("§6d · nothing was written by the invalid attempt", [afterInvalid.protection_status, afterInvalid.protection_commission], [before.protection_status, before.protection_commission]);
      // Clean up — a genuine Cancel closes it out.
      await page.click("#prot-comm-cancel");
      await wait(page, 300);

      ok("§6c/d · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §7 · W11 — APPOINTMENT TITLE QUICK-PICKS
       ======================================================================= */
    {
      console.log("\n— §7 · #appt-title-chips: clicking a chip fills #appt-title (still editable) and fires input (p2)");
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;

      await page.evaluate(() => window.openAppt(null));
      await wait(page, 700);
      const chips = await page.$$eval(".appt-title-chip", (els) => els.map((e) => e.dataset.apptTitle));
      ok("§7a · five title chips are offered", chips.length === 5, JSON.stringify(chips));
      const before = await page.$eval("#appt-title", (e) => e.value);
      eq("fixture · the title field starts blank on a new appointment", before, "");

      const pick = chips[0];
      await page.click(`.appt-title-chip[data-appt-title="${pick}"]`);
      await wait(page, 300);
      const afterClick = await page.$eval("#appt-title", (e) => e.value);
      eq("§7b · clicking the chip fills #appt-title with its title", afterClick, pick);

      // Still free text: typing over it works exactly as before.
      await page.fill("#appt-title", "Ring Deborah back re: the survey");
      const edited = await page.$eval("#appt-title", (e) => e.value);
      eq("§7c · the field is still freely editable after a chip fill", edited, "Ring Deborah back re: the survey");

      ok("§7 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.evaluate(() => window.closeModal && window.closeModal());
      await page.close();
    }

    /* =======================================================================
       §8 · K4 — VAULT LOGIN TOKEN (.vault-user)
       ======================================================================= */
    {
      console.log("\n— §8 · the three \"Test Bank A\" vault rows show distinct .vault-user tokens; never a secret value (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await goto(page, "vault", 1400);

      const rows = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".vault-card")].filter((c) => {
          const n = c.querySelector(".vault-name");
          return n && n.textContent.trim() === "Test Bank A";
        });
        return cards.map((c) => {
          const u = c.querySelector(".vault-user");
          return { userText: u ? u.textContent.trim() : null };
        });
      });
      eq("§8a · exactly three \"Test Bank A\" rows are on the vault", rows.length, 3);
      const tokens = rows.map((r) => r.userText);
      eq("§8b · every row carries a .vault-user token", tokens.every((t) => !!t), true);
      const distinct = new Set(tokens);
      eq("§8c · all three tokens are distinct — daniel.p / luke.r / wayne.k", distinct.size, 3);
      eq("§8d · …and they are exactly that set", tokens.slice().sort(), ["daniel.p", "luke.r", "wayne.k"]);

      const SECRETS = ["test-pass-1", "test-pass-2", "test-pass-3", "bluecar", "redkite", "greenfern"];
      ok("§8e · no .vault-user token is ever one of the secret field values", tokens.every((t) => !SECRETS.includes(t)), JSON.stringify(tokens));

      ok("§8 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §9 · K5 — DATA HEALTH STUCK-EMAILS BANNER (one line, pointer to Emails)
       ======================================================================= */
    {
      console.log("\n— §9 · #dh-stuck-notice: one-liner + #dh-stuck-link → nav('emails') (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      // Guarantee a stuck row regardless of the fixture's own baseline: a queued email created
      // well over a day ago (get_data_quality's own "stuck" definition — see mock-supabase.js).
      const seed = await mkClientCase(page, { first: "R37S9", last: "Stuck" + Date.now(), case: { stage: "application", assigned_to: "p2" } });
      await page.evaluate(async ({ caseId, clientId }) => {
        const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
        await window.__mockDb.from("email_queue").insert({
          case_id: caseId, client_id: clientId, email_type: "docs_request", to_email: "r37s9@example.com",
          status: "queued", created_at: twoDaysAgo, scheduled_for: twoDaysAgo,
        });
      }, { caseId: seed.caseId, clientId: seed.clId });

      await goto(page, "data", 1500);
      const dq = await page.evaluate(async () => (await window.__mockDb.rpc("get_data_quality")).data);
      ok("fixture · at least one stuck email is now on the queue", dq.emails_stuck > 0, JSON.stringify(dq));

      const notice = await page.evaluate(() => {
        const el = document.querySelector("#dh-stuck-notice");
        const link = document.querySelector("#dh-stuck-link");
        return el ? { text: el.textContent.replace(/\s+/g, " ").trim(), hasLink: !!link } : null;
      });
      ok("§9a · #dh-stuck-notice is present", !!notice, JSON.stringify(notice));
      ok("§9b · it names the exact stuck-email count", notice && notice.text.includes(String(dq.emails_stuck)), JSON.stringify({ notice, dq }));
      /* R74: THE HOLD OUTRANKS THE SENDER (panel D-25). Mail that cannot leave was "queued" on
         Emails, "queued" in Settings and "stuck" here — three words for one deliberate, reversible
         state, and "5 emails stuck" reads as a fault to go and find. While `email_hold` is on the
         verdict is "held" on all four surfaces; "stuck" survives only where it is true, which is a
         queue that is NOT held with a live sender. Three readings now, not two — the assertion is
         wider, not weaker. */
      const holdOn = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("value").eq("key", "email_hold");
        return String((data && data[0] && data[0].value) || "on").toLowerCase() !== "off";
      });
      const expectedVerb = holdOn ? "held" : (dq.emails_sending_live ? "stuck" : "queued, not sent");
      ok("§9c · …and the right one-line verdict for the hold and the sender", notice && notice.text.includes(expectedVerb), JSON.stringify({ notice, dq, holdOn }));
      ok("§9d · #dh-stuck-link is present and reads \"see Emails\"", notice && notice.hasLink, JSON.stringify(notice));
      ok("§9e · it is genuinely ONE line — no second sentence of detail (that now lives on Today/Emails only)",
        notice && notice.text.split(" — ").length <= 2, JSON.stringify(notice));

      await page.click("#dh-stuck-link");
      await wait(page, 900);
      const nowOnEmails = await page.evaluate(() => ({
        pageVisible: !document.querySelector("#page-emails").classList.contains("hidden"),
        current: document.querySelector('#topnav button[data-page="emails"]') ? document.querySelector('#topnav button[data-page="emails"]').getAttribute("aria-current") : null,
      }));
      ok("§9f · clicking #dh-stuck-link navigates to the Emails page", nowOnEmails.pageVisible && nowOnEmails.current === "page", JSON.stringify(nowOnEmails));

      ok("§9 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §10 · L10 — RATE-END SORT TAIL (.client-rateend-more)
       ======================================================================= */
    {
      console.log("\n— §10 · \"Next rate end\" sort: a multi-rate client's row carries \"(+N more)\"; a single-rate client's carries none (p4)");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;
      await clearNxKeys(page);
      const tag = "R37S10" + Date.now();
      const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

      const multiId = await insertClient(page, { first_name: tag, last_name: "MultiRate", email: `${tag}.multi@example.com`, phone: "07700900000" });
      await insertCase(page, { client_id: multiId, case_kind: "remortgage", stage: "application", assigned_to: "p2", rate_end_date: future(60), lender: "R37LenderA" });
      await insertCase(page, { client_id: multiId, case_kind: "buy_to_let", stage: "application", assigned_to: "p2", rate_end_date: future(240), lender: "R37LenderB" });
      await insertCase(page, { client_id: multiId, case_kind: "buy_to_let", stage: "offer", assigned_to: "p2", rate_end_date: future(500), lender: "R37LenderC" });

      const soloId = await insertClient(page, { first_name: tag, last_name: "SoloRate", email: `${tag}.solo@example.com`, phone: "07700900000" });
      await insertCase(page, { client_id: soloId, case_kind: "remortgage", stage: "application", assigned_to: "p2", rate_end_date: future(90), lender: "R37LenderD" });

      await goto(page, "clients", 1000);
      await page.selectOption("#cl-sort", "rate_end");
      await wait(page, 800);

      const rowInfo = (id) => page.evaluate((cid) => {
        const row = document.querySelector(`.client-row[data-client="${cid}"]`);
        if (!row) return null;
        const more = row.querySelector(".client-rateend-more");
        return { hasMore: !!more, moreText: more ? more.textContent.trim() : null, rateendText: row.querySelector(".client-rateend") ? row.querySelector(".client-rateend").textContent.trim() : null };
      }, id);

      const multiRow = await rowInfo(multiId);
      ok("§10a · the multi-rate client's row carries .client-rateend-more", multiRow && multiRow.hasMore, JSON.stringify(multiRow));
      eq("§10b · …reading \"(+2 more)\" (3 rate ends ahead, earliest shown)", multiRow && multiRow.moreText, "(+2 more)");

      const soloRow = await rowInfo(soloId);
      ok("§10c · the single-rate client's row carries NO .client-rateend-more", soloRow && !soloRow.hasMore, JSON.stringify(soloRow));
      ok("§10d · …but still shows its one rate end", soloRow && /rate ends/.test(soloRow.rateendText || ""), JSON.stringify(soloRow));

      ok("§10 · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §11 · P3 — ADMIN SEES PER-ADVISER TARGETS, READ-ONLY
       ======================================================================= */
    {
      console.log("\n— §11 · #adviser-targets-section: admin read-only, owner editable, adviser absent (p1/p4/p2)");
      const admin = await newPage(browser, "p1");
      const errAdmin = (admin.__err || []).length;
      await goto(admin, "settings", 1500);
      const adminState = await admin.evaluate(() => {
        const sec = document.querySelector("#adviser-targets-section");
        if (!sec) return null;
        const inputs = [...sec.querySelectorAll(".adv-target-input")];
        return {
          present: true,
          allDisabled: inputs.length > 0 && inputs.every((i) => i.disabled),
          readonlyNote: !!document.querySelector("#adviser-targets-readonly"),
          hasSaveBtn: !!document.querySelector("#adviser-targets-save"),
        };
      });
      ok("§11a · admin: #adviser-targets-section is present", adminState && adminState.present, JSON.stringify(adminState));
      ok("§11b · admin: every .adv-target-input is disabled", adminState && adminState.allDisabled, JSON.stringify(adminState));
      ok("§11c · admin: #adviser-targets-readonly lock note is present", adminState && adminState.readonlyNote, JSON.stringify(adminState));
      ok("§11d · admin: NO #adviser-targets-save button", adminState && !adminState.hasSaveBtn, JSON.stringify(adminState));

      const owner = await newPage(browser, "p4");
      const errOwner = (owner.__err || []).length;
      await goto(owner, "settings", 1500);
      const ownerState = await owner.evaluate(() => {
        const sec = document.querySelector("#adviser-targets-section");
        if (!sec) return null;
        const inputs = [...sec.querySelectorAll(".adv-target-input")];
        return {
          present: true,
          anyDisabled: inputs.some((i) => i.disabled),
          readonlyNote: !!document.querySelector("#adviser-targets-readonly"),
          hasSaveBtn: !!document.querySelector("#adviser-targets-save"),
        };
      });
      ok("§11e · owner: #adviser-targets-section is present", ownerState && ownerState.present, JSON.stringify(ownerState));
      ok("§11f · owner: inputs are editable (none disabled)", ownerState && !ownerState.anyDisabled, JSON.stringify(ownerState));
      ok("§11g · owner: NO read-only lock note", ownerState && !ownerState.readonlyNote, JSON.stringify(ownerState));
      ok("§11h · owner: #adviser-targets-save IS present", ownerState && ownerState.hasSaveBtn, JSON.stringify(ownerState));

      const adv = await newPage(browser, "p2");
      const errAdv = (adv.__err || []).length;
      await goto(adv, "settings", 1500);
      const advSectionAbsent = await adv.evaluate(() => !document.querySelector("#adviser-targets-section"));
      ok("§11i · adviser: #adviser-targets-section is absent entirely (unchanged from R26)", advSectionAbsent);

      ok("§11 · no console errors (admin)", noNewErr(admin, errAdmin), JSON.stringify(admin.__err));
      ok("§11 · no console errors (owner)", noNewErr(owner, errOwner), JSON.stringify(owner.__err));
      ok("§11 · no console errors (adviser)", noNewErr(adv, errAdv), JSON.stringify(adv.__err));
      await admin.close(); await owner.close(); await adv.close();
    }

    /* =======================================================================
       §12 · item 22 — #report-money-note: admin-only extra sentence
       ======================================================================= */
    {
      console.log("\n— §12 · #report-money-note: admin gets the ENDS-here sentence, owner sees nothing, adviser sees the base note only (p1/p4/p2)");
      const admin = await newPage(browser, "p1");
      const errAdmin = (admin.__err || []).length;
      await goto(admin, "reports", 1500);
      const adminNote = await admin.$eval("#report-money-note", (e) => ({ hidden: e.classList.contains("hidden"), text: e.textContent }));
      ok("§12a · admin: the money note is visible", !adminNote.hidden, JSON.stringify(adminNote));
      ok("§12b · admin: …and names the page ending on purpose (\"ENDS where\")", /ENDS where/.test(adminNote.text), adminNote.text);
      ok("§12c · admin: …and points at Pipeline MI as the admin view of the money", /Pipeline MI/.test(adminNote.text), adminNote.text);

      const owner = await newPage(browser, "p4");
      const errOwner = (owner.__err || []).length;
      await goto(owner, "reports", 1500);
      const ownerNote = await owner.$eval("#report-money-note", (e) => ({ hidden: e.classList.contains("hidden"), text: e.textContent }));
      ok("§12d · owner: the money note is hidden (they see the money panels directly)", ownerNote.hidden, JSON.stringify(ownerNote));
      eq("§12e · owner: …and carries no text", ownerNote.text, "");

      const adv = await newPage(browser, "p2");
      const errAdv = (adv.__err || []).length;
      await goto(adv, "reports", 1500);
      const advNote = await adv.$eval("#report-money-note", (e) => ({ hidden: e.classList.contains("hidden"), text: e.textContent }));
      ok("§12f · adviser: the money note is visible (same base note as before R37)", !advNote.hidden, JSON.stringify(advNote));
      ok("§12g · adviser: …but carries NO admin-only \"ENDS where\" sentence", !/ENDS where/.test(advNote.text), advNote.text);

      ok("§12 · no console errors (admin)", noNewErr(admin, errAdmin), JSON.stringify(admin.__err));
      ok("§12 · no console errors (owner)", noNewErr(owner, errOwner), JSON.stringify(owner.__err));
      ok("§12 · no console errors (adviser)", noNewErr(adv, errAdv), JSON.stringify(adv.__err));
      await admin.close(); await owner.close(); await adv.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r37: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
