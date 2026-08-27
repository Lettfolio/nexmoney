#!/usr/bin/env node
/* =============================================================================
   tests/r65_watchtower.js — acceptance tests for ROUND 65's Watchtower pass:
   TWO NEW CHECKS and ONE CHECK THAT NOW COUNTS PEOPLE INSTEAD OF MESSAGES.

   WHAT THIS ROUND IS ABOUT. Three changes land in production's `run_watchtower`
   and are mirrored, rule for rule, in admin/mock-supabase.js:

     1. `offer_before_completion` — a case at Offer or Exchange that has BOTH an
        offer expiry date and an expected completion date recorded, where the
        OFFER DIES FIRST. Nothing on the case screen ever compared those two
        fields, so the mismatch only surfaced in the week the offer expired.
        CRITICAL once the offer itself is inside 30 days, WARNING before that.
        dedupe `offer_before_completion:<case_id>`.
     2. `erc_before_completion` — a LIVE retention case (one carrying a
        `retention_source_case_id`) whose expected completion falls INSIDE the
        SOURCE case's ERC window: the client pays an Early Repayment Charge for
        leaving a deal they were weeks away from leaving for free. The two dates
        live on two different case rows, which is why nobody ever put them side
        by side. Always WARNING. dedupe `erc_before_completion:<case_id>`.
     3. `email_unanswered` becomes PER CLIENT. It used to fire once per waiting
        message, so one client with three emails across two cases produced three
        near-identical WARNING rows and three Dismiss buttons for what is one
        conversation. Now: one row per client, dedupe `email_unanswered:c:<client_id>`,
        carrying the count, the latest subject and the LATEST message's case_id.
        A message with no client_id has nothing to aggregate on and keeps the old
        per-email key, `email_unanswered:<email_id>`.

     §A  The two new rules against the SHIPPED FIXTURES: exactly one of each,
         with the expected severity, dedupe key, title and detail — then the
         severity boundary on cases built for it, and the auto-resolve sweep
         (fix the dates, run again, the alert closes).
     §B  email_unanswered: three messages for one client across two cases plus
         one for another client ⇒ exactly TWO alerts, keyed per client, the
         3-message one naming its latest subject and pointing at its latest
         case. A message with a null client_id keeps the old per-email key.
     §C  The app: rows render under written group labels ("Offer expires before
         completion", "Completing inside old ERC", "Client emails unanswered"),
         the row's Open opens the right case, the Watchtower's panel-sub names
         both new checks and says the email one is counted per client, and no
         console errors on p2 or p4.

   EVERY string this file asserts is recomputed HERE — the London date format,
   the day arithmetic, the titles, the dedupe keys — independently of both
   app.js and mock-supabase.js, per the standing rule in HARNESS.md. §A's first
   half is the only part that reads the shipped fixture book; everything else
   builds its own clients, cases and emails, and mock-supabase.js rebuilds its
   DB per page load, so an id minted on one page means nothing on another.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/root/pwb node /root/nx/tests/r65_watchtower.js
         (expects a static server on 8099; starts one itself if absent)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const SETTLE = 1600;
const DAY_MS = 86400000;

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

const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser", "nx_diary_staff", "nx_views_v1", "nx_nav_firm",
  "nx_import_blurb", "nx_ret_scope", "nx_ret_month", "nx_drawer_watchtower", "nx_drawer_unactioned", "nx_drawer_leads",
  "nx_drawer_todayappts", "nx_drawer_tasks", "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

async function newPage(browser, persona) {
  const page = await browser.newPage();
  await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  page.__dialogs = [];
  page.on("dialog", async (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); await d.accept(); });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  await clearNxKeys(page);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);

const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1200 : ms);
};

/* ---------------------------------------------------------------------------
   INDEPENDENT re-implementations of everything §A/§B assert.
   Production composes these strings with to_char(… AT TIME ZONE 'Europe/London',
   'DD Mon YYYY' | 'DD Mon HH24:MI'): zero-padded day, fixed three-letter English
   month, 24-hour clock. Intl's month:"short" is NOT that under en-GB (it renders
   September as "Sept"), so the month name comes from a table here exactly as it
   does in the mirror — written out separately on purpose, so a change to one is
   not silently a change to both.
   ------------------------------------------------------------------------- */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function ldnFields(t) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(t).split("-");
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
  return { y: ymd[0], m: Number(ymd[1]), d: ymd[2], hm };
}
/* A date-only column is read at midday UTC so the London calendar day cannot slide
   across midnight under BST — the same pin the mock and app.js both use. */
