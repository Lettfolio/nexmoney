#!/usr/bin/env node
/* =============================================================================
   tests/r88_kit.js — acceptance tests for R88 slice F, the LIST KIT (R88-DESIGN §F,
   panel-r87/KIT.md). Each helper is rendered into a sandbox inside <main> on the mock page
   and its structure is read back from the live DOM — no HTML is pasted in here.

     §A  listToolsHtml    — .list-tools row; ids pass through verbatim (#client-search,
                            #ret-scope-mine, #cl-sort …); scope = .segment of aria-pressed
                            buttons with data-scope; sort = <select class="list-sort">.
     §B  segmentChipsHtml — .seg-strip of .seg-btn + .seg-count; aria-pressed follows the
                            active chip and flips on click; the page's data-seg is intact.
     §C  selectAllHtml / bulkBarHtml — the select-all line; ≤3 verbs visible on the bar,
                            the rest inside More ▾ (.row-more); Clear pinned; is-empty at 0.
     §D  dockBulkBar      — the bar sits in a .bulk-dock as the LAST child of the scroller,
                            its bottom on the scroller's bottom while scrolled; zero height
                            when empty; idempotent across renders.
     §E  rowItemHtml      — .row-item anatomy: checkbox · name (→ openClient) + ≤2 chips ·
                            one fact line · 📞 💬 via phoneActionsHtml (opt-out honoured) ·
                            ≤3 verbs + More ▾; desktop row height stays the Clients height.
     §F  PHONE (390×844)  — every kit control measures ≥ 44px tall.
     §G  emptyState is the kit's only empty state; the kit block is fenced; no console errors.
     §H  R88 · E kit gaps — the `attrs` map (escaped data-* + hidden) on rowItemHtml and
         segmentChipsHtml; the `moreCls` hook on both More ▾ menus; the 44px name hit area on
         .row-head > .t[onclick]; the row checkbox on the name's line (one kit rule, no page patch).

   Run:  node /root/nx/tests/r88_kit.js
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

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

async function boot(browser, persona, viewport) {
  const ctx = await browser.newContext({ viewport, locale: "en-GB", timezoneId: "Europe/London", hasTouch: viewport === PHONE, isMobile: viewport === PHONE });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  page.on("dialog", (d) => d.dismiss());
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(200);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));

/* The sandbox: a .panel inside <main>, on top of whatever page is showing, so the kit's rules
   (and the tap-target block, which is scoped to `main`) apply exactly as they will on a page. */
async function sandbox(page) {
  await page.evaluate(() => {
    let sb = document.querySelector("#kit-sandbox");
    if (!sb) {
      sb = document.createElement("div");
      sb.id = "kit-sandbox";
      sb.className = "panel";
      sb.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;z-index:9999;overflow:auto;background:#fff;padding:16px;";
      document.querySelector("main").appendChild(sb);
    }
    sb.innerHTML = "";
  });
}

