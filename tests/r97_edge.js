// tests/r97_edge.js — R97 · E: process-emails v23 (E-1 session_ok + full-run roles, E-2 care/opt-out at send
// time, E-3 stale cutoff 7 days, E-4 custom body re-escaped + recipient is the client).
//
//   §A  static: one process-emails source (v23), the mock gates it with session_ok, the cron branch kept
//   §B  mock (admin/mock.html): owner at aal1 → 403 "second factor required"; owner at aal2 runs
//   §C  the REAL v23 handler transpiled and run in Node with Deno + fetch + supabase-js stubbed
//       (the tests/r95_unsub.js loadV4 technique, with a chainable in-memory query builder):
//         C1 roles/MFA · C2 cron response shape · C3 care flag · C4 stale · C5 custom body / recipient
//   Every date is computed from Date.now() at run time.
//
// Run:  node /root/nx/tests/r97_edge.js
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

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
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");

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

/* ------------------------------------------------------------------ §C harness */
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const ago = (days) => iso(Date.now() - days * DAY);

// The v22 cron-path response keys, in order (R95 · A). v23 may only APPEND to these.
const V22_KEYS = ["queued", "comms", "sent", "failed", "scoped", "skipped_optout", "skipped_promos", "requeued"];

let V23_JS = null;
function v23js() {
  if (V23_JS) return V23_JS;
  const src = read("edge/process-emails-v23.ts").replace(/^import \{ createClient \} from "jsr:@supabase\/supabase-js@2";$/m, "const { createClient } = __stub;");
  V23_JS = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return V23_JS;
}

/* A tiny PostgREST-shaped store. Supports exactly what v23 calls: select (incl. count/head and the
   "*, cases(*), clients(*), leads(*)" embed on update…select), eq/in/lt/lte/is/order/limit,
   maybeSingle/single, update/insert/upsert, rpc, and the user client's auth.getUser + rpc("session_ok"). */
