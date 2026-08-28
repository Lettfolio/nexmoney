#!/usr/bin/env node
/* =============================================================================
   tests/r64.js — acceptance tests for ROUND 6.4

   Three quality-of-life features and one harness-parity job:

     H-01  NOTE RE-FILE — a note filed on the wrong case is corrected, not moved:
           a prefixed copy on the target case, a "filed in error" marker on the
           source encoding the original note id, the original struck through and
           badged everywhere notes render (including the evidence pack), and
           guards that refuse the four ways this could corrupt a file.
     H-02  The rate-end reminder confirm names the property, in the same
           `Property: <full address>` line the retention confirm has used since
           R6-31.
     H-03  ONE spelling per property — postcode-bearing, then most complete,
           then most recent — read by headings, picker options, chips and the
           canonical case identity alike.
     MOCK  Parity with the backend that deployed today: the retention successor
           carries the property (and names it in its task and its note), the
           composed emails mention it, and parse-offer returns it.

   Run:  node /root/nx/tests/r64.js   (expects a static server on 8099;
                                       starts one itself if absent)
   ========================================================================== */
"use strict";

/* R73 · A3 — THE CASE ACTION BAR IS CAPPED NOW, so a stage action may be one press away.
   The bar was 135px of a 900px desktop viewport and 445px of an 844px phone because every action
   CASE_ACTION_RULES calls primary at a stage sat on it — twelve buttons on a completed case.
   R73 keeps the two or three the stage is actually about on the bar and moves the rest into the
   Actions ▾ menu, under a heading naming the stage; every act-* id is built exactly once, with
   the same label and the same handler, and every one is reachable in at most one extra press.
   Same shape r13 and r5_batch1 have used since R15: find out where the action currently is, open
   the overflow only if that is where it is, then click it exactly as before. */
async function r73OpenAction(page, id) {
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return true;                       // absent: let the click fail as it always would
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, `#${id}`);
  if (!visible) await page.click("#case-more-actions-toggle");
}


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
const lastDialog = (page) => (page.__dialogs.length ? page.__dialogs[page.__dialogs.length - 1].message : "");

/* The two fixture clients this file leans on:
     Melanie Underhill — exactly two cases on two properties (the ordinary
       re-file shape: one obvious wrong case, one obvious right one), assigned
       to p3 so "any staff" is a real question rather than an admin's privilege.
     Ruby Sinclair    — six cases across five properties, two of them on the
       same flat, which is the shape H-03 exists for. */
const findClient = (page, lastName) => page.evaluate(async (ln) => {
  const db = window.__mockDb;
  const { data: cls } = await db.from("clients").select("id,first_name,last_name,email");
  const cl = cls.find((c) => c.last_name === ln);
  const { data: cs } = await db.from("cases").select("id,client_id,stage,case_kind,lender,property_address,rate_end_date,created_at").eq("client_id", cl.id);
  return { client: cl, cases: cs };
}, lastName);

const addNote = (page, caseId, body) => page.evaluate(async ([id, b]) => {
  const { data } = await window.__mockDb.from("case_notes").insert({ case_id: id, body: b }).select("id").single();
  return data.id;
}, [caseId, body]);

const notesOn = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("case_notes").select("id,case_id,body,created_at").eq("case_id", id);
  return data;
}, caseId);

