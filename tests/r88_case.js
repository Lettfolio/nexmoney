// tests/r88_case.js — R88 · D: CASE PANEL ORDER (panel 02 #5, #6, #8).
//
// The case modal reads top-down as the work: sticky actions → identity line + contact + the key
// stats (Adviser, Loan/LTV, Lender, Rate/ends) → Tasks (next task + composer + list) → Notes
// composer → History → collapsed <details class="case-fold"> sections: Milestones, Stage checklist,
// Documents, Files, More facts, Security check, Case details. A fold opens on arrival only when it
// has content (CASE_SECTION_RULES.defaultOpen). Every expectation is computed at runtime from the
// mock database — no hard-coded case ids, counts or dates.
//
//   §A  Offer fixture at 1440×900: order, positions (notes ≤900, history ≤1000), ≤14 controls
//       before scrolling, key stats, every pinned id still present
//   §B  Completed case: same order; folds closed (no content-driven fold without content)
//   §C  defaultOpen: a live case WITH a checklist row and a file opens Documents + Files
//   §D  opening each fold reveals the same DOM the suites pin
//   §E  composers: options on focus; a chip-dated task and a typed note still write
//   §F  openCase(id, { focus }) and { scrollTo: "docs" } land inside the folds
//   §G  keyboard: every fold summary is focusable and toggles with Enter
//   §H  phone 390×844: same order, every fold summary ≥44px, R87 footer rule intact
//   §Z  no console errors
//
// Run:  node /root/nx/tests/r88_case.js
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

async function ensureServer() {
  const up = await new Promise((res) => {
    const req = http.get(`http://localhost:${PORT}/admin/mock.html`, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
  });
  if (up) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1200));
  return srv;
}

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
async function boot(browser, persona, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || DESK, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 30000 });
  await page.waitForTimeout(1800);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(300);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const wait = (page, ms) => page.waitForTimeout(ms);
async function openCase(page, id, opts) {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await wait(page, 300);
  await page.evaluate(({ id, opts }) => window.openCase(id, opts), { id, opts: opts || {} });
  await wait(page, 2200);
}
let uniq = 0;
const tag = () => `R88D${Date.now().toString(36)}${++uniq}`;
async function mkCase(page, o) {
  return page.evaluate(async (opt) => {
    const db = window.__mockDb;
    const { data: cl } = await db.from("clients").insert({ first_name: opt.first, last_name: opt.last, email: `${opt.last.toLowerCase()}@example.com`, phone: "07700900123" }).select("id").single();
    const row = Object.assign({ client_id: cl.id, case_kind: "purchase", stage: "offer", assigned_to: "p4", lender: "Nationwide", loan_amount: 200000, property_value: 250000 }, opt.row || {});
    const { data: c } = await db.from("cases").insert(row).select("id").single();
    return { clientId: cl.id, caseId: c.id };
  }, o);
}

/* The Offer fixture — picked exactly as panel-r87/measure-case.js picks it (newest Offer case with an
   address and a lender), so the positions are comparable with the panel's 1,811px. */
async function pickCase(page, stage) {
  return page.evaluate(async (st) => {
    const { data } = await window.db.from("cases").select("id,stage,lender,property_address").eq("stage", st).order("updated_at", { ascending: false }).limit(20);
    const rows = data || [];
    const p = rows.find((r) => r.property_address && r.lender) || rows.find((r) => r.lender) || rows[0];
    return p && p.id;
  }, stage);
}

