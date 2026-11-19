/* R123 — X1 (second half): near-duplicate text colours folded onto the palette's own tokens.
   node tests/r123_text_colours.js   (static server on :8099, admin/mock.html built by smoke.js)
   Stylesheet-only, so it holds in both harness modes; measured in real mode. */
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
(async () => {
  const browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + "?as=p4&scope=default");
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  await p.waitForTimeout(800);
  /* Every visible run of text: its colour, the surface behind it, and the contrast between them. */
  const scan = () => p.evaluate(() => { const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const rgb = (s) => s.match(/[\d.]+/g).map(Number); const out = []; const w = document.createTreeWalker(document.getElementById("app-view"), NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const t = n.textContent.trim(); if (!t) continue; const e = n.parentElement; if (!e.checkVisibility() || !e.getBoundingClientRect().width) continue;
      const fg = rgb(getComputedStyle(e).color); if (fg[3] !== undefined && fg[3] < 1) continue; let bg = null, x = e; while (x && !bg) { const c = rgb(getComputedStyle(x).backgroundColor); if (!(c[3] !== undefined && c[3] < 0.99)) bg = c; x = x.parentElement; } bg = bg || [255, 255, 255];
      const a = lum(fg), b = lum(bg); out.push({ c: fg.slice(0, 3).join(","), dark: b < 0.2 || !!e.closest(".sidebar"), cr: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), n: t.length, cls: String(e.className).split(" ")[0] || e.tagName }); }
    return out; });
  let all = await scan();
  for (const pg of ["pipeline", "diary", "clients", "protection", "retention", "reports", "vault", "operations", "operations/data", "site", "settings"]) { await p.evaluate((x) => window.nav(x), pg); await p.waitForTimeout(1600); all = all.concat(await scan()); }
  const id = await p.evaluate(async () => (await window.__mockDb.from("cases").select("id").limit(1)).data[0].id);
  await p.evaluate((i) => window.openCase(i), id); await p.waitForTimeout(1800); all = all.concat(await scan());
  const light = [...new Set(all.filter((r) => !r.dark).map((r) => r.c))], dark = [...new Set(all.filter((r) => r.dark).map((r) => r.c))];
  const isGrey = (c) => { const [r, g, b] = c.split(",").map(Number); return Math.max(r, g, b) - Math.min(r, g, b) < 50; };
  const dist = (a, b) => { const x = a.split(",").map(Number), y = b.split(",").map(Number); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
  const greys = light.filter((c) => isGrey(c) && c !== "255,255,255");
  const close = []; light.forEach((a, i) => light.slice(i + 1).forEach((b) => { if (dist(a, b) < 14) close.push(a + " ~ " + b); }));

  console.log(`measured: ${light.length} on light, ${close.length} near-duplicate pairs, ${dark.length} on dark`);
  console.log("A · what is on the pages");
  ok("A1 · the scan read a real amount of text", all.reduce((a, r) => a + r.n, 0) > 20000, String(all.length));
  ok("A2 · on light surfaces the neutrals are the palette's four (ink, text, muted, muted-on-tint) and no others", greys.length <= 4 && ["16,36,60", "54,67,88", "91,106,126"].every((c) => greys.includes(c)), greys.join(" | "));
  ok("A3 · no two text colours on a light surface are near-duplicates of each other (was 6 such pairs; muted and muted-on-tint are a deliberate pair)", close.filter((c) => !/91,106,126 ~ 89,103,122|89,103,122 ~ 91,106,126/.test(c)).length === 0, close.join(" ; "));
  ok("A4 · one red, one green, one amber, one link blue", ["192,57,43", "22,121,76", "128,88,0", "0,72,140"].every((c) => light.includes(c)) && !["184,53,42", "179,38,30", "29,122,58", "138,100,0", "154,98,0", "179,83,9", "26,95,180"].some((c) => light.includes(c)), light.join(" | "));
  ok("A5 · fewer distinct text colours on light surfaces than before (was 21)", light.length <= 12, `${light.length}: ${light.join(" | ")}`);
  ok("A6 · and text on dark surfaces is down to four colours (was seven)", dark.length <= 4, dark.join(" | "));

  console.log("B · still readable");
  const folded = ["192,57,43", "22,121,76", "128,88,0", "0,72,140", "91,106,126", "89,103,122"];
  const worst = {}; all.filter((r) => !r.dark && folded.includes(r.c)).forEach((r) => { if (!worst[r.c] || r.cr < worst[r.c].cr) worst[r.c] = r; });
  ok("B1 · every folded colour still meets 4.5:1 wherever it lands", Object.values(worst).every((r) => r.cr >= 4.5), JSON.stringify(Object.values(worst).map((r) => [r.c, r.cls, +r.cr.toFixed(2)])));

  console.log("C · the stylesheet");
  const css = fs.readFileSync(path.join(__dirname, "..", "admin", "admin.css"), "utf8");
  const stray = ["#5b6b7e", "#66738a", "#556275", "#b8352a", "#b3261e", "#8a6400", "#9a6200", "#1d7a3a", "#1a5fb4", "#a8c0dc", "#9fb6d3", "#cddcef"].filter((h) => new RegExp("(?<![-\\w])color:\\s*" + h, "i").test(css));
  ok("C1 · none of the stray text colours is left in a color: declaration", stray.length === 0, stray.join(" "));
  ok("C2 · the stylesheet is no longer than before", css.split("\n").length - 1 <= 3946, String(css.split("\n").length - 1));
  ok("E1 · no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  console.log(`\nr123_text_colours: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
