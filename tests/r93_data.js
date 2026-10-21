/* ==========================================================================
   R93 · A — Website: data + edge + build (tests/r93_data.js)

   §A — db/r93/01_site_tables.sql names the four tables, enables RLS on each, carries every
        policy, no DELETE grant on site_publishes / seo_snapshots, the status guard and the three
        settings rows; db/r93/02_cron.sql schedules seo-snapshot at 02:30 UTC off settings.cron_key.
   §B — both edge functions carry the session_ok() gate; seo-snapshot the x-cron-key path and
        timeouts; site-publish the deploy-hook contract.
   §C — build.js with NX_CONTENT_FIXTURE: dist/guides/<slug>.html + dist/guides.html, overridden
        <title>/description/<h1>, FAQPage JSON-LD on the fixture page, raw HTML escaped, sitemap lists
        the guide; a missing fixture fails CLOSED (3 tries, one line, exit 1) unless NX_CONTENT_OPTIONAL=1
        (exit 0, repo HTML + verbatim sitemap, no guides pages) (R93 · fixer); `--hash`
        prints the eight admin files and touches no content; vercel.json has no /guides redirect;
        llms.txt lists /guides; marked is a pinned devDependency.
   §D — mock fixtures: the four tables parse with the contract shapes, the registry equals
        db/columns.json, RLS/guard parity (adviser reads nothing, admin cannot approve, owner
        approval stamps, no delete on snapshots), functions.invoke is recorded in __mockInvokes.

   Run:  node tests/r93_data.js   (NX_REPO / NX_PORT override the defaults)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn, execFileSync, spawnSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = process.env.NX_REPO || path.resolve(__dirname, "..");
const PORT = Number(process.env.NX_PORT || 8099);
const BASE = `http://localhost:${PORT}/admin/mock.html`;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + String(detail).slice(0, 400) : ""}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
const rd = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

async function ensureServer() {
  const up = await new Promise((res) => {
    const req = http.get(`${BASE}`, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
  });
  if (up) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1200));
  return srv;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
async function boot(browser, persona) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mockDb && window.__mock, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  return page;
}

const FIXTURE = {
  site_pages: [
    { slug: "mortgages", title: "R93 Override Title | NexMoney", meta_description: "R93 override <description> & more", og_title: "R93 OG", og_description: null, og_image: null, h1: "R93 <H1>", faq: [{ q: "R93 question?", a: "R93 answer <b>x</b>" }], updated_at: "2026-10-01T10:00:00Z" },
    { slug: "../admin/index", title: "never applied" },
  ],
  site_posts: [
    { id: "a1", slug: "r93-test-guide", title: "R93 test guide", excerpt: "An excerpt.", body_md: "# Heading\n\nSome **bold** text and [a link](/contact).\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))", cover_image: null, status: "published", published_at: "2026-10-10T09:00:00Z", created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-12T09:00:00Z" },
    { id: "a2", slug: "r93-draft", title: "Draft", body_md: "x", status: "draft" },
  ],
};

(async () => {
  /* =====================================================================
     §A — SQL
     ===================================================================== */
  console.log("\n— §A · db/r93 SQL");
  const sql = rd("db/r93/01_site_tables.sql");
  for (const t of ["site_pages", "site_posts", "site_publishes", "seo_snapshots"]) {
    ok(`A1 · creates public.${t}`, new RegExp(`create table if not exists public\\.${t}\\b`).test(sql));
    ok(`A2 · RLS enabled on ${t}`, new RegExp(`alter table public\\.${t}\\s+enable row level security`).test(sql));
  }
  for (const pol of ["site_pages admin all", "site_pages anon read", "site_posts admin all", "site_posts anon read published",
    "site_publishes admin read", "seo_snapshots admin read"]) {
    ok(`A3 · policy "${pol}" (drop if exists + create)`, sql.includes(`drop policy if exists "${pol}"`) && sql.includes(`create policy "${pol}"`));
  }
  for (const pol of ["site_publishes admin insert", "site_publishes admin update", "seo_snapshots admin insert", "seo_snapshots admin update"]) {
    ok(`A3b · policy "${pol}" dropped, not recreated (service_role writes)`, sql.includes(`drop policy if exists "${pol}"`) && !sql.includes(`create policy "${pol}"`));
  }
  ok("A4 · admin policies use the initplan is_admin_or_owner()", (sql.match(/\(select public\.is_admin_or_owner\(\)\)/g) || []).length >= 6);
  ok("A5 · no delete policy on site_publishes / seo_snapshots", !/create policy "[^"]*" on public\.(site_publishes|seo_snapshots) for (delete|all|insert|update)/.test(sql));
  ok("A6 · authenticated gets SELECT only on site_publishes / seo_snapshots", /grant select on table public\.site_publishes, public\.seo_snapshots to authenticated;/.test(sql) && !/seo_snapshots_id_seq to authenticated/.test(sql));
  ok("A7 · anon reads published posts only", /for select to anon\s+using \(status = 'published'\)/.test(sql));
  ok("A8 · anon column grant on site_pages leaves out notes", /grant select \(([^)]*)\)\s+on table public\.site_pages to anon/.test(sql) && !/notes/.test(sql.match(/grant select \(([^)]*)\)\s+on table public\.site_pages to anon/)[1]));
  ok("A9 · status guard trigger + owner-only message", sql.includes("create trigger site_posts_status_guard") && sql.includes("'Only the owner can approve'") && sql.includes("public.is_owner()"));
  ok("A10 · updated_at trigger function (site_touch_updated_at) on pages + posts", /create trigger site_pages_touch/.test(sql) && /create trigger site_posts_touch/.test(sql));
  ok("A11 · three settings rows, on conflict do nothing", /'vercel_deploy_hook_secret', ''/.test(sql) && !/'vercel_deploy_hook'/.test(sql) && /'gsc_property', 'sc-domain:nexmoney\.co\.uk'/.test(sql) && /'seo_audit_enabled', 'on'/.test(sql) && /on conflict \(key\) do nothing/.test(sql));
  ok("A13 · non-owner edit of approved/published content demotes to draft and clears the stamps (R93 · fixer)",
    /old\.status in \('approved', 'published'\)/.test(sql) && /new\.body_md is distinct from old\.body_md/.test(sql) && /new\.status := 'draft';\s*new\.approved_by := null;\s*new\.approved_at := null;\s*new\.published_at := null;/.test(sql) && /not public\.is_owner\(\)\s*and old\.status/.test(sql));
  ok("A14 · site_hook_is_set(): security definer, session_ok + is_admin_or_owner, authenticated only",
    /create or replace function public\.site_hook_is_set\(\)\s*returns boolean/.test(sql) && /security definer\s*set search_path = public/.test(sql)
    && /public\.session_ok\(\) and public\.is_admin_or_owner\(\)/.test(sql) && /key = 'vercel_deploy_hook_secret'/.test(sql)
    && /revoke all on function public\.site_hook_is_set\(\) from public, anon;/.test(sql) && /grant execute on function public\.site_hook_is_set\(\) to authenticated;/.test(sql));
  ok("A15 · server-side author stamps + site_pages slug CHECK", /new\.updated_by := auth\.uid\(\)/.test(sql) && /new\.author_id := coalesce\(new\.author_id, auth\.uid\(\)\)/.test(sql) && /slug\s+text primary key check \(slug ~ '\^\[a-z0-9-\]\*\$'\)/.test(sql));
  const cron = rd("db/r93/02_cron.sql");
  ok("A12 · cron: nexmoney-seo-snapshot at '30 2 * * *', x-cron-key from settings.cron_key", cron.includes("'nexmoney-seo-snapshot', '30 2 * * *'") && /key = 'cron_key'/.test(cron) && cron.includes("/functions/v1/seo-snapshot"));

  /* =====================================================================
     §B — edge functions
     ===================================================================== */
  console.log("\n— §B · edge functions");
  const pub = rd("edge/site-publish-v1.ts"), seo = rd("edge/seo-snapshot-v1.ts");
  ok("B1 · site-publish carries session_ok", pub.includes('uc.rpc("session_ok")') && pub.includes("second factor required"));
  ok("B2 · seo-snapshot carries session_ok", seo.includes('uc.rpc("session_ok")') && seo.includes("second factor required"));
  ok("B3 · seo-snapshot admits x-cron-key against settings.cron_key", seo.includes('req.headers.get("x-cron-key")') && seo.includes('.eq("key", "cron_key")'));
  ok("B4 · both time out their fetches (AbortController)", pub.includes("new AbortController()") && seo.includes("new AbortController()"));
  ok("B5 · site-publish: vercel_deploy_hook_secret + 400 'no deploy hook set'", pub.includes('"vercel_deploy_hook_secret"') && !pub.includes('"vercel_deploy_hook"') && /"no deploy hook set"[^\n]*400/.test(pub));
  ok("B6 · seo-snapshot upserts on (day,kind,page) and uses WebCrypto RS256", seo.includes('onConflict: "day,kind,page"') && seo.includes('"RSASSA-PKCS1-v1_5"') && seo.includes('"pkcs8"'));
  ok("B7 · owner/admin role gate in both", pub.includes('["owner", "admin"]') && seo.includes('["owner", "admin"]'));
  ok("B8 · seo-snapshot redacts ?key= in every error (msg + returned errors + run_errors)", seo.includes(`replace(/([?&]key=)[^&\\s"']+/g, "$1<redacted>")`) && /return redact\(s\)/.test(seo) && (seo.match(/errors: errors\.map\(redact\)/g) || []).length === 2 && /run_errors: errors\.slice\(0, RUN_ERRORS_MAX\)\.map\(\(e\) => redact\(e\)\.slice\(0, 200\)\)/.test(seo));
  ok("B9 · seo-snapshot budget order: audit → PSI (≤8, 12 s, stop <10 s) → links", /const run = await runAudit\(dl, errors\);[\s\S]*const psi = await runPsi\(run\.pages, dl, errors\);\s*await runLinks\(run, dl, errors\);/.test(seo) && /PSI_MAX_PAGES = 8;/.test(seo) && /PSI_CALL_MS = 12_000;/.test(seo) && /PSI_MIN_LEFT_MS = 10_000;/.test(seo) && /not checked/.test(seo));

  /* =====================================================================
     §C — build.js
     ===================================================================== */
  console.log("\n— §C · build.js (offline, NX_CONTENT_FIXTURE)");
  const fx = path.join(os.tmpdir(), `r93_fixture_${process.pid}.json`);
  fs.writeFileSync(fx, JSON.stringify(FIXTURE));
  const b = spawnSync("node", ["build.js"], { cwd: REPO, encoding: "utf8", env: { ...process.env, NX_CONTENT_FIXTURE: fx } });
  ok("C1 · build exits 0", b.status === 0, b.stderr);
  ok("C2 · logs the content line", /content \(fixture\): 1 page override\(s\), 1 guide\(s\)/.test(b.stdout), b.stdout.split("\n").filter((l) => /content/.test(l)).join(" | "));
  const dist = (rel) => path.join(REPO, "dist", rel);
  ok("C3 · dist/guides/r93-test-guide.html exists", fs.existsSync(dist("guides/r93-test-guide.html")));
  ok("C4 · dist/guides.html exists and links the guide", fs.existsSync(dist("guides.html")) && fs.readFileSync(dist("guides.html"), "utf8").includes('href="/guides/r93-test-guide"'));
  ok("C5 · the draft is not rendered", !fs.existsSync(dist("guides/r93-draft.html")));
  const g = fs.existsSync(dist("guides/r93-test-guide.html")) ? fs.readFileSync(dist("guides/r93-test-guide.html"), "utf8") : "";
  ok("C6 · guide: canonical + Article JSON-LD", g.includes('<link rel="canonical" href="https://www.nexmoney.co.uk/guides/r93-test-guide">') && /"@type":"Article"/.test(g));
  ok("C7 · guide: raw <script> in Markdown is escaped, javascript: link dropped, # → h2", g.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !/<script>alert/.test(g) && !g.includes("javascript:") && g.includes("<h2>Heading</h2>"));
  ok("C8 · guide: no unfilled placeholders", !/\{\{\w+\}\}/.test(g));
  const m = fs.readFileSync(dist("mortgages.html"), "utf8");
  ok("C9 · mortgages: overridden <title>", m.includes("<title>R93 Override Title | NexMoney</title>"));
  ok("C10 · mortgages: description escaped", m.includes('<meta name="description" content="R93 override &lt;description&gt; &amp; more">'));
  ok("C11 · mortgages: og:title + twitter:title", m.includes('<meta property="og:title" content="R93 OG">') && m.includes('<meta name="twitter:title" content="R93 OG">'));
  ok("C12 · mortgages: first <h1> replaced, escaped", /<h1[^>]*>R93 &lt;H1&gt;<\/h1>/.test(m));
  ok("C13 · mortgages: FAQPage JSON-LD with the question, HTML-safe", /<script type="application\/ld\+json">\{"@context":"https:\/\/schema.org","@type":"FAQPage"/.test(m) && m.includes("R93 question?") && m.includes("\\u003cb\\u003ex"));
  ok("C14 · path-traversal slug never applied", !fs.readFileSync(dist("admin/index.html"), "utf8").includes("never applied"));
  const sm = fs.readFileSync(dist("sitemap.xml"), "utf8");
  ok("C15 · sitemap: /guides + the guide with lastmod", sm.includes("<loc>https://www.nexmoney.co.uk/guides</loc>") && /<loc>https:\/\/www\.nexmoney\.co\.uk\/guides\/r93-test-guide<\/loc>\s*<lastmod>2026-10-12<\/lastmod>/.test(sm));
  ok("C16 · the template itself is not shipped", !fs.existsSync(dist("guides.template.html")));

  // R93 · fixer: a content-fetch failure fails the build (Vercel keeps the previous deploy) …
  const missing = path.join(os.tmpdir(), "r93_missing_fixture.json");
  const bad = spawnSync("node", ["build.js"], { cwd: REPO, encoding: "utf8", env: { ...process.env, NX_CONTENT_FIXTURE: missing, NX_CONTENT_OPTIONAL: "" } });
  const errLines = bad.stderr.split("\n").filter((l) => l.trim());
  ok("C17 · fail-closed: exit 1, one line naming 3 tries + NX_CONTENT_OPTIONAL", bad.status === 1 && errLines.length === 1
    && /^build: content fetch failed after 3 tries — .+; failing the build so the previous deploy stays live \(set NX_CONTENT_OPTIONAL=1 to build without content\)$/.test(errLines[0])
    && !bad.stdout.split("\n").some((l) => l.startsWith("content")), errLines.join(" | "));
  // … unless NX_CONTENT_OPTIONAL=1: repo HTML, the repo sitemap verbatim, no guides pages.
  const opt = spawnSync("node", ["build.js"], { cwd: REPO, encoding: "utf8", env: { ...process.env, NX_CONTENT_FIXTURE: missing, NX_CONTENT_OPTIONAL: "1" } });
  const optLines = opt.stdout.split("\n").filter((l) => l.startsWith("content"));
  ok("C18 · optional: exit 0, one content line, repo <title> ships", opt.status === 0 && optLines.length === 1 && /NX_CONTENT_OPTIONAL=1/.test(optLines[0]) && !fs.readFileSync(dist("mortgages.html"), "utf8").includes("R93 Override"), optLines.join(" | ") + opt.stderr);
  ok("C19 · optional: sitemap is the repo's verbatim, no guides pages", fs.readFileSync(dist("sitemap.xml"), "utf8") === rd("sitemap.xml") && !fs.existsSync(dist("guides.html")) && !fs.existsSync(dist("guides")));
  try { fs.unlinkSync(fx); } catch (_) { /* gone */ }

  let hash = "";
  try { hash = execFileSync("node", ["build.js", "--hash"], { cwd: REPO, encoding: "utf8", env: { ...process.env, NX_CONTENT_FIXTURE: "" } }); } catch (e) { hash = String(e); }
  const adminFiles = hash.trim().split("\n").map((l) => l.split(/\s+/)[1]).filter((f) => f && f.startsWith("admin/"));
  eq("C20 · --hash prints the eight admin files", adminFiles, ["admin/core.js", "admin/reports-money.js", "admin/diary.js", "admin/import.js", "admin/vault.js", "admin/site.js", "admin/app.js", "admin/admin.css"]);
  ok("C21 · --hash does no content work", !/content/.test(hash));
  const vj = JSON.parse(rd("vercel.json"));
  ok("C22 · vercel.json: no /guides redirect, the others kept", !vj.redirects.some((r) => r.source === "/guides") && vj.redirects.some((r) => r.source === "/forum"));
  ok("C23 · llms.txt lists /guides", rd("llms.txt").includes("https://www.nexmoney.co.uk/guides"));
  const pkg = JSON.parse(rd("package.json"));
  ok("C24 · marked is a pinned devDependency", /^\d+\.\d+\.\d+$/.test((pkg.devDependencies || {}).marked || ""), (pkg.devDependencies || {}).marked);
  ok("C25 · build.js reads the anon key from admin/app.js (no literal)", !/eyJhbGciOi/.test(rd("build.js")) && rd("build.js").includes('"admin", "app.js"'));

  /* =====================================================================
     §D — mock fixtures
     ===================================================================== */
  console.log("\n— §D · mock fixtures + RLS parity + invoke recording");
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {
    const cols = JSON.parse(rd("db/columns.json"));
    const p4 = await boot(browser, "p4");
    const d = await p4.evaluate(async () => {
      const db = window.__mockDb;
      const read = async (t) => (await db.from(t).select("*")).data || [];
      const reg = {};
      for (const t of ["site_pages", "site_posts", "site_publishes", "seo_snapshots"]) reg[t] = window.__mock.columnRegistry(t);
      return { pages: await read("site_pages"), posts: await read("site_posts"), pubs: await read("site_publishes"), snaps: await read("seo_snapshots"), reg };
    });
    eq("D1 · fixture counts 3 / 3 / 2 / 27 (R93 · fixer: + the 404 audit page)", [d.pages.length, d.posts.length, d.pubs.length, d.snaps.length], [3, 3, 2, 27]);
    for (const t of ["site_pages", "site_posts", "site_publishes", "seo_snapshots"]) eq(`D2 · ${t} registry = db/columns.json`, d.reg[t], cols[t]);
    eq("D3 · one post per status draft/approved/published", d.posts.map((p) => p.status).sort(), ["approved", "draft", "published"]);
    const kinds = {};
    d.snaps.forEach((s) => { kinds[s.kind] = (kinds[s.kind] || 0) + 1; });
    eq("D4 · snapshot kinds", kinds, { audit: 15, psi: 3, gsc: 3, gsc_query: 5, summary: 1 });
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    ok("D5 · all snapshots are yesterday (UTC)", d.snaps.every((s) => s.day === yday), [...new Set(d.snaps.map((s) => s.day))].join(","));
    const aud = d.snaps.find((s) => s.kind === "audit").data;
    eq("D6 · audit data keys (contract shape)", Object.keys(aud).sort(), ["broken_links", "canonical", "canonical_ok", "h1", "h1_count", "has_jsonld", "images_no_alt", "internal_links", "issues", "meta", "meta_len", "status", "title", "title_len", "words"].sort());
    const sum = d.snaps.find((s) => s.kind === "summary");
    eq("D7 · summary data keys", Object.keys(sum.data).sort(), ["duration_ms", "errors", "gsc", "gsc_connected", "pages", "psi_avg", "psi_connected", "ran_at", "run_errors", "warnings"]);
    const errs = d.snaps.filter((s) => s.kind === "audit").reduce((n, s) => n + s.data.issues.filter((i) => i.level === "error").length, 0);
    ok("D8 · summary.errors agrees with the audit rows", sum.data.errors === errs && sum.page === "", `${sum.data.errors} vs ${errs}`);
    eq("D9 · psi data keys", Object.keys(d.snaps.find((s) => s.kind === "psi").data).sort(), ["cls", "fcp_ms", "fetched_at", "inp_ms", "lcp_ms", "performance", "strategy"]);
    eq("D10 · gsc_query data keys", Object.keys(d.snaps.find((s) => s.kind === "gsc_query").data).sort(), ["clicks", "ctr", "impressions", "position"]);

    const w = await p4.evaluate(async () => {
      const db = window.__mockDb;
      const draft = (await db.from("site_posts").select("id").eq("status", "draft").single()).data;
      const ap = await db.from("site_posts").update({ status: "approved" }).eq("id", draft.id).select("*").single();
      const pubd = await db.from("site_posts").update({ status: "published" }).eq("id", draft.id).select("*").single();
      const badSlug = await db.from("site_posts").insert({ slug: "Bad Slug", title: "x" });
      const del = await db.from("seo_snapshots").delete().eq("kind", "psi");
      const up = await db.from("site_pages").upsert({ slug: "about", title: "About us" }).select("*").single();
      return { ap: ap.data, pub: pubd.data, badSlug: badSlug.error && badSlug.error.code, del: del.error && del.error.code, up: up.data };
    });
    ok("D11 · owner approval stamps approved_by/approved_at", w.ap && w.ap.approved_by === "p4" && !!w.ap.approved_at);
    ok("D12 · publishing stamps published_at", w.pub && w.pub.status === "published" && !!w.pub.published_at);
    eq("D13 · slug CHECK → 23514", w.badSlug, "23514");
    eq("D14 · no delete on seo_snapshots → 42501", w.del, "42501");
    ok("D15 · site_pages upsert by slug fills defaults", w.up && w.up.slug === "about" && Array.isArray(w.up.faq) && w.up.notes === null && !("created_at" in w.up));

    const inv = await p4.evaluate(async () => {
      window.__mockInvokes = [];
      const a = await window.__mockDb.functions.invoke("site-publish");
      const b = await window.__mockDb.functions.invoke("seo-snapshot", { body: { force: true } });
      const today = new Date().toISOString().slice(0, 10);
      const s = (await window.__mockDb.from("seo_snapshots").select("*").eq("day", today).eq("kind", "summary")).data;
      const last = (await window.__mockDb.from("site_publishes").select("*").order("requested_at", { ascending: false }).limit(1)).data[0];
      return { rec: window.__mockInvokes.map((x) => [x.name, x.body]), a: a.data, b: b.data && b.data.ok, s: s.length, last };
    });
    eq("D16 · invokes recorded in __mockInvokes", inv.rec, [["site-publish", {}], ["seo-snapshot", { force: true }]]);
    ok("D17 · site-publish without a hook: error + failed row", inv.a && inv.a.error === "no deploy hook set" && inv.last.status === "failed" && inv.last.requested_by === "p4");
    ok("D18 · seo-snapshot writes today's summary", inv.b === true && inv.s === 1);
    eq("D19 · p4: zero page errors", realErrs(p4), []);
    await p4.context().close();

    const p1 = await boot(browser, "p1");
    const a1 = await p1.evaluate(async () => {
      const db = window.__mockDb;
      const n = ((await db.from("seo_snapshots").select("id")).data || []).length;
      const ap = (await db.from("site_posts").select("id").eq("status", "draft").single()).data;
      const r = await db.from("site_posts").update({ status: "approved" }).eq("id", ap.id);
      const ins = await db.from("site_posts").insert({ slug: "admin-draft", title: "Admin draft" }).select("*").single();
      const keys = ((await db.from("settings").select("key")).data || []).map((x) => x.key).filter((k) => /vercel/.test(k));
      const hookUnset = (await db.rpc("site_hook_is_set")).data;
      window.__mock.db.settings.find((x) => x.key === "vercel_deploy_hook_secret").value = "https://api.vercel.com/v1/integrations/deploy/prj_x/abc";
      const hookSet = (await db.rpc("site_hook_is_set")).data;
      const keys2 = ((await db.from("settings").select("key")).data || []).map((x) => x.key).filter((k) => /vercel/.test(k));
      return { n, err: r.error && r.error.message, code: r.error && r.error.code, ins: ins.data && ins.data.status, author: ins.data && ins.data.author_id, keys, hookUnset, hookSet, keys2 };
    });
    eq("D25 · admin: hook key hidden, site_hook_is_set() false → true once set, author_id stamped server-side", [a1.keys, a1.hookUnset, a1.hookSet, a1.keys2, a1.author], [[], false, true, [], "p1"]);
    ok("D20 · admin reads the snapshots", a1.n === 27);
    ok("D21 · admin cannot approve: 'Only the owner can approve' (42501)", a1.err === "Only the owner can approve" && a1.code === "42501", JSON.stringify(a1));
    eq("D22 · admin can write a draft", a1.ins, "draft");
    await p1.context().close();

    const p2 = await boot(browser, "p2");
    const a2 = await p2.evaluate(async () => {
      const db = window.__mockDb;
      const out = {};
      for (const t of ["site_pages", "site_posts", "site_publishes", "seo_snapshots"]) out[t] = ((await db.from(t).select("*")).data || []).length;
      const w = await db.from("site_pages").upsert({ slug: "faq", title: "x" });
      out.write = w.error && w.error.code;
      const inv = await db.functions.invoke("site-publish");
      out.invoke = inv.data && inv.data.error;
      return out;
    });
    eq("D23 · adviser reads nothing, writes nothing, cannot publish", a2, { site_pages: 0, site_posts: 0, site_publishes: 0, seo_snapshots: 0, write: "42501", invoke: "unauthorized" });
    const h2 = await p2.evaluate(async () => {
      const db = window.__mockDb;
      const keys = ((await db.from("settings").select("key")).data || []).map((r) => r.key).filter((k) => /vercel/.test(k));
      const rpc = await db.rpc("site_hook_is_set");
      return { keys, rpc: rpc.data, appSettings: Object.keys(window.settings || {}).filter((k) => /vercel/.test(k)) };
    });
    eq("D24 · adviser: settings never return the deploy hook key; site_hook_is_set() false (R93 · fixer)", h2, { keys: [], rpc: false, appSettings: [] });
    await p2.context().close();
  } catch (e) {
    failures.push("CRASH " + (e && e.stack || e));
    console.log("CRASH", e);
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (_) { /* gone */ }
  }
  console.log("\n================================================================");
  console.log(`r93_data: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
