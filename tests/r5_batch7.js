#!/usr/bin/env node
/* =============================================================================
   tests/r5_batch7.js — acceptance tests for PLAN-R5 Batch 7
   ("Import & duplicate-aware intake")

   One block per plan item:
     1. S4 / R5-23a  the import preview carries a MATCH column: green for an exact
                     match, amber "possible" with Attach / New client for a near one,
                     blank for a genuinely new person; the choice lives on the row and
                     is re-derived the moment the row's name/email/phone is edited.
     2. S4 / R5-23a  runImport writes the row's VISIBLE decision, not a silent
                     save-time index — forced-new creates, attach attaches, and a
                     possible match nobody resolved creates a new client and says so.
     3. S5 / R5-23b  an attaching row whose email/phone disagree with the record
                     expands into a per-field picker (existing pre-selected); the pick
                     is applied and the discarded value is named in the result panel.
     4. R5-10        lead accept runs the same matcher: name+phone count even when the
                     lead HAS an email, a near match asks "Did you mean …?", declining
                     still creates the new client and Data Health flags the pair.

   Run:  node /root/nx/tests/r5_batch7.js   (expects a static server on 8099;
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

async function newPage(browser, persona) {
  const page = await browser.newPage();
  page.__dialogs = [];
  // Default: accept everything (prompts keep their default value). Blocks that care about a
  // specific answer install their own handler with page.__decide.
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    if (d.type() === "prompt") return d.accept(d.defaultValue());
    if (typeof page.__decide === "function" && page.__decide(d.message()) === false) return d.dismiss();
    return d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}

// Paste rows into the import box and run Analyse, exactly as an operator would.
async function analyse(page, csv) {
  await page.click('[data-page="import"]');
  await page.waitForTimeout(250);
  await page.fill("#import-text", csv);
  await page.click("#analyse-btn");
  await page.waitForTimeout(900);
}
const matchCells = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".imp-match")].map((t) => t.innerText.replace(/\s+/g, " ").trim()));
const badgeClasses = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".imp-match")].map((t) => { const b = t.querySelector(".badge"); return b ? b.className.replace("badge ", "") : ""; }));
const previewText = (page) => page.evaluate(() => (document.querySelector("#import-preview") || {}).innerText || "");
const clientsNamed = (page, last) => page.evaluate(async (l) => {
  const { data } = await window.__mockDb.from("clients").select("id,first_name,last_name,email,phone");
  return (data || []).filter((c) => c.last_name === l);
}, last);
// Edit one contenteditable preview cell the way a person does: focus, replace, blur.
async function editCell(page, i, field, value) {
  await page.evaluate(({ i, field, value }) => {
    const td = document.querySelector(`.imp-edit[data-i="${i}"][data-field="${field}"]`);
    td.focus(); td.textContent = value; td.blur();
  }, { i, field, value });
  await page.waitForTimeout(150);
}

/* Three rows that exercise all three verdicts:
   0 Duncan Armitage — the email we already hold                       → exact
   1 Ruby Sinclair   — the name we hold, a DIFFERENT email             → possible
   2 Bartholomew Quill — nobody                                        → new    */
