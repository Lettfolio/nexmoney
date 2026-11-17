/* R110 — C4: on the full-width record a case field saves as you leave it; there is no Save button.
   node tests/r110_autosave.js   (static server on :8099, admin/mock.html built by smoke.js)
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
const row = (p, id) => p.evaluate(async (i) => (await window.__mockDb.from("cases").select("*").eq("id", i).single()).data, id);
const field = (p, n) => p.evaluate((x) => { const e = document.querySelector("#case-form").elements[x]; return e.type === "checkbox" ? e.checked : e.value; }, n);
const vis = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && e.checkVisibility(); }, sel);
const overlay = (p) => p.evaluate(() => { const o = document.getElementById("overlay-modal"); return o && o.checkVisibility() ? o.textContent.replace(/\s+/g, " ").trim() : ""; });
const isOpen = (p) => p.evaluate(() => !document.getElementById("modal-backdrop").classList.contains("hidden"));
const details = async (p) => { await p.click('.rec-tabs button[data-tab="details"]'); await p.waitForTimeout(500); };
// A live case with no protection gate in the way and nothing odd about its dates.
const pick = (p, where) => p.evaluate(async (w) => { const { data } = await window.__mockDb.from("cases").select("*"); const c = (data || []).find(new Function("c", "return " + w)); return c ? c.id : null; }, where);
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  const id = await pick(p, 'c.stage === "application" && c.client_id');
  await p.evaluate((i) => window.openCase(i), id); await p.waitForTimeout(1500);
  await details(p);

  console.log("A · a field saves as you leave it");
  ok("A1 · no Save and no Cancel on the record; Open client stays", !(await vis(p, "#modal-save")) && !(await vis(p, "#modal-cancel")) && (await vis(p, "#case-open-client")));
  const b0 = await row(p, id);
  await p.fill('#case-form input[name="rate_percent"]', "5.55"); await p.press('#case-form input[name="rate_percent"]', "Tab"); await p.waitForTimeout(700);
  const b1 = await row(p, id);
  ok("A2 · leaving the box writes it — no button pressed", String(b1.rate_percent) === "5.55", String(b1.rate_percent));
  const moved = Object.keys(b1).filter((k) => String(b1[k]) !== String(b0[k]));
  ok("A3 · only that field went to the database", moved.filter((k) => k !== "updated_at").join() === "rate_percent", moved.join());
  ok("A4 · a Saved tick shows beside the field", await p.evaluate(() => { const t = document.querySelector('#case-form input[name="rate_percent"]').closest("label").querySelector(".saved-msg"); return !!t && /Saved/.test(t.textContent) && t.checkVisibility(); }));
  ok("A5 · the summary on the left shows the new figure", await p.evaluate(() => /5\.55%/.test(document.querySelector("#cs-stats-key").textContent)));
  await p.waitForTimeout(2700);
  ok("A6 · the tick goes after a moment", await p.evaluate(() => !document.querySelector("#case-form .saved-msg")));
  await p.selectOption('#case-form select[name="fee_status"]', "requested"); await p.waitForTimeout(700);
  ok("A7 · a drop-down saves the moment it is chosen", (await row(p, id)).fee_status === "requested");
  await p.fill('#case-form input[name="lender"]', "Zed Bank"); await p.keyboard.press("Escape"); await p.waitForTimeout(900);
  ok("A8 · Escape in the middle of a box saves it and closes — no discard question", !(await isOpen(p)) && (await overlay(p)) === "" && (await row(p, id)).lender === "Zed Bank", JSON.stringify({ open: await isOpen(p), lender: (await row(p, id)).lender }));

  console.log("B · the checks Save used to make");
  await p.evaluate((i) => window.openCase(i), id); await p.waitForTimeout(1500);
  ok("B1 · the record reopens on the tab you were on", await vis(p, '#case-form select[name="stage"]'));
  await p.evaluate(async (i) => { await window.__mockDb.from("cases").update({ protection_status: "not_discussed", protection_commission: null }).eq("id", i); }, id);
  await p.evaluate((i) => window.openCase(i), id); await p.waitForTimeout(1500);
  await p.selectOption('#case-form select[name="protection_status"]', "policy_taken"); await p.waitForTimeout(700);
  ok("B2 · Policy taken with no commission is refused and goes back", (await field(p, "protection_status")) === "not_discussed" && (await row(p, id)).protection_status === "not_discussed", await field(p, "protection_status"));
  await p.selectOption('#case-form select[name="stage"]', "not_proceeding"); await p.waitForTimeout(700);
  ok("B3 · Not Proceeding still asks for the reason", await vis(p, "#lost-reason"));
  await p.click("#lost-cancel"); await p.waitForTimeout(600);
  ok("B4 · cancelling the reason puts the stage back and writes nothing", (await field(p, "stage")) === "application" && (await row(p, id)).stage === "application", await field(p, "stage"));
  await p.fill('#case-form input[name="expected_completion_date"]', "2020-01-15"); await p.press('#case-form input[name="expected_completion_date"]', "Tab"); await p.waitForTimeout(700);
  ok("B5 · a completion date in the past is questioned", /in the past/.test(await overlay(p)), (await overlay(p)).slice(0, 80));
  await p.click("#ovl-confirm-cancel"); await p.waitForTimeout(600);
  ok("B6 · saying no puts the old date back", (await field(p, "expected_completion_date")) === (b0.expected_completion_date || "") && (await row(p, id)).expected_completion_date === b0.expected_completion_date, await field(p, "expected_completion_date"));
  await p.selectOption('#case-form select[name="protection_status"]', "discussed"); await p.waitForTimeout(700);
  await p.selectOption('#case-form select[name="stage"]', "offer"); await p.waitForTimeout(1800);
  const head = await p.evaluate(() => document.querySelector("#modal .cs-h3-row h3").textContent);
  ok("B7 · a stage change saves, and the record redraws around the new stage without leaving the tab", (await row(p, id)).stage === "offer" && /Offer/.test(head) && (await isOpen(p)) && (await vis(p, '#case-form select[name="stage"]')), head);

  console.log("C · two people in one case");
  await p.evaluate(async (i) => { await window.__mockDb.from("cases").update({ product_name: "Theirs 2yr", updated_at: new Date(Date.now() + 5000).toISOString() }).eq("id", i); }, id);
  await p.fill('#case-form input[name="term_years"]', "31"); await p.press('#case-form input[name="term_years"]', "Tab"); await p.waitForTimeout(900);
  let r = await row(p, id);
  ok("C1 · a colleague's change to another field is kept, and yours is written without a question", String(r.term_years) === "31" && r.product_name === "Theirs 2yr" && (await overlay(p)) === "", JSON.stringify({ term: r.term_years, product: r.product_name }));
  await p.evaluate(async (i) => { await window.__mockDb.from("cases").update({ lender: "Their Bank", updated_at: new Date(Date.now() + 9000).toISOString() }).eq("id", i); }, id);
  await p.fill('#case-form input[name="lender"]', "My Bank"); await p.press('#case-form input[name="lender"]', "Tab"); await p.waitForTimeout(900);
  ok("C2 · the same field changed by both is put to you", /colleague changed lender/i.test(await overlay(p)), (await overlay(p)).slice(0, 90));
  await p.click("#ovl-confirm-cancel"); await p.waitForTimeout(700);
  ok("C3 · declining shows theirs and leaves it", (await field(p, "lender")) === "Their Bank" && (await row(p, id)).lender === "Their Bank", await field(p, "lender"));
  await p.fill('#case-form input[name="lender"]', "My Bank"); await p.press('#case-form input[name="lender"]', "Tab"); await p.waitForTimeout(900);
  ok("C4 · typing it again after that is an ordinary save", (await row(p, id)).lender === "My Bank" && (await overlay(p)) === "");

  console.log("D · work in progress is not lost");
  await p.click('.rec-tabs button[data-tab="work"]'); await p.waitForTimeout(1500);
  await p.fill("#new-note", "half a thought"); 
  await details(p);
  await p.selectOption('#case-form select[name="case_kind"]', "remortgage"); await p.waitForTimeout(1500);
  ok("D1 · a half-typed note survives a save that would otherwise redraw the record", (await p.evaluate(() => (document.querySelector("#new-note") || {}).value)) === "half a thought" && (await row(p, id)).case_kind === "remortgage");
  await p.click("#modal .modal-close"); await p.waitForTimeout(600);
  ok("D2 · and leaving with that note unsaved still warns", /unsaved|discard/i.test(await overlay(p)), (await overlay(p)).slice(0, 60));
  await p.evaluate(() => { const b = [...document.querySelectorAll("#overlay-modal button")].find((x) => /discard/i.test(x.textContent)); if (b) b.click(); }); await p.waitForTimeout(600);

  console.log("D2 · one case's save never borrows another's stamp");
  const id2 = await pick(p, `c.stage === "fact_find" && c.client_id && c.id !== "${id}"`);
  await p.evaluate((i) => window.openCase(i), id); await p.waitForTimeout(1500); await details(p);
  await p.fill('#case-form input[name="product_name"]', "Left in a hurry");
  // Leave the box and open the next case in the same breath: the first save is still in flight.
  await p.evaluate((i) => { document.activeElement.blur(); window.openCase(i); }, id2); await p.waitForTimeout(2000);
  const stampOk = await p.evaluate(async (i) => { /* global openedUpdatedAt */ const { data } = await window.__mockDb.from("cases").select("updated_at").eq("id", i).single(); return typeof openedUpdatedAt !== "undefined" && openedUpdatedAt === data.updated_at; }, id2);
  ok("D2b · the case now on screen still holds its own stamp", stampOk);
  await p.fill('#case-form input[name="product_name"]', "Second case"); await p.press('#case-form input[name="product_name"]', "Tab"); await p.waitForTimeout(900);
  ok("D3 · both saves land on their own case and nobody is asked about a conflict", (await row(p, id)).product_name === "Left in a hurry" && (await row(p, id2)).product_name === "Second case" && (await overlay(p)) === "", JSON.stringify({ a: (await row(p, id)).product_name, b: (await row(p, id2)).product_name, o: (await overlay(p)).slice(0, 50) }));
  await p.fill('#case-form input[name="lender_reference"]', "REF-2"); await p.press('#case-form input[name="lender_reference"]', "Tab"); await p.waitForTimeout(900);
  ok("D4 · and the second case goes on saving normally", (await row(p, id2)).lender_reference === "REF-2" && (await overlay(p)) === "");
  await p.click("#modal .modal-close"); await p.waitForTimeout(600);

  console.log("E · where Save stays");
  await p.evaluate(() => window.openCase(null)); await p.waitForTimeout(900);
  ok("E1 · a new case keeps Save, Cancel and + New client…", (await vis(p, "#modal-save")) && (await vis(p, "#modal-cancel")) && (await p.evaluate(() => !!document.querySelector('#case-client-select option[value="__new__"]'))));
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);
  const legacy = await boot(browser, "?as=p4");
  await legacy.evaluate((i) => window.openCase(i), id); await legacy.waitForTimeout(1500);
  await legacy.evaluate(() => { document.querySelector("#modal .case-details").open = true; });
  await legacy.fill('#case-form input[name="rate_percent"]', "6.66"); await legacy.press('#case-form input[name="rate_percent"]', "Tab"); await legacy.waitForTimeout(700);
  ok("E2 · the harness seam keeps the Save button and writes nothing until it is pressed", (await vis(legacy, "#modal-save")) && String((await row(legacy, id)).rate_percent) !== "6.66");

  const errs = [p, legacy].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr110_autosave: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
