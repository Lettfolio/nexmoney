/* R102 — Daniel's decisions from the 14 Nov UI/UX review.
   node tests/r102_decisions.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness's firm-wide seam, so these read the app's REAL defaults. */
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
const scope = (p) => p.evaluate(() => ({
  mine: document.getElementById("brief-scope-mine").classList.contains("scope-active"),
  all: document.getElementById("brief-scope-all").classList.contains("scope-active"),
}));
(async () => {
  const browser = await chromium.launch();

  console.log("A · T3 — whose day Today opens on");
  const owner = await boot(browser, "?as=p4&scope=default");
  ok("A1 · the owner's Today opens on Mine", JSON.stringify(await scope(owner)) === '{"mine":true,"all":false}', JSON.stringify(await scope(owner)));
  const admin = await boot(browser, "?as=p1&scope=default");
  ok("A2 · an administrator's Today still opens on All", JSON.stringify(await scope(admin)) === '{"mine":false,"all":true}', JSON.stringify(await scope(admin)));
  const adv = await boot(browser, "?as=p2&scope=default");
  ok("A3 · an adviser's Today opens on Mine, as before", JSON.stringify(await scope(adv)) === '{"mine":true,"all":false}', JSON.stringify(await scope(adv)));
  await owner.click("#brief-scope-all");
  await owner.waitForTimeout(700);
  ok("A4 · All is one press away for the owner", (await scope(owner)).all);

  console.log("B · T3 — overdue and today on the first screen; Worth doing folded");
  const firm = await boot(browser, "?as=p4");
  const bands = await firm.evaluate(() => {
    const list = document.getElementById("briefing-list");
    const secs = [...list.querySelectorAll(".brief-sec")].map((s) => [...s.classList].find((c) => /^brief-sec-(warm|hot|rest)$/.test(c)).replace("brief-sec-", ""));
    const rest = list.querySelector(".brief-sec-rest");
    let fold = rest && rest.nextElementSibling;
    const direct = [];
    while (fold && fold.classList.contains("brief-row")) { direct.push(fold); fold = fold.nextElementSibling; }
    const vis = (e) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    return {
      secs, restDirectRows: direct.length,
      foldIsDetails: !!fold && fold.matches("details.brief-fold"), foldOpen: !!fold && fold.open,
      foldRows: fold ? fold.querySelectorAll(".brief-row:not(.brief-subrow)").length : 0,
      foldSummary: fold ? fold.querySelector("summary").textContent.trim() : "",
      visibleRestRows: fold ? [...fold.querySelectorAll(".brief-row")].filter(vis).length : -1,
      todayRowsVisible: [...list.querySelectorAll(".brief-sec-warm ~ .brief-row")].filter(vis).length,
    };
  });
  ok("B1 · the bands are still Today, Urgent, Worth doing, in that order", JSON.stringify(bands.secs) === '["warm","hot","rest"]', JSON.stringify(bands.secs));
  ok("B2 · Worth doing shows no rows until asked: all of them sit in one closed fold", bands.restDirectRows === 0 && bands.foldIsDetails && !bands.foldOpen && bands.foldRows > 0 && bands.visibleRestRows === 0, JSON.stringify(bands));
  ok("B3 · the fold says how many it holds", new RegExp(`^Show the other ${bands.foldRows} worth doing items?$`).test(bands.foldSummary), bands.foldSummary);
  ok("B4 · today's rows are on screen", bands.todayRowsVisible > 0, String(bands.todayRowsVisible));

  console.log("C · T1 — My Day leads the page");
  const order = await firm.evaluate(() => {
    const ids = [...document.querySelectorAll("#page-dashboard > *")].map((e) => e.id).filter(Boolean);
    const top = (id) => Math.round(document.getElementById(id).getBoundingClientRect().top + window.scrollY);
    return { ids: ids.slice(ids.indexOf("today-heading"), ids.indexOf("today-heading") + 5), firstRow: Math.round(document.querySelector("#briefing-list .brief-row").getBoundingClientRect().top), kpiBelow: top("kpi-row") > top("briefing-panel") };
  });
  ok("C1 · heading, My Day, tiles, cap notice, ops strip", JSON.stringify(order.ids) === '["today-heading","briefing-panel","kpi-row","dash-cap-notice","ops-strip"]', JSON.stringify(order.ids));
  ok("C2 · the first task row starts in the top half of a 768px screen", order.firstRow < 384 && order.kpiBelow, JSON.stringify(order));

  console.log("D · B2 — Clients opens on Recently touched");
  await owner.evaluate(() => window.nav("clients"));
  await owner.waitForSelector("#cl-sort");
  await owner.waitForTimeout(900);
  const cl = await owner.evaluate(() => {
    const byId = {}; window.__mock.db.clients.forEach((c) => { byId[c.id] = String(c.updated_at || c.created_at || ""); });
    window.__mock.db.cases.forEach((x) => { const u = String(x.updated_at || ""); if (x.client_id && u > (byId[x.client_id] || "")) byId[x.client_id] = u; });
    const ids = [...document.querySelectorAll("#page-clients [data-act='openClient'], #page-clients .kit-row .t")].map((e) => { try { return JSON.parse(e.getAttribute("data-args") || "[]")[0]; } catch (_) { return null; } }).filter(Boolean);
    const stamps = ids.map((id) => byId[id]);
    return { sort: document.getElementById("cl-sort").value, n: ids.length, desc: stamps.every((v, i) => i === 0 || stamps[i - 1] >= v) };
  });
  ok("D1 · the sort control starts on Recently touched", cl.sort === "touched", cl.sort);
  ok("D2 · the rows run newest-touched first (client or any of their cases)", cl.n > 5 && cl.desc, JSON.stringify(cl));
  await firm.evaluate(() => window.nav("clients"));
  await firm.waitForSelector("#cl-sort");
  ok("D3 · the harness seam keeps A–Z for the older suites", await firm.evaluate(() => document.getElementById("cl-sort").value) === "name");

  const errs = [owner, admin, adv, firm].flatMap((p) => p.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr102_decisions: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
