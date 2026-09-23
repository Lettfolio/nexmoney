#!/usr/bin/env node
/* =============================================================================
   tests/r88_book_c.js — acceptance tests for R88 slice C: RETENTION + PROTECTION ON THE LIST KIT
   (R88-DESIGN §C, panel-r87/04-book-pages.md #3 #5 #6 #7, panel-r87/KIT.md).

     §A  RETENTION (p4, 1440×900) — the kit's tools row (#ret-search · #ret-scope-mine/-all ·
         #ret-sort with "Never contacted first" as a Sort option), ONE .seg-strip (#ret-segs:
         windows · outcomes · Gone quiet) whose counts equal an independent recount off the
         mock store, select-all + the kit bulk bar DOCKED at the bottom of #ret-rates-list,
         rows via rowItemHtml: the NAME opens the CLIENT (the case is a chip), ≤3 visible verbs.
     §B  GONE QUIET — the chip filters to exactly the coldClients() set (and the old panel is gone).
     §C  PROTECTION (p4 + p2) — no <table> in the list, ONE ROW PER CLIENT (no client id in two
         rows, every scope), chips (#prot-segs) = an independent recount of the RPC rows (distinct
         clients per predicate), the one count line agrees with the rows, rank chip, docked bar,
         the Status…/GI… selects live inside 📝 Log call, #prot-filter is a hidden compat select.
     §D  SMS OPT-OUT — with every client flagged, neither page renders a single sms: link.
     §E  GEOMETRY — first row ≤ 380px at 1440 (p4 + p2, both pages); every control ≥ 44px on a
         phone (390×844); ≤3 visible verbs on every row of both pages.
     §F  no console errors (ERR_TUNNEL font lines ignored).

   Expectations are computed at runtime off window.__mockDb — nothing about the fixture is pasted in.
   Run:  node /root/nx/tests/r88_book_c.js
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
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + String(detail).slice(0, 400) : ""}`); }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

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
  const vp = viewport || DESK;
  const ctx = await browser.newContext({ viewport: vp, locale: "en-GB", timezoneId: "Europe/London", hasTouch: vp === PHONE, isMobile: vp === PHONE });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  page.on("dialog", (d) => d.dismiss());
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.evaluate(() => { try { ["nx_ret_month", "nx_ret_sortdir", "nx_ret_untouched", "nx_ret_scope"].forEach((k) => localStorage.removeItem(k)); } catch (_) {} });
  await page.waitForTimeout(200);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));
async function goPage(page, name, ms) {
  await page.evaluate((n) => window.nav(n), name);
  await page.waitForTimeout(ms || 3000);
}
async function pressSeg(page, strip, key, ms) {
  await page.evaluate((o) => document.querySelector(`#${o.strip} .seg-btn[data-seg="${o.key}"]`).click(), { strip, key });
  await page.waitForTimeout(ms || 2200);
}

/* The independent recount of the Retention feed, off the store: v_alerts (rates inside the
   reminder window + ERC flags), minus a source whose retention successor is still live, scoped
   through cases.assigned_to, collapsed on (property, rate end date) — then bucketed by window. */
const RET_RECOUNT = async (scope) => {
  const all = async (t) => { const { data } = await window.__mockDb.from(t).select("*").range(0, 9999); return data || []; };
  const [alerts, cases] = await Promise.all([all("v_alerts"), all("cases")]);
  const months = Number(settings.rate_reminder_months) || 6;
  const live = new Set(cases.filter((c) => c.retention_source_case_id && !["completed", "not_proceeding"].includes(c.stage)).map((c) => c.id));
  const adv = {}; cases.forEach((c) => { adv[c.id] = c.assigned_to || null; });
  const byId = {}; cases.forEach((c) => { byId[c.id] = c; });
  const inScope = (a) => scope === "all" || (adv[a.case_id] !== undefined ? adv[a.case_id] : a.assigned_to) === ME.id;
  const soon = alerts.filter((a) => a.days_to_rate_end != null && a.days_to_rate_end <= months * 30 && !live.has(a.case_id) && inScope(a));
  const erc = alerts.filter((a) => a.erc_outlasts_rate && !live.has(a.case_id) && inScope(a));
  const merged = soon.slice(); const seenId = new Set(soon.map((a) => a.case_id));
  erc.forEach((a) => { if (!seenId.has(a.case_id)) { seenId.add(a.case_id); merged.push(a); } });
  const keys = new Set(); const rows = [];
  merged.forEach((a) => {
    const c = byId[a.case_id]; const pk = c ? propKey(c) : "";
    const k = pk ? pk + "|" + (a.rate_end_date || "") : "";
    if (k && keys.has(k)) return; if (k) keys.add(k); rows.push(a);
  });
  const now = new Date(); const tIdx = now.getFullYear() * 12 + now.getMonth();
  const mIdx = (d) => { const m = /^(\d{4})-(\d{2})/.exec(String(d || "")); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null; };
  const ended = (a) => a.days_to_rate_end != null && a.days_to_rate_end < 0;
  return {
    all: rows.length,
    ended12: rows.filter((a) => ended(a) && a.days_to_rate_end >= -366).length,
    this: rows.filter((a) => mIdx(a.rate_end_date) === tIdx).length,
    "3mo": rows.filter((a) => { const i = mIdx(a.rate_end_date); return i != null && i - tIdx >= 0 && i - tIdx <= 2; }).length,
  };
};
/* The independent recount of Protection's chips: the RPC's rows, the page's scope, each chip's
   predicate, DISTINCT clients. */
