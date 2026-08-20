#!/usr/bin/env node
/* =============================================================================
   tests/r8_touch.js — acceptance tests for ROUND 8, the CLIENT TOUCH PROGRAMME.

     R8-1  CLIENT SEGMENTS — eight chips over the Clients page (All · No live
           case · Rate ends Y/Y+1/Y+2 · No protection outcome · Missing DOB ·
           Not contacted 6+ months), each with a live count, each combining with
           the existing text search, and the last-contact definition stated on
           screen in the words the code actually uses.
     R8-2  BULK ACTIONS on the filtered set — select-all + per-row checkboxes,
           "Add task…" (one task per selected client, filed on that client's one
           case or one live case, NOTHING guessed) and "Export CSV" (money
           column governed by the same csvShowsFee() rule as the pipeline
           export). No bulk email verb — deliberately.
     R8-3  DOB CAPTURE — the DOB on the row in the segment that exists because
           it is missing, a deep link into the field, and a settings status line
           whose arithmetic is real.
     R8-4  ANNUAL REVIEW — the annual_review_enabled switch, the task it makes,
           and the task rendering in My Day like any other.
     R8-5  COPY AUDIT — the drip and the annual review described honestly on the
           Emails page and in Settings.

   EVERY segment's membership is recomputed here from the fixture tables
   directly (clients/cases/case_notes/email_queue/appointments/case_tasks), in
   an implementation deliberately written separately from app.js's, and the
   rendered rows are compared against THAT — never against app.js's own idea of
   who is in a segment. Same for the DOB status line and the drip order.

   Run:  node /root/nx/tests/r8_touch.js   (expects a static server on 8099;
                                            starts one itself if absent)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const SETTLE = 1500;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
    r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}

async function newPage(browser, persona, viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  page.__dialogs = [];
  page.__dialogAnswer = "accept";
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    if (page.__dialogAnswer === "dismiss") await d.dismiss();
    else await d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const toastText = (page) => page.$eval("#toast", (e) => e.textContent).catch(() => "");
const gotoClients = async (page) => { await page.evaluate(() => window.nav("clients")); await page.waitForTimeout(700); };

/* ---------------------------------------------------------------------------
   GROUND TRUTH — every segment recomputed from the fixture tables, here, in a
   separate implementation. If app.js and this file ever disagree about who is
   "not contacted in 6+ months", the run goes red and one of the two is wrong.
   ------------------------------------------------------------------------- */
const groundTruth = (page) => page.evaluate(async () => {
  const db = window.__mockDb;
  const [cl, cs, nt, eqR, ap, tk] = await Promise.all([
    db.from("clients").select("id,first_name,last_name,email,phone,date_of_birth"),
    db.from("cases").select("id,client_id,stage,rate_end_date,protection_status,broker_fee,assigned_to,completed_at,review_requested_at"),
    db.from("case_notes").select("case_id,created_at"),
    db.from("email_queue").select("client_id,case_id,status,sent_at"),
    db.from("appointments").select("client_id,case_id,starts_at"),
    db.from("case_tasks").select("id,case_id,title,due_date,done_at,assigned_to,created_at"),
  ]);
  const clients = cl.data || [], cases = cs.data || [];
  const ownerOf = {};                       // case id → client id
  cases.forEach((c) => { ownerOf[c.id] = c.client_id; });
  const casesOf = {};
  clients.forEach((c) => { casesOf[c.id] = []; });
  cases.forEach((c) => { if (casesOf[c.client_id]) casesOf[c.client_id].push(c); });
  const isLive = (s) => s !== "completed" && s !== "not_proceeding";

  /* last contact, built from the four sources the screen names */
  const last = {};
  const bump = (id, at) => { if (!id || !at) return; const s = String(at); if (!last[id] || s > last[id]) last[id] = s; };
  (nt.data || []).forEach((n) => bump(ownerOf[n.case_id], n.created_at));
  (eqR.data || []).forEach((e) => { if (e.status === "sent" && e.sent_at) bump(e.client_id || ownerOf[e.case_id], e.sent_at); });
  const nowMs = Date.now();
  (ap.data || []).forEach((a) => { if (a.starts_at && new Date(a.starts_at).getTime() <= nowMs) bump(a.client_id || ownerOf[a.case_id], a.starts_at); });
  (tk.data || []).forEach((t) => { if (t.done_at) bump(ownerOf[t.case_id], t.done_at); });

  const cut = new Date(); cut.setMonth(cut.getMonth() - 6);
  const cutMs = cut.getTime();
  const yr = new Date().getFullYear();
  const inYear = (c, y) => (casesOf[c.id] || []).some((x) => x.rate_end_date && String(x.rate_end_date).slice(0, 4) === String(y));
  const member = {
    all: () => true,
    no_live_case: (c) => !(casesOf[c.id] || []).some((x) => isLive(x.stage)),
    no_protection: (c) => (casesOf[c.id] || []).some((x) => isLive(x.stage) && ["not_discussed", "discussed"].includes(x.protection_status || "not_discussed")),
    no_dob: (c) => !c.date_of_birth,
    cold: (c) => !last[c.id] || new Date(last[c.id]).getTime() < cutMs,
  };
  member["rate_" + yr] = (c) => inYear(c, yr);
  member["rate_" + (yr + 1)] = (c) => inYear(c, yr + 1);
  member["rate_" + (yr + 2)] = (c) => inYear(c, yr + 2);

  const segIds = {};
  Object.keys(member).forEach((k) => { segIds[k] = clients.filter(member[k]).map((c) => c.id); });

  return {
    years: [yr, yr + 1, yr + 2],
    clients: clients.map((c) => ({ id: c.id, first: c.first_name, last: c.last_name, email: c.email, phone: c.phone, dob: c.date_of_birth })),
    cases: cases.map((c) => ({ id: c.id, client_id: c.client_id, stage: c.stage, assigned_to: c.assigned_to, broker_fee: c.broker_fee, completed_at: c.completed_at, review_requested_at: c.review_requested_at, rate_end_date: c.rate_end_date, protection_status: c.protection_status })),
    tasks: tk.data || [],
    segIds, lastContact: last, cutoff: cut.toISOString(),
    dobWith: clients.filter((c) => !!c.date_of_birth).length,
    dobTotal: clients.length,
  };
});

