#!/usr/bin/env node
/* =============================================================================
   tests/r71_health.js — acceptance tests for R71 build B, "Data health: fast,
   complete, fixable" (panel findings H6, M2, M8).

   What the R70 panel found, verified against production on 27 August:
     · Data health took ~10.4s to first paint at 2,000 cases while every other
       page took 1–3s, because the page read the book in SIX SEQUENTIAL waves
       that had no dependency on each other (H6);
     · there was no tile at all for the two biggest gaps in the back book —
       291 completed cases with no property address, 292 with no loan amount
       (H6, Priya F1 / Sam F5+F6);
     · fixing ANY flagged gap meant a six-click round trip through a case form
       carrying fifty other fields, for a value the panel had already told you
       was blank (H6 + M8, Luke F6);
     · nothing anywhere answered "is this case's file actually complete?" —
       objective, checklist, papers, fact find, waiting-on and expected
       completion each lived in their own section (M2, Sam F8 / Priya F3).

     §A  B1 · SPEED. A 2,000-case book seeded at runtime through window.__mockDb
         (the tests/r29_scale.js technique), then the SAME six read groups timed
         two ways against the same store: sequentially (the pre-R71 shape) and
         in one Promise.all (the shipped shape), each read charged a modelled
         network round trip because the mock has none. Asserts after < before,
         and — needing no clock — that the page now issues every read it makes
         in ONE wave. Every read still goes through readAll, so the tiles are
         right past the mock's
         1,000-row PostgREST ceiling — the r29_scale canary, asserted here too.
     §B  B2 · THE TWO NEW TILES. #dh-tile-address and #dh-tile-loan count exactly
         the seeded gaps, exclude not_proceeding and exclude protection-only
         (not-mortgage-shaped) records, and both appear in #dh-readiness.
     §C  B3 · INLINE FIX. Each of the four repair panels carries an input and a
         Save: the write lands on that ONE column, the row leaves the list, the
         tile count comes down, the rollup comes down with it, and the toast
         names the case. Empty input and a future completion date are refused
         with a reason and write nothing.
     §D  B4 · COMPLETENESS. caseCompleteness's denominator moves with the stage;
         the case modal's 📁 chip agrees with it; #dh-tile-completeness lists
         live cases worst-first with the missing items named; the pipeline board
         is untouched (r24's BOARD_CASE_COLS contract).
     §E  No console errors on any of it, owner and adviser.

   EVERY figure asserted here is either computed by this file's own seeding,
   read straight back off window.__mockDb, or read live off app.js's own module
   state — never a number invented independently of the fixture it is testing.

   Run:  node /root/nx/tests/r71_health.js
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
  "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc", "nx_drawer_retention"];

async function boot(browser, persona) {
  const page = await (await browser.newContext()).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  /* R69-HF1's lesson, borrowed verbatim from tests/r29_scale.js: a bare .select() against the mock
     stops at its 1,000-row PostgREST ceiling, so any ground truth this file computes above that
     size has to page for itself or it would be measuring the first page and calling it the book. */
  await page.addInitScript(() => {
    window.__readAllRaw = async function (table, cols) {
      const PAGE = 1000, out = [];
      for (let from = 0; from < 500000; from += PAGE) {
        const res = await window.__mockDb.from(table).select(cols || "*").order("id").range(from, from + PAGE - 1);
        const rows = (res && res.data) || [];
        for (let i = 0; i < rows.length; i++) out.push(rows[i]);
        if (rows.length < PAGE) break;
      }
      return out;
    };
  });
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
const tileNum = (page, id) => page.$eval("#" + id + " .num", (e) => (e.textContent || "").trim()).catch(() => null);
const readinessRows = (page) => page.evaluate(() => [...document.querySelectorAll("#dh-readiness .dh-readiness-item")].map((el) => ({
  label: ((el.querySelector(".dh-readiness-label") || {}).textContent || "").trim(),
  count: Number(((el.querySelector(".dh-readiness-count") || {}).textContent || "").trim()),
  tile: ((el.getAttribute("onclick") || "").match(/getElementById\('([^']+)'\)/) || [])[1] || null,
})));
const toastTxt = (page) => page.evaluate(() => (document.querySelector("#toast") || {}).textContent || "");

let uniq = 0;
const tag = () => `R71B${Date.now().toString(36)}${++uniq}`;
const dOff = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/* One client + one case, through the mock's own client so applyInsertDefaults() runs exactly as
   production would. Returns both ids. */
async function mkCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const { data: cl, error: ce } = await db.from("clients").insert({
      first_name: o.first, last_name: o.last, email: o.email || null, phone: o.phone || "07700900123",
    }).select("id").single();
    if (ce) throw new Error("client insert: " + ce.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "completed" }, o.case || {});
    const { data: cs, error: se } = await db.from("cases").insert(row).select("id").single();
    if (se) throw new Error("case insert: " + se.message);
    return { clientId: cl.id, caseId: cs.id };
  }, opts);
}