const PROT_RECOUNT = async (scope) => {
  const { data } = await window.__mockDb.rpc("get_protection_pipeline", { p_scope: "all" });
  const rows = (data || []).filter((r) => scope === "all" || (scope === "mine" ? r.owner === ME.id : r.owner == null));
  const GI = ["purchase", "ftb", "first_time_buyer", "btl", "buy_to_let", "remortgage"];
  const giApplies = (k) => typeof caseGiApplies === "function" ? caseGiApplies(k) : GI.includes(k);
  const preds = {
    all: () => true, live: (r) => r.live, completed: (r) => !r.live, quoted: (r) => r.protection_status === "quoted",
    nooutcome: (r) => !r.live, gi: (r) => giApplies(r.case_kind) && (r.gi_status || "not_discussed") === "not_discussed",
  };
  const out = {};
  Object.keys(preds).forEach((k) => { out[k] = new Set(rows.filter(preds[k]).map((r) => r.client_id)).size; });
  out.__cases = rows.length;
  return out;
};

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* ======================================================================
       §A · RETENTION ON THE KIT (p4, desktop)
       ====================================================================== */
    {
      console.log("\n— §A · Retention: tools row · one chip strip · docked bar · kit rows (p4, 1440)");
      const page = await boot(browser, "p4", DESK);
      const errBefore = realErrs(page).length;
      await goPage(page, "retention", 3600);

      const tools = await page.evaluate(() => {
        const t = document.querySelector("#page-retention .list-tools");
        return t ? {
          id: t.id,
          search: !!t.querySelector("input#ret-search.search"),
          mine: !!t.querySelector(".segment #ret-scope-mine.seg-btn[data-scope='mine']"),
          all: !!t.querySelector(".segment #ret-scope-all.seg-btn[data-scope='all']"),
          pressed: [...t.querySelectorAll(".segment .seg-btn")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.id),
          sort: !!t.querySelector("select#ret-sort.list-sort"),
          opts: [...document.querySelectorAll("#ret-sort option")].map((o) => o.value),
        } : null;
      });
      ok("A1 · the kit tools row renders on Retention (#ret-tools.list-tools)", !!tools && tools.id === "ret-tools", JSON.stringify(tools));
      ok("A1b · …with 🔍 #ret-search, Mine|All keeping #ret-scope-mine / #ret-scope-all, and #ret-sort", tools && tools.search && tools.mine && tools.all && tools.sort, JSON.stringify(tools));
      eq("A1c · exactly one scope is pressed — All for the owner", tools && tools.pressed, ["ret-scope-all"]);
      ok("A1d · the untouched toggle is a Sort option now (“untouched”), and its chip is gone",
        tools && tools.opts.includes("untouched") && tools.opts.includes("newest") && tools.opts.includes("oldest") && !(await page.$("#ret-untouched-btn")), JSON.stringify(tools && tools.opts));

      const strip = await page.evaluate(() => {
        const s = document.querySelector("#ret-month-chips > .seg-strip#ret-segs");
        if (!s) return null;
        const b = [...s.querySelectorAll(".seg-btn")];
        return {
          strips: document.querySelectorAll("#page-retention .seg-strip").length,
          keys: b.map((x) => x.dataset.seg),
          hidden: b.filter((x) => x.hidden).map((x) => x.dataset.seg),
          pressed: b.filter((x) => x.getAttribute("aria-pressed") === "true").map((x) => x.dataset.seg),
          counts: Object.fromEntries(b.map((x) => [x.dataset.seg, Number((x.querySelector(".seg-count") || {}).textContent)])),
          monthAttr: b.filter((x) => x.classList.contains("ret-month-chip")).every((x) => x.dataset.month === x.dataset.seg),
          outcomeAttr: b.filter((x) => x.classList.contains("ret-outcome-chip")).every((x) => x.dataset.outcome === x.dataset.seg && x.dataset.n === (x.querySelector(".seg-count") || {}).textContent),
          funnelTile: !!document.querySelector("#ret-outcome-funnel"),
          coldPanel: !!document.querySelector("#ret-cold-panel"),
        };
      });
      ok("A2 · ONE .seg-strip (#ret-segs) on the page", strip && strip.strips === 1, JSON.stringify(strip && strip.strips));
      ok("A2b · …holding the windows (R87 keys, incl. the three folded ones), the four outcomes and Gone quiet",
        strip && ["ended", "ended3", "ended12", "this", "next", "3mo", "all", "retained", "renewed_elsewhere", "sold", "none", "cold"].every((k) => strip.keys.includes(k)), JSON.stringify(strip && strip.keys));
      eq("A2c · the folded windows render hidden (ended · ended3 · next)", strip && strip.hidden, ["ended", "ended3", "next"]);
      eq("A2d · one chip pressed, and it names the list (the default window)", strip && strip.pressed, ["all"]);
      ok("A2e · the old keys ride on the buttons (data-month / data-outcome / data-n)", strip && strip.monthAttr && strip.outcomeAttr);
      ok("A2f · the funnel tile and the Gone-quiet panel are gone (both are chips)", strip && !strip.funnelTile && !strip.coldPanel);

      const recount = await page.evaluate(RET_RECOUNT, "all");
      ["all", "ended12", "this", "3mo"].forEach((k) => eq(`A3 · chip “${k}” count = the independent recount off v_alerts + cases`, strip && strip.counts[k], recount[k]));
      const rowsAll = await page.evaluate(() => document.querySelectorAll("#ret-rates-list .kit-row.ret-row").length);
      eq("A3b · the pressed chip's count = the rows on screen", rowsAll, Math.min(100, recount.all));
      const outcomeN = await page.evaluate(() => {
        const n = Number(document.querySelector('#ret-segs .seg-btn[data-seg="none"] .seg-count').textContent);
        return n;
      });
      await pressSeg(page, "ret-segs", "none");
      const noneRows = await page.evaluate(() => ({
        rows: document.querySelectorAll("#ret-rates-list .kit-row.ret-row").length,
        pressed: [...document.querySelectorAll("#ret-segs .seg-btn")].filter((x) => x.getAttribute("aria-pressed") === "true").map((x) => x.dataset.seg),
        outcomes: [...document.querySelectorAll("#ret-rates-list .kit-row")].map((r) => (r.querySelector(".ret-row-outcome") || {}).dataset?.outcome || "none"),
      }));
      eq("A3c · the No-outcome chip: its count = its rows (a rate still in the feed can always be shown)", noneRows.rows, outcomeN);
      ok("A3d · …one chip pressed, and every row has no outcome recorded", JSON.stringify(noneRows.pressed) === '["none"]' && noneRows.outcomes.every((o) => o === "none"), JSON.stringify(noneRows));
      await pressSeg(page, "ret-segs", "all");

      // Docked bar + select-all
      const dock = await page.evaluate(() => {
        const list = document.querySelector("#ret-rates-list");
        const d = list.lastElementChild;
        const bar = document.querySelector("#ret-bulk-bar");
        return {
          last: !!d && d.classList.contains("bulk-dock") && d.contains(bar),
          empty: bar && bar.classList.contains("is-empty"),
          h: d ? Math.round(d.getBoundingClientRect().height) : -1,
          selall: !!document.querySelector("#ret-rates-list > .list-selall input#ret-bulk-all"),
          selallAboveRows: (() => { const s = document.querySelector("#ret-bulk-all-wrap"), r = document.querySelector("#ret-rates-list .kit-row"); return !!(s && r && s.getBoundingClientRect().top < r.getBoundingClientRect().top); })(),
          verbs: [...(bar ? bar.querySelectorAll(":scope > .btn:not(.bulk-clear)") : [])].map((b) => b.id),
        };
      });
      ok("A4 · the bulk bar is the kit's, in a .bulk-dock that is the LAST child of #ret-rates-list", dock.last, JSON.stringify(dock));
      ok("A4b · …zero-height and .is-empty while nothing is ticked", dock.empty && dock.h === 0, JSON.stringify(dock));
      ok("A4c · “Select all N shown” (#ret-bulk-all) sits directly above the rows", dock.selall && dock.selallAboveRows, JSON.stringify(dock));
      eq("A4d · ≤3 verbs on the bar, the R64 ids kept", dock.verbs, ["ret-bulk-rate", "ret-bulk-retention", "ret-bulk-task"]);
      await page.evaluate(() => { const cb = document.querySelector("#ret-rates-list .ret-cb"); cb.click(); });
      await page.waitForTimeout(300);
      const ticked = await page.evaluate(() => {
        const bar = document.querySelector("#ret-bulk-bar"), dk = bar.parentElement;
        const r = bar.getBoundingClientRect();
        return { n: document.querySelector("#ret-bulk-n").textContent, empty: bar.classList.contains("is-empty"), dockEmpty: dk.classList.contains("is-empty"), bottom: Math.round(r.bottom), vh: innerHeight, h: Math.round(r.height), sticky: getComputedStyle(dk).position };
      });
      ok("A4e · ticking a row fills the bar in place (1 selected), docked sticky at the bottom of the viewport",
        ticked.n === "1" && !ticked.empty && !ticked.dockEmpty && ticked.sticky === "sticky" && ticked.h > 0 && ticked.bottom <= ticked.vh + 1, JSON.stringify(ticked));
      await page.click("#ret-bulk-clear");
      await page.waitForTimeout(200);
      ok("A4f · Clear empties it again", await page.evaluate(() => document.querySelector("#ret-bulk-bar").classList.contains("is-empty") && !document.querySelector("#ret-rates-list .ret-cb:checked")));

      // Rows: name → client; the case a chip; ≤3 verbs
      const rowShape = await page.evaluate(async () => {
        const rows = [...document.querySelectorAll("#ret-rates-list .kit-row.ret-row")];
        const { data: cases } = await window.__mockDb.from("cases").select("id,client_id").range(0, 9999);
        const owner = Object.fromEntries((cases || []).map((c) => [c.id, c.client_id]));
        return rows.map((r) => {
          const cb = r.querySelector(".ret-cb");
          const t = r.querySelector(".row-head > .t");
          const m = /openClient\('([^']+)'\)/.exec(t.getAttribute("onclick") || "");
          return {
            caseId: cb && cb.dataset.id,
            clientOk: !!m && m[1] === owner[cb && cb.dataset.id],
            caseChip: !!r.querySelector(`.row-chips .row-chip[onclick*="openCase('${cb && cb.dataset.id}')"]`),
            chips: r.querySelectorAll(".row-chips > *").length,
            verbs: r.querySelectorAll(".row-acts > .btn").length,
            factLines: r.querySelectorAll(".row-fact").length,
          };
        });
      });
      ok("A5 · every Retention row's NAME opens the CLIENT who owns that case", rowShape.length > 0 && rowShape.every((r) => r.clientOk), JSON.stringify(rowShape.filter((r) => !r.clientOk).slice(0, 3)));
      ok("A5b · …and the case is a chip that opens the case", rowShape.every((r) => r.caseChip && r.chips <= 2), JSON.stringify(rowShape.filter((r) => !r.caseChip).slice(0, 3)));
      ok("A5c · ≤ 3 visible verbs on every row (the rest in More ▾), one fact line", rowShape.every((r) => r.verbs <= 3 && r.factLines === 1), JSON.stringify(rowShape.map((r) => r.verbs)));
      await page.evaluate(() => { window.__oc = []; const o = window.openClient; window.openClient = function (id) { window.__oc.push(id); return o.apply(this, arguments); }; });
      const target = rowShape[0];
      await page.click(`#ret-rates-list .kit-row[data-id="ret-${target.caseId}"] .row-head > .t`);
      await page.waitForTimeout(1200);
      const opened = await page.evaluate(async (caseId) => {
        const { data: c } = await window.__mockDb.from("cases").select("client_id").eq("id", caseId).single();
        return { calls: window.__oc, want: c.client_id, modal: !document.querySelector("#modal-backdrop").classList.contains("hidden") };
      }, target.caseId);
      ok("A5d · clicking the name opens THE CLIENT (openClient with the case's client id) and the record modal", opened.calls[0] === opened.want && opened.modal, JSON.stringify(opened));
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
      await page.waitForTimeout(400);

      // Sort: "Never contacted first" is an option that re-orders and never hides
      const before = await page.evaluate(() => [...document.querySelectorAll("#ret-rates-list .ret-cb")].map((c) => c.dataset.id).sort());
      await page.selectOption("#ret-sort", "untouched");
      await page.waitForTimeout(2600);
      const after = await page.evaluate(() => ({ ids: [...document.querySelectorAll("#ret-rates-list .ret-cb")].map((c) => c.dataset.id).sort(), v: document.querySelector("#ret-sort").value, ls: localStorage.getItem("nx_ret_untouched") }));
      ok("A6 · Sort › Never contacted first re-orders and hides nothing (same row set), remembered in nx_ret_untouched",
        JSON.stringify(after.ids) === JSON.stringify(before) && after.v === "untouched" && after.ls === "1", JSON.stringify({ n: after.ids.length, v: after.v, ls: after.ls }));
      await page.selectOption("#ret-sort", "newest");
      await page.waitForTimeout(2200);

      // Search narrows
      const firstName = await page.evaluate(() => document.querySelector("#ret-rates-list .kit-row .t").textContent.trim());
      await page.fill("#ret-search", firstName);
      await page.waitForTimeout(2400);
      const searched = await page.evaluate(() => [...document.querySelectorAll("#ret-rates-list .kit-row .t")].map((t) => t.textContent.trim()));
      ok("A7 · the search narrows the list to that client", searched.length >= 1 && searched.every((n) => n === firstName), JSON.stringify(searched));
      await page.fill("#ret-search", "zzqq-nobody");
      await page.waitForTimeout(2400);
      ok("A7b · a search that finds nobody is the house emptyState, with the way out", await page.evaluate(() => !!document.querySelector("#ret-rates-list .empty-state #ret-empty-clear") && !document.querySelector("#page-retention .empty")));
      await page.click("#ret-empty-clear");
      await page.waitForTimeout(2400);
      ok("§A · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page).slice(errBefore)));
      await page.close();
    }

    /* ======================================================================
       §B · GONE QUIET IS THE CLIENTS COLD CHIP
       ====================================================================== */
    for (const persona of ["p4", "p2"]) {
      console.log(`\n— §B · the Gone quiet chip = coldClients() (${persona})`);
      const page = await boot(browser, persona, DESK);
      const errBefore = realErrs(page).length;
      await goPage(page, "retention", 3600);
      const want = await page.evaluate(async () => {
        const data = await clientDataCached();
        const adviser = retScopeResolved() === "mine" && ME && ME.id ? ME.id : "all";
        return coldClients(data, adviser).map((c) => c.id).sort();
      });
      const chipN = await page.evaluate(() => Number(document.querySelector('#ret-segs .seg-btn[data-seg="cold"] .seg-count').textContent));
      await pressSeg(page, "ret-segs", "cold", 2400);
      const got = await page.evaluate(() => ({
        ids: [...document.querySelectorAll("#ret-cold-list .kit-row .row-head > .t")].map((t) => (/openClient\('([^']+)'\)/.exec(t.getAttribute("onclick") || "") || [])[1]).sort(),
        pressed: [...document.querySelectorAll("#ret-segs .seg-btn")].filter((x) => x.getAttribute("aria-pressed") === "true").map((x) => x.dataset.seg),
        rates: document.querySelectorAll("#ret-rates-list .ret-row").length,
        goto: !!document.querySelector("#ret-cold-goto"),
        verbs: [...document.querySelectorAll("#ret-cold-list .kit-row")].map((r) => r.querySelectorAll(".row-acts > .btn").length),
      }));
      eq(`B1 · the chip's count = coldClients() for this scope (${want.length})`, chipN, want.length);
      eq("B2 · pressing it lists EXACTLY the coldClients() set, one row per client", got.ids, want.slice(0, 100));
      ok("B3 · …in place of the rate rows, with the chip pressed and the hand-off to Clients kept", got.rates === 0 && JSON.stringify(got.pressed) === '["cold"]' && got.goto, JSON.stringify(got));
      ok("B4 · ≤ 3 verbs on every Gone-quiet row", got.verbs.every((n) => n <= 3), JSON.stringify(got.verbs));
      await pressSeg(page, "ret-segs", "cold", 2400);
      ok("B5 · pressing it again returns to the rate window", await page.evaluate(() => document.querySelectorAll("#ret-rates-list .ret-row").length > 0 && !document.querySelector("#ret-cold-list")));
      ok("§B · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page).slice(errBefore)));
      await page.close();
    }

    /* ======================================================================
       §C · PROTECTION: ONE ROW PER CLIENT, ON THE KIT
       ====================================================================== */
    for (const persona of ["p4", "p2"]) {
      console.log(`\n— §C · Protection on the kit (${persona})`);
      const page = await boot(browser, persona, DESK);
      const errBefore = realErrs(page).length;
      await goPage(page, "protection", 3600);
      const tools = await page.evaluate(() => {
        const t = document.querySelector("#page-protection .list-tools#prot-tools");
        return t ? { search: !!t.querySelector("#prot-search"), scopes: [...t.querySelectorAll(".segment .seg-btn")].map((b) => b.id), sort: !!t.querySelector("select") } : null;
      });
      ok("C1 · the kit tools row renders (#prot-tools): search + Mine|Unassigned|All, ids kept", !!tools && tools.search && JSON.stringify(tools.scopes) === '["prot-scope-mine","prot-scope-unassigned","prot-scope-all"]', JSON.stringify(tools));
      const shape = await page.evaluate(() => ({
        tables: document.querySelectorAll("#prot-table table").length,
        oldTable: !!document.querySelector("#prot-list-table"),
        bands: !!document.querySelector("#prot-calllist-panel, #prot-gi-panel"),
        tiles: document.querySelectorAll("#page-protection .kpi").length,
        strip: !!document.querySelector("#prot-chips > .seg-strip#prot-segs"),
        compat: (() => { const s = document.querySelector("#prot-filter"); if (!s) return null; const r = s.getBoundingClientRect(); return { hidden: s.getAttribute("aria-hidden") === "true" && s.tabIndex === -1 && r.width <= 1 && r.height <= 1, v: s.value }; })(),
      }));
      eq("C2 · Protection's list has NO <table>", shape.tables, 0);
      ok("C2b · …the two bands and the three KPI tiles are gone; the chips are one .seg-strip (#prot-segs)", !shape.oldTable && !shape.bands && shape.tiles === 0 && shape.strip, JSON.stringify(shape));
      ok("C2c · #prot-filter survives as a visually-hidden compat select (aria-hidden, untabbable, 1px)", !!shape.compat && shape.compat.hidden === true, JSON.stringify(shape.compat));

      for (const sc of ["mine", "unassigned", "all"]) {
        await page.click(`#prot-scope-${sc}`);
        await page.waitForTimeout(900);
        const got = await page.evaluate(() => {
          const ids = [...document.querySelectorAll("#prot-list .kit-row.prot-row .row-head > .t")].map((t) => (/openClient\('([^']+)'\)/.exec(t.getAttribute("onclick") || "") || [])[1] || t.textContent);
          const chips = Object.fromEntries([...document.querySelectorAll("#prot-segs .seg-btn")].map((b) => [b.dataset.seg, Number((b.querySelector(".seg-count") || {}).textContent)]));
          return {
            ids, dupes: ids.filter((x, i) => ids.indexOf(x) !== i),
            chips, count: Number((document.getElementById("prot-kpi-count") || {}).textContent),
            line: (document.getElementById("prot-cap-line") || {}).textContent || "",
            pressed: document.querySelector("#prot-segs .seg-btn[aria-pressed='true']")?.dataset.seg,
            verbs: [...document.querySelectorAll("#prot-list .kit-row")].map((r) => r.querySelectorAll(".row-acts > .btn").length),
            ranks: [...document.querySelectorAll("#prot-list .kit-row .prot-rank")].map((e) => Number(e.textContent.replace("#", ""))),
          };
        });
        const want = await page.evaluate(PROT_RECOUNT, sc);
        eq(`C3 · ${sc}: no client id appears in two rows`, got.dupes, []);
        eq(`C3b · ${sc}: every chip count = the recount off the RPC rows (distinct clients per predicate)`,
          ["all", "live", "completed", "quoted", "nooutcome", "gi"].map((k) => got.chips[k]), ["all", "live", "completed", "quoted", "nooutcome", "gi"].map((k) => want[k]));
        ok(`C3c · ${sc}: the one count line's client count IS the rows on screen, and names the cases in them`,
          got.count === got.ids.length && got.ids.length === want.all && new RegExp(`${want.__cases} opportunit`).test(got.line), JSON.stringify({ count: got.count, rows: got.ids.length, want: want.all, line: got.line.slice(0, 120) }));
        ok(`C3d · ${sc}: ≤ 3 visible verbs per row; the rank chip ascends`, got.verbs.every((n) => n <= 3) && got.ranks.every((r, i) => i === 0 || r > got.ranks[i - 1]), JSON.stringify({ v: got.verbs, r: got.ranks }));
      }
      // A chip narrows, the compat select follows, and the line agrees
      await page.click("#prot-scope-all"); await page.waitForTimeout(800);
      await pressSeg(page, "prot-segs", "nooutcome", 900);
      const no = await page.evaluate(() => ({
        rows: document.querySelectorAll("#prot-list .kit-row").length,
        chip: Number(document.querySelector('#prot-segs .seg-btn[data-seg="nooutcome"] .seg-count').textContent),
        compat: document.querySelector("#prot-filter").value,
        allCompleted: [...document.querySelectorAll("#prot-list .kit-row .prot-case-chip")].every((c) => /^Completed/.test(c.textContent)),
      }));
      ok("C4 · the “Completed, no outcome” chip shows exactly its count, completed cases only, and #prot-filter follows", no.rows === no.chip && no.allCompleted && no.compat === "nooutcome", JSON.stringify(no));
      await page.selectOption("#prot-filter", "all");
      await page.waitForTimeout(900);
      ok("C4b · …and the hidden compat select still drives the list (suites use it)", await page.evaluate(() => document.querySelector("#prot-segs .seg-btn[aria-pressed='true']").dataset.seg === "all"));

      // Rows: name → client, case chip, docked bar
      const rows = await page.evaluate(() => [...document.querySelectorAll("#prot-list .kit-row")].map((r) => ({
        name: /^openClient\(/.test(r.querySelector(".row-head > .t").getAttribute("onclick") || ""),
        caseChip: !!r.querySelector(".row-chips .row-chip[onclick^=\"event.stopPropagation();openCase(\"]"),
        cases: r.querySelectorAll(".row-fact .prot-fact-case").length,
      })));
      ok("C5 · every Protection row's name opens the client; the top case is a chip; the fact line names its cases", rows.length > 0 && rows.every((r) => r.name && r.caseChip && r.cases >= 1), JSON.stringify(rows.slice(0, 3)));
      const dock = await page.evaluate(() => {
        const list = document.querySelector("#prot-list"), d = list.lastElementChild, bar = document.querySelector("#prot-bulk-bar");
        return { last: d.classList.contains("bulk-dock") && d.contains(bar), empty: bar.classList.contains("is-empty"), selall: !!document.querySelector("#prot-list > .list-selall #prot-bulk-all"), status: !!bar.querySelector("#prot-bulk-status"), intro: !!bar.querySelector("#prot-bulk-intro") };
      });
      ok("C6 · select-all + the kit bulk bar docked as the list's last child (status select + intro kept)", dock.last && dock.empty && dock.selall && dock.status && dock.intro, JSON.stringify(dock));
      await page.evaluate(() => document.querySelector("#prot-list .prot-cb").click());
      await page.waitForTimeout(300);
      const tick = await page.evaluate(() => ({ n: document.querySelector("#prot-bulk-n").textContent, empty: document.querySelector("#prot-bulk-bar").classList.contains("is-empty"), sel: protBulkSel.size }));
      ok("C6b · ticking a client row selects that client (bar: 1) and all its cases in view", tick.n === "1" && !tick.empty && tick.sel >= 1, JSON.stringify(tick));
      await page.click("#prot-bulk-clear"); await page.waitForTimeout(200);

      // Log call carries the status selects
      await page.evaluate(() => { const b = document.querySelector("#prot-list .kit-row .row-acts .prot-logcall"); b.click(); });
      await page.waitForTimeout(1400);
      const ov = await page.evaluate(() => {
        const box = document.querySelector("#overlay-modal");
        return { panel: !!box.querySelector("#prot-logcall-panel"), prot: !!box.querySelector("select#prot-logcall-prot.prot-status-set"), opts: [...box.querySelectorAll("#prot-logcall-prot option")].map((o) => o.value) };
      });
      ok("C7 · 📝 Log call opens the one log-call overlay (#prot-logcall-panel) WITH the protection status select", ov.panel && ov.prot && ov.opts.includes("policy_taken"), JSON.stringify(ov));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      ok("§C · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page).slice(errBefore)));
      await page.close();
    }

    /* ======================================================================
       §D · SMS OPT-OUT ON BOTH PAGES
       ====================================================================== */
    {
      console.log("\n— §D · no sms: link for an opted-out client, on either page (p4)");
      const page = await boot(browser, "p4", DESK);
      const errBefore = realErrs(page).length;
      await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id").range(0, 9999);
        for (const c of data || []) await window.__mockDb.from("clients").update({ sms_opt_out: true }).eq("id", c.id);
      });
      await goPage(page, "dashboard", 2000);
      await goPage(page, "retention", 3600);
      const ret = await page.evaluate(() => ({ sms: document.querySelectorAll("#page-retention a[href^='sms']").length, tel: document.querySelectorAll("#ret-rates-list a[href^='tel:']").length, markers: document.querySelectorAll("#ret-rates-list .row-sms-optout").length }));
      ok("D1 · Retention: every client flagged → ZERO sms: links, the call kept, “no texts” said", ret.sms === 0 && ret.tel > 0 && ret.markers === ret.tel, JSON.stringify(ret));
      await pressSeg(page, "ret-segs", "cold", 2400);
      const cold = await page.evaluate(() => ({ sms: document.querySelectorAll("#ret-cold-list a[href^='sms']").length, rows: document.querySelectorAll("#ret-cold-list .kit-row").length }));
      eq("D2 · …and on the Gone-quiet list", cold.sms, 0);
      await goPage(page, "protection", 3600);
      await page.click("#prot-scope-all"); await page.waitForTimeout(900);
      const prot = await page.evaluate(() => ({ sms: document.querySelectorAll("#page-protection a[href^='sms']").length, tel: document.querySelectorAll("#prot-list a[href^='tel:']").length, markers: document.querySelectorAll("#prot-list .row-sms-optout").length }));
      ok("D3 · Protection: ZERO sms: links, the call kept, “no texts” said", prot.sms === 0 && prot.tel > 0 && prot.markers === prot.tel, JSON.stringify(prot));
      ok("§D · no console errors", realErrs(page).length === errBefore, JSON.stringify(realErrs(page).slice(errBefore)));
      await page.close();
    }

    /* ======================================================================
       §E · GEOMETRY — first row at 1440, 44px on a phone
       ====================================================================== */
    for (const persona of ["p4", "p2"]) {
      console.log(`\n— §E · first row ≤ 380px at 1440×900 (${persona})`);
      const page = await boot(browser, persona, DESK);
      await goPage(page, "retention", 3600);
      const r = await page.evaluate(() => { const e = document.querySelector("#ret-rates-list .kit-row"); return e ? Math.round(e.getBoundingClientRect().top) : null; });
      ok(`E1 · Retention: the first row's top is ≤ 380px (${r})`, r != null && r <= 380, String(r));
      /* R88 · fixer (10 4c) — the nine-chip strip is one line at 1440 again (it wrapped: 370). */
      const stripH = await page.evaluate(() => Math.round(document.querySelector("#ret-segs").getBoundingClientRect().height));
      ok(`E1b · Retention: the chip strip is ONE line at 1440 (${stripH}px) and the first row is back at ≤ 350px (${r})`, stripH <= 44 && r != null && r <= 350, JSON.stringify([stripH, r]));
      /* R88 · fixer (10 D3) — the dial pair is INSIDE the fact box on every row that has a number
         (the kit used to append it to the ellipsised fact, clipping it off 10 of 15 rows at 1440). */
      const clipOf = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((r) => r.checkVisibility() && r.querySelector(".row-fact a[href^='tel:']")).map((r) => {
        const fr = r.querySelector(".row-fact").getBoundingClientRect();
        const pair = [r.querySelector(".row-fact a[href^='tel:']"), r.querySelector(".row-fact a[href^='sms:'], .row-fact .row-sms-optout")];
        return pair.every((el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right <= fr.right + 0.5);
      }), sel);
      if (persona === "p4") { await page.click("#ret-scope-all"); await page.waitForTimeout(2500); }
      const retClip = await clipOf("#ret-rates-list .kit-row");
      ok(`E4 · Retention (${persona === "p4" ? "All" : "Mine"}): 📞 and 💬 / 'no texts' inside the fact box on every row with a number (${retClip.filter(Boolean).length}/${retClip.length})`, retClip.length > 0 && retClip.every(Boolean), JSON.stringify(retClip));
      await goPage(page, "protection", 3600);
      const p = await page.evaluate(() => { const e = document.querySelector("#prot-list .kit-row"); return e ? Math.round(e.getBoundingClientRect().top) : null; });
      ok(`E2 · Protection: the first row's top is ≤ 380px (${p})`, p != null && p <= 380, String(p));
      const protClip = await clipOf("#prot-list .kit-row");
      ok(`E5 · Protection: the dial pair is inside the fact box on every row with a number (${protClip.filter(Boolean).length}/${protClip.length})`, protClip.length > 0 && protClip.every(Boolean), JSON.stringify(protClip));
      const h = await page.evaluate(() => [...document.querySelectorAll("#prot-list .kit-row")].map((e) => Math.round(e.getBoundingClientRect().height)));
      ok(`E3 · Protection rows keep the Clients row's scale on a desktop (≤ 80px; max ${Math.max(...h)})`, h.length > 0 && h.every((x) => x <= 80), JSON.stringify(h));
      await page.close();
    }
    {
      console.log("\n— §E · every control ≥ 44px on a phone (p2, 390×844)");
      const page = await boot(browser, "p2", PHONE);
      const errBefore = realErrs(page).length;
      const measure = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)]
        .filter((e) => e.offsetParent !== null && !e.hidden)
        .map((e) => ({ id: e.id || e.className.split(" ").slice(0, 2).join("."), h: Math.round(e.getBoundingClientRect().height), t: (e.textContent || e.value || "").trim().slice(0, 18) }))
        .filter((x) => x.h < 44), sel);
      await goPage(page, "retention", 3600);
      await page.evaluate(() => document.querySelector("#ret-rates-list .ret-cb").click());
      await page.waitForTimeout(300);
      const retSmall = await measure("#page-retention .list-tools input, #page-retention .list-tools select, #page-retention .list-tools .seg-btn, #ret-segs .seg-btn, #ret-rates-list .kit-row .row-acts > .btn, #ret-rates-list .kit-row .row-more > summary, #ret-bulk-bar > .btn, #ret-bulk-bar .row-more > summary, #ret-rates-list .kit-row > .bulk-cb, #ret-bulk-all");
      eq("E4 · Retention on a phone: no control under 44px (tools, chips, verbs, More ▾, bulk bar, checkboxes)", retSmall, []);
      await goPage(page, "protection", 3600);
      await page.click("#prot-scope-all"); await page.waitForTimeout(800);
      await page.evaluate(() => document.querySelector("#prot-list .prot-cb").click());
      await page.waitForTimeout(300);
      const protSmall = await measure("#page-protection .list-tools input, #page-protection .list-tools .seg-btn, #prot-segs .seg-btn, #prot-list .kit-row .row-acts > .btn, #prot-list .kit-row .row-more > summary, #prot-bulk-bar > .btn, #prot-bulk-bar > select, #prot-list .kit-row > .bulk-cb, #prot-bulk-all");
      eq("E5 · Protection on a phone: no control under 44px", protSmall, []);
      ok("§E · no console errors (phone)", realErrs(page).length === errBefore, JSON.stringify(realErrs(page).slice(errBefore)));
      await page.close();
    }
  } catch (e) {
    failures.push("CRASH — " + (e && e.stack || e));
    console.log("CRASH", e);
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (_) { /* gone */ } }
  }
  console.log(`\nr88_book_c: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
