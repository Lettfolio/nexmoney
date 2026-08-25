#!/usr/bin/env node
/* =============================================================================
   tests/r57.js — acceptance tests for R57 (objective line + milestone checklist)

   1. §A  Pinned objective — renders in the case header (placeholder when empty),
          the overlay edits it, the targeted write persists, the header updates,
          and — the part that matters — a form Save straight afterwards is NOT a
          false conflict (the R18-D1 stale-write stamp was refreshed).
   2. §B  Milestones — derived from the case's own columns: created ticked with
          date, submitted_at ticks Application with its date, current stage is
          the → row, a product transfer has no Exchange row, a completed case
          ticks Completed, and not_proceeding shows the ✕ closed row.

   Run:  node /root/nx/tests/r57.js   (expects a static server on 8099;
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
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push(d.message().slice(0, 80)); d.accept(); });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}?as=p1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  /* ---- fixtures straight from the mock DB ---- */
  const fx = await page.evaluate(async () => {
    const db = window.__mockDb;
    const { data: cases } = await db.from("cases").select("id,stage,case_kind,submitted_at,completed_at,objective");
    const offerCase = (cases || []).find((c) => c.stage === "offer") || (cases || []).find((c) => c.stage === "application");
    // force a known shape: at offer, with a submitted date, not a PT
    await db.from("cases").update({ case_kind: "purchase", submitted_at: "2026-08-01", objective: null }).eq("id", offerCase.id);
    const pt = (cases || []).find((c) => c.case_kind === "product_transfer");
    const done = (cases || []).find((c) => c.stage === "completed" && c.completed_at);
    const lost = (cases || []).find((c) => c.stage === "not_proceeding");
    return { offerId: offerCase.id, offerStage: offerCase.stage, ptId: pt ? pt.id : null, doneId: done ? done.id : null, lostId: lost ? lost.id : null };
  });
  ok("fixtures · found offer-ish / PT / completed cases", !!fx.offerId && !!fx.ptId && !!fx.doneId, JSON.stringify(fx));

  /* ================================ §A · objective ================================ */
  console.log("\n— §A · the pinned objective");
  await page.evaluate((id) => window.openCase(id), fx.offerId);
  await page.waitForTimeout(900);
  const obj0 = await page.evaluate(() => ({
    line: !!document.querySelector("#cs-objective"),
    placeholder: document.querySelector("#cs-obj-text")?.classList.contains("cs-muted") || false,
  }));
  ok("A1 · the objective line renders in the case header", obj0.line);
  ok("A2 · …showing the muted placeholder while empty", obj0.placeholder);

  await page.click("#cs-objective");
  await page.waitForTimeout(400);
  ok("A3 · clicking it opens the edit overlay", await page.evaluate(() => !!document.querySelector("#overlay-modal #obj-text")));
  await page.fill("#overlay-modal #obj-text", "First home purchase — friend of the Marcus family, completing before Christmas");
  await page.click("#overlay-modal #obj-ok");
  await page.waitForTimeout(600);

  const obj1 = await page.evaluate(async (id) => {
    const { data } = await window.__mockDb.from("cases").select("objective").eq("id", id).single();
    return { db: data.objective, shown: document.querySelector("#cs-obj-text")?.textContent || "", muted: document.querySelector("#cs-obj-text")?.classList.contains("cs-muted") };
  }, fx.offerId);
  eq("A4 · the objective is stored on the case", obj1.db, "First home purchase — friend of the Marcus family, completing before Christmas");
  ok("A5 · …and the header line updated in place, no longer muted", /Marcus family/.test(obj1.shown) && !obj1.muted, JSON.stringify(obj1));

  // A6 — THE GUARD TEST: a form Save straight after the targeted objective write must not be
  // a false "changed elsewhere" conflict (editCaseObjective refreshes the R18-D1 stamp).
  page.__dialogs = [];
  await page.click("#modal-save");
  await page.waitForTimeout(900);
  ok("A6 · form Save straight after the objective edit is NOT a false conflict", page.__dialogs.length === 0, JSON.stringify(page.__dialogs));

  // A7 — persistence: reopen and the sentence is there, pinned.
  await page.evaluate((id) => window.openCase(id), fx.offerId);
  await page.waitForTimeout(900);
  const obj2 = await page.evaluate(() => document.querySelector("#cs-obj-text")?.textContent || "");
  ok("A7 · reopening the case shows the pinned objective", /Marcus family/.test(obj2), obj2);

  /* ================================ §B · milestones ================================ */
  console.log("\n— §B · the milestone checklist");
  const ms = await page.evaluate(() => {
    const box = document.querySelector("#case-milestones");
    if (!box) return null;
    const rows = [...box.querySelectorAll(".ms-row")].map((r) => ({
      label: r.querySelector(".ms-label")?.textContent || "", state: r.className.replace("ms-row", "").trim(), date: r.querySelector(".ms-date")?.textContent || "",
    }));
    return { summary: box.querySelector("summary")?.textContent || "", rows };
  });
  ok("B1 · the milestones fold renders on the case", !!ms, JSON.stringify(ms && ms.summary));
  const row = (label) => (ms.rows || []).find((r) => r.label.startsWith(label));
  ok("B2 · Case created is done, with its date", row("Case created")?.state === "done" && !!row("Case created")?.date, JSON.stringify(row("Case created")));
  ok("B3 · Application submitted ticks off the submitted_at column, with the date", row("Application submitted")?.state === "done" && row("Application submitted")?.date.length > 0, JSON.stringify(row("Application submitted")));
  const stageRow = fx.offerStage === "offer" ? row("Offer issued") : row("Application submitted");
  ok("B4 · the case's current stage is the → row (or already done via its date)", stageRow && (stageRow.state === "current" || stageRow.state === "done"), JSON.stringify(stageRow));
  ok("B5 · Completed is still to come on a live case", row("Completed")?.state === "todo", JSON.stringify(row("Completed")));
  ok("B6 · the summary carries the done-count", /\d+ of \d+ done/.test(ms.summary), ms.summary);
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  // B7 — product transfer: no Exchange row (R15 §5 — a PT never exchanges contracts).
  await page.evaluate((id) => window.openCase(id), fx.ptId);
  await page.waitForTimeout(900);
  const ptRows = await page.evaluate(() => [...document.querySelectorAll("#case-milestones .ms-row .ms-label")].map((e) => e.textContent));
  ok("B7 · a product transfer has NO Exchange milestone", ptRows.length > 0 && !ptRows.some((l) => l.startsWith("Exchange")), JSON.stringify(ptRows));
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  // B8 — completed case: Completed done with its date.
  await page.evaluate((id) => window.openCase(id), fx.doneId);
  await page.waitForTimeout(900);
  const doneRow = await page.evaluate(() => {
    const r = [...document.querySelectorAll("#case-milestones .ms-row")].find((e) => e.querySelector(".ms-label")?.textContent.startsWith("Completed"));
    return r ? { state: r.className, date: r.querySelector(".ms-date")?.textContent || "" } : null;
  });
  ok("B8 · a completed case ticks Completed with its date", !!doneRow && /done/.test(doneRow.state) && doneRow.date.length > 0, JSON.stringify(doneRow));
  await page.evaluate(() => window.closeModal && window.closeModal());
  await page.waitForTimeout(300);

  // B9 — not proceeding: the ✕ closed row.
  if (fx.lostId) {
    await page.evaluate((id) => window.openCase(id), fx.lostId);
    await page.waitForTimeout(900);
    const lostRow = await page.evaluate(() => [...document.querySelectorAll("#case-milestones .ms-row.lost .ms-label")].map((e) => e.textContent));
    ok("B9 · a not-proceeding case shows the closed row", lostRow.some((l) => /Closed — not proceeding/.test(l)), JSON.stringify(lostRow));
    await page.evaluate(() => window.closeModal && window.closeModal());
  } else {
    ok("B9 · (skipped — no not-proceeding fixture)", true);
  }

  const realErrors = errors.filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs/i.test(e));
  ok("no page errors", realErrors.length === 0, realErrors.join(" | ").slice(0, 300));

  console.log(`\nR57: ${pass} passed, ${failures.length} failed`);
  if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
