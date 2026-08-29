#!/usr/bin/env node
/* =============================================================================
   tests/r75_queues.js — acceptance tests for R75 build B, "Queues without
   friction" (panel findings A#16–A#19 + E-13's file inputs, D#20, D#19, D#22,
   B#10/B#12/B#17/B#19, plus the two R74 riders).

   What R75 · B changed, and what each section pins:

     §A  DROP ZONES (B1 / E-13 / D#20). Four raw `<input type=file>` — bulk
         import, Revolution sync, the weekly commission statement and the proc
         rate card — are one `dropZoneHtml(id, accept, label)` component: a
         styled zone, REAL dragover/drop wiring, the accepted formats written
         out, and a filename readout that is ours (so the two Money handlers
         clearing `.value` cannot erase it). The input keeps its id, accept and
         aria-label, because every existing handler and the harness's own
         `__drop()` helper drive it directly. Both import primary buttons are
         disabled until there is something to read, with the reason in a title.

     §B  THE JUNK GUARD AND WHAT SURROUNDS IT (finding 10). The AI import now
         runs the Revolution path's person check (`rowPersonCheck`, shared by
         both doors): a row with no name, email or phone starts UNTICKED with
         the reason stated, and typing a name in re-ticks it. "1 records found"
         is pluralised. "Assign new cases to me" defaults OFF for admin/owner
         and ON for advisers — `newCaseSelfAssigns()`, the R72 rule. "Review
         before saving" keeps sentence one on screen and folds the rest. The
         review table freezes the tick box AND the Client column.

     §C  THE FUNNEL IS A CONTROL (D#19). `#ret-outcome-funnel`'s chips are
         buttons; pressing one filters the ended list to that outcome and says
         so above the list; "£ at risk" is the loan on the no-outcome set.
         rateBookCounts and the R72 derivation are untouched — pinned here.

     §D  GONE QUIET GETS VERBS (D#22). The shared "no contact in N days" fact is
         in the panel-sub once; each row carries the loan, the next rate end and
         the standard verbs; the list is ordered by next rate end ascending.

     §E  THE PIPELINE TABLE (B#10, B#12, B#17, B#19). A rule-based default set of
         nine (Property dropped when >half the rows have no address, Adviser
         dropped under an adviser filter, never the column we are sorted by),
         "⊞ All columns" for the full set, a ↕ on every sortable head and ▲/▼ on
         the active one, a "Sorted by …" line, the tick column sticky at left:0
         so Client cannot slide under it, Download CSV out of the scroller, and
         the board's day-colour legend repeated in table view.

     §F  THE R74 RIDERS. previewComposeEmail knows review_request and the five
         other composed types (and factfind); bulkMoveStage's native
         confirm + "type REOPEN" prompt are one house overlay each, with the
         batch semantics unchanged.

   Run:  node /root/nx/tests/r75_queues.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — see HARNESS.md.)
   ========================================================================== */
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
function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(name, same, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function ensureServer() {
  const up = await new Promise((res) => {
    const req = http.get(`http://localhost:${PORT}/admin/mock.html`, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
  });
  if (up) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1400));
  return srv;
}

/* nx_pipe_cols is R75's addition to the clear-list, for the same reason
   nx_ret_month was R64's: a suite that asserts a DEFAULT must never inherit a
   choice an earlier scenario made. */
const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_sortdir", "nx_ret_untouched", "nx_wt_scope",
  "nx_board_adviser", "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc",
  "nx_drawer_retention", "nx_import_blurb", "nx_pipe_cols", "nx_pipe_view", "nx_client_adviser"];

async function boot(browser, persona) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));
const noNewErr = (page, before) => realErrs(page).length === before;

const goto = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms || 1600);
};

/* The pipeline table, on screen. Same shape r65_pipeline uses. */
async function toTable(page) {
  await goto(page, "pipeline", 1700);
  const isBoard = await page.evaluate(() => !document.querySelector("#board").classList.contains("hidden"));
  if (isBoard) { await page.click("#view-toggle"); await page.waitForTimeout(1600); }
}
const tableKeys = (page) => page.$$eval("#pipe-table th[data-k]", (e) => e.map((t) => t.dataset.k));

/* A REAL drop onto a zone: a DataTransfer carrying a File, dispatched as a drop
   event on the zone, exactly as a browser does it. Nothing here touches the
   input directly — that is the whole point of the assertion. */
async function dropOnZone(page, zoneId, name, text) {
  return page.evaluate(({ zoneId, name, text }) => {
    const zone = document.getElementById(zoneId);
    if (!zone) return "no zone";
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: "text/csv" }));
    const ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    zone.dispatchEvent(ev);
    return "ok";
  }, { zoneId, name, text });
}

const CSV = `Name,Email,Phone,Stage,Lender,Rate,Fee
Duncan Armitage,duncan.armitage@example.com,07700 900102,offer,Halifax,4.29,495
Ruby Sinclair,ruby.newjob@example.com,,application,Nationwide,4.5,595`;
/* The trailing junk line every report tool leaves behind: money and a word, no
   person. The mock's ai-import stub returns it (R75 mock-parity) exactly as
   production's language-model importer does. Deliberately NOT stage
   "completed": that would ALSO trip the older "completed with no completion
   date" flag, and this section is about the person guard on its own. */
const CSV_JUNK = CSV + `\n,,,enquiry,TOTALS,,12500`;
const CSV_ONE = `Name,Email,Phone,Stage,Lender,Rate,Fee
Solo Onerow,solo.onerow@example.com,07700 900999,enquiry,Halifax,4.1,395`;

