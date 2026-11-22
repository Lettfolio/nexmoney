/* R127 — four plain fixes from the 21 Nov review: phone row labels no longer sit over the name, nothing runs off
   the right edge without a scroller, small controls get a 44px hit area, and Reports' bar wears the headline's colour. */
const { chromium } = require("playwright");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " — " + d : "")); } };
const open = async (b, vp, touch) => { const ctx = await b.newContext({ viewport: vp, hasTouch: !!touch, isMobile: !!touch }); const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; }); await p.goto("http://localhost:8099/admin/mock.html?as=p4&scope=default");
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty")); await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelector("#brief-scope-all").click()); await p.waitForTimeout(600); return p; };
const go = async (p, pg) => { await p.evaluate((x) => window.nav(x), pg); await p.waitForTimeout(1700); };
/* elements whose right edge leaves the screen with no sideways scroller above them */
const lost = (p) => p.evaluate(() => { const root = document.querySelector(".page:not(.hidden)"); const out = [];
  [...root.querySelectorAll("*")].forEach((e) => { if (!e.checkVisibility()) return; const r = e.getBoundingClientRect(); if (!r.width || r.right <= innerWidth + 2) return; let sc = e.parentElement; while (sc && sc !== document.body && !/auto|scroll/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement; if (!sc || sc === document.body) out.push((e.id || e.className || e.tagName) + " r" + Math.round(r.right)); }); return out; });
/* does a tap `dy` px above/below the element's own box still land on it? */
const hits = (p, sel, n, dy) => p.evaluate(([s, n, dy]) => { const els = [...document.querySelectorAll(s)].filter((e) => e.checkVisibility()).slice(0, n); return els.map((e) => { e.scrollIntoView({ block: "center", inline: "center" }); const r = e.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const at = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === e || e.contains(h)); }; return { h: Math.round(r.height), w: Math.round(r.width), up: at(cx, cy - dy), down: at(cx, cy + dy), mid: at(cx, cy) }; }); }, [sel, n, dy || 20]);
const all44 = (rs) => rs.length > 0 && rs.every((r) => r.mid && r.up && r.down);
(async () => { const b = await chromium.launch();
  const p = await open(b, { width: 390, height: 844 }, true);
  console.log("§A — phone rows: the case label");
  for (const [pg, sel] of [["clients", "#page-clients"], ["protection", "#page-protection"], ["retention", "#page-retention"]]) {
    await go(p, pg);
    const r = await p.evaluate(() => { const root = document.querySelector(".page:not(.hidden)"); return [...root.querySelectorAll(".kit-row .row-chip")].filter((e) => e.checkVisibility()).slice(0, 8).map((e) => { const row = e.closest(".kit-row"); const c = e.getBoundingClientRect(); let over = 0; [...row.querySelectorAll(".row-main .t, .row-main .s, .row-fact, strong, .contact-link")].forEach((o) => { if (o.contains(e) || e.contains(o) || !o.checkVisibility()) return; [...o.getClientRects()].forEach((q) => { const ox = Math.min(c.right, q.right) - Math.max(c.left, q.left), oy = Math.min(c.bottom, q.bottom) - Math.max(c.top, q.top); if (ox > 2 && oy > 2 && !o.contains(e.parentElement)) over++; }); }); return { h: Math.round(c.height), over }; }); });
    ok(`A · ${pg}: the label is pill-height (≤ 30px), not a 48px block`, r.length > 0 && r.every((x) => x.h <= 30), JSON.stringify(r.slice(0, 3)));
    ok(`A · ${pg}: a tap 20px above or below the label still opens it`, all44(await hits(p, ".page:not(.hidden) .kit-row .row-chip", 4)));
    const l = await lost(p); ok(`B · ${pg}: nothing runs off the right edge without a scroller`, l.length === 0, l.slice(0, 4).join(" | "));
  }
  console.log("§B — the clawback table scrolls");
  await go(p, "protection");
  const cw = await p.evaluate(() => { const t = document.querySelector("#prot-clawback-table"); if (!t) return null; const sc = t.parentElement; t.scrollIntoView(); const before = sc.scrollLeft; sc.scrollLeft = 300; const moved = sc.scrollLeft; sc.scrollLeft = before; return { cls: sc.className, moved, wider: t.getBoundingClientRect().width > sc.getBoundingClientRect().width }; });
  ok("B4 · the clawback table sits in a sideways scroller that moves", !!cw && /table-scroll/.test(cw.cls) && (!cw.wider || cw.moved > 0), JSON.stringify(cw));
  console.log("§C — small controls take a 44px tap");
  await go(p, "pipeline");
  ok("C1 · column fold arrow", all44(await hits(p, "#board .col-fold", 3)));
  const fm = await hits(p, "#board .flags-more", 3); ok("C2 · “+N” on a card", all44(fm), JSON.stringify(fm));
  await go(p, "operations/import"); ok("C3 · the “i” info button", all44(await hits(p, ".page:not(.hidden) .info-i", 2)));
  await go(p, "reports"); const rl = await hits(p, "#page-reports td > .linkish", 3, 12); ok("C4 · adviser names on Reports take a tap 12px above or below (rows are ~40px apart, so the row is the limit)", all44(rl), JSON.stringify(rl));
  await go(p, "operations/data"); const dl = await hits(p, "#dh-stuck-link", 1); ok("C5 · Data health “see Emails” (when shown)", dl.length === 0 || all44(dl), JSON.stringify(dl));
  ok("C6 · the hit areas add no sideways travel", await p.evaluate(() => { document.scrollingElement.scrollLeft = 400; const v = document.scrollingElement.scrollLeft; document.scrollingElement.scrollLeft = 0; return v === 0; }));
  console.log("§D — case History initials");
  await go(p, "pipeline"); await p.evaluate(() => document.querySelector("#board .card").click()); await p.waitForTimeout(1800);
  await p.evaluate(() => { const t = [...document.querySelectorAll("#modal [role=tab], #modal .rec-tab")].find((e) => /History/.test(e.textContent)); if (t) t.click(); }); await p.waitForTimeout(900);
  const tiny = await p.evaluate(() => [...document.querySelectorAll("#modal *")].filter((e) => e.checkVisibility() && e.children.length === 0 && e.textContent.trim() && parseFloat(getComputedStyle(e).fontSize) < 11).map((e) => e.className + ":" + getComputedStyle(e).fontSize));
  ok("D1 · no text under 11px on the open case's History", tiny.length === 0, tiny.slice(0, 4).join(" | "));
  ok("D2 · no page errors (phone)", p.errs.length === 0, p.errs.join(" | "));
  await p.context().close();
  console.log("§E — Reports: bar and headline agree");
  const d = await open(b, { width: 1366, height: 900 }); await go(d, "reports");
  const e = await d.evaluate(() => { const h = document.querySelector("#report-hero .rep-hero-pct"), bar = document.querySelector("#month-fee-target .fee-bar-fill"), mine = document.querySelector("#report-mine-target .fee-bar-fill"); const probe = document.createElement("span"); document.body.appendChild(probe); const rgb = (v) => { probe.style.color = v; return getComputedStyle(probe).color; }; return { head: h && getComputedStyle(h).color, bar: bar && getComputedStyle(bar).backgroundColor, txt: h && h.textContent, muted: rgb("var(--muted)") }; });
  ok("E1 · the fixture shows a headline and a bar", !!e.head && !!e.bar, JSON.stringify(e));
  ok("E2 · the bar is the headline's colour", e.head === e.bar || e.head === e.muted, JSON.stringify(e));
  const f = await d.evaluate(() => ({ a: window.feeBarHtml(77, 9500, "x"), g: window.feeBarHtml(77, 9500, "x", "var(--green)") }));
  ok("E3 · without a pace the bar keeps its old thresholds (My numbers)", /background:var\(--amber\)/.test(f.a) && /background:var\(--green\)/.test(f.g));
  ok("E4 · no page errors (desktop)", d.errs.length === 0, d.errs.join(" | "));
  await b.close(); console.log(`\nr127_fixes: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
