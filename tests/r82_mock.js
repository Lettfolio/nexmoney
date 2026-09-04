#!/usr/bin/env node
/* =============================================================================
   tests/r82_mock.js — R82 · B: the mock learns about sign-ins, and the
   adoption panel can finally tell "signed in and read quietly" apart from
   "never came".

   FOUR THINGS, all of them agent B's:

   B1 · `get_staff_activity()` REGISTERED IN THE MOCK. The CTO shipped it to
        production this round: no arguments, guarded to signed-in staff
        (anybody else gets an EMPTY ARRAY, not a raise), returning one entry per
        `profiles` row — { id, has_signed_in, last_sign_in_at, invited_at }.
        Mirrored faithfully, including R81's strict mode (registered in
        RPC_ARGS with an empty arg list) and including the ability to model a
        database WITHOUT it, which is the state every defensive consumer exists
        for (`setMigrations({m12:false})`, or the new pre-load seed
        `window.__mockMigrations` for a suite that needs it off from the very
        first read of the page).
        The sign-in facts live in their OWN side table, not as `profiles`
        columns, because in production they live in `auth.users` — modelling
        them as profiles columns would let a ghost select pass strict mode that
        production would 42703.
   B2 · the build tag (`__nxTag_core` / `__nxTag_reportsmoney` → "r82"); pinned
        by r81_platform §C, not here.
   B3 · THE ADOPTION PANEL SHOWS SIGN-IN TRUTH. A new "Signed in" column ahead
        of "Last active", a dormant pill, and a rewritten explanatory paragraph
        that no longer disclaims a blind spot the app no longer has — while
        staying just as precise about the one it now has instead (a sign-in is
        not usage). Consumed DEFENSIVELY: a missing RPC, a refusal, a transport
        failure or an unrecognised shape all fall back to today's behaviour and
        today's wording. A failed read never makes a colleague look inactive.
   B4 · v20's SEND-TIME FINANCIAL-PROMOTIONS REFUSAL mirrored in the mock's
        process-emails (HARNESS's standing mock-parity rule): for
        FIN_PROMO_TYPES = referral_request / protection_offer / gi_exchange,
        an unapproved `settings.financial_promotions_approved` CANCELS the row
        with the exact error string and counts `results.skipped_promos`.

   §A — the RPC: shape, guard, strict registration, the missing-function
        toggle (both ways in), and the seed hook that expresses production.
   §B — the panel with the production seed: three logins invited and never
        signed in, Daniel the only human who has ever used the system.
   §C — the fallback: RPC absent, and RPC answering nonsense. Both land on
        today's behaviour, today's wording and NOBODY flagged.
   §D — v20's refusal in the mock's send path, including its position in the
        order and its fail-closed default.

   Standing rules obeyed: ground truth read from `window.__mockDb` /
   `window.__mock` at runtime, never hardcoded; poll for DOM conditions rather
   than sleeping and hoping.

   Run:  node /root/nx/tests/r82_mock.js   (expects a static server on 8099;
         spawns one if none is listening)
   (Copy to /tmp and patch REPO/PORT to run against a worktree — HARNESS.md.)
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
    r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  return srv;
}

/* `init` runs in an addInitScript, i.e. BEFORE mock-supabase.js evaluates — the only place a
   pre-load flag like window.__mockMigrations can be set and still be seen. */
async function boot(browser, persona, init) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  page.__ctx = ctx;
  page.__err = [];
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.on("pageerror", (e) => page.__err.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console: " + m.text()); });
  await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  if (init) await page.addInitScript(init);
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon|fonts\.googleapis/i.test(e));

const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 2600 : ms);
};
/* PLAYWRIGHT-AWAIT — poll for a DOM condition rather than sleeping and hoping. */
async function waitFor(page, fn, arg, timeout = 9000) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await page.waitForTimeout(120);
  }
}

/* THE PRODUCTION SITUATION, stated once. Kim, Wayne and Luke were invited on 4 July 2026 and have
   never signed in; Daniel is the only human who has ever used this system. Expressed through the
   fixture HOOK rather than by moving a default, because 86 other suites were written on the
   assumption that every colleague is a live desk. Dates are computed from "now" at runtime — the
   standing rule — so nothing here goes stale. */
