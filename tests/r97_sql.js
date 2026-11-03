// tests/r97_sql.js — R97 · S: the database refusals the red team asked for, through the mock mirror.
//
// The SQL itself (supabase/migrations/20261103163000_r97_red_team.sql) was replayed on PG16; this suite pins the
// mock mirror in admin/mock-supabase.js so the battery fails if the two drift. Every row is created here.
//
//   §A  S-4 email_queue: a signed-in caller cannot mark a row sent/sending, re-date or re-status a sent row, or
//       delete a sent row; cancel / requeue / to_email edits / deleting a cancelled row still work; the sender
//       (window.__mockServiceRole) still marks sent
//   §B  S-8 cases: no persona deletes a case (owner included); deleting a client still removes its cases
//   §C  static: the migration names every item, is idempotent-shaped, and the one-off stays out of migrations
//   §Z  no console errors
//
// Run:  node /root/nx/tests/r97_sql.js
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

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

async function boot(browser, persona) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 30000 });
  await page.waitForTimeout(1800);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(300);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|\b4\d\d\b/i.test(e));

/* One write as the page's persona → its error code (or "ok"). */
const run = (page, fn, arg) => page.evaluate(async ({ src, arg }) => {
  const r = await (0, eval)("(" + src + ")")(window.__mockDb, arg);
  return r && r.error ? r.error.code : "ok";
}, { src: fn.toString(), arg });

