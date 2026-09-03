#!/usr/bin/env node
/* =============================================================================
   tests/r81_strict.js — R81 · B: STRICT COLUMN MODE in admin/mock-supabase.js.

   The R79 code-health panel confirmed the harness's one big blind spot: the
   mock throws on an unknown TABLE (42P01) and an unknown RPC (42883), but a
   typo'd COLUMN NAME sailed straight through — a ghost select column returned
   undefined fields, a ghost filter matched nothing, a ghost insert/update key
   stored happily — while production PostgREST fails all of these with 42703.

   R81 adds a per-table COLUMN REGISTRY (union of every seeded fixture row's
   keys + STRICT_EXTRA_COLUMNS for sparse/empty tables, snapshotted eagerly at
   load) and enforces it on every path: select strings (embeds recursed,
   aliases/casts/JSON paths handled), every filter/order column (.or() strings
   included), insert/update/upsert payload keys (and onConflict), and rpc arg
   names per known RPC. On violation the mock THROWS, synchronously:

     MOCK STRICT: unknown column '<t>.<c>' — prod would 42703 (add it to the
     registry if prod really has it)

   `window.__mockStrict = false` disables enforcement (default TRUE). There is
   deliberately NO per-call allowlist — fix the caller or the registry.

   §A — defaults + registry coverage: strict is ON out of the box, and the
        registry covers every DB table (plus v_alerts), spot-checked for the
        hand-listed prod columns fixtures never seed.
   §B — ghost SELECT columns throw the named message; "*", aliases, casts and
        count/head selects stay legal.
   §C — ghost FILTER / ORDER / .or() columns throw; real ones don't.
   §D — ghost INSERT / UPDATE / UPSERT keys throw; a migration-disabled column
        stays a returned 42703 {error} (feature-detect parity), never a throw.
   §E — embed inner-column validation, at depth, hints included; an unknown
        embed table is refused too.
   §F — rpc arg names: a typo'd arg throws; an unknown FUNCTION is still the
        42883 {error} the app feature-detects on.
   §G — the escape hatch: __mockStrict=false restores the old lenient mock
        (ghost select silent, ghost insert stored), true restores enforcement.
   §H — no console errors.

   Run:  node /root/nx/tests/r81_strict.js   (expects a static server on 8099;
         spawns one if none is listening)
   ========================================================================== */
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;

let pass = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (n, a, e) => ok(n, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false)); r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}
/* run fn(db) inside the page and report {threw, message} — strict violations
   are SYNCHRONOUS throws, so a try/catch around the builder call catches them */
