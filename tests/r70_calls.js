#!/usr/bin/env node
/* =============================================================================
   tests/r70_calls.js — acceptance tests for R70 build B, "Calls: a session of
   thirty, not one" (panel finding H2, plus L1).

   The findings this file answers, from the R70 discovery panel:

     B1 · "Log call" refused to save "No answer" without a typed sentence, and
          booked nothing. A session of thirty calls is mostly no-answers, so
          that was thirty typed sentences that all said the same thing and
          thirty separate decisions to book the retry. An outcome chip is now
          a complete record on its own ("Call: No answer"), and the two
          outcomes that ARE a retry — No answer / Left voicemail — pre-fill the
          panel's own follow-up with "Call again" tomorrow, unless the adviser
          touches either field first.
     B2 · Nothing on a retention row said whether anybody had already rung this
          client. Every row now carries one grey clause — "· last contact
          3 days ago (WK)" or "· never contacted" — computed by the new shared
          lastContactByClient(), which uses the SAME R64 definition the Clients
          page's cold segment and the Gone-quiet panel use (a real note, a SENT
          email, an appointment that has STARTED, a completed task; import
          provenance notes are not contact). A "🕸 Never contacted first"
          toggle re-orders on that fact and is remembered in nx_ret_untouched.
     B3 · The three commonest rate-end outcomes are chips on the COMPLETED row:
          Renewed elsewhere / Property sold both open the R58 rate-end outcome
          overlay ON THE RIGHT RADIO (they do not bypass its confirm copy), and
          Re-mortgaging with us is the row's existing startRetentionCase.
     B4 · tel: / sms: wherever a number is already in hand — the Retention
          rows, Today's Rate & ERC drawer, My Day and the no-next-action radar.
          The sms: link is a DEEP LINK into the adviser's own phone with a
          house sentence prefilled; nothing is sent, queued or recorded, and
          the link's own title says so. The radar also gained the fact that
          decides who to ring (rate end + lender), a rate-soonest-first order
          with quiet-days as the tiebreak, and L1's 25-row cap.

   Every figure asserted here is recomputed in the test from window.__mockDb,
   independently of app.js's own helpers, per the standing HARNESS.md rule.

   Run:  node /root/nx/tests/r70_calls.js
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

/* Every localStorage key a page under test here can read. nx_ret_untouched is R70's addition and
   is cleared for the same reason nx_ret_month is: a suite that depends on a default must never
   inherit a choice an earlier scenario made. */
const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_untouched", "nx_wt_scope", "nx_board_adviser",
  "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_clients_adviser", "nx_drawer_rateerc",
  "nx_drawer_retention", "nx_drawer_unactioned", "nx_drawer_watchtower", "nx_brief_scope"];

async function boot(browser, persona) {
  const page = await (await browser.newContext()).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.waitForTimeout(1600);
  return page;
}
/* The tunnel/CDN noise every suite in this harness filters — the mock page loads no network
   assets of its own, but favicons and the sheetjs CDN tag are still in the markup. */
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));

const goPage = async (page, name, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await page.waitForTimeout(ms == null ? 2400 : ms);
};

let uniq = 0;
const tag = () => `R70B${Date.now().toString(36)}${++uniq}`;
const ymd = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
/* Europe/London calendar date, computed in the TEST rather than borrowed from app.js — the
   auto call-back's due date is asserted against this. */
const localYmd = (offsetDays) => {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};
/* R78: the call-back prefill is a RELATIVE verb, so "tomorrow" now skips the weekend (B4's roll —
   a Friday "No answer" books Monday). Computed independently of app.js, as localYmd itself is. */
const rollWeekend = (s) => {
  const d = new Date(s + "T12:00:00");
  const dow = d.getDay();
  if (dow !== 6 && dow !== 0) return s;
  d.setDate(d.getDate() + (dow === 6 ? 2 : 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const workingTomorrow = () => rollWeekend(localYmd(1));   // R78: what the prefill now writes

async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const { data: cl, error: ce } = await db.from("clients").insert({
      first_name: o.first, last_name: o.last, email: o.email || null, phone: o.phone === undefined ? null : o.phone,
    }).select("id").single();
    if (ce) throw new Error("client insert: " + ce.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "completed", assigned_to: "p2" }, o.case || {});
    const { data: cs, error: se } = await db.from("cases").insert(row).select("id").single();
    if (se) throw new Error("case insert: " + se.message);
    /* Every case insert auto-logs a case_created case_event (see mock-supabase.js). It is not
       "contact" under the R64 definition, but the radar counts it as activity — so a fixture that
       has to look quiet gets it wiped, exactly the way tests/r17.js's mkQuietCase does. */
    if (o.quiet) {
      await db.from("case_events").delete().eq("case_id", cs.id);
      await db.from("case_notes").delete().eq("case_id", cs.id);
    }
    return { clientId: cl.id, caseId: cs.id };
  }, opts);
}

const rowFor = (page, sel, caseId) => page.evaluate(({ s, id }) => {
  const row = [...document.querySelectorAll(`${s} .row-item`)]
    .find((r) => { const t = r.querySelector(".t[onclick]"); return t && t.getAttribute("onclick").includes(`'${id}'`); });
  if (!row) return null;
  const tel = row.querySelector("a[href^='tel:']");
  const sms = row.querySelector("a[href^='sms:']");
  const lastc = row.querySelector(".ret-row-lastc");
  return {
    text: row.textContent.replace(/\s+/g, " ").trim(),
    tel: tel ? tel.getAttribute("href") : null,
    telText: tel ? tel.textContent : null,
    sms: sms ? sms.getAttribute("href") : null,
    smsTitle: sms ? sms.getAttribute("title") : null,
    lastc: lastc ? lastc.textContent.trim() : null,
    never: !!row.querySelector(".ret-row-never"),
    outChips: [...row.querySelectorAll(".ret-out-chip")].map((b) => b.getAttribute("onclick")),
  };
}, { s: sel, id: caseId });

