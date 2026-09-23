#!/usr/bin/env node
/* =============================================================================
   tests/r88_book_b.js — acceptance tests for R88 slice B: CLIENTS + the PIPELINE TABLE on the
   list kit (R88-DESIGN §B; panel-r87/04-book-pages.md #6 #10, 03-pipeline-diary.md #3 #5 #6).
   Every expectation is computed at runtime — from the mock store, or from the live DOM.

     §A  CLIENTS TOOLS ROW  — one .list-tools#client-tools: #client-search · Mine|All
                              (#cl-scope-mine/#cl-scope-all, aria-pressed) · #cl-sort. The
                              saved-views trio, the adviser row and the two note lines are gone;
                              #client-adviser is a HIDDEN compat select carrying the value. Mine
                              and All really re-scope the list (recounted from the store).
     §B  CHIPS              — 8 × `.seg-strip#client-segment > .seg-btn[data-seg] > .seg-count`,
                              counts equal to an INDEPENDENT recount off __mockDb (clients, cases,
                              the four comms tables); a chip press re-renders with aria-pressed.
     §C  ROWS               — `.row-item.kit-row.client-row`, ≤3 visible verbs, ≤2 chips, ONE
                              fact line; the name opens the CLIENT (never a case); a single-live-
                              case chip opens that case; emptyState() is the empty state.
     §D  BULK BAR           — select-all (.list-selall#client-bulk-all), the bar docked as the
                              LAST child of #client-list, 0px tall while empty, sticky at the
                              viewport bottom once rows are ticked, ≤3 verbs.
     §E  CAP LINE           — > 100 clients: "Showing 100 of N — search to narrow".
     §F  PIPELINE TABLE     — #board-tools Mine|All|Unassigned (compat #board-adviser hidden and
                              in step), select-all via the kit line, the kit bar docked as
                              #table-wrap's last child (0px empty), ≤3 verbs + More ▾ (.row-more)
                              holding the four send/chase verbs; board cards untouched.
     §G  PHONE (390×844)    — every control on the Clients tools/chips/bulk bar ≥ 44px tall.
     §H  No inline styles in the two regions; no console errors.

   Run:  node /root/nx/tests/r88_book_b.js
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
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

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

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };
const wait = (page, ms) => page.waitForTimeout(ms);

async function boot(browser, persona, viewport) {
  const vp = viewport || DESK;
  const ctx = await browser.newContext({ viewport: vp, locale: "en-GB", timezoneId: "Europe/London", hasTouch: vp === PHONE, isMobile: vp === PHONE });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  page.on("dialog", (d) => d.dismiss());
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 30000 });
  await wait(page, 1500);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await wait(page, 200);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));
async function goto(page, name, ms) {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await wait(page, ms == null ? 1500 : ms);
}

/* ---- the independent recount: segment membership computed straight off the mock store ---- */
const recount = (page, who) => page.evaluate(async (who) => {
  const db = window.__mockDb;
  const [cl, ks, notes, emails, appts, tasks] = await Promise.all([
    db.from("clients").select("id,date_of_birth"),
    db.from("cases").select("id,client_id,stage,rate_end_date,protection_status,assigned_to"),
    db.from("case_notes").select("case_id,created_at,body"),
    db.from("email_queue").select("client_id,case_id,status,sent_at"),
    db.from("appointments").select("client_id,case_id,starts_at"),
    db.from("case_tasks").select("case_id,done_at"),
  ]);
  const cases = ks.data || [];
  const owner = new Map(cases.map((k) => [k.id, k.client_id]));
  const byClient = new Map();
  cases.forEach((k) => { if (!byClient.has(k.client_id)) byClient.set(k.client_id, []); byClient.get(k.client_id).push(k); });
  const live = (s) => s !== "completed" && s !== "not_proceeding";
  const now = Date.now();
  const last = new Map();
  const bump = (cid, at) => { if (!cid || !at) return; const t = new Date(at).getTime(); if (!last.has(cid) || t > last.get(cid)) last.set(cid, t); };
  (notes.data || []).forEach((n) => { if (/^\s*SB-IMPORT-\d/.test(n.body || "") || /^\s*AI bulk import\b/.test(n.body || "")) return; bump(owner.get(n.case_id), n.created_at); });
  (emails.data || []).forEach((e) => { if (e.status === "sent" && e.sent_at) bump(e.client_id || owner.get(e.case_id), e.sent_at); });
  (appts.data || []).forEach((a) => { if (a.starts_at && new Date(a.starts_at).getTime() <= now) bump(a.client_id || owner.get(a.case_id), a.starts_at); });
  (tasks.data || []).forEach((t) => { if (t.done_at) bump(owner.get(t.case_id), t.done_at); });
  const cut = new Date(now); cut.setMonth(cut.getMonth() - clientQuietMonths());   // the window is a SETTING; the membership rule below is ours
  const y = new Date().getFullYear();
  const mine = (c) => {
    if (!who || who === "all") return true;
    return (byClient.get(c.id) || []).some((k) => k.assigned_to === who);
  };
  const book = (cl.data || []).filter(mine);
  const segs = {
    all: book.length,
    no_live_case: book.filter((c) => !(byClient.get(c.id) || []).some((k) => live(k.stage))).length,
    ["rate_" + y]: 0, ["rate_" + (y + 1)]: 0, ["rate_" + (y + 2)]: 0,
    no_protection: book.filter((c) => (byClient.get(c.id) || []).some((k) => live(k.stage) && ["not_discussed", "discussed"].includes(k.protection_status || "not_discussed"))).length,
    no_dob: book.filter((c) => !c.date_of_birth).length,
    cold: book.filter((c) => !last.has(c.id) || last.get(c.id) < cut.getTime()).length,
  };
  [y, y + 1, y + 2].forEach((yy) => { segs["rate_" + yy] = book.filter((c) => (byClient.get(c.id) || []).some((k) => k.rate_end_date && String(k.rate_end_date).slice(0, 4) === String(yy))).length; });
  return segs;
}, who);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* =====================================================================
       §A · the Clients tools row (p4 owner — opens on All)
       ===================================================================== */
    console.log("\n— §A · Clients: one kit tools row — search · Mine|All · Sort (p4, 1440)");
    const page = await boot(browser, "p4");
    const errBefore = realErrs(page).length;
    await goto(page, "clients", 2200);
    const tools = await page.evaluate(() => {
      const t = document.querySelector("#client-tools");
      if (!t) return null;
      const kids = [...t.children].filter((e) => e.offsetParent);
      return {
        cls: t.className,
        search: !!t.querySelector("input#client-search[type=search]"),
        scope: [...t.querySelectorAll(".segment.list-scope > .seg-btn")].map((b) => [b.id, b.dataset.scope, b.getAttribute("aria-pressed")]),
        sort: !!t.querySelector("select#cl-sort.list-sort"),
        sortOpts: [...(t.querySelector("#cl-sort") || { options: [] }).options].map((o) => o.value),
        tops: new Set(kids.map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2))).size,
        compatHidden: document.querySelector("#client-adviser") ? document.querySelector("#client-adviser").hidden : null,
        compatVal: (document.querySelector("#client-adviser") || {}).value,
        gone: ["client-views", "client-view-save", "client-view-del", "client-adv-note", "cl-sort-note"].filter((id) => document.getElementById(id)),
        oldRow: !!document.querySelector(".client-controls"),
      };
    });
    ok("A1 · #client-tools is a .list-tools row", !!tools && /\blist-tools\b/.test(tools.cls), JSON.stringify(tools));
    ok("A2 · …holding the search box #client-search", tools && tools.search);
    eq("A3 · …the Mine|All scope (#cl-scope-mine / #cl-scope-all), All pressed for the owner", tools && tools.scope, [["cl-scope-mine", "mine", "false"], ["cl-scope-all", "all", "true"]]);
    ok("A4 · …and the sort <select id=cl-sort> with its three orders", tools && tools.sort && JSON.stringify(tools.sortOpts) === JSON.stringify(["name", "rate_end", "recent"]), JSON.stringify(tools && tools.sortOpts));
    ok("A5 · the three controls share ONE line at 1440", tools && tools.tops === 1, JSON.stringify(tools && tools.tops));
    eq("A6 · the saved-views trio, the adviser row and both note lines are gone", tools && tools.gone.concat(tools.oldRow ? ["client-controls"] : []), []);
    ok("A7 · #client-adviser survives as a HIDDEN compat select carrying the scope (\"all\")", tools && tools.compatHidden === true && tools.compatVal === "all", JSON.stringify(tools));

    // Mine really narrows to p4's book, recounted from the store; All restores the firm's.
    const firm = await recount(page, "all");
    await page.click("#cl-scope-mine");
    await wait(page, 1200);
    const mineRecount = await recount(page, "p4");
    const mineState = await page.evaluate(() => ({
      pressed: document.querySelector("#cl-scope-mine").getAttribute("aria-pressed"),
      compat: document.querySelector("#client-adviser").value,
      rows: document.querySelectorAll("#client-list .client-row").length,
      allChip: Number((document.querySelector('#client-segment .seg-btn[data-seg="all"] .seg-count') || {}).textContent),
      stored: localStorage.getItem("nx_clients_adviser_p4"),
    }));
    ok("A8 · Mine presses, writes the compat select (p4) and persists the pick", mineState.pressed === "true" && mineState.compat === "p4" && mineState.stored === "p4", JSON.stringify(mineState));
    eq("A9 · …and the All chip now counts p4's book, recounted from the store", mineState.allChip, mineRecount.all);
    ok("A9b · …which is a real narrowing of the firm's book", mineRecount.all < firm.all, JSON.stringify({ mine: mineRecount.all, firm: firm.all }));
    await page.click("#cl-scope-all");
    await wait(page, 1200);
    eq("A10 · All puts the firm's book back", await page.evaluate(() => Number(document.querySelector('#client-segment .seg-btn[data-seg="all"] .seg-count').textContent)), firm.all);

    // A colleague's book (the door Retention uses): neither button pressed, a "✕" chip leads back.
    await page.evaluate(() => window.gotoClientSegment("all", "p3"));
    await wait(page, 1500);
    const other = await page.evaluate(() => ({
      pressed: [...document.querySelectorAll("#client-tools .list-scope .seg-btn")].map((b) => b.getAttribute("aria-pressed")),
      chip: (() => { const c = document.querySelector("#cl-scope-other"); return c && !c.classList.contains("hidden") ? c.textContent.trim() : null; })(),
    }));
    ok("A11 · a colleague's book presses neither Mine nor All and shows a “✕” chip naming them", other.pressed.every((p) => p === "false") && /✕/.test(other.chip || "") && /Luke|p3/i.test(other.chip || ""), JSON.stringify(other));
    await page.click("#cl-scope-other");
    await wait(page, 1200);
    eq("A12 · …and the chip takes you back to All", await page.evaluate(() => [document.querySelector("#cl-scope-all").getAttribute("aria-pressed"), document.querySelector("#cl-scope-other").classList.contains("hidden")]), ["true", true]);

    /* =====================================================================
       §B · the eight segment chips, recounted independently
       ===================================================================== */
    console.log("\n— §B · 8 kit chips; counts = an independent recount off the store (p4)");
    const chips = await page.evaluate(() => [...document.querySelectorAll("#client-segment > .seg-btn")].map((b) => ({
      seg: b.dataset.seg, n: Number((b.querySelector(".seg-count") || {}).textContent), pressed: b.getAttribute("aria-pressed"), strip: b.parentElement.classList.contains("seg-strip"),
    })));
    eq("B1 · eight chips, in the page's order", chips.map((c) => c.seg), Object.keys(firm));
    ok("B2 · every chip is a .seg-btn inside the .seg-strip#client-segment", chips.length === 8 && chips.every((c) => c.strip));
    const recountNow = await recount(page, "all");
    for (const c of chips) eq(`B3 · “${c.seg}” count = the store's own recount`, c.n, recountNow[c.seg]);
    ok("B4 · exactly one chip is aria-pressed (All)", chips.filter((c) => c.pressed === "true").length === 1 && chips.find((c) => c.pressed === "true").seg === "all", JSON.stringify(chips.map((c) => c.pressed)));
    const target = chips.find((c) => c.seg === "no_dob");
    await page.click('#client-segment .seg-btn[data-seg="no_dob"]');
    await wait(page, 900);
    const afterSeg = await page.evaluate(() => ({
      pressed: (document.querySelector("#client-segment .seg-btn[aria-pressed=true]") || {}).dataset?.seg,
      rows: document.querySelectorAll("#client-list .client-row").length,
      dobLine: [...document.querySelectorAll("#client-list .client-row .row-fact")].every((f) => /DOB: —/.test(f.textContent)),
    }));
    ok("B5 · pressing “Missing DOB” re-renders: it is the pressed chip, the rows are its count, each says DOB: —", afterSeg.pressed === "no_dob" && afterSeg.rows === Math.min(100, target.n) && afterSeg.dobLine, JSON.stringify(afterSeg));
    await page.click('#client-segment .seg-btn[data-seg="all"]');
    await wait(page, 900);

    /* =====================================================================
       §C · rows
       ===================================================================== */
    console.log("\n— §C · rows are the kit's .row-item: ≤3 verbs, ≤2 chips, one fact line, name → client (p4)");
    const rows = await page.evaluate(() => {
      const rs = [...document.querySelectorAll("#client-list .client-row")];
      return {
        n: rs.length,
        kit: rs.every((r) => r.classList.contains("row-item") && r.classList.contains("kit-row")),
        compat: rs.every((r) => r.dataset.client && r.dataset.client === r.dataset.id),
        maxVerbs: Math.max(0, ...rs.map((r) => [...r.querySelectorAll(".row-acts > .btn")].filter((b) => b.offsetParent).length)),
        maxChips: Math.max(0, ...rs.map((r) => r.querySelectorAll(".row-chips > *").length)),
        oneFact: rs.every((r) => r.querySelectorAll(".row-fact").length === 1),
        factLines: Math.max(0, ...rs.map((r) => { const f = r.querySelector(".row-fact"); return f ? Math.round(f.getBoundingClientRect().height / parseFloat(getComputedStyle(f).lineHeight || "18")) : 0; })),
        heights: rs.slice(0, 20).map((r) => Math.round(r.getBoundingClientRect().height)),
        cb: rs.every((r) => r.querySelector(":scope > input.bulk-cb.client-cb")),
      };
    });
    ok("C1 · every client row is .row-item.kit-row (with the .client-row compat class and data-client)", rows.n > 0 && rows.kit && rows.compat, JSON.stringify(rows));
    ok(`C2 · ≤3 visible verbs on any row (max ${rows.maxVerbs})`, rows.maxVerbs <= 3);
    ok(`C3 · ≤2 chips on any row (max ${rows.maxChips})`, rows.maxChips <= 2);
    ok(`C4 · ONE fact line per row, one line tall at 1440 (max ${rows.factLines})`, rows.oneFact && rows.factLines <= 1, JSON.stringify(rows.factLines));
    ok(`C5 · the row stays the Clients row height (≤ 72px; measured ${Math.max(...rows.heights)})`, Math.max(...rows.heights) <= 72, JSON.stringify(rows.heights));
    ok("C6 · every row carries its .bulk-cb.client-cb checkbox", rows.cb);

    // name → the client, never the case; the single-live-case chip → that case.
    const pick = await page.evaluate(() => {
      const r = [...document.querySelectorAll("#client-list .client-row")].find((x) => x.querySelector(".client-case-chip[onclick*=openCase]"));
      return r ? { id: r.dataset.id, caseOnclick: r.querySelector(".client-case-chip").getAttribute("onclick") } : null;
    });
    ok("C7 · fixture · a row with exactly one live case exists", !!pick, JSON.stringify(pick));
    await page.evaluate(() => {
      window.__hits = [];
      const oc = window.openClient, ok2 = window.openCase;
      window.openClient = function (...a) { window.__hits.push(["client", a[0]]); return oc.apply(this, a); };
      window.openCase = function (...a) { window.__hits.push(["case", a[0]]); return ok2.apply(this, a); };
    });
    await page.click(`#client-list .client-row[data-id="${pick.id}"] .t`);
    await wait(page, 900);
    const nameHits = await page.evaluate(() => window.__hits.slice());
    eq("C8 · clicking the name opens the CLIENT (openClient with the row's id), never a case", nameHits, [["client", pick.id]]);
    await page.evaluate(() => { if (window.closeModal) window.closeModal(); window.__hits = []; });
    await wait(page, 400);
    await page.click(`#client-list .client-row[data-id="${pick.id}"] .client-case-chip`);
    await wait(page, 900);
    const chipHits = await page.evaluate(() => window.__hits.slice());
    ok("C9 · the single-live-case chip opens THAT case (and not the client)", chipHits.length === 1 && chipHits[0][0] === "case" && pick.caseOnclick.includes(chipHits[0][1]), JSON.stringify(chipHits));
    await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
    await wait(page, 400);

    // emptyState is the empty state.
    await page.fill("#client-search", "zzzz-r88b-nobody");
    await wait(page, 700);
    const empty = await page.evaluate(() => ({ es: !!document.querySelector("#client-list .empty-state"), old: !!document.querySelector("#client-list .empty"), clear: !!document.querySelector("#client-empty-clear"), selall: !!document.querySelector("#client-bulk-all") }));
    ok("C10 · an empty search renders emptyState() (no .empty wrapper) with Clear filters, and no select-all line", empty.es && !empty.old && empty.clear && !empty.selall, JSON.stringify(empty));
    await page.fill("#client-search", "");
    await wait(page, 700);

    /* =====================================================================
       §D · bulk bar docked at the list bottom
       ===================================================================== */
    console.log("\n— §D · Clients bulk bar: docked at the bottom of #client-list, 0px while empty (p4)");
    const d0 = await page.evaluate(() => {
      const list = document.querySelector("#client-list");
      const dock = document.querySelector("#client-bulk-dock");
      const bar = document.querySelector("#client-bulk-bar");
      return { last: list.lastElementChild === dock, dockCls: dock && dock.className, h: dock ? dock.getBoundingClientRect().height : -1, barEmpty: bar && bar.classList.contains("is-empty"), selall: (document.querySelector("#client-bulk .list-selall label") || {}).textContent };
    });
    ok("D1 · the bar sits in a .bulk-dock that is #client-list's LAST child", d0.last && /\bbulk-dock\b/.test(d0.dockCls || ""), JSON.stringify(d0));
    eq("D2 · …and the dock is 0px tall while nothing is ticked", d0.h, 0);
    const shownN = await page.evaluate(() => document.querySelectorAll("#client-list .client-row").length);
    ok("D3 · the select-all line is the kit's (.list-selall) and counts the rows shown", new RegExp(`Select all ${firm.all} shown`).test(d0.selall || "") && shownN === Math.min(100, firm.all), JSON.stringify({ selall: d0.selall, shownN }));
    await page.evaluate(() => { [...document.querySelectorAll("#client-list .client-cb")].slice(0, 2).forEach((cb) => cb.click()); });
    await wait(page, 500);
    const d1 = await page.evaluate(() => {
      const dock = document.querySelector("#client-bulk-dock");
      const bar = document.querySelector("#client-bulk-bar");
      const r = dock.getBoundingClientRect();
      return {
        n: document.querySelector("#client-bulk-n").textContent, hidden: bar.hidden, empty: bar.classList.contains("is-empty"),
        pos: getComputedStyle(dock).position, bottom: Math.round(r.bottom), vh: window.innerHeight, h: Math.round(r.height),
        verbs: [...bar.children].filter((e) => e.matches(".btn:not(.bulk-clear)") && e.offsetParent).map((e) => e.id),
        clear: !!bar.querySelector("#client-bulk-clear.bulk-clear"), note: /No bulk email yet/.test((document.querySelector("#client-bulk-note") || {}).textContent || ""),
        indet: document.querySelector("#client-bulk-all").indeterminate,
      };
    });
    ok("D4 · ticking two rows shows the bar with “2 selected”", d1.n === "2" && !d1.hidden && !d1.empty, JSON.stringify(d1));
    ok("D5 · the dock is sticky and sits on the viewport's bottom edge", d1.pos === "sticky" && Math.abs(d1.bottom - d1.vh) <= 2 && d1.h > 0, JSON.stringify(d1));
    ok("D6 · ≤3 verbs on the bar (Add task · Export CSV) + Clear", d1.verbs.length <= 3 && d1.verbs.includes("client-bulk-task") && d1.verbs.includes("client-bulk-csv") && d1.clear, JSON.stringify(d1.verbs));
    ok("D7 · the no-bulk-email explanation keeps its id and words, folded on the bar; select-all goes indeterminate", d1.note && d1.indet === true, JSON.stringify(d1));
    await page.click("#client-bulk-clear");
    await wait(page, 600);
    eq("D8 · Clear empties the selection and the dock folds back to 0px", await page.evaluate(() => [document.querySelector("#client-bulk-n").textContent, document.querySelector("#client-bulk-dock").getBoundingClientRect().height]), ["0", 0]);

    /* =====================================================================
       §E · the cap line
       ===================================================================== */
    console.log("\n— §E · > 100 clients: “Showing 100 of N — search to narrow” (p4)");
    await page.evaluate(async () => {
      const db = window.__mockDb;
      for (let i = 0; i < 60; i++) await db.from("clients").insert({ first_name: "CapB", last_name: `R88Fill${String(i).padStart(2, "0")}`, email: `r88b.${i}@example.com` });
    });
    await goto(page, "clients", 2200);
    const total = (await recount(page, "all")).all;
    const cap = await page.evaluate(() => ({
      rows: document.querySelectorAll("#client-list .client-row").length,
      note: ((document.querySelector("#client-list .client-list-cap-note") || {}).textContent || "").trim(),
      selall: (document.querySelector("#client-bulk .list-selall label") || {}).textContent,
    }));
    ok(`E1 · fixture · the book is past the cap (${total} clients)`, total > 100);
    eq("E2 · exactly 100 rows render", cap.rows, 100);
    eq("E3 · the cap line reads “Showing 100 of N — search to narrow”", cap.note, `Showing 100 of ${total} — search to narrow`);
    ok("E4 · …while select-all still counts the full list", new RegExp(`Select all ${total} shown`).test(cap.selall || ""), cap.selall);
    ok("§A–E · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page)));
    await page.context().close();

    /* =====================================================================
       §F · the pipeline table
       ===================================================================== */
    console.log("\n— §F · Pipeline table: Mine|All|Unassigned, kit select-all, docked kit bar with More ▾ (p2, 1440)");
    const pp = await boot(browser, "p2");
    const pErr = realErrs(pp).length;
    await goto(pp, "pipeline", 2200);
    const bt = await pp.evaluate(() => ({
      tools: !!document.querySelector("#board-tools.list-tools #board-search"),
      scope: [...document.querySelectorAll("#board-tools .list-scope > .seg-btn")].map((b) => [b.id, b.getAttribute("aria-pressed")]),
      compat: { hidden: document.querySelector("#board-adviser").hidden, v: document.querySelector("#board-adviser").value },
      cards: document.querySelectorAll("#board .card").length,
    }));
    ok("F1 · #board-tools is a kit .list-tools row holding #board-search", bt.tools, JSON.stringify(bt));
    eq("F2 · Mine|All|Unassigned, Mine pressed for an adviser", bt.scope, [["board-scope-mine", "true"], ["board-scope-all", "false"], ["board-scope-unassigned", "false"]]);
    eq("F3 · #board-adviser is a hidden compat select in step with the toggle (p2)", bt.compat, { hidden: true, v: "p2" });
    await pp.evaluate(() => [...document.querySelectorAll("#pipe-segment .seg-btn")].find((x) => x.dataset.seg === "current").click());
    await wait(pp, 1800);
    await pp.click("#board-scope-all");
    await wait(pp, 1400);
    const allState = await pp.evaluate(async () => {
      const book = (await window.__mockDb.from("cases").select("id,stage")).data || [];
      return { compat: document.querySelector("#board-adviser").value, pressed: document.querySelector("#board-scope-all").getAttribute("aria-pressed"),
        rows: document.querySelectorAll("#pipe-table .bulk-cb").length, stored: localStorage.getItem("nx_board_adviser_p2"),
        tab: (document.querySelector(".stage-tab.active") || {}).textContent };
    });
    ok("F4 · All writes the compat select, persists, and repaints the table", allState.compat === "all" && allState.pressed === "true" && allState.stored === "all" && allState.rows > 0, JSON.stringify(allState));
    const t0 = await pp.evaluate(() => {
      const wrap = document.querySelector("#table-wrap");
      const dock = document.querySelector("#pipe-bulk-dock");
      const sa = document.querySelector("#pipe-bulk-all");
      return {
        last: wrap.lastElementChild === dock, dockCls: dock && dock.className, h: dock ? dock.getBoundingClientRect().height : -1,
        selall: sa ? sa.closest(".list-selall") && sa.closest(".list-selall").textContent.trim() : null, inHead: !!(sa && sa.closest("#pipe-table-head")),
        rows: document.querySelectorAll("#pipe-table .bulk-cb").length,
        oldMenu: !!document.querySelector("#pipe-bulk-more-menu, .bulk-more-menu"),
      };
    });
    ok("F5 · the bar is in a .bulk-dock that is #table-wrap's LAST child", t0.last && /\bbulk-dock\b/.test(t0.dockCls || ""), JSON.stringify(t0));
    eq("F6 · …0px tall while nothing is ticked", t0.h, 0);
    ok("F7 · select-all is the kit line (#pipe-bulk-all in .list-selall, in the header strip), counting the rows", t0.inHead && t0.selall === `Select all ${t0.rows} shown`, JSON.stringify(t0));
    ok("F8 · the inline-styled More ▾ popover is gone", !t0.oldMenu);
    await pp.evaluate(() => { [...document.querySelectorAll("#pipe-table .bulk-cb")].slice(0, 3).forEach((cb) => { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }); });
    await wait(pp, 400);
    const t1 = await pp.evaluate(() => {
      const bar = document.querySelector("#pipe-bulk-bar"), dock = document.querySelector("#pipe-bulk-dock");
      const more = document.querySelector("#pipe-bulk-more");
      const r = dock.getBoundingClientRect();
      const visible = [...bar.children].filter((e) => e.offsetParent && (e.matches("select, .btn") && !e.matches(".bulk-clear")));
      return {
        n: document.querySelector("#pipe-bulk-n").textContent, hidden: bar.hidden, pos: getComputedStyle(dock).position, bottom: Math.round(r.bottom), vh: window.innerHeight,
        verbs: visible.map((e) => e.id), moreIsKit: !!more && more.matches("details.row-more"), moreClosed: !!more && !more.open,
        moreIds: more ? [...more.querySelectorAll(".row-more-body > .btn")].map((b) => b.id) : [], h: Math.round(bar.getBoundingClientRect().height),
        allIndet: document.querySelector("#pipe-bulk-all").indeterminate,
      };
    });
    ok("F9 · ticking three rows shows “3 selected”; the dock is sticky on the viewport's bottom", t1.n === "3" && !t1.hidden && t1.pos === "sticky" && Math.abs(t1.bottom - t1.vh) <= 2, JSON.stringify(t1));
    eq("F10 · ≤3 verbs on the bar: Move to stage… · Assign to… · ＋ Add task…", t1.verbs, ["pipe-bulk-stage", "pipe-bulk-adviser", "pipe-bulk-task"]);
    ok("F11 · More ▾ is the kit's <details class=row-more>, closed, holding the four send/chase verbs", t1.moreIsKit && t1.moreClosed && JSON.stringify(t1.moreIds) === JSON.stringify(["pipe-bulk-rate", "pipe-bulk-retention", "pipe-bulk-chase", "pipe-bulk-docs"]), JSON.stringify(t1));
    ok(`F12 · the bar is one row (${t1.h}px) and select-all reads indeterminate`, t1.h <= 60 && t1.allIndet === true, JSON.stringify(t1));
    await pp.click("#pipe-bulk-clear");
    await wait(pp, 300);
    eq("F13 · Clear folds the dock back to 0px", await pp.evaluate(() => document.querySelector("#pipe-bulk-dock").getBoundingClientRect().height), 0);
    // A colleague via the compat select (Reports' per-adviser door): ✕ chip, neither pressed.
    await pp.evaluate(() => window.reportGotoAdviser("p3"));
    await wait(pp, 1800);
    const pOther = await pp.evaluate(() => ({ pressed: [...document.querySelectorAll("#board-tools .list-scope .seg-btn")].map((b) => b.getAttribute("aria-pressed")), chip: (() => { const c = document.querySelector("#board-scope-other"); return c && !c.classList.contains("hidden") ? c.textContent : null; })() }));
    ok("F14 · a colleague's board presses no scope button and shows a “✕” chip", pOther.pressed.every((p) => p === "false") && /✕/.test(pOther.chip || ""), JSON.stringify(pOther));
    await pp.click("#board-scope-other");
    await wait(pp, 1200);
    eq("F15 · …which takes the board back to All", await pp.evaluate(() => document.querySelector("#board-adviser").value), "all");
    // board cards untouched: the board view still paints .card elements with their own stage move.
    await pp.evaluate(() => { pipelineSegment = "live"; pipelineView = "board"; loadPipeline(); });
    await wait(pp, 1600);
    ok("F16 · the board view still paints its cards (untouched by this slice)", await pp.evaluate(() => document.querySelectorAll("#board .card").length > 0));
    ok("§F · no console errors", realErrs(pp).length === pErr, JSON.stringify(realErrs(pp)));
    await pp.context().close();

    /* =====================================================================
       §G · phone
       ===================================================================== */
    console.log("\n— §G · phone 390×844: Clients controls ≥ 44px (p2)");
    const ph = await boot(browser, "p2", PHONE);
    const phErr = realErrs(ph).length;
    await goto(ph, "clients", 2200);
    await ph.evaluate(() => { const cb = document.querySelector("#client-list .client-cb"); if (cb) cb.click(); });
    await wait(ph, 500);
    const small = await ph.evaluate(() => {
      const sel = ["#client-search", "#cl-scope-mine", "#cl-scope-all", "#cl-sort", "#client-segment .seg-btn", "#client-bulk-all", "#client-list .client-cb", "#client-bulk-task", "#client-bulk-csv", "#client-bulk-clear"];
      const out = [];
      sel.forEach((s) => document.querySelectorAll(s).forEach((e) => { const r = e.getBoundingClientRect(); if (r.width && r.height < 43.5) out.push(`${s}:${Math.round(r.height)}`); }));
      return { out, doc: document.documentElement.scrollWidth, win: window.innerWidth, mine: document.querySelector("#cl-scope-mine").getAttribute("aria-pressed") };
    });
    eq("G1 · every Clients tools/chip/checkbox/bulk control is ≥ 44px tall on a phone", small.out, []);
    ok("G2 · no horizontal page scroll on the phone", small.doc <= small.win, JSON.stringify(small));
    eq("G3 · an adviser's Clients page opens on Mine", small.mine, "true");
    ok("§G · no console errors", realErrs(ph).length === phErr, JSON.stringify(realErrs(ph)));
    await ph.context().close();

    /* =====================================================================
       §H · no inline styles in the two regions
       ===================================================================== */
    console.log("\n— §H · no inline styles on the Clients page or the pipeline table (p4)");
    const pg = await boot(browser, "p4");
    const hErr = realErrs(pg).length;
    await goto(pg, "clients", 2000);
    const clientStyled = await pg.evaluate(() => [...document.querySelectorAll("#page-clients [style]")].map((e) => e.id || e.className));
    eq("H1 · the Clients page carries no style= attribute", clientStyled, []);
    await goto(pg, "pipeline", 2000);
    await pg.evaluate(() => [...document.querySelectorAll("#pipe-segment .seg-btn")].find((x) => x.dataset.seg === "current").click());
    await wait(pg, 1800);
    const tableStyled = await pg.evaluate(() => [...document.querySelectorAll("#table-wrap [style], #board-tools [style]")].map((e) => (e.id || e.className || e.tagName) + ":" + e.getAttribute("style")));
    eq("H2 · the pipeline table, its bar and the scope row carry no style= attribute", tableStyled, []);
    ok("§H · no console errors", realErrs(pg).length === hErr, JSON.stringify(realErrs(pg)));
    await pg.context().close();
  } catch (e) {
    failures.push("crash: " + (e && e.stack || e));
    console.log("CRASH", e);
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (_) { /* ignore */ }
  }
  console.log(`\nr88_book_b: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  FAIL: " + f)); process.exit(1); }
})();
