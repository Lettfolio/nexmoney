#!/usr/bin/env node
/* =============================================================================
   R87 · "Say less" — the Book pages, slice C (Retention + Protection).

   Pins the deletion-first round on the two hand-rolled call lists, per panel
   findings 04 #1, #2, #3 (partial), #4, #5, #8, #9, #11 and 04's "small stuff":

     §A  SMS OPT-OUT (C1, 04 #1). Every Retention caller passes the client's
         sms_opt_out: with EVERY fixture client flagged (the verifier's own
         method — flip the flag in the in-memory mock, then re-enter the page)
         Retention renders zero sms: links and a "no texts" marker on every
         row that has a number; with the default fixture, the flagged clients
         carry the marker and nobody else does; the Gone-quiet panel and
         Today's Rate & ERC drawer honour it through the same helper.

     §B  RETENTION PROSE DIET (C2, 04 #2/#11). One ≤25-word line per panel;
         the arithmetic, the money basis and the funnel's population live in
         ONE closed howFold whose text still says what R74/R61/R72 said. Four
         visible month chips (the other three keys still exist, hidden, and
         still filter); one sort <select> in the tools row replacing the two
         h3 toggles; the bulk-bar note is gone; the untouched note only prints
         when there is somebody to talk about. First .row-item ≤ 380px at
         1440×900 for p4 and p2.

     §C  RETENTION ROWS (C3, 04 #5). No duplicate verb: a startable row has
         the "🔁 Start retention case" button and NO "Re-mortgaging with us"
         chip; ≤ 3 visible verbs beside the dial pair, the rest behind
         "More ▾" (same elements, same handlers); rows without a call-pack
         line ≤ 135px and the median row ≤ 115px at 1440.

     §D  PROTECTION COUNTS (C4, 04 #4/#8/#9). The tile and the line under the
         tools row read the same number in every scope; no "#" column and no
         "hover the # column" sentence; the rank rides on the client cell with
         the score tooltip; exactly one 📞 per table row; the two bands are
         filter options over the ONE table (same predicates) and are collapsed
         <details>; no adviser-facing owner-only-money note.

     §E  PROTECTION PROSE (C5). Every visible standing line on the page is ≤ 25
         words; the band and clawback bases keep their ids inside folds.

     §F  NO CONSOLE ERRORS, every persona, both pages.

   Expectations are computed at runtime from the mock's own rows, never typed
   in. Run:  node /root/nx/tests/r87_book.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — see HARNESS.md.)
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

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  return srv;
}

async function boot(browser, persona, ctxOpts) {
  const page = await (await browser.newContext(Object.assign({ viewport: { width: 1440, height: 900 }, locale: "en-GB", timezoneId: "Europe/London" }, ctxOpts || {}))).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));
const noNewErr = (page, before) => realErrs(page).length === (before || 0);
const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 3000 : ms);
};
const txt = (page, sel) => page.$eval(sel, (e) => (e.textContent || "").replace(/\s+/g, " ").trim()).catch(() => null);
const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;

/* The visible standing prose of a page: paragraphs that are on screen and NOT inside a closed
   <details> (a fold's body is the manual, not the page). */
