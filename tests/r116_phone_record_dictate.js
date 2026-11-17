/* R116 — a record on a phone does not slide sideways; the assistant opens cleanly on a phone; dictation.
   node tests/r116_phone_record_dictate.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL behaviour. */
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
/* A stand-in for the browser's speech recogniser: the test says what was "heard". */
const FAKE_SR = () => { window.__sr = []; window.SpeechRecognition = window.webkitSpeechRecognition = function () { const me = this; window.__sr.push(me); me.started = 0; me.stopped = 0;
  me.start = () => { me.started++; }; me.stop = () => { me.stopped++; if (me.onend) me.onend(); };
  me.hear = (t) => me.onresult({ results: [[{ transcript: t }]] }); me.failWith = (c) => { me.onerror({ error: c }); if (me.onend) me.onend(); }; }; };
const NO_SR = () => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; Object.defineProperty(window, "SpeechRecognition", { value: undefined }); Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined }); };
async function boot(browser, qs, ctxOpts, init) {
  const ctx = await browser.newContext(ctxOpts || { viewport: { width: 1366, height: 768 } });
  const p = await ctx.newPage();
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  if (init) await p.addInitScript(init);
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  await p.waitForTimeout(600);
  return p;
}
/* How far the open record can be pushed sideways, and what sticks out past the screen edge. */
const sideways = (p) => p.evaluate(() => { const back = document.getElementById("modal-backdrop"), m = document.getElementById("modal"), vw = document.documentElement.clientWidth;
  back.scrollLeft = 500; const moved = back.scrollLeft; back.scrollLeft = 0;
  const out = [...m.querySelectorAll("*")].filter((e) => e.checkVisibility() && !e.closest("table, .table-scroll, .stage-tabs, .rec-tabs") && (e.getBoundingClientRect().right > vw + 0.5 || e.getBoundingClientRect().left < -0.5)).map((e) => e.id || e.className).slice(0, 4);
  return { open: !back.classList.contains("hidden"), moved, out, doc: document.documentElement.scrollWidth - vw }; });
