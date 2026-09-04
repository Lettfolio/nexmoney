#!/usr/bin/env node
/* =============================================================================
   tests/r80_protect.js — acceptance tests for R80 build A, "Mine the book".

   The CTO rewrote the LIVE get_protection_pipeline: previously `limit 250`
   with NO order (an arbitrary 250 of 1,531 candidates), now the BEST 250 BY
   SCORE (stage urgency + warmth + loan size + has_email), same row shape plus
   `score`, with a new companion get_protection_pipeline_total(p_scope) →
   {"total": N} and non-admin callers forced to p_scope='mine'. The mock
   mirrors that exactly, and the Protection page became a work-the-book call
   list around it.

   §A  A1 · MOCK RPC PARITY + CEILING. window.__mock.seedProtectionBook(300)
       inflates the book past the cap; the RPC returns exactly the top 250 by
       the pinned score formula (recomputed here from fixture ground truth),
       score-desc, est_commission = protection_avg_commission × loan band
       (0.7/1.0/1.3/1.6). A top-score case seeded BEYOND position 250 by
       fixture order appears; a low-score case beyond the cap does NOT. The
       companion total RPC reports the uncapped count.
   §B  A2/A4 · PAGE HONESTY + WAVES. The page consumes BOTH RPCs in one wave
       and everything else in a second (≤2 waves measured, r78_fast's in-page
       instrumentation); the header states "best 250 of N" with the £ sum
       matching fixture arithmetic; rank order is the RPC's (score desc, R61
       bands retired) with the score explained in the # cell's tooltip; search
       and filter cost ZERO network (session cache); one cases write through
       the choke point busts the cache so the next load refetches.
   §C  A2f · BULK "QUEUE PROTECTION INTRO". Tick rows → house overlay carrying
       R79's held wording verbatim, skipping (and counting, with the reason)
       clients with no email; confirming queues protection_offer rows for
       exactly the emailed clients through the existing send path.
   §D  A3 · GI CALL LIST. Derived from the SAME cached rows (0 network),
       gi_status not_discussed on GI-applicable kinds, score order, count
       matches fixture arithmetic; honest empty state when the band is clean.
   §E  A2e · LOG CALL opens the ONE modal (openLogCallModal, own panelId).
   §E2 A1c · QUICK-SETS: protection_status + the GI band's gi_status both
       write through db.from (the audit trigger fires — the newest cases
       audit row diffs the field) and repaint the page.
   §E3 A1c · the per-row Queue-email verb is a HOUSE overlay now (the R76
       natives-go-house rule) — promo-approval wording + R79's held sentence
       verbatim; Cancel queues nothing.
   §F  A1 · SCOPE FORCING. An adviser's RPC rows are their own book (owner
       ∈ {me, null}), their total is their scope, and the header's £ is the
       sum over THEIR rows with the money note saying whose money it is.

   Standing rules obeyed: ground truth from window.__mockDb at runtime, never
   hardcoded; PLAYWRIGHT-AWAIT (poll, never sleep-and-hope alone).

   Run:  node /root/nx/tests/r80_protect.js
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

/* r78_fast's in-page wave instrumentation, verbatim: a request that starts
   while NOTHING is in flight opens a new WAVE; concurrent requests share it.
   40ms of added latency per response keeps dependent reads from ever looking
   parallel. */
const NET_INIT = `
  (() => {
    const NET = { pending: 0, waves: 0, calls: 0, active: false, lat: 40, installed: false };
    window.__net = NET;
    const delay = (res) => new Promise((r) => setTimeout(() => { NET.pending--; r(res); }, NET.lat));
    const note = () => { if (NET.pending === 0) NET.waves++; NET.pending++; NET.calls++; };
    function install(client) {
      if (NET.installed || !client || typeof client.from !== "function") return;
      NET.installed = true;
      try {
        const proto = Object.getPrototypeOf(client.from("clients"));
        const origRun = proto._run;
        proto._run = function () {
          if (!NET.active) return origRun.apply(this, arguments);
          note();
          return origRun.apply(this, arguments).then(delay);
        };
      } catch (e) {}
      try {
        const origRpc = client.rpc.bind(client);
        client.rpc = function () {
          if (!NET.active) return origRpc.apply(null, arguments);
          note();
          return origRpc.apply(null, arguments).then(delay);
        };
      } catch (e) {}
    }
    Object.defineProperty(window, "db", {
      configurable: true,
      get() { return this.__dbReal; },
      set(v) { this.__dbReal = v; install(v); },
    });
  })();
`;

