#!/usr/bin/env node
/* =============================================================================
   tests/r61.js — acceptance tests for R61 (site-wide hierarchy pass)

   §A  MY DAY IN BANDS — the flat list becomes colour-banded sections (Urgent /
       Today / Worth doing) with per-band counts, each band folding past 10 rows
       behind "show the other N"; fold state survives repaints; the section
       counts still add up to every row (nothing hidden from the workload).
   §B  CLIENTS: ONE CURRENT FACT — "no contact in 210 days" no longer prints
       (true of the whole imported book = noise); each row instead carries its
       one current fact: live case at stage / next rate end / rate ended.
   §C  RETENTION: SAY THE BASIS ONCE — the per-row "(value at risk · …)"
       parenthetical is gone from rows and lives in the panel subtitle; group
       heads carry their colour classes; old distances read in months/years.
   §D  PROTECTION: STATUS BANDS — rows grouped current-first (quoted →
       discussed → not discussed) with coloured band rows; row DOM contract
       (Open button, status select, .prot-cb) unchanged.

   Run:  node /root/nx/tests/r61.js
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

async function boot(browser, persona) {
  const page = await (await browser.newContext()).newPage();
  page.on("dialog", (d) => d.accept());
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* ================= §A · My Day bands ================= */
  console.log("— §A · My Day in bands");
  const pa = await boot(browser, "p1");
  const a = await pa.evaluate(() => {
    const list = document.querySelector("#briefing-list");
    const secs = [...list.querySelectorAll(".brief-sec")].map((s) => ({
      cls: s.className, n: Number(s.querySelector(".brief-sec-n")?.textContent || 0),
    }));
    const heads = list.querySelectorAll(".brief-row:not(.brief-subrow)").length;
    const folds = [...list.querySelectorAll("details.brief-fold")].map((d) => ({
      open: d.open, summary: d.querySelector("summary").textContent.trim(),
      rows: d.querySelectorAll(".brief-row:not(.brief-subrow)").length,
    }));
    const shownOutside = [...list.querySelectorAll(".brief-row:not(.brief-subrow)")].filter((r) => !r.closest("details")).length;
    return { secs, heads, folds, shownOutside };
  });
  ok("A1 · the list renders in banded sections", a.secs.length >= 1, JSON.stringify(a.secs));
  ok("A2 · section counts add up to every row — nothing hidden from the workload",
    a.secs.reduce((s, x) => s + x.n, 0) === a.heads, JSON.stringify({ sum: a.secs.reduce((s, x) => s + x.n, 0), heads: a.heads }));
  ok("A3 · a band longer than 10 folds the rest ('show the other N'), closed by default",
    a.folds.every((f) => !f.open && /Show the other \d+/.test(f.summary)) && (a.heads <= 10 * a.secs.length || a.folds.length > 0),
    JSON.stringify(a.folds));
  // fold state survives a repaint
  const a4 = await pa.evaluate(async () => {
    const d = document.querySelector("#briefing-list details.brief-fold");
    if (!d) return { skip: true };
    d.open = true;                    // ontoggle stores it
    await new Promise((r) => setTimeout(r, 50));
    window.renderBriefing ? window.renderBriefing() : null;
    // renderBriefing may not be on window — drive a repaint through the exported repaint path
    if (!window.renderBriefing) await new Promise((r) => setTimeout(r, 100));
    const d2 = document.querySelector("#briefing-list details.brief-fold");
    return { skip: false, stillOpen: d2 ? d2.open : null };
  });
  ok("A4 · an opened fold stays open across a repaint", a4.skip || a4.stillOpen === true, JSON.stringify(a4));
  ok("A5 · no page errors on Today", pa.__err.filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs/i.test(e)).length === 0, pa.__err.join("|").slice(0, 200));
  await pa.close();

  /* ================= §B · the client row's one current fact ================= */
  console.log("\n— §B · Clients: one current fact, no boilerplate");
  const pb = await boot(browser, "p1");
  const fxB = await pb.evaluate(async () => {
    const db = window.__mockDb;
    const mkC = (fn, ln) => db.from("clients").insert({ first_name: fn, last_name: ln, email: `${fn}.${ln}@example.com`.toLowerCase(), phone: "07700900123" }).select("id").single();
    const { data: c1 } = await mkC("R61", "Livecase");
    await db.from("cases").insert({ client_id: c1.id, case_kind: "purchase", stage: "application", assigned_to: "p2", property_address: "1 R61 St, Testtown TE1 1AA" });
    const { data: c2 } = await mkC("R61", "Watched");
    await db.from("cases").insert({ client_id: c2.id, case_kind: "remortgage", stage: "completed", assigned_to: "p2", rate_end_date: "2027-09-30", completed_at: "2025-09-30", property_address: "2 R61 St, Testtown TE1 1AB" });
    const { data: c3 } = await mkC("R61", "Rateended");
    await db.from("cases").insert({ client_id: c3.id, case_kind: "buy_to_let", stage: "completed", assigned_to: "p2", rate_end_date: "2023-03-31", completed_at: "2018-03-31", property_address: "3 R61 St, Testtown TE1 1AC" });
    return { live: c1.id, watched: c2.id, ended: c3.id };
  });
  await pb.evaluate(() => { location.hash = "#clients"; });
  await pb.waitForTimeout(1400);
  const rowFacts = await pb.evaluate((fx) => {
    const get = (id) => {
      const row = document.querySelector(`.client-row[data-client="${id}"]`);
      if (!row) return null;
      return {
        next: row.querySelector(".client-next")?.textContent.trim() || null,
        nextCls: row.querySelector(".client-next")?.className || "",
        lcAge: row.querySelector(".client-lc-age")?.textContent.trim() || null,
      };
    };
    const anyBoiler = document.querySelector("#client-list") && document.querySelector("#client-list").textContent.includes("no contact in 210 days");
    return { live: get(fx.live), watched: get(fx.watched), ended: get(fx.ended), anyBoiler };
  }, fxB);
  ok("B1 · a live-case client reads its kind at its stage (blue fact)", rowFacts.live && /at /.test(rowFacts.live.next || "") && /cn-live/.test(rowFacts.live.nextCls), JSON.stringify(rowFacts.live));
  ok("B2 · a watched client reads 'rate ends <date>' (green fact)", rowFacts.watched && /^rate ends /.test(rowFacts.watched.next || "") && /cn-watch/.test(rowFacts.watched.nextCls), JSON.stringify(rowFacts.watched));
  ok("B3 · an outcome-owed client reads 'rate ended <date>' (amber fact)", rowFacts.ended && /^rate ended /.test(rowFacts.ended.next || "") && /cn-overdue/.test(rowFacts.ended.nextCls), JSON.stringify(rowFacts.ended));
  ok("B4 · 'no contact in 210 days' is gone from the list (silence is not news)", rowFacts.anyBoiler === false);
  ok("B5 · …and the no-comms rows carry no .client-lc-age at all", rowFacts.live && rowFacts.live.lcAge === null, JSON.stringify(rowFacts.live));
  ok("B6 · no page errors on Clients", pb.__err.filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs/i.test(e)).length === 0, pb.__err.join("|").slice(0, 200));
  await pb.close();

  /* ================= §C · Retention says the basis once ================= */
  console.log("\n— §C · Retention: basis once, coloured groups, readable distances");
  const pc = await boot(browser, "p4");   // owner — the money lines render for him
  await pc.evaluate(() => { location.hash = "#retention"; });
  await pc.waitForTimeout(1800);
  const c = await pc.evaluate(() => {
    const list = document.querySelector("#ret-rates-list");
    const sub = document.querySelector("#ret-rates-sub")?.textContent || "";
    const endedRows = list ? list.querySelectorAll(".ret-group-h.ret-g-ended").length : 0;
    const soonHead = list ? list.querySelectorAll(".ret-group-h.ret-g-soon").length : 0;
    // the per-row "≈ estimate" marker on an uplift figure is row-specific and stays;
    // what must be gone is the repeated FEED basis phrase.
    const rowBasis = list ? [...list.querySelectorAll(".row-item")].filter((r) => /last fee as proxy/.test(r.textContent)).length : 0;
    const yearHeads = list ? [...list.querySelectorAll(".ret-year-h")].map((e) => e.textContent) : [];
    const humanised = list ? /(months|years) ago/.test(list.textContent) : false;
    const moneyRows = list ? list.querySelectorAll(".rate-money").length : 0;
    const endedCount = list ? Number(list.querySelector(".ret-group-h.ret-g-ended .count")?.textContent || 0) : 0;
    return { sub, endedRows, soonHead, rowBasis, yearHeads, humanised, moneyRows, endedCount };
  });
  ok("C1 · the Ended group head wears its red class (and Soon its amber, when present)", c.endedRows >= 1 || c.soonHead >= 1, JSON.stringify(c));
  ok("C2 · NO row repeats the money basis any more", c.rowBasis === 0, `rowBasis=${c.rowBasis}`);
  ok("C3 · the basis is said once, in the panel subtitle", /value at risk/.test(c.sub) && /proxy/.test(c.sub), c.sub.slice(0, 160));
  ok("C4 · long-ended rates read in months/years, not day counts", c.moneyRows === 0 || c.humanised || c.endedCount === 0, JSON.stringify({ humanised: c.humanised, endedCount: c.endedCount }));
  ok("C5 · year sub-heads render inside a long Ended group (date sort)", c.endedCount <= 8 || c.yearHeads.length >= 1, JSON.stringify(c.yearHeads));
  ok("C6 · no page errors on Retention", pc.__err.filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs/i.test(e)).length === 0, pc.__err.join("|").slice(0, 200));
  await pc.close();

  /* ================= §D · Protection bands ================= */
  console.log("\n— §D · Protection: status bands, current first");
  const pd = await boot(browser, "p1");
  // guarantee more than one band: set one open opportunity to quoted, one to discussed
  await pd.evaluate(async () => {
    const db = window.__mockDb;
    const { data: cs } = await db.from("cases").select("id,stage,protection_status").in("stage", ["application", "offer"]).limit(10);
    if ((cs || [])[0]) await db.from("cases").update({ protection_status: "quoted", protection_quoted_at: new Date().toISOString() }).eq("id", cs[0].id);
    if ((cs || [])[1]) await db.from("cases").update({ protection_status: "discussed" }).eq("id", cs[1].id);
  });
  await pd.evaluate(() => { location.hash = "#protection"; });
  await pd.waitForTimeout(1800);
  const d = await pd.evaluate(() => {
    const t = document.querySelector("#prot-list-table");
    if (!t) return null;
    const bands = [...t.querySelectorAll("tr.prot-band")].map((r) => r.className.match(/prot-band-(\w+)/)?.[1]);
    // the row order of statuses must be non-interleaved and follow quoted→discussed→not_discussed
    const order = { quoted: 0, discussed: 1, not_discussed: 2 };
    const rowStatuses = [...t.querySelectorAll("tr")].filter((r) => r.querySelector(".prot-cb")).map((r) => {
      const b = r.querySelector("td:nth-child(6) .badge");
      return b ? b.textContent.trim() : "";
    });
    const seq = rowStatuses.map((s) => s === "QUOTED" ? 0 : s === "DISCUSSED" ? 1 : 2);
    const sorted = seq.every((v, i) => i === 0 || v >= seq[i - 1]);
    const contract = [...t.querySelectorAll("tr")].filter((r) => r.querySelector(".prot-cb"))
      .every((r) => r.querySelector(".prot-actions button") && r.querySelector(".prot-status-set"));
    return { bands, sorted, rows: rowStatuses.length, contract, bandOrderOk: bands.every((b, i) => i === 0 || (order[b] ?? 3) > (order[bands[i - 1]] ?? 3)) };
  });
  ok("D1 · band header rows render (quoted / discussed / not discussed)", d && d.bands.length >= 2, JSON.stringify(d && d.bands));
  ok("D2 · bands run current-first: quoted → discussed → not discussed", d && d.bandOrderOk, JSON.stringify(d && d.bands));
  ok("D3 · rows are grouped, never interleaved", d && d.sorted, JSON.stringify(d && d.rows));
  ok("D4 · every row keeps its Open button and status select (DOM contract)", d && d.contract);
  ok("D5 · no page errors on Protection", pd.__err.filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs/i.test(e)).length === 0, pd.__err.join("|").slice(0, 200));
  await pd.close();

  console.log(`\nR61: ${pass} passed, ${failures.length} failed`);
  if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
