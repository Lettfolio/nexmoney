/* R128 — Reports' first table is on the first screen (B); a sideways-scrolling filter row fades at its right edge (D). */
const { chromium } = require("playwright");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " — " + d : "")); } };
const open = async (b, q, vp, touch) => { const ctx = await b.newContext({ viewport: vp, hasTouch: !!touch, isMobile: !!touch }); const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; }); await p.goto("http://localhost:8099/admin/mock.html?as=p4" + q);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty")); await p.waitForTimeout(700); return p; };
const go = async (p, pg) => { await p.evaluate((x) => window.nav(x), pg); await p.waitForTimeout(2000); };
(async () => { const b = await chromium.launch();
  console.log("§A — Reports at 1366×768, real mode");
  let p = await open(b, "&scope=default", { width: 1366, height: 768 }); await go(p, "reports");
  const m = await p.evaluate(() => { const row = document.querySelector("#report-advisers tbody tr"); const vis = (q) => { const e = document.querySelector(q); return !!e && e.checkVisibility(); };
    return { rowBottom: row && Math.round(row.getBoundingClientRect().bottom), h: innerHeight, basis: vis("#report-hero .rep-hero-basis:not(.rep-hero-trend)"), legend: vis("#month-legend"), scope: vis("#report-scoreboard-scope"), note: vis("#report-month-note"),
      basisText: (document.querySelector("#report-hero .rep-hero-basis:not(.rep-hero-trend)") || {}).textContent, scopeText: (document.querySelector("#report-scoreboard-scope") || {}).textContent.trim().length,
      btns: ["#report-hero .rep-hero-lbl .info-i", "#month-report-title .info-i", "#report-scoreboard-panel > h3 .info-i"].map((q) => !!document.querySelector(q)) }; });
  ok("A1 · the scoreboard's first row is on the first screen", m.rowBottom > 0 && m.rowBottom <= m.h, JSON.stringify({ rowBottom: m.rowBottom, h: m.h }));
  ok("A2 · the hero's basis, the glossary and the scope sentence are tucked away", !m.basis && !m.legend && !m.scope, JSON.stringify(m));
  ok("A3 · …but still in the page, word for word (“paid or not”)", /paid or not/.test(m.basisText || "") && m.scopeText > 20);
  ok("A4 · each has an “i” on its heading", m.btns.every(Boolean), JSON.stringify(m.btns));
  ok("A5 · the “Also scoped to the month…” divider is gone", !m.note);
  await p.click("#report-hero .rep-hero-lbl .info-i"); await p.click("#month-report-title .info-i"); await p.click("#report-scoreboard-panel > h3 .info-i"); await p.waitForTimeout(200);
  const o = await p.evaluate(() => ["#report-hero .rep-hero-basis:not(.rep-hero-trend)", "#month-legend", "#report-scoreboard-scope"].map((q) => document.querySelector(q).checkVisibility()).concat([...document.querySelectorAll("#page-reports .info-i")].filter((b) => b.getAttribute("aria-expanded") === "true").length));
  ok("A6 · a click on each “i” shows its line in place and says so", o[0] && o[1] && o[2] && o[3] === 3, JSON.stringify(o));
  await p.evaluate(() => { const i = document.querySelector("#report-month"); const d = new Date(); d.setMonth(d.getMonth() - 1); i.value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); i.dispatchEvent(new Event("change", { bubbles: true })); }); await p.waitForTimeout(1800);
  const r = await p.evaluate(() => ({ one: document.querySelectorAll("#month-report-title .info-i").length, hero: document.querySelectorAll("#report-hero .info-i").length, sc: document.querySelectorAll("#report-scoreboard-panel > h3 .info-i").length, basis: (document.querySelector("#report-hero .rep-hero-basis:not(.rep-hero-trend)") || { checkVisibility: () => false }).checkVisibility() }));
  ok("A7 · after changing the month there is still exactly one “i” per heading, and the basis is tucked again", r.one === 1 && r.hero <= 1 && r.sc === 1 && !r.basis, JSON.stringify(r));
  ok("A8 · no page errors", p.errs.length === 0, p.errs.join(" | "));
  await p.context().close();
  console.log("§B — filter rows on a phone, real mode");
  p = await open(b, "&scope=default", { width: 390, height: 844 }, true);
  for (const [pg, sel] of [["retention", "#ret-segs"], ["clients", "#client-segment"], ["dashboard", "#page-dashboard .kpi-row"]]) { await go(p, pg);
    const s = await p.evaluate(async (q) => { const e = document.querySelector(q); if (!e) return null; const wait = () => new Promise((r) => setTimeout(r, 250)); e.scrollLeft = 0; await wait(); const start = e.classList.contains("more-right"), over = e.scrollWidth - e.clientWidth; const mask = getComputedStyle(e).maskImage || getComputedStyle(e).webkitMaskImage; e.scrollLeft = 99999; await wait(); const end = e.classList.contains("more-right"); e.scrollLeft = 0; await wait(); return { over, start, end, back: e.classList.contains("more-right"), mask: /gradient/.test(mask) }; }, sel);
    ok(`B · ${pg}: fades while more is hidden on the right, clears at the end, returns on scrolling back`, !!s && s.over > 8 && s.start && s.mask && !s.end && s.back, JSON.stringify(s)); }
  await go(p, "diary"); ok("B4 · a row that fits is not faded", await p.evaluate(() => [...document.querySelectorAll(".page:not(.hidden) .seg-strip")].every((e) => e.scrollWidth - e.clientWidth > 8 || !e.classList.contains("more-right"))));
  ok("B5 · no page errors (phone)", p.errs.length === 0, p.errs.join(" | "));
  await p.context().close();
  console.log("§C — seam unchanged");
  p = await open(b, "", { width: 1366, height: 768 }); await go(p, "reports");
  const c = await p.evaluate(() => ({ i: document.querySelectorAll("#page-reports .info-i").length, basis: document.querySelector("#report-hero .rep-hero-basis:not(.rep-hero-trend)").checkVisibility(), note: document.querySelector("#report-month-note").checkVisibility(), fade: document.querySelectorAll(".more-right").length }));
  ok("C1 · seam: no “i”, the lines and the divider on show, no fade class", c.i === 0 && c.basis && c.note && c.fade === 0, JSON.stringify(c));
  await b.close(); console.log(`\nr128_reports_strips: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
