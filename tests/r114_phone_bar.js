/* R114 — N7: a fixed bottom bar replaces the sideways-scrolling menu strip on a phone.
   node tests/r114_phone_bar.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL layout. */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs, vp, tour) {
  const p = await browser.newPage({ viewport: vp });
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  if (!tour) await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  await p.waitForTimeout(700);
  return p;
}
const PHONE = { width: 390, height: 844 };
const bar = (p) => p.evaluate(() => { const b = document.getElementById("phone-bar"); if (!b) return null; const r = b.getBoundingClientRect();
  return { shown: b.checkVisibility(), bottom: Math.round(innerHeight - r.bottom), h: Math.round(r.height), labels: [...b.querySelectorAll("button")].map((x) => x.querySelector(".pb-l").textContent.trim() + (x.classList.contains("active") ? "*" : "")), cut: [...b.querySelectorAll(".pb-l")].some((l) => l.scrollWidth > l.clientWidth + 1),
    tap: Math.min(...[...b.querySelectorAll("button")].map((x) => Math.round(Math.min(x.getBoundingClientRect().width, x.getBoundingClientRect().height)))), strip: document.querySelector(".sidenav").checkVisibility(), spill: document.documentElement.scrollWidth > innerWidth, page: (location.hash || "").replace("#", "") }; });