const USERS = {
  "tok-owner": { id: "u-owner", aal2: true },
  "tok-owner-aal1": { id: "u-owner", aal2: false },
  "tok-admin": { id: "u-admin", aal2: true },
  "tok-adviser": { id: "u-adv", aal2: true },
};
function makeState(o) {
  const st = {
    settings: [
      { key: "email_hold", value: "off" }, { key: "cron_key", value: "ck-test" },
      { key: "site_url", value: "https://www.nexmoney.co.uk" }, { key: "from_email", value: "NexMoney <hello@nexmoney.co.uk>" },
      { key: "company_name", value: "NexMoney" },
    ],
    profiles: [
      { id: "u-owner", role: "owner", full_name: "Owner Person", email: "owner@nexmoney.co.uk", phone: null, email_signoff: null },
      { id: "u-admin", role: "admin", full_name: "Admin Person", email: "admin@nexmoney.co.uk", phone: null, email_signoff: null },
      { id: "u-adv", role: "adviser", full_name: "Adviser Person", email: "adviser@nexmoney.co.uk", phone: null, email_signoff: null },
    ],
    clients: [], cases: [], leads: [], email_queue: [], case_documents: [], fact_finds: [],
    rpcs: [], fetches: [],
  };
  return Object.assign(st, o || {});
}
let seq = 0;
function addRow(st, o) {
  const n = ++seq;
  const cl = Object.assign({ id: `cl-${n}`, first_name: "Test", last_name: `Client${n}`, email: `client${n}@example.com`, comms_token: `tok-${n}`,
    suppress_automation: false, comms_optout: false, marketing_opt_out: false }, o.client || {});
  const cs = Object.assign({ id: `case-${n}`, client_id: cl.id, assigned_to: "u-adv", lender: "Nationwide", rate_type: "fixed", rate_percent: 4.1,
    rate_end_date: iso(Date.now() + 120 * DAY), property_address: "1 Test Road", broker_fee: 500, doc_token: null, nps_token: null }, o.case || {});
  const q = Object.assign({ id: `q-${n}`, case_id: cs.id, client_id: cl.id, lead_id: null, email_type: "rate_end_reminder", to_email: cl.email,
    subject: null, body_html: null, status: "queued", scheduled_for: ago(0.01), created_at: ago(1), claimed_at: null, error: null, attachment_path: null }, o.row || {});
  st.clients.push(cl); st.cases.push(cs); st.email_queue.push(q);
  return q;
}
function makeStub(st) {
  const tbl = (t) => (st[t] = st[t] || []);
  const join = (r, cols) => {
    const out = Object.assign({}, r);
    if (cols && /cases\(\*\)/.test(cols)) out.cases = tbl("cases").find((x) => x.id === r.case_id) || null;
    if (cols && /clients\(\*\)/.test(cols)) out.clients = tbl("clients").find((x) => x.id === r.client_id) || null;
    if (cols && /leads\(\*\)/.test(cols)) out.leads = tbl("leads").find((x) => x.id === r.lead_id) || null;
    if (out.cases) out.cases = Object.assign({}, out.cases);
    if (out.clients) out.clients = Object.assign({}, out.clients);
    return out;
  };
  function from(table) {
    const s = { op: "select", f: [], cols: "*", count: null, head: false, order: null, limit: null, after: null, single: false, payload: null };
    const api = {
      select(cols, opts) { if (s.op === "select") { s.cols = cols || "*"; if (opts) { s.count = opts.count || null; s.head = !!opts.head; } } else s.after = cols || "*"; return api; },
      eq(k, v) { s.f.push((r) => r[k] === v); return api; },
      in(k, vs) { s.f.push((r) => vs.includes(r[k])); return api; },
      lt(k, v) { s.f.push((r) => r[k] != null && r[k] < v); return api; },
      lte(k, v) { s.f.push((r) => r[k] != null && r[k] <= v); return api; },
      is(k, v) { s.f.push((r) => (r[k] ?? null) === v); return api; },
      order(k, o) { s.order = [k, !(o && o.ascending === false)]; return api; },
      limit(n) { s.limit = n; return api; },
      update(obj) { s.op = "update"; s.payload = obj; return api; },
      insert(obj) { s.op = "insert"; s.payload = obj; return api; },
      upsert(obj) { s.op = "upsert"; s.payload = obj; return api; },
      maybeSingle() { s.single = true; return api; },
      single() { s.single = true; return api; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    function run() {
      const rows = tbl(table);
      const hit = rows.filter((r) => s.f.every((fn) => fn(r)));
      if (s.op === "select") {
        let out = hit.slice();
        if (s.order) { const [k, asc] = s.order; out.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1)); }
        if (s.limit != null) out = out.slice(0, s.limit);
        if (s.head) return { data: null, count: out.length, error: null };
        const data = out.map((r) => join(r, s.cols));
        return { data: s.single ? (data[0] || null) : data, count: s.count ? out.length : null, error: null };
      }
      if (s.op === "update") {
        hit.forEach((r) => Object.assign(r, s.payload));
        const data = s.after ? hit.map((r) => join(r, s.after)) : null;
        return { data: s.single ? (data && data[0]) || null : data, error: null };
      }
      if (s.op === "insert") {
        const r = Object.assign({ id: `${table}-${++seq}`, token: `t-${seq}` }, s.payload); rows.push(r);
        return { data: s.single ? r : [r], error: null };
      }
      if (s.op === "upsert") {
        const ex = rows.find((r) => r.key === s.payload.key);
        if (ex) Object.assign(ex, s.payload); else rows.push(Object.assign({}, s.payload));
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return api;
  }
  return {
    createClient(_url, _key, opts) {
      const auth = opts && opts.global && opts.global.headers && opts.global.headers.Authorization;
      if (auth) {
        const u = USERS[String(auth).replace("Bearer ", "")];
        return {
          auth: { getUser: async () => ({ data: { user: u ? { id: u.id } : null } }) },
          rpc: async (name) => { st.rpcs.push("user:" + name); return name === "session_ok" ? { data: !!(u && u.aal2), error: null } : { data: null, error: { message: "nope" } }; },
          from,
        };
      }
      return {
        from,
        rpc: async (name) => { st.rpcs.push(name); return { data: { stub: name }, error: null }; },
        storage: { from: () => ({ download: async () => ({ data: null, error: { message: "no storage in stub" } }) }) },
      };
    },
  };
}
function loadV23(st) {
  let handler = null;
  const env = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "anon", RESEND_API_KEY: "re_test" };
  const Deno = { env: { get: (k) => env[k] }, serve: (fn) => { handler = fn; } };
  const fetchStub = async (url, init) => {
    st.fetches.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: "re_" + st.fetches.length }), { status: 200, headers: { "content-type": "application/json" } });
  };
  new Function("Deno", "__stub", "fetch", v23js())(Deno, makeStub(st), fetchStub);
  return handler;
}
async function call(st, { token, cron, body }) {
  const h = loadV23(st);
  const headers = { "content-type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cron) headers["x-cron-key"] = cron;
  const res = await h(new Request("https://stub.supabase.co/functions/v1/process-emails", { method: "POST", headers, body: body === undefined ? "" : JSON.stringify(body) }));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_e) { json = null; }
  return { status: res.status, json, text };
}
const rowOf = (st, id) => st.email_queue.find((q) => q.id === id);