const retRowIds = (page) => page.evaluate(() =>
  [...document.querySelectorAll("#ret-rates-list .row-item .t[onclick]")]
    .map((el) => (el.getAttribute("onclick").match(/openCase\('([^']+)'\)/) || [])[1]).filter(Boolean));

const notesFor = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("case_notes").select("*");
  return (data || []).filter((n) => n.case_id === id).map((n) => n.body);
}, caseId);
const tasksFor = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("case_tasks").select("*");
  return (data || []).filter((t) => t.case_id === id).map((t) => ({ title: t.title, due: t.due_date, assigned_to: t.assigned_to }));
}, caseId);
const caseRow = (page, caseId) => page.evaluate(async (id) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", id).single();
  return data;
}, caseId);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* ======================================================================
     §A · B1 — A CHIP IS A COMPLETE RECORD, AND "NO ANSWER" BOOKS THE RETRY
     ====================================================================== */
  console.log("\n— §A · B1 · chip-only saves, and the automatic call-back");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    const noAns = await mkClientCase(page, { first: "R70A", last: "Noanswer" + t, phone: "07700900801", case: { stage: "application", case_kind: "remortgage", assigned_to: "p2" } });
    const spoke = await mkClientCase(page, { first: "R70A", last: "Spoke" + t, phone: "07700900802", case: { stage: "application", case_kind: "remortgage", assigned_to: "p2" } });
    const typed = await mkClientCase(page, { first: "R70A", last: "Typedfirst" + t, phone: "07700900803", case: { stage: "application", case_kind: "remortgage", assigned_to: "p2" } });
    const empty = await mkClientCase(page, { first: "R70A", last: "Nothing" + t, phone: "07700900804", case: { stage: "application", case_kind: "remortgage", assigned_to: "p2" } });
    const flip = await mkClientCase(page, { first: "R70A", last: "Changedmind" + t, phone: "07700900805", case: { stage: "application", case_kind: "remortgage", assigned_to: "p2" } });

    const openLogCall = async (caseId) => {
      await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
      await page.waitForTimeout(300);
      await page.evaluate((id) => window.openCase(id), caseId);
      await page.waitForTimeout(1400);
      await page.click("#cs-logcall-btn");
      await page.waitForTimeout(400);
    };

    // A1 — the panel says what the two new rules are, before either happens.
    await openLogCall(noAns.caseId);
    const help = await page.$eval("#cs-call-help", (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
    ok("A1 · the panel says a chip on its own is enough…", !!help && /chip on its own is enough/i.test(help), String(help));
    ok("A1 · …and that No answer / Left voicemail book a call-back for tomorrow, changeable",
      !!help && /No answer/.test(help) && /call-back task for tomorrow/i.test(help) && /change the title or the date/i.test(help), String(help));

    // A2 — picking "No answer" pre-fills the EXISTING follow-up fields (R64's, not new ones).
    await page.click('#cs-call-outcome-chips .tl-chip[data-outcome="No answer"]');
    await page.waitForTimeout(250);
    const prefill = await page.evaluate(() => ({
      title: document.querySelector("#cs-call-fu-title").value,
      due: document.querySelector("#cs-call-fu-due").value,
    }));
    eq("A2 · 'No answer' pre-fills the follow-up title with 'Call again'", prefill.title, "Call again");
    eq("A2 · …dated the working tomorrow (Europe/London; R78 weekend roll), computed in the test", prefill.due, workingTomorrow());

    // A3 — and Save with NO typed note at all now works: the chip IS the record.
    await page.click("#cs-call-save");
    await page.waitForTimeout(2200);
    const noAnsNotes = await notesFor(page, noAns.caseId);
    eq("A3 · a chip with no typed note saves as 'Call: <outcome>'",
      noAnsNotes.filter((b) => /^Call: /.test(b)), ["Call: No answer"]);
    const noAnsTasks = await tasksFor(page, noAns.caseId);
    eq("A3 · …and the call-back task is written with the pre-filled title and date",
      noAnsTasks.filter((x) => x.title === "Call again").map((x) => x.due), [workingTomorrow()]);   // R78: weekend roll
    eq("A3 · …on the case's own adviser, not on whoever took the call",
      (noAnsTasks.find((x) => x.title === "Call again") || {}).assigned_to, "p2");

    // A4 — a CONNECTED call is untouched: no prefill, and the R5-49 note body is byte-for-byte
    //      what it always was.
    await openLogCall(spoke.caseId);
    await page.click('#cs-call-outcome-chips .tl-chip[data-outcome="Spoke — actioned"]');
    await page.waitForTimeout(250);
    const spokePrefill = await page.evaluate(() => ({
      title: document.querySelector("#cs-call-fu-title").value,
      due: document.querySelector("#cs-call-fu-due").value,
    }));
    eq("A4 · a connected outcome books nothing by itself", spokePrefill, { title: "", due: "" });
    await page.fill("#cs-call-note", "agreed to send the offer pack");
    await page.click("#cs-call-save");
    await page.waitForTimeout(2200);
    eq("A4 · …and the connected note body is exactly the R5-49 one",
      (await notesFor(page, spoke.caseId)).filter((b) => /^Call: /.test(b)),
      ["Call: Spoke — actioned — agreed to send the offer pack"]);
    eq("A4 · …with no follow-up task invented", (await tasksFor(page, spoke.caseId)).length, 0);

    // A5 — "unless the user changes it": a title typed BEFORE the chip is never overwritten.
    await openLogCall(typed.caseId);
    await page.fill("#cs-call-fu-title", "Ring after the survey");
    await page.click('#cs-call-outcome-chips .tl-chip[data-outcome="Left voicemail"]');
    await page.waitForTimeout(250);
    const kept = await page.evaluate(() => ({
      title: document.querySelector("#cs-call-fu-title").value,
      due: document.querySelector("#cs-call-fu-due").value,
    }));
    eq("A5 · a follow-up title the adviser typed first survives the chip", kept.title, "Ring after the survey");
    eq("A5 · …and the date they did not set is left alone too", kept.due, "");
    await page.click("#cs-call-save");
    await page.waitForTimeout(2200);
    eq("A5 · saving writes THEIR task, not ours",
      (await tasksFor(page, typed.caseId)).map((x) => x.title), ["Ring after the survey"]);

    // A6 — changing the outcome to a connected one withdraws the call-back we put there.
    await openLogCall(flip.caseId);
    await page.click('#cs-call-outcome-chips .tl-chip[data-outcome="No answer"]');
    await page.waitForTimeout(200);
    await page.click('#cs-call-outcome-chips .tl-chip[data-outcome="Spoke — will call back"]');
    await page.waitForTimeout(250);
    const withdrawn = await page.evaluate(() => ({
      title: document.querySelector("#cs-call-fu-title").value,
      due: document.querySelector("#cs-call-fu-due").value,
    }));
    eq("A6 · moving to a connected outcome withdraws the automatic call-back", withdrawn, { title: "", due: "" });
    await page.click("#cs-call-save");
    await page.waitForTimeout(2200);
    eq("A6 · …so nothing is booked", (await tasksFor(page, flip.caseId)).length, 0);
    eq("A6 · …and the chip still saves on its own",
      (await notesFor(page, flip.caseId)).filter((b) => /^Call: /.test(b)), ["Call: Spoke — will call back"]);

    // A7 — the guard survives, narrowed: nothing said at all is still refused.
    await openLogCall(empty.caseId);
    await page.click("#cs-call-save");
    await page.waitForTimeout(1400);
    eq("A7 · a Save with no chip and no note is still refused", (await notesFor(page, empty.caseId)).filter((b) => /^Call: /.test(b)), []);
    const toastTxt = await page.evaluate(() => (document.querySelector("#toast") || {}).textContent || "");
    ok("A7 · …and the toast names both ways out", /outcome chip/i.test(toastTxt) && /type what happened/i.test(toastTxt), toastTxt);

    ok("§A · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §A2 · the SAME rules through the Retention row's overlay — one writer
     ====================================================================== */
  console.log("\n— §A2 · B1 · the row's overlay obeys the same two rules (one writer, not two)");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    const c = await mkClientCase(page, { first: "R70A2", last: "Rowchip" + t, phone: "07700900811", case: { lender: "Halifax", rate_percent: 2.4, rate_end_date: ymd(-25), completed_at: ymd(-780), loan_amount: 180000, property_address: "1 R70 Row, Testtown TE7 0AA" } });
    await goPage(page, "retention", 2800);
    await page.click(`#ret-rates-list button[onclick*="retLogCall('${c.caseId}')"]`);
    await page.waitForTimeout(1200);
    await page.click("#ret-logcall-panel #cs-call-outcome-chips .tl-chip[data-outcome='No answer']");
    await page.waitForTimeout(250);
    const overlayPrefill = await page.evaluate(() => ({
      panel: !!document.getElementById("ret-logcall-panel"),
      title: document.querySelector("#ret-logcall-panel #cs-call-fu-title").value,
      due: document.querySelector("#ret-logcall-panel #cs-call-fu-due").value,
      help: !!document.querySelector("#ret-logcall-panel #cs-call-help"),
    }));
    ok("A2a · the row overlay carries the same panel, copy and prefill",
      overlayPrefill.panel && overlayPrefill.help && overlayPrefill.title === "Call again" && overlayPrefill.due === workingTomorrow(),   // R78: weekend roll
      JSON.stringify(overlayPrefill));
    await page.click("#ret-logcall-panel #cs-call-save");
    await page.waitForTimeout(2800);
    eq("A2b · a chip-only save from the row writes the identical note body",
      (await notesFor(page, c.caseId)).filter((b) => /^Call: /.test(b)), ["Call: No answer"]);
    eq("A2c · …and the identical call-back task",
      (await tasksFor(page, c.caseId)).map((x) => ({ title: x.title, due: x.due, assigned_to: x.assigned_to })),
      [{ title: "Call again", due: workingTomorrow(), assigned_to: "p2" }]);   // R78: weekend roll
    ok("§A2 · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §B · B2 — LAST CONTACT ON EVERY ROW, AND "NEVER CONTACTED FIRST"
     ====================================================================== */
  console.log("\n— §B · B2 · the last-contact clause and the never-contacted toggle");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    /* Three completed cases whose rates ended RECENTLY, so they land in the page's "Ended" group
       at the very end of its ascending date order — which is what makes the toggle's re-ordering
       visible rather than a coincidence. */
    /* R70 MERGE (CTO) — agent A's default sort is now NEWEST-ended first, so for B3d's precondition
       (the worked row ABOVE the untouched one before the toggle) the WORKED case must be the more
       recently ended of the pair. Dates swapped accordingly; nothing else about the trio changed. */
    const untouched = await mkClientCase(page, { first: "R70B", last: "Untouched" + t, phone: "07700900821", case: { lender: "Halifax", rate_percent: 2.5, rate_end_date: ymd(-4), completed_at: ymd(-700), loan_amount: 150000, property_address: "10 R70 Quiet, Testtown TE7 1AA" } });
    const worked = await mkClientCase(page, { first: "R70B", last: "Worked" + t, phone: "07700900822", case: { lender: "Skipton", rate_percent: 2.6, rate_end_date: ymd(-3), completed_at: ymd(-710), loan_amount: 160000, property_address: "11 R70 Quiet, Testtown TE7 1AB" } });
    const imported = await mkClientCase(page, { first: "R70B", last: "Imported" + t, phone: "07700900823", case: { lender: "Nationwide", rate_percent: 2.7, rate_end_date: ymd(-5), completed_at: ymd(-720), loan_amount: 170000, property_address: "12 R70 Quiet, Testtown TE7 1AC" } });
    // A real note by Luke Richards (p3) six days ago, and an IMPORT PROVENANCE note on the third.
    await page.evaluate(async (o) => {
      const db = window.__mockDb;
      await db.from("case_notes").insert({ case_id: o.worked, body: "Call: Spoke — will call back — happy to review in the autumn", created_by: "p3", created_at: new Date(Date.now() - 6 * 86400000).toISOString() });
      await db.from("case_notes").insert({ case_id: o.imported, body: "SB-IMPORT-1 · back-book import 2026-07-02", created_by: "p1" });
    }, { worked: worked.caseId, imported: imported.caseId });

    await goPage(page, "retention", 3000);
    const u1 = await rowFor(page, "#ret-rates-list", untouched.caseId);
    const w1 = await rowFor(page, "#ret-rates-list", worked.caseId);
    const i1 = await rowFor(page, "#ret-rates-list", imported.caseId);
    ok("B1 · fixture — all three seeded rows are on the page", !!u1 && !!w1 && !!i1, JSON.stringify({ u: !!u1, w: !!w1, i: !!i1 }));
    eq("B1a · a client nobody has touched reads 'never contacted'", u1 && u1.lastc, "· never contacted");
    ok("B1b · …and is flagged, not merely worded", u1 && u1.never === true, JSON.stringify(u1));
    eq("B2a · a client with a real note reads the age of it", w1 && w1.lastc, "· last contact 6 days ago (LR)");
    ok("B2b · …carrying the note author's initials", w1 && /\(LR\)$/.test(w1.lastc || ""), JSON.stringify(w1));
    eq("B2c · an SB-IMPORT provenance note is NOT contact (R47 Gate 0, unchanged)", i1 && i1.lastc, "· never contacted");

    // B3 — the toggle. It re-orders and NEVER hides.
    const chip = await page.evaluate(() => {
      const b = document.querySelector("#ret-untouched-btn");
      return b ? { on: b.getAttribute("aria-pressed"), count: Number((b.querySelector(".count") || {}).textContent), text: b.textContent.replace(/\s+/g, " ").trim(), note: (document.querySelector(".ret-untouched-note") || {}).textContent } : null;
    });
    ok("B3a · the page carries a 'Never contacted first' toggle, off by default",
      !!chip && chip.on === "false" && /Never contacted first/.test(chip.text), JSON.stringify(chip));
    // Ground truth, computed here: which of the rows on screen have no contact of any kind.
    const truthNever = await page.evaluate(async () => {
      const db = window.__mockDb;
      const win = 210 * 86400000;                       // ≥ the app's comms window at the 6-month default
      const since = Date.now() - win;
      const ids = [...document.querySelectorAll("#ret-rates-list .row-item .t[onclick]")]
        .map((el) => (el.getAttribute("onclick").match(/openCase\('([^']+)'\)/) || [])[1]).filter(Boolean);
      const { data: cases } = await db.from("cases").select("id,client_id");
      const byId = {}; (cases || []).forEach((c) => { byId[c.id] = c.client_id; });
      const clientIds = [...new Set(ids.map((id) => byId[id]).filter(Boolean))];
      const casesOf = {}; (cases || []).forEach((c) => { if (clientIds.includes(c.client_id)) (casesOf[c.client_id] = casesOf[c.client_id] || []).push(c.id); });
      const { data: notes } = await db.from("case_notes").select("*");
      const { data: mails } = await db.from("email_queue").select("*");
      const { data: appts } = await db.from("appointments").select("*");
      const { data: tasks } = await db.from("case_tasks").select("*");
      const out = [];
      clientIds.forEach((cid) => {
        const mine = casesOf[cid] || [];
        const hit =
          (notes || []).some((n) => mine.includes(n.case_id) && !/^\s*SB-IMPORT-\d/.test(String(n.body || "")) && new Date(n.created_at).getTime() >= since)
          || (mails || []).some((m) => m.client_id === cid && m.status === "sent" && m.sent_at && new Date(m.sent_at).getTime() >= since)
          || (appts || []).some((a) => a.client_id === cid && a.starts_at && new Date(a.starts_at).getTime() <= Date.now() && new Date(a.starts_at).getTime() >= since)
          || (tasks || []).some((x) => mine.includes(x.case_id) && x.done_at && new Date(x.done_at).getTime() >= since);
        if (!hit) out.push(cid);
      });
      return out.length;
    });
    eq("B3b · the chip's count matches an independently computed 'never contacted' set", chip && chip.count, truthNever);

    const before = await retRowIds(page);
    await page.click("#ret-untouched-btn");
    await page.waitForTimeout(2600);
    const after = await retRowIds(page);
    eq("B3c · the toggle is a SORT, not a filter — the same rows, all of them", after.slice().sort(), before.slice().sort());
    ok("B3d · …and it moves an untouched row above one that has been worked",
      after.indexOf(untouched.caseId) < after.indexOf(worked.caseId)
      && before.indexOf(untouched.caseId) > before.indexOf(worked.caseId),
      JSON.stringify({ beforeU: before.indexOf(untouched.caseId), beforeW: before.indexOf(worked.caseId), afterU: after.indexOf(untouched.caseId), afterW: after.indexOf(worked.caseId) }));
    const stored = await page.evaluate(() => localStorage.getItem("nx_ret_untouched"));
    eq("B3e · the choice is persisted in nx_ret_untouched", stored, "1");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    await goPage(page, "retention", 3000);
    const pressedAfterReload = await page.$eval("#ret-untouched-btn", (b) => b.getAttribute("aria-pressed")).catch(() => null);
    eq("B3f · …and restored after a reload", pressedAfterReload, "true");

    // B4 — the drawer deliberately does NOT carry the clause (it would cost five reads).
    await goPage(page, "dashboard", 2800);
    const drawerClause = await page.evaluate(() => document.querySelectorAll("#alerts-rateerc .ret-row-lastc").length);
    eq("B4 · Today's Rate & ERC drawer carries no last-contact clause (a morning glance does not earn five reads)", drawerClause, 0);

    ok("§B · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §C · B3 — THE THREE OUTCOME CHIPS ON A COMPLETED ROW
     ====================================================================== */
  console.log("\n— §C · B3 · outcome chips route to the right overlay, and write nothing themselves");
  {
    const page = await boot(browser, "p1");
    const t = tag();
    const done = await mkClientCase(page, { first: "R70C", last: "Completed" + t, phone: "07700900831", case: { lender: "Halifax", rate_percent: 2.8, rate_end_date: ymd(-30), completed_at: ymd(-800), loan_amount: 200000, property_address: "20 R70 Out, Testtown TE7 2AA" } });
    const sold = await mkClientCase(page, { first: "R70C", last: "Soldpath" + t, phone: "07700900832", case: { lender: "Skipton", rate_percent: 2.9, rate_end_date: ymd(-31), completed_at: ymd(-810), loan_amount: 210000, property_address: "21 R70 Out, Testtown TE7 2AB" } });
    const retain = await mkClientCase(page, { first: "R70C", last: "Stayingwithus" + t, phone: "07700900833", case: { lender: "Nationwide", rate_percent: 3.0, rate_end_date: ymd(-32), completed_at: ymd(-820), loan_amount: 220000, property_address: "22 R70 Out, Testtown TE7 2AC" } });
    /* A LIVE case whose rate is inside the window — it reaches the same feed, and must NOT get
       outcome chips: there is no rate END to record an outcome for yet. */
    const live = await mkClientCase(page, { first: "R70C", last: "Stillopen" + t, phone: "07700900834", case: { stage: "offer", lender: "Barclays", rate_percent: 3.1, rate_end_date: ymd(40), loan_amount: 230000, property_address: "23 R70 Out, Testtown TE7 2AD" } });

    await goPage(page, "retention", 3000);
    const dRow = await rowFor(page, "#ret-rates-list", done.caseId);
    const lRow = await rowFor(page, "#ret-rates-list", live.caseId);
    eq("C1a · a completed row carries exactly three outcome chips", dRow && dRow.outChips.length, 3);
    ok("C1b · …the first two into the rate-end outcome machinery, the third into startRetentionCase",
      dRow && /retRateOutcome\('[^']+','renewed'\)/.test(dRow.outChips[0])
      && /retRateOutcome\('[^']+','sold'\)/.test(dRow.outChips[1])
      && /startRetentionCase\('[^']+', event\)/.test(dRow.outChips[2]), JSON.stringify(dRow && dRow.outChips));
    ok("C1c · …each stopping the row's own click-through to the case", dRow && dRow.outChips.every((h) => /event\.stopPropagation\(\)/.test(h)), JSON.stringify(dRow && dRow.outChips));
    eq("C1d · a LIVE row carries none — there is no rate end to record an outcome for", lRow && lRow.outChips.length, 0);
    eq("C1e · …and the drawer carries none either (page-only, like the rest of the cluster)",
      await page.evaluate(() => document.querySelectorAll("#alerts-rateerc .ret-out-chip").length), 0);

    // C2 — "Renewed elsewhere" opens R58's overlay on the renewed radio.
    await page.click(`#ret-rates-list button[onclick*="retRateOutcome('${done.caseId}','renewed')"]`);
    await page.waitForTimeout(1500);
    const renewOverlay = await page.evaluate(() => ({
      heading: (document.querySelector("#overlay-modal h3") || {}).textContent || "",
      hidden: document.querySelector("#overlay-backdrop").classList.contains("hidden"),
      checked: (document.querySelector('input[name="reo-kind"]:checked') || {}).value,
      renewDim: (document.querySelector("#reo-renew-fields") || {}).style ? document.querySelector("#reo-renew-fields").style.opacity : null,
      soldDim: (document.querySelector("#reo-sold-fields") || {}).style ? document.querySelector("#reo-sold-fields").style.opacity : null,
    }));
    ok("C2a · the chip opens the R58 rate-end outcome overlay",
      renewOverlay.hidden === false && /Rate-end outcome/.test(renewOverlay.heading), JSON.stringify(renewOverlay));
    eq("C2b · …preselected on 'Renewed'", renewOverlay.checked, "renewed");
    eq("C2c · …with the renewal fields live and the sold half dimmed", [renewOverlay.renewDim, renewOverlay.soldDim], ["", "0.45"]);
    // The confirm copy that names the side effects is NOT bypassed.
    const namesEffects = await page.evaluate(() => {
      const p = [...document.querySelectorAll("#overlay-modal .panel-sub")].map((e) => e.textContent).join(" ");
      return /Recorded on the case with a note/i.test(p) && /any open retention case for this rate is closed/i.test(p);
    });
    ok("C2d · the overlay still names its side effects — the chip is a route in, not a shortcut past", namesEffects);
    await page.evaluate(() => { const b = document.querySelector("#reo-cancel"); if (b) b.click(); });
    await page.waitForTimeout(900);
    eq("C2e · cancelling writes nothing", (await caseRow(page, done.caseId)).rate_end_date, ymd(-30));

    // C3 — "Property sold" opens the SAME overlay on the other radio, and recording it works.
    await goPage(page, "retention", 2800);
    await page.click(`#ret-rates-list button[onclick*="retRateOutcome('${sold.caseId}','sold')"]`);
    await page.waitForTimeout(1500);
    const soldOverlay = await page.evaluate(() => ({
      checked: (document.querySelector('input[name="reo-kind"]:checked') || {}).value,
      renewDim: document.querySelector("#reo-renew-fields").style.opacity,
      soldDim: document.querySelector("#reo-sold-fields").style.opacity,
      soldDate: document.querySelector("#reo-sold-date").value,
    }));
    eq("C3a · the 'Property sold' chip opens the overlay on the SOLD radio", soldOverlay.checked, "sold");
    eq("C3b · …with the sold half live and the renewal half dimmed", [soldOverlay.renewDim, soldOverlay.soldDim], ["0.45", ""]);
    await page.click("#reo-ok");
    await page.waitForTimeout(3200);
    const soldCase = await caseRow(page, sold.caseId);
    eq("C3c · recording it clears the rate tracking (R58's own write, unchanged)", [soldCase.rate_end_date, soldCase.erc_end_date], [null, null]);
    eq("C3d · …and marks the property sold", soldCase.property_sold_at, soldOverlay.soldDate);
    ok("C3e · …with the R58 note on the case",
      (await notesFor(page, sold.caseId)).some((b) => /Rate-end outcome — property sold/.test(b)),
      JSON.stringify(await notesFor(page, sold.caseId)));
    const gone = await rowFor(page, "#ret-rates-list", sold.caseId);
    ok("C3f · the Retention list repaints and the row you just worked is gone (H2)", gone === null, JSON.stringify(gone));
    const modalUp = await page.evaluate(() => !document.getElementById("modal-backdrop").classList.contains("hidden"));
    ok("C3g · …without dumping you into the case modal", modalUp === false);

    // C4 — the third chip is startRetentionCase, unchanged (native confirm, real successor).
    await goPage(page, "retention", 2800);
    page.__dialogs = [];
    await page.click(`#ret-rates-list button[onclick*="startRetentionCase('${retain.caseId}', event)"]`);
    await page.waitForTimeout(3200);
    ok("C4a · 'Re-mortgaging with us' asks the same confirm the row's own button asks",
      page.__dialogs.some((d) => d.type === "confirm" && /retention case/i.test(d.message)), JSON.stringify(page.__dialogs.slice(0, 2)));
    const successors = await page.evaluate(async (id) => {
      const { data } = await window.__mockDb.from("cases").select("*");
      return (data || []).filter((c) => c.retention_source_case_id === id).map((c) => ({ stage: c.stage, assigned_to: c.assigned_to }));
    }, retain.caseId);
    eq("C4b · …and creates exactly one follow-on case, on the source case's adviser", successors, [{ stage: "enquiry", assigned_to: "p2" }]);

    ok("§C · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §D · B4 — TAP TO CALL AND TAP TO TEXT, ON EVERY SURFACE THAT KNOWS A NUMBER
     ====================================================================== */
  console.log("\n— §D · B4 · tel: / sms: on the Retention rows and Today's drawer");
  {
    const page = await boot(browser, "p4");     // the owner sees the whole firm's book
    const t = tag();
    const withPhone = await mkClientCase(page, { first: "Marjorie", last: "R70D" + t, phone: "07700 900 841", case: { lender: "Halifax", rate_percent: 2.2, rate_end_date: ymd(45), completed_at: ymd(-500), loan_amount: 240000, property_address: "30 R70 Tel, Testtown TE7 3AA" } });
    const noPhone = await mkClientCase(page, { first: "Nigel", last: "R70Dnp" + t, phone: null, case: { lender: "Skipton", rate_percent: 2.3, rate_end_date: ymd(46), completed_at: ymd(-510), loan_amount: 250000, property_address: "31 R70 Tel, Testtown TE7 3AB" } });

    await goPage(page, "retention", 3000);
    const r = await rowFor(page, "#ret-rates-list", withPhone.caseId);
    const rn = await rowFor(page, "#ret-rates-list", noPhone.caseId);
    eq("D1a · the row's tel: href is the number, stripped to diallable characters", r && r.tel, "tel:07700900841");
    eq("D1b · …printed verbatim as the record holds it", r && r.telText, "07700 900 841");
    ok("D1c · a client with no number gets neither link", rn && rn.tel === null && rn.sms === null, JSON.stringify(rn));

    // The sms: deep link — recomputed here rather than borrowed from app.js.
    const expectBody = encodeURIComponent(`Hi Marjorie, it's Daniel from NexMoney — your mortgage rate ends ${new Date(ymd(45) + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}; when suits for a quick call?`)
      .replace(/['()!*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
    eq("D2a · the sms: deep link carries the house template, URL-encoded, on the same number",
      r && r.sms, `sms:07700900841?&body=${expectBody}`);
    ok("D2b · …naming the client, the signed-in adviser and the rate-end date",
      !!r && /Hi%20Marjorie/.test(r.sms) && /Daniel/.test(decodeURIComponent(r.sms)) && /NexMoney/.test(decodeURIComponent(r.sms)), r && r.sms);
    ok("D2c · …and no apostrophe or bracket escapes the encoding", !!r && !/['()!*]/.test(r.sms.split("body=")[1] || ""), r && r.sms);
    ok("D2d · the link says out loud that nothing is sent, queued or recorded",
      !!r && /nothing is sent from here/i.test(r.smsTitle || "") && /nothing is queued/i.test(r.smsTitle || "") && /nothing is recorded on the case/i.test(r.smsTitle || ""),
      r && r.smsTitle);

    // D3 — the same pair on Today's drawer, which had none at all before R70.
    await goPage(page, "dashboard", 3200);
    const d = await rowFor(page, "#alerts-rateerc", withPhone.caseId);
    ok("D3a · fixture — the seeded case reaches Today's Rate & ERC drawer", !!d, "row not found");
    eq("D3b · the drawer row now carries the same tel: link", d && d.tel, "tel:07700900841");
    eq("D3c · …and the same sms: deep link", d && d.sms, r && r.sms);
    eq("D3d · …while still carrying none of the page-only action cluster",
      await page.evaluate(() => document.querySelectorAll("#alerts-rateerc .ret-row-acts, #alerts-rateerc .ret-cb").length), 0);

    // D4 — My Day. The numbers come off the case-meta read the briefing already runs.
    const brief = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#briefing-list .brief-row:not(.brief-subrow)")];
      return {
        rows: rows.length,
        withTel: rows.filter((x) => x.querySelector("a[href^='tel:']")).length,
        withSms: rows.filter((x) => x.querySelector("a[href^='sms:']")).length,
        sample: (rows.find((x) => x.querySelector("a[href^='sms:']")) || { querySelector: () => null }).querySelector("a[href^='sms:']"),
      };
    });
    ok("D4a · My Day rows carry a tel: link wherever a number is known", brief.withTel > 0, JSON.stringify(brief));
    eq("D4b · …and every one of them carries the matching sms: link", brief.withSms, brief.withTel);
    // Ground truth: a My Day row whose client genuinely has no phone offers neither link.
    const noPhoneRows = await page.evaluate(async () => {
      const { data: cls } = await window.__mockDb.from("clients").select("id,phone");
      const noPhone = new Set((cls || []).filter((c) => !c.phone).map((c) => c.id));
      const { data: cases } = await window.__mockDb.from("cases").select("id,client_id");
      const owner = {}; (cases || []).forEach((c) => { owner[c.id] = c.client_id; });
      let bad = 0;
      [...document.querySelectorAll("#briefing-list .brief-row")].forEach((row) => {
        const t = row.querySelector(".t[onclick]");
        const m = t && (t.getAttribute("onclick").match(/openCase\('([^']+)'\)/) || []);
        const cid = m && m[1] ? owner[m[1]] : null;
        if (cid && noPhone.has(cid) && row.querySelector("a[href^='tel:']")) bad++;
      });
      return bad;
    });
    eq("D4c · …and no row invents one for a client whose record has no number", noPhoneRows, 0);
    ok("§D · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §E · B4 / L1 — THE RADAR BECOMES A PRODUCT-TRANSFER WORKLIST
     ====================================================================== */
  console.log("\n— §E · B4/L1 · the no-next-action radar: rate first, quiet-days as the tiebreak, capped at 25");
  {
    const page = await boot(browser, "p4");
    const t = tag();
    /* Thirty quiet live cases, seeded in ONE round trip: enough to prove the cap, with rate ends
       spread so the order can be checked against ground truth computed here. */
    const seeded = await page.evaluate(async (o) => {
      const db = window.__mockDb;
      const out = [];
      for (let i = 0; i < 30; i++) {
        const { data: cl } = await db.from("clients").insert({ first_name: "Radar", last_name: o.t + "_" + String(i).padStart(2, "0"), phone: "0770090" + String(1000 + i) }).select("id").single();
        const { data: cs } = await db.from("cases").insert({
          client_id: cl.id, case_kind: "product_transfer", stage: "enquiry", assigned_to: "p2",
          lender: i % 2 ? "Skipton" : "Halifax",
          rate_end_date: new Date(Date.now() + (i - 5) * 3 * 86400000).toISOString().slice(0, 10),
        }).select("id").single();
        await db.from("case_events").delete().eq("case_id", cs.id);
        await db.from("case_notes").delete().eq("case_id", cs.id);
        out.push({ caseId: cs.id, rate: null });
      }
      return out;
    }, { t });
    ok("E0 · fixture — thirty quiet product-transfer cases seeded", seeded.length === 30, String(seeded.length));
    await goPage(page, "dashboard", 3600);

    const radar = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#unactioned-list .row-item")];
      return {
        rows: rows.length,
        ids: rows.map((r) => ((r.querySelector(".t[onclick]") || { getAttribute: () => "" }).getAttribute("onclick").match(/openCase\('([^']+)'\)/) || [])[1]),
        rateLines: rows.filter((r) => r.querySelector(".unactioned-rate")).length,
        tels: rows.filter((r) => r.querySelector("a[href^='tel:']")).length,
        smss: rows.filter((r) => r.querySelector("a[href^='sms:']")).length,
        more: (document.querySelector("#unactioned-list .unactioned-more") || {}).textContent || "",
        count: (document.querySelector("#unactioned-panel .count") || {}).textContent || "",
        firstRate: (document.querySelector("#unactioned-list .unactioned-rate") || {}).textContent || "",
      };
    });
    eq("E1a · the radar is capped at 25 rows (L1 — it was the last uncapped list on Today)", radar.rows, 25);
    ok("E1b · …with the tail named and handed to the Pipeline, not dropped",
      /…and \d+ more/.test(radar.more) && /open Pipeline/.test(radar.more), radar.more);
    // Ground truth for the order, recomputed here from the mock.
    const truth = await page.evaluate(async () => {
      const db = window.__mockDb;
      const { data: cases } = await db.from("cases").select("*");
      const { data: tasks } = await db.from("case_tasks").select("*");
      const { data: notes } = await db.from("case_notes").select("*");
      const { data: events } = await db.from("case_events").select("*");
      const since = Date.now() - 7 * 86400000;
      const openTask = new Set((tasks || []).filter((x) => !x.done_at).map((x) => x.case_id));
      const act = {};
      [...(notes || []), ...(events || [])].forEach((r) => {
        const ts = new Date(r.created_at).getTime();
        if (!act[r.case_id] || ts > act[r.case_id]) act[r.case_id] = ts;
      });
      const quiet = (cases || []).filter((c) => c.stage !== "completed" && c.stage !== "not_proceeding"
        && !openTask.has(c.id) && !(act[c.id] && act[c.id] >= since));
      const daysQuiet = (c) => Math.max(0, Math.floor((Date.now() - new Date(act[c.id] || c.created_at).getTime()) / 86400000));
      quiet.sort((a, b) => {
        const ra = a.rate_end_date || "", rb = b.rate_end_date || "";
        if (ra !== rb) { if (!ra) return 1; if (!rb) return -1; return ra < rb ? -1 : 1; }
        return daysQuiet(b) - daysQuiet(a);
      });
      return { total: quiet.length, first25: quiet.slice(0, 25).map((c) => c.id), withRate: quiet.slice(0, 25).filter((c) => c.rate_end_date).length };
    });
    ok("E1c · …and the panel count still reports EVERY quiet case, not the 25 on screen",
      Number(radar.count) === truth.total && truth.total > 25, JSON.stringify({ shown: radar.rows, badge: radar.count, truth: truth.total }));
    eq("E2a · the 25 shown are the rate-soonest 25, in that order (quiet-days breaks a tie)", radar.ids, truth.first25);
    eq("E2b · every one of them prints the rate end and the lender that decides the call", radar.rateLines, truth.withRate);
    ok("E2c · …a rate that has already ended says so", /rate ended /.test(radar.firstRate), radar.firstRate);
    eq("E3a · the radar rows carry the tel: link", radar.tels, 25);
    eq("E3b · …and the sms: deep link beside it", radar.smss, 25);
    ok("§E · no console errors", realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  /* ======================================================================
     §F · EVERY PERSONA OPENS BOTH SCREENS CLEAN
     ====================================================================== */
  console.log("\n— §F · every persona opens Today and Retention clean");
  for (const persona of ["p2", "p3", "p4", "p1"]) {
    const page = await boot(browser, persona);
    await goPage(page, "dashboard", 2600);
    await goPage(page, "retention", 2800);
    const seen = await page.evaluate(() => ({
      toggle: !!document.querySelector("#ret-untouched-btn"),
      clauses: document.querySelectorAll("#ret-rates-list .ret-row-lastc").length,
      rows: document.querySelectorAll("#ret-rates-list .row-item").length,
    }));
    ok(`§F · ${persona} sees the never-contacted toggle`, seen.toggle, JSON.stringify(seen));
    ok(`§F · ${persona} · every row on screen carries a last-contact clause`, seen.clauses === seen.rows, JSON.stringify(seen));
    ok(`§F · ${persona} opens Today and Retention with no console errors`, realErrs(page).length === 0, realErrs(page).slice(0, 3).join(" | "));
    await page.close();
  }

  await browser.close();
  if (srv) { try { process.kill(-srv.pid); } catch (e) { /* the server was somebody else's */ } }

  console.log("\n================================================================");
  console.log(`r70_calls: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
