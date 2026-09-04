#!/usr/bin/env node
/* =============================================================================
   tests/r79_send.js — acceptance tests for R79 build A, "Trust the send".

   What R79 · A changed, and what each section pins:

     §A  REAL PREVIEWS (A2). previewComposeEmail is a faithful client-side
         replica of process-emails v19's compose(): the ACTUAL sentences and
         the ACTUAL subject per type (the fold leads with "Subject:"), built
         from the same row/case/client/settings inputs — per-adviser sign-off
         (the profile's email_signoff block wins, else v19's exact
         "Best regards, / <adviser> / <company>"), the property-mention rules
         (in-sentence on/for/of fragments vs the standalone "Regarding:"
         line), the docs chase variant, the reminder variant of
         review_request, and v19's unsubscribe footer on EXACTLY the four
         marketing-adjacent types. A stored body (custom) still wins (R74).
         The fold's note says — truthfully now — "This is the exact wording
         the send composes."

     §B  EMAILS PAGE TRUTH AT SCALE (A3). The status chips and the summary
         count the WHOLE email_queue via head:true count queries (folded into
         wave 1 — R78's two-wave budget holds); the LIST stays windowed at
         the newest 100 with honest wording. Backlog honesty: >50 due queued
         says "up to 50 per run — ~X runs".

     §C  SENT THIS MORNING (A3). #em-morning lists what has ACTUALLY gone out
         since London midnight, grouped by type with the first recipients
         named; yesterday's sends are excluded; the empty state is honest.

     §D  HELD HONESTY ON PER-CASE SENDS (A4). Every per-case send confirm
         carries the holdLine while emailHoldOn(); sendResultToast has a held
         branch ("Email queued and HELD — …"); the auto chase/follow-up tasks
         (rate-end 7-day, fact-find 3-day) are NOT created while held and the
         toast says so.

     §E  MOCK v19 PARITY (A5/A1). The scoped send path enforces the hold like
         prod ({held:true, pending, warning}, rows stay queued); an opted-out
         client's queued marketing row is CANCELLED at send time with the
         exact error "client opted out of these emails"; the unscoped run
         sends oldest-due-first (order asserted on the composed sequence,
         capped at 50); the four marketing types compose the unsubscribe
         footer + url; a successful factfind/docs_request send stamps the
         30-day link expiry.

   Run:  node /root/nx/tests/r79_send.js
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

async function boot(browser, persona) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.__ctx = ctx;
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const goto = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms || 1600);
};
const wait = (page, ms) => page.waitForTimeout(ms);

/* Flip the hold / the mock's server key, then refresh the app's settings cache
   (r76_intake's documented pattern — an admin cannot write settings). */
async function setHold(page, value) {
  await page.evaluate(async (v) => {
    const all = (await window.__mockDb.from("settings").select("*")).data || window.__mock.db.settings;
    const rows = window.__mock.db ? window.__mock.db.settings : all;
    const row = rows.filter((r) => r.key === "email_hold")[0];
    if (row) row.value = v; else rows.push({ key: "email_hold", value: v });
    await window.__reloadSettings();
  }, value);
}

