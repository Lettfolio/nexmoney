#!/usr/bin/env node
/* =============================================================================
   tests/r72_owner.js — acceptance tests for R72 build A, "The owner can see the
   rollout" (R70 panel findings H5a + H5c, M4, M7).

   What the R70 panel found, verified against production on 28 August:
     · the app has NO view of who is using it. Only Daniel has ever signed in —
       Kim, Wayne and Luke were created on 4 July and have never opened it —
       and the single most important fact about the rollout lives only in the
       audit log, which no screen aggregates (H5a);
     · rate-end outcomes are recorded as prose (a 📌 case note, plus
       property_sold_at, plus retention close reasons, plus — for a renewal —
       the case's own rate fields being re-dated), so "how many of the rates
       that ended did we keep?" cannot be answered at all. 593 rates have
       ended; about 550 carry no outcome (H5c);
     · Settings is ten switches each with its own paragraph and nothing that
       says what stands between the firm and go-live (M4);
     · the first-run tour shows the same four owner-shaped steps to every role,
       has never mentioned Retention, and nothing anywhere tells a returning
       user what has changed since they last looked (M7).

     §A  A1 · ADOPTION STRIP — #report-adoption inside the owner scoreboard: one
         row per back-office login (TEAM, not just advisers — the administrator
         is exactly the person this must not omit), with Last active / Cases
         touched 30d / Overdue tasks. Asserts: a person with no audit rows reads
         "never"; a write made in the session moves them to today; SYSTEM rows
         (actor IS NULL — the automation, 9,214 of production's last 30 days)
         never count as human activity; the overdue figures equal an
         independent recount off __mockDb; and the strip rides the scoreboard's
         Owner gate (an admin gets no strip).
     §B  A2 · RATE-END OUTCOMES — rateEndOutcomeOf() derived four ways, the
         #ret-outcome-funnel tile and the per-row "· outcome: …" clause. A
         seeded QUARTET (retained via the R70 retention_source_case_id link /
         renewed elsewhere / sold / nothing) moves each count by exactly one; a
         case whose outcome was recorded and which has therefore LEFT the feed
         is still counted; "retained" beats a note; Today's Rate & ERC drawer
         renders no clause at all (drawer parity).
     §C  A3 · GO-LIVE ROLLUP — #settings-golive: the blocked rows on the mock's
         seeded settings, green rows collapsed into one "already ready" fold,
         a row click that scrolls to the control that fixes it, the count
         falling as switches are flipped through __mockDb, Owner + Admin only.
     §D  A4 · ROLE-AWARE TOUR + WHAT'S NEW — TOUR_STEPS is now the list for
         MY_ROLE: owner / admin / adviser differ, every role's last step is
         Retention, a step whose target is missing is skipped, and finishing
         still calls mark_tour_seen(). The #whatsnew-band shows only for a
         returning user (tour_seen_at set) and its dismissal persists.
     §E  No console/page errors, every persona touched.

   Every figure asserted here is either seeded by this file, recomputed
   independently off window.__mockDb, or read live off app.js's own module
   state — never read back off the DOM it is testing as its own ground truth.

   NOTE ON PERSONAS: p1 Kim Martin is the ADMIN, p2 Wayne Kellow and p3 Luke
   Richards are ADVISERS, p4 Daniel Potts is the OWNER (mock-supabase.js
   PERSONAS). p3 is the ONE persona whose tour_seen_at is null in the fixture,
   which is why the tour fires for him and the what's-new band does not.

   Run:  node /root/nx/tests/r72_owner.js
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

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  return srv;
}

/* nx_whatsnew_r72 is R72's addition to the clear-list, for exactly the reason nx_ret_sortdir was
   R70's and nx_ret_month was R64's: a suite that asserts a DEFAULT must never inherit a choice an
   earlier scenario made. It is a per-browser dismissal (lsSet in dismissWhatsNew), not a server
   write, so clearing it here is the only way §D's "it shows once" assertion can mean anything. */
const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_sortdir", "nx_ret_untouched", "nx_wt_scope",
  "nx_board_adviser", "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc",
  "nx_drawer_retention", "nx_whatsnew_r72"];

async function boot(browser, persona, opts) {
  const o = opts || {};
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.__ctx = ctx;
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  /* The product tour is a modal overlay and most of this file clicks real controls, so it is
     skipped everywhere except §D, which is about the tour itself. */
  if (!o.tour) await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.waitForTimeout(1500);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));

const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 2600 : ms);
};

let uniq = 0;
const tag = () => `R72A${Date.now().toString(36)}${++uniq}`;
const dOff = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/* One client + one case through the mock's own client, so every default the app relies on
   (applyInsertDefaults) is applied exactly as production would apply it. */
