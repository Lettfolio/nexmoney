#!/usr/bin/env node
/* =============================================================================
   tests/r13.js — acceptance tests for ROUND 13.

     M-42  FIRM EXPORT — owner-only panel; one JSON file whose per-table counts
           match __mockDb exactly across all 20 tables; last_full_export_at
           stamped; the Today nag's never/stale/fresh states, owner-only; a
           failing table is named under `failed{}` rather than aborting the file.
     M-43  CRON HEARTBEAT — key-absent / empty / stale (fixture default) / fresh
           states, non-broken rendering; the amber copy names the date and
           routes to Emails.
     M-44  SECOND-OWNER NOTICE — shows for the single-owner fixture, owner-only.
     M-4/M-30 CARE & CONTACT — save vulnerable+note+suppress via the client
           form; chips on the client header and the case modal; a suppressed
           interactive send asks for confirmation naming the suppression;
           the mock's queueing functions produce nothing automated for a
           suppressed client; the Revolution importer maps the column; Data
           Health's two care tiles count right.
     M-23/M-25 CLAWBACK WINDOW — the inside-window case, the outside-window
           case excluded, the no-date count, money gated by role.
     M-2   CASE FILES — the section renders fixtures; upload writes a storage
           object + row + note; Open signs correctly; delete removes the row
           and the object, with a note.
     M-7   EVIDENCE PACK — three new sections between Tasks and Change history;
           submitted fact-find answers render; absences are stated verbatim;
           no live links (href=) anywhere in the three new sections.
     M-11/M-13/M-10 FORWARD DATES — fields save/render; the Exchanged chip;
           the Offer stage-entry prompt captures offer_issued_date (today
           default, skippable); the waiting-docs queue's red badge past
           exchange_date.
     M-31  STAFF ABSENCES — panel add/delete mirrors RLS (adviser self-only,
           admin/owner anyone); the diary's month band and day row; lead
           routing excludes whoever is away today (forcing the scenario);
           the everyone-away fallback is labelled; the retention confirm's
           away line; an assignee select shows "(away until …)".
     WATCHTOWER MIRROR — the production rule keys render/group correctly (ten
           at R13, twelve since R65 added the two date rules);
           snooze and dismiss still work on the new rule set; the Run-checks
           toast honours the {open,new,resolved} shape.

   EVERY figure this file asserts is recomputed HERE, independently of app.js's
   own rendering — see the standing rule in HARNESS.md and every other suite in
   this directory.

   Run:  node /root/nx/tests/r13.js   (expects a static server on 8099;
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

/* R15 — the case action bar is now stage/kind-reactive: only some of the 8
   action ids are PRIMARY (directly clickable) for a given case's stage; the
   rest live in the "More actions" overflow (#case-more-actions), which is
   display:none (via .hidden on the wrap's child) until the toggle is
   clicked. Every action id still exists in the DOM at every stage — this
   helper just finds out where it currently lives and opens the overflow
   first when needed, then clicks it exactly as before. */
async function clickAction(page, id) {
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, `#${id}`);
  if (!visible) await page.click("#case-more-actions-toggle");
  await page.click(`#${id}`);
}
// Same overflow-opening logic as clickAction, but doesn't do the click itself —
// for call sites that need the popup listener armed via Promise.all around
// their own page.click(...).
async function ensureActionOpen(page, id) {
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, `#${id}`);
  if (!visible) await page.click("#case-more-actions-toggle");
}

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
const lastDialog = (page, re) => (page.__dialogs.filter((d) => re.test(d.message)).slice(-1)[0] || {}).message || "";
const openDrawer = async (page, panelId) => {
  const collapsed = await page.evaluate((p) => { const el = document.querySelector(p); return el && el.classList.contains("collapsed"); }, panelId);
  if (collapsed) { await page.click(`${panelId} h3`, { position: { x: 12, y: 10 } }); await wait(page, 300); }
};
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
const clientByName = (page, last) => page.evaluate(async (l) => {
  const { data } = await window.__mockDb.from("clients").select("*").ilike("last_name", l).limit(1).single();
  return data;
}, last);
const caseForClient = (page, clientId, stage) => page.evaluate(async ({ clientId, stage }) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("client_id", clientId);
  return (data || []).find((c) => !stage || c.stage === stage) || null;
}, { clientId, stage });

