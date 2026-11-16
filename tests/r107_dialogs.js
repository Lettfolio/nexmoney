/* R107 — X3 in-app confirm / type-in, N1 sidebar counts, X4 loading placeholders.
   node tests/r107_dialogs.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL behaviour. */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs) {
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  p.__errs = []; p.__dialogs = 0; p.on("pageerror", (e) => p.__errs.push(String(e)));
  p.on("dialog", (d) => { p.__dialogs++; d.accept(); });
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  await p.waitForTimeout(700);
  return p;
}
const overlay = (p) => p.evaluate(() => { const b = document.getElementById("overlay-modal"), back = document.getElementById("overlay-backdrop");
  const on = !!b && !!back && !back.classList.contains("hidden") && b.checkVisibility();
  return { on, title: on ? (b.querySelector("h3") || {}).textContent : "", btns: on ? [...b.querySelectorAll(".modal-actions button")].map((x) => x.textContent.trim()) : [], input: on && !!b.querySelector("input[type=text]") }; });
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");

  console.log("A · sidebar counts");
  const nav = await p.evaluate(() => { const n = (pg) => { const c = document.querySelector(`.sidenav button[data-page="${pg}"] .nav-n`); return c ? c.textContent : ""; };
    document.querySelectorAll("#briefing-list details.brief-fold").forEach((d) => { d.open = true; });
    const due = [...document.querySelectorAll("#briefing-list .brief-band, #briefing-list [data-band]")];
    return { today: n("dashboard"), ret: n("retention"), ops: n("operations"), failed: (document.getElementById("ops-emails-failed") || { dataset: {} }).dataset.n || "",
      others: [...document.querySelectorAll(".sidenav button .nav-n")].length }; });
  ok("A1 · Today carries a count", /^\d+\+?$/.test(nav.today), JSON.stringify(nav));
  ok("A2 · Operations' count is the 'emails failed' figure Today's strip shows (or absent at zero)", nav.ops === (Number(nav.failed) > 0 ? nav.failed : ""), JSON.stringify(nav));
  await p.click('[data-page="retention"]'); await p.waitForTimeout(1800);
  const ret = await p.evaluate(() => ({ badge: (document.querySelector('.sidenav button[data-page="retention"] .nav-n') || {}).textContent || "", text: document.getElementById("page-retention").innerText }));
  ok("A3 · Retention carries a count (the fixture has ended rates)", /^\d+\+?$/.test(ret.badge), ret.badge);
  ok("A4 · …and the page states the same number of ended rates", ret.badge === "" || new RegExp(`\\bended\\s+${ret.badge}\\b`, "i").test(ret.text), ret.badge + " / " + (ret.text.match(/[^\n]*[Ee]nded[^\n]*/) || [""])[0].slice(0, 120));
  ok("A5 · only those three entries ever carry a count", nav.others <= 3, String(nav.others));

  console.log("B · confirm in the house overlay");
  await p.click('[data-page="operations"]'); await p.waitForTimeout(1800);
  const rowsBefore = await p.evaluate(() => document.querySelectorAll('#email-list button[data-act="cancelQueuedRow"], #email-list button[data-act="cancelEmail"]').length);
  const cancelSel = '#email-list .row-item button:has-text("Cancel"):visible';
  await p.locator(cancelSel).first().click(); await p.waitForTimeout(700);
  const o1 = await overlay(p);
  ok("B1 · Cancel on a queued email opens the in-app dialog, not a browser box", o1.on && p.__dialogs === 0, JSON.stringify({ o1, dialogs: p.__dialogs }));
  ok("B2 · its heading is the question and its buttons are Go back / a verb", /^Cancel this (queued|failed) email to /.test(o1.title) && o1.btns.join("|") === "Go back|Cancel this email", JSON.stringify(o1));
  const cancelsBefore = await p.locator(cancelSel).count();
  await p.click("#overlay-modal #ovl-confirm-cancel"); await p.waitForTimeout(500);
  ok("B3 · Go back changes nothing", !(await overlay(p)).on && (await p.locator(cancelSel).count()) === cancelsBefore);
  await p.locator(cancelSel).first().click(); await p.waitForTimeout(700);
  await p.click("#overlay-modal #ovl-confirm-ok"); await p.waitForTimeout(1500);
  ok("B4 · the verb carries it out — one fewer row can be cancelled", (await p.locator(cancelSel).count()) === cancelsBefore - 1, JSON.stringify({ before: cancelsBefore, after: await p.locator(cancelSel).count() }));

  console.log("C · type-in in the house overlay");
  await p.click('[data-page="pipeline"]'); await p.waitForTimeout(1800);
  await p.click("#board-view-save"); await p.waitForTimeout(600);
  const o2 = await overlay(p);
  ok("C1 · Save view asks for the name in the in-app dialog", o2.on && o2.input && /Save current pipeline filters/.test(o2.title) && p.__dialogs === 0, JSON.stringify(o2));
  await p.fill("#ovl-ask-input", "R107 view"); await p.keyboard.press("Enter"); await p.waitForTimeout(900);
  ok("C2 · Enter saves it — the view is in the Saved views list", await p.evaluate(() => [...document.querySelectorAll("#board-views option")].some((o) => o.textContent.trim() === "R107 view")));
  await p.click("#board-view-save"); await p.waitForTimeout(500);
  await p.click("#ovl-ask-cancel"); await p.waitForTimeout(400);
  ok("C3 · Cancel saves nothing", await p.evaluate(() => [...document.querySelectorAll("#board-views option")].filter((o) => /R107/.test(o.textContent)).length === 1));
  ok("C4 · no browser dialog was raised anywhere in this run", p.__dialogs === 0, String(p.__dialogs));

  console.log("D · loading placeholders");
  for (const pg of ["dashboard", "clients", "retention", "operations", "vault"]) { await p.click(`[data-page="${pg}"]`); await p.waitForTimeout(1500); }
  ok("D1 · no placeholder is left behind on any page once it has loaded", await p.evaluate(() => document.querySelectorAll(".skel").length === 0), await p.evaluate(() => [...document.querySelectorAll(".skel")].map((s) => s.parentElement.id).join(",")));
  const sk = await p.evaluate(() => { const h = document.getElementById("client-list"); h.innerHTML = ""; paintSkeleton("clients"); const n = h.querySelectorAll(".skel > i").length; h.innerHTML = "<div class='kit-row'>x</div>"; paintSkeleton("clients"); return { n, kept: !h.querySelector(".skel") }; });
  ok("D2 · an empty list gets six placeholder bars; a list already on show is never overwritten", sk.n === 6 && sk.kept, JSON.stringify(sk));

  console.log("E · the seam");
  const legacy = await boot(browser, "?as=p4");
  ok("E1 · under the harness seam there are no sidebar counts or placeholders", await legacy.evaluate(() => !document.querySelector(".nav-n") && !document.querySelector(".skel")));
  await legacy.click('[data-page="pipeline"]'); await legacy.waitForTimeout(1500);
  await legacy.click("#board-view-save"); await legacy.waitForTimeout(600);
  ok("E2 · …and Save view still raises the native box the older suites answer", legacy.__dialogs === 1 && !(await overlay(legacy)).on, String(legacy.__dialogs));

  const errs = [p, legacy].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr107_dialogs: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
