#!/usr/bin/env node
/* =============================================================================
   tests/r59.js — acceptance tests for R59 (SOLD vs RETAINED, obvious on the record)

   1. §A  Recording "property sold" stamps property_sold_at (date editable in the
          overlay, defaulting to today), and the CLIENT RECORD then says so out
          loud: SOLD badge + dimmed card on the book, SOLD flag on the case
          header, and a "Property sold" milestone row.
   2. §B  The retained side: a completed case with a FUTURE tracked rate wears
          the green "retained · ends" badge; an OVERDUE one wears the amber
          "rate ended" badge (an outcome is owed). A completed case with neither
          stays quiet — unknown is not a status.
   3. §C  Correction: recording "renewed" on a case that carries a stale SOLD
          stamp clears it — the record must not shout SOLD on a live mortgage.

   Run:  node /root/nx/tests/r59.js   (expects a static server on 8099;
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

  /* ---- fixtures: two completed tracked cases (sold + future-retained) on known clients ---- */
  const fx = await page.evaluate(async () => {
    const db = window.__mockDb;
    const { data: cases } = await db.from("cases").select("id,client_id,stage,rate_end_date");
    const tracked = (cases || []).filter((c) => c.stage === "completed" && c.rate_end_date);
    const sold = tracked[0], keep = tracked[1];
    // pin the retained one to a KNOWN future date, and find/make an overdue one
    const future = new Date(); future.setFullYear(future.getFullYear() + 1);
    const futureStr = future.toISOString().slice(0, 10);
    await db.from("cases").update({ rate_end_date: futureStr }).eq("id", keep.id);
    const overdue = tracked[2] || null;
    if (overdue) await db.from("cases").update({ rate_end_date: "2024-05-01" }).eq("id", overdue.id);
    return { soldId: sold.id, soldClient: sold.client_id, keepId: keep.id, keepClient: keep.client_id,
             futureStr, overdueId: overdue && overdue.id, overdueClient: overdue && overdue.client_id };
  });
  ok("fixtures · completed tracked cases found", !!fx.soldId && !!fx.keepId, JSON.stringify(fx));

  /* ================= §A · sold — and the record says so ================= */
  console.log("\n— §A · property sold, obvious everywhere");
  await page.evaluate((id) => window.openCase(id), fx.soldId);
  await page.waitForTimeout(900);
  await page.click("#act-rate-outcome");
  await page.waitForTimeout(400);
  const soldField = await page.evaluate(() => document.querySelector("#overlay-modal #reo-sold-date")?.value || "");
  ok("A1 · the overlay offers a sold date, prefilled today", /^\d{4}-\d{2}-\d{2}$/.test(soldField), soldField);
  await page.check('#overlay-modal input[name="reo-kind"][value="sold"]');
  await page.fill("#overlay-modal #reo-sold-date", "2026-08-20");
  await page.click("#overlay-modal #reo-ok");
  await page.waitForTimeout(1200);

  const soldDb = await page.evaluate(async (id) => {
    const { data: c } = await window.__mockDb.from("cases").select("property_sold_at,rate_end_date").eq("id", id).single();
    const { data: notes } = await window.__mockDb.from("case_notes").select("body").eq("case_id", id);
    return { at: c.property_sold_at, rateEnd: c.rate_end_date,
             noteHit: (notes || []).some((n) => /property sold \/ mortgage redeemed on /i.test(n.body)) };
  }, fx.soldId);
  eq("A2 · property_sold_at is stamped with the chosen date", soldDb.at, "2026-08-20");
  ok("A3 · rate tracking still closed and the note carries the date", soldDb.rateEnd == null && soldDb.noteHit, JSON.stringify(soldDb));

  // the reopened case (rateEndOutcome ends in openCase): header flag + milestone row
  const caseView = await page.evaluate(() => ({
    flag: document.querySelector(".cs-sold-flag")?.textContent || "",
    ms: [...document.querySelectorAll("#case-milestones .ms-row.done .ms-label")].map((e) => e.textContent),
  }));
  ok("A4 · the case header wears the SOLD flag with the date", /SOLD/.test(caseView.flag) && /20/.test(caseView.flag), caseView.flag);
  ok("A5 · milestones gained the 'Property sold / mortgage redeemed' done row", caseView.ms.some((l) => /Property sold \/ mortgage redeemed/.test(l)), JSON.stringify(caseView.ms));
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  // the client book: SOLD badge + dimmed card
  await page.evaluate((id) => window.openClient(id), fx.soldClient);
  await page.waitForTimeout(1000);
  const book = await page.evaluate((caseId) => {
    const cards = [...document.querySelectorAll(".cl-card")];
    const soldCards = cards.filter((c) => c.classList.contains("cl-card-sold"));
    const badge = document.querySelector(".cl-card-sold .cl-badge-sold");
    return { cards: cards.length, soldCards: soldCards.length, badgeText: badge ? badge.textContent : "" };
  }, fx.soldId);
  ok("A6 · the client book renders the sold case as a dimmed SOLD card", book.soldCards >= 1, JSON.stringify(book));
  ok("A7 · …with the SOLD badge carrying the date", /SOLD/.test(book.badgeText) && /20/.test(book.badgeText), book.badgeText);
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  /* ================= §B · retained / overdue badges ================= */
  console.log("\n— §B · the retained side of the book");
  await page.evaluate((id) => window.openClient(id), fx.keepClient);
  await page.waitForTimeout(1000);
  const keepBadge = await page.evaluate(() => {
    const b = document.querySelector(".cl-badge-watch.green, .badge.green.cl-badge-watch");
    return b ? b.textContent : "";
  });
  ok("B1 · a future tracked rate wears the green retained badge", /retained/.test(keepBadge) && /ends/.test(keepBadge), keepBadge);
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);
  if (fx.overdueId) {
    await page.evaluate((id) => window.openClient(id), fx.overdueClient);
    await page.waitForTimeout(1000);
    const late = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".badge.amber.cl-badge-watch")];
      return b.map((e) => e.textContent).join(" | ");
    });
    ok("B2 · an overdue tracked rate wears the amber 'rate ended' badge", /rate ended/.test(late), late);
    await page.evaluate(() => window.closeModal && window.closeModal());
    await page.waitForTimeout(300);
  } else {
    ok("B2 · (skipped — no third tracked fixture)", true);
  }
  // quiet when unknown: a completed case with no stamp and no tracked rate carries NO status badge
  const quiet = await page.evaluate(async () => {
    const db = window.__mockDb;
    const { data: cases } = await db.from("cases").select("id,client_id,stage,rate_end_date,property_sold_at");
    const c = (cases || []).find((x) => x.stage === "completed" && !x.rate_end_date && !x.property_sold_at);
    if (!c) return { skip: true };
    await window.openClient(c.client_id);
    await new Promise((r) => setTimeout(r, 900));
    const card = [...document.querySelectorAll(".cl-card")].find((el) => {
      const t = el.querySelector(".t");
      return t && t.getAttribute("onclick") && t.getAttribute("onclick").includes(c.id);
    });
    return { skip: false, hasBadge: !!(card && (card.querySelector(".cl-badge-sold") || card.querySelector(".cl-badge-watch"))) };
  });
  ok("B3 · a completed case with no stamp and no tracked rate stays quiet", quiet.skip || quiet.hasBadge === false, JSON.stringify(quiet));
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  /* ================= §C · correction clears a stale SOLD stamp ================= */
  console.log("\n— §C · renewed clears a stale SOLD stamp");
  await page.evaluate(async (id) => {
    // the mistake scenario: marked sold, then the client turns out to have renewed —
    // the operator re-adds the rate end date on the form, which brings the action back
    await window.__mockDb.from("cases").update({ rate_end_date: "2026-12-01" }).eq("id", id);
  }, fx.soldId);
  await page.evaluate((id) => window.openCase(id), fx.soldId);
  await page.waitForTimeout(900);
  ok("C1 · the outcome action is back once a rate is tracked again", await page.evaluate(() => !!document.querySelector("#act-rate-outcome")));
  await page.click("#act-rate-outcome");
  await page.waitForTimeout(400);
  await page.click('#overlay-modal .reo-chip[data-years="2"]');
  await page.click("#overlay-modal #reo-ok");
  await page.waitForTimeout(1200);
  const fixed = await page.evaluate(async (id) => {
    const { data: c } = await window.__mockDb.from("cases").select("property_sold_at,rate_end_date").eq("id", id).single();
    return { at: c.property_sold_at, rateEnd: c.rateEnd, hasFlag: !!document.querySelector(".cs-sold-flag") };
  }, fx.soldId);
  ok("C2 · the SOLD stamp is cleared by the renewed outcome", fixed.at == null, JSON.stringify(fixed));
  ok("C3 · …and the reopened case header no longer wears the flag", fixed.hasFlag === false, JSON.stringify(fixed));
  await page.evaluate(() => window.closeModal && window.closeModal());

  const realErrors = errors.filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs/i.test(e));
  ok("no page errors", realErrors.length === 0, realErrors.join(" | ").slice(0, 300));

  console.log(`\nR59: ${pass} passed, ${failures.length} failed`);
  if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
