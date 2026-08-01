#!/usr/bin/env node
/* =============================================================================
   tests/r8_rev.js — acceptance tests for ROUND 8, the REVOLUTION SYNC.

   The weekly Stonebridge `client_data_export_V2` is read FROM Revolution (the
   book of record) INTO this system. Five properties are under test, and every
   one of them is a "did it write the right thing" property, not a "did it draw
   a table" one:

     R8R-1  HEADER MAPPING BY NAME. All 57 columns of the sample are accounted
            for — mapped, recognised-but-unstorable, or ignored — the mapping
            survives the columns being shuffled, it recognises the documented
            synonyms (Surname/Last Name, Initial Term Expiry Date/Rate End
            Date, Taken Protection/Protection Sold), and a correction is
            remembered for next week.
     R8R-2  THE TWELVE VERDICTS. 6 exact + 1 exact-with-a-conflict, 2 to
            review, 2 new, 1 quarantined — recomputed here from the fixture
            tables and the CSV directly, never from app.js's own idea of them.
     R8R-3  THE DIFF. Blank → UPDATE, disagreement → KEEP and highlighted, and
            a completion date locked to the stage decision it belongs to.
     R8R-4  APPLY WRITES EXACTLY THE CONFIRMED SET. The kept value stays kept,
            the filled values land, a sync note is written on every touched
            case, NO email is queued and NO stage moves — and a second run of
            the same file writes nothing at all (idempotent).
     R8R-5  MONEY + ROLES. Owner and adviser and administrator can all use the
            importer (it is staff work), but the fee columns follow the same
            rule as the CSV exports: Owner always, adviser on their own case,
            Administrator never — and what is not shown is not written.

   THE FIXTURE. tests/fixtures/revolution_sample.csv is static and the mock's
   book is generated relative to "now", so only the names and the seven fixed
   DOBs are guaranteed to line up (FIXTURES-R7.md § 4). Two cases that DO
   overlap the file are seeded on demand by
   `window.__mock.seedRevolutionCases()` — an append-only hook that inserts
   nothing unless a test calls it, so no other suite's counts move.

   Run:  node /root/nx/tests/r8_rev.js   (expects a static server on 8099;
                                          starts one itself if absent)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const SETTLE = 1500;
const CSV_PATH = `${REPO}/tests/fixtures/revolution_sample.csv`;
const CSV = fs.readFileSync(CSV_PATH, "utf8");

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

/* ---------------------------------------------------------------------------
   GROUND TRUTH — the CSV, parsed here, by a parser written separately from
   app.js's. Everything this suite expects about a row is derived from THIS,
   plus the fixture tables read straight out of the mock.
   ------------------------------------------------------------------------ */
