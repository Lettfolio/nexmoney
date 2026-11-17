/* R104 — B10: the Diary's List view (next 14 days), the default when no view is stored.
   node tests/r104_agenda.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL defaults. */
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
  // R114: on a phone the strip is gone — Diary is reached the way a phone user reaches it, through More.
  if (await p.evaluate(() => document.querySelector('#topnav [data-page="diary"]').checkVisibility())) await p.click('#topnav [data-page="diary"]');
  else { await p.click('#phone-bar [data-bar="more"]'); await p.click('#overlay-modal [data-more="diary"]'); }
  await p.waitForTimeout(1200);
  return p;
}
const active = (p) => p.evaluate(() => ["agenda", "month", "week", "day"].filter((m) => document.getElementById("diary-view-" + m).classList.contains("scope-active")).join("+"));
const shown = (p) => p.evaluate(() => ["diary-agenda", "diary-grid", "diary-week-view", "diary-day-view"].filter((id) => document.getElementById(id).checkVisibility()).join("+"));
(async () => {
  const browser = await chromium.launch();

  console.log("A · the default");
  const p = await boot(browser, "?as=p4&scope=default");
  ok("A1 · with no stored view the Diary opens on List", (await active(p)) === "agenda", await active(p));
  ok("A2 · …and only the list is on show", (await shown(p)) === "diary-agenda", await shown(p));
  const phone = await boot(browser, "?as=p2&scope=default", { width: 390, height: 844 });
  ok("A3 · a phone opens on List too", (await active(phone)) === "agenda", await active(phone));
  const legacy = await boot(browser, "?as=p4");
  ok("A4 · the harness seam keeps the old desktop default (Week)", (await active(legacy)) === "week", await active(legacy));

  console.log("B · what the list holds");
  const fx = await p.evaluate(async () => {
    const pad = (n) => String(n).padStart(2, "0"), ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + 14);
    const { data } = await window.__mockDb.from("appointments").select("*");
    const inWin = (data || []).filter((a) => new Date(a.starts_at) >= s && new Date(a.starts_at) < e);
    return { n: inWin.length, ids: inWin.map((a) => String(a.id)).sort(), today: ymd(s), days: [...new Set(inWin.map((a) => ymd(new Date(a.starts_at))))].length };
  });
  const dom = await p.evaluate(() => ({
    ids: [...document.querySelectorAll("#diary-agenda [data-appt]")].map((r) => r.dataset.appt).sort(),
    heads: [...document.querySelectorAll("#diary-agenda h3")].map((h) => ({ day: h.dataset.day, text: h.textContent })),
    title: document.getElementById("diary-title").textContent,
    times: [...document.querySelectorAll("#diary-agenda .da-time")].map((t) => t.textContent.trim()),
    legendHidden: document.getElementById("diary-legend").classList.contains("hidden"),
  }));
  ok("B0 · fixture · there are appointments in the next 14 days", fx.n > 0, String(fx.n));
  ok("B1 · every appointment in the next 14 days is a row, and nothing else is", JSON.stringify(dom.ids) === JSON.stringify(fx.ids), JSON.stringify({ dom: dom.ids.length, fx: fx.n }));
  ok("B2 · today always has a heading, and it says Today", dom.heads.some((h) => h.day === fx.today && /^Today · /.test(h.text)), JSON.stringify(dom.heads.slice(0, 3)));
  ok("B3 · days are in date order with no repeats", dom.heads.every((h, i) => i === 0 || h.day > dom.heads[i - 1].day), JSON.stringify(dom.heads.map((h) => h.day)));
  ok("B4 · empty days are left out (fewer headings than days in the range)", dom.heads.length >= fx.days && dom.heads.length < 14, JSON.stringify({ heads: dom.heads.length, days: fx.days }));
  ok("B5 · each row leads with a start–end time", dom.times.length === fx.n && dom.times.every((t) => /^\d\d:\d\d–\d\d:\d\d$/.test(t)), JSON.stringify(dom.times.slice(0, 3)));
  ok("B6 · the title names the 14-day range", /^Diary — \d+ \w+ – \d+ \w+ \d{4}$/.test(dom.title), dom.title);
  ok("B7 · the adviser-colour legend is not shown over a list", dom.legendHidden);

  console.log("C · moving and opening");
  await p.click("#diary-next"); await p.waitForTimeout(900);
  const t2 = await p.evaluate(() => document.getElementById("diary-title").textContent);
  ok("C1 · Next steps 14 days", t2 !== dom.title && /^Diary — /.test(t2), t2);
  await p.click("#diary-today"); await p.waitForTimeout(900);
  ok("C2 · Today comes back to the same range", (await p.evaluate(() => document.getElementById("diary-title").textContent)) === dom.title);
  await p.click("#diary-agenda [data-appt]"); await p.waitForTimeout(700);
  ok("C3 · pressing a row opens that appointment", await p.evaluate(() => { const m = document.getElementById("appt-modal") || document.querySelector(".modal:not(.hidden) #appt-title, #appt-title"); return !!m && m.checkVisibility(); }));
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  await p.click("#diary-view-week"); await p.waitForTimeout(900);
  ok("C4 · Week is one press away and hides the list", (await active(p)) === "week" && (await shown(p)) === "diary-week-view", (await active(p)) + " / " + (await shown(p)));
  await p.click("#diary-view-agenda"); await p.waitForTimeout(900);
  ok("C5 · …and List comes back", (await shown(p)) === "diary-agenda", await shown(p));
  await p.click("#diary-view-month"); await p.waitForTimeout(600);
  await p.reload(); await p.waitForFunction(() => /^Diary — /.test(document.getElementById("diary-title").textContent), null, { timeout: 20000 });
  await p.waitForTimeout(800);
  ok("C6 · a chosen view is remembered over the new default", (await active(p)) === "month", await active(p));

  const errs = [p, phone, legacy].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr104_agenda: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
