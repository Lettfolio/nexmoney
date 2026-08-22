#!/usr/bin/env node
/* =============================================================================
   tests/r48.js — acceptance tests for ROUND 48: commission attribution, the
   "needs you" queue, and no case hard-delete (admin/app.js ~L9174/12440-13010/
   23200-24100, admin/mock-supabase.js commission_lines.attributed_to).

   What R48 shipped, in one paragraph: the prod migration r48_commission_
   attribution added `commission_lines.attributed_to uuid` (FK profiles, on
   delete set null). Case hard-delete is GONE — #del-case-btn's markup and its
   click handler are both removed; "🚫 Mark not proceeding" (#case-mark-np,
   unchanged since R35) is the only way a case leaves the live pipeline, and it
   still just moves the stage — the case row is never deleted. Every commission
   line now carries WHO its money belongs to: r44AttributeLine (pure) decides
   at import time — misc insurance (protection/renewal/other, or any non-
   Mortgage-group line) always goes to the OWNER regardless of whose name is on
   the sheet; a mortgage/takeback goes to the matched case's assigned_to when
   one was suggested, else the sheet's named adviser IF they are a current
   profile, else the owner. Confirming a mortgage receipt against a case
   RE-HOMES the line onto that case's true adviser, overriding the import-time
   guess. r44AttributeLineTo is the manual override (no case required), wired
   to the review screen's per-line "Attribute to" select + "no case — just
   income" checkbox + "Set person" button. renderReconReview grows a per-person
   tally (r44TallyHtml) and a "needs you" queue/count (r44NeedsYou) — a line
   needs you when it is a pending matchable line OR its attribution is null,
   which import guarantees never happens (every line resolves to a profile).

   §A  no case hard-delete — #del-case-btn absent for owner AND admin (never
       existed for advisers either); #case-mark-np present and still moves a
       live case to not_proceeding, LEAVING THE ROW IN PLACE
   §B  r44AttributeLine / r44NameKey / r44IsMiscInsurance — pure, synthetic
       inputs: matched-case wins, named-current-adviser fallback, ex-broker/
       unknown-name falls to owner, misc insurance always owner regardless of
       name, non-Mortgage group always owner, name normalisation (trim/case/
       whitespace)
   §C  attribution at a REAL import — mortgage matched to a case beats the
       sheet's adviser name; mortgage unmatched falls to the named current
       adviser; mortgage unmatched with an unknown name falls to the owner;
       protection/renewal/other always land on the owner even when named to a
       current adviser; a takeback follows the identical mortgage rule; no
       line in the batch is ever null-attributed
   §D  confirm follows the case — a line attributed to adviser X at import,
       confirmed against a case owned by DIFFERENT adviser Y, re-homes to Y;
       the R44 fee-paid write (proc_fee_paid_at + case note) still happens
   §E  manual attribution — r44AttributeLineTo sets attributed_to directly;
       the noCase variant parks match_status at "na"; refused on an already-
       confirmed line; the #recon-attr-<id> select / #recon-attr-nocase-<id> /
       #recon-attr-set-<id> DOM control round-trips through a real click
   §F  the tally — correct per-person banked_net sums, dismissed lines
       excluded, the owner's row annotated with the misc-insurance slice, a
       null-attributed line rolls into "Unassigned — needs you (N)" and N
       matches an independent r44NeedsYou count
   §G  owner-only — p1 admin and p2 adviser see no recon panel/tally/queue via
       nav(), the panel self-gates even when forced, and a direct write to
       commission_lines.attributed_to comes back 42501 for both
   §H  XSS spot-check — a hostile adviser_name/provider on an imported line
       renders as inert text in the review (tally + needs-you queue), no
       script/image ever executes
   §I  no console errors across the whole owner session

   EVERY figure this file asserts is either read straight back off the mock db
   or computed independently from the fixtures at runtime (r44's/HARNESS.md's
   standing rule) — never a hardcoded expectation that could drift.

   Run:  node /root/nx/tests/r48.js
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
/* Same sandbox workaround as tests/r44.js: cdn.sheetjs.com 403s here, so any
   test driving a real upload injects the local xlsx UMD bundle instead of a
   <script src="https://cdn..."> tag. This file never opens anything else out
   of /tmp/r44 — every fixture workbook below is built in-page from invented
   rows. */
const XLSX_PATH = "/tmp/r44/node_modules/xlsx/dist/xlsx.full.min.js";

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail !== undefined ? ` — ${JSON.stringify(detail)}` : "")); console.log(`  ✗ ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`); }
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
    try { if (page.__dialogAnswer === "dismiss") await d.dismiss(); else await d.accept(); } catch (e) { /* ignore */ }
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const noNewErr = (page, before) => (page.__err || []).length === before;
const gotoMoney = async (page, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate(() => window.nav("money"));
  await wait(page, ms == null ? 2000 : ms);
};
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");

async function bootXlsx(page) {
  await page.addScriptTag({ path: XLSX_PATH });
  await page.evaluate(() => {
    window.__mkFile = function (aoa, sheetName, fileName) {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      return new File([out], fileName, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    };
    window.__drop = function (sel, file) {
      const el = document.querySelector(sel);
      const dt = new DataTransfer(); dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
  });
  await wait(page, 200);
}

/* ---------------------------------------------------------------------------
   Straight-into-the-mock inserts — the technique tests/r44.js/r35.js/... use.
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
let uniq = 0;
function tag() { uniq += 1; return "R48" + Date.now().toString(36) + uniq; }
/* A case whose stage/proc_fee_paid_at satisfy r44LoadCandidateCases' filter
   (stage in offer/exchange/completed, and — for completed — no paid date), so
   it is always a live matcher candidate. `o.case` overrides land on the row. */
async function mkFixtureCase(page, last, o) {
  const opt = o || {};
  const clId = await insertClient(page, { first_name: "R48", last_name: last, email: `${last.toLowerCase()}@example.invalid`, phone: "07700900000" });
  const row = Object.assign({
    client_id: clId, case_kind: "remortgage", stage: "completed", assigned_to: "p2",
    lender: "Halifax", loan_amount: 200000, proc_fee: 0, proc_fee_paid_at: null,
  }, opt.case || {});
  const caseId = await insertCase(page, row);
  return { clientId: clId, caseId, last };
}
const readCase = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", id).single();
  return data;
}, caseId);
const notesFor = (page, caseId) => page.evaluate((id) => window.__mock.db.case_notes.filter((n) => n.case_id === id).map((n) => n.body), caseId);
const openCase = async (page, caseId) => {
  await page.evaluate((id) => window.openCase(id), caseId);
  await wait(page, 900);
};