/* Fresh email_queue rows for this test, inserted as the persona (insert is not guarded). */
const seedQueue = (page) => page.evaluate(async () => {
  const db = window.__mockDb;
  const { data: cl } = await db.from("clients").select("id,email").limit(1).single();
  const mk = async (status, extra) => (await db.from("email_queue").insert(Object.assign({ client_id: cl.id, email_type: "custom", to_email: cl.email, subject: "R97", status }, extra || {})).select("id").single()).data.id;
  return { queued: await mk("queued"), cancelled: await mk("cancelled"), failed: await mk("failed"),
    sent: await mk("sent", { sent_at: new Date(Date.now() - 3 * 86400000).toISOString() }), queued2: await mk("queued") };
});
const row = (page, id) => page.evaluate((id) => { const r = window.__mock.db.email_queue.find((e) => e.id === id); return r ? { status: r.status, sent_at: r.sent_at } : null; }, id);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const errLog = [];
  try {
    /* =====================================================================
       §A · S-4 email_queue status guard
       ===================================================================== */
    for (const persona of ["p2", "p4"]) {
      console.log(`\n— §A · email_queue: only the sender marks sent (${persona})`);
      const page = await boot(browser, persona);
      const q = await seedQueue(page);
      const sentBefore = await row(page, q.sent);
      eq(`§A1 · ${persona}: queued → sent is refused`, await run(page, (db, id) => db.from("email_queue").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id), q.queued), "42501");
      eq(`§A2 · ${persona}: cancelled → sent (the forge path) is refused`, await run(page, (db, id) => db.from("email_queue").update({ status: "sent" }).eq("id", id), q.cancelled), "42501");
      eq(`§A3 · ${persona}: queued → sending is refused`, await run(page, (db, id) => db.from("email_queue").update({ status: "sending" }).eq("id", id), q.queued), "42501");
      eq(`§A4 · ${persona}: re-dating a sent row is refused`, await run(page, (db, id) => db.from("email_queue").update({ sent_at: new Date().toISOString() }).eq("id", id), q.sent), "42501");
      eq(`§A5 · ${persona}: re-queueing a sent row is refused`, await run(page, (db, id) => db.from("email_queue").update({ status: "queued" }).eq("id", id), q.sent), "42501");
      eq(`§A6 · ${persona}: deleting a sent row is refused`, await run(page, (db, id) => db.from("email_queue").delete().eq("id", id), q.sent), "42501");
      eq(`§A7 · ${persona}: …and the sent row is untouched`, await row(page, q.sent), sentBefore);
      eq(`§A8 · ${persona}: the queued row is still queued`, (await row(page, q.queued)).status, "queued");
      eq(`§A9 · ${persona}: cancel a queued row → ok`, await run(page, (db, id) => db.from("email_queue").update({ status: "cancelled" }).eq("id", id).eq("status", "queued"), q.queued), "ok");
      eq(`§A10 · ${persona}: requeue a failed row → ok`, await run(page, (db, id) => db.from("email_queue").update({ status: "queued", error: null }).eq("id", id), q.failed), "ok");
      eq(`§A11 · ${persona}: edit to_email on a queued row → ok`, await run(page, (db, id) => db.from("email_queue").update({ to_email: "r97@example.com" }).eq("id", id), q.queued2), "ok");
      eq(`§A12 · ${persona}: delete a cancelled row → ok`, await run(page, (db, id) => db.from("email_queue").delete().eq("id", id), q.cancelled), "ok");
      const svc = await page.evaluate(async (id) => {
        window.__mockServiceRole = true;
        try { const { error } = await window.__mockDb.from("email_queue").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id); return error ? error.code : "ok"; }
        finally { window.__mockServiceRole = false; }
      }, q.queued2);
      eq(`§A13 · ${persona}: the sender (service role) still marks a row sent`, svc, "ok");
      errLog.push(["A " + persona, realErrs(page)]);
      await page.context().close();
    }

    /* =====================================================================
       §B · S-8 no case deletion through the API
       ===================================================================== */
    {
      console.log("\n— §B · cases: nobody deletes a case; a client delete still cascades (p1 / p4)");
      for (const persona of ["p1", "p4"]) {
        const page = await boot(browser, persona);
        const ids = await page.evaluate(async () => {
          const db = window.__mockDb;
          const { data: cl } = await db.from("clients").insert({ first_name: "R97", last_name: "Delete", email: "r97.delete@example.com" }).select("id").single();
          const { data: c } = await db.from("cases").insert({ client_id: cl.id, case_kind: "purchase", stage: "enquiry" }).select("id").single();
          return { clientId: cl.id, caseId: c.id };
        });
        eq(`§B1 · ${persona}: deleting a case → 42501`, await run(page, (db, id) => db.from("cases").delete().eq("id", id), ids.caseId), "42501");
        ok(`§B2 · ${persona}: …the case is still there`, await page.evaluate((id) => window.__mock.db.cases.some((c) => c.id === id), ids.caseId));
        eq(`§B3 · ${persona}: deleting its client → ok`, await run(page, (db, id) => db.from("clients").delete().eq("id", id), ids.clientId), "ok");
        ok(`§B4 · ${persona}: …and the case went with it (FK cascade)`, await page.evaluate((id) => !window.__mock.db.cases.some((c) => c.id === id), ids.caseId));
        errLog.push(["B " + persona, realErrs(page)]);
        await page.context().close();
      }
    }

    /* =====================================================================
       §C · static: the migration and the one-off
       ===================================================================== */
    {
      console.log("\n— §C · migration file shape");
      const dir = path.join(REPO, "supabase/migrations");
      const f = fs.readdirSync(dir).filter((n) => /_r97_red_team\.sql$/.test(n));
      eq("§C1 · exactly one R97 migration", f.length, 1);
      const sql = f.length ? fs.readFileSync(path.join(dir, f[0]), "utf8") : "";
      ok("§C2 · its header names S-1…S-8 and D1, and S-9 is not shipped (no site_pages policy change, D3 = no)", ["S-1", "S-2", "S-3", "S-4", "S-5", "S-6", "S-7", "S-8", "D1"].every((k) => sql.includes(k)) && !/policy[^;]*site_pages/i.test(sql), "");
      const creates = (sql.match(/create policy "([^"]+)"/g) || []).map((m) => m.slice(15, -1));
      ok("§C3 · every created policy is dropped-if-exists first", creates.length >= 3 && creates.every((n) => sql.includes(`drop policy if exists "${n}"`)), JSON.stringify(creates));
      ok("§C4 · the trigger is dropped-if-exists first; functions are create or replace", /drop trigger if exists email_queue_status_guard/.test(sql) && !/create function/i.test(sql.replace(/create or replace function/gi, "")), "");
      ok("§C5 · the MFA row only appends 'adviser' (never re-arms an emptied break-glass value)", /btrim\(value\) <> ''/.test(sql) && /\|\| ',adviser'/.test(sql), "");
      ok("§C6 · the site grants are guarded by to_regclass (a Preview Branch has no site tables)", /to_regclass\('public\.site_pages'\)/.test(sql) && /to_regclass\('public\.site_posts'\)/.test(sql), "");
      const r93 = fs.readFileSync(path.join(REPO, "db/r93/01_site_tables.sql"), "utf8");
      const cols = (t) => ((r93.match(new RegExp("grant select \\(([^)]+)\\)\\s+on table public\\." + t + " to anon")) || [])[1] || "").replace(/\s+/g, " ").trim();
      ok("§C7 · site_pages / site_posts re-grant R93's exact column lists", !!cols("site_pages") && sql.replace(/\s+/g, " ").includes(`grant select (${cols("site_pages")}) on table public.site_pages to anon`)
        && sql.replace(/\s+/g, " ").includes(`grant select (${cols("site_posts")}) on table public.site_posts to anon`), cols("site_pages"));
      ok("§C8 · VERIFY queries close the file", /-- VERIFY/.test(sql.slice(-2500)), "");
      ok("§C9 · the stale-queue one-off lives in db/r97, not in migrations", fs.existsSync(path.join(REPO, "db/r97/01_stale_queue.sql")) && !fs.readdirSync(dir).some((n) => /stale/.test(n)), "");
      const one = fs.existsSync(path.join(REPO, "db/r97/01_stale_queue.sql")) ? fs.readFileSync(path.join(REPO, "db/r97/01_stale_queue.sql"), "utf8") : "";
      ok("§C10 · the one-off uses N = 7 days and only touches queued rows", (one.match(/interval '7 days'/g) || []).length >= 3 && !/status\s*<>\s*'queued'/.test(one) && !/delete from/i.test(one), "");
    }

    console.log("\n— §Z · no console errors (ERR_TUNNEL font lines and the expected 4xx refusals ignored)");
    errLog.forEach(([sec, e]) => ok(`Z · §${sec} raised no console/page errors`, e.length === 0, JSON.stringify(e)));
  } catch (e) {
    ok("suite ran without throwing", false, String(e && e.stack || e));
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (e) { /* ignore */ }
  }
  console.log("\n================================================================");
  console.log(`r97_sql: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