// Is the thing at the bottom of the list clear of the bar? True when the bar does not sit over any part of it.
const clearOfBar = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s), b = document.getElementById("phone-bar"); if (!e || !e.checkVisibility()) return "absent"; const r = e.getBoundingClientRect(), br = b.getBoundingClientRect(); return r.bottom <= br.top + 1 ? "clear" : `under by ${Math.round(r.bottom - br.top)}px`; }, sel);
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default", PHONE);

  console.log("A · the bar");
  const a = await bar(p);
  ok("A1 · five entries fixed to the bottom edge, the strip gone, nothing spilling sideways", !!a && a.shown && a.bottom === 0 && !a.strip && !a.spill && a.labels.map((l) => l.replace(/[*]| · \d+\+?/g, "")).join("|") === "Today|Pipeline|Clients|Search|More", JSON.stringify(a));
  ok("A2 · no label is cut short and every target is at least 44px", !a.cut && a.tap >= 44, JSON.stringify({ cut: a.cut, tap: a.tap }));
  ok("A3 · Today is marked as the current page and carries its count", /^Today · \d+\*$/.test(a.labels[0]), a.labels[0]);
  await p.click('#phone-bar [data-bar="pipeline"]'); await p.waitForTimeout(900);
  const b1 = await bar(p);
  ok("A4 · Pipeline goes to Pipeline and takes the mark", b1.labels[1] === "Pipeline*" && !b1.labels[0].endsWith("*") && (await p.evaluate(() => document.getElementById("page-pipeline").checkVisibility())));
  await p.click('#phone-bar [data-bar="search"]'); await p.waitForTimeout(600);
  ok("A5 · Search opens the search box", await p.evaluate(() => !document.getElementById("palette-backdrop").classList.contains("hidden")));
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);

  console.log("B · More");
  await p.click('#phone-bar [data-bar="more"]'); await p.waitForTimeout(500);
  const more = await p.evaluate(() => [...document.querySelectorAll("#overlay-modal [data-more]")].map((x) => x.dataset.more));
  ok("B1 · More lists every other destination an owner can reach", more.join("|") === "diary|protection|retention|reports|vault|operations|site|settings", more.join("|"));
  await p.click('#overlay-modal [data-more="retention"]'); await p.waitForTimeout(900);
  const b2 = await bar(p);
  ok("B2 · choosing one goes there, closes the list, and marks More", (await p.evaluate(() => document.getElementById("page-retention").checkVisibility() && document.getElementById("overlay-backdrop").classList.contains("hidden"))) && b2.labels[4] === "More*" && b2.labels.filter((l) => l.endsWith("*")).length === 1, JSON.stringify(b2.labels));
  const adv = await boot(browser, "?as=p2&scope=default", PHONE);
  await adv.click('#phone-bar [data-bar="more"]'); await adv.waitForTimeout(500);
  const advMore = await adv.evaluate(() => [...document.querySelectorAll("#overlay-modal [data-more]")].map((x) => x.dataset.more));
  ok("B3 · an adviser's More has no Operations or Website — the sidebar's own role gates", !advMore.includes("operations") && !advMore.includes("site") && advMore.includes("settings"), advMore.join("|"));

  console.log("C · nothing hides under it");
  await p.evaluate(() => window.nav("clients")); await p.waitForTimeout(1200);
  await p.evaluate(() => { const c = document.querySelector("#page-clients .bulk-cb"); if (c) c.click(); }); await p.waitForTimeout(500);
  const cliDock = await clearOfBar(p, "#page-clients .bulk-bar");
  ok("C2 · Clients' bulk bar sits above the bar, not behind it", cliDock === "clear", cliDock);
  await p.evaluate(() => window.nav("settings")); await p.waitForTimeout(1200);
  await p.evaluate(() => { const i = document.querySelector('#settings-form input[type="number"], #settings-form input[type="text"]'); if (i) { i.value = String(Number(i.value || 0) + 1); i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); } }); await p.waitForTimeout(500);
  const save = await clearOfBar(p, "#settings-save");
  ok("C3 · the Settings Save bar is above the bar", save === "clear", save);
  await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(300);
  ok("C4 · the last thing on a page can be scrolled clear of the bar", await p.evaluate(() => { const m = document.getElementById("main"), b = document.getElementById("phone-bar"); const kids = [...m.querySelectorAll(".page:not(.hidden) *")].filter((e) => e.checkVisibility() && e.getBoundingClientRect().height > 0 && getComputedStyle(e).position !== "sticky"); const last = Math.max(...kids.map((e) => e.getBoundingClientRect().bottom)); return last <= b.getBoundingClientRect().top + 1; }));
  await p.evaluate(() => window.toast("Saved")); await p.waitForTimeout(200);
  const toast = await clearOfBar(p, ".toast");
  ok("C5 · a toast shows above the bar", toast === "clear", toast);
  const id = await p.evaluate(async () => (await window.__mockDb.from("cases").select("id,stage,client_id")).data.find((c) => c.stage === "application" && c.client_id).id);
  await p.evaluate((i) => window.openCase(i), id); await p.waitForTimeout(1500);
  ok("C6 · an open record covers the bar", await p.evaluate(() => { const b = document.getElementById("phone-bar").getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!top && !top.closest("#phone-bar"); }));
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);

  console.log("D · where it does not apply");
  const desk = await boot(browser, "?as=p4&scope=default", { width: 1366, height: 768 });
  const d = await bar(desk);
  ok("D1 · on a laptop the bar is not shown and the sidebar is as it was", !!d && !d.shown && d.strip);
  const legacy = await boot(browser, "?as=p4", PHONE);
  ok("D2 · the harness seam keeps the strip and has no bar", await legacy.evaluate(() => !document.getElementById("phone-bar") && document.querySelector(".sidenav").checkVisibility() && !document.body.classList.contains("has-phone-bar")));
  const tour = await boot(browser, "?as=p4&scope=default", PHONE, true);
  await tour.evaluate(() => { const b = document.getElementById("help-btn"); if (b) b.click(); }); await tour.waitForTimeout(500);
  await tour.evaluate(() => { const b = [...document.querySelectorAll("#overlay-modal button")].find((x) => /tour/i.test(x.textContent)); if (b) b.click(); }); await tour.waitForTimeout(900);
  const during = await tour.evaluate(() => ({ on: !!document.getElementById("tour-overlay"), strip: document.querySelector(".sidenav").checkVisibility(), bar: document.getElementById("phone-bar").checkVisibility() }));
  ok("D3 · while the tour runs the strip it points at is back and the bar is away", during.on && during.strip && !during.bar, JSON.stringify(during));
  await tour.keyboard.press("Escape"); await tour.waitForTimeout(500);
  const after = await tour.evaluate(() => ({ on: !!document.getElementById("tour-overlay"), strip: document.querySelector(".sidenav").checkVisibility(), bar: document.getElementById("phone-bar").checkVisibility() }));
  ok("D4 · and the bar returns when the tour ends", !after.on && !after.strip && after.bar, JSON.stringify(after));

  const errs = [p, adv, desk, legacy, tour].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr114_phone_bar: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
