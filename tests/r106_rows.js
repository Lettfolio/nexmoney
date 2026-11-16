/* R106 — the one-button row on Protection and Clients (kit default) and the one-line Vault entry (O9).
   node tests/r106_rows.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL layout. */
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
  await p.waitForTimeout(500);
  return p;
}
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");

  console.log("A · Protection");
  await p.click('[data-page="protection"]'); await p.waitForTimeout(1800);
  const prot = await p.evaluate(() => [...document.querySelectorAll(".kit-row.prot-row")].filter((r) => r.checkVisibility()).map((r) => {
    const acts = r.querySelector(".row-acts") || r; const m = acts.querySelector("details.row-one");
    return { shown: [...acts.querySelectorAll("button")].filter((b) => !b.closest(".row-more-body") && b.checkVisibility()).map((b) => b.textContent.trim()),
      handle: m ? m.querySelector("summary").textContent.trim() : "", inMenu: m ? [...m.querySelectorAll(".row-more-body > *")].map((b) => b.textContent.trim()) : [] };
  }));
  ok("A0 · fixture · Protection has rows", prot.length > 0, String(prot.length));
  ok("A1 · every row shows Log call and nothing else beside it", prot.every((r) => r.shown.length === 1 && /Log call/.test(r.shown[0])), JSON.stringify(prot.map((r) => r.shown)));
  ok("A2 · the rest sits behind ⋯ — Task and each case's Open among it", prot.every((r) => r.handle === "⋯" && r.inMenu.includes("Task") && r.inMenu.some((l) => /^Open · /.test(l))), JSON.stringify(prot[0]));
  await p.click(".kit-row.prot-row details.row-one > summary"); await p.waitForTimeout(150);
  await p.click('.kit-row.prot-row details.row-one[open] .row-more-body button[data-act="openCase"]'); await p.waitForTimeout(900);
  ok("A3 · Open inside the menu opens the case", await p.evaluate(() => { const m = document.getElementById("modal"); return !!m && m.checkVisibility(); }));
  await p.keyboard.press("Escape"); await p.waitForTimeout(400);

  console.log("B · Clients");
  await p.click('[data-page="clients"]'); await p.waitForTimeout(1800);
  const cli = await p.evaluate(() => [...document.querySelectorAll("#page-clients .kit-row")].filter((r) => r.checkVisibility()).map((r) => [...r.querySelectorAll("button")].filter((b) => !b.closest(".row-main") && !b.closest(".row-more-body") && b.checkVisibility()).length));
  ok("B1 · no client row shows more than one button beside its text", cli.length > 5 && cli.every((n) => n <= 1), JSON.stringify(cli.slice(0, 8)));

  console.log("C · Vault");
  await p.click('[data-page="vault"]'); await p.waitForTimeout(1500);
  const vault = await p.evaluate(() => [...document.querySelectorAll("#vault-list .vault-card")].map((c) => ({
    row: c.classList.contains("vault-row"),
    quick: [...c.querySelectorAll(".vault-card-actions > .vault-quick")].map((b) => b.textContent.trim()),
    headBtns: [...c.querySelectorAll(".vault-card-actions > button")].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()),
    menu: [...c.querySelectorAll(".vault-more-menu > button")].map((b) => b.textContent.trim()),
    foldOpen: (c.querySelector("details.vault-fold") || {}).open, fields: c.querySelectorAll(".vault-fold .vault-field").length,
    fieldVisible: [...c.querySelectorAll(".vault-field")].some((f) => f.checkVisibility()),
    secrets: [...c.querySelectorAll(".vault-field.is-secret .vf-value")].map((v) => v.getAttribute("data-val")),
    passLabel: (c.querySelector('.vault-quick:nth-of-type(2), .vault-quick') || {}).textContent || "",
    headText: c.querySelector(".vault-card-head").innerText,
  })));
  ok("C0 · fixture · the Vault has entries", vault.length > 5, String(vault.length));
  ok("C1 · every entry is the one-line row", vault.every((v) => v.row));
  ok("C2 · the only buttons on show are Copy username and Copy password", vault.every((v) => v.headBtns.every((b) => b === "Copy username" || b === "Copy password")) && vault.some((v) => v.headBtns.length === 2), JSON.stringify(vault.map((v) => v.headBtns).slice(0, 3)));
  ok("C3 · Edit and Delete are in the ⋯ menu (owner)", vault.every((v) => v.menu.join("|") === "Edit|Delete"), JSON.stringify(vault[0].menu));
  ok("C4 · fields start folded away under Details, and are all still there", vault.every((v) => v.foldOpen === false && !v.fieldVisible && v.fields > 0), JSON.stringify(vault.map((v) => [v.foldOpen, v.fields]).slice(0, 3)));
  ok("C5 · no secret value is printed on the collapsed line", vault.every((v) => v.secrets.every((s) => !s || !v.headText.includes(s))));
  // Copy password copies the secret without revealing it.
  await p.evaluate(() => { window.__copied = []; const o = navigator.clipboard && navigator.clipboard.writeText; try { navigator.clipboard.writeText = (t) => { window.__copied.push(t); return Promise.resolve(); }; } catch (e) { window.__noStub = true; } });
  const want = await p.evaluate(() => { const c = [...document.querySelectorAll("#vault-list .vault-card")].find((x) => x.querySelectorAll(".vault-quick").length === 2); c.setAttribute("data-t106", "1"); return c.querySelector(".vault-field.is-secret .vf-value").getAttribute("data-val"); });
  await p.click('[data-t106] .vault-quick:has-text("Copy password")'); await p.waitForTimeout(300);
  const copied = await p.evaluate(() => ({ list: window.__copied, noStub: !!window.__noStub, shown: document.querySelector("[data-t106] .vault-field.is-secret .vf-value").getAttribute("data-shown"), fold: document.querySelector("[data-t106] details.vault-fold").open }));
  ok("C6 · Copy password puts the password on the clipboard", copied.noStub || copied.list.includes(want), JSON.stringify({ n: copied.list.length, noStub: copied.noStub }));
  ok("C7 · …without revealing it or opening Details", copied.shown === "0" && copied.fold === false, JSON.stringify(copied.shown + "/" + copied.fold));
  await p.click("[data-t106] details.vault-fold > summary"); await p.waitForTimeout(150);
  ok("C8 · Details opens the fields, each with its own copy", await p.evaluate(() => { const c = document.querySelector("[data-t106]"); return c.querySelector(".vault-field").checkVisibility() && c.querySelectorAll(".vault-field .vf-copy").length > 0; }));
  await p.click("[data-t106] details.vault-more > summary"); await p.waitForTimeout(150);
  await p.click("[data-t106] details.vault-more[open] .vault-edit"); await p.waitForTimeout(600);
  ok("C9 · Edit inside the menu opens the editor, and the menu folds up", await p.evaluate(() => !!document.querySelector(".vault-editor") && document.querySelector(".vault-editor").checkVisibility() && !document.querySelector("#vault-list details.vault-more[open]")));

  console.log("D · adviser and the seam");
  const adv = await boot(browser, "?as=p2&scope=default");
  await adv.click('[data-page="vault"]'); await adv.waitForTimeout(1500);
  ok("D1 · an adviser has no Delete: Edit stands on the row instead of a one-item menu", await adv.evaluate(() => { const c = document.querySelector("#vault-list .vault-card"); return !!c && !c.querySelector(".vault-del") && !c.querySelector("details.vault-more") && !!c.querySelector(".vault-card-actions > .vault-edit"); }));
  const legacy = await boot(browser, "?as=p4");
  await legacy.click('[data-page="vault"]'); await legacy.waitForTimeout(1500);
  ok("D2 · the harness seam keeps the open card the older suites read", await legacy.evaluate(() => { const c = document.querySelector("#vault-list .vault-card"); return !!c && !c.classList.contains("vault-row") && !c.querySelector(".vault-fold") && c.querySelector(".vault-field").checkVisibility(); }));

  const errs = [p, adv, legacy].flatMap((x) => x.__errs);
  ok("Z · no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
  console.log(`\nr106_rows: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
