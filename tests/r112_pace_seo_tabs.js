/* R112 — O4: the Reports target reads against how much of the month has gone. O10: the SEO tab is two inner tabs.
   node tests/r112_pace_seo_tabs.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL layout. */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs, clock) {
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  if (clock) await p.clock.setFixedTime(new Date(clock));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#app-view") && !document.querySelector("#app-view").classList.contains("hidden") && typeof window.nav === "function", null, { timeout: 30000 });
  await p.waitForTimeout(2000);
  return p;
}
const hero = async (p, target) => {
  if (target != null) await p.evaluate(async (t) => { await window.__mockDb.from("settings").update({ value: String(t) }).eq("key", "monthly_fee_target"); await loadSettings(); }, target);
  await p.evaluate(() => window.nav("dashboard")); await p.waitForTimeout(300);
  await p.evaluate(() => window.nav("reports")); await p.waitForTimeout(1800);
  return p.evaluate(() => { const e = document.querySelector("#report-hero .rep-hero-pct"), n = document.querySelector("#report-hero .rep-hero-num"); return e ? { text: e.textContent.trim(), colour: e.style.color, title: e.title, earned: Number(n.textContent.replace(/[^\d.]/g, "")) } : null; });
};
(async () => {
  const browser = await chromium.launch();

  console.log("A · O4 — the target is read against the date");
  // The 10th of this month, so the sample data (seeded around today) still has a "this month".
  const d10 = new Date(); d10.setDate(10); d10.setHours(10, 0, 0, 0);
  const daysIn = new Date(d10.getFullYear(), d10.getMonth() + 1, 0).getDate(), gone = Math.round((10 / daysIn) * 100);
  const monthName = d10.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const prev = new Date(d10.getFullYear(), d10.getMonth() - 1, 1), prevMv = prev.getFullYear() + "-" + String(prev.getMonth() + 1).padStart(2, "0");
  const p = await boot(browser, "?as=p4&scope=default", d10.getTime());
  const h0 = await hero(p);
  ok("A0 · the hero shows a percentage of target", !!h0 && /\d+% of target/.test(h0.text), JSON.stringify(h0));
  const earned = h0 ? h0.earned : 0;
  if (earned > 0) {
    const ahead = await hero(p, Math.round(earned * 2));     // 50% earned, 33% gone
    ok("A1 · half the target earned a third of the way in is green and says on pace", /^50% of target · on pace$/.test(ahead.text) && ahead.colour === "var(--green)", JSON.stringify(ahead));
    ok("A2 · the reason is on the tooltip", ahead.title === `${gone}% of ${monthName} has gone; 50% of the target is earned.`, ahead.title);
    const behind = await hero(p, Math.round(earned * 10));   // 10% earned, 33% gone
    ok("A3 · a tenth earned a third of the way in is amber and says behind pace — not red", /^10% of target · behind pace$/.test(behind.text) && behind.colour === "var(--amber)", JSON.stringify(behind));
    const met = await hero(p, Math.max(1, Math.round(earned / 2)));
    ok("A4 · a target already met is green with no pace note", /^\d+% of target$/.test(met.text) && met.colour === "var(--green)", JSON.stringify(met));
  } else ok("A1–A4 · sample data has earned income this month", false, "earned = 0");
  // A closed month that fell short is the only red.
  await hero(p, 100000000);
  const past = await p.evaluate(async (mv) => { const pk = document.querySelector("#report-month, #reports-month, input[type='month']"); if (!pk) return null; pk.value = mv; pk.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((r) => setTimeout(r, 1800)); const e = document.querySelector("#report-hero .rep-hero-pct"); return e ? { text: e.textContent.trim(), colour: e.style.color } : null; }, prevMv);
  ok("A5 · a month that has closed short is red, with no pace note", !!past && /^\d+% of target$/.test(past.text) && past.colour === "var(--red)", JSON.stringify(past));

  console.log("B · O10 — the SEO tab in two");
  const s = await boot(browser, "?as=p4&scope=default");
  await s.evaluate(() => window.nav("site/seo"));
  await s.waitForFunction(() => document.querySelector("#seo-head, #seo-empty"), null, { timeout: 10000 }); await s.waitForTimeout(500);
  const st = () => s.evaluate(() => { const r = document.getElementById("page-site-seo"); const vis = (sel) => { const e = r.querySelector(sel); return !!e && e.checkVisibility(); };
    return { tabs: [...r.querySelectorAll("#seo-tabs button")].map((b) => b.textContent + (b.getAttribute("aria-selected") === "true" ? "*" : "")), table: vis("table.seo-table, #seo-table"), queries: vis("#seo-queries, .seo-queries"), tiles: vis(".seo-tiles, #seo-tiles"), h: document.documentElement.scrollHeight, gsc: !!r.querySelector("#seo-history, .seo-history") }; });
  const a = await st();
  ok("B1 · two inner tabs under the tiles", a.tabs.length === 2 && a.tabs.map((t) => t.replace("*", "")).join("|") === "Performance|Page audit" && a.tiles, JSON.stringify(a));
  ok("B2 · it opens on Performance when Search Console is connected, on the audit when it is not", a.gsc ? a.tabs[0].endsWith("*") && a.queries && !a.table : a.tabs[1].endsWith("*") && a.table, JSON.stringify(a.tabs));
  const other = a.tabs[0].endsWith("*") ? "audit" : "perf";
  await s.click(`#seo-tabs [data-seo-tab="${other}"]`); await s.waitForTimeout(300);
  const b = await st();
  ok("B3 · the other tab shows the other half and hides the first", other === "audit" ? b.table && !b.queries : b.queries && !b.table, JSON.stringify(b));
  await s.evaluate(() => window.nav("dashboard")); await s.waitForTimeout(300);
  await s.evaluate(() => window.nav("site/seo")); await s.waitForTimeout(1200);
  const c = await st();
  ok("B5 · it comes back on the tab it was left on", c.tabs.find((t) => t.endsWith("*")) === b.tabs.find((t) => t.endsWith("*")), JSON.stringify(c.tabs));
  // Not connected: the tab opens on the audit, and the Connect tile's target is on Performance.
  const nc = await boot(browser, "?as=p4&scope=default");
  await nc.evaluate(() => { const r = window.__mock.db.seo_snapshots.filter((x) => x.kind === "summary").sort((x, y) => String(y.day).localeCompare(String(x.day)))[0]; r.data = Object.assign({}, r.data, { gsc_connected: false, gsc: null }); });
  await nc.evaluate(() => window.nav("site/seo"));
  await nc.waitForFunction(() => document.querySelector("#seo-head, #seo-empty"), null, { timeout: 10000 }); await nc.waitForTimeout(500);
  const n0 = await nc.evaluate(() => ({ on: (document.querySelector('#seo-tabs [aria-selected="true"]') || {}).textContent, connectShown: document.getElementById("seo-connect").checkVisibility() }));
  ok("B6a · without Search Console it opens on Page audit, the Connect panel out of sight on the other tab", n0.on === "Page audit" && !n0.connectShown, JSON.stringify(n0));
  await nc.click('#page-site-seo [data-seo-jump="seo-connect"]'); await nc.waitForTimeout(500);
  const n1 = await nc.evaluate(() => ({ on: (document.querySelector('#seo-tabs [aria-selected="true"]') || {}).textContent, connectShown: document.getElementById("seo-connect").checkVisibility() }));
  ok("B6 · the Connect tile switches to Performance and shows the panel it points at", n1.on === "Performance" && n1.connectShown, JSON.stringify(n1));
  const legacy = await boot(browser, "?as=p4");
  await legacy.evaluate(() => window.nav("site/seo"));
  await legacy.waitForFunction(() => document.querySelector("#seo-head, #seo-empty"), null, { timeout: 10000 }); await legacy.waitForTimeout(500);
  ok("B7 · the harness seam keeps the single page", await legacy.evaluate(() => !document.querySelector("#seo-tabs") && !document.querySelector(".seo-pane")));
  const one = await legacy.evaluate(() => document.documentElement.scrollHeight);
  ok("B4 · each tab is shorter than the single page was", a.h < one && b.h < one, `tabs ${a.h}px / ${b.h}px, single page ${one}px`);

  const errs = [p, s, nc, legacy].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr112_pace_seo_tabs: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
