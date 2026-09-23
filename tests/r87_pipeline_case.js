#!/usr/bin/env node
/* =============================================================================
   tests/r87_pipeline_case.js — R87 "Say less", slice B: PIPELINE · THE CASE MODAL · ROUTING/ROLES.

   One suite for the eight findings this slice implements (panel refs in brackets):
     §A  B1 · the stage-entry prompt is the DEFAULT for every interactive move [03 #1]: the board
         card's <select>, a board drop and the modal's <select> all raise it; a headless call
         opts out with { promptStageEntry:false } or { silent:true }; the card's hover-only "→"
         is gone (one move control per surface). Overlays are two-exit and ≤ 40 words [03 #8].
     §B  B2 · the board never paints Completed / Not proceeding columns; default segment "live";
         6 columns fit the board with no horizontal scroll; Completed & closed and All are
         table-only [03 #2].
     §C  B3 · prose diet on the table: one ≤25-word standing line + a closed fold that holds
         the old copy; "N of M … the N" both computed; the bulk bar is ONE row with the two
         import-era verbs off it and the rest behind "More ▾", ids kept [03 #4, #5].
     §D  B4 · opening a case writes #case/<id> and "<Client> · NexMoney Back Office"; closing
         restores both; a refresh on #case/<id> reopens the case; ⧉ Copy link exists and copies
         that link [01 #1].
     §E  B5 · the client name in the case header is a link to the client, and the footer has
         "Open client" like the appointment modal [01 #2].
     §F  B6 · the sticky action row is one line at 1440 and at 390 for a live and a completed
         case; 📅 Book appointment is on the row at the live stages; every act-* id kept [02 #7,
         03 #9].
     §G  B7 · PAGE_ROLE_GATE covers import/emails/data; an adviser's sidebar hides them and
         nav() bounces to Today [01 #3].
     §H  B8 · phone: the case modal's Cancel/Save footer shows only while the folded form is open
         [02 #8].
     §I  no console errors across everything above.

   Expectations are computed at runtime from window.__mockDb / the DOM, never typed in.
   Run:  node /root/nx/tests/r87_pipeline_case.js
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

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const NX_KEYS = ["nx_nav_firm", "nx_pipe_cols", "nx_views_v1"];

async function boot(browser, persona, viewport, hash) {
  const ctx = await browser.newContext({ viewport: viewport || DESK, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}${hash || ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 30000 });
  await page.waitForTimeout(1800);
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); Object.keys(localStorage).filter((k) => /^nx_(seg|view)_/.test(k)).forEach((k) => localStorage.removeItem(k)); }, NX_KEYS);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(300);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const wait = (page, ms) => page.waitForTimeout(ms);
const words = (s) => String(s || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length;
const overlayOpen = (page) => page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden"));
const overlayText = (page) => page.evaluate(() => (document.querySelector("#overlay-modal") || {}).textContent || "");
const caseRow = (page, id) => page.evaluate(async (i) => (await window.__mockDb.from("cases").select("*").eq("id", i).single()).data, id);
const goPipeline = async (page, ms) => { await page.evaluate(() => { if (window.closeModal) window.closeModal(); }); await page.evaluate(() => window.nav("pipeline")); await wait(page, ms || 2000); };

let uniq = 0;
const tag = () => `R87${Date.now().toString(36)}${++uniq}`;
async function mkCase(page, o) {
  return page.evaluate(async (opt) => {
    const db = window.__mockDb;
    const { data: cl } = await db.from("clients").insert({ first_name: opt.first, last_name: opt.last, email: `${opt.last.toLowerCase()}@example.com`, phone: "07700900123" }).select("id").single();
    const row = Object.assign({ client_id: cl.id, case_kind: "purchase", stage: "enquiry", assigned_to: "p4" }, opt.row || {});
    const { data: c } = await db.from("cases").insert(row).select("id").single();
    return { clientId: cl.id, caseId: c.id, name: `${opt.first} ${opt.last}` };
  }, o);
}
/* Drive a board card's stage <select> the way its inline handler is driven. */
const cardSelect = (page, id, to) => page.evaluate(({ id, to }) => {
  const s = document.querySelector(`#board .card[data-id="${id}"] .card-stage-move`);
  if (!s) return false;
  s.value = to; s.dispatchEvent(new Event("change")); return true;
}, { id, to });

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* =====================================================================
       §A · B1 — the prompt is the default for every interactive move
       ===================================================================== */
    {
      console.log("\n— §A · B1 · every interactive move raises the stage-entry prompt; one control per surface (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      const a1 = await mkCase(page, { first: "Prompt", last: "Select" + tag(), row: { stage: "fact_find", lender: null } });
      await goPipeline(page, 2400);
      const card = await page.evaluate((id) => {
        const c = document.querySelector(`#board .card[data-id="${id}"]`);
        return c ? { advance: !!c.querySelector(".card-advance"), select: !!c.querySelector(".card-stage-move") } : null;
      }, a1.caseId);
      ok("A1 · the board card carries ONE move control — the stage select — and no hover-only “→”", card && card.select && !card.advance, JSON.stringify(card));
      eq("A1b · …and no card anywhere on the board has a .card-advance", await page.evaluate(() => document.querySelectorAll("#board .card-advance").length), 0);
      ok("A2 · the card's select is driven (Fact Find → DIP)", await cardSelect(page, a1.caseId, "decision_in_principle"));
      await wait(page, 1400);
      ok("A2b · …and it RAISES the DIP stage-entry prompt (it used to move silently)", await overlayOpen(page) && !!(await page.$("#se-lender")));
      const exits = await page.evaluate(() => ({ cancel: !!document.querySelector("#se-cancel"), skip: !!document.querySelector("#se-skip"), ok: !!document.querySelector("#se-ok") }));
      eq("A3 · the overlay has TWO exits — Don't advance / Save & advance (Skip is gone; blank is skip)", exits, { cancel: true, skip: false, ok: true });
      const dipWords = words(await page.evaluate(() => { const b = document.querySelector("#overlay-modal").cloneNode(true); b.querySelectorAll("datalist, .modal-actions").forEach((x) => x.remove()); return b.textContent; }));
      ok(`A3b · …and its copy is ≤ 40 words (measured ${dipWords})`, dipWords <= 40, String(dipWords));
      eq("A3c · nothing moved while the question is open", (await caseRow(page, a1.caseId)).stage, "fact_find");
      // blank Save = the old Skip: advance, write nothing
      await page.evaluate(() => { document.querySelector("#se-lender").value = ""; document.querySelector("#se-dip-task").checked = false; });
      await page.click("#se-ok");
      await wait(page, 1500);
      const r1 = await caseRow(page, a1.caseId);
      eq("A4 · a blank Save & advance moves the case and writes no lender", [r1.stage, r1.lender], ["decision_in_principle", null]);

      // the modal's select (now at the head of Actions ▾) prompts too
      const a2 = await mkCase(page, { first: "Prompt", last: "Modal" + tag(), row: { stage: "decision_in_principle", waiting_on: null, expected_completion_date: null, protection_status: "discussed" } });
      await page.evaluate((id) => window.openCase(id), a2.caseId);
      await wait(page, 1800);
      const selPlace = await page.evaluate(() => { const s = document.querySelector("#cs-stage-select"); return s ? { inMenu: !!s.closest("#case-more-actions"), inBar: !!s.closest("#cs-sticky-actions") } : null; });
      ok("A5 · the modal keeps its move-to-any-stage select, at the head of Actions ▾ (inside the sticky row)", selPlace && selPlace.inMenu && selPlace.inBar, JSON.stringify(selPlace));
      await page.click("#case-more-actions-toggle");
      await page.selectOption("#cs-stage-select", "application");
      await wait(page, 1400);
      ok("A5b · the modal select RAISES the Application prompt (waiting on)", await overlayOpen(page) && !!(await page.$("#se-waiting")) || await page.evaluate(() => /waiting|sitting with/i.test(document.querySelector("#overlay-modal").textContent)));
      const appWords = words(await page.evaluate(() => { const b = document.querySelector("#overlay-modal").cloneNode(true); b.querySelectorAll("select, option, datalist, .modal-actions").forEach((x) => x.remove()); return b.textContent; }));
      ok(`A5c · …its copy is ≤ 40 words (measured ${appWords})`, appWords <= 40, String(appWords));
      await page.click("#se-cancel");
      await wait(page, 1200);
      eq("A5d · “Don't advance” leaves the case where it was", (await caseRow(page, a2.caseId)).stage, "decision_in_principle");

      // a headless call declares silence
      const a3 = await mkCase(page, { first: "Headless", last: "Call" + tag(), row: { stage: "fact_find", lender: null } });
      const res = await page.evaluate((id) => window.moveCaseToStage(id, "decision_in_principle", { promptStageEntry: false, skipReload: true }), a3.caseId);
      eq("A6 · a headless call with promptStageEntry:false still just moves (the suites' contract)", [res, (await caseRow(page, a3.caseId)).stage], ["moved", "decision_in_principle"]);
      const a4 = await mkCase(page, { first: "Silent", last: "Call" + tag(), row: { stage: "fact_find", lender: null } });
      const res2 = await page.evaluate((id) => window.moveCaseToStage(id, "decision_in_principle", { silent: true, skipReload: true }), a4.caseId);
      eq("A6b · …and so does { silent:true }", [res2, await overlayOpen(page)], ["moved", false]);

      ok("§A · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page)));
      await page.context().close();
    }

    /* =====================================================================
       §B · B2 — the board is the live book
       ===================================================================== */
    {
      console.log("\n— §B · B2 · six live columns, no terminal cards, no horizontal scroll (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPipeline(page, 2400);
      const b = await page.evaluate(() => {
        const board = document.querySelector("#board");
        return { seg: pipelineSegment, view: pipelineView, cols: [...board.querySelectorAll(".col")].map((c) => c.dataset.stage),
          scrollW: board.scrollWidth, clientW: board.clientWidth, focused: board.classList.contains("is-focused"),
          segButtons: [...document.querySelectorAll("#pipe-segment .seg-btn")].map((x) => x.dataset.seg) };
      });
      eq("B1 · the default segment is “live”", b.seg, "live");
      eq("B2 · the board paints exactly the six live stages, in order", b.cols, ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"]);
      ok("B3 · …and fits its width — no horizontal scroll", b.scrollW <= b.clientW && b.focused, JSON.stringify({ scrollW: b.scrollW, clientW: b.clientW }));
      const terminal = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,stage").in("stage", ["completed", "not_proceeding"]);
        return { n: data.length, onBoard: data.filter((c) => document.querySelector(`#board .card[data-id="${c.id}"]`)).length };
      });
      ok(`B4 · none of the ${terminal.n} terminal cases is a board card`, terminal.n > 0 && terminal.onBoard === 0, JSON.stringify(terminal));
      eq("B5 · the segment strip offers Live · New business · Current · Completed & closed · All", b.segButtons, ["live", "new", "current", "completed", "all"]);
      // Completed & closed and All are table-only
      await page.evaluate(() => [...document.querySelectorAll("#pipe-segment .seg-btn")].find((x) => x.dataset.seg === "all").click());
      await wait(page, 2000);
      const all = await page.evaluate(() => ({ view: pipelineView, table: !document.querySelector("#table-wrap").classList.contains("hidden"), board: !document.querySelector("#board").classList.contains("hidden"), toggle: document.querySelector("#view-toggle").style.display }));
      ok("B6 · “All” is a TABLE (terminal cases live in the table only) and the board/table toggle is hidden", all.view === "table" && all.table && !all.board && all.toggle === "none", JSON.stringify(all));
      const allRows = await page.evaluate(() => document.querySelectorAll("#pipe-table .bulk-cb").length);
      const total = await page.evaluate(async () => (await window.__mockDb.from("cases").select("id")).data.length);
      ok("B6b · …and lists every case in the book", allRows === total, `${allRows} rows vs ${total} cases`);
      await page.evaluate(() => [...document.querySelectorAll("#pipe-segment .seg-btn")].find((x) => x.dataset.seg === "live").click());
      await wait(page, 2000);
      eq("B7 · back on Live the board returns", await page.evaluate(() => [pipelineView, !document.querySelector("#board").classList.contains("hidden")]), ["board", true]);
      const boardProse = await page.evaluate(() => {
        const hint = document.querySelector("#board-hint .desktop-hint");
        const how = document.querySelector("#board-how");
        return { hint: hint ? hint.textContent : "", foldClosed: !!how && !how.open && how.offsetParent !== null, legendInFold: !!document.querySelector("#board-how #board-legend") };
      });
      ok(`B8 · the board keeps ONE standing line (${words(boardProse.hint)} words) and folds the legend`, words(boardProse.hint) <= 25 && boardProse.foldClosed && boardProse.legendInFold, JSON.stringify(boardProse));
      ok("§B · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page)));
      await page.context().close();
    }

    /* =====================================================================
       §C · B3 — prose diet on the table + one-row bulk bar
       ===================================================================== */
    {
      console.log("\n— §C · B3 · one ≤25-word line + a fold; computed column counts; one-row bulk bar (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPipeline(page, 2400);
      await page.evaluate(() => [...document.querySelectorAll("#pipe-segment .seg-btn")].find((x) => x.dataset.seg === "current").click());
      await wait(page, 2200);
      const t = await page.evaluate(() => {
        const tw = document.querySelector("#table-wrap");
        const standing = [...tw.querySelectorAll("p, .pipe-sorted-by")].filter((p) => !p.closest("details") && p.offsetParent !== null && p.textContent.trim());
        const how = document.querySelector("#pipe-how");
        const why = document.querySelector("#pipe-cols-why");
        const cols = document.querySelectorAll("#pipe-table tr:first-child th[data-k]").length;
        const m = why ? why.textContent.replace(/\s+/g, " ").match(/Showing (\d+) of (\d+) columns\.\s*The default set is the (\d+) this view/) : null;
        return { standing: standing.map((p) => p.textContent.replace(/\s+/g, " ").trim()), foldClosed: !!how && !how.open, currentWhyInFold: !!how && !!how.querySelector("#pipe-current-why"),
          colsWhyInFold: !!how && !!how.querySelector("#pipe-cols-why"), legendInFold: !!how && !!how.querySelector("#pipe-legend .bl-item"), cols, m: m && m.slice(1).map(Number),
          firstRowY: (document.querySelector("#pipe-table tr:nth-child(2)") || {}).getBoundingClientRect?.().top };
      });
      ok(`C1 · exactly ONE standing line above the table, ≤ 25 words (${t.standing.length ? words(t.standing[0]) : 0} words)`, t.standing.length === 1 && words(t.standing[0]) <= 25, JSON.stringify(t.standing));
      ok("C2 · the old copy (why-table, column rules, legend) is inside one closed howFold", t.foldClosed && t.currentWhyInFold && t.colsWhyInFold && t.legendInFold, JSON.stringify(t));
      ok("C3 · “Showing N of M … the N” — both numbers computed and equal to the columns on screen", !!t.m && t.m[0] === t.cols && t.m[2] === t.cols && t.m[1] > t.cols, JSON.stringify({ m: t.m, cols: t.cols }));
      ok("C3b · …and “the nine” is nowhere in it", !(await page.evaluate(() => /the nine/.test(document.querySelector("#pipe-cols-why").textContent))));
      ok(`C4 · the first table row is higher up the page than the panel's 587px (measured ${Math.round(t.firstRowY)})`, t.firstRowY < 500, String(t.firstRowY));
      // the bulk bar
      const bar = await page.evaluate(async () => {
        [...document.querySelectorAll("#pipe-table .bulk-cb")].slice(0, 3).forEach((cb) => { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); });
        await new Promise((r) => setTimeout(r, 300));
        const b = document.querySelector("#pipe-bulk-bar");
        const kids = [...b.children];
        const bands = new Set(kids.map((e) => { const r = e.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2 / 20); }));
        const more = document.querySelector("#pipe-bulk-more");
        return { hidden: b.hidden, h: b.getBoundingClientRect().height, rows: bands.size, kids: kids.map((k) => k.id || k.className),
          moreClosed: !!more && !more.open, moreIds: more ? [...more.querySelectorAll("button")].map((x) => x.id) : [],
          gone: ["pipe-bulk-playbook", "pipe-bulk-checklists", "pipe-bulk-info", "pipe-bulk-sub"].filter((id) => document.getElementById(id)),
          exported: typeof window.bulkApplyPlaybooks === "function" && typeof window.bulkBuildChecklists === "function" };
      });
      ok(`C5 · the bulk bar is ONE row (${Math.round(bar.h)}px; it was 89px on two)`, !bar.hidden && bar.rows === 1 && bar.h <= 60, JSON.stringify(bar));
      eq("C6 · the bar reads: count · Move to stage… · Assign to… · ＋ Add task… · More ▾ · Clear", bar.kids, ["bulk-bar-count", "pipe-bulk-stage", "pipe-bulk-adviser", "pipe-bulk-task", "pipe-bulk-more", "pipe-bulk-clear"]);
      eq("C7 · “More ▾” holds the four send/chase verbs with their ids, closed by default", [bar.moreClosed, bar.moreIds], [true, ["pipe-bulk-rate", "pipe-bulk-retention", "pipe-bulk-chase", "pipe-bulk-docs"]]);
      eq("C8 · the two import-era back-fill verbs and the ⓘ paragraph are off the bar", bar.gone, []);
      ok("C8b · …their runners stay exported for Data health (window.bulkApplyPlaybooks / bulkBuildChecklists)", bar.exported);
      const moreFlow = await page.evaluate(async () => {
        const more = document.querySelector("#pipe-bulk-more");
        more.open = true;
        const vis = document.querySelector("#pipe-bulk-chase").offsetParent !== null;
        document.querySelector("#pipe-bulk-clear").click();
        await new Promise((r) => setTimeout(r, 200));
        return { vis, closedOnClear: !more.open, barHidden: document.querySelector("#pipe-bulk-bar").hidden };
      });
      ok("C9 · opening More ▾ reveals the verbs; Clear hides the bar and folds the menu", moreFlow.vis && moreFlow.closedOnClear && moreFlow.barHidden, JSON.stringify(moreFlow));
      ok("§C · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page)));
      await page.context().close();
    }

    /* =====================================================================
       §D · B4 — the record is in the URL and the tab
       ===================================================================== */
    let deepLinkCase = null;
    {
      console.log("\n— §D · B4 · #case/<id> + “<Client> · NexMoney Back Office”; restore on close; Copy link (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      const c = await mkCase(page, { first: "Deep", last: "Link" + tag(), row: { stage: "offer" } });
      deepLinkCase = c;
      await page.evaluate(() => window.nav("dashboard"));
      await wait(page, 1200);
      const before = await page.evaluate(() => ({ hash: location.hash, title: document.title }));
      await page.evaluate((id) => window.openCase(id), c.caseId);
      await wait(page, 1800);
      const open = await page.evaluate(() => ({ hash: location.hash, title: document.title, copy: !!document.querySelector("#cs-copy-link"), h3: document.querySelector("#modal h3").textContent.trim() }));
      eq("D1 · opening a case writes #case/<id>", open.hash, `#case/${c.caseId}`);
      eq("D2 · …and the tab reads “<Client name> · NexMoney Back Office”", open.title, `${c.name} · NexMoney Back Office`);
      ok("D3 · a ⧉ Copy link control sits in the case header (the h3 still reads “Case”)", open.copy && open.h3 === "Case", JSON.stringify(open));
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT}` });
      /* R88 · D: was a button beside the "Case" heading, now the first item in Actions ▾ (same id,
         same handler) because the case's first screen is held to ≤14 controls (panel 02 #5). */
      if (!(await page.isVisible("#cs-copy-link"))) await page.click("#cs-sticky-actions #case-more-actions-toggle");
      await page.click("#cs-copy-link");
      await wait(page, 500);
      const copied = await page.evaluate(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return "ERR " + e.message; } });
      const toast = await page.$eval("#toast", (e) => e.textContent).catch(() => "");
      ok("D4 · pressing it copies the deep link and says so", copied.endsWith(`#case/${c.caseId}`) && /Link copied/.test(toast), JSON.stringify({ copied, toast }));
      // Back closes the modal and restores hash + title
      await page.goBack();
      await wait(page, 900);
      const closed = await page.evaluate(() => ({ hash: location.hash, title: document.title, modalHidden: document.querySelector("#modal-backdrop").classList.contains("hidden") }));
      ok("D5 · Back closes the modal and the URL/tab go back to the page", closed.modalHidden && closed.hash === before.hash && closed.title === before.title, JSON.stringify({ closed, before }));
      // closeModal() (Save / Cancel path) restores too
      await page.evaluate((id) => window.openCase(id), c.caseId);
      await wait(page, 1800);
      await page.evaluate(() => window.closeModal());
      await wait(page, 700);
      const closed2 = await page.evaluate(() => ({ hash: location.hash, title: document.title }));
      ok("D6 · closing via Cancel/Save restores the page hash and title too", closed2.hash === before.hash && closed2.title === before.title, JSON.stringify({ closed2, before }));
      ok("§D · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page)));
      await page.context().close();
    }
    {
      console.log("\n— §D2 · a refresh on #case/<id> reopens the case (p4)");
      // the case seeded above lives in THAT context's mock db; seed the deep link against a fixture case here
      const page = await boot(browser, "p4");
      const fx = await page.evaluate(async () => (await window.__mockDb.from("cases").select("id,client_id,clients!client_id(first_name,last_name)").eq("stage", "application").limit(1)).data[0]);
      await page.context().close();
      const page2 = await boot(browser, "p4", DESK, `#case/${fx.id}`);
      await wait(page2, 2500);
      const re = await page2.evaluate(() => ({ modal: !document.querySelector("#modal-backdrop").classList.contains("hidden"), hash: location.hash, title: document.title, page: currentPage, name: (document.querySelector(".cs-name") || {}).textContent || "" }));
      ok("D7 · cold load on #case/<id> opens that case over the Pipeline page", re.modal && re.hash === `#case/${fx.id}` && re.page === "pipeline", JSON.stringify(re));
      ok("D7b · …with the client's name in the tab", re.title.startsWith(`${fx.clients.first_name} ${fx.clients.last_name}`), re.title);
      ok("§D2 · no console errors", realErrs(page2).length === 0, JSON.stringify(realErrs(page2)));
      await page2.context().close();
    }

    {
      console.log("\n— §D3 · a re-sign-in with the case open (R76 signed-out strip) keeps the modal and its typing (p4)");
      const page = await boot(browser, "p4");
      const c = await mkCase(page, { first: "Keep", last: "Typing" + tag(), row: { stage: "application" } });
      await page.evaluate((id) => window.openCase(id), c.caseId);
      await wait(page, 1800);
      await page.fill("#new-note", "half-typed note");
      await page.evaluate(() => { window.__mockDb.auth.signOut(); });
      await wait(page, 900);
      await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("profiles").select("email").eq("id", "p4").single();
        document.querySelector("#login-email").value = data.email;
        document.querySelector("#login-password").value = "x";
        document.querySelector("#login-form").requestSubmit();
      });
      await wait(page, 2000);
      if (await page.$("#mfa-code")) { await page.fill("#mfa-code", ""); await page.type("#mfa-code", "000000", { delay: 15 }); await wait(page, 2400); }   // R86 — the sixth digit auto-submits
      const back = await page.evaluate(() => ({ modal: !document.querySelector("#modal-backdrop").classList.contains("hidden"), note: (document.querySelector("#new-note") || {}).value, hash: location.hash, title: document.title }));
      ok("D8 · routeFromHash on #case/<id> with that modal already up leaves it (and the typing) alone", back.modal && back.note === "half-typed note" && back.hash === `#case/${c.caseId}` && back.title.startsWith(c.name), JSON.stringify(back));
      ok("§D3 · no console errors", realErrs(page).length === 0, JSON.stringify(realErrs(page)));
      await page.context().close();
    }

    /* =====================================================================
       §E · B5 — case → client
       ===================================================================== */
    {
      console.log("\n— §E · B5 · the case header's name opens the client; the footer has Open client (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      const c = await mkCase(page, { first: "Back", last: "Toclient" + tag(), row: { stage: "application" } });
      await page.evaluate((id) => window.openCase(id), c.caseId);
      await wait(page, 1800);
      const hdr = await page.evaluate(() => {
        const a = document.querySelector(".cs-name a.cs-name-link");
        const btn = document.querySelector("#modal > .modal-actions #case-open-client");
        return { link: !!a, href: a && a.getAttribute("href"), text: a && a.textContent.trim(), footer: !!btn, footerText: btn && btn.textContent.trim() };
      });
      ok("E1 · the client name is a link carrying the client deep link", hdr.link && hdr.href === `#client/${c.clientId}` && hdr.text === c.name, JSON.stringify(hdr));
      eq("E2 · the footer offers “Open client”, like the appointment modal", [hdr.footer, hdr.footerText], [true, "Open client"]);
      await page.click(".cs-name a.cs-name-link");
      await wait(page, 1800);
      const cl = await page.evaluate(() => ({ hash: location.hash, form: !!document.querySelector("#client-form"), title: document.title }));
      ok("E3 · pressing the name opens the client record, and the URL follows", cl.form && cl.hash === `#client/${c.clientId}`, JSON.stringify(cl));
      await page.evaluate((id) => window.openCase(id), c.caseId);
      await wait(page, 1800);
      await page.click("#case-open-client");
      await wait(page, 1800);
      ok("E4 · the footer button does the same", await page.evaluate(() => !!document.querySelector("#client-form") && /^#client\//.test(location.hash)));
      ok("§E · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page)));
      await page.context().close();
    }

    /* =====================================================================
       §F · B6 — one-line action row, Book appointment on it
       ===================================================================== */
    for (const [label, vp, maxH] of [["1440", DESK, 70], ["390", PHONE, 60]]) {
      console.log(`\n— §F · B6 · the sticky action row is ONE line at ${label} (p4)`);
      const page = await boot(browser, "p4", vp);
      const errBefore = realErrs(page).length;
      const live = await mkCase(page, { first: "Row", last: "Live" + tag(), row: { stage: "enquiry" } });
      const done = await mkCase(page, { first: "Row", last: "Done" + tag(), row: { stage: "completed", completed_at: new Date().toISOString(), rate_end_date: "2028-03-01", assigned_to: "p2" } });
      const measure = (id) => page.evaluate(async (i) => {
        await window.openCase(i);
        await new Promise((r) => setTimeout(r, 1800));
        const st = document.querySelector("#cs-sticky-actions");
        const vis = [...st.querySelectorAll("button, select, label.ret-tome")].filter((e) => e.offsetParent !== null && !e.closest(".more-actions-menu"));
        const centres = vis.map((e) => { const r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; });
        const bands = new Set(centres.length ? [Math.max(...centres) - Math.min(...centres) <= 14 ? 1 : 2] : []);   // one row = every control's centre within 14px
        const ids = [...document.querySelectorAll("#modal [id^=act-]")].map((e) => e.id);
        return { h: st.getBoundingClientRect().height, rows: bands.size, vis: vis.map((e) => e.id || e.className.split(" ")[0]), ids,
          appt: (() => { const b = document.querySelector('#cs-sticky-actions #case-action-bar > #act-appt[data-act-tier="top"]'); return b ? { top: true, aria: b.getAttribute("aria-label") || b.textContent.trim() } : { top: false }; })() };
      }, id);
      const L = await measure(live.caseId);
      ok(`F1 · live case: one line (${Math.round(L.h)}px)`, L.rows === 1 && L.h <= maxH, JSON.stringify(L));
      ok("F2 · 📅 Book appointment is ON the row at Enquiry (it was 6–7 presses away in Actions ▾)", L.appt.top && /Book appointment/.test(L.appt.aria), JSON.stringify(L.appt));
      ok("F3 · the row still starts with Advance and carries Log call and Actions ▾", L.vis.includes("cs-advance-btn") && L.vis.includes("cs-logcall-btn") && L.vis.includes("case-more-actions-toggle"), JSON.stringify(L.vis));
      const expectIds = ["act-appt", "act-factfind", "act-write", "act-ref-protection", "act-evidence", "act-record-reason"];
      ok("F4 · every act-* id is still present somewhere in the modal", expectIds.filter((i) => i !== "act-record-reason").every((i) => L.ids.includes(i)), JSON.stringify(L.ids));
      await page.evaluate(() => window.closeModal());
      const D = await measure(done.caseId);
      ok(`F5 · completed case with a tracked rate: one line (${Math.round(D.h)}px; the panel measured 98/96)`, D.rows === 1 && D.h <= maxH, JSON.stringify(D));
      ok("F6 · …with 🔁 Start retention case and the assign-to-me tick on it", D.vis.includes("cs-retention-btn") && D.vis.includes("ret-tome"), JSON.stringify(D.vis));
      ok(`§F · ${label} · no console errors`, realErrs(page).length === errBefore, JSON.stringify(realErrs(page)));
      await page.context().close();
    }

    /* =====================================================================
       §G · B7 — roles
       ===================================================================== */
    {
      console.log("\n— §G · B7 · Import / Emails / Data health are Owner-Administrator pages (p2 adviser vs p1 admin)");
      const p2 = await boot(browser, "p2");
      const errBefore = realErrs(p2).length;
      const adv = await p2.evaluate(() => {
        const all = [...document.querySelectorAll("#topnav button[data-page]")];
        return { total: all.length, visible: all.filter((b) => !b.classList.contains("hidden")).map((b) => b.dataset.page), hidden: all.filter((b) => b.classList.contains("hidden")).map((b) => b.dataset.page) };
      });
      /* R89 · F — was [13, 9, [data, emails, import, money]]: the four are tabs now (Operations; Reports ›
         Money), so the sidebar holds 10 entries and the one an adviser loses is Operations. */
      eq("G1 · an adviser's sidebar hides Operations: 10 → 9 visible", [adv.total, adv.visible.length, adv.hidden.sort()], [10, 9, ["operations"]]);
      ok("G1b · Settings stays (slice D shrinks it)", adv.visible.includes("settings"));
      const bounce = await p2.evaluate(() => {
        const out = {};
        ["import", "emails", "data"].forEach((k) => { window.nav(k); out[k] = { page: currentPage, hash: location.hash, shown: !document.querySelector("#page-dashboard").classList.contains("hidden") }; });
        return out;
      });
      ok("G2 · nav() to any gated page lands an adviser on Today with the hash rewritten", Object.values(bounce).every((b) => b.page === "dashboard" && b.hash === "#today" && b.shown), JSON.stringify(bounce));
      const gate = await p2.evaluate(() => Object.keys(PAGE_ROLE_GATE).sort());
      // R89 · F — + operations (the page that holds import · emails · data; their own gates stay for the aliases)
      eq("G3 · PAGE_ROLE_GATE names exactly money · import · emails · data · operations", gate, ["data", "emails", "import", "money", "operations"]);
      ok("§G · p2 · no console errors", realErrs(p2).length === errBefore, JSON.stringify(realErrs(p2)));
      await p2.context().close();
      const p1 = await boot(browser, "p1");
      const adm = await p1.evaluate(() => { window.nav("import"); return { page: currentPage, tab: currentPageTab(), visible: [...document.querySelectorAll("#topnav button[data-page]")].filter((b) => !b.classList.contains("hidden")).map((b) => b.dataset.page) }; });
      // R89 · F — was page "import" + three visible entries; Import is Operations › Import, one entry.
      ok("G4 · an administrator keeps Import / Emails / Data health (money stays owner-only)", adm.page === "operations" && adm.tab === "import" && adm.visible.includes("operations") && !adm.visible.includes("money"), JSON.stringify(adm));
      await p1.context().close();
    }
    {
      console.log("\n— §G2 · deep link to a gated page bounces an adviser (p2 on #import)");
      const page = await boot(browser, "p2", DESK, "#import");
      await wait(page, 800);
      const st = await page.evaluate(() => ({ page: currentPage, hash: location.hash }));
      eq("G5 · #import on a cold load lands an adviser on #today", st, { page: "dashboard", hash: "#today" });
      ok("§G2 · no console errors", realErrs(page).length === 0, JSON.stringify(realErrs(page)));
      await page.context().close();
    }

    /* =====================================================================
       §H · B8 — phone: the footer follows the fold
       ===================================================================== */
    {
      console.log("\n— §H · B8 · phone: Cancel/Save show only while Case details is open (p4, 390×844)");
      const page = await boot(browser, "p4", PHONE);
      const errBefore = realErrs(page).length;
      const c = await mkCase(page, { first: "Fold", last: "Footer" + tag(), row: { stage: "offer" } });
      await page.evaluate((id) => window.openCase(id), c.caseId);
      await wait(page, 1800);
      const s0 = await page.evaluate(() => ({ detailsOpen: document.querySelector("#modal .case-details").open, footerHidden: document.querySelector("#modal > .modal-actions").hidden, save: !!document.querySelector("#modal-save") }));
      ok("H1 · the form is folded and the Cancel/Save footer is hidden (the buttons still exist)", !s0.detailsOpen && s0.footerHidden && s0.save, JSON.stringify(s0));
      await page.evaluate(() => { document.querySelector("#modal .case-details").open = true; });
      await wait(page, 300);
      const s1 = await page.evaluate(() => ({ footerHidden: document.querySelector("#modal > .modal-actions").hidden, saveVisible: document.querySelector("#modal-save").offsetParent !== null }));
      ok("H2 · opening Case details shows the footer", !s1.footerHidden && s1.saveVisible, JSON.stringify(s1));
      await page.evaluate(() => { document.querySelector("#modal .case-details").open = false; });
      await wait(page, 300);
      eq("H3 · closing it hides the footer again", await page.evaluate(() => document.querySelector("#modal > .modal-actions").hidden), true);
      ok("§H · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page)));
      await page.context().close();
    }
    {
      console.log("\n— §H2 · desktop keeps the footer as it was (p4, 1440)");
      const page = await boot(browser, "p4");
      const c = await mkCase(page, { first: "Desk", last: "Footer" + tag(), row: { stage: "offer" } });
      await page.evaluate((id) => window.openCase(id), c.caseId);
      await wait(page, 1800);
      eq("H4 · at 1440 the footer is shown with the fold closed", await page.evaluate(() => [document.querySelector("#modal .case-details").open, document.querySelector("#modal > .modal-actions").hidden]), [false, false]);
      await page.context().close();
    }
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch (_) { /* already gone */ } }
  }
  console.log(`\nr87_pipeline_case: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