const renderedIds = (page) => page.$$eval("#client-list .client-row", (rs) => rs.map((r) => r.getAttribute("data-client")));
const chipCounts = (page) => page.$$eval("#client-segment .seg-btn", (bs) => bs.map((b) => ({
  seg: b.dataset.seg,
  label: b.textContent.replace(/\s+/g, " ").trim(),
  n: Number((b.querySelector(".seg-count") || {}).textContent || "-1"),
})));
const clickSeg = async (page, seg) => {
  await page.$$eval("#client-segment .seg-btn", (bs, s) => { const b = bs.find((x) => x.dataset.seg === s); if (b) b.click(); }, seg);
  await page.waitForTimeout(450);
};
const sorted = (a) => a.slice().sort();

/* Capture what a click on an <a download> would have written, without letting
   chromium try to save it. */
async function armCsvCapture(page) {
  await page.evaluate(() => {
    window.__csvBlob = null;
    if (!window.__csvArmed) {
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__csvBlob = b; try { return origCreate(b); } catch (e) { return "blob:captured"; } };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute("download")) { window.__csvName = this.getAttribute("download"); return; } return origClick.apply(this, arguments); };
      window.__csvArmed = true;
    }
  });
}
const readCsv = (page) => page.evaluate(async () => (window.__csvBlob ? await window.__csvBlob.text() : null));
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {

    /* ===================================================================
       1 · SEGMENTS — the chips, the counts, the membership, the definition
       =================================================================== */
    {
      console.log("\n— R8-1 · client segments (p1 Kim, admin)");
      const page = await newPage(browser, "p1");
      await gotoClients(page);
      const gt = await groundTruth(page);

      const chips = await chipCounts(page);
      const expectSegs = ["all", "no_live_case", "rate_" + gt.years[0], "rate_" + gt.years[1], "rate_" + gt.years[2], "no_protection", "no_dob", "cold"];
      eq("R8-1 · the eight segments are present, in order", chips.map((c) => c.seg), expectSegs);
      ok("R8-1 · the rate-end chips name real calendar years, not a hardcoded 2026",
        chips[2].label.startsWith(`Rate ends ${gt.years[0]}`) && chips[4].label.startsWith(`Rate ends ${gt.years[2]}`),
        JSON.stringify(chips.map((c) => c.label)));
      ok("R8-1 · the cold segment states its own window in the label", /Not contacted 6\+ months/.test(chips[7].label), chips[7].label);

      /* counts */
      expectSegs.forEach((s) => {
        const chip = chips.find((c) => c.seg === s);
        eq(`R8-1 · count matches the fixtures · ${s}`, chip.n, gt.segIds[s].length);
      });
      ok("R8-1 · every segment except All is a genuine subset of the book",
        expectSegs.slice(1).every((s) => gt.segIds[s].length < gt.segIds.all.length), JSON.stringify(gt.segIds.all.length));

      /* membership, segment by segment */
      for (const s of expectSegs) {
        await clickSeg(page, s);
        const ids = await renderedIds(page);
        eq(`R8-1 · rendered rows ARE the segment · ${s}`, sorted(ids), sorted(gt.segIds[s]));
      }

      /* the definition line — the whole point of stating it is that it moves */
      await clickSeg(page, "cold");
      const coldDef = await page.$eval("#client-seg-def", (e) => e.textContent.trim());
      ok("R8-1 · the last-contact definition names all four sources",
        /note/i.test(coldDef) && /email we SENT/i.test(coldDef) && /appointment/i.test(coldDef) && /task completed/i.test(coldDef), coldDef);
      ok("R8-1 · …and says what happens to a client with no contact at all", /no contact of any kind/i.test(coldDef), coldDef);
      ok("R8-1 · …and prints the actual cut-off date", coldDef.includes(String(new Date(gt.cutoff).getFullYear())), coldDef);
      await clickSeg(page, "no_live_case");
      const liveDef = await page.$eval("#client-seg-def", (e) => e.textContent.trim());
      ok("R8-1 · the definition changes with the segment", liveDef !== coldDef && /Completed or Not proceeding/i.test(liveDef), liveDef);
      await clickSeg(page, "no_protection");
      const protDef = await page.$eval("#client-seg-def", (e) => e.textContent.trim());
      ok("R8-1 · the protection definition admits that a blank status counts as not discussed", /blank status counts as not discussed/i.test(protDef), protDef);

      /* a spot-check the definition can be READ off one client, so the whole
         segment is not just self-consistent with a shared bug */
      const coldOne = gt.segIds.cold[0];
      if (coldOne) {
        const lc = gt.lastContact[coldOne];
        ok("R8-1 · a cold client really is cold in the raw fixtures",
          !lc || new Date(lc).getTime() < new Date(gt.cutoff).getTime(), `${coldOne} last=${lc} cutoff=${gt.cutoff}`);
      }
      const warmOne = gt.clients.map((c) => c.id).find((id) => !gt.segIds.cold.includes(id));
      if (warmOne) {
        ok("R8-1 · …and a client left OUT of it really has been contacted since the cut-off",
          !!gt.lastContact[warmOne] && new Date(gt.lastContact[warmOne]).getTime() >= new Date(gt.cutoff).getTime(),
          `${warmOne} last=${gt.lastContact[warmOne]}`);
      }
      ok("no console errors (segments)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       2 · SEARCH × SEGMENT — the two filters compose, and the counts follow
       =================================================================== */
    {
      console.log("\n— R8-1 · text search combined with a segment (p1 Kim)");
      const page = await newPage(browser, "p1");
      await gotoClients(page);
      const gt = await groundTruth(page);

      /* a term that matches several clients but not all of them */
      const term = "ar";
      const norm = (p) => String(p || "").replace(/[\s()\-.]/g, "").replace(/^\+44/, "0").replace(/^0044/, "0");
      const matches = gt.clients.filter((c) => ((c.first || "") + " " + (c.last || "") + " " + (c.email || "")).toLowerCase().includes(term)).map((c) => c.id);
      ok("fixture · the search term is a real partial match", matches.length > 1 && matches.length < gt.clients.length, `${matches.length}/${gt.clients.length}`);

      await page.fill("#client-search", term);
      await page.waitForTimeout(450);
      const searchedIds = await renderedIds(page);
      eq("R8-1 · search alone still works exactly as before", sorted(searchedIds), sorted(matches));

      const chips = await chipCounts(page);
      chips.forEach((chip) => {
        const want = gt.segIds[chip.seg].filter((id) => matches.includes(id)).length;
        eq(`R8-1 · chip count re-reads against the search · ${chip.seg}`, chip.n, want);
      });

      /* and pressing one of them intersects rather than replacing */
      const target = chips.slice(1).find((c) => c.n > 0) || chips[1];
      await clickSeg(page, target.seg);
      const bothIds = await renderedIds(page);
      eq(`R8-1 · search ∩ segment (${target.seg})`, sorted(bothIds), sorted(gt.segIds[target.seg].filter((id) => matches.includes(id))));

      /* an empty intersection says which two filters produced it */
      await page.fill("#client-search", "zzzznobody");
      await page.waitForTimeout(450);
      const emptyMsg = await page.$eval("#client-list .empty", (e) => e.textContent.trim()).catch(() => "");
      ok("R8-1 · an empty intersection blames both filters, not just the search", /in this segment/i.test(emptyMsg), emptyMsg);
      ok("no console errors (search × segment)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       3 · BULK "ADD TASK…" — writes what it claims, only for the selected
       =================================================================== */
    {
      console.log("\n— R8-2 · bulk Add task… (p1 Kim, admin)");
      const page = await newPage(browser, "p1");
      await gotoClients(page);
      const gt = await groundTruth(page);
      const casesOf = (id) => gt.cases.filter((c) => c.client_id === id);
      const isLive = (s) => s !== "completed" && s !== "not_proceeding";
      const classify = (id) => {
        const cs = casesOf(id);
        if (!cs.length) return { why: "no_case" };
        if (cs.length === 1) return { caseId: cs[0].id, assignedTo: cs[0].assigned_to };
        const live = cs.filter((c) => isLive(c.stage));
        if (live.length === 1) return { caseId: live[0].id, assignedTo: live[0].assigned_to };
        return { why: live.length > 1 ? "many_live" : "no_live" };
      };
      const takeN = (pred, n) => gt.clients.map((c) => c.id).filter((id) => pred(classify(id))).slice(0, n);
      const single = takeN((t) => !t.why && casesOf.length !== 0 && true, 4).filter((id) => !classify(id).why);
      const manyLive = takeN((t) => t.why === "many_live", 2);
      const noCase = takeN((t) => t.why === "no_case", 2);
      const noLive = takeN((t) => t.why === "no_live", 2);
      const picked = single.slice(0, 4).concat(manyLive, noCase, noLive);
      ok("fixture · there is at least one client the verb CAN file a task for", single.length > 0, JSON.stringify(single));
      ok("fixture · …and at least one it must refuse to guess for", manyLive.length + noCase.length + noLive.length > 0,
        JSON.stringify({ manyLive, noCase, noLive }));

      /* select them */
      for (const id of picked) {
        await page.$$eval("#client-list .client-cb", (cbs, cid) => { const cb = cbs.find((x) => x.dataset.id === cid); if (cb) cb.click(); }, id);
      }
      await page.waitForTimeout(400);
      const barN = await page.$eval("#client-bulk-n", (e) => Number(e.textContent)).catch(() => -1);
      eq("R8-2 · the bulk bar counts exactly what is ticked", barN, picked.length);
      ok("R8-2 · there is no bulk EMAIL verb this round", (await page.$("#client-bulk-email")) === null);
      const absent = await page.$eval("#client-bulk-note", (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
      ok("R8-2 · …and the absence is explained where the verb would have been",
        /No bulk email yet/.test(absent) && /template decision/.test(absent), absent);

      const before = await page.evaluate(async () => (await window.__mockDb.from("case_tasks").select("id")).data.length);
      await page.click("#client-bulk-task");
      await page.waitForTimeout(400);
      /* R36-C — a client with several LIVE cases now surfaces a case-resolution overlay BEFORE the
         confirm dialog this block goes on to read. Resolve it first: this block's whole point is
         that a many_live client is REFUSED (skipped, not guessed at), and R36-C's own picker offers
         exactly that as one of its two paths ("choose a case" or "Skip this one") — "__skip" for
         every many_live row here preserves that intent exactly, so every assertion below (the
         skip-count, the skipped-client naming, "several live cases", nothing landing on a
         many_live client's cases) still holds against the SAME clients for the SAME reason. */
      const pickerUp = await page.$("#btaskc-pick-rows");
      if (pickerUp) {
        await page.$$eval("#btaskc-pick-rows .bulk-task-case-pick", (sels) => sels.forEach((s) => {
          s.value = "__skip"; s.dispatchEvent(new Event("change", { bubbles: true }));
        }));
        await page.waitForTimeout(150);
        await page.click("#btaskc-pick-ok");
        await page.waitForTimeout(400);
      }
      const dlg = await page.$eval("#overlay-modal", (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
      const expTargets = picked.filter((id) => !classify(id).why);
      const expSkipped = picked.filter((id) => !!classify(id).why);
      ok("R8-2 · the dialog says how many tasks it will write BEFORE writing them",
        new RegExp(`Add a task to ${expTargets.length} client`).test(dlg), dlg.slice(0, 260));
      if (expSkipped.length) {
        ok("R8-2 · …and names the ones it will skip, and how many",
          new RegExp(`${expSkipped.length} of the ${picked.length} selected will be skipped`).test(dlg), dlg.slice(0, 400));
        if (manyLive.length) ok("R8-2 · a client with several live cases is refused, not guessed at", /several live cases/i.test(dlg), dlg.slice(0, 400));
        if (noCase.length) ok("R8-2 · a client with no case at all is refused, with the reason", /no case at all to attach a task to/i.test(dlg), dlg.slice(0, 400));
      }

      const TITLE = "R8 touch — book the annual review call";
      await page.fill("#btaskc-title", TITLE);
      await page.$eval(".btaskc-chip[data-days='7']", (b) => b.click());
      const due = await page.$eval("#btaskc-due", (e) => e.value);
      await page.click("#btaskc-ok");
      await page.waitForTimeout(700);

      const made = await page.evaluate(async (t) => {
        const { data } = await window.__mockDb.from("case_tasks").select("id,case_id,title,due_date,assigned_to");
        return { all: data.length, mine: data.filter((x) => x.title === t) };
      }, TITLE);
      eq("R8-2 · exactly one task per fileable client was written", made.mine.length, expTargets.length);
      eq("R8-2 · and nothing else was written", made.all - before, expTargets.length);
      eq("R8-2 · each landed on the case the rule names", sorted(made.mine.map((t) => t.case_id)), sorted(expTargets.map((id) => classify(id).caseId)));
      eq("R8-2 · every task carries the title that was typed", [...new Set(made.mine.map((t) => t.title))], [TITLE]);
      eq("R8-2 · every task carries the due date that was chosen", [...new Set(made.mine.map((t) => t.due_date))], [due]);
      ok("R8-2 · each task went to that case's own adviser, not to whoever ran the batch",
        made.mine.every((t) => {
          const want = (gt.cases.find((c) => c.id === t.case_id) || {}).assigned_to || "p1";
          return t.assigned_to === want;
        }), JSON.stringify(made.mine.map((t) => [t.case_id, t.assigned_to])));
      const skippedCaseIds = expSkipped.reduce((a, id) => a.concat(casesOf(id).map((c) => c.id)), []);
      ok("R8-2 · NOT ONE task landed on a skipped client's cases",
        made.mine.every((t) => !skippedCaseIds.includes(t.case_id)), JSON.stringify(made.mine.map((t) => t.case_id)));
      const unselected = gt.clients.map((c) => c.id).filter((id) => !picked.includes(id));
      const unselectedCaseIds = unselected.reduce((a, id) => a.concat(casesOf(id).map((c) => c.id)), []);
      ok("R8-2 · …nor on any client that was never selected",
        made.mine.every((t) => !unselectedCaseIds.includes(t.case_id)), JSON.stringify(made.mine.map((t) => t.case_id)));

      const t1 = await toastText(page);
      ok("R8-2 · the toast reports the number written", new RegExp(`${expTargets.length} task`).test(t1), t1);
      if (expSkipped.length) ok("R8-2 · …and the number skipped, by name", /skipped/.test(t1), t1);
      const stillSel = await page.$eval("#client-bulk-n", (e) => Number(e.textContent)).catch(() => 0);
      eq("R8-2 · the filed clients are deselected; the skipped ones stay selected for a hand fix", stillSel, expSkipped.length);

      /* second run: the explicit assignee overrides the case's adviser */
      if (single.length) {
        await page.evaluate(() => { window.clientSelTestReset = true; });
        await page.$$eval("#client-list .client-cb", (cbs) => cbs.forEach((c) => { if (c.checked) c.click(); }));
        await page.waitForTimeout(300);
        const one = single[0];
        await page.$$eval("#client-list .client-cb", (cbs, cid) => { const cb = cbs.find((x) => x.dataset.id === cid); if (cb) cb.click(); }, one);
        await page.waitForTimeout(300);
        await page.click("#client-bulk-task");
        await page.waitForTimeout(350);
        const TITLE2 = "R8 touch — explicit assignee";
        await page.fill("#btaskc-title", TITLE2);
        await page.selectOption("#btaskc-who", "p3");
        await page.click("#btaskc-ok");
        await page.waitForTimeout(600);
        const t2 = await page.evaluate(async (t) => (await window.__mockDb.from("case_tasks").select("id,case_id,assigned_to,title")).data.filter((x) => x.title === t), TITLE2);
        eq("R8-2 · the assignee field is honoured over the case's adviser", t2.map((x) => x.assigned_to), ["p3"]);
        eq("R8-2 · …and it still lands on the rule's case", t2.map((x) => x.case_id), [classify(one).caseId]);
      }
      ok("no console errors (bulk task)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       4 · BULK "EXPORT CSV" — the adviser money rule, verbatim
       =================================================================== */
    {
      console.log("\n— R8-2 · Export CSV and the money rules (p2 Wayne, adviser)");
      const page = await newPage(browser, "p2");
      await gotoClients(page);
      const gt = await groundTruth(page);
      await armCsvCapture(page);
      const mineOnly = gt.clients.map((c) => c.id).filter((id) => {
        const cs = gt.cases.filter((c) => c.client_id === id);
        return cs.length > 0 && cs.every((c) => c.assigned_to === "p2");
      });
      const someoneElses = gt.clients.map((c) => c.id).find((id) => {
        const cs = gt.cases.filter((c) => c.client_id === id);
        return cs.length > 0 && cs.some((c) => c.assigned_to && c.assigned_to !== "p2");
      });
      ok("fixture · Wayne has clients whose whole book is his", mineOnly.length > 0, JSON.stringify(mineOnly.length));
      ok("fixture · …and there is a colleague's client to spill", !!someoneElses, String(someoneElses));

      const select = async (ids) => {
        await page.$$eval("#client-list .client-cb", (cbs) => cbs.forEach((c) => { if (c.checked) c.click(); }));
        await page.waitForTimeout(250);
        for (const id of ids) await page.$$eval("#client-list .client-cb", (cbs, cid) => { const cb = cbs.find((x) => x.dataset.id === cid); if (cb) cb.click(); }, id);
        await page.waitForTimeout(300);
      };

      /* own book only → the fee column is his own money, so it stays */
      await select(mineOnly.slice(0, 3));
      await page.click("#client-bulk-csv");
      await page.waitForTimeout(400);
      let csv = await readCsv(page);
      ok("R8-2 · a CSV really is produced", !!csv && csv.split("\n").length > 1, String(csv).slice(0, 80));
      let head = parseCsvLine(csv.replace(/^﻿/, "").split("\n")[0]);
      ok("R8-2 · an adviser exporting only their OWN clients keeps the fee column", head.includes("Broker fees total"), JSON.stringify(head));
      eq("R8-2 · one data row per selected client", csv.replace(/^﻿/, "").trim().split("\n").length - 1, 3);
      const rows = csv.replace(/^﻿/, "").trim().split("\n").slice(1).map(parseCsvLine);
      const feeIdx = head.indexOf("Broker fees total");
      const dobIdx = head.indexOf("Date of birth");
      const wantFees = mineOnly.slice(0, 3).map((id) => gt.cases.filter((c) => c.client_id === id).reduce((s, c) => s + Number(c.broker_fee || 0), 0));
      eq("R8-2 · the fee total is the sum of that client's cases", sorted(rows.map((r) => Number(r[feeIdx]))), sorted(wantFees));
      const wantDobs = mineOnly.slice(0, 3).map((id) => (gt.clients.find((c) => c.id === id) || {}).dob || "");
      eq("R8-2 · the DOB column carries what is on file (blank where nothing is)", sorted(rows.map((r) => r[dobIdx])), sorted(wantDobs));

      /* the moment a colleague's row is in scope, the column goes */
      await select(mineOnly.slice(0, 2).concat([someoneElses]));
      await page.click("#client-bulk-csv");
      await page.waitForTimeout(400);
      csv = await readCsv(page);
      head = parseCsvLine(csv.replace(/^﻿/, "").split("\n")[0]);
      ok("R8-2 · one colleague's client in the selection drops the fee column entirely", !head.includes("Broker fees total"), JSON.stringify(head));
      const t = await toastText(page);
      ok("R8-2 · …and the export SAYS the fees are not in the file", /broker fees are not in this file/i.test(t), t);
      ok("no console errors (csv p2)", !page.__err, JSON.stringify(page.__err));
      await page.close();

      console.log("\n— R8-2 · the same export as the Owner (p4 Daniel)");
      const owner = await newPage(browser, "p4");
      await gotoClients(owner);
      await armCsvCapture(owner);
      await owner.click("#client-bulk-all");
      await owner.waitForTimeout(500);
      await owner.click("#client-bulk-csv");
      await owner.waitForTimeout(500);
      const ocsv = await readCsv(owner);
      const ohead = parseCsvLine(ocsv.replace(/^﻿/, "").split("\n")[0]);
      ok("R8-2 · the Owner's export always carries the fee column", ohead.includes("Broker fees total"), JSON.stringify(ohead));
      eq("R8-2 · select-all exports the whole filtered set", ocsv.replace(/^﻿/, "").trim().split("\n").length - 1, gt.clients.length);
      ok("no console errors (csv p4)", !owner.__err, JSON.stringify(owner.__err));
      await owner.close();

      console.log("\n— R8-2 · and as an Administrator (p1 Kim) — deliberately unchanged from R5-F1");
      const adm = await newPage(browser, "p1");
      await gotoClients(adm);
      await armCsvCapture(adm);
      await adm.click("#client-bulk-all");
      await adm.waitForTimeout(500);
      await adm.click("#client-bulk-csv");
      await adm.waitForTimeout(500);
      const acsv = await readCsv(adm);
      const ahead = parseCsvLine(acsv.replace(/^﻿/, "").split("\n")[0]);
      ok("R8-2 · an Administrator's export still has no fee column", !ahead.includes("Broker fees total"), JSON.stringify(ahead));
      await adm.close();
    }

    /* ===================================================================
       5 · DOB CAPTURE
       =================================================================== */
    {
      console.log("\n— R8-3 · DOB on the row, in the form, and on the settings status line (p4 Daniel)");
      const page = await newPage(browser, "p4");
      const gt = await groundTruth(page);

      await page.evaluate(() => window.nav("settings"));
      await page.waitForTimeout(1200);
      const status = await page.$eval("#birthday-status", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("R8-3 · the status line states the switch", /Birthday greetings: (ON|OFF)/.test(status), status);
      const birthdaySetting = await page.evaluate(async () => ((await window.__mockDb.from("settings").select("key,value")).data.find((r) => r.key === "birthday_enabled") || {}).value);
      ok("R8-3 · the ON/OFF matches the stored setting",
        new RegExp(`Birthday greetings: ${birthdaySetting === "on" ? "ON" : "OFF"}`).test(status), status);
      ok("R8-3 · N of M is the real arithmetic over the clients table",
        new RegExp(`${gt.dobWith} of ${gt.dobTotal} clients? have a date of birth`).test(status), `${status} | want ${gt.dobWith}/${gt.dobTotal}`);
      const missing = gt.dobTotal - gt.dobWith;
      ok("fixture · some of the book has no date of birth", missing > 0, `${missing} missing`);
      ok("R8-3 · …and the shortfall is a link, not a lament", new RegExp(`${missing} missing`).test(status), status);

      await page.click("#birthday-missing-link");
      await page.waitForTimeout(800);
      const onClients = await page.$eval("#page-clients", (e) => !e.classList.contains("hidden"));
      ok("R8-3 · the link lands on the Clients page", onClients === true);
      const activeSeg = await page.$eval("#client-segment .seg-btn.active", (e) => e.dataset.seg);
      eq("R8-3 · …with the Missing-DOB segment selected", activeSeg, "no_dob");
      const ids = await renderedIds(page);
      eq("R8-3 · …showing exactly the clients with no DOB", sorted(ids), sorted(gt.segIds.no_dob));

      const rowTxt = await page.$eval("#client-list .client-row .s", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("R8-3 · the row itself says the DOB is missing", /DOB: —/.test(rowTxt), rowTxt);
      ok("R8-3 · …and offers the one-click way to add it", /add/.test(rowTxt), rowTxt);
      /* the same row in another segment does NOT carry it — this is an affordance
         for the segment that exists because of it, not a new column */
      await clickSeg(page, "all");
      const anyDobOnRow = await page.$$eval("#client-list .client-row .s", (rs) => rs.some((r) => /DOB:/.test(r.textContent)));
      ok("R8-3 · the DOB affordance is confined to the Missing-DOB segment", anyDobOnRow === false);

      await clickSeg(page, "no_dob");
      const firstMissing = (await renderedIds(page))[0];
      await page.$eval("#client-list .client-dob-add", (a) => a.click());
      await page.waitForTimeout(700);
      const focused = await page.evaluate(() => (document.activeElement && document.activeElement.getAttribute("name")) || "");
      eq("R8-3 · the add link opens the client form at the DOB field", focused, "date_of_birth");
      const detOpen = await page.$eval("#modal .client-details", (d) => d.open);
      ok("R8-3 · …with the (normally collapsed) details section open", detOpen === true);
      const flag = await page.$eval("#modal .client-dob-flag", (e) => e.textContent.trim()).catch(() => "");
      eq("R8-3 · the field is badged as missing while it is", flag, "missing");
      const order = await page.$$eval("#client-form label", (ls) => ls.map((l) => (l.querySelector("input,select,textarea") || {}).name));
      ok("R8-3 · DOB sits with the name, not below the opt-outs", order.indexOf("date_of_birth") === 2, JSON.stringify(order));
      const hint = await page.$eval(".client-dob-field .field-hint", (e) => e.textContent.trim());
      ok("R8-3 · the field says what it is FOR", /birthday greetings/i.test(hint), hint);

      /* fill it in and prove the segment, the count and the status line all move */
      await page.fill("#client-form [name='date_of_birth']", "1984-03-09");
      await page.click("#modal-save");
      await page.waitForTimeout(1000);
      const saved = await page.evaluate(async (id) => (await window.__mockDb.from("clients").select("id,date_of_birth").eq("id", id)).data[0].date_of_birth, firstMissing);
      eq("R8-3 · the DOB is actually stored", saved, "1984-03-09");
      const chipsAfter = await chipCounts(page);
      eq("R8-3 · the Missing-DOB count drops by one", chipsAfter.find((c) => c.seg === "no_dob").n, gt.segIds.no_dob.length - 1);
      await page.evaluate(() => window.nav("settings"));
      await page.waitForTimeout(1200);
      const status2 = await page.$eval("#birthday-status", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("R8-3 · …and the settings status line follows it", new RegExp(`${gt.dobWith + 1} of ${gt.dobTotal}`).test(status2), status2);
      ok("no console errors (dob)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       6 · ANNUAL REVIEW — the switch, the task, and My Day
       =================================================================== */
    {
      console.log("\n— R8-4 · annual review (p4 Daniel, owner)");
      const page = await newPage(browser, "p4");
      await page.evaluate(() => window.nav("settings"));
      await page.waitForTimeout(1200);

      const sel = await page.$("select[name='annual_review_enabled']");
      ok("R8-4 · Settings carries the annual_review_enabled toggle", !!sel);
      const seeded = await page.evaluate(async () => ((await window.__mockDb.from("settings").select("key,value")).data.find((r) => r.key === "annual_review_enabled") || {}).value);
      eq("R8-4 · it ships OFF, like production", seeded, "off");
      eq("R8-4 · …and the control shows OFF", await page.$eval("select[name='annual_review_enabled']", (e) => e.value), "off");
      const note = await page.$eval("#annual-review-note", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("R8-4 · the copy says it creates a call task on the completion anniversary", /call task/i.test(note) && /completion anniversary/i.test(note), note);
      ok("R8-4 · …and says outright that no email is sent", /No email is sent to the client/i.test(note), note);
      ok("R8-4 · …and separates itself from the anniversary EMAIL sitting above it", /Independent of the completion-anniversary email/i.test(note), note);

      /* the switch really is the gate */
      const offRun = await page.evaluate(() => window.__mock.queueCommsExtras());
      eq("R8-4 · with the switch off, a queueing run creates no annual-review task", offRun.annual_review_tasks, 0);

      await page.selectOption("select[name='annual_review_enabled']", "on");
      await page.click("#save-settings-btn");
      await page.waitForTimeout(900);
      const stored = await page.evaluate(async () => (await window.__mockDb.from("settings").select("key,value")).data.find((r) => r.key === "annual_review_enabled").value);
      eq("R8-4 · the Owner's save persists the switch", stored, "on");

      /* Last year's call is IN the fixtures (it is what proves the 11-month
         idempotency window lets this year's through), so "the tasks this run
         made" is a diff, not a filter. */
      const beforeIds = await page.evaluate(async () => (await window.__mockDb.from("case_tasks").select("id,title")).data.filter((t) => /^Annual review call — /.test(t.title)).map((t) => t.id));
      const run = await page.evaluate(() => window.__mock.queueCommsExtras());
      ok("R8-4 · with it on, the queueing run makes annual-review tasks", run.annual_review_tasks > 0, JSON.stringify(run));
      const allAr = await page.evaluate(async () => (await window.__mockDb.from("case_tasks").select("id,case_id,title,due_date,assigned_to,done_at,created_by")).data.filter((t) => /^Annual review call — /.test(t.title)));
      const arTasks = allAr.filter((t) => !beforeIds.includes(t.id));
      eq("R8-4 · the tally matches the rows actually written", arTasks.length, run.annual_review_tasks);
      ok("R8-4 · the task title names the client and the completion date", /Annual review call — .+ \(completed \d{2}\/\d{2}\/\d{4}/.test(arTasks[0].title), arTasks[0].title);
      const todayLdn = await page.evaluate(() => localDateStr());
      /* The queueing function stamps its own "today" (the database's clock);
         localDateStr() is the app's Europe/London one. They are the same date
         except for the hour a day when a UTC sandbox and BST disagree, so the
         due date is asserted against the stamping clock and the horizon check
         below is done against the app's. */
      const todayDb = await page.evaluate(() => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; });
      eq("R8-4 · each new one is due today", [...new Set(arTasks.map((t) => t.due_date))], [todayDb]);
      ok("R8-4 · …and none of them is pre-completed", arTasks.every((t) => !t.done_at));
      ok("R8-4 · …so My Day's 14-day horizon will show it", arTasks.every((t) => t.due_date <= todayLdn), JSON.stringify([todayLdn, arTasks.map((t) => t.due_date)]));
      ok("R8-4 · a completion whose anniversary is a year old but already called this year is left alone",
        allAr.length === beforeIds.length + arTasks.length, JSON.stringify([beforeIds.length, arTasks.length, allAr.length]));

      /* running it again must not double up */
      const again = await page.evaluate(() => window.__mock.queueCommsExtras());
      eq("R8-4 · a second run writes no duplicate call", again.annual_review_tasks, 0);

      /* …and it renders in My Day and in the case, like any other task */
      /* My Day's task panel shows the first 15 of the fortnight, oldest due date
         first, and the fixtures carry a wall of overdue work in front of a task
         due today. Close that backlog so the new call is on screen rather than
         behind an "…and N more due" line — the point of the check is the
         RENDERING of the title, not the ordering, which is untouched this round. */
      await page.evaluate(async () => {
        const db = window.__mockDb;
        const today = localDateStr();
        const { data } = await db.from("case_tasks").select("id,title,due_date,done_at");
        for (const t of data) {
          if (!t.done_at && t.due_date && t.due_date < today && !/^Annual review call — /.test(t.title)) {
            await db.from("case_tasks").update({ done_at: new Date().toISOString() }).eq("id", t.id);
          }
        }
      });
      await page.evaluate(() => window.nav("dashboard"));
      await page.waitForTimeout(1400);
      /* the tasks are on the CASES' advisers, which is the point — so read the
         panel in the scope that shows the team's work, exactly as an owner would */
      await page.click("#tasks-scope-all");
      await page.waitForTimeout(1000);
      const myDay = await page.$eval("#tasks-list", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("R8-4 · the annual-review task renders in My Day's task list, unmangled",
        /Annual review call/.test(myDay), myDay.slice(0, 300));
      ok("R8-4 · …with the em dash intact (nothing chokes on the title)", /Annual review call —/.test(myDay), myDay.slice(0, 300));
      const openCaseId = arTasks[0].case_id;
      await page.evaluate((id) => window.openCase(id), openCaseId);
      await page.waitForTimeout(1200);
      const caseTxt = await page.$eval("#modal", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("R8-4 · …and on the case itself", /Annual review call/.test(caseTxt), caseTxt.slice(0, 200));
      ok("no console errors (annual review)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       7 · THE REVIEW-REQUEST DRIP — 5 a run, oldest first, remainder waits
       =================================================================== */
    {
      console.log("\n— R8-5 · the review-request drip (p4 Daniel)");
      const page = await newPage(browser, "p4");
      await page.evaluate(() => window.nav("settings"));
      await page.waitForTimeout(1200);
      const npsNote = await page.$eval("#nps-note", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("R8-5 · the review-request copy states the cap", /at most 5 per automation run/i.test(npsNote), npsNote);
      ok("R8-5 · …and the order", /oldest completion first/i.test(npsNote), npsNote);
      ok("R8-5 · …and what happens to the rest", /queue up on later runs/i.test(npsNote), npsNote);

      // R13 · M-4/M-30 — a client hand-flagged suppress_automation=true gets NO
      // automated review-request either, mirrored here independently rather
      // than trusted from the app: cl021 (Hannah Verity, "do not contact") is
      // suppressed and completed, so her case (ca011-ish) drops out of the
      // eligible backlog and whichever case is next in line takes her slot.
      const eligible = await page.evaluate(async () => {
        const db = window.__mockDb;
        const [cs, cl, st] = await Promise.all([
          db.from("cases").select("id,client_id,stage,completed_at,review_requested_at"),
          db.from("clients").select("id,email,marketing_opt_out,suppress_automation"),
          db.from("settings").select("key,value"),
        ]);
        const delay = Number((st.data.find((r) => r.key === "review_delay_days") || {}).value || 14) || 14;
        const byId = {}; cl.data.forEach((c) => (byId[c.id] = c));
        return cs.data.filter((c) => {
          if (c.stage !== "completed" || !c.completed_at || c.review_requested_at) return false;
          if ((Date.now() - new Date(c.completed_at).getTime()) / 86400000 < delay) return false;
          const x = byId[c.client_id];
          return !!(x && x.email && !x.marketing_opt_out && !x.suppress_automation);
        }).sort((a, b) => (a.completed_at < b.completed_at ? -1 : a.completed_at > b.completed_at ? 1 : (a.id < b.id ? -1 : 1))).map((c) => c.id);
      });
      ok("fixture · the review backlog is bigger than one run's cap", eligible.length > 5, `${eligible.length} eligible`);

      // Independent proof that suppression is actually doing something here,
      // not just a filter that never fires on this fixture.
      const suppressedCompleted = await page.evaluate(async () => {
        const db = window.__mockDb;
        const [cs, cl] = await Promise.all([
          db.from("cases").select("id,client_id,stage,completed_at"),
          db.from("clients").select("id,email,suppress_automation"),
        ]);
        const byId = {}; cl.data.forEach((c) => (byId[c.id] = c));
        return cs.data.filter((c) => c.stage === "completed" && c.completed_at && byId[c.client_id] && byId[c.client_id].suppress_automation && byId[c.client_id].email).map((c) => c.id);
      });
      ok("fixture · at least one completed, emailable case belongs to a suppressed client", suppressedCompleted.length > 0, JSON.stringify(suppressedCompleted));
      eq("…and none of them ever appear in the eligible backlog", suppressedCompleted.filter((id) => eligible.includes(id)).length, 0);

      /* the review link is a real gate, and proving it costs one run: blank both
         link settings, run, and nothing may be queued or stamped */
      await page.evaluate(async () => { await window.__mockDb.from("settings").upsert([{ key: "google_review_link", value: "" }, { key: "review_platform_link", value: "" }]); });
      const noLink = await page.evaluate(() => window.__mock.queueCommsExtras());
      eq("R8-5 · with no review link, nothing is queued at all", noLink.review_requests_queued, 0);
      await page.evaluate(async () => { await window.__mockDb.from("settings").upsert([{ key: "review_platform_link", value: "https://g.page/r/mock" }]); });

      const r1 = await page.evaluate(() => window.__mock.queueCommsExtras());
      eq("R8-5 · one run queues at most five", r1.review_requests_queued, 5);
      const q1 = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id,case_id,email_type,created_at")).data.filter((e) => e.email_type === "review_request").map((e) => e.case_id));
      eq("R8-5 · …and they are the five oldest completions", sorted(q1.slice(-5)), sorted(eligible.slice(0, 5)));
      const stamped = await page.evaluate(async (ids) => (await window.__mockDb.from("cases").select("id,review_requested_at")).data.filter((c) => ids.includes(c.id) && c.review_requested_at).map((c) => c.id), eligible);
      eq("R8-5 · exactly the queued five are stamped — the rest keep their turn", sorted(stamped), sorted(eligible.slice(0, 5)));

      const r2 = await page.evaluate(() => window.__mock.queueCommsExtras());
      eq("R8-5 · the next run takes the next five (or what is left)", r2.review_requests_queued, Math.min(5, eligible.length - 5));
      const q2 = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id,case_id,email_type")).data.filter((e) => e.email_type === "review_request").map((e) => e.case_id));
      eq("R8-5 · …and nobody is asked twice", q2.filter((id) => eligible.includes(id)).length, new Set(q2.filter((id) => eligible.includes(id))).size);

      /* the Emails page tells an operator the same story */
      await page.evaluate(() => window.nav("emails"));
      await page.waitForTimeout(1200);
      const enote = await page.$eval("#emails-r8-note", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("R8-5 · the Emails page states the drip cap", /at most 5 per run/i.test(enote), enote);
      ok("R8-5 · …and that the annual review is a task, so it will never appear on this page",
        /Annual reviews send no email/i.test(enote) && /call task/i.test(enote), enote);
      ok("no console errors (drip)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       8 · GATING — an adviser and an admin see honest, refusing settings
       =================================================================== */
    {
      console.log("\n— R8-4 · owner/adviser gating on the new switch (p2 Wayne, adviser)");
      const page = await newPage(browser, "p2");
      await page.evaluate(() => window.nav("settings"));
      await page.waitForTimeout(1200);
      const dis = await page.$eval("select[name='annual_review_enabled']", (e) => e.disabled);
      ok("R8-4 · an adviser sees the annual-review switch read-only, not missing", dis === true);
      const saveHidden = await page.$eval("#save-settings-btn", (e) => e.classList.contains("hidden"));
      ok("R8-4 · …and no Save button to press", saveHidden === true);
      const note = await page.$eval("#annual-review-note", (e) => e.textContent.trim());
      ok("R8-4 · …but the same honest explanation of what it does", /No email is sent/i.test(note), note.slice(0, 120));
      const status = await page.$eval("#birthday-status", (e) => e.textContent.trim());
      ok("R8-3 · …and the same DOB status line", /have a date of birth/.test(status), status);

      /* the client page verbs are NOT owner-gated — an adviser sweeps their own book */
      await gotoClients(page);
      const chips = await chipCounts(page);
      ok("R8-1 · an adviser gets the full segment set", chips.length === 8, JSON.stringify(chips.length));
      await page.click("#client-bulk-all");
      await page.waitForTimeout(500);
      ok("R8-2 · …and both bulk verbs", (await page.$("#client-bulk-task")) !== null && (await page.$("#client-bulk-csv")) !== null);
      ok("R8-2 · …and still no bulk email verb", (await page.$("#client-bulk-email")) === null);
      ok("no console errors (gating)", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       9 · VIEWPORTS — 390 and 1280 clean, on every state this round adds
       =================================================================== */
    {
      console.log("\n— R8 · 390 / 1280 clean");
      for (const [w, h, tag] of [[390, 844, "390"], [1280, 800, "1280"]]) {
        const page = await newPage(browser, "p1", { width: w, height: h });
        await gotoClients(page);
        await clickSeg(page, "cold");
        await page.click("#client-bulk-all");
        await page.waitForTimeout(500);
        const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
        eq(`R8 · no horizontal overflow on the Clients page at ${tag}`, m.doc <= m.win, true);
        const barVisible = await page.$eval("#client-bulk-bar", (e) => !e.hidden && e.getBoundingClientRect().width > 0);
        ok(`R8 · the bulk bar is usable at ${tag}`, barVisible === true);
        const chipsFit = await page.$eval("#client-segment", (e) => e.scrollWidth >= e.clientWidth && e.getBoundingClientRect().width <= window.innerWidth);
        ok(`R8 · the segment strip stays inside the viewport at ${tag}`, chipsFit === true);
        await page.evaluate(() => window.nav("settings"));
        await page.waitForTimeout(1200);
        const m2 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
        eq(`R8 · no horizontal overflow on Settings at ${tag}`, m2.doc <= m2.win, true);
        ok(`no console errors at ${tag}`, !page.__err, JSON.stringify(page.__err));
        await page.close();
      }
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r8_touch: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