/* The app's own customEmailBodyHtml() + esc(), lifted from the source so the round-trip test follows the app. */
function appCustomBody() {
  const core = read("admin/core.js").match(/^const esc = .*$/m)[0];
  const fn = read("admin/app.js").match(/^function customEmailBodyHtml\(text\) \{[\s\S]*?\n\}/m)[0];
  return new Function(`${core}\n${fn}\nreturn customEmailBodyHtml;`)();
}

(async () => {
  /* ================================================================== §A static */
  console.log("§A · static");
  const pe = fs.readdirSync(path.join(REPO, "edge")).filter((f) => /^process-emails-v\d+\.ts$/.test(f));
  eq("A1 · exactly one process-emails source in edge/, and it is v23", pe, ["process-emails-v23.ts"]);
  const v23 = read("edge/process-emails-v23.ts");
  ok("A2 · v23 calls session_ok through the caller's JWT and answers 403 'second factor required'",
    /await uc\.rpc\("session_ok"\)/.test(v23) && /\{ error: "second factor required" \}\), \{ status: 403/.test(v23));
  ok("A3 · cron branch unchanged: x-cron-key compared with settings.cron_key before any JWT work",
    /const cronKey = req\.headers\.get\("x-cron-key"\);\n  if \(cronKey\) \{\n    const \{ data \} = await supabase\.from\("settings"\)\.select\("value"\)\.eq\("key", "cron_key"\)\.maybeSingle\(\);\n    if \(data\?\.value && cronKey === data\.value\) return "cron";/.test(v23));
  ok("A4 · stale cutoff is 7 days (owner decision D5)", /const STALE_DAYS = 7;/.test(v23));
  const mock = read("admin/mock-supabase.js");
  const gated = (mock.match(/var MFA_GATED_EDGE = \[([\s\S]*?)\];/) || [])[1] || "";
  ok("A5 · mock MFA_GATED_EDGE lists process-emails", /"process-emails"/.test(gated), gated);

  /* ================================================================== §B mock */
  console.log("\n§B · mock: process-emails behind session_ok");
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {
    for (const leg of [{ aal: "aal1", want403: true }, { aal: "aal2", want403: false }]) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-GB", timezoneId: "Europe/London" });
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e)));
      if (leg.aal === "aal1") await page.addInitScript(() => { window.__mockMfa = { p4: { aal: "aal1" } }; });
      await page.goto(`${BASE}?as=p4`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__mockDb && window.__mockDb.functions, null, { timeout: 30000 });
      await page.waitForTimeout(1800);
      const r = await page.evaluate(async () => {
        const raw = await fetch("https://mock.supabase.co/functions/v1/process-emails", { method: "POST", body: JSON.stringify({ queue_ids: [] }) });
        return { status: raw.status, body: await raw.json() };
      });
      if (leg.want403) eq("B1 · owner at aal1 → process-emails 403 { error: 'second factor required' }", [r.status, r.body], [403, { error: "second factor required" }]);
      else ok("B2 · owner at aal2 → process-emails answers (no 403, no error)", r.status === 200 && !r.body.error, JSON.stringify(r));
      eq(`B · ${leg.aal}: no page errors`, errs, []);
      await ctx.close();
    }
  } finally {
    await browser.close();
    if (server) try { process.kill(-server.pid); } catch (_e) { /* ignore */ }
  }

  /* ================================================================== §C handler */
  console.log("\n§C1 · roles and the second factor");
  {
    let st = makeState(); addRow(st, {});
    let r = await call(st, { token: "tok-adviser", body: {} });
    eq("C1.1 · adviser, unscoped → 403", r.status, 403);
    ok("C1.1 · …and nothing ran: no queueing RPC, no heartbeat, no Resend call",
      !st.rpcs.includes("queue_automated_emails") && !st.settings.some((x) => x.key === "last_cron_run_at") && st.fetches.length === 0, JSON.stringify(st.rpcs));

    st = makeState(); let q = addRow(st, {});
    r = await call(st, { token: "tok-adviser", body: { queue_ids: [q.id] } });
    ok("C1.2 · adviser, scoped → proceeds: 200, the named row sent", r.status === 200 && r.json.sent === 1 && rowOf(st, q.id).status === "sent", r.text);

    st = makeState(); q = addRow(st, {});
    r = await call(st, { token: "tok-owner-aal1", body: {} });
    eq("C1.3 · owner at aal1, unscoped → 403 second factor required", [r.status, r.json], [403, { error: "second factor required" }]);
    r = await call(st, { token: "tok-owner-aal1", body: { queue_ids: [q.id] } });
    ok("C1.4 · owner at aal1, scoped → 403 too, row untouched", r.status === 403 && rowOf(st, q.id).status === "queued" && st.fetches.length === 0, r.text);

    st = makeState(); addRow(st, {});
    r = await call(st, { token: "tok-owner", body: {} });
    ok("C1.5 · owner at aal2, unscoped → full run (queueing RPCs + heartbeat + send)",
      r.status === 200 && st.rpcs.includes("queue_automated_emails") && st.rpcs.includes("queue_comms_extras") && st.settings.some((x) => x.key === "last_cron_run_at") && r.json.sent === 1, r.text);
    st = makeState(); addRow(st, {});
    r = await call(st, { token: "tok-admin" });
    ok("C1.6 · admin, empty body (unscoped) → full run", r.status === 200 && r.json.scoped === false && r.json.sent === 1, r.text);
    st = makeState();
    r = await call(st, { token: "tok-nobody", body: {} });
    eq("C1.7 · unknown JWT → 401 unauthorized", [r.status, r.json], [401, { error: "unauthorized" }]);
    r = await call(st, { cron: "wrong", body: {} });
    eq("C1.8 · wrong cron key, no JWT → 401", r.status, 401);
    ok("C1.9 · the cron path never asks session_ok", !st.rpcs.some((x) => x.startsWith("user:")), JSON.stringify(st.rpcs));
  }

  console.log("\n§C2 · cron path: same branch, response keys only appended");
  {
    let st = makeState(); addRow(st, {});
    let r = await call(st, { cron: "ck-test" });
    const keys = Object.keys(r.json);
    eq("C2.1 · cron run 200, keys = v22's then skipped_care, skipped_stale", [r.status, keys], [200, V22_KEYS.concat(["skipped_care", "skipped_stale"])]);
    ok("C2.2 · cron run sent the due row and stamped the heartbeat", r.json.sent === 1 && st.settings.some((x) => x.key === "last_cron_run_at"), r.text);
    st = makeState(); st.settings.find((x) => x.key === "email_hold").value = "on"; addRow(st, {});
    r = await call(st, { cron: "ck-test" });
    eq("C2.3 · held cron run keys = v22 keys + the two counters, then warning/held/pending", Object.keys(r.json),
      V22_KEYS.concat(["skipped_care", "skipped_stale", "warning", "held", "pending"]));
    ok("C2.4 · held: nothing cancelled for age or care while the hold is on", st.email_queue.every((q) => q.status === "queued") && st.fetches.length === 0);
  }

  console.log("\n§C3 · care flag (suppress_automation) and comms_optout at send time");
  {
    let st = makeState(); let q = addRow(st, { client: { suppress_automation: true } });
    let r = await call(st, { cron: "ck-test" });
    ok("C3.1 · care-flagged client, unscoped (cron) → cancelled, skipped_care 1, NO Resend call",
      rowOf(st, q.id).status === "cancelled" && rowOf(st, q.id).error === "client suppressed / opted out at send time" && r.json.skipped_care === 1 && st.fetches.length === 0, r.text);
    st = makeState(); q = addRow(st, { client: { suppress_automation: true } });
    r = await call(st, { token: "tok-owner", body: { queue_ids: [q.id] } });
    ok("C3.2 · same client, scoped → sends (a human pressed Send)", r.json.sent === 1 && st.fetches.length === 1 && rowOf(st, q.id).status === "sent", r.text);
    st = makeState(); q = addRow(st, { client: { comms_optout: true }, row: { email_type: "rate_end_chase" } });
    r = await call(st, { token: "tok-owner", body: {} });
    ok("C3.3 · comms_optout + rate_end_chase, unscoped → cancelled (care counter)", rowOf(st, q.id).status === "cancelled" && r.json.skipped_care === 1 && st.fetches.length === 0, r.text);
    st = makeState(); q = addRow(st, { client: { comms_optout: true }, row: { email_type: "birthday_greeting" } });
    r = await call(st, { cron: "ck-test" });
    ok("C3.4 · comms_optout + marketing type → the v19 rule unchanged (skipped_optout, its own error text)",
      rowOf(st, q.id).status === "cancelled" && rowOf(st, q.id).error === "client opted out of these emails" && r.json.skipped_optout === 1 && r.json.skipped_care === 0, r.text);
    st = makeState(); q = addRow(st, { client: { suppress_automation: true }, row: { email_type: "custom", subject: "Hello", body_html: "<p>Hi</p>" } });
    r = await call(st, { cron: "ck-test" });
    ok("C3.5 · custom is exempt: care-flagged client's custom row still sends unscoped", r.json.sent === 1 && r.json.skipped_care === 0, r.text);
    st = makeState(); q = addRow(st, {});
    const cl = st.clients.find((c) => c.id === q.client_id);
    // the joined row says no flag; the fresh re-read must win — flip it between claim and check via a getter
    let reads = 0;
    Object.defineProperty(cl, "suppress_automation", { enumerable: true, get() { reads++; return reads > 1; } });
    r = await call(st, { cron: "ck-test" });
    ok("C3.6 · flag set after the claim's join → the fresh re-read cancels it", rowOf(st, q.id).status === "cancelled" && st.fetches.length === 0, r.text);
  }

  console.log("\n§C4 · stale cutoff (7 days)");
  {
    let st = makeState();
    const old = addRow(st, { row: { scheduled_for: ago(8) } });
    const fresh = addRow(st, { row: { scheduled_for: ago(6) } });
    let r = await call(st, { cron: "ck-test" });
    ok("C4.1 · 8 days old → cancelled 'stale: scheduled more than 7 days ago'", rowOf(st, old.id).status === "cancelled" && rowOf(st, old.id).error === "stale: scheduled more than 7 days ago", JSON.stringify(rowOf(st, old.id)));
    ok("C4.2 · 6 days old → sent", rowOf(st, fresh.id).status === "sent", JSON.stringify(rowOf(st, fresh.id)));
    eq("C4.3 · counters: skipped_stale 1, sent 1, one Resend call (for the fresh row)", [r.json.skipped_stale, r.json.sent, st.fetches.length, st.fetches[0] && st.fetches[0].body.to[0]],
      [1, 1, 1, st.clients.find((c) => c.id === fresh.client_id).email]);
    st = makeState(); const old2 = addRow(st, { row: { scheduled_for: ago(8) } });
    r = await call(st, { token: "tok-owner", body: { queue_ids: [old2.id] } });
    ok("C4.4 · scoped send of an 8-day-old row → sent (scoped path unchanged)", rowOf(st, old2.id).status === "sent" && r.json.skipped_stale === 0, r.text);
    st = makeState(); const many = []; for (let i = 0; i < 55; i++) many.push(addRow(st, { row: { scheduled_for: ago(30 + i) } }));
    const due = addRow(st, { row: { scheduled_for: ago(1) } });
    r = await call(st, { cron: "ck-test" });
    ok("C4.5 · 55 stale rows do not crowd out the oldest-due-50 batch: all cancelled, the 1-day row sent",
      r.json.skipped_stale === 55 && rowOf(st, due.id).status === "sent" && many.every((q) => rowOf(st, q.id).status === "cancelled"), r.text);
  }

  console.log("\n§C5 · custom body and recipient");
  {
    const evil = `<p>Dear client &amp; family</p><p>line one<br>line two</p><a href="https://evil.example/pay">Pay here</a><img src=x onerror=alert(1)>`;
    let st = makeState(); let q = addRow(st, { row: { email_type: "custom", subject: "Action needed", body_html: evil } });
    let r = await call(st, { token: "tok-adviser", body: { queue_ids: [q.id] } });
    const html = st.fetches[0] ? st.fetches[0].body.html : "";
    ok("C5.1 · sent (scoped, adviser)", r.json.sent === 1, r.text);
    ok("C5.2 · <a href> arrives escaped, no live anchor to evil", html.includes("&lt;a href=&quot;https://evil.example/pay&quot;&gt;Pay here&lt;/a&gt;") && !/<a href="https:\/\/evil/.test(html), html.slice(0, 400));
    ok("C5.3 · <img onerror> arrives escaped, no <img in the payload", html.includes("&lt;img src=x onerror=alert(1)&gt;") && !/<img/i.test(html));
    ok("C5.4 · <p>, </p>, <br> kept as tags; the app's &amp; not double-escaped",
      html.includes("<p>Dear client &amp; family</p><p>line one<br>line two</p>") && !html.includes("&amp;amp;"));
    const appBody = appCustomBody()(`Hi Sam,\n\nRates: 4.1% & "fixed" — it's <ok>?\nNext line\n\nThanks`);
    st = makeState(); q = addRow(st, { row: { email_type: "custom", subject: "Rates", body_html: appBody } });
    r = await call(st, { token: "tok-owner", body: { queue_ids: [q.id] } });
    ok("C5.5 · a body written by the app's customEmailBodyHtml() reaches Resend byte-identical", st.fetches[0] && st.fetches[0].body.html.includes(appBody), appBody);
    st = makeState(); q = addRow(st, { row: { email_type: "custom", subject: "Hi", body_html: "<p>Hi</p>", to_email: "target@elsewhere.example" } });
    r = await call(st, { token: "tok-adviser", body: { queue_ids: [q.id] } });
    eq("C5.6 · foreign to_email → failed 'recipient is not the client's email', no Resend call", [rowOf(st, q.id).status, rowOf(st, q.id).error, st.fetches.length, r.json.failed],
      ["failed", "recipient is not the client's email", 0, 1]);
    st = makeState(); q = addRow(st, { row: { email_type: "custom", subject: "Hi", body_html: "<p>Hi</p>" } });
    rowOf(st, q.id).to_email = rowOf(st, q.id).to_email.toUpperCase();
    r = await call(st, { token: "tok-adviser", body: { queue_ids: [q.id] } });
    ok("C5.7 · same address in another case → sent (comparison is case-insensitive)", rowOf(st, q.id).status === "sent" && st.fetches.length === 1, r.text);
    st = makeState(); q = addRow(st, { row: { email_type: "rate_end_reminder", to_email: "other@elsewhere.example" } });
    r = await call(st, { token: "tok-owner", body: { queue_ids: [q.id] } });
    ok("C5.8 · the recipient rule is custom-only (a template row keeps its stored to_email)", rowOf(st, q.id).status === "sent", r.text);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