const CSV = `Name,Email,Phone,Stage,Lender,Rate,Fee
Duncan Armitage,duncan.armitage@example.com,07700 900102,offer,Halifax,4.29,495
Ruby Sinclair,ruby.newjob@example.com,,application,Nationwide,4.5,595
Bartholomew Quill,bartholomew.quill@example.com,07700 911222,enquiry,,,`;

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore", detached: true });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       1 · S4 / R5-23a — the MATCH column, and what happens when a row is edited
       =================================================================== */
    console.log("\n— S4 / R5-23a · the preview says who each row lands on (p1 Kim)");
    {
      const page = await newPage(browser, "p1");
      await analyse(page, CSV);

      const cells = await matchCells(page);
      const badges = await badgeClasses(page);
      ok("R5-23a · the preview has a Match column header",
        (await previewText(page)).toUpperCase().includes("MATCH"));
      ok("R5-23a · an exact email match reads green “→ attaches to <name>”",
        /→ attaches to Duncan Armitage/.test(cells[0]) && badges[0] === "green", JSON.stringify([cells[0], badges[0]]));
      ok("R5-23a · a same-name/different-email row is amber “possible: <name>”",
        /possible: Ruby Sinclair/.test(cells[1]) && badges[1] === "amber", JSON.stringify([cells[1], badges[1]]));
      ok("R5-23a · the amber row offers both ways out (Attach / New client)",
        /Attach/.test(cells[1]) && /New client/.test(cells[1]), JSON.stringify(cells[1]));
      eq("R5-23a · a row matching nobody is blank (it creates a client)", cells[2], "");

      // The decision is the operator's, and it is stored on the row: "New client" on the exact
      // match takes it off Duncan's record, and undo puts it back.
      await page.click('.imp-match-new[data-i="0"]');
      await page.waitForTimeout(150);
      const afterNew = (await matchCells(page))[0];
      ok("R5-23a · “New client” overrides an exact match", /new client/i.test(afterNew) && !/attaches to/.test(afterNew), JSON.stringify(afterNew));
      await page.click('.imp-match-undo[data-i="0"]');
      await page.waitForTimeout(150);
      ok("R5-23a · undo restores the match", /→ attaches to Duncan Armitage/.test((await matchCells(page))[0]));

      // Editing an identity cell re-derives the verdict — this is the whole point of showing it
      // before the write: correcting the misread email changes who the row lands on.
      await editCell(page, 1, "email", "ruby.sinclair@example.com");
      const fixed = await matchCells(page);
      ok("R5-23a · correcting the email upgrades the row to an exact match",
        /→ attaches to Ruby Sinclair/.test(fixed[1]) && (await badgeClasses(page))[1] === "green", JSON.stringify(fixed[1]));
      await editCell(page, 1, "email", "someone.else@example.com");
      ok("R5-23a · changing it again re-runs the match (back to possible)",
        /possible: Ruby Sinclair/.test((await matchCells(page))[1]));
      // …and the name cell counts too: the same email on a row now named Ruby raises her as a
      // possible match, where the old preview showed nothing and the save-time index decided alone.
      await editCell(page, 2, "client_name", "Ruby Sinclair");
      ok("R5-23a · editing the NAME re-runs the match as well",
        /possible: Ruby Sinclair/.test((await matchCells(page))[2]), JSON.stringify((await matchCells(page))[2]));

      eq("no console errors", page.__err || [], []);
      await page.close();
    }

    /* ===================================================================
       2 · S4 / R5-23a — runImport writes the row's decision, not a hidden index
       =================================================================== */
    console.log("\n— S4 / R5-23a · the import writes what the preview promised (p1 Kim)");
    {
      const page = await newPage(browser, "p1");
      const before = await page.evaluate(async () => (await window.__mockDb.from("clients").select("id")).data.length);
      await analyse(page, CSV);
      await page.click('.imp-match-new[data-i="0"]');     // Duncan: NOT the same person
      await page.click('.imp-match-attach[data-i="1"]');  // Ruby: yes, attach
      await page.waitForTimeout(150);
      await page.click("#import-save-btn");
      await page.waitForTimeout(1500);

      const armitages = await clientsNamed(page, "Armitage");
      const sinclairs = await clientsNamed(page, "Sinclair");
      const after = await page.evaluate(async () => (await window.__mockDb.from("clients").select("id")).data.length);
      ok("R5-23a · the forced-new row created a second record instead of attaching", armitages.length === 2, JSON.stringify(armitages.map((c) => c.id)));
      ok("R5-23a · the attached row created NO new client", sinclairs.length === 1, JSON.stringify(sinclairs.map((c) => c.id)));
      eq("R5-23a · exactly two clients were created (forced-new + the genuinely new one)", after - before, 2);

      const cases = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,client_id,lender,stage,created_at").order("created_at");
        return data.slice(-3).map((c) => ({ client_id: c.client_id, lender: c.lender, stage: c.stage }));
      });
      ok("R5-23a · the attached row's case hangs off the EXISTING client (cl001)",
        cases.some((c) => c.client_id === "cl001" && c.lender === "Nationwide" && c.stage === "application"), JSON.stringify(cases));

      const summary = await previewText(page);
      ok("R5-23a · the result panel states attached vs new",
        /1 attached to existing/i.test(summary) && /2 new/i.test(summary), JSON.stringify(summary.split("\n")[0]));
      eq("no console errors", page.__err || [], []);
      await page.close();
    }

    /* ===================================================================
       2b · an unresolved possible match creates a client — and says so
       =================================================================== */
    console.log("\n— S4 / R5-23a · a possible match nobody answered is never attached on a guess (p1 Kim)");
    {
      const page = await newPage(browser, "p1");
      await analyse(page, CSV);
      await page.click("#import-save-btn");   // Ruby's amber row left undecided
      await page.waitForTimeout(1500);
      const sinclairs = await clientsNamed(page, "Sinclair");
      const summary = await previewText(page);
      ok("R5-23a · the undecided row created a NEW client rather than attaching silently", sinclairs.length === 2, JSON.stringify(sinclairs.map((c) => c.email)));
      ok("R5-23a · and the result panel names it and the client it looked like",
        /created a NEW client despite a possible match/.test(summary) && /Ruby Sinclair/.test(summary), JSON.stringify(summary));
      ok("R5-23a · the exact-match row still attached (1 attached to existing)", /1 attached to existing/i.test(summary), JSON.stringify(summary.split("\n")[0]));
      eq("no console errors", page.__err || [], []);
      await page.close();
    }

    /* ===================================================================
       3 · S5 / R5-23b — conflicting contact details are surfaced, not dropped
       =================================================================== */
    console.log("\n— S5 / R5-23b · the conflict expander, and what happens to the value you don't keep (p1 Kim)");
    for (const keep of ["incoming", "existing"]) {
      const page = await newPage(browser, "p1");
      await analyse(page, CSV);
      await page.click('.imp-match-attach[data-i="1"]');
      await page.waitForTimeout(200);

      if (keep === "incoming") {
        const expander = await page.evaluate(() => (document.querySelector('.imp-conf-cell[data-i="1"]') || {}).innerText || "");
        ok("R5-23b · attaching Ruby's row opens an expander naming the disagreement",
          /disagrees with Ruby Sinclair/.test(expander) && /Email/.test(expander), JSON.stringify(expander.replace(/\s+/g, " ").slice(0, 120)));
        ok("R5-23b · it shows both values — what's on record and what's in the file",
          /ruby\.sinclair@example\.com/.test(expander) && /ruby\.newjob@example\.com/.test(expander));
        const checked = await page.evaluate(() =>
          [...document.querySelectorAll('.imp-conf-radio[data-i="1"][data-field="email"]')].filter((r) => r.checked).map((r) => r.value));
        eq("R5-23b · the EXISTING value is pre-selected (an import never overwrites on autopilot)", checked, ["existing"]);
        const noConflictRow = await page.evaluate(() =>
          document.querySelector('.imp-conf-cell[data-i="0"]').closest("tr").classList.contains("hidden"));
        ok("R5-23b · a row with nothing in dispute shows no expander", noConflictRow === true);
        await page.click('.imp-conf-radio[data-i="1"][data-field="email"][value="incoming"]');
      }

      await page.click("#import-save-btn");
      await page.waitForTimeout(1500);
      const ruby = (await clientsNamed(page, "Sinclair"))[0];
      const summary = await previewText(page);
      if (keep === "incoming") {
        eq("R5-23b · choosing the incoming value updates her record", ruby.email, "ruby.newjob@example.com");
        ok("R5-23b · the result panel names the value that was discarded",
          /discarded ruby\.sinclair@example\.com/.test(summary), JSON.stringify(summary));
      } else {
        eq("R5-23b · choosing existing leaves her record alone", ruby.email, "ruby.sinclair@example.com");
        ok("R5-23b · the result panel still names the incoming value that was discarded",
          /discarded ruby\.newjob@example\.com/.test(summary), JSON.stringify(summary));
      }
      ok("R5-23b · the headline counts the resolved conflict", /1 field conflict resolved/i.test(summary), JSON.stringify(summary.split("\n")[0]));
      eq("no console errors", page.__err || [], []);
      await page.close();
    }

    /* ===================================================================
       4 · R5-10 — near-match at lead accept
       =================================================================== */
    console.log("\n— R5-10 · accepting a lead asks about the client we already hold (p1 Kim)");
    /* R76 · B3 — joint accept now goes through ONE house overlay (#lead-joint-overlay), not the
       prompt/confirm chain: the Ashworths are a JOINT enquiry, so the did-you-mean question this
       section pins is asked as a radio candidate list inside that overlay ("Attach to Deborah
       Ashworth — same name, different contact details" vs "Create a new client"). The FACTS under
       test are unchanged — the different email no longer hides the client we hold, what matched
       is stated, attaching creates no client, declining creates exactly one and Data Health still
       flags the pair. Non-joint accepts keep the native confirms (section 4b below, untouched). */
    for (const attach of [true, false]) {
      const page = await newPage(browser, "p1");
      const beforeCount = await page.evaluate(async () => (await window.__mockDb.from("clients").select("id")).data.length);
      const leadId = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("leads").select("id,name").eq("status", "new");
        return (data.find((l) => /Ashworth/.test(l.name)) || {}).id;
      });
      ok("fixture · the Ashworth lead is waiting", !!leadId);
      await page.evaluate((id) => { window.acceptLead(id); }, leadId);
      await page.waitForTimeout(1500);

      const overlay = await page.evaluate(() => ({
        open: !!document.querySelector("#lead-joint-overlay"),
        candText: (document.querySelector("#ljo-candidates") || {}).textContent || "",
        values: [...document.querySelectorAll('#lead-joint-overlay input[name="ljo-pick"]')].map((r) => r.value),
      }));
      ok("R5-10 · the lead's DIFFERENT email no longer hides the client we hold — it asks",
        overlay.open && overlay.values.includes("cl003"), JSON.stringify(overlay.values));
      ok("R5-10 · it says what matched and what each answer will do",
        /Attach to Deborah Ashworth — same name, different contact details/.test(overlay.candText)
        && /deborah\.ashworth@example\.com/.test(overlay.candText)
        && /Create a new client/.test(overlay.candText), overlay.candText);
      await page.evaluate((pick) => {
        document.querySelector(`#lead-joint-overlay input[name="ljo-pick"][value="${pick}"]`).checked = true;
      }, attach ? "cl003" : "__new__");
      await page.click("#ljo-ok");
      await page.waitForTimeout(1800);

      const landed = await page.evaluate(async (id) => {
        const { data: leads } = await window.__mockDb.from("leads").select("*").eq("id", id);
        const { data: cs } = await window.__mockDb.from("cases").select("id,client_id").eq("id", leads[0].converted_case_id);
        const { data: cl } = await window.__mockDb.from("clients").select("*").eq("id", cs[0].client_id);
        return { client: cl[0] };
      }, leadId);
      const afterCount = await page.evaluate(async () => (await window.__mockDb.from("clients").select("id")).data.length);

      if (attach) {
        eq("R5-10 · accepting attaches the case to cl003", landed.client.id, "cl003");
        eq("R5-10 · and creates no new client", afterCount - beforeCount, 0);
      } else {
        ok("R5-10 · declining creates the new client anyway", landed.client.id !== "cl003" && landed.client.email === "d.m.ashworth@example.com",
          JSON.stringify(landed.client));
        eq("R5-10 · exactly one client was created", afterCount - beforeCount, 1);
        const flagged = await page.evaluate(async (newId) => {
          const { data } = await window.__mockDb.rpc("find_duplicate_clients", {});
          return (data || []).filter((p) => p.a_id === newId || p.b_id === newId).map((p) => p.reason);
        }, landed.client.id);
        ok("R5-10 · Data Health still flags the pair (existing behaviour, unchanged)", flagged.includes("same name"), JSON.stringify(flagged));
      }
      eq("no console errors", page.__err || [], []);
      await page.close();
    }

    /* ===================================================================
       4b · R5-10 — the exact paths still behave as they did
       =================================================================== */
    console.log("\n— R5-10 · exact matches keep the old wording and the old outcome (p1 Kim)");
    {
      const page = await newPage(browser, "p1");
      const ids = await page.evaluate(async () => {
        const mk = async (row) => (await window.__mockDb.from("leads").insert(row).select().single()).data.id;
        return {
          byEmail: await mk({ name: "Duncan Armitage", email: "duncan.armitage@example.com", phone: null, enquiry_type: "remortgage", status: "new" }),
          byPhone: await mk({ name: "D Armitage", email: "duncan.works@example.com", phone: "+44 7700 900102", enquiry_type: "remortgage", status: "new" }),
        };
      });
      await page.evaluate((id) => window.acceptLead(id), ids.byEmail);
      await page.waitForTimeout(1200);
      let msgs = page.__dialogs.filter((d) => d.type === "confirm").map((d) => d.message);
      ok("R5-10 · a same-email lead still says “A client already exists”, naming what matched",
        msgs.some((m) => /A client already exists: Duncan Armitage/.test(m) && /matched on same email address/.test(m)), JSON.stringify(msgs));

      page.__dialogs.length = 0;
      await page.evaluate((id) => window.acceptLead(id), ids.byPhone);
      await page.waitForTimeout(1200);
      msgs = page.__dialogs.filter((d) => d.type === "confirm").map((d) => d.message);
      ok("R5-10 · a lead WITH an email but a known phone number is now caught too (it used to be missed)",
        msgs.some((m) => /matched on same phone number/.test(m)), JSON.stringify(msgs));
      const armitages = await clientsNamed(page, "Armitage");
      eq("R5-10 · both accepts attached to the one existing record", armitages.length, 1);
      eq("no console errors", page.__err || [], []);
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (_) {} }
  }

  console.log(`\nBATCH 7: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
