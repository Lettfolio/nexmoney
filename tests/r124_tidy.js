/* R124 — three small tidy-ups Daniel approved on 21 Nov: page boxes say Filter; no "Showing your…" sentence on Mine;
   the Emails intro sits inside the fold beneath it.
   node tests/r124_tidy.js   (static server on :8099, admin/mock.html built by smoke.js) */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs) {
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  await p.waitForTimeout(600);
  return p;
}
const go = async (p, where) => { await p.evaluate((x) => window.nav(x), where); await p.waitForTimeout(1700); };
const box = (p, id) => p.evaluate((id) => { const e = document.getElementById(id); return e ? { ph: e.placeholder, al: e.getAttribute("aria-label") || "" } : null; }, id);
const pageText = (p) => p.evaluate(() => { const pg = document.querySelector(".page:not(.hidden)"); const out = []; const w = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (n.parentElement.checkVisibility() && n.textContent.trim()) out.push(n.textContent.trim()); } return out.join(" ").replace(/\s+/g, " "); });
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  const seam = await boot(browser, "?as=p4");

  console.log("A · page boxes say Filter");
  const boxes = {};
  for (const [pg, id] of [["pipeline", "board-search"], ["clients", "client-search"], ["retention", "ret-search"], ["protection", "prot-search"], ["vault", "vault-search"]]) { await go(p, pg); boxes[id] = await box(p, id); }
  ok("A1 · the five page boxes read Filter, in the box and to a screen reader", Object.values(boxes).every((b) => b && /^Filter\b/.test(b.ph) && /^Filter\b/.test(b.al)), JSON.stringify(boxes));
  ok("A2 · none of them says Search any more", Object.values(boxes).every((b) => !/search/i.test(b.ph + b.al)));
  ok("A3 · the one that looks everywhere still says Search", await p.evaluate(() => /Search clients and cases/.test(document.getElementById("global-search-btn").getAttribute("aria-label")) && /^Search/.test(document.getElementById("palette-input").placeholder)));
  await go(p, "clients"); await p.fill("#client-search", "a"); await p.waitForTimeout(900);
  ok("A4 · and a renamed box still filters its list", await p.evaluate(() => document.querySelectorAll("#client-list [data-id], #client-list .row-item, #client-list tr").length > 0));
  await p.fill("#client-search", ""); await p.waitForTimeout(500);

  console.log("B · no 'Showing your…' sentence on Mine");
  const seen = {}, seenSeam = {};
  for (const [pg, mine] of [["dashboard", "#brief-scope-mine"], ["retention", "#ret-scope-mine"], ["protection", "#prot-scope-mine"]]) {
    for (const [pageObj, store] of [[p, seen], [seam, seenSeam]]) { await go(pageObj, pg); if (await pageObj.$(mine + ":visible")) { await pageObj.click(mine); await pageObj.waitForTimeout(1500); } store[pg] = { t: await pageText(pageObj), mine: await pageObj.evaluate((m) => { const b = document.querySelector(m); return !!b && (b.classList.contains("scope-active") || b.getAttribute("aria-pressed") === "true"); }, mine) }; }
  }
  ok("B1 · Mine is the pressed choice on each page tested", Object.values(seen).every((s) => s.mine), JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.mine]))));
  ok("B2 · Today, Retention and Protection on Mine carry no 'Showing your…' sentence", Object.values(seen).every((s) => !/Showing (your|<strong>your)|your cases only/i.test(s.t)), JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, (v.t.match(/.{0,30}Showing.{0,40}/) || [""])[0]]))));
  ok("B3 · the harness seam still has them (so the check above is reading the right place)", Object.values(seenSeam).some((s) => /Showing (your|.{0,12}your)|your cases only/i.test(s.t)), JSON.stringify(Object.fromEntries(Object.entries(seenSeam).map(([k, v]) => [k, (v.t.match(/.{0,20}(Showing|your cases only).{0,40}/) || [""])[0]]))));
  ok("B4 · Retention on Mine still says what the list covers", /whole \d+-month window/.test(seen.retention.t), (seen.retention.t.match(/.{0,20}month window.{0,30}/) || [""])[0]);

  console.log("C · the Emails intro");
  await go(p, "operations"); await go(seam, "operations");
  const e = await p.evaluate(() => { const i = document.getElementById("emails-intro"), f = document.getElementById("emails-explainer"); return { inFold: i.parentElement === f, first: f.querySelector("summary").nextElementSibling === i, shown: i.checkVisibility(), open: f.open, text: i.textContent.trim(), morning: document.getElementById("em-morning-sub").checkVisibility() }; });
  ok("C1 · it is the first line inside the fold beneath, and out of sight until that is opened", e.inFold && e.first && !e.shown && !e.open && e.morning, JSON.stringify(e));
  await p.click("#emails-explainer > summary"); await p.waitForTimeout(300);
  ok("C2 · opening the fold shows it, word for word", await p.evaluate((t) => { const i = document.getElementById("emails-intro"); return i.checkVisibility() && i.textContent.trim() === t; }, await seam.evaluate(() => document.getElementById("emails-intro").textContent.trim())));
  await go(p, "pipeline"); await go(p, "operations");
  ok("C3 · it is still there, once, after leaving and coming back", await p.evaluate(() => document.querySelectorAll("#emails-intro").length === 1 && document.getElementById("emails-intro").parentElement.id === "emails-explainer"));
  ok("C4 · the harness seam keeps it on show above the fold", await seam.evaluate(() => { const i = document.getElementById("emails-intro"); return i.checkVisibility() && i.parentElement.id !== "emails-explainer"; }));
  const errs = [p, seam].flatMap((x) => x.__errs);
  ok("E1 · no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  console.log(`\nr124_tidy: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