const atNoon = (d) => new Date(String(d) + "T12:00:00Z");
function fmtDate(d) { const f = ldnFields(atNoon(d)); return `${f.d} ${MON[f.m - 1]} ${f.y}`; }
function fmtStamp(ts) { const f = ldnFields(new Date(ts)); return `${f.d} ${MON[f.m - 1]} ${f.hm}`; }
const dayGap = (from, to) => Math.round((atNoon(to).getTime() - atNoon(from).getTime()) / DAY_MS);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/* Local YYYY-MM-DD — never toISOString(), which is a day out west of Greenwich in summer. */
function dstr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const inDays = (n) => dstr(Date.now() + n * DAY_MS);

const expectOfferDetail = (expiry, completion) =>
  `Offer expires ${fmtDate(expiry)} · completion expected ${fmtDate(completion)} — ${plural(dayGap(expiry, completion), "day", "days")} short`;
const expectErcDetail = (ercEnd, completion) =>
  `Old rate's ERC runs until ${fmtDate(ercEnd)} · completion expected ${fmtDate(completion)} — ${plural(dayGap(completion, ercEnd), "day", "days")} early`;

/* ---------------------------------------------------------------------------
   Page-side helpers.
   ------------------------------------------------------------------------- */
/* The RPC, called the way the "Run checks" button calls it. §C exercises the
   button itself; everywhere else the RPC is the subject and the DOM is not. */
const runChecks = async (page) => {
  const r = await page.evaluate(async () => (await window.__mockDb.rpc("run_watchtower")).data);
  await wait(page, 300);
  return r;
};
const openAlerts = (page, rule) => page.evaluate(async (r) => {
  const { data } = await window.__mockDb.from("watch_alerts").select("*").is("resolved_at", null);
  return (data || []).filter((a) => !r || a.rule === r);
}, rule || null);
const alertByKey = (page, key) => page.evaluate(async (k) => {
  const { data } = await window.__mockDb.from("watch_alerts").select("*").eq("dedupe_key", k);
  return (data || [])[0] || null;
}, key);
const caseRow = (page, id) => page.evaluate(async (i) => {
  const { data } = await window.__mockDb.from("cases").select("*").eq("id", i).single();
  return data || null;
}, id);
const clientFullName = (page, id) => page.evaluate(async (i) => {
  const { data } = await window.__mockDb.from("clients").select("first_name,last_name").eq("id", i).single();
  return data ? [data.first_name, data.last_name].filter(Boolean).join(" ") : null;
}, id);
const patchCase = (page, id, patch) => page.evaluate(
  ({ id, patch }) => window.__mockDb.from("cases").update(patch).eq("id", id), { id, patch });

/* A client + one case in a single round trip. Inserted directly, never through
   moveCaseToStage — this suite measures the checker, not the stage gates. */
async function mkClientCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const email = o.email || `r65.${Math.random().toString(36).slice(2, 9)}@example.com`;
    const { data: cl, error: clErr } = await db.from("clients")
      .insert({ first_name: o.first || "R65", last_name: o.last || "Case", email, phone: o.phone || null })
      .select("id").single();
    if (clErr) throw new Error("client insert: " + clErr.message);
    const row = Object.assign({
      client_id: cl.id, case_kind: "purchase", stage: "offer", assigned_to: "p2",
      lender: "Halifax", protection_status: "not_needed",
    }, o.case || {});
    row.client_id = cl.id;
    const { data: cs, error: csErr } = await db.from("cases").insert(row).select("id").single();
    if (csErr) throw new Error("case insert: " + csErr.message);
    return { clientId: cl.id, caseId: cs.id, name: `${o.first || "R65"} ${o.last || "Case"}` };
  }, opts || {});
}

const addEmail = (page, row) => page.evaluate((r) => window.__mockDb.from("case_emails").insert(r).select("id").single()
  .then((x) => (x.data ? x.data.id : null)), row);

/* The rendered Watchtower, group by group. Labels and counts come off the DOM;
   the row's Open handler is read verbatim so §C can prove where it points. */
