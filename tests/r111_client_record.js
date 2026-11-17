/* R111 — B3: a client opens as a full-width record with Cases / Timeline / Details tabs.
   node tests/r111_client_record.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL layout. */
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
  await p.waitForTimeout(600);
  return p;
}
const state = (p) => p.evaluate(() => { const m = document.getElementById("modal"), back = document.getElementById("modal-backdrop");
  const vis = (s) => { const e = m.querySelector(s); return !!e && e.checkVisibility(); };
  return { open: !back.classList.contains("hidden"), kind: m.dataset.record || "", w: Math.round(m.getBoundingClientRect().width), left: Math.round(back.getBoundingClientRect().left), h: m.scrollHeight,
    tabs: [...m.querySelectorAll(".rec-tabs > button")].map((b) => b.textContent + (b.getAttribute("aria-selected") === "true" ? "*" : "")),
    side: [...(m.querySelector(".rec-side") || { children: [] }).children].map((c) => c.id || c.className.split(" ").pop()),
    cases: vis("#client-cases-block"), tl: vis("#tl-list"), form: vis('#client-form [name="first_name"]'), save: vis("#modal-save"), sub: !!m.querySelector(".tl-fold-sub") }; });
const open = async (p, id, ...rest) => { await p.evaluate(([i, r]) => window.openClient(i, ...r), [id, rest]); await p.waitForTimeout(1600); };
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  const ids = await p.evaluate(async () => { const { data } = await window.__mockDb.from("cases").select("client_id"); const n = {}; data.forEach((c) => { if (c.client_id) n[c.client_id] = (n[c.client_id] || 0) + 1; }); const e = Object.entries(n).sort((a, b) => b[1] - a[1]); return { many: e[0][0], one: e[e.length - 1][0] }; });

  console.log("A · the record");
  await open(p, ids.many);
  const s = await state(p);
  ok("A1 · a client opens as a record that fills the page beside the sidebar", s.open && s.kind === "client" && s.w >= 1000 && s.left === 216, JSON.stringify({ kind: s.kind, w: s.w, left: s.left }));
  ok("A2 · three tabs, opening on Cases", s.tabs.join("|") === "Cases*|Timeline|Details" && s.cases && !s.tl && !s.form, JSON.stringify(s.tabs));
  ok("A3 · contact, last contact and the portfolio sit down the left", s.side.join("|") === "client-contact-line|client-last-contact|client-portfolio|client-portfolio-sub", s.side.join("|"));
  await p.click('.rec-tabs button[data-tab="timeline"]'); await p.waitForTimeout(600);
  const st = await state(p);
  ok("A4 · Timeline opens without a second press and no longer explains why it was folded", st.tl && !st.cases && !st.sub);
  await p.click('.rec-tabs button[data-tab="details"]'); await p.waitForTimeout(500);
  const sd = await state(p);
  const cols = await p.evaluate(() => getComputedStyle(document.querySelector("#client-form")).gridTemplateColumns.split(" ").length);
  ok("A5 · Details shows the form in three columns", sd.form && !sd.tl && cols === 3, String(cols));
  ok("A6 · Save stays on a client — only case fields save themselves", s.save && sd.save);

  console.log("B · behaviour kept");
  await p.fill('#client-form [name="address"]', "1 Test Street"); await p.click("#modal .modal-close"); await p.waitForTimeout(600);
  const guard = await p.evaluate(() => { const o = document.getElementById("overlay-modal"); return o && o.checkVisibility() ? o.textContent : ""; });
  ok("B1 · leaving with an unsaved change still warns", /unsaved|discard/i.test(guard), guard.slice(0, 60));
  await p.evaluate(() => { const b = [...document.querySelectorAll("#overlay-modal button")].find((x) => /keep|stay|back|cancel/i.test(x.textContent)); if (b) b.click(); }); await p.waitForTimeout(400);
  await p.click("#modal-save"); await p.waitForTimeout(1500);
  ok("B2 · Save writes the change", await p.evaluate(async (i) => (await window.__mockDb.from("clients").select("address").eq("id", i).single()).data.address === "1 Test Street", ids.many));
  if ((await state(p)).open) { await p.click("#modal .modal-close"); await p.waitForTimeout(500); }
  await open(p, ids.one);
  const so = await state(p);
  ok("B3 · the next client opens on the tab last used", so.tabs.join("|") === "Cases|Timeline|Details*", so.tabs.join("|"));
  ok("B4 · a client with one case has no portfolio strip on the left, and an unfolded timeline still gets its tab", so.side.join("|") === "client-contact-line|client-last-contact" && (await p.evaluate(() => !!document.querySelector('#modal .rec-panel[data-tab="timeline"] > .tl-section'))), so.side.join("|"));
  await p.click('.rec-tabs button[data-tab="cases"]'); await p.waitForTimeout(300);
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);
  await open(p, ids.many, "dob");
  const sf = await state(p);
  ok("B5 · opened to fix one field, it lands on Details with the cursor in that field", sf.tabs.join("|") === "Cases|Timeline|Details*" && (await p.evaluate(() => document.activeElement && document.activeElement.name === "date_of_birth")), sf.tabs.join("|"));
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);
  await open(p, ids.many);
  ok("B6 · and that one-field visit does not change the tab it opens on next time", (await state(p)).tabs[0] === "Cases*", (await state(p)).tabs.join("|"));
  await p.click("#client-cases-block .row-main .t"); await p.waitForTimeout(1600);
  const sc = await state(p);
  ok("B7 · a case card opens that case's record", sc.kind === "case" && sc.tabs.length === 4, JSON.stringify({ kind: sc.kind, tabs: sc.tabs }));
  await p.click("#modal .modal-close"); await p.waitForTimeout(600);

  console.log("C · what stays a small panel");
  await p.evaluate(() => window.openClient(null)); await p.waitForTimeout(900);
  const nc = await state(p);
  ok("C1 · a new client keeps the small panel", nc.open && nc.kind === "" && nc.w <= 640 && nc.tabs.length === 0, JSON.stringify({ w: nc.w, kind: nc.kind }));
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);
  const ph = await boot(browser, "?as=p4&scope=default", { width: 390, height: 844 });
  await open(ph, ids.many);
  const ps = await state(ph);
  ok("C2 · on a phone it is one column and nothing spills sideways", ps.kind === "client" && ps.left === 0 && (await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)), JSON.stringify({ left: ps.left, w: ps.w }));
  const legacy = await boot(browser, "?as=p4");
  await open(legacy, ids.many);
  const lg = await state(legacy);
  ok("C3 · the harness seam keeps the 640px panel the older suites drive", lg.open && lg.kind === "" && lg.w <= 640 && lg.tabs.length === 0 && lg.sub, JSON.stringify({ w: lg.w, kind: lg.kind }));

  const errs = [p, ph, legacy].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr111_client_record: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
