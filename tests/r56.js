#!/usr/bin/env node
/* =============================================================================
   tests/r56.js — acceptance tests for R56 (Revolution design pointers round)

   1. §A  Product cards — the client record's case list renders as cards
          (.cl-card + icon + money line) WITHOUT breaking the R6/R36 DOM
          contract (.row-item / .t onclick / .cl-prot-chip / .cprop-group).
   2. §B  Protection gap card — shown on a mortgage book with no policy_taken,
          gone once a policy is recorded, absent on an all-declined book.
   3. §C  Referral actions — survey/conveyancing tiles on the case modal,
          the capture overlay writes referrals row + case note + chase task,
          the list renders, and status advances to completed.

   Run:  node /root/nx/tests/r56.js   (expects a static server on 8099;
                                       starts one itself if absent)
   ========================================================================== */
"use strict";

/* R73 · A3 — THE CASE ACTION BAR IS CAPPED NOW, so a stage action may be one press away.
   The bar was 135px of a 900px desktop viewport and 445px of an 844px phone because every action
   CASE_ACTION_RULES calls primary at a stage sat on it — twelve buttons on a completed case.
   R73 keeps the two or three the stage is actually about on the bar and moves the rest into the
   Actions ▾ menu, under a heading naming the stage; every act-* id is built exactly once, with
   the same label and the same handler, and every one is reachable in at most one extra press.
   Same shape r13 and r5_batch1 have used since R15: find out where the action currently is, open
   the overflow only if that is where it is, then click it exactly as before. */
async function r73OpenAction(page, id) {
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return true;                       // absent: let the click fail as it always would
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, `#${id}`);
  if (!visible) await page.click("#case-more-actions-toggle");
}


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
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }

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