/* The statement fixture builder — copied verbatim from tests/r44.js's own
   buildStatementAoa/importStatement (shared shape infrastructure, not R44-
   specific logic): 21 spacer-interleaved columns, header text carrying
   literal mid-phrase newlines, a Ref: cell buried in the trailer rows. `rows`
   is a list of { d, tt, addr, prov, acct, opp, reason, ptype, pgroup, prem,
   g, n, adviser }; a firm row + one adviser group per distinct `adviser`
   value is generated automatically. All values below are invented for this
   file. */
function buildStatementAoa(ref, rows, opts) {
  const o = opts || {};
  const H = ["Date", "Tran Type \nDesc", "Addressee", "Provider", "Account \nnumber", "Opp ID", null,
    "File Review Client Name", "Reason", "Policy \nType", "Policy Group", null, "Premium",
    "Banked\n(Gross)", null, null, "Banked\n(Net)", "Deduction(Introducer)", "Deduction\n(Referrer)", "Clawback\nReserve", "£"];
  const blank = () => new Array(21).fill(null);
  const line = (r) => { const a = blank();
    a[0] = r.d; a[1] = r.tt; a[2] = r.addr || ""; a[3] = r.prov || ""; a[4] = r.acct || ""; a[5] = r.opp || "";
    a[8] = r.reason || ""; a[9] = r.ptype || ""; a[10] = r.pgroup || ""; a[12] = r.prem == null ? "" : r.prem;
    a[13] = r.g; a[16] = r.n; return a; };
  const title = blank(); title[0] = "Commission statement";
  const refRow = blank(); refRow[11] = ref ? `Ref:${ref}` : "";
  const firmName = "Fixture Network Ltd";
  const firm = blank(); firm[0] = firmName;
  const advOf = {}; (rows || []).forEach((r) => { advOf[r.adviser || "one"] = true; });
  const byAdv = {};
  (rows || []).forEach((r) => { const k = r.adviser || "one"; (byAdv[k] = byAdv[k] || []).push(r); });
  let gTot = 0, nTot = 0;
  const aoa = [title, refRow, blank(), blank(), blank(), H, firm, blank()];
  Object.keys(byAdv).sort().forEach((k) => {
    const advRow = blank(); advRow[0] = k;
    aoa.push(advRow);
    byAdv[k].forEach((r) => { aoa.push(line(r)); gTot += Number(r.g || 0); nTot += Number(r.n || 0); });
    const sub = blank(); sub[10] = byAdv[k].length + " item(s)";
    sub[13] = byAdv[k].reduce((s, r) => s + Number(r.g || 0), 0);
    sub[16] = byAdv[k].reduce((s, r) => s + Number(r.n || 0), 0);
    aoa.push(sub);
    aoa.push(blank());
  });
  const totF = blank(); totF[0] = "Total for " + firmName; totF[13] = gTot; totF[16] = nTot;
  aoa.push(totF);
  if (!o.omitStatementTotal) {
    const totS = blank(); totS[0] = "Total for this statement"; totS[10] = (rows || []).length + " item(s)"; totS[13] = gTot; totS[16] = nTot;
    aoa.push(totS);
  }
  aoa.push(blank());
  return aoa;
}
async function importStatement(page, ref, rows, opts) {
  await page.evaluate(({ aoa, fn }) => {
    window.__drop("#recon-file", window.__mkFile(aoa, "Commission Statement (Fixture)", fn));
  }, { aoa: buildStatementAoa(ref, rows, opts || {}), fn: `${ref || "no-ref"}.xlsx` });
  await wait(page, (opts && opts.settle) || 2200);
}
/* Find a rendered .recon-line whose facts text contains `needle` (an account
   number or addressee substring unique to the fixture row), inside a given
   kind-group. Throws loudly rather than returning undefined, so a broken
   lookup fails the very next assertion with a clear message instead of a
   confusing null-deref three lines later. */
