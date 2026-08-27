#!/usr/bin/env node
/* =============================================================================
   tests/r9_docs.js — acceptance tests for ROUND 9's DOCUMENT CHASE half.

     R9-5  DOCUMENT CHECKLIST (case modal, migration m10) — the per-case
           checklist and its CRUD, the role rule on delete, the derived chase
           status line in all four fixture states, the client upload link
           (generate / persist / copy / the bearer warning), and the scoped
           "Send document request now" that queues exactly one email and never
           flushes the queue.
     R9-5b WAITING ON + SOLICITOR — the two case fields, the datalist of firms
           already on the book, and the subtle chip the board cards and the
           pipeline table both wear.
     R9-6  CONVEYANCER SPEED (Reports, Owner-only) — average submission-to-
           completion days by solicitor firm, n<3 marked, slowest highlighted,
           honest empty and migration-absent states.
     R9-7  SETTINGS HONESTY — the doc_chase_enabled toggle (seeded off) and
           what its copy has to say before a firm switches it on, plus the
           docs_list description now that per-case checklists exist.
     R9-8  THE TWO PUBLIC PAGES — /docs and /feedback, driven headless against
           the same mock edge stubs the admin app uses, at 390 and 1280.

   EVERY figure this file asserts is recomputed HERE, from the fixture tables,
   in an implementation written separately from app.js's. Nothing is compared
   against app.js's own idea of the answer and nothing date-relative is
   hardcoded — see the standing rules in HARNESS.md.

   Run:  node /root/nx/tests/r9_docs.js   (expects a static server on 8099;
                                           starts one itself if absent)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const ORIGIN = `http://localhost:${PORT}`;
const BASE = `${ORIGIN}/admin/mock.html`;
const MOCK_JS = `${REPO}/admin/mock-supabase.js`;
/* The mock stubs window.fetch for supabase FUNCTION urls only, so pointing the
   two public pages at this base is the whole of the harness wiring: the pages
   themselves have no idea they are being tested. */
const FN_BASE = "https://mock.supabase.co/functions/v1";
const SETTLE = 1500;
const CONV_MIN_N = 3;
const CHASE_MAX = 3;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const near = (name, actual, expected, tol) =>
  ok(name, typeof actual === "number" && Math.abs(actual - expected) <= tol, `expected ${expected} ±${tol}, got ${actual}`);

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
    r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}

/* Console errors are collected on every page in this file. The 403s the fonts
   and the SheetJS CDN produce in this sandbox are filtered out — they are the
   network, not the app — and everything else is a failure. */
function watch(page) {
  page.__err = [];
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err.push(m.text()); });
  page.on("pageerror", (e) => page.__err.push("pageerror: " + e.message));
}
async function newPage(browser, persona, viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  page.__dialogs = [];
  page.__answers = [];
  page.__dialogAnswer = "accept";
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    const want = page.__answers.length ? page.__answers.shift() : page.__dialogAnswer;
    if (want === "dismiss") await d.dismiss();
    else await d.accept();
  });
  watch(page);
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
/* A public page — no login, no admin shell. The mock is injected before the
   page's own script runs, so window.fetch is already stubbed by the time the
   page makes its first call. */
async function newPublicPage(browser, url, viewport, opts = {}) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  watch(page);
  page.on("dialog", async (d) => d.accept());
  await page.addInitScript({ path: MOCK_JS });
  await page.addInitScript(`window.__NEX_FN_BASE = ${JSON.stringify(FN_BASE)};`);
  /* The mock stubs window.fetch, so nothing reaches the network and Playwright's
     own request events never fire. This wraps the stub (it is installed by the
     script above, which runs first) and records what the PAGE asked for — which
     is the only way to prove the request it builds actually matches the
     deployed contract, rather than merely that the stub was happy with it. */
  if (opts.record) {
    await page.addInitScript(() => {
      const orig = window.fetch;
      window.__calls = [];
      window.fetch = function (input, init) {
        try {
          const rec = {
            url: typeof input === "string" ? input : (input && input.url) || "",
            method: String((init && init.method) || "GET").toUpperCase(),
            headerKeys: init && init.headers ? Object.keys(init.headers) : [],
            isFormData: !!(init && init.body && typeof FormData !== "undefined" && init.body instanceof FormData),
            bodyType: init && init.body ? (typeof init.body === "string" ? "string" : "object") : null,
            parts: null,
          };
          if (rec.isFormData) {
            rec.parts = {};
            init.body.forEach((v, k) => {
              rec.parts[k] = (v && typeof v === "object" && "name" in v && "size" in v)
                ? { file: true, name: v.name, size: v.size }
                : String(v);
            });
          }
          window.__calls.push(rec);
        } catch (e) { /* recording must never break the page under test */ }
        return orig.apply(this, arguments);
      };
    });
  }
  await page.goto(url);
  await page.waitForTimeout(900);
  return page;
}
// R33 — scoped to #modal: Settings' new #diag-details shares the `.case-details` styling class
// and, being static markup, is always in the DOM — an unscoped selector now matches it first.
const openDetails = (page) => page.evaluate(() => { const d = document.querySelector("#modal .case-details"); if (d) d.open = true; });
const gotoReports = async (page) => { await page.evaluate(() => window.nav("reports")); await page.waitForTimeout(2400); };
const gotoPipeline = async (page) => { await page.evaluate(() => window.nav("pipeline")); await page.waitForTimeout(1500); };
const gotoSettings = async (page) => { await page.evaluate(() => window.nav("settings")); await page.waitForTimeout(1300); };
const openCase = async (page, id, ms) => { await page.evaluate((i) => window.openCase(i), id); await page.waitForTimeout(ms || 1000); };
const txt = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
const exists = async (page, sel) => !!(await page.$(sel));

/* ---------------------------------------------------------------------------
   GROUND TRUTH — the whole document picture, recomputed here from the fixture
   tables. If app.js and this disagree about how many chases a case has had,
   what is outstanding on it, or how long a solicitor takes, the run goes red
   and one of the two is wrong.
   ------------------------------------------------------------------------- */
const groundTruth = (page) => page.evaluate(async ({ CHASE_MAX }) => {
  const db = window.__mockDb;
  const [cs, cl, cd, eqr, tk, st] = await Promise.all([
    db.from("cases").select("id,client_id,stage,case_kind,submitted_at,completed_at,waiting_on,solicitor_firm,doc_token,assigned_to"),
    db.from("clients").select("id,first_name,last_name,email"),
    db.from("case_documents").select("*"),
    db.from("email_queue").select("id,case_id,email_type,status,sent_at,created_at"),
    db.from("case_tasks").select("id,case_id,title,due_date,done_at"),
    db.from("settings").select("key,value"),
  ]);
  const cases = cs.data || [], clients = cl.data || [], docs = cd.data || [];
  const mails = eqr.data || [], tasks = tk.data || [];
  const settings = Object.fromEntries((st.data || []).map((r) => [r.key, r.value]));
  const nameOf = (id) => { const c = clients.find((x) => x.id === id); return c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() : ""; };
  const caseFor = (name, stage) => cases.find((c) => nameOf(c.client_id) === name && (!stage || c.stage === stage)) || null;
  const DAYMS = 86400000;

  const perCase = {};
  cases.forEach((c) => {
    const mine = docs.filter((d) => d.case_id === c.id);
    /* R63 · A5(a) — DELIBERATE CONTRACT CHANGE to this ground truth, for a parity fix.
       Production has NO `docs_chase` email type: the chaser queues a FURTHER `docs_request` row,
       so the first document email on a case is the request and every one after it is a chase.
       app.js (docChaseCount) and mock-supabase.js (docChaseCountFor) were both moved onto that
       rule in R63; this recomputation had the OLD rule ("count docs_chase rows"), which against a
       production-shaped case returns 0 no matter how many chases have gone. It is changed here
       rather than worked around, because a ground truth that encodes a rule the app deliberately
       stopped having is not a ground truth. `docs_chase` is still counted — this file's own
       fixtures seed it and a historic row could exist — and against those fixtures the two rules
       give identical numbers (0 / 2 / 3 for Ellingham / Quirke / Amery), so every assertion below
       is unchanged; the difference only appears once a chase is queued the production way. */
    const dm = mails.filter((m) => m.case_id === c.id && ["docs_request", "docs_chase"].includes(m.email_type));
    const dmLive = dm.filter((m) => m.status !== "cancelled");
    perCase[c.id] = {
      items: mine.length,
      outstanding: mine.filter((d) => d.status === "requested").length,
      received: mine.filter((d) => d.status === "received").length,
      waived: mine.filter((d) => d.status === "waived").length,
      /* what the deployed GET may show a client: waived is filtered server-side */
      visible: mine.filter((d) => d.status !== "waived").length,
      ids: mine.map((d) => ({ id: d.id, item: d.item, status: d.status })),
      chases: dmLive.filter((m) => m.email_type === "docs_chase").length
        + Math.max(0, dmLive.filter((m) => m.email_type === "docs_request").length - 1),
      docMails: dm.length,
      lastMail: dm.map((m) => m.sent_at || m.created_at).filter(Boolean).sort().slice(-1)[0] || null,
      token: c.doc_token || null,
      overdueTask: tasks.some((t) => t.case_id === c.id && !t.done_at && t.title === `Documents overdue — call ${nameOf(c.client_id)}`),
    };
  });

  // --- conveyancer speed, computed independently of app.js -----------------
  const byFirm = {};
  let unnamed = 0;
  cases.forEach((c) => {
    if (c.stage !== "completed" || !c.completed_at || !c.submitted_at) return;
    const days = Math.round((new Date(c.completed_at) - new Date(c.submitted_at)) / DAYMS);
    if (!(days > 0)) return;
    const firm = (c.solicitor_firm || "").trim();
    if (!firm) { unnamed++; return; }
    (byFirm[firm] = byFirm[firm] || []).push(days);
  });
  const conv = Object.keys(byFirm).map((firm) => {
    const d = byFirm[firm];
    return {
      firm, n: d.length,
      avg: Number((d.reduce((s, x) => s + x, 0) / d.length).toFixed(1)),
      min: Math.min(...d), max: Math.max(...d),
    };
  }).sort((a, b) => a.avg - b.avg);

  const waiting = cases.filter((c) => c.waiting_on);
  const liveWaiting = waiting.filter((c) => !["completed", "not_proceeding"].includes(c.stage));

  return {
    ids: {
      ellingham: (caseFor("Sarah Ellingham", "fact_find") || {}).id,
      quirke: (caseFor("Bethany Quirke", "application") || {}).id,
      amery: (caseFor("Rosalind Amery", "application") || {}).id,
      osei: (caseFor("Tanya Osei", "fact_find") || {}).id,
    },
    names: {
      ellingham: nameOf((caseFor("Sarah Ellingham", "fact_find") || {}).client_id),
      quirke: nameOf((caseFor("Bethany Quirke", "application") || {}).client_id),
    },
    perCase,
    conv, unnamedCompletions: unnamed,
    checklistCases: cases.filter((c) => docs.some((d) => d.case_id === c.id)).length,
    noChecklistCases: cases.filter((c) => !docs.some((d) => d.case_id === c.id)).length,
    waitingTotal: waiting.length,
    waitingLive: liveWaiting.length,
    waitingSolicitorNamed: waiting.filter((c) => c.waiting_on === "solicitor").every((c) => !!c.solicitor_firm),
    firms: [...new Set(cases.map((c) => (c.solicitor_firm || "").trim()).filter(Boolean))].sort(),
    docsList: String(settings.docs_list || "").split("|").map((s) => s.trim()).filter(Boolean),
    docChaseEnabled: settings.doc_chase_enabled,
    docChaseDays: Number(settings.doc_chase_days ?? 3) || 3,
    siteUrl: settings.site_url || "",
    queuedMails: mails.filter((m) => m.status === "queued").map((m) => m.id),
    totalMails: mails.length,
    CHASE_MAX,
  };
}, { CHASE_MAX });

