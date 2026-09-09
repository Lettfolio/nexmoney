#!/usr/bin/env node
/* =============================================================================
   tests/r86_mfa.js — acceptance tests for R86 "Second factor": TOTP two-step
   sign-in for the back office.

   Contract under test: /root/nx/R86-DESIGN.md — session_ok() (db/r86/01) as
   mirrored by the mock's sessionOk() inside isStaff/isAdminOrOwner/isOwner and
   every RPC guard (db/r86/02), get_team_mfa (db/r86/03), the challenge and
   enrolment screens in the login card, the Settings "Security" card, and the
   mock's auth.mfa surface + hooks (`window.__mockMfa` pre-load seed,
   `__mock.setMfa`, `__mock.mfaState`).

     §A  CHALLENGE. Owner with a verified factor at aal1 (a restored session
         seeded at aal1, and the REAL sign-in path: sign out, sign in with the
         password form) → the challenge screen; a wrong code → the error stays
         on the screen; "000000" → the app boots; __errorLog 0.
     §B  ENROLMENT. Admin with NO factor → the enrolment screen: QR <img>
         (SVG data URI), the secret in <code>, no toast ever carries it; a
         wrong code errors; "000000" → the app boots, listFactors shows a
         verified factor, the mock's aal is aal2.
     §C  OPTIONAL ROLE. Adviser, no factor → straight in. Settings → Security
         offers "Set up authenticator"; enrol via the house overlay → status
         "on"; Remove asks for a code (refuses without one, refuses a wrong
         one); "000000" → removed, status "not set up".
     §D  THE SERVER GATE (mock RLS + RPC mirrors). An enforced role at aal1
         reads [] from cases, [] from get_briefing, {} from get_reports and a
         42501 from get_dashboard_counts / get_team_mfa; every one answers
         after the code is verified.
     §E  THE TEAM COLUMN. Owner → Settings shows who is on/off, matching
         get_team_mfa() / the fixture; Administrator sees it too; an adviser
         does not; with the RPC switched off (m14) the card says "not
         available" and nothing else breaks. Enforced roles have no Remove.
     §F  BREAK-GLASS. settings.mfa_enforced_roles = '' → an owner with no
         factor signs in straight to the app (the live read wins over the
         MFA_ENFORCED_ROLES mirror), and the mock's RLS lets the read through.
     §H  EDGE FUNCTIONS (R86 · V1). invite-user and send-sms (the mock's stubs for
         the seven gated functions) refuse an enforced persona at aal1 with
         { error: "second factor required" } 403 and answer at aal2.
     §I  RECOVERY WITH A FACTOR (R86 · V2). updateUser({password}) is refused at
         aal1 (insufficient_aal); showRecovery(session) challenges first, then
         paints the new-password card, and the save then succeeds.
     §J  STALE STORED FACTORS (R86 · V3). getAuthenticatorAssuranceLevel reports
         no factor (stale session) while listFactors shows one → the challenge
         still appears. Plus the server-truth gate (R86 · V4): session_ok()
         missing (m15 off) → straight in, exactly pre-R86; the enforced list
         widened to advisers → an adviser with no factor meets enrolment.
     §G  HYGIENE. No console/page errors on any screen; the login card never
         contains the secret after the enrol screen is left; the overlay is
         empty after enrolment; the sign-out link on the challenge screen
         works; the R76 signed-out strip still behaves; showRecovery still
         paints.

   Standing rules obeyed: ground truth from window.__mockDb / __mock at
   runtime; PLAYWRIGHT-AWAIT (poll, never sleep-and-hope alone).

   Run:  node /root/nx/tests/r86_mfa.js
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

const DESK = { width: 1400, height: 950 };

/* r78_fast's in-page instrumentation: every mock _run / rpc is counted so netSettle can wait
   for "nothing in flight", and logged by table/rpc name. */
const NET_INIT = `
  (() => {
    const NET = { pending: 0, waves: 0, calls: 0, active: false, lat: 40, installed: false, log: [] };
    window.__net = NET;
    const delay = (res) => new Promise((r) => setTimeout(() => { NET.pending--; r(res); }, NET.lat));
    const note = () => { if (NET.pending === 0) NET.waves++; NET.pending++; NET.calls++; };
    function install(client) {
      if (NET.installed || !client || typeof client.from !== "function") return;
      NET.installed = true;
      try {
        const proto = Object.getPrototypeOf(client.from("clients"));
        const origRun = proto._run;
        proto._run = function () {
          NET.log.push({ kind: "from", table: this._table, op: this._op || "select" });
          if (!NET.active) return origRun.apply(this, arguments);
          note();
          return origRun.apply(this, arguments).then(delay);
        };
      } catch (e) {}
      try {
        const origRpc = client.rpc.bind(client);
        client.rpc = function (name) {
          NET.log.push({ kind: "rpc", name });
          if (!NET.active) return origRpc.apply(null, arguments);
          note();
          return origRpc.apply(null, arguments).then(delay);
        };
      } catch (e) {}
    }
    Object.defineProperty(window, "db", {
      configurable: true,
      get() { return this.__dbReal; },
      set(v) { this.__dbReal = v; install(v); },
    });
  })();
`;

/* Boot a persona. `opts.mfa` is the pre-load seed (window.__mockMfa), applied before app.js
   runs — the only way to meet the challenge / enrolment screen on a RESTORED session. */