async function mkClientCase(page, o) {
  return page.evaluate(async (opt) => {
    const db = window.__mockDb;
    const { data: cl, error: ce } = await db.from("clients").insert({
      first_name: opt.first, last_name: opt.last, email: opt.email, phone: opt.phone || "07700900123",
    }).select("id").single();
    if (ce) throw new Error("client insert: " + ce.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "completed", assigned_to: "p2" }, opt.case || {});
    const { data: cs, error: se } = await db.from("cases").insert(row).select("id").single();
    if (se) throw new Error("case insert: " + se.message);
    if (opt.note) {
      const { error: ne } = await db.from("case_notes").insert({ case_id: cs.id, body: opt.note, created_by: "p4" });
      if (ne) throw new Error("note insert: " + ne.message);
    }
    if (opt.successor) {
      const { error: xe } = await db.from("cases").insert(Object.assign({
        client_id: cl.id, case_kind: "remortgage", assigned_to: "p2", retention_source_case_id: cs.id,
      }, opt.successor));
      if (xe) throw new Error("successor insert: " + xe.message);
    }
    return { clientId: cl.id, caseId: cs.id };
  }, o);
}

const funnelCounts = (page) => page.evaluate(() => {
  const out = {};
  document.querySelectorAll("#ret-outcome-funnel .ret-outcome-chip").forEach((c) => { out[c.dataset.outcome] = Number(c.dataset.n); });
  return out;
});
const rowOutcome = (page, caseId) => page.evaluate((id) => {
  const r = [...document.querySelectorAll("#ret-rates-list .row-item")].find((x) => {
    const t = x.querySelector(".t[onclick]");
    return t && t.getAttribute("onclick").includes(`'${id}'`);
  });
  if (!r) return { found: false };
  const o = r.querySelector(".ret-row-outcome");
  return { found: true, clause: o ? o.textContent.trim() : null, key: o ? o.dataset.outcome : null };
}, caseId);
const pickChip = async (page, k) => {
  await page.click(`#ret-month-chips .ret-month-chip[data-month="${k}"]`);
  await page.waitForTimeout(2600);
};

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* ======================================================================
     §A · A1 — THE ADOPTION STRIP
     ====================================================================== */
  console.log("— §A · adoption strip on the owner scoreboard");
  {
    const page = await boot(browser, "p4");
    await goPage(page, "reports", 4000);

    const shape = await page.evaluate(() => {
      const t = document.getElementById("report-adoption-table");
      if (!t) return null;
      const rows = [...t.querySelectorAll("tr.adopt-row")];
      return {
        inScoreboard: !!document.querySelector("#report-scoreboard-panel #report-adoption"),
        subHasSignIn: /not a sign-in/i.test((document.getElementById("report-adoption-sub") || {}).textContent || ""),
        subHasSystem: /automation is excluded/i.test((document.getElementById("report-adoption-sub") || {}).textContent || ""),
        ids: rows.map((r) => r.dataset.staff).sort(),
        team: (TEAM || []).map((p) => p.id).sort(),   // TEAM is a script-scope `let`, so it is NOT on window — read it bare, the way tests/r12b.js reads TOUR_STEPS
        cols: [...t.querySelectorAll("tr:first-child th")].map((h) => h.textContent.replace(/\s+/g, " ").trim()),
      };
    });
    ok("§A1 · the strip renders inside the owner scoreboard panel", shape && shape.inScoreboard, JSON.stringify(shape));
    eq("§A1b · one row per back-office login (TEAM — the administrator included)", shape.ids, shape.team);
    eq("§A1c · the three columns the panel asked for", shape.cols.slice(2),
      ["Last active", "Cases touched (30d)", "Overdue tasks"]);
    ok("§A1d · the copy says “Last active” is not a sign-in", shape.subHasSignIn, JSON.stringify(shape));
    ok("§A1e · the copy says the automation is excluded", shape.subHasSystem, JSON.stringify(shape));

    /* Overdue tasks: recomputed here off the store, never read back off the table being tested. */
    const wantOverdue = await page.evaluate(async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await window.__mockDb.from("case_tasks").select("assigned_to,due_date,done_at").order("id");
      const m = {};
      (data || []).forEach((t) => {
        if (!t || t.done_at || !t.due_date || String(t.due_date).slice(0, 10) >= today) return;
        if (!t.assigned_to) return;
        m[t.assigned_to] = (m[t.assigned_to] || 0) + 1;
      });
      return (TEAM || []).map((p) => [p.id, m[p.id] || 0]);
    });
    const gotOverdue = await page.evaluate(() => [...document.querySelectorAll("#report-adoption-table tr.adopt-row")]
      .map((r) => [r.dataset.staff, Number(r.querySelector(".adopt-overdue").dataset.n)]));
    eq("§A2 · overdue-task counts equal an independent recount off the store", gotOverdue.slice().sort(), wantOverdue.slice().sort());

    /* SYSTEM ROWS. The automation writes audit rows with actor IS NULL (CH_SYSTEM, "System
       (automation)"). Twenty of them, all dated today, on a real case: nothing on the strip may
       move, because a null actor can never match the `.in(actor, staffIds)` filter. */
    const before = await page.evaluate(() => [...document.querySelectorAll("#report-adoption-table tr.adopt-row")]
      .map((r) => [r.dataset.staff, r.querySelector(".adopt-last").dataset.last, r.querySelector(".adopt-touched").dataset.n].join("|")));
    await page.evaluate(() => {
      const DB = window.__mock.db;
      const caseId = (DB.cases[0] || {}).id;
      for (let i = 0; i < 20; i++) {
        DB.audit_log.push({ id: "auSYS" + i, happened_at: new Date().toISOString(), actor: null,
          actor_label: null, action: "update", table_name: "cases", row_id: caseId, case_id: caseId,
          client_id: null, summary: "System updated cases", changes: null });
      }
    });
    await goPage(page, "dashboard", 1200);
    await goPage(page, "reports", 4000);
    const afterSystem = await page.evaluate(() => [...document.querySelectorAll("#report-adoption-table tr.adopt-row")]
      .map((r) => [r.dataset.staff, r.querySelector(".adopt-last").dataset.last, r.querySelector(".adopt-touched").dataset.n].join("|")));
    eq("§A3 · 20 System (actor IS NULL) audit rows change nothing on the strip", afterSystem, before);

    /* "NEVER". Strip every audit row belonging to one adviser and re-render: the app can only
       report what the log holds, so that person must read "never" — the production answer for
       three of the four logins. */
    await page.evaluate(() => {
      const DB = window.__mock.db;
      DB.audit_log = DB.audit_log.filter((r) => r.actor !== "p3");
    });
    await goPage(page, "dashboard", 1200);
    await goPage(page, "reports", 4000);
    const never = await page.evaluate(() => {
      const r = document.querySelector('#report-adoption-table tr.adopt-row[data-staff="p3"]');
      if (!r) return null;
      const c = r.querySelector(".adopt-last");
      return { text: c.textContent.trim(), last: c.dataset.last, never: c.classList.contains("adopt-never"),
        touched: Number(r.querySelector(".adopt-touched").dataset.n), warnRow: r.classList.contains("row-warn") };
    });
    eq("§A4a · a person with nothing in the log reads “never”", never && never.text, "never");
    eq("§A4b · …with an empty data-last and the never class", [never.last, never.never], ["", true]);
    eq("§A4c · …and no cases touched", never && never.touched, 0);
    ok("§A4d · the row is flagged (row-warn), because nobody using it is the finding", never && never.warnRow, JSON.stringify(never));

    /* A REAL WRITE, through the app's own client, so the audit trigger writes the row exactly as
       production would: the signed-in owner edits a case, and his line moves to today. */
    const touched = await page.evaluate(async () => {
      const db = window.__mockDb;
      const { data } = await db.from("cases").select("id").order("id").limit(1);
      const id = (data && data[0] && data[0].id) || null;
      if (!id) return null;
      await db.from("cases").update({ lender: "R72 Adoption Test Bank" }).eq("id", id);
      return id;
    });
    ok("fixture · a case was available to edit", !!touched);
    await goPage(page, "dashboard", 1200);
    await goPage(page, "reports", 4000);
    const danielCell = await page.evaluate(() => {
      const r = document.querySelector('#report-adoption-table tr.adopt-row[data-staff="p4"]');
      return r ? { text: r.querySelector(".adopt-last").textContent.replace(/\s+/g, " ").trim(), last: r.querySelector(".adopt-last").dataset.last } : null;
    });
    ok("§A5 · the write the owner just made reads “(today)” on his own line", danielCell && /\(today\)/.test(danielCell.text), JSON.stringify(danielCell));
    ok("§A5b · …and carries the real timestamp in data-last", danielCell && danielCell.last && danielCell.last.slice(0, 10) === new Date().toISOString().slice(0, 10), JSON.stringify(danielCell));

    eq("§A6 · no console errors (owner)", realErrs(page), []);
    await page.__ctx.close();
  }
  {
    const page = await boot(browser, "p1");
    await goPage(page, "reports", 4000);
    const adminView = await page.evaluate(() => ({
      panelHidden: !!(document.getElementById("report-scoreboard-panel") || {}).classList.contains("hidden"),
      strip: ((document.getElementById("report-adoption") || {}).innerHTML || "").trim(),
    }));
    ok("§A7 · an administrator gets no scoreboard panel and no adoption strip (it rides the money gate)",
      adminView.panelHidden && adminView.strip === "", JSON.stringify(adminView));
    eq("§A7b · no console errors (admin)", realErrs(page), []);
    await page.__ctx.close();
  }

  /* ======================================================================
     §B · A2 — RATE-END OUTCOMES: THE FUNNEL AND THE ROW CLAUSE
     ====================================================================== */
  console.log("\n— §B · rate-end outcomes: #ret-outcome-funnel + the row clause");
  {
    const page = await boot(browser, "p4");

    /* The classifier itself, before anything is rendered: the exact bodies rateEndOutcome writes
       (grepped out of app.js — both carry a lender or a date after the phrase, which is why this
       is a prefix match and never an equality test). */
    const kinds = await page.evaluate(() => ({
      renewed: window.rateEndOutcomeNoteKind ? null : typeof rateEndOutcomeNoteKind,
      a: rateEndOutcomeNoteKind("📌 Rate-end outcome — renewed elsewhere with Halifax. Now watching the new rate end 1 Jan 2028; retention will resurface it in the reminder window."),
      b: rateEndOutcomeNoteKind("📌 Rate-end outcome — property sold / mortgage redeemed on 3 Mar 2026. Rate tracking closed; this case has left the rates feed."),
      c: rateEndOutcomeNoteKind("Client rang about the rate-end outcome — renewed elsewhere, apparently"),
      d: rateEndOutcomeNoteKind("SB-IMPORT-1 · imported from the pipeline sheet"),
    }));
    eq("§B1 · a 📌 renewed note classifies as renewed_elsewhere", kinds.a, "renewed_elsewhere");
    eq("§B1b · a 📌 sold note classifies as sold", kinds.b, "sold");
    eq("§B1c · prose that merely mentions the words is not an outcome", kinds.c, null);
    eq("§B1d · an import provenance note is not an outcome", kinds.d, null);

    await goPage(page, "retention", 3200);
    await pickChip(page, "ended12");
    const base = await funnelCounts(page);
    ok("§B2 · the funnel tile renders with the four counts", base && ["retained", "renewed_elsewhere", "sold", "none"].every((k) => typeof base[k] === "number"), JSON.stringify(base));

    /* THE QUARTET. Four ended rates, one per outcome, each on its own property and its own
       maturity date so the feed's same-property/same-date dedupe can never fold two into one. */
    const t = tag();
    const mk = (label, days, extra) => mkClientCase(page, {
      first: "R72", last: label + t, email: `r72.${label}.${t}@example.com`.toLowerCase(),
      case: Object.assign({ lender: "Halifax", rate_percent: 2.1, loan_amount: 210000,
        completed_at: dOff(-900), rate_end_date: dOff(days),
        property_address: `${label} ${t} Outcome Road, Testtown TE7 2AA` }, (extra && extra.case) || {}),
      note: extra && extra.note, successor: extra && extra.successor,
    });
    const retained = await mk("Retained", -21, { successor: { stage: "completed", completed_at: dOff(-3) } });
    const renewed = await mk("Renewed", -22, { note: "📌 Rate-end outcome — renewed elsewhere with Nationwide. Now watching the new rate end 1 Jan 2029; retention will resurface it in the reminder window." });
    const sold = await mk("Sold", -23, { note: "📌 Rate-end outcome — property sold / mortgage redeemed on 1 Aug 2026. Rate tracking closed; this case has left the rates feed." });
    const none = await mk("None", -24, {});
    await goPage(page, "retention", 3400);
    const after = await funnelCounts(page);
    eq("§B3a · the retained case moves “retained” by exactly one", after.retained - base.retained, 1);
    eq("§B3b · the renewed case moves “renewed elsewhere” by exactly one", after.renewed_elsewhere - base.renewed_elsewhere, 1);
    eq("§B3c · the sold case moves “sold” by exactly one", after.sold - base.sold, 1);
    eq("§B3d · the case with nothing recorded moves “no outcome” by exactly one", after.none - base.none, 1);

    const rRet = await rowOutcome(page, retained.caseId);
    const rRen = await rowOutcome(page, renewed.caseId);
    const rSold = await rowOutcome(page, sold.caseId);
    const rNone = await rowOutcome(page, none.caseId);
    ok("fixture · all four seeded rows are on screen", [rRet, rRen, rSold, rNone].every((r) => r.found), JSON.stringify([rRet, rRen, rSold, rNone]));
    eq("§B4a · the retained row's clause", rRet.clause, "· outcome: retained");
    eq("§B4b · the renewed row's clause", rRen.clause, "· outcome: renewed elsewhere");
    eq("§B4c · the sold row's clause", rSold.clause, "· outcome: sold");
    eq("§B4d · a row with no outcome carries NO clause (550 “no outcome” lines is not information)", rNone.clause, null);
    eq("§B4e · the clause carries the machine-readable key", [rRet.key, rRen.key, rSold.key], ["retained", "renewed_elsewhere", "sold"]);

    /* PRECEDENCE. A completed retention successor is the stronger record — it is a mortgage this
       firm actually wrote — so a stale "renewed elsewhere" note on the same case must not win. */
    await page.evaluate(async (id) => {
      await window.__mockDb.from("case_notes").insert({ case_id: id, created_by: "p4",
        body: "📌 Rate-end outcome — renewed elsewhere with Barclays. Now watching the new rate end 1 Jan 2030." });
    }, retained.caseId);
    await goPage(page, "retention", 3400);
    const rRet2 = await rowOutcome(page, retained.caseId);
    eq("§B5 · a completed retention case beats a “renewed elsewhere” note on the same case", rRet2.clause, "· outcome: retained");

    /* THE HALF THAT LEFT THE LIST. Recording "sold" nulls rate_end_date, so the case drops out of
       the feed entirely — the whole reason the funnel's population is not just "the rows on
       screen". A completed case with no rate end and a sold note, recorded today, must still be
       counted, and must not appear as a row. */
    const beforeGone = await funnelCounts(page);
    const gone = await mkClientCase(page, {
      first: "R72", last: "Gone" + t, email: `r72.gone.${t}@example.com`,
      case: { lender: "Halifax", stage: "completed", completed_at: dOff(-800), rate_end_date: null,
        property_address: `Gone ${t} Outcome Road, Testtown TE7 2AA` },
      note: "📌 Rate-end outcome — property sold / mortgage redeemed on 1 Aug 2026. Rate tracking closed; this case has left the rates feed.",
    });
    await goPage(page, "retention", 3400);
    const afterGone = await funnelCounts(page);
    eq("§B6a · an outcome recorded on a case that has left the feed is still counted", afterGone.sold - beforeGone.sold, 1);
    eq("§B6b · …and that case is NOT a row on the list (it has no rate end left)", (await rowOutcome(page, gone.caseId)).found, false);

    /* DRAWER PARITY. Today's Rate & ERC drawer passes no row options at all, so not one character
       of this belongs to it — the R64/R70 rule that keeps the two surfaces from drifting. */
    await goPage(page, "dashboard", 3000);
    const drawer = await page.evaluate(() => ({
      clauses: document.querySelectorAll("#rate-erc-list .ret-row-outcome").length,
      anyRow: document.querySelectorAll("#rate-erc-list .row-item").length,
      funnelOnToday: !!document.querySelector("#page-dashboard #ret-outcome-funnel"),
    }));
    eq("§B7 · Today's Rate & ERC drawer renders no outcome clause", drawer.clauses, 0);
    eq("§B7b · …and no funnel tile", drawer.funnelOnToday, false);

    eq("§B8 · no console errors", realErrs(page), []);
    await page.__ctx.close();
  }

  /* ======================================================================
     §C · A3 — THE GO-LIVE ROLLUP ON SETTINGS
     ====================================================================== */
  console.log("\n— §C · #settings-golive");
  {
    const page = await boot(browser, "p4");
    await goPage(page, "settings", 4000);
    const first = await page.evaluate(() => {
      const el = document.getElementById("settings-golive");
      return {
        hidden: el.classList.contains("hidden"),
        aboveForm: !!(el.compareDocumentPosition(document.getElementById("settings-form")) & Node.DOCUMENT_POSITION_FOLLOWING),
        underStrip: !!(el.compareDocumentPosition(document.getElementById("email-sending-status")) & Node.DOCUMENT_POSITION_PRECEDING),
        count: (document.getElementById("golive-count") || {}).textContent,
        blocked: [...el.querySelectorAll('.golive-list > .golive-item')].filter((i) => !i.closest("details")).map((i) => i.id),
        ready: [...el.querySelectorAll('#golive-ready-fold .golive-item')].map((i) => i.id),
        states: Object.fromEntries([...el.querySelectorAll(".golive-item")].map((i) => [i.id, i.dataset.state])),
        everyBlockedSaysWhy: [...el.querySelectorAll('.golive-item[data-state="blocked"]')].every((i) => (i.querySelector(".golive-blocks") || {}).textContent),
      };
    });
    ok("§C1 · the rollup is on the page for the owner", !first.hidden, JSON.stringify(first));
    ok("§C1b · it sits at the top — under the sending strip, above the settings form", first.underStrip && first.aboveForm, JSON.stringify(first));
    eq("§C2 · the mock's seeded settings block exactly the five expected rows",
      first.blocked, ["golive-resend", "golive-hold", "golive-targets", "golive-promos", "golive-docchase"]);
    eq("§C2b · …and the three that already pass are folded away into “already ready”",
      first.ready, ["golive-from", "golive-reviewlink", "golive-phone"]);
    eq("§C2c · the header counts the outstanding ones", first.count, "5 outstanding");
    ok("§C2d · every blocked row says what it blocks, in words", first.everyBlockedSaysWhy, JSON.stringify(first.states));

    /* A row is a jump to the control that fixes it. */
    const jump = await page.evaluate(async () => {
      const before = document.querySelector('[name="doc_chase_enabled"]').getBoundingClientRect().top;
      document.getElementById("golive-docchase").click();
      await new Promise((r) => setTimeout(r, 1300));
      const el = document.querySelector('[name="doc_chase_enabled"]');
      return { before, after: el.getBoundingClientRect().top };
    });
    ok("§C3 · clicking a row scrolls its own setting into view", Math.abs(jump.after) < Math.abs(jump.before) || jump.after < 400, JSON.stringify(jump));

    /* Flip the four settings-backed rows and the server key, and the list must empty itself. */
    await page.evaluate(async () => {
      const db = window.__mockDb;
      await db.from("settings").upsert([
        { key: "doc_chase_enabled", value: "on" },
        { key: "financial_promotions_approved", value: "on" },
        { key: "email_hold", value: "off" },
        { key: "adviser_fee_targets", value: JSON.stringify(Object.fromEntries((window.advisingStaff() || []).map((a) => [a.id, 4000]))) },
      ]);
      window.__mock.setResendKey(true);
      /* The app holds `settings` in memory from sign-in and renderSettings() reads THAT, not the
         table — so a test that writes settings rows has to make the app re-read them, exactly as
         the app's own save path does (writeEmailHold → loadSettings). */
      await loadSettings();
    });
    await goPage(page, "dashboard", 1200);
    await goPage(page, "settings", 4000);
    const clear = await page.evaluate(() => {
      const el = document.getElementById("settings-golive");
      return {
        count: (document.getElementById("golive-count") || {}).textContent,
        blocked: [...el.querySelectorAll(".golive-item")].filter((i) => i.dataset.state !== "ready").map((i) => i.id),
        readyN: [...el.querySelectorAll('#golive-ready-fold .golive-item')].length,
        sub: (document.getElementById("settings-golive-sub") || {}).textContent.trim().slice(0, 40),
      };
    });
    eq("§C4a · flipping every switch leaves nothing outstanding", clear.blocked, []);
    eq("§C4b · the header says so", clear.count, "all clear");
    eq("§C4c · all eight collapse into the ready fold", clear.readyN, 8);
    ok("§C4d · and the subtitle says nothing is outstanding", /Nothing is outstanding/.test(clear.sub), clear.sub);

    /* R72-HF1 — prod writes from_email in the display-name form `NexMoney <onboarding@resend.dev>`,
       whose trailing ">" defeated the end-anchored sandbox regex; the mock's bare address never
       exercised it and the live rollup called the sandbox sender "ready". Pin the real shape. */
    const hf1 = await page.evaluate(async () => {
      await window.__mockDb.from("settings").upsert([{ key: "from_email", value: "NexMoney <onboarding@resend.dev>" }]);
      await loadSettings();
      window.renderSettingsGolive();
      const row = document.getElementById("golive-from");
      return { state: row && row.dataset.state, detail: (row.querySelector(".golive-detail") || {}).textContent || "" };
    });
    eq("§C4e (R72-HF1) · a display-name resend.dev sender still counts as the sandbox", hf1.state, "blocked");
    ok("§C4e2 · and the detail names it", /sandbox/i.test(hf1.detail), hf1.detail);
    await page.evaluate(async () => { // put it back so later sections see the §C4 all-clear state
      await window.__mockDb.from("settings").upsert([{ key: "from_email", value: "hello@nexmoney.co.uk" }]);
      await loadSettings(); window.renderSettingsGolive();
    });

    eq("§C5 · no console errors (owner)", realErrs(page), []);
    await page.__ctx.close();
  }
  {
    const page = await boot(browser, "p1");
    await goPage(page, "settings", 4000);
    const admin = await page.evaluate(() => {
      const el = document.getElementById("settings-golive");
      return { hidden: el.classList.contains("hidden"), items: el.querySelectorAll(".golive-item").length,
        saysAdmin: /signed in as an Administrator/.test((document.getElementById("settings-golive-sub") || {}).textContent || "") };
    });
    ok("§C6 · an administrator sees the same list…", !admin.hidden && admin.items === 8, JSON.stringify(admin));
    ok("§C6b · …and is told most of it is the Owner's to change", admin.saysAdmin, JSON.stringify(admin));
    eq("§C6c · no console errors (admin)", realErrs(page), []);
    await page.__ctx.close();
  }
  {
    const page = await boot(browser, "p2");
    await goPage(page, "settings", 3600);
    const adv = await page.evaluate(() => {
      const el = document.getElementById("settings-golive");
      return { hidden: el.classList.contains("hidden"), html: (el.innerHTML || "").trim().length };
    });
    ok("§C7 · an adviser gets no rollup at all (same audience as the sending strip)", adv.hidden && adv.html === 0, JSON.stringify(adv));
    eq("§C7b · no console errors (adviser)", realErrs(page), []);
    await page.__ctx.close();
  }

  /* ======================================================================
     §D · A4 — ROLE-AWARE TOUR + "SINCE YOU WERE LAST HERE"
     ====================================================================== */
  console.log("\n— §D · role-aware tour and the what's-new band");
  {
    /* The step LISTS, read off the app's own module state for each role. Deliberately read through
       tourStepsFor() rather than by firing four tours: the list is the contract, and the tour's
       own filtering/positioning machinery is what r12b and r41 already walk end to end. */
    const page = await boot(browser, "p4");
    const lists = await page.evaluate(() => {
      const pick = (r) => tourStepsFor(r).map((s) => ({ t: s.title, target: s.target }));
      return { owner: pick("owner"), admin: pick("admin"), adviser: pick("adviser"), legacy: pick("staff").map((s) => s.t), unknown: pick("banana").map((s) => s.t) };
    });
    ok("§D1a · the owner tour is 4–5 steps", lists.owner.length >= 4 && lists.owner.length <= 5, JSON.stringify(lists.owner.length));
    ok("§D1b · the admin tour is 4–5 steps", lists.admin.length >= 4 && lists.admin.length <= 5, JSON.stringify(lists.admin.length));
    ok("§D1c · the adviser tour is 4–5 steps", lists.adviser.length >= 4 && lists.adviser.length <= 5, JSON.stringify(lists.adviser.length));
    ok("§D1d · the three lists are genuinely different",
      JSON.stringify(lists.owner) !== JSON.stringify(lists.admin)
      && JSON.stringify(lists.admin) !== JSON.stringify(lists.adviser)
      && JSON.stringify(lists.owner) !== JSON.stringify(lists.adviser), JSON.stringify(lists));
    eq("§D2 · EVERY role's last step is Retention",
      [lists.owner, lists.admin, lists.adviser].map((l) => l[l.length - 1].target),
      ['#topnav button[data-page="retention"]', '#topnav button[data-page="retention"]', '#topnav button[data-page="retention"]']);
    ok("§D2b · the admin tour names the email queue and Data health",
      lists.admin.some((s) => /data-page="emails"/.test(s.target)) && lists.admin.some((s) => /data-page="data"/.test(s.target)), JSON.stringify(lists.admin));
    ok("§D2c · the owner tour keeps its money framing (Reports + Monday money)",
      lists.owner.some((s) => /data-page="reports"/.test(s.target)) && lists.owner.some((s) => s.target === "#nav-money"), JSON.stringify(lists.owner));
    eq("§D2d · the legacy 'staff' role and anything unrecognised fall back to the adviser tour",
      [lists.legacy, lists.unknown], [lists.adviser.map((s) => s.t), lists.adviser.map((s) => s.t)]);
    await page.__ctx.close();
  }
  {
    /* The OWNER's tour, actually run: TOUR_STEPS becomes his list, every target is live, and a
       step whose target is removed is skipped rather than shown pointing at nothing. */
    const page = await boot(browser, "p4", { tour: true });
    await page.waitForTimeout(800);
    const owner = await page.evaluate(async () => {
      window.runFirstRunTour({ force: true });
      await new Promise((r) => setTimeout(r, 400));
      return { live: !!document.querySelector("#tour-bubble"), n: TOUR_STEPS.length,
        stepN: (document.querySelector(".tour-step-n") || {}).textContent,
        same: JSON.stringify(TOUR_STEPS) === JSON.stringify(tourStepsFor("owner")) };
    });
    ok("§D3a · the owner's tour fires on Retake", owner.live, JSON.stringify(owner));
    ok("§D3b · TOUR_STEPS is the OWNER's list while it is on screen", owner.same, JSON.stringify(owner));
    eq("§D3c · the bubble counts that list", owner.stepN, `1 of ${owner.n}`);

    const skipped = await page.evaluate(async () => {
      document.querySelector("#tour-skip").click();
      await new Promise((r) => setTimeout(r, 200));
      const wt = document.getElementById("watchtower-panel");
      wt.parentElement.removeChild(wt);
      window.runFirstRunTour({ force: true });
      await new Promise((r) => setTimeout(r, 400));
      const shown = [];
      for (let i = 0; i < 8; i++) {
        const h = document.querySelector("#tour-bubble h4");
        if (!h) break;
        shown.push(h.textContent);
        const btn = document.querySelector("#tour-next");
        const last = btn && btn.textContent === "Finish";
        btn.click();
        await new Promise((r) => setTimeout(r, 200));
        if (last) break;
      }
      return { shown, listLen: tourStepsFor("owner").length };
    });
    eq("§D4a · a step whose target has gone is skipped, not shown", skipped.shown.length, skipped.listLen - 1);
    ok("§D4b · …and it is the Watchtower step that is missing", !skipped.shown.includes("Watchtower"), JSON.stringify(skipped.shown));
    eq("§D4c · no console errors (owner tour)", realErrs(page), []);
    await page.__ctx.close();
  }
  {
    /* The tour still marks itself seen exactly as it always has — the one thing this round must
       not have touched (r12b C1 / r41 §F own this contract; it is re-checked here because the
       step list underneath it changed). p3 is the fixture's only tour_seen_at IS NULL persona. */
    const page = await boot(browser, "p3", { tour: true });
    await page.waitForTimeout(1200);
    const walk = await page.evaluate(async () => {
      const before = !!document.querySelector("#tour-bubble");
      const isAdviserList = JSON.stringify(TOUR_STEPS) === JSON.stringify(tourStepsFor("adviser"));
      let guard = 0;
      while (document.querySelector("#tour-next") && guard++ < 10) {
        const last = document.querySelector("#tour-next").textContent === "Finish";
        document.querySelector("#tour-next").click();
        await new Promise((r) => setTimeout(r, 250));
        if (last) break;
      }
      await new Promise((r) => setTimeout(r, 400));
      const { data } = await window.__mockDb.from("profiles").select("tour_seen_at").eq("id", "p3").single();
      return { before, isAdviserList, gone: !document.querySelector("#tour-bubble"), seen: data && data.tour_seen_at };
    });
    ok("§D5a · the tour still fires on a first sign-in (p3)", walk.before, JSON.stringify(walk));
    ok("§D5b · and it is the ADVISER list he is shown", walk.isAdviserList, JSON.stringify(walk));
    ok("§D5c · Finish still closes it", walk.gone, JSON.stringify(walk));
    ok("§D5d · Finish still calls mark_tour_seen() — tour_seen_at is set", walk.seen != null, JSON.stringify(walk));
    eq("§D5e · no console errors (adviser tour)", realErrs(page), []);
    await page.__ctx.close();
  }
  {
    /* THE BAND. Returning user only, dismissible, and the dismissal is a browser preference that
       survives a reload (same context, so the same localStorage). */
    const page = await boot(browser, "p4");
    const shown = await page.evaluate(() => {
      const el = document.getElementById("whatsnew-band");
      return { hidden: el.classList.contains("hidden"), text: (el.textContent || "").replace(/\s+/g, " ").trim(),
        aboveHeading: !!(el.compareDocumentPosition(document.getElementById("today-heading")) & Node.DOCUMENT_POSITION_FOLLOWING),
        btn: !!document.getElementById("whatsnew-dismiss") };
    });
    ok("§D6a · a returning user (tour_seen_at set) gets the band", !shown.hidden && shown.btn, JSON.stringify(shown));
    ok("§D6b · it is one line naming what is new", /New since you were last here/.test(shown.text), shown.text);
    ok("§D6c · it sits above the Today heading (R11-1's heading→KPI→briefing run is untouched)", shown.aboveHeading, JSON.stringify(shown));

    await page.click("#whatsnew-dismiss");
    await page.waitForTimeout(300);
    const afterClick = await page.evaluate(() => ({
      hidden: document.getElementById("whatsnew-band").classList.contains("hidden"),
      key: localStorage.getItem("nx_whatsnew_r72"),
    }));
    eq("§D7a · dismissing hides it", afterClick.hidden, true);
    eq("§D7b · …and records the choice under the release's own key", afterClick.key, "seen");

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    const afterReload = await page.evaluate(() => ({
      hidden: document.getElementById("whatsnew-band").classList.contains("hidden"),
      html: (document.getElementById("whatsnew-band").innerHTML || "").trim().length,
    }));
    ok("§D7c · it stays dismissed on the next visit", afterReload.hidden && afterReload.html === 0, JSON.stringify(afterReload));
    eq("§D7d · no console errors", realErrs(page), []);
    await page.__ctx.close();
  }
  {
    const page = await boot(browser, "p3");
    await page.waitForTimeout(1200);
    const firstRun = await page.evaluate(() => {
      const el = document.getElementById("whatsnew-band");
      return { hidden: el.classList.contains("hidden"), html: (el.innerHTML || "").trim().length };
    });
    ok("§D8 · a first-time user (tour_seen_at null) gets NO band — the tour is their welcome",
      firstRun.hidden && firstRun.html === 0, JSON.stringify(firstRun));
    eq("§D8b · no console errors", realErrs(page), []);
    await page.__ctx.close();
  }

  await browser.close();
  if (srv) try { srv.kill(); } catch (e) { /* already gone */ }
  console.log(`\nR72 owner: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