/* Drive one re-file all the way through the UI, from the case modal. */
async function refileFromCaseModal(page, sourceCaseId, noteId, targetCaseId) {
  await page.evaluate((id) => window.openCase(id), sourceCaseId);
  await page.waitForTimeout(900);
  /* R40 — #notes-list is gone; a note is now a .tl-row inside #case-events-list and carries no
     note id itself, but refileBtnHtml still stamps data-note-id on the Re-file button, so that
     stays the reliable way to find the right row's control. */
  await page.click(`#case-events-list .note-refile-btn[data-note-id="${noteId}"]`);
  await page.waitForTimeout(500);
  const options = await page.$$eval("#refile-target option", (els) => els.map((e) => ({ value: e.value, label: e.textContent })));
  await page.selectOption("#refile-target", targetCaseId);
  await page.click("#refile-ok");
  await page.waitForTimeout(1400);
  return options;
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore", detached: true });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       1 · H-01 · THE HAPPY PATH — two rows, a strike and a badge
       =================================================================== */
    console.log("\n— H-01 · re-file happy path (p1 Kim, admin)");
    {
      const page = await newPage(browser, "p1");
      const { client, cases } = await findClient(page, "Underhill");
      const src = cases[0], tgt = cases[1];
      const noteId = await addNote(page, src.id, "Call: chased the valuation today");
      const before = (await notesOn(page, src.id)).length + (await notesOn(page, tgt.id)).length;

      const options = await refileFromCaseModal(page, src.id, noteId, tgt.id);

      /* The picker offers the client's OTHER cases, labelled with the canonical
         property · type · lender · stage, and never the case the note is on. */
      ok("H-01 · the picker offers the client's other case, canonically labelled",
        options.length === 2 && /Owls Rd/.test(options[1].label) && /Buy to Let/.test(options[1].label)
        && /Skipton/.test(options[1].label) && /Application/.test(options[1].label),
        JSON.stringify(options));
      ok("H-01 · GUARD · the source case is never offered as a target (no same-case re-file)",
        !options.some((o) => o.value === src.id), JSON.stringify(options.map((o) => o.value)));

      const srcNotes = await notesOn(page, src.id);
      const tgtNotes = await notesOn(page, tgt.id);
      const after = srcNotes.length + tgtNotes.length;
      eq("H-01 · exactly TWO rows were written (nothing moved, nothing deleted)", after - before, 2);

      const copy = tgtNotes.find((n) => /^Re-filed from /.test(n.body));
      ok("H-01 · the TARGET case carries a copy prefixed with the source case identity",
        !!copy && copy.body === "Re-filed from 22 Ravenscourt Rd · BH6 · Remortgage · Nationwide · Completed: Call: chased the valuation today",
        copy && copy.body);

      const marker = srcNotes.find((n) => /^Filed in error — see /.test(n.body));
      ok("H-01 · the SOURCE case carries a marker naming the target case identity",
        !!marker && /Filed in error — see Flat 1, 5 Owls Rd · BH5 · Buy to Let · Skipton · Application/.test(marker.body),
        marker && marker.body);
      ok("H-01 · …and the marker encodes the source note id, so renderers can match it",
        !!marker && marker.body.endsWith(` [re-filed:${noteId}]`), marker && marker.body);
      ok("H-01 · the original note itself is untouched (a correction, not an edit)",
        srcNotes.some((n) => n.id === noteId && n.body === "Call: chased the valuation today"));

      /* The case modal, repainted by the action itself.
         R40 — #notes-list, .note, .note-refiled and .note-body are gone. The struck original is
         now a .tl-row whose .tl-title carries `<s class="tl-refiled">…</s>` + the badge; the
         marker is a plain .tl-row whose title starts with the marker sentence. Neither .tl-row
         carries the note's own id any more, so rows are found by their known text instead. */
      const rendered = await page.evaluate((nid) => {
        const rows = [...document.querySelectorAll("#case-events-list .tl-row")];
        const struck = rows.find((r) => r.querySelector("s.tl-refiled") && /chased the valuation today/.test(r.querySelector("s.tl-refiled").textContent));
        const marker = rows.find((r) => {
          const t = r.querySelector(".tl-title");
          return t && /^Filed in error — see /.test(t.textContent.trim());
        });
        const plainTitle = (row) => {
          const t = row.querySelector(".tl-title");
          const clone = t.cloneNode(true);
          clone.querySelectorAll(".chip, .note-refile-btn").forEach((n) => n.remove());
          return clone.textContent.trim();
        };
        return {
          refiledClass: !!struck,
          badge: !!(struck && struck.querySelector(".note-refiled-badge")),
          stillReadable: struck ? struck.querySelector("s.tl-refiled").textContent : null,
          noControlOnRefiled: !!(struck && !struck.querySelector(".note-refile-btn")),
          markerText: marker ? plainTitle(marker) : null,
          noControlOnMarker: !!(marker && !marker.querySelector(".note-refile-btn")),
          controlsLeft: document.querySelectorAll("#case-events-list .note-refile-btn").length,
        };
      }, noteId);
      ok("H-01 · case modal · the original renders struck/dimmed (.note-refiled)", rendered.refiledClass, JSON.stringify(rendered));
      ok("H-01 · case modal · …with a “re-filed” badge", rendered.badge, JSON.stringify(rendered));
      eq("H-01 · case modal · …and is still readable underneath the strike", rendered.stillReadable, "chased the valuation today");
      ok("H-01 · case modal · the marker reads plainly, with its machine tag stripped",
        rendered.markerText === "Filed in error — see Flat 1, 5 Owls Rd · BH5 · Buy to Let · Skipton · Application",
        JSON.stringify(rendered.markerText));
      ok("H-01 · GUARD · neither the re-filed note nor the marker offers Re-file again",
        rendered.noControlOnRefiled && rendered.noControlOnMarker, JSON.stringify(rendered));

      /* …and the client's own timeline, which is the other place notes render. */
      await page.evaluate(() => window.closeModal());
      await page.waitForTimeout(400);
      await page.evaluate((cid) => window.openClient(cid), client.id);
      await page.waitForTimeout(1200);
      const tl = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#tl-list .tl-row")].map((r) => r.querySelector(".tl-title").innerHTML);
        return {
          struck: rows.filter((h) => /<s class="tl-refiled">/.test(h)).length,
          badged: rows.filter((h) => /note-refiled-badge/.test(h)).length,
          marker: rows.filter((h) => /Filed in error — see/.test(h)).length,
          copy: rows.filter((h) => /Re-filed from/.test(h)).length,
          tagLeaked: rows.filter((h) => /\[re-filed:/.test(h)).length,
          controls: document.querySelectorAll("#tl-list .note-refile-btn").length,
        };
      });
      ok("H-01 · client timeline · the original is struck and badged there too",
        tl.struck === 1 && tl.badged === 1, JSON.stringify(tl));
      ok("H-01 · client timeline · both the marker and the copy are visible on it",
        tl.marker === 1 && tl.copy === 1, JSON.stringify(tl));
      eq("H-01 · client timeline · the machine tag is never printed", tl.tagLeaked, 0);
      ok("H-01 · client timeline · other notes still offer Re-file", tl.controls > 0, JSON.stringify(tl));

      /* …and the evidence pack, which is the surface a compliance reader gets. */
      const packHtml = await page.evaluate(async (cid) => {
        const orig = window.open;
        let captured = "";
        window.open = () => ({ document: { write: (h) => { captured += h; }, close() {} } });
        try { await window.buildEvidencePack(cid); } finally { window.open = orig; }
        return captured;
      }, cases[0].id);
      ok("H-01 · evidence pack · the re-filed note is struck through",
        /<s style="color:#777;">chased the valuation today<\/s>/.test(packHtml) || /<s style="color:#777;">Call: chased the valuation today<\/s>/.test(packHtml),
        packHtml.slice(packHtml.indexOf("<h2>Notes</h2>"), packHtml.indexOf("<h2>Notes</h2>") + 700));
      ok("H-01 · evidence pack · …and badged [re-filed], so the correction is visible to a reader",
        /\[re-filed\]/.test(packHtml));
      /* The Notes SECTION only. The pack's Change history prints what the audit
         trigger recorded, verbatim and including the machine tag — an audit trail
         that paraphrased what was written would not be an audit trail. */
      const packNotes = packHtml.slice(packHtml.indexOf("<h2>Notes</h2>"), packHtml.indexOf("<h2>Tasks</h2>"));
      ok("H-01 · evidence pack · the marker sentence is printed, without its machine tag",
        /Filed in error — see Flat 1, 5 Owls Rd/.test(packNotes) && !/\[re-filed:/.test(packNotes), packNotes.slice(0, 800));
      ok("H-01 · evidence pack · the audit trail underneath still records the row verbatim, tag and all",
        /\[re-filed:/.test(packHtml.slice(packHtml.indexOf("<h2>Change history</h2>"))));

      ok("H-01 · no page errors during the happy path", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       2 · H-01 · THE GUARDS
       =================================================================== */
    console.log("\n— H-01 · guards");
    {
      const page = await newPage(browser, "p1");
      const { cases } = await findClient(page, "Underhill");
      const src = cases[0], tgt = cases[1];
      const noteId = await addNote(page, src.id, "Meeting: reviewed the ERC position");
      await refileFromCaseModal(page, src.id, noteId, tgt.id);

      const marker = (await notesOn(page, src.id)).find((n) => /^Filed in error/.test(n.body));

      /* A marker is the correction, not the thing corrected. */
      await page.evaluate((id) => window.refileNote(id), marker.id);
      await page.waitForTimeout(600);
      ok("H-01 · GUARD · a “filed in error” marker cannot itself be re-filed",
        /marker, not a note/.test(await toastText(page)), await toastText(page));

      /* Re-filing twice would leave one note with two contradictory markers. */
      await page.evaluate((id) => window.refileNote(id), noteId);
      await page.waitForTimeout(600);
      ok("H-01 · GUARD · an already re-filed note cannot be re-filed again",
        /already been re-filed/.test(await toastText(page)), await toastText(page));
      eq("H-01 · GUARD · …and no third row was written", (await notesOn(page, src.id)).filter((n) => /^Filed in error/.test(n.body)).length, 1);

      /* A note has to live on a case, so a single-case client has nowhere to send it. */
      const solo = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").insert({ first_name: "Solo", last_name: "Onecase", email: "solo@example.com" }).select("id").single();
        const { data: cs } = await db.from("cases").insert({ client_id: cl.id, stage: "enquiry", case_kind: "remortgage" }).select("id").single();
        const { data: n } = await db.from("case_notes").insert({ case_id: cs.id, body: "the only note on the only case" }).select("id").single();
        return { caseId: cs.id, noteId: n.id };
      });
      await page.evaluate((id) => window.refileNote(id), solo.noteId);
      await page.waitForTimeout(600);
      ok("H-01 · GUARD · a client with no other case is told so, rather than shown an empty picker",
        /no other case to re-file/.test(await toastText(page)), await toastText(page));

      ok("H-01 · guards raised no page errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       3 · H-01 · THE SECOND WRITE FAILS — honest reporting
       There is no transaction across two inserts from a browser. The copy is
       written first (a marker pointing at nothing is worse than an untidy
       file); if the marker then fails, the report has to name BOTH halves.
       =================================================================== */
    console.log("\n— H-01 · injected second-write failure");
    {
      const page = await newPage(browser, "p1");
      const { cases } = await findClient(page, "Underhill");
      const src = cases[0], tgt = cases[1];
      const noteId = await addNote(page, src.id, "Email: sent the illustration");

      // Fail ONLY the marker insert — the copy must still go through, which is
      // the whole point of the state being reported rather than guessed at.
      await page.evaluate(() => {
        const from = window.__mockDb.from.bind(window.__mockDb);
        window.__mockDb.from = function (t) {
          const b = from(t);
          if (t === "case_notes") {
            const insert = b.insert.bind(b);
            b.insert = function (row) {
              if (String((row && row.body) || "").indexOf("Filed in error — see") === 0) {
                return Promise.resolve({ data: null, error: { message: "permission denied for table case_notes", code: "42501" } });
              }
              return insert(row);
            };
          }
          return b;
        };
      });

      await refileFromCaseModal(page, src.id, noteId, tgt.id);
      const msg = await toastText(page);
      ok("H-01 · the report says the copy WAS written, and where to", /copy WAS added to/.test(msg) && /Owls Rd/.test(msg), msg);
      ok("H-01 · …and that the marker was NOT written, and why", /marker was NOT written/.test(msg) && /permission denied/.test(msg), msg);
      ok("H-01 · …and states the resulting state of the file, rather than leaving it to be discovered",
        /Both cases now carry the note/.test(msg), msg);

      const srcNotes = await notesOn(page, src.id);
      const tgtNotes = await notesOn(page, tgt.id);
      eq("H-01 · the copy really is on the target case", tgtNotes.filter((n) => /^Re-filed from /.test(n.body)).length, 1);
      eq("H-01 · …and no marker was left behind on the source", srcNotes.filter((n) => /^Filed in error/.test(n.body)).length, 0);
      // R40 — #notes-list is gone; the Re-file button (still carrying data-note-id) now lives
      // inside a .tl-row under #case-events-list.
      const stillOffered = await page.evaluate((nid) => !!document.querySelector(`#case-events-list .note-refile-btn[data-note-id="${nid}"]`), noteId);
      ok("H-01 · the note is NOT shown as re-filed (no marker ⇒ no strike) and can be retried", stillOffered);
      await page.close();
    }

    /* ===================================================================
       4 · H-01 · ESCAPING — a note body is operator text, everywhere
       =================================================================== */
    console.log("\n— H-01 · escaping (XSS)");
    {
      const page = await newPage(browser, "p1");
      const { client, cases } = await findClient(page, "Underhill");
      const src = cases[0], tgt = cases[1];
      const NASTY = '<img src=x onerror="window.__pwned=1">"\'&';
      const noteId = await addNote(page, src.id, NASTY);
      await refileFromCaseModal(page, src.id, noteId, tgt.id);

      // R40 — #notes-list / .note-body are gone; the struck original is a .tl-row in
      // #case-events-list, and its text now lives inside the <s class="tl-refiled"> element.
      const srcSafe = await page.evaluate(() => {
        const struck = [...document.querySelectorAll("#case-events-list s.tl-refiled")][0];
        return {
          pwned: !!window.__pwned,
          imgs: document.querySelectorAll("#case-events-list img").length,
          text: struck ? struck.textContent : null,
        };
      });
      ok("H-01 · the struck original renders its markup as text, not as an element",
        !srcSafe.pwned && srcSafe.imgs === 0 && srcSafe.text === NASTY, JSON.stringify(srcSafe));

      await page.evaluate((id) => window.openCase(id), tgt.id);
      await page.waitForTimeout(900);
      // R40 — the copy is an ordinary (unstruck) .tl-row whose title starts "Re-filed from …".
      const tgtSafe = await page.evaluate(() => {
        const titles = [...document.querySelectorAll("#case-events-list .tl-row .tl-title")];
        const copy = titles.find((t) => /^Re-filed from /.test(t.textContent));
        return {
          pwned: !!window.__pwned,
          imgs: document.querySelectorAll("#case-events-list img").length,
          html: copy ? copy.innerHTML : "",
        };
      });
      ok("H-01 · the copy on the target case escapes the note text it carries",
        !tgtSafe.pwned && tgtSafe.imgs === 0 && /&lt;img/.test(tgtSafe.html || ""), JSON.stringify(tgtSafe));

      await page.evaluate(() => window.closeModal());
      await page.waitForTimeout(300);
      await page.evaluate((cid) => window.openClient(cid), client.id);
      await page.waitForTimeout(1200);
      const tlSafe = await page.evaluate(() => ({ pwned: !!window.__pwned, imgs: document.querySelectorAll("#tl-list img").length }));
      ok("H-01 · the client timeline escapes it on every row it renders", !tlSafe.pwned && tlSafe.imgs === 0, JSON.stringify(tlSafe));

      const packHtml = await page.evaluate(async (cid) => {
        const orig = window.open;
        let captured = "";
        window.open = () => ({ document: { write: (h) => { captured += h; }, close() {} } });
        try { await window.buildEvidencePack(cid); } finally { window.open = orig; }
        return captured;
      }, tgt.id);
      ok("H-01 · the evidence pack escapes it too", /&lt;img src=x/.test(packHtml) && !/<img src=x/.test(packHtml));
      await page.close();
    }

    /* ===================================================================
       5 · H-01 · ANY STAFF may re-file a note they can reach
       =================================================================== */
    console.log("\n— H-01 · any staff (p3 Luke, adviser)");
    {
      const page = await newPage(browser, "p3");
      const { cases } = await findClient(page, "Underhill"); // Melanie's cases are Luke's
      const noteId = await addNote(page, cases[0].id, "Call: Luke's own note");
      await refileFromCaseModal(page, cases[0].id, noteId, cases[1].id);
      const marker = (await notesOn(page, cases[0].id)).find((n) => n.body.endsWith(`[re-filed:${noteId}]`));
      ok("H-01 · an adviser can re-file — no role gate on reading a note and saying it is misfiled", !!marker, await toastText(page));
      eq("H-01 · …and the copy landed on the case the adviser chose",
        (await notesOn(page, cases[1].id)).filter((n) => /^Re-filed from /.test(n.body)).length, 1);
      await page.close();
    }

    /* ===================================================================
       6 · H-02 · the rate-end reminder confirm names the property
       =================================================================== */
    console.log("\n— H-02 · rate-end reminder confirm names the property");
    {
      const page = await newPage(browser, "p1");
      const { cases } = await findClient(page, "Underhill");
      const withProp = cases.find((c) => c.property_address && c.rate_end_date);

      page.__dialogAnswer = "dismiss"; // read the wording; send nothing
      await page.evaluate((id) => window.openCase(id), withProp.id);
      await page.waitForTimeout(900);
      await r73OpenAction(page, "act-reminder"); await page.click("#act-reminder");
      await page.waitForTimeout(700);
      const msg = lastDialog(page);
      ok("H-02 · the confirm carries a `Property:` line with the FULL address",
        msg.includes("\nProperty: 22 Ravenscourt Road, Southbourne, Bournemouth BH6 3NG"), JSON.stringify(msg));
      ok("H-02 · …in the same style as the retention confirm (own line, full address, not the chip label)",
        /\nProperty: [^\n]+\n/.test(msg + "\n") && !msg.includes("Property: 22 Ravenscourt Rd · BH6"), JSON.stringify(msg));
      ok("H-02 · …and the rest of the dialog is unchanged (signatory + follow-up task)",
        /Signed off by: /.test(msg) && /A follow-up task/.test(msg), JSON.stringify(msg));

      // A case with no address must read exactly as it did before.
      const bare = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").insert({ first_name: "Nora", last_name: "Nowhere", email: "nora@example.com" }).select("id").single();
        const d = new Date(); d.setMonth(d.getMonth() + 4);
        const { data: cs } = await db.from("cases").insert({
          client_id: cl.id, stage: "completed", case_kind: "remortgage", lender: "Halifax",
          rate_end_date: d.toISOString().slice(0, 10),
        }).select("id").single();
        return cs.id;
      });
      await page.evaluate(() => window.closeModal());
      await page.waitForTimeout(300);
      await page.evaluate((id) => window.openCase(id), bare);
      await page.waitForTimeout(900);
      await r73OpenAction(page, "act-reminder"); await page.click("#act-reminder");
      await page.waitForTimeout(700);
      const bareMsg = lastDialog(page);
      ok("H-02 · a case with no property address gets no Property line at all",
        !/Property:/.test(bareMsg) && /Signed off by: /.test(bareMsg), JSON.stringify(bareMsg));
      await page.close();
    }

    /* ===================================================================
       7 · H-03 · one spelling per property
       =================================================================== */
    console.log("\n— H-03 · the best spelling in a group");
    {
      const page = await newPage(browser, "p1");
      const GOOD = "8 Grand Avenue, Southbourne, Bournemouth BH6 3SY";
      const SHABBY = "8 grand avenue southbourne bournemouth bh63sy";
      const SHOUTED = "8 GRAND AVENUE, SOUTHBOURNE, BOURNEMOUTH, BH6 3SY";
      const NO_PC = "8 Grand Avenue, Southbourne, Bournemouth";

      const ranking = await page.evaluate(([g, s, sh, n]) => ({
        oneKey: window.propKey(g) === window.propKey(s) && window.propKey(g) === window.propKey(sh),
        // the shabby spelling is the NEWEST — recency must not outrank completeness
        shabbyLoses: window.propBestAddress([
          { property_address: g, created_at: "2026-01-01T00:00:00Z" },
          { property_address: s, created_at: "2026-07-01T00:00:00Z" },
        ]),
        shoutedLoses: window.propBestAddress([
          { property_address: g, created_at: "2026-01-01T00:00:00Z" },
          { property_address: sh, created_at: "2026-07-01T00:00:00Z" },
        ]),
        // a postcode outranks everything, even a fuller-looking spelling without one
        postcodeWins: window.propBestAddress([
          { property_address: n, created_at: "2026-07-01T00:00:00Z" },
          { property_address: s, created_at: "2026-01-01T00:00:00Z" },
        ]),
        // equal spellings ⇒ the most recent one
        recencyDecides: window.propBestAddress([
          { property_address: "10 Alma Road, Bournemouth BH9 1AA", created_at: "2026-01-01T00:00:00Z" },
          { property_address: "10 Alma Road, Bournemouth BH9 1AA", created_at: "2026-07-01T00:00:00Z" },
        ]),
        stable: [1, 2, 3].map(() => window.propBestAddress([
          { property_address: s, created_at: "2026-07-01T00:00:00Z" },
          { property_address: sh, created_at: "2026-03-01T00:00:00Z" },
          { property_address: g, created_at: "2026-01-01T00:00:00Z" },
        ])),
      }), [GOOD, SHABBY, SHOUTED, NO_PC]);

      ok("H-03 · the three postcoded spellings really are one property (propKey agrees)", ranking.oneKey);
      eq("H-03 · a shabby-cased variant loses to the properly spelled one, even when newer", ranking.shabbyLoses, GOOD);
      eq("H-03 · a SHOUTED variant loses too — commas are punctuation, words are content", ranking.shoutedLoses, GOOD);
      eq("H-03 · a postcode-bearing spelling outranks one without", ranking.postcodeWins, SHABBY);
      eq("H-03 · equally good spellings are decided by recency", ranking.recencyDecides, "10 Alma Road, Bournemouth BH9 1AA");
      eq("H-03 · the answer is stable across repeated evaluation", ranking.stable, [GOOD, GOOD, GOOD]);

      /* One source: the heading, the chip beside it, the picker's option list and
         the canonical case identity must all print the same string. */
      const ruby = await findClient(page, "Sinclair");
      const pair = ruby.cases.filter((c) => /Grand Avenue/i.test(c.property_address || ""));
      ok("H-03 · fixture check · Ruby has two cases on one flat", pair.length === 2, JSON.stringify(pair.map((c) => c.property_address)));

      // Degrade the newer of the pair to the shabby spelling, exactly as a hurried retype would.
      await page.evaluate(([id, s]) => window.__mockDb.from("cases").update({ property_address: s }).eq("id", id), [pair[1].id, SHABBY]);
      await page.evaluate((cid) => window.openClient(cid), ruby.client.id);
      await page.waitForTimeout(1300);

      const surfaces = await page.evaluate(([g, s]) => {
        const grp = [...document.querySelectorAll(".cprop-group")]
          .find((el) => [...el.querySelectorAll(".cprop-addr")].some((a) => /Grand Av/i.test(a.textContent)));
        return {
          heading: grp ? grp.querySelector(".cprop-addr").textContent : null,
          chip: grp ? grp.querySelector(".prop-chip .pc-txt").textContent : null,
          chipTitle: grp ? grp.querySelector(".prop-chip").getAttribute("title") : null,
          options: [...document.querySelectorAll("#tl-case option")].map((o) => o.textContent).filter((t) => /Grand Av/i.test(t)),
          /* The cases list and the timeline — NOT the change-history panel, which
             records what was actually written and must keep saying so. */
          shabbyOnDisplay: (document.querySelector(".cases-list, #client-cases") || grp || document.createElement("div")).innerHTML.indexOf(s) >= 0
            || document.querySelector("#tl-list").innerHTML.indexOf(s) >= 0,
        };
      }, [GOOD, SHABBY]);

      eq("H-03 · the group heading is the group's BEST spelling, not the first row's", surfaces.heading, GOOD);
      eq("H-03 · the chip beside the heading prints the same spelling, shortened", surfaces.chip, "8 Grand Ave · BH6");
      ok("H-03 · the chip's tooltip carries the good spelling too", /^8 Grand Avenue, Southbourne, Bournemouth BH6 3SY/.test(surfaces.chipTitle || ""), surfaces.chipTitle);
      ok("H-03 · both cases' picker options follow it (canonical identity, one spelling)",
        surfaces.options.length === 2 && surfaces.options.every((t) => t.startsWith("8 Grand Ave · BH6 · ")), JSON.stringify(surfaces.options));
      ok("H-03 · the shabby spelling is not printed on the record's own surfaces", !surfaces.shabbyOnDisplay);

      /* STABILITY WHEN A POSTCODED SIBLING APPEARS.
         A client starts with one squashed-postcode spelling of a flat, so that is
         the best there is and every surface uses it. A second case appears
         carrying the properly written spelling of the SAME flat: every surface
         moves to it, and — the part that matters — it STAYS there when a later,
         narrower read only sees the shabby row again. The client register is what
         holds that, so a filtered list cannot walk the label backwards. */
      const stability = await page.evaluate(async ([g, s]) => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").insert({ first_name: "Pat", last_name: "Portfolio", email: "pat@example.com" }).select("id").single();
        const { data: shabbyCase } = await db.from("cases").insert({ client_id: cl.id, stage: "enquiry", case_kind: "remortgage", property_address: s }).select("id").single();
        const read = async () => (await db.from("cases").select("id,client_id,property_address,created_at,stage,case_kind,lender").eq("client_id", cl.id)).data;
        const only = (rows) => rows.filter((c) => /Grand Av/i.test(c.property_address || ""));

        const before = only(await read());
        const beforeOpts = window.distinctPropAddresses(before);
        window.registerClientProps(cl.id, before);
        const beforeChip = window.propCanonAddr(cl.id, before[0]);

        await db.from("cases").insert({ client_id: cl.id, stage: "offer", case_kind: "buy_to_let", property_address: g });
        const rows = only(await read());
        const afterOpts = window.distinctPropAddresses(rows);
        window.registerClientProps(cl.id, rows);
        const afterChip = window.propCanonAddr(cl.id, rows.find((r) => r.id === shabbyCase.id));

        /* A narrower read that only mentions the shabby case — the shape that used
           to walk a client's label backwards. */
        window.registerClientProps(cl.id, rows.filter((r) => r.id === shabbyCase.id));
        return {
          beforeOpts, beforeChip, afterOpts, afterChip,
          reversed: window.distinctPropAddresses(rows.slice().reverse()),
          afterNarrowRead: window.propCanonAddr(cl.id, rows.find((r) => r.id === shabbyCase.id)),
        };
      }, [GOOD, SHABBY]);

      eq("H-03 · with only the shabby spelling, that is what the group is labelled with", stability.beforeOpts, [SHABBY]);
      eq("H-03 · …on the chip too", stability.beforeChip, SHABBY);
      eq("H-03 · a postcoded, properly written sibling appears — the option list moves to it", stability.afterOpts, [GOOD]);
      eq("H-03 · …and the shabby case's own chip now prints the good spelling", stability.afterChip, GOOD);
      eq("H-03 · read order cannot change the answer", stability.reversed, [GOOD]);
      eq("H-03 · a later, narrower read cannot walk the label back to the shabby one", stability.afterNarrowRead, GOOD);

      ok("H-03 · no page errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       8 · MOCK PARITY (a) · queue_automated_emails carries the property
       =================================================================== */
    console.log("\n— MOCK parity (a) · retention successor via __mock.queueAutomatedEmails()");
    {
      const page = await newPage(browser, "p1");
      const seeded = await page.evaluate(() => {
        const db = window.__mockDb;
        const d = new Date(); d.setMonth(d.getMonth() + 3);
        const due = d.toISOString().slice(0, 10);
        const mk = async (addr, lender) => {
          const { data: cl } = await db.from("clients").insert({ first_name: "Rene", last_name: "Wal" + (addr ? "P" : "N"), email: "rene." + (addr ? "p" : "n") + "@example.com" }).select("id").single();
          const { data: cs } = await db.from("cases").insert({
            client_id: cl.id, stage: "completed", case_kind: "remortgage", lender: lender,
            rate_end_date: due, property_address: addr || null, assigned_to: "p2",
          }).select("id").single();
          return { clientId: cl.id, caseId: cs.id };
        };
        return (async () => ({
          due,
          withProp: await mk("63 Malvern Road, Bournemouth BH9 3AS", "Aldermore"),
          without: await mk(null, "Halifax"),
        }))();
      });

      const result = await page.evaluate(async (s) => {
        const out = window.__mock.queueAutomatedEmails();
        const db = window.__mockDb;
        const succ = async (srcId) => {
          const { data } = await db.from("cases").select("id,property_address,retention_source_case_id").eq("retention_source_case_id", srcId);
          const c = data[0];
          if (!c) return null;
          const { data: tasks } = await db.from("case_tasks").select("title").eq("case_id", c.id);
          const { data: notes } = await db.from("case_notes").select("body").eq("case_id", c.id);
          return { addr: c.property_address, title: tasks[0] && tasks[0].title, note: notes[0] && notes[0].body };
        };
        return { out, withProp: await succ(s.withProp.caseId), without: await succ(s.without.caseId) };
      }, seeded);

      ok("MOCK (a) · the RPC created both retention successors", result.out.retention_cases_created >= 2, JSON.stringify(result.out));
      eq("MOCK (a) · the successor carries the source case's property_address",
        result.withProp.addr, "63 Malvern Road, Bournemouth BH9 3AS");
      eq("MOCK (a) · the call task names the first address line",
        result.withProp.title, `Call client — rate on 63 Malvern Road ends ${seeded.due}`);
      eq("MOCK (a) · the origin note names the lender and the FULL address",
        result.withProp.note,
        `Retention opportunity auto-created — current Aldermore deal on 63 Malvern Road, Bournemouth BH9 3AS ends ${seeded.due}.`);
      eq("MOCK (a) · with no address the successor has none either", result.without.addr, null);
      eq("MOCK (a) · …and the task title is word-for-word what it always was",
        result.without.title, `Call client — rate ends ${seeded.due}`);
      ok("MOCK (a) · …and so is the note", /^Created automatically — /.test(result.without.note), result.without.note);
      await page.close();
    }

    /* ===================================================================
       9 · MOCK PARITY (b) · the composed emails mention the property
       =================================================================== */
    console.log("\n— MOCK parity (b) · compose, via __mock.lastEmailRun()");
    {
      const page = await newPage(browser, "p1");
      const ADDR = "12A Herbert Avenue, Parkstone, Poole BH12 4HR";
      const composed = await page.evaluate(async (addr) => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").insert({ first_name: "Comp", last_name: "Ose", email: "compose@example.com" }).select("id,email").single();
        const mk = async (a) => {
          const { data } = await db.from("cases").insert({
            client_id: cl.id, stage: "application", case_kind: "remortgage", lender: "Skipton",
            property_address: a, assigned_to: "p2",
          }).select("id").single();
          return data.id;
        };
        const withProp = await mk(addr), without = await mk(null);
        const types = ["rate_end_reminder", "rate_end_chase", "submitted_update", "offer_update", "completion_congrats",
          "protection_offer", "fee_request", "gi_exchange"];
        const ids = [];
        for (const cid of [withProp, without]) {
          for (const t of types) {
            const { data } = await db.from("email_queue").insert({
              case_id: cid, client_id: cl.id, email_type: t, to_email: cl.email, subject: t,
            }).select("id").single();
            ids.push(data.id);
          }
        }
        const r = await fetch("https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1/process-emails", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queue_ids: ids }),
        });
        await r.json();
        const run = window.__mock.lastEmailRun();
        const by = {};
        run.composed.forEach((c) => {
          const k = (c.property_address ? "with:" : "without:") + c.email_type;
          by[k] = { mention: c.property_mention, line: c.property_line, phrase: c.property_phrase, body: c.body_lines };
        });
        return { by, count: run.composed.length };
      }, ADDR);

      eq("MOCK (b) · all sixteen queued messages were composed", composed.count, 16);
      const SENT = ["rate_end_reminder", "rate_end_chase", "submitted_update", "offer_update", "completion_congrats"];
      const REG = ["protection_offer", "fee_request", "gi_exchange"];
      SENT.forEach((t) => {
        const c = composed.by["with:" + t] || {};
        ok(`MOCK (b) · ${t} mentions the property IN the sentence`,
          c.mention === "sentence" && c.phrase === `your mortgage on ${ADDR}`
          && (c.body || []).some((l) => l.includes(`your mortgage on ${ADDR}`)),
          JSON.stringify(c));
      });
      REG.forEach((t) => {
        const c = composed.by["with:" + t] || {};
        ok(`MOCK (b) · ${t} carries a standalone "Regarding:" line`,
          c.mention === "regarding" && c.line === `Regarding: ${ADDR}` && (c.body || [])[0] === `Regarding: ${ADDR}`,
          JSON.stringify(c));
      });
      SENT.concat(REG).forEach((t) => {
        const c = composed.by["without:" + t] || {};
        /* "Unchanged" means: no Regarding line, no "on <address>" hanging off the
           subject, and no stray fragment of one. The subject stays the plain
           "your mortgage" this email has always used. */
        const text = (c.body || []).join(" ");
        ok(`MOCK (b) · ${t} with no address: wording unchanged, no empty mention`,
          c.mention === null && c.line === null && c.phrase === null
          && !text.includes("Regarding:") && !text.includes("your mortgage on ")
          && !/\bon\s*[.,]/.test(text) && (REG.indexOf(t) >= 0 || text.includes("your mortgage")),
          JSON.stringify(c));
      });
      await page.close();
    }

    /* ===================================================================
       10 · MOCK PARITY (c) · parse-offer returns a property address, and the
            app's offer-diff proposes and applies it — end to end.
       =================================================================== */
    console.log("\n— MOCK parity (c) · parse-offer → offer diff → apply");
    {
      const page = await newPage(browser, "p1");
      const OFFER_ADDR = "17 Talbot Avenue, Winton, Bournemouth BH3 7HU";

      const raw = await page.evaluate(async () => {
        const r = await fetch("https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1/parse-offer", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdf_base64: "" }),
        });
        return (await r.json()).offer;
      });
      eq("MOCK (c) · parse-offer returns property_address", raw.property_address, OFFER_ADDR);

      const target = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").insert({ first_name: "Offa", last_name: "Reed", email: "offa@example.com" }).select("id").single();
        const { data: cs } = await db.from("cases").insert({ client_id: cl.id, stage: "application", case_kind: "purchase" }).select("id").single();
        return cs.id;
      });
      await page.evaluate((id) => window.openCase(id), target);
      await page.waitForTimeout(900);
      await page.setInputFiles("#offer-file", { name: "offer.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 mock") });
      await page.waitForTimeout(1600);

      const diff = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#offer-diff tbody tr")].map((tr) => ({
          label: tr.children[0].textContent,
          current: tr.children[1].textContent,
          incoming: tr.children[2].textContent,
          checked: tr.querySelector("input").checked,
        }));
        return { rows, propRow: rows.find((r) => r.label === "Property address") || null };
      });
      ok("MOCK (c) · the diff proposes a Property address row",
        !!diff.propRow && diff.propRow.incoming.includes(OFFER_ADDR), JSON.stringify(diff.propRow));
      ok("MOCK (c) · …pre-ticked, because the case had no address to conflict with",
        !!diff.propRow && diff.propRow.checked && /empty/.test(diff.propRow.current), JSON.stringify(diff.propRow));

      await page.click("#offer-apply");
      await page.waitForTimeout(1500);
      const applied = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("property_address,lender,rate_percent").eq("id", id).single();
        return data;
      }, target);
      eq("MOCK (c) · Apply writes the address onto the case", applied.property_address, OFFER_ADDR);
      ok("MOCK (c) · …alongside the other readings, as one update", applied.lender === "Coventry Building Society" && applied.rate_percent === 4.24, JSON.stringify(applied));
      ok("MOCK (c) · no page errors through the offer path", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
  } catch (e) {
    failures.push("HARNESS: " + (e && e.stack || e));
    console.log("\n!! harness error:", e && e.stack || e);
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (_) {} }
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log(`r64: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
  process.exit(0);
})();