async function boot(browser, persona, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({ viewport: DESK });
  const page = await ctx.newPage();
  await page.addInitScript(NET_INIT);
  if (o.mfa) await page.addInitScript((seed) => { window.__mockMfa = seed; }, o.mfa);
  if (o.init) await page.addInitScript(o.init);
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  if (!o.keepTour) {
    await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
    await page.waitForTimeout(300);
  }
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const goPage = async (page, name, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await page.waitForTimeout(ms == null ? 1500 : ms);
};
/* Settle = nothing in flight AND the call counter has not moved for `quiet` ms. */
async function netSettle(page, quiet = 700, capMs = 20000) {
  const t0 = Date.now();
  let last = -1, lastAt = Date.now();
  for (;;) {
    const { pending, calls } = await page.evaluate(() => ({ pending: window.__net.pending, calls: window.__net.log.length }));
    if (calls !== last) { last = calls; lastAt = Date.now(); }
    if (pending === 0 && Date.now() - lastAt >= quiet) return;
    if (Date.now() - t0 > capMs) return;
    await page.waitForTimeout(80);
  }
}
/* Poll until `fn` (evaluated in-page) is truthy, or give up after capMs. Returns the value. */
async function until(page, fn, capMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() - t0 > capMs) return v;
    await page.waitForTimeout(100);
  }
}
const screen = (page) => page.evaluate(() => ({
  login: !document.querySelector("#login-view").classList.contains("hidden"),
  app: !document.querySelector("#app-view").classList.contains("hidden"),
  h1: (document.querySelector("#login-form h1") || {}).textContent || "",
  code: !!document.querySelector("#mfa-code"),
  email: !!document.querySelector("#login-email"),
  qr: !!document.querySelector("#login-form .mfa-qr img"),
  err: (() => { const e = document.querySelector("#login-error"); return e && !e.classList.contains("hidden") ? e.textContent : ""; })(),
  card: document.querySelector("#login-form").innerHTML,
  toast: (document.querySelector("#toast") || {}).textContent || "",
}));
/* Type a code into the login card's #mfa-code — the sixth digit auto-submits (wireMfaCodeInput). */
async function typeCode(page, sel, code) {
  await page.fill(sel, "");
  await page.type(sel, code, { delay: 15 });
  await page.waitForTimeout(600);
  await netSettle(page);
}
const page_screen = screen;
const errLog = (page) => page.evaluate(() => (window.__errorLog || []).length);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  try {
    /* =====================================================================
       §A · CHALLENGE — owner with a factor, at aal1
       ===================================================================== */
    console.log("\n— §A · CHALLENGE · p4 Daniel (owner, verified factor) at aal1 meets the code screen");
    {
      const page = await boot(browser, "p4", { mfa: { p4: { aal: "aal1" } } });
      ok("A0 · instrumentation installed", await page.evaluate(() => window.__net.installed === true));
      const seeded = await page.evaluate(() => window.__mock.mfaState("p4"));
      ok("A0 · pre-load seed took: p4 has a verified factor and sits at aal1", seeded.aal === "aal1" && seeded.factors.some((f) => f.status === "verified"), JSON.stringify(seeded));
      let s = await screen(page);
      ok("A1 · the CHALLENGE screen is up (login card, #mfa-code, app hidden)", s.login && !s.app && s.code && /two-step/i.test(s.h1), JSON.stringify({ login: s.login, app: s.app, code: s.code, h1: s.h1 }));
      ok("A1 · …with the 'Lost your authenticator? Ask Daniel' note and a Sign out link",
        /Lost your authenticator\? Ask Daniel/.test(s.card) && !!(await page.$("#mfa-signout")));
      const attrs = await page.evaluate(() => { const i = document.querySelector("#mfa-code"); return { im: i.getAttribute("inputmode"), ac: i.getAttribute("autocomplete"), pat: i.getAttribute("pattern"), focused: document.activeElement === i }; });
      eq("A1 · code input: inputmode=numeric autocomplete=one-time-code pattern=[0-9]{6}", [attrs.im, attrs.ac, attrs.pat], ["numeric", "one-time-code", "[0-9]{6}"]);
      ok("A1 · …and it has focus on load", attrs.focused === true);
      await typeCode(page, "#mfa-code", "123456");
      s = await screen(page);
      ok("A2 · a wrong code auto-submits on the 6th digit and the error stays ON the challenge screen", s.login && !s.app && s.code && /Invalid TOTP code entered/.test(s.err), JSON.stringify({ err: s.err, code: s.code, app: s.app }));
      eq("A2 · the wrong-code attempt did not read a single table (no data at aal1 is the point, but the screen doesn't even try)", (await page.evaluate(() => window.__net.log.filter((e) => e.kind === "from" && e.table === "cases").length)), 0);
      await typeCode(page, "#mfa-code", "000000");
      await until(page, () => !document.querySelector("#app-view").classList.contains("hidden"));
      await netSettle(page);
      s = await screen(page);
      ok("A3 · '000000' verifies: the app boots (Today painted)", s.app && !s.login && /Today/.test(await page.evaluate(() => document.querySelector("#today-heading").textContent)), JSON.stringify({ app: s.app, login: s.login }));
      eq("A3 · the mock's session is now aal2", (await page.evaluate(() => window.__mock.mfaState("p4").aal)), "aal2");
      eq("A3 · __errorLog is empty", await errLog(page), 0);
      eq("A3 · no console/page errors", realErrs(page), []);

      // The REAL sign-in path: sign out (no modal open → plain login screen), sign in with the password form.
      await page.evaluate(() => { window.__mockDb.auth.signOut(); });
      await page.waitForTimeout(700);
      s = await screen(page);
      ok("A4 · signing out restores the PASSWORD form in the card (no stale code screen)", s.login && s.email && !s.code, JSON.stringify({ login: s.login, email: s.email, code: s.code }));
      await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("profiles").select("email").eq("id", "p4").single();
        document.querySelector("#login-email").value = data.email;
        document.querySelector("#login-password").value = "anything-the-mock-accepts";
        document.querySelector("#login-form").requestSubmit();
      });
      await until(page, () => !!document.querySelector("#mfa-code"));
      s = await screen(page);
      ok("A5 · a fresh password sign-in lands at aal1 → the challenge screen again (the sign-in submit path goes through enterApp)", s.login && !s.app && s.code, JSON.stringify({ login: s.login, app: s.app, code: s.code }));
      eq("A5 · the mock dropped the session to aal1 on sign-in", (await page.evaluate(() => window.__mock.mfaState("p4").aal)), "aal1");
      await typeCode(page, "#mfa-code", "000000");
      await until(page, () => !document.querySelector("#app-view").classList.contains("hidden"));
      await netSettle(page);
      s = await screen(page);
      ok("A6 · …and the code opens the app", s.app && !s.login);
      eq("A6 · no console/page errors across the whole §A", realErrs(page), []);
      await page.context().close();
    }

    /* =====================================================================
       §B · ENROLMENT — admin with NO factor
       ===================================================================== */
    console.log("\n— §B · ENROLMENT · p1 Kim (admin, no factor) must enrol before anything else");
    {
      const page = await boot(browser, "p1", { mfa: { p1: { factors: [], aal: "aal1" } } });
      let s = await screen(page);
      ok("B1 · the ENROLMENT screen is up (QR img, code input, app hidden)", s.login && !s.app && s.qr && s.code && /Set up your authenticator/i.test(s.h1), JSON.stringify({ login: s.login, app: s.app, qr: s.qr, code: s.code, h1: s.h1 }));
      const qr = await page.evaluate(() => (document.querySelector("#login-form .mfa-qr img") || {}).getAttribute("src"));
      ok("B1 · the QR is the SVG data URI the auth API returned", /^data:image\/svg\+xml/.test(qr || ""), String(qr).slice(0, 40));
      const secret = await page.evaluate(() => (document.querySelector("#login-form code.mfa-secret") || {}).textContent);
      eq("B1 · the secret is shown in a <code> for manual entry", secret, "MOCKSECRET");
      ok("B1 · the word 'required' reasoning is on the screen (your role requires a second factor)", /requires a second factor/i.test(s.card));
      const st = await page.evaluate(() => window.__mock.mfaState("p1"));
      ok("B1 · the mock now holds ONE unverified factor for p1 (enrolled, not yet verified)", st.factors.length === 1 && st.factors[0].status === "unverified", JSON.stringify(st));
      ok("B1 · the toast never carried the secret", !/MOCKSECRET/.test(s.toast));
      await typeCode(page, "#mfa-code", "999999");
      s = await screen(page);
      ok("B2 · a wrong code errors and the enrol screen (QR + secret) stays", s.login && s.qr && /Invalid TOTP code entered/.test(s.err), JSON.stringify({ err: s.err, qr: s.qr }));
      await typeCode(page, "#mfa-code", "000000");
      await until(page, () => !document.querySelector("#app-view").classList.contains("hidden"));
      await netSettle(page);
      s = await screen(page);
      ok("B3 · '000000' turns it on and the app boots", s.app && !s.login);
      const lf = await page.evaluate(async () => { const r = await window.__mockDb.auth.mfa.listFactors(); return r.data; });
      ok("B3 · listFactors() shows the verified TOTP factor (totp = verified only; all carries it too)", lf && lf.totp.length === 1 && lf.totp[0].status === "verified" && lf.all.length === 1, JSON.stringify(lf));
      eq("B3 · the mock's session is aal2", (await page.evaluate(() => window.__mock.mfaState("p1").aal)), "aal2");
      ok("B3 · the login card no longer contains the secret", !/MOCKSECRET/.test(s.card));
      ok("B3 · …and no toast did either", !/MOCKSECRET/.test(s.toast));
      eq("B3 · __errorLog is empty", await errLog(page), 0);
      eq("B3 · no console/page errors", realErrs(page), []);
      await page.context().close();
    }

    /* =====================================================================
       §C · OPTIONAL ROLE — adviser enrols and removes from Settings
       ===================================================================== */
    console.log("\n— §C · OPTIONAL ROLE · p2 Wayne (adviser, no factor) boots straight in; Security card enrol/remove");
    {
      const page = await boot(browser, "p2");
      let s = await screen(page);
      ok("C1 · an adviser with no factor boots straight into the app", s.app && !s.login);
      await goPage(page, "settings", 1800);
      await netSettle(page);
      const card = await page.evaluate(() => ({
        panel: !document.querySelector("#security-panel").classList.contains("hidden"),
        status: (document.querySelector("#sec-mfa-status") || {}).textContent || "",
        enrol: !!document.querySelector("#sec-mfa-enrol"),
        remove: !!document.querySelector("#sec-mfa-remove"),
        team: document.querySelector("#security-team").classList.contains("hidden"),
      }));
      ok("C2 · Settings → Security card is visible for an adviser", card.panel);
      ok("C2 · status says 'not set up'", /not set up/i.test(card.status), card.status);
      ok("C2 · offers 'Set up authenticator' and no Remove", card.enrol && !card.remove, JSON.stringify(card));
      eq("C2 · the team column is hidden for an adviser", card.team, true);

      await page.click("#sec-mfa-enrol");
      await until(page, () => !!document.querySelector("#overlay-modal .mfa-qr img"));
      const ov = await page.evaluate(() => ({
        open: !document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        qr: (document.querySelector("#overlay-modal .mfa-qr img") || {}).getAttribute("src") || "",
        secret: (document.querySelector("#overlay-modal code.mfa-secret") || {}).textContent || "",
        code: !!document.querySelector("#ovl-mfa-code"),
        focused: document.activeElement && document.activeElement.id === "ovl-mfa-code",
      }));
      ok("C3 · the house overlay opens with the QR, the secret and the code input (focused)", ov.open && /^data:image\/svg\+xml/.test(ov.qr) && ov.secret === "MOCKSECRET" && ov.code && ov.focused, JSON.stringify({ open: ov.open, code: ov.code, focused: ov.focused }));
      await page.click("#ovl-mfa-ok");
      await page.waitForTimeout(300);
      ok("C3 · Turn on without a code refuses at the box", /6-digit/.test(await page.evaluate(() => document.querySelector("#ovl-mfa-err").textContent)));
      await typeCode(page, "#ovl-mfa-code", "000000");
      await until(page, () => document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      await netSettle(page);
      const on = await page.evaluate(() => ({
        closed: document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        ovEmpty: document.querySelector("#overlay-modal").innerHTML === "",
        status: (document.querySelector("#sec-mfa-status") || {}).textContent || "",
        enrol: !!document.querySelector("#sec-mfa-enrol"),
        remove: !!document.querySelector("#sec-mfa-remove"),
        toast: (document.querySelector("#toast") || {}).textContent || "",
        st: window.__mock.mfaState("p2"),
      }));
      ok("C4 · '000000' verifies: overlay closed and emptied, status 'on since <date>'", on.closed && on.ovEmpty && /\bon\b/.test(on.status) && /since \d{1,2} \w{3} \d{4}/.test(on.status), JSON.stringify({ closed: on.closed, ovEmpty: on.ovEmpty, status: on.status }));
      ok("C4 · the factor is verified in the mock and the card now offers Remove, not Set up", on.st.factors.length === 1 && on.st.factors[0].status === "verified" && on.remove && !on.enrol, JSON.stringify({ remove: on.remove, enrol: on.enrol, st: on.st }));
      ok("C4 · the confirmation toast never carries the secret", /Authenticator app is on/.test(on.toast) && !/MOCKSECRET/.test(on.toast), on.toast);

      // Remove — requires a fresh code.
      await page.click("#sec-mfa-remove");
      await until(page, () => !!document.querySelector("#ovl-mfa-code"));
      ok("C5 · Remove opens a code prompt (no QR, danger button)", await page.evaluate(() => !document.querySelector("#overlay-modal .mfa-qr") && !!document.querySelector("#ovl-mfa-ok.btn-danger-solid")));
      await page.click("#ovl-mfa-ok");
      await page.waitForTimeout(300);
      ok("C5 · Remove without a code refuses", /6-digit/.test(await page.evaluate(() => document.querySelector("#ovl-mfa-err").textContent)));
      eq("C5 · …and nothing was removed", (await page.evaluate(() => window.__mock.mfaState("p2").factors.length)), 1);
      await typeCode(page, "#ovl-mfa-code", "111111");
      ok("C5 · a wrong code refuses with the real error and the factor stays", await page.evaluate(() => /Invalid TOTP code entered/.test(document.querySelector("#ovl-mfa-err").textContent) && window.__mock.mfaState("p2").factors.length === 1));
      await typeCode(page, "#ovl-mfa-code", "000000");
      await until(page, () => document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      await netSettle(page);
      const off = await page.evaluate(() => ({
        status: (document.querySelector("#sec-mfa-status") || {}).textContent || "",
        enrol: !!document.querySelector("#sec-mfa-enrol"),
        remove: !!document.querySelector("#sec-mfa-remove"),
        st: window.__mock.mfaState("p2"),
        toast: (document.querySelector("#toast") || {}).textContent || "",
      }));
      ok("C6 · after removal: status 'not set up', Set up offered again, no factor in the mock", /not set up/i.test(off.status) && off.enrol && !off.remove && off.st.factors.length === 0, JSON.stringify(off));
      ok("C6 · the removal toast reads plainly", /Authenticator removed/.test(off.toast), off.toast);
      // A cancelled enrolment leaves nothing half-made behind.
      await page.click("#sec-mfa-enrol");
      await until(page, () => !!document.querySelector("#ovl-mfa-code"));
      eq("C7 · opening enrol creates one UNVERIFIED factor", (await page.evaluate(() => window.__mock.mfaState("p2").factors.map((f) => f.status))), ["unverified"]);
      await page.click("#ovl-mfa-cancel");
      await page.waitForTimeout(500);
      eq("C7 · cancelling unenrols it — nothing unverified left on the login", (await page.evaluate(() => window.__mock.mfaState("p2").factors.length)), 0);
      eq("C7 · __errorLog is empty", await errLog(page), 0);
      eq("§C · no console/page errors", realErrs(page), []);
      await page.context().close();
    }

    /* =====================================================================
       §D · THE SERVER GATE — the mock's RLS + RPC mirrors of session_ok()
       ===================================================================== */
    console.log("\n— §D · SERVER GATE · an enforced role at aal1 reads nothing; everything answers after the code");
    {
      const page = await boot(browser, "p4", { mfa: { p4: { aal: "aal1" } } });
      ok("D0 · on the challenge screen", (await screen(page)).code);
      const before = await page.evaluate(async () => {
        const db = window.__mockDb;
        const cases = await db.from("cases").select("id").limit(1);
        const clients = await db.from("clients").select("id").limit(1);
        const settings = await db.from("settings").select("key,value").eq("key", "mfa_enforced_roles").maybeSingle();
        const briefing = await db.rpc("get_briefing", { p_scope: "all" });
        const reports = await db.rpc("get_reports");
        const counts = await db.rpc("get_dashboard_counts");
        const team = await db.rpc("get_team_mfa");
        const role = await db.rpc("my_role");
        const bank = await db.rpc("has_bank_details");
        const prot = await db.rpc("get_protection_pipeline", { p_scope: "all" });
        const total = await db.rpc("get_protection_pipeline_total", { p_scope: "all" });
        const wt = await db.rpc("run_watchtower");
        const write = await db.from("case_notes").insert({ case_id: (window.__mock.db.cases[0] || {}).id, body: "should not land" });
        const signed = await db.storage.from("client-docs").createSignedUrl("anything.pdf", 60);   // R86 · V (P2) — storage policies are is_staff()-gated
        const listed = await db.storage.from("client-docs").list();
        const qa = await db.rpc("queue_automated_emails");   // R86 · V (P2)
        const qc = await db.rpc("queue_comms_extras");
        const sok = await db.rpc("session_ok");   // R86 · V4
        return {
          storage: { signed: signed.error && signed.error.statusCode, signedData: signed.data, listed: listed.error && listed.error.statusCode },
          queues: [qa.data, qc.data], sok: sok.data,
          cases: cases.data, clients: clients.data, settings: settings.data, briefing: briefing.data, reports: reports.data,
          counts: { code: counts.error && counts.error.code, data: counts.data },
          team: { code: team.error && team.error.code, data: team.data },
          role: role.data, bank: bank.data, prot: prot.data, total: total.data, wt: wt.data,
          write: { code: write.error && write.error.code },
        };
      });
      eq("D1 · db.from('cases').select('id').limit(1) → [] (RLS via is_staff() → session_ok())", before.cases, []);
      eq("D1 · clients → []", before.clients, []);
      eq("D1 · settings (the enforcement row itself) → hidden at aal1", before.settings, null);
      eq("D2 · get_briefing → '[]' (its own refusal shape)", before.briefing, []);
      eq("D2 · get_reports → '{}'", before.reports, {});
      eq("D2 · get_dashboard_counts → 42501", [before.counts.code, before.counts.data], ["42501", null]);
      eq("D2 · get_team_mfa → 42501", [before.team.code, before.team.data], ["42501", null]);
      eq("D2 · get_protection_pipeline → [] · _total → {total:0} · run_watchtower → {error:'forbidden'} · has_bank_details → false", [before.prot, before.total, before.wt, before.bank], [[], { total: 0 }, { error: "forbidden" }, false]);
      eq("D2 · my_role() is deliberately NOT gated — it answers 'owner' at aal1 (the app needs it to pick the screen)", before.role, "owner");
      eq("D3 · a write is refused (42501) at aal1", before.write.code, "42501");
      eq("D3 · storage: createSignedUrl / list are refused (403, no data) at aal1 — the objects policies are is_staff()-gated", [before.storage.signed, before.storage.signedData, before.storage.listed], ["403", null, "403"]);
      eq("D3 · queue_automated_emails / queue_comms_extras answer '{}' to a signed-in caller at aal1 (db/r86/02 P2 guard)", before.queues, [{}, {}]);
      eq("D3 · session_ok() itself answers false", before.sok, false);
      await typeCode(page, "#mfa-code", "000000");
      await until(page, () => !document.querySelector("#app-view").classList.contains("hidden"));
      await netSettle(page);
      const after = await page.evaluate(async () => {
        const db = window.__mockDb;
        const cases = await db.from("cases").select("id").limit(1);
        const counts = await db.rpc("get_dashboard_counts");
        const team = await db.rpc("get_team_mfa");
        const briefing = await db.rpc("get_briefing", { p_scope: "all" });
        const bank = await db.rpc("has_bank_details");
        const wt = await db.rpc("run_watchtower");
        const signed = await db.storage.from("client-docs").createSignedUrl("anything.pdf", 60);
        const sok = await db.rpc("session_ok");
        return { cases: (cases.data || []).length, counts: !!(counts.data && !counts.error), team: Array.isArray(team.data), briefing: Array.isArray(briefing.data) && briefing.data.length > 0, bank, wt: wt.data && typeof wt.data.open === "number", signed: !!(signed.data && !signed.error), sok: sok.data };
      });
      ok("D4 · after verifying: cases read answers a row; get_dashboard_counts, get_team_mfa, get_briefing, has_bank_details, run_watchtower all answer; storage signs; session_ok() true", after.cases === 1 && after.counts && after.team && after.briefing && after.wt && after.signed && after.sok === true, JSON.stringify(after));
      // readTableAs keeps its meaning: a colleague at aal2 reads; the SAME persona forced to aal1 does not.
      const ras = await page.evaluate(() => {
        const a = window.__mock.readTableAs("p1", "cases").length;
        window.__mock.setMfa("p1", { aal: "aal1" });
        const b = window.__mock.readTableAs("p1", "cases").length;
        window.__mock.setMfa("p1", { aal: "aal2" });
        const c = window.__mock.readTableAs("p2", "cases").length;   // adviser: optional role, aal1 is fine
        return { a, b, c };
      });
      ok("D5 · readTableAs mirrors session_ok(): p1 at aal2 reads, p1 at aal1 reads nothing, p2 (adviser, aal1) reads", ras.a > 0 && ras.b === 0 && ras.c > 0, JSON.stringify(ras));
      eq("§D · no console/page errors", realErrs(page), []);
      await page.context().close();
    }

    /* =====================================================================
       §E · THE TEAM COLUMN — get_team_mfa on the Owner's / Admin's card
       ===================================================================== */
    console.log("\n— §E · TEAM COLUMN · p4 Daniel sees who is on/off; p1 too; p2 not; m14 off → 'not available'");
    {
      const page = await boot(browser, "p4");
      await goPage(page, "settings", 1800);
      await netSettle(page);
      const truth = await page.evaluate(async () => (await window.__mockDb.rpc("get_team_mfa")).data);
      const fixture = await page.evaluate(() => window.__mock.db.profiles.filter((p) => ["owner", "admin", "adviser", "staff"].includes(p.role)).map((p) => ({ id: p.id, on: window.__mock.mfaState(p.id).factors.some((f) => f.status === "verified") })));
      ok("E0 · get_team_mfa() names every STAFF profile once (never the introducer), ordered by name", truth.length === fixture.length && fixture.every((f) => truth.some((t) => t.id === f.id)) && !truth.some((t) => t.role === "introducer")
        && truth.every((t, i, a) => i === 0 || a[i - 1].full_name.localeCompare(t.full_name) <= 0), JSON.stringify(truth));
      ok("E0 · mfa_on matches the fixture (p1 + p4 on, p2 + p3 off) and enrolled_at is set only when on", fixture.every((f) => { const t = truth.find((x) => x.id === f.id); return t.mfa_on === f.on && (!!t.enrolled_at) === f.on; })
        && truth.find((t) => t.id === "p4").mfa_on && truth.find((t) => t.id === "p1").mfa_on && !truth.find((t) => t.id === "p2").mfa_on, JSON.stringify(truth));
      ok("E0 · the RPC row never carries a secret or a factor id", !truth.some((t) => Object.keys(t).some((k) => /secret|factor/i.test(k))));
      const view = await page.evaluate(() => ({
        teamShown: !document.querySelector("#security-team").classList.contains("hidden"),
        rows: [...document.querySelectorAll("#sec-team-tbl tbody tr")].map((tr) => ({ id: tr.dataset.id, name: tr.children[0].textContent, on: tr.children[2].textContent.trim(), since: tr.children[3].textContent.trim() })),
        status: (document.querySelector("#sec-mfa-status") || {}).textContent || "",
        remove: !!document.querySelector("#sec-mfa-remove"),
        enforcedNote: (document.querySelector("#sec-mfa-enforced-note") || {}).textContent || "",
        summary: (document.querySelector("#security-team p") || {}).textContent || "",
      }));
      ok("E1 · the Owner's card shows the team table, one row per RPC entry", view.teamShown && view.rows.length === truth.length, JSON.stringify(view.rows));
      ok("E1 · on/off per row matches the RPC; 'Since' is a date only for those on", truth.every((t) => { const r = view.rows.find((x) => x.id === t.id); return r && r.on === (t.mfa_on ? "on" : "off") && (t.mfa_on ? /\d{4}/.test(r.since) : r.since === "—"); }), JSON.stringify(view.rows));
      ok("E1 · the summary counts them", /2 of \d+ logins have one/.test(view.summary), view.summary);
      ok("E2 · an ENFORCED role's own card: status on, NO Remove button, the dashboard-reset note instead", /\bon\b/.test(view.status) && !view.remove && /Supabase dashboard/.test(view.enforcedNote), JSON.stringify({ status: view.status, remove: view.remove }));
      // A wrong role never sees the column; an Administrator does.
      await page.context().close();
      const p1 = await boot(browser, "p1");
      await goPage(p1, "settings", 1800);
      await netSettle(p1);
      const adminView = await p1.evaluate(() => ({ shown: !document.querySelector("#security-team").classList.contains("hidden"), rows: document.querySelectorAll("#sec-team-tbl tbody tr").length, remove: !!document.querySelector("#sec-mfa-remove") }));
      ok("E3 · the Administrator sees the team column too (and, enforced, has no Remove)", adminView.shown && adminView.rows === truth.length && !adminView.remove, JSON.stringify(adminView));
      // The RPC missing (older database) → one honest line.
      await p1.evaluate(() => window.__mock.setMigrations({ m14: false }));
      await goPage(p1, "dashboard", 600);
      await goPage(p1, "settings", 1800);
      await netSettle(p1);
      const missing = await p1.evaluate(() => ({ note: (document.querySelector("#sec-team-note") || {}).textContent || "", tbl: !!document.querySelector("#sec-team-tbl"), status: (document.querySelector("#sec-mfa-status") || {}).textContent || "" }));
      ok("E4 · with get_team_mfa absent (m14 off) the card says 'not available' and the own-status line still paints", /isn’t available|not available/i.test(missing.note) && !missing.tbl && /\bon\b/.test(missing.status), JSON.stringify(missing));
      eq("E4 · __errorLog is empty (a missing RPC is a feature-detect, not a failure)", await errLog(p1), 0);
      eq("§E · no console/page errors", realErrs(p1), []);
      await p1.context().close();
    }

    /* =====================================================================
       §F · BREAK-GLASS — enforcement off
       ===================================================================== */
    console.log("\n— §F · BREAK-GLASS · mfa_enforced_roles = '' → an owner with no factor signs straight in");
    {
      const page = await boot(browser, "p4");
      await page.evaluate(() => {
        const row = window.__mock.db.settings.find((s) => s.key === "mfa_enforced_roles");
        row.value = "";
        window.__mock.setMfa("p4", { factors: [], aal: "aal1" });
      });
      const gate = await page.evaluate(async () => ({
        cases: (await window.__mockDb.from("cases").select("id").limit(1)).data.length,
        counts: !!(await window.__mockDb.rpc("get_dashboard_counts")).data,
        st: window.__mock.mfaState("p4"),
      }));
      ok("F1 · with enforcement off the mock's session_ok() is true at aal1 with no factor: reads and RPCs answer", gate.cases === 1 && gate.counts && gate.st.aal === "aal1" && gate.st.factors.length === 0, JSON.stringify(gate));
      await page.evaluate(() => { window.__mockDb.auth.signOut(); });
      await page.waitForTimeout(700);
      await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("profiles").select("email").eq("id", "p4").single();
        document.querySelector("#login-email").value = data.email;
        document.querySelector("#login-password").value = "anything-the-mock-accepts";
        document.querySelector("#login-form").requestSubmit();
      });
      await until(page, () => !document.querySelector("#app-view").classList.contains("hidden"));
      await netSettle(page);
      const s = await screen(page);
      ok("F2 · the owner signs in STRAIGHT to the app — no enrolment screen (the live settings read beats the MFA_ENFORCED_ROLES mirror)", s.app && !s.login && !s.qr, JSON.stringify({ app: s.app, login: s.login, qr: s.qr }));
      await goPage(page, "settings", 1800);
      await netSettle(page);
      const card = await page.evaluate(() => ({ status: (document.querySelector("#sec-mfa-status") || {}).textContent || "", enrol: !!document.querySelector("#sec-mfa-enrol"), note: (document.querySelector("#security-mfa .sec-note") || {}).textContent || "" }));
      ok("F3 · the Security card offers Set up and says enforcement is currently off for their role", /not set up/.test(card.status) && card.enrol && /switched off/.test(card.note), JSON.stringify(card));
      eq("§F · no console/page errors", realErrs(page), []);
      await page.context().close();

      // R86 · V4 — the list WIDENED on the server (advisers enforced): an adviser with no factor meets
      // the enrolment screen although the client's MFA_ENFORCED_ROLES mirror says advisers are optional.
      const adv = await boot(browser, "p2", { init: "window.__mockSettingsPatch = { mfa_enforced_roles: 'owner, Admin ,adviser' };" });
      const widened = await page_screen(adv);
      ok("F4 · server list widened to advisers (' Admin ,adviser' — trimmed, case-folded) → p2 with no factor meets ENROLMENT, not the app", widened.login && !widened.app && widened.qr && widened.code, JSON.stringify({ login: widened.login, app: widened.app, qr: widened.qr }));
      eq("F4 · …because session_ok() said false for them", await adv.evaluate(async () => (await window.__mockDb.rpc("session_ok")).data), false);
      await typeCode(adv, "#mfa-code", "000000");
      await until(adv, () => !document.querySelector("#app-view").classList.contains("hidden"));
      ok("F4 · …and the code opens the app", (await page_screen(adv)).app);
      eq("§F4 · no console/page errors", realErrs(adv), []);
      await adv.context().close();
    }

    /* =====================================================================
       §H · EDGE FUNCTIONS — the seven signed-in functions require session_ok()
       ===================================================================== */
    console.log("\n— §H · EDGE FUNCTIONS · invite-user / send-sms refuse at aal1 (403 second factor required), answer at aal2");
    {
      const page = await boot(browser, "p4", { mfa: { p4: { aal: "aal1" } } });
      ok("H0 · on the challenge screen", (await screen(page)).code);
      const before = await page.evaluate(async () => {
        const r1 = await window.__mockDb.functions.invoke("invite-user", { body: { email: "new.adviser@example.com", full_name: "New Adviser", role: "adviser" } });
        const r2 = await window.__mockDb.functions.invoke("send-sms", { body: {} });
        const r3 = await window.__mockDb.functions.invoke("assistant", { body: { messages: [{ role: "user", content: "hi" }] } });
        const raw = await fetch("https://mock.supabase.co/functions/v1/invite-user", { method: "POST", body: JSON.stringify({ email: "x@example.com", full_name: "X", role: "adviser" }) });
        return { r1: r1.data, r2: r2.data, r3: r3.data, status: raw.status, profiles: window.__mock.db.profiles.length };
      });
      eq("H1 · invite-user at aal1 → { error: 'second factor required' } (HTTP 403) — no login minted, no temp_password", [before.r1, before.status, "temp_password" in (before.r1 || {})], [{ error: "second factor required" }, 403, false]);
      eq("H1 · send-sms at aal1 → the same refusal", before.r2, { error: "second factor required" });
      eq("H1 · assistant at aal1 → the same refusal", before.r3, { error: "second factor required" });
      await typeCode(page, "#mfa-code", "000000");
      await until(page, () => !document.querySelector("#app-view").classList.contains("hidden"));
      await netSettle(page);
      const after = await page.evaluate(async (n) => {
        const r1 = await window.__mockDb.functions.invoke("invite-user", { body: { email: "new.adviser@example.com", full_name: "New Adviser", role: "adviser" } });
        const r2 = await window.__mockDb.functions.invoke("send-sms", { body: {} });
        return { ok1: r1.data && r1.data.ok === true && typeof r1.data.temp_password === "string", ok2: r2.data && r2.data.ok === true, profiles: window.__mock.db.profiles.length - n };
      }, before.profiles);
      ok("H2 · at aal2 invite-user mints the login (one profile added, temp_password returned) and send-sms runs", after.ok1 && after.ok2 && after.profiles === 1, JSON.stringify(after));
      eq("§H · no console/page errors", realErrs(page), []);
      await page.context().close();
    }

    /* =====================================================================
       §I · RECOVERY WITH A FACTOR — verify first, then the new-password card
       ===================================================================== */
    console.log("\n— §I · RECOVERY · a recovery session (aal1) with a verified factor is challenged before the new-password card");
    {
      const page = await boot(browser, "p1", { mfa: { p1: { aal: "aal1" } } });
      ok("I0 · p1 at aal1 with a factor (challenge screen)", (await screen(page)).code);
      const refused = await page.evaluate(async () => { const r = await window.__mockDb.auth.updateUser({ password: "New-Passw0rd!" }); return r.error; });
      eq("I1 · the mock refuses updateUser at aal1 with a factor (GoTrue insufficient_aal, 403)", [refused && refused.code, refused && refused.status], ["insufficient_aal", 403]);
      // The PASSWORD_RECOVERY event lands with the recovery session.
      await page.evaluate(async () => { const s = (await window.__mockDb.auth.getSession()).data.session; await showRecovery(s); });
      await page.waitForTimeout(500);
      let s = await screen(page);
      ok("I2 · showRecovery(session) paints the CHALLENGE first (recovery lead, no password field yet)", s.login && s.code && !s.email && /Before choosing a new password/.test(s.card) && !(await page.$("#new-pass")), JSON.stringify({ code: s.code, h1: s.h1 }));
      await typeCode(page, "#mfa-code", "000000");
      await until(page, () => !!document.querySelector("#new-pass"));
      s = await screen(page);
      ok("I3 · after the code: the 'Choose a new password' card, the app still hidden", !!(await page.$("#new-pass")) && /new password/i.test(s.h1) && !s.app, JSON.stringify({ h1: s.h1, app: s.app }));
      const saved = await page.evaluate(async () => { const r = await window.__mockDb.auth.updateUser({ password: "New-Passw0rd!" }); return { err: r.error, aal: window.__mock.mfaState("p1").aal }; });
      ok("I3 · …and updateUser now succeeds (session at aal2)", saved.err === null && saved.aal === "aal2", JSON.stringify(saved));
      eq("§I · no console/page errors", realErrs(page), []);
      await page.context().close();
      // No factor: straight to the card, as before R86.
      const p2 = await boot(browser, "p2");
      await p2.evaluate(async () => { const s = (await window.__mockDb.auth.getSession()).data.session; await showRecovery(s); });
      await p2.waitForTimeout(400);
      ok("I4 · a login with no factor goes straight to the new-password card", !!(await p2.$("#new-pass")) && !(await p2.$("#mfa-code")));
      await p2.context().close();
    }

    /* =====================================================================
       §J · STALE STORED FACTORS + the server-truth gate
       ===================================================================== */
    console.log("\n— §J · STALE FACTORS · aal call says no factor, listFactors says one → challenge; session_ok() missing → pre-R86");
    {
      const page = await boot(browser, "p4", { mfa: { p4: { aal: "aal1" } }, init: "window.__mockStale = { p4: true };" });
      const st = await page.evaluate(async () => { const a = (await window.__mockDb.auth.mfa.getAuthenticatorAssuranceLevel()).data; const l = (await window.__mockDb.auth.mfa.listFactors()).data; return { cur: a.currentLevel, next: a.nextLevel, verified: l.totp.length }; });
      ok("J0 · the stale seed: aal reports currentLevel aal1 / nextLevel aal1 (no factor) while listFactors shows the verified one", st.cur === "aal1" && st.next === "aal1" && st.verified === 1, JSON.stringify(st));
      const s = await screen(page);
      ok("J1 · the CHALLENGE still appears — the decision is made from listFactors, not the stored claim", s.login && s.code && !s.qr && !s.app, JSON.stringify({ code: s.code, qr: s.qr, app: s.app }));
      await typeCode(page, "#mfa-code", "000000");
      await until(page, () => !document.querySelector("#app-view").classList.contains("hidden"));
      ok("J1 · …and the code opens the app", (await screen(page)).app);
      eq("§J1 · no console/page errors", realErrs(page), []);
      await page.context().close();
      // session_ok() missing (a database without db/r86): exactly the pre-R86 behaviour — straight in.
      const old = await boot(browser, "p1", { mfa: { p1: { factors: [], aal: "aal1" } }, init: "window.__mockMigrations = { m15: false };" });
      const o = await screen(old);
      const missing = await old.evaluate(async () => { const r = await window.__mockDb.rpc("session_ok"); return r.error && r.error.code; });
      ok("J2 · with session_ok() absent (m15 off, 42883) an admin with no factor boots STRAIGHT IN — the pre-R86 behaviour, no enrol screen", missing === "42883" && o.app && !o.login, JSON.stringify({ missing, app: o.app, login: o.login }));
      eq("§J2 · no console/page errors", realErrs(old), []);
      await old.context().close();
    }

    /* =====================================================================
       §G · HYGIENE
       ===================================================================== */
    console.log("\n— §G · HYGIENE · secrets stay on the enrol screen; sign-out link; R76 strip; recovery still paints");
    {
      // Every default persona boots to the app with zero errors (the 89-suite promise).
      for (const p of ["p1", "p2", "p3", "p4"]) {
        const page = await boot(browser, p);
        const s = await screen(page);
        ok(`G1 · ${p} boots straight to the app on a restored session (aal per persona default)`, s.app && !s.login, JSON.stringify({ app: s.app, login: s.login }));
        eq(`G1 · ${p} no console/page errors`, realErrs(page), []);
        await page.context().close();
      }
      // Sign out from the challenge screen — a deliberate sign-out, so it reloads to a clean page.
      const page = await boot(browser, "p4", { mfa: { p4: { aal: "aal1" } } });
      ok("G2 · challenge screen up", (await screen(page)).code);
      await page.evaluate(() => { window.__r86Marker = 1; });
      await page.click("#mfa-signout");
      await page.waitForTimeout(2500);
      const afterSignout = await screen(page);
      const reloaded = await page.evaluate(() => window.__r86Marker === undefined);
      /* The page RELOADED (the in-page marker is gone — R79 · B6's deliberate-sign-out rule). The
         pre-load seed re-applies on the reload, so the restored session is at aal1 again and the
         fresh page is a fresh challenge screen — which is exactly a "clean page", not a stale one:
         the old card's handler and typed code are gone with the document. */
      ok("G2 · Sign out on the challenge screen reloads to a clean page (marker gone; the seeded restored session meets a FRESH challenge)", reloaded && afterSignout.login && !afterSignout.app && afterSignout.code, JSON.stringify({ reloaded, app: afterSignout.app, login: afterSignout.login, email: afterSignout.email, code: afterSignout.code }));
      eq("G2 · no console/page errors", realErrs(page), []);
      await page.context().close();
      // The enrol screen's secret never survives into the app; the R76 signed-out strip still works.
      const p1 = await boot(browser, "p1", { mfa: { p1: { factors: [], aal: "aal1" } } });
      ok("G3 · enrol screen shows the secret", /MOCKSECRET/.test((await screen(p1)).card));
      await typeCode(p1, "#mfa-code", "000000");
      await until(p1, () => !document.querySelector("#app-view").classList.contains("hidden"));
      await netSettle(p1);
      const g3 = await p1.evaluate(() => ({ card: document.querySelector("#login-form").innerHTML, body: document.body.innerHTML.includes("MOCKSECRET"), toast: (document.querySelector("#toast") || {}).textContent || "" }));
      ok("G3 · after leaving the enrol screen the login card — and the whole page — no longer contains the secret", !/MOCKSECRET/.test(g3.card) && !g3.body && !/MOCKSECRET/.test(g3.toast));
      // R76 · B4 — the strip over open work is unchanged.
      await goPage(p1, "pipeline", 1500);
      await p1.evaluate(async () => { const c = window.__mock.db.cases[0]; await window.openCase(c.id); });
      await p1.waitForTimeout(1200);
      await p1.evaluate(() => { window.__mockDb.auth.signOut(); });
      await p1.waitForTimeout(900);
      const strip = await p1.evaluate(() => ({ strip: !document.querySelector("#signedout-strip").classList.contains("hidden"), modal: !document.querySelector("#modal-backdrop").classList.contains("hidden"), login: !document.querySelector("#login-view").classList.contains("hidden"), email: !!document.querySelector("#login-email") }));
      ok("G4 · R76: a session lost over an open modal still shows the signed-out strip, keeps the modal, and the password form is underneath", strip.strip && strip.modal && strip.login && strip.email, JSON.stringify(strip));
      eq("G4 · no console/page errors", realErrs(p1), []);
      await p1.context().close();
      // showRecovery still paints (the recovery-password flow shares the card).
      const p2 = await boot(browser, "p2");
      await p2.evaluate(() => window.showRecovery ? window.showRecovery() : showRecovery());
      await p2.waitForTimeout(300);
      const rec = await p2.evaluate(() => ({ login: !document.querySelector("#login-view").classList.contains("hidden"), pass: !!document.querySelector("#new-pass"), h1: (document.querySelector("#login-form h1") || {}).textContent }));
      ok("G5 · showRecovery() still takes the card over (Choose a new password)", rec.login && rec.pass && /new password/i.test(rec.h1), JSON.stringify(rec));
      eq("G5 · no console/page errors", realErrs(p2), []);
      await p2.context().close();
    }
  } catch (e) {
    failures.push("UNCAUGHT: " + (e && e.stack || e));
    console.log("UNCAUGHT", e);
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (_) { /* already gone */ } }
  }

  console.log(`\nR86_MFA: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
