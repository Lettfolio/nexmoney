/* R105 — T2/B6/X8: one main button per row, the rest behind ⋯ (Today, Retention, Operations).
   node tests/r105_rows.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL row layout. */
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
/* Per row: the verbs on show OUTSIDE the text column (buttons / .btn links / the ⋯ handle), and what the menu holds. */
const rowsOf = (p, sel) => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((r) => r.checkVisibility()).map((r) => {
  const outside = (el) => !el.closest(".row-main") && !el.closest(".row-more-body");
  const shown = [...r.querySelectorAll("button, a.btn")].filter((b) => outside(b) && b.checkVisibility());
  const menu = [...r.children].find((c) => c.matches && c.matches("details.row-one")) || r.querySelector(":scope > .row-acts > details.row-one, :scope > details.row-one");
  return { shown: shown.map((b) => b.textContent.trim()), acts: shown.map((b) => b.dataset.act || ""), menu: !!menu,
    inMenu: menu ? [...menu.querySelectorAll(".row-more-body > button, .row-more-body > a, .row-more-body > details")].length : 0,
    handle: menu ? menu.querySelector("summary").textContent.trim() : "" };
}), sel);
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  await p.evaluate(() => { document.querySelectorAll("#briefing-list details.brief-fold").forEach((d) => { d.open = true; }); });

  console.log("A · Today");
  const today = await rowsOf(p, "#briefing-list .brief-row");
  ok("A0 · fixture · My Day has rows", today.length > 5, String(today.length));
  ok("A1 · no row shows more than two buttons beside its text", today.every((r) => r.shown.length <= 2), JSON.stringify(today.filter((r) => r.shown.length > 2).slice(0, 2)));
  ok("A2 · a row with a menu shows exactly one button, and the handle reads ⋯", today.filter((r) => r.menu).every((r) => r.shown.length === 1 && r.handle === "⋯") && today.some((r) => r.menu), JSON.stringify(today.filter((r) => r.menu).slice(0, 2)));
  ok("A3 · a menu is never built for one leftover", today.filter((r) => r.menu).every((r) => r.inMenu >= 2), JSON.stringify(today.filter((r) => r.menu && r.inMenu < 2)));
  ok("A4 · a task row's button is ✓ Done", today.some((r) => r.menu && r.acts[0] === "briefDone"), JSON.stringify(today.map((r) => r.acts[0])));
  const before = await p.evaluate(() => { const d = document.querySelector("#briefing-list .brief-row > details.row-one"); return { open: d.open, vis: d.querySelector(".row-more-body > *").checkVisibility() }; });
  ok("A5 · the menu starts shut and its verbs are not on show", before.open === false && before.vis === false, JSON.stringify(before));
  await p.click("#briefing-list .brief-row > details.row-one > summary"); await p.waitForTimeout(200);
  const opened = await p.evaluate(() => { const d = document.querySelector("#briefing-list .brief-row > details.row-one"); return { open: d.open, labels: [...d.querySelectorAll(".row-more-body > *")].map((e) => (e.querySelector("summary") || e).textContent.trim()), vis: d.querySelector(".row-more-body > *").checkVisibility() }; });
  ok("A6 · pressing ⋯ shows the other verbs (Snooze and Open among them)", opened.open && opened.vis && opened.labels.some((l) => /Snooze/.test(l)) && opened.labels.includes("Open"), JSON.stringify(opened));
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);
  ok("A7 · Escape folds it back up", await p.evaluate(() => !document.querySelector("#briefing-list details.row-one[open]")));
  const two = [];
  for (const h of await p.$$("#briefing-list .brief-row > details.row-one > summary")) { if (await h.isVisible()) two.push(h); if (two.length === 2) break; }
  if (two.length > 1) { await two[0].click(); await two[1].click(); await p.waitForTimeout(150); }
  ok("A8 · opening a second menu shuts the first", two.length < 2 || (await p.evaluate(() => document.querySelectorAll("#briefing-list details.row-one[open]").length)) === 1);
  await p.keyboard.press("Escape");
  // Open, from inside the menu, opens the case — the moved button is the same button.
  await p.evaluate(() => { const r = [...document.querySelectorAll("#briefing-list .brief-row[data-case]")].find((x) => x.checkVisibility() && x.querySelector(':scope > details.row-one .row-more-body > button[data-act="openCase"]')); r.setAttribute("data-t105", "1"); });
  await p.click("[data-t105] > details.row-one > summary"); await p.waitForTimeout(150);
  await p.click('[data-t105] > details.row-one[open] .row-more-body > button[data-act="openCase"]'); await p.waitForTimeout(900);
  ok("A9 · Open inside the menu opens the case panel", await p.evaluate(() => { const m = document.getElementById("modal"); return !!m && m.checkVisibility(); }));
  ok("A10 · …and the menu folded itself up behind it", await p.evaluate(() => !document.querySelector("#briefing-list details.row-one[open]")));
  await p.keyboard.press("Escape"); await p.waitForTimeout(400);
  // ✓ Done still completes the task in one press.
  const n0 = await p.evaluate(() => document.querySelectorAll('#briefing-list .brief-row > button[data-act="briefDone"]').length);
  await p.locator('#briefing-list .brief-row > button[data-act="briefDone"]:visible').first().click(); await p.waitForTimeout(1200);
  const n1 = await p.evaluate(() => document.querySelectorAll('#briefing-list .brief-row > button[data-act="briefDone"]').length);
  ok("A11 · ✓ Done is still one press", n1 === n0 - 1, JSON.stringify({ n0, n1 }));

  console.log("B · Retention");
  await p.click('[data-page="retention"]'); await p.waitForTimeout(1800);
  const ret = await rowsOf(p, "#page-retention .kit-row.ret-row");
  ok("B0 · fixture · Retention has rows", ret.length > 5, String(ret.length));
  ok("B1 · every row leads with Log call", ret.every((r) => /Log call/.test(r.shown[0] || "")), JSON.stringify(ret.map((r) => r.shown[0]).slice(0, 4)));
  ok("B2 · one button plus ⋯, or two buttons and no menu", ret.every((r) => (r.menu && r.shown.length === 1 && r.handle === "⋯" && r.inMenu >= 2) || (!r.menu && r.shown.length <= 2)), JSON.stringify(ret.filter((r) => !((r.menu && r.shown.length === 1) || (!r.menu && r.shown.length <= 2))).slice(0, 2)));
  ok("B3 · no row still says More ▾", await p.evaluate(() => ![...document.querySelectorAll("#page-retention .ret-row summary")].some((s) => /More/.test(s.textContent))));
  const startRow = await p.$('#page-retention .ret-row details.row-one .row-more-body > button[data-act="startRetentionCase"]');
  ok("B4 · Start retention case lives in the menu", !!startRow);
  ok("B5 · the bulk bar keeps its own More ▾ (not a row)", await p.evaluate(() => !document.querySelector(".bulk-bar details.row-one")));

  console.log("C · Operations");
  await p.click('[data-page="operations"]'); await p.waitForTimeout(1800);
  const ops = await rowsOf(p, "#page-operations .row-item");
  const opsActs = ops.filter((r) => r.shown.length);
  ok("C0 · fixture · Operations has rows with verbs", opsActs.length > 3, String(opsActs.length));
  ok("C1 · no row shows more than two buttons", ops.every((r) => r.shown.length <= 2), JSON.stringify(ops.filter((r) => r.shown.length > 2).slice(0, 2)));
  ok("C2 · a failed send with a bad contact leads with Fix contact; Retry and Cancel are in the menu", ops.some((r) => r.menu && r.acts[0] === "fixContactOpen" && r.inMenu === 2), JSON.stringify(ops.filter((r) => r.menu).slice(0, 2)));
  ok("C3 · a queued email keeps its single Cancel on the row", ops.some((r) => !r.menu && r.shown.length === 1 && r.shown[0] === "Cancel"));

  console.log("D · the seam");
  const legacy = await boot(browser, "?as=p4");
  ok("D1 · without ?scope=default the harness shows every verb on the row (what the older suites click)", await legacy.evaluate(() => !document.querySelector("details.row-one") && !!document.querySelector("#briefing-list .brief-row > .snooze-wrap, #briefing-list .brief-row > details")));

  const errs = [p, legacy].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr105_rows: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
