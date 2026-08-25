#!/usr/bin/env node
/* =============================================================================
   tests/r60.js — acceptance tests for R60 (current mortgage first, previous minimised)

   1. §A  RANKING — on one property, a case still in flight beats the watched
          completed mortgage, which beats sold, which beats completed-untracked,
          which beats not-proceeding. Exactly ONE full card renders; the rest
          are minimised into the "previous" fold as mini rows.
   2. §B  The watched mortgage LEADS even when an untracked completed case was
          created later (the 47 Bryncelyn backwards-order bug).
   3. §C  A recorded SOLD outcome fronts its property group wearing the badge.
   4. §D  Mini rows still open their case; the no-address bucket stays flat.

   Run:  node /root/nx/tests/r60.js   (expects a static server on 8099;
                                       starts one itself if absent)
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

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}?as=p1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  /* ---- fixtures: a fresh single-property landlord with the full spread of case states ---- */
  const ADDR = "1 Ordering Test House, Ranktown RK1 1AA";
  const fx = await page.evaluate(async (ADDR2) => {
    const db = window.__mockDb;
    const { data: cl } = await db.from("clients").insert({
      first_name: "Rank", last_name: "Ordering", email: "rank.ordering@example.com", phone: "07700900001",
    }).select("id").single();
    const mk = (o) => db.from("cases").insert(Object.assign({
      client_id: cl.id, case_kind: "buy_to_let", lender: "Testbank", property_address: ADDR2, assigned_to: "p2",
    }, o)).select("id").single();
    const { data: live } = await mk({ stage: "application", loan_amount: 111000 });
    const { data: watched } = await mk({ stage: "completed", loan_amount: 222000, rate_end_date: "2027-06-30", completed_at: "2025-06-30" });
    const { data: soldC } = await mk({ stage: "completed", loan_amount: 333000, property_sold_at: "2026-01-15", completed_at: "2020-01-01" });
    const { data: done } = await mk({ stage: "completed", loan_amount: 444000, completed_at: "2024-01-01" });
    const { data: lost } = await mk({ stage: "not_proceeding", loan_amount: 555000 });
    return { clientId: cl.id, liveId: live.id, watchedId: watched.id, soldId: soldC.id, doneId: done.id, lostId: lost.id };
  }, ADDR);
  ok("fixtures · one property, five case states", !!fx.clientId && !!fx.lostId, JSON.stringify(fx));

  /* ================= §A · ranking + one full card ================= */
  console.log("\n— §A · the current case is THE card; the rest are minimised");
  await page.evaluate((id) => window.openClient(id), fx.clientId);
  await page.waitForTimeout(1000);
  const a = await page.evaluate((fx2) => {
    const cards = [...document.querySelectorAll("#modal .row-item.cl-card")].filter((e) => !e.classList.contains("cl-gap-card"));
    const headOnclick = cards[0]?.querySelector(".t")?.getAttribute("onclick") || "";
    const fold = document.querySelector("#modal .cprop-prev");
    const minis = [...document.querySelectorAll("#modal .cl-mini")];
    return {
      fullCards: cards.length,
      headIsLive: headOnclick.includes(fx2.liveId),
      summary: fold ? fold.querySelector("summary").textContent : "",
      miniCount: minis.length,
      miniOrder: minis.map((m) => (m.querySelector(".t")?.getAttribute("onclick") || "").match(/openCase\('([^']+)'\)/)?.[1]),
      openByDefault: fold ? fold.open : null,
      miniContract: minis.length > 0 && minis.every((m) => m.classList.contains("row-item") && m.querySelector(".row-main .t") && m.querySelector(".cl-prot-chip")),
    };
  }, fx);
  eq("A1 · exactly ONE full card renders for the property", a.fullCards, 1);
  ok("A2 · …and it is the case still in flight", a.headIsLive, JSON.stringify(a));
  ok("A3 · the other four are minimised into the previous fold, closed by default", a.miniCount === 4 && a.openByDefault === false, JSON.stringify(a));
  ok("A3b · mini rows keep the row contract (.row-item, .t onclick, .cl-prot-chip)", a.miniContract, JSON.stringify(a));
  ok("A4 · the fold says how many it holds", /4 previous cases on this property/.test(a.summary), a.summary);
  ok("A5 · fold order follows the ranking: watched → sold → completed → not proceeding",
    JSON.stringify(a.miniOrder) === JSON.stringify([fx.watchedId, fx.soldId, fx.doneId, fx.lostId]), JSON.stringify(a.miniOrder));
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  /* ================= §B · the watched mortgage leads (the Bryncelyn bug) ================= */
  console.log("\n— §B · watched beats untracked, whatever was created last");
  const b = await page.evaluate(async (fx2) => {
    const db = window.__mockDb;
    // kill the live case so the completed rows compete on their own merits
    await db.from("cases").update({ stage: "not_proceeding" }).eq("id", fx2.liveId);
    await window.openClient(fx2.clientId);
    await new Promise((r) => setTimeout(r, 900));
    const card = [...document.querySelectorAll("#modal .row-item.cl-card")].find((e) => !e.classList.contains("cl-gap-card"));
    return {
      headOnclick: card?.querySelector(".t")?.getAttribute("onclick") || "",
      badge: (card?.querySelector(".cl-badge-watch")?.textContent || "").trim(),
    };
  }, fx);
  ok("B1 · the WATCHED completed mortgage is now the card", b.headOnclick.includes(fx.watchedId), JSON.stringify(b));
  ok("B2 · …wearing its retained badge (R59)", /retained/.test(b.badge), b.badge);
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  /* ================= §C · a sold outcome fronts the group ================= */
  console.log("\n— §C · sold fronts the property once nothing is watched");
  const c = await page.evaluate(async (fx2) => {
    const db = window.__mockDb;
    await db.from("cases").update({ rate_end_date: null }).eq("id", fx2.watchedId); // stop watching it
    await window.openClient(fx2.clientId);
    await new Promise((r) => setTimeout(r, 900));
    const card = [...document.querySelectorAll("#modal .row-item.cl-card")].find((e) => !e.classList.contains("cl-gap-card"));
    return {
      headOnclick: card?.querySelector(".t")?.getAttribute("onclick") || "",
      soldClass: card?.classList.contains("cl-card-sold") || false,
      badge: (card?.querySelector(".cl-badge-sold")?.textContent || "").trim(),
    };
  }, fx);
  ok("C1 · the SOLD case is now the card, dimmed", c.headOnclick.includes(fx.soldId) && c.soldClass, JSON.stringify(c));
  ok("C2 · …with the SOLD badge on show", /SOLD/.test(c.badge), c.badge);
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  /* ================= §D · minis open their case; no-address stays flat ================= */
  console.log("\n— §D · the fold is a doorway, not a graveyard");
  await page.evaluate((id) => window.openClient(id), fx.clientId);
  await page.waitForTimeout(900);
  await page.click("#modal .cprop-prev summary");
  await page.waitForTimeout(200);
  await page.evaluate((id) => {
    const t = [...document.querySelectorAll("#modal .cl-mini .t")].find((e) => (e.getAttribute("onclick") || "").includes(id));
    t.click();
  }, fx.doneId);
  await page.waitForTimeout(1000);
  const opened = await page.evaluate((id) => !!document.querySelector("#case-milestones") &&
    !!document.querySelector(`#cs-stage-select`), fx.doneId);
  ok("D1 · clicking a minimised previous case opens that case", opened);
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  const d2 = await page.evaluate(async () => {
    const db = window.__mockDb;
    // a client whose multi-case book has NO addresses at all → flat list, no fold
    const { data: cs } = await db.from("cases").select("id,client_id,property_address");
    const byClient = {};
    (cs || []).forEach((x) => { (byClient[x.client_id] = byClient[x.client_id] || []).push(x); });
    const target = Object.entries(byClient).find(([, rows]) => rows.length > 1 && rows.every((r) => !r.property_address));
    if (!target) return { skip: true };
    await window.openClient(target[0]);
    await new Promise((r) => setTimeout(r, 900));
    return { skip: false, folds: document.querySelectorAll("#modal .cprop-prev").length,
             cards: [...document.querySelectorAll("#modal .row-item.cl-card")].filter((e) => !e.classList.contains("cl-gap-card")).length };
  });
  ok("D2 · a no-address multi-case book stays the flat list (no fold, all cards)", d2.skip || (d2.folds === 0 && d2.cards > 1), JSON.stringify(d2));
  await page.evaluate(() => window.closeModal && window.closeModal());

  const realErrors = errors.filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs/i.test(e));
  ok("no page errors", realErrors.length === 0, realErrors.join(" | ").slice(0, 300));

  console.log(`\nR60: ${pass} passed, ${failures.length} failed`);
  if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
