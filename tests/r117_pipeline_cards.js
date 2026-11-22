/* R117 — P2: a pipeline card shows two chips and "+N"; P5: a column folds to a strip.
   node tests/r117_pipeline_cards.js   (static server on :8099, admin/mock.html built by smoke.js)
   ?scope=default switches off the harness seam, so these read the app's REAL behaviour. */
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
  // R126: the owner now opens every page on Mine; these checks read the firm-wide board, so he presses All first.
  if (/as=p4/.test(qs) && /scope=default/.test(qs)) { await p.evaluate(() => document.querySelector("#brief-scope-all").click()); await p.waitForTimeout(600); }
  await p.evaluate(() => window.nav("pipeline"));
  await p.waitForFunction(() => document.querySelectorAll("#board .card").length > 5, null, { timeout: 20000 });
  await p.waitForTimeout(700);
  return p;
}
/* Per card: the chips on show, the ones behind "+N", and what the "+N" says. */
const cards = (p) => p.evaluate(() => [...document.querySelectorAll("#board .card")].map((c) => { const f = c.querySelector(".flags"), more = f.querySelector(".flags-more"), rest = f.querySelector(".flags-rest");
  const txt = (e) => e.textContent.replace(/[^\w£.,·?≈ -]/g, "").replace(/\s+/g, " ").trim(), cls = (e) => (/wait-chip/.test(e.className) ? "wait" : /\bred\b/.test(e.className) ? "red" : /\bamber\b/.test(e.className) ? "amber" : "info");
  const shown = [...f.children].filter((e) => e !== more && e !== rest && e.checkVisibility()), hidden = rest ? [...rest.children] : [];
  return { id: c.dataset.id, shown: shown.map(txt), shownKind: shown.map(cls), hidden: hidden.map(txt), hiddenKind: hidden.map(cls), hiddenVisible: hidden.some((e) => e.checkVisibility()), more: more ? more.textContent.trim() : "", title: more ? more.title : "", label: more ? more.getAttribute("aria-label") : "", h: Math.round(c.getBoundingClientRect().height) }; }));
const cols = (p) => p.evaluate(() => { const b = document.getElementById("board"); return [...b.querySelectorAll(".col")].map((c) => { const r = c.getBoundingClientRect(), btn = c.querySelector(".col-fold"), h = c.querySelector(".col-h");
  return { stage: c.dataset.stage, w: Math.round(r.width), folded: c.classList.contains("is-folded"), cards: [...c.querySelectorAll(".card")].filter((e) => e.checkVisibility()).length, all: c.querySelectorAll(".card").length, count: h.querySelector("span").textContent, head: h.checkVisibility(), btn: btn ? { exp: btn.getAttribute("aria-expanded"), label: btn.getAttribute("aria-label"), w: Math.round(btn.getBoundingClientRect().width) } : null }; }); });
