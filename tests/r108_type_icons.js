/* R108 — X1 one type scale (11 uppercase labels / 12 / 13 / 14 / 18 / 24) and X9 one line-icon set.
   node tests/r108_type_icons.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so the icon swap is live. */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
const PAGES = ["dashboard", "pipeline", "diary", "clients", "protection", "retention", "reports", "vault", "operations", "site", "settings"];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs) {
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  await p.waitForTimeout(700);
  return p;
}
const survey = (p) => p.evaluate(() => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{2712}\u{2728}\u{2B50}\u{23F0}-\u{23F3}]/u;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const sizes = {}, left = {}; let n;
  while ((n = w.nextNode())) {
    const el = n.parentElement;
    if (!n.nodeValue.trim() || !el.checkVisibility() || el.closest("svg, option, script, style")) continue;
    const cs = getComputedStyle(el), f = cs.fontSize;
    if (!sizes[f]) sizes[f] = { n: 0, eg: (el.className || el.tagName).toString().slice(0, 40), upper: 0 };
    sizes[f].n++; if (cs.textTransform === "uppercase") sizes[f].upper++;
    for (const ch of n.nodeValue) if (emoji.test(ch) && !"☰☑☐".includes(ch)) left[ch] = (left[ch] || 0) + 1;
  }
  return { sizes, left, icons: [...document.querySelectorAll("svg.ic")].filter((s) => s.checkVisibility()).length };
});
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  const SCALE = ["11px", "12px", "13px", "14px", "18px", "24px"];
  const all = {}, leftAll = {}; let icons = 0, upper11 = true;
  for (const pg of PAGES) {
    const btn = await p.$(`[data-page="${pg}"]`); if (!btn || !(await btn.isVisible())) continue;
    await btn.click(); await p.waitForTimeout(pg === "reports" ? 3200 : 1900);
    const s = await survey(p);
    Object.entries(s.sizes).forEach(([k, v]) => { all[k] = all[k] || { n: 0, eg: pg + ":" + v.eg }; all[k].n += v.n; if (k === "11px" && v.upper !== v.n) upper11 = false; });
    Object.entries(s.left).forEach(([k, v]) => { leftAll[k] = (leftAll[k] || 0) + v; });
    icons += s.icons;
  }
  console.log("    sizes: " + JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.n]))));
  console.log("A · one type scale");
  const off = Object.keys(all).filter((k) => !SCALE.includes(k));
  ok("A1 · every piece of visible text on every page is one of 11 / 12 / 13 / 14 / 18 / 24", off.length === 0, JSON.stringify(off.map((k) => k + " " + all[k].eg + " ×" + all[k].n)));
  ok("A2 · 11px is only ever an uppercase label", upper11);
  ok("A3 · the working sizes are all in use (12 / 13 / 14 / 18)", ["12px", "13px", "14px", "18px"].every((k) => all[k] && all[k].n > 0), JSON.stringify(Object.keys(all)));

  console.log("B · one icon set");
  ok("B1 · no colour emoji is left in visible text on any page", Object.keys(leftAll).length === 0, JSON.stringify(leftAll));
  ok("B2 · line icons are drawn in their place", icons > 100, String(icons));
  await p.click('[data-page="retention"]'); await p.waitForTimeout(1800);
  const btn = await p.evaluate(() => { const b = document.querySelector('.ret-row button[data-act="retLogCall"]'); const svg = b.querySelector("svg.ic"); const cs = svg ? getComputedStyle(svg) : null;
    return { text: b.textContent.trim(), ic: svg ? svg.dataset.ic : "", stroke: cs ? cs.stroke : "", color: getComputedStyle(b).color, fill: cs ? cs.fill : "", hidden: svg ? svg.getAttribute("aria-hidden") : "" }; });
  ok("B3 · Log call carries the phone icon and keeps its words", btn.ic === "phone" && btn.text === "Log call", JSON.stringify(btn));
  ok("B4 · the icon takes the colour of the text beside it and is hidden from screen readers", btn.stroke === btn.color && btn.fill === "none" && btn.hidden === "true", JSON.stringify(btn));
  // text written later is swapped too, and what a person types never is.
  const late = await p.evaluate(async () => { const d = document.createElement("div"); d.id = "t108"; document.body.appendChild(d); d.textContent = "📅 Booked";
    const i = document.createElement("textarea"); i.id = "t108b"; i.textContent = "📞 call me"; document.body.appendChild(i);
    await new Promise((r) => setTimeout(r, 60));
    const out = { ic: (d.querySelector("svg.ic") || { dataset: {} }).dataset.ic || "", text: d.textContent, area: i.value, areaIc: !!i.querySelector("svg") }; d.remove(); i.remove(); return out; });
  ok("B5 · a label written after load is swapped as it appears", late.ic === "calendar" && late.text.trim() === "Booked", JSON.stringify(late));
  ok("B6 · text inside a text box is never touched", late.area === "📞 call me" && !late.areaIc, JSON.stringify(late));
  await p.click(".ret-row button[data-act=\"retLogCall\"]"); await p.waitForTimeout(900);
  ok("B7 · an icon button still does its job — Log call opens the call form", await p.evaluate(() => { const o = document.getElementById("overlay-modal"), m = document.getElementById("modal"); return (!!o && o.checkVisibility()) || (!!m && m.checkVisibility()); }));

  console.log("C · the seam");
  const legacy = await boot(browser, "?as=p4");
  const ls = await survey(legacy);
  ok("C1 · under the harness seam the labels keep their emoji and no icons are drawn", ls.icons === 0 && Object.keys(ls.left).length > 0, JSON.stringify({ icons: ls.icons, left: Object.keys(ls.left).length }));
  ok("C2 · …and the type scale holds there too", Object.keys(ls.sizes).every((k) => SCALE.includes(k)), JSON.stringify(Object.keys(ls.sizes)));

  const errs = [p, legacy].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr108_type_icons: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