/* One fixture, the same on every viewport: what a Clients-page consumer would pass. */
const FIXTURE = `({
  tools: {
    id: "client-tools",
    search: { id: "client-search", placeholder: "Search name, email…", value: "smi" },
    scope: { id: "ret-scope", value: "all", options: ["mine", "all"] },
    sort: { id: "cl-sort", value: "recent", options: [{ value: "az", label: "A–Z" }, { value: "recent", label: "Newest first" }] },
  },
  chips: { id: "client-segment", chips: [
    { key: "all", label: "All", count: 50, active: false },
    { key: "live", label: "Live", count: 12, active: true, title: "A case in flight" },
    { key: "cold", label: "Gone quiet", count: 7 },
    { key: "nodob", label: "Missing DOB" },
  ] },
  selall: { id: "client-bulk-all", count: 12 },
  bar: { id: "client-bulk", count: 3, verbs: [
    { id: "client-bulk-task", label: "＋ Add task…", onclick: "window.__kitHit='task'" },
    { id: "client-bulk-csv", label: "⭳ Export CSV", onclick: "window.__kitHit='csv'" },
    { id: "v3", label: "Assign to…" },
    { id: "v4", label: "Queue rate-end reminders" },
    { id: "v5", label: "Send document request" },
  ], more: [{ id: "v6", label: "Chase solicitors" }], clearId: "client-bulk-clear", onClear: "window.__kitHit='clear'" },
  row: { id: "c1", cb: { name: "client-cb", value: "c1", checked: true },
    name: { text: "Smith, Alice", clientId: "c1" },
    chips: [{ label: "Offer", cls: "blue", onclick: "window.__kitHit='case'", title: "Open the case" }, { label: "2 cases" }, { label: "third chip must not render" }],
    fact: "alice@example.com · rate ends 3 Mar 2027 · Halifax",
    contact: { phone: "07700 900123", first: "Alice", smsOptOut: false },
    verbs: [
      { id: "r-log", label: "📞 Log call", onclick: "window.__kitHit='log'" },
      { id: "r-book", label: "Book review" },
      { id: "r-open", label: "Open" },
      { id: "r-renew", label: "Renewed elsewhere" },
      { id: "r-sold", label: "Property sold" },
    ],
    sub: "<em>sub line</em>" },
  rowOptOut: { id: "c2", name: { text: "Jones, Bob", clientId: "c2" }, fact: "bob@example.com",
    contact: { phone: "07700 900456", first: "Bob", smsOptOut: true }, verbs: [{ label: "Open" }] },
})`;

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const kitSrc = fs.readFileSync(path.join(REPO, "admin", "app.js"), "utf8");
  const cssSrc = fs.readFileSync(path.join(REPO, "admin", "admin.css"), "utf8");
  try {
    const desk = await boot(browser, "p1", DESK);
    await sandbox(desk);

    /* =====================================================================
       §A · listToolsHtml
       ===================================================================== */
    console.log("\n— §A · listToolsHtml: one .list-tools row, ids verbatim, aria-pressed scope, sort select");
    {
      const r = await desk.evaluate((fx) => {
        const F = eval(fx);
        const sb = document.querySelector("#kit-sandbox");
        sb.innerHTML = listToolsHtml(F.tools);
        const root = sb.firstElementChild;
        const scope = root.querySelector(".segment");
        return {
          rootCls: root.className, rootId: root.id, kids: root.children.length,
          search: !!root.querySelector("#client-search"), searchVal: (root.querySelector("#client-search") || {}).value,
          searchType: (root.querySelector("#client-search") || {}).type, searchCls: (root.querySelector("#client-search") || {}).className,
          scopeRole: scope && scope.getAttribute("role"),
          btns: [...root.querySelectorAll(".segment > button")].map((b) => ({ id: b.id, scope: b.dataset.scope, pressed: b.getAttribute("aria-pressed"), active: b.classList.contains("scope-active"), cls: b.className, text: b.textContent.trim() })),
          sortId: (root.querySelector("select") || {}).id, sortCls: (root.querySelector("select") || {}).className, sortVal: (root.querySelector("select") || {}).value,
          sortOpts: [...root.querySelectorAll("select option")].map((o) => o.value),
          noTabs: !root.querySelector('[role="tab"], [role="tablist"]'),
          oneLine: (() => { const a = root.querySelector(".search").getBoundingClientRect(), b = root.querySelector("select").getBoundingClientRect(); return Math.abs(a.top - b.top) < 12; })(),
        };
      }, FIXTURE);
      ok("A1 · renders one .list-tools root carrying the caller's id", r.rootCls === "list-tools" && r.rootId === "client-tools", JSON.stringify([r.rootCls, r.rootId]));
      ok("A2 · search input keeps its id (#client-search), type=search, class .search, value passed through", r.search && r.searchType === "search" && /\bsearch\b/.test(r.searchCls) && r.searchVal === "smi");
      ok("A3 · scope is a .segment with role=group (never a tablist)", r.scopeRole === "group" && r.noTabs);
      ok("A4 · scope buttons carry the prefixed ids the suites pin (#ret-scope-mine / #ret-scope-all)", r.btns.map((b) => b.id).join() === "ret-scope-mine,ret-scope-all", JSON.stringify(r.btns));
      ok("A5 · exactly one scope button is aria-pressed=true and .scope-active — the value passed (all)", r.btns.filter((b) => b.pressed === "true").length === 1 && r.btns.find((b) => b.pressed === "true").scope === "all" && r.btns.every((b) => b.active === (b.pressed === "true")));
      ok("A6 · scope buttons wear the house classes (.btn.btn-sm.seg-btn, seg-first / seg-last) and data-scope", r.btns.every((b) => /\bbtn\b/.test(b.cls) && /\bseg-btn\b/.test(b.cls) && b.scope) && /seg-first/.test(r.btns[0].cls) && /seg-last/.test(r.btns[1].cls));
      ok("A7 · sort is <select class=\"list-sort\"> with the caller's id (#cl-sort), options and selected value", r.sortId === "cl-sort" && /list-sort/.test(r.sortCls) && r.sortVal === "recent" && r.sortOpts.join() === "az,recent");
      ok("A8 · search and sort sit on ONE line at 1440", r.oneLine);
      const r2 = await desk.evaluate(() => {
        const sb = document.querySelector("#kit-sandbox");
        sb.innerHTML = listToolsHtml({ id: "t2", scope: { id: "prot-scope", value: "unassigned", options: ["mine", "unassigned", "all"], labels: { all: "Everyone" } }, extra: '<span id="kit-extra">x</span>' });
        return { ids: [...sb.querySelectorAll("button")].map((b) => b.id), pressed: [...sb.querySelectorAll("button")].map((b) => b.getAttribute("aria-pressed")), labelAll: sb.querySelector("#prot-scope-all").textContent.trim(), extra: !!sb.querySelector("#kit-extra"), noSearch: !sb.querySelector("input"), noSort: !sb.querySelector("select") };
      });
      ok("A9 · three-way scope (Protection): #prot-scope-mine / -unassigned / -all, Unassigned pressed, custom label honoured", r2.ids.join() === "prot-scope-mine,prot-scope-unassigned,prot-scope-all" && r2.pressed.join() === "false,true,false" && r2.labelAll === "Everyone");
      ok("A10 · search and sort are optional; `extra` html is appended inside the row", r2.noSearch && r2.noSort && r2.extra);
    }

    /* =====================================================================
       §B · segmentChipsHtml
       ===================================================================== */
    console.log("\n— §B · segmentChipsHtml: .seg-strip / .seg-btn / .seg-count, aria-pressed, data-seg");
    {
      const r = await desk.evaluate((fx) => {
        const F = eval(fx);
        const sb = document.querySelector("#kit-sandbox");
        sb.innerHTML = segmentChipsHtml(F.chips);
        const strip = sb.firstElementChild;
        const chips = [...strip.querySelectorAll(".seg-btn")];
        window.__segHit = null;
        strip.addEventListener("click", (e) => { const b = e.target.closest("[data-seg]"); if (b) window.__segHit = b.dataset.seg; });
        chips[2].click();
        return {
          cls: strip.className, id: strip.id, role: strip.getAttribute("role"),
          n: chips.length, keys: chips.map((c) => c.dataset.seg), tags: chips.map((c) => c.tagName),
          counts: chips.map((c) => (c.querySelector(".seg-count") || {}).textContent),
          pressedNow: chips.map((c) => c.getAttribute("aria-pressed")), activeNow: chips.map((c) => c.classList.contains("active")),
          title: chips[1].title, hit: window.__segHit,
          oldFamily: !!strip.querySelector(".btn, .scope-active, .count"), noTabs: !strip.querySelector("[role=tab]"),
        };
      }, FIXTURE);
      ok("B1 · renders one .seg-strip[role=group] carrying the caller's id (#client-segment)", r.cls === "seg-strip" && r.id === "client-segment" && r.role === "group");
      ok("B2 · one .seg-btn <button> per chip, data-seg = key, in order", r.n === 4 && r.keys.join() === "all,live,cold,nodob" && r.tags.every((t) => t === "BUTTON"));
      ok("B3 · .seg-count pill shows the count; a chip with no count has no pill", r.counts.slice(0, 3).join() === "50,12,7" && r.counts[3] == null);
      ok("B4 · clicking a chip flips aria-pressed and .active to it inside the strip (was `live`, now `cold`)", r.pressedNow.join() === "false,false,true,false" && r.activeNow.join() === "false,false,true,false");
      ok("B5 · the page's own data-seg handler still fires (kit sets state, page owns behaviour)", r.hit === "cold");
      ok("B6 · title passes through; no role=tab; none of the retired .segment .btn.scope-active .count family", r.title === "A case in flight" && r.noTabs && !r.oldFamily);
      const r2 = await desk.evaluate(() => {
        const sb = document.querySelector("#kit-sandbox");
        sb.innerHTML = segmentChipsHtml({ id: "s2", chips: [{ key: "a", label: "A", active: true, id: "ret-month-2026-03" }, { key: "b", label: "B" }] });
        return { id: !!sb.querySelector("#ret-month-2026-03"), pressed: [...sb.querySelectorAll(".seg-btn")].map((c) => c.getAttribute("aria-pressed")).join() };
      });
      ok("B7 · a chip's own id passes through (Retention month chips keep their ids); active → aria-pressed=true", r2.id && r2.pressed === "true,false");
    }

    /* =====================================================================
       §C · selectAllHtml / bulkBarHtml
       ===================================================================== */
    console.log("\n— §C · selectAllHtml + bulkBarHtml: the select-all line; ≤3 verbs + More ▾ + Clear");
    {
      const r = await desk.evaluate((fx) => {
        const F = eval(fx);
        const sb = document.querySelector("#kit-sandbox");
        sb.innerHTML = selectAllHtml(F.selall) + bulkBarHtml(F.bar);
        const sa = sb.querySelector(".list-selall"), bar = sb.querySelector(".bulk-bar");
        const direct = [...bar.querySelectorAll(":scope > .btn, :scope > a.btn")];
        const more = bar.querySelector("details.row-more");
        const inMore = more ? [...more.querySelectorAll(".row-more-body .btn")] : [];
        const clear = bar.querySelector("#client-bulk-clear");
        const visibleVerbs = direct.filter((b) => b !== clear);
        const rects = { bar: bar.getBoundingClientRect(), clear: clear.getBoundingClientRect(), last: visibleVerbs[visibleVerbs.length - 1].getBoundingClientRect() };
        const hidden = inMore.map((b) => b.getBoundingClientRect().width === 0);
        more.open = true;
        const shownAfter = inMore.map((b) => b.getBoundingClientRect().width > 0);
        window.__kitHit = null; visibleVerbs[0].click(); const hit1 = window.__kitHit; clear.click(); const hit2 = window.__kitHit;
        return {
          sa: !!sa, saCb: !!sb.querySelector("#client-bulk-all"), saText: sa.textContent.trim(), saWrapId: sa.id,
          barId: bar.id, role: bar.getAttribute("role"), count: (bar.querySelector("#client-bulk-n") || {}).textContent, isEmpty: bar.classList.contains("is-empty"),
          visible: visibleVerbs.map((b) => b.id), inMore: inMore.map((b) => b.id), moreSummary: (more.querySelector("summary") || {}).textContent,
          clearIsLast: bar.lastElementChild === clear, clearRight: rects.bar.right - rects.clear.right < 40 && rects.clear.left - rects.last.right > 40,
          hidden, shownAfter, hit1, hit2,
        };
      }, FIXTURE);
      ok("C1 · selectAllHtml → .list-selall with the checkbox on the caller's id (#client-bulk-all) and 'Select all 12 shown'", r.sa && r.saCb && /Select all 12 shown/.test(r.saText) && r.saWrapId === "client-bulk-all-wrap");
      ok("C2 · bulkBarHtml → .bulk-bar[role=toolbar] with the caller's id, count in #<id>-n", r.barId === "client-bulk" && r.role === "toolbar" && r.count === "3" && !r.isEmpty);
      ok("C3 · exactly 3 verbs visible on the bar, in the order given, with their ids", r.visible.join() === "client-bulk-task,client-bulk-csv,v3", r.visible.join());
      ok("C4 · verbs 4+ AND the `more` list land inside ONE <details class=\"row-more\"> 'More ▾'", r.inMore.join() === "v4,v5,v6" && /More ▾/.test(r.moreSummary));
      ok("C5 · More ▾ verbs are hidden closed and shown once opened", r.hidden.every(Boolean) && r.shownAfter.every(Boolean));
      ok("C6 · Clear is the last control, on the caller's id (#client-bulk-clear), pinned to the right", r.clearIsLast && r.clearRight);
      ok("C7 · verb onclick and onClear expressions run", r.hit1 === "task" && r.hit2 === "clear");
      const r2 = await desk.evaluate(() => {
        const sb = document.querySelector("#kit-sandbox");
        sb.innerHTML = selectAllHtml({ id: "x-all", count: 0 }) + bulkBarHtml({ id: "x-bulk", count: 0, verbs: [{ label: "One" }, { label: "Two" }] });
        const bar = sb.querySelector(".bulk-bar");
        return { noSelAll: !sb.querySelector(".list-selall"), isEmpty: bar.classList.contains("is-empty"), vis: getComputedStyle(bar).visibility, noMore: !bar.querySelector(".row-more"), nId: !!sb.querySelector("#x-bulk-n"), clearId: !!sb.querySelector("#x-bulk-clear") };
      });
      ok("C8 · at count 0: no select-all line (R64 rule), the bar is .is-empty and visibility:hidden, ids derived from the bar id", r2.noSelAll && r2.isEmpty && r2.vis === "hidden" && r2.nId && r2.clearId);
      ok("C9 · ≤3 verbs → no More ▾ rendered at all", r2.noMore);
    }

    /* =====================================================================
       §D · dockBulkBar
       ===================================================================== */
    console.log("\n— §D · dockBulkBar: sticky at the bottom of the list's scroller, zero-height when empty, idempotent");
    {
      const r = await desk.evaluate((fx) => {
        const F = eval(fx);
        const sb = document.querySelector("#kit-sandbox");
        sb.innerHTML = `<div id="kit-list" style="height:320px;overflow:auto;border:1px solid #ccc;"></div>`;
        const list = sb.querySelector("#kit-list");
        list.innerHTML = Array.from({ length: 40 }, (_, i) => rowItemHtml({ id: "r" + i, name: { text: "Row " + i, clientId: "r" + i }, fact: "fact " + i })).join("") + bulkBarHtml({ ...F.bar, count: 0 });
        const bar = list.querySelector(".bulk-bar");
        const dock1 = dockBulkBar(list, bar);
        const emptyH = dock1.getBoundingClientRect().height;
        const emptyClass = dock1.classList.contains("is-empty");   // read now — dock2 is the same node
        const emptyRows = list.querySelectorAll(".row-item").length;
        const firstRowTop = list.querySelector(".row-item").getBoundingClientRect().top;
        // a selection appears
        bar.classList.remove("is-empty");
        const dock2 = dockBulkBar(list, bar);
        const firstRowTopAfter = list.querySelector(".row-item").getBoundingClientRect().top;
        const L = list.getBoundingClientRect(), B = bar.getBoundingClientRect();
        list.scrollTop = 900;
        const L2 = list.getBoundingClientRect(), B2 = bar.getBoundingClientRect();
        const dockCount = list.querySelectorAll(".bulk-dock").length;
        return {
          dockCls: dock1.className, sameDock: dock1 === dock2, dockCount, isLast: list.lastElementChild === dock2, rows: emptyRows,
          emptyH, emptyClass, firstRowSame: Math.abs(firstRowTop - firstRowTopAfter) < 1,
          filledH: dock2.getBoundingClientRect().height, notEmptyClass: dock2.classList.contains("is-empty"),
          bottomOn: Math.abs(B.bottom - L.bottom) <= 2, bottomOnScrolled: Math.abs(B2.bottom - L2.bottom) <= 2, scrolled: list.scrollTop > 500,
          sticky: getComputedStyle(dock2).position === "sticky", z: getComputedStyle(dock2).zIndex,
          shadow: getComputedStyle(bar).boxShadow !== "none",
        };
      }, FIXTURE);
      ok("D1 · wraps the bar in ONE .bulk-dock appended as the scroller's last child, rows untouched", /^bulk-dock/.test(r.dockCls) && r.isLast && r.dockCount === 1 && r.rows === 40);
      ok("D2 · empty bar → dock is .is-empty and 0px tall (nothing shifts on the first tick)", r.emptyClass && r.emptyH === 0 && r.firstRowSame, JSON.stringify([r.emptyClass, r.emptyH, r.firstRowSame]));
      ok("D3 · idempotent: a second call returns the same dock and adds nothing", r.sameDock);
      ok("D4 · with a selection the dock has height, sheds .is-empty, is position:sticky with a raised z-index and a top shadow", r.filledH > 30 && !r.notEmptyClass && r.sticky && Number(r.z) >= 10 && r.shadow, JSON.stringify([r.filledH, r.sticky, r.z]));
      ok("D5 · the bar's bottom edge sits on the scroller's bottom edge (±2px) at scrollTop 0", r.bottomOn);
      ok("D6 · … and stays there after scrolling 900px down the list", r.scrolled && r.bottomOnScrolled);
      const r2 = await desk.evaluate(() => {
        const list = document.querySelector("#kit-list");
        const bar = list.querySelector(".bulk-bar");
        bar.classList.add("is-empty");
        const noSync = list.querySelector(".bulk-dock").getBoundingClientRect().height;   // css :has() alone
        dockBulkBar("#kit-list", "#kit-list .bulk-bar");
        return { noSync, byId: list.querySelector(".bulk-dock").classList.contains("is-empty"), nul: dockBulkBar("#nope", bar) };
      });
      ok("D7 · back to empty: the dock collapses by CSS alone (:has) and dockBulkBar accepts selectors", r2.noSync === 0 && r2.byId, String(r2.noSync));
      ok("D8 · a missing list or bar returns null rather than throwing", r2.nul === null);
    }

    /* =====================================================================
       §E · rowItemHtml
       ===================================================================== */
    console.log("\n— §E · rowItemHtml: the Clients row anatomy");
    {
      const r = await desk.evaluate((fx) => {
        const F = eval(fx);
        const sb = document.querySelector("#kit-sandbox");
        sb.innerHTML = `<div class="panel" id="kit-rows">` + rowItemHtml(F.row) + rowItemHtml(F.rowOptOut) + `</div>`;
        const row = sb.querySelector(".row-item"), row2 = sb.querySelectorAll(".row-item")[1];
        const cb = row.querySelector("input[type=checkbox]");
        const t = row.querySelector(".row-main .t");
        const chips = [...row.querySelectorAll(".row-chips .badge")];
        const fact = row.querySelector(".row-main .s");
        const acts = row.querySelector(".row-acts");
        const visible = [...acts.querySelectorAll(":scope > .btn")];
        const more = acts.querySelector("details.row-more");
        const inMore = more ? [...more.querySelectorAll(".row-more-body .btn")] : [];
        window.__kitHit = null; visible[0].click(); const hitLog = window.__kitHit;
        window.__kitHit = null; chips[0].click(); const hitCase = window.__kitHit;
        const realOpen = window.openClient; let opened = null; window.openClient = (id) => { opened = id; };
        t.click(); window.openClient = realOpen;
        const rowRect = row.getBoundingClientRect();
        const plainRow = sb.querySelectorAll(".row-item")[1].getBoundingClientRect();
        return {
          cls: row.className, dataId: row.dataset.id, isSel: row.classList.contains("is-sel"),
          cb: cb && { cls: cb.className, id: cb.dataset.id, checked: cb.checked, aria: cb.getAttribute("aria-label"), first: row.firstElementChild === cb },
          tText: t.textContent.trim(), tOnclick: t.getAttribute("onclick"), opened,
          chips: chips.map((c) => ({ tag: c.tagName, text: c.textContent.trim(), cls: c.className })),
          factText: fact.textContent, factLines: Math.round(fact.getBoundingClientRect().height / 17),
          tel: !!fact.querySelector(".ret-row-tel a[href^='tel:']"), sms: !!fact.querySelector("a.row-sms-link[href^='sms:']"), smsBody: (fact.querySelector("a.row-sms-link") || { href: "" }).href,
          visible: visible.map((b) => b.id), inMore: inMore.map((b) => b.id), moreSummary: more && more.querySelector("summary").textContent.trim(),
          hitLog, hitCase, sub: (row.querySelector(".row-sub") || {}).innerHTML,
          h: plainRow.height, hSub: rowRect.height,
          r2: { optout: !!row2.querySelector(".row-sms-optout"), noSms: !row2.querySelector(".row-sms-link"), tel: !!row2.querySelector("a[href^='tel:']"), noCb: !row2.querySelector("input"), noMore: !row2.querySelector(".row-more"), verbs: row2.querySelectorAll(".row-acts .btn").length },
          esc: !/<script>/.test(rowItemHtml({ id: "z", name: { text: "<script>x</script>", clientId: "z" }, fact: "" })),
        };
      }, FIXTURE);
      ok("E1 · .row-item.kit-row with data-id, .is-sel when the checkbox is checked", /\brow-item\b/.test(r.cls) && /\bkit-row\b/.test(r.cls) && r.dataId === "c1" && r.isSel);
      ok("E2 · checkbox first: .bulk-cb + the caller's class family (client-cb), data-id, checked, aria-label names the row", r.cb && r.cb.first && /\bbulk-cb\b/.test(r.cb.cls) && /\bclient-cb\b/.test(r.cb.cls) && r.cb.id === "c1" && r.cb.checked && /Smith, Alice/.test(r.cb.aria));
      ok("E3 · the name is .row-main .t and opens the CLIENT (openClient(id)), never the case", r.tText === "Smith, Alice" && /^openClient\('c1'\)$/.test(r.tOnclick) && r.opened === "c1", r.tOnclick);
      ok("E4 · at most 2 chips, .badge, after the name; a chip with onclick is a <button> (the case chip)", r.chips.length === 2 && r.chips[0].tag === "BUTTON" && /\bblue\b/.test(r.chips[0].cls) && r.chips[1].tag === "SPAN" && r.hitCase === "case", JSON.stringify(r.chips));
      ok("E5 · ONE fact line (.row-main .s) carrying the caller's fact text", /alice@example.com · rate ends 3 Mar 2027 · Halifax/.test(r.factText) && r.factLines <= 1, String(r.factLines));
      ok("E6 · contact renders through phoneActionsHtml: tel: link + sms: deep link with the house body", r.tel && r.sms && /body=Hi%20Alice/.test(r.smsBody), r.smsBody.slice(0, 80));
      ok("E7 · sms opt-out honoured: 'no texts' instead of the 💬, the call stays", r.r2.optout && r.r2.noSms && r.r2.tel);
      ok("E8 · ≤3 verbs visible in .row-acts, in order, with ids; verbs 4–5 inside More ▾ (.row-more)", r.visible.join() === "r-log,r-book,r-open" && r.inMore.join() === "r-renew,r-sold" && /More ▾/.test(r.moreSummary));
      ok("E9 · a verb's onclick runs and does not bubble into the row", r.hitLog === "log" && r.opened === "c1");
      ok("E10 · `sub` html renders in .row-sub; text fields are escaped", /<em>sub line<\/em>/.test(r.sub) && r.esc);
      ok(`E11 · desktop row height is the Clients row height (${Math.round(r.h)}px, 55–66); a row with \`sub\` grows by one line`, r.h >= 55 && r.h <= 66 && r.hSub > r.h && r.hSub < r.h + 40, JSON.stringify([r.h, r.hSub]));
      ok("E12 · no checkbox / no More when not asked; 1 verb → 1 button", r.r2.noCb && r.r2.noMore && r.r2.verbs === 1);
    }

    /* =====================================================================
       §G (part 1) · the kit is the only kit; emptyState reused
       ===================================================================== */
    console.log("\n— §G · fenced block, emptyState reuse, one empty-state shape");
    {
      const start = kitSrc.indexOf("/* ===== R88 LIST KIT ====="), end = kitSrc.indexOf("/* ===== END R88 LIST KIT ===== */");
      ok("G1 · app.js carries ONE fenced /* ===== R88 LIST KIT ===== */ … END block near the top", start > 0 && end > start && start < 60000 && kitSrc.split("R88 LIST KIT =====").length === 3);
      const block = kitSrc.slice(start, end);
      ok("G2 · the six helpers are defined inside the fence", ["listToolsHtml", "segmentChipsHtml", "selectAllHtml", "bulkBarHtml", "dockBulkBar", "rowItemHtml"].every((f) => new RegExp(`function ${f}\\(`).test(block)));
      ok("G3 · the kit defines no empty state of its own (emptyState stays the one, outside the fence)", !/empty-state|class="empty"/.test(block) && /function emptyState\(/.test(kitSrc.slice(end)));
      ok("G4 · the kit knows no page: no page loader, no page id, no global selection set inside the fence", !/loadClients|loadRetention|loadProtection|renderPipeline|clientSel|pipeSel|protBulkSel|#page-/.test(block));
      ok("G5 · admin.css has ONE `R88 list kit` heading holding .list-tools / .seg-strip / .bulk-dock / .row-more, and the old R87 .row-more rules are gone", cssSrc.split("R88 list kit").length >= 2 && (() => { const i = cssSrc.indexOf("R88 list kit"); const tail = cssSrc.slice(i); return [".list-tools {", ".seg-strip {", ".bulk-dock {", ".row-more {"].every((s) => tail.includes(s)) && cssSrc.slice(0, i).indexOf(".row-more {") === -1; })());
      const r = await desk.evaluate(() => { const sb = document.querySelector("#kit-sandbox"); sb.innerHTML = emptyState({ headline: "No clients match", sub: "Try All.", action: { label: "Clear", onclick: "window.__kitHit='es'" } }); const b = sb.querySelector(".empty-state .btn"); window.__kitHit = null; b.click(); return { h: sb.querySelector(".empty-state-h").textContent, hit: window.__kitHit }; });
      ok("G6 · emptyState() renders the house shape a kit consumer uses", r.h === "No clients match" && r.hit === "es");
      ok("G7 · desktop: no console / page errors", realErrs(desk).length === 0, realErrs(desk).join(" | "));
    }

    /* =====================================================================
       §H · R88 · E — the kit gaps the consumers reported, closed in the kit
       ===================================================================== */
    console.log("\n— §H · attrs map (data-* + hidden), moreCls hook, name hit area, checkbox on the name line");
    {
      await sandbox(desk);
      const r = await desk.evaluate((fx) => {
        const F = eval(fx);
        const sb = document.querySelector("#kit-sandbox");
        sb.innerHTML = `<div class="panel" id="kit-rows">`
          + rowItemHtml({ ...F.row, moreCls: "hk-row-more", attrs: { client: "c1", monthKey: "3m", n: 0, skip: null, off: false, hidden: false, evil: 'a"><b x="1' } })
          + rowItemHtml({ id: "c9", name: { text: "Hidden, Row", clientId: "c9" }, fact: "x", attrs: { hidden: true } })
          + rowItemHtml({ ...F.rowOptOut, more: [{ label: "Archive" }], moreCls: 'x" onclick="window.__kitHit=1' })
          + `</div>`
          + segmentChipsHtml({ id: "hk-segs", chips: [
            { key: "12", label: "12 mo", attrs: { month: "12", hidden: true } },
            { key: "none", label: "No outcome", count: 3, active: true, attrs: { outcome: "none", n: "3" } },
            { key: "all", label: "All" },
          ] })
          + bulkBarHtml({ ...F.bar, moreCls: "hk-bar-more" }) + bulkBarHtml({ ...F.bar, id: "hk-bar2" });
        const row = sb.querySelector("#row-c1"), hid = sb.querySelector("#row-c9"), row2 = sb.querySelector("#row-c2");
        const chips = [...sb.querySelectorAll("#hk-segs .seg-btn")];
        const cb = row.querySelector(":scope > .bulk-cb").getBoundingClientRect(), main = row.querySelector(":scope > .row-main").getBoundingClientRect();
        return {
          data: { client: row.dataset.client, monthKey: row.getAttribute("data-month-key"), n: row.dataset.n, skip: row.hasAttribute("data-skip"), off: row.hasAttribute("data-off"), hidden: row.hidden, id: row.dataset.id },
          evil: { val: row.getAttribute("data-evil"), injected: row.hasAttribute("x") || !!row.querySelector("b[x]") },
          hidRow: hid.hidden && hid.offsetParent === null,
          chip0: { hidden: chips[0].hidden, month: chips[0].dataset.month, shown: chips[0].offsetParent !== null },
          chip1: { outcome: chips[1].dataset.outcome, n: chips[1].dataset.n, seg: chips[1].dataset.seg, pressed: chips[1].getAttribute("aria-pressed") },
          chip2: { anyData: [...chips[2].attributes].map((a) => a.name).filter((n) => n.startsWith("data-") && n !== "data-seg"), hidden: chips[2].hidden },
          rowMore: row.querySelector(".row-acts details.row-more").className,
          row2More: row2.querySelector("details.row-more").className, row2Onclick: row2.querySelector("details.row-more").getAttribute("onclick"),
          barMore: sb.querySelector("#client-bulk details.row-more").className,
          bar2More: sb.querySelector("#hk-bar2 details.row-more").className,
          cbTop: Math.round(cb.top), mainTop: Math.round(main.top),
          tPad: getComputedStyle(row.querySelector(".row-head > .t")).paddingTop,
        };
      }, FIXTURE);
      eq("H1 · rowItemHtml attrs → data-* (camelCase → kebab); null / false skipped; 0 kept; data-id untouched",
        r.data, { client: "c1", monthKey: "3m", n: "0", skip: false, off: false, hidden: false, id: "c1" });
      ok("H2 · attrs values are escaped: a quote-and-tag value stays one attribute value, nothing injected", r.evil.val === 'a"><b x="1' && !r.evil.injected, JSON.stringify(r.evil));
      ok("H3 · attrs.hidden: true renders the bare hidden attribute (the row is not shown)", r.hidRow);
      eq("H4 · segmentChipsHtml chip attrs: data-month + hidden on a folded chip", r.chip0, { hidden: true, month: "12", shown: false });
      eq("H5 · chip attrs sit beside the kit's own data-seg / aria-pressed", r.chip1, { outcome: "none", n: "3", seg: "none", pressed: "true" });
      ok("H6 · a chip with no attrs carries no extra data-* and is not hidden", r.chip2.anyData.length === 0 && !r.chip2.hidden, JSON.stringify(r.chip2));
      ok("H7 · rowItemHtml moreCls adds a class hook to its More ▾ <details>", r.rowMore === "row-more hk-row-more", r.rowMore);
      ok("H8 · bulkBarHtml moreCls adds a class hook to the bar's More ▾; without it the class is just row-more", r.barMore === "row-more hk-bar-more" && r.bar2More === "row-more", [r.barMore, r.bar2More].join(" | "));
      ok("H9 · moreCls is escaped (a quote cannot open an onclick)", /^row-more x" onclick="window.__kitHit=1$/.test(r.row2More) && r.row2Onclick === "event.stopPropagation()", JSON.stringify([r.row2More, r.row2Onclick]));
      ok("H10 · desktop: the row checkbox sits on the name's line (its top is the row-main's top), as on Clients", Math.abs(r.cbTop - r.mainTop) <= 2, JSON.stringify([r.cbTop, r.mainTop]));
      ok("H11 · desktop: the name carries no hit-area padding (the 44px rule is phone / coarse only)", r.tPad === "0px", r.tPad);
      const media = (cssSrc.match(/^@media \(max-width: 760px\), \(pointer: coarse\) \{[\s\S]*?\n\}/m) || [""])[0];
      ok("H12 · admin.css: the tap-target block gives `.row-head > .t[onclick]` the 44px hit area and keeps the checkbox on the name line — kit rules, no #client-list patch left",
        /main \.row-head > \.t\[onclick\]/.test(media) && /\.kit-row > \.bulk-cb \+ \.row-main \{ flex-basis: calc\(100% - 44px\)/.test(media) && !/#client-list \.kit-row/.test(cssSrc) && /\.row-item\.kit-row > \.bulk-cb \{ align-self: flex-start/.test(cssSrc));
      const block = kitSrc.slice(kitSrc.indexOf("/* ===== R88 LIST KIT ====="), kitSrc.indexOf("/* ===== END R88 LIST KIT ===== */"));
      ok("H13 · the attrs helper and the moreCls hook live inside the kit fence", /function kitDataAttrs\(/.test(block) && /moreCls/.test(block));
      ok("H14 · no consumer re-stamps kit markup after render (no dataset.client = / dataset.month = / dataset.outcome = writes)", !/\.dataset\.(client|month|outcome)\s*=[^=]/.test(kitSrc));

      /* R88 · fixer (10 D3) — THE 📞 / 💬 PAIR IS NEVER CLIPPED. The contact used to be appended to the
         one ellipsised nowrap fact line, so a long Retention fact pushed the pair out of the box on
         desktop (still in the DOM — a tel: count could not see it). It is its own non-shrinking
         .row-contact now; only the fact text takes the ellipsis. Measured on a row whose fact is far
         wider than the row, in a 900px list, with both the 💬 link and the opt-out marker. */
      const clip = await desk.evaluate((fx) => {
        const F = eval(fx);
        const sb = document.querySelector("#kit-sandbox");
        const long = "Test Bank C 1.94% — ends 31 Dec 2026 (in 3 months) · ERC 2% to 30 Nov 2026 · last contact 1 day ago (WK) · Loan £168,000 · a very long tail that cannot fit on one line at any desktop width whatsoever";
        sb.innerHTML = `<div class="panel" id="kit-rows" style="width:900px">`
          + rowItemHtml({ ...F.row, id: "cl1", fact: long })
          + rowItemHtml({ ...F.rowOptOut, id: "cl2", fact: long })
          + `</div>`;
        return [...sb.querySelectorAll(".kit-row")].map((row) => {
          const f = row.querySelector(".row-fact"), fr = f.getBoundingClientRect();
          const t = f.querySelector(".row-fact-t");
          const pair = [row.querySelector(".row-fact a[href^='tel:']"), row.querySelector(".row-fact a.row-sms-link, .row-fact .row-sms-optout")];
          return {
            inside: pair.every((el) => el && el.getBoundingClientRect().right <= fr.right + 0.5 && el.getBoundingClientRect().left >= fr.left - 0.5 && el.getBoundingClientRect().width > 0),
            oneLine: Math.round(fr.height) <= 24, textClipped: !!t && t.scrollWidth > t.clientWidth && getComputedStyle(t).textOverflow === "ellipsis",
            contactEl: !!f.querySelector(":scope > .row-contact"), text: f.textContent.slice(-40),
          };
        });
      }, FIXTURE);
      ok("H16 · desktop: with a fact far wider than the row, the 📞 link and the 💬 / 'no texts' sit INSIDE the fact box (not clipped)", clip.every((c) => c.inside), JSON.stringify(clip));
      ok("H17 · …the fact stays ONE line, and it is the fact text (.row-fact-t) that takes the ellipsis", clip.every((c) => c.oneLine && c.textClipped), JSON.stringify(clip));
      ok("H18 · …the pair is its own .row-contact element after the fact text", clip.every((c) => c.contactEl), JSON.stringify(clip));
    }
      ok("H15 · desktop after §H: no console / page errors", realErrs(desk).length === 0, realErrs(desk).join(" | "));
    await desk.context().close();

    /* =====================================================================
       §F · phone: 44px everything
       ===================================================================== */
    console.log("\n— §F · 390×844: every kit control ≥ 44px tall; the strip scrolls sideways");
    {
      const ph = await boot(browser, "p2", PHONE);
      await sandbox(ph);
      const r = await ph.evaluate((fx) => {
        const F = eval(fx);
        const sb = document.querySelector("#kit-sandbox");
        sb.innerHTML = listToolsHtml(F.tools) + segmentChipsHtml({ ...F.chips, chips: F.chips.chips.concat([{ key: "e", label: "Rate ends 2027", count: 9 }, { key: "f", label: "Overdue", count: 2 }, { key: "g", label: "Protection gap", count: 4 }]) }) + selectAllHtml(F.selall)
          + `<div class="panel" id="kit-rows">` + rowItemHtml(F.row) + `</div>` + bulkBarHtml(F.bar);
        const bar = sb.querySelector(".bulk-bar");
        dockBulkBar(sb.querySelector("#kit-rows"), bar);
        sb.querySelectorAll("details.row-more").forEach((d) => { d.open = true; });
        const h = (sel) => [...sb.querySelectorAll(sel)].map((el) => Math.round(el.getBoundingClientRect().height));
        const cbH = [...sb.querySelectorAll("input[type=checkbox]")].map((el) => Math.round(el.getBoundingClientRect().height));
        const cbW = [...sb.querySelectorAll("input[type=checkbox]")].map((el) => Math.round(el.getBoundingClientRect().width));   // R88 · fixer (10 D6)
        const strip = sb.querySelector(".seg-strip");
        const row = sb.querySelector(".row-item");
        return {
          search: h(".list-tools .search"), scope: h(".list-tools .seg-btn"), sort: h(".list-tools .list-sort"),
          chips: h(".seg-strip .seg-btn"), stripScrolls: strip.scrollWidth > strip.clientWidth + 5 && getComputedStyle(strip).overflowX === "auto",
          rowVerbs: h(".row-acts .btn"), rowMore: h(".row-acts .row-more > summary"), moreBody: h(".row-more-body .btn"),
          barBtns: h(".bulk-bar > .btn, .bulk-bar .row-more > summary, .bulk-bar .row-more-body .btn"),
          tel: h(".row-fact .ret-row-tel a"), sms: h(".row-fact a.row-sms-link"), cbs: cbH, cbW,
          noOverflow: document.documentElement.scrollWidth <= 390 && sb.scrollWidth <= sb.clientWidth + 1,
          rowW: row.getBoundingClientRect().width,
          nameH: Math.round(row.querySelector(".row-head > .t").getBoundingClientRect().height),
          cbMid: (() => { const b = row.querySelector(":scope > .bulk-cb").getBoundingClientRect(); return b.top + b.height / 2; })(),
          nameMid: (() => { const b = row.querySelector(".row-head > .t").getBoundingClientRect(); return b.top + b.height / 2; })(),
          cbRight: row.querySelector(":scope > .bulk-cb").getBoundingClientRect().right,
          mainLeft: row.querySelector(":scope > .row-main").getBoundingClientRect().left,
        };
      }, FIXTURE);
      const all44 = (arr) => arr.length > 0 && arr.every((v) => v >= 44);
      ok("F1 · search input ≥ 44px", all44(r.search), r.search.join());
      ok("F2 · Mine / All scope buttons ≥ 44px", all44(r.scope), r.scope.join());
      ok("F3 · sort select ≥ 44px", all44(r.sort), r.sort.join());
      ok("F4 · every segment chip ≥ 44px", all44(r.chips), r.chips.join());
      ok("F5 · seven chips overflow the width and the strip scrolls sideways rather than wrapping", r.stripScrolls);
      ok("F6 · row verbs, the row's More ▾ summary and its opened verbs ≥ 44px", all44(r.rowVerbs) && all44(r.rowMore) && all44(r.moreBody), [r.rowVerbs, r.rowMore, r.moreBody].join(" | "));
      ok("F7 · bulk-bar verbs, More ▾ and Clear ≥ 44px", all44(r.barBtns), r.barBtns.join());
      ok("F8 · 📞 and 💬 Text pills ≥ 44px (phoneActionsHtml's own pills)", all44(r.tel) && all44(r.sms), [r.tel, r.sms].join(" | "));
      ok("F9 · the select-all and row checkboxes ≥ 44px tall", all44(r.cbs), r.cbs.join());
      /* R88 · fixer (10 D6): was 24px wide — the height alone passed, the tap target did not. */
      ok("F9b · …and ≥ 44px WIDE (a 44×44 hit area; the 22px box is drawn centred in it)", all44(r.cbW), r.cbW.join());
      ok("F10 · nothing scrolls sideways at 390 (the page and the sandbox)", r.noOverflow && r.rowW <= 390);
      ok("F12 · R88 · E: the row's clickable name (.row-head > .t) is a ≥ 44px tap target", r.nameH >= 44, String(r.nameH));
      ok("F13 · R88 · E: the row checkbox shares the name's line (beside, not above, the row-main)", r.mainLeft >= r.cbRight && Math.abs(r.cbMid - r.nameMid) <= 12, JSON.stringify([r.cbRight, r.mainLeft, Math.round(r.cbMid), Math.round(r.nameMid)]));
      ok("F11 · phone: no console / page errors", realErrs(ph).length === 0, realErrs(ph).join(" | "));
      await ph.context().close();
    }
  } catch (e) {
    failures.push("HARNESS: " + (e && e.stack || e));
    console.log("  ✗ HARNESS: " + (e && e.stack || e));
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) { /* already gone */ } }
  }
  console.log(`\nR88 KIT: ${pass + failures.length} checks, ${failures.length} failures`);
  if (failures.length) { console.log(failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
})();