(async () => {
  const browser = await chromium.launch();
  const p = await boot(browser, "?as=p4&scope=default");
  const seam = await boot(browser, "?as=p4");
  const real = await cards(p), old = await cards(seam);
  const oldById = Object.fromEntries(old.map((c) => [c.id, c]));

  console.log("A · two chips and +N");
  const busy = real.filter((c) => c.more), quiet = real.filter((c) => !c.more);
  ok("A1 · no card shows more than two chips", real.length > 5 && real.every((c) => c.shown.length <= 2), JSON.stringify(real.filter((c) => c.shown.length > 2).slice(0, 2)));
  ok("A2 · the fixture has cards with three or more chips, and each of those says +N", busy.length >= 3 && busy.every((c) => c.shown.length === 2 && c.more === "+" + c.hidden.length && c.hidden.length >= 1 && !c.hiddenVisible), `busy ${busy.length}`);
  ok("A3 · a card with one or two chips is as it was — no +N", quiet.every((c) => c.hidden.length === 0) && quiet.some((c) => c.shown.length > 0));
  const sameSet = real.every((c) => { const o = oldById[c.id]; return o && [...c.shown, ...c.hidden].sort().join("|") === [...o.shown].sort().join("|"); });
  ok("A4 · nothing is lost: shown + hidden is exactly what the card used to print", sameSet);
  const rank = { wait: 0, red: 1, amber: 2, info: 3 };
  const ordered = busy.every((c) => { const seq = [...c.shownKind, ...c.hiddenKind].map((k) => rank[k]); return seq.every((v, i) => i === 0 || seq[i - 1] <= v); });
  ok("A5 · who it is waiting on leads, then red, then amber, then the rest", ordered && busy.some((c) => c.shownKind[0] !== "info"), JSON.stringify(busy.slice(0, 2).map((c) => [c.shownKind, c.hiddenKind])));
  ok("A6 · +N names what it is holding, on hover and to a screen reader", busy.every((c) => c.hidden.every((t) => c.title.includes(t.replace(/^[^\w]+/, "").slice(0, 8))) && c.label.startsWith(c.hidden.length + " more: ")), busy[0] && busy[0].title);
  const shorter = busy.filter((c) => oldById[c.id].h > c.h).length;
  ok("A7 · those cards are shorter than before", shorter >= Math.ceil(busy.length / 2), `${shorter} of ${busy.length}`);
  const sel = `#board .card[data-id="${busy[0].id}"]`;
  await p.click(sel + " .flags-more"); await p.waitForTimeout(300);
  const opened = (await cards(p)).find((c) => c.id === busy[0].id);
  ok("A8 · pressing +N opens the rest on that card and does not open the case", opened.hiddenVisible && opened.more === "Less" && (await p.evaluate(() => document.getElementById("modal-backdrop").classList.contains("hidden"))) && (await p.evaluate((s) => document.querySelector(s + " .flags-more").getAttribute("aria-expanded"), sel)) === "true");
  await p.focus(sel + " .flags-more"); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  const closed = (await cards(p)).find((c) => c.id === busy[0].id);
  ok("A9 · and again (from the keyboard) puts them away", !closed.hiddenVisible && closed.more === "+" + closed.hidden.length);
  ok("A10 · the harness seam prints every chip and no +N", old.every((c) => !c.more && c.hidden.length === 0) && old.some((c) => c.shown.length > 2));

  console.log("B · a column folds away");
  const c0 = await cols(p);
  const withCards = c0.filter((c) => c.all > 0), target = withCards[1], other = c0.find((c) => c.stage !== target.stage);
  ok("B1 · every column heading has a fold button that says what it does", c0.length >= 6 && c0.every((c) => c.btn && c.btn.exp === "true" && /^Fold .+ away$/.test(c.btn.label)), JSON.stringify(c0[0].btn));
  await p.click(`#board .col[data-stage="${target.stage}"] .col-fold`); await p.waitForTimeout(300);
  const c1 = await cols(p), t1 = c1.find((c) => c.stage === target.stage), o1 = c1.find((c) => c.stage === other.stage);
  ok("B2 · the folded column is a narrow strip: name and count stay, cards go", t1.folded && t1.w <= 48 && t1.cards === 0 && t1.head && t1.count === target.count && t1.btn.exp === "false" && /^Open /.test(t1.btn.label), JSON.stringify(t1));
  ok("B3 · the other columns keep or gain width, never lose it", o1.w >= other.w && !o1.folded, `${other.w} → ${o1.w}`);
  const drop = await p.evaluate(([from, to]) => { const card = document.querySelector(`#board .col[data-stage="${from}"] .card`); if (!card) return "no card"; const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true })); const col = document.querySelector(`#board .col[data-stage="${to}"]`);
    col.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true })); const lit = col.classList.contains("dragover");
    col.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); card.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true })); return lit ? "lit" : "dark"; }, [withCards[0].stage, target.stage]);
  await p.waitForTimeout(1500);
  const asked = await p.evaluate(() => { const o = document.getElementById("overlay-modal"); return o && o.checkVisibility() ? o.textContent.replace(/\s+/g, " ").slice(0, 80) : ""; });
  ok("B4 · a card dropped on a folded column is still taken (the usual move prompt appears)", drop === "lit" && asked.length > 0, drop + " / " + asked);
  await p.keyboard.press("Escape"); await p.waitForTimeout(400);
  await p.reload(); await p.waitForFunction(() => typeof window.nav === "function" && document.getElementById("app-view").checkVisibility(), null, { timeout: 20000 }); await p.waitForTimeout(1500);
  await p.evaluate(() => window.nav("pipeline")); await p.waitForFunction(() => document.querySelectorAll("#board .col").length > 5); await p.waitForTimeout(700);
  ok("B5 · the fold is remembered after a reload", (await cols(p)).find((c) => c.stage === target.stage).folded);
  const adv = await boot(browser, "?as=p2&scope=default");
  ok("B6 · and is per person: another user's board is all open", (await cols(adv)).every((c) => !c.folded));
  await p.click(`#board .col[data-stage="${target.stage}"] .col-fold`); await p.waitForTimeout(300);
  const c2 = await cols(p);
  ok("B7 · pressing it again opens the column exactly as it was", JSON.stringify(c2.map((c) => [c.stage, c.w, c.folded, c.cards])) === JSON.stringify(c0.map((c) => [c.stage, c.w, c.folded, c.cards])) && (await p.evaluate(() => document.getElementById("board").style.gridTemplateColumns === "" && localStorage.getItem("nx_board_fold_v1:" + Object.keys(localStorage).find((k) => k.startsWith("nx_board_fold_v1:")).split(":")[1]) === "[]")));
  ok("B8 · the harness seam has no fold button", (await cols(seam)).every((c) => !c.btn && !c.folded));
  const phone = await boot(browser, "?as=p4&scope=default", { width: 390, height: 844 });
  const pc = await cols(phone);
  if (pc.length && pc[0].head) { await phone.click(`#board .col[data-stage="${pc.find((c) => c.all > 0).stage}"] .col-fold`); await phone.waitForTimeout(300);
    ok("B9 · it folds on a phone too, and the page is no wider than the screen", (await cols(phone)).some((c) => c.folded && c.w <= 48) && (await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)));
  } else ok("B9 · on a phone the board is not shown as columns, so there is nothing to fold", pc.every((c) => !c.head));

  const errs = [p, seam, adv, phone].flatMap((x) => x.__errs);
  ok("E1 · no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  console.log(`\nr117_pipeline_cards: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