const attempt = (page, body) => page.evaluate(async (src) => {
  const db = window.__mockDb;
  try {
    const fn = new Function("db", `return (async () => { ${src} })();`);
    const out = await fn(db);
    return { threw: false, out: out === undefined ? null : out };
  } catch (e) { return { threw: true, message: String(e && e.message || e) }; }
}, body);
const STRICT_RE = /^MOCK STRICT: unknown column '([a-z_]+\.[A-Za-z_]+)' — prod would 42703 \(add it to the registry if prod really has it\)$/;

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on("dialog", async (d) => { await d.accept(); });
    page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
    page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
    await page.goto(`${BASE}?as=p1`);
    await page.waitForTimeout(1800);

    /* ===================================================================
       A · DEFAULTS + REGISTRY COVERAGE
       =================================================================== */
    console.log("\n— A · strict is the default and the registry covers the whole DB");
    const a = await page.evaluate(() => {
      const reg = window.__mock.columnRegistry();
      const tables = Object.keys(window.__mock.db);
      return {
        strictFlag: window.__mockStrict,
        tables,
        missing: tables.filter((t) => !reg[t] || !reg[t].length),
        hasVAlerts: Array.isArray(reg.v_alerts) && reg.v_alerts.length > 0,
        spot: {
          casesQuoted: reg.cases.includes("protection_quoted_at") && reg.cases.includes("protection_quoted_by"),
          emailLead: reg.email_queue.includes("lead_id") && reg.email_queue.includes("body_html"),
          dupDismiss: reg.duplicate_dismissals.includes("a_id") && reg.duplicate_dismissals.includes("b_id"),
          commLines: reg.commission_lines.includes("attributed_to"),
          ceFromName: reg.case_emails.includes("from_name"),
        },
      };
    });
    eq("A1 · window.__mockStrict defaults TRUE", a.strictFlag, true);
    ok("A2 · every DB table the battery can touch has a non-empty registry entry (" + a.tables.length + " tables)",
      a.missing.length === 0, "missing: " + JSON.stringify(a.missing));
    ok("A3 · the v_alerts view is registered too", a.hasVAlerts);
    ok("A4 · hand-listed prod columns fixtures never seed are registered (cases.protection_quoted_at/_by)", a.spot.casesQuoted);
    ok("A5 · email_queue.lead_id + body_html registered (the R81 lead_id parity find)", a.spot.emailLead);
    ok("A6 · empty-at-load tables are hand-listed (duplicate_dismissals, commission_lines)", a.spot.dupDismiss && a.spot.commLines);
    ok("A7 · case_emails.from_name registered (run_watchtower's client_waiting reads it)", a.spot.ceFromName);

    /* ===================================================================
       B · GHOST SELECT COLUMNS
       =================================================================== */
    console.log("\n— B · a ghost select column throws the named message");
    const b1 = await attempt(page, `return await db.from("cases").select("id,ghost_colx").limit(1);`);
    ok("B1 · select('id,ghost_colx') THROWS", b1.threw, JSON.stringify(b1));
    ok("B2 · …with the exact named, actionable message", STRICT_RE.test(b1.message || "") && /cases\.ghost_colx/.test(b1.message || ""), b1.message);
    const b3 = await attempt(page, `const r = await db.from("cases").select("id,stage,clients!client_id(first_name)").limit(1); return r.data.length;`);
    ok("B3 · a legitimate select still answers", !b3.threw && b3.out === 1, JSON.stringify(b3));
    const b4 = await attempt(page, `const r = await db.from("cases").select("*", { count: "exact", head: true }); return r.count;`);
    ok("B4 · '*' + count/head selects stay legal", !b4.threw && typeof b4.out === "number" && b4.out > 0, JSON.stringify(b4));
    const b5 = await attempt(page, `await db.from("cases").select("nickname:stage,loan_amount::text").limit(1); return 1;`);
    ok("B5 · PostgREST 'alias:col' + '::cast' tokens validate the real column (no throw)", !b5.threw, JSON.stringify(b5));
    const b6 = await attempt(page, `return await db.from("cases").select("id,alias:ghost_coly").limit(1);`);
    ok("B6 · …but an aliased GHOST column still throws", b6.threw && /cases\.ghost_coly/.test(b6.message || ""), JSON.stringify(b6));
    const b7 = await attempt(page, `return await db.from("email_queue").insert({ email_type: "custom", status: "queued" }).select("id,ghost_ret");`);
    ok("B7 · a ghost column in a write's RETURNING select throws too", b7.threw && /email_queue\.ghost_ret/.test(b7.message || ""), JSON.stringify(b7));

    /* ===================================================================
       C · GHOST FILTER / ORDER / OR COLUMNS
       =================================================================== */
    console.log("\n— C · ghost filter columns throw");
    const c1 = await attempt(page, `return await db.from("cases").select("id").eq("ghost_filter", "x");`);
    ok("C1 · .eq on a ghost column THROWS the named message", c1.threw && STRICT_RE.test(c1.message || "") && /cases\.ghost_filter/.test(c1.message || ""), JSON.stringify(c1));
    const c2 = await attempt(page, `return await db.from("case_tasks").select("id").order("ghost_order");`);
    ok("C2 · .order on a ghost column throws", c2.threw && /case_tasks\.ghost_order/.test(c2.message || ""), JSON.stringify(c2));
    const c3 = await attempt(page, `return await db.from("email_queue").select("id").or("status.eq.queued,ghost_or.is.null");`);
    ok("C3 · a ghost column inside an .or() string throws", c3.threw && /email_queue\.ghost_or/.test(c3.message || ""), JSON.stringify(c3));
    const c4 = await attempt(page, `return await db.from("clients").select("id").in("ghost_in", ["a"]);`);
    ok("C4 · .in on a ghost column throws", c4.threw && /clients\.ghost_in/.test(c4.message || ""), JSON.stringify(c4));
    const c5 = await attempt(page, `return await db.from("watch_alerts").select("id").is("ghost_is", null);`);
    ok("C5 · .is on a ghost column throws", c5.threw && /watch_alerts\.ghost_is/.test(c5.message || ""), JSON.stringify(c5));
    const c6 = await attempt(page, `return await db.from("cases").select("id").not("ghost_not", "is", null);`);
    ok("C6 · .not on a ghost column throws", c6.threw && /cases\.ghost_not/.test(c6.message || ""), JSON.stringify(c6));
    const c7 = await attempt(page, `const r = await db.from("cases").select("id").eq("stage", "completed").not("completed_at", "is", null).or("fee_status.eq.paid,broker_fee.gte.0").order("updated_at", { ascending: false }).limit(3); return r.data.length >= 0;`);
    ok("C7 · real filter/order/or columns all still answer", !c7.threw && c7.out === true, JSON.stringify(c7));
    const c8 = await attempt(page, `return await db.from("v_alerts").select("case_id").eq("ghost_view_col", 1);`);
    ok("C8 · the v_alerts VIEW is enforced too", c8.threw && /v_alerts\.ghost_view_col/.test(c8.message || ""), JSON.stringify(c8));

    /* ===================================================================
       D · GHOST WRITE KEYS
       =================================================================== */
    console.log("\n— D · ghost insert/update/upsert keys throw");
    const d1 = await attempt(page, `return await db.from("leads").insert({ name: "R81 Ghost", ghost_key: 1 });`);
    ok("D1 · a ghost INSERT key THROWS the named message", d1.threw && STRICT_RE.test(d1.message || "") && /leads\.ghost_key/.test(d1.message || ""), JSON.stringify(d1));
    const d1b = await page.evaluate(() => window.__mock.db.leads.filter((l) => l.name === "R81 Ghost").length);
    eq("D1b · …and NOTHING landed in the table", d1b, 0);
    const d2 = await attempt(page, `return await db.from("cases").update({ ghost_upd: "x" }).eq("stage", "no_such_stage");`);
    ok("D2 · a ghost UPDATE key throws (before any row is touched)", d2.threw && /cases\.ghost_upd/.test(d2.message || ""), JSON.stringify(d2));
    const d3 = await attempt(page, `return await db.from("settings").upsert({ key: "r81_probe", value: "1", ghost_up: true });`);
    ok("D3 · a ghost UPSERT key throws", d3.threw && /settings\.ghost_up/.test(d3.message || ""), JSON.stringify(d3));
    const d4 = await attempt(page, `return await db.from("saved_views").upsert({ scope: "pipeline", name: "r81", filters: {} }, { onConflict: "user_id,scope,ghost_conflict" });`);
    ok("D4 · a ghost onConflict column throws", d4.threw && /saved_views\.ghost_conflict/.test(d4.message || ""), JSON.stringify(d4));
    const d5 = await attempt(page, `
      const ins = await db.from("case_tasks").insert({ title: "R81 legit", due_date: "2030-01-01" }).select("id").single();
      if (ins.error) return "insert: " + ins.error.message;
      const upd = await db.from("case_tasks").update({ title: "R81 legit 2" }).eq("id", ins.data.id);
      if (upd.error) return "update: " + upd.error.message;
      const del = await db.from("case_tasks").delete().eq("id", ins.data.id);
      return del.error ? "delete: " + del.error.message : "ok";`);
    eq("D5 · legitimate insert/update/delete round-trips untouched", d5.out, "ok");
    /* feature-detect parity: a migration-disabled column is a RETURNED 42703,
       exactly what app.js's fallbacks probe for — strict must never turn that
       contract into a throw. */
    const d6 = await attempt(page, `
      window.__mock.setMigrations({ m7: false });
      const r = await db.from("cases").update({ property_address: "1 Test St" }).eq("stage", "no_such_stage");
      window.__mock.setMigrations({ m7: true });
      return { code: r.error && r.error.code, threwNot: true };`);
    ok("D6 · a migration-disabled column stays a returned 42703 {error}, NOT a strict throw", !d6.threw && d6.out && d6.out.code === "42703", JSON.stringify(d6));

    /* ===================================================================
       E · EMBED INNER-COLUMN VALIDATION
       =================================================================== */
    console.log("\n— E · embeds validate their inner columns against the embedded table");
    const e1 = await attempt(page, `return await db.from("cases").select("id,clients!client_id(first_name,ghost_emb)").limit(1);`);
    ok("E1 · a ghost column INSIDE an embed throws against the EMBEDDED table", e1.threw && /clients\.ghost_emb/.test(e1.message || ""), JSON.stringify(e1));
    const e2 = await attempt(page, `return await db.from("case_tasks").select("id,cases(client_id,clients!client_id(ghost_deep))").limit(1);`);
    ok("E2 · …at nesting depth 2 as well", e2.threw && /clients\.ghost_deep/.test(e2.message || ""), JSON.stringify(e2));
    const e3 = await attempt(page, `const r = await db.from("case_tasks").select("id,cases(client_id,clients!client_id(first_name,last_name))").limit(1); return r.data.length;`);
    ok("E3 · the same shape with real columns still answers", !e3.threw && e3.out === 1, JSON.stringify(e3));
    const e4 = await attempt(page, `return await db.from("cases").select("id,ghost_rel(name)").limit(1);`);
    ok("E4 · an embed naming a table that does not exist is refused", e4.threw && /cases\.ghost_rel/.test(e4.message || ""), JSON.stringify(e4));

    /* ===================================================================
       F · RPC ARG NAMES
       =================================================================== */
    console.log("\n— F · rpc arg names are enforced per known RPC");
    const f1 = await attempt(page, `const r = await db.rpc("get_briefing", { p_scope: "all" }); return Array.isArray(r.data);`);
    ok("F1 · the real arg name answers", !f1.threw && f1.out === true, JSON.stringify(f1));
    const f2 = await attempt(page, `return await db.rpc("get_briefing", { p_scop: "all" });`);
    ok("F2 · a TYPO'D arg name throws (prod: PGRST202, not a briefing that ignored the scope)",
      f2.threw && /MOCK STRICT: unknown rpc arg 'get_briefing\.p_scop'/.test(f2.message || ""), JSON.stringify(f2));
    const f3 = await attempt(page, `const r = await db.rpc("no_such_function_r81"); return r.error && r.error.code;`);
    ok("F3 · an unknown FUNCTION is still the returned 42883 the app feature-detects on", !f3.threw && f3.out === "42883", JSON.stringify(f3));

    /* ===================================================================
       G · THE ESCAPE HATCH
       =================================================================== */
    console.log("\n— G · __mockStrict=false restores the lenient mock; true restores enforcement");
    const g1 = await attempt(page, `
      window.__mockStrict = false;
      const sel = await db.from("cases").select("id,ghost_colx").limit(1);
      const flt = await db.from("cases").select("id").eq("ghost_filter", "x");
      return { selErr: sel.error, ghostKeyUndefined: sel.data[0].ghost_colx === undefined, fltRows: flt.data.length };`);
    ok("G1 · with strict OFF a ghost select answers silently (undefined field) — the pre-R81 hole, on demand",
      !g1.threw && g1.out && g1.out.selErr === null && g1.out.ghostKeyUndefined === true && g1.out.fltRows === 0, JSON.stringify(g1));
    const g2 = await attempt(page, `
      const ins = await db.from("leads").insert({ name: "R81 Lenient", ghost_key: "stored" }).select("*").single();
      const stored = ins.data && ins.data.ghost_key;
      window.__mock.db.leads.splice(window.__mock.db.leads.findIndex((l) => l.name === "R81 Lenient"), 1);
      return stored;`);
    eq("G2 · with strict OFF a ghost insert key is stored (the exact bug class strict exists to catch)", g2.out, "stored");
    const g3 = await attempt(page, `
      window.__mockStrict = true;
      return await db.from("cases").select("id,ghost_colx").limit(1);`);
    ok("G3 · flipping __mockStrict back to true re-arms enforcement", g3.threw && /cases\.ghost_colx/.test(g3.message || ""), JSON.stringify(g3));

    /* ===================================================================
       H · CONSOLE
       =================================================================== */
    console.log("\n— H · console");
    ok("H1 · no console errors", !(page.__err || []).length, JSON.stringify(page.__err));
    await page.close();
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(`\nR81_STRICT: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
