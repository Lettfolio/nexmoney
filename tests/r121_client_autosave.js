/* R121 — save-as-you-go on an existing client's fields (the case got it in R110).
   node tests/r121_client_autosave.js   (static server on :8099, admin/mock.html built by smoke.js)
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
const open = async (p, id) => { await p.evaluate((i) => window.openClient(i), id); await p.waitForTimeout(1600); if (await p.$('.rec-tabs button[data-tab="details"]')) { await p.click('.rec-tabs button[data-tab="details"]'); await p.waitForTimeout(400); } else await p.evaluate(() => { const d = document.querySelector("details.client-details"); if (d) d.open = true; }); };
const dbRow = (p, id) => p.evaluate(async (i) => (await window.__mockDb.from("clients").select("*").eq("id", i).single()).data, id);
const F = (n) => `#client-form [name="${n}"]`;
const leave = async (p) => { await p.keyboard.press("Tab"); await p.waitForTimeout(700); };
const tick = (p, n) => p.evaluate((n) => { const l = document.querySelector(`#client-form [name="${n}"]`).closest("label"), t = l && l.querySelector(".saved-msg"); return t ? t.textContent : ""; }, n);
const toastText = (p) => p.evaluate(() => [...document.querySelectorAll(".toast, #toast")].filter((t) => t.checkVisibility()).map((t) => t.textContent).join(" | "));
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  const ids = await p.evaluate(async () => { const { data } = await window.__mockDb.from("clients").select("id,first_name,last_name,email,phone,updated_at").limit(6); return data; });
  const A = ids[0], B = ids[1];
  /* Count the writes: one field changed must be one update carrying that column only. */
  await p.evaluate(() => { window.__writes = []; const from = window.__mockDb.from.bind(window.__mockDb); window.__mockDb.from = (t) => { const q = from(t); if (t === "clients") { const up = q.update.bind(q); q.update = (row) => { window.__writes.push(Object.keys(row)); return up(row); }; } return q; }; });

  console.log("A · a field saves as it is left");
  await open(p, A.id);
  const bar = await p.evaluate(() => { const v = (s) => { const e = document.querySelector(s); return !!e && e.checkVisibility(); }; return { save: v("#modal-save"), cancel: v("#modal-cancel"), form: v('#client-form [name="first_name"]'), auto: document.getElementById("client-form").dataset.autosave }; });
  ok("A1 · an existing client has no Save or Cancel button", bar.form && !bar.save && !bar.cancel && bar.auto === "1", JSON.stringify(bar));
  await p.fill(F("address"), "12 Harbour Row, Poole"); await leave(p);
  ok("A2 · leaving the field writes it", (await dbRow(p, A.id)).address === "12 Harbour Row, Poole");
  ok("A3 · and says so beside the field", (await tick(p, "address")).includes("Saved"));
  ok("A4 · only that column was sent, once", await p.evaluate(() => window.__writes.length === 1 && window.__writes[0].join() === "address"), JSON.stringify(await p.evaluate(() => window.__writes)));
  await p.selectOption(F("marketing_opt_out"), "1"); await p.waitForTimeout(700);
  ok("A5 · a yes/no choice is stored as a real true", (await dbRow(p, A.id)).marketing_opt_out === true);
  await p.fill(F("date_of_birth"), "1980-04-12"); await leave(p);
  ok("A6 · a date saves as a date", (await dbRow(p, A.id)).date_of_birth === "1980-04-12");
  await p.focus(F("address")); await leave(p);
  ok("A7 · tabbing through without changing anything writes nothing", await p.evaluate(() => window.__writes.length === 3), String(await p.evaluate(() => window.__writes.length)));
  await p.fill(F("first_name"), "Georgina"); await leave(p);
  const head = await p.evaluate(() => document.querySelector("#modal > h3").textContent);
  ok("A8 · a new name is saved and the record's heading follows it", (await dbRow(p, A.id)).first_name === "Georgina" && head.startsWith("Georgina"), head);

  console.log("B · what is refused");
  const before = await dbRow(p, A.id);
  await p.fill(F("last_name"), ""); await leave(p);
  ok("B1 · a blank last name is put back, said, and not written", (await p.inputValue(F("last_name"))) === before.last_name && (await dbRow(p, A.id)).last_name === before.last_name && /last name is required/i.test(await toastText(p)), await toastText(p));
  await p.fill(F("email"), "not-an-email"); await leave(p);
  const em = await p.evaluate(() => { const f = document.querySelector('#client-form [name="email"]'); return { v: f.value, bad: f.classList.contains("field-error") || f.getAttribute("aria-invalid") === "true" || !!f.closest("label").querySelector(".field-error-msg, .field-msg, .err"), txt: f.closest("label").textContent }; });
  ok("B2 · a malformed email stays in the box, is marked there, and is not written", em.v === "not-an-email" && (em.bad || /valid email/i.test(em.txt)) && (await dbRow(p, A.id)).email === before.email, JSON.stringify(em));
  await p.fill(F("email"), "georgina@example.co.uk"); await leave(p);
  const em2 = await p.evaluate(() => /valid email/i.test(document.querySelector('#client-form [name="email"]').closest("label").textContent));
  ok("B3 · correcting it saves and clears the mark", (await dbRow(p, A.id)).email === "georgina@example.co.uk" && !em2);
  await p.fill(F("phone"), "12345"); await leave(p);
  ok("B4 · a malformed phone is not written either", (await dbRow(p, A.id)).phone === before.phone);
  await p.fill(F("phone"), before.phone || "07700 900123"); await leave(p);

  console.log("C · leaving, and other people");
  await p.fill(F("notes"), "Prefers calls after 5pm"); await p.keyboard.press("Escape"); await p.waitForTimeout(1200);
  const guard = await p.evaluate(() => { const o = document.getElementById("overlay-modal"); return o && o.checkVisibility() ? o.textContent : ""; });
  ok("C1 · Escape straight after typing saves it and does not ask about unsaved changes", guard === "" && (await dbRow(p, A.id)).notes === "Prefers calls after 5pm" && (await p.evaluate(() => document.getElementById("modal-backdrop").classList.contains("hidden"))), guard.slice(0, 50));
  await open(p, A.id);
  ok("C2 · reopened, the record shows what was saved", (await p.inputValue(F("notes"))) === "Prefers calls after 5pm" && (await p.inputValue(F("first_name"))) === "Georgina");
  await p.evaluate(async (i) => { await window.__mockDb.from("clients").update({ address: "Changed by a colleague", updated_at: new Date(Date.now() + 5000).toISOString() }).eq("id", i); }, A.id);
  await p.fill(F("notes"), "Second note"); await leave(p);
  const c3 = await dbRow(p, A.id);
  ok("C3 · a colleague's change to another field is kept, and ours still saves", c3.address === "Changed by a colleague" && c3.notes === "Second note", JSON.stringify([c3.address, c3.notes]));
  await p.evaluate(async (i) => { await window.__mockDb.from("clients").update({ notes: "Colleague's note", updated_at: new Date(Date.now() + 9000).toISOString() }).eq("id", i); }, A.id);
  await p.fill(F("notes"), "My note"); await leave(p);
  const asked = await p.evaluate(() => { const o = document.getElementById("overlay-modal"); return o && o.checkVisibility() ? o.textContent.replace(/\s+/g, " ") : ""; });
  ok("C4 · when a colleague changed the same field, it asks which to keep", /colleague changed/i.test(asked) && /Keep mine/.test(asked), asked.slice(0, 90));
  await p.evaluate(() => { const b = [...document.querySelectorAll("#overlay-modal button")].find((x) => !/Keep mine/.test(x.textContent) && x.textContent.trim()); b.click(); }); await p.waitForTimeout(700);
  ok("C5 · choosing theirs puts their text in the box and leaves the database alone", (await p.inputValue(F("notes"))) === "Colleague's note" && (await dbRow(p, A.id)).notes === "Colleague's note");
  await p.click("#modal .modal-close"); await p.waitForTimeout(600);
  await open(p, B.id);
  await p.fill(F("address"), "B's new address"); await leave(p);
  ok("C6 · the next client opened saves against its own record", (await dbRow(p, B.id)).address === "B's new address" && (await dbRow(p, A.id)).address === "Changed by a colleague");
  await p.click("#modal .modal-close"); await p.waitForTimeout(500);

  console.log("D · where the Save button stays");
  await p.evaluate(() => window.openClient()); await p.waitForTimeout(1000);
  const nw = await p.evaluate(() => ({ save: document.getElementById("modal-save").checkVisibility(), auto: document.getElementById("client-form").dataset.autosave || "" }));
  ok("D1 · a new client still has Save (nothing exists to write to yet)", nw.save && nw.auto === "", JSON.stringify(nw));
  await p.keyboard.press("Escape"); await p.waitForTimeout(400);
  const seam = await boot(browser, "?as=p4");
  await open(seam, B.id);
  const sm = await seam.evaluate(() => ({ save: document.getElementById("modal-save").checkVisibility(), auto: document.getElementById("client-form").dataset.autosave || "" }));
  await seam.fill(F("address"), "Seam address"); await seam.keyboard.press("Tab"); await seam.waitForTimeout(600);
  const notYet = (await dbRow(seam, B.id)).address !== "Seam address";
  await seam.click("#modal-save"); await seam.waitForTimeout(1500);
  ok("D2 · the harness seam keeps Save: nothing is written until it is pressed", sm.save && sm.auto === "" && notYet && (await dbRow(seam, B.id)).address === "Seam address");

  const errs = [p, seam].flatMap((x) => x.__errs);
  ok("E1 · no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  console.log(`\nr121_client_autosave: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
