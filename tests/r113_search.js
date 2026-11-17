/* R113 — N3: recent records lead the search box. N4: a result carries its next steps.
   node tests/r113_search.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL behaviour. */
const { chromium } = require("playwright");
const BASE = "http://localhost:8099/admin/mock.html";
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
async function boot(browser, qs) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const p = await ctx.newPage();
  p.__errs = []; p.on("pageerror", (e) => p.__errs.push(String(e)));
  await p.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await p.goto(BASE + qs);
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 20000 });
  await p.waitForTimeout(600);
  return p;
}
const pal = (p) => p.evaluate(() => { const r = document.getElementById("palette-results"); const vis = (e) => e.checkVisibility();
  return { open: !document.getElementById("palette-backdrop").classList.contains("hidden"), groups: [...r.querySelectorAll(".palette-group-label")].map((g) => g.textContent),
    rows: [...r.querySelectorAll(".palette-row")].map((x) => ({ title: x.querySelector(".pr-title").textContent, sel: x.classList.contains("sel"), verb: x.classList.contains("palette-verb"), quick: [...x.querySelectorAll("[data-quick]")].filter(vis).map((b) => b.textContent) })) }; });
const openPal = async (p) => { await p.keyboard.press("/"); await p.waitForTimeout(700); };
const closeRec = async (p) => { await p.click("#modal .modal-close"); await p.waitForTimeout(500); };
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  const ids = await p.evaluate(async () => { const { data } = await window.__mockDb.from("cases").select("id,client_id,stage,clients!client_id(first_name,last_name,phone)"); const live = data.filter((c) => c.client_id && c.stage === "application" && c.clients && c.clients.phone); return { a: live[0].id, b: live[1].id, client: live[0].client_id, nameA: [live[0].clients.first_name, live[0].clients.last_name].join(" "), nameB: [live[1].clients.first_name, live[1].clients.last_name].join(" "), last: live[0].clients.last_name }; });

  console.log("A · N3 — recent records");
  await openPal(p);
  const fresh = await pal(p);
  ok("A1 · with nothing opened yet the box shows Actions only", fresh.open && !fresh.groups.includes("Recent") && fresh.rows.every((r) => r.verb), JSON.stringify(fresh.groups));
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  await p.evaluate((i) => window.openCase(i), ids.a); await p.waitForTimeout(1400); await closeRec(p);
  await p.evaluate((i) => window.openClient(i), ids.client); await p.waitForTimeout(1400); await closeRec(p);
  await p.evaluate((i) => window.openCase(i), ids.b); await p.waitForTimeout(1400); await closeRec(p);
  await openPal(p);
  const rec = await pal(p);
  const recRows = rec.rows.filter((r) => !r.verb);
  ok("A2 · the three records just opened lead the box, most recent first, above Actions", rec.groups.join("|") === "Recent|Actions" && recRows.map((r) => r.title).join("|") === [ids.nameB, ids.nameA, ids.nameA].join("|"), JSON.stringify({ g: rec.groups, t: recRows.map((r) => r.title) }));
  ok("A3 · the newest is highlighted, so Enter goes straight back to it", recRows[0].sel);
  const stored = await p.evaluate(() => { const k = Object.keys(localStorage).find((x) => x.startsWith("nx_recent_v1:")); return k ? localStorage.getItem(k) : ""; });
  ok("A4 · only kinds and ids are kept in the browser — no names", /^\[\{"t":"case","id":/.test(stored) && !stored.includes(ids.last), stored.slice(0, 90));
  await p.keyboard.press("Enter"); await p.waitForTimeout(1400);
  ok("A5 · Enter opens that record", await p.evaluate((i) => document.querySelector("#case-form") && document.querySelector("#case-form").dataset.caseId === i && !document.getElementById("modal-backdrop").classList.contains("hidden"), ids.b));
  await closeRec(p);
  await p.evaluate((i) => window.openCase(i), ids.a); await p.waitForTimeout(1400); await closeRec(p);
  await openPal(p);
  const again = (await pal(p)).rows.filter((r) => !r.verb);
  ok("A6 · opening one again moves it to the top without listing it twice", again.length === 3 && again[0].title === ids.nameA && again[1].title === ids.nameB, again.map((r) => r.title).join("|"));

  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  // The stored list goes (a different user signs in on this tab; storage is cleared): what was on screen last time must not come back.
  const kept = await p.evaluate(() => { const k = Object.keys(localStorage).find((x) => x.startsWith("nx_recent_v1:")); const v = localStorage.getItem(k); localStorage.removeItem(k); return [k, v]; });
  await p.keyboard.press("/");
  const atOnce = await pal(p);
  await p.waitForTimeout(700);
  const settled = await pal(p);
  ok("A7 · when the stored list is gone, last time's records are not shown — not even for a moment", !atOnce.groups.includes("Recent") && !settled.groups.includes("Recent") && settled.rows.every((r) => r.verb), JSON.stringify({ atOnce: atOnce.groups, settled: settled.groups }));
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  await p.evaluate(([k, v]) => localStorage.setItem(k, v), kept);
  await openPal(p);

  console.log("B · N4 — next steps on a result");
  ok("B1 · the highlighted case offers Log call, Add task and Book; the other rows show none", again[0].quick.join("|") === "Log call|Add task|Book" && again.slice(1).every((r) => r.quick.length === 0), JSON.stringify(again.map((r) => r.quick)));
  await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(200);
  const onClient = (await pal(p)).rows.filter((r) => !r.verb);
  ok("B2 · a client offers Call (it has a number) and Book", onClient[2].sel && onClient[2].quick.join("|") === "Call|Book", JSON.stringify(onClient.map((r) => r.quick)));
  ok("B3 · Call is a real tel: link", await p.evaluate(() => /^tel:\+?\d{6,}$/.test(document.querySelector('.palette-row.sel [data-quick="call"]').getAttribute("href"))));
  await p.keyboard.press("ArrowUp"); await p.keyboard.press("ArrowUp"); await p.waitForTimeout(200);
  await p.keyboard.press("Tab"); await p.keyboard.press("Enter"); await p.waitForTimeout(1800);
  const call = await p.evaluate((i) => { const f = document.querySelector("#case-form"), o = document.getElementById("overlay-backdrop"); return { caseOpen: !!f && f.dataset.caseId === i, dialog: o.classList.contains("hidden") ? "" : o.textContent.replace(/\s+/g, " ").trim().slice(0, 40), palClosed: document.getElementById("palette-backdrop").classList.contains("hidden") }; }, ids.a);
  ok("B4 · by keyboard: Tab to Log call, Enter — the case opens with Log a call in front of it", call.caseOpen && call.palClosed && call.dialog.startsWith("Log a call — " + ids.nameA), JSON.stringify(call));
  await p.keyboard.press("Escape"); await p.waitForTimeout(500);
  if (await p.evaluate(() => !document.getElementById("overlay-backdrop").classList.contains("hidden"))) console.log("DEBUG buttons:", await p.evaluate(() => [...document.querySelectorAll("#overlay-backdrop button")].map((b) => (b.id || "") + ":" + b.textContent.trim().slice(0, 20)).join(" | ")));
  await closeRec(p);
  // Leave the record on another tab, then ask for Add task: it must come to Work.
  await p.evaluate((i) => window.openCase(i), ids.a); await p.waitForTimeout(1400);
  await p.click('.rec-tabs button[data-tab="history"]'); await p.waitForTimeout(300); await closeRec(p);
  await openPal(p);
  await p.click('.palette-row.sel [data-quick="task"]'); await p.waitForTimeout(1800);
  ok("B5 · Add task opens the case on Work with the cursor in the task box", await p.evaluate(() => document.activeElement && document.activeElement.id === "new-task" && document.activeElement.checkVisibility()));
  await closeRec(p);
  await openPal(p);
  await p.fill("#palette-input", ids.last); await p.waitForTimeout(1200);
  const found = await pal(p);
  ok("B6 · typed results carry the same actions on the highlighted row", found.rows.some((r) => !r.verb && r.sel && r.quick.length >= 2), JSON.stringify(found.rows.filter((r) => !r.verb).map((r) => r.quick)).slice(0, 160));
  await p.fill("#palette-input", ""); await p.waitForTimeout(500);
  await p.hover(".palette-row >> nth=2"); await p.mouse.move(700, 300); await p.hover(".palette-row >> nth=2"); await p.waitForTimeout(200);
  ok("B7 · moving the pointer onto a row highlights it and shows that row's actions", await p.evaluate(() => { const r = document.querySelectorAll("#palette-results .palette-row")[2]; return r.classList.contains("sel") && !!r.querySelector(".pr-quick") && !r.querySelector(".pr-quick").hidden; }));
  await p.click('.palette-row.sel [data-quick="appt"]'); await p.waitForTimeout(1500);
  ok("B8 · Book on a client opens a new appointment already set to that client", await p.evaluate((cid) => { const f = document.getElementById("appt-form"); if (!f || !f.checkVisibility()) return false; const e = f.elements.client_id || document.getElementById("appt-client-select"); return !!e && e.value === cid; }, ids.client));
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);

  const ph = await boot(browser, "?as=p4&scope=default");
  await ph.setViewportSize({ width: 390, height: 844 });
  await ph.evaluate((i) => window.openCase(i), ids.a); await ph.waitForTimeout(1400); await ph.evaluate(() => window.closeModal()); await ph.waitForTimeout(400);
  await ph.evaluate(() => document.getElementById("global-search-btn").click()); await ph.waitForTimeout(900);
  const phRow = await ph.evaluate(() => { const r = document.querySelector("#palette-results .palette-row.sel"); const t = r.querySelector(".pr-title"); return { cut: t.scrollWidth > t.clientWidth, under: r.querySelector(".pr-quick").getBoundingClientRect().top >= r.querySelector(".pr-main").getBoundingClientRect().bottom - 1, spill: document.documentElement.scrollWidth > window.innerWidth }; });
  ok("B9 · on a phone the actions sit under the name, which is not cut short, and nothing spills", !phRow.cut && phRow.under && !phRow.spill, JSON.stringify(phRow));

  console.log("C · the harness seam");
  const legacy = await boot(browser, "?as=p4");
  await legacy.evaluate((i) => window.openCase(i), ids.a); await legacy.waitForTimeout(1400); await legacy.click("#modal .modal-close"); await legacy.waitForTimeout(500);
  await openPal(legacy);
  const lg = await pal(legacy);
  ok("C1 · under the seam: no Recent group and no row actions", !lg.groups.includes("Recent") && lg.rows.every((r) => r.quick.length === 0) && (await legacy.evaluate(() => !document.querySelector("#palette-results .pr-quick"))));

  const errs = [p, ph, legacy].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr113_search: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