(async () => {
  if (!(await serverUp())) {
    const s = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore", detached: true });
    process.on("exit", () => { try { process.kill(-s.pid, "SIGTERM"); } catch (_) {} });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  const owner = await newPage(browser, "p4");
  const G = await groundTruth(owner);

  console.log("\n=== fixtures (recomputed here) ===");
  console.log(`  checklists on ${G.checklistCases} cases · ${G.noChecklistCases} without · firms ${JSON.stringify(G.firms)}`);
  console.log(`  waiting_on set on ${G.waitingTotal} cases (${G.waitingLive} live) · doc_chase_enabled=${G.docChaseEnabled}`);
  console.log(`  conveyancer: ${G.conv.map((c) => `${c.firm} ${c.avg}d (n=${c.n})`).join(" · ")}`);

  console.log("\n=== R9-5 · FIXTURE SHAPE (the four chase states exist) ===");
  /* R12b — this used to be a hard `=== 4`. What it actually protects (per the
     file banner above: "the derived chase status line in all four fixture
     states") is that the four NAMED chase-state fixtures below — Ellingham
     (started, 0 chases), Quirke (mid-chase), Amery (chases maxed out), Osei
     (fully documented) — all exist with a checklist attached; it was never a
     ceiling on how many checklist-bearing cases the book may hold. Loosened
     to >= 4 so a later stage's fixture (e.g. a DIP-stage checklist case) can
     be added without this line going stale; the four named states are still
     verified individually by the eq() checks right below.  */
  ok("fixture · at least the four named chase-state cases carry a checklist", G.checklistCases >= 4, `got ${G.checklistCases}`);
  ok("fixture · the legacy majority has no checklist at all", G.noChecklistCases >= 60, `got ${G.noChecklistCases}`);
  eq("fixture · Ellingham — 4 items, 2 in, 2 outstanding, 0 chases",
    [G.perCase[G.ids.ellingham].items, G.perCase[G.ids.ellingham].received, G.perCase[G.ids.ellingham].outstanding, G.perCase[G.ids.ellingham].chases],
    [4, 2, 2, 0]);
  eq("fixture · Quirke — 3 outstanding, 2 chases spent",
    [G.perCase[G.ids.quirke].outstanding, G.perCase[G.ids.quirke].chases], [3, 2]);
  eq("fixture · Amery — 4 items, 1 waived, 3 outstanding, 3 chases spent (and no token)",
    [G.perCase[G.ids.amery].items, G.perCase[G.ids.amery].waived, G.perCase[G.ids.amery].outstanding, G.perCase[G.ids.amery].chases, G.perCase[G.ids.amery].token],
    [4, 1, 3, 3, null]);
  eq("fixture · Osei — everything in, nothing outstanding",
    [G.perCase[G.ids.osei].outstanding, G.perCase[G.ids.osei].received], [0, 3]);
  ok("fixture · waived is counted by STATUS, not by row (Amery has 4 items and 3 outstanding)",
    G.perCase[G.ids.amery].items !== G.perCase[G.ids.amery].outstanding);
  eq("fixture · doc_chase_enabled ships off", G.docChaseEnabled, "off");

  console.log("\n=== R9-5 · THE DOCUMENTS SECTION ===");
  await openCase(owner, G.ids.quirke);
  ok("Documents section renders on a case with a checklist", await exists(owner, "#case-docs"));
  const qRows = await owner.$$eval("#docs-list .doc-row", (els) => els.map((e) => ({
    item: e.querySelector(".doc-item").textContent.trim(), status: e.dataset.status,
  })));
  eq("every checklist row is drawn, in order, with its status",
    qRows.length, G.perCase[G.ids.quirke].items);
  ok("all three of Quirke's rows read outstanding", qRows.every((r) => r.status === "requested"));
  const qSummary = await txt(owner, "#docs-summary");
  ok("the summary counts outstanding against total", /3 of 3 outstanding/.test(qSummary), qSummary);

  console.log("\n=== R9-5 · CHASE STATUS DERIVATION — all four fixture states ===");
  const chaseLine = async (id) => { await openCase(owner, id); return txt(owner, "#docs-chase-line"); };
  const cEll = await chaseLine(G.ids.ellingham);
  ok("Ellingham (mailed yesterday, no chase yet) · reads 0 of 3 and names a future eligibility date",
    /0 of 3 chases sent/.test(cEll) && /next eligible/.test(cEll), cEll);
  const cQui = await chaseLine(G.ids.quirke);
  ok("Quirke (2 chases, last one outside the quiet window) · reads 2 of 3 and eligible now",
    /2 of 3 chases sent/.test(cQui) && /eligible now/.test(cQui), cQui);
  const cAme = await chaseLine(G.ids.amery);
  ok("Amery (3 chases spent) · reads chases exhausted and says a call task takes over",
    /[Cc]hases exhausted/.test(cAme) && /3 of 3/.test(cAme) && /call task/.test(cAme), cAme);
  const cOse = await chaseLine(G.ids.osei);
  ok("Osei (everything in) · says nothing outstanding, so no chase will ever be sent",
    /nothing is outstanding/.test(cOse) && /no chase/.test(cOse), cOse);
  const noChk = (await owner.evaluate(async () => {
    const db = window.__mockDb;
    const docs = (await db.from("case_documents").select("case_id")).data || [];
    const cases = (await db.from("cases").select("id,stage")).data || [];
    const have = new Set(docs.map((d) => d.case_id));
    return (cases.find((c) => !have.has(c.id) && c.stage === "application") || {}).id;
  }));
  const cNone = await chaseLine(noChk);
  ok("a case with NO checklist · says so, and says an unknown is skipped rather than guessed at",
    /No checklist on this case/.test(cNone) && /skips it entirely/.test(cNone), cNone);
  ok("every chase line names the OFF switch while doc_chase_enabled is off",
    [cEll, cQui].every((t) => /[Aa]utomatic chasing is off/.test(t)));

  console.log("\n=== R9-5 · CHECKLIST CRUD ===");
  await openCase(owner, G.ids.quirke);
  const beforeAdd = await owner.evaluate(async (id) => ((await window.__mockDb.from("case_documents").select("id").eq("case_id", id)).data || []).length, G.ids.quirke);
  await owner.click("#docs-add-btn");
  await owner.waitForTimeout(400);
  ok("Add items… offers the firm's list from Settings",
    (await owner.$$eval("#doc-pick-suggested .doc-pick", (e) => e.map((x) => x.textContent))).length > 0);
  const alreadyDisabled = await owner.$$eval("#doc-pick-suggested input[disabled]", (e) => e.length);
  ok("items already on this checklist are shown ticked and disabled, not hidden", alreadyDisabled >= 1, `got ${alreadyDisabled}`);
  /* THE KIND FILTER. Quirke's case is a buy-to-let, so the firm's list arrives
     with the two buy-to-let extras appended and nothing dropped. The expected
     list is built here from settings.docs_list, not read off the dialog. */
  const pickLabels = await owner.$$eval("#doc-pick-suggested .doc-pick input", (e) => e.map((x) => x.value));
  eq("the suggestions are the firm's list plus that case kind's own documents",
    pickLabels, G.docsList.concat(["Tenancy agreement", "Portfolio schedule"]));
  ok("suggestions not already on the checklist arrive pre-ticked",
    (await owner.$$eval("#doc-pick-suggested input:checked:not([disabled])", (e) => e.length)) > 0);
  /* Untick them, so what lands next is provably the free text and nothing else
     \u2014 the pre-ticking is asserted on its own, immediately above. */
  await owner.$$eval("#doc-pick-suggested input:not([disabled])", (els) => els.forEach((i) => { i.checked = false; }));
  await owner.fill("#doc-free", "Latest SA302\nLandlord reference");
  await owner.click("#doc-add-ok");
  await owner.waitForTimeout(800);
  const afterAdd = await owner.evaluate(async (id) => (await window.__mockDb.from("case_documents").select("*").eq("case_id", id)).data || [], G.ids.quirke);
  eq("free text adds exactly the two typed items", afterAdd.length, beforeAdd + 2);
  ok("added rows are outstanding and dated", afterAdd.filter((d) => d.item === "Latest SA302").every((d) => d.status === "requested" && !!d.requested_at));
  ok("the section repaints without reopening the modal", (await owner.$$eval("#docs-list .doc-row", (e) => e.length)) === afterAdd.length);

  // mark received
  const sa302Id = afterAdd.find((d) => d.item === "Latest SA302").id;
  await owner.click(`.doc-act[data-act="received"][data-doc="${sa302Id}"]`);
  await owner.waitForTimeout(700);
  const sa302 = await owner.evaluate(async (i) => (await window.__mockDb.from("case_documents").select("*").eq("id", i).single()).data, sa302Id);
  eq("Mark received sets the status and stamps received_at", [sa302.status, !!sa302.received_at], ["received", true]);
  ok("the row now shows the received chip", await exists(owner, `.doc-row[data-doc="${sa302Id}"][data-status="received"]`));

  // undo
  await owner.click(`.doc-act[data-act="undo"][data-doc="${sa302Id}"]`);
  await owner.waitForTimeout(700);
  const sa302b = await owner.evaluate(async (i) => (await window.__mockDb.from("case_documents").select("*").eq("id", i).single()).data, sa302Id);
  eq("Undo returns it to outstanding and clears the received date", [sa302b.status, sa302b.received_at], ["requested", null]);

  // waive, with a reason
  const lrId = afterAdd.find((d) => d.item === "Landlord reference").id;
  await owner.click(`.doc-act[data-act="waive"][data-doc="${lrId}"]`);
  await owner.waitForTimeout(400);
  ok("waiving asks why, and says plainly that it is not a delete",
    /not a delete/i.test(await txt(owner, "#overlay-modal") || ""));
  await owner.fill("#doc-waive-note", "Company let — no landlord to reference");
  await owner.click("#doc-waive-ok");
  await owner.waitForTimeout(700);
  const lr = await owner.evaluate(async (i) => (await window.__mockDb.from("case_documents").select("*").eq("id", i).single()).data, lrId);
  eq("Waive stores the status and the reason verbatim",
    [lr.status, lr.note], ["waived", "Company let — no landlord to reference"]);
  ok("the waived row still appears on the checklist (it is a record, not a deletion)",
    await exists(owner, `.doc-row[data-doc="${lrId}"][data-status="waived"]`));
  ok("the waived reason is shown on the row", /Company let/.test(await txt(owner, `.doc-row[data-doc="${lrId}"] .doc-note`) || ""));
  const sumAfterWaive = await txt(owner, "#docs-summary");
  ok("a waived item is not counted as outstanding", /1 waived/.test(sumAfterWaive), sumAfterWaive);

  // delete (owner)
  owner.__answers = ["accept"];
  await owner.click(`.doc-act[data-act="delete"][data-doc="${lrId}"]`);
  await owner.waitForTimeout(700);
  const delConfirm = (owner.__dialogs.slice(-1)[0] || {}).message || "";
  ok("delete confirms, and points at Waive as the thing you probably meant", /Waive instead/i.test(delConfirm), delConfirm);
  const gone = await owner.evaluate(async (i) => ((await window.__mockDb.from("case_documents").select("id").eq("id", i)).data || []).length, lrId);
  eq("the row is deleted", gone, 0);
  // tidy up: put the case back the way the fixtures left it
  await owner.evaluate(async (i) => { await window.__mockDb.from("case_documents").delete().eq("id", i); }, sa302Id);

  console.log("\n=== R9-5 · ROLE RULES ===");
  eq("owner sees a delete control on every row",
    await owner.$$eval('#docs-list .doc-act[data-act="delete"]', (e) => e.length),
    await owner.$$eval("#docs-list .doc-row", (e) => e.length));
  const adviser = await newPage(browser, "p2");
  await openCase(adviser, G.ids.quirke);
  eq("an adviser is offered NO delete control at all", await adviser.$$eval('#docs-list .doc-act[data-act="delete"]', (e) => e.length), 0);
  ok("…but can still mark received and waive — the checklist is their daily work",
    (await adviser.$$eval('#docs-list .doc-act[data-act="received"]', (e) => e.length)) > 0
    && (await adviser.$$eval('#docs-list .doc-act[data-act="waive"]', (e) => e.length)) > 0);
  const admin = await newPage(browser, "p1");
  await openCase(admin, G.ids.quirke);
  ok("an administrator does get delete (the rule is Owner/Administrator, not Owner)",
    (await admin.$$eval('#docs-list .doc-act[data-act="delete"]', (e) => e.length)) > 0);

  console.log("\n=== R9-5 · THE UPLOAD LINK ===");
  await openCase(owner, G.ids.ellingham);
  eq("a case that already has a token offers Copy, not Create",
    /Copy upload link/.test(await txt(owner, "#docs-link-btn") || ""), true);
  await owner.click("#docs-link-btn");
  await owner.waitForTimeout(600);
  const ellUrl = await owner.$eval("#docs-link-input", (e) => e.value);
  eq("the existing token is reused, never regenerated",
    ellUrl, `${G.siteUrl.replace(/\/+$/, "")}/docs?token=${G.perCase[G.ids.ellingham].token}`);
  ok("the link is the /docs clean URL with the token in the query string", /\/docs\?token=/.test(ellUrl), ellUrl);
  const warn = await txt(owner, "#docs-link-warn");
  ok("the bearer warning is stated plainly — anyone with the link can upload",
    /Anyone with this link can upload/i.test(warn) && /does not ask for a login/i.test(warn), warn);
  ok("…and it says what the page discloses (first name and the list, nothing else)",
    /first name/i.test(warn), warn);

  await openCase(owner, G.ids.amery);
  eq("a case with no token offers Create", /Create upload link/.test(await txt(owner, "#docs-link-btn") || ""), true);
  await owner.click("#docs-link-btn");
  await owner.waitForTimeout(700);
  const ameryToken = await owner.evaluate(async (i) => (await window.__mockDb.from("cases").select("doc_token").eq("id", i).single()).data.doc_token, G.ids.amery);
  ok("a token is generated and PERSISTED to the case", !!ameryToken && ameryToken.length >= 18, String(ameryToken));
  eq("the copied link carries the token that was just saved",
    await owner.$eval("#docs-link-input", (e) => e.value), `${G.siteUrl.replace(/\/+$/, "")}/docs?token=${ameryToken}`);
  await owner.click("#docs-link-btn");
  await owner.waitForTimeout(600);
  eq("pressing Copy again does NOT mint a second token",
    await owner.evaluate(async (i) => (await window.__mockDb.from("cases").select("doc_token").eq("id", i).single()).data.doc_token, G.ids.amery),
    ameryToken);
  const reopened = await owner.evaluate(async (i) => {
    await window.openCase(i);
    await new Promise((r) => setTimeout(r, 900));
    return document.querySelector("#docs-link-btn").textContent;
  }, G.ids.amery);
  ok("the token survives a reopen — the button now says Copy", /Copy upload link/.test(reopened), reopened);
  // put Amery back the way the fixtures left her: no token
  await owner.evaluate(async (i) => { await window.__mockDb.from("cases").update({ doc_token: null }).eq("id", i); }, G.ids.amery);

  console.log("\n=== R9-5 · SEND DOCUMENT REQUEST NOW (scoped — never a flush) ===");
  const mailsBefore = await owner.evaluate(async () => (await window.__mockDb.from("email_queue").select("id,case_id,email_type,status")).data || []);
  const queuedBefore = mailsBefore.filter((m) => m.status === "queued").map((m) => m.id).sort();
  await openCase(owner, G.ids.quirke);
  owner.__dialogs = [];
  await owner.click("#docs-send-btn");
  await owner.waitForTimeout(1400);
  const sendConfirm = (owner.__dialogs[0] || {}).message || "";
  ok("the confirm names the recipient and the exact items the client will read",
    /Send document request email to/.test(sendConfirm) && /still outstanding \(3\)/.test(sendConfirm), sendConfirm);
  const mailsAfter = await owner.evaluate(async () => (await window.__mockDb.from("email_queue").select("id,case_id,email_type,status")).data || []);
  const added = mailsAfter.filter((m) => !mailsBefore.some((b) => b.id === m.id));
  eq("exactly ONE email row is created", added.length, 1);
  eq("…it is a docs_request on this case", [added[0].email_type, added[0].case_id], ["docs_request", G.ids.quirke]);
  const stillQueued = mailsAfter.filter((m) => queuedBefore.includes(m.id) && m.status === "queued").map((m) => m.id).sort();
  eq("every other queued email is untouched — the queue was not flushed", stillQueued, queuedBefore);

  await openCase(owner, G.ids.osei);
  owner.__dialogs = [];
  const mailsPreOsei = await owner.evaluate(async () => ((await window.__mockDb.from("email_queue").select("id")).data || []).length);
  await owner.click("#docs-send-btn");
  await owner.waitForTimeout(900);
  eq("a checklist with nothing outstanding REFUSES to send — no confirm, no email",
    [owner.__dialogs.length, await owner.evaluate(async () => ((await window.__mockDb.from("email_queue").select("id")).data || []).length)],
    [0, mailsPreOsei]);
  ok("…and says why", /nothing to ask for/i.test(await txt(owner, "#toast") || ""));

  console.log("\n=== R9-5b · WAITING ON + SOLICITOR ===");
  await openCase(owner, G.ids.quirke);
  await openDetails(owner);
  await owner.waitForTimeout(200);
  ok("the case form has a Waiting on select", await exists(owner, "#case-waiting-select"));
  eq("its options are exactly — / client / lender / solicitor / other",
    await owner.$$eval("#case-waiting-select option", (e) => e.map((o) => o.value)),
    ["", "client", "lender", "solicitor", "other"]);
  eq("it opens on the value the case holds", await owner.$eval("#case-waiting-select", (e) => e.value), "client");
  eq("the solicitor datalist offers every firm already on the book",
    await owner.$$eval("#case-solicitor-firms option", (e) => e.map((o) => o.value).sort()), G.firms);
  await owner.selectOption("#case-waiting-select", "solicitor");
  await owner.fill("#case-solicitor-input", "  Trelawny Conveyancing  ");
  await owner.click("#modal-save");
  await owner.waitForTimeout(1300);
  eq("both fields save, and the firm name is trimmed (the report groups on this exact string)",
    await owner.evaluate(async (i) => { const r = (await window.__mockDb.from("cases").select("waiting_on,solicitor_firm").eq("id", i).single()).data; return [r.waiting_on, r.solicitor_firm]; }, G.ids.quirke),
    ["solicitor", "Trelawny Conveyancing"]);

  await gotoPipeline(owner);
  const boardChips = await owner.$$eval("#board .wait-chip", (e) => e.map((x) => x.textContent.trim()));
  eq("the board shows one waiting-on chip per live case that has one", boardChips.length, G.waitingLive);
  ok("the chip names who, in lower case, and stays quiet (no red/amber badge class)",
    boardChips.every((t) => /^⏳ (client|lender|solicitor|someone else)/.test(t)),
    JSON.stringify(boardChips.slice(0, 3)));
  ok("a solicitor chip names the firm beside it",
    boardChips.some((t) => /^⏳ solicitor · /.test(t)), JSON.stringify(boardChips.filter((t) => /solicitor/.test(t)).slice(0, 3)));
  ok("the aging colouring is untouched — cards still carry their age classes",
    (await owner.$$eval("#board .card.age-red, #board .card.age-amber", (e) => e.length)) > 0);
  await owner.click("#view-toggle");
  await owner.waitForTimeout(1400);
  const tableChips = await owner.$$eval("#pipe-table .wait-chip", (e) => e.length).catch(() => 0);
  /* PATCHED R65 · H7b — the chip MOVED from inside the Stage cell to its own sortable column.
     The R9 contract these two lines encoded ("one chip per live case that has one, on the table
     as well as the board") is unchanged and still asserted; what changed is WHICH cell it lives
     in, and the column it now has is the whole point — a chip nested in the Stage cell could not
     be sorted on, and "everything sitting with a solicitor" is the question the table is read
     with. The old expectation is inverted, not deleted, so a regression back into the Stage cell
     would fail here. */
  eq("the pipeline table shows the same chips, in their own Waiting-on column", tableChips, G.waitingLive);
  eq("R65 · the table now HAS a Waiting-on column (the chip is sortable)",
    await owner.$$eval("#pipe-table th", (e) => e.map((x) => x.textContent.replace(/[▲▼]/g, "").trim()).filter(Boolean).includes("Waiting on")),
    true);
  eq("R65 · …and the chips are in that column, not in the Stage cell",
    await owner.$$eval("#pipe-table td.pipe-col-waiting .wait-chip", (e) => e.length), G.waitingLive);

  console.log("\n=== R9-6 · CONVEYANCER SPEED (Reports, Owner-only) ===");
  await gotoReports(owner);
  ok("the panel is on the page for an Owner", await exists(owner, "#report-conveyancer-panel:not(.hidden)"));
  const convRows = await owner.$$eval("#conv-table tr", (els) => els.slice(1).map((tr) => {
    const td = [...tr.querySelectorAll("td")];
    return {
      firm: td[0].textContent.replace("slowest", "").trim(),
      n: Number(td[1].textContent.trim()),
      avg: Number(td[2].textContent.replace(/\(n<\d\)/, "").trim()),
      range: td[3].textContent.trim(),
      slowest: tr.classList.contains("conv-slowest"),
      thin: /\(n<\d\)/.test(td[2].textContent),
    };
  }));
  /* NOTE the ground truth for this block is computed above from the fixture
     rows, in this file, with its own expression — the panel is never asked
     what it thinks the answer is. */
  eq("one row per firm, fastest first", convRows.map((r) => r.firm), G.conv.map((r) => r.firm));
  eq("case counts match the fixtures", convRows.map((r) => r.n), G.conv.map((r) => r.n));
  eq("average days match an independent recomputation", convRows.map((r) => r.avg), G.conv.map((r) => r.avg));
  eq("ranges match", convRows.map((r) => r.range), G.conv.map((r) => `${r.min}–${r.max}`));
  near("Harker & Bligh averages 38.1 days", (G.conv.find((r) => /Harker/.test(r.firm)) || {}).avg, 38.1, 0.15);
  near("Trelawny averages 51.7 days", (G.conv.find((r) => /Trelawny/.test(r.firm)) || {}).avg, 51.7, 0.15);
  near("Bexley Rowe averages 63.9 days", (G.conv.find((r) => /Bexley/.test(r.firm)) || {}).avg, 63.9, 0.15);
  eq("the slowest firm with enough cases behind it is highlighted, and only it",
    convRows.filter((r) => r.slowest).map((r) => r.firm), [G.conv[G.conv.length - 1].firm]);
  ok("no row with n≥3 is marked thin", convRows.filter((r) => r.n >= CONV_MIN_N).every((r) => !r.thin));
  const convBasis = await txt(owner, "#report-conveyancer-basis");
  ok("the basis says submission→completion, and says WHY it is not offer→completion",
    /application submitted/i.test(convBasis) && /completed/i.test(convBasis) && /no date an offer was issued/i.test(convBasis), convBasis);
  const convFoot = await txt(owner, "#conv-basis");
  ok("the footnote states the sample and how far apart the fastest and slowest firms are",
    new RegExp(`${G.conv.reduce((s, r) => s + r.n, 0)} completions across ${G.conv.length} firms`).test(convFoot)
    && /days between your fastest and slowest firm/.test(convFoot), convFoot);
  ok("completions with no solicitor are excluded and SAID to be excluded, with the product-transfer reason",
    /name no solicitor/.test(convFoot) && /product transfer has no conveyancer/.test(convFoot), convFoot);

  // n<3 marking — induce it rather than assume the fixtures happen to have one
  const thinCaseId = await owner.evaluate(async () => {
    const db = window.__mockDb;
    const cs = (await db.from("cases").select("id,stage,submitted_at,completed_at,solicitor_firm")).data || [];
    const t = cs.find((c) => c.stage === "completed" && c.submitted_at && c.completed_at && c.solicitor_firm);
    await db.from("cases").update({ solicitor_firm: "Pinner & Wade (one case)" }).eq("id", t.id);
    return t.id;
  });
  await gotoReports(owner);
  const thinRow = await owner.$$eval("#conv-table tr", (els) => els.slice(1).map((tr) => {
    const td = [...tr.querySelectorAll("td")];
    return { firm: td[0].textContent.trim(), n: Number(td[1].textContent.trim()), thin: /\(n<\d\)/.test(td[2].textContent) };
  }).find((r) => /Pinner/.test(r.firm)));
  eq("a firm with one completion is shown, with n and an (n<3) marker — not hidden",
    [thinRow && thinRow.n, thinRow && thinRow.thin], [1, true]);
  const slowestNow = await owner.$$eval("#conv-table tr.conv-slowest td:first-child", (e) => e.map((x) => x.textContent.trim()));
  ok("a thin row is never called the slowest", !slowestNow.some((s) => /Pinner/.test(s)), JSON.stringify(slowestNow));
  await owner.evaluate(async (id) => { await window.__mockDb.from("cases").update({ solicitor_firm: null }).eq("id", id); }, thinCaseId);

  const adviserReports = adviser;
  await gotoReports(adviserReports);
  ok("an adviser does not see the panel at all", !(await exists(adviserReports, "#report-conveyancer-panel:not(.hidden)")));

  console.log("\n=== R9-7 · SETTINGS HONESTY ===");
  await gotoSettings(owner);
  eq("the doc_chase_enabled toggle is on the page and reads Off",
    await owner.$eval('[name="doc_chase_enabled"]', (e) => e.value), "off");
  const chaseCopy = await txt(owner, "#doc-chase-note");
  ok("copy states the 3-day cadence", new RegExp(`every ${G.docChaseDays} days`).test(chaseCopy), chaseCopy);
  ok("copy states that only MISSING items are listed", /only the items still missing/i.test(chaseCopy), chaseCopy);
  ok("copy states the max of 3 and what replaces the fourth email", /3 chases it stops emailing/i.test(chaseCopy) && /call task/i.test(chaseCopy), chaseCopy);
  // R12b · W-24 — the chase widened from "Fact Find or Application" to every live stage
  // (Enquiry through Exchange); the copy now says so explicitly, and names the old two-stage rule
  // as what it was widened FROM, so this assertion reads the actual new sentence rather than a
  // guess at its wording.
  ok("copy states which cases are chased (every live stage, widened from Fact Find/Application) and that a case with no checklist is skipped",
    /live stage.{0,20}covered/i.test(chaseCopy) && /Enquiry through Exchange/.test(chaseCopy) && /widened from Fact Find and Application only/.test(chaseCopy) && /skipped/.test(chaseCopy), chaseCopy);
  ok("copy states the dependency — nothing sends without email sending configured",
    /Requires email sending to be set up/i.test(chaseCopy) && /Resend/.test(chaseCopy), chaseCopy);
  const docsListCopy = await txt(owner, "#setting-note-docs_list");
  ok("the docs_list description now mentions per-case checklists and which one wins",
    /checklist/i.test(docsListCopy) && /that checklist wins/i.test(docsListCopy), docsListCopy);
  ok("…and says editing the firm list does not rewrite checklists already built",
    /does not change any checklist already built/i.test(docsListCopy), docsListCopy);

  console.log("\n=== R9-5 · m10 ABSENT — the whole feature degrades, nothing breaks ===");
  const off = await newPage(browser, "p4");
  await off.evaluate(() => window.__mock.setMigrations({ m10: false }));
  await off.reload();
  await off.waitForTimeout(SETTLE);
  await off.evaluate(() => window.__mock.setMigrations({ m10: false }));
  await openCase(off, G.ids.quirke, 1300);
  ok("no Documents section", !(await exists(off, "#case-docs")));
  await openDetails(off);
  ok("no Waiting on select", !(await exists(off, "#case-waiting-select")));
  ok("no Solicitor field", !(await exists(off, "#case-solicitor-field")));
  ok("the rest of the case modal still renders", await exists(off, "#case-form"));
  await off.evaluate(() => window.closeModal());
  await gotoPipeline(off);
  eq("no waiting-on chips anywhere on the board", await off.$$eval(".wait-chip", (e) => e.length), 0);
  await gotoReports(off);
  const offConv = await txt(off, "#report-conveyancer-body");
  ok("the conveyancer panel says the migration is absent — it does not show a confident zero",
    /has not taken migration/i.test(offConv) && /m10/.test(offConv) && /it is an absence/i.test(offConv), offConv);
  eq("no console errors with the migration off", off.__err, []);

  console.log("\n=== R9-8a · THE DEPLOYED doc-upload CONTRACT ===");
  /* Driven straight at the endpoint from a public page context, because the
     page can only ever exercise the handful of paths its own UI produces —
     and every one of these codes is a path a real client WILL reach. One page,
     no navigations: the mock re-seeds on every load, so mutating the fixture
     DB and reading it back has to happen inside a single document. */
  const cp = await newPublicPage(browser, `${ORIGIN}/docs.html?token=${G.perCase[G.ids.ellingham].token}`, { width: 1280, height: 900 });
  const C = await cp.evaluate(async ({ ameryId, ellToken }) => {
    const F = window.__NEX_FN_BASE + "/doc-upload";
    const db = window.supabase.createClient("https://mock.supabase.co", "k");
    const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 11, 12, 13];
    const JPG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8];
    const file = (name, bytes) => new File([new Uint8Array(bytes)], name, {});
    const fd = (parts) => {
      const f = new FormData();
      Object.keys(parts).forEach((k) => { const v = parts[k]; if (v == null) return; if (v instanceof File) f.append(k, v, v.name); else f.append(k, v); });
      return f;
    };
    const post = async (parts, url) => {
      const r = await fetch(url || F, { method: "POST", body: fd(parts) });
      let j = null; try { j = await r.json(); } catch (e) {}
      return { status: r.status, body: j };
    };
    const get = await (await fetch(F + "?token=" + encodeURIComponent(ellToken), { method: "GET" })).json();
    const item3 = get.items.filter((d) => d.status === "requested")[0];
    const item4 = get.items.filter((d) => d.status === "requested")[1];
    const out = { get };

    // a JSON body is refused before any logic runs
    const jr = await fetch(F, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: ellToken, item_id: item3.id }) });
    out.jsonBody = jr.status;

    // the honeypot: 200, a bare {ok:true}, and nothing written
    const beforeHp = ((await db.from("case_documents").select("*").eq("id", item3.id)).data || [])[0].status;
    out.honeypot = await post({ token: ellToken, item_id: item3.id, website: "http://spam.example", file: file("a.pdf", PDF) });
    out.honeypotWroteNothing = ((await db.from("case_documents").select("*").eq("id", item3.id)).data || [])[0].status === beforeHp;

    // the token is read from the BODY; a query-string token is ignored on POST
    out.queryTokenOnly = (await post({ item_id: item3.id, file: file("a.pdf", PDF) }, F + "?token=" + encodeURIComponent(ellToken))).status;
    // the item is matched on ID; its NAME is not a substitute
    out.nameNotId = (await post({ token: ellToken, item: item3.item, file: file("a.pdf", PDF) })).status;
    out.noItemId = (await post({ token: ellToken, file: file("a.pdf", PDF) })).status;
    out.noToken = (await post({ item_id: item3.id, file: file("a.pdf", PDF) })).status;
    out.deadToken = (await post({ token: "not-a-real-token", item_id: item3.id, file: file("a.pdf", PDF) })).status;
    out.unknownItem = (await post({ token: ellToken, item_id: "cd-does-not-exist", file: file("a.pdf", PDF) })).status;
    out.noFile = (await post({ token: ellToken, item_id: item3.id })).status;
    out.emptyFile = (await post({ token: ellToken, item_id: item3.id, file: file("a.pdf", []) })).status;
    out.badExtension = (await post({ token: ellToken, item_id: item3.id, file: file("a.txt", [104, 105]) })).status;
    out.magicMismatch = (await post({ token: ellToken, item_id: item3.id, file: file("a.pdf", [104, 105, 106, 107, 108]) })).status;
    out.tooBig = (await post({ token: ellToken, item_id: item3.id, file: new File([new Uint8Array(11 * 1024 * 1024)], "big.pdf", {}) })).status;
    window.__mock.failDocStorageOnce();
    out.storageFailure = (await post({ token: ellToken, item_id: item3.id, file: file("a.pdf", PDF) })).status;

    // …and the one that works
    out.success = await post({ token: ellToken, item_id: item3.id, file: file("a.pdf", PDF) });
    out.rowAfter = ((await db.from("case_documents").select("*").eq("id", item3.id)).data || [])[0];
    out.noteAfter = ((await db.from("case_notes").select("*")).data || []).filter((n) => n.body === "Document received via upload link: " + item3.item).map((n) => n.created_by);
    // the same item again is a 409 carrying its status
    out.duplicate = await post({ token: ellToken, item_id: item3.id, file: file("a.pdf", PDF) });
    // a JPG is accepted too — the extension list is not pdf-only
    out.jpgOk = await post({ token: ellToken, item_id: item4.id, file: file("photo.jpg", JPG) });

    // WAIVED IS FILTERED SERVER-SIDE. Amery is the only checklist with a waived
    // row; she has no token, so one is lent to her inside this document only.
    await db.from("cases").update({ doc_token: "contract-probe-token" }).eq("id", ameryId);
    const ameryGet = await (await fetch(F + "?token=contract-probe-token", { method: "GET" })).json();
    const ameryRows = (await db.from("case_documents").select("*").eq("case_id", ameryId)).data || [];
    const waivedRow = ameryRows.filter((d) => d.status === "waived")[0];
    out.amery = {
      rowsInDb: ameryRows.length,
      itemsReturned: ameryGet.items.length,
      anyWaivedReturned: ameryGet.items.some((d) => d.status === "waived"),
      outstanding: ameryGet.outstanding,
      // an id the GET never showed is "unknown", not "waived"
      waivedIdStatus: (await post({ token: "contract-probe-token", item_id: waivedRow.id, file: file("a.pdf", PDF) })).status,
    };

    // the rate cap, shrunk from the mock hook so it is reachable in a test
    window.__mock.setDocUploadRateCap(2);
    window.__mock.resetDocUploadRate();
    const r = [];
    for (let i = 0; i < 3; i++) r.push((await post({ token: "contract-probe-token", item_id: "cd-does-not-exist", file: file("a.pdf", PDF) })).status);
    out.rate = r;
    window.__mock.setDocUploadRateCap(20);
    return out;
  }, { ameryId: G.ids.amery, ellToken: G.perCase[G.ids.ellingham].token });

  eq("GET · returns the firm's name, a first name, the items and an integer outstanding count",
    [typeof C.get.company, typeof C.get.first_name, Array.isArray(C.get.items), typeof C.get.outstanding],
    ["string", "string", true, "number"]);
  eq("GET · every item carries an id, a name and a status",
    C.get.items.every((d) => d.id && d.item && d.status), true);
  eq("GET · outstanding is the count of requested items, as a number",
    C.get.outstanding, C.get.items.filter((d) => d.status === "requested").length);
  eq("POST · a JSON body is a 400 before any logic runs", C.jsonBody, 400);
  eq("POST · the honeypot answers 200 with a bare {ok:true} — no item, no count",
    [C.honeypot.status, C.honeypot.body.ok, "item" in C.honeypot.body, "outstanding" in C.honeypot.body],
    [200, true, false, false]);
  eq("POST · …and writes absolutely nothing", C.honeypotWroteNothing, true);
  eq("POST · the token is read from the BODY — a query-string token is ignored", C.queryTokenOnly, 400);
  eq("POST · the item is matched on item_id; sending its NAME is not a substitute", C.nameNotId, 400);
  eq("400 · no item_id", C.noItemId, 400);
  eq("400 · no token", C.noToken, 400);
  eq("400 · no file part", C.noFile, 400);
  eq("400 · an empty file", C.emptyFile, 400);
  eq("404 · a dead link", C.deadToken, 404);
  eq("404 · an item that is not on this checklist", C.unknownItem, 404);
  eq("413 · a file over 10MB", C.tooBig, 413);
  eq("415 · an extension that is not on the accepted list", C.badExtension, 415);
  eq("415 · bytes that disagree with the extension", C.magicMismatch, 415);
  eq("500 · a storage failure", C.storageFailure, 500);
  eq("429 · the per-link rate cap, once it is reached", C.rate, [404, 404, 429]);
  eq("200 · success returns {ok, item, outstanding} and nothing else",
    [C.success.status, C.success.body.ok, typeof C.success.body.item, typeof C.success.body.outstanding, Object.keys(C.success.body).sort()],
    [200, true, "string", "number", ["item", "ok", "outstanding"]]);
  eq("200 · the row is marked received, dated, and given a storage path",
    [C.rowAfter.status, !!C.rowAfter.received_at, !!C.rowAfter.storage_path], ["received", true, true]);
  eq("200 · the case note is written once, by nobody (service role)", C.noteAfter, [null]);
  eq("409 · the same item again, carrying its current status",
    [C.duplicate.status, C.duplicate.body.status], [409, "received"]);
  eq("200 · a JPG is accepted too — the list is not pdf-only",
    [C.jpgOk.status, C.jpgOk.body.ok], [200, true]);
  ok("waived items are filtered out of the GET server-side",
    C.amery.rowsInDb === G.perCase[G.ids.amery].items
    && C.amery.itemsReturned === G.perCase[G.ids.amery].visible
    && C.amery.anyWaivedReturned === false,
    JSON.stringify(C.amery));
  eq("…so a waived item's id is UNKNOWN to a client, not merely refused", C.amery.waivedIdStatus, 404);
  eq("zero console errors while exercising the whole contract", cp.__err, []);
  await cp.close();

  console.log("\n=== R9-8 · /docs — the client upload page ===");
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const tag = `${vp.width}px`;
    const dp = await newPublicPage(browser, `${ORIGIN}/docs.html?token=${G.perCase[G.ids.ellingham].token}`, vp, { record: true });
    const shown = await dp.evaluate(() => ["loading", "invalid", "alldone", "page"].filter((i) => document.getElementById(i).style.display !== "none"));
    eq(`${tag} · a valid token renders the checklist page`, shown, ["page"]);
    eq(`${tag} · the greeting uses the first name and nothing else`, await txt(dp, "#greeting"), "Hi Sarah");
    const body = await dp.evaluate(() => document.body.innerText);
    // The reviewed Stonebridge compliance footer (Aug 2026) carries a MANDATORY, boilerplate FCA
    // fee disclosure ("Typically, we charge a fee of £375…") — identical for every client, NOT the
    // client's own figures. Strip that one sentence before the money check so the privacy guarantee
    // (no CLIENT-SPECIFIC money/PII leaks onto the public upload page) still holds against any OTHER £.
    const bodyNoFeeBoilerplate = body.replace(/Typically, we charge a fee[\s\S]*?fee waiver agreement\./i, "");
    ok(`${tag} · no surname, email, address or client-specific money appears (the standard FCA fee-disclosure footer is allowed)`,
      !/Ellingham/i.test(body) && !/@/.test(body) && !/£/.test(bodyNoFeeBoilerplate), body.slice(0, 200));
    const getCall = await dp.evaluate(() => window.__calls[0]);
    eq(`${tag} · the page opens with a GET carrying the token on the query string`,
      [getCall.method, /\?token=/.test(getCall.url), getCall.bodyType], ["GET", true, null]);
    const rows = await dp.$$eval(".doc", (e) => e.map((x) => ({ item: x.dataset.item, status: x.dataset.status })));
    eq(`${tag} · every item the server returned is listed, received ones included`, rows.length, G.perCase[G.ids.ellingham].visible);
    eq(`${tag} · no waived item is ever drawn (the server does not send them)`,
      rows.filter((r) => r.status === "waived").length, 0);
    eq(`${tag} · the two already-received items are shown ticked`,
      rows.filter((r) => r.status === "received").length, G.perCase[G.ids.ellingham].received);
    eq(`${tag} · only outstanding items get a file input`,
      await dp.$$eval('.doc input[type="file"]', (e) => e.length), G.perCase[G.ids.ellingham].outstanding);
    ok(`${tag} · the page picked up the firm's name from the GET`,
      /Money/.test(await txt(dp, ".brand") || ""));
    eq(`${tag} · the accept list is pdf/jpg/png/heic`,
      await dp.$eval('.doc input[type="file"]', (e) => e.accept.split(",").map((s) => s.trim()).filter((s) => s.startsWith("."))),
      [".pdf", ".jpg", ".jpeg", ".png", ".heic", ".heif"]);
    ok(`${tag} · the 10MB rule is stated before anybody picks a file`, /10MB/.test(await txt(dp, ".rules") || ""));
    const overflow = await dp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`${tag} · nothing overflows horizontally`, overflow <= 1, `overflow ${overflow}px`);
    if (vp.width === 390) {
      // a file that is too big is refused locally, before any upload
      const idx = await dp.evaluate(() => [...document.querySelectorAll(".doc")].findIndex((e) => e.dataset.status === "requested"));
      await dp.setInputFiles(`#file-${idx}`, { name: "huge.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(11 * 1024 * 1024, 1) });
      await dp.waitForTimeout(300);
      ok("390px · an 11MB file is refused on the device, with the size named", /over the 10MB limit/.test(await txt(dp, `#err-${idx}`) || ""));
      eq("390px · …and Send stays disabled", await dp.$eval(`#send-${idx}`, (e) => e.disabled), true);
      await dp.setInputFiles(`#file-${idx}`, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
      await dp.waitForTimeout(300);
      ok("390px · a .txt is refused with the accepted types named", /PDF, JPG, PNG or HEIC/.test(await txt(dp, `#err-${idx}`) || ""));

      // …and a good one goes all the way through
      const notesBefore = await dp.evaluate(async (id) => ((await window.supabase.createClient("https://mock.supabase.co", "k").from("case_notes").select("id").eq("case_id", id)).data || []).length, G.ids.ellingham);
      await dp.setInputFiles(`#file-${idx}`, { name: "statements.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 statements") });
      await dp.waitForTimeout(250);
      eq("390px · a valid file enables Send", await dp.$eval(`#send-${idx}`, (e) => e.disabled), false);
      const item = await dp.evaluate((i) => document.querySelectorAll(".doc")[i].dataset.item, idx);
      await dp.click(`#send-${idx}`);
      await dp.waitForTimeout(900);
      const after = await dp.evaluate(async (id) => {
        const db = window.supabase.createClient("https://mock.supabase.co", "k");
        return {
          docs: ((await db.from("case_documents").select("*").eq("case_id", id)).data || []).map((d) => [d.item, d.status]),
          notes: ((await db.from("case_notes").select("*").eq("case_id", id)).data || []).map((n) => n.body),
        };
      }, G.ids.ellingham);
      ok("390px · the upload marks the item received on the case", after.docs.some(([i2, s]) => i2 === item && s === "received"), JSON.stringify(after.docs));
      ok("390px · …and writes the case note the adviser will see",
        after.notes.includes(`Document received via upload link: ${item}`), JSON.stringify(after.notes.slice(-2)));
      eq("390px · exactly one new note, not one per render", after.notes.length, notesBefore + 1);
      ok("390px · the page confirms it in words", /received — thank you/i.test(await txt(dp, "#banner") || ""));
      eq("390px · the row is now ticked",
        await dp.$$eval(".doc.is-done", (e) => e.length), G.perCase[G.ids.ellingham].received + 1);

      /* WHAT THE PAGE ACTUALLY SENT. This is the assertion that would have
         caught the first version of this page, which posted JSON and passed a
         lenient stub while 400-ing against the deployed function. */
      const calls = await dp.evaluate(() => window.__calls);
      const post = calls.filter((c) => c.method === "POST").slice(-1)[0];
      eq("390px · the upload is a POST", post.method, "POST");
      eq("390px · …sent as multipart/form-data, not JSON", [post.isFormData, post.bodyType], [true, "object"]);
      eq("390px · …with NO Content-Type header set by hand (it would drop the boundary)", post.headerKeys, []);
      eq("390px · …to the bare function URL, with nothing in the query string", /\?/.test(post.url), false);
      eq("390px · the parts are exactly token, item_id and file",
        Object.keys(post.parts).sort(), ["file", "item_id", "token"]);
      eq("390px · the token part is the case's token, in the BODY",
        post.parts.token, G.perCase[G.ids.ellingham].token);
      const sentItem = G.perCase[G.ids.ellingham].ids.find((d) => d.item === item);
      eq("390px · item_id is the item's ID, never its name", post.parts.item_id, sentItem.id);
      eq("390px · the file part carries a real file WITH its filename",
        [post.parts.file.file, post.parts.file.name], [true, "statements.pdf"]);
      ok("390px · the honeypot field is not sent", !("website" in post.parts));
      eq("390px · one file per request", Object.keys(post.parts).filter((k) => post.parts[k] && post.parts[k].file).length, 1);
      eq("390px · the response's outstanding count is used — no second GET after a success",
        calls.filter((c) => c.method === "GET").length, 1);

      /* A SUCCESS HAS TO LOOK LIKE ONE. The honeypot answers 200 with a bare
         {ok:true}; a page that treats that as an upload shows a client a tick
         for a document nobody has. */
      await dp.evaluate(() => {
        const orig = window.fetch;
        window.fetch = function (input, init) {
          if (init && init.method === "POST") {
            window.fetch = orig;
            return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
          }
          return orig.apply(this, arguments);
        };
      });
      const idxHp = await dp.evaluate(() => [...document.querySelectorAll(".doc")].findIndex((e) => e.dataset.status === "requested"));
      await dp.setInputFiles(`#file-${idxHp}`, { name: "deposit.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) });
      await dp.waitForTimeout(250);
      await dp.click(`#send-${idxHp}`);
      await dp.waitForTimeout(700);
      ok("390px · a bare {ok:true} is NOT treated as an upload", /didn't go through/i.test(await txt(dp, `#err-${idxHp}`) || ""));
      eq("390px · …and the row is not ticked", await dp.$eval(`#doc-${idxHp}`, (e) => e.dataset.status), "requested");
      eq("390px · …and Send is offered again", await dp.$eval(`#send-${idxHp}`, (e) => e.disabled), false);

      /* 409 — somebody in the office ticked it off while this page was open.
         The page must not show an error dead end; it re-reads the list. */
      const dupId = await dp.evaluate(async (i) => {
        const db = window.supabase.createClient("https://mock.supabase.co", "k");
        const id = document.querySelectorAll(".doc")[i].id.replace("doc-", "");
        const items = (await db.from("case_documents").select("*")).data || [];
        const name = document.querySelectorAll(".doc")[i].dataset.item;
        const row = items.find((d) => d.item === name && d.status === "requested");
        await db.from("case_documents").update({ status: "received", received_at: new Date().toISOString() }).eq("id", row.id);
        return row.id;
      }, idxHp);
      await dp.click(`#send-${idxHp}`);
      await dp.waitForTimeout(900);
      ok("390px · a 409 is reported as 'we already have that one', not as a failure",
        /already have that one/i.test(await txt(dp, "#banner") || ""));
      eq("390px · …and the list is re-read, so the row shows as received",
        await dp.evaluate(() => ["loading", "invalid", "alldone", "page"].filter((i) => document.getElementById(i).style.display !== "none")),
        ["alldone"]);
      ok("390px · the 409 caused exactly one extra GET", (await dp.evaluate(() => window.__calls.filter((c) => c.method === "GET").length)) === 2);
      ok("390px · nothing was written twice", !!dupId);
    }
    eq(`${tag} · zero console errors`, dp.__err, []);
    await dp.close();
  }

  const allIn = await newPublicPage(browser, `${ORIGIN}/docs.html?token=${G.perCase[G.ids.osei].token}`, { width: 390, height: 844 });
  eq("a client whose list is complete gets the all-done page, not a 404",
    await allIn.evaluate(() => ["loading", "invalid", "alldone", "page"].filter((i) => document.getElementById(i).style.display !== "none")),
    ["alldone"]);
  ok("…and it says everything is in", /have everything we asked for/i.test(await txt(allIn, "#alldone-sub") || ""));
  eq("zero console errors on the all-done page", allIn.__err, []);
  await allIn.close();

  for (const [label, url] of [
    ["an invented token", `${ORIGIN}/docs.html?token=not-a-real-token`],
    ["an empty token", `${ORIGIN}/docs.html?token=`],
    ["no token at all", `${ORIGIN}/docs.html`],
  ]) {
    const bad = await newPublicPage(browser, url, { width: 390, height: 844 });
    eq(`${label} → the same graceful "this link isn't valid" page`,
      await bad.evaluate(() => ["loading", "invalid", "alldone", "page"].filter((i) => document.getElementById(i).style.display !== "none")),
      ["invalid"]);
    ok(`${label} → it does not distinguish "no such link" from "not your link"`,
      /may have expired or been mistyped/i.test(await txt(bad, "#invalid") || ""));
    eq(`${label} → zero console errors`, bad.__err, []);
    await bad.close();
  }

  console.log("\n=== R9-8 · /feedback — the detractor's page ===");
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const tag = `${vp.width}px`;
    /* Driven against a completed case that carries no score yet, so nothing
       another suite measures is disturbed and the note/task this creates are
       demonstrably this test's. */
    const probe = await newPublicPage(browser, `${ORIGIN}/feedback.html`, vp);
    const target = await probe.evaluate(async () => {
      const db = window.supabase.createClient("https://mock.supabase.co", "k");
      const cases = (await db.from("cases").select("id,client_id,stage,nps_score,review_requested_at,assigned_to")).data || [];
      const clients = (await db.from("clients").select("id,first_name,last_name")).data || [];
      const c = cases.find((x) => x.stage === "completed" && x.review_requested_at && x.nps_score == null);
      const cl = clients.find((x) => x.id === c.client_id);
      return { id: c.id, name: [cl.first_name, cl.last_name].filter(Boolean).join(" "), adviser: c.assigned_to };
    });
    await probe.close();

    /* THE LINK IS MINTED ON THE CASE, not invented. nps-capture resolves a
       submission by its TOKEN and by nothing else (see R9-8b below), so a
       made-up token is a 404 and would drive none of the behaviour asserted
       here. This is the link the firm's review email actually carries. Set
       after load rather than before, because the page's only pre-submit call is
       best-effort context it works perfectly well without. */
    const fbToken = `fb-${target.id}-r9`;
    const fp = await newPublicPage(browser, `${ORIGIN}/feedback.html?case=${target.id}&token=${fbToken}&score=4`, vp);
    await fp.evaluate(async (t) => {
      const db = window.supabase.createClient("https://mock.supabase.co", "k");
      await db.from("cases").update({ nps_token: t.token }).eq("id", t.id);
    }, { id: target.id, token: fbToken });
    eq(`${tag} · the page renders`,
      await fp.evaluate(() => ["loading", "invalid", "done", "page"].filter((i) => document.getElementById(i).style.display !== "none")), ["page"]);
    eq(`${tag} · the score is shown back to the client`, await txt(fp, "#score-num"), "4/10");
    const head = await txt(fp, "#score-txt");
    ok(`${tag} · the wording owns it rather than defending`, /not the job we set out to do/i.test(head), head);
    const fbBody = await fp.evaluate(() => document.body.innerText);
    eq(`${tag} · not one exclamation mark on the page`, /!/.test(fbBody), false);
    ok(`${tag} · UK tone — nothing is "reached out" or "apologized"`, !/reach(ed)? out|apologiz/i.test(fbBody));
    ok(`${tag} · there is exactly one free-text box, and it says what happens to the words`,
      (await fp.$$eval("textarea", (e) => e.length)) === 1 && /exactly what you type/i.test(await txt(fp, "#count") || ""));
    const ovf = await fp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`${tag} · nothing overflows horizontally`, ovf <= 1, `overflow ${ovf}px`);

    if (vp.width === 390) {
      const words = "Nobody rang me back for three weeks and I heard about the offer from the estate agent.";
      await fp.fill("#reason", words);
      await fp.click("#submitBtn");
      await fp.waitForTimeout(900);
      eq("390px · the thank-you state replaces the form",
        await fp.evaluate(() => ["loading", "invalid", "done", "page"].filter((i) => document.getElementById(i).style.display !== "none")), ["done"]);
      ok("390px · it promises a person, not an automated reply", /adviser will call you/i.test(await txt(fp, "#done-sub") || ""));
      const outcome = await fp.evaluate(async (t) => {
        const db = window.supabase.createClient("https://mock.supabase.co", "k");
        const notes = ((await db.from("case_notes").select("*").eq("case_id", t.id)).data || []);
        const tasks = ((await db.from("case_tasks").select("*").eq("case_id", t.id)).data || []);
        const cs = (await db.from("cases").select("nps_score").eq("id", t.id).single()).data;
        return { notes: notes.map((n) => ({ body: n.body, by: n.created_by })), tasks: tasks.map((x) => ({ title: x.title, due: x.due_date, to: x.assigned_to, by: x.created_by })), score: cs.nps_score };
      }, target);
      eq("390px · the score is recorded on the case", outcome.score, 4);
      const note = outcome.notes.find((n) => /^Review feedback/.test(n.body));
      eq("390px · the client's words are written to the case VERBATIM, prefixed with the score",
        note && note.body, `Review feedback (4/10): ${words}`);
      eq("390px · …with created_by null, because a public form wrote it, not a member of staff", note && note.by, null);
      const task = outcome.tasks.find((t) => /review feedback needs attention/.test(t.title));
      eq("390px · a call-back task is raised on the case's adviser",
        task && [task.title, task.to, task.by], [`Call ${target.name} — review feedback needs attention`, target.adviser, null]);
      const tomorrow = await fp.evaluate(() => {
        const d = new Date(Date.now() + 86400000);
        return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
      });
      eq("390px · due TOMORROW — never already overdue when somebody first reads it", task && task.due, tomorrow);
      eq("390px · zero console errors", fp.__err, []);
    }
    await fp.close();
  }

  const badFb = await newPublicPage(browser, `${ORIGIN}/feedback.html?case=nope&token=zz&score=3`, { width: 390, height: 844 });
  await badFb.fill("#reason", "test");
  await badFb.click("#submitBtn");
  await badFb.waitForTimeout(800);
  eq("an expired or invented feedback link ends on the invalid page, not an error",
    await badFb.evaluate(() => ["loading", "invalid", "done", "page"].filter((i) => document.getElementById(i).style.display !== "none")), ["invalid"]);
  ok("…and points the client at replying to the email instead", /reply to the email/i.test(await txt(badFb, "#invalid") || ""));
  eq("zero console errors on the invalid path", badFb.__err, []);
  await badFb.close();
  const noParams = await newPublicPage(browser, `${ORIGIN}/feedback.html`, { width: 390, height: 844 });
  eq("a feedback link with no case and no token is invalid on sight",
    await noParams.evaluate(() => ["loading", "invalid", "done", "page"].filter((i) => document.getElementById(i).style.display !== "none")), ["invalid"]);
  await noParams.close();

  /* ==========================================================================
     R9-8b · THE DEPLOYED nps-capture CONTRACT — THE FORGED-PATH MATRIX

     The sibling of R9-8a, and here for the same reason: what a page can reach
     through its own UI is a fraction of what an endpoint with no login on it
     will be sent. Driven straight at the function, one document, because the
     mock re-seeds on every load and these have to mutate the fixture DB and
     read it back.

     THE PROPERTY UNDER TEST IS "FAILS CLOSED". The deployed function resolves a
     submission by its TOKEN and by nothing else —
       if (!kase || !kase.nps_token || kase.nps_token !== token) return 404
     ahead of every write — and `case_id`, where one is sent, is an assertion to
     be verified rather than a lookup key. An earlier version of the MOCK looked
     the case up by `case_id` first and never checked the two agreed, which made
     a forged POST look like it worked in the harness while production had
     always refused it. That is precisely the class of parity bug this file
     exists to catch, so the matrix below is asserted against the stub row by
     row, and EVERY refusal is checked for zero writes as well as for its code.
     ====================================================================== */
  console.log("\n=== R9-8b · nps-capture — the forged-path matrix ===");
  {
    const cp = await newPublicPage(browser, `${ORIGIN}/feedback.html`, { width: 390, height: 844 });
    const M = await cp.evaluate(async (FN_BASE) => {
      const db = window.supabase.createClient("https://mock.supabase.co", "k");
      const F = FN_BASE + "/nps-capture";
      const post = async (b) => {
        const r = await fetch(F, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
        let j = null; try { j = await r.json(); } catch (e) { j = null; }
        return { status: r.status, ok: !!(j && j.ok), j };
      };
      const cases = (await db.from("cases").select("*")).data || [];
      /* MINE — a completed case with no score, carrying a real link.
         THEIRS — somebody else's completed case, with a score already on it, so
         both "did you write" and "did you overwrite" are observable. */
      const mine = cases.find((c) => c.stage === "completed" && c.nps_score == null);
      const theirs = cases.find((c) => c.stage === "completed" && c.id !== mine.id && c.nps_score != null);
      await db.from("cases").update({ nps_token: "mine-token-r9" }).eq("id", mine.id);
      await db.from("cases").update({ nps_token: "theirs-token-r9" }).eq("id", theirs.id);

      const snap = async (id) => {
        const c = (await db.from("cases").select("nps_score").eq("id", id).single()).data;
        const n = ((await db.from("case_notes").select("id").eq("case_id", id)).data || []).length;
        const t = ((await db.from("case_tasks").select("id").eq("case_id", id)).data || []).length;
        return { score: c.nps_score, notes: n, tasks: t };
      };
      const attempt = async (label, body, victimId) => {
        const before = await snap(victimId);
        const res = await post(body);
        const after = await snap(victimId);
        return { label, res, before, after, untouched: JSON.stringify(before) === JSON.stringify(after) };
      };

      const rows = [];
      rows.push(await attempt("their case id, no token at all", { case_id: theirs.id, score: 0, reason: "forged" }, theirs.id));
      rows.push(await attempt("their case id, empty token", { case_id: theirs.id, token: "", score: 0, reason: "forged" }, theirs.id));
      rows.push(await attempt("their case id, MY token", { case_id: theirs.id, token: "mine-token-r9", score: 0, reason: "forged" }, theirs.id));
      rows.push(await attempt("their case id, a shape-passing unknown token", { case_id: theirs.id, token: "theirs-token-r0", score: 0, reason: "forged" }, theirs.id));
      rows.push(await attempt("no case id, an unknown token", { token: "not-a-token-at-all", score: 0, reason: "forged" }, theirs.id));
      rows.push(await attempt("the honeypot filled in", { token: "mine-token-r9", score: 2, reason: "bot", website: "http://spam.example" }, mine.id));
      /* …and the two that MUST work, or the guard has simply broken the feature. */
      const legitNoCase = await attempt("my token alone, no case id", { token: "mine-token-r9", score: 3, reason: "legitimate" }, mine.id);
      const stored = (await db.from("cases").select("nps_score").eq("id", mine.id).single()).data.nps_score;
      const overwrite = await attempt("my own link again with a different score", { case_id: mine.id, token: "mine-token-r9", score: 10, reason: "second thoughts" }, mine.id);
      return { rows, legitNoCase, stored, overwrite, mineId: mine.id, theirsId: theirs.id, theirsScore: theirs.nps_score };
    }, FN_BASE);

    const refusals = M.rows.slice(0, 5);
    eq("no token is a 400 — a submission naming no link is malformed", refusals[0].res.status, 400);
    eq("an empty token is a 400 too", refusals[1].res.status, 400);
    eq("case A's id with case B's token is a 404", refusals[2].res.status, 404);
    eq("a shape-passing but unknown token is a 404", refusals[3].res.status, 404);
    eq("an unknown token with no case id is a 404", refusals[4].res.status, 404);
    ok("…and the 404 is the SAME 404 in every case — no oracle for guessing tokens",
      new Set(refusals.filter((r) => r.res.status === 404).map((r) => r.res.j && r.res.j.error)).size === 1,
      JSON.stringify(refusals.map((r) => r.res.j && r.res.j.error)));
    refusals.forEach((r) => {
      ok(`ZERO WRITES · "${r.label}" touched nothing on the victim's case`, r.untouched,
        `${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`);
      eq(`…and "${r.label}" never reports success`, r.res.ok, false);
    });
    eq("the victim's score is exactly what it was before the whole matrix ran", M.rows[0].after.score, M.theirsScore);

    const pot = M.rows[5];
    eq("the honeypot answers a bare 200", pot.res.status, 200);
    eq("…saying only {ok:true} — no score, no detractor flag, nothing to act on",
      Object.keys(pot.res.j || {}).sort(), ["ok"]);
    ok("…and writes nothing at all", pot.untouched, `${JSON.stringify(pot.before)} → ${JSON.stringify(pot.after)}`);

    eq("a valid token ALONE is enough — case_id is not required", M.legitNoCase.res.status, 200);
    eq("…and it records the score on the right case", M.stored, 3);
    ok("…and raises the detractor's note and call-back", M.legitNoCase.after.notes > M.legitNoCase.before.notes && M.legitNoCase.after.tasks > M.legitNoCase.before.tasks,
      `${JSON.stringify(M.legitNoCase.before)} → ${JSON.stringify(M.legitNoCase.after)}`);
    eq("THE SCORE IS WRITE-ONCE — re-following the link with a 10 does not move a recorded 3",
      M.overwrite.after.score, 3);
    eq("…and the response reports the score the firm actually holds, not the one asked for",
      M.overwrite.res.j && M.overwrite.res.j.score, 3);
    ok("…so the call-back decision cannot be edited away in the address bar",
      M.overwrite.res.j && M.overwrite.res.j.detractor === true, JSON.stringify(M.overwrite.res.j));
    eq("zero console errors across the whole matrix", cp.__err, []);
    await cp.close();
  }

  console.log("\n=== CONSOLE + LAYOUT (admin) ===");
  eq("owner session · zero console errors", owner.__err, []);
  eq("adviser session · zero console errors", adviser.__err, []);
  eq("administrator session · zero console errors", admin.__err, []);
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const p = await newPage(browser, "p4", vp);
    await openCase(p, G.ids.amery, 1200);
    const o1 = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`${vp.width}px · the case modal with a checklist does not overflow`, o1 <= 1, `overflow ${o1}px`);
    ok(`${vp.width}px · the checklist rows are visible`, (await p.$$eval("#docs-list .doc-row", (e) => e.length)) > 0);
    await p.evaluate(() => window.closeModal());
    await gotoReports(p);
    const o2 = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`${vp.width}px · Reports with the conveyancer panel does not overflow`, o2 <= 1, `overflow ${o2}px`);
    ok(`${vp.width}px · the conveyancer table is on screen`, await exists(p, "#conv-table"));
    eq(`${vp.width}px · zero console errors`, p.__err, []);
    await p.close();
  }

  await browser.close();
  console.log(`\nR9_DOCS: ${pass} checks, ${failures.length} failures`);
  if (failures.length) failures.forEach((f) => console.log("  ✗ " + f));
  /* R43 teardown fix: the spawned server below is started detached and never
     unref()'d (same as every sibling suite — r5_batch*.js, r9_adv.js, r9_embed.js,
     r64.js — which all rely on it to persist across runs), which keeps node's
     event loop alive forever once the checks finish. Every sibling suite works
     around this the same way: an explicit process.exit() at the very end, which
     terminates immediately regardless of the still-open child handle (the
     process.on("exit", ...) cleanup registered above at spawn time still runs
     synchronously as part of process.exit() and kills the server's process
     group, exactly as it always has — this call was simply never reached
     before). No check above this line changed. */
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
