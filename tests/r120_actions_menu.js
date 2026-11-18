/* R120 — the case record's Actions menu stays on the screen on a phone (it opened 96px off the left edge).
   node tests/r120_actions_menu.js   (static server on :8099, admin/mock.html built by smoke.js) */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs, vp) {
  const phone = vp.width < 900;
  const ctx = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone });
  const p = await ctx.newPage();
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  await p.waitForTimeout(600);
  const id = await p.evaluate(async () => { const { data } = await window.__mockDb.from("cases").select("id,stage"); return (data.find((c) => c.stage === "offer") || data[0]).id; });
  await p.evaluate((i) => window.openCase(i), id); await p.waitForTimeout(1800);
  return p;
}
const press = async (p) => { await p.evaluate(() => document.getElementById("case-more-actions-toggle").scrollIntoView({ block: "center" })); await p.click("#case-more-actions-toggle"); await p.waitForTimeout(350); };
const menu = (p) => p.evaluate(() => { const m = document.getElementById("case-more-actions"), r = m.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = innerHeight;
  const items = [...m.querySelectorAll("button, a")].filter((e) => e.checkVisibility()); if (!items.length) return { open: m.checkVisibility() }; const f = items[0], fr = f.getBoundingClientRect();
  const hit = document.elementFromPoint(fr.left + 12, fr.top + fr.height / 2);
  return { open: m.checkVisibility(), l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), vw, vh, n: items.length, itemsIn: items.every((e) => e.getBoundingClientRect().left >= 0 && e.getBoundingClientRect().right <= vw), firstHit: !!hit && (hit === f || f.contains(hit)), firstText: f.textContent.trim().length, scrolls: m.scrollHeight > m.clientHeight + 1, inlineLeft: m.style.left }; });
const fits = (m) => m.open && m.l >= 0 && m.r <= m.vw && m.b <= m.vh && m.itemsIn;
(async () => {
  const browser = await chromium.launch();

  console.log("A · on a phone");
  const p = await boot(browser, "?as=p4&scope=default", { width: 390, height: 844 });
  await press(p); const a = await menu(p);
  ok("A1 · the whole menu is on the screen", fits(a) && a.n >= 5, JSON.stringify(a));
  ok("A2 · it keeps a margin from the left edge and its first item can be pressed", a.l >= 8 && a.firstHit && a.firstText > 3, JSON.stringify(a));
  await press(p); ok("A3 · pressing Actions again closes it", !(await menu(p)).open);
  await press(p); ok("A4 · and it is still on the screen the second time", fits(await menu(p)));
  await press(p);
  const s = await boot(browser, "?as=p4&scope=default", { width: 390, height: 560 });
  await press(s); const b = await menu(s);
  ok("A5 · on a short screen it stops above the bottom and scrolls inside itself", fits(b) && b.scrolls, JSON.stringify(b));
  const n = await boot(browser, "?as=p4&scope=default", { width: 320, height: 640 });
  await press(n); const c = await menu(n);
  ok("A6 · on the narrowest phone it is no wider than the screen", fits(c) && c.w <= 320 - 16 + 1, JSON.stringify(c));
  const seam = await boot(browser, "?as=p4", { width: 390, height: 844 });
  await press(seam); ok("A7 · the old 640px panel (harness seam) keeps its menu on the screen too", fits(await menu(seam)), JSON.stringify(await menu(seam)));

  console.log("B · on wider screens nothing moves");
  for (const [label, vp] of [["tablet", { width: 820, height: 1100 }], ["desktop", { width: 1366, height: 768 }]]) {
    const w = await boot(browser, "?as=p4&scope=default", vp); await press(w); const m = await menu(w);
    ok(`B · ${label}: on the screen, and left where the stylesheet puts it`, fits(m) && m.inlineLeft === "", JSON.stringify(m));
    p.__errs.push(...w.__errs);
  }
  const errs = [p, s, n, seam].flatMap((x) => x.__errs);
  ok("E1 · no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  console.log(`\nr120_actions_menu: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