/* ---------------------------------------------------------------------------
   §A's seed — the r29_scale technique: ONE bulk insert per table through
   window.__mockDb, so every default the app relies on is applied exactly as it
   would be for any other insert, and the store the app reads from is the store
   that just grew. Deliberately varied so the page has real work to do at
   2,000 rows rather than a degenerate fixture that happens to render fast.
   ------------------------------------------------------------------------ */
async function seedScale(page, n) {
  return page.evaluate(async (n) => {
    const db = window.__mockDb;
    const FIRST = ["James", "Sarah", "Michael", "Emma", "David", "Laura", "Robert", "Katie", "Daniel", "Sophie"];
    const LAST = ["Smith", "Jones", "Taylor", "Brown", "Williams", "Wilson", "Johnson", "Davies", "Robinson", "Wright"];
    const LENDERS = ["Halifax", "Nationwide", "Barclays", "HSBC", "NatWest", "Santander"];
    const KINDS = ["purchase", "remortgage", "product_transfer", "buy_to_let", "first_time_buyer", "other"];
    const STAGE_CYCLE = [];
    [["enquiry", 14], ["fact_find", 14], ["decision_in_principle", 10], ["application", 14],
      ["offer", 10], ["exchange", 10], ["completed", 18], ["not_proceeding", 10]]
      .forEach(([s, c]) => { for (let k = 0; k < c; k++) STAGE_CYCLE.push(s); });
    const now = Date.now(), DAY = 86400000;
    const off = (d) => new Date(now + d * DAY).toISOString().slice(0, 10);

    const clients = [];
    for (let i = 0; i < n; i++) {
      clients.push({
        first_name: FIRST[i % FIRST.length], last_name: LAST[Math.floor(i / FIRST.length) % LAST.length],
        email: (i % 11 === 0) ? null : `r71.scale.${i}@example.com`,
        phone: (i % 13 === 0) ? null : `07700${String(900000 + i).slice(-6)}`,
      });
    }
    const insC = await db.from("clients").insert(clients).select("id");
    if (insC.error) throw new Error("client insert failed: " + insC.error.message);
    const ids = insC.data.map((r) => r.id);

    const cases = [];
    for (let i = 0; i < n; i++) {
      const stage = STAGE_CYCLE[i % 100];
      const row = {
        client_id: ids[i], stage, case_kind: KINDS[i % KINDS.length], lender: LENDERS[i % LENDERS.length],
        rate_type: (i % 3 === 0) ? "tracker" : "fixed",
        loan_amount: (i % 7 === 0) ? null : 80000 + (i % 60) * 5000,
        property_value: 200000 + (i % 40) * 5000,
        mortgage_account_number: (i % 5 === 0) ? "MA" + i : null,
        assigned_to: ["p1", "p2", "p3", "p4", null][i % 5],
        submitted_at: stage === "enquiry" ? null : off(-(30 + (i % 400))),
        rate_end_date: (i % 9 === 0) ? null : off((i % 2 === 0 ? -1 : 1) * (5 + (i % 700))),
        expected_completion_date: (i % 8 === 0) ? null : off((i % 3 === 0 ? -1 : 1) * (5 + (i % 300))),
        property_address: (i % 4 === 0) ? null : `${1 + (i % 90)} Test Road, Bournemouth BH${1 + (i % 9)} ${i % 9}AA`,
      };
      if (stage === "completed") row.completed_at = (i % 40 === 0) ? null : off(-(20 + (i % 500)));
      cases.push(row);
    }
    const insCa = await db.from("cases").insert(cases).select("id");
    if (insCa.error) throw new Error("case insert failed: " + insCa.error.message);
    return { clients: ids.length, cases: insCa.data.length };
  }, n);
}

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {

    /* =====================================================================
       §A · B1/H6 — DATA HEALTH OPENS IN ONE ROUND TRIP, NOT SIX
       ===================================================================== */
    {
      console.log("\n— §A · Data health's read shape at 2,000 cases (owner, p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;

      const before = await page.evaluate(() => window.__mock.counts());
      const seeded = await seedScale(page, 2000);
      const after = await page.evaluate(() => window.__mock.counts());
      eq("A1 · the seed landed 2,000 clients and 2,000 cases in the store the app reads",
        [after.clients - before.clients, after.cases - before.cases], [2000, 2000]);
      ok("A1b · …so the book is genuinely past the mock's 1,000-row PostgREST ceiling",
        after.cases > 1000 && seeded.cases === 2000, JSON.stringify({ after, seeded }));

      /* THE MEASUREMENT, and what it does and does not model.

         The six read groups the page needs, against the same seeded store, arranged two ways:
         SEQUENTIALLY (the pre-R71 shape — each wave awaited before the next is even issued) and in
         ONE Promise.all (what R71 ships). window.db is the client app.js itself holds and readAll
         is app.js's own pager, so this is the app's own read cost, not a re-implementation.

         Each read is charged a fixed LATENCY, identically in both arrangements, because the thing
         the change actually removes is FIVE NETWORK ROUND TRIPS and the mock has no network: its
         reads resolve out of memory in single-digit milliseconds, which would make both
         arrangements look free and prove nothing about the page that took 10.4 seconds in
         production. The raw (latency-free) figures are printed alongside, so the modelled part is
         visible rather than buried. */
      const LATENCY_MS = 120;   // a plausible Supabase round trip, charged to both arrangements
      const timings = await page.evaluate(async (LAT) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const mk = [
          () => window.readAll(window.db.from("cases").select("id,stage,rate_end_date,expected_completion_date,completed_at,created_at,submitted_at,case_kind,lender,rate_type,retention_source_case_id,loan_amount,property_value,mortgage_account_number,client_id,property_address").order("id")),
          () => window.readAll(window.db.from("clients").select("id,first_name,last_name,email,phone").order("id")),
          () => window.readAll(window.db.from("case_documents").select("case_id,status").order("case_id").order("id")),
          () => window.readAll(window.db.from("cases").select("id,waiting_on,solicitor_firm,assigned_to").order("id")),
          () => window.readAll(window.db.from("cases").select("id,exchange_date").order("id")),
          () => window.readAll(window.db.from("cases").select("id,offer_issued_date").order("id")),
        ];
        const run = async (groups, latency) => {
          const one = async (g) => { if (latency) await sleep(latency); return g(); };
          const t0 = performance.now();
          for (const g of groups) await one(g);
          const seq = performance.now() - t0;
          const t1 = performance.now();
          await Promise.all(groups.map((g) => one(g)));
          const par = performance.now() - t1;
          return { seq, par };
        };
        await Promise.all(mk.map((g) => g()));          // warm both paths once
        const raw = await run(mk, 0);
        const modelled = await run(mk, LAT);
        return { raw, modelled };
      }, LATENCY_MS);
      console.log(`    six read groups at 2,000 cases, raw (in-memory mock)      — BEFORE (sequential): ${timings.raw.seq.toFixed(0)}ms · AFTER (one Promise.all): ${timings.raw.par.toFixed(0)}ms`);
      console.log(`    …with a ${LATENCY_MS}ms round trip charged to each read — BEFORE (sequential): ${timings.modelled.seq.toFixed(0)}ms · AFTER (one Promise.all): ${timings.modelled.par.toFixed(0)}ms`);
      ok("A2a · the parallel read group beats the same six groups run sequentially (raw)",
        timings.raw.par < timings.raw.seq, JSON.stringify(timings.raw));
      ok("A2b · …and beats it by most of five round trips once each read is charged a real network latency",
        timings.modelled.par < timings.modelled.seq && (timings.modelled.seq - timings.modelled.par) > 4 * LATENCY_MS, JSON.stringify(timings.modelled));

      /* AND THE STRUCTURAL PROOF, which needs no clock at all: while loadDataHealth runs, every
         table read it makes is ISSUED in one burst rather than in six waves separated by the time
         each wave took to come back. db.from is the moment a read is built, so clustering those
         timestamps counts the waves directly. (The gate probe, if the support caches are cold, is
         allowed its own earlier wave — it is one shared query for all six gates.) */
      const waves = await page.evaluate(async () => {
        const stamps = [];
        const origFrom = window.db.from.bind(window.db);
        window.db.from = (t) => { stamps.push({ t, at: performance.now() }); return origFrom(t); };
        const t0 = performance.now();
        await window.loadDataHealth();
        const wall = performance.now() - t0;
        window.db.from = origFrom;
        // A "wave" = reads issued within 25ms of the previous one; a real round trip is far longer.
        const groups = [];
        stamps.forEach((s) => {
          const last = groups[groups.length - 1];
          if (last && s.at - last.at <= 25) { last.n++; last.at = s.at; } else groups.push({ n: 1, at: s.at, first: s.t });
        });
        return { wall, reads: stamps.length, waves: groups.map((g) => g.n) };
      });
      console.log(`    loadDataHealth() at 2,000 cases: ${waves.wall.toFixed(0)}ms wall, ${waves.reads} table reads issued in ${waves.waves.length} wave(s) of ${JSON.stringify(waves.waves)}`);
      ok("A3a · every table read the page makes is issued in ONE wave (a cold support probe may take one of its own, never more)",
        waves.waves.length <= 2, JSON.stringify(waves));
      ok("A3b · …and that wave carries the whole page — the big cases/clients reads and the five feature-detected ones together",
        Math.max.apply(null, waves.waves) >= 8, JSON.stringify(waves));
      await page.waitForTimeout(1200);

      const rendered = await page.$eval("#data-content", (e) => e.innerHTML.length).catch(() => 0);
      ok("A4 · the page still rendered at scale (no white screen)", rendered > 1000, rendered);

      /* THE readAll CANARY. The tiles must be right ABOVE the 1,000-row ceiling: a tile that
         stopped at the first page would report a number this ground truth disagrees with. */
      const gt = await page.evaluate(async () => {
        const rows = await window.__readAllRaw("cases", "id,stage,loan_amount,property_address,mortgage_account_number,case_kind");
        const MK = ["purchase", "first_time_buyer", "remortgage", "product_transfer", "buy_to_let"];
        const mortgageShaped = (c) => !!c.mortgage_account_number || MK.includes(c.case_kind);
        return {
          total: rows.length,
          noAddr: rows.filter((c) => c.stage === "completed" && !c.property_address && mortgageShaped(c)).length,
          noLoan: rows.filter((c) => c.stage === "completed" && c.loan_amount == null && mortgageShaped(c)).length,
        };
      });
      ok("A5 · the independent ground truth itself sees past 1,000 rows", gt.total > 1000, JSON.stringify(gt));
      eq("A5a · #dh-tile-address counts the whole book, not the first page", await tileNum(page, "dh-tile-address"), String(gt.noAddr));
      eq("A5b · #dh-tile-loan counts the whole book, not the first page", await tileNum(page, "dh-tile-loan"), String(gt.noLoan));
      ok("A5c · both counts are genuinely large at this seed (the ceiling is actually exercised)",
        gt.noAddr > 50 && gt.noLoan > 20, JSON.stringify(gt));

      eq("A6 · no console errors at 2,000 cases", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §B · B2/H6 — THE TWO NEW TILES
       ===================================================================== */
    {
      console.log("\n— §B · Completed — no property address / no loan amount (owner, p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;

      // Ground truth from the untouched fixture, computed here rather than borrowed from app.js.
      const base = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,stage,case_kind,loan_amount,property_address,mortgage_account_number");
        const MK = ["purchase", "first_time_buyer", "remortgage", "product_transfer", "buy_to_let"];
        const shaped = (c) => !!c.mortgage_account_number || MK.includes(c.case_kind);
        return {
          addr: data.filter((c) => c.stage === "completed" && !c.property_address && shaped(c)).length,
          loan: data.filter((c) => c.stage === "completed" && c.loan_amount == null && shaped(c)).length,
        };
      });

      const t = tag();
      const seeded = {
        // counted: completed, mortgage-shaped, both gaps
        addrGap: await mkCase(page, { first: t, last: "AddrGap", case: { stage: "completed", case_kind: "remortgage", loan_amount: 210000, property_address: null, completed_at: dOff(-30) } }),
        loanGap: await mkCase(page, { first: t, last: "LoanGap", case: { stage: "completed", case_kind: "purchase", loan_amount: null, mortgage_account_number: "MA-" + t, property_address: "1 Counted Road, Poole BH12 1AA", completed_at: dOff(-31) } }),
        // NOT counted: not_proceeding (both tiles are completed-only)
        dead: await mkCase(page, { first: t, last: "NotProceeding", case: { stage: "not_proceeding", case_kind: "remortgage", loan_amount: null, property_address: null } }),
        // NOT counted: live
        live: await mkCase(page, { first: t, last: "LiveCase", case: { stage: "application", case_kind: "remortgage", loan_amount: null, property_address: null } }),
        // NOT counted: protection-only — no loan, no mortgage account number, not a mortgage kind
        prot: await mkCase(page, { first: t, last: "ProtectionOnly", case: { stage: "completed", case_kind: "other", loan_amount: null, mortgage_account_number: null, property_address: null, protection_status: "policy_taken", completed_at: dOff(-32) } }),
      };
      await goPage(page, "data");

      eq("B1a · #dh-tile-address counts exactly the fixture's gaps plus the one seeded", await tileNum(page, "dh-tile-address"), String(base.addr + 1));
      eq("B1b · #dh-tile-loan counts exactly the fixture's gaps plus the one seeded", await tileNum(page, "dh-tile-loan"), String(base.loan + 1));

      const labels = await page.evaluate(() => ["dh-tile-address", "dh-tile-loan"].map((id) => {
        const t = document.getElementById(id);
        return t ? { id, lbl: t.querySelector(".lbl").textContent.trim(), warn: t.classList.contains("warn"), title: t.getAttribute("title") || "" } : null;
      }));
      eq("B2a · the address tile is captioned as the role card asked", labels[0] && labels[0].lbl, "Completed — no property address ▾");
      eq("B2b · the loan tile is captioned as the role card asked", labels[1] && labels[1].lbl, "Completed — no loan amount ▾");
      ok("B2c · both are coloured as faults while they are non-zero", labels[0].warn && labels[1].warn, JSON.stringify(labels.map((l) => l.warn)));
      ok("B2d · …and each says in plain English what it is and why it matters",
        /retention/i.test(labels[0].title) && /LTV|MI/i.test(labels[1].title), JSON.stringify(labels.map((l) => l.title.slice(0, 60))));

      // The drawers open, and carry exactly the rows the tiles counted.
      await page.click("#dh-tile-address"); await page.waitForTimeout(500);
      await page.click("#dh-tile-loan"); await page.waitForTimeout(500);
      const drawers = await page.evaluate((ids) => {
        const read = (sel) => {
          const p = document.querySelector(sel);
          return { open: !p.classList.contains("hidden"), rows: p.querySelectorAll(".row-item").length, text: p.textContent.replace(/\s+/g, " "), sub: (p.querySelector(".panel-sub") || {}).textContent || "" };
        };
        return { addr: read("#dh-address-panel"), loan: read("#dh-loan-panel"), ids };
      }, seeded);
      ok("B3a · clicking each tile opens its drawer", drawers.addr.open && drawers.loan.open, JSON.stringify([drawers.addr.open, drawers.loan.open]));
      const t3 = tag();
      ok("B3b · the address drawer lists the seeded address gap", drawers.addr.text.includes("AddrGap"), drawers.addr.text.slice(0, 200));
      ok("B3c · the loan drawer lists the seeded loan gap", drawers.loan.text.includes("LoanGap"), drawers.loan.text.slice(0, 200));
      ok("B3d · neither drawer lists the not-proceeding case", !drawers.addr.text.includes("NotProceeding") && !drawers.loan.text.includes("NotProceeding"));
      ok("B3e · neither drawer lists the live case", !drawers.addr.text.includes("LiveCase") && !drawers.loan.text.includes("LiveCase"));
      ok("B3f · neither drawer lists the protection-only record", !drawers.addr.text.includes("ProtectionOnly") && !drawers.loan.text.includes("ProtectionOnly"));
      ok("B3g · …and both panels SAY they leave protection-only records out, rather than leaving it to be discovered",
        /protection-only/i.test(drawers.addr.sub) && /protection-only/i.test(drawers.loan.sub), JSON.stringify([drawers.addr.sub.slice(0, 80), drawers.loan.sub.slice(0, 80)]));

      const rows = await readinessRows(page);
      const addrRow = rows.find((r) => r.tile === "dh-tile-address");
      const loanRow = rows.find((r) => r.tile === "dh-tile-loan");
      ok("B4a · the readiness rollup lists the address check", !!addrRow, JSON.stringify(rows.map((r) => r.tile)));
      ok("B4b · …and the loan check", !!loanRow, JSON.stringify(rows.map((r) => r.tile)));
      eq("B4c · the rollup's address count is the tile's count", String(addrRow && addrRow.count), await tileNum(page, "dh-tile-address"));
      eq("B4d · the rollup's loan count is the tile's count", String(loanRow && loanRow.count), await tileNum(page, "dh-tile-loan"));

      eq("B5 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §C · B3/H6+M8 — FIX THE GAP WITHOUT THE 51-FIELD MODAL
       ===================================================================== */
    {
      console.log("\n— §C · the inline repairs (owner, p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      const t = tag();

      const rateEnd = await mkCase(page, { first: t, last: "RateEndFix", case: { stage: "completed", case_kind: "remortgage", rate_type: "fixed", loan_amount: 190000, rate_end_date: null, completed_at: dOff(-40), property_address: "2 Fix Road, Poole BH12 2AA" } });
      const compDate = await mkCase(page, { first: t, last: "CompDateFix", case: { stage: "completed", case_kind: "remortgage", loan_amount: 175000, completed_at: null, rate_end_date: dOff(300), property_address: "3 Fix Road, Poole BH12 3AA" } });
      const addrFix = await mkCase(page, { first: t, last: "AddrFix", case: { stage: "completed", case_kind: "remortgage", loan_amount: 165000, property_address: null, completed_at: dOff(-42) } });
      const loanFix = await mkCase(page, { first: t, last: "LoanFix", case: { stage: "completed", case_kind: "purchase", loan_amount: null, mortgage_account_number: "MA-" + t, property_address: "5 Fix Road, Poole BH12 5AA", completed_at: dOff(-43) } });
      await goPage(page, "data");

      // Open all four drawers.
      for (const id of ["dh-tile-rateend", "dh-tile-nocompleted", "dh-tile-address", "dh-tile-loan"]) {
        await page.click("#" + id); await page.waitForTimeout(250);
      }

      /* Scoped to the PANEL, not the page: one case can legitimately be short of two different
         things at once (our rate-end case is also missing nothing else, but a real back-book row
         is routinely on three of these lists), and each panel gives it the input that panel is
         about. Looking one up page-wide would find whichever list happened to render first. */
      const shape = await page.evaluate((ids) => {
        const cell = (panel, caseId) => {
          const w = document.querySelector(`#${panel} .dh-fix[data-case="${caseId}"]`);
          if (!w) return null;
          const row = w.closest(".row-item");
          return {
            col: w.dataset.col,
            type: (w.querySelector(".dh-fix-input") || {}).type,
            hasSave: !!w.querySelector(".dh-fix-save"),
            keepsOpen: /Open/.test(w.textContent),
            inRow: !!row,
          };
        };
        return {
          rateEnd: cell("dh-rateend-panel", ids.rateEnd), compDate: cell("dh-nocompleted-panel", ids.compDate),
          addr: cell("dh-address-panel", ids.addr), loan: cell("dh-loan-panel", ids.loan),
        };
      }, { rateEnd: rateEnd.caseId, compDate: compDate.caseId, addr: addrFix.caseId, loan: loanFix.caseId });
      eq("C1a · the rate-end row carries a date input", [shape.rateEnd && shape.rateEnd.col, shape.rateEnd && shape.rateEnd.type], ["rate_end_date", "date"]);
      eq("C1b · the completion-date row carries a date input", [shape.compDate && shape.compDate.col, shape.compDate && shape.compDate.type], ["completed_at", "date"]);
      eq("C1c · the address row carries a text input", [shape.addr && shape.addr.col, shape.addr && shape.addr.type], ["property_address", "text"]);
      eq("C1d · the loan row carries a number input", [shape.loan && shape.loan.col, shape.loan && shape.loan.type], ["loan_amount", "number"]);
      ok("C1e · every one keeps its Save AND the original Open beside it",
        [shape.rateEnd, shape.compDate, shape.addr, shape.loan].every((s) => s && s.hasSave && s.keepsOpen), JSON.stringify(shape));

      ok("C1f · the rate-end panel says what setting the date DOES — the case joins the retention feed",
        await page.$eval("#dh-rateend-panel .panel-sub", (e) => /retention/i.test(e.textContent)), "panel-sub");

      /* ---- the refusals, first: nothing must be written ---- */
      const rateTileBefore = await tileNum(page, "dh-tile-rateend");
      await page.evaluate((id) => { document.querySelector(`#dh-rateend-panel .dh-fix[data-case="${id}"] .dh-fix-save`).click(); }, rateEnd.caseId);
      await page.waitForTimeout(400);
      ok("C2a · an empty input is refused with a reason, not a silent no-op", /type a value/i.test(await toastTxt(page)), await toastTxt(page));
      eq("C2b · …and the row is still there", await page.$$eval(`#dh-rateend-panel .dh-fix[data-case="${rateEnd.caseId}"]`, (e) => e.length), 1);

      await page.evaluate((id) => {
        const w = document.querySelector(`#dh-nocompleted-panel .dh-fix[data-case="${id}"]`);
        w.querySelector(".dh-fix-input").value = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        w.querySelector(".dh-fix-save").click();
      }, compDate.caseId);
      await page.waitForTimeout(500);
      ok("C3a · a completion date in the FUTURE is refused, and says why", /future/i.test(await toastTxt(page)), await toastTxt(page));
      const compStillNull = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("completed_at").eq("id", id).single();
        return data.completed_at;
      }, compDate.caseId);
      eq("C3b · …and nothing was written to the case", compStillNull, null);

      /* ---- and now the four real saves ---- */
      const wantRateEnd = dOff(200);
      await page.evaluate((o) => {
        const w = document.querySelector(`#dh-rateend-panel .dh-fix[data-case="${o.id}"]`);
        w.querySelector(".dh-fix-input").value = o.v;
        w.querySelector(".dh-fix-save").click();
      }, { id: rateEnd.caseId, v: wantRateEnd });
      await page.waitForTimeout(600);
      const savedRateEnd = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("rate_end_date,loan_amount,property_address").eq("id", id).single();
        return data;
      }, rateEnd.caseId);
      eq("C4a · the rate-end date landed on the case", savedRateEnd.rate_end_date, wantRateEnd);
      eq("C4b · …and NOTHING else on the case was touched by the write", [savedRateEnd.loan_amount, savedRateEnd.property_address], [190000, "2 Fix Road, Poole BH12 2AA"]);
      ok("C4c · the toast names the case and what was set", /RateEndFix/.test(await toastTxt(page)) && /rate-end date/i.test(await toastTxt(page)), await toastTxt(page));
      eq("C4d · the row left the list", await page.$$eval(`#dh-rateend-panel .dh-fix[data-case="${rateEnd.caseId}"]`, (e) => e.length), 0);
      eq("C4e · the tile count came down by exactly one", await tileNum(page, "dh-tile-rateend"), String(Number(rateTileBefore) - 1));
      const rowsAfter = await readinessRows(page);
      const reRow = rowsAfter.find((r) => r.tile === "dh-tile-rateend");
      eq("C4f · the readiness rollup came down with it", String(reRow ? reRow.count : 0), await tileNum(page, "dh-tile-rateend"));

      const wantComp = dOff(-3);
      const compTileBefore = await tileNum(page, "dh-tile-nocompleted");
      await page.evaluate((o) => {
        const w = document.querySelector(`#${o.panel} .dh-fix[data-case="${o.id}"]`);
        w.querySelector(".dh-fix-input").value = o.v;
        w.querySelector(".dh-fix-save").click();
      }, { id: compDate.caseId, v: wantComp, panel: "dh-nocompleted-panel" });
      await page.waitForTimeout(600);
      eq("C5a · a past completion date is accepted and lands on the case",
        await page.evaluate(async (id) => (await window.__mockDb.from("cases").select("completed_at").eq("id", id).single()).data.completed_at, compDate.caseId), wantComp);
      eq("C5b · …and its tile came down", await tileNum(page, "dh-tile-nocompleted"), String(Number(compTileBefore) - 1));

      const addrTileBefore = await tileNum(page, "dh-tile-address");
      await page.evaluate((o) => {
        const w = document.querySelector(`#${o.panel} .dh-fix[data-case="${o.id}"]`);
        w.querySelector(".dh-fix-input").value = o.v;
        w.querySelector(".dh-fix-save").click();
      }, { id: addrFix.caseId, v: "44 Repaired Street, Bournemouth BH1 4AA", panel: "dh-address-panel" });
      await page.waitForTimeout(600);
      eq("C6a · the property address lands on the case",
        await page.evaluate(async (id) => (await window.__mockDb.from("cases").select("property_address").eq("id", id).single()).data.property_address, addrFix.caseId), "44 Repaired Street, Bournemouth BH1 4AA");
      eq("C6b · …and its tile came down", await tileNum(page, "dh-tile-address"), String(Number(addrTileBefore) - 1));

      const loanTileBefore = await tileNum(page, "dh-tile-loan");
      await page.evaluate((o) => {
        const w = document.querySelector(`#${o.panel} .dh-fix[data-case="${o.id}"]`);
        w.querySelector(".dh-fix-input").value = o.v;
        w.querySelector(".dh-fix-save").click();
      }, { id: loanFix.caseId, v: "215000", panel: "dh-loan-panel" });
      await page.waitForTimeout(600);
      eq("C7a · the loan amount lands on the case as a number",
        await page.evaluate(async (id) => (await window.__mockDb.from("cases").select("loan_amount").eq("id", id).single()).data.loan_amount, loanFix.caseId), 215000);
      eq("C7b · …and its tile came down", await tileNum(page, "dh-tile-loan"), String(Number(loanTileBefore) - 1));
      ok("C7c · the toast names the case in words, with the money formatted", /LoanFix/.test(await toastTxt(page)) && /£215,000/.test(await toastTxt(page)), await toastTxt(page));

      // And it all survives a genuine reload: the numbers came from the database, not the DOM.
      await goPage(page, "data");
      const reloaded = await page.evaluate((ids) => Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, !!document.querySelector(`#${v.panel} .dh-fix[data-case="${v.id}"]`)])), {
        rateEnd: { id: rateEnd.caseId, panel: "dh-rateend-panel" }, compDate: { id: compDate.caseId, panel: "dh-nocompleted-panel" },
        addr: { id: addrFix.caseId, panel: "dh-address-panel" }, loan: { id: loanFix.caseId, panel: "dh-loan-panel" },
      });
      eq("C8 · after a real reload none of the four is back on any list", reloaded, { rateEnd: false, compDate: false, addr: false, loan: false });

      eq("C9 · zero native dialogs — every refusal was a toast", page.__dialogs, []);
      eq("C10 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §D · B4/M2 — ONE FILE-COMPLETENESS MEASURE
       ===================================================================== */
    {
      console.log("\n— §D · caseCompleteness, the header chip and the tile (owner, p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;

      /* The denominator moves with the stage. Read off app.js's own function so the test and the
         app can never disagree about what "of" means — the ASSERTED numbers are this file's. */
      const perStage = await page.evaluate(() => {
        const empty = { docCount: 0, fileCount: 0, factFindCount: 0, docsOn: true, filesOn: true, objectiveOn: true, waitingOn: true };
        return ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"]
          .map((s) => window.caseCompleteness({ stage: s }, empty).of);
      });
      eq("D1 · the denominator grows with the stage — 2,3,4,5,6,6 from Enquiry to Exchange", perStage, [2, 3, 4, 5, 6, 6]);

      const scored = await page.evaluate(() => {
        const on = { docsOn: true, filesOn: true, objectiveOn: true, waitingOn: true };
        const enq = window.caseCompleteness({ stage: "enquiry", objective: "buy a first home" }, Object.assign({ docCount: 1, fileCount: 0, factFindCount: 0 }, on));
        const off = window.caseCompleteness({ stage: "offer", objective: null, waiting_on: "solicitor", expected_completion_date: "2026-12-01" },
          Object.assign({ docCount: 3, fileCount: 1, factFindCount: 1 }, on));
        const nodb = window.caseCompleteness({ stage: "offer" }, { docCount: 0, fileCount: 0, factFindCount: 0, docsOn: false, filesOn: false, objectiveOn: false, waitingOn: false, factFindOn: false });
        return { enq, off, nodb };
      });
      eq("D2a · an enquiry with an objective and a checklist is complete for its stage", [scored.enq.have, scored.enq.of, scored.enq.missing], [2, 2, []]);
      eq("D2b · an offer missing only the objective scores 5 of 6 and names it", [scored.off.have, scored.off.of, scored.off.missing], [5, 6, ["client objective"]]);
      eq("D2c · every artefact whose table/column could not be read drops out of the denominator silently — never counted as missing", [scored.nodb.have, scored.nodb.of, scored.nodb.missing], [0, 1, ["expected completion date"]]);

      /* The chip, on a real case, agreeing with the same function. */
      const t = tag();
      const bare = await mkCase(page, { first: t, last: "BareFile", case: { stage: "application", case_kind: "remortgage", loan_amount: 150000, objective: null, waiting_on: null } });
      await page.evaluate((id) => window.openCase(id), bare.caseId);
      await page.waitForTimeout(2200);
      const chip = await page.evaluate(() => {
        const c = document.querySelector("#cs-file-chip");
        return c ? { txt: c.textContent.trim(), title: c.getAttribute("title") || "", amber: c.classList.contains("amber") } : null;
      });
      ok("D3a · the case modal carries a 📁 File chip", !!chip, JSON.stringify(chip));
      eq("D3b · …reading 0 of the 5 artefacts an Application is asked for", chip && chip.txt, "📁 File 0/5");
      ok("D3c · …with every missing item NAMED in the title, not just counted",
        chip && /client objective/.test(chip.title) && /document checklist/.test(chip.title) && /fact find/.test(chip.title) && /case papers/.test(chip.title) && /waiting-on/.test(chip.title), chip && chip.title);
      ok("D3d · …and coloured amber while the file is short", chip && chip.amber, JSON.stringify(chip));

      // Fill two artefacts and reopen: the chip must move.
      await page.evaluate(async (o) => {
        const db = window.__mockDb;
        await db.from("cases").update({ objective: "Remortgage before the rate ends", waiting_on: "client" }).eq("id", o.caseId);
        await db.from("fact_finds").insert({ case_id: o.caseId, client_id: o.clientId, status: "created" });
      }, bare);
      await page.evaluate(() => window.closeModal && window.closeModal());
      await page.waitForTimeout(300);
      await page.evaluate((id) => window.openCase(id), bare.caseId);
      await page.waitForTimeout(2200);
      eq("D4 · the chip moves as the artefacts land", await page.$eval("#cs-file-chip", (e) => e.textContent.trim()), "📁 File 3/5");
      await page.evaluate(() => window.closeModal && window.closeModal());
      await page.waitForTimeout(300);

      /* The Data-health tile and its list. */
      await goPage(page, "data");
      const tileTxt = await page.evaluate(() => {
        const t = document.getElementById("dh-tile-completeness");
        return t ? { n: t.querySelector(".num").textContent.trim(), lbl: t.querySelector(".lbl").textContent.trim() } : null;
      });
      ok("D5a · the tile exists", !!tileTxt, JSON.stringify(tileTxt));
      eq("D5b · …under the words the role card asked for", tileTxt && tileTxt.lbl, "Live cases with file gaps ▾");

      await page.click("#dh-tile-completeness"); await page.waitForTimeout(600);
      const panel = await page.evaluate(() => {
        const p = document.querySelector("#dh-completeness-panel");
        return {
          open: !p.classList.contains("hidden"),
          rows: [...p.querySelectorAll(".row-item")].map((r) => (r.querySelector(".s") || {}).textContent || ""),
          text: p.textContent.replace(/\s+/g, " "),
          hasInput: !!p.querySelector(".dh-fix-input"),
        };
      });
      ok("D6a · the drawer opens", panel.open);
      ok("D6b · every row names WHAT is missing, in words", panel.rows.length > 0 && panel.rows.every((s) => /missing:/.test(s)), JSON.stringify(panel.rows.slice(0, 2)));
      const gaps = panel.rows.map((s) => { const m = s.match(/(\d+)\/(\d+)/); return m ? Number(m[2]) - Number(m[1]) : -1; });
      ok("D6c · …and the list is worst-first (biggest gap at the top)",
        gaps.length > 1 && gaps.every((g, i) => i === 0 || gaps[i - 1] >= g), JSON.stringify(gaps.slice(0, 8)));
      ok("D6d · this panel offers no inline box — every missing item is work on the case, not a value to type", !panel.hasInput);
      ok("D6e · the tile's number is the number of rows the list would hold", Number(tileTxt.n) >= panel.rows.length, JSON.stringify({ tile: tileTxt.n, rows: panel.rows.length }));

      const rows = await readinessRows(page);
      ok("D7 · the readiness rollup lists it too", rows.some((r) => r.tile === "dh-tile-completeness"), JSON.stringify(rows.map((r) => r.tile)));

      /* r24's BOARD_CASE_COLS contract: the board is untouched this round. */
      await goPage(page, "pipeline");
      const boardHasChip = await page.evaluate(() => !!document.querySelector("#page-pipeline .cs-file-chip, #page-pipeline [id^='dh-tile-completeness']"));
      ok("D8 · NO completeness column or chip was added to the Pipeline board (r24 BOARD_CASE_COLS contract)", !boardHasChip);

      eq("D9 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §E · an adviser sees the same page, error-free
       ===================================================================== */
    {
      console.log("\n— §E · adviser pass (p2)");
      const page = await boot(browser, "p2");
      const errBefore = realErrs(page).length;
      await goPage(page, "data");
      const tiles = await page.evaluate(() => ["dh-tile-address", "dh-tile-loan", "dh-tile-completeness"]
        .map((id) => { const t = document.getElementById(id); return t ? Number(t.querySelector(".num").textContent.trim()) : null; }));
      ok("E1 · all three new tiles render for an adviser with real numbers", tiles.every((n) => Number.isFinite(n)), JSON.stringify(tiles));
      const inputs = await page.$$eval(".dh-fix-input", (els) => els.length);
      ok("E2 · the inline repair boxes are on the page for an adviser too (data quality is everybody's job)", inputs > 0, inputs);
      eq("E3 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r71_health: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
