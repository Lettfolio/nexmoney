/* R118 — X5: a card's coloured edge is backed by an icon and words (clock = slow, warning sign = stuck).
   node tests/r118_edge_marks.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL behaviour. */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
const TH = { enquiry: 5, fact_find: 7, decision_in_principle: 10, application: 21, offer: 14, exchange: 30 };
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs) {
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  // R126: the owner now opens every page on Mine; these checks read the firm-wide board, so he presses All first.
  if (/as=p4/.test(qs) && /scope=default/.test(qs)) { await p.evaluate(() => document.querySelector("#brief-scope-all").click()); await p.waitForTimeout(600); }
  await p.evaluate(() => window.nav("pipeline"));
  await p.waitForFunction(() => document.querySelectorAll("#board .card").length > 5, null, { timeout: 20000 });
  await p.waitForTimeout(700);
  return p;
}
const cards = (p) => p.evaluate(() => [...document.querySelectorAll("#board .card")].map((c) => { const line = c.querySelector(".age-line"), m = c.querySelector(".age-mark"), svg = m && m.querySelector("svg"), r = svg && svg.getBoundingClientRect();
  return { id: c.dataset.id, stage: c.closest(".col").dataset.stage, level: c.classList.contains("age-red") ? "red" : c.classList.contains("age-amber") ? "amber" : "", line: line ? line.textContent.replace(/\s+/g, " ").trim() : "", lineH: line ? Math.round(line.getBoundingClientRect().height) : 0,
    mark: m ? { label: m.getAttribute("aria-label"), title: m.title, role: m.getAttribute("role"), ic: svg && svg.dataset.ic, w: r ? Math.round(r.width) : 0, inLine: !!m.closest(".age-line") } : null }; }));
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  const seam = await boot(browser, "?as=p4");
  const real = await cards(p), old = await cards(seam);
  const amber = real.filter((c) => c.level === "amber"), red = real.filter((c) => c.level === "red"), plain = real.filter((c) => !c.level);
  const nums = (c) => { const m = /— (\d+) days in this stage, (?:past|more than twice) the usual (\d+) days?$/.exec(c.mark.label); return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN]; };

  console.log("A · the board");
  ok("A1 · the fixture has amber, red and plain cards", amber.length >= 2 && red.length >= 2 && plain.length >= 2, `${amber.length}/${red.length}/${plain.length}`);
  ok("A2 · every amber card carries a clock that says Slow", amber.every((c) => c.mark && c.mark.ic === "clock" && c.mark.label.startsWith("Slow — ") && c.mark.role === "img" && c.mark.inLine), JSON.stringify(amber[0]));
  ok("A3 · every red card carries a warning sign that says Stuck", red.every((c) => c.mark && c.mark.ic === "alert" && c.mark.label.startsWith("Stuck — ") && c.mark.role === "img" && c.mark.inLine), JSON.stringify(red[0]));
  ok("A4 · a card with no coloured edge has no mark", plain.every((c) => !c.mark));
  ok("A5 · the words name the stage's own threshold, and the days on the card", [...amber, ...red].every((c) => { const [d, th] = nums(c); return th === TH[c.stage] && c.line.startsWith(d + "d in stage"); }), JSON.stringify([...amber, ...red].map((c) => [c.stage, c.mark.label]).slice(0, 2)));
  ok("A6 · and they are true: amber is past the threshold, red is at least twice it", amber.every((c) => { const [d, th] = nums(c); return d >= th && d < th * 2; }) && red.every((c) => { const [d, th] = nums(c); return d >= th * 2; }));
  ok("A7 · the same words show on hover", [...amber, ...red].every((c) => c.mark.title === c.mark.label));
  ok("A8 · the icon is big enough to see and the line is no taller than before", [...amber, ...red].every((c) => c.mark.w >= 12) && real.every((c) => { const o = old.find((x) => x.id === c.id); return o && c.lineH <= o.lineH + 1; }), JSON.stringify(real.filter((c) => { const o = old.find((x) => x.id === c.id); return !o || c.lineH > o.lineH + 1; }).slice(0, 2)));
  ok("A9 · the harness seam has no marks, and the same edges", old.every((c) => !c.mark) && JSON.stringify(old.map((c) => [c.id, c.level])) === JSON.stringify(real.map((c) => [c.id, c.level])));

  console.log("B · the table and the legend");
  const legend = await p.evaluate(() => { const d = document.getElementById("board-how"); d.open = true; return [...document.querySelectorAll("#board-legend .bl-item")].map((i) => ({ t: i.textContent.replace(/\s+/g, " ").trim(), svg: !!i.querySelector("svg.ic") && i.querySelector("svg.ic").getBoundingClientRect().width >= 12, edge: (i.querySelector(".bl-edge") || {}).className || "" })); });
  ok("B1 · the legend names both marks beside their edge colour", legend[0].t === "Slow: in this stage longer than usual" && legend[0].svg && /amber/.test(legend[0].edge) && legend[1].t === "Stuck: more than twice as long" && legend[1].svg && /red/.test(legend[1].edge), JSON.stringify(legend.slice(0, 2)));
  ok("B2 · and no longer claims a flat 14 or 30 days (each stage has its own)", !legend.some((l) => /14\+|30\+/.test(l.t)));
  await p.click("#btn-toggle-view, [data-act*='toggleView'], button:has-text('Table view')"); await p.waitForFunction(() => document.querySelectorAll("#table-wrap .age-cell").length > 3, null, { timeout: 15000 }); await p.waitForTimeout(500);
  const cells = await p.evaluate(() => [...document.querySelectorAll("#table-wrap .age-cell")].map((c) => { const m = c.querySelector(".age-mark"); return { level: c.classList.contains("age-red") ? "red" : c.classList.contains("age-amber") ? "amber" : "", ic: m ? m.querySelector("svg").dataset.ic : "", label: m ? m.getAttribute("aria-label") : "", t: c.textContent.trim() }; }));
  ok("B3 · the table's In stage column carries the same marks", cells.some((c) => c.level === "amber") && cells.some((c) => c.level === "red") && cells.every((c) => (c.level === "amber" ? c.ic === "clock" && c.label.startsWith("Slow — " + parseInt(c.t, 10) + " days") : c.level === "red" ? c.ic === "alert" && c.label.startsWith("Stuck — " + parseInt(c.t, 10) + " days") : !c.ic)), JSON.stringify(cells.slice(0, 3)));

  const errs = [p, seam].flatMap((x) => x.__errs);
  ok("E1 · no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  console.log(`\nr118_edge_marks: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