const still = (s) => s.open && s.moved === 0 && s.out.length === 0 && s.doc <= 0;
(async () => {
  const browser = await chromium.launch();

  console.log("A · a record on a phone stays put sideways");
  const p = await boot(browser, "?as=p4&scope=default", PHONE, FAKE_SR);
  const ids = await p.evaluate(async () => { const { data } = await window.__mockDb.from("cases").select("id,client_id"); const n = {}; data.forEach((c) => { if (c.client_id) n[c.client_id] = (n[c.client_id] || 0) + 1; }); const e = Object.entries(n).sort((a, b) => b[1] - a[1]); return { many: e[0][0], kase: data[0].id }; });
  await p.evaluate(async (i) => { await window.__mockDb.from("clients").update({ email: "a-very-long-unbroken-address-that-used-to-push-things-wide@an-equally-long-domain-name-example.co.uk" }).eq("id", i); }, ids.many);
  await p.evaluate((i) => window.openClient(i), ids.many); await p.waitForTimeout(1600);
  for (const tab of ["cases", "timeline", "details"]) { await p.click(`.rec-tabs button[data-tab="${tab}"]`); await p.waitForTimeout(500); const s = await sideways(p); ok(`A1 · client record, ${tab}: nothing wider than the screen and no sideways travel`, still(s), JSON.stringify(s)); }
  const bars = await p.evaluate(() => ["#modal .modal-topbar", "#modal > .modal-actions"].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }));
  ok("A2 · the top bar and the Save bar end exactly at the screen edges", bars.every((b) => b[0] === 0 && b[1] === 390), JSON.stringify(bars));
  ok("A3 · the record stops the page behind it being dragged along", await p.evaluate(() => { const cs = getComputedStyle(document.getElementById("modal-backdrop")); return cs.overflowX === "hidden" && cs.overscrollBehaviorY === "contain" && cs.overflowY === "auto"; }));
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);
  await p.evaluate((i) => window.openCase(i), ids.kase); await p.waitForTimeout(1800);
  const cs = await sideways(p); ok("A4 · a case record is the same", still(cs), JSON.stringify(cs));
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);
  const tab = await boot(browser, "?as=p4&scope=default", { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });
  await tab.evaluate((i) => window.openClient(i), ids.many); await tab.waitForTimeout(1600);
  const ts = await sideways(tab); ok("A5 · and on a tablet-width screen (it was 12px over each side)", still(ts), JSON.stringify(ts));
  const desk = await boot(browser, "?as=p4&scope=default", null, FAKE_SR);
  await desk.evaluate((i) => window.openClient(i), ids.many); await desk.waitForTimeout(1600);
  ok("A6 · the desktop record is untouched: beside the sidebar, two columns", await desk.evaluate(() => { const b = document.getElementById("modal-backdrop").getBoundingClientRect(), m = document.getElementById("modal"); return Math.round(b.left) === 216 && getComputedStyle(m).display === "grid"; }));
  await desk.click("#modal .modal-close"); await desk.waitForTimeout(400);

  console.log("B · the assistant opens cleanly on a phone");
  await p.tap("#assistant-fab"); await p.waitForTimeout(400);
  const o = await p.evaluate(() => { const d = document.getElementById("assistant-drawer"), c = document.getElementById("assistant-close").getBoundingClientRect(), f = document.getElementById("chat-form").getBoundingClientRect();
    return { open: d.checkVisibility(), focus: document.activeElement.id, greet: document.querySelectorAll("#chat-log .chat-ai").length, vvh: document.documentElement.style.getPropertyValue("--vvh"), h: Math.round(d.getBoundingClientRect().height), vh: Math.round(window.visualViewport.height), close: [Math.round(c.width), Math.round(c.height)], formBottom: Math.round(f.bottom) }; });
  ok("B1 · it opens on the greeting without raising the keyboard", o.open && o.greet === 1 && o.focus !== "chat-input", JSON.stringify(o));
  ok("B2 · it is exactly as tall as the visible screen, so the box is never under the browser's bar", o.vvh === o.vh + "px" && o.h === o.vh && o.formBottom <= o.vh, JSON.stringify(o));
  ok("B3 · the close button is a full-size touch target", o.close[0] >= 44 && o.close[1] >= 44, o.close.join("×"));
  await p.evaluate(() => { window.visualViewport.dispatchEvent(new Event("resize")); });
  await p.setViewportSize({ width: 390, height: 500 }); await p.waitForTimeout(400);
  const k = await p.evaluate(() => ({ h: Math.round(document.getElementById("assistant-drawer").getBoundingClientRect().height), b: Math.round(document.getElementById("chat-form").getBoundingClientRect().bottom), vh: Math.round(window.visualViewport.height) }));
  ok("B4 · when the visible area shrinks (keyboard up) the drawer shrinks with it", k.h === k.vh && k.b <= k.vh && k.vh === 500, JSON.stringify(k));
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(300);
  ok("B5 · on a desktop it still puts the cursor in the box", await desk.evaluate(() => { window.askAI(); return document.activeElement.id === "chat-input"; }));
  const ios = await boot(browser, "?as=p4&scope=default", { ...PHONE, userAgent: IOS_UA });
  const vpI = await ios.evaluate(() => document.querySelector('meta[name="viewport"]').content), vpA = await p.evaluate(() => document.querySelector('meta[name="viewport"]').content);
  ok("B6 · on an iPhone the page no longer zooms itself when a field is tapped", /maximum-scale=1\b/.test(vpI) && /width=device-width/.test(vpI), vpI);
  ok("B6b · other phones keep the plain viewport (their pinch-zoom is untouched)", !/maximum-scale/.test(vpA), vpA);

  console.log("C · dictation");
  const mic = (pg) => pg.evaluate(() => { const m = document.getElementById("chat-mic"), r = m.getBoundingClientRect(); return { shown: m.checkVisibility(), pressed: m.getAttribute("aria-pressed"), label: m.getAttribute("aria-label"), on: m.classList.contains("on"), h: Math.round(r.height), n: (window.__sr || []).length, started: (window.__sr || []).reduce((a, s) => a + s.started, 0) }; });
  const m0 = await mic(p);
  ok("C1 · a Dictate button sits beside Send, and nothing is listening until it is pressed", m0.shown && m0.pressed === "false" && m0.label === "Dictate" && m0.n === 0, JSON.stringify(m0));
  await p.fill("#chat-input", "Add a task for"); await p.tap("#chat-mic"); await p.waitForTimeout(200);
  const m1 = await mic(p);
  ok("C2 · pressing it starts listening and says so", m1.pressed === "true" && m1.on && m1.label === "Stop dictating" && m1.started === 1, JSON.stringify(m1));
  ok("C2b · it listens for British English", await p.evaluate(() => window.__sr[0].lang === "en-GB"));
  await p.evaluate(() => window.__sr[0].hear("the Bellamys")); await p.evaluate(() => window.__sr[0].hear("the Bellamys tomorrow at ten"));
  ok("C3 · what is heard is added after what was already typed, and replaces its own earlier guess", (await p.inputValue("#chat-input")) === "Add a task for the Bellamys tomorrow at ten", await p.inputValue("#chat-input"));
  ok("C4 · nothing is sent on its own", await p.evaluate(() => document.querySelectorAll("#chat-log .chat-me").length === 0));
  await p.tap("#chat-mic"); await p.waitForTimeout(200);
  const m2 = await mic(p);
  ok("C5 · pressing it again stops listening", m2.pressed === "false" && !m2.on && m2.label === "Dictate" && (await p.evaluate(() => window.__sr[0].stopped === 1)), JSON.stringify(m2));
  await p.tap("#chat-mic"); await p.waitForTimeout(150); await p.evaluate(() => window.__sr[1].failWith("not-allowed")); await p.waitForTimeout(300);
  const blocked = await p.evaluate(() => { const t = document.querySelector(".toast, #toast"); return t ? t.textContent : ""; });
  ok("C6 · a blocked microphone is explained and the button resets", /microphone is blocked/i.test(blocked) && (await mic(p)).pressed === "false", blocked.slice(0, 80));
  await p.tap("#chat-mic"); await p.waitForTimeout(150); await p.tap("#chat-send"); await p.waitForTimeout(600);
  ok("C7 · Send stops the listening and sends what is in the box", (await p.evaluate(() => window.__sr[2].stopped === 1 && document.querySelectorAll("#chat-log .chat-me").length === 1)) && (await mic(p)).pressed === "false");
  await p.tap("#chat-mic"); await p.waitForTimeout(150); await p.tap("#assistant-close"); await p.waitForTimeout(300);
  ok("C8 · closing the assistant stops the listening and releases the drawer height", await p.evaluate(() => window.__sr[3].stopped === 1 && !document.getElementById("assistant-drawer").checkVisibility() && document.documentElement.style.getPropertyValue("--vvh") === ""));
  const none = await boot(browser, "?as=p4&scope=default", PHONE, NO_SR);
  await none.tap("#assistant-fab"); await none.waitForTimeout(300);
  ok("C9 · a browser that cannot dictate shows no button", !(await mic(none)).shown);
  const seam = await boot(browser, "?as=p4", PHONE, FAKE_SR);
  await seam.evaluate(() => window.askAI()); await seam.waitForTimeout(300);
  ok("C10 · the harness seam keeps the old assistant: no button, cursor in the box", !(await mic(seam)).shown && (await seam.evaluate(() => document.activeElement.id === "chat-input" && document.documentElement.style.getPropertyValue("--vvh") === "")));

  console.log("D · the microphone is allowed for the back office only");
  const vj = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  const pp = vj.headers.filter((h) => h.headers.some((x) => x.key === "Permissions-Policy")).map((h) => [h.source, h.headers.find((x) => x.key === "Permissions-Policy").value]);
  const adminPP = (pp.find((x) => x[0] === "/admin/:path*") || [])[1] || "", sitePP = (pp.find((x) => x[0] === "/((?!admin).*)") || [])[1] || "";
  ok("D1 · /admin may use its own microphone and nothing else new", adminPP === "camera=(), microphone=(self), geolocation=(), payment=(), usb=()", adminPP);
  ok("D2 · the public site still refuses the microphone, and no rule covers both", sitePP === "camera=(), microphone=(), geolocation=(), payment=(), usb=()" && pp.length === 2, JSON.stringify(pp));

  const errs = [p, tab, desk, ios, none, seam].flatMap((x) => x.__errs);
  ok("E1 · no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  console.log(`\nr116_phone_record_dictate: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