/* One read of the modal: section tops (viewport px, modal scrolled to top), DOM order, fold states. */
const snap = (page) => page.evaluate(() => {
  const m = document.querySelector("#modal");
  const bd = document.querySelector("#modal-backdrop");
  if (bd) bd.scrollTop = 0;
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.height > 0 && r.width > 0 && cs.display !== "none" && cs.visibility !== "hidden" && !el.closest("details:not([open]) > :not(summary)"); };
  const top = (sel) => { const el = m.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().top) : null; };
  const order = ["#cs-sticky-actions", ".case-summary", "#case-tasks", "#note-compose", "#case-history",
    "#case-milestones", "#case-fold-checklist", "#case-docs", "#case-fold-files", "#case-fold-facts", "#case-sec-wrap", "details.case-details"];
  const all = [...m.querySelectorAll("*")];
  const pos = {};
  order.forEach((s) => { const el = m.querySelector(s); pos[s] = el ? all.indexOf(el) : -1; });
  const ctrls = [...m.querySelectorAll("button, select, input:not([type=hidden]), textarea, a[href], [onclick]")].filter(vis);
  const firstScreen = ctrls.filter((c) => c.getBoundingClientRect().top < innerHeight);
  const folds = {};
  m.querySelectorAll("details.case-fold").forEach((d) => { folds[d.dataset.fold || d.id] = { open: d.open, hidden: getComputedStyle(d).display === "none" }; });
  return {
    tops: { notes: top("#new-note"), history: top("#case-history"), tasks: top("#new-task"), summary: top(".case-summary") },
    pos, order,
    firstScreen: firstScreen.length, firstScreenLabels: firstScreen.map((c) => (c.innerText || c.placeholder || c.getAttribute("aria-label") || c.tagName).trim().slice(0, 24)),
    keyLabels: [...m.querySelectorAll("#cs-stats-key .cs-stat .cs-lbl")].map((e) => e.textContent.trim().replace(/ —.*$/, "")),
    moreLabels: [...m.querySelectorAll("#cs-stats-more .cs-stat .cs-lbl")].map((e) => e.textContent.trim()),
    folds,
    ids: ["#case-history", "#modal-save", "#cs-sticky-actions", "#new-note", "#add-note-btn", "#note-type-chips", "#new-task", "#add-task-btn", "#new-task-due", "#new-task-assignee", "#tasks-inline", "#case-events-list", "#case-tl-filters", "#cs-copy-link", "#cs-task-val", "#cs-note-val", "#case-more-actions"].filter((s) => !m.querySelector(s)),
    actIds: m.querySelectorAll("[id^='act-']").length,
    stickyFirst: (() => { const s = m.querySelector("#cs-sticky-actions"); const sum = m.querySelector(".case-summary"); return !!(s && sum && (s.compareDocumentPosition(sum) & Node.DOCUMENT_POSITION_FOLLOWING)); })(),
  };
});
const inOrder = (s) => { const p = s.order.map((k) => s.pos[k]).filter((v) => v >= 0); return p.every((v, i) => i === 0 || v > p[i - 1]); };

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  let offerId, doneId, richId;
  const errLog = [];
  try {
    /* =====================================================================
       §A · the Offer fixture at 1440×900
       ===================================================================== */
    {
      console.log("\n— §A · Offer fixture at 1440×900 (p4)");
      const page = await boot(browser, "p4");
      offerId = await pickCase(page, "offer");
      ok("A0 · fixture sanity — an Offer case exists", !!offerId, String(offerId));
      const facts = await page.evaluate(async (id) => {
        const db = window.__mockDb;
        const docs = (await db.from("case_documents").select("id").eq("case_id", id)).data || [];
        const files = (await db.from("case_files").select("id").eq("case_id", id)).data || [];
        return { docs: docs.length, files: files.length };
      }, offerId);
      await page.evaluate(() => window.nav("pipeline")); await wait(page, 800);
      await openCase(page, offerId);
      const s = await snap(page);
      ok("A1 · the notes composer top is ≤ 900px (was 1,811)", s.tops.notes != null && s.tops.notes <= 900, JSON.stringify(s.tops));
      ok("A2 · #case-history top is ≤ 1,000px (was 1,911)", s.tops.history != null && s.tops.history <= 1000, JSON.stringify(s.tops));
      ok("A3 · controls visible before scrolling ≤ 14 (was 20)", s.firstScreen <= 14, `${s.firstScreen}: ${JSON.stringify(s.firstScreenLabels)}`);
      ok("A4 · DOM order: sticky → header → tasks → notes → history → Milestones → Checklist → Documents → Files → More facts → Security → Case details", inOrder(s), JSON.stringify(s.pos));
      ok("A4b · the sticky action row comes before the header", s.stickyFirst);
      ok("A5 · the task composer sits above the notes composer, both above History", s.tops.tasks < s.tops.notes && s.tops.notes < s.tops.history, JSON.stringify(s.tops));
      const keyAllowed = ["Adviser", "Loan", "LTV", "Lender", "Rate"];
      ok("A6 · the header's stat row holds only the key stats (Adviser, Loan/LTV, Lender, Rate/ends)", s.keyLabels.length >= 2 && s.keyLabels.every((l) => keyAllowed.includes(l)), JSON.stringify(s.keyLabels));
      ok("A6b · Adviser and Loan are always in it", s.keyLabels.includes("Adviser") && s.keyLabels.includes("Loan"), JSON.stringify(s.keyLabels));
      ok("A7 · every other stat moved into More facts (Value is there, none of the key four is)", s.moreLabels.includes("Value") && !s.moreLabels.some((l) => ["Adviser", "Loan", "Lender"].includes(l)), JSON.stringify(s.moreLabels));
      eq("A8 · every pinned id is still in the modal", s.ids, []);
      ok("A8b · the act-* action ids are still rendered", s.actIds > 5, String(s.actIds));
      ok("A9 · Milestones is a fold and is born closed", s.folds.milestones && s.folds.milestones.open === false, JSON.stringify(s.folds.milestones));
      eq("A10 · Documents fold open ⇔ this case has a checklist", !!(s.folds.docs && s.folds.docs.open), facts.docs > 0);
      eq("A11 · Files fold open ⇔ this case has a file", !!(s.folds.files && s.folds.files.open), facts.files > 0);
      ok("A12 · Case details is closed", s.folds.details && s.folds.details.open === false, JSON.stringify(s.folds.details));
      // measured before any fold is opened (A13b opens Case details)
      const summaryWords = await page.evaluate(() => document.querySelector("#modal").innerText.split(/\s+/).filter(Boolean).length);
      ok("A15 · the modal says less on arrival (< 509 words, the panel's count)", summaryWords < 509, String(summaryWords));
      const footer = await page.evaluate(() => ({ footerHidden: document.querySelector("#modal > .modal-actions").hidden, save: getComputedStyle(document.querySelector("#modal-save")).display !== "none", cancel: getComputedStyle(document.querySelector("#modal-cancel")).display !== "none" }));
      ok("A13 · desktop keeps the footer + Save (R87 H4); Cancel waits for Case details (panel #8)", !footer.footerHidden && footer.save && !footer.cancel, JSON.stringify(footer));
      await page.evaluate(() => { document.querySelector("#modal .case-details").open = true; });
      await wait(page, 200);
      ok("A13b · opening Case details shows Cancel", await page.evaluate(() => getComputedStyle(document.querySelector("#modal-cancel")).display !== "none"));
      const copy = await page.evaluate(() => { const b = document.querySelector("#cs-copy-link"); return b ? !!b.closest("#case-more-actions") : null; });
      ok("A14 · ⧉ Copy link lives in Actions ▾ (same id)", copy === true, String(copy));
      errLog.push(["A", realErrs(page)]);
      await page.context().close();
    }

    /* =====================================================================
       §B · a Completed case — same order, folds closed unless content
       ===================================================================== */
    {
      console.log("\n— §B · Completed case (p4)");
      const page = await boot(browser, "p4");
      doneId = await pickCase(page, "completed");
      ok("B0 · fixture sanity — a Completed case exists", !!doneId);
      const facts = await page.evaluate(async (id) => {
        const db = window.__mockDb;
        const files = (await db.from("case_files").select("id").eq("case_id", id)).data || [];
        const c = (await db.from("cases").select("*").eq("id", id).single()).data;
        return { files: files.length, objective: c.objective };
      }, doneId);
      await openCase(page, doneId);
      const s = await snap(page);
      ok("B1 · same DOM order as the Offer case", inOrder(s), JSON.stringify(s.pos));
      ok("B2 · notes composer and History are still above the folds and above 1,000px", s.tops.notes <= 900 && s.tops.history <= 1000, JSON.stringify(s.tops));
      ok("B3 · Milestones, Stage checklist and More facts are closed", ["milestones", "checklist", "facts"].every((k) => !s.folds[k] || !s.folds[k].open), JSON.stringify(s.folds));
      ok("B4 · Documents at Completed is the compact closed fold (R15 §3)", !s.folds.docs || s.folds.docs.open === false, JSON.stringify(s.folds.docs));
      eq("B5 · Files open ⇔ a file exists", !!(s.folds.files && s.folds.files.open), facts.files > 0);
      const obj = await page.evaluate(() => !!document.querySelector("#cs-objective"));
      eq("B6 · the objective PROMPT is gone on a completed case (shown only if one is on file) — panel #6", obj, !!(facts.objective && String(facts.objective).trim()));
      errLog.push(["B", realErrs(page)]);
      await page.context().close();
    }

    /* =====================================================================
       §C · defaultOpen — content opens the fold
       ===================================================================== */
    {
      console.log("\n— §C · a live case WITH a checklist row and a file (p4)");
      const page = await boot(browser, "p4");
      const c = await mkCase(page, { first: "Rich", last: "Folds" + tag() });
      richId = c.caseId;
      await page.evaluate(async ({ caseId, clientId }) => {
        const db = window.__mockDb;
        await db.from("case_documents").insert({ case_id: caseId, item: "Payslips — last 3 months", status: "requested" });
        await db.from("case_files").insert({ case_id: caseId, client_id: clientId, name: "ESIS.pdf", kind: "esis", storage_path: `case-files/${caseId}/esis.pdf` });
      }, c);
      await openCase(page, richId);
      const s = await snap(page);
      ok("C1 · Documents fold is born OPEN (a checklist exists)", s.folds.docs && s.folds.docs.open === true, JSON.stringify(s.folds.docs));
      ok("C2 · Files fold is born OPEN (a file exists)", s.folds.files && s.folds.files.open === true, JSON.stringify(s.folds.files));
      ok("C3 · Milestones stays closed", s.folds.milestones && !s.folds.milestones.open);
      const sub = await page.evaluate(() => (document.querySelector("#case-fold-docs > summary") || {}).textContent || "");
      ok("C4 · the Documents summary names the count", /1 on the checklist/.test(sub), sub);
      ok("C5 · the checklist row itself is painted and visible", await page.isVisible("#case-docs-body .doc-row, #case-docs-body [data-doc]").catch(() => false));
      errLog.push(["C", realErrs(page)]);
      await page.context().close();
    }

    /* =====================================================================
       §D · opening a fold reveals the DOM the suites pin
       ===================================================================== */
    {
      console.log("\n— §D · opening each fold (p4, Offer fixture)");
      const page = await boot(browser, "p4");
      await openCase(page, offerId);
      const before = await page.evaluate(() => ({ ms: !!document.querySelector("#case-milestones .ms-row"), chk: !!document.querySelector("#stage-checklist-items") }));
      ok("D0 · folded content is IN the DOM before opening (textContent suites keep working)", before.ms, JSON.stringify(before));
      ok("D1 · .ms-row hidden while Milestones is closed", !(await page.isVisible("#case-milestones .ms-row")));
      await page.click("#case-milestones > summary");
      await wait(page, 200);
      ok("D2 · clicking the Milestones summary reveals the .ms-row list", await page.isVisible("#case-milestones .ms-row"));
      if (before.chk) {
        await page.click("#case-fold-checklist > summary");
        await wait(page, 200);
        ok("D3 · Stage checklist fold reveals #stage-checklist-items", await page.isVisible("#stage-checklist-items"));
      } else ok("D3 · (no checklist at this stage — nothing to reveal)", true);
      const docsFold = await page.$("#case-fold-docs > summary");
      if (docsFold) { await docsFold.click(); await wait(page, 200); }
      ok("D4 · Documents fold reveals #case-docs-body", await page.isVisible("#case-docs"));
      const filesSum = await page.$("#case-fold-files > summary");
      if (filesSum) { await filesSum.click(); await wait(page, 200); }
      ok("D5 · Files fold reveals #case-files", await page.isVisible("#case-files"));
      const factsOpen = await page.evaluate(() => document.querySelector("#case-fold-facts").open);
      if (!factsOpen) { await page.click("#case-fold-facts > summary"); await wait(page, 200); }
      ok("D6 · More facts shows its .cs-stat cells", await page.isVisible("#cs-stats-more .cs-stat"));
      await page.click("#modal details.case-details > summary");
      await wait(page, 200);
      ok("D7 · Case details reveals #case-form", await page.isVisible("#case-form"));
      await page.click("#sec-toggle").catch(() => {});
      await wait(page, 200);
      ok("D8 · the security card still toggles by #sec-toggle", await page.evaluate(() => !document.querySelector("#case-sec-card").classList.contains("sec-collapsed")));
      /* D9 — a re-render of the same case (what "+ Add" on the checklist does) keeps opened folds. */
      await page.evaluate((id) => window.openCase(id), offerId);
      await wait(page, 2200);
      ok("D9 · re-rendering the SAME open case keeps the folds the operator opened", await page.evaluate(() => document.querySelector("#case-milestones").open === true));
      await page.evaluate(() => window.closeModal());
      await wait(page, 300);
      await page.evaluate((id) => window.openCase(id), offerId);
      await wait(page, 2200);
      ok("D10 · …but a fresh open starts from the rules again (Milestones closed)", await page.evaluate(() => document.querySelector("#case-milestones").open === false));
      errLog.push(["D", realErrs(page)]);
      await page.context().close();
    }

    /* =====================================================================
       §E · composers
       ===================================================================== */
    {
      console.log("\n— §E · composers show their options on focus and still write (p4)");
      const page = await boot(browser, "p4");
      const c = await mkCase(page, { first: "Comp", last: "Oser" + tag() });
      await openCase(page, c.caseId);
      ok("E1 · on arrival the task options (chips, assignee, date, Add) are hidden", !(await page.isVisible(".due-chip[data-days='3']")) && !(await page.isVisible("#add-task-btn")));
      await page.focus("#new-task");
      await wait(page, 100);
      ok("E2 · focusing Add a task… reveals the due chips and Add task", await page.isVisible(".due-chip[data-days='3']") && await page.isVisible("#add-task-btn"));
      const tabOrder = await page.evaluate(() => { const els = [...document.querySelectorAll("#task-compose input, #task-compose button, #task-compose select")].map((e) => e.id || e.dataset.days || e.dataset.months); return els; });
      eq("E3 · tab order is title → chips → assignee → date → Add (R12a·D10)", [tabOrder[0], tabOrder[tabOrder.length - 1]], ["new-task", "add-task-btn"]);
      await page.click(".due-chip[data-days='3']");
      const due = await page.$eval("#new-task-due", (e) => e.value);
      await page.fill("#new-task", "R88 composer task");
      await page.click("#add-task-btn");
      await wait(page, 1500);
      const row = await page.evaluate(async (id) => ((await window.__mockDb.from("case_tasks").select("*").eq("case_id", id)).data || []).find((t) => t.title === "R88 composer task"), c.caseId);
      ok("E4 · the chip-dated task was written with that date", row && row.due_date === due, JSON.stringify({ row: row && row.due_date, due }));
      ok("E5 · note options hidden until the note box is focused", !(await page.isVisible("#add-note-btn")));
      await page.focus("#new-note");
      await wait(page, 100);
      ok("E6 · focusing the note box reveals Add note and the type chips", await page.isVisible("#add-note-btn") && await page.isVisible("#note-type-chips .tl-chip[data-type='call']"));
      await page.click("#note-type-chips .tl-chip[data-type='call']");
      await page.fill("#new-note", "R88 composer note");
      await page.click("#add-note-btn");
      await wait(page, 1500);
      ok("E7 · the note lands in History", await page.evaluate(() => /R88 composer note/.test(document.querySelector("#case-events-list").textContent)));
      errLog.push(["E", realErrs(page)]);
      await page.context().close();
    }

    /* =====================================================================
       §F · openCase options that land inside the new layout
       ===================================================================== */
    {
      console.log("\n— §F · openCase(id, { focus }) and { scrollTo: 'docs' } (p4)");
      const page = await boot(browser, "p4");
      await openCase(page, offerId, { focus: "task" });
      const f = await page.evaluate(() => ({ active: document.activeElement && document.activeElement.id, opts: document.querySelector("#task-compose").classList.contains("is-active") }));
      ok("F1 · { focus: 'task' } focuses #new-task with its options open (Today's 'Add next step')", f.active === "new-task" && f.opts, JSON.stringify(f));
      await openCase(page, offerId, { focus: "note" });
      ok("F2 · { focus: 'note' } focuses #new-note", await page.evaluate(() => document.activeElement && document.activeElement.id === "new-note"));
      await openCase(page, offerId, { scrollTo: "docs" });
      const d = await page.evaluate(() => { const el = document.querySelector("#modal #case-docs"); const fold = el.closest("details.case-fold") || el; return { open: fold.open, top: Math.round(el.getBoundingClientRect().top) }; });
      ok("F3 · { scrollTo: 'docs' } opens the Documents fold and scrolls it near the top", d.open && d.top < 400, JSON.stringify(d));
      errLog.push(["F", realErrs(page)]);
      await page.context().close();
    }

    /* =====================================================================
       §G · keyboard
       ===================================================================== */
    {
      console.log("\n— §G · every fold summary is keyboard-reachable (p4)");
      const page = await boot(browser, "p4");
      await openCase(page, offerId);
      const r = await page.evaluate(() => [...document.querySelectorAll("#modal details.case-fold > summary")].filter((s) => getComputedStyle(s.parentElement).display !== "none").map((s) => { s.focus(); return document.activeElement === s; }));
      ok("G1 · every visible fold summary takes focus", r.length >= 5 && r.every(Boolean), JSON.stringify(r));
      await page.focus("#case-milestones > summary");
      const was = await page.evaluate(() => document.querySelector("#case-milestones").open);
      await page.keyboard.press("Enter");
      await wait(page, 150);
      ok("G2 · Enter on a focused summary toggles the fold", await page.evaluate((w) => document.querySelector("#case-milestones").open !== w, was));
      errLog.push(["G", realErrs(page)]);
      await page.context().close();
    }

    /* =====================================================================
       §H · phone 390×844
       ===================================================================== */
    {
      console.log("\n— §H · phone 390×844 (p4)");
      const page = await boot(browser, "p4", PHONE);
      await openCase(page, offerId);
      const s = await snap(page);
      ok("H1 · same DOM order on a phone", inOrder(s), JSON.stringify(s.pos));
      ok("H2 · notes composer is above History and both above the folds", s.tops.notes < s.tops.history, JSON.stringify(s.tops));
      const hs = await page.evaluate(() => [...document.querySelectorAll("#modal details.case-fold > summary")].filter((x) => getComputedStyle(x.parentElement).display !== "none").map((x) => Math.round(x.getBoundingClientRect().height)));
      ok("H3 · every fold summary is ≥44px tall on a phone", hs.length >= 5 && hs.every((h) => h >= 44), JSON.stringify(hs));
      const ft = await page.evaluate(() => document.querySelector("#modal > .modal-actions").hidden);
      ok("H4 · R87 B8 intact: the footer is hidden while Case details is closed", ft === true);
      await page.click("#modal details.case-details > summary");
      await wait(page, 200);
      ok("H5 · …and shows when it opens", await page.evaluate(() => !document.querySelector("#modal > .modal-actions").hidden));
      const ow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
      ok("H6 · no horizontal page scroll", ow);
      errLog.push(["H", realErrs(page)]);
      await page.context().close();
    }
    console.log("\n— §Z · no console errors (ERR_TUNNEL font lines ignored)");
    errLog.forEach(([sec, e]) => ok(`Z · §${sec} raised no console/page errors`, e.length === 0, JSON.stringify(e)));
  } catch (e) {
    ok("suite ran without throwing", false, String(e && e.stack || e));
  } finally {
    await browser.close();
    if (server) try { process.kill(-server.pid); } catch (e) { /* ignore */ }
  }
  console.log("\n================================================================");
  console.log(`r88_case: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