function csvSplit(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
const CSV_LINES = CSV.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
const CSV_HEADERS = csvSplit(CSV_LINES[0]);
const CSV_ROWS = CSV_LINES.slice(1).map(csvSplit);
const col = (name) => CSV_HEADERS.indexOf(name);
const cell = (r, name) => (CSV_ROWS[r][col(name)] || "").trim();
const ukIso = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const rowName = (r) => [cell(r, "First Name"), cell(r, "Surname")].filter(Boolean).join(" ");

async function newPage(browser, persona, viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  page.__dialogs = [];
  page.on("dialog", async (d) => { page.__dialogs.push(d.message()); await d.accept(); });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
/* Load the sample into the Revolution panel and read it. `seed` inserts the two
   overlapping cases first (they must exist before the panel reads the book). */
async function loadSample(page, opts = {}) {
  const seeded = await page.evaluate(async ({ csv, seed, text }) => {
    const ids = seed ? window.__mock.seedRevolutionCases() : [];
    window.nav("import");
    document.querySelector("#rev-text").value = text || csv;
    await window.__rev.read();
    return ids;
  }, { csv: CSV, seed: !!opts.seed, text: opts.text || null });
  await page.waitForTimeout(300);
  return seeded;
}
const revRows = (page) => page.evaluate(() => window.__rev.rows());
const revMap = (page) => page.evaluate(() => window.__rev.mapping());
const counts = (page) => page.evaluate(() => {
  const c = window.__mock.counts();
  return { clients: c.clients, cases: c.cases, notes: c.case_notes, emails: c.email_queue, sms: c.sms_queue };
});

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {

    /* ===================================================================
       1 · R8R-1 — THE HEADER MAPPING
       =================================================================== */
    {
      console.log("\n— R8R-1 · header recognition (by name, never by position)");
      const page = await newPage(browser, "p1");
      await loadSample(page);
      const map = await revMap(page);

      eq("every column in the file appears in the mapping exactly once", map.length, CSV_HEADERS.length);
      eq("the sample really is 57 columns", CSV_HEADERS.length, 57);
      eq("the mapping is in the file's own order", map.map((m) => m.header), CSV_HEADERS);
      const buckets = map.reduce((a, m) => { a[m.bucket] = (a[m.bucket] || 0) + 1; return a; }, {});
      eq("all 57 are accounted for — mapped, not-stored, or ignored",
        (buckets.mapped || 0) + (buckets.unstored || 0) + (buckets.ignored || 0), 57);
      ok("no column is left in an unknown state", map.every((m) => ["mapped", "unstored", "ignored"].includes(m.bucket)));
      ok("every not-stored / ignored column says WHY", map.filter((m) => m.bucket !== "mapped").every((m) => (m.why || "").length > 10));
      ok("no two columns claim the same field",
        new Set(map.filter((m) => m.key).map((m) => m.key)).size === map.filter((m) => m.key).length);

      const keyOf = (h) => (map.find((m) => m.header === h) || {}).key;
      const bucketOf = (h) => (map.find((m) => m.header === h) || {}).bucket;
      eq("Initial Term Expiry Date → rate_end_date (not term_years)", keyOf("Initial Term Expiry Date"), "rate_end_date");
      eq("Term Years → term_years", keyOf("Term Years"), "term_years");
      eq("ERC End Date → erc_end_date", keyOf("ERC End Date"), "erc_end_date");
      eq("Surname → last_name", keyOf("Surname"), "last_name");
      eq("Date of Birth → date_of_birth", keyOf("Date of Birth"), "date_of_birth");
      eq("Initial Rate % → rate_percent", keyOf("Initial Rate %"), "rate_percent");
      eq("Reversion Rate % is NOT read as the rate", bucketOf("Reversion Rate %"), "unstored");
      eq("Taken Protection → protection_status", keyOf("Taken Protection"), "protection_status");
      eq("Protection Commission → protection_commission", keyOf("Protection Commission"), "protection_commission");
      eq("Protection Premium is not stored (it is not the commission)", bucketOf("Protection Premium (Monthly)"), "unstored");
      eq("Home Insurance → gi_status", keyOf("Home Insurance"), "gi_status");
      eq("Income Protection is not read as the life policy", bucketOf("Income Protection"), "unstored");
      eq("Adviser FCA Ref is not read as the adviser", bucketOf("Adviser FCA Ref"), "unstored");
      eq("Fee Status → fee_status (not the broker fee)", keyOf("Fee Status"), "fee_status");
      eq("Broker Fee → broker_fee", keyOf("Broker Fee"), "broker_fee");
      eq("Case Status → stage", keyOf("Case Status"), "stage");
      eq("Home Telephone is not stored — it is a duplicate of the mobile column", bucketOf("Home Telephone"), "unstored");
      ok("…and it says so", /duplicate/i.test((map.find((m) => m.header === "Home Telephone") || {}).why || ""));

      // The Consumer Duty column with nowhere to land is named, loudly.
      const vuln = map.find((m) => m.header === "Vulnerable Customer");
      eq("Vulnerable Customer is recognised but not stored", vuln.bucket, "unstored");
      ok("…and the reason says there is no field for it", /no vulnerable-customer flag/i.test(vuln.why), vuln.why);

      // The screen says it too, in the operator's own words.
      const summary = await page.$eval("#rev-map-summary", (e) => e.textContent.replace(/\s+/g, " "));
      ok("the mapping summary states all three counts", /57 column/.test(summary) && /mapped/.test(summary) && /not stored/.test(summary), summary);
      const nostore = await page.$eval("#rev-preview", (e) => e.textContent);
      ok("the preview lists the not-stored columns by name", nostore.includes("Protection Premium (Monthly)") && nostore.includes("Not stored (no field here)"));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       2 · R8R-1b — POSITION INDEPENDENCE + SYNONYMS
       =================================================================== */
    {
      console.log("\n— R8R-1b · the columns can move, and can be called something else");
      const page = await newPage(browser, "p1");
      // Same file, columns reversed. If anything read by position, this breaks.
      const rev = [CSV_HEADERS.slice().reverse().join(",")]
        .concat(CSV_ROWS.map((r) => r.slice().reverse().map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")))
        .join("\n");
      await loadSample(page, { text: rev });
      const map = await revMap(page);
      const keyOf = (h) => (map.find((m) => m.header === h) || {}).key;
      eq("reversed file: same number of columns", map.length, 57);
      eq("reversed file: Initial Term Expiry Date still → rate_end_date", keyOf("Initial Term Expiry Date"), "rate_end_date");
      eq("reversed file: Surname still → last_name", keyOf("Surname"), "last_name");
      const rows = await revRows(page);
      eq("reversed file: the same 12 rows, with the same names", rows.map((r) => r.name), CSV_ROWS.map((_, i) => rowName(i) || "(no name)"));
      eq("reversed file: the same verdicts", rows.map((r) => r.match).join(","),
        "exact,exact,exact,exact,exact,exact,review,review,new,new,exact,quarantine");

      // The synonyms FIXTURES-R7.md § 4 names explicitly.
      const renamed = CSV_LINES.slice();
      renamed[0] = renamed[0]
        .replace("Initial Term Expiry Date", "Rate End Date")
        .replace("Surname", "Last Name")
        .replace("Taken Protection", "Protection Sold")
        .replace("Mobile Number", "Contact Number")
        .replace("Completion Date", "Date Completed");
      await loadSample(page, { text: renamed.join("\n") });
      const map2 = await revMap(page);
      const k2 = (h) => (map2.find((m) => m.header === h) || {}).key;
      eq("synonym: Rate End Date → rate_end_date", k2("Rate End Date"), "rate_end_date");
      eq("synonym: Last Name → last_name", k2("Last Name"), "last_name");
      eq("synonym: Protection Sold → protection_status", k2("Protection Sold"), "protection_status");
      eq("synonym: Contact Number → phone", k2("Contact Number"), "phone");
      eq("synonym: Date Completed → completed_date", k2("Date Completed"), "completed_date");
      const rows2 = await revRows(page);
      eq("renamed headers produce the same verdicts", rows2.map((r) => r.match).join(","),
        "exact,exact,exact,exact,exact,exact,review,review,new,new,exact,quarantine");

      // A column nobody has ever seen is ignored, and still counted.
      const extra = CSV_LINES.slice();
      extra[0] = extra[0] + ",Stonebridge Widget Code";
      for (let i = 1; i < extra.length; i++) extra[i] = extra[i] + ",WGT-" + i;
      await loadSample(page, { text: extra.join("\n") });
      const map3 = await revMap(page);
      eq("an unrecognised column is counted", map3.length, 58);
      eq("…and ignored", (map3.find((m) => m.header === "Stonebridge Widget Code") || {}).bucket, "ignored");
      ok("…and says it is not recognised", /not recognised/i.test((map3.find((m) => m.header === "Stonebridge Widget Code") || {}).why || ""));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       3 · R8R-1c — THE MAPPING IS REMEMBERED FOR NEXT WEEK
       =================================================================== */
    {
      console.log("\n— R8R-1c · a correction is remembered (and honestly labelled)");
      const page = await newPage(browser, "p1");
      await page.evaluate(() => window.__rev.forgetMap());
      await loadSample(page);
      const before = (await revMap(page)).find((m) => m.header === "Notes");
      eq("Notes maps to the case note by default", before.key, "note");
      // Correct it through the UI, exactly as the operator would.
      const idx = CSV_HEADERS.indexOf("Notes");
      await page.selectOption(`.rev-map-sel[data-h="${idx}"]`, "");
      await page.waitForTimeout(400);
      const after = (await revMap(page)).find((m) => m.header === "Notes");
      eq("the correction takes effect immediately", after.key, null);
      ok("…and is marked as remembered", after.remembered === true);

      // A RELOAD is the test: same browser, same user, next week's file.
      await page.reload();
      await page.waitForTimeout(SETTLE);
      await loadSample(page);
      const later = (await revMap(page)).find((m) => m.header === "Notes");
      eq("after a reload the correction is still there", later.key, null);
      ok("…and the row still says it was remembered", later.remembered === true);
      const badge = await page.$eval(`tr[data-h="${idx}"]`, (e) => e.textContent);
      ok("…and the screen shows a “remembered” badge on that column", /remembered/i.test(badge));
      const summary = await page.$eval("#rev-map-summary", (e) => e.textContent);
      ok("the screen says the memory is per-browser, not shared", /this browser/i.test(summary));

      // It genuinely changes what is read: no file note reaches the sync note.
      const seeded = await page.evaluate(() => window.__mock.seedRevolutionCases());
      await loadSample(page);
      await page.evaluate(() => window.__rev.apply());
      await page.waitForTimeout(600);
      const noteBodies = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("case_notes").select("body").eq("case_id", id);
        return (data || []).map((n) => n.body);
      }, seeded[0]);
      ok("the ignored Notes column really is not read — no “File note” in the sync note",
        noteBodies.some((b) => /^Revolution sync/.test(b)) && !noteBodies.some((b) => /File note/.test(b)),
        JSON.stringify(noteBodies));
      await page.evaluate(() => window.__rev.forgetMap());
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       4 · R8R-2 — THE TWELVE VERDICTS, recomputed here
       =================================================================== */
    {
      console.log("\n— R8R-2 · the twelve rows");
      const page = await newPage(browser, "p1");
      const seeded = await loadSample(page, { seed: true });
      const rows = await revRows(page);
      const book = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id,first_name,last_name,email,phone,date_of_birth");
        return data;
      });
      // Independent expectation: name key + DOB, straight off the fixture table.
      const nameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
      const expected = CSV_ROWS.map((_, i) => {
        const nm = rowName(i);
        if (!nm) return "quarantine";
        const dob = ukIso(cell(i, "Date of Birth"));
        const byName = book.filter((c) => nameKey([c.first_name, c.last_name].join(" ")) === nameKey(nm));
        if (byName.length && dob && byName[0].date_of_birth === dob) return "exact";
        const byEmail = book.filter((c) => (c.email || "").toLowerCase() === cell(i, "Email Address").toLowerCase() && cell(i, "Email Address"));
        const byPhone = book.filter((c) => (c.phone || "").replace(/\D/g, "") === cell(i, "Mobile Number").replace(/\D/g, "") && cell(i, "Mobile Number"));
        return (byName.length || byEmail.length || byPhone.length) ? "review" : "new";
      });
      eq("every row's verdict matches the one computed from the fixtures", rows.map((r) => r.match), expected);
      eq("6 rows match on name AND date of birth alone",
        rows.filter((r) => r.match === "exact" && r.reason === "name and date of birth both match" && !r.diffs.some((d) => d.state === "conflict")).length, 6);
      eq("2 rows are held for review", rows.filter((r) => r.match === "review").length, 2);
      eq("2 rows are brand-new clients", rows.filter((r) => r.match === "new").length, 2);
      eq("1 row is quarantined", rows.filter((r) => r.match === "quarantine").length, 1);
      eq("1 row surfaces a field conflict", rows.filter((r) => r.diffs.some((d) => d.state === "conflict")).length, 1);

      const byName2 = (n) => rows.find((r) => r.name === n);
      // The two fuzzy rows, and WHY each is fuzzy rather than a match.
      ok("Meera Chandra is held because the date of birth disagrees",
        /date of birth/i.test(byName2("Meera Chandra").reason), byName2("Meera Chandra").reason);
      ok("Bruce Lindquist is held because the contact details disagree",
        /contact details/i.test(byName2("Bruce Lindquist").reason), byName2("Bruce Lindquist").reason);
      eq("a row held for review is not included in the write", [byName2("Meera Chandra").included, byName2("Bruce Lindquist").included], [false, false]);
      eq("…and it would write nothing", [byName2("Meera Chandra").writes.fields, byName2("Bruce Lindquist").writes.fields], [0, 0]);
      ok("the new clients are the two the file says are new",
        rows.filter((r) => r.match === "new").map((r) => r.name).join(",") === "Fergus Ballantyne,Rowena Tasker-Hyde");
      eq("a new row creates a client AND a case", byName2("Fergus Ballantyne").writes.creates, ["client", "case"]);

      // The garbage row: quarantined, with reasons, and nothing offered.
      const junk = rows.find((r) => r.match === "quarantine");
      ok("the garbage row says there is no person in it", /no name/i.test(junk.reason), junk.reason);
      ok("…and names the unreadable date", junk.problems.some((p) => /#N\/A/.test(p)), JSON.stringify(junk.problems));
      eq("…and is not included in the write", junk.included, false);
      const qText = await page.$eval("#rev-quarantine", (e) => e.textContent);
      ok("…and it is listed on screen as needing attention", /needs attention/i.test(qText) && /#N\/A/.test(qText));
      const qCount = await page.$$eval("#rev-quarantine-rows tr[data-i]", (els) => els.length);
      eq("one row in the needs-attention table", qCount, 1);

      // The DOM says the same thing as the hook.
      const domVerdicts = await page.$$eval("#rev-rows tr.rev-row", (els) => els.map((e) => e.dataset.v));
      eq("the screen shows the same verdicts", domVerdicts, rows.filter((r) => r.match !== "quarantine").map((r) => r.match));
      const conflictRows = await page.$$eval('#rev-rows tr.rev-row[data-conflict="1"]', (els) => els.length);
      eq("exactly one row is flagged as conflicting on screen", conflictRows, 1);
      const highlighted = await page.$$eval("#rev-rows tr.rev-conflict", (els) => els.map((e) => e.dataset.f));
      eq("…and the conflicting field is highlighted", highlighted, ["rate_end_date"]);
      ok("the seeded overlap really was two cases", seeded.length === 2);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       5 · R8R-3 — CASE MATCHING AND THE DIFF
       =================================================================== */
    {
      console.log("\n— R8R-3 · same mortgage / candidate-new, and the field diff");
      const page = await newPage(browser, "p4");           // Owner: money visible
      const seeded = await loadSample(page, { seed: true });
      const rows = await revRows(page);
      const byName2 = (n) => rows.find((r) => r.name === n);

      const w = byName2("James Whitfield");
      eq("Whitfield matches the case with the same lender and rate end", [w.caseVerdict, w.caseId], ["same", seeded[0]]);
      const n = byName2("Nigel Trewin");
      eq("Trewin matches the case with the same lender 59 days away", [n.caseVerdict, n.caseId], ["same", seeded[1]]);
      const p = byName2("Priya Nadkarni");
      eq("a row whose lender we do not hold is a CANDIDATE new case", p.caseVerdict, "new");
      ok("…and it says which lenders we DO hold for her", /no case with this lender/i.test(p.caseReason || ""), p.caseReason);

      const d = (r, k) => r.diffs.find((x) => x.key === k) || {};
      eq("a blank field defaults to UPDATE", [d(w, "erc_end_date").state, d(w, "erc_end_date").choice], ["fill", "update"]);
      eq("…and so does a protection status still sitting at “not discussed”",
        [d(w, "protection_status").state, d(w, "protection_status").choice], ["fill", "update"]);
      eq("a field that agrees is no change at all", d(w, "rate_end_date").state, "same");
      eq("a field that DISAGREES defaults to KEEP", [d(n, "rate_end_date").state, d(n, "rate_end_date").choice], ["conflict", "keep"]);
      eq("…and it is the rate end the file moved", [d(n, "rate_end_date").held, d(n, "rate_end_date").incoming], ["2031-01-31", "2031-03-31"]);
      eq("a case stage the file would move is offered, not taken", n.stageMove, { from: "application", to: "completed", accepted: false });
      eq("…and the completion date is locked to that decision", d(n, "completed_date").choice, "keep");
      const locked = await page.$eval(`#rev-preview`, (e) => e.textContent);
      ok("…and the screen says why it is locked", /tied to the stage decision/i.test(locked));

      // Ticking the stage unlocks the completion date that belongs to it.
      await page.click(`.rev-stage-ok[data-i="${n.i}"]`);
      await page.waitForTimeout(300);
      const n2 = (await revRows(page)).find((r) => r.name === "Nigel Trewin");
      eq("ticking the stage move unlocks the completion date", (n2.diffs.find((x) => x.key === "completed_date") || {}).choice, "update");
      eq("…and the stage move is now accepted", n2.stageMove.accepted, true);
      await page.click(`.rev-stage-ok[data-i="${n.i}"]`);
      await page.waitForTimeout(300);
      const n3 = (await revRows(page)).find((r) => r.name === "Nigel Trewin");
      eq("unticking it locks the completion date again", (n3.diffs.find((x) => x.key === "completed_date") || {}).choice, "keep");

      // The client-side diff: the file's fuller address is not a "conflict".
      const cd = (r, k) => r.clientDiffs.find((x) => x.key === k) || {};
      eq("the same address written more fully is an extension, not a conflict",
        [cd(w, "address").state, cd(w, "address").choice], ["extend", "update"]);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       6 · R8R-4 — APPLY WRITES EXACTLY WHAT WAS CONFIRMED
       =================================================================== */
    {
      console.log("\n— R8R-4 · apply, the notes, the silence, and idempotency");
      const page = await newPage(browser, "p4");
      const seeded = await loadSample(page, { seed: true });
      const before = await counts(page);
      const preRows = await revRows(page);
      const plannedFields = preRows.reduce((a, r) => a + r.writes.fields, 0);
      const meera = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("clients").select("id,date_of_birth,email").eq("first_name", "Meera").single();
        return data;
      });

      await page.evaluate(() => window.__rev.apply());
      await page.waitForTimeout(900);
      const after = await counts(page);

      eq("two clients were created — the two the file says are new", after.clients - before.clients, 2);
      eq("seven cases were created — one per candidate-new row", after.cases - before.cases, 7);
      eq("NOTHING was queued to email", after.emails, before.emails);
      eq("NOTHING was queued to SMS", after.sms, before.sms);

      const state = await page.evaluate(async ([w, n]) => {
        const db = window.__mockDb;
        const one = async (id) => (await db.from("cases").select("*").eq("id", id).single()).data;
        const notes = (await db.from("case_notes").select("case_id,body").ilike("body", "Revolution sync%")).data || [];
        const { data: clients } = await db.from("clients").select("first_name,last_name,date_of_birth,address,email");
        return { w: await one(w), n: await one(n), notes, clients };
      }, seeded);

      // The row with everything blank: every blank filled, nothing else touched.
      eq("the blank ERC end date was filled from the file", state.w.erc_end_date, "2027-05-31");
      eq("the protection outcome was filled", state.w.protection_status, "policy_taken");
      eq("the GI outcome was filled", state.w.gi_status, "policy_taken");
      eq("the lead source was filled", state.w.lead_source, "Google");
      eq("the broker fee was filled (the Owner may see and write it)", state.w.broker_fee, 495);
      eq("the rate end that already agreed is untouched", state.w.rate_end_date, "2027-05-31");
      eq("the stage was not touched", state.w.stage, "completed");

      // The conflict row: KEEP means KEEP.
      eq("the conflicting rate end was KEPT, exactly as the row defaulted", state.n.rate_end_date, "2031-01-31");
      eq("…while the blank ERC date beside it was filled", state.n.erc_end_date, "2031-03-31");
      eq("the stage was NOT moved, because nobody ticked it", state.n.stage, "application");
      eq("…and no completion date was written onto a live case", state.n.completed_at, null);

      // The sync note — the audit trail, and the thing the stamp reads back.
      const wNote = state.notes.filter((x) => x.case_id === seeded[0]).map((x) => x.body)[0] || "";
      const nNote = state.notes.filter((x) => x.case_id === seeded[1]).map((x) => x.body)[0] || "";
      ok("every touched case carries a “Revolution sync <date>” note", /^Revolution sync \d/.test(wNote) && /^Revolution sync \d/.test(nNote), wNote);
      ok("…and the note names what it filled", /filled ERC end date \(31 May 2027\)/.test(wNote), wNote);
      ok("…and carries the file's own note", /File note: Client happy to be contacted/.test(wNote), wNote);
      ok("the kept conflict is NOT reported as an update", !/updated rate end/i.test(nNote), nNote);
      eq("one sync note per touched case, no more", state.notes.length, 9);
      eq("the note count moved by exactly that", after.notes - before.notes, 9);

      // The rows held for review wrote nothing at all.
      const meeraAfter = state.clients.find((c) => c.first_name === "Meera");
      eq("the client held for review was not touched", meeraAfter.date_of_birth, meera.date_of_birth);
      ok("the new clients landed with their date of birth and address",
        state.clients.some((c) => c.last_name === "Ballantyne" && c.date_of_birth === "1984-10-26" && /Wharfdale/.test(c.address || "")));

      // The per-row outcome log.
      const log = await page.$$eval("#rev-outcome tr[data-row]", (els) => els.map((e) => e.dataset.row + "=" + e.dataset.outcome));
      eq("every row of the file has an outcome line", log.length, 12);
      ok("the matched-with-updates row reports its field count", /^1=updated \d+ fields?$/.test(log[0]), log[0]);
      eq("the two review rows are reported as skipped", log.slice(6, 8), ["7=skipped — nothing confirmed", "8=skipped — nothing confirmed"]);
      ok("the new-client rows say so", /created client \+ case/.test(log[8]) && /created client \+ case/.test(log[9]));
      ok("the garbage row is reported as quarantined", /quarantined/.test(log[11]), log[11]);
      const resultText = await page.$eval("#rev-result", (e) => e.textContent);
      ok("the result panel states that nothing was emailed", /0 emails were queued/.test(resultText));
      ok("…and that no stage was moved", /No case stage was moved/.test(resultText));

      // "Last import" now reads off the sync's own notes — shared, not per-browser.
      const stamp = await page.evaluate(() => window.__rev.lastSync());
      eq("the last-import stamp comes from the shared sync notes", stamp.shared, true);
      const stampText = await page.$eval("#rev-lastsync", (e) => e.textContent);
      ok("…and the screen says everyone sees the same date", /everyone sees the same date/i.test(stampText), stampText);

      /* ---- IDEMPOTENCY: the same file again writes nothing ---- */
      await loadSample(page);
      const again = await revRows(page);
      eq("re-reading the same file finds every row matched or held", again.map((r) => r.match).join(","),
        "exact,exact,exact,exact,exact,exact,review,review,exact,exact,exact,quarantine");
      eq("…every matched row now points at the case the first run created/updated",
        again.filter((r) => r.match === "exact").every((r) => r.caseVerdict === "same"), true);
      eq("…and not one of them would write anything", again.reduce((a, r) => a + r.writes.fields, 0), 0);
      eq("…and not one of them would create anything", again.reduce((a, r) => a + r.writes.creates.length, 0), 0);
      ok("the first run really did have work to do (so this is not a vacuous pass)", plannedFields > 0, String(plannedFields));
      await page.evaluate(() => window.__rev.apply());
      await page.waitForTimeout(700);
      const third = await counts(page);
      eq("pressing Apply a second time changes nothing", third, after);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       7 · R8R-4b — RESOLVING A REVIEW ROW, AND OVERRIDING A CONFLICT
       =================================================================== */
    {
      console.log("\n— R8R-4b · the decisions a human makes on the screen");
      const page = await newPage(browser, "p4");
      const seeded = await loadSample(page, { seed: true });
      const rows = await revRows(page);
      const bruce = rows.find((r) => r.name === "Bruce Lindquist");
      const before = await counts(page);

      // Attach the fuzzy row to the candidate the screen offered.
      await page.click(`.rev-attach[data-i="${bruce.i}"]`);
      await page.waitForTimeout(300);
      const bruce2 = (await revRows(page)).find((r) => r.name === "Bruce Lindquist");
      ok("attaching a review row resolves it to that client", !!bruce2.clientId);
      eq("…and it is now included in the write", bruce2.included, true);
      ok("…and it now has a case verdict of its own", ["same", "new"].includes(bruce2.caseVerdict));

      // Override the conflict the other way: KEEP → UPDATE.
      const nigel = rows.find((r) => r.name === "Nigel Trewin");
      await page.evaluate((i) => window.__rev.setChoice(i, "rate_end_date", "update"), nigel.i);
      await page.waitForTimeout(200);
      await page.evaluate(() => window.__rev.apply());
      await page.waitForTimeout(900);
      const out = await page.evaluate(async ([n, email]) => {
        const db = window.__mockDb;
        const c = (await db.from("cases").select("rate_end_date,stage").eq("id", n).single()).data;
        const note = ((await db.from("case_notes").select("body").eq("case_id", n)).data || []).map((x) => x.body).find((b) => /^Revolution sync/.test(b));
        const bruceRow = (await db.from("clients").select("id,email,date_of_birth").eq("email", email).single()).data;
        return { c, note, bruceRow };
      }, [seeded[1], "bruce.lindquist@example.com"]);
      eq("choosing UPDATE on a conflict writes the file's value", out.c.rate_end_date, "2031-03-31");
      eq("…and still does not move the stage", out.c.stage, "application");
      ok("…and the note says what it changed, both sides of the arrow",
        /updated rate end date \(31 Jan 2031 → 31 Mar 2031\)/.test(out.note || ""), out.note);
      ok("the attached client kept the email we hold (the file's differs and nobody chose it)",
        out.bruceRow.email === "bruce.lindquist@example.com");
      eq("…but the date of birth we did NOT hold was filled from the file", out.bruceRow.date_of_birth, "1963-05-03");
      const after = await counts(page);
      eq("still nothing emailed", after.emails, before.emails);
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       8 · R8R-5 — MONEY, AND WHO MAY RUN IT
       =================================================================== */
    {
      console.log("\n— R8R-5 · the fee columns follow the money rule");
      // Administrator: import is staff work, but firm money is not admin money.
      const admin = await newPage(browser, "p1");
      const seededA = await loadSample(admin, { seed: true });
      ok("an Administrator can reach the Revolution sync", await admin.$eval("#rev-input-panel", (e) => !!e));
      const wA = (await revRows(admin)).find((r) => r.name === "James Whitfield");
      const dA = (k) => wA.diffs.find((x) => x.key === k) || {};
      eq("an Administrator is not offered the proc fee", dA("proc_fee").state, "money");
      eq("…nor the broker fee", dA("broker_fee").state, "money");
      eq("…nor the protection commission", dA("protection_commission").state, "money");
      eq("…and non-money fields are still theirs to apply", dA("erc_end_date").choice, "update");
      await admin.evaluate(() => window.__rev.apply());
      await admin.waitForTimeout(900);
      const aState = await admin.evaluate(async (id) => (await window.__mockDb.from("cases").select("broker_fee,proc_fee,protection_commission,erc_end_date").eq("id", id).single()).data, seededA[0]);
      eq("what is not shown is not written — the broker fee is untouched", aState.broker_fee, null);
      eq("…and so is the proc fee", aState.proc_fee, null);
      eq("…and so is the protection commission", aState.protection_commission, null);
      eq("…while the rest of the row landed normally", aState.erc_end_date, "2027-05-31");
      const aText = await admin.$eval("#rev-result", (e) => e.textContent);
      ok("…and the result says the fee columns were left alone", /fee columns were not written/i.test(aText), aText);
      ok("no console errors (admin)", !admin.__err, JSON.stringify(admin.__err));
      await admin.close();

      // Adviser: their OWN case's money, and nobody else's.
      const wayne = await newPage(browser, "p2");          // Wayne Kellow — holds the Whitfield case
      await loadSample(wayne, { seed: true });
      const rowsW = await revRows(wayne);
      const own = rowsW.find((r) => r.name === "James Whitfield");
      const other = rowsW.find((r) => r.name === "Nigel Trewin");   // assigned to Luke
      eq("an adviser may fill the fee on their own case", (own.diffs.find((x) => x.key === "broker_fee") || {}).state, "fill");
      eq("…and may not on a colleague's", (other.diffs.find((x) => x.key === "broker_fee") || {}).state, "money");
      eq("…and a case they are about to create is theirs", ((rowsW.find((r) => r.name === "Fergus Ballantyne").diffs.find((x) => x.key === "broker_fee")) || {}).state, "fill");
      ok("an adviser can run the sync at all", await wayne.$eval("#rev-read-btn", (e) => !e.disabled));
      ok("no console errors (adviser)", !wayne.__err, JSON.stringify(wayne.__err));
      await wayne.close();
    }

    /* ===================================================================
       9 · VIEWPORTS — 390 and 1280 clean
       =================================================================== */
    {
      console.log("\n— R8R · 390 / 1280 clean");
      for (const [w, h, tag] of [[390, 844, "390"], [1280, 800, "1280"]]) {
        const page = await newPage(browser, "p4", { width: w, height: h });
        await loadSample(page, { seed: true });
        const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
        eq(`no horizontal overflow on the Import page at ${tag}`, m.doc <= m.win, true);
        const applyVisible = await page.$eval("#rev-apply-btn", (e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right <= window.innerWidth + 1);
        ok(`the Apply button is reachable at ${tag}`, applyVisible === true);
        const choiceIn = await page.$$eval(".rev-choice", (els) => els.every((e) => e.getBoundingClientRect().right <= window.innerWidth + 1));
        ok(`every KEEP/UPDATE control is inside the viewport at ${tag}`, choiceIn === true);
        ok(`no console errors at ${tag}`, !page.__err, JSON.stringify(page.__err));
        await page.close();
      }
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r8_rev: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