const wtGroups = (page) => page.$$eval("#watchtower-list .wt-group", (els) => els.map((g) => ({
  key: g.dataset.wtKey,
  rule: String(g.dataset.wtKey || "").split("|")[0],
  label: (g.querySelector(".wt-group-label") || {}).textContent || "",
  n: Number((g.querySelector(".wt-group-n") || {}).textContent || "-1"),
  headTitle: (g.querySelector(".wt-group-head") || {}).title || "",
  rows: [...g.querySelectorAll(".wt-row")].map((r) => ({
    title: (r.querySelector(".t") || {}).textContent || "",
    detail: (r.querySelector(".s") || {}).textContent || "",
    openAttr: [...r.querySelectorAll("button")].map((b) => b.getAttribute("onclick") || "").filter((s) => /openCase\(/.test(s))[0] || "",
    buttons: [...r.querySelectorAll("button")].map((b) => b.textContent.trim()),
  })),
})));

const openWatchtower = async (page) => {
  await goto(page, "dashboard", 1600);
  await page.evaluate(() => {
    const p = document.getElementById("watchtower-panel");
    if (p && p.classList.contains("collapsed")) document.querySelector("#watchtower-panel h3").click();
  });
  await wait(page, 600);
};

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  const page = await newPage(browser, "p1");

  try {

    /* =======================================================================
       §A · THE TWO NEW DATE RULES.
       ======================================================================= */
    {
      console.log("\n— §A1 · the shipped fixture book trips each new rule exactly once (p1)");
      await runChecks(page);

      const obc = await openAlerts(page, "offer_before_completion");
      eq("A1a · exactly ONE open offer_before_completion alert across the whole fixture book", obc.length, 1);
      const ebc = await openAlerts(page, "erc_before_completion");
      eq("A1b · exactly ONE open erc_before_completion alert across the whole fixture book", ebc.length, 1);

      if (obc.length === 1) {
        const a = obc[0];
        const c = await caseRow(page, a.case_id);
        const who = await clientFullName(page, c.client_id);
        eq("A1c · …keyed per case: offer_before_completion:<case_id>", a.dedupe_key, `offer_before_completion:${c.id}`);
        ok("A1d · fixture sanity — the case is at Offer or Exchange with BOTH dates, expiry first",
          ["offer", "exchange"].includes(c.stage) && !!c.offer_expiry_date && !!c.expected_completion_date &&
          c.offer_expiry_date < c.expected_completion_date, JSON.stringify({ stage: c.stage, e: c.offer_expiry_date, x: c.expected_completion_date }));
        const daysToExpiry = dayGap(dstr(Date.now()), c.offer_expiry_date);
        eq("A1e · severity is crit inside 30 days to expiry, warn beyond it", a.severity, daysToExpiry <= 30 ? "crit" : "warn");
        eq("A1f · title names the client after the problem", a.title, `Offer expires before completion: ${who}`);
        eq("A1g · detail: both dates in British form and the shortfall in days",
          a.detail, expectOfferDetail(c.offer_expiry_date, c.expected_completion_date));
        ok("A1h · the detail carries NO raw ISO date (production's to_char has already formatted it)",
          !/\d{4}-\d{2}-\d{2}/.test(a.detail), a.detail);
        ok("A1i · the alert carries the case it is about, so the row can open it", a.case_id === c.id && !!a.client_id, JSON.stringify(a));
      }

      if (ebc.length === 1) {
        const a = ebc[0];
        const c = await caseRow(page, a.case_id);
        const src = await caseRow(page, c.retention_source_case_id);
        const who = await clientFullName(page, c.client_id);
        eq("A1j · …keyed per case: erc_before_completion:<case_id>", a.dedupe_key, `erc_before_completion:${c.id}`);
        ok("A1k · fixture sanity — a LIVE successor, its SOURCE has an ERC date, completion lands inside it",
          !["completed", "not_proceeding"].includes(c.stage) && !!src && !!src.erc_end_date &&
          !!c.expected_completion_date && c.expected_completion_date < src.erc_end_date,
          JSON.stringify({ stage: c.stage, x: c.expected_completion_date, erc: src && src.erc_end_date }));
        eq("A1l · severity is always warn — a conversation, not an emergency", a.severity, "warn");
        eq("A1m · title names the client after the problem", a.title, `Completing inside the old rate's ERC: ${who}`);
        eq("A1n · detail: the old rate's ERC end, the completion date, and how early it is",
          a.detail, expectErcDetail(src.erc_end_date, c.expected_completion_date));
        ok("A1o · the detail carries NO raw ISO date", !/\d{4}-\d{2}-\d{2}/.test(a.detail), a.detail);
      }

      console.log("\n— §A2 · the severity boundary, on cases built for it");
      /* Beyond 30 days to expiry the offer is a diary note; inside it, it is a fire. Both cases
         are built with the expiry AFTER the 30-day line or before it and the completion after
         the expiry either way, so the only thing that differs between them is the severity. */
      const warnCase = await mkClientCase(page, { first: "Warn", last: "Boundary", case: { stage: "offer", offer_expiry_date: inDays(45), expected_completion_date: inDays(70) } });
      const critCase = await mkClientCase(page, { first: "Crit", last: "Boundary", case: { stage: "exchange", offer_expiry_date: inDays(12), expected_completion_date: inDays(40) } });
      const cleanCase = await mkClientCase(page, { first: "Clean", last: "Boundary", case: { stage: "offer", offer_expiry_date: inDays(80), expected_completion_date: inDays(40) } });
      const noDateCase = await mkClientCase(page, { first: "Nodate", last: "Boundary", case: { stage: "offer", offer_expiry_date: inDays(20), expected_completion_date: null } });
      const deadCase = await mkClientCase(page, { first: "Dead", last: "Boundary", case: { stage: "not_proceeding", offer_expiry_date: inDays(10), expected_completion_date: inDays(60) } });
      await runChecks(page);

      const wa = await alertByKey(page, `offer_before_completion:${warnCase.caseId}`);
      eq("A2a · expiry 45 days out, completion after it ⇒ WARNING", wa && wa.severity, "warn");
      eq("A2b · …with the 25-day shortfall spelled out", wa && wa.detail, expectOfferDetail(inDays(45), inDays(70)));
      const ca = await alertByKey(page, `offer_before_completion:${critCase.caseId}`);
      eq("A2c · expiry 12 days out ⇒ CRITICAL", ca && ca.severity, "crit");
      ok("A2d · …and EXCHANGE counts too, not just Offer — an exchanged case completes against the same offer",
        !!ca && !ca.resolved_at, JSON.stringify(ca));
      eq("A2e · expiry AFTER the expected completion ⇒ no alert (the right way round)",
        await alertByKey(page, `offer_before_completion:${cleanCase.caseId}`), null);
      eq("A2f · no expected completion date recorded ⇒ nothing to compare, no alert",
        await alertByKey(page, `offer_before_completion:${noDateCase.caseId}`), null);
      eq("A2g · a not_proceeding case is out of scope for the offer rule too (stage gate)",
        await alertByKey(page, `offer_before_completion:${deadCase.caseId}`), null);

      console.log("\n— §A3 · the ERC rule's own gates");
      const src = await mkClientCase(page, { first: "Ercsrc", last: "Boundary", case: { stage: "completed", rate_end_date: inDays(120), erc_end_date: inDays(120), completed_at: new Date(Date.now() - 400 * DAY_MS).toISOString() } });
      const succ = await mkClientCase(page, { first: "Ercsucc", last: "Boundary", case: { stage: "application", retention_source_case_id: src.caseId, expected_completion_date: inDays(90) } });
      const succOk = await mkClientCase(page, { first: "Ercsafe", last: "Boundary", case: { stage: "application", retention_source_case_id: src.caseId, expected_completion_date: inDays(150) } });
      const noSrcErc = await mkClientCase(page, { first: "Ercnone", last: "Boundary", case: { stage: "application", retention_source_case_id: cleanCase.caseId, expected_completion_date: inDays(20) } });
      await runChecks(page);
      const ea = await alertByKey(page, `erc_before_completion:${succ.caseId}`);
      eq("A3a · completion 30 days inside the source's ERC ⇒ one warn alert", ea && ea.severity, "warn");
      eq("A3b · …detail counts the days early from the SOURCE case's ERC end", ea && ea.detail, expectErcDetail(inDays(120), inDays(90)));
      eq("A3c · …title names the successor's client", ea && ea.title, `Completing inside the old rate's ERC: ${succ.name}`);
      eq("A3d · completion AFTER the ERC ends ⇒ no alert", await alertByKey(page, `erc_before_completion:${succOk.caseId}`), null);
      eq("A3e · a source with no erc_end_date ⇒ nothing to be inside, no alert",
        await alertByKey(page, `erc_before_completion:${noSrcErc.caseId}`), null);

      console.log("\n— §A4 · fixing the dates resolves the alert on the next run (the auto-resolve sweep)");
      /* The point of the whole panel: "resolves itself when fixed". Move the offer expiry past
         the completion it is meant to fund, run the checks again, and the row closes itself —
         no dismissal, no human action on the alert at all. */
      await patchCase(page, critCase.caseId, { offer_expiry_date: inDays(90) });
      await patchCase(page, succ.caseId, { expected_completion_date: inDays(160) });
      const tally = await runChecks(page);
      const critAfter = await alertByKey(page, `offer_before_completion:${critCase.caseId}`);
      ok("A4a · the offer alert is resolved once the expiry moves past the completion",
        !!critAfter && !!critAfter.resolved_at, JSON.stringify(critAfter));
      const ercAfter = await alertByKey(page, `erc_before_completion:${succ.caseId}`);
      ok("A4b · the ERC alert is resolved once the completion moves past the ERC end",
        !!ercAfter && !!ercAfter.resolved_at, JSON.stringify(ercAfter));
      ok("A4c · …and the run reports them among its auto-resolved count", (tally && Number(tally.resolved)) >= 2, JSON.stringify(tally));
      const stillOpen = await openAlerts(page, "offer_before_completion");
      ok("A4d · the OTHER offer alerts are untouched by that fix — resolving is per dedupe key",
        stillOpen.every((a) => a.case_id !== critCase.caseId) && stillOpen.length >= 2, JSON.stringify(stillOpen.map((a) => a.dedupe_key)));

      console.log("\n— §A5 · a re-run is idempotent: same keys, nothing new, nothing re-opened");
      const before = (await openAlerts(page)).map((a) => a.dedupe_key).sort();
      const again = await runChecks(page);
      const after = (await openAlerts(page)).map((a) => a.dedupe_key).sort();
      eq("A5a · the open set is identical after a second run", after, before);
      eq("A5b · …and the run reports nothing new", Number(again && again.new), 0);
      ok("§A · no console errors", !(page.__err || []).length, JSON.stringify(page.__err));
    }

    /* =======================================================================
       §B · email_unanswered, ONE ROW PER CLIENT.
       ======================================================================= */
    {
      console.log("\n— §B · three messages from one client across two cases + one from another (p1)");
      const b = await newPage(browser, "p1");

      /* The shipped fixtures seed their own inbound emails; this section is about the shape of
         the aggregation, so it works on a cleared table and counts the whole rule, not a subset. */
      await b.evaluate(async () => { await window.__mockDb.from("case_emails").delete().neq("id", "__none__"); });
      const rows = await b.evaluate(async () => (await window.__mockDb.from("case_emails").select("id")).data || []);
      eq("B0 · the inbound table starts empty for this section", rows.length, 0);

      const talker = await mkClientCase(b, { first: "Nadia", last: "Talkative", email: "nadia.talkative@example.com", case: { stage: "application" } });
      const talker2 = await b.evaluate(async (clientId) => {
        const { data } = await window.__mockDb.from("cases")
          .insert({ client_id: clientId, case_kind: "remortgage", stage: "offer", assigned_to: "p2", lender: "Skipton" })
          .select("id").single();
        return data.id;
      }, talker.clientId);
      const quiet = await mkClientCase(b, { first: "Owen", last: "Oneemail", email: "owen.oneemail@example.com", case: { stage: "fact_find" } });

      const OLD = (h) => new Date(Date.now() - h * 3600000).toISOString();
      /* All comfortably past the rule's 24-hour floor; the LATEST is the one whose subject and
         case the alert must carry, and it is deliberately NOT the last one inserted. */
      const t1 = OLD(96), t2 = OLD(40), tLatest = OLD(30), tQuiet = OLD(50);
      await addEmail(b, { case_id: talker.caseId, client_id: talker.clientId, from_email: "nadia.talkative@example.com", from_name: "Nadia Talkative", subject: "Payslips attached", received_at: t1, triage_status: "new" });
      await addEmail(b, { case_id: talker2, client_id: talker.clientId, from_email: "nadia.talkative@example.com", from_name: "Nadia Talkative", subject: "And the second property", received_at: tLatest, triage_status: "new" });
      await addEmail(b, { case_id: talker.caseId, client_id: talker.clientId, from_email: "nadia.talkative@example.com", from_name: "Nadia Talkative", subject: "Sorry, one more thing", received_at: t2, triage_status: "new" });
      await addEmail(b, { case_id: quiet.caseId, client_id: quiet.clientId, from_email: "owen.oneemail@example.com", from_name: "Owen Oneemail", subject: "Is the offer through?", received_at: tQuiet, triage_status: "new" });
      /* One that must NOT be counted: answered already. */
      await addEmail(b, { case_id: quiet.caseId, client_id: quiet.clientId, from_email: "owen.oneemail@example.com", subject: "Thanks", received_at: OLD(60), triage_status: "handled" });
      /* …and one that is still inside the 24-hour grace window. */
      await addEmail(b, { case_id: quiet.caseId, client_id: quiet.clientId, from_email: "owen.oneemail@example.com", subject: "Just now", received_at: OLD(3), triage_status: "new" });

      await runChecks(b);
      const alerts = await openAlerts(b, "email_unanswered");
      eq("B1 · four waiting messages from two clients ⇒ exactly TWO alerts", alerts.length, 2);
      eq("B2 · …keyed per client, never per message",
        alerts.map((a) => a.dedupe_key).sort(), [`email_unanswered:c:${quiet.clientId}`, `email_unanswered:c:${talker.clientId}`].sort());
      ok("B3 · no per-email key survives for a message that HAS a client",
        alerts.every((a) => /^email_unanswered:c:/.test(a.dedupe_key)), JSON.stringify(alerts.map((a) => a.dedupe_key)));

      const nadia = alerts.filter((a) => a.dedupe_key === `email_unanswered:c:${talker.clientId}`)[0];
      eq("B4 · the three-message client's detail counts messages, not cases",
        nadia && nadia.detail, `3 messages waiting · latest "And the second property" received ${fmtStamp(tLatest)}`);
      eq("B5 · …title is the sender, after the problem", nadia && nadia.title, "Client email unanswered: Nadia Talkative");
      eq("B6 · …severity is warn", nadia && nadia.severity, "warn");
      eq("B7 · …client_id is the client the row aggregates", nadia && nadia.client_id, talker.clientId);
      eq("B8 · …case_id is the LATEST message's case, not the first — that is the live conversation",
        nadia && nadia.case_id, talker2);

      const owen = alerts.filter((a) => a.dedupe_key === `email_unanswered:c:${quiet.clientId}`)[0];
      eq("B9 · a single waiting message reads in the singular", owen && owen.detail,
        `1 message waiting · latest "Is the offer through?" received ${fmtStamp(tQuiet)}`);
      ok("B10 · …and neither the handled message nor the one inside the 24-hour window is counted",
        owen && /^1 message/.test(owen.detail), owen && owen.detail);

      console.log("\n— §B2 · a message with no client_id keeps the OLD per-email key");
      const orphanId = await addEmail(b, { case_id: null, client_id: null, from_email: "someone@nowhere.example.com", subject: "Who is this?", received_at: OLD(72), triage_status: "new" });
      await runChecks(b);
      const alerts2 = await openAlerts(b, "email_unanswered");
      eq("B11 · the unmatched message adds a THIRD alert of its own", alerts2.length, 3);
      const orphan = await alertByKey(b, `email_unanswered:${orphanId}`);
      ok("B12 · …keyed email_unanswered:<email_id>, exactly as before R65", !!orphan && !orphan.resolved_at, JSON.stringify(orphan));
      eq("B13 · …carrying no client, because it has none to aggregate on", orphan && orphan.client_id, null);
      eq("B14 · …and its detail is the same shape with a count of one", orphan && orphan.detail,
        `1 message waiting · latest "Who is this?" received ${fmtStamp(OLD(72))}`);

      console.log("\n— §B3 · answering a client's messages resolves their ONE row");
      await b.evaluate(async (cid) => { await window.__mockDb.from("case_emails").update({ triage_status: "handled" }).eq("client_id", cid); }, talker.clientId);
      await runChecks(b);
      const nadiaAfter = await alertByKey(b, `email_unanswered:c:${talker.clientId}`);
      ok("B15 · the client's single row closes when the last of their messages is handled",
        !!nadiaAfter && !!nadiaAfter.resolved_at, JSON.stringify(nadiaAfter));
      const left = await openAlerts(b, "email_unanswered");
      eq("B16 · …and only that one closes", left.length, 2);
      ok("§B · no console errors", !(b.__err || []).length, JSON.stringify(b.__err));
      await b.close();
    }

    /* =======================================================================
       §C · THE APP: labels, links, copy.
       ======================================================================= */
    {
      console.log("\n— §C1 · the panel groups the new rules under written labels (p1, All scope)");
      const c = await newPage(browser, "p1");
      await openWatchtower(c);
      /* The button, not the RPC — this is the operator's own path and it repaints the list. */
      await c.click("#watchtower-run");
      await wait(c, 1500);

      const groups = await wtGroups(c);
      const byRule = {};
      groups.forEach((g) => { byRule[g.rule] = g; });
      ok("C1a · the offer-date rule has its own group", !!byRule.offer_before_completion, JSON.stringify(groups.map((g) => g.rule)));
      ok("C1b · the ERC rule has its own group", !!byRule.erc_before_completion, JSON.stringify(groups.map((g) => g.rule)));
      ok("C1c · the email rule has its own group", !!byRule.email_unanswered, JSON.stringify(groups.map((g) => g.rule)));
      eq("C1d · label: the offer rule reads in English, not as a token",
        byRule.offer_before_completion && byRule.offer_before_completion.label, "Offer expires before completion");
      eq("C1e · label: the ERC rule keeps ERC in capitals (the token fallback wrote “Erc”)",
        byRule.erc_before_completion && byRule.erc_before_completion.label, "Completing inside old ERC");
      eq("C1f · label: the email rule reads as clients, plural, not as messages",
        byRule.email_unanswered && byRule.email_unanswered.label, "Client emails unanswered");
      ok("C1g · …and the ERC label carries the glossary expansion in its header tooltip",
        /Early Repayment Charge/.test((byRule.erc_before_completion || {}).headTitle || ""),
        (byRule.erc_before_completion || {}).headTitle);
      ok("C1h · the email group's header counts CLIENTS waiting on a reply, not alerts",
        /client(s)? waiting on a reply/.test((byRule.email_unanswered || {}).headTitle || "") &&
        !/alert/.test((byRule.email_unanswered || {}).headTitle || ""),
        (byRule.email_unanswered || {}).headTitle);
      ok("C1i · every other group still says “alerts of this type”",
        /alerts? of this type/.test((byRule.fee_aging || byRule.lead_slow || byRule.protection_quote_stale || {}).headTitle || ""),
        JSON.stringify(groups.map((g) => [g.rule, g.headTitle])));

      console.log("\n— §C2 · the row opens the case it is about");
      const gt = await openAlerts(c, "offer_before_completion");
      const target = gt[0];
      const row = (byRule.offer_before_completion || { rows: [] }).rows[0] || null;
      ok("C2a · the group's row renders", !!row, JSON.stringify(byRule.offer_before_completion));
      if (row && target) {
        ok("C2b · its Open button points at the alert's own case", row.openAttr.includes(`openCase('${target.case_id}')`), row.openAttr);
        ok("C2c · …and it is the plain Open, not a second door to somewhere else (no rule link button)",
          !row.buttons.some((t) => /→/.test(t)), JSON.stringify(row.buttons));
        eq("C2d · the row's title is the alert's title, unmangled", row.title.trim(), target.title);
        eq("C2e · the row's detail is the alert's detail, unmangled (no ISO rewrite to do)", row.detail.trim(), target.detail);
        /* Clicked for real, off the rendered row, rather than calling openCase() by hand — the
           point of the assertion is that THIS BUTTON leads to THAT case. */
        await c.click(`#watchtower-list .wt-row button[onclick*="openCase('${target.case_id}')"]`);
        await wait(c, 1400);
        /* The CASE modal is `#modal` behind `#modal-backdrop` — `#overlay-modal` is the second,
           stacked layer (snooze prompts and the like) and is empty here. */
        const modal = await c.evaluate(() => {
          const bd = document.querySelector("#modal-backdrop");
          const m = document.querySelector("#modal");
          if (!bd || bd.classList.contains("hidden") || !m) return null;
          return { html: m.innerHTML, text: m.textContent || "" };
        });
        ok("C2f · clicking that button opens the case modal", !!modal, String(!!modal));
        if (modal) {
          /* The modal has no single id attribute to read, so identity is proven twice over: the
             case id appears in the markup it wires its own actions with, and the client the alert
             names is the client on screen. */
          const who = await clientFullName(c, target.client_id);
          ok("C2g · …on the right case (its id wires the modal's own actions)", modal.html.includes(target.case_id), target.case_id);
          ok("C2h · …and the client the alert named is the client on screen", modal.text.includes(who), who);
        }
        await c.evaluate(() => window.closeModal && window.closeModal());
        await wait(c, 400);
      }

      console.log("\n— §C3 · the panel's own copy names the new checks");
      const sub = await c.$eval("#watchtower-sub", (e) => e.textContent.trim());
      ok("C3a · the Watchtower panel-sub names the offer-date check", /Offer expires before completion/.test(sub), sub);
      ok("C3b · …and the ERC check, with Early Repayment Charge spelled out", /Completing inside old ERC/.test(sub) && /Early Repayment Charge/.test(sub), sub);
      ok("C3c · …and says the email check is counted per client", /per client/.test(sub) && /not one per message/.test(sub), sub);
      const gloss = await c.evaluate(async () => {
        const btn = document.getElementById("help-btn");
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 700));
        const t = document.body.textContent || "";
        if (window.closeModal) window.closeModal();
        return t;
      });
      ok("C3d · the Help & glossary Watchtower entry names both new checks",
        /Offer expires before completion/.test(gloss) && /Completing inside old ERC/.test(gloss), "glossary text did not mention them");
      ok("C3e · …and explains the per-client email count there too", /one row per person waiting on a reply/.test(gloss), "glossary text did not explain it");
      ok("§C · no console errors (p1)", !(c.__err || []).length, JSON.stringify(c.__err));
      await c.close();

      console.log("\n— §C4 · the same panel on an adviser (p2) and the owner (p4)");
      for (const persona of ["p2", "p4"]) {
        const q = await newPage(browser, persona);
        await openWatchtower(q);
        await q.click("#watchtower-run");
        await wait(q, 1500);
        const gs = await wtGroups(q);
        const labels = gs.map((g) => g.label);
        ok(`C4 · ${persona} · the panel renders with no console errors`, !(q.__err || []).length, JSON.stringify(q.__err));
        ok(`C4 · ${persona} · every group carries a written label, never a bare rule token`,
          labels.every((l) => l && !/_/.test(l)), JSON.stringify(labels));
        /* The synthetic "my data health" rows (R34 · Part 4) are computed client-side per adviser
           and have no watch_alerts row behind them. R65 adds rules to the RPC and nothing to that
           path, so an adviser must still get them, still Open-only, and the new rules must not
           have leaked into it. */
        if (persona === "p2") {
          const synth = await q.$$eval("#watchtower-list .wt-row-mine", (els) => els.map((e) => ({
            rule: e.dataset.wtSynth,
            buttons: [...e.querySelectorAll("button")].map((b) => b.textContent.trim()),
          })));
          ok("C4 · p2 · the synthetic my-data-health rows still build (or are legitimately absent)",
            Array.isArray(synth), JSON.stringify(synth));
          ok("C4 · p2 · …and none of them is one of the new RPC rules",
            synth.every((s) => !/before_completion/.test(s.rule || "")), JSON.stringify(synth));
          ok("C4 · p2 · …and they still carry no Snooze/Dismiss (there is no row behind them)",
            synth.every((s) => !s.buttons.some((t) => /Snooze|Dismiss/.test(t))), JSON.stringify(synth));
        }
        await q.close();
      }
    }

  } catch (e) {
    failures.push("EXCEPTION: " + (e && e.stack ? e.stack : e));
    console.log("  ✗ EXCEPTION: " + (e && e.message ? e.message : e));
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r65_watchtower: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