/* One preview-fixture case: every field v19's compose() reads, on one row. */
async function seedPreviewCase(page) {
  return page.evaluate(async () => {
    const db = window.__mockDb;
    const { data: cl } = await db.from("clients").insert({
      first_name: "Petra", last_name: "Villers", email: "petra.villers@example.com", phone: "07700 900901",
    }).select("*").single();
    const rateEnd = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
    const { data: cs } = await db.from("cases").insert({
      client_id: cl.id, case_kind: "purchase", stage: "offer", lender: "Halifax",
      property_address: "9 Test Road, Bournemouth BH1 1AA",
      rate_end_date: rateEnd, rate_type: "fixed", rate_percent: 4.5,
      broker_fee: 495, assigned_to: "p2", doc_token: "doc-r79-tok",
    }).select("*").single();
    return { clientId: cl.id, caseId: cs.id, rateEnd };
  });
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {

    /* =======================================================================
       §A · A2 — THE PREVIEW IS v19's OWN WORDING
       ===================================================================== */
    {
      console.log("\n— §A · previews carry v19's real sentences, subject and footer (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      const fx = await seedPreviewCase(page);

      // One queued row per composed type on the fixture case (+ a lead_ack on a lead).
      const seeded = await page.evaluate(async (fx) => {
        const db = window.__mockDb;
        const types = ["welcome", "factfind", "docs_request", "submitted_update", "offer_update",
          "protection_offer", "gi_exchange", "completion_congrats", "referral_request",
          "birthday_greeting", "completion_anniversary", "rate_end_reminder", "rate_end_chase",
          "review_request", "fee_request", "review_reminder"];
        const ids = {};
        for (const t of types) {
          const row = { case_id: fx.caseId, client_id: fx.clientId, email_type: t, to_email: "petra.villers@example.com", status: "queued" };
          if (t === "offer_update") row.attachment_path = "offers/r79-offer.pdf";
          const { data } = await db.from("email_queue").insert(row).select("id").single();
          ids[t] = data.id;
        }
        // Checklist on the case (two outstanding) so docs_request composes the checklist variant.
        await db.from("case_documents").insert([
          { case_id: fx.caseId, item: "Photo ID", status: "requested" },
          { case_id: fx.caseId, item: "Latest payslip", status: "requested" },
        ]);
        // A lead + its acknowledgement row.
        const { data: ld } = await db.from("leads").insert({ name: "Bertram Quill", email: "bert.quill@example.com", status: "new" }).select("id").single();
        const { data: ack } = await db.from("email_queue").insert({ lead_id: ld.id, email_type: "lead_ack", to_email: "bert.quill@example.com", status: "queued" }).select("id").single();
        ids.lead_ack = ack.id;
        // A stored (custom) email — the stored body must win.
        const { data: cust } = await db.from("email_queue").insert({
          case_id: fx.caseId, client_id: fx.clientId, email_type: "custom", to_email: "petra.villers@example.com",
          status: "queued", subject: "R79 stored subject", body_html: "<p>Hand written by the adviser.</p>",
        }).select("id").single();
        ids.custom = cust.id;
        return ids;
      }, fx);

      await goto(page, "emails", 3000);
      const folds = await page.evaluate((ids) => {
        const out = {};
        for (const [t, id] of Object.entries(ids)) {
          const fold = document.querySelector(`#email-list details.em-fold[data-em-preview="${id}"]`);
          if (!fold) { out[t] = null; continue; }
          fold.open = true;
          const body = fold.querySelector(".em-prev-body");
          out[t] = {
            subject: (fold.querySelector(".em-prev-subject") || {}).textContent.replace(/\s+/g, " ").trim(),
            body: body ? body.textContent.replace(/\s+/g, " ").trim() : "",
            composed: !!(body && body.dataset.emComposed),
            unsub: !!fold.querySelector(".em-prev-unsub"),
            note: (fold.querySelector(".em-prev-note") || {}).textContent.replace(/\s+/g, " ").trim(),
            anchors: fold.querySelectorAll("a[href]").length,
          };
        }
        return out;
      }, seeded);

      const edgeDate = await page.evaluate((d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), fx.rateEnd);

      const f = (t) => folds[t] || { subject: "", body: "", note: "" };
      ok("A1a · every composed type renders a preview", Object.keys(seeded).every((t) => t === "custom" || (folds[t] && folds[t].composed)),
        JSON.stringify(Object.keys(seeded).filter((t) => t !== "custom" && !(folds[t] && folds[t].composed))));
      ok("A1b · the fold leads with a Subject: line", f("welcome").subject.startsWith("Subject:"), f("welcome").subject);

      // Subjects — v19's own, verbatim.
      const subj = (t) => f(t).subject.replace(/^Subject:\s*/, "");
      eq("A2a · welcome subject", subj("welcome"), "Welcome to NexMoney – here's what happens next");
      eq("A2b · factfind subject", subj("factfind"), "NexMoney – your mortgage fact find (5–10 minutes)");
      eq("A2c · docs (chase-free) subject", subj("docs_request"), "NexMoney – documents we'll need from you");
      eq("A2d · submitted subject", subj("submitted_update"), "Good news – your mortgage application has been submitted");
      eq("A2e · offer subject", subj("offer_update"), "Your mortgage offer has been issued 🎉");
      eq("A2f · protection subject", subj("protection_offer"), "Your mortgage is agreed – have you protected it?");
      eq("A2g · gi subject", subj("gi_exchange"), "Buildings insurance needs to be in place when you exchange");
      eq("A2h · completion subject", subj("completion_congrats"), "Congratulations – your mortgage has completed! 🏡");
      eq("A2i · referral subject", subj("referral_request"), "Know someone who needs mortgage help?");
      eq("A2j · birthday subject", subj("birthday_greeting"), "Happy birthday from NexMoney! 🎂");
      eq("A2k · anniversary subject", subj("completion_anniversary"), "A year on – how's the home? 🏡");
      eq("A2l · rate-end subject carries the edge's long-month date", subj("rate_end_reminder"), `Your mortgage rate ends on ${edgeDate} – let's review your options`);
      eq("A2m · rate chase subject", subj("rate_end_chase"), `Still time to sort your new rate before ${edgeDate}`);
      eq("A2n · review subject (first ask)", subj("review_request"), "Thanks for choosing NexMoney – how did we do?");
      eq("A2o · review_reminder subject (the 2nd ask IS v19's reminder variant)", subj("review_reminder"), "A quick nudge – how did we do?");
      eq("A2p · fee subject", subj("fee_request"), "NexMoney – broker fee payment details");
      eq("A2q · lead_ack subject", subj("lead_ack"), "Thank you for your enquiry – NexMoney");

      // Bodies — v19's actual sentences, with the case's own facts woven in.
      ok("A3a · welcome opens Hi <first> with v19's first sentence",
        f("welcome").body.includes("Hi Petra,") && f("welcome").body.includes("Thanks for your enquiry – it's great to have you on board. I'll be looking after your mortgage personally."), f("welcome").body.slice(0, 200));
      ok("A3b · submitted weaves lender AND property into the sentence",
        f("submitted_update").body.includes("your application to Halifax for 9 Test Road, Bournemouth BH1 1AA has been submitted. 🎉"), f("submitted_update").body.slice(0, 220));
      ok("A3c · offer names the lender and the attached PDF",
        f("offer_update").body.includes("Excellent news – Halifax has issued your mortgage offer for 9 Test Road")
        && f("offer_update").body.includes("We've attached a copy of your offer document"), f("offer_update").body.slice(0, 260));
      ok("A3d · protection carries the Regarding line and the compliance sentence",
        f("protection_offer").body.includes("Regarding: 9 Test Road, Bournemouth BH1 1AA")
        && f("protection_offer").body.includes("not personal advice or a recommendation. Any recommendation would only follow a full review of your circumstances."), f("protection_offer").body.slice(0, 260));
      ok("A3e · gi weaves the property with 'of'",
        f("gi_exchange").body.includes("exchange of contracts on your purchase of 9 Test Road"), f("gi_exchange").body.slice(0, 200));
      ok("A3f · completion weaves the property with 'on'",
        f("completion_congrats").body.includes("your mortgage on 9 Test Road, Bournemouth BH1 1AA has completed. Congratulations!"), f("completion_congrats").body.slice(0, 220));
      ok("A3g · rate-end reminder carries type, lender, percent, property and the long date",
        f("rate_end_reminder").body.includes(`Your current fixed rate with Halifax (4.5%) for your mortgage on 9 Test Road, Bournemouth BH1 1AA is due to end on ${edgeDate}.`), f("rate_end_reminder").body.slice(0, 300));
      ok("A3h · docs lists ONLY the outstanding items and the v19 doc link",
        f("docs_request").body.includes("· Photo ID") && f("docs_request").body.includes("· Latest payslip")
        && f("docs_request").body.includes("https://www.nexmoney.co.uk/docs?token=doc-r79-tok"), f("docs_request").body.slice(0, 300));
      ok("A3i · factfind names the link as built-at-send, never invents one",
        f("factfind").body.includes("Start your fact find → (a secure link, built for this client at the moment the email goes)")
        && !/token=/.test(f("factfind").body), f("factfind").body.slice(0, 260));
      ok("A3j · review (first ask) carries v19's sentences and the review-link CTA",
        f("review_request").body.includes("Congratulations on completing your mortgage – it's been a pleasure helping you.")
        && f("review_request").body.includes("Leave a review → https://g.page/r/nexmoney-bournemouth/review"), f("review_request").body.slice(0, 280));
      ok("A3k · review reminder carries the gentle-reminder sentence",
        f("review_reminder").body.includes("so this is just one gentle reminder – and the last time we'll ask."), f("review_reminder").body.slice(0, 240));
      ok("A3l · fee carries the amount, the reference, and says who fills the bank lines in",
        f("fee_request").body.includes("our broker fee for arranging your mortgage is £495.00")
        && f("fee_request").body.includes(`Reference: VILLERS-${String(fx.caseId).slice(0, 6).toUpperCase()}`)
        && /filled in from Settings by the send/.test(f("fee_request").body), f("fee_request").body.slice(0, 320));
      ok("A3m · lead_ack greets the enquirer by first name",
        f("lead_ack").body.includes("Hi Bertram,") && f("lead_ack").body.includes("Your enquiry has reached us and it is in hand."), f("lead_ack").body.slice(0, 200));

      // Sign-off — the case adviser's own block (Wayne p2 has one).
      ok("A4a · the adviser's own email_signoff block signs the mail",
        f("welcome").body.includes("Wayne Kellow") && f("welcome").body.includes("Mortgage & Protection Adviser"), f("welcome").body.slice(-200));
      ok("A4b · lead_ack (no case, no adviser) falls back to v19's Best regards + firm",
        f("lead_ack").body.includes("Best regards,") && f("lead_ack").body.includes("NexMoney"), f("lead_ack").body.slice(-160));

      // The unsubscribe footer — EXACTLY the four marketing-adjacent types (+ the 2nd-ask reminder, which is one of them).
      const unsubOn = Object.keys(folds).filter((t) => folds[t] && folds[t].unsub).sort();
      eq("A5a · unsubscribe footer on exactly the marketing-adjacent set",
        unsubOn, ["birthday_greeting", "completion_anniversary", "referral_request", "review_reminder", "review_request"]);
      ok("A5b · …with v19's exact sentence",
        f("birthday_greeting").body === f("birthday_greeting").body && (await page.evaluate((id) => {
          const fold = document.querySelector(`#email-list details.em-fold[data-em-preview="${id}"]`);
          return (fold.querySelector(".em-prev-unsub") || {}).textContent || "";
        }, seeded.birthday_greeting)) === "Prefer not to get emails like this? Unsubscribe.", "footer text mismatch");

      // The note, the truth claim, and the inert pipeline.
      ok("A6a · the fold says: This is the exact wording the send composes.",
        /This is the exact wording the send composes\./.test(f("welcome").note), f("welcome").note);
      eq("A6b · still zero live links in any preview", Object.values(folds).filter(Boolean).reduce((a, x) => a + x.anchors, 0), 0);
      ok("A6c · a stored (custom) body still wins and says it is the stored text",
        folds.custom && !folds.custom.composed && folds.custom.body.includes("Hand written by the adviser")
        && /stored text/.test(folds.custom.note) && subj("custom") === "R79 stored subject", JSON.stringify(folds.custom));

      // The reminder VARIANT on review_request itself: a prior non-cancelled ask flips the wording.
      const variant = await page.evaluate(async (fx) => {
        const db = window.__mockDb;
        const old = new Date(Date.now() - 20 * 86400000).toISOString();
        await db.from("email_queue").insert({
          case_id: fx.caseId, client_id: fx.clientId, email_type: "review_request", to_email: "petra.villers@example.com",
          status: "sent", sent_at: old, created_at: old,
        });
        await window.loadEmails();
        await new Promise((r) => setTimeout(r, 1200));
        return null;
      }, fx);
      const rr2 = await page.evaluate((id) => {
        const fold = document.querySelector(`#email-list details.em-fold[data-em-preview="${id}"]`);
        if (!fold) return null;
        fold.open = true;
        return {
          subject: (fold.querySelector(".em-prev-subject") || {}).textContent.replace(/\s+/g, " ").trim(),
          body: (fold.querySelector(".em-prev-body") || {}).textContent.replace(/\s+/g, " ").trim(),
        };
      }, seeded.review_request);
      ok("A7a · a review_request with a prior ask now previews the REMINDER wording (v19's same-type variant)",
        rr2 && /A quick nudge – how did we do\?/.test(rr2.subject) && /one gentle reminder/.test(rr2.body), JSON.stringify(rr2));

      // …and the docs chase variant, same mechanism.
      const dc = await page.evaluate(async (arg) => {
        const db = window.__mockDb;
        const old = new Date(Date.now() - 9 * 86400000).toISOString();
        await db.from("email_queue").insert({
          case_id: arg.fx.caseId, client_id: arg.fx.clientId, email_type: "docs_request", to_email: "petra.villers@example.com",
          status: "sent", sent_at: old, created_at: old,
        });
        await window.loadEmails();
        await new Promise((r) => setTimeout(r, 1200));
        const fold = document.querySelector(`#email-list details.em-fold[data-em-preview="${arg.id}"]`);
        if (!fold) return null;
        fold.open = true;
        return {
          subject: (fold.querySelector(".em-prev-subject") || {}).textContent.replace(/\s+/g, " ").trim(),
          body: (fold.querySelector(".em-prev-body") || {}).textContent.replace(/\s+/g, " ").trim(),
        };
      }, { fx, id: seeded.docs_request });
      ok("A7b · a docs_request with a prior ask previews the chase wording and counts the missing items",
        dc && /still waiting on 2 documents/.test(dc.subject) && /Just a gentle nudge – we're still missing a few things/.test(dc.body), JSON.stringify(dc));

      eq("§A · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =======================================================================
       §B · A3 — CHIPS AND SUMMARY COUNT THE WHOLE TABLE
       ===================================================================== */
    {
      console.log("\n— §B · chips/summary from real count queries, list stays windowed (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;

      // Seed well past the 100-row window: 160 sent, 70 queued-due, 25 failed, 15 cancelled.
      await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").select("id,email").not("email", "is", null).limit(1);
        const c = cl[0];
        const mk = (n, status, extra) => Array.from({ length: n }, (_, i) => Object.assign({
          client_id: c.id, email_type: "review_request", to_email: c.email, status,
          created_at: new Date(Date.now() - (i + 3) * 86400000).toISOString(),
        }, extra || {}));
        const rows = [
          ...mk(160, "sent", { sent_at: new Date(Date.now() - 3 * 86400000).toISOString() }),
          ...mk(70, "queued"),
          ...mk(25, "failed", { error: "bounce" }),
          ...mk(15, "cancelled"),
        ];
        for (let i = 0; i < rows.length; i += 50) await db.from("email_queue").insert(rows.slice(i, i + 50));
      });
      await goto(page, "emails", 3200);

      const truth = await page.evaluate(async () => {
        const db = window.__mockDb;
        const count = async (st) => (await db.from("email_queue").select("id", { count: "exact", head: true }).eq("status", st)).count;
        const out = {};
        for (const st of ["queued", "sending", "sent", "failed", "cancelled"]) out[st] = await count(st) || 0;
        out.all = out.queued + out.sending + out.sent + out.failed + out.cancelled;
        const { count: due } = await db.from("email_queue").select("id", { count: "exact", head: true })
          .eq("status", "queued").or(`scheduled_for.is.null,scheduled_for.lte.${new Date().toISOString()}`);
        out.due = due || 0;
        return out;
      });
      const chips = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#em-filters [data-em-status]")]
        .map((b) => [b.dataset.emStatus, Number((b.querySelector(".seg-count") || {}).textContent || "-1")])));
      ok("B1a · the table genuinely out-runs the window (fixture sanity)", truth.all > 150, JSON.stringify(truth));
      eq("B1b · chips = the DB's own per-status counts, not the window's",
        [chips.queued, chips.sent, chips.failed, chips.cancelled, chips.all, chips.needs, chips.history],
        [truth.queued, truth.sent, truth.failed, truth.cancelled, truth.all, truth.queued + truth.failed, truth.sent + truth.cancelled]);
      const listN = await page.evaluate(() => document.querySelectorAll("#email-list .row-item.qrow-queued, #email-list .row-item.qrow-failed, #email-list .row-item.qrow-sent, #email-list .row-item.qrow-cancelled").length);
      ok("B1c · the LIST stays windowed (≤100 rows)", listN <= 100, String(listN));
      const summary = await page.evaluate(() => (document.getElementById("em-summary") || {}).textContent || "");
      ok("B1d · the summary counts the whole queue and says the list is the window",
        summary.includes(String(truth.queued)) && /newest 100 rows are listed below — the counts here cover the whole queue/.test(summary), summary.slice(0, 300));
      ok("B1e · backlog honesty: >50 due says up-to-50-per-run and ~N runs",
        /up to 50 per run/.test(summary) && new RegExp(`~${Math.ceil(truth.due / 50)} runs`).test(summary), summary.slice(0, 380));
      ok("B1f · the held summary still leads with the hold (fixture holds email_hold=on)",
        /held/.test(summary) && /email sending is on hold/i.test(summary), summary.slice(0, 200));

      eq("§B · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =======================================================================
       §C · A3 — SENT THIS MORNING
       ===================================================================== */
    {
      console.log("\n— §C · the morning panel groups today's ACTUAL sends by type (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;

      await goto(page, "emails", 2600);
      const empty = await page.evaluate(() => (document.getElementById("em-morning") || {}).textContent || "");
      ok("C1a · honest empty state before anything has sent today",
        /Sent this morning/.test(empty) && /Nothing has been sent since midnight \(Europe\/London\)/.test(empty), empty.slice(0, 220));
      ok("C1b · …and while held it says the silence is expected", /email sending is on hold, so that is expected/.test(empty), empty.slice(0, 260));

      await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cls } = await db.from("clients").select("id,email,first_name,last_name").not("email", "is", null).limit(4);
        const now = new Date().toISOString();
        const yesterday = new Date(Date.now() - 26 * 3600000).toISOString();
        const rows = [];
        for (let i = 0; i < 3; i++) rows.push({ client_id: cls[i].id, email_type: "review_request", to_email: cls[i].email, status: "sent", sent_at: now });
        for (let i = 0; i < 2; i++) rows.push({ client_id: cls[i].id, email_type: "birthday_greeting", to_email: cls[i].email, status: "sent", sent_at: now });
        rows.push({ client_id: cls[3].id, email_type: "welcome", to_email: cls[3].email, status: "sent", sent_at: yesterday });
        await db.from("email_queue").insert(rows);
        await window.loadEmails();
        await new Promise((r) => setTimeout(r, 1200));
      });
      const morning = await page.evaluate(() => ({
        sub: (document.getElementById("em-morning-sub") || {}).textContent || "",
        rows: [...document.querySelectorAll("#em-morning .em-morning-row")].map((r) => ({
          type: r.dataset.morningType,
          n: Number((r.querySelector(".em-morning-n") || {}).textContent || "-1"),
          who: (r.querySelector(".s") || {}).textContent || "",
        })),
      }));
      eq("C2a · grouped by type with counts (yesterday's send excluded)",
        morning.rows.map((r) => [r.type, r.n]), [["review_request", 3], ["birthday_greeting", 2]]);
      ok("C2b · the total says 5 and names the window", /5/.test(morning.sub) && /since midnight \(Europe\/London\)/.test(morning.sub), morning.sub.slice(0, 220));
      ok("C2c · the first recipients are named on the row", morning.rows[0] && /[A-Za-z]+ [A-Za-z]/.test(morning.rows[0].who), JSON.stringify(morning.rows[0]));

      eq("§C · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =======================================================================
       §D · A4 — HELD HONESTY ON PER-CASE SENDS
       ===================================================================== */
    {
      console.log("\n— §D · every per-case send confirm carries the holdLine; held toast; no chase task (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      const fx = await seedPreviewCase(page);
      // Bank details so the fee gate opens (direct fixture mutation — owner-RLS'd in the app).
      await page.evaluate(async () => {
        const rows = window.__mock.db.settings;
        [["bank_account_name", "NexMoney Ltd"], ["bank_sort_code", "12-34-56"], ["bank_account_number", "12345678"]].forEach(([k, v]) => {
          const r = rows.filter((x) => x.key === k)[0];
          if (r) r.value = v; else rows.push({ key: k, value: v });
        });
        await window.__reloadSettings();
      });

      const HOLD_LINE = "Sending is currently ON HOLD (Settings › Email sending) — this will queue and wait; nothing is sent now.";
      const toastText = () => page.evaluate(() => (document.getElementById("toast") || {}).textContent || "");
      const drive = async (type) => {
        page.__dialogs = [];
        await page.evaluate(async (a) => {
          const { data: c } = await window.__mockDb.from("cases").select("*").eq("id", a.caseId).single();
          await window.queueEmail(a.caseId, a.clientId, a.type, c, null);
        }, { ...fx, type });
        await wait(page, 700);
        const confirms = page.__dialogs.filter((d) => d.type === "confirm");
        return { msg: (confirms[confirms.length - 1] || {}).message || "", toast: await toastText() };
      };

      for (const type of ["rate_end_reminder", "factfind", "review_request", "docs_request", "fee_request"]) {
        const r = await drive(type);
        ok(`D1 · ${type} confirm carries the holdLine`, r.msg.includes(HOLD_LINE), r.msg.slice(-220));
        ok(`D2 · ${type} toast is the held branch`,
          r.toast.includes("Email queued and HELD — nothing sends until the hold is released (Settings › Email sending)."), r.toast);
      }
      // The two chase-carrying types say the task is skipped, in the confirm AND the toast.
      const rr = await drive("rate_end_reminder");
      ok("D3a · rate-end confirm says no follow-up task while held", /No follow-up task will be created while sending is held/.test(rr.msg), rr.msg.slice(-260));
      ok("D3b · …and the held toast owns the skipped chase", /No chase task was created while the hold is on\./.test(rr.toast), rr.toast);
      const ffr = await drive("factfind");
      ok("D3c · fact-find confirm says no chase task while held", /No chase task will be created while sending is held/.test(ffr.msg), ffr.msg.slice(-260));
      const tasks = await page.evaluate(async (fx) => {
        const { data } = await window.__mockDb.from("case_tasks").select("title").eq("case_id", fx.caseId);
        return (data || []).map((t) => t.title);
      }, fx);
      eq("D4 · NO chase/follow-up task exists on the case (both types, both sends)",
        tasks.filter((t) => /Follow up rate-end reminder|Chase fact-find/.test(t)), []);

      // The protection intro's own confirm.
      // R80: RE-POINTED — protQueueEmail's native confirm() became the house overlay
      // (confirmDestructive, non-danger; the R76 natives-go-house rule). Same promo-approval
      // wording, same held sentence — now read from #ovl-confirm-title/-body and confirmed by
      // pressing #ovl-confirm-ok (fire the call UNAWAITED; the overlay blocks it).
      /* PATCHED R82 · A1 — NEW PRECONDITION, deliberate contract change. The protection intro is a
         regulated financial promotion and BOTH queue paths now refuse while
         settings.financial_promotions_approved is off (production's state, and the fixture's).
         Same shape as R79's own "hold off + resend key" precondition: state it, then drive the
         path this section is actually about. The held-branch assertions below are unchanged. */
      await page.evaluate(async () => {
        const rows = window.__mock.db.settings;
        const row = rows.filter((r) => r.key === "financial_promotions_approved")[0];
        if (row) row.value = "on"; else rows.push({ key: "financial_promotions_approved", value: "on" });
        await window.__reloadSettings();
      });
      await page.evaluate((fx) => { window.protQueueEmail(fx.caseId, null); }, fx);
      await wait(page, 700);
      const protMsg = await page.evaluate(() => {
        const t = (document.querySelector("#ovl-confirm-title") || {}).textContent || "";
        const b = (document.querySelector("#ovl-confirm-body") || {}).textContent || "";
        return (t + " " + b).replace(/\s+/g, " ").trim();
      });
      ok("D5a · protection intro confirm carries the holdLine (R80: house overlay body)", protMsg.includes(HOLD_LINE), protMsg);
      ok("D5a2 · …and keeps the promo-approval wording", /Ensure the template has principal approval\./.test(protMsg), protMsg);
      await page.evaluate(() => { const b = document.querySelector("#ovl-confirm-ok"); if (b) b.click(); });
      await wait(page, 1200);
      ok("D5b · protection intro toast is the held branch", /Email queued and HELD/.test(await toastText()), await toastText());

      // The rows all stayed queued — the mock's scoped path now honours the hold like prod.
      const state = await page.evaluate(async (fx) => {
        const { data } = await window.__mockDb.from("email_queue").select("email_type,status").eq("case_id", fx.caseId);
        return { statuses: [...new Set((data || []).map((r) => r.status))], lastRun: window.__mock.lastEmailRun() };
      }, fx);
      eq("D6a · every per-case row stayed queued (nothing sent under the hold)", state.statuses, ["queued"]);
      ok("D6b · the mock testifies: scoped run, held, sent 0",
        state.lastRun && state.lastRun.scoped === true && state.lastRun.held === true && state.lastRun.sent === 0, JSON.stringify(state.lastRun));

      eq("§D · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =======================================================================
       §E · A5/A1 — MOCK v19 PARITY: optout cancel, order, footer, expiry
       ===================================================================== */
    {
      console.log("\n— §E · v19 behaviours on the mock run (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      await setHold(page, "off");
      await page.evaluate(() => window.__mock.setResendKey(true));

      const seeded = await page.evaluate(async () => {
        const db = window.__mockDb;
        const optout = (await db.from("clients").select("id,email,first_name,last_name,comms_optout,comms_token").eq("comms_optout", true).limit(1)).data[0];
        const clean = (await db.from("clients").select("id,email,comms_token").eq("comms_optout", false).not("email", "is", null).limit(1)).data[0];
        const mkQ = async (client, type, schedDaysAgo) => (await db.from("email_queue").insert({
          client_id: client.id, email_type: type, to_email: client.email, status: "queued",
          scheduled_for: new Date(Date.now() - schedDaysAgo * 86400000).toISOString(),
        }).select("id").single()).data.id;
        const optoutBirthday = await mkQ(optout, "birthday_greeting", 1);
        // Three welcome rows deliberately queued OUT of date order, to assert the send order.
        const o1 = await mkQ(clean, "welcome", 2);
        const o2 = await mkQ(clean, "welcome", 5);
        const o3 = await mkQ(clean, "welcome", 3);
        const cleanBirthday = await mkQ(clean, "birthday_greeting", 1);
        return { optout, clean, optoutBirthday, order: { o1, o2, o3 }, cleanBirthday };
      });
      ok("E0 · the fixture seeds opted-out clients (comms_optout=true with a comms_token)",
        seeded.optout && seeded.optout.comms_token, JSON.stringify(seeded.optout));

      const run = await page.evaluate(async () => (await window.__mockDb.functions.invoke("process-emails", { body: {} })).data);
      const after = await page.evaluate(async (s) => {
        const db = window.__mockDb;
        const row = (await db.from("email_queue").select("status,error").eq("id", s.optoutBirthday).single()).data;
        const lastRun = window.__mock.lastEmailRun();
        const composedIds = (lastRun.composed || []).map((c) => c.queue_id);
        const cleanComposed = (lastRun.composed || []).find((c) => c.queue_id === s.cleanBirthday) || null;
        return { row, composedIds, cleanComposed, skipped: lastRun.skipped_optout, considered: lastRun.considered };
      }, seeded);

      eq("E1a · the opted-out birthday row is CANCELLED with the exact v19 error",
        [after.row.status, after.row.error], ["cancelled", "client opted out of these emails"]);
      ok("E1b · the run reports skipped_optout", run && run.skipped_optout >= 1 && after.skipped >= 1, JSON.stringify({ run: run && run.skipped_optout, last: after.skipped }));
      ok("E1c · nothing was composed for the opted-out client", !after.composedIds.includes(seeded.optoutBirthday), "composed the opted-out row");

      const pos = (id) => after.composedIds.indexOf(id);
      ok("E2 · the unscoped run sends oldest-due first (o2 −5d before o3 −3d before o1 −2d)",
        pos(seeded.order.o2) >= 0 && pos(seeded.order.o2) < pos(seeded.order.o3) && pos(seeded.order.o3) < pos(seeded.order.o1),
        JSON.stringify({ o1: pos(seeded.order.o1), o2: pos(seeded.order.o2), o3: pos(seeded.order.o3) }));
      ok("E2b · a run considers at most 50 rows (v18's cap, now modelled)", after.considered <= 50, String(after.considered));

      ok("E3a · the clean birthday composed the unsubscribe footer line",
        after.cleanComposed && (after.cleanComposed.body_lines || []).includes("Prefer not to get emails like this? Unsubscribe."),
        JSON.stringify(after.cleanComposed && after.cleanComposed.body_lines));
      ok("E3b · …and the unsubscribe url carries the client's own id + comms_token",
        after.cleanComposed && after.cleanComposed.unsubscribe_url
        && after.cleanComposed.unsubscribe_url.includes(`c=${seeded.clean.id}`)
        && after.cleanComposed.unsubscribe_url.includes(`t=${seeded.clean.comms_token}`), JSON.stringify(after.cleanComposed && after.cleanComposed.unsubscribe_url));
      const noFooter = await page.evaluate(() => {
        const lr = window.__mock.lastEmailRun();
        return (lr.composed || []).filter((c) => ["welcome"].includes(c.email_type)
          && (c.body_lines || []).includes("Prefer not to get emails like this? Unsubscribe.")).length;
      });
      eq("E3c · transactional types compose NO footer", noFooter, 0);

      // Expiry stamping — factfind + docs_request with a link, scoped sends with the hold off.
      const exp = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").insert({ first_name: "Expiry", last_name: "Case", email: "expiry@example.com" }).select("id").single();
        const { data: cs } = await db.from("cases").insert({ client_id: cl.id, case_kind: "remortgage", stage: "fact_find", doc_token: "doc-r79-exp" }).select("id").single();
        await db.from("case_documents").insert({ case_id: cs.id, item: "Passport", status: "requested" });
        const q = async (t) => (await db.from("email_queue").insert({ case_id: cs.id, client_id: cl.id, email_type: t, to_email: "expiry@example.com", status: "queued" }).select("id").single()).data.id;
        const ffId = await q("factfind");
        const docId = await q("docs_request");
        await db.functions.invoke("process-emails", { body: { queue_ids: [ffId, docId] } });
        const ff = (await db.from("fact_finds").select("expires_at,status").eq("case_id", cs.id).limit(1)).data[0];
        const kase = (await db.from("cases").select("doc_token_expires_at").eq("id", cs.id).single()).data;
        const mails = (await db.from("email_queue").select("email_type,status").in("id", [ffId, docId])).data;
        return { ff, kase, mails };
      });
      const days = (iso) => iso ? Math.round((new Date(iso) - Date.now()) / 86400000) : null;
      eq("E4a · both scoped sends went out with the hold off", exp.mails.map((m) => m.status).sort(), ["sent", "sent"]);
      ok("E4b · the factfind send stamped fact_finds.expires_at ≈ now()+30d",
        exp.ff && days(exp.ff.expires_at) >= 29 && days(exp.ff.expires_at) <= 30, JSON.stringify(exp.ff));
      ok("E4c · the docs send (link carried) stamped cases.doc_token_expires_at ≈ now()+30d",
        days(exp.kase.doc_token_expires_at) >= 29 && days(exp.kase.doc_token_expires_at) <= 30, JSON.stringify(exp.kase));

      eq("§E · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

    /* =======================================================================
       §F · A5 — SCOPED HELD PARITY (the repro'd gap, pinned shut)
       ===================================================================== */
    {
      console.log("\n— §F · a scoped send under the hold sends NOTHING and says so (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      const out = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: cl } = await db.from("clients").select("id,email").not("email", "is", null).limit(1);
        const { data: q } = await db.from("email_queue").insert({
          client_id: cl[0].id, email_type: "review_request", to_email: cl[0].email, status: "queued",
        }).select("id").single();
        const { data: res } = await db.functions.invoke("process-emails", { body: { queue_ids: [q.id] } });
        const row = (await db.from("email_queue").select("status").eq("id", q.id).single()).data;
        return { res, row, lastRun: window.__mock.lastEmailRun() };
      });
      ok("F1a · the scoped response is {held:true, pending, warning} — prod v18/v19's shape",
        out.res && out.res.held === true && out.res.pending >= 1 && /email_hold is on/.test(out.res.warning || ""), JSON.stringify(out.res));
      eq("F1b · the named row stayed queued", out.row.status, "queued");
      ok("F1c · LAST_EMAIL_RUN testifies scoped+held+sent:0",
        out.lastRun && out.lastRun.scoped === true && out.lastRun.held === true && out.lastRun.sent === 0, JSON.stringify(out.lastRun));

      eq("§F · no console errors", realErrs(page).slice(errBefore), []);
      await page.__ctx.close();
    }

  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) { try { srv.kill(); } catch (e2) { /* ignore */ } } }
  }

  console.log(`\nR79_SEND: ${pass} checks passed, ${failures.length} failures`);
  if (failures.length) { failures.forEach((f) => console.log("  FAIL: " + f)); process.exit(1); }
})();
