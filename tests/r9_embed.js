#!/usr/bin/env node
/* =============================================================================
   tests/r9_embed.js — regression tests for the ROUND-9 EMBED AMBIGUITY break.

   WHAT BROKE, AND WHY 1,528 CHECKS DID NOT CATCH IT
   -------------------------------------------------
   Round 9's migration m11 added

       alter table cases add column referrer_client_id uuid references clients(id)

   (constraint `cases_referrer_client_id_fkey`) alongside the original
   `cases.client_id` (`cases_client_id_fkey`). From that moment `cases` and
   `clients` are joined by TWO foreign keys, and PostgREST stops guessing: every
   embed between the two tables — in either direction, at any nesting depth —
   must name the relationship, or the request comes back

       HTTP 300  PGRST201
       "Could not embed because more than one relationship was found for
        'cases' and 'clients'"

   The deployed Pipeline (and every other page embedding clients from cases)
   started 300-ing live. The harness stayed green because the mock's embed
   resolver was PERMISSIVE: it took the first FK column it found and carried on,
   so the very query production refused resolved happily here. A mock that is
   more permissive than the thing it mirrors makes a page look healthy on the
   one property that is actually broken — the same lesson HARNESS.md already
   records for the `nps-capture` stub.

   So this file has two halves and needs both:

     §1-§3  THE MOCK IS NOW STRICT. An unhinted embed between an ambiguous pair
            returns the exact PostgREST error shape (returned, never thrown);
            the `!column_name` and `!constraint_name` hints resolve to the
            relationship they name, both directions, nested; and the migration
            gate is honoured — with m11 OFF there is only one relationship and
            an unhinted embed is legal again, which is what a database that has
            not taken m11 really does.
     §4     THE APP IS NOW HINTED. Pipeline / My Day / Clients / Protection /
            Emails render REAL CLIENT NAMES as p1, p2 and p4. Names are the
            assertion on purpose: a page that 300s still draws its chrome, so
            "the page loaded" proves nothing. The name only appears if the
            embed resolved.

   Ground truth for §2 is recomputed here from the fixture tables, never read
   back from app.js's own idea of the answer.

   Run:  node /root/nx/tests/r9_embed.js   (expects a static server on 8099;
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
  page.__dialogAnswer = "accept";
  page.on("dialog", async (d) => { if (page.__dialogAnswer === "dismiss") await d.dismiss(); else await d.accept(); });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const goTo = async (page, name, wait) => { await page.evaluate((n) => window.nav(n), name); await page.waitForTimeout(wait || 1500); };

/* Run an arbitrary select in the page and bring back the WHOLE envelope,
   including whether the call threw — "returned as an error, not thrown" is
   itself part of the PostgREST contract this file is pinning. */
async function runSelect(page, table, sel, opts) {
  return page.evaluate(async ([t, s, o]) => {
    try {
      let q = window.__mockDb.from(t).select(s);
      if (o && o.eqCol) q = q.eq(o.eqCol, o.eqVal);
      if (o && o.single) q = q.single();
      if (o && o.limit) q = q.limit(o.limit);
      const r = await q;
      return {
        threw: false, data: r.data, error: r.error || null,
        status: r.status, statusText: r.statusText,
      };
    } catch (e) {
      return { threw: true, thrown: String((e && e.message) || e), data: null, error: null };
    }
  }, [table, sel, opts || null]);
}

const AMBIG = (a, b) =>
  `Could not embed because more than one relationship was found for '${a}' and '${b}'`;

/* ---------------------------------------------------------------------------
   GROUND TRUTH — computed from the fixture tables with EXPLICIT column reads
   only (no embeds at all), so nothing here depends on the resolver under test.
   --------------------------------------------------------------------------- */