const INVITED_DAYS_AGO = 61;
async function seedProduction(page) {
  return page.evaluate((d) => {
    const invited = new Date(Date.now() - d * 86400000).toISOString();
    return window.__mock.seedStaffActivity({
      p1: { has_signed_in: false, invited_at: invited },
      p2: { has_signed_in: false, invited_at: invited },
      p3: { has_signed_in: false, invited_at: invited },
    });
  }, INVITED_DAYS_AGO);
}
/* Read the whole Signed in / Last active table back off the DOM, in one go. */
const readStrip = (page) => page.evaluate(() => {
  const t = document.getElementById("report-adoption-table");
  if (!t) return null;
  return {
    cols: [...t.querySelectorAll("tr:first-child th")].map((h) => h.textContent.replace(/\s+/g, " ").trim()),
    rows: [...t.querySelectorAll("tr.adopt-row")].map((r) => {
      const s = r.querySelector(".adopt-signin");
      const l = r.querySelector(".adopt-last");
      return {
        id: r.dataset.staff,
        signin: s ? s.dataset.signin : null,
        signinText: s ? s.textContent.replace(/\s+/g, " ").trim() : null,
        signinTitle: s ? (s.getAttribute("title") || "") : "",
        invited: s ? (s.dataset.invited || "") : "",
        lastSignin: s ? (s.dataset.lastSignin || "") : "",
        unknown: !!(s && s.classList.contains("adopt-signin-unknown")),
        never: !!(s && s.classList.contains("adopt-signin-never")),
        last: l ? l.dataset.last : null,
        lastText: l ? l.textContent.replace(/\s+/g, " ").trim() : null,
        lastTitle: l ? (l.getAttribute("title") || "") : "",
        touched: r.querySelector(".adopt-touched") ? r.querySelector(".adopt-touched").dataset.n : null,
        overdue: r.querySelector(".adopt-overdue") ? r.querySelector(".adopt-overdue").dataset.n : null,
      };
    }),
    sub: (document.getElementById("report-adoption-sub") || {}).textContent || "",
    dormantPill: document.getElementById("report-adoption-dormant")
      ? { n: document.getElementById("report-adoption-dormant").dataset.n,
        text: document.getElementById("report-adoption-dormant").textContent.trim() } : null,
    activePill: (document.querySelector(".adopt-h .count") || {}).textContent || "",
  };
});

/* Flip a settings row and refresh the app's cached copy (r76_intake's documented pattern — an
   admin cannot write settings through the app's own client). */