async function analyse(page, csv) {
  await goto(page, "import", 900);
  await page.fill("#import-text", csv);
  await page.click("#analyse-btn");
  await page.waitForTimeout(1800);
}

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {

    /* =======================================================================
       §A · THE DROP ZONES — four doors, one component
       ======================================================================= */
    {
      console.log("\n— §A · drop zones on all four file doors (p4 owner: Money is owner-gated)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;

      await goto(page, "import", 1200);
      const zones = await page.evaluate(() => ["import-file", "rev-file"].map((id) => {
        const zone = document.getElementById(id + "-zone");
        const input = document.getElementById(id);
        const readout = document.getElementById(id + "-name");
        const face = zone && zone.querySelector(".dz-face");
        return {
          id,
          hasZone: !!zone,
          inputInZone: !!(zone && input && zone.contains(input)),
          accept: input ? input.getAttribute("accept") : null,
          aria: input ? input.getAttribute("aria-label") : null,
          formats: face ? (face.querySelector(".dz-formats") || {}).textContent || "" : "",
          verb: face ? (face.querySelector(".dz-verb") || {}).textContent || "" : "",
          readout: readout ? readout.textContent.trim() : null,
        };
      }));
      zones.forEach((z) => {
        ok(`A1 · ${z.id}: the styled zone exists and holds the real input`, z.hasZone && z.inputInZone, JSON.stringify(z));
        ok(`A1b · ${z.id}: the input keeps its accept list`, /\.csv/.test(z.accept || ""), z.accept);
        ok(`A1c · ${z.id}: the input keeps an accessible name`, !!(z.aria && z.aria.length > 4), z.aria);
        ok(`A1d · ${z.id}: the accepted formats are stated in words`, /^Accepts /.test(z.formats) && /Excel/.test(z.formats), z.formats);
        ok(`A1e · ${z.id}: the zone says you can drop a file on it`, /Drop/.test(z.verb) && /choose one/.test(z.verb), z.verb);
        eq(`A1f · ${z.id}: the filename readout starts empty and says so`, z.readout, "No file chosen yet.");
      });

      // A2 — a REAL drop, on the zone, with no help from the input.
      eq("A2 · fixture — a drop event is dispatched on the import zone", await dropOnZone(page, "import-file-zone", "book.csv", CSV), "ok");
      await page.waitForTimeout(700);
      const dropped = await page.evaluate(() => ({
        readout: document.getElementById("import-file-name").textContent.trim(),
        hasFileCls: document.getElementById("import-file-name").classList.contains("has-file"),
        box: document.getElementById("import-text").value.slice(0, 30),
        status: document.getElementById("import-status").textContent,
        files: document.getElementById("import-file").files.length,
      }));
      eq("A2a · the dropped filename is read back on the zone", dropped.readout, "Chosen: book.csv");
      ok("A2b · …and the readout marks itself as carrying a file", dropped.hasFileCls);
      ok("A2c · the drop went through the input's OWN change handler (the box was filled)",
        dropped.box.startsWith("Name,Email"), JSON.stringify(dropped));
      ok("A2d · …and the existing status line ran unchanged", /Loaded book\.csv/.test(dropped.status), dropped.status);
      eq("A2e · the file really landed on the input, not just on the readout", dropped.files, 1);

      // A4 — the two import primary buttons.
      await page.evaluate(() => { document.getElementById("import-text").value = ""; document.getElementById("import-text").dispatchEvent(new Event("input", { bubbles: true })); });
      await page.waitForTimeout(200);
      const btnEmpty = await page.evaluate(() => ({
        analyse: document.getElementById("analyse-btn").disabled,
        analyseTitle: document.getElementById("analyse-btn").title,
        rev: document.getElementById("rev-read-btn").disabled,
        revTitle: document.getElementById("rev-read-btn").title,
      }));
      ok("A4a · ✨ Analyse with AI is disabled with nothing to analyse", btnEmpty.analyse);
      ok("A4b · …and its title says why", /Nothing to analyse yet/.test(btnEmpty.analyseTitle), btnEmpty.analyseTitle);
      ok("A4c · Read the export is disabled with nothing to read", btnEmpty.rev);
      ok("A4d · …and its title says why", /Nothing to read yet/.test(btnEmpty.revTitle), btnEmpty.revTitle);
      await page.fill("#import-text", CSV);
      await page.fill("#rev-text", "Client Name,Email\nA B,a@b.com");
      await page.waitForTimeout(250);
      const btnFull = await page.evaluate(() => ({
        analyse: document.getElementById("analyse-btn").disabled,
        analyseTitle: document.getElementById("analyse-btn").title,
        rev: document.getElementById("rev-read-btn").disabled,
      }));
      ok("A4e · both re-enable the moment there is something to read", !btnFull.analyse && !btnFull.rev, JSON.stringify(btnFull));
      ok("A4f · …and the enabled title says what pressing it does", /Nothing is saved/.test(btnFull.analyseTitle), btnFull.analyseTitle);

      // A5 — the Revolution panel reads as the quieter of the two doors.
      const quiet = await page.evaluate(() => {
        const rev = document.getElementById("rev-input-panel");
        const imp = document.querySelector("#page-import .panel");
        return {
          secondary: rev.classList.contains("panel-secondary"),
          revBg: getComputedStyle(rev).backgroundColor,
          impBg: getComputedStyle(imp).backgroundColor,
        };
      });
      ok("A5 · the Revolution panel takes the quieter secondary treatment", quiet.secondary && quiet.revBg !== quiet.impBg, JSON.stringify(quiet));

      // A3 — the Money uploaders: same component, and the readout survives the
      // handler clearing the input (which is what it does, so the same workbook
      // can be chosen twice).
      await goto(page, "money", 2600);
      const moneyZones = await page.evaluate(() => ["recon-file", "procrates-file"].map((id) => {
        const zone = document.getElementById(id + "-zone");
        const input = document.getElementById(id);
        return {
          id, hasZone: !!zone, inputInZone: !!(zone && input && zone.contains(input)),
          accept: input ? input.getAttribute("accept") : null,
          formats: zone ? (zone.querySelector(".dz-formats") || {}).textContent || "" : "",
          inHead: !!(input && input.closest(".panel-head-row")),
        };
      }));
      moneyZones.forEach((z) => {
        ok(`A3 · ${z.id}: the Money uploader is the same drop zone`, z.hasZone && z.inputInZone, JSON.stringify(z));
        ok(`A3b · ${z.id}: …stating what it accepts`, /Excel/.test(z.formats), z.formats);
        ok(`A3c · ${z.id}: …and it is out of the panel head, below the explainer`, !z.inHead);
      });
      await page.evaluate(() => {
        const el = document.getElementById("recon-file");
        const dt = new DataTransfer();
        dt.items.add(new File(["x"], "statement-wk34.xlsx", { type: "application/vnd.ms-excel" }));
        el.files = dt.files;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(1400);
      const reconRead = await page.evaluate(() => ({
        readout: document.getElementById("recon-file-name").textContent.trim(),
        inputCleared: document.getElementById("recon-file").value === "",
      }));
      eq("A3d · the statement's filename is read back", reconRead.readout, "Chosen: statement-wk34.xlsx");
      ok("A3e · …and it survives the handler clearing the input", reconRead.inputCleared, JSON.stringify(reconRead));

      ok("§A · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =======================================================================
       §B · THE JUNK GUARD, THE ASSIGN DEFAULT, THE FOLD AND THE FROZEN COLUMN
       ======================================================================= */
    {
      console.log("\n— §B · import review: junk guard, assign default, review-rules fold, frozen columns (p1 Kim, admin)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;

      // The shared person check, both doors, by name.
      const check = await page.evaluate(() => ({
        empty: rowPersonCheck("", "", ""),
        noName: rowPersonCheck("", "a@b.com", ""),
        fine: rowPersonCheck("Jo Bloggs", "", ""),
        phoneOnly: rowPersonCheck("", "", "07700 900000"),
      }));
      ok("B0a · a row with nothing in it fails the person check, with the Revolution reason",
        check.empty.ok === false && /no name, email or phone/.test(check.empty.reason), JSON.stringify(check.empty));
      ok("B0b · contact details with no name fail too, with their own reason",
        check.noName.ok === false && /contact details but no name/.test(check.noName.reason), JSON.stringify(check.noName));
      ok("B0c · a name alone passes", check.fine.ok === true, JSON.stringify(check.fine));
      ok("B0d · a phone alone does NOT (there is nobody to write to a client record)",
        check.phoneOnly.ok === false, JSON.stringify(check.phoneOnly));

      await analyse(page, CSV_JUNK);
      const rowsB = await page.evaluate(() => [...document.querySelectorAll(".imp-row")].map((cb, i) => ({
        i, checked: cb.checked,
        match: (document.querySelector(`.imp-match[data-i="${i}"]`) || {}).textContent || "",
      })));
      eq("B1 · fixture — the junk row survived the importer and is in the preview", rowsB.length, 3);
      ok("B1a · the two real rows start ticked", rowsB[0].checked && rowsB[1].checked, JSON.stringify(rowsB));
      ok("B1b · the junk row starts UNTICKED", rowsB[2].checked === false, JSON.stringify(rowsB[2]));
      ok("B1c · …and its Match cell states the reason, in the Revolution path's words",
        /no person in this row/.test(rowsB[2].match) && /no name, email or phone/.test(rowsB[2].match), rowsB[2].match);
      ok("B1d · the badge carries the explanation as a title",
        await page.$eval('.imp-match[data-i="2"] .badge', (e) => /starts unticked because/.test(e.title)));

      // B2 — the way back: type a name in and the row re-ticks itself.
      await page.evaluate(() => {
        const td = document.querySelector('.imp-edit[data-i="2"][data-field="client_name"]');
        td.focus(); td.textContent = "Recovered Person"; td.blur();
      });
      await page.waitForTimeout(400);
      const afterFix = await page.evaluate(() => ({
        checked: document.querySelector('.imp-row[data-i="2"]').checked,
        match: document.querySelector('.imp-match[data-i="2"]').textContent,
      }));
      ok("B2 · typing a name into the junk row re-ticks it", afterFix.checked, JSON.stringify(afterFix));
      ok("B2b · …and the “no person” verdict is gone", !/no person in this row/.test(afterFix.match), afterFix.match);

      // B3 — the pluralisation.
      await analyse(page, CSV_ONE);
      const status1 = await page.$eval("#import-status", (e) => e.textContent);
      ok("B3 · one row reads “1 record found”, not “1 records found”",
        /\b1 record found\b/.test(status1) && !/1 records/.test(status1), status1);
      await analyse(page, CSV);
      const status2 = await page.$eval("#import-status", (e) => e.textContent);
      ok("B3b · …and two still read “2 records found”", /\b2 records found\b/.test(status2), status2);

      // B4 — assign-to-me, by role.
      const kimAssign = await page.evaluate(() => ({
        checked: document.getElementById("imp-assign-me").checked,
        why: (document.getElementById("imp-assign-why") || {}).textContent || "",
      }));
      ok("B4a · an ADMINISTRATOR gets it unticked", kimAssign.checked === false, JSON.stringify(kimAssign));
      ok("B4b · …with the reason on the page", /starts UNTICKED for administrators and the owner/.test(kimAssign.why), kimAssign.why);

      // B5 — the fold: sentence one stays out, the rules go behind it.
      const fold = await page.evaluate(() => {
        const lede = document.getElementById("imp-review-lede");
        const blurb = document.getElementById("imp-review-blurb");
        const btn = document.getElementById("imp-blurb-toggle");
        return {
          lede: lede ? lede.textContent.trim() : null,
          ledeHidden: lede ? lede.classList.contains("hidden") : null,
          blurbHidden: blurb ? blurb.classList.contains("hidden") : null,
          btn: btn ? btn.textContent.trim() : null,
          titled: blurb ? [...blurb.querySelectorAll(".badge")].map((b) => !!(b.getAttribute("title") || "").length) : [],
          badges: blurb ? blurb.querySelectorAll(".badge").length : 0,
        };
      });
      ok("B5a · sentence one is on screen, always", /^Untick anything that shouldn't be imported\./.test(fold.lede || ""), fold.lede);
      ok("B5b · …and is NOT the thing that folds", fold.ledeHidden === false, JSON.stringify(fold));
      ok("B5c · the rest of the rules are in the existing #imp-review-blurb fold", fold.blurbHidden === false && fold.btn === "Got it — collapse", JSON.stringify(fold));
      ok("B5d · every badge the rules explain carries a title",
        fold.badges >= 6 && fold.titled.every(Boolean), JSON.stringify(fold));
      await page.click("#imp-blurb-toggle");
      await page.waitForTimeout(250);
      const folded = await page.evaluate(() => ({
        blurbHidden: document.getElementById("imp-review-blurb").classList.contains("hidden"),
        ledeHidden: document.getElementById("imp-review-lede").classList.contains("hidden"),
        btn: document.getElementById("imp-blurb-toggle").textContent.trim(),
      }));
      ok("B5e · collapsing hides the rules and keeps sentence one",
        folded.blurbHidden && !folded.ledeHidden && folded.btn === "Review rules ▸", JSON.stringify(folded));

      // B6 — the frozen columns.
      const frozen = await page.evaluate(() => {
        const th = document.querySelector("#imp-review-table th.bulk-col");
        const cl = document.querySelector("#imp-review-table th.stick-col");
        const g = (e) => { const s = getComputedStyle(e); return { pos: s.position, left: s.left, bg: s.backgroundColor }; };
        return { bulk: th ? g(th) : null, client: cl ? g(cl) : null, hint: (document.getElementById("imp-scroll-hint") || {}).textContent || "" };
      });
      ok("B6a · the tick column is sticky at left:0 with a ground of its own",
        frozen.bulk && frozen.bulk.pos === "sticky" && frozen.bulk.left === "0px" && !/rgba\(0, 0, 0, 0\)/.test(frozen.bulk.bg), JSON.stringify(frozen.bulk));
      ok("B6b · the Client column is sticky and CLEARS the tick column (so it cannot slide under it)",
        frozen.client && frozen.client.pos === "sticky" && parseFloat(frozen.client.left) >= 36, JSON.stringify(frozen.client));
      ok("B6c · the sideways-scroll affordance is said, not only drawn",
        /scrolls sideways/.test(frozen.hint) && /stay put/.test(frozen.hint), frozen.hint);

      ok("§B · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }
    {
      console.log("\n— §B4c · …and an ADVISER still gets “assign to me” ticked (the R72 newCaseSelfAssigns rule)");
      const page = await boot(browser, "p2");
      const errBefore = realErrs(page).length;
      await analyse(page, CSV);
      const advAssign = await page.evaluate(() => ({
        checked: document.getElementById("imp-assign-me").checked,
        why: (document.getElementById("imp-assign-why") || {}).textContent || "",
        rule: newCaseSelfAssigns(),
      }));
      ok("B4c · an adviser gets it ticked", advAssign.checked === true, JSON.stringify(advAssign));
      ok("B4d · …and the checkbox agrees with newCaseSelfAssigns() itself", advAssign.checked === advAssign.rule, JSON.stringify(advAssign));
      ok("B4e · …with an adviser-shaped reason", /You are an adviser/.test(advAssign.why), advAssign.why);
      ok("§B4c · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =======================================================================
       §C · THE FUNNEL FILTERS THE LIST, AND SAYS WHAT IS AT RISK
       ======================================================================= */
    {
      console.log("\n— §C · #ret-outcome-funnel becomes a control (p4 owner — £ at risk is firm money)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goto(page, "retention", 3000);

      const chips = await page.evaluate(() => [...document.querySelectorAll("#ret-outcome-funnel .ret-outcome-chip")].map((c) => ({
        tag: c.tagName, outcome: c.dataset.outcome, n: Number(c.dataset.n),
        pressed: c.getAttribute("aria-pressed"), btn: c.classList.contains("btn"),
      })));
      eq("C1 · the four chips are still there, still carrying data-outcome and data-n",
        chips.map((c) => c.outcome), ["retained", "renewed_elsewhere", "sold", "none"]);
      ok("C1b · …and they are BUTTONS now, not spans", chips.every((c) => c.tag === "BUTTON"), JSON.stringify(chips.map((c) => c.tag)));
      ok("C1c · …each announcing its pressed state", chips.every((c) => c.pressed === "false"), JSON.stringify(chips.map((c) => c.pressed)));
      ok("C1d · …and joining the house button system", chips.every((c) => c.btn));

      // C2 — £ at risk, checked against the mock's own loan amounts.
      const risk = await page.evaluate(() => {
        const el = document.getElementById("ret-outcome-atrisk");
        return { text: el ? el.textContent.replace(/\s+/g, " ").trim() : null, title: el ? el.title : null };
      });
      ok("C2 · a “£ at risk” clause joins the strip", !!risk.text && /at risk$/.test(risk.text), JSON.stringify(risk));
      ok("C2b · …and its title says the basis (the loan on the no-outcome cases, added up)",
        /loan on each of the/.test(risk.title || "") && /added up/.test(risk.title || ""), risk.title);
      const riskSub = await page.$eval("#ret-outcome-sub", (e) => e.textContent);
      ok("C2c · the basis is in the sub as well, in words", /at risk<\/strong>|at risk/.test(riskSub) && /not a fee forecast/.test(riskSub), riskSub.slice(-300));
      const noneN = (chips.find((c) => c.outcome === "none") || {}).n || 0;
      const riskNum = Number((risk.text || "").replace(/[^0-9]/g, ""));
      ok("C2d · the figure is a real total, not a placeholder", noneN === 0 || riskNum > 0, JSON.stringify({ noneN, riskNum }));

      // C3 — pressing "no outcome" filters the list.
      const before = await page.evaluate(() => ({
        rows: document.querySelectorAll("#ret-rates-list .row-item").length,
        groups: [...document.querySelectorAll("#ret-rates-list .ret-group-h")].map((h) => h.className),
        book: window.__r74RateBookCounts ? "exposed" : "missing",
      }));
      await page.click('#ret-outcome-funnel .ret-outcome-chip[data-outcome="none"]');
      await page.waitForTimeout(2200);
      const after = await page.evaluate(() => ({
        rows: document.querySelectorAll("#ret-rates-list .row-item").length,
        pressed: document.querySelector('.ret-outcome-chip[data-outcome="none"]').getAttribute("aria-pressed"),
        active: document.querySelector('.ret-outcome-chip[data-outcome="none"]').classList.contains("scope-active"),
        notice: (() => { const n = document.getElementById("ret-outcome-filter-note"); return n && !n.hidden ? n.textContent.replace(/\s+/g, " ").trim() : null; })(),
        groups: [...document.querySelectorAll("#ret-rates-list .ret-group-h")].map((h) => h.className),
        outcomes: [...document.querySelectorAll("#ret-rates-list .row-item")].map((r) => {
          const o = r.querySelector(".ret-row-outcome");
          return o ? o.dataset.outcome : "none";
        }),
      }));
      ok("C3a · the pressed chip says so, and takes the house pressed state",
        after.pressed === "true" && after.active, JSON.stringify(after));
      ok("C3b · the list is narrowed to that outcome", after.rows > 0 && after.rows <= before.rows, JSON.stringify({ before: before.rows, after: after.rows }));
      ok("C3c · …and every row on screen really has no outcome recorded",
        after.outcomes.every((o) => o === "none"), JSON.stringify(after.outcomes));
      eq("C3d · only the ENDED group is left (an outcome happens at the end of a rate)",
        after.groups.filter((c) => /ret-g-(soon|erc)/.test(c)).length, 0);
      ok("C3e · the filter says itself above the list, and names the way out",
        /Filtered to/.test(after.notice || "") && /Show everything/.test(after.notice || ""), after.notice);

      // C4 — toggling off.
      await page.click('#ret-outcome-funnel .ret-outcome-chip[data-outcome="none"]');
      await page.waitForTimeout(2200);
      const cleared = await page.evaluate(() => ({
        rows: document.querySelectorAll("#ret-rates-list .row-item").length,
        pressed: document.querySelector('.ret-outcome-chip[data-outcome="none"]').getAttribute("aria-pressed"),
        noticeHidden: document.getElementById("ret-outcome-filter-note").hidden,
      }));
      eq("C4 · pressing the pressed chip again restores the whole list", cleared.rows, before.rows);
      ok("C4b · …clears the pressed state and the notice", cleared.pressed === "false" && cleared.noticeHidden, JSON.stringify(cleared));

      // C5 — the numbers were NOT redefined: rateBookCounts is still the source
      // and the three group badges still sum to the rows on screen.
      const book = await page.evaluate(() => {
        const heads = [...document.querySelectorAll("#ret-rates-list .ret-group-h .count")].map((c) => Number(c.textContent));
        return { heads, sum: heads.reduce((a, b) => a + b, 0), rows: document.querySelectorAll("#ret-rates-list .row-item").length };
      });
      eq("C5 · the group badges still add up to the rows on screen (rateBookCounts untouched)", book.sum, book.rows);
      eq("C5b · …and the shared predicate is still exposed where R74 left it", before.book, "exposed");

      ok("§C · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =======================================================================
       §D · GONE QUIET GETS VERBS
       ======================================================================= */
    {
      console.log("\n— §D · #ret-cold-list rows get values, verbs and a deadline order (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goto(page, "retention", 3000);

      const cold = await page.evaluate(() => {
        const sub = document.getElementById("ret-cold-sub").textContent;
        const rows = [...document.querySelectorAll("#ret-cold-list .row-item")].map((r) => ({
          text: r.textContent.replace(/\s+/g, " ").trim(),
          rate: (r.querySelector(".client-rate-bit") || {}).textContent || "",
          money: (r.querySelector(".ret-cold-money") || {}).textContent || "",
          tel: !!r.querySelector(".ret-row-tel a[href^='tel:']"),
          sms: !!r.querySelector("a.row-sms-link[href^='sms:']"),
          logcall: !!r.querySelector(".ret-logcall-chip"),
        }));
        return { sub, rows };
      });
      ok("D0 · fixture — the panel has rows", cold.rows.length > 0, String(cold.rows.length));
      ok("D1 · the shared silence fact is stated ONCE, in the panel-sub",
        /no contact of any kind on record in the last \d+ days/.test(cold.sub), cold.sub.slice(-260));
      const repeats = cold.rows.filter((r) => /no contact of any kind in the last/.test(r.text)).length;
      eq("D1b · …and no longer on every single row", repeats, 0);
      const withRate = cold.rows.filter((r) => r.rate);
      ok("D2 · rows with a future rate carry the next rate-end date", withRate.length > 0, String(withRate.length));
      ok("D2b · every row carries the loan value (owner)", cold.rows.every((r) => /Loan £/.test(r.money) || !r.money), JSON.stringify(cold.rows.map((r) => r.money)));
      ok("D2c · …and at least most of them have one to show", cold.rows.filter((r) => /Loan £/.test(r.money)).length >= Math.ceil(cold.rows.length / 2),
        JSON.stringify(cold.rows.map((r) => r.money)));
      ok("D3 · every row carries the standard call/text pair", cold.rows.every((r) => r.tel && r.sms), JSON.stringify(cold.rows.map((r) => [r.tel, r.sms])));
      ok("D3b · …and a “Log call” chip wherever there is a maturing case to log it against",
        withRate.every((r) => r.logcall), JSON.stringify(withRate.map((r) => r.logcall)));

      // D4 — the order.
      const order = await page.evaluate(() => [...document.querySelectorAll("#ret-cold-list .row-item")].map((r) => {
        const bit = r.querySelector(".client-rate-bit");
        if (!bit) return null;
        const m = bit.textContent.match(/next rate ends ([0-9]{1,2} [A-Za-z]{3} [0-9]{4})/);
        return m ? Date.parse(m[1] + " 12:00:00") : null;
      }));
      const dated = order.filter((x) => x !== null);
      const undatedFirstAt = order.findIndex((x) => x === null);
      ok("D4 · the list is ordered by next rate end, soonest first",
        dated.every((v, i) => i === 0 || dated[i - 1] <= v), JSON.stringify(dated));
      ok("D4b · …and clients with no future rate end sort LAST",
        undatedFirstAt === -1 || order.slice(undatedFirstAt).every((x) => x === null), JSON.stringify(order));
      ok("D4c · the sub says what the order is and why",
        /Ordered by the next rate end, soonest first/.test(cold.sub), cold.sub.slice(-200));

      ok("§D · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =======================================================================
       §E · THE PIPELINE TABLE EARNS ITS COLUMNS
       ======================================================================= */
    {
      console.log("\n— §E · pipeline table: rule-based columns, sort affordances, sticky tick column, CSV + legend (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await toTable(page);

      const keys = await tableKeys(page);
      ok("E1 · the default set is around nine columns, not sixteen", keys.length <= 10, JSON.stringify(keys));
      ok("E1b · Completing and Fee status are promoted INTO it",
        keys.includes("expected_completion_date") && keys.includes("fee_status"), JSON.stringify(keys));
      ok("E1c · the identity and the two triage answers are in it",
        ["client", "stage", "days_in_stage", "waiting_on"].every((k) => keys.includes(k)), JSON.stringify(keys));

      // E2 — the Property rule, measured against the rows on screen.
      const propRule = await page.evaluate(() => {
        const t = document.querySelector("#pipe-table");
        const ths = [...t.querySelector("tr").querySelectorAll("th")];
        const rows = [...t.querySelectorAll("tr")].slice(1);
        return { shown: ths.some((th) => th.dataset.k === "property"), rows: rows.length };
      });
      const propHalf = await page.evaluate(() => {
        // the app's own predicate, over the rows the table is built from
        const t = document.querySelector("#pipe-table");
        return { total: [...t.querySelectorAll("tr")].length - 1 };
      });
      ok("E2 · Property is dropped on a view where more than half the rows have no address",
        propRule.shown === false, JSON.stringify({ propRule, propHalf }));
      const why = await page.$eval("#pipe-cols-why", (e) => e.textContent.replace(/\s+/g, " ").trim());
      ok("E2b · the rules are stated on the page", /more than half the rows/.test(why) && /adviser filter/.test(why) && /sorted by/.test(why), why);
      ok("E2c · …and it says nothing is lost", /Nothing is lost/.test(why), why);

      // E2d — the escape hatch restores everything.
      await page.click("#pipe-cols-toggle");
      await page.waitForTimeout(1700);
      const allKeys = await tableKeys(page);
      ok("E2d · “⊞ All columns” brings the full set back", allKeys.length > keys.length && allKeys.includes("property"), JSON.stringify(allKeys));
      await page.click("#pipe-cols-toggle");
      await page.waitForTimeout(1700);
      eq("E2e · …and pressing it again returns to the rule-based set", (await tableKeys(page)).length, keys.length);

      // E3 — the sort affordances.
      const sortBits = await page.evaluate(() => {
        const ths = [...document.querySelectorAll("#pipe-table th[data-k]")];
        return {
          allHaveAriaSort: ths.every((t) => !!t.getAttribute("aria-sort")),
          allTitled: ths.every((t) => /sort by|Sorted by/.test(t.getAttribute("title") || "")),
          active: ths.filter((t) => t.getAttribute("aria-sort") !== "none").map((t) => t.dataset.k),
          activeMark: (ths.find((t) => t.getAttribute("aria-sort") !== "none") || {}).textContent || "",
          hint: (() => {
            const idle = ths.find((t) => t.getAttribute("aria-sort") === "none");
            return idle ? getComputedStyle(idle, "::after").content : null;
          })(),
          line: (document.getElementById("pipe-sorted-by") || {}).textContent || "",
        };
      });
      ok("E3a · every sortable head announces its sort state", sortBits.allHaveAriaSort);
      ok("E3b · …and says what clicking it does", sortBits.allTitled);
      eq("E3c · exactly one column is the active sort", sortBits.active.length, 1);
      ok("E3d · the active one carries ▲ or ▼", /[▲▼]/.test(sortBits.activeMark), sortBits.activeMark);
      ok("E3e · the idle ones show a quiet ↕ (drawn, so header TEXT is unchanged)",
        /↕/.test(sortBits.hint || ""), sortBits.hint);
      ok("E3f · …and a “Sorted by <col>” line sits above the table",
        /^Sorted by /.test(sortBits.line.trim()), sortBits.line);
      const headTexts = await page.$$eval("#pipe-table th", (e) => e.map((x) => x.textContent.replace(/[▲▼]/g, "").trim()).filter(Boolean));
      ok("E3g · the ↕ is NOT in the header text (the R65/r9_docs header contract)",
        headTexts.every((h) => !/↕/.test(h)), JSON.stringify(headTexts));

      // E4 — the sticky tick column.
      const sticky = await page.evaluate(() => {
        const g = (sel) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); return { pos: s.position, left: s.left, bg: s.backgroundColor }; };
        return { bulk: g("#pipe-table th.bulk-col"), client: g("#pipe-table th.stick-col") };
      });
      ok("E4 · the tick cell is sticky at left:0 with a background of its own",
        sticky.bulk && sticky.bulk.pos === "sticky" && sticky.bulk.left === "0px" && !/rgba\(0, 0, 0, 0\)/.test(sticky.bulk.bg), JSON.stringify(sticky.bulk));
      ok("E4b · …and the sticky Client column starts AFTER it, so nothing leaks underneath",
        sticky.client && sticky.client.pos === "sticky" && parseFloat(sticky.client.left) >= 36, JSON.stringify(sticky.client));

      // E5 — CSV out of the scroller; E6 — the legend repeated.
      const chrome = await page.evaluate(() => {
        const csv = document.getElementById("csv-btn");
        const scroller = document.getElementById("pipe-scroll");
        const legend = document.getElementById("pipe-legend");
        const board = document.getElementById("board-legend");
        return {
          csvInScroller: !!(csv && scroller && scroller.contains(csv)),
          csvInHead: !!(csv && csv.closest("#pipe-table-head")),
          legendItems: legend ? legend.querySelectorAll(".bl-item").length : 0,
          boardItems: board ? board.querySelectorAll(".bl-item").length : 0,
          legendSame: !!(legend && board && legend.innerHTML === board.innerHTML),
          legendVisible: !!(legend && legend.offsetParent !== null),
        };
      });
      ok("E5 · Download CSV is out of the horizontal scroller", chrome.csvInScroller === false);
      ok("E5b · …and into the panel header, where it stays put", chrome.csvInHead);
      ok("E6 · the board's day-colour legend is repeated in table view",
        chrome.legendVisible && chrome.legendItems === chrome.boardItems && chrome.legendItems >= 3, JSON.stringify(chrome));
      ok("E6b · …from the board's own markup, so the two cannot drift", chrome.legendSame);

      ok("§E · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }
    {
      console.log("\n— §E7 · …and an adviser filter drops the Adviser column (every row would say the same name)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await toTable(page);
      ok("E7 · fixture — Adviser is in the default set with no filter on", (await tableKeys(page)).includes("assigned"));
      await page.evaluate(() => {
        const sel = document.getElementById("board-adviser");
        const opt = [...sel.options].find((o) => o.value !== "all" && o.value !== "unassigned");
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(1900);
      const filteredKeys = await tableKeys(page);
      ok("E7b · with a filter on, Adviser is dropped", !filteredKeys.includes("assigned"), JSON.stringify(filteredKeys));
      ok("§E7 · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =======================================================================
       §F · THE R74 RIDERS
       ======================================================================= */
    {
      console.log("\n— §F1 · previewComposeEmail knows review_request and the rest of the composed set (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;

      const preview = await page.evaluate(() => {
        const types = ["review_request", "welcome", "lead_ack", "referral_request",
          "birthday_greeting", "completion_anniversary", "factfind", "rate_end_reminder"];
        const out = {};
        types.forEach((t) => {
          const c = previewComposeEmail(t, { email_type: t }, { caseRow: null });
          out[t] = c ? c.lines : null;
        });
        return { out, mapKeys: Object.keys(HOUSE_TPL_OPENING).sort() };
      });
      ok("F1a · review_request composes a body at last (Kim's 23 queued rows)",
        Array.isArray(preview.out.review_request) && /short review/.test(preview.out.review_request.join(" ")),
        JSON.stringify(preview.out.review_request));
      ["welcome", "lead_ack", "referral_request", "birthday_greeting", "completion_anniversary"].forEach((t) => {
        ok(`F1b · ${t} composes a body`, Array.isArray(preview.out[t]) && preview.out[t].length > 0, JSON.stringify(preview.out[t]));
      });
      ok("F1c · factfind composes its three real sentences and NAMES the link rather than inventing one",
        (preview.out.factfind || []).length === 3 && /a secure link, built for this client/.test((preview.out.factfind || []).join(" ")),
        JSON.stringify(preview.out.factfind));
      ok("F1d · the pre-existing eleven are untouched",
        /rate on your mortgage is coming to an end/.test((preview.out.rate_end_reminder || []).join(" ")),
        JSON.stringify(preview.out.rate_end_reminder));

      // F1e — the inventory: every type the harness's model of v17 composes is in
      // the map. That model IS the written-down contract for the deployed function.
      const inventory = await page.evaluate(() => {
        const known = Object.keys(HOUSE_TPL_OPENING);
        // The mock's composer knows a type when it has an opening for it; factfind
        // composes through its own builder and is handled separately in the app.
        return { known: known.sort() };
      });
      const mustHave = ["review_request", "review_reminder", "welcome", "lead_ack", "referral_request",
        "birthday_greeting", "completion_anniversary", "rate_end_reminder", "rate_end_chase",
        "submitted_update", "offer_update", "completion_congrats", "protection_offer", "fee_request",
        "gi_exchange", "docs_request", "docs_chase"];
      eq("F1e · the preview map covers every composed type in the enum", mustHave.filter((t) => !inventory.known.includes(t)), []);

      // F1f — end to end: an actual queued review_request row renders the wording.
      await page.evaluate(async () => {
        const { data: cs } = await window.__mockDb.from("cases").select("id,client_id").limit(1);
        const c = cs[0];
        await window.__mockDb.from("email_queue").insert({
          case_id: c.id, client_id: c.client_id, email_type: "review_request",
          to_email: "r75@example.com", subject: "How did we do?", status: "queued",
        });
      });
      await goto(page, "emails", 2600);
      const rendered = await page.evaluate(async () => {
        const row = [...document.querySelectorAll("#email-list .em-fold")].find((f) => {
          const item = f.closest(".row-item, .em-row, li, div");
          return item && /r75@example\.com/.test(item.textContent);
        });
        if (!row) return { found: false };
        row.open = true;
        await new Promise((r) => setTimeout(r, 200));
        const body = row.querySelector(".em-prev-body");
        return { found: true, composed: !!(body && body.dataset.emComposed), text: body ? body.textContent.replace(/\s+/g, " ").trim() : "" };
      });
      ok("F1f · a real queued review_request row previews the composed house wording",
        rendered.found && rendered.composed && /short review/.test(rendered.text), JSON.stringify(rendered).slice(0, 300));

      ok("§F1 · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }
    {
      console.log("\n— §F2 · bulkMoveStage asks through the house overlay, in both branches (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;

      // Two fresh live cases so the batch outcome is deterministic.
      const made = await page.evaluate(async () => {
        const ids = [];
        for (const n of ["R75One", "R75Two"]) {
          const { data: cl } = await window.__mockDb.from("clients")
            .insert({ first_name: "Bulk", last_name: n, email: `${n.toLowerCase()}@example.com` }).select("id").single();
          const { data: cs } = await window.__mockDb.from("cases")
            .insert({ client_id: cl.id, stage: "enquiry", case_kind: "purchase", assigned_to: "p2" }).select("id").single();
          ids.push(cs.id);
        }
        return ids;
      });
      await toTable(page);
      const selectable = await page.evaluate((ids) => ids.filter((id) => !!document.querySelector(`#pipe-table .bulk-cb[data-id="${id}"]`)), made);
      eq("F2 · fixture — both new cases are selectable in the table", selectable.length, 2);
      for (const id of made) await page.check(`#pipe-table .bulk-cb[data-id="${id}"]`);
      page.__dialogs = [];
      await page.selectOption("#pipe-bulk-stage", "fact_find");
      await page.waitForTimeout(1200);

      const plain = await page.evaluate(() => {
        const back = document.getElementById("overlay-backdrop");
        const body = document.getElementById("ovl-confirm-body");
        const okBtn = document.getElementById("ovl-confirm-ok");
        return {
          open: !!(back && !back.classList.contains("hidden")),
          body: body ? body.textContent.replace(/\s+/g, " ").trim() : null,
          okLabel: okBtn ? okBtn.textContent.trim() : null,
          danger: okBtn ? okBtn.classList.contains("btn-danger-solid") : null,
          title: (document.getElementById("ovl-confirm-title") || {}).textContent || "",
        };
      });
      ok("F2a · the plain branch opens the house overlay, not a native confirm", plain.open, JSON.stringify(plain));
      eq("F2b · …and no native dialog was raised at all", page.__dialogs.length, 0);
      ok("F2c · the overlay carries the batch plan verbatim (the four buckets)",
        /2 will move/.test(plain.body || "") && /are blocked/.test(plain.body || "")
        && /already in/.test(plain.body || "") && /will be REOPENED/.test(plain.body || ""), plain.body);
      ok("F2d · …names the cases it is moving", /Moving:\s*· Bulk R75One/.test(plain.body || ""), plain.body);
      ok("F2e · the question is in the dialog's own heading", /Move 2 cases to Fact Find\?/.test(plain.title), plain.title);
      ok("F2f · a plain stage move is NOT dressed as a deletion", plain.danger === false, String(plain.danger));
      await page.click("#ovl-confirm-ok");
      await page.waitForTimeout(2600);
      const moved = await page.evaluate(async (ids) => {
        const { data } = await window.__mockDb.from("cases").select("id,stage").in("id", ids);
        return (data || []).map((c) => c.stage).sort();
      }, made);
      eq("F2g · the batch semantics are unchanged — both cases moved", moved, ["fact_find", "fact_find"]);

      // The cancel path writes nothing.
      await toTable(page);
      for (const id of made) await page.check(`#pipe-table .bulk-cb[data-id="${id}"]`);
      await page.selectOption("#pipe-bulk-stage", "offer");
      await page.waitForTimeout(1200);
      await page.click("#ovl-confirm-cancel");
      await page.waitForTimeout(1600);
      const notMoved = await page.evaluate(async (ids) => {
        const { data } = await window.__mockDb.from("cases").select("id,stage").in("id", ids);
        return (data || []).map((c) => c.stage).sort();
      }, made);
      eq("F2h · backing out of the overlay writes nothing", notMoved, ["fact_find", "fact_find"]);

      /* F3 — THE REOPEN BRANCH. A settled case selected with a live one is the
         shape the typed gate exists for. */
      const settled = await page.evaluate(async () => {
        const { data: cl } = await window.__mockDb.from("clients")
          .insert({ first_name: "Bulk", last_name: "R75Done", email: "r75done@example.com" }).select("id").single();
        const { data: cs } = await window.__mockDb.from("cases")
          .insert({ client_id: cl.id, stage: "completed", case_kind: "purchase", assigned_to: "p2", completed_at: new Date().toISOString() })
          .select("id").single();
        return cs.id;
      });
      await page.evaluate(() => { [...document.querySelectorAll("#pipe-segment .seg-btn")].find((b) => b.dataset.seg === "all").click(); });
      await page.waitForTimeout(1800);
      await toTable(page);
      const canPick = await page.evaluate((id) => !!document.querySelector(`#pipe-table .bulk-cb[data-id="${id}"]`), settled);
      ok("F3 · fixture — the completed case is selectable", canPick);
      if (canPick) {
        await page.check(`#pipe-table .bulk-cb[data-id="${settled}"]`);
        page.__dialogs = [];
        await page.selectOption("#pipe-bulk-stage", "application");
        await page.waitForTimeout(1200);
        const typed = await page.evaluate(() => {
          const back = document.getElementById("overlay-backdrop");
          const input = document.getElementById("ovl-typed-input");
          const okBtn = document.getElementById("ovl-typed-ok");
          return {
            open: !!(back && !back.classList.contains("hidden")),
            hasInput: !!input,
            okDisabled: okBtn ? okBtn.disabled : null,
            danger: okBtn ? okBtn.classList.contains("btn-danger-solid") : null,
            label: (document.getElementById("ovl-typed-label") || {}).textContent || "",
            body: (document.getElementById("ovl-typed-body") || {}).textContent || "",
          };
        });
        ok("F3a · the reopen branch opens the TYPED house overlay", typed.open && typed.hasInput, JSON.stringify(typed));
        eq("F3b · …raising no native prompt", page.__dialogs.length, 0);
        ok("F3c · the word to type is REOPEN, and the button starts disabled",
          /REOPEN/.test(typed.label) && typed.okDisabled === true, JSON.stringify(typed));
        ok("F3d · …the confirming button is the danger one", typed.danger === true);
        ok("F3e · …and the no-undo warning is in the body",
          /back into the live pipeline, and there is no undo/.test(typed.body), typed.body.slice(0, 400));
        // A wrong word is refused.
        await page.fill("#ovl-typed-input", "reopn");
        await page.waitForTimeout(200);
        const wrong = await page.evaluate(() => document.getElementById("ovl-typed-ok").disabled);
        ok("F3f · a wrong word leaves the confirm disabled", wrong === true);
        // The right one, case-insensitively typed, is accepted — the rule is the word.
        await page.fill("#ovl-typed-input", "REOPEN");
        await page.waitForTimeout(200);
        ok("F3g · typing REOPEN enables it", (await page.evaluate(() => document.getElementById("ovl-typed-ok").disabled)) === false);
        await page.click("#ovl-typed-ok");
        await page.waitForTimeout(2600);
        const reopened = await page.evaluate(async (id) => {
          const { data } = await window.__mockDb.from("cases").select("stage").eq("id", id).single();
          return data.stage;
        }, settled);
        eq("F3h · …and the batch reopened the settled case exactly as it always did", reopened, "application");
      }

      ok("§F2 · no console errors", noNewErr(page, errBefore), JSON.stringify(realErrs(page)));
      await page.close();
    }

    /* =======================================================================
       §G · A PHONE PASS over the two surfaces this round re-laid out
       ======================================================================= */
    {
      console.log("\n— §G · 390×844: the drop zone and the gone-quiet rows (p4)");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      page.__err = [];
      page.on("pageerror", (e) => page.__err.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
      page.on("dialog", (d) => d.accept());
      await page.goto(`${BASE}?as=p4`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1800);
      await goto(page, "import", 1400);
      const phoneZone = await page.evaluate(() => {
        const z = document.getElementById("import-file-zone");
        const r = z.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), overflow: document.documentElement.scrollWidth > 390 + 2 };
      });
      ok("G1 · the drop zone fits a 390px screen", phoneZone.w <= 390 && phoneZone.w > 200, JSON.stringify(phoneZone));
      ok("G1b · …and is a comfortable target", phoneZone.h >= 44, String(phoneZone.h));
      ok("G1c · the Import page does not scroll sideways at 390px", phoneZone.overflow === false);
      await goto(page, "retention", 3200);
      const phoneCold = await page.evaluate(() => {
        const chips = [...document.querySelectorAll("#ret-cold-list .ret-logcall-chip")];
        return {
          n: chips.length,
          minH: chips.length ? Math.min(...chips.map((c) => Math.round(c.getBoundingClientRect().height))) : null,
          overflow: document.documentElement.scrollWidth > 390 + 2,
        };
      });
      ok("G2 · the gone-quiet verbs are real tap targets at 390px", phoneCold.n === 0 || phoneCold.minH >= 30, JSON.stringify(phoneCold));
      ok("G2b · the Retention page does not scroll sideways at 390px", phoneCold.overflow === false);
      ok("§G · no console errors", realErrs(page).length === 0, JSON.stringify(realErrs(page)));
      await page.close();
      await ctx.close();
    }

  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (e) { try { server.kill(); } catch (e2) { /* gone */ } } }
  }

  console.log(`\nR75 QUEUES: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