async function groundTruth(page) {
  return page.evaluate(async () => {
    const db = window.__mockDb;
    const cases = (await db.from("cases").select("id,client_id,referrer_client_id,stage")).data || [];
    const clients = (await db.from("clients").select("id,first_name,last_name")).data || [];
    const tasks = (await db.from("case_tasks").select("id,case_id,title")).data || [];
    const byId = {};
    clients.forEach((c) => { byId[c.id] = c; });
    const referred = cases.filter((c) => c.referrer_client_id);
    /* the referrer we lean on: one who has sent somebody AND has cases of their
       own, so `cases!client_id` and `cases!referrer_client_id` are genuinely
       different sets rather than accidentally equal */
    let referrerId = null;
    for (const r of referred) {
      const own = cases.filter((c) => c.client_id === r.referrer_client_id).map((c) => c.id).sort();
      const sent = cases.filter((c) => c.referrer_client_id === r.referrer_client_id).map((c) => c.id).sort();
      if (own.length && sent.length && JSON.stringify(own) !== JSON.stringify(sent)) { referrerId = r.referrer_client_id; break; }
    }
    if (!referrerId && referred.length) referrerId = referred[0].referrer_client_id;
    const plainCase = cases.find((c) => c.client_id && !c.referrer_client_id) || null;
    const refCase = referred[0] || null;
    const task = tasks.find((t) => t.case_id && cases.some((c) => c.id === t.case_id)) || null;
    const taskCase = task ? cases.find((c) => c.id === task.case_id) : null;
    return {
      caseCount: cases.length,
      referredCount: referred.length,
      referrerId,
      referrerOwnCaseIds: referrerId ? cases.filter((c) => c.client_id === referrerId).map((c) => c.id).sort() : [],
      referrerSentCaseIds: referrerId ? cases.filter((c) => c.referrer_client_id === referrerId).map((c) => c.id).sort() : [],
      plainCase,
      plainCaseClient: plainCase ? byId[plainCase.client_id] || null : null,
      refCase,
      refCaseClient: refCase ? byId[refCase.client_id] || null : null,
      refCaseReferrer: refCase ? byId[refCase.referrer_client_id] || null : null,
      task, taskCase,
      taskCaseClient: taskCase ? byId[taskCase.client_id] || null : null,
      /* surnames of clients with a case, for the page-render assertions */
      caseSurnames: [...new Set(cases.map((c) => (byId[c.client_id] || {}).last_name).filter(Boolean))],
    };
  });
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {

    /* ===================================================================
       0 · FIXTURE SHAPE — stated once, so a later failure reads as "the
       resolver is wrong" rather than "the fixtures moved under us"
       =================================================================== */
    let GT;
    const page = await newPage(browser, "p4");
    {
      console.log("\n— R9-EMBED · fixture shape");
      GT = await groundTruth(page);
      ok("fixture · cases exist", GT.caseCount > 0, String(GT.caseCount));
      ok("fixture · m11 is on and at least one case names a referrer", GT.referredCount > 0, String(GT.referredCount));
      ok("fixture · a case with a client and NO referrer exists", !!GT.plainCase);
      ok("fixture · a referrer exists whose own cases differ from the ones they sent",
        !!GT.referrerId && JSON.stringify(GT.referrerOwnCaseIds) !== JSON.stringify(GT.referrerSentCaseIds),
        JSON.stringify({ own: GT.referrerOwnCaseIds, sent: GT.referrerSentCaseIds }));
      ok("fixture · a case_task hangs off a case with a client", !!GT.task && !!GT.taskCaseClient);
    }

    /* ===================================================================
       1 · THE AMBIGUOUS UNHINTED EMBED — the exact live failure
       =================================================================== */
    {
      console.log("\n— R9-EMBED-1 · an unhinted cases↔clients embed is refused, exactly as PostgREST refuses it");

      const r = await runSelect(page, "cases", "id,client_id,clients(first_name,last_name)");
      ok("R9-E1 · the call RETURNS, it does not throw", r.threw === false, r.thrown);
      ok("R9-E1 · data is null", r.data === null, JSON.stringify(r.data && r.data.slice && r.data.slice(0, 1)));
      ok("R9-E1 · an error came back", !!r.error);
      eq("R9-E1 · the message is PostgREST's, word for word", r.error && r.error.message, AMBIG("cases", "clients"));
      eq("R9-E1 · code PGRST201", r.error && r.error.code, "PGRST201");
      eq("R9-E1 · HTTP 300 Multiple Choices", [r.status, r.statusText], [300, "Multiple Choices"]);
      ok("R9-E1 · details lists BOTH relationships",
        Array.isArray(r.error && r.error.details) && r.error.details.length === 2,
        JSON.stringify(r.error && r.error.details));
      const rel = ((r.error && r.error.details) || []).map((d) => d.relationship).join(" | ");
      ok("R9-E1 · details names cases_client_id_fkey", /cases_client_id_fkey using cases\(client_id\)/.test(rel), rel);
      ok("R9-E1 · details names cases_referrer_client_id_fkey", /cases_referrer_client_id_fkey using cases\(referrer_client_id\)/.test(rel), rel);
      const hint = (r.error && r.error.hint) || "";
      ok("R9-E1 · the hint offers both disambiguated forms",
        hint.includes("'clients!cases_client_id_fkey'") && hint.includes("'clients!cases_referrer_client_id_fkey'"), hint);

      /* the other direction */
      const rv = await runSelect(page, "clients", "id,cases(id,stage)");
      ok("R9-E1b · clients→cases unhinted is refused too", !!rv.error && rv.data === null);
      eq("R9-E1b · …naming the pair the other way round", rv.error && rv.error.message, AMBIG("clients", "cases"));
      const hv = (rv.error && rv.error.hint) || "";
      ok("R9-E1b · the reverse hint offers the reverse constraint forms",
        hv.includes("'cases!cases_client_id_fkey'") && hv.includes("'cases!cases_referrer_client_id_fkey'"), hv);

      /* nested — the hop that broke My Day's task list */
      const rn = await runSelect(page, "case_tasks", "id,title,cases(clients(first_name,last_name))");
      ok("R9-E1c · a NESTED unhinted clients embed under cases is refused", !!rn.error && rn.data === null);
      eq("R9-E1c · …reported for the inner pair, not the outer one", rn.error && rn.error.message, AMBIG("cases", "clients"));

      /* `!inner` is a join modifier, not a relationship hint */
      const ri = await runSelect(page, "case_tasks", "id,cases!inner(clients(first_name))");
      ok("R9-E1d · `!inner` does not count as disambiguation", !!ri.error && ri.data === null);
      eq("R9-E1d · …still the cases↔clients ambiguity", ri.error && ri.error.message, AMBIG("cases", "clients"));

      /* .single() must not mask it as PGRST116 */
      const rs = await runSelect(page, "cases", "id,clients(first_name)", { eqCol: "id", eqVal: GT.plainCase.id, single: true });
      eq("R9-E1e · .single() surfaces PGRST201, not PGRST116", rs.error && rs.error.code, "PGRST201");

      /* a returning-select on a write is validated the same way. `.eq` on an id
         that cannot exist means this touches nothing. */
      const ru = await page.evaluate(async () => {
        const r2 = await window.__mockDb.from("cases").update({ stage: "enquiry" }).eq("id", "__no_such_case__").select("id,clients(first_name)");
        return { code: r2.error && r2.error.code, msg: r2.error && r2.error.message, data: r2.data };
      });
      eq("R9-E1f · an ambiguous returning-select on a write is refused too", [ru.code, ru.msg], ["PGRST201", AMBIG("cases", "clients")]);

      /* the blast radius stops at the ambiguous pair */
      const okAppt = await runSelect(page, "appointments", "id,clients(first_name,last_name)", { limit: 5 });
      ok("R9-E1g · appointments→clients (one FK) still resolves unhinted", !okAppt.error && Array.isArray(okAppt.data) && okAppt.data.length > 0, JSON.stringify(okAppt.error));
      const okEmail = await runSelect(page, "email_queue", "id,clients(first_name,last_name)", { limit: 5 });
      ok("R9-E1h · email_queue→clients still resolves unhinted", !okEmail.error && Array.isArray(okEmail.data) && okEmail.data.length > 0, JSON.stringify(okEmail.error));
      const okIntro = await runSelect(page, "cases", "id,introducers(name)", { limit: 5 });
      ok("R9-E1i · cases→introducers still resolves unhinted", !okIntro.error && Array.isArray(okIntro.data), JSON.stringify(okIntro.error));
      const okTaskCase = await runSelect(page, "case_tasks", "id,cases(id,stage)", { limit: 5 });
      ok("R9-E1j · case_tasks→cases (one FK) still resolves unhinted", !okTaskCase.error && Array.isArray(okTaskCase.data) && okTaskCase.data.length > 0, JSON.stringify(okTaskCase.error));
    }

    /* ===================================================================
       2 · THE HINTS RESOLVE — both directions, both spellings, nested
       =================================================================== */
    {
      console.log("\n— R9-EMBED-2 · !column_name and !constraint_name resolve the relationship they name");

      const one = await runSelect(page, "cases", "id,client_id,clients!client_id(id,first_name,last_name)", { eqCol: "id", eqVal: GT.plainCase.id });
      ok("R9-E2 · the column hint resolves", !one.error, JSON.stringify(one.error));
      eq("R9-E2 · …to the OWNING client", one.data && one.data[0] && one.data[0].clients && one.data[0].clients.id, GT.plainCaseClient.id);
      ok("R9-E2 · the result key is the bare table name — a hint disambiguates, it does not rename",
        !!(one.data && one.data[0] && Object.prototype.hasOwnProperty.call(one.data[0], "clients")
          && !Object.prototype.hasOwnProperty.call(one.data[0], "clients!client_id")),
        JSON.stringify(one.data && one.data[0] && Object.keys(one.data[0])));

      const byConstraint = await runSelect(page, "cases", "id,clients!cases_client_id_fkey(id,first_name,last_name)", { eqCol: "id", eqVal: GT.plainCase.id });
      ok("R9-E2b · the constraint-name hint resolves", !byConstraint.error, JSON.stringify(byConstraint.error));
      eq("R9-E2b · …identically to the column hint",
        byConstraint.data && byConstraint.data[0] && byConstraint.data[0].clients,
        one.data && one.data[0] && one.data[0].clients);

      /* the referrer hop — the relationship that caused all this */
      const ref = await runSelect(page, "cases", "id,client_id,referrer_client_id,clients!referrer_client_id(id,first_name,last_name)", { eqCol: "id", eqVal: GT.refCase.id });
      ok("R9-E2c · clients!referrer_client_id resolves", !ref.error, JSON.stringify(ref.error));
      eq("R9-E2c · …to the REFERRER, not the case's own client",
        ref.data && ref.data[0] && ref.data[0].clients && ref.data[0].clients.id, GT.refCaseReferrer.id);
      ok("R9-E2c · …and the referrer is genuinely a different person from the client",
        GT.refCaseReferrer.id !== GT.refCaseClient.id, JSON.stringify([GT.refCaseReferrer.id, GT.refCaseClient.id]));
      const refBoth = await runSelect(page, "cases", "id,clients!client_id(id),clients!cases_referrer_client_id_fkey(id)", { eqCol: "id", eqVal: GT.refCase.id });
      ok("R9-E2d · the referrer's constraint-name hint resolves", !refBoth.error, JSON.stringify(refBoth.error));
      const nonRef = await runSelect(page, "cases", "id,clients!referrer_client_id(id)", { eqCol: "id", eqVal: GT.plainCase.id });
      eq("R9-E2e · a case with no referrer embeds null, not the owning client",
        nonRef.data && nonRef.data[0] && nonRef.data[0].clients, null);

      /* reverse direction — client → their cases vs. cases they sent */
      const own = await runSelect(page, "clients", "id,cases!client_id(id)", { eqCol: "id", eqVal: GT.referrerId });
      ok("R9-E2f · clients→cases!client_id resolves", !own.error, JSON.stringify(own.error));
      eq("R9-E2f · …to exactly that client's OWN cases",
        ((own.data && own.data[0] && own.data[0].cases) || []).map((c) => c.id).sort(), GT.referrerOwnCaseIds);
      const sent = await runSelect(page, "clients", "id,cases!referrer_client_id(id)", { eqCol: "id", eqVal: GT.referrerId });
      ok("R9-E2g · clients→cases!referrer_client_id resolves", !sent.error, JSON.stringify(sent.error));
      eq("R9-E2g · …to exactly the cases that client REFERRED",
        ((sent.data && sent.data[0] && sent.data[0].cases) || []).map((c) => c.id).sort(), GT.referrerSentCaseIds);
      ok("R9-E2h · the two reverse hints return different sets — the hint picks the relationship, it is not decoration",
        JSON.stringify(GT.referrerOwnCaseIds) !== JSON.stringify(GT.referrerSentCaseIds));
      const sentByConstraint = await runSelect(page, "clients", "id,cases!cases_referrer_client_id_fkey(id)", { eqCol: "id", eqVal: GT.referrerId });
      eq("R9-E2i · the reverse constraint-name hint agrees with the reverse column hint",
        ((sentByConstraint.data && sentByConstraint.data[0] && sentByConstraint.data[0].cases) || []).map((c) => c.id).sort(),
        GT.referrerSentCaseIds);

      /* nested */
      const nested = await runSelect(page, "case_tasks", "id,case_id,cases(client_id,clients!client_id(id,first_name,last_name))", { eqCol: "id", eqVal: GT.task.id });
      ok("R9-E2j · a nested hint resolves", !nested.error, JSON.stringify(nested.error));
      eq("R9-E2j · …to the task's case's client",
        nested.data && nested.data[0] && nested.data[0].cases && nested.data[0].cases.clients && nested.data[0].cases.clients.id,
        GT.taskCaseClient.id);
      const nestedRef = await runSelect(page, "case_tasks", "id,cases(clients!referrer_client_id(id))", { eqCol: "id", eqVal: GT.task.id });
      ok("R9-E2k · the nested referrer hint resolves too", !nestedRef.error, JSON.stringify(nestedRef.error));

      /* a hint on a pair that was never ambiguous is still accepted */
      const hintedUnambiguous = await runSelect(page, "case_tasks", "id,cases!case_id(id,stage)", { eqCol: "id", eqVal: GT.task.id });
      ok("R9-E2l · a hint on an unambiguous pair is accepted, not rejected", !hintedUnambiguous.error, JSON.stringify(hintedUnambiguous.error));
      eq("R9-E2l · …and resolves to the right case",
        hintedUnambiguous.data && hintedUnambiguous.data[0] && hintedUnambiguous.data[0].cases && hintedUnambiguous.data[0].cases.id,
        GT.task.case_id);

      /* a hint that names nothing must NOT quietly fall back to a guess */
      const bogus = await runSelect(page, "cases", "id,clients!not_a_column(id)", { eqCol: "id", eqVal: GT.plainCase.id });
      eq("R9-E2m · an unknown hint resolves to nothing rather than guessing a relationship",
        bogus.data && bogus.data[0] && bogus.data[0].clients, null);

      /* !inner alongside a hint */
      const innerHinted = await runSelect(page, "cases", "id,clients!client_id!inner(id)", { limit: 200 });
      ok("R9-E2n · a hint and `!inner` compose", !innerHinted.error, JSON.stringify(innerHinted.error));
      ok("R9-E2n · …and `!inner` drops rows whose embed is empty",
        Array.isArray(innerHinted.data) && innerHinted.data.every((r) => r.clients),
        JSON.stringify((innerHinted.data || []).filter((r) => !r.clients).length));
    }

    /* ===================================================================
       3 · THE MIGRATION GATE — no m11, no second relationship, no ambiguity
       =================================================================== */
    {
      console.log("\n— R9-EMBED-3 · without m11 the pair has ONE relationship again");
      const p = await newPage(browser, "p4");
      await p.evaluate(() => window.__mock.setMigrations({ m11: false }));
      const un = await runSelect(p, "cases", "id,clients(first_name,last_name)", { limit: 5 });
      ok("R9-E3 · an unhinted embed is legal on a database that never took m11",
        !un.error && Array.isArray(un.data) && un.data.length > 0 && !!un.data[0].clients, JSON.stringify(un.error));
      const hi = await runSelect(p, "cases", "id,clients!client_id(first_name,last_name)", { limit: 5 });
      ok("R9-E3b · …and the hinted form the app now sends still resolves there",
        !hi.error && Array.isArray(hi.data) && hi.data.length > 0 && !!hi.data[0].clients, JSON.stringify(hi.error));
      const rv = await runSelect(p, "clients", "id,cases(id)", { limit: 5 });
      ok("R9-E3c · the reverse direction is unambiguous without m11 as well", !rv.error, JSON.stringify(rv.error));
      await p.evaluate(() => window.__mock.setMigrations({ m11: true }));
      const back = await runSelect(p, "cases", "id,clients(first_name)", { limit: 5 });
      eq("R9-E3d · turning m11 back on restores the refusal", back.error && back.error.code, "PGRST201");
      await p.close();
    }

    await page.close();

    /* ===================================================================
       4 · THE PAGES — real client names, as p1 / p2 / p4
       A 300 still leaves the page furniture standing, so every check below
       asserts NAMES, not "the container exists".
       =================================================================== */
    {
      console.log("\n— R9-EMBED-4 · the pages that embed clients from cases render with data");
      for (const persona of ["p1", "p2", "p4"]) {
        const pg = await newPage(browser, persona);
        const surnames = GT.caseSurnames;
        const hasAName = (text) => surnames.filter((s) => text.includes(s)).length;

        /* Pipeline — the page that broke */
        await goTo(pg, "pipeline", 1600);
        const pipe = await pg.evaluate(() => {
          const names = [...document.querySelectorAll("#board .card .cn-name")].map((e) => e.textContent.trim());
          const rows = [...document.querySelectorAll("#table-wrap tbody tr")].length;
          return { names, rows, text: (document.querySelector("#page-pipeline") || {}).innerText || "" };
        });
        ok(`R9-E4 · ${persona} · Pipeline draws case cards`, pipe.names.length > 0, String(pipe.names.length));
        ok(`R9-E4 · ${persona} · …every card carries a client name, none blank`,
          pipe.names.length > 0 && pipe.names.every((n) => n.length > 1), JSON.stringify(pipe.names.filter((n) => n.length <= 1)));
        ok(`R9-E4 · ${persona} · …and those names are fixture clients`, hasAName(pipe.names.join(" ")) >= 3, JSON.stringify(pipe.names.slice(0, 5)));
        ok(`R9-E4 · ${persona} · Pipeline shows no embed error`, !/more than one relationship/i.test(pipe.text));

        /* My Day */
        await goTo(pg, "dashboard", 1500);
        const day = await pg.evaluate(() => {
          if (window.setBriefScope) window.setBriefScope("all");
          return null;
        });
        await pg.waitForTimeout(1300);
        const dayText = await pg.evaluate(() => (document.querySelector("#page-dashboard") || {}).innerText || "");
        ok(`R9-E4 · ${persona} · My Day names clients`, hasAName(dayText) >= 1, dayText.slice(0, 160));
        ok(`R9-E4 · ${persona} · My Day shows no embed error`, !/more than one relationship/i.test(dayText));

        /* Clients — the reverse direction (clients → cases!client_id) */
        await goTo(pg, "clients", 1500);
        const cl = await pg.evaluate(() => {
          const el = document.querySelector("#client-list");
          return { text: el ? el.innerText : "", rows: el ? el.children.length : 0 };
        });
        ok(`R9-E4 · ${persona} · Clients lists people`, cl.rows > 0, String(cl.rows));
        ok(`R9-E4 · ${persona} · …with their case counts, so cases!client_id resolved`, /\d+ case/.test(cl.text), cl.text.slice(0, 160));
        ok(`R9-E4 · ${persona} · Clients shows no embed error`, !/more than one relationship/i.test(cl.text));

        /* Protection */
        await goTo(pg, "protection", 1500);
        const prot = await pg.evaluate(() => {
          const t = document.querySelector("#prot-table");
          return { rows: t ? t.querySelectorAll("tbody tr").length : 0, text: t ? t.innerText : "" };
        });
        ok(`R9-E4 · ${persona} · Protection lists cases`, prot.rows > 0, String(prot.rows));
        ok(`R9-E4 · ${persona} · …naming the client on each`, hasAName(prot.text) >= 1, prot.text.slice(0, 160));
        ok(`R9-E4 · ${persona} · Protection shows no embed error`, !/more than one relationship/i.test(prot.text));

        /* Emails */
        await goTo(pg, "emails", 1600);
        const em = await pg.evaluate(() => {
          const el = document.querySelector("#email-list");
          return { text: el ? el.innerText : "", rows: el ? el.children.length : 0 };
        });
        ok(`R9-E4 · ${persona} · Emails lists queued messages`, em.rows > 0, String(em.rows));
        ok(`R9-E4 · ${persona} · …naming the recipient`, hasAName(em.text) >= 1, em.text.slice(0, 160));
        ok(`R9-E4 · ${persona} · Emails shows no embed error`, !/more than one relationship/i.test(em.text));

        ok(`R9-E4 · ${persona} · no console errors across all five pages`, !pg.__err, JSON.stringify(pg.__err));
        await pg.close();
      }
    }

  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (_) { } }
  }

  console.log("\n================================================================");
  console.log(`r9_embed: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
