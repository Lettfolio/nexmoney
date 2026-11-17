/* R115 — O5: each Reports headline figure carries the twelve months ending in the month on show.
   node tests/r115_trend.js   (static server on :8099, admin/mock.html built by smoke.js) */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs) {
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#app-view") && !document.querySelector("#app-view").classList.contains("hidden") && typeof window.nav === "function", null, { timeout: 30000 });
  await p.waitForTimeout(2000);
  await p.evaluate(() => window.nav("reports")); await p.waitForTimeout(2000);
  return p;
}
const read = (p) => p.evaluate(() => { const t = (sel) => { const e = document.querySelector(sel); if (!e) return null; const pts = e.querySelector("svg polyline").getAttribute("points").trim().split(" "); const k = e.closest(".kpi");
    return { months: e.title.split(" · ").map((x) => x.replace(/ [£\d,.-]+$/, "")), vals: e.title.split(" · ").map((x) => Number(x.split(" ").pop().replace(/[£,]/g, ""))), points: pts.length, said: e.querySelector(".sr-only").textContent, shown: k ? k.querySelector(".num").textContent.trim() : document.querySelector("#report-hero .rep-hero-num").textContent.trim(), caption: e.textContent.includes("12 months") }; };
  return { n: document.querySelectorAll("#page-reports .kpi-trend").length, hero: t("#report-hero .kpi-trend"), sub: t("#month-kpis .kpi:nth-child(1) .kpi-trend"), subMoney: t("#month-kpis .kpi-secondary .kpi-trend"), done: t("#month-kpis .kpi:last-child .kpi-trend"), month: (document.querySelector("#report-month") || {}).value }; });
const num = (s) => Number(String(s).replace(/[^\d.]/g, ""));
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  const r = await read(p);
  console.log("A · the owner's Reports");
  ok("A1 · four headline figures, four twelve-month lines", r.n === 4 && [r.hero, r.sub, r.subMoney, r.done].every((t) => t && t.points === 12 && t.months.length === 12 && t.caption), JSON.stringify({ n: r.n }));
  const now = new Date(), MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], want = Array.from({ length: 12 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1); return MON[d.getMonth()] + " " + String(d.getFullYear()).slice(2); });
  ok("A2 · the months run oldest first and end on the month on show", r.hero.months.join("|") === want.join("|"), r.hero.months.join("|"));
  ok("A3 · the last point of each line is the figure printed above it", num(r.hero.shown) === r.hero.vals[11] && num(r.sub.shown) === r.sub.vals[11] && num(r.subMoney.shown) === r.subMoney.vals[11] && num(r.done.shown) === r.done.vals[11], JSON.stringify({ hero: [r.hero.shown, r.hero.vals[11]], sub: [r.sub.shown, r.sub.vals[11]], money: [r.subMoney.shown, r.subMoney.vals[11]], done: [r.done.shown, r.done.vals[11]] }));
  const truth = await p.evaluate(async () => { const { data } = await window.__mockDb.from("cases").select("completed_at,stage"); const d = new Date(), m = new Date(d.getFullYear(), d.getMonth() - 1, 1), key = m.getFullYear() + "-" + String(m.getMonth() + 1).padStart(2, "0"); return data.filter((c) => c.completed_at && String(c.completed_at).slice(0, 7) === key).length; });
  ok("A4 · last month's completions on the line match the cases completed last month", Math.abs(r.done.vals[10] - truth) <= 1, `line ${r.done.vals[10]}, cases ${truth}`);
  ok("A5 · a screen reader is given the months and values in words", /^Twelve months to .+: .+ · /.test(r.hero.said) && r.hero.said.includes("£"));
  await p.evaluate(() => { const pk = document.querySelector("#report-month"); const d = new Date(); const m = new Date(d.getFullYear(), d.getMonth() - 3, 1); pk.value = m.getFullYear() + "-" + String(m.getMonth() + 1).padStart(2, "0"); pk.dispatchEvent(new Event("change", { bubbles: true })); }); await p.waitForTimeout(1800);
  const back = await read(p);
  ok("A6 · choosing an earlier month moves the twelve months with it", back.hero.months[11] === want[8] && num(back.done.shown) === back.done.vals[11], back.hero.months[11] + " vs " + want[8]);

  console.log("B · an adviser");
  const adv = await boot(browser, "?as=p2&scope=default");
  const a = await read(adv);
  const advPage = await adv.evaluate(() => ({ kpis: document.querySelectorAll("#month-kpis .kpi").length, shown: !!document.querySelector("#month-kpis") && document.querySelector("#month-kpis").checkVisibility(), hero: document.querySelector("#report-hero").checkVisibility() }));
  ok("B1 · is shown no money line (their Reports has no monthly tiles at all)", !a.hero && !a.subMoney && !advPage.hero, JSON.stringify({ n: a.n, advPage }));

  const errs = [p, adv].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr115_trend: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
