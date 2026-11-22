/* R122 — X3: three things that can be put back are done at once and offer Undo, instead of asking first.
   node tests/r122_undo.js   (static server on :8099, admin/mock.html built by smoke.js)
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
const overlay = (p) => p.evaluate(() => { const o = document.getElementById("overlay-modal"); return o && o.checkVisibility() ? o.textContent.replace(/\s+/g, " ").trim() : ""; });
const toast = (p) => p.evaluate(() => { const t = document.getElementById("toast"); return t && t.checkVisibility() ? { text: (t.querySelector(".toast-msg") || t).textContent.trim(), action: t.querySelector("#toast-action") ? t.querySelector("#toast-action").textContent.trim() : "" } : { text: "", action: "" }; });
const q = (p, table, sel, col, val) => p.evaluate(async ([t, s, c, v]) => (await window.__mockDb.from(t).select(s).eq(c, v)).data, [table, sel, col, val]);
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  await p.evaluate(() => document.querySelector("#brief-scope-all").click()); await p.waitForTimeout(700);   // R126: the owner now opens every page on Mine; these checks read the firm-wide lists

  console.log("A · a checklist row");
  const doc = await p.evaluate(async () => { const { data } = await window.__mockDb.from("case_documents").select("*"); const d = data.find((x) => x.status === "requested") || data[0]; return d; });
  const nBefore = (await q(p, "case_documents", "id", "case_id", doc.case_id)).length;
  await p.evaluate((i) => window.openCase(i), doc.case_id); await p.waitForTimeout(1800);
  await p.click('.rec-tabs button[data-tab="docs"]'); await p.waitForTimeout(600);
  const delSel = `.doc-act[data-doc-act="delete"][data-doc="${doc.id}"]`;
  await p.click(delSel); await p.waitForTimeout(700);
  const t1 = await toast(p);
  ok("A1 · Delete does it at once — no question first", (await overlay(p)) === "" && (await q(p, "case_documents", "id", "id", doc.id)).length === 0 && !(await p.$(delSel)));
  ok("A2 · and the toast offers Undo", /deleted/i.test(t1.text) && t1.action === "Undo", JSON.stringify(t1));
  await p.click("#toast-action"); await p.waitForTimeout(800);
  const back = (await q(p, "case_documents", "*", "id", doc.id))[0];
  ok("A3 · Undo puts the same row back, whole", !!back && JSON.stringify(back) === JSON.stringify(doc), JSON.stringify(back));
  ok("A4 · and the list on screen shows it again", !!(await p.$(delSel)) && (await q(p, "case_documents", "id", "case_id", doc.case_id)).length === nBefore && /put back/i.test((await toast(p)).text));
  await p.click(delSel); await p.waitForTimeout(600);
  await p.click("#modal .modal-close"); await p.waitForTimeout(600);
  const other = await p.evaluate(async (cid) => (await window.__mockDb.from("cases").select("id")).data.find((c) => c.id !== cid).id, doc.case_id);
  await p.evaluate((i) => window.openCase(i), other); await p.waitForTimeout(1800);
  await p.click('.rec-tabs button[data-tab="docs"]'); await p.waitForTimeout(500);
  const otherRows = await p.evaluate(() => [...document.querySelectorAll("#case-docs-body .doc-act")].map((b) => b.dataset.doc).join());
  await p.click("#toast-action"); await p.waitForTimeout(800);
  ok("A5 · Undo pressed after another case was opened restores the row without painting it into that case", (await q(p, "case_documents", "id", "id", doc.id)).length === 1 && (await p.evaluate(() => [...document.querySelectorAll("#case-docs-body .doc-act")].map((b) => b.dataset.doc).join())) === otherRows);
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);
  const adv = await boot(browser, "?as=p2&scope=default");
  await adv.evaluate((i) => window.openCase(i), doc.case_id); await adv.waitForTimeout(1800);
  ok("A6 · an adviser still has no Delete on a checklist row", await adv.evaluate(() => document.querySelectorAll('.doc-act[data-doc-act="delete"]').length === 0 && document.querySelectorAll(".doc-act").length > 0));

  console.log("B · a saved Pipeline view");
  await p.evaluate(() => window.nav("pipeline")); await p.waitForFunction(() => document.querySelectorAll("#board .card").length > 5); await p.waitForTimeout(500);
  await p.fill("#board-search", "bell"); await p.waitForTimeout(500);
  await p.click("#board-view-save"); await p.waitForTimeout(400);
  await p.fill("#overlay-modal input", "Bells only"); await p.keyboard.press("Enter"); await p.waitForTimeout(600);
  const sel = "board-views", delBtn = "board-view-del";
  ok("B0 · the view was saved and is selected", !!sel && !!delBtn && (await p.inputValue("#" + sel)) === "Bells only", sel + "/" + delBtn);
  const has = () => p.evaluate((s) => [...document.getElementById(s).options].some((o) => o.value === "Bells only"), sel);
  await p.click("#" + delBtn); await p.waitForTimeout(500);
  const t2 = await toast(p);
  ok("B1 · deleting it asks nothing and offers Undo", (await overlay(p)) === "" && !(await has()) && t2.action === "Undo" && /Bells only/.test(t2.text), JSON.stringify(t2));
  await p.click("#toast-action"); await p.waitForTimeout(500);
  ok("B2 · Undo brings the view back", await has());
  await p.fill("#board-search", ""); await p.waitForTimeout(300);
  await p.selectOption("#" + sel, "Bells only"); await p.waitForTimeout(500);
  ok("B3 · with the filters it held", (await p.inputValue("#board-search")) === "bell");
  await p.fill("#board-search", ""); await p.waitForTimeout(300);

  console.log("C · assigning cases on Data health");
  const two = await p.evaluate(async () => { const { data } = await window.__mockDb.from("cases").select("id,stage,assigned_to"); const live = data.filter((c) => c.stage !== "completed" && c.stage !== "not_proceeding").slice(0, 2); for (const c of live) await window.__mockDb.from("cases").update({ assigned_to: null }).eq("id", c.id); return live.map((c) => c.id); });
  await p.evaluate(() => window.nav("operations/data")); await p.waitForFunction(() => document.querySelectorAll("#data-content .dh-cb").length >= 2, null, { timeout: 20000 }); await p.waitForTimeout(600);
  const picked = await p.evaluate((ids) => { const cbs = [...document.querySelectorAll("#data-content .dh-cb")].filter((cb) => ids.includes(cb.dataset.id)); cbs.forEach((cb) => cb.click()); return cbs.length; }, two);
  const who = await p.evaluate(() => { const s = document.getElementById("dh-bulk-adviser"); const o = [...s.options].find((x) => x.value); s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return o.value; });
  await p.waitForTimeout(1200);
  const assigned = await p.evaluate(async (ids) => (await window.__mockDb.from("cases").select("id,assigned_to")).data.filter((c) => ids.includes(c.id)).map((c) => c.assigned_to), two);
  const t3 = await toast(p);
  ok("C1 · choosing an adviser assigns the ticked cases at once — no question", picked === 2 && (await overlay(p)) === "" && assigned.every((a) => a === who), JSON.stringify([picked, assigned]));
  ok("C2 · and the toast says how many and offers Undo", /^2 cases assigned to /.test(t3.text) && t3.action === "Undo", JSON.stringify(t3));
  await p.evaluate(async ([id, who]) => { const other = (await window.__mockDb.from("profiles").select("id")).data.find((x) => x.id !== who).id; await window.__mockDb.from("cases").update({ assigned_to: other }).eq("id", id); }, [two[1], who]);
  await p.click("#toast-action"); await p.waitForTimeout(1200);
  const after = await p.evaluate(async (ids) => { const d = (await window.__mockDb.from("cases").select("id,assigned_to")).data; return ids.map((i) => d.find((c) => c.id === i).assigned_to); }, two);
  ok("C3 · Undo hands back the one still as it left it, and leaves the one a colleague has since re-assigned", after[0] === null && after[1] !== null && after[1] !== who, JSON.stringify(after));
  ok("C4 · and says so", /^1 case handed back — 1 left as since changed/.test((await toast(p)).text), (await toast(p)).text);

  console.log("D · what still asks");
  const seam = await boot(browser, "?as=p4");
  await seam.evaluate(() => window.nav("pipeline")); await seam.waitForFunction(() => document.querySelectorAll("#board .card").length > 5); await seam.waitForTimeout(500);
  seam.on("dialog", (d) => d.accept("Seam view"));
  await seam.click("#board-view-save"); await seam.waitForTimeout(800);
  if (await seam.$("#overlay-modal input")) { await seam.fill("#overlay-modal input", "Seam view"); await seam.keyboard.press("Enter"); await seam.waitForTimeout(500); }
  await seam.click("#" + delBtn); await seam.waitForTimeout(500);
  ok("D1 · the harness seam still asks before deleting a view", /Delete this saved view/.test(await overlay(seam)), (await overlay(seam)).slice(0, 60));
  const errs = [p, adv, seam].flatMap((x) => x.__errs);
  ok("E1 · no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  console.log(`\nr122_undo: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