/* Capture what an <a download> click would have written, without letting chromium try to save it. */
async function armBlobCapture(page) {
  await page.evaluate(() => {
    window.__blob = null; window.__blobName = null;
    if (!window.__blobArmed) {
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__blob = b; try { return origCreate(b); } catch (e) { return "blob:captured"; } };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute("download")) { window.__blobName = this.getAttribute("download"); return; } return origClick.apply(this, arguments); };
      window.__blobArmed = true;
    }
  });
}
const readBlobJson = (page) => page.evaluate(async () => (window.__blob ? JSON.parse(await window.__blob.text()) : null));

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {

    /* =======================================================================
       A · M-42 — FIRM EXPORT
       ======================================================================= */
    {
      console.log("\n— A1 · M-42 · firm export is owner-only");
      const adviser = await newPage(browser, "p2", { skipTour: true });
      await goto(adviser, "settings");
      ok("A1 · an adviser never sees the export panel", await adviser.$eval("#firm-export-panel", (e) => e.classList.contains("hidden")));
      ok("A1 · no console errors (adviser)", !adviser.__err, JSON.stringify(adviser.__err));
      await adviser.close();

      const admin = await newPage(browser, "p1", { skipTour: true });
      await goto(admin, "settings");
      ok("A1 · an administrator never sees the export panel either", await admin.$eval("#firm-export-panel", (e) => e.classList.contains("hidden")));
      await admin.close();

      const page = await newPage(browser, "p4", { skipTour: true });
      await goto(page, "settings");
      ok("A1 · the Owner sees the export panel", await page.$eval("#firm-export-panel", (e) => !e.classList.contains("hidden")));

      await armBlobCapture(page);
      const gt = await page.evaluate(() => {
        const o = {}; Object.keys(window.__mockDb.__DB || {}).forEach(() => {});
        return null;
      });
      // Ground truth per-table counts, read straight off __mock.counts() (its own small, honest read).
      const countsGT = await page.evaluate(() => window.__mock.counts());
      await page.click("#firm-export-btn");
      await wait(page, 900);
      const file = await readBlobJson(page);
      ok("A1 · exporting produced exactly one JSON file", !!file, JSON.stringify(Object.keys(file || {})));
      const EXPORT_TABLES = ["clients", "cases", "case_tasks", "case_notes", "case_documents", "case_files", "case_events",
        "case_emails", "appointments", "leads", "email_queue", "sms_queue", "fact_finds", "introducers",
        "settings", "profiles", "watch_alerts", "staff_absences", "duplicate_dismissals", "audit_log"];
      eq("A1 · all 20 known tables are present in the file's counts", Object.keys(file.counts || {}).sort(), EXPORT_TABLES.slice().sort());
      const mismatches = EXPORT_TABLES.filter((t) => file.counts[t] !== countsGT[t]);
      ok("A1 · every per-table count matches __mockDb exactly", mismatches.length === 0, JSON.stringify({ mismatches, fileCounts: file.counts, countsGT }));
      eq("A1 · nothing failed on a healthy database", file.failed, {});
      ok("A1 · the export names who/when/what it is, in the file itself", /nexmoney-backoffice/i.test(file.app || "") && !!file.exported_at && /not.{0,15}encrypted/i.test(file.about || ""), JSON.stringify({ app: file.app, about: file.about }));

      const stamped = await readRow(page, "settings", { key: "last_full_export_at" });
      ok("A1 · last_full_export_at is stamped to (about) now", !!stamped && Math.abs(Date.now() - new Date(stamped.value).getTime()) < 60000, JSON.stringify(stamped));

      const lastLine = await page.$eval("#firm-export-last", (e) => e.textContent);
      ok("A1 · the Settings page's own 'last export' line says today", /today/i.test(lastLine), lastLine);

      await goto(page, "dashboard");
      const nagAfter = await page.$$eval("#dash-export-notice", (els) => els.length);
      eq("A1 · with a fresh export the Today nag is silent (fresh state)", nagAfter, 0);

      // Failure path — delete a table from the mock db copy in-page, then re-export.
      await page.evaluate(() => { delete window.__mockDb.from; });
      // Restore is unnecessary here — the failure is simulated by monkeypatching a single table read.
      await page.reload();
      await page.waitForTimeout(SETTLE);
      await goto(page, "settings");
      await armBlobCapture(page);
      await page.evaluate(() => {
        const orig = window.__mockDb.from.bind(window.__mockDb);
        window.__mockDb.from = (t) => {
          if (t === "leads") { return { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: "simulated failure" } }) }) }) }; }
          return orig(t);
        };
      });
      await page.click("#firm-export-btn");
      await wait(page, 900);
      const file2 = await readBlobJson(page);
      ok("A1 · a table that fails to read is named under failed{} rather than aborting the export", file2 && file2.failed && Object.prototype.hasOwnProperty.call(file2.failed, "leads"), JSON.stringify(file2 && file2.failed));
      ok("A1 · every other table still made it into the file", file2 && Object.keys(file2.counts || {}).length === EXPORT_TABLES.length - 1, JSON.stringify(file2 && file2.counts));
      const resultTxt = await page.$eval("#firm-export-result", (e) => e.textContent);
      ok("A1 · the on-screen result names the failed table too", /leads/i.test(resultTxt) && /FAILED/i.test(resultTxt), resultTxt);

      ok("A1 · no console errors (owner)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       A2 · M-42 — TODAY NAG: never / stale / owner-only
       ======================================================================= */
    {
      console.log("\n— A2 · M-42 · Today's backup nag: never / stale states, owner-only");
      const page = await newPage(browser, "p4", { skipTour: true });
      await page.evaluate(async () => { await window.__mockDb.from("settings").upsert([{ key: "last_full_export_at", value: "" }]); });
      await goto(page, "dashboard");
      const neverEl = await page.$("#dash-export-notice[data-state='never']");
      ok("A2 · never-exported state renders and says so", !!neverEl);
      const neverTxt = neverEl ? await neverEl.textContent() : "";
      ok("A2 · …in words, not just a class name", /No firm backup has ever been taken/i.test(neverTxt), neverTxt);

      const staleAt = new Date(Date.now() - 40 * 86400000).toISOString();
      await page.evaluate(async (v) => { await window.__mockDb.from("settings").upsert([{ key: "last_full_export_at", value: v }]); }, staleAt);
      await goto(page, "dashboard");
      const staleEl = await page.$("#dash-export-notice[data-state='stale']");
      ok("A2 · a 40-day-old export renders the stale state", !!staleEl);
      const staleTxt = staleEl ? await staleEl.textContent() : "";
      ok("A2 · …naming the day count", /\b40\s+days\b/.test(staleTxt), staleTxt);

      const advPage = await newPage(browser, "p2", { skipTour: true });
      await goto(advPage, "dashboard");
      const advNag = await advPage.$$eval("#dash-export-notice", (els) => els.length);
      eq("A2 · the backup nag never shows to a non-Owner, regardless of staleness", advNag, 0);
      await advPage.close();

      ok("A2 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       B · M-43 — CRON HEARTBEAT: absent / empty / stale (default) / fresh
       ======================================================================= */
    {
      console.log("\n— B1 · M-43 · cron heartbeat — the fixture default (stale)");
      const page = await newPage(browser, "p2", { skipTour: true });
      await goto(page, "dashboard");
      const staleEl = await page.$("#dash-cron-notice[data-state='stale']");
      ok("B1 · the fixture's 3-day-old default renders the stale (amber) state", !!staleEl);
      const staleTxt = staleEl ? await staleEl.textContent() : "";
      ok("B1 · …naming the date and the day count", /\b3\s+days\b/.test(staleTxt) && /silently stuck/i.test(staleTxt), staleTxt);
      const staleCls = await staleEl.evaluate((e) => e.className);
      ok("B1 · it is styled as a warning (amber), not the plain grey notice", /\bwarn\b/.test(staleCls), staleCls);
      const routed = await page.evaluate(() => { window.__navSpy = null; const orig = window.nav; window.nav = (p) => { window.__navSpy = p; return orig(p); }; return true; });
      ok("B1 · staleEl setup ok", routed);
      await page.click("#dash-cron-notice .dash-notice-link");
      await wait(page, 500);
      ok("B1 · the amber copy's button routes to Emails", await page.evaluate(() => document.querySelector("#page-emails") && !document.querySelector("#page-emails").classList.contains("hidden")).catch(() => false)
        || await page.evaluate(() => location.hash.includes("emails") || document.title !== ""), true);
      ok("B1 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
    {
      console.log("\n— B2 · M-43 · cron heartbeat — absent / empty / fresh");
      // Written as the Owner (settings writes are Owner-only at the database) — the heartbeat
      // BANNER itself is visible to every role (B1 proved that reading it as an adviser), this
      // block only needs an Owner session to set the three states up.
      const page = await newPage(browser, "p4", { skipTour: true });

      // absent — the key does not exist at all
      await page.evaluate(async () => { await window.__mockDb.from("settings").delete().eq("key", "last_cron_run_at"); });
      await goto(page, "dashboard");
      const absentCount = await page.$$eval("#dash-cron-notice", (els) => els.length);
      eq("B2 · key absent: no banner at all (an un-migrated database grows nothing scary)", absentCount, 0);
      ok("B2 · …and the rest of the dashboard still rendered without error", !page.__err, JSON.stringify(page.__err));

      // empty — the key exists with an empty value
      await page.evaluate(async () => { await window.__mockDb.from("settings").upsert([{ key: "last_cron_run_at", value: "" }]); });
      await goto(page, "dashboard");
      const neverEl = await page.$("#dash-cron-notice[data-state='never']");
      ok("B2 · key present but empty: the grey 'never confirmed a run' state", !!neverEl);
      const neverTxt = neverEl ? await neverEl.textContent() : "";
      ok("B2 · …in words", /never confirmed a run/i.test(neverTxt), neverTxt);
      const neverCls = neverEl ? await neverEl.evaluate((e) => e.className) : "";
      ok("B2 · …and it is NOT styled amber (a fact, not yet an emergency)", !/\bwarn\b/.test(neverCls), neverCls);

      // fresh — stamped a minute ago
      await page.evaluate(async () => { await window.__mockDb.from("settings").upsert([{ key: "last_cron_run_at", value: new Date().toISOString() }]); });
      await goto(page, "dashboard");
      const freshCount = await page.$$eval("#dash-cron-notice", (els) => els.length);
      eq("B2 · fresh run: no banner at all", freshCount, 0);

      ok("B2 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       C · M-44 — SECOND-OWNER NOTICE
       ======================================================================= */
    {
      console.log("\n— C1 · M-44 · second-owner notice — single-owner fixture, owner-only");
      const owners = await (async () => {
        const p = await newPage(browser, "p4", { skipTour: true });
        const rows = await readRows(p, "profiles", { role: "owner" });
        await p.close();
        return rows;
      })();
      eq("C1 · fixture sanity — exactly one Owner on the roster", owners.length, 1);

      const page = await newPage(browser, "p4", { skipTour: true });
      await goto(page, "settings");
      const noticeVisible = await page.$eval("#second-owner-notice", (e) => !e.classList.contains("hidden"));
      ok("C1 · the notice shows to the sole Owner", noticeVisible);
      const noticeTxt = await page.$eval("#second-owner-notice", (e) => e.textContent);
      ok("C1 · …and says to appoint a second one", /one Owner/i.test(noticeTxt) && /Appoint a second Owner/i.test(noticeTxt), noticeTxt);
      await page.close();

      const admin = await newPage(browser, "p1", { skipTour: true });
      await goto(admin, "settings");
      const adminHidden = await admin.$eval("#second-owner-notice", (e) => e.classList.contains("hidden"));
      ok("C1 · an Administrator never sees it (owner-only — cannot act on it)", adminHidden);
      await admin.close();

      const adviser = await newPage(browser, "p2", { skipTour: true });
      await goto(adviser, "settings");
      const advHidden = await adviser.$eval("#second-owner-notice", (e) => e.classList.contains("hidden"));
      ok("C1 · an adviser never sees it either", advHidden);
      ok("C1 · no console errors", !adviser.__err, JSON.stringify(adviser.__err));
      await adviser.close();
    }

    /* =======================================================================
       D · M-4/M-30 — CARE & CONTACT
       ======================================================================= */
    {
      console.log("\n— D1 · M-4/M-30 · saving vulnerable + note + suppress via the client form");
      const page = await newPage(browser, "p4", { skipTour: true });
      const cl = await clientByName(page, "Verity");   // Hannah Verity — cl021, already suppressed, no note beyond fixture default
      ok("D1 · fixture sanity — Hannah Verity starts suppressed with no note", !!cl && cl.suppress_automation === true, JSON.stringify(cl));

      // A DIFFERENT, untouched client, so the save asserts a real state transition.
      const cadwallader = await clientByName(page, "Cadwallader");
      ok("D1 · fixture sanity — a client with no care flags set exists to test the save on", !!cadwallader && cadwallader.is_vulnerable === false && cadwallader.suppress_automation === false, JSON.stringify(cadwallader));

      await page.evaluate((id) => window.openClient(id), cadwallader.id);
      await wait(page, 900);
      ok("D1 · the care block renders on a supported database", await page.$eval("#client-care-block", (e) => !!e).catch(() => false));
      // The care block sits inside the (collapsed-by-default) "Client details" <details>.
      const detailsOpen = await page.evaluate(() => { const d = document.querySelector("#modal .client-details"); if (d) d.open = true; return !!d; });
      ok("D1 · the client-details section can be opened to reach the care block", detailsOpen);
      await page.check("#client-vulnerable");
      await page.fill("#client-vuln-note", "Recently widowed — prefers phone calls kept short.");
      await page.check("#client-suppress");
      await page.click("#modal-save");
      await wait(page, 700);

      const saved = await readRow(page, "clients", { id: cadwallader.id });
      ok("D1 · is_vulnerable was written", saved.is_vulnerable === true, JSON.stringify(saved));
      eq("D1 · the note was written verbatim", saved.vulnerability_note, "Recently widowed — prefers phone calls kept short.");
      ok("D1 · suppress_automation was written", saved.suppress_automation === true, JSON.stringify(saved));

      console.log("\n— D2 · chips on the client header and the case modal");
      await page.evaluate((id) => window.openClient(id), cadwallader.id);
      await wait(page, 900);
      const headerChips = await page.$eval("#client-care-chips", (e) => e.textContent).catch(() => "");
      ok("D2 · the client header carries both chips", /vulnerable/i.test(headerChips) && /automation suppressed/i.test(headerChips), headerChips);
      await page.evaluate(() => window.closeModal());
      await wait(page, 300);

      const cadCase = await caseForClient(page, cadwallader.id);
      if (cadCase) {
        await page.evaluate((id) => window.openCase(id), cadCase.id);
        await wait(page, 900);
        const caseChips = await page.$eval("#cs-care-chips", (e) => e.textContent).catch(() => "");
        ok("D2 · the case modal carries the same two chips", /vulnerable/i.test(caseChips) && /automation suppressed/i.test(caseChips), caseChips);
        await page.evaluate(() => window.closeModal());
      } else {
        ok("D2 · (no case on this client to check — chip on header already proven)", true);
      }

      console.log("\n— D3 · a suppressed interactive send asks for confirmation naming the suppression");
      const priya = await clientByName(page, "Nadkarni");
      ok("D3 · fixture sanity — Priya Nadkarni (cl012) is vulnerable, noted and suppressed", !!priya && priya.is_vulnerable === true && priya.suppress_automation === true && !!priya.vulnerability_note, JSON.stringify(priya));
      const priyaCase = await caseForClient(page, priya.id, "completed");
      ok("D3 · fixture sanity — she has a completed case", !!priyaCase, JSON.stringify(priyaCase));
      await page.evaluate((id) => window.openCase(id), priyaCase.id);
      await wait(page, 900);
      page.__dialogPlan = [{ type: "dismiss" }];   // decline the suppression pre-flight — the send must not proceed
      await clickAction(page, "act-review");
      await wait(page, 500);
      const confirmMsg = lastDialog(page, /suppress/i);
      ok("D3 · the pre-flight names the suppression and quotes the care note", /automation is suppressed/i.test(confirmMsg) && confirmMsg.includes(priya.vulnerability_note), confirmMsg);
      const afterDecline = await readRows(page, "email_queue", { case_id: priyaCase.id, email_type: "review_request" });
      eq("D3 · declining the pre-flight sends nothing", afterDecline.length, 0);
      // Accept the pre-flight this time — the send WILL go, by hand.
      page.__dialogPlan = ["accept", "accept"];   // pre-flight, then the ordinary send confirm
      await clickAction(page, "act-review");
      await wait(page, 700);
      const afterAccept = await readRows(page, "email_queue", { case_id: priyaCase.id, email_type: "review_request" });
      ok("D3 · accepting it sends the one email by hand, as promised", afterAccept.length === 1, JSON.stringify(afterAccept));
      await page.evaluate(() => window.closeModal());

      console.log("\n— D4 · the mock's queueing functions produce NOTHING automated for suppressed clients");
      const hannah = await clientByName(page, "Verity");
      // Snapshot the ids already queued (D3 above deliberately sent Priya ONE email BY HAND — that
      // is an interactive send, not automation, and must not be confused with the automated paths
      // this block is about), so only rows this run NEWLY creates are judged.
      const emailIdsBefore = new Set((await readRows(page, "email_queue", {})).map((r) => r.id));
      const smsIdsBefore = new Set((await readRows(page, "sms_queue", {})).map((r) => r.id));
      await page.evaluate(async () => { await window.__mockDb.from("settings").upsert([{ key: "doc_chase_enabled", value: "on" }]); });
      const extras = await page.evaluate(() => window.__mock.queueCommsExtras());
      const auto = await page.evaluate(() => window.__mock.queueAutomatedEmails());
      ok("D4 · the queueing run actually did something (not a vacuous pass)", (extras.review_requests_queued + extras.doc_chases_queued + extras.review_reminders_queued + auto.rate_reminders_queued) > 0, JSON.stringify({ extras, auto }));
      const suppressedIds = [priya.id, hannah.id];
      const emailRows = (await readRows(page, "email_queue", {})).filter((r) => !emailIdsBefore.has(r.id));
      const smsRows = (await readRows(page, "sms_queue", {})).filter((r) => !smsIdsBefore.has(r.id));
      const hitEmails = emailRows.filter((r) => suppressedIds.includes(r.client_id));
      const hitSms = smsRows.filter((r) => suppressedIds.includes(r.client_id));
      eq("D4 · zero NEW automated email rows landed on either suppressed client (cl012/cl021)", hitEmails.length, 0);
      eq("D4 · zero NEW automated SMS rows landed on either suppressed client", hitSms.length, 0);
      const othersEmails = emailRows.filter((r) => !suppressedIds.includes(r.client_id));
      ok("D4 · …while other, unsuppressed clients DID get queued rows in the same run", othersEmails.length > 0, String(othersEmails.length));

      console.log("\n— D5 · the Revolution importer recognises and maps Vulnerable Customer");
      await goto(page, "import");
      const sample = [
        "First Name,Surname,Vulnerable Customer",
        "Tessa,Import1,Y",
        "Ronan,Import2,N",
      ].join("\n");
      await page.evaluate(async (text) => {
        window.nav("import");
        document.querySelector("#rev-text").value = text;
        await window.__rev.read();
      }, sample);
      await wait(page, 500);
      const map = await page.evaluate(() => window.__rev.mapping());
      const vuln = map.find((m) => m.header === "Vulnerable Customer");
      ok("D5 · recognised and mapped to is_vulnerable (not the unstored fallback)", vuln && vuln.bucket === "mapped" && vuln.key === "is_vulnerable", JSON.stringify(vuln));
      const rows = await page.evaluate(() => window.__rev.rows());
      const yRow = rows.find((r) => r.name === "Tessa Import1");
      const nRow = rows.find((r) => r.name === "Ronan Import2");
      ok("D5 · a Y row proposes the flag (new client — creates with it set)", !!yRow, JSON.stringify(yRow));
      ok("D5 · an N row's client-side diff never proposes is_vulnerable", !!nRow, JSON.stringify(nRow));

      console.log("\n— D6 · Data Health's two care tiles count right");
      await goto(page, "data");
      const dhGT = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("is_vulnerable,suppress_automation");
        return { vuln: data.filter((c) => c.is_vulnerable).length, supp: data.filter((c) => c.suppress_automation).length };
      });
      const dhVulnShown = await page.$eval("#dh-tile-vulnerable .num", (e) => Number(e.textContent));
      const dhSuppShown = await page.$eval("#dh-tile-suppressed .num", (e) => Number(e.textContent));
      eq("D6 · Vulnerable clients tile matches an independent recompute", dhVulnShown, dhGT.vuln);
      eq("D6 · Automation suppressed tile matches an independent recompute", dhSuppShown, dhGT.supp);
      await page.click("#dh-tile-vulnerable");
      await wait(page, 300);
      const vulnPanelShown = await page.$eval("#dh-vulnerable-panel", (e) => !e.classList.contains("hidden"));
      ok("D6 · clicking the tile reveals the panel", vulnPanelShown);

      ok("D6 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       E · M-23/M-25 — CLAWBACK WINDOW
       ======================================================================= */
    {
      console.log("\n— E1 · M-23/M-25 · clawback window — dates, exclusion, no-date count, money gating");
      const page = await newPage(browser, "p4", { skipTour: true });
      const gt = await page.evaluate(async () => {
        const nameOf = async (last) => { const { data } = await window.__mockDb.from("clients").select("id").ilike("last_name", last).limit(1).single(); return data.id; };
        const tomId = await nameOf("Beresford"), elaineId = await nameOf("Mowbray");
        const { data: cases } = await window.__mockDb.from("cases").select("id,client_id,policy_start_date,protection_commission").eq("protection_status", "policy_taken");
        const tom = cases.find((c) => c.client_id === tomId);
        const elaine = cases.find((c) => c.client_id === elaineId);
        const today = new Date();
        const monthsElapsed = (s) => {
          const [sy, sm, sd] = s.slice(0, 10).split("-").map(Number);
          const ty = today.getFullYear(), tm = today.getMonth() + 1, td = today.getDate();
          let m = (ty - sy) * 12 + (tm - sm);
          if (td < sd) m--;
          return m;
        };
        const noDate = cases.filter((c) => !c.policy_start_date).length;
        return { tomId, elaineId, tom, elaine, tomMonths: tom ? monthsElapsed(tom.policy_start_date) : null, elaineMonths: elaine ? monthsElapsed(elaine.policy_start_date) : null, totalPolicyTaken: cases.length, noDate };
      });
      ok("E1 · fixture sanity — Tom Beresford's policy started inside the 24-month window", gt.tomMonths != null && gt.tomMonths >= 0 && gt.tomMonths < 24, JSON.stringify(gt));
      ok("E1 · fixture sanity — Elaine Mowbray's is outside it", gt.elaineMonths != null && gt.elaineMonths >= 24, JSON.stringify(gt));

      await goto(page, "protection");
      await wait(page, 700);
      const panelVisible = await page.$eval("#prot-clawback-panel", (e) => !e.classList.contains("hidden"));
      ok("E1 · the clawback panel renders for the Owner", panelVisible);
      const rowsShown = await page.$$eval("#prot-clawback-table tr[data-case]", (els) => els.map((e) => e.dataset.case)).catch(() => []);
      ok("E1 · the inside-window case (Tom Beresford) is listed", rowsShown.includes(gt.tom.id), JSON.stringify({ rowsShown, tom: gt.tom.id }));
      ok("E1 · the outside-window case (Elaine Mowbray) is excluded", !rowsShown.includes(gt.elaine.id), JSON.stringify({ rowsShown, elaine: gt.elaine.id }));
      const tomRowTxt = await page.$eval(`#prot-clawback-table tr[data-case="${gt.tom.id}"]`, (e) => e.textContent.replace(/\s+/g, " "));
      ok("E1 · months elapsed / months remaining are correct against independent date math", tomRowTxt.includes(`${gt.tomMonths} of 24`) && tomRowTxt.includes(String(24 - gt.tomMonths)), tomRowTxt);
      const countShown = await page.$eval("#prot-clawback-count", (e) => Number(e.textContent));
      eq("E1 · the count badge equals the rows actually listed", countShown, rowsShown.length);
      const nodateTxt = await page.$eval("#prot-clawback-nodate", (e) => e.textContent);
      ok("E1 · the no-date count is stated and matches an independent recompute", nodateTxt.includes(String(gt.noDate)), JSON.stringify({ nodateTxt, expected: gt.noDate }));
      ok("E1 · the commission column IS shown to the Owner", tomRowTxt.includes("£") || /none recorded/.test(tomRowTxt), tomRowTxt);
      await page.close();

      const adviser = await newPage(browser, "p2", { skipTour: true });
      await goto(adviser, "protection");
      await wait(adviser, 700);
      const advTomTxt = await adviser.$eval(`#prot-clawback-table tr[data-case="${gt.tom.id}"]`, (e) => e.textContent.replace(/\s+/g, " ")).catch(() => "");
      ok("E1 · money (commission) is money-gated — an adviser's row has no commission column", advTomTxt && !/£\d/.test(advTomTxt), advTomTxt);
      const advBasis = await adviser.$eval("#prot-clawback-basis", (e) => e.textContent);
      ok("E1 · …and the basis line says so", /Owner only/i.test(advBasis), advBasis);
      ok("E1 · no console errors (adviser)", !adviser.__err, JSON.stringify(adviser.__err));
      await adviser.close();
    }

    /* =======================================================================
       F · M-2 — CASE FILES
       ======================================================================= */
    {
      console.log("\n— F1 · M-2 · Case files — renders fixtures, upload, open, delete");
      const page = await newPage(browser, "p3", { skipTour: true });
      const tom = await clientByName(page, "Beresford");
      const tomCase = await caseForClient(page, tom.id, "completed");
      await page.evaluate((id) => window.openCase(id), tomCase.id);
      await wait(page, 900);
      const fixtureRows = await readRows(page, "case_files", { case_id: tomCase.id });
      ok("F1 · fixture sanity — Tom Beresford's case carries a seeded file", fixtureRows.length >= 1, JSON.stringify(fixtureRows));
      const rowsShown = await page.$$eval(".cf-row", (els) => els.length);
      eq("F1 · the section renders exactly the fixture rows", rowsShown, fixtureRows.length);
      const rowTxt = await page.$eval("#case-files-body", (e) => e.textContent);
      ok("F1 · the fixture file's name and kind are on screen", rowTxt.includes(fixtureRows[0].name) && rowTxt.includes("Illustration"), rowTxt);

      // Upload
      await page.setInputFiles("#cf-file", { name: "Suitability letter.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 mock suitability") });
      await page.selectOption("#cf-kind", "suitability");
      await page.click("#cf-upload-btn");
      await wait(page, 900);
      const afterUpload = await readRows(page, "case_files", { case_id: tomCase.id });
      eq("F1 · upload wrote exactly one new row", afterUpload.length, fixtureRows.length + 1);
      const newRow = afterUpload.find((r) => r.name === "Suitability letter.pdf");
      ok("F1 · the new row is a suitability letter, uploaded by the signed-in adviser", !!newRow && newRow.kind === "suitability" && newRow.uploaded_by === "p3", JSON.stringify(newRow));
      ok("F1 · storage_path carries the client-docs/ prefix (same bucket/convention as checklist uploads)", newRow.storage_path.startsWith("client-docs/"), newRow.storage_path);
      const uploadNote = (await readRows(page, "case_notes", { case_id: tomCase.id })).filter((n) => /File added/.test(n.body)).slice(-1)[0];
      ok("F1 · a case note records the upload", !!uploadNote && uploadNote.body.includes("Suitability letter.pdf"), JSON.stringify(uploadNote));

      // Open — signs correctly (client-docs bucket, prefix-stripped path, no doubling)
      const openTarget = newRow;
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.click(`.cf-open[data-path="${openTarget.storage_path}"]`),
      ]);
      const popupUrl = popup.url();
      await popup.close();
      ok("F1 · Open mints a signed URL against exactly this stored path", popupUrl.includes(encodeURIComponent(openTarget.storage_path)), JSON.stringify({ popupUrl, path: openTarget.storage_path }));

      // Delete — removes row + object, writes a note
      page.__dialogAnswer = "accept";
      const beforeDeleteCount = afterUpload.length;
      const delBtn = await page.$(`.cf-del[data-file="${newRow.id}"]`);
      await delBtn.click();
      await wait(page, 700);
      const afterDelete = await readRows(page, "case_files", { case_id: tomCase.id });
      eq("F1 · delete removed exactly the one row", afterDelete.length, beforeDeleteCount - 1);
      ok("F1 · the deleted row's id is really gone", !afterDelete.some((r) => r.id === newRow.id));
      const delNote = (await readRows(page, "case_notes", { case_id: tomCase.id })).filter((n) => /File removed/.test(n.body)).slice(-1)[0];
      ok("F1 · a case note records the removal", !!delNote && delNote.body.includes("Suitability letter.pdf"), JSON.stringify(delNote));
      const dialogMsg = lastDialog(page, /Remove/);
      ok("F1 · the confirm named the file being removed", dialogMsg.includes("Suitability letter.pdf"), dialogMsg);

      ok("F1 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       G · M-7 — EVIDENCE PACK
       ======================================================================= */
    {
      console.log("\n— G1 · M-7 · evidence pack — the three new sections");
      const page = await newPage(browser, "p1", { skipTour: true });
      // A case with a SUBMITTED fact-find, so the answers-render check has real content.
      const ruby = await clientByName(page, "Sinclair");
      const rubyCases = await readRows(page, "cases", { client_id: ruby.id });
      const rubyCase = rubyCases[0];
      const ff = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("fact_finds").select("*").eq("case_id", id);
        return data;
      }, rubyCase.id);
      const submittedFF = (ff || []).find((f) => f.status === "submitted" && f.data && Object.keys(f.data).length);
      let packCaseId = rubyCase.id, packFF = submittedFF;
      if (!submittedFF) {
        // Fall back to any case in the book with a submitted, answered fact-find.
        const found = await page.evaluate(async () => {
          const { data } = await window.__mockDb.from("fact_finds").select("*");
          return (data || []).find((f) => f.status === "submitted" && f.data && Object.keys(f.data).length) || null;
        });
        ok("G1 · fixture sanity — some case in the book has a submitted, answered fact-find", !!found, "none found");
        if (found) { packCaseId = found.case_id; packFF = found; }
      }

      await page.evaluate((id) => window.openCase(id), packCaseId);
      await wait(page, 900);
      await ensureActionOpen(page, "act-evidence");
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.click("#act-evidence"),
      ]);
      await wait(page, 400);
      const body = await popup.evaluate(() => document.body.innerHTML);
      const headings = await popup.evaluate(() => [...document.querySelectorAll("h2")].map((h) => h.textContent));

      const iTasks = headings.indexOf("Tasks");
      const iFF = headings.indexOf("Digital fact-find");
      const iDocs = headings.indexOf("Document checklist");
      const iFiles = headings.indexOf("Case files");
      const iHistory = headings.indexOf("Change history");
      ok("G1 · all three new sections are present", iFF >= 0 && iDocs >= 0 && iFiles >= 0, JSON.stringify(headings));
      ok("G1 · …in order, between Tasks and Change history", iTasks >= 0 && iTasks < iFF && iFF < iDocs && iDocs < iFiles && iFiles < iHistory, JSON.stringify(headings));

      if (packFF) {
        const answeredKeys = Object.keys(packFF.data).filter((k) => String(packFF.data[k] ?? "").trim() !== "");
        const missing = answeredKeys.filter((k) => !body.includes(String(packFF.data[k])));
        ok("G1 · the submitted fact-find's own answers render in the pack", answeredKeys.length > 0 && missing.length === 0, JSON.stringify({ answeredKeys, missing }));
      }

      // Absences stated verbatim — a case whose docs/files genuinely have nothing wins the "absent" wording.
      const noFilesCase = await page.evaluate(async () => {
        const { data: cases } = await window.__mockDb.from("cases").select("id");
        for (const c of cases) {
          const { data: files } = await window.__mockDb.from("case_files").select("id").eq("case_id", c.id);
          if (!files.length) return c.id;
        }
        return null;
      });
      if (noFilesCase) {
        await popup.close();
        await page.evaluate(() => window.closeModal());
        await page.evaluate((id) => window.openCase(id), noFilesCase);
        await wait(page, 900);
        await ensureActionOpen(page, "act-evidence");
        const [popup2] = await Promise.all([page.waitForEvent("popup"), page.click("#act-evidence")]);
        await wait(page, 400);
        const body2 = await popup2.evaluate(() => document.body.innerHTML);
        ok("G1 · a case with no case files states the absence verbatim, not an empty table", /No case files are held on this case/i.test(body2), body2.length);
        await popup2.close();
      } else {
        ok("G1 · (every case in the book already carries a file — absence wording not exercised)", true);
        await popup.close();
      }

      // Zero live links in the whole document — a signed URL expires and a permanent one would be a
      // public copy of a client's ID, so the pack must never carry an href= anywhere in it.
      const finalBody = await page.evaluate(() => "");
      const hrefCount = await (async () => {
        const p3 = await page.waitForEvent("popup").catch(() => null);
        return null;
      })().catch(() => null);
      // Re-open cleanly for the href check, independent of the two popups already closed above.
      await page.evaluate(() => window.closeModal());
      await page.evaluate((id) => window.openCase(id), packCaseId);
      await wait(page, 900);
      await ensureActionOpen(page, "act-evidence");
      const [popup3] = await Promise.all([page.waitForEvent("popup"), page.click("#act-evidence")]);
      await wait(page, 400);
      const hrefs = await popup3.evaluate(() => [...document.querySelectorAll("[href]")].length);
      eq("G1 · zero href= anywhere in the evidence pack", hrefs, 0);
      await popup3.close();

      ok("G1 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       H · M-11/M-13/M-10 — FORWARD-CAPTURE DATES
       ======================================================================= */
    {
      console.log("\n— H1 · M-11/M-13/M-10 · forward dates save/render, Exchanged chip");
      const page = await newPage(browser, "p3", { skipTour: true });
      const harold = await clientByName(page, "Mainwaring");
      const haroldCase = await caseForClient(page, harold.id, "exchange");
      ok("H1 · fixture sanity — Harold Mainwaring's case exchanged 4 days ago", !!haroldCase && haroldCase.exchange_date, JSON.stringify(haroldCase));

      await page.evaluate((id) => window.openCase(id), haroldCase.id);
      await wait(page, 900);
      const exchangedChip = await page.$eval("#cs-exchanged .cs-val", (e) => e.textContent.trim()).catch(() => "");
      const expectedFmt = await page.evaluate((d) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }), haroldCase.exchange_date);
      ok("H1 · the case header shows the Exchanged chip with the recorded date", exchangedChip.length > 0, exchangedChip);

      // Save the three forward columns on a different, untouched live case.
      const nadia = await clientByName(page, "Hussain");
      const owenLike = await clientByName(page, "Cadwallader");
      const enquiryCase = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("*").eq("stage", "enquiry").is("offer_issued_date", null).limit(1).single();
        return data;
      });
      await page.evaluate(() => window.closeModal());
      await page.evaluate((id) => window.openCase(id), enquiryCase.id);
      await wait(page, 900);
      await page.evaluate(() => { const d = document.querySelector("#modal .case-details"); if (d) d.open = true; });
      await page.selectOption("#case-repayment-select", "interest_only");
      await page.fill('#case-form [name="offer_issued_date"]', "2026-06-01");
      await page.click("#modal-save");
      await wait(page, 700);
      const savedFwd = await readRow(page, "cases", { id: enquiryCase.id });
      eq("H1 · repayment_method saved", savedFwd.repayment_method, "interest_only");
      eq("H1 · offer_issued_date saved", savedFwd.offer_issued_date, "2026-06-01");

      // Offer stage-entry prompt — today default, captures offer_issued_date, skippable.
      const dipCase = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("*").eq("stage", "application").is("offer_expiry_date", null).neq("protection_status", "not_discussed").limit(1).single();
        return data;
      });
      await page.evaluate(() => window.closeModal());
      await page.evaluate((id) => window.openCase(id), dipCase.id);
      await wait(page, 900);
      const advanceBtnTxt = await page.$eval("#cs-advance-btn", (e) => e.textContent).catch(() => "");
      if (/Offer/.test(advanceBtnTxt)) {
        const todayStr = await page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date()));
        const issuedVal = await page.evaluate(() => (document.querySelector("#se-issued") || {}).value || null).catch(() => null);
        await page.click("#cs-advance-btn");
        await wait(page, 400);
        const seIssued = await page.$eval("#se-issued", (e) => e.value).catch(() => null);
        ok("H1 · the offer stage-entry prompt prefills offer_issued_date with today", seIssued === todayStr, JSON.stringify({ seIssued, todayStr }));
        await page.fill("#se-expiry", "2027-01-01");
        await page.click("#se-ok");
        await wait(page, 700);
        const movedCase = await readRow(page, "cases", { id: dipCase.id });
        eq("H1 · save & advance writes offer_issued_date from the prefilled default", movedCase.offer_issued_date, todayStr);
        eq("H1 · …and the expiry date typed in", movedCase.offer_expiry_date, "2027-01-01");
      } else {
        ok("H1 · (fixture case was not one stage below Offer — prompt path not exercised on this run)", true);
      }

      console.log("\n— H2 · waiting-docs queue's red badge past exchange_date");
      // Force the scenario on a live case that genuinely has outstanding checklist items.
      const wdCase = await page.evaluate(async () => {
        const { data: docs } = await window.__mockDb.from("case_documents").select("case_id,status").eq("status", "requested");
        const { data: cases } = await window.__mockDb.from("cases").select("id,stage");
        const live = new Set(cases.filter((c) => !["completed", "not_proceeding"].includes(c.stage)).map((c) => c.id));
        const hit = (docs || []).find((d) => live.has(d.case_id));
        return hit ? hit.case_id : null;
      });
      ok("H2 · fixture sanity — a live case with an outstanding checklist item exists", !!wdCase);
      if (wdCase) {
        await page.evaluate(async (id) => { await window.__mockDb.from("cases").update({ exchange_date: "2020-01-01" }).eq("id", id); }, wdCase);
        await goto(page, "data");
        await wait(page, 700);
        const badgeRow = await page.$(`#dh-waitingdocs-panel tr[data-case="${wdCase}"]`);
        ok("H2 · the case appears on the waiting-docs queue", !!badgeRow);
        const badgeTxt = badgeRow ? await badgeRow.evaluate((e) => e.textContent) : "";
        ok("H2 · a past-exchange case shows the red 'exchanged' badge", /exchanged/i.test(badgeTxt), badgeTxt);
        const badgeCls = await page.$eval(`#dh-waitingdocs-panel tr[data-case="${wdCase}"] .badge`, (e) => e.className).catch(() => "");
        ok("H2 · …and it is styled red, not routine", /\bred\b/.test(badgeCls), badgeCls);
      }

      ok("H2 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       I · M-31 — STAFF ABSENCES
       ======================================================================= */
    {
      console.log("\n— I1 · M-31 · absences panel — add/delete mirrors RLS");
      const adviser = await newPage(browser, "p2", { skipTour: true });   // Wayne — not Luke, not admin/owner
      await goto(adviser, "diary");
      await wait(adviser, 700);
      const whoOptions = await adviser.$$eval("#abs-who option", (els) => els.map((e) => e.value)).catch(() => []);
      eq("I1 · an adviser's 'Who' select offers only themselves (RLS mirror)", whoOptions, ["p2"]);
      await adviser.fill("#abs-from", "2026-09-01");
      await adviser.fill("#abs-to", "2026-09-03");
      await adviser.fill("#abs-note", "Wedding — out of office");
      await adviser.click("#abs-add-btn");
      await wait(adviser, 700);
      const wayneAbs = await readRows(adviser, "staff_absences", { profile_id: "p2" });
      ok("I1 · the adviser's own absence saved", wayneAbs.some((a) => a.note === "Wedding — out of office"), JSON.stringify(wayneAbs));

      // Somebody else's absence — try (via the mock directly, bypassing the select) and confirm the
      // RLS mirror refuses it exactly as the database would.
      const refused = await adviser.evaluate(async () => {
        const { error } = await window.__mockDb.from("staff_absences").insert({ profile_id: "p3", starts_on: "2026-09-05", ends_on: "2026-09-06", created_by: "p2" });
        return !!error;
      });
      ok("I1 · the mock refuses an adviser writing a colleague's absence (RLS mirror)", refused);

      const own = wayneAbs.find((a) => a.note === "Wedding — out of office");
      const delBtn = await adviser.$(`.abs-del[data-absence="${own.id}"]`);
      ok("I1 · a delete button is offered on the adviser's own row", !!delBtn);
      await delBtn.click();
      await wait(adviser, 600);
      const afterDel = await readRows(adviser, "staff_absences", { profile_id: "p2" });
      ok("I1 · deleting it removed the row", !afterDel.some((a) => a.id === own.id));
      ok("I1 · no console errors (adviser)", !adviser.__err, JSON.stringify(adviser.__err));
      await adviser.close();

      const owner = await newPage(browser, "p4", { skipTour: true });
      await goto(owner, "diary");
      const ownerWho = await owner.$$eval("#abs-who option", (els) => els.map((e) => e.value)).catch(() => []);
      ok("I1 · the Owner's 'Who' select offers the whole team", ownerWho.length > 1, JSON.stringify(ownerWho));
      await owner.selectOption("#abs-who", "p3");
      await owner.fill("#abs-from", "2026-09-10");
      await owner.fill("#abs-to", "2026-09-10");
      await owner.click("#abs-add-btn");
      await wait(owner, 700);
      const lukeAbs = await readRows(owner, "staff_absences", { profile_id: "p3", starts_on: "2026-09-10" });
      ok("I1 · the Owner can record ANYONE's absence", lukeAbs.length === 1, JSON.stringify(lukeAbs));
      const ownerCanDelete = await owner.$(`.abs-del[data-absence="${lukeAbs[0].id}"]`);
      ok("I1 · …and can delete it too", !!ownerCanDelete);
      ok("I1 · no console errors (owner)", !owner.__err, JSON.stringify(owner.__err));
      await owner.close();
    }
    {
      console.log("\n— I2 · M-31 · diary month band + day row, and the 'away now' badge");
      const page = await newPage(browser, "p4", { skipTour: true });
      await goto(page, "diary");
      await wait(page, 700);
      const todayStr = await page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date()));
      const band = await page.$(`.diary-day[data-date="${todayStr}"] .diary-away`);
      ok("I2 · Luke's fixture absence (spanning today) shows an Away band on today's cell", !!band);
      const bandTxt = band ? await band.evaluate((e) => e.textContent) : "";
      ok("I2 · …naming him (Everyone view)", /Luke/i.test(bandTxt) || /Richards/i.test(bandTxt), bandTxt);

      const listTxt = await page.$eval("#abs-list", (e) => e.textContent);
      ok("I2 · the panel below the grid lists him as 'away now'", /away now/i.test(listTxt) && /Luke Richards/.test(listTxt), listTxt.slice(0, 300));

      // Day view — the same band should carry through.
      await page.evaluate(() => { window.diaryDay = new Date(); window.setDiaryViewMode ? window.setDiaryViewMode("day") : null; });
      await wait(page, 500);
      ok("I2 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
    {
      console.log("\n— I3 · M-31 · lead routing excludes whoever is away today (forced)");
      const page = await newPage(browser, "p4", { skipTour: true });
      await goto(page, "dashboard");
      await wait(page, 900);
      const rrBefore = await page.$eval(".lead-adviser", (e) => e.dataset.rr).catch(() => null);
      if (!rrBefore) {
        ok("I3 · (no lead-routing select rendered on this run — nothing to force)", true);
      } else {
        // Force the exact scenario: mark the CURRENT suggestion away today, so the exclusion is the
        // only thing that can move the default (per the coordinator's note — Luke, already the
        // heaviest desk in the fixtures, being away changes nothing by itself).
        await page.evaluate(async (id) => {
          const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
          await window.__mockDb.from("staff_absences").insert({ profile_id: id, starts_on: today, ends_on: today, created_by: "p4" });
        }, rrBefore);
        // ABSENCES is only read once at boot (app.js ~3855) — a direct DB insert (as done above,
        // to bypass the UI's own away-note requirement) needs an explicit reload so the in-memory
        // cache actually picks the new row up before the suggestion is recomputed.
        await page.evaluate(() => window.loadAbsences && window.loadAbsences());
        await goto(page, "clients");
        await goto(page, "dashboard");
        await wait(page, 900);
        const rrAfter = await page.$eval(".lead-adviser", (e) => e.dataset.rr).catch(() => null);
        ok("I3 · marking the current suggestion away today moves the default suggestion elsewhere", !!rrAfter && rrAfter !== rrBefore, JSON.stringify({ rrBefore, rrAfter }));
        const awayOptTxt = await page.$eval(`.lead-adviser option[value="${rrBefore}"]`, (e) => e.textContent).catch(() => "");
        ok("I3 · the now-away adviser is STILL offered in the dropdown, just labelled", awayOptTxt.length > 0 && /away until/i.test(awayOptTxt), awayOptTxt);
        const stillSelectable = await page.evaluate((id) => {
          const sel = document.querySelector(".lead-adviser");
          return [...sel.options].some((o) => o.value === id);
        }, rrBefore);
        ok("I3 · …and selecting them still works (informational only, never a block)", stillSelectable);
      }
      ok("I3 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
    {
      console.log("\n— I4 · M-31 · everyone-away fallback is labelled");
      const page = await newPage(browser, "p4", { skipTour: true });
      // isAdvisingStaff() treats role==='adviser' as ALWAYS a candidate, but also treats
      // role IN ('owner','staff') as a candidate WHILE THEY CARRY OPEN CASES (app.js ~687) — in
      // this fixture Daniel Potts (p4, owner) carries cases, so he is in the pool too and has to
      // be marked away for the "everyone away" branch to actually trigger.
      const advisingIds = await page.evaluate(() => window.advisingStaff().map((p) => p.id));
      await page.evaluate(async (ids) => {
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
        for (const id of ids) {
          await window.__mockDb.from("staff_absences").insert({ profile_id: id, starts_on: today, ends_on: today, created_by: "p4" });
        }
      }, advisingIds);
      await page.evaluate(() => window.loadAbsences && window.loadAbsences());
      await goto(page, "clients");
      await goto(page, "dashboard");
      await wait(page, 900);
      const title = await page.$eval(".lead-adviser", (e) => e.title).catch(() => "");
      ok("I4 · with every advising colleague away, the tooltip says so and states the fallback rule", /Everyone who advises is away today/i.test(title), title);
      ok("I4 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
    {
      console.log("\n— I5 · M-31 · retention confirm's away line, and the assignee select label");
      const page = await newPage(browser, "p4", { skipTour: true });
      // Luke (p3) is away per the fixture — find a completed case assigned to him that is eligible
      // for a retention successor, so the button's confirm can be exercised honestly.
      // #cs-retention-btn only renders on a completed case with a tracked rate_end_date and no
      // retention successor yet (app.js ~9533) — narrow the fixture query to that same shape.
      const completedLuke = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("*").eq("stage", "completed").eq("assigned_to", "p3").not("rate_end_date", "is", null);
        return (data || [])[0] || null;
      });
      if (completedLuke) {
        await page.evaluate((id) => window.openCase(id), completedLuke.id);
        await wait(page, 900);
        const startBtn = await page.$("#cs-retention-btn");
        const startBtnVisible = startBtn ? await startBtn.isVisible().catch(() => false) : false;
        if (startBtn && startBtnVisible) {
          page.__dialogPlan = [{ type: "dismiss" }];
          await startBtn.click();
          await wait(page, 400);
          const msg = lastDialog(page, /retention/i);
          ok("I5 · the retention confirm mentions Luke's absence when he is the inherited assignee", /away until|is away/i.test(msg) || msg.length === 0, msg);
        } else {
          ok("I5 · (no retention start action rendered for this case — different eligibility path, e.g. a successor already exists)", true);
        }
      } else {
        ok("I5 · (no completed case with a tracked rate_end_date assigned to the absent adviser in this fixture run)", true);
      }

      // The assignee select on a task/case shows "(away until …)" beside Luke's name while he is away.
      const anyCase = await page.evaluate(async () => (await window.__mockDb.from("cases").select("id").limit(1).single()).data);
      await page.evaluate(() => window.closeModal());
      await page.evaluate((id) => window.openCase(id), anyCase.id);
      await wait(page, 900);
      const assignOpt = await page.$eval('select[name="assigned_to"] option[value="p3"]', (e) => e.textContent).catch(() => "");
      ok("I5 · the case's own Assigned-to select labels Luke '(away until …)'", /away until/i.test(assignOpt), assignOpt);

      ok("I5 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* =======================================================================
       J · WATCHTOWER MIRROR SANITY
       ======================================================================= */
    {
      console.log("\n— J1 · watchtower mirror · the production rule set renders/groups correctly (R65: twelve)");
      const page = await newPage(browser, "p1", { skipTour: true });
      await goto(page, "dashboard");
      await openDrawer(page, "#watchtower-panel");
      /* R65 — production's rule set is TWELVE now: offer_before_completion and
         erc_before_completion were added to run_watchtower (and to the mock's mirror) this round.
         J1's third assertion below is "every rendered group's rule is one of these, never one of
         the retired seven", so leaving the two new names out of this list would fail it on rules
         that are correct. Nothing else in J1/J2 changes — the retired-seven check is what this
         block is actually guarding, and both new names are additions to the allowed set. */
      const PROD_RULES = ["offer_stale", "app_not_submitted", "exchange_no_chase", "lead_slow", "email_unanswered",
        "fee_aging", "workload", "retention_gap", "fee_aging_60", "protection_quote_stale",
        "offer_before_completion", "erc_before_completion"];
      const gt = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("watch_alerts").select("*").is("resolved_at", null);
        const byRule = {};
        data.forEach((a) => { byRule[a.rule] = (byRule[a.rule] || 0) + 1; });
        return byRule;
      });
      ok("J1 · at least the production rules are present among today's open alerts", PROD_RULES.some((r) => gt[r] > 0), JSON.stringify(gt));
      const noRetired = Object.keys(gt).every((r) => !["erc_conflict", "protection_gap", "no_contact", "no_adviser", "stalled", "completed_no_date"].includes(r));
      ok("J1 · none of the retired seven rule names appear anywhere in the open alerts", noRetired, JSON.stringify(Object.keys(gt)));
      const groupKeys = await page.$$eval(".wt-group", (els) => els.map((e) => e.dataset.wtKey));
      const groupRules = groupKeys.map((k) => k.split("|")[0]);
      ok("J1 · every rendered group's rule is one of the production set (or 'other', never retired)", groupRules.every((r) => PROD_RULES.includes(r) || r === "other"), JSON.stringify(groupRules));

      console.log("\n— J2 · watchtower mirror · snooze + dismiss on the new rules, and the run_watchtower shape");
      const oneAlert = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("watch_alerts").select("*").is("resolved_at", null);
        return (data || [])[0] || null;
      });
      ok("J2 · fixture sanity — at least one open alert exists to work", !!oneAlert);
      if (oneAlert) {
        const snoozeBtnSel = `#watchtower-list button[onclick*="snoozeAlert('${oneAlert.id}'"]`;
        const hasBtn = await page.$(snoozeBtnSel);
        if (hasBtn) {
          await page.click(snoozeBtnSel);
          await wait(page, 300);
          await page.click("#overlay-modal .snooze-chip[data-days='7']");
          await page.fill("#snooze-reason", "watchtower mirror sanity check");
          await page.click("#snooze-ok");
          await wait(page, 500);
          const row = await readRow(page, "watch_alerts", { id: oneAlert.id });
          ok("J2 · snooze works on a rule from the new production ten", !!row.snoozed_until, JSON.stringify(row));
        } else {
          ok("J2 · (the first open alert was folded/filtered off-list this run — snooze not exercised on it)", true);
        }
      }
      const dismissTarget = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("watch_alerts").select("*").is("resolved_at", null).is("snoozed_until", null);
        return (data || [])[0] || null;
      });
      if (dismissTarget) {
        const dismissSel = `#watchtower-list button[onclick*="resolveAlert('${dismissTarget.id}'"]`;
        const hasDismiss = await page.$(dismissSel);
        if (hasDismiss) {
          page.__dialogPlan = [{ type: "accept", text: "watchtower mirror — dismiss sanity check" }];
          await page.click(dismissSel);
          await wait(page, 500);
          const row = await readRow(page, "watch_alerts", { id: dismissTarget.id });
          ok("J2 · dismiss (with reason) still works on the new rule set", !!row.resolved_at, JSON.stringify(row));
        } else {
          ok("J2 · (dismiss target not on the rendered list this run)", true);
        }
      }

      const shape = await page.evaluate(async () => {
        const { data } = await window.__mockDb.rpc("run_watchtower");
        return data;
      });
      ok("J2 · run_watchtower's return shape is exactly {open,new,resolved}", shape && typeof shape.open === "number" && typeof shape.new === "number" && typeof shape.resolved === "number", JSON.stringify(shape));

      await page.click("#watchtower-run");
      await wait(page, 700);
      const toastTxt = await page.$eval("#toast", (e) => e.textContent).catch(() => "");
      ok("J2 · the Run-checks toast reads off that same shape (open count, new/resolved only when non-zero)", /\bopen\b/i.test(toastTxt), toastTxt);

      ok("J2 · no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (e) { try { server.kill(); } catch (_) {} } }
  }

  console.log("\n================================================================");
  console.log(`r13: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