const visibleProse = (page, sectionSel) => page.evaluate((sel) => {
  const sec = document.querySelector(sel);
  const cands = [...sec.querySelectorAll("p.panel-sub, p.dq-notice, .ret-untouched-note, #prot-cap-line, .kpi .s")];
  return cands
    .filter((p) => p.offsetParent !== null && !p.closest(".row-item") && !p.closest("details:not([open])") && p.textContent.trim())
    .map((p) => ({ id: p.id || p.className, text: p.textContent.replace(/\s+/g, " ").trim() }));
}, sectionSel);

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* ======================================================================
       §A · C1 — SMS OPT-OUT ON EVERY RETENTION CALLER
       ====================================================================== */
    {
      console.log("\n— §A · every Retention caller honours sms_opt_out (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "retention");

      // A1 — default fixture: the flagged clients (and only they) carry the marker.
      const gt = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id,first_name,last_name,phone,sms_opt_out");
        const flagged = (data || []).filter((c) => c.sms_opt_out).map((c) => `${c.first_name} ${c.last_name}`);
        return { flagged, byName: Object.fromEntries((data || []).map((c) => [`${c.first_name} ${c.last_name}`, { phone: c.phone, opt: !!c.sms_opt_out }])) };
      });
      ok("A0 · fixture — at least two clients are marked SMS opt-out", gt.flagged.length >= 2, JSON.stringify(gt.flagged));
      // The rate rows and the Gone-quiet rows carry the dial pair; the pipeline panel's rows never did.
      const rowsDefault = await page.evaluate(() => [...document.querySelectorAll("#ret-rates-list .row-item, #ret-cold-list .row-item")].map((r) => ({
        name: (r.querySelector(".t") || {}).textContent.trim().split(" ").slice(0, 2).join(" "),
        tel: !!r.querySelector("a[href^='tel:']"), sms: !!r.querySelector("a[href^='sms:']"), marker: !!r.querySelector(".row-sms-optout"),
      })));
      const wrong = rowsDefault.filter((r) => { const c = gt.byName[r.name]; return c && c.phone && (c.opt ? (r.sms || !r.marker) : (r.marker || !r.sms)); });
      ok("A1 · default fixture: every row with a number offers a text UNLESS the client is opted out, who gets the marker instead",
        rowsDefault.length > 0 && wrong.length === 0, JSON.stringify(wrong.slice(0, 4)));
      ok("A1b · …and an opted-out client keeps the call (a call is not a text)",
        rowsDefault.filter((r) => r.marker).every((r) => r.tel), JSON.stringify(rowsDefault.filter((r) => r.marker)));

      // A2 — the verifier's method (measure-optout2.js): flag EVERY client, re-enter the page.
      await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id");
        for (const c of data || []) await window.__mockDb.from("clients").update({ sms_opt_out: true }).eq("id", c.id);
      });
      await goPage(page, "dashboard", 2200);
      await goPage(page, "retention", 3200);
      const all = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#page-retention .row-item")];
        return {
          rows: rows.length,
          sms: document.querySelectorAll("#page-retention a[href^='sms']").length,
          tel: document.querySelectorAll("#page-retention a[href^='tel:']").length,
          markers: document.querySelectorAll("#page-retention .row-sms-optout").length,
          telRowsWithoutMarker: rows.filter((r) => r.querySelector("a[href^='tel:']") && !r.querySelector(".row-sms-optout")).length,
          gone: { rows: document.querySelectorAll("#ret-cold-list .row-item").length, sms: document.querySelectorAll("#ret-cold-list a[href^='sms']").length, markers: document.querySelectorAll("#ret-cold-list .row-sms-optout").length },
        };
      });
      eq("A2 · with every client flagged, Retention renders ZERO sms: links (rate rows and Gone-quiet alike)", all.sms, 0);
      ok("A2b · …every row that has a number says “no texts” instead", all.tel > 0 && all.telRowsWithoutMarker === 0, JSON.stringify(all));
      ok("A2c · …including the Gone-quiet rows (they read the flag off the Book's client row)", all.gone.rows === 0 || (all.gone.sms === 0 && all.gone.markers > 0), JSON.stringify(all.gone));

      // A3 — Today's Rate & ERC drawer goes through the same helper (retRowPhones), so it follows.
      await goPage(page, "dashboard", 2800);
      const drawer = await page.evaluate(() => ({
        rows: document.querySelectorAll("#alerts-rateerc .row-item").length,
        sms: document.querySelectorAll("#alerts-rateerc a[href^='sms']").length,
        markers: document.querySelectorAll("#alerts-rateerc .row-sms-optout").length,
        acts: document.querySelectorAll("#alerts-rateerc .ret-row-acts").length,
      }));
      ok("A3 · Today's Rate & ERC drawer offers no text either (same helper, same flag)", drawer.rows === 0 || (drawer.sms === 0 && drawer.markers > 0), JSON.stringify(drawer));
      eq("A3b · …and still carries none of the page-only verb cluster", drawer.acts, 0);
      ok("§A · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* ======================================================================
       §B · C2 — RETENTION PROSE DIET
       ====================================================================== */
    for (const persona of ["p4", "p2"]) {
      console.log(`\n— §B · Retention: one line per panel, one fold, four chips, one sort (${persona})`);
      const page = await boot(browser, persona);
      const errBefore = realErrs(page).length;
      await page.evaluate(() => { try { ["nx_ret_month", "nx_ret_sortdir", "nx_ret_untouched", "nx_ret_scope"].forEach((k) => localStorage.removeItem(k)); } catch (_) {} });
      await goPage(page, "retention", 3200);

      const prose = await visibleProse(page, "#page-retention");
      const long = prose.filter((p) => words(p.text) > 25);
      ok(`B1 · every visible standing line on the page is ≤ 25 words (${prose.length} lines)`, prose.length > 0 && long.length === 0, JSON.stringify(long.map((p) => `${p.id}: ${words(p.text)}w`)));
      const totalWords = prose.reduce((s, p) => s + words(p.text), 0);
      ok("B1b · …and the page's standing prose is under 120 words in all (was 526 in 9 paragraphs)", totalWords < 120, String(totalWords));

      const fold = await page.evaluate(() => {
        const d = document.getElementById("ret-rates-how-fold");
        return d ? {
          tag: d.tagName, open: d.open, cls: d.className,
          basis: (document.getElementById("ret-rates-basis") || {}).textContent || "",
          money: (document.getElementById("ret-rates-money-basis") || {}).textContent || null,
          funnel: (document.getElementById("ret-outcome-sub") || {}).textContent || "",
          folds: document.querySelectorAll("#ret-rates-panel details.how-fold").length,
        } : null;
      });
      ok("B2 · the rates panel carries exactly ONE howFold, closed", !!fold && fold.tag === "DETAILS" && !fold.open && /how-fold/.test(fold.cls) && fold.folds === 1, JSON.stringify(fold && { open: fold.open, folds: fold.folds }));
      ok("B2b · …holding the R74 reconciliation in words", /already ended and \d+ still to end make the \d+ in the \d+-month window/.test(fold.basis) && /rows in all/.test(fold.basis), fold.basis.slice(-200));
      ok("B2c · …and the R72 funnel's population sentence", /matured in the last 12 months/.test(fold.funnel) || /outcome recorded/.test(fold.funnel), fold.funnel.slice(0, 160));
      if (persona === "p4") ok("B2d · …and the R61 money basis for the money-holder", /value at risk/.test(fold.money || "") && /proxy/.test(fold.money || ""), fold.money);
      else eq("B2d · …and no money basis for an adviser", fold.money, null);

      const chips = await page.evaluate(() => [...document.querySelectorAll("#ret-month-chips .ret-month-chip")].map((b) => ({ k: b.dataset.month, hidden: b.hidden, shown: b.offsetParent !== null })));
      eq("B3 · four month chips are visible: Ended · last 12 months · This month · 3 months · the whole window", chips.filter((c) => c.shown).map((c) => c.k), ["ended12", "this", "3mo", "all"]);
      eq("B3b · …the other three keys are still rendered, hidden (a stored pick or a suite can still reach them)", chips.filter((c) => !c.shown).map((c) => c.k), ["ended", "ended3", "next"]);
      const rowsAll = await page.evaluate(() => document.querySelectorAll("#ret-rates-list .row-item").length);
      await page.evaluate(() => document.querySelector('#ret-month-chips .ret-month-chip[data-month="next"]').click());
      await page.waitForTimeout(2200);
      const nextState = await page.evaluate(() => ({
        shown: [...document.querySelectorAll("#ret-month-chips .ret-month-chip")].filter((b) => b.offsetParent !== null).map((b) => b.dataset.month),
        active: (document.querySelector("#ret-month-chips .ret-month-chip.scope-active") || {}).dataset?.month,
        sub: document.getElementById("ret-rates-sub").textContent,
      }));
      ok("B3c · a hidden key that IS the pick shows its chip pressed, so a remembered choice is never invisible", nextState.active === "next" && nextState.shown.includes("next") && /Showing only rates ending in/.test(nextState.sub), JSON.stringify(nextState));
      await page.evaluate(() => window.retSetMonth("all"));
      await page.waitForTimeout(2200);
      eq("B3d · back on the whole window the list is what it was", await page.evaluate(() => document.querySelectorAll("#ret-rates-list .row-item").length), rowsAll);

      const sort = await page.evaluate(() => {
        const s = document.getElementById("ret-sort");
        return {
          inTools: !!(s && s.closest(".page-tools")), values: s ? [...s.options].map((o) => o.value) : null, value: s && s.value,
          h3Buttons: document.querySelectorAll("#ret-rates-h3 button").length, oldIds: !!(document.getElementById("ret-sort-dir") || document.getElementById("ret-rates-sort")),
        };
      });
      ok("B4 · ONE sort <select> sits in the page's tools row; the h3 carries no buttons and the two old toggles are gone", sort.inTools && sort.h3Buttons === 0 && !sort.oldIds, JSON.stringify(sort));
      eq("B4b · its options are the three orders — value at risk for the money-holder only", sort.values, persona === "p4" ? ["newest", "oldest", "value"] : ["newest", "oldest"]);
      eq("B4c · the default order is what it always was", sort.value, persona === "p4" ? "value" : "newest");
      // The select really re-orders: pick the oldest-first order and check the ended group's dates ascend.
      await page.selectOption("#ret-sort", "oldest");
      await page.waitForTimeout(2400);
      const dates = await page.evaluate(() => {
        const out = []; let inEnded = false;
        for (const n of document.getElementById("ret-rates-list").children) {
          if (n.classList.contains("ret-group-h")) { inEnded = n.classList.contains("ret-g-ended"); continue; }
          if (inEnded && n.classList.contains("row-item")) { const m = /ends (\d{1,2} \w{3} \d{4})/.exec(n.textContent); if (m) out.push(new Date(m[1]).getTime()); }
        }
        return out;
      });
      ok("B4d · picking “Oldest first” orders the ended group ascending by rate end", dates.length >= 2 && dates.every((d, i) => i === 0 || d >= dates[i - 1]), JSON.stringify(dates.slice(0, 6)));
      eq("B4e · …and the choice is stored where the old toggle stored it (nx_ret_sortdir)", await page.evaluate(() => localStorage.getItem("nx_ret_sortdir")), "oldest");

      const notes = await page.evaluate(() => ({
        bulkNote: !!document.querySelector(".ret-bulk-note"),
        untouchedCount: Number((document.querySelector("#ret-untouched-btn .count") || {}).textContent || 0),
        untouchedNote: !!document.querySelector(".ret-untouched-note"),
        scopeNoteHidden: document.getElementById("ret-scope-note").hidden,
        scopeNote: document.getElementById("ret-scope-note").textContent,
        groupSubs: document.querySelectorAll("#ret-rates-list .ret-group-sub").length,
        groupTitled: [...document.querySelectorAll("#ret-rates-list .ret-group-h")].every((h) => h.title.length > 20),
      }));
      eq("B5 · the bulk-bar's 30-word provenance note is gone", notes.bulkNote, false);
      ok("B5b · the untouched note prints only when the count is above zero", notes.untouchedNote === (notes.untouchedCount > 0), JSON.stringify(notes));
      ok("B5c · the group definitions are the headings' titles, not paragraphs between the reader and the rows", notes.groupSubs === 0 && notes.groupTitled, JSON.stringify(notes));
      if (persona === "p2") ok("B5d · an adviser's Mine note is one clause and still says whose it is", !notes.scopeNoteHidden && /your cases and your clients/.test(notes.scopeNote) && words(notes.scopeNote) <= 25, notes.scopeNote);
      else ok("B5d · under All the scope note is not shown — every panel line already says whose", notes.scopeNoteHidden, notes.scopeNote);

      await page.evaluate(() => window.retSetSort("newest"));
      await page.waitForTimeout(2400);
      const firstTop = await page.evaluate(() => { const r = document.querySelector("#ret-rates-list .row-item"); return r ? Math.round(r.getBoundingClientRect().top + window.scrollY) : null; });
      ok(`B6 · the first row sits ≤ 380px down the page at 1440×900 (was 696px) — measured ${firstTop}px`, firstTop != null && firstTop <= 380, String(firstTop));
      ok("§B · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* ======================================================================
       §C · C3 — RETENTION ROWS: NO DUPLICATE VERB, ≤ 3 VISIBLE, MORE ▾
       ====================================================================== */
    {
      console.log("\n— §C · Retention rows: three verbs, one Start, the rest behind More ▾ (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "retention", 3200);
      const rows = await page.evaluate(() => [...document.querySelectorAll("#ret-rates-list .row-item")].map((r) => {
        const vis = (e) => e.offsetParent !== null;
        const verbs = [...r.querySelectorAll("button, summary")].filter(vis).map((b) => b.textContent.replace(/\s+/g, " ").trim());
        return {
          h: Math.round(r.getBoundingClientRect().height),
          callPack: !!r.querySelector(".call-pack, .callpack, .cs-callpack, .ret-callpack") || /Balance|reverts to|pays £/.test(r.textContent),
          verbs,
          start: !!r.querySelector("button.btn-retention[onclick*='startRetentionCase']"),
          remortgageChip: [...r.querySelectorAll(".ret-out-chip")].some((b) => /Re-mortgaging/.test(b.textContent)),
          more: !!r.querySelector("details.ret-row-more"),
          hiddenVerbs: [...r.querySelectorAll("details.ret-row-more button")].map((b) => b.textContent.trim()),
          outChips: r.querySelectorAll(".ret-out-chip").length,
          factLines: r.querySelectorAll(".row-main > .s").length,
        };
      }));
      ok("C0 · fixture — the page has rows, some of them startable", rows.length >= 8 && rows.some((r) => r.start), JSON.stringify({ n: rows.length, start: rows.filter((r) => r.start).length }));
      eq("C1 · NO row carries the “🔁 Re-mortgaging with us” chip any more (the Start button is the one verb)", rows.filter((r) => r.remortgageChip).length, 0);
      ok("C1b · a completed row still offers the two rate-end OUTCOME chips (inside More); a live row none", rows.every((r) => r.outChips === 0 || r.outChips === 2) && rows.some((r) => r.outChips === 2), JSON.stringify(rows.map((r) => r.outChips)));
      const tooMany = rows.filter((r) => r.verbs.filter((v) => !/^More/.test(v)).length > 3);
      ok("C2 · ≤ 3 verbs visible on every row beside the dial pair (Log call · Start/Mark reminded · …)", tooMany.length === 0, JSON.stringify(tooMany.slice(0, 2).map((r) => r.verbs)));
      ok("C2b · every row has a “More ▾” holding Book review, plus the outcome chips on completed rows", rows.every((r) => r.more && r.hiddenVerbs.some((v) => /Book review/.test(v)) && (r.outChips === 0 || r.hiddenVerbs.some((v) => /Renewed elsewhere/.test(v)))), JSON.stringify(rows[0].hiddenVerbs));
      // More ▾ is a real <details>: opening it exposes the verbs, and they still work.
      const exposed = await page.evaluate(() => {
        const d = document.querySelector("#ret-rates-list details.ret-row-more");
        const before = [...d.querySelectorAll("button")].filter((b) => b.offsetParent !== null).length;
        d.open = true;
        const after = [...d.querySelectorAll("button")].filter((b) => b.offsetParent !== null).length;
        return { before, after, n: d.querySelectorAll("button").length };
      });
      ok("C2c · opening More exposes exactly the hidden verbs", exposed.before === 0 && exposed.after === exposed.n && exposed.n >= 1, JSON.stringify(exposed));
      await page.evaluate(() => document.querySelectorAll("#ret-rates-list details.ret-row-more").forEach((d) => { d.open = true; }));
      await page.click("#ret-rates-list details.ret-row-more button[onclick*=\"retBookReview\"]");
      await page.waitForTimeout(1800);
      const appt = await page.evaluate(() => ({ form: !!document.getElementById("appt-form"), title: (document.getElementById("appt-form") || { elements: {} }).elements.title?.value }));
      ok("C2d · Book review from inside More still opens the diary editor prefilled", appt.form && appt.title === "Rate-end review", JSON.stringify(appt));
      await page.evaluate(() => window.closeModal && window.closeModal());
      ok("C3 · the row is ONE fact line (lender · rate · ends · money · last contact) plus the verb line", rows.every((r) => r.factLines <= 3), JSON.stringify(rows.map((r) => r.factLines)));
      const plain = rows.filter((r) => !r.callPack).map((r) => r.h);
      const sorted = rows.map((r) => r.h).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      ok(`C4 · rows without a call-pack line are ≤ 135px at 1440 (were 153–247) — max ${Math.max(...plain)}px`, plain.length > 0 && Math.max(...plain) <= 135, JSON.stringify(plain));
      ok(`C4b · …and the median row is ≤ 115px — measured ${median}px (target 110)`, median <= 115, JSON.stringify(sorted));
      ok("§C · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* ======================================================================
       §D · C4 — PROTECTION: ONE COUNT, ONE 📞, NO # COLUMN, BANDS AS FILTERS
       ====================================================================== */
    for (const persona of ["p4", "p2"]) {
      console.log(`\n— §D · Protection counts and rows (${persona})`);
      const page = await boot(browser, persona);
      const errBefore = realErrs(page).length;
      await goPage(page, "protection", 3200);
      const scopes = persona === "p4" ? ["mine", "unassigned", "all"] : ["mine"];
      for (const sc of scopes) {
        await page.click(`#prot-scope-${sc}`);
        await page.waitForTimeout(700);
        const st = await page.evaluate(() => ({
          tile: Number(document.getElementById("prot-kpi-count").textContent),
          rows: document.querySelectorAll("#prot-list-table tr.prot-row").length,
          cap: (document.getElementById("prot-cap-line") || {}).textContent || "",
          empty: !!document.querySelector("#prot-table .empty-state, #prot-table .empty"),
        }));
        // "Showing the best 250 of 1,516 opportunities…" / "Showing the best 12 in this view…" / "5 opportunities on your cases…"
        const n = Number(((st.cap.match(/best (\d+)/) || st.cap.match(/^(\d+) opportunit/) || [])[1]));
        ok(`D1·${sc} · the tile and the line read the SAME number (${st.tile}) and it is the rows on screen`, st.tile === st.rows && (st.empty || n === st.tile), JSON.stringify(st));
      }
      await page.click("#prot-scope-all"); await page.waitForTimeout(600);
      const page1 = await page.evaluate(() => ({
        hashCol: document.querySelectorAll("#prot-list-table .prot-col-n").length,
        hover: /hover the #/.test(document.getElementById("page-protection").innerText),
        rankTitle: (document.querySelector("#prot-list-table tr.prot-row .prot-rank") || {}).title || "",
        rankText: (document.querySelector("#prot-list-table tr.prot-row .prot-rank") || {}).textContent || "",
        glyphs: [...document.querySelectorAll("#prot-list-table tr.prot-row")].map((r) => (r.textContent.match(/📞/g) || []).length),
        logcall: [...document.querySelectorAll("#prot-list-table tr.prot-row .prot-actions button[aria-label='Log a call']")].map((b) => b.textContent.trim()),
        moneyNote: !!document.getElementById("prot-money-note"),
        capWords: (document.getElementById("prot-cap-line") || {}).textContent.trim().split(/\s+/).length,
      }));
      eq("D2 · the # column is gone", page1.hashCol, 0);
      eq("D2b · …and so is the “hover the # column” sentence", page1.hover, false);
      ok("D2c · the rank rides on the client cell with the score spelled out in its tooltip", /^#1$/.test(page1.rankText.trim()) && /#1 — score [\d.]+:/.test(page1.rankTitle) && /stage \d+/.test(page1.rankTitle), page1.rankTitle.slice(0, 80));
      ok("D3 · exactly one 📞 per table row — the dial glyph beside the name; Log call is 📝", page1.glyphs.length > 0 && page1.glyphs.every((g) => g <= 1) && page1.logcall.every((t) => t === "📝"), JSON.stringify({ g: page1.glyphs.slice(0, 6), l: page1.logcall.slice(0, 3) }));
      eq("D4 · no owner-only-money apology paragraph exists on the page", page1.moneyNote, false);
      ok("D4b · the line under the tools row is ≤ 25 words", page1.capWords <= 25, String(page1.capWords));

      // D5 — the bands are filter options over the ONE table, same predicates, collapsed below.
      const band = await page.evaluate(async () => {
        const gi = (r) => ["purchase", "first_time_buyer", "buy_to_let", "remortgage"].includes(r.case_kind) && (r.gi_status || "not_discussed") === "not_discussed";
        const { data } = await window.__mockDb.rpc("get_protection_pipeline", { p_scope: "all" });
        const rows = data || [];
        const opts = [...document.querySelectorAll("#prot-filter option")].map((o) => ({ v: o.value, t: o.textContent }));
        return {
          opts, wantNo: rows.filter((r) => !r.live).length, wantGi: rows.filter(gi).length,
          bandNo: Number(document.getElementById("prot-calllist-count").textContent), bandGi: Number(document.getElementById("prot-gi-count").textContent),
          details: [...document.querySelectorAll("#prot-calllist-panel, #prot-gi-panel")].map((d) => ({ tag: d.tagName, open: d.open, hidden: d.classList.contains("hidden") })),
        };
      });
      const optNo = band.opts.find((o) => o.v === "nooutcome"), optGi = band.opts.find((o) => o.v === "gi");
      ok("D5 · the status filter offers both bands as options, each carrying its scoped count", !!optNo && !!optGi && Number((optNo.t.match(/\((\d+)\)/) || [])[1]) === band.bandNo && Number((optGi.t.match(/\((\d+)\)/) || [])[1]) === band.bandGi, JSON.stringify(band.opts));
      if (persona === "p4") ok("D5b · …and those counts are the RPC's own predicates (All scope)", band.bandNo === band.wantNo && band.bandGi === band.wantGi, JSON.stringify(band));
      ok("D5c · both bands are collapsed <details> — rendered, closed, not a second list on the page", band.details.length === 2 && band.details.every((d) => d.tag === "DETAILS" && !d.open && !d.hidden), JSON.stringify(band.details));
      await page.selectOption("#prot-filter", "nooutcome"); await page.waitForTimeout(700);
      const filtered = await page.evaluate(() => ({
        rows: document.querySelectorAll("#prot-list-table tr.prot-row").length, tile: Number(document.getElementById("prot-kpi-count").textContent),
        completedOnly: [...document.querySelectorAll("#prot-list-table tr.prot-row .prot-col-case")].every((td) => /Completed/.test(td.textContent)),
        names: [...document.querySelectorAll("#prot-list-table tr.prot-row .prot-client")].map((e) => e.textContent),
        bandNames: [...document.querySelectorAll("#prot-calllist .row-item .t")].map((e) => e.textContent),
      }));
      ok("D5d · picking “Completed, no protection outcome” filters the ONE table to exactly the band's rows", filtered.rows === band.bandNo && filtered.tile === filtered.rows && filtered.completedOnly, JSON.stringify(filtered));
      eq("D5e · …the same clients the band lists (first 25), in the same order", filtered.names.slice(0, 25), filtered.bandNames);
      await page.selectOption("#prot-filter", "gi"); await page.waitForTimeout(700);
      const giRows = await page.evaluate(() => document.querySelectorAll("#prot-list-table tr.prot-row").length);
      eq("D5f · and “GI not discussed” filters to the GI band's rows", giRows, band.bandGi);
      await page.selectOption("#prot-filter", "all"); await page.waitForTimeout(500);
      ok("§D · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* ======================================================================
       §E · C5 — PROTECTION PROSE
       ====================================================================== */
    {
      console.log("\n— §E · Protection prose: ≤ 25 words a line, bases in folds (p2 then p4)");
      for (const persona of ["p2", "p4"]) {
        const page = await boot(browser, persona);
        const errBefore = realErrs(page).length;
        await goPage(page, "protection", 3200);
        const prose = await visibleProse(page, "#page-protection");
        const long = prose.filter((p) => words(p.text) > 25);
        ok(`E1·${persona} · every visible standing line on the page is ≤ 25 words (${prose.length} lines)`, prose.length > 0 && long.length === 0, JSON.stringify(long.map((p) => `${p.id}: ${words(p.text)}w`)));
        const folds = await page.evaluate(() => ({
          claw: !!document.querySelector("#prot-clawback-how-fold #prot-clawback-basis"), clawOpen: (document.getElementById("prot-clawback-how-fold") || {}).open,
          clawText: (document.getElementById("prot-clawback-basis") || {}).textContent || "",
          giBasis: (document.getElementById("prot-gi-basis") || {}).textContent || "", giInFold: !!document.querySelector("#prot-gi-panel #prot-gi-basis"),
          kpiCaption: (document.querySelector("#prot-summary .kpi .s") || {}).textContent || "",
        }));
        ok(`E2·${persona} · the clawback basis keeps its id and its words inside a closed howFold`, folds.claw && folds.clawOpen === false && /assumption/.test(folds.clawText) && /providers differ/.test(folds.clawText), folds.clawText.slice(0, 80));
        if (persona === "p2") ok("E2b · …and still tells an adviser the commission column is Owner-only", /Owner only/.test(folds.clawText), folds.clawText.slice(-160));
        ok(`E3·${persona} · the GI band's 60-word basis sits inside the collapsed band with its id`, folds.giInFold && /no extra reads/.test(folds.giBasis), folds.giBasis.slice(0, 80));
        if (persona === "p4") ok("E4 · the KPI tile caption is ≤ 25 words", words(folds.kpiCaption) <= 25 && folds.kpiCaption.length > 0, folds.kpiCaption);
        ok(`§E·${persona} · no console errors`, noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
        await page.close();
      }
    }

    /* ======================================================================
       §F · NO CONSOLE ERRORS, EVERY PERSONA, BOTH PAGES (+ phone width)
       ====================================================================== */
    {
      console.log("\n— §F · clean console on Retention and Protection for every persona, desktop and phone");
      for (const persona of ["p1", "p2", "p3", "p4"]) {
        const page = await boot(browser, persona);
        await goPage(page, "retention", 2600);
        await goPage(page, "protection", 2600);
        ok(`F1·${persona} · no console errors across both pages`, realErrs(page).length === 0, JSON.stringify(realErrs(page).slice(0, 3)));
        await page.close();
      }
      const phone = await boot(browser, "p4", { viewport: { width: 390, height: 844 } });
      await goPage(phone, "retention", 3000);
      const ph = await phone.evaluate(() => ({
        firstTop: Math.round(document.querySelector("#ret-rates-list .row-item").getBoundingClientRect().top + window.scrollY),
        docSW: document.documentElement.scrollWidth, w: innerWidth,
      }));
      ok(`F2 · on a phone the first Retention row is under one screen and a half (was 1,333px) — ${ph.firstTop}px`, ph.firstTop <= 1000, JSON.stringify(ph));
      ok("F2b · …with no sideways scroll", ph.docSW <= ph.w, JSON.stringify(ph));
      ok("§F · no console errors (phone)", realErrs(phone).length === 0, JSON.stringify(realErrs(phone).slice(0, 3)));
      await phone.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(`\nr87_book: ${pass} passed, ${failures.length} failed`);
  if (failures.length) failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