async function findLineId(page, kind, needle) {
  const id = await page.evaluate(({ k, n }) => {
    const els = [...document.querySelectorAll(`#recon-group-${k} .recon-line[data-kind="${k}"]`)];
    const hit = els.find((el) => el.textContent.indexOf(n) >= 0);
    return hit ? hit.dataset.line : null;
  }, { k: kind, n: needle });
  if (!id) throw new Error(`findLineId: no ${kind} line found containing "${needle}"`);
  return id;
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       §A · no case hard-delete
       ======================================================================= */
    {
      console.log("\n— §A · case hard-delete removed; #case-mark-np is the only close path, and it does not delete the row");
      /* Each browser page has its OWN in-memory mock DB (a fresh admin/mock.html
         load = a fresh fixture set) — a case created on one page's __mockDb is
         invisible to another page. So each persona gets its own fixture case,
         inserted on the very page that then opens the modal, same as tests/
         r35.js's mkClientCase pattern. */
      for (const persona of ["p4", "p1", "p2", "p3"]) {
        const page = await newPage(browser, persona);
        const errBefore = (page.__err || []).length;
        const f = await mkFixtureCase(page, "Kestleford" + tag(), { case: { stage: "application", assigned_to: persona === "p2" || persona === "p3" ? persona : "p2" } });
        await openCase(page, f.caseId);
        const present = await page.evaluate(() => !!document.querySelector("#del-case-btn"));
        ok(`§A1 · ${persona}: #del-case-btn is absent from the case modal`, !present);
        const anyHardDeleteBtn = await page.evaluate(() => [...document.querySelectorAll("#modal button")].some((b) => /delete this case|hard.delete case/i.test(b.textContent || "")));
        ok(`§A2 · ${persona}: no button in the modal reads like a case hard-delete`, !anyHardDeleteBtn);
        const npPresent = await page.evaluate(() => !!document.querySelector("#case-mark-np"));
        ok(`§A3 · ${persona}: #case-mark-np is present on a live case`, npPresent);
        ok(`§A · ${persona} console clean`, noNewErr(page, errBefore), JSON.stringify(page.__err));
        await page.close();
      }

      /* Drive it: p2 (the case's own adviser) marks a fresh case not
         proceeding, and the case ROW STILL EXISTS afterwards — closed, not
         deleted. Same page creates and interacts with the fixture, for the
         reason above. */
      const page = await newPage(browser, "p2");
      const errBefore = (page.__err || []).length;
      const nfix = await mkFixtureCase(page, "Ashendale" + tag(), { case: { stage: "application", assigned_to: "p2" } });
      await openCase(page, nfix.caseId);
      const before = await readCase(page, nfix.caseId);
      ok("§A4 · fixture case starts live (not not_proceeding)", before.stage !== "not_proceeding", before.stage);
      /* #case-mark-np lives in the More-actions overflow at a live stage — open
         it first, same as tests/r35.js's §E does. */
      await page.click("#case-more-actions-toggle");
      await wait(page, 250);
      await page.click("#case-mark-np");
      await wait(page, 500);
      ok("§A5 · the confirm names the consequence", /Mark this case as Not proceeding/i.test((page.__dialogs.slice(-1)[0] || {}).message || ""), page.__dialogs.slice(-1));
      const overlayOpen = await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      ok("§A6 · the lost-reason capture opens next", overlayOpen);
      await page.selectOption("#lost-reason", "rate_price");
      await page.click("#lost-ok");
      await wait(page, 900);
      const after = await readCase(page, nfix.caseId);
      eq("§A7 · the case landed on not_proceeding", after.stage, "not_proceeding");
      ok("§A8 · …and it is the SAME row (id unchanged)", after.id === nfix.caseId, { before: nfix.caseId, after: after.id });
      const existsCount = await page.evaluate((id) => window.__mock.db.cases.filter((c) => c.id === id).length, nfix.caseId);
      eq("§A9 · the case row EXISTS in the mock DB — not gone, just closed", existsCount, 1);
      await openCase(page, nfix.caseId);
      const npGoneReopened = await page.evaluate(() => !document.querySelector("#case-mark-np"));
      ok("§A10 · reopening the now not_proceeding case shows #case-mark-np gone (Record reason takes over)", npGoneReopened);
      const stillNoDelBtn = await page.evaluate(() => !document.querySelector("#del-case-btn"));
      ok("§A11 · …and #del-case-btn is still absent on the closed case too", stillNoDelBtn);
      ok("§A · p2 console clean", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       §B · r44AttributeLine / r44NameKey / r44IsMiscInsurance — PURE
       ======================================================================= */
    {
      console.log("\n— §B · r44AttributeLine pure function, synthetic inputs");
      const page = await newPage(browser, "p4");
      const errBefore = (page.__err || []).length;

      const OWNER = "owner-xyz", ADV = "adv-xyz";
      const nameToId = { "wayne kellow": ADV };

      const r = await page.evaluate(({ OWNER, nameToId }) => ({
        matchedCaseWins: r44AttributeLine({ policy_group: "Mortgage", tran_type: "Commission receipt", addressee: "X", adviser_name: "Nobody Relevant" }, "mortgage", { assigned_to: "case-owner-id" }, nameToId, OWNER),
        namedCurrentAdviser: r44AttributeLine({ policy_group: "Mortgage", tran_type: "Commission receipt", addressee: "X", adviser_name: "Wayne Kellow" }, "mortgage", null, nameToId, OWNER),
        exBrokerFallsToOwner: r44AttributeLine({ policy_group: "Mortgage", tran_type: "Commission receipt", addressee: "X", adviser_name: "Hannah Ex-Broker" }, "mortgage", null, nameToId, OWNER),
        noMatchNoNameFallsToOwner: r44AttributeLine({ policy_group: "Mortgage", tran_type: "Commission receipt", addressee: "X", adviser_name: "" }, "mortgage", null, nameToId, OWNER),
        protectionAlwaysOwner: r44AttributeLine({ policy_group: "Life/Protection", tran_type: "Commission receipt", addressee: "X", adviser_name: "Wayne Kellow" }, "protection", null, nameToId, OWNER),
        renewalAlwaysOwner: r44AttributeLine({ policy_group: "Life/Protection", tran_type: "Renewal commission", addressee: "", adviser_name: "Wayne Kellow" }, "renewal", null, nameToId, OWNER),
        otherAlwaysOwner: r44AttributeLine({ policy_group: "", tran_type: "Adjustment", addressee: "X", adviser_name: "Wayne Kellow" }, "other", null, nameToId, OWNER),
        nonMortgageGroupAlwaysOwner: r44AttributeLine({ policy_group: "General Insurance", tran_type: "Commission receipt", addressee: "X", adviser_name: "Wayne Kellow" }, "mortgage", null, nameToId, OWNER),
        takebackFollowsMortgageRule_matched: r44AttributeLine({ policy_group: "Mortgage", tran_type: "Commission takeback", addressee: "X", adviser_name: "Someone Else" }, "takeback", { assigned_to: "case-owner-id" }, nameToId, OWNER),
        takebackFollowsMortgageRule_named: r44AttributeLine({ policy_group: "Mortgage", tran_type: "Commission takeback", addressee: "X", adviser_name: "Wayne Kellow" }, "takeback", null, nameToId, OWNER),
        neverNull_noOwnerEither: r44AttributeLine({ policy_group: "Mortgage", tran_type: "Commission receipt", addressee: "X", adviser_name: "" }, "mortgage", null, {}, null),
      }), { OWNER, nameToId });

      eq("§B1 · a matched case's assigned_to WINS over the sheet's adviser name", r.matchedCaseWins, "case-owner-id");
      eq("§B2 · unmatched mortgage, sheet names a CURRENT adviser → that adviser", r.namedCurrentAdviser, ADV);
      eq("§B3 · unmatched mortgage, sheet names an EX-BROKER (no profile) → owner", r.exBrokerFallsToOwner, OWNER);
      eq("§B4 · unmatched, no case, no name at all → owner", r.noMatchNoNameFallsToOwner, OWNER);
      eq("§B5 · protection → owner even though the name matches a current adviser", r.protectionAlwaysOwner, OWNER);
      eq("§B6 · renewal → owner", r.renewalAlwaysOwner, OWNER);
      eq("§B7 · other → owner", r.otherAlwaysOwner, OWNER);
      eq("§B8 · policy_group not \"Mortgage\" → owner regardless of kind classification", r.nonMortgageGroupAlwaysOwner, OWNER);
      eq("§B9 · takeback: matched case wins, same as mortgage", r.takebackFollowsMortgageRule_matched, "case-owner-id");
      eq("§B10 · takeback: unmatched falls to the named current adviser, same as mortgage", r.takebackFollowsMortgageRule_named, ADV);
      eq("§B11 · with NO owner fallback available either, the function still returns null (never throws) — the import always supplies one, this is just the pure function's own contract", r.neverNull_noOwnerEither, null);

      /* r44NameKey normalisation */
      const nk = await page.evaluate(() => ({
        trim: r44NameKey("  Wayne Kellow  "),
        caseFold: r44NameKey("WAYNE KELLOW"),
        collapseWhitespace: r44NameKey("Wayne    Kellow"),
        mixedAll: r44NameKey("  wAyNe   KELLOW "),
        nullish: r44NameKey(null),
        undef: r44NameKey(undefined),
      }));
      eq("§B12 · r44NameKey trims", nk.trim, "wayne kellow");
      eq("§B13 · r44NameKey lowercases", nk.caseFold, "wayne kellow");
      eq("§B14 · r44NameKey collapses internal whitespace", nk.collapseWhitespace, "wayne kellow");
      eq("§B15 · r44NameKey does all three at once", nk.mixedAll, "wayne kellow");
      eq("§B16 · r44NameKey(null) → \"\"", nk.nullish, "");
      eq("§B17 · r44NameKey(undefined) → \"\"", nk.undef, "");

      /* r44IsMiscInsurance directly */
      const mi = await page.evaluate(() => ({
        protection: r44IsMiscInsurance({ policy_group: "Mortgage" }, "protection"),
        renewal: r44IsMiscInsurance({ policy_group: "Mortgage" }, "renewal"),
        other: r44IsMiscInsurance({ policy_group: "Mortgage" }, "other"),
        mortgageNo: r44IsMiscInsurance({ policy_group: "Mortgage" }, "mortgage"),
        takebackNo: r44IsMiscInsurance({ policy_group: "Mortgage" }, "takeback"),
        nonMortgageGroupYes: r44IsMiscInsurance({ policy_group: "General Insurance" }, "mortgage"),
      }));
      ok("§B18 · protection/renewal/other kinds are ALWAYS misc insurance, regardless of group", mi.protection && mi.renewal && mi.other, mi);
      ok("§B19 · mortgage/takeback kinds with policy_group Mortgage are NOT misc insurance", !mi.mortgageNo && !mi.takebackNo, mi);
      ok("§B20 · a \"mortgage\"-kind line whose group is NOT Mortgage is still misc insurance (group overrides kind)", mi.nonMortgageGroupYes, mi);

      ok("§B · no console errors", noNewErr(page, errBefore), JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       Fixture cases for §C-§H, inserted straight into the mock, then a long-
       lived owner page (p4) carried through the rest of the file — same
       pattern tests/r44.js's §E-§I use.
       ======================================================================= */
    let p4;
    p4 = await newPage(browser, "p4");
    await bootXlsx(p4);
    await gotoMoney(p4);

    const staff = await p4.evaluate(() => {
      const { ownerId, nameToId } = r44StaffMaps();
      return { ownerId, nameToId, p2Id: nameToId["wayne kellow"], p3Id: nameToId["luke richards"] };
    });
    ok("§setup1 · owner resolved to p4 (Daniel Potts)", staff.ownerId === "p4", staff);
    ok("§setup2 · Wayne Kellow (p2) resolves via nameToId", staff.p2Id === "p2", staff);
    ok("§setup3 · Luke Richards (p3) resolves via nameToId", staff.p3Id === "p3", staff);

    const CaseX = await mkFixtureCase(p4, "Merridew" + tag(), { case: { lender: "Halifax", loan_amount: 200000, proc_fee: 800, assigned_to: "p2" } });
    const CaseY = await mkFixtureCase(p4, "Oakden" + tag(), { case: { lender: "Nationwide", loan_amount: 150000, proc_fee: 600, assigned_to: "p3" } });
    const CaseZ = await mkFixtureCase(p4, "Thornbeck" + tag(), { case: { lender: "Skipton", loan_amount: 100000, proc_fee: 900, assigned_to: "p3" } }); // for takeback-matched test

    /* =======================================================================
       §C · attribution at a REAL import
       ======================================================================= */
    let REFC;
    {
      console.log("\n— §C · attribution at import (real .xlsx via addScriptTag)");
      const errBefore = (p4.__err || []).length;
      REFC = "ATTR-" + tag();
      await importStatement(p4, REFC, [
        /* matched to CaseX (surname+lender), sheet names a DIFFERENT adviser than CaseX's owner — matched case must win */
        { d: new Date(2026, 6, 21), tt: "Commission receipt", addr: "Mr " + CaseX.last, prov: "Halifax", acct: "ACC-C1", ptype: "Mortgage", pgroup: "Mortgage", prem: 1500, g: 800, n: 720, adviser: "Luke Richards" },
        /* unmatched (no case anywhere named "Nemo"/lender "ObscureBank"), sheet names a current adviser → nameToId fallback */
        { d: new Date(2026, 6, 21), tt: "Commission receipt", addr: "Mr NemoNoMatch" + tag(), prov: "ObscureBank" + tag(), acct: "ACC-C2", ptype: "Mortgage", pgroup: "Mortgage", prem: 900, g: 400, n: 360, adviser: "Wayne Kellow" },
        /* unmatched, name normalisation (case + surrounding whitespace + doubled internal space) */
        { d: new Date(2026, 6, 21), tt: "Commission receipt", addr: "Mr NoMatchTwo" + tag(), prov: "AnotherObscureBank" + tag(), acct: "ACC-C3", ptype: "Mortgage", pgroup: "Mortgage", prem: 900, g: 450, n: 405, adviser: "  luke   RICHARDS " },
        /* unmatched, ex-broker name (no current profile) → owner */
        { d: new Date(2026, 6, 21), tt: "Commission receipt", addr: "Mr NoMatchThree" + tag(), prov: "YetAnotherBank" + tag(), acct: "ACC-C4", ptype: "Mortgage", pgroup: "Mortgage", prem: 900, g: 500, n: 450, adviser: "Hannah Ex-Broker" },
        /* protection, named to a CURRENT adviser → owner anyway */
        { d: new Date(2026, 6, 22), tt: "Commission receipt", addr: "Mr & Mrs ProtHolder" + tag(), prov: "Aviva", acct: "POL-C5", ptype: "Level Term", pgroup: "Life/Protection", prem: 42.5, g: 150, n: 135, adviser: "Wayne Kellow" },
        /* renewal → owner */
        { d: new Date(2026, 6, 23), tt: "Renewal commission", addr: "", prov: "Legal & General", acct: "POL-C6", reason: "VARIOUS", pgroup: "Life/Protection", g: 3.25, n: 2.93, adviser: "Wayne Kellow" },
        /* other/non-mortgage group → owner */
        { d: new Date(2026, 6, 24), tt: "Adjustment", addr: "", prov: "", acct: "ACC-C7", pgroup: "", g: 0.5, n: 0.5, adviser: "Wayne Kellow" },
        /* takeback matched to CaseZ (surname+lender), sheet names a different adviser → matched case wins, same as mortgage */
        { d: new Date(2026, 6, 25), tt: "Commission takeback", addr: "Ms " + CaseZ.last, prov: "Skipton", acct: "ACC-C8", ptype: "Mortgage", pgroup: "Mortgage", prem: 1000, g: -900, n: -810, adviser: "Wayne Kellow" },
        /* takeback unmatched, named to a current adviser → nameToId fallback, same as mortgage */
        { d: new Date(2026, 6, 26), tt: "Commission takeback", addr: "Mr NoMatchFour" + tag(), prov: "SomeOtherBank" + tag(), acct: "ACC-C9", ptype: "Mortgage", pgroup: "Mortgage", prem: 900, g: -300, n: -270, adviser: "Wayne Kellow" },
      ]);

      const cLines = await p4.evaluate((ref) => {
        const st = window.__mock.db.commission_statements.filter((s) => s.ref === ref)[0];
        return window.__mock.db.commission_lines.filter((l) => l.statement_id === st.id)
          .map((l) => ({ acct: l.account_number, attr: l.attributed_to, matched: l.matched_case_id }));
      }, REFC);
      const byAcct = {};
      cLines.forEach((l) => { byAcct[l.acct] = l; });

      eq("§C1 · matched mortgage → the CASE's adviser (p2), NOT the sheet's named adviser (Luke)", byAcct["ACC-C1"].attr, "p2");
      ok("§C1b · …and it really did match CaseX", byAcct["ACC-C1"].matched === CaseX.caseId, byAcct["ACC-C1"]);
      eq("§C2 · unmatched mortgage, sheet names Wayne Kellow → p2", byAcct["ACC-C2"].attr, "p2");
      eq("§C3 · unmatched mortgage, sheet names \"  luke   RICHARDS \" (normalised) → p3", byAcct["ACC-C3"].attr, "p3");
      eq("§C4 · unmatched mortgage, sheet names an ex-broker → owner (p4)", byAcct["ACC-C4"].attr, "p4");
      eq("§C5 · protection named to Wayne Kellow → owner (p4) anyway", byAcct["POL-C5"].attr, "p4");
      eq("§C6 · renewal → owner (p4)", byAcct["POL-C6"].attr, "p4");
      eq("§C7 · other/non-mortgage-group → owner (p4)", byAcct["ACC-C7"].attr, "p4");
      eq("§C8 · matched takeback → the CASE's adviser (p3), NOT the sheet's named Wayne", byAcct["ACC-C8"].attr, "p3");
      ok("§C8b · …and it really did match CaseZ", byAcct["ACC-C8"].matched === CaseZ.caseId, byAcct["ACC-C8"]);
      eq("§C9 · unmatched takeback, sheet names Wayne Kellow → p2, same rule as mortgage", byAcct["ACC-C9"].attr, "p2");
      ok("§C10 · NOT ONE line in this 9-line batch is null-attributed", cLines.every((l) => l.attr != null && l.attr !== ""), cLines);

      ok("§C · no console errors", noNewErr(p4, errBefore), JSON.stringify(p4.__err));
    }

    /* =======================================================================
       §D · confirm follows the case
       ======================================================================= */
    {
      console.log("\n— §D · confirming a mortgage receipt re-homes attribution onto the case's TRUE adviser");
      const errBefore = (p4.__err || []).length;
      /* ACC-C2 was attributed to p2 (Wayne) at import via the name fallback
         (no case matched it). Now confirm it against CaseY, owned by p3
         (Luke) — a DIFFERENT adviser — and prove attribution follows the
         case, not the import guess. */
      const lineId = await findLineId(p4, "mortgage", "ACC-C2");
      const preAttr = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0].attributed_to, lineId);
      eq("§D1 · pre-confirm: still attributed to p2 (the import-time guess)", preAttr, "p2");

      const caseBefore = await readCase(p4, CaseY.caseId);
      ok("§D2 · CaseY starts with no proc fee paid date", !caseBefore.proc_fee_paid_at, caseBefore.proc_fee_paid_at);

      await p4.evaluate((d) => { const s = document.querySelector(`#recon-pick-${d.id}`); if (s) { s.value = d.caseId; s.dispatchEvent(new Event("change", { bubbles: true })); } }, { id: lineId, caseId: CaseY.caseId });
      await p4.click(`#recon-confirm-${lineId}`);
      await wait(p4, 1400);

      const postAttr = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0].attributed_to, lineId);
      eq("§D3 · post-confirm: attribution moved to p3 (CaseY's TRUE adviser) — the import guess is overridden", postAttr, "p3");
      const matchStatus = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0].match_status, lineId);
      eq("§D4 · the line is confirmed", matchStatus, "confirmed");

      /* No R44 regression: the fee-paid write still happens exactly as before R48. */
      const caseAfter = await readCase(p4, CaseY.caseId);
      ok("§D5 · proc_fee_paid_at IS set (the R44 fee-paid write survived R48)", !!caseAfter.proc_fee_paid_at, caseAfter.proc_fee_paid_at);
      const notesY = await notesFor(p4, CaseY.caseId);
      ok("§D6 · a case note was written naming the banked fee (R44 behaviour unchanged)", notesY.some((b) => /^Proc fee .* banked .*/.test(b)), notesY.slice(-2));

      ok("§D · no console errors", noNewErr(p4, errBefore), JSON.stringify(p4.__err));
    }

    /* =======================================================================
       §E · manual attribution
       ======================================================================= */
    {
      console.log("\n— §E · r44AttributeLineTo + the #recon-attr-* DOM control");
      const errBefore = (p4.__err || []).length;

      /* ACC-C3 is an open (still-pending) mortgage line, currently attributed
         to p3 at import. Manually re-attribute it to p2 via the pure
         function, called the same way the review's own click handler does. */
      const lineId = await findLineId(p4, "mortgage", "ACC-C3");
      await p4.evaluate((id) => window.r44AttributeLineTo(id, "p2", false), lineId);
      await wait(p4, 500);
      const l1 = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0], lineId);
      eq("§E1 · r44AttributeLineTo sets attributed_to directly", l1.attributed_to, "p2");
      ok("§E2 · match_status is left AS-IS (still whatever it was, not forced to na)", l1.match_status === "unmatched" || l1.match_status === "suggested", l1.match_status);

      /* noCase variant: also parks match_status at "na". */
      const lineId2 = await findLineId(p4, "mortgage", "ACC-C4");
      await p4.evaluate((id) => window.r44AttributeLineTo(id, "p3", true), lineId2);
      await wait(p4, 500);
      const l2 = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0], lineId2);
      eq("§E3 · noCase=true also sets attributed_to", l2.attributed_to, "p3");
      eq("§E4 · noCase=true parks match_status at \"na\"", l2.match_status, "na");

      /* Refused on a confirmed line — reuse §D's now-confirmed ACC-C2 line. */
      const confirmedId = await p4.evaluate(() => {
        const l = window.__mock.db.commission_lines.filter((x) => x.account_number === "ACC-C2")[0];
        return l ? l.id : null;
      });
      ok("§E5 · found the confirmed ACC-C2 line from §D", !!confirmedId);
      const preConfirmedAttr = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0].attributed_to, confirmedId);
      await p4.evaluate((id) => window.r44AttributeLineTo(id, "p1", false), confirmedId);
      await wait(p4, 500);
      const refusedToast = (await toastText(p4)) || "";
      ok("§E6 · confirmed line refuses, toast names the reason", /confirmed.*attribution follows the case/i.test(refusedToast), refusedToast);
      const postConfirmedAttr = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0].attributed_to, confirmedId);
      eq("§E7 · …and attribution is UNCHANGED", postConfirmedAttr, preConfirmedAttr);

      /* The #recon-attr-<id> DOM control round-trips through a real click. */
      const lineId3 = await findLineId(p4, "mortgage", "ACC-C1"); // still open in this review? re-check: C1 was matched+not yet confirmed
      const controlPresent = await p4.evaluate((id) => !!document.querySelector(`#recon-attr-${id}`), lineId3);
      ok("§E8 · the attribute-to select is present on an open line", controlPresent);
      const before3 = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0].attributed_to, lineId3);
      await p4.evaluate((id) => {
        const sel = document.querySelector(`#recon-attr-${id}`);
        sel.value = "p3";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }, lineId3);
      await p4.click(`#recon-attr-set-${lineId3}`);
      await wait(p4, 700);
      const after3 = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0].attributed_to, lineId3);
      eq("§E9 · clicking Set person round-trips the select's value into attributed_to", after3, "p3");
      ok("§E10 · …and it actually changed something (not a no-op fixture)", before3 !== after3 || before3 == null, { before: before3, after: after3 });
      /* The re-rendered control now shows p3 selected by default. */
      const selRerendered = await p4.evaluate((id) => { const s = document.querySelector(`#recon-attr-${id}`); return s ? s.value : null; }, lineId3);
      eq("§E11 · the re-rendered select defaults to the NEW current attribution", selRerendered, "p3");

      /* noCase checkbox through the real control too. */
      const lineId4 = await findLineId(p4, "mortgage", "ACC-C1");
      await p4.evaluate((id) => { const c = document.querySelector(`#recon-attr-nocase-${id}`); if (c) { c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); } }, lineId4);
      await p4.click(`#recon-attr-set-${lineId4}`);
      await wait(p4, 700);
      const l4 = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0], lineId4);
      eq("§E12 · the DOM checkbox round-trips through to noCase → match_status \"na\"", l4.match_status, "na");

      ok("§E · no console errors", noNewErr(p4, errBefore), JSON.stringify(p4.__err));
    }

    /* =======================================================================
       §F · the tally
       ======================================================================= */
    let REFF;
    {
      console.log("\n— §F · the per-person tally (r44TallyHtml) + needs-you queue count");
      const errBefore = (p4.__err || []).length;
      REFF = "TALLY-" + tag();
      const CaseT = await mkFixtureCase(p4, "Winterbourne" + tag(), { case: { lender: "TSB", loan_amount: 90000, proc_fee: 700, assigned_to: "p2" } });
      await importStatement(p4, REFF, [
        /* two lines that land on p2 (matched to CaseT) */
        { d: new Date(2026, 7, 1), tt: "Commission receipt", addr: "Mr " + CaseT.last, prov: "TSB", acct: "ACC-F1", ptype: "Mortgage", pgroup: "Mortgage", prem: 1000, g: 700, n: 630, adviser: "Wayne Kellow" },
        { d: new Date(2026, 7, 2), tt: "Commission takeback", addr: "Mr " + CaseT.last, prov: "TSB", acct: "ACC-F1B", ptype: "Mortgage", pgroup: "Mortgage", prem: 1000, g: -100, n: -90, adviser: "Wayne Kellow" },
        /* misc insurance, owner's row */
        { d: new Date(2026, 7, 3), tt: "Commission receipt", addr: "Mr & Mrs Insured" + tag(), prov: "Aviva", acct: "POL-F2", ptype: "Level Term", pgroup: "Life/Protection", prem: 30, g: 120, n: 108, adviser: "Wayne Kellow" },
        { d: new Date(2026, 7, 4), tt: "Renewal commission", addr: "", prov: "Legal & General", acct: "POL-F3", reason: "VARIOUS", pgroup: "Life/Protection", g: 5, n: 4.5, adviser: "Wayne Kellow" },
        /* a line that WILL be dismissed — must be excluded from every sum */
        { d: new Date(2026, 7, 5), tt: "Commission receipt", addr: "Mr ToDismiss" + tag(), prov: "SomeBank" + tag(), acct: "ACC-F4", ptype: "Mortgage", pgroup: "Mortgage", prem: 1000, g: 900, n: 810, adviser: "Wayne Kellow" },
      ]);
      /* dismiss the last line */
      const dismissId = await findLineId(p4, "mortgage", "ACC-F4");
      await p4.evaluate((id) => window.r44DismissLine(id), dismissId);
      await wait(p4, 500);
      const dismissedStatus = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0].match_status, dismissId);
      eq("§F0 · the line really is dismissed", dismissedStatus, "dismissed");

      /* manually null-attribute one line, to prove the Unassigned bucket */
      const unassignId = await findLineId(p4, "protection", "POL-F2");
      await p4.evaluate((id) => window.r44AttributeLineTo(id, "", false), unassignId);
      await wait(p4, 500);
      const nulled = await p4.evaluate((id) => window.__mock.db.commission_lines.filter((l) => String(l.id) === String(id))[0].attributed_to, unassignId);
      eq("§F0b · the manually-nulled line really has attributed_to === null", nulled, null);

      /* Independently compute expected sums straight from reconState.lines —
         never imported from r44TallyHtml itself, per the standing rule. */
      const computed = await p4.evaluate(() => {
        const st = reconState;
        const byPerson = {};
        let unassignedNet = 0, unassignedCount = 0;
        let ownerInsurance = 0;
        st.lines.forEach((l) => {
          if (l.match_status === "dismissed") return;
          const net = Number(l.banked_net || 0);
          if (!l.attributed_to) { unassignedNet += net; unassignedCount++; return; }
          byPerson[l.attributed_to] = (byPerson[l.attributed_to] || 0) + net;
          if (l.attributed_to === st.ownerId && r44IsMiscInsurance(l)) ownerInsurance += net;
        });
        const needs = st.lines.filter(r44NeedsYou).length;
        return { byPerson, unassignedNet, unassignedCount, ownerInsurance, needs, ownerId: st.ownerId, fmtM2: (n) => fmtM2(n) };
      });

      const domRows = await p4.evaluate(() => [...document.querySelectorAll("#recon-tally .recon-tally-row")].map((r) => ({
        person: r.dataset.person, text: r.textContent,
      })));
      const p2Row = domRows.find((r) => r.person === "p2");
      ok("§F1 · p2's tally row exists", !!p2Row, domRows);
      const p2ExpectedTxt = await p4.evaluate((n) => fmtM2(n), computed.byPerson.p2 || 0);
      ok(`§F2 · p2's tally net matches the independently-computed sum (${p2ExpectedTxt})`, p2Row && p2Row.text.indexOf(p2ExpectedTxt) >= 0, { row: p2Row, expected: p2ExpectedTxt });

      const dismissedInSums = await p4.evaluate(() => {
        const l = window.__mock.db.commission_lines.filter((x) => x.account_number === "ACC-F4")[0];
        // ACC-F4 was on the same adviser (p2) as ACC-F1 — if it leaked into the sum, p2's total would be 810 too high.
        return l && l.match_status === "dismissed";
      });
      ok("§F3 · the dismissed line is confirmed dismissed (excluded from the tally by construction)", dismissedInSums);

      const ownerRow = domRows.find((r) => r.person === "p4");
      ok("§F4 · owner's row is annotated with the misc-insurance slice", ownerRow && /incl\..*insurance/.test(ownerRow.text), ownerRow);
      const ownerInsExpectedTxt = await p4.evaluate((n) => fmtM2(n), computed.ownerInsurance);
      ok(`§F5 · owner's insurance annotation matches the independently-computed misc-insurance sum (${ownerInsExpectedTxt})`, ownerRow && ownerRow.text.indexOf(ownerInsExpectedTxt) >= 0, { row: ownerRow, expected: ownerInsExpectedTxt });

      const unassignedRow = domRows.find((r) => r.person === "");
      ok("§F6 · a null-attributed line shows under \"Unassigned — needs you\"", !!unassignedRow, domRows);
      ok(`§F7 · its count (${computed.unassignedCount}) is in the row text`, unassignedRow && unassignedRow.text.indexOf(`(${computed.unassignedCount})`) >= 0, unassignedRow);

      const needsCountDom = await p4.evaluate(() => Number((document.querySelector("#recon-needs-count") || {}).textContent || "-1"));
      eq("§F8 · #recon-needs-count matches an independently-computed r44NeedsYou count", needsCountDom, computed.needs);
      const needsLineCount = await p4.evaluate(() => document.querySelectorAll('.recon-line[data-needs="1"]').length);
      ok("§F9 · every needs-you line in the DOM is flagged data-needs=\"1\", and the count is at least the queue's rendered line count", needsCountDom >= needsLineCount, { needsCountDom, needsLineCount });
      const nulledLineNeeds = await p4.evaluate((id) => document.querySelector(`.recon-line[data-line="${id}"]`).dataset.needs, unassignId);
      eq("§F10 · the manually-unassigned line itself carries data-needs=\"1\"", nulledLineNeeds, "1");

      ok("§F · no console errors", noNewErr(p4, errBefore), JSON.stringify(p4.__err));
    }

    /* =======================================================================
       §G · owner-only gating
       ======================================================================= */
    {
      console.log("\n— §G · owner-only — p1 admin and p2 adviser see no recon panel/tally/queue");
      for (const persona of ["p1", "p2"]) {
        const page = await newPage(browser, persona);
        const errBefore = (page.__err || []).length;
        await gotoMoney(page, 1200);
        ok(`§G1 · ${persona}: #money-recon-panel not visible via nav()`, !(await page.isVisible("#money-recon-panel")));
        ok(`§G2 · ${persona}: no #recon-tally anywhere in the DOM`, (await page.evaluate(() => document.querySelectorAll("#recon-tally").length)) === 0);
        ok(`§G3 · ${persona}: no .recon-needs-line queue rows anywhere`, (await page.evaluate(() => document.querySelectorAll(".recon-needs-line").length)) === 0);

        /* Force the renderer to run, to prove the panel's OWN self-gate. */
        const forced = await page.evaluate(async () => {
          document.querySelector("#page-money").classList.remove("hidden");
          await window.loadMoneyPage();
          return {
            reconHidden: document.querySelector("#money-recon-panel").classList.contains("hidden"),
            reviewEmpty: (document.querySelector("#recon-review") || {}).innerHTML === "",
            tallyCount: document.querySelectorAll("#recon-tally").length,
          };
        });
        ok(`§G4 · ${persona}: forced loadMoneyPage() still hides #money-recon-panel`, forced.reconHidden, forced);
        ok(`§G5 · ${persona}: #recon-review left empty, no tally leaked into the DOM`, forced.reviewEmpty && forced.tallyCount === 0, forced);

        /* r44AttributeLineTo / r44AttrControl are unreachable (no reconState),
           but the ACTUAL enforcement is the RLS-style write gate underneath —
           prove a direct write to commission_lines.attributed_to comes back
           42501 for a non-owner, same as every other R44/R48 write. */
        const write = await page.evaluate(() => window.__mockDb.from("commission_lines").update({ attributed_to: "p1" }).eq("id", "whatever"));
        eq(`§G6 · ${persona}: a direct write to commission_lines.attributed_to is refused 42501`, write.error && write.error.code, "42501");
        const read = await page.evaluate(async () => (await window.__mockDb.from("commission_lines").select("*")).data.length);
        eq(`§G7 · ${persona}: reads of commission_lines come back empty`, read, 0);

        ok(`§G · ${persona} console clean`, noNewErr(page, errBefore), JSON.stringify(page.__err));
        await page.close();
      }
    }

    /* =======================================================================
       §H · XSS spot-check
       ======================================================================= */
    {
      console.log("\n— §H · hostile adviser_name/provider render inert in the tally + needs-you queue");
      const errBefore = (p4.__err || []).length;
      const REFX = "R48XSS-" + tag();
      await p4.evaluate((ref) => { window.__R48XSS = 0; }, REFX);
      await importStatement(p4, REFX, [
        { d: new Date(2026, 7, 11), tt: "Commission receipt", addr: '<img src=x onerror="window.__R48XSS=1">', prov: '"><svg onload="window.__R48XSS=2">', acct: "ACC-XSS", ptype: "Mortgage", pgroup: "Mortgage", prem: 1, g: 10, n: 9, adviser: '<script>window.__R48XSS=3</script>Adviser' },
      ]);
      const xssSafe = await p4.evaluate(() => ({
        flag: window.__R48XSS,
        imgs: document.querySelectorAll("#recon-review img, #recon-review svg").length,
        reviewTxt: (document.querySelector("#recon-review") || {}).textContent || "",
      }));
      ok("§H1 · no injected script/image/svg actually ran", !xssSafe.flag && xssSafe.imgs === 0, xssSafe);
      ok("§H2 · the raw markup is present as INERT TEXT in the review (tally+queue share this DOM)", /<img src=x/.test(xssSafe.reviewTxt), xssSafe.reviewTxt.slice(0, 250));
      /* The hostile line itself: no case/name matched it, so it lands attributed
         to the owner (r44AttributeLine's own fallback) and is still a pending
         matchable line, so it is in the needs-you queue — check its row
         specifically renders the hostile provider/adviser text inertly. */
      const xssLine = await p4.evaluate(() => {
        const el = [...document.querySelectorAll('.recon-line[data-kind="mortgage"]')].find((e) => e.textContent.indexOf("ACC-XSS") >= 0);
        return el ? { needs: el.dataset.needs, html: el.innerHTML, hasImgEl: !!el.querySelector("img,svg") } : null;
      });
      ok("§H3 · the hostile line was found and rendered", !!xssLine, xssLine);
      ok("§H4 · it carries data-needs=\"1\" (pending matchable → in the queue)", xssLine && xssLine.needs === "1", xssLine);
      ok("§H5 · …and its own markup has no live img/svg element either", xssLine && !xssLine.hasImgEl, xssLine);
      ok("§H6 · its line-row HTML has the escaped entity, not a live tag", xssLine && /&lt;img src=x/.test(xssLine.html), xssLine && xssLine.html.slice(0, 200));

      ok("§H · no console errors", noNewErr(p4, errBefore), JSON.stringify(p4.__err));
    }

    /* =======================================================================
       §I · no console errors across the whole owner session
       ======================================================================= */
    {
      console.log("\n— §I · console clean across the whole owner run (§C-§H)");
      ok("§I1 · owner console clean end to end", (p4.__err || []).length === 0, p4.__err);
      await p4.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r48: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
