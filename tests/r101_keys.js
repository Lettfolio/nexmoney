/* R101 — keyboard shortcuts and refresh-on-return.
   node tests/r101_keys.js   (static server on :8099, admin/mock.html built by smoke.js) */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
(async () => {
  const browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + "?as=p4"); await p.waitForFunction(() => window.nav && document.querySelector("#page-dashboard"), null, { timeout: 20000 }); await p.waitForTimeout(1500);
  const page = () => p.evaluate(() => location.hash.replace(/^#/, "") || "today");
  const hidden = (sel) => p.evaluate((s) => document.querySelector(s).classList.contains("hidden"), sel);
  const blur = () => p.evaluate(() => document.activeElement && document.activeElement.blur());

  console.log("A · go-to keys");
  for (const [k, want] of [["p", "pipeline"], ["c", "clients"], ["d", "diary"], ["r", "retention"], ["t", "today"]]) {
    await blur(); await p.keyboard.press("g"); await p.keyboard.press(k); await p.waitForTimeout(500);
    ok(`A · g ${k} goes to ${want}`, (await page()).startsWith(want), await page());
  }
  await blur(); await p.keyboard.press("p"); await p.waitForTimeout(300);
  ok("A6 · a letter without g first does nothing", (await page()).startsWith("today"), await page());
  await p.keyboard.press("g"); await p.waitForTimeout(1700); await p.keyboard.press("p"); await p.waitForTimeout(300);
  ok("A7 · g expires after 1.5s", (await page()).startsWith("today"), await page());

  console.log("B · palette, new case, help");
  await blur(); await p.keyboard.press("Control+k"); await p.waitForTimeout(300);
  ok("B1 · Ctrl+K opens the palette", !(await hidden("#palette-backdrop")));
  await p.keyboard.type("gp"); await p.waitForTimeout(300);
  ok("B2 · typing g p in the palette types, and does not navigate", (await page()).startsWith("today") && await p.evaluate(() => document.getElementById("palette-input").value === "gp"));
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  await blur(); await p.keyboard.press("/"); await p.waitForTimeout(300);
  ok("B3 · / still opens the palette", !(await hidden("#palette-backdrop")));
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  await blur(); await p.keyboard.press("?"); await p.waitForTimeout(400);
  ok("B4 · ? opens Help, which lists the shortcuts", !(await hidden("#overlay-backdrop")) && await p.evaluate(() => !!document.getElementById("help-keys") && document.querySelectorAll("#help-keys .glossary-row").length === 5));
  await p.keyboard.press("g"); await p.keyboard.press("p"); await p.waitForTimeout(300);
  ok("B5 · with Help open the page keys stand down", (await page()).startsWith("today"), await page());
  await p.evaluate(() => document.getElementById("help-close").click()); await p.waitForTimeout(300);
  await blur(); await p.keyboard.press("n"); await p.waitForTimeout(900);
  ok("B6 · n opens a new case", !(await hidden("#modal-backdrop")) && await p.evaluate(() => /new case/i.test(document.getElementById("modal-backdrop").textContent)));
  await p.keyboard.press("g"); await p.keyboard.press("c"); await p.waitForTimeout(300);
  ok("B7 · with a record open the page keys stand down", (await page()).startsWith("today"), await page());
  await p.keyboard.press("Escape"); await p.waitForTimeout(500);
  await p.evaluate(() => window.nav("clients")); await p.waitForTimeout(800);
  await p.focus("#client-search"); await p.keyboard.type("np"); await p.waitForTimeout(300);
  ok("B8 · keys typed into a field are just text", await hidden("#modal-backdrop") && await p.evaluate(() => document.getElementById("client-search").value === "np"));

  console.log("C · refresh on return");
  await blur();
  const run = (awayMs, pre) => p.evaluate(({ awayMs, pre }) => {
    if (pre) (new Function(pre))();
    window.__navs = 0; const orig = window.nav; window.nav = function () { window.__navs++; return orig.apply(this, arguments); };
    const set = (h) => Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    const realNow = Date.now; set(true); const a = window.refreshOnReturn();
    Date.now = () => realNow() + awayMs; set(false); const b = window.refreshOnReturn(); Date.now = realNow;
    window.nav = orig; delete document.hidden;
    return [a, b];
  }, { awayMs, pre });
  ok("C1 · back after 2 minutes: the page re-reads", JSON.stringify(await run(120000)) === "[false,true]");
  ok("C2 · back after 10 seconds: nothing happens", JSON.stringify(await run(10000)) === "[false,false]");
  ok("C3 · a field has focus: nothing happens", JSON.stringify(await run(120000, 'document.getElementById("client-search").focus()')) === "[false,false]");
  await blur();
  await p.evaluate(() => window.openHelpPanel()); await p.waitForTimeout(300);
  ok("C4 · a panel is open: nothing happens", JSON.stringify(await run(120000)) === "[false,false]");
  await p.evaluate(() => document.getElementById("help-close").click()); await p.waitForTimeout(300);
  ok("C5 · it keeps you on the same page and tab", (await page()).startsWith("clients"), await page());
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr101_keys: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