async function setSetting(page, key, value) {
  await page.evaluate(async (o) => {
    const rows = window.__mock.db.settings;
    const row = rows.filter((r) => r.key === o.key)[0];
    if (o.value === null) { const i = rows.indexOf(row); if (i >= 0) rows.splice(i, 1); }
    else if (row) row.value = o.value;
    else rows.push({ key: o.key, value: o.value, updated_at: new Date().toISOString() });
    if (window.__reloadSettings) await window.__reloadSettings();
  }, { key, value });
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* =====================================================================
       §A · B1 — THE RPC: shape, guard, strict registration, toggles
       ===================================================================== */
    console.log("\n— §A · B1 · get_staff_activity() is registered faithfully (p1 Kim, admin)");
    {
      const page = await boot(browser, "p1");

      const a = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data, error } = await db.rpc("get_staff_activity");
        const profiles = (await db.from("profiles").select("id")).data.map((p) => p.id).sort();
        return {
          error, isArray: Array.isArray(data),
          ids: (data || []).map((r) => r.id).sort(),
          profiles,
          keys: [...new Set((data || []).flatMap((r) => Object.keys(r)))].sort(),
          typesOk: (data || []).every((r) => typeof r.has_signed_in === "boolean"
            && (r.last_sign_in_at === null || typeof r.last_sign_in_at === "string")
            && (r.invited_at === null || typeof r.invited_at === "string")),
          nullRule: (data || []).every((r) => (r.has_signed_in === true) || r.last_sign_in_at === null),
        };
      });
      ok("A1a · the RPC answers with no error", a.error === null, JSON.stringify(a.error));
      ok("A1b · …a JSON ARRAY, one entry per profiles row (the deactivated login and the introducer included)",
        a.isArray && JSON.stringify(a.ids) === JSON.stringify(a.profiles), JSON.stringify({ ids: a.ids, profiles: a.profiles }));
      eq("A1c · exactly the four columns the CTO shipped", a.keys, ["has_signed_in", "id", "invited_at", "last_sign_in_at"]);
      ok("A1d · has_signed_in is a real boolean; the two timestamps are a string or null", a.typesOk, JSON.stringify(a));
      ok("A1e · last_sign_in_at is null wherever has_signed_in is false — the only combination auth.users can produce",
        a.nullRule, JSON.stringify(a));

      /* A2 — STRICT MODE. The RPC takes NO arguments, so an invented one is production's PGRST202
         and R81's strict registry throws it in the caller's own stack. */
      const a2 = await page.evaluate(async () => {
        try { await window.__mockDb.rpc("get_staff_activity", { p_scope: "all" }); return { threw: false }; }
        catch (e) { return { threw: true, message: String((e && e.message) || e) }; }
      });
      ok("A2a · an invented argument THROWS the strict rpc-arg message (registered with an empty arg list)",
        a2.threw && /MOCK STRICT: unknown rpc arg 'get_staff_activity\.p_scope'/.test(a2.message || ""), JSON.stringify(a2));
      const a2b = await page.evaluate(async () => {
        const r = await window.__mockDb.rpc("get_staff_activity", {});
        return Array.isArray(r.data) && r.error === null;
      });
      ok("A2b · …and calling it with an empty args object is legal, as it is in production", a2b);

      /* A3 — the seed hook, and what it does NOT do. */
      const before = await page.evaluate(async () => (await window.__mockDb.rpc("get_staff_activity")).data
        .reduce((m, r) => (m[r.id] = r.has_signed_in, m), {}));
      ok("A3a · the DEFAULT fixture has everybody signed in — no existing suite's routing moves",
        Object.keys(before).length > 0 && Object.values(before).every((v) => v === true), JSON.stringify(before));
      await seedProduction(page);
      const after = await page.evaluate(async () => (await window.__mockDb.rpc("get_staff_activity")).data);
      const byId = after.reduce((m, r) => (m[r.id] = r, m), {});
      eq("A3b · seedStaffActivity expresses production: Kim, Wayne and Luke never signed in",
        [byId.p1.has_signed_in, byId.p2.has_signed_in, byId.p3.has_signed_in], [false, false, false]);
      ok("A3c · …Daniel is the only human on the team who has ever used it",
        byId.p4.has_signed_in === true && byId.p4.last_sign_in_at, JSON.stringify(byId.p4));
      ok("A3d · …and the invite dates came through, so 'invited N days ago' is expressible",
        [byId.p1, byId.p2, byId.p3].every((r) => r.invited_at && r.last_sign_in_at === null), JSON.stringify(byId.p1));
      const a3e = await page.evaluate(() => {
        window.__mock.seedStaffActivity({ p2: true });
        return window.__mock.staffActivity().p2;
      });
      ok("A3e · the `true` shorthand puts a desk back, with a sign-in date",
        a3e && a3e.has_signed_in === true && !!a3e.last_sign_in_at, JSON.stringify(a3e));

      /* A4 — THE GUARD. Production returns an EMPTY ARRAY to a caller who is not signed-in staff,
         rather than raising: it is a read about the firm's own logins and an introducer gets
         nothing. Driven through readTableAs's own trick — swap the current uid, ask, swap back. */
      const a4 = await page.evaluate(async () => {
        const db = window.__mockDb;
        const asStaff = (await db.rpc("get_staff_activity")).data.length;
        /* p5 Rachel Foyle is the introducer login the staff gate exists to refuse. */
        const before = window.__mock.persona;
        const out = { asStaff, before };
        return out;
      });
      ok("A4a · signed-in staff get the full list", a4.asStaff > 0, JSON.stringify(a4));
      await page.__ctx.close();
    }
    {
      /* The introducer boots into the staff-login gate, which is exactly the caller the RPC's
         guard is about. The page still holds a live mock client, so the RPC can be asked. */
      const page = await boot(browser, "p5");
      const a4b = await page.evaluate(async () => {
        const r = await window.__mockDb.rpc("get_staff_activity");
        return { data: r.data, error: r.error, role: window.__mock.role() };
      });
      eq("A4b · an introducer gets an EMPTY ARRAY — the guard returns nothing, it does not raise",
        [a4b.data, a4b.error, a4b.role], [[], null, "introducer"]);
      await page.__ctx.close();
    }
    {
      /* A5 — THE MISSING-FUNCTION TOGGLE, both ways in. This is the toggle any suite pinning the
         UNSUPPORTED path needs, agent A's r82_correct §D1 included. */
      const page = await boot(browser, "p1");
      const a5 = await page.evaluate(async () => {
        window.__mock.setMigrations({ m12: false });
        const off = await window.__mockDb.rpc("get_staff_activity");
        window.__mock.setMigrations({ m12: true });
        const on = await window.__mockDb.rpc("get_staff_activity");
        return { offCode: off.error && off.error.code, offMsg: off.error && off.error.message,
          offData: off.data, onOk: Array.isArray(on.data) && on.error === null };
      });
      eq("A5a · setMigrations({m12:false}) makes the call a 42883 {error}, not a throw",
        [a5.offCode, a5.offData], ["42883", null]);
      ok("A5b · …with production's own undefined-function wording, which is what app.js feature-detects on",
        /function public\.get_staff_activity\(\) does not exist/.test(a5.offMsg || ""), a5.offMsg);
      ok("A5c · …and flipping it back on restores the RPC", a5.onOk, JSON.stringify(a5));
      await page.__ctx.close();
    }
    {
      /* A6 — the PRE-LOAD seed. setMigrations() can only be called once the page has loaded, which
         is already too late for anything read inside init(). A suite that needs the RPC missing
         from the very first read sets window.__mockMigrations in an addInitScript. */
      const page = await boot(browser, "p1", () => { window.__mockMigrations = { m12: false }; });
      const a6 = await page.evaluate(async () => {
        const r = await window.__mockDb.rpc("get_staff_activity");
        return { code: r.error && r.error.code, m12: window.__mock.migrations.m12, m6: window.__mock.migrations.m6 };
      });
      eq("A6a · window.__mockMigrations = {m12:false} is honoured from the very first read", [a6.code, a6.m12], ["42883", false]);
      eq("A6b · …and it touches nothing else (m6 is still on)", a6.m6, true);
      ok("A6c · no console errors (§A)", realErrs(page).length === 0, JSON.stringify(realErrs(page)));
      await page.__ctx.close();
    }

    /* =====================================================================
       §B · B3 — THE PANEL, WITH THE PRODUCTION SITUATION SEEDED
       ===================================================================== */
    console.log("\n— §B · B3 · the adoption panel shows sign-in truth (p4 Daniel, owner)");
    {
      const page = await boot(browser, "p4");
      await seedProduction(page);
      await goPage(page, "reports", 4200);
      const strip = await waitFor(page, () => {
        const t = document.getElementById("report-adoption-table");
        return t && t.querySelectorAll("tr.adopt-row").length ? true : null;
      }) ? await readStrip(page) : null;
      ok("B0 · the strip rendered", !!strip, JSON.stringify(strip));

      eq("B1 · a Signed in column sits immediately before Last active", strip.cols.slice(2, 4), ["Signed in", "Last active"]);

      const by = strip.rows.reduce((m, r) => (m[r.id] = r, m), {});
      eq("B2a · Kim, Wayne and Luke read `never` under Signed in",
        ["p1", "p2", "p3"].map((k) => by[k] && by[k].signin), ["never", "never", "never"]);
      ok("B2b · …each saying how long ago they were invited, not just that they never came",
        ["p1", "p2", "p3"].every((k) => new RegExp(`invited ${INVITED_DAYS_AGO} days ago`).test(by[k].signinText)),
        JSON.stringify(["p1", "p2", "p3"].map((k) => by[k].signinText)));
      ok("B2c · …and the row carries the real invite timestamp for anything that needs it",
        ["p1", "p2", "p3"].every((k) => by[k].invited && !isNaN(Date.parse(by[k].invited))), JSON.stringify(by.p1));
      ok("B2d · Daniel — the only human who has ever used this system — reads a sign-in DATE",
        by.p4 && by.p4.signin === "yes" && by.p4.lastSignin && /\(/.test(by.p4.signinText), JSON.stringify(by.p4));
      ok("B2e · nobody reads a bare 0 or an empty cell — every row says something",
        strip.rows.every((r) => r.signinText && r.signinText !== "0"), JSON.stringify(strip.rows.map((r) => r.signinText)));

      eq("B3a · the headline counts the dormant logins", strip.dormantPill && strip.dormantPill.n, "3");
      ok("B3b · …in the panel's own words", /3 never signed in/.test((strip.dormantPill || {}).text || ""), JSON.stringify(strip.dormantPill));
      ok("B3c · the original `N of M active` pill is untouched and still first",
        /\d+ of \d+ active/.test(strip.activePill), strip.activePill);

      /* B4 — THE PARAGRAPH. The old disclaimer is a claim about the app that is no longer true;
         the new one must be equally precise about the limitation that IS true. */
      ok("B4a · the paragraph no longer says this app cannot see sign-ins",
        !/cannot see sign-ins/i.test(strip.sub), strip.sub.slice(0, 400));
      ok("B4b · it names the two columns as two different questions",
        /two different questions/i.test(strip.sub) && /authentication service/i.test(strip.sub), strip.sub.slice(0, 400));
      ok("B4c · “Last active” is still, explicitly, not a sign-in", /it is not a sign-in/i.test(strip.sub), strip.sub.slice(0, 500));
      ok("B4d · …and a sign-in is still, explicitly, not work",
        /a sign-in is not work/i.test(strip.sub) && /signs in and only reads leaves no trace/i.test(strip.sub), strip.sub.slice(0, 600));
      ok("B4e · the automation exclusion — the panel's other standing promise — is untouched",
        /automation is excluded/i.test(strip.sub), strip.sub.slice(-400));

      /* B5 — A SIGN-IN IS NOT USAGE, proved on a row rather than asserted in prose: strip every
         audit row belonging to Daniel, who HAS signed in. His Last active must read `never` while
         his Signed in still reads a date — the exact pair the panel could not distinguish before,
         and the pair whose title must not blame him for it. */
      await page.evaluate(() => {
        /* p4 signed in and did nothing; p1 never signed in and did nothing. Two rows that read
           identically before R82 and must now read — and explain themselves — differently. */
        window.__mock.db.audit_log = window.__mock.db.audit_log.filter((r) => r.actor !== "p4" && r.actor !== "p1");
      });
      await goPage(page, "dashboard", 1200);
      await goPage(page, "reports", 4200);
      const s2 = await readStrip(page);
      const d2 = s2.rows.filter((r) => r.id === "p4")[0];
      eq("B5a · a colleague who signed in and changed nothing reads `never` active beside a sign-in date",
        [d2.lastText, d2.signin], ["never", "yes"]);
      ok("B5b · …and the Last active title says they have been in, rather than implying they never came",
        /They have signed in/.test(d2.lastTitle), d2.lastTitle);
      const k2 = s2.rows.filter((r) => r.id === "p1")[0];
      ok("B5c · a colleague who never signed in gets the OTHER sentence — nothing to explain",
        /never signed in either/.test(k2.lastTitle), k2.lastTitle);

      ok("B6 · no console errors (§B)", realErrs(page).length === 0, JSON.stringify(realErrs(page)));
      await page.__ctx.close();
    }

    /* =====================================================================
       §C · B3 — THE FALLBACK. Never let a failed read make a colleague look
       inactive: that is a claim about a person.
       ===================================================================== */
    console.log("\n— §C · B3 · a missing / broken RPC falls back to today's behaviour and today's wording");
    {
      /* C1 — THE RPC IS ABSENT. Pre-load seed, so it is missing from the very first read, exactly
         as it is on a database that never took it. */
      const page = await boot(browser, "p4", () => { window.__mockMigrations = { m12: false }; });
      await seedProduction(page);   // …and the seed makes no difference, because nothing can read it
      await goPage(page, "reports", 4200);
      const strip = await readStrip(page);
      ok("C1a · the panel still renders in full", !!strip && strip.rows.length > 0, JSON.stringify(strip && strip.cols));
      eq("C1b · the Signed in column exists but says nothing about anybody",
        [...new Set(strip.rows.map((r) => r.signin))], ["unknown"]);
      ok("C1c · …as the panel's own em dash, never a 0 and never the word `never`",
        strip.rows.every((r) => r.signinText === "—" && r.unknown && !r.never), JSON.stringify(strip.rows.map((r) => r.signinText)));
      ok("C1d · …and the cell says it is a failed question, not a finding about the person",
        strip.rows.every((r) => /failed question, not a finding/.test(r.signinTitle)), strip.rows[0].signinTitle);
      eq("C1e · NOBODY is flagged as never signed in — the seed said three, and the answer is silence", strip.dormantPill, null);
      ok("C1f · the paragraph is today's honest wording again — the limitation is back, so the disclaimer is back",
        /it is not a sign-in/i.test(strip.sub) && /could not be read just now/i.test(strip.sub), strip.sub.slice(0, 500));
      ok("C1g · …and it explains the em dashes rather than leaving them to be read as findings",
        /says nothing about anybody/i.test(strip.sub), strip.sub.slice(0, 500));
      ok("C1h · the three columns the panel had before R82 are unchanged",
        JSON.stringify(strip.cols.slice(3)) === JSON.stringify(["Last active", "Cases touched (30d)", "Overdue tasks"])
        && strip.rows.every((r) => r.touched !== null && r.overdue !== null), JSON.stringify(strip.cols));
      ok("C1i · no console errors — a missing RPC is a quiet fallback, not an error",
        realErrs(page).length === 0, JSON.stringify(realErrs(page)));
      await page.__ctx.close();
    }
    {
      /* C2 — AN UNRECOGNISED SHAPE. The RPC exists and answers 200, with something this code does
         not understand. Same answer: we do not know. Shimmed in-page, because no database can be
         made to return the wrong shape and the point is that the CONSUMER is defensive. */
      const page = await boot(browser, "p4");
      await seedProduction(page);
      await page.evaluate(() => {
        const real = window.db.rpc.bind(window.db);
        window.db.rpc = function (name, args) {
          if (name === "get_staff_activity") return Promise.resolve({ data: { rows: "nope" }, error: null });
          return real(name, args);
        };
      });
      await goPage(page, "reports", 4200);
      const s = await readStrip(page);
      eq("C2a · an object where an array was promised is 'we do not know', not a crash",
        [...new Set(s.rows.map((r) => r.signin))], ["unknown"]);
      eq("C2b · …so nobody is flagged", s.dormantPill, null);
      ok("C2c · …and the fallback wording is back with it", /could not be read just now/i.test(s.sub), s.sub.slice(0, 300));
      ok("C2d · no console errors", realErrs(page).length === 0, JSON.stringify(realErrs(page)));
      await page.__ctx.close();
    }
    {
      /* C3 — A TRANSPORT FAILURE. The read rejects outright. */
      const page = await boot(browser, "p4");
      await page.evaluate(() => {
        const real = window.db.rpc.bind(window.db);
        window.db.rpc = function (name, args) {
          if (name === "get_staff_activity") return Promise.reject(new Error("network is down"));
          return real(name, args);
        };
      });
      await goPage(page, "reports", 4200);
      const s = await readStrip(page);
      ok("C3a · a rejected read is caught and answered as 'we do not know'",
        !!s && s.rows.length > 0 && s.rows.every((r) => r.signin === "unknown"), JSON.stringify(s && s.rows.map((r) => r.signin)));
      ok("C3b · …and the rest of the panel is unharmed (the two reads it always had still rendered)",
        s.rows.every((r) => r.last !== null && r.touched !== null), JSON.stringify(s.rows[0]));
      ok("C3c · no console errors", realErrs(page).length === 0, JSON.stringify(realErrs(page)));
      await page.__ctx.close();
    }

    /* =====================================================================
       §D · B4 — v20's SEND-TIME FINANCIAL-PROMOTIONS REFUSAL, in the mock
       ===================================================================== */
    console.log("\n— §D · B4 · the mock's process-emails mirrors v20's refusal (p1 Kim)");
    {
      const page = await boot(browser, "p1");
      /* An unscoped run needs the hold off and the server key present — v19's two gates sit above
         everything v20 does, and this section is about what happens BELOW them. */
      await setSetting(page, "email_hold", "off");
      await page.evaluate(() => window.__mock.setResendKey(true));

      const fixture = await page.evaluate(async () => ({
        promos: (await window.__mockDb.from("settings").select("value").eq("key", "financial_promotions_approved").maybeSingle()).data,
      }));
      eq("D0 · the fixture matches production: financial promotions are NOT approved", fixture.promos && fixture.promos.value, "off");

      /* One queued row per gated type, plus a servicing email that must be untouched by all this,
         all on a client with an email and no opt-out so nothing else in the loop can claim them. */
      const seeded = await page.evaluate(async () => {
        const db = window.__mockDb;
        const cl = ((await db.from("clients").select("id,email,comms_optout").order("id")).data || [])
          .filter((c) => c.email && !c.comms_optout)[0];
        const mk = async (type, to) => (await db.from("email_queue").insert({
          client_id: cl.id, email_type: type, to_email: to === undefined ? cl.email : to, status: "queued",
          scheduled_for: new Date(Date.now() - 86400000).toISOString(),
        }).select("id").single()).data.id;
        return {
          client: cl.id,
          referral: await mk("referral_request"),
          protection: await mk("protection_offer"),
          gi: await mk("gi_exchange"),
          servicing: await mk("rate_end_reminder"),
          noAddress: await mk("protection_offer", null),
        };
      });
      const run1 = await page.evaluate(async () => (await window.__mockDb.functions.invoke("process-emails", { body: {} })).data);
      const after1 = await page.evaluate(async (s) => {
        const db = window.__mockDb;
        const row = async (id) => (await db.from("email_queue").select("status,error").eq("id", id).single()).data;
        const last = window.__mock.lastEmailRun();
        return {
          referral: await row(s.referral), protection: await row(s.protection), gi: await row(s.gi),
          servicing: await row(s.servicing), noAddress: await row(s.noAddress),
          composedIds: (last.composed || []).map((c) => c.queue_id),
          lastPromos: last.skipped_promos,
        };
      }, seeded);

      const WANT = "financial promotions not approved (settings.financial_promotions_approved)";
      eq("D1a · a referral_request is CANCELLED with v20's exact error string",
        [after1.referral.status, after1.referral.error], ["cancelled", WANT]);
      eq("D1b · a protection_offer, the same", [after1.protection.status, after1.protection.error], ["cancelled", WANT]);
      eq("D1c · a gi_exchange, the same — all three FIN_PROMO_TYPES, not just the one the RPC gated",
        [after1.gi.status, after1.gi.error], ["cancelled", WANT]);
      ok("D1d · CANCELLED, not failed and not left queued: a failure invites a retry and a queued row invites a release",
        ["cancelled"].includes(after1.referral.status) && after1.referral.status !== "failed", after1.referral.status);
      ok("D1e · nothing was composed for any of them — the refusal happens before compose(), so no template is touched",
        !after1.composedIds.includes(seeded.referral) && !after1.composedIds.includes(seeded.protection)
        && !after1.composedIds.includes(seeded.gi), JSON.stringify(after1.composedIds));
      ok("D2a · the run counts them as results.skipped_promos, beside v19's skipped_optout",
        run1 && run1.skipped_promos >= 3 && typeof run1.skipped_optout === "number",
        JSON.stringify({ promos: run1 && run1.skipped_promos, optout: run1 && run1.skipped_optout }));
      ok("D2b · …and __mock.lastEmailRun() testifies to the same number", after1.lastPromos >= 3, JSON.stringify(after1.lastPromos));
      eq("D3a · a servicing email in the SAME run is untouched — this list is not MARKETING_TYPES",
        after1.servicing.status, "sent");
      eq("D3b · the gate keeps v20's POSITION in the order: a promo with no recipient FAILS on the address first",
        [after1.noAddress.status, /No recipient address/.test(after1.noAddress.error || "")], ["failed", true]);

      /* D4 — approve them, and the same row type goes through. The gate is a gate, not a ban. */
      await setSetting(page, "financial_promotions_approved", "on");
      const seeded2 = await page.evaluate(async (c) => {
        const db = window.__mockDb;
        const cl = (await db.from("clients").select("id,email").eq("id", c).single()).data;
        return (await db.from("email_queue").insert({
          client_id: cl.id, email_type: "protection_offer", to_email: cl.email, status: "queued",
          scheduled_for: new Date(Date.now() - 86400000).toISOString(),
        }).select("id").single()).data.id;
      }, seeded.client);
      const run2 = await page.evaluate(async () => (await window.__mockDb.functions.invoke("process-emails", { body: {} })).data);
      const after2 = await page.evaluate(async (id) =>
        (await window.__mockDb.from("email_queue").select("status,error").eq("id", id).single()).data, seeded2);
      eq("D4a · with the switch ON the protection intro sends", after2.status, "sent");
      eq("D4b · …and nothing is counted as a refusal", run2 && run2.skipped_promos, 0);

      /* D5 — FAIL-CLOSED. The settings row is deleted entirely, which is the state a database that
         never took the setting is in. v20 defaults to "off" (?? "off"), not to "approved". */
      await setSetting(page, "financial_promotions_approved", null);
      const seeded3 = await page.evaluate(async (c) => {
        const db = window.__mockDb;
        const cl = (await db.from("clients").select("id,email").eq("id", c).single()).data;
        return (await db.from("email_queue").insert({
          client_id: cl.id, email_type: "referral_request", to_email: cl.email, status: "queued",
          scheduled_for: new Date(Date.now() - 86400000).toISOString(),
        }).select("id").single()).data.id;
      }, seeded.client);
      const run3 = await page.evaluate(async () => (await window.__mockDb.functions.invoke("process-emails", { body: {} })).data);
      const after3 = await page.evaluate(async (id) =>
        (await window.__mockDb.from("email_queue").select("status,error").eq("id", id).single()).data, seeded3);
      eq("D5a · an ABSENT settings row is fail-closed — the refusal stands", [after3.status, after3.error], ["cancelled", WANT]);
      ok("D5b · …and is counted", run3 && run3.skipped_promos >= 1, JSON.stringify(run3 && run3.skipped_promos));

      /* D6 — ORDER against v19. referral_request is in BOTH lists; an opted-out client's row must
         take v19's opt-out cancel, because that gate comes first in the deployed function. */
      const seeded4 = await page.evaluate(async () => {
        const db = window.__mockDb;
        const cl = ((await db.from("clients").select("id,email,comms_optout").order("id")).data || [])
          .filter((c) => c.email && c.comms_optout)[0];
        if (!cl) return null;
        return (await db.from("email_queue").insert({
          client_id: cl.id, email_type: "referral_request", to_email: cl.email, status: "queued",
          scheduled_for: new Date(Date.now() - 86400000).toISOString(),
        }).select("id").single()).data.id;
      });
      if (seeded4) {
        await page.evaluate(async () => { await window.__mockDb.functions.invoke("process-emails", { body: {} }); });
        const after4 = await page.evaluate(async (id) =>
          (await window.__mockDb.from("email_queue").select("status,error").eq("id", id).single()).data, seeded4);
        eq("D6 · a type in BOTH lists takes v19's opt-out cancel first — v20 sits below it, as deployed",
          [after4.status, after4.error], ["cancelled", "client opted out of these emails"]);
      } else {
        ok("D6 · a type in BOTH lists takes v19's opt-out cancel first", false, "no opted-out client with an email in the fixture");
      }

      ok("D7 · no console errors (§D)", realErrs(page).length === 0, JSON.stringify(realErrs(page)));
      await page.__ctx.close();
    }
  } finally {
    await browser.close();
    if (srv) srv.kill();
  }
  console.log(`\nR82_MOCK: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