const mock = (page, fn, arg) => page.evaluate(fn, arg);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}?as=p1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(SETTLE);

  /* ---- fixtures: a mortgage-book client with no protection, and a purchase case ---- */
  const fx = await mock(page, async () => {
    const db = window.__mockDb;
    // A client whose book is mortgage-shaped with NOTHING protected.
    const { data: cases } = await db.from("cases").select("id,client_id,case_kind,stage,protection_status,loan_amount");
    const byClient = {};
    (cases || []).forEach((c) => { (byClient[c.client_id] = byClient[c.client_id] || []).push(c); });
    let gapClient = null;
    for (const [cid, list] of Object.entries(byClient)) {
      const live = list.filter((c) => c.stage !== "not_proceeding");
      if (live.length && live.some((c) => Number(c.loan_amount) > 0)
        && !live.some((c) => c.protection_status === "policy_taken")
        && live.some((c) => c.protection_status !== "declined")) { gapClient = cid; break; }
    }
    // A purchase case at application for the referral tiles.
    let refCase = (cases || []).find((c) => c.case_kind === "purchase" && c.stage === "application");
    if (!refCase) {
      refCase = (cases || []).find((c) => c.stage === "application") || (cases || [])[0];
      await db.from("cases").update({ case_kind: "purchase", stage: "application" }).eq("id", refCase.id);
    }
    // A product-transfer case (tiles must survive in the overflow, never vanish).
    const ptCase = (cases || []).find((c) => c.case_kind === "product_transfer");
    return { gapClient, refCaseId: refCase.id, ptCaseId: ptCase ? ptCase.id : null };
  });
  ok("fixtures · found a mortgage-book client with no protection", !!fx.gapClient, JSON.stringify(fx));

  /* ================= §A + §B · product cards + gap card on the client record ================ */
  console.log("\n— §A/§B · product cards on the client record");
  await mock(page, (id) => window.openClient(id), fx.gapClient);
  await page.waitForTimeout(900);
  const cardStats = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#modal .row-item.cl-card")].filter((e) => !e.classList.contains("cl-gap-card"));
    return {
      cards: cards.length,
      icons: cards.filter((e) => e.querySelector(".cl-card-icon")).length,
      openable: cards.filter((e) => (e.querySelector(".t")?.getAttribute("onclick") || "").includes("openCase(")).length,
      prot: cards.filter((e) => e.querySelector(".cl-prot-chip")).length,
      moneyRows: cards.filter((e) => e.querySelector(".cl-card-money")).length,
      grid: !!document.querySelector("#modal .cl-book"),
      gap: !!document.querySelector("#modal .cl-gap-card"),
    };
  });
  ok("A1 · case rows render as cards inside the .cl-book grid", cardStats.grid && cardStats.cards > 0, JSON.stringify(cardStats));
  eq("A2 · every card carries the kind icon", cardStats.icons, cardStats.cards);
  eq("A3 · the R6 contract holds — every card's .t still opens its case", cardStats.openable, cardStats.cards);
  eq("A4 · the R36 contract holds — every card still carries .cl-prot-chip", cardStats.prot, cardStats.cards);
  ok("A5 · cards with a loan show the money line", cardStats.moneyRows > 0, cardStats.moneyRows);
  ok("B1 · the protection GAP card shows on an unprotected mortgage book", cardStats.gap);

  // B2 — record a policy on one live case; the gap card must stand down.
  await mock(page, async (id) => {
    const db = window.__mockDb;
    const { data: cs } = await db.from("cases").select("id,stage").eq("client_id", id);
    const live = (cs || []).find((c) => c.stage !== "not_proceeding") || (cs || [])[0];
    await db.from("cases").update({ protection_status: "policy_taken" }).eq("id", live.id);
    if (window.closeModal) window.closeModal();
  }, fx.gapClient);
  await page.waitForTimeout(400);
  await mock(page, (id) => window.openClient(id), fx.gapClient);
  await page.waitForTimeout(900);
  const gapAfter = await page.evaluate(() => !!document.querySelector("#modal .cl-gap-card"));
  ok("B2 · the gap card is GONE once a policy is recorded on the book", !gapAfter);
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  // A6 — the grouped (.cprop-group) multi-property path still renders, with cards inside.
  const grouped = await mock(page, async () => {
    const db = window.__mockDb;
    const { data: cs } = await db.from("cases").select("id,client_id,property_address");
    const byClient = {};
    (cs || []).forEach((c) => { if (c.property_address) (byClient[c.client_id] = byClient[c.client_id] || new Set()).add(c.property_address); });
    for (const [cid, props] of Object.entries(byClient)) if (props.size >= 2) return cid;
    return null;
  });
  if (grouped) {
    await mock(page, (id) => window.openClient(id), grouped);
    await page.waitForTimeout(900);
    const g = await page.evaluate(() => ({
      groups: document.querySelectorAll("#modal .cprop-group").length,
      cardsInGroups: document.querySelectorAll("#modal .cprop-group .row-item.cl-card").length,
    }));
    ok("A6 · multi-property client still renders grouped, with cards inside the groups", g.groups >= 2 && g.cardsInGroups > 0, JSON.stringify(g));
    await page.evaluate(() => window.closeModal && window.closeModal());
    await page.waitForTimeout(300);
  } else {
    ok("A6 · (skipped — no multi-property fixture found)", true);
  }

  /* ======================= §C · referral tiles + capture + status ======================= */
  console.log("\n— §C · outbound referral actions on the case modal");
  await mock(page, (id) => window.openCase(id), fx.refCaseId);
  await page.waitForTimeout(900);
  const tiles = await page.evaluate(() => ({
    survey: !!document.querySelector("#act-ref-survey"),
    conveyancing: !!document.querySelector("#act-ref-conveyancing"),
    listEmpty: (document.querySelector("#case-referrals")?.children.length || 0) === 0,
  }));
  ok("C1 · both referral tiles render on a purchase case at application", tiles.survey && tiles.conveyancing, JSON.stringify(tiles));
  ok("C2 · the referral list starts empty (and therefore invisible)", tiles.listEmpty);

  const tasksBefore = await mock(page, async (id) => (await window.__mockDb.from("case_tasks").select("id").eq("case_id", id)).data.length, fx.refCaseId);
  await r73OpenAction(page, "act-ref-survey"); await page.click("#act-ref-survey");
  await page.waitForTimeout(400);
  ok("C3 · the capture overlay opens", await page.evaluate(() => !!document.querySelector("#overlay-modal #ref-to")));
  await page.fill("#overlay-modal #ref-to", "Harrison & Co Surveyors");
  await page.fill("#overlay-modal #ref-note", "Level 2 homebuyer survey");
  await page.click("#overlay-modal #ref-ok");
  await page.waitForTimeout(800);

  const after = await mock(page, async (id) => {
    const db = window.__mockDb;
    const { data: refs } = await db.from("referrals").select("*").eq("case_id", id);
    const { data: notes } = await db.from("case_notes").select("body").eq("case_id", id);
    const { data: tasks } = await db.from("case_tasks").select("title").eq("case_id", id);
    return {
      refs: (refs || []).map((r) => ({ kind: r.kind, to: r.referred_to, status: r.status, id: r.id })),
      noteHit: (notes || []).some((n) => /Survey referral — referred to Harrison & Co Surveyors/.test(n.body)),
      chaseHit: (tasks || []).some((t) => /Chase survey referral outcome/.test(t.title)),
      tasks: (tasks || []).length,
    };
  }, fx.refCaseId);
  eq("C4 · one referrals row was written", after.refs.length, 1);
  ok("C4 · …kind survey, status made, referred-to captured", after.refs[0] && after.refs[0].kind === "survey" && after.refs[0].status === "made" && after.refs[0].to === "Harrison & Co Surveyors", JSON.stringify(after.refs));
  ok("C5 · a case note tells the story", after.noteHit);
  ok("C6 · the chase task was created (default on)", after.chaseHit, JSON.stringify({ before: tasksBefore, after: after.tasks }));

  const rowShown = await page.evaluate(() => {
    const row = document.querySelector("#case-referrals .ref-row");
    return row ? { status: row.dataset.refStatus, text: row.querySelector(".ref-t")?.textContent || "" } : null;
  });
  ok("C7 · the referral renders under the action bar", !!rowShown && /Harrison & Co Surveyors/.test(rowShown.text), JSON.stringify(rowShown));

  await page.evaluate(async (arg) => { await window.refSetStatus(arg.refId, arg.caseId, "completed"); }, { refId: after.refs[0].id, caseId: fx.refCaseId });
  await page.waitForTimeout(600);
  const done = await mock(page, async (id) => {
    const { data } = await window.__mockDb.from("referrals").select("status").eq("case_id", id);
    return (data || []).map((r) => r.status);
  }, fx.refCaseId);
  eq("C8 · status advances to completed", done[0], "completed");
  const doneRow = await page.evaluate(() => document.querySelector("#case-referrals .ref-row")?.dataset.refStatus || null);
  eq("C9 · …and the rendered row agrees", doneRow, "completed");
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  // C10 — a product transfer: the tiles are demoted, never removed (the R15 overflow rule).
  if (fx.ptCaseId) {
    await mock(page, (id) => window.openCase(id), fx.ptCaseId);
    await page.waitForTimeout(900);
    const pt = await page.evaluate(() => ({
      survey: !!document.querySelector("#act-ref-survey"),
      inOverflow: !!document.querySelector("#case-more-actions #act-ref-survey"),
    }));
    ok("C10 · on a product transfer the survey tile survives in the overflow", pt.survey && pt.inOverflow, JSON.stringify(pt));
    await page.evaluate(() => window.closeModal && window.closeModal());
  } else {
    ok("C10 · (skipped — no product-transfer fixture)", true);
  }

  const realErrors = errors.filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs/i.test(e));
  ok("no page errors", realErrors.length === 0, realErrors.join(" | ").slice(0, 300));

  console.log(`\nR56: ${pass} passed, ${failures.length} failed`);
  if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
