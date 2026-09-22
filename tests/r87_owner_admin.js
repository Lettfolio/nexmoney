#!/usr/bin/env node
/* =============================================================================
   tests/r87_owner_admin.js — acceptance tests for R87 slice D, "owner / admin
   prose" (panel-r87/05-owner-admin.md #3 #5 #7 #8 #9 #10 #11 #12 #13, 06 #1 #11,
   07 #7 · the auto_sms_appointment switch).

     §A  PROSE DIET (T1, 05 #8, 06 #1/#11). On Reports, Monday money, Settings,
         Emails, Import, Data health and Vault every standing prose line this
         slice owns is ≤ 25 words once closed <details> are discounted; the long
         forms sit behind howFold() <details class="how-fold"> that are CLOSED on
         arrival and still carry the original text (the copy suites read
         textContent through them); no column identifier or formula reaches the
         rendered text (coalesce · ceil( · first_contact_at · protection_status ·
         case_events · _fee_paid_at · buy_to_let …).
     §B  MONDAY MONEY (05 #3). The weekly statement drop zone is the FIRST panel
         in #money-body, the rate card second, and every read-only panel follows
         with its id intact.
     §C  KIM'S REPORTS (05 #7). Admin: #report-money-note ≤ 20 words and the
         "My numbers" adviser card hidden; adviser: card still there.
     §D  SCOREBOARDS (05 #11). Month scoreboard, MI scoreboard and Monday money's
         per-adviser strip list only advisers with something on the board; the
         administrator / no-access / Unassigned / empty rows are behind "Show all",
         the foot total keeps counting them, and Show all brings them back.
     §E  DOORS (05 #9, #10). Import: Revolution sync first and primary, AI import
         second and .panel-secondary. Emails under the hold: "Release hold…" is
         the primary button (Owner enabled → Settings; Admin disabled), the run
         button is not primary and explains itself in ≤ 15 words; hold off → the
         release button is gone.
     §F  SETTINGS + VAULT (05 #5 #12 #13, 07 #7, 01 #3). No auto_sms_appointment
         control; every field note ≤ 15 visible words; adviser's Settings is My
         details + Security only (no firm form, no jump bar); the jump nav is the
         five group headings; Vault: no default "Everyone" badge, one copy control
         per secret, Delete inside a ⋯ menu that still deletes through the house
         dialog.
     §G  REPORTS CHIPS (05 #12). The per-panel chip strip is hidden on arrival and
         appears when a section pill (or the Panels toggle) is used.
     §H  NO CONSOLE ERRORS on every page this slice touches, for p4 / p1 / p2.

   Ground truth comes from window.__mock.db / the rendered DOM at runtime; nothing
   is hard-coded from the fixture.
   Run:  node /root/nx/tests/r87_owner_admin.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — HARNESS.md.)
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
const DESK = { width: 1440, height: 900 };
async function boot(browser, persona, viewport) {
  const page = await (await browser.newContext({ viewport: viewport || DESK, locale: "en-GB", timezoneId: "Europe/London" })).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));
const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 3200 : ms);
};
const txt = (page, sel) => page.$eval(sel, (e) => (e.textContent || "").replace(/\s+/g, " ").trim()).catch(() => null);
const setSettingLive = (page, key, value) => page.evaluate(async ({ key, value }) => {
  const rows = window.__mock.db.settings;
  const row = rows.filter((r) => r.key === key)[0];
  if (row) row.value = value;
  else rows.push({ key, value, updated_at: new Date().toISOString() });
  await window.__reloadSettings();
}, { key, value });

/* THE PROSE MEASURE, in the page: for every standing prose element under a page section, the words
   the reader actually sees — a closed <details> contributes only its <summary>. */
const PROSE_JS = `(function (pageId, sels) {
  const pg = document.getElementById(pageId);
  const inClosed = (el) => { let n = el.parentElement; while (n && n !== pg) { if (n.tagName === "DETAILS" && !n.open) return true; n = n.parentElement; } return false; };
  /* Prose = the words a reader has to read: a closed fold contributes nothing (its summary is a control label,
     not a sentence), a basis CHIP is a label the panel finding endorses (05 #8), and a bare dash or arrow is
     punctuation. */
  const vis = (el) => { const c = el.cloneNode(true); c.querySelectorAll("details:not([open]), .money-basis").forEach((d) => d.remove()); return c.textContent.replace(/\\s+/g, " ").trim(); };
  const nWords = (t) => t.split(/\\s+/).filter((w) => /[A-Za-z0-9£]/.test(w)).length;
  return [...pg.querySelectorAll(sels)].filter((el) => el.offsetParent !== null && !inClosed(el)).map((el) => ({ id: el.id || null, cls: el.className, w: nWords(vis(el)), t: vis(el).slice(0, 90) }));
})`;
const words = (s) => String(s || "").trim().split(/\s+/).filter((w) => /[A-Za-z0-9£]/.test(w)).length;
/* Identifiers that must not reach rendered text (05 #8, 06 #11). \\b[a-z]+_[a-z_]+\\b would also catch
   e-mail addresses in fixtures, so the list is explicit. */
