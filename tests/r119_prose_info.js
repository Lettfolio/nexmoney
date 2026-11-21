/* R119 — X6: on Operations and Settings an explaining sentence sits behind an "i" on its heading.
   node tests/r119_prose_info.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL behaviour. */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs) {
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  await p.waitForTimeout(600);
  return p;
}
const go = async (p, where) => { await p.evaluate((x) => window.nav(x), where); await p.waitForTimeout(1500); };
const setTab = async (p, i) => { await p.evaluate((i) => [...document.querySelectorAll("#page-settings [role=tab], #page-settings .tabs button, #settings-tabs button")][i].click(), i); await p.waitForTimeout(900); };
/* One sentence: is it on show, and what does its "i" say. */
const line = (p, sel) => p.evaluate((sel) => { const e = typeof sel === "string" && sel.startsWith("~") ? [...document.querySelectorAll("p.panel-sub")].find((x) => x.textContent.includes(sel.slice(1))) : document.querySelector(sel); if (!e) return null;
  const b = e.id && document.querySelector(`.info-i[aria-controls="${e.id}"]`), r = b && b.getBoundingClientRect();
  return { shown: e.checkVisibility(), text: e.textContent.replace(/\s+/g, " ").trim(), i: b ? { exp: b.getAttribute("aria-expanded"), label: b.getAttribute("aria-label"), inHeading: !!b.closest("h2, h3, h4"), w: Math.round(r.width), vis: b.checkVisibility() } : null }; }, sel);
const words = (p) => p.evaluate(() => { const pg = document.querySelector(".page:not(.hidden)"); let n = 0; pg.querySelectorAll("p.panel-sub").forEach((e) => { if (e.checkVisibility()) n += e.textContent.trim().split(/\s+/).filter(Boolean).length; }); return n; });
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  const seam = await boot(browser, "?as=p4");

  console.log("A · Operations");
  await go(p, "operations"); await go(seam, "operations");
  const intro = await line(p, "#emails-intro");
  ok("A1 · Emails: the two status lines stay on show; the intro is inside the fold beneath them (R124)", !intro.shown && !intro.i && (await line(p, "#em-morning-sub")).shown && (await line(p, "#sms-summary")).shown && (await p.evaluate(() => document.getElementById("emails-intro").parentElement.id === "emails-explainer")));
  await go(p, "operations/import"); await go(seam, "operations/import");
  const rev = await line(p, "#rev-intro"), imp = await line(p, "#import-intro");
  ok("A2 · Import: both door explainers are behind an i, each on its own heading", rev && !rev.shown && rev.i && rev.i.exp === "false" && rev.i.inHeading && imp && !imp.shown && imp.i && rev.i.label === "About Revolution sync" && imp.i.label === "About Bring in data from anywhere", JSON.stringify([rev && rev.i, imp && imp.i]));
  await p.hover('.info-i[aria-controls="rev-intro"]'); await p.waitForTimeout(150);
  ok("A3 · hovering the i names the sentence", (await p.getAttribute('.info-i[aria-controls="rev-intro"]', "title")) === rev.text);
  await p.click('.info-i[aria-controls="rev-intro"]'); await p.waitForTimeout(150);
  const open = await line(p, "#rev-intro");
  ok("A4 · pressing it shows the sentence where it always was", open.shown && open.i.exp === "true" && open.text === (await line(seam, "#rev-intro")).text && !(await line(p, "#import-intro")).shown);
  await p.focus('.info-i[aria-controls="rev-intro"]'); await p.keyboard.press("Enter"); await p.waitForTimeout(150);
  ok("A5 · and again, from the keyboard, puts it away", !(await line(p, "#rev-intro")).shown && (await line(p, "#rev-intro")).i.exp === "false");
  const wReal = await words(p), wSeam = await words(seam);
  ok("A7 · the Import tab carries fewer standing words than before", wReal < wSeam, `${wSeam} → ${wReal}`);

  console.log("B · Settings");
  await go(p, "settings"); await go(seam, "settings");
  const golive = await line(p, "#settings-golive-sub"), rules = await line(p, "~The switches that make this system");
  ok("B1 · Firm & rules: the two explainers are behind an i", golive && !golive.shown && golive.i && rules && !rules.shown && rules.i, JSON.stringify([golive, rules]));
  ok("B2 · the email-sending status line stays on show", (await line(p, "#email-sending-sub")).shown && !(await line(p, "#email-sending-sub")).i);
  const sReal = await words(p), sSeam = await words(seam);
  ok("B3 · fewer standing words on Firm & rules", sReal < sSeam, `${sSeam} → ${sReal}`);
  await setTab(p, 1);
  const promo = await line(p, "~financial promotions"), chase = await line(p, "#set-doc-chase-pointer");
  ok("B4 · Automations: the financial-promotions warning and the chasing status stay on show", promo && promo.shown && !promo.i && chase && chase.shown && !chase.i, JSON.stringify([promo, chase]));
  await setTab(p, 3);
  const sec = await line(p, "#security-sub"), logins = await line(p, "~logins have one");
  ok("B5 · Team & security: the two-step explainer is behind an i; the count of logins is not", sec && !sec.shown && sec.i && logins && logins.shown && !logins.i, JSON.stringify([sec, logins]));
  await setTab(p, 4);
  const exp = await line(p, "#firm-export-sub"), hist = await line(p, "#change-history-sub");
  ok("B6 · Data: the 'Not encrypted' warning stays on show; the history explainer is behind an i", exp && exp.shown && !exp.i && /Not encrypted/.test(exp.text) && hist && !hist.shown && hist.i, JSON.stringify([exp, hist]));
  await setTab(p, 0); await go(p, "pipeline"); await go(p, "settings");
  const dup = await p.evaluate(() => { const hs = [...document.querySelectorAll("#page-settings h2, #page-settings h3, #page-settings h4")]; return { max: Math.max(...hs.map((h) => h.querySelectorAll(".info-i").length)), orphans: [...document.querySelectorAll("#page-settings .info-i")].filter((b) => !document.getElementById(b.getAttribute("aria-controls"))).length }; });
  ok("B7 · after leaving and coming back there is still one i per heading and none points at nothing", dup.max === 1 && dup.orphans === 0 && !(await line(p, "#settings-golive-sub")).shown, JSON.stringify(dup));
  ok("B8 · the i is big enough to press", (await line(p, "#settings-golive-sub")).i.w >= 20);

  console.log("C · elsewhere");
  await go(p, "dashboard");
  ok("C1 · Today is untouched (it has no explaining sentences to move)", await p.evaluate(() => document.querySelectorAll("#page-dashboard .info-i").length === 0));
  ok("C2 · the harness seam has no i buttons and every sentence on show", await seam.evaluate(() => document.querySelectorAll(".info-i").length === 0 && [...document.querySelectorAll("p.panel-sub")].every((e) => !e.hidden)));
  const errs = [p, seam].flatMap((x) => x.__errs);
  ok("E1 · no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  console.log(`\nr119_prose_info: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