const DESK = { width: 1400, height: 950 };
async function boot(browser, persona, withNet) {
  const ctx = await browser.newContext({ viewport: DESK });
  const page = await ctx.newPage();
  if (withNet) await page.addInitScript(NET_INIT);
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(300);
  return page;
}
async function netSettle(page, quiet = 700, capMs = 20000) {
  const t0 = Date.now();
  let last = -1, lastAt = Date.now();
  for (;;) {
    const { pending, calls } = await page.evaluate(() => ({ pending: window.__net.pending, calls: window.__net.calls }));
    if (calls !== last) { last = calls; lastAt = Date.now(); }
    if (pending === 0 && Date.now() - lastAt >= quiet) return;
    if (Date.now() - t0 > capMs) return;
    await page.waitForTimeout(80);
  }
}
const netReset = (page) => page.evaluate(() => { window.__net.waves = 0; window.__net.calls = 0; window.__net.active = true; });
const netRead = (page) => page.evaluate(() => ({ waves: window.__net.waves, calls: window.__net.calls, pending: window.__net.pending }));
/* PLAYWRIGHT-AWAIT — poll for a DOM condition rather than sleeping and hoping */
async function waitFor(page, fn, arg, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await page.waitForTimeout(120);
  }
}

/* The score formula and est-commission bands, ONCE, in the suite — the same
   arithmetic the mock and the live RPC pin. Recomputed from fixture ground
   truth so nothing here is hardcoded to a fixture's current shape. */
const SCORE_STAGE = { offer: 100, exchange: 95, application: 90, decision_in_principle: 80, fact_find: 70, enquiry: 50, completed: 30 };
const SCORE_WARM = { quoted: 15, referred: 10, discussed: 5 };
const scoreOf = (c, hasEmail) => (SCORE_STAGE[c.stage] || 0) + (SCORE_WARM[c.protection_status || "not_discussed"] || 0)
  + Math.min(Number(c.loan_amount || 0) / 50000, 20) + (hasEmail ? 3 : 0);