const LEAK_RE = /coalesce|ceil\(|first_contact_at|protection_status|protection_quoted_at|case_events|stage_changed|_fee_paid_at\b|fee_paid_at\b|completed_at\b|created_at\b|submitted_at\b|offer_issued_date\b|review_requested_at|offer_expiry_date|policy_taken\b|buy_to_let\b|case_tasks\b|\bUPDATE\b|\bINSERT\b/;

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* =====================================================================
       §A · PROSE DIET
       ===================================================================== */
    {
      console.log("\n— §A · prose diet on the owner's seven pages (p4)");
      const page = await boot(browser, "p4");
      const e0 = realErrs(page).length;
      const OWNED = {
        reports: ["#report-mine-scope", "#report-scoreboard-scope", "#report-owed-basis", "#report-rateend-basis", "#report-leadresp-basis", "#report-conveyancer-basis", "#report-outcomes-basis", "#report-ref-basis", "#report-advocacy-basis", "#report-adoption-sub", "#report-mi-scope", "#report-mi-funnel-scope", "#report-mix-scope", "#report-funnel-scope", "#report-sources-scope", ".rep-hero-basis", "#month-advisers-attrib"],
        money: ["#money-scope", "#money-owed-basis", "#money-rateends-basis", "#money-cold-basis", "#money-movement-basis", "#money-leads-basis", "#money-advisers-basis", "#money-recon-sub", "#money-procrates-sub"],
        emails: ["#emails-intro", "#em-morning-sub"],
        import: ["#rev-intro", "#import-intro"],
        data: ["#dh-page-sub", "#dh-key", "#dh-atrisk-email"],
        vault: ["#vault-intro"],
      };
      for (const [pg, sels] of Object.entries(OWNED)) {
        await goPage(page, pg);
        const rows = await page.evaluate(`${PROSE_JS}("page-${pg}", ${JSON.stringify(sels.join(", "))})`);
        const over = rows.filter((r) => r.w > 25);
        ok(`§A1 · ${pg}: every standing line this slice owns is ≤ 25 words (${rows.length} measured)`, rows.length > 0 && over.length === 0, JSON.stringify(over));
        const text = await page.$eval(`#page-${pg}`, (e) => e.innerText);
        ok(`§A2 · ${pg}: no column identifier or formula in the rendered text`, !LEAK_RE.test(text), (text.match(LEAK_RE) || [])[0]);
      }
      /* Reports: the long forms still exist, closed, and hold the sentences the copy suites read. */
      await goPage(page, "reports");
      const folds = await page.evaluate(() => ["report-owed-how", "report-leadresp-how", "report-adoption-how", "report-rateend-how", "report-scoreboard-how", "report-ref-how", "report-outcomes-how"].map((id) => {
        const d = document.getElementById(id);
        return { id, present: !!d, details: !!d && d.tagName === "DETAILS", open: d ? d.open : null, words: d ? d.textContent.trim().split(/\s+/).length : 0 };
      }));
      ok("§A3 · Reports: the owed / lead-response / adoption / rate-end / scoreboard / referrals / outcomes essays are behind CLOSED folds",
        folds.every((f) => f.present && f.details && f.open === false && f.words > 20), JSON.stringify(folds));
      const owed = await txt(page, "#report-owed-basis");
      ok("§A4 · the Money owed basis still ENDS on the R42 basis chip, with the fold before it (r42 §F3 intact)", !!owed && owed.endsWith("— basis: outstanding (see legend above)"), owed);
      ok("§A5 · …and its folded text says 'each on its own paid date' in English, never coalesce()", /its own paid date/.test(owed) && !/coalesce/.test(owed), owed);
      const lead = await txt(page, "#report-leadresp-basis");
      ok("§A6 · Lead response: p90 is 'nine in ten enquiries were inside', not ceil(0.9 × n)", /nine in ten/.test(lead || "") && !/ceil/.test(lead || ""), lead);
      const scoreLine = await page.evaluate(() => { const el = document.getElementById("report-scoreboard-scope"); const c = el.cloneNode(true); c.querySelectorAll("details").forEach((d) => d.remove()); return c.textContent.replace(/\s+/g, " ").trim(); });
      ok("§A7 · the scoreboard keeps one sentence in the open and its attribution note in the fold", words(scoreLine) <= 25 && /Figures follow the adviser currently on each case/.test(await txt(page, "#report-scoreboard-scope")), scoreLine);
      // Settings, owner: the field notes.
      await goPage(page, "settings");
      const notes = await page.evaluate(`${PROSE_JS}("page-settings", ".set-note")`);
      const overNotes = notes.filter((n) => n.w > 15);
      ok(`§A8 · Settings: every field note is ≤ 15 visible words (${notes.length} notes)`, notes.length >= 10 && overNotes.length === 0, JSON.stringify(overNotes));
      const longForms = await page.evaluate(() => ["setting-note-financial_promotions_approved", "playbook-auto-note", "setting-note-client_quiet_months", "setting-note-docs_list", "nps-note", "nps-reminder-note", "annual-review-note"].map((id) => {
        const el = document.getElementById(id); const d = el && el.querySelector("details");
        return { id, tag: el ? el.tagName : null, fold: !!d, open: d ? d.open : null, words: el ? el.textContent.trim().split(/\s+/).length : 0 };
      }));
      ok("§A9 · …each keeps its id on a <div> whose closed fold still carries the full text (the copy suites read textContent)",
        longForms.every((f) => f.tag === "DIV" && f.fold && f.open === false && f.words > 40), JSON.stringify(longForms));
      const finPromo = await txt(page, "#setting-note-financial_promotions_approved");
      ok("§A10 · the 151-word financial-promotions note still names the three enforcement points inside its fold (r82 A4b)", /nightly queueing job/.test(finPromo) && /Queue protection intro/.test(finPromo) && /cancel/i.test(finPromo), (finPromo || "").slice(0, 120));
      const settingsText = await page.$eval("#page-settings", (e) => e.innerText);
      ok("§A11 · Settings: no identifier in the rendered text", !LEAK_RE.test(settingsText), (settingsText.match(LEAK_RE) || [])[0]);
      const ch = await page.evaluate(() => [...document.querySelectorAll("#ch-list .audit-act")].map((e) => e.textContent.trim()));
      ok("§A12 · Change history badges read Created / Updated / Deleted, not INSERT / UPDATE", ch.length > 0 && ch.every((w) => /^(Created|Updated|Deleted)$/.test(w)), JSON.stringify(ch.slice(0, 6)));
      const chSum = await page.evaluate(() => [...document.querySelectorAll("#ch-list .audit-sum")].map((e) => e.textContent).join(" | "));
      ok("§A13 · …and the summaries name tables and case kinds in English (no case_tasks / buy_to_let)", !/case_tasks|buy_to_let|\bcases "/.test(chSum), chSum.slice(0, 160));
      eq("§A · no console errors", realErrs(page).slice(e0), []);
      await page.close();
    }

    /* =====================================================================
       §B · MONDAY MONEY — the ritual leads
       ===================================================================== */
    {
      console.log("\n— §B · Monday money: statement drop zone first (p4)");
      const page = await boot(browser, "p4");
      const e0 = realErrs(page).length;
      await goPage(page, "money", 3600);
      const order = await page.evaluate(() => {
        const body = document.getElementById("money-body");
        const kids = [...body.children].map((k) => k.id || [...k.querySelectorAll("[id]")].map((x) => x.id).join("+"));
        const y = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null; };
        return { kids, drop: y("#recon-file-slot"), banked: y("#money-banked-panel"), advisers: y("#money-advisers-panel"), rates: y("#money-procrates-panel"), ids: ["money-banked", "money-owed", "money-rateends", "money-cold", "money-movement", "money-leads", "money-advisers", "recon-statements", "procrates-status"].every((id) => !!document.getElementById(id)) };
      });
      eq("§B1 · the first child of #money-body is the weekly commission statement panel", order.kids[0], "money-recon-panel");
      eq("§B2 · …the rate card is second", order.kids[1], "money-procrates-panel");
      ok("§B3 · the drop zone sits above the first read-only panel and the per-adviser strip", order.drop != null && order.drop < order.banked && order.banked < order.advisers, JSON.stringify(order));
      ok("§B4 · the statement is on the first screen (top < 900px)", order.drop < 900, String(order.drop));
      ok("§B5 · every read-only panel keeps its id (nothing deleted — R89 merges them)", order.ids, JSON.stringify(order.kids));
      const scope = await page.evaluate(() => { const el = document.getElementById("money-scope"); const c = el.cloneNode(true); c.querySelectorAll("details").forEach((d) => d.remove()); return c.textContent.replace(/\s+/g, " ").trim(); });
      ok("§B6 · the page scope is one line pointing at the statement, with the basis behind #money-how", words(scope) <= 25 && /statement/i.test(scope) && !!(await page.$("#money-how")), scope);
      eq("§B · no console errors", realErrs(page).slice(e0), []);
      await page.close();
    }

    /* =====================================================================
       §C · KIM'S REPORTS
       ===================================================================== */
    {
      console.log("\n— §C · the administrator's Reports (p1) vs the adviser's (p2)");
      const admin = await boot(browser, "p1");
      const eA = realErrs(admin).length;
      await goPage(admin, "reports");
      const note = await txt(admin, "#report-money-note");
      ok("§C1 · admin: the money note is one line of ≤ 20 words", !!note && words(note) <= 20, `${words(note)} words: ${note}`);
      ok("§C2 · …that still says the page ENDS where the money begins and names Pipeline MI (r37 §12)", /ENDS where/.test(note || "") && /Pipeline MI/.test(note || ""), note);
      const mineAdmin = await admin.evaluate(() => ({ hidden: document.getElementById("report-mine-panel").classList.contains("hidden"), tiles: document.querySelectorAll("#report-mine .kpi").length, chip: !!document.getElementById("rep-nav-mine") }));
      ok("§C3 · admin: the 'My numbers' adviser card is hidden and empty", mineAdmin.hidden && mineAdmin.tiles === 0, JSON.stringify(mineAdmin));
      ok("§C4 · …and no 'mine' section head or chip is offered", mineAdmin.chip === false && (await admin.evaluate(() => document.getElementById("rsec-mine").classList.contains("hidden"))), JSON.stringify(mineAdmin));
      eq("§C · no console errors (admin)", realErrs(admin).slice(eA), []);
      await admin.close();
      const adv = await boot(browser, "p2");
      const eB = realErrs(adv).length;
      await goPage(adv, "reports");
      const mineAdv = await adv.evaluate(() => ({ hidden: document.getElementById("report-mine-panel").classList.contains("hidden"), tiles: document.querySelectorAll("#report-mine .kpi").length, scope: (document.getElementById("report-mine-scope") || {}).textContent || "" }));
      ok("§C5 · adviser: the card is still theirs — visible with its five tiles", !mineAdv.hidden && mineAdv.tiles === 5, JSON.stringify(mineAdv));
      const advScopeLine = await adv.evaluate(() => { const el = document.getElementById("report-mine-scope"); const c = el.cloneNode(true); c.querySelectorAll("details").forEach((d) => d.remove()); return c.textContent.replace(/\s+/g, " ").trim(); });
      ok("§C6 · …with one ≤ 25-word scope line and the three-window explanation folded (text intact for r68_mi)", words(advScopeLine) <= 25 && /My retention conversion/.test(mineAdv.scope) && /calendar year/.test(mineAdv.scope), advScopeLine);
      eq("§C · no console errors (adviser)", realErrs(adv).slice(eB), []);
      await adv.close();
    }

    /* =====================================================================
       §D · SCOREBOARDS hide the empty rows behind Show all
       ===================================================================== */
    {
      console.log("\n— §D · scoreboards: admin / no-access / Unassigned / empty rows behind Show all (p4)");
      const page = await boot(browser, "p4");
      const e0 = realErrs(page).length;
      await goPage(page, "reports");
      const gt = await page.evaluate(() => ({
        admin: window.__mock.db.profiles.filter((p) => p.role === "admin").map((p) => p.full_name),
        noAccess: window.__mock.db.profiles.filter((p) => p.role === "none").map((p) => p.full_name),
      }));
      const readBoard = () => page.evaluate(() => {
        const rows = [...document.querySelectorAll("#report-advisers table tr")].slice(1);
        const body = rows.filter((r) => !r.classList.contains("scoreboard-foot"));
        const foot = rows.find((r) => r.classList.contains("scoreboard-foot"));
        return { names: body.map((r) => r.children[0].textContent.trim()), footOpen: foot ? foot.children[1].textContent.trim() : null,
          quiet: (document.getElementById("report-scoreboard-quiet") || {}).textContent || "", btn: !!document.getElementById("report-scoreboard-showall"),
          reconcile: (document.getElementById("report-scoreboard-reconcile") || {}).textContent || "" };
      });
      const before = await readBoard();
      const quietNames = gt.admin.concat(gt.noAccess.map((n) => n + " — no access"), ["Unassigned"]);
      ok("§D1 · month scoreboard: no administrator, no-access or Unassigned row on arrival", before.names.length > 0 && !before.names.some((n) => quietNames.some((q) => n.startsWith(q))), JSON.stringify(before.names));
      ok("§D2 · …a line says how many rows are hidden and names them, with a Show all button", before.btn && /hidden/.test(before.quiet) && /Show all/.test(before.quiet), before.quiet);
      ok("§D3 · …and the open-cases foot total still reconciles with the live KPI (counts stay honest)", /reconcile with/.test(before.reconcile) && !/do not reconcile/.test(before.reconcile), before.reconcile);
      await page.click("#report-scoreboard-showall");
      await page.waitForTimeout(600);
      const after = await readBoard();
      ok("§D4 · Show all brings the hidden rows back (more rows, same foot total)", after.names.length > before.names.length && after.footOpen === before.footOpen, JSON.stringify({ before: before.names, after: after.names, foot: [before.footOpen, after.footOpen] }));
      ok("§D5 · …including the Unassigned bucket and the administrator where the book has them", after.names.some((n) => /Unassigned/.test(n)) || after.names.some((n) => gt.admin.includes(n)), JSON.stringify(after.names));
      // MI scoreboard shares the flag.
      const mi = await page.evaluate(() => ({ names: [...document.querySelectorAll("#report-mi-scoreboard table tr")].slice(1).map((r) => r.children[0].textContent.trim()), btn: (document.getElementById("report-mi-scoreboard-showall") || {}).textContent || "" }));
      ok("§D6 · the MI scoreboard follows the same flag: with Show all on, its hide button is offered and Unassigned is listed", /Hide/.test(mi.btn) && mi.names.some((n) => /Unassigned/.test(n)), JSON.stringify(mi));
      await page.click("#report-scoreboard-showall");   // back to the quiet view
      await page.waitForTimeout(600);
      const mi2 = await page.evaluate(() => [...document.querySelectorAll("#report-mi-scoreboard table tr")].slice(1).map((r) => r.children[0].textContent.trim()));
      ok("§D7 · …and hidden again, the MI board drops Unassigned and the administrator", !mi2.some((n) => /Unassigned/.test(n) || gt.admin.includes(n)), JSON.stringify(mi2));
      // Monday money per adviser.
      await goPage(page, "money", 3600);
      const mm = await page.evaluate(() => ({ names: [...document.querySelectorAll("#money-adviser-table tr")].slice(1).map((r) => r.children[0].textContent.trim()), quiet: (document.getElementById("money-advisers-quiet") || {}).textContent || "" }));
      ok("§D8 · Monday money › Per adviser: the administrator's £0 / — row is behind Show all too", mm.names.length > 0 && !mm.names.some((n) => gt.admin.includes(n)) && /Show all/.test(mm.quiet), JSON.stringify(mm));
      eq("§D · no console errors", realErrs(page).slice(e0), []);
      await page.close();
    }

    /* =====================================================================
       §E · DOORS — Import order, Emails under the hold
       ===================================================================== */
    {
      console.log("\n— §E · Import doors in weekly order; Emails' primary button under the hold (p4 / p1)");
      const page = await boot(browser, "p4");
      const e0 = realErrs(page).length;
      await goPage(page, "import", 1800);
      const imp = await page.evaluate(() => {
        const rev = document.getElementById("rev-input-panel"), ai = document.getElementById("import-ai-panel");
        return { revFirst: !!(rev.compareDocumentPosition(ai) & Node.DOCUMENT_POSITION_FOLLOWING), revSecondary: rev.classList.contains("panel-secondary"), aiSecondary: ai.classList.contains("panel-secondary"),
          revBg: getComputedStyle(rev).backgroundColor, aiBg: getComputedStyle(ai).backgroundColor,
          h2s: [...document.querySelectorAll("#page-import h2")].map((h) => h.textContent.trim()), slots: ["rev-file-slot", "import-file-slot", "rev-text", "import-text", "analyse-btn", "rev-read-btn"].every((id) => !!document.getElementById(id)) };
      });
      ok("§E1 · Revolution sync is the first door in the DOM and the AI import follows", imp.revFirst, JSON.stringify(imp.h2s));
      ok("§E2 · …the Revolution panel is the primary one and the AI import takes the secondary skin (r75 A5 re-pointed)", !imp.revSecondary && imp.aiSecondary && imp.revBg !== imp.aiBg, JSON.stringify(imp));
      ok("§E3 · every control keeps its id", imp.slots);
      // Emails, hold ON (the fixture's seed).
      await goPage(page, "emails", 2600);
      const held = await page.evaluate(() => ({ hold: window.__mock.db.settings.find((r) => r.key === "email_hold").value,
        rel: (() => { const b = document.getElementById("em-release-hold-btn"); return b ? { hidden: b.classList.contains("hidden"), primary: b.classList.contains("btn-primary"), disabled: b.disabled, text: b.textContent.trim() } : null; })(),
        run: (() => { const b = document.getElementById("run-now-btn"); return b ? { hidden: b.classList.contains("hidden"), primary: b.classList.contains("btn-primary") } : null; })(),
        why: (() => { const w = document.getElementById("run-now-why"); return w ? { hidden: w.classList.contains("hidden"), text: w.textContent.trim() } : null; })() }));
      eq("§E4 · fixture — email_hold is on", held.hold, "on");
      ok("§E5 · owner, held: 'Release hold…' is visible, primary and enabled", held.rel && !held.rel.hidden && held.rel.primary && !held.rel.disabled && /Release hold/.test(held.rel.text), JSON.stringify(held.rel));
      ok("§E6 · …the run button is still there but not primary", held.run && !held.run.hidden && !held.run.primary, JSON.stringify(held.run));
      ok("§E7 · …and one ≤ 15-word line says why it cannot send", held.why && !held.why.hidden && words(held.why.text) <= 15 && /nothing sends/i.test(held.why.text), JSON.stringify(held.why));
      await page.click("#em-release-hold-btn");
      await page.waitForTimeout(1400);
      const landed = await page.evaluate(() => ({ page: !document.getElementById("page-settings").classList.contains("hidden"), strip: !!document.getElementById("email-hold-btn") }));
      ok("§E8 · pressing it opens Settings, where the release switch lives", landed.page && landed.strip, JSON.stringify(landed));
      await setSettingLive(page, "email_hold", "off");
      await goPage(page, "emails", 2600);
      const off = await page.evaluate(() => ({ rel: document.getElementById("em-release-hold-btn").classList.contains("hidden"), why: document.getElementById("run-now-why").classList.contains("hidden") }));
      ok("§E9 · hold off: the release button and the explainer are gone", off.rel && off.why, JSON.stringify(off));
      await setSettingLive(page, "email_hold", "on");
      eq("§E · no console errors (owner)", realErrs(page).slice(e0), []);
      await page.close();
      const admin = await boot(browser, "p1");
      const eA = realErrs(admin).length;
      await goPage(admin, "emails", 2600);
      const relA = await admin.evaluate(() => { const b = document.getElementById("em-release-hold-btn"); return { hidden: b.classList.contains("hidden"), disabled: b.disabled, text: b.textContent.trim() }; });
      ok("§E10 · admin, held: the same button, disabled, saying the Owner releases it", !relA.hidden && relA.disabled && /Owner/.test(relA.text), JSON.stringify(relA));
      eq("§E · no console errors (admin)", realErrs(admin).slice(eA), []);
      await admin.close();
    }

    /* =====================================================================
       §F · SETTINGS + VAULT
       ===================================================================== */
    {
      console.log("\n— §F · Settings: the switch that read nothing, the five chips, the adviser's page; Vault polish (p4 / p1 / p2)");
      const page = await boot(browser, "p4");
      const e0 = realErrs(page).length;
      await goPage(page, "settings", 2600);
      const sw = await page.evaluate(() => ({ appt: !!document.querySelector('#settings-form [name="auto_sms_appointment"]'), rateEnd: !!document.querySelector('#settings-form [name="auto_sms_rate_end"]'), pointer: !!document.getElementById("set-protection-gate-pointer") }));
      ok("§F1 · owner: no auto_sms_appointment control (07 #7) — the rate-end SMS switch stays", !sw.appt && sw.rateEnd, JSON.stringify(sw));
      ok("§F2 · the 'it moved to the top of this page' pointer paragraph is gone", !sw.pointer);
      const chips = await page.$$eval("#settings-jump-chips [data-settings-jump]", (els) => els.map((b) => b.dataset.settingsJump));
      eq("§F3 · owner: the jump nav is the five group headings", chips, ["firm", "automations", "integrations", "team", "data"]);
      const jump = await page.evaluate(async () => {
        document.getElementById("settings-nav-integrations").click();
        await new Promise((r) => setTimeout(r, 1200));
        return { open: document.getElementById("set-sec-advanced").open, top: document.getElementById("set-sec-advanced").getBoundingClientRect().top, active: [...document.querySelectorAll("#settings-jump-chips .seg-btn.active")].map((b) => b.id) };
      });
      ok("§F4 · the Integrations chip opens the Advanced fold and scrolls to it", jump.open && jump.top < 250 && jump.active.includes("settings-nav-integrations"), JSON.stringify(jump));
      const dataChip = await page.evaluate(() => { const b = document.getElementById("settings-nav-data"); b.click(); return new Promise((r) => setTimeout(() => r(document.getElementById("firm-export-panel").getBoundingClientRect().top), 1200)); });
      ok("§F5 · the Data chip lands on Data & backup, which now sits with Change history", dataChip < 250, String(dataChip));
      eq("§F · no console errors (owner)", realErrs(page).slice(e0), []);
      await page.close();

      const admin = await boot(browser, "p1");
      const eA = realErrs(admin).length;
      await goPage(admin, "settings", 2600);
      const adminChips = await admin.$$eval("#settings-jump-chips [data-settings-jump]", (els) => els.map((b) => b.dataset.settingsJump));
      ok("§F6 · admin: the same five groups, Data anchored on a panel the admin can see (change history is Owner-only, diagnostics is not)", adminChips.length === 5 && adminChips.includes("data"), JSON.stringify(adminChips));
      const roNote = await txt(admin, "#settings-readonly-note");
      ok("§F7 · admin: the read-only line is one sentence pair, ≤ 25 words", !!roNote && words(roNote) <= 25, roNote);
      eq("§F · no console errors (admin)", realErrs(admin).slice(eA), []);
      await admin.close();

      const adv = await boot(browser, "p2");
      const eB = realErrs(adv).length;
      await goPage(adv, "settings", 2600);
      const advView = await adv.evaluate(() => ({
        controls: document.querySelectorAll("#settings-form input, #settings-form select, #settings-form textarea").length,
        note: !!document.getElementById("settings-readonly-note") && /edit and save those/.test(document.getElementById("settings-readonly-note").textContent),
        hidden: ["introducers-panel", "team-logins-panel", "firm-export-panel", "change-history-panel", "settings-golive", "email-sending-status"].map((id) => document.getElementById(id).classList.contains("hidden")),
        shown: ["my-details-panel", "security-panel"].map((id) => !document.getElementById(id).classList.contains("hidden")),
        bar: document.getElementById("settings-jump").hidden, targets: !!document.getElementById("adviser-targets-section"), save: document.getElementById("save-settings-btn").classList.contains("hidden"),
      }));
      ok("§F8 · adviser: no firm form controls at all", advView.controls === 0, String(advView.controls));
      ok("§F9 · …only My details and Security are on the page", advView.shown.every(Boolean) && advView.hidden.every(Boolean) && !advView.targets && advView.save, JSON.stringify(advView));
      ok("§F10 · …no jump bar (nothing to jump between) and the read-only line keeps r5_batch8's 'edit and save those'", advView.bar === true && advView.note, JSON.stringify(advView));
      // Vault (owner/admin controls) — as the admin.
      await goPage(adv, "vault", 2200);
      const vAdv = await adv.evaluate(() => ({ del: document.querySelectorAll("#vault-list .vault-del").length, more: document.querySelectorAll("#vault-list details.vault-more").length }));
      ok("§F11 · adviser: no Delete and no ⋯ menu on any card", vAdv.del === 0 && vAdv.more === 0, JSON.stringify(vAdv));
      eq("§F · no console errors (adviser)", realErrs(adv).slice(eB), []);
      await adv.close();

      const owner = await boot(browser, "p4");
      const eO = realErrs(owner).length;
      await goPage(owner, "vault", 2200);
      const v = await owner.evaluate(() => {
        const cards = [...document.querySelectorAll("#vault-list .vault-card")];
        const restricted = window.__mock.db.vault_entries.filter((r) => Array.isArray(r.visible_to) && r.visible_to.length).length;
        return { cards: cards.length, everyone: document.querySelectorAll(".vault-vis-all").length, restrictedChips: document.querySelectorAll(".vault-vis-restricted").length, restricted,
          pwCopy: document.querySelectorAll(".vault-pw-copy").length,
          dupCopy: cards.filter((c) => c.querySelectorAll(".vault-card-head [data-nexcopy], .vault-card-head .vf-copy").length > 0).length,
          delInMenu: cards.every((c) => !c.querySelector(".vault-del") || c.querySelector("details.vault-more .vault-del")),
          delVisibleAtRest: cards.filter((c) => { const d = c.querySelector(".vault-del"); return d && d.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }) && d.getBoundingClientRect().height > 0; }).length,
          menus: document.querySelectorAll("#vault-list details.vault-more").length, heads: document.querySelectorAll("#vault-list .vault-group-head").length };
      });
      ok("§F12 · no 'Everyone' badge anywhere; the restricted chip appears exactly on the restricted entries", v.everyone === 0 && v.restrictedChips === v.restricted, JSON.stringify(v));
      ok("§F13 · one copy affordance per secret — the head's duplicate 'Copy password' is gone", v.pwCopy === 0 && v.dupCopy === 0, JSON.stringify(v));
      ok("§F14 · Delete lives inside a ⋯ menu on every card and is not visible at rest", v.menus === v.cards && v.delInMenu && v.delVisibleAtRest === 0, JSON.stringify(v));
      ok("§F15 · category headings show on the All view", v.heads > 1, String(v.heads));
      await owner.click("#vault-segment .seg-btn[data-seg='lender']");
      await owner.waitForTimeout(400);
      eq("§F16 · …and drop when a category chip is selected (the chip already names it)", await owner.$$eval("#vault-list .vault-group-head", (e) => e.length), 0);
      const firstId = await owner.$eval("#vault-list .vault-card", (c) => c.dataset.id);
      const nBefore = await owner.evaluate(async () => ((await window.__mockDb.from("vault_entries").select("id")).data || []).length);
      await owner.click(`#vault-list .vault-card[data-id="${firstId}"] details.vault-more summary`);
      await owner.waitForTimeout(300);
      const menuOpen = await owner.$eval(`#vault-list .vault-card[data-id="${firstId}"] .vault-del`, (b) => b.offsetParent !== null);
      ok("§F17 · opening the ⋯ menu reveals Delete", menuOpen);
      await owner.click(`#vault-list .vault-card[data-id="${firstId}"] .vault-del`);
      await owner.waitForTimeout(600);
      const dlg = await owner.evaluate(() => { const b = document.querySelector("#ovl-confirm-ok"); return b ? { label: b.textContent.trim(), danger: b.classList.contains("btn-danger-solid") } : null; });
      ok("§F18 · …and Delete still asks in the house dialog with the danger verb (r14 / r74 contract)", dlg && /delete/i.test(dlg.label) && dlg.danger, JSON.stringify(dlg));
      await owner.click("#ovl-confirm-cancel");
      await owner.waitForTimeout(500);
      const nAfter = await owner.evaluate(async () => ((await window.__mockDb.from("vault_entries").select("id")).data || []).length);
      eq("§F19 · cancelling deletes nothing", nAfter, nBefore);
      eq("§F · no console errors (vault)", realErrs(owner).slice(eO), []);
      await owner.close();
    }

    /* =====================================================================
       §G · REPORTS chip strip is opt-in
       ===================================================================== */
    {
      console.log("\n— §G · Reports: the per-panel chip strip hides behind the section pills (p4)");
      const page = await boot(browser, "p4");
      const e0 = realErrs(page).length;
      await goPage(page, "reports");
      const arrive = await page.evaluate(() => ({ pills: document.querySelectorAll("#reports-jump-chips [data-reports-jump]").length, pillBar: document.getElementById("reports-jump").hidden, chips: document.getElementById("rep-nav").hidden, toggle: !!document.getElementById("reports-jump-toggle"), toggleTab: document.getElementById("reports-jump-toggle").getAttribute("role") }));
      ok("§G1 · on arrival: the section pills show, the 23-chip strip does not", arrive.pills >= 4 && !arrive.pillBar && arrive.chips === true, JSON.stringify(arrive));
      ok("§G2 · a 'Panels' toggle sits with the pills and is not itself a tab (r74 §D2 pill count untouched)", arrive.toggle && arrive.toggleTab !== "tab", JSON.stringify(arrive));
      await page.click("#reports-nav-money");
      await page.waitForTimeout(900);
      const afterPill = await page.evaluate(() => ({ chips: document.getElementById("rep-nav").hidden, n: document.querySelectorAll("#rep-nav-chips [data-rep-jump]").length, owed: !!document.getElementById("rep-nav-owed"), pos: getComputedStyle(document.getElementById("rep-nav")).position }));
      ok("§G3 · pressing a pill reveals that section's chips (still sticky, r11/r74 contracts)", afterPill.chips === false && afterPill.n >= 1 && afterPill.owed && afterPill.pos === "sticky", JSON.stringify(afterPill));
      await page.click("#reports-jump-toggle");
      await page.waitForTimeout(400);
      const toggled = await page.evaluate(() => ({ chips: document.getElementById("rep-nav").hidden, expanded: document.getElementById("reports-jump-toggle").getAttribute("aria-expanded") }));
      ok("§G4 · the toggle hides them again and says so (aria-expanded)", toggled.chips === true && toggled.expanded === "false", JSON.stringify(toggled));
      await page.evaluate(() => window.gotoMoneyOwed());
      await page.waitForTimeout(1600);
      const deep = await page.evaluate(() => ({ chips: document.getElementById("rep-nav").hidden, section: (document.querySelector("#reports-jump-chips .seg-btn.active") || {}).dataset.reportsJump }));
      ok("§G5 · a deep link (gotoMoneyOwed) re-opens the strip and lands in Money & book (r74 §D3)", deep.chips === false && deep.section === "money", JSON.stringify(deep));
      eq("§G · no console errors", realErrs(page).slice(e0), []);
      await page.close();
    }

    /* =====================================================================
       §H · NO CONSOLE ERRORS across the slice's pages, three roles
       ===================================================================== */
    {
      console.log("\n— §H · zero console errors on every page this slice touched (p4 / p1 / p2)");
      for (const persona of ["p4", "p1", "p2"]) {
        const page = await boot(browser, persona);
        const e0 = realErrs(page).length;
        for (const pg of ["reports", "settings", "emails", "import", "data", "vault", "money"]) {
          const allowed = await page.evaluate((p) => !!document.querySelector(`.nav-link[data-page="${p}"], [data-page="${p}"]`), pg);
          if (!allowed && pg === "money") continue;
          await goPage(page, pg, 2200);
        }
        const errs = realErrs(page).slice(e0);
        const log = await page.evaluate(() => (window.__errorLog || []).filter((e) => e && e.kind !== "caught" && !/ERR_TUNNEL|Failed to load/i.test(String(e.msg || ""))).length);
        eq(`§H · ${persona}: no console errors after walking the slice`, errs, []);
        ok(`§H · ${persona}: nothing uncaught in window.__errorLog`, log === 0, String(log));
        await page.close();
      }
    }
  } finally {
    await browser.close();
    if (srv) srv.kill();
  }
  console.log(`\nR87 · owner-admin: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
