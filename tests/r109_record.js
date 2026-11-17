/* R109 — C1/C2/C3: a case opens as a full-width record with four tabs and a heading that names it.
   node tests/r109_record.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL layout. */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs, vp) {
  const p = await browser.newPage({ viewport: vp || { width: 1366, height: 768 } });
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  await p.waitForTimeout(600);
  return p;
}
const state = (p) => p.evaluate(() => { const m = document.getElementById("modal"), back = document.getElementById("modal-backdrop"), r = m.getBoundingClientRect();
  const vis = (e) => !!e && e.checkVisibility();
  return { open: !back.classList.contains("hidden"), record: m.classList.contains("record"), w: Math.round(r.width), left: Math.round(back.getBoundingClientRect().left), h: m.scrollHeight,
    head: (m.querySelector(".cs-h3-row h3") || {}).textContent || "",
    tabs: [...m.querySelectorAll(".rec-tabs > button")].map((b) => b.textContent + (b.getAttribute("aria-selected") === "true" ? "*" : "")),
    shown: [...m.querySelectorAll(".rec-panel")].filter((x) => !x.hidden).map((x) => x.dataset.tab),
    side: [...(m.querySelector(".rec-side") || { children: [] }).children].map((c) => c.id || c.className.split(" ")[0]),
    panels: Object.fromEntries([...m.querySelectorAll(".rec-panel")].map((x) => [x.dataset.tab, [...x.children].map((c) => c.id || c.className.split(" ")[0])])),
    tasksVis: vis(m.querySelector("#case-tasks")), histVis: vis(m.querySelector("#case-history")), formVis: vis(m.querySelector('select[name="stage"]')), saveVis: vis(m.querySelector(".modal-actions .btn-primary")) }; });
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  await p.click('[data-page="pipeline"]'); await p.waitForTimeout(1800);
  const card = await p.evaluate(() => { const c = document.querySelector("#board .card"); return { id: c.dataset.id || c.dataset.case || "", name: (c.querySelector(".cn-name") || c).textContent.trim() }; });
  await p.click("#board .card"); await p.waitForTimeout(1500);
  const s = await state(p);

  console.log("A · the record");
  ok("A1 · a case opens as a record that fills the page beside the sidebar", s.open && s.record && s.w >= 1000 && s.left === 216, JSON.stringify({ w: s.w, left: s.left, record: s.record }));
  const want = await p.evaluate(() => { const m = document.getElementById("modal"); const o = (n) => { const e = m.querySelector(`select[name="${n}"]`); return e.selectedOptions[0].textContent.trim(); }; return { who: m.querySelector(".case-summary a").textContent.trim(), type: o("case_kind"), stage: o("stage") }; });
  ok("A2 · the heading names it: client — type · stage", s.head === `${want.who} — ${want.type} · ${want.stage}` && !/^Case$/.test(s.head), s.head);
  ok("A3 · four tabs, in order, opening on Work", s.tabs.join("|") === "Work*|Documents|Details|History" && s.shown.join() === "work", JSON.stringify(s.tabs));
  ok("A4 · the summary and its actions sit down the left", s.side.join("|") === "cs-sticky-actions|case-summary", JSON.stringify(s.side));
  ok("A5 · every section went to its tab", s.panels.work.includes("case-tasks") && s.panels.work.includes("note-compose") && s.panels.docs.includes("case-fold-docs") && s.panels.details.includes("case-details") && s.panels.history.join() === "case-history", JSON.stringify(s.panels));
  ok("A6 · on Work the tasks are on show and history and the form are not", s.tasksVis && !s.histVis && !s.formVis);
  ok("A7 · Work fits one screen (the pop-up was three)", s.h <= 900, String(s.h));
  await p.click('.rec-tabs button[data-tab="history"]'); await p.waitForTimeout(500);
  const sh = await state(p);
  ok("A8 · History shows the history and nothing from Work", sh.histVis && !sh.tasksVis && sh.shown.join() === "history");
  await p.click('.rec-tabs button[data-tab="details"]'); await p.waitForTimeout(600);
  const sd = await state(p);
  const cols = await p.evaluate(() => getComputedStyle(document.querySelector("#modal .form-grid")).gridTemplateColumns.split(" ").length);
  ok("A9 · Details opens its folds without a second press and lays the form out in three columns", sd.formVis && cols === 3 && (await p.evaluate(() => [...document.querySelectorAll('#modal .rec-panel[data-tab="details"] > details')].filter((d) => d.checkVisibility()).every((d) => d.open))), JSON.stringify({ formVis: sd.formVis, cols }));
  ok("A10 · R110: the record has no Save button on any tab — fields save themselves", !s.saveVis && !sh.saveVis && !sd.saveVis);

  console.log("B · it still works as the panel did");
  const cid = await p.evaluate(() => document.querySelector("#case-form").dataset.caseId);
  await p.fill('#modal input[name="rate_percent"]', "5.55");
  await p.click("#modal .modal-close"); await p.waitForTimeout(900);
  const guard = await p.evaluate(() => { const o = document.getElementById("overlay-modal"); return !!o && o.checkVisibility() ? o.textContent : ""; });
  ok("B1 · R110: leaving a changed field does not warn — there is nothing unsaved", guard === "", guard.slice(0, 80));
  const saved = await p.evaluate(async (i) => { const { data } = await window.__mockDb.from("cases").select("id,rate_percent").eq("id", i).single(); return String(data.rate_percent) === "5.55"; }, cid);
  ok("B2 · and the change is on that case", saved);
  if (await p.evaluate(() => !document.getElementById("modal-backdrop").classList.contains("hidden"))) { await p.click("#modal .modal-close"); await p.waitForTimeout(500); }
  ok("B3 · closing returns to the list you came from", await p.evaluate(() => document.getElementById("modal-backdrop").classList.contains("hidden") && document.getElementById("page-pipeline").checkVisibility()));
  await p.click("#board .card:nth-of-type(2)"); await p.waitForTimeout(1400);
  ok("B4 · the next case opens on the tab you were last on", (await state(p)).shown.join() === "details", JSON.stringify((await state(p)).shown));
  ok("B5 · the close button says where it goes", await p.evaluate(() => document.querySelector("#modal .modal-close").title === "Back to the list"));
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);

  console.log("C · what stays a small panel");
  await p.evaluate(() => window.openCase(null)); await p.waitForTimeout(900);
  const nc = await state(p);
  ok("C1 · a new case keeps the small panel — no record, no tabs", nc.open && !nc.record && nc.w <= 640 && nc.tabs.length === 0 && nc.left === 0, JSON.stringify({ w: nc.w, record: nc.record, left: nc.left }));
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);
  await p.click('[data-page="clients"]'); await p.waitForTimeout(1600);
  await p.evaluate(async () => { const { data } = await window.__mockDb.from("clients").select("id"); await window.openClient(data[0].id); }); await p.waitForTimeout(1300);
  const cl = await state(p);
  ok("C2 · a client record is unchanged in this round", cl.open && !cl.record && cl.tabs.length === 0, JSON.stringify({ open: cl.open, record: cl.record }));

  console.log("D · phone and the seam");
  const ph = await boot(browser, "?as=p4&scope=default", { width: 390, height: 844 });
  await ph.evaluate(() => window.openCase(document.querySelector("#briefing-list .brief-row[data-case]").dataset.case)); await ph.waitForTimeout(1500);
  const ps = await state(ph);
  ok("D1 · on a phone the record is one column with the tabs under the summary, and nothing spills sideways", ps.record && ps.left === 0 && ps.tabs.length === 4 && (await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)), JSON.stringify({ left: ps.left, w: ps.w }));
  const legacy = await boot(browser, "?as=p4");
  await legacy.evaluate(() => window.openCase(document.querySelector("#briefing-list .brief-row[data-case]").dataset.case)); await legacy.waitForTimeout(1500);
  const lg = await state(legacy);
  ok("D2 · the harness seam keeps the 640px panel the older suites drive", lg.open && !lg.record && lg.w <= 640 && lg.tabs.length === 0 && /^Case$/.test(lg.head), JSON.stringify({ w: lg.w, head: lg.head }));

  const errs = [p, ph, legacy].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr109_record: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