const bandOf = (loan) => { const l = Number(loan || 0); return l < 100000 ? 0.7 : l < 250000 ? 1.0 : l < 500000 ? 1.3 : 1.6; };

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  try {
    /* =====================================================================
       §A · A1 — mock RPC parity + ceiling (p4 Daniel, owner)
       ===================================================================== */
    console.log("\n— §A · A1 · get_protection_pipeline = best 250 by score; total RPC uncapped (p4)");
    const page = await boot(browser, "p4", true);
    {
      const seeded = await page.evaluate(() => window.__mock.seedProtectionBook(300));
      ok("A0 · seedProtectionBook seeds 300 candidates", seeded && seeded.cases === 300, JSON.stringify(seeded));

      /* Two hand-planted rows AFTER the 300 (so both sit beyond position 250
         in FIXTURE ORDER — if the cap were still "first 250, no order", the
         hot one could never appear): one that must WIN on score, one that
         must LOSE. */
      const planted = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: hotCl } = await db.from("clients").insert({ first_name: "Zinnia", last_name: "Hotscore", email: "zinnia.hotscore@example.com" }).select("id").single();
        const { data: hotCa } = await db.from("cases").insert({
          client_id: hotCl.id, case_kind: "purchase", stage: "offer", lender: "Halifax",
          loan_amount: 990000, protection_status: "quoted", gi_status: "not_discussed", assigned_to: "p2",
        }).select("id").single();
        const { data: coldCl } = await db.from("clients").insert({ first_name: "Zebedee", last_name: "Coldscore" }).select("id").single();
        const { data: coldCa } = await db.from("cases").insert({
          client_id: coldCl.id, case_kind: "remortgage", stage: "completed", lender: "Skipton",
          loan_amount: 46000, protection_status: "not_discussed", gi_status: "not_applicable", assigned_to: "p3",
        }).select("id").single();
        /* a high-score candidate with NO email — §C's deterministic skip row */
        const { data: nmCl } = await db.from("clients").insert({ first_name: "Yorick", last_name: "Nomail" }).select("id").single();
        const { data: nmCa } = await db.from("cases").insert({
          client_id: nmCl.id, case_kind: "purchase", stage: "offer", lender: "NatWest",
          loan_amount: 620000, protection_status: "discussed", gi_status: "not_discussed", assigned_to: "p3",
        }).select("id").single();
        return { hot: hotCa.id, cold: coldCa.id, nomail: nmCa.id };
      });
      ok("A1 · planted a hot case and a cold case beyond position 250 by fixture order", !!(planted.hot && planted.cold), JSON.stringify(planted));

      /* Ground truth: recompute the score for EVERY candidate from the
         fixture tables and take the top 250 — then the RPC must agree. */
      const gt = await page.evaluate(async () => {
        const db = window.__mockDb;
        const cases = [];
        for (let from = 0; ; from += 500) {
          const { data } = await db.from("cases").select("id,client_id,stage,protection_status,loan_amount,assigned_to").range(from, from + 499);
          if (!data || !data.length) break;
          cases.push(...data);
          if (data.length < 500) break;
        }
        const clients = [];
        for (let from = 0; ; from += 500) {
          const { data } = await db.from("clients").select("id,email").range(from, from + 499);
          if (!data || !data.length) break;
          clients.push(...data);
          if (data.length < 500) break;
        }
        const emailOf = {};
        clients.forEach((c) => { emailOf[c.id] = !!c.email; });
        const { data: avgRow } = await db.from("settings").select("value").eq("key", "protection_avg_commission").maybeSingle();
        const pipe = await db.rpc("get_protection_pipeline", { p_scope: "all" });
        const tot = await db.rpc("get_protection_pipeline_total", { p_scope: "all" });
        return { cases, emailOf, avg: Number((avgRow || {}).value) || 850, rows: pipe.data || [], pipeErr: pipe.error, total: tot.data, totErr: tot.error };
      });
      ok("A2 · both RPCs answer without error", !gt.pipeErr && !gt.totErr, JSON.stringify([gt.pipeErr, gt.totErr]));

      const OPEN = ["not_discussed", "discussed", "quoted", "referred"];
      const candidates = gt.cases.filter((c) => c.stage !== "not_proceeding" && OPEN.includes(c.protection_status || "not_discussed"));
      const scored = candidates.map((c) => ({ id: c.id, s: scoreOf(c, gt.emailOf[c.client_id]), loan: c.loan_amount }))
        .sort((a, b) => (b.s - a.s) || (a.id < b.id ? -1 : 1));
      /* the cap CANARY: the mock exposes its cap so this arithmetic follows the contract
         instead of hardcoding 250 in a second place that could drift */
      const CAP = await page.evaluate(() => window.__mock.protPipeCap);
      eq("A3a · the mock exposes the cap canary (window.__mock.protPipeCap = 250)", CAP, 250);
      ok("A3 · the ceiling bites: candidates > cap", candidates.length > CAP, String(candidates.length));
      eq("A4 · the RPC returns exactly cap rows", gt.rows.length, CAP);
      eq("A5 · get_protection_pipeline_total reports the uncapped count", gt.total, { total: candidates.length });

      const wantIds = new Set(scored.slice(0, CAP).map((x) => x.id));
      const gotIds = new Set(gt.rows.map((r) => r.case_id));
      const missing = [...wantIds].filter((id) => !gotIds.has(id));
      const extra = [...gotIds].filter((id) => !wantIds.has(id));
      ok("A6 · the 250 are EXACTLY the top 250 by the pinned score formula (recomputed from fixtures)",
        missing.length === 0 && extra.length === 0, `missing ${missing.slice(0, 3)} extra ${extra.slice(0, 3)}`);
      const dropped = scored.slice(CAP).map((x) => x.id);
      ok("A6b · …and what fell off is exactly the LOWEST-scored tail, every one of them absent",
        dropped.length === candidates.length - CAP && dropped.every((id) => !gotIds.has(id)), String(dropped.length));
      const sortedDesc = gt.rows.every((r, i) => i === 0 || Number(gt.rows[i - 1].score) >= Number(r.score));
      ok("A7 · rows come back score-descending, score column present on every row", sortedDesc && gt.rows.every((r) => r.score != null), "");
      ok("A8 · the hot case planted beyond position 250 by fixture order IS returned (best, not arbitrary)",
        gotIds.has(planted.hot), planted.hot);
      ok("A9 · the low-score case beyond the cap is NOT returned", !gotIds.has(planted.cold), planted.cold);
      const cutoff = scored[CAP - 1].s;
      const coldScore = scored.find((x) => x.id === planted.cold);
      ok("A9b · …and for the honest reason: its score is below the 250th's", coldScore && coldScore.s < cutoff, JSON.stringify({ cold: coldScore && coldScore.s, cutoff }));

      const estBad = gt.rows.filter((r) => r.est_commission !== Math.round(gt.avg * bandOf(r.loan_amount)));
      ok("A10 · est_commission = protection_avg_commission × loan band (0.7/1.0/1.3/1.6) on every row", estBad.length === 0, JSON.stringify(estBad.slice(0, 2)));
      const SHAPE = ["case_id", "client_id", "client_name", "has_email", "stage", "case_kind", "lender", "loan_amount", "protection_status", "gi_status", "live", "owner", "est_commission", "score"];
      const shapeOk = gt.rows.length && SHAPE.every((k) => Object.prototype.hasOwnProperty.call(gt.rows[0], k));
      ok("A11 · row shape unchanged + score (all 14 columns present)", shapeOk, JSON.stringify(Object.keys(gt.rows[0] || {})));

      /* =====================================================================
         §B · A2/A4 — page honesty + wave/keystroke discipline (same page)
         ===================================================================== */
      console.log("\n— §B · A2/A4 · header truth, RPC rank order, ≤2 waves, 0-network search (p4)");
      ok("B0 · wave instrumentation installed", await page.evaluate(() => window.__net.installed === true));
      await netReset(page);
      await page.evaluate(() => window.nav("protection"));
      await netSettle(page);
      const load = await netRead(page);
      console.log(`    · protection load: ${load.waves} waves, ${load.calls} calls`);
      ok(`B1 · protection page load ≤ 2 serial waves (was 4) — measured ${load.waves}`, load.waves > 0 && load.waves <= 2, JSON.stringify(load));
      await page.evaluate(() => { window.__net.active = false; });

      await page.click("#prot-scope-all");
      await page.waitForTimeout(600);
      const estSum = gt.rows.reduce((s, r) => s + Number(r.est_commission || 0), 0);
      const header = await page.evaluate(() => ({
        cap: (document.querySelector("#prot-cap-line") || {}).textContent || "",
        capTitle: (document.querySelector("#prot-cap-line") || {}).title || "",
      }));
      const m = header.cap.match(/best (\d+) of ([\d,]+) opportunities/);
      ok("B2 · header states the ceiling: “Showing the best 250 of <total> opportunities”",
        !!m && Number(m[1]) === CAP && Number(m[2].replace(/,/g, "")) === candidates.length, JSON.stringify(header.cap));
      const wantMoney = await page.evaluate((n) => { try { return fmtM(n); } catch (e) { return null; } }, estSum);
      ok("B3 · …and the ~£ sum matches fixture arithmetic (Σ est_commission over the returned rows)",
        wantMoney && header.cap.includes(`(~${wantMoney} estimated commission on this page)`), JSON.stringify({ wantMoney, cap: header.cap }));
      ok("B4 · the score is explained in words on the header line's tooltip", /stage urgency|Offer 100/i.test(header.capTitle), header.capTitle.slice(0, 80));

      const order = await page.evaluate(() => [...document.querySelectorAll("#prot-list-table .prot-cb")].map((cb) => cb.dataset.id));
      const rpcOrder = gt.rows.map((r) => r.case_id);
      ok("B5 · rank order preserved from the RPC (score desc) — R61 status bands retired",
        order.length === CAP && order.every((id, i) => id === rpcOrder[i])
        && (await page.evaluate(() => document.querySelectorAll("tr.prot-band").length)) === 0,
        JSON.stringify({ n: order.length, first: order[0], wantFirst: rpcOrder[0] }));
      const rankTitle = await page.evaluate(() => (document.querySelector("#prot-list-table td.prot-col-n") || {}).title || "");
      ok("B6 · the # cell's tooltip explains the row's score, not a bare number",
        /#1 — score [\d.]+:/.test(rankTitle) && /stage \d+/.test(rankTitle), rankTitle.slice(0, 90));
      ok("B6b · the hot planted case ranks FIRST on the page", order[0] === planted.hot, JSON.stringify({ got: order[0], want: planted.hot }));

      /* keystroke discipline: search, status filter, scope — all 0 network */
      await netReset(page);
      await page.fill("#prot-search", "zinnia");
      await page.waitForTimeout(700);   // past the 250ms debounce
      const searchNet = await netRead(page);
      const searchRows = await page.evaluate(() => document.querySelectorAll("#prot-list-table tr.prot-row").length);
      eq("B7 · a search keystroke performs ZERO network calls (session cache)", searchNet.calls, 0);
      ok("B7b · …and the search actually narrowed the table", searchRows === 1, String(searchRows));
      await page.fill("#prot-search", "");
      await page.waitForTimeout(500);
      await page.selectOption("#prot-filter", "quoted");
      await page.waitForTimeout(400);
      await page.click("#prot-scope-mine");
      await page.waitForTimeout(400);
      const filterNet = await netRead(page);
      eq("B8 · status filter + scope clicks are 0 network too", filterNet.calls, 0);
      await page.selectOption("#prot-filter", "all");
      await page.click("#prot-scope-all");
      await page.waitForTimeout(400);
      await page.evaluate(() => { window.__net.active = false; });

      /* the choke point busts the cache: one ordinary cases write → refetch */
      await page.evaluate(async (id) => { await window.__mockDb.from("cases").update({ loan_amount: 991000 }).eq("id", id); }, planted.hot);
      await netReset(page);
      await page.evaluate(() => loadProtectionPage());
      await netSettle(page);
      const rel = await netRead(page);
      ok("B9 · ONE cases write through the choke point busts the cache — the next load refetches (>0 calls, still ≤2 waves)",
        rel.calls > 0 && rel.waves <= 2, JSON.stringify(rel));
      await page.evaluate(() => { window.__net.active = false; });
      await page.waitForTimeout(300);

      /* =====================================================================
         §C · A2f — bulk "Queue protection intro to N" (same page)
         ===================================================================== */
      console.log("\n— §C · A2f · bulk queue respects held wording + skips no-email rows, counted (p4)");
      const pick = await page.evaluate((nomailId) => {
        const rows = [...document.querySelectorAll("#prot-list-table tr.prot-row")];
        const withEmail = [], noEmail = [];
        rows.forEach((tr) => {
          const id = tr.querySelector(".prot-cb").dataset.id;
          if (tr.querySelector(".prot-actions .badge.grey")) noEmail.push(id); else withEmail.push(id);
        });
        // the planted no-email case is deterministic; any other no-email row would also do
        return { withEmail: withEmail.slice(0, 3), noEmail: noEmail.includes(nomailId) ? [nomailId] : noEmail.slice(0, 1) };
      }, planted.nomail);
      ok("C0 · found 3 emailed rows + 1 no-email row to select", pick.withEmail.length === 3 && pick.noEmail.length === 1, JSON.stringify(pick));
      const qBefore = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id", { count: "exact", head: true }).eq("email_type", "protection_offer")).count);
      for (const id of [...pick.withEmail, ...pick.noEmail]) await page.check(`#prot-list-table .prot-cb[data-id="${id}"]`);
      const holdOn = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("value").eq("key", "email_hold").maybeSingle();
        return String((data || {}).value ?? "on").trim().toLowerCase() !== "off";
      });
      /* PATCHED R82 · A1 — NEW PRECONDITION, deliberate contract change: bulkQueueProtIntro now
         refuses outright while financial_promotions_approved is off (the fixture default), because
         a protection intro is a regulated financial promotion. R82's own suite pins the refusal;
         this section is about the overlay's counts and skips, so it states the precondition and
         gets on with it. */
      await page.evaluate(async () => {
        const rows = window.__mock.db.settings;
        const row = rows.filter((r) => r.key === "financial_promotions_approved")[0];
        if (row) row.value = "on"; else rows.push({ key: "financial_promotions_approved", value: "on" });
        await window.__reloadSettings();
      });
      await page.click("#prot-bulk-intro");
      const ov = await waitFor(page, () => {
        const box = document.querySelector("#prot-bulk-intro-box");
        return box ? {
          text: box.textContent.replace(/\s+/g, " ").trim(),
          held: !!box.querySelector("#prot-bulk-intro-held"),
          heldText: (box.querySelector("#prot-bulk-intro-held") || {}).textContent || "",
          skips: (box.querySelector("#prot-bulk-intro-skips") || {}).textContent || "",
          goLabel: (box.querySelector("#prot-bulk-intro-go") || {}).textContent || "",
        } : null;
      });
      ok("C1 · a house overlay opens, named “Queue protection intro to 3 clients?”", !!ov && /Queue protection intro to 3 clients\?/.test(ov.text), ov && ov.text.slice(0, 90));
      ok("C2 · held honesty, R79's exact sentence, present iff the hold is on",
        !!ov && (ov.held === holdOn) && (!holdOn || /Sending is currently ON HOLD \(Settings › Email sending\) — this will queue and wait; nothing is sent now\./.test(ov.heldText)),
        JSON.stringify({ holdOn, heldText: ov && ov.heldText }));
      ok("C3 · the skip is stated with count AND reason before anything queues",
        !!ov && /1 of the 4 selected cases are skipped/.test(ov.skips) && /no email address on file/.test(ov.skips), ov && ov.skips);
      ok("C4 · the confirm button names the real count", !!ov && /Queue 3 emails/.test(ov.goLabel), ov && ov.goLabel);
      await page.click("#prot-bulk-intro-go");
      await page.waitForTimeout(2500);
      const qAfter = await page.evaluate(async (p) => {
        const { data } = await window.__mockDb.from("email_queue").select("id,case_id,client_id,email_type,to_email").eq("email_type", "protection_offer").order("created_at", { ascending: false }).limit(10);
        return (data || []).filter((r) => p.withEmail.includes(r.case_id) || p.noEmail.includes(r.case_id));
      }, pick);
      ok("C5 · exactly the 3 emailed clients got a protection_offer queue row; the no-email case got NONE",
        qAfter.length === 3 && qAfter.every((r) => pick.withEmail.includes(r.case_id) && r.to_email), JSON.stringify(qAfter.map((r) => r.case_id)));
      const qCount = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id", { count: "exact", head: true }).eq("email_type", "protection_offer")).count);
      eq("C6 · net new protection_offer rows = 3", qCount - qBefore, 3);
      /* held honesty at bulk scale: the fixture hold is ON (the state production lives in), so
         the scoped run must send NOTHING and every row must STAY queued. */
      ok("C6b · the email hold is ON in this suite (the fixture default — nothing turned it off)", holdOn === true, String(holdOn));
      const heldState = await page.evaluate(async (p) => {
        const { data } = await window.__mockDb.from("email_queue").select("case_id,status").eq("email_type", "protection_offer");
        return [...new Set((data || []).filter((r) => p.withEmail.includes(r.case_id)).map((r) => r.status))];
      }, pick);
      eq("C6c · held = STAYS QUEUED: every bulk-queued row's status is 'queued' (nothing sent under the hold)", heldState, ["queued"]);
      const selCleared = await waitFor(page, () => {
        const bar = document.querySelector("#prot-bulk-bar");
        return bar && bar.hidden ? true : null;
      });
      ok("C7 · the selection is cleared after the run", !!selCleared, "");

      /* =====================================================================
         §D · A3 — the GI call list, from the cached rows (same page)
         ===================================================================== */
      console.log("\n— §D · A3 · GI band from the SAME cached rows, ranked, honest when clean (p4)");
      await page.evaluate(() => { window.__bustProtCache(); return loadProtectionPage(); });
      await page.waitForTimeout(1500);
      await page.click("#prot-scope-all");
      await page.waitForTimeout(500);
      const giGt = await page.evaluate(async () => {
        const { data } = await window.__mockDb.rpc("get_protection_pipeline", { p_scope: "all" });
        const GI_KINDS = ["purchase", "first_time_buyer", "buy_to_let", "remortgage"];
        const want = (data || []).filter((r) => GI_KINDS.includes(r.case_kind) && (r.gi_status || "not_discussed") === "not_discussed");
        return {
          wantCount: want.length, firstName: (want[0] || {}).client_name,
          count: Number(document.querySelector("#prot-gi-count").textContent),
          items: document.querySelectorAll("#prot-gi-list .row-item").length,
          firstShown: (document.querySelector("#prot-gi-list .row-item .t") || {}).textContent || "",
          basis: (document.querySelector("#prot-gi-basis") || {}).textContent || "",
          hidden: document.querySelector("#prot-gi-panel").classList.contains("hidden"),
        };
      });
      ok("D1 · the GI band renders with the fixture-true count (gi not_discussed · GI-applicable kind, within the pipeline)",
        !giGt.hidden && giGt.count === giGt.wantCount && giGt.wantCount > 0, JSON.stringify(giGt));
      ok("D2 · capped at 25 visible rows, in the pipeline's own score order (best first)",
        giGt.items === Math.min(25, giGt.wantCount) && giGt.firstShown === giGt.firstName, JSON.stringify({ shown: giGt.firstShown, want: giGt.firstName }));
      ok("D3 · the basis says it costs no extra network and names the cap when it bites",
        /no extra reads/.test(giGt.basis) && /best-250/.test(giGt.basis), giGt.basis.slice(0, 140));
      const giRowVerb = await page.evaluate(() => {
        const row = document.querySelector("#prot-gi-list .row-item");
        return row ? [...row.querySelectorAll("button")].map((b) => b.textContent.trim()) : [];
      });
      ok("D4 · each GI row carries the Log-call verb", giRowVerb.some((t) => /Log call/.test(t)), JSON.stringify(giRowVerb));
      const giEmpty = await page.evaluate(() => {
        renderProtGiBand([], false);   // the renderer, fed a clean book
        const t = (document.querySelector("#prot-gi-list .empty") || {}).textContent || "";
        return t;
      });
      ok("D5 · honest empty state when the band is clean", /Every GI-applicable case in this scope has its GI conversation recorded/.test(giEmpty), giEmpty);
      await page.evaluate(() => loadProtectionPage());   // repaint the real state
      await page.waitForTimeout(600);

      /* =====================================================================
         §E · A2e — Log call opens the ONE modal (same page)
         ===================================================================== */
      console.log("\n— §E · A2e · 📞 Log call opens the ONE openLogCallModal overlay (p4)");
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("#prot-list-table .prot-actions button")]
          .find((b) => /Log a call/.test(b.getAttribute("aria-label") || "") || /Log call/.test(b.textContent));
        btn.click();
      });
      const modal = await waitFor(page, () => {
        const panel = document.querySelector("#prot-logcall-panel");
        if (!panel) return null;
        const ovl = panel.closest("#overlay-modal") || panel.closest(".modal");
        return {
          panelId: panel.id,
          title: (document.querySelector("#overlay-modal h3") || {}).textContent || "",
          sharedMarkup: !!panel.querySelector("#cs-call-note") && !!panel.querySelector("#cs-call-save"),
          inOverlay: !!ovl,
        };
      });
      ok("E1 · the row's Log call opens openLogCallModal — same overlay, own panelId (#prot-logcall-panel)",
        !!modal && modal.panelId === "prot-logcall-panel" && modal.inOverlay, JSON.stringify(modal));
      ok("E2 · same titled presentation (“📞 Log a call — <name>”) and the SHARED panel markup (#cs-call-note / #cs-call-save)",
        !!modal && /^📞 Log a call — .+/.test(modal.title) && modal.sharedMarkup, modal && modal.title);
      await page.evaluate(() => { const c = document.querySelector("#cs-call-cancel"); if (c) c.click(); });
      await page.waitForTimeout(400);

      /* =====================================================================
         §E2 · A1c — the quick-sets WRITE (db.from → audit trigger) and repaint
         ===================================================================== */
      console.log("\n— §E2 · A1c · status quick-sets write through db.from, repaint, and leave an AUDIT row (p4)");
      const qsTarget = await page.evaluate(() => {
        const tr = [...document.querySelectorAll("#prot-list-table tr.prot-row")]
          .find((r) => { const b = r.querySelector(".prot-col-status .badge"); return b && b.textContent.trim() === "NOT DISCUSSED" && r.querySelector(".prot-status-set"); });
        return tr ? tr.querySelector(".prot-cb").dataset.id : null;
      });
      ok("E4 · found a NOT DISCUSSED row to quick-set", !!qsTarget, String(qsTarget));
      await page.evaluate((id) => {
        const sel = [...document.querySelectorAll("#prot-list-table tr.prot-row")]
          .find((r) => r.querySelector(`.prot-cb[data-id="${id}"]`)).querySelector(".prot-status-set");
        sel.value = "discussed";
        sel.dispatchEvent(new Event("change"));
      }, qsTarget);
      const repainted = await waitFor(page, (id) => {
        const tr = [...document.querySelectorAll("#prot-list-table tr.prot-row")]
          .find((r) => r.querySelector(`.prot-cb[data-id="${id}"]`));
        const b = tr && tr.querySelector(".prot-col-status .badge");
        return b && b.textContent.trim() === "DISCUSSED" ? true : null;
      }, qsTarget);
      ok("E5 · the write repaints the page — the row's badge now reads DISCUSSED", !!repainted, "");
      const qsProof = await page.evaluate(async (id) => {
        const db = window.__mockDb;
        const { data: c } = await db.from("cases").select("protection_status").eq("id", id).single();
        const { data: aud } = await db.from("audit_log").select("table_name,action,changes")
          .eq("row_id", id).eq("table_name", "cases").order("happened_at", { ascending: false }).limit(1);
        return { status: c && c.protection_status, aud: (aud || [])[0] || null };
      }, qsTarget);
      eq("E6 · cases.protection_status was written", qsProof.status, "discussed");
      ok("E7 · …through db.from, so the AUDIT trigger fired (newest cases audit row diffs protection_status → discussed)",
        !!qsProof.aud && qsProof.aud.action === "update" && JSON.stringify(qsProof.aud.changes || {}).includes('"protection_status"')
        && JSON.stringify(qsProof.aud.changes || {}).includes('"discussed"'), JSON.stringify(qsProof.aud));

      /* the GI band's own quick-set: closes the row out of the band, audited the same way */
      const giTarget = await page.evaluate(() => {
        const btn = document.querySelector("#prot-gi-list .row-item button[onclick^=\"protLogCall\"]");
        return btn ? (btn.getAttribute("onclick").match(/'([^']+)'/) || [])[1] : null;
      });
      ok("E8 · found a GI-band row to quick-set", !!giTarget, String(giTarget));
      await page.evaluate((id) => {
        const sel = [...document.querySelectorAll("#prot-gi-list .row-item .prot-gi-set")]
          .find((s) => (s.getAttribute("onchange") || "").includes(id));
        sel.value = "not_applicable";
        sel.dispatchEvent(new Event("change"));
      }, giTarget);
      const giGone = await waitFor(page, (id) => {
        const still = [...document.querySelectorAll("#prot-gi-list .row-item .prot-gi-set")]
          .some((s) => (s.getAttribute("onchange") || "").includes(id));
        return still ? null : true;
      }, giTarget);
      const giProof = await page.evaluate(async (id) => {
        const db = window.__mockDb;
        const { data: c } = await db.from("cases").select("gi_status").eq("id", id).single();
        const { data: aud } = await db.from("audit_log").select("action,changes")
          .eq("row_id", id).eq("table_name", "cases").order("happened_at", { ascending: false }).limit(1);
        return { gi: c && c.gi_status, aud: (aud || [])[0] || null };
      }, giTarget);
      ok("E9 · the GI quick-set writes gi_status, the row leaves the band on the repaint, and the audit row diffs it",
        !!giGone && giProof.gi === "not_applicable"
        && !!giProof.aud && JSON.stringify(giProof.aud.changes || {}).includes('"gi_status"'), JSON.stringify(giProof));

      /* the row's own Email verb: the native confirm is GONE — a house overlay carries the
         promo-approval wording and (hold on) R79's held sentence; Cancel queues nothing. */
      console.log("\n— §E3 · A1c · per-row Queue-email verb = house overlay, held-honest, cancellable (p4)");
      const dialogsBefore = page.__dialogs.length;
      const qRowsBefore = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id", { count: "exact", head: true }).eq("email_type", "protection_offer")).count);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("#prot-list-table .prot-actions button")].find((b) => b.textContent.trim() === "Email");
        btn.click();
      });
      const emailOv = await waitFor(page, () => {
        const body = document.querySelector("#ovl-confirm-body");
        if (!body) return null;
        return {
          title: (document.querySelector("#ovl-confirm-title") || {}).textContent || "",
          body: body.textContent.replace(/\s+/g, " ").trim(),
          okLabel: (document.querySelector("#ovl-confirm-ok") || {}).textContent || "",
        };
      });
      ok("E10 · the Email verb opens the HOUSE overlay (#ovl-confirm-*), not a native confirm",
        !!emailOv && page.__dialogs.length === dialogsBefore, JSON.stringify(emailOv));
      ok("E11 · …keeping the promo-approval wording and R79's held sentence, word for word",
        !!emailOv && /Queue the protection intro email\?/.test(emailOv.title)
        && /Ensure the template has principal approval\./.test(emailOv.body)
        && emailOv.body.includes("Sending is currently ON HOLD (Settings › Email sending) — this will queue and wait; nothing is sent now."),
        emailOv && (emailOv.title + " | " + emailOv.body));
      await page.click("#ovl-confirm-cancel");
      await page.waitForTimeout(500);
      const qRowsAfter = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id", { count: "exact", head: true }).eq("email_type", "protection_offer")).count);
      eq("E12 · Cancel queues nothing", qRowsAfter - qRowsBefore, 0);

      const errs = (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|favicon/i.test(e));
      eq("E3 · zero page errors across §A–§E", errs, []);
      await page.context().close();
    }

    /* =====================================================================
       §F · A1 — scope forcing for an adviser (p2 Wayne)
       ===================================================================== */
    console.log("\n— §F · A1 · non-admin callers are forced to p_scope='mine' (p2)");
    {
      const p2 = await boot(browser, "p2", false);
      await p2.evaluate(() => window.__mock.seedProtectionBook(300));
      const adv = await p2.evaluate(async () => {
        const db = window.__mockDb;
        const pipe = await db.rpc("get_protection_pipeline", { p_scope: "all" });   // asks for all…
        const tot = await db.rpc("get_protection_pipeline_total", { p_scope: "all" });
        const rows = pipe.data || [];
        return { n: rows.length, owners: [...new Set(rows.map((r) => r.owner))], total: tot.data };
      });
      ok("F1 · an adviser asking for 'all' gets ONLY their own book back (owner ∈ {me, null} — T1-5's ownerless quirk kept)",
        adv.n > 0 && adv.owners.every((o) => o === "p2" || o == null), JSON.stringify(adv.owners));
      const mineCount = await p2.evaluate(async () => {
        const db = window.__mockDb;
        const cases = [];
        for (let from = 0; ; from += 500) {
          const { data } = await db.from("cases").select("id,stage,protection_status,assigned_to").range(from, from + 499);
          if (!data || !data.length) break;
          cases.push(...data);
          if (data.length < 500) break;
        }
        const OPEN = ["not_discussed", "discussed", "quoted", "referred"];
        return cases.filter((c) => c.stage !== "not_proceeding" && OPEN.includes(c.protection_status || "not_discussed")
          && (c.assigned_to === "p2" || c.assigned_to == null)).length;
      });
      eq("F2 · the total RPC reports the adviser's OWN uncapped candidate count", adv.total, { total: mineCount });
      await p2.evaluate(() => window.nav("protection"));
      await p2.waitForTimeout(2500);
      const advView = await p2.evaluate(async () => {
        const { data } = await window.__mockDb.rpc("get_protection_pipeline", { p_scope: "all" });
        const sum = (data || []).reduce((s, r) => s + Number(r.est_commission || 0), 0);
        return {
          cap: (document.querySelector("#prot-cap-line") || {}).textContent || "",
          wantMoney: (() => { try { return fmtM(sum); } catch (e) { return null; } })(),
          note: (document.querySelector("#prot-money-note") || {}).textContent || "",
          noteHidden: document.querySelector("#prot-money-note").classList.contains("hidden"),
        };
      });
      ok("F3 · the adviser's header £ is the sum over THEIR rows (their scope, per the RPC's own rule)",
        advView.wantMoney && advView.cap.includes(advView.wantMoney), JSON.stringify({ want: advView.wantMoney, cap: advView.cap.slice(0, 140) }));
      ok("F4 · the money note says whose money the header figure is (yours, not the firm's)",
        !advView.noteHidden && /YOURS/i.test(advView.note) && /scoped server-side/.test(advView.note), advView.note.slice(0, 140));
      await p2.context().close();
    }
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) { try { srv.kill(); } catch (_) {} } }
  }

  console.log(`\nr80_protect: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  FAIL: " + f)); process.exit(1); }
})();
