/* ============================================================================
   R95 · A — tests/r95_unsub.js

   THE UNSUBSCRIBE PAGE ON THE SITE, AND THE TWO EDGE FUNCTIONS THAT POINT AT IT.

   §A (static) — unsubscribe.html has no inline script, no inline handler, no javascript:
        URL and loads /unsubscribe.js; it is noindex, Disallowed in robots.txt and absent from
        sitemap.xml. process-emails v22's footer links {site_url}/unsubscribe?c=&t= and its
        List-Unsubscribe header still targets the function; unsubscribe v4 redirects to the same
        site path with the same fallback host.
   §B (runtime) — the page served with the strict site policy (script-src 'self') as a header,
        the function URL stubbed with page.route: valid → the button; not valid → the v3 "not
        recognised" copy; bad/missing params → that copy with no request; the button POSTs
        JSON {c,t} → "Done"; a failed POST → a retry banner; the check unreachable → the button
        anyway. Zero CSP violations, zero on* attributes, zero script without src.
   §C (handler) — unsubscribe-v4.ts transpiled and run in Node with Deno + supabase stubbed:
        302 to the site, JSON validity with one answer for every bad link, the JSON POST and
        the RFC 8058 one-click POST (no Origin) both opt out with both flags and get a 200.
   ========================================================================== */
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const REPO = "/root/nx";
const PORT = 8099;
const ORIGIN = `http://localhost:${PORT}`;
const FN = "https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1/unsubscribe";
const C = "11111111-2222-3333-4444-555555555555";
const T = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- server */
function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/unsubscribe.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await sleep(250);
  return srv;
}

/* ---------- §C helper: the real v4 handler with Deno and supabase stubbed */
function loadV4(db) {
  const src = read("edge/unsubscribe-v4.ts").replace(/^import \{ createClient \} from "jsr:@supabase\/supabase-js@2";$/m, "const { createClient } = __stub;");
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let handler = null;
  const Deno = { env: { get: () => "x" }, serve: (fn) => { handler = fn; } };
  const builder = (table) => {
    const q = { filters: {} };
    const api = {
      select() { return api; },
      eq(k, v) { q.filters[k] = v; return q.update ? Promise.resolve(db.update(table, q.update, q.filters)) : api; },
      update(obj) { q.update = obj; return api; },
      maybeSingle() { return Promise.resolve({ data: db.get(table, q.filters) }); },
    };
    return api;
  };
  new Function("Deno", "__stub", js)(Deno, { createClient: () => ({ from: builder }) });
  return handler;
}

(async () => {
  /* ------------------------------------------------------------------ A. static */
  console.log("A · page, robots, link shape (static)");
  const html = read("unsubscribe.html");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  ok("A1 · every <script> has a src and an empty body", scripts.length > 0 && scripts.every((m) => /\bsrc=/.test(m[1]) && !m[2].trim()), String(scripts.length));
  ok("A2 · loads /unsubscribe.js deferred", /<script src="\/unsubscribe\.js" defer><\/script>/.test(html));
  ok("A3 · no inline on*= handler, no javascript: URL", !/\son[a-z]+=/i.test(html) && !/javascript:/i.test(html));
  ok("A4 · noindex meta", /<meta name="robots" content="noindex/.test(html));
  ok("A5 · robots.txt Disallows /unsubscribe in the universal group", /User-agent: \*[\s\S]*?Disallow: \/unsubscribe\n[\s\S]*?User-agent: GPTBot/.test(read("robots.txt")));
  ok("A6 · sitemap.xml does not list it", !/unsubscribe/.test(read("sitemap.xml")));
  ok("A7 · v3 wording reused verbatim (not recognised / confirm / done)",
    html.includes("Sorry — this link isn't one we recognise.") && html.includes("Prefer not to get emails like this?") && html.includes("Done — you're unsubscribed."));
  const v22 = read("edge/process-emails-v22.ts");
  ok("A8 · v22 footer: href=\"${escapeHtml(unsubSite)}/unsubscribe?c=…&t=…\", unsubSite from s.site_url",
    /<a href="\$\{escapeHtml\(unsubSite\)\}\/unsubscribe\?c=\$\{escapeHtml\(String\(cl\.id\)\)\}&t=\$\{escapeHtml\(String\(cl\.comms_token\)\)\}"/.test(v22) &&
    /const unsubSite = \(s\.site_url \|\| "https:\/\/www\.nexmoney\.co\.uk"\)/.test(v22));
  ok("A9 · v22 footer no longer links the function; List-Unsubscribe still does", !/href="\$\{FN_BASE\}\/unsubscribe/.test(v22) && /`\$\{FN_BASE\}\/unsubscribe\?c=/.test(v22));
  const v4 = read("edge/unsubscribe-v4.ts");
  ok("A10 · v4 redirects to {site_url}/unsubscribe?c=&t= with the same fallback host as v22",
    /`\$\{await siteUrl\(\)\}\/unsubscribe\?c=\$\{encodeURIComponent\(c\)\}&t=\$\{encodeURIComponent\(t\)\}`/.test(v4) && v4.includes('"https://www.nexmoney.co.uk").replace'));
  ok("A11 · v4 has no HTML response left", !/text\/html/.test(v4));

  /* ------------------------------------------------------------------ B. runtime */
  console.log("\nB · the page under script-src 'self' with the function stubbed");
  const server = await ensureServer();
  const browser = await chromium.launch();
  const POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://sclghkmvzpwtmnzbkaoe.supabase.co; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
  // fn: { get: "valid"|"invalid"|"down", post: "ok"|"fail" } → returns the request log
  async function open(qs, fn) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const log = [];
    const cspv = [];
    await ctx.route(`${ORIGIN}/**`, async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const resp = await route.fetch();
      await route.fulfill({ response: resp, headers: { ...resp.headers(), "content-security-policy": POLICY } });
    });
    await ctx.route(`${FN}**`, async (route) => {
      const r = route.request();
      log.push({ method: r.method(), url: r.url(), body: r.postData() });
      const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
      if (r.method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "ok" });
      if (r.method() === "GET") {
        if (fn.get === "down") return route.abort();
        return route.fulfill({ status: 200, headers: hdr, contentType: "application/json", body: JSON.stringify({ ok: true, valid: fn.get === "valid" }) });
      }
      if (fn.post === "fail") return route.fulfill({ status: 200, headers: hdr, contentType: "application/json", body: JSON.stringify({ ok: false }) });
      return route.fulfill({ status: 200, headers: hdr, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) cspv.push(m.text().slice(0, 200)); });
    await page.goto(`${ORIGIN}/unsubscribe.html${qs}`, { waitUntil: "load" });
    await sleep(400);
    const vis = await page.evaluate(() => ["loading", "invalid", "confirm", "done"].filter((id) => !document.getElementById(id).hidden));
    return { ctx, page, log, cspv, vis };
  }
  const QS = `?c=${C}&t=${T}`;
  try {
    let o = await open(QS, { get: "valid" });
    ok("B1 · valid link → only the confirm card shows", JSON.stringify(o.vis) === '["confirm"]', JSON.stringify(o.vis));
    const g = o.log.filter((x) => x.method === "GET");
    ok("B2 · the check is one GET ?format=json&c=&t= and nothing is POSTed on load",
      g.length === 1 && g[0].url === `${FN}?format=json&c=${C}&t=${T}` && !o.log.some((x) => x.method === "POST"), JSON.stringify(o.log));
    const dom = await o.page.evaluate(() => ({
      on: [...document.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
      inline: [...document.scripts].filter((s) => !s.src).length,
      ran: !document.getElementById("loading").hidden ? "no" : "yes",
    }));
    ok("B3 · DOM: zero on* attributes, zero script without src, and the script ran under the policy", dom.on === 0 && dom.inline === 0 && dom.ran === "yes", JSON.stringify(dom));
    await o.page.click("#unsubBtn");
    await sleep(400);
    const post = o.log.find((x) => x.method === "POST");
    ok("B4 · the button POSTs JSON {c,t}", !!post && post.url === FN && JSON.stringify(JSON.parse(post.body)) === JSON.stringify({ c: C, t: T }), JSON.stringify(post));
    const done = await o.page.evaluate(() => ({ vis: ["invalid", "confirm", "done"].filter((id) => !document.getElementById(id).hidden), text: document.getElementById("done").innerText }));
    ok("B5 · → \"Done — you're unsubscribed.\"", JSON.stringify(done.vis) === '["done"]' && done.text.includes("Done — you're unsubscribed."), JSON.stringify(done));
    ok("B6 · zero CSP console reports", o.cspv.length === 0, JSON.stringify(o.cspv));
    await o.ctx.close();

    o = await open(QS, { get: "invalid" });
    const inv = await o.page.evaluate(() => document.getElementById("invalid").innerText);
    ok("B7 · {valid:false} → the not-recognised copy, no button", JSON.stringify(o.vis) === '["invalid"]' && inv.includes("Sorry — this link isn't one we recognise.") && inv.includes("Nothing has been changed."), JSON.stringify(o.vis));
    await o.ctx.close();

    for (const [label, qs] of [["no params", ""], ["c only", `?c=${C}`], ["bad shape", `?c=${C}&t=<script>`]]) {
      o = await open(qs, { get: "valid" });
      ok(`B8 · ${label} → not recognised, no request made`, JSON.stringify(o.vis) === '["invalid"]' && o.log.length === 0, JSON.stringify([o.vis, o.log.length]));
      await o.ctx.close();
    }

    o = await open(QS, { get: "valid", post: "fail" });
    await o.page.click("#unsubBtn");
    await sleep(400);
    const fb = await o.page.evaluate(() => ({ vis: ["invalid", "confirm", "done"].filter((id) => !document.getElementById(id).hidden), banner: document.getElementById("banner").hidden ? "" : document.getElementById("banner").textContent, dis: document.getElementById("unsubBtn").disabled, label: document.getElementById("unsubBtn").textContent }));
    ok("B9 · {ok:false} on POST → retry banner, button re-enabled, still on confirm",
      JSON.stringify(fb.vis) === '["confirm"]' && /didn't go through/.test(fb.banner) && !fb.dis && fb.label === "Unsubscribe me", JSON.stringify(fb));
    await o.ctx.close();

    o = await open(QS, { get: "down" });
    ok("B10 · check unreachable → the button anyway (the POST decides)", JSON.stringify(o.vis) === '["confirm"]', JSON.stringify(o.vis));
    await o.ctx.close();
  } catch (e) {
    failures.push("crash: " + (e && e.stack || e));
    console.log("  ✗ crash", e);
  } finally {
    await browser.close();
    if (server) try { process.kill(-server.pid); } catch (_) { /* already gone */ }
  }

  /* ------------------------------------------------------------------ C. handler */
  console.log("\nC · unsubscribe-v4 handler (Deno + supabase stubbed)");
  try {
    const mk = (opts = {}) => {
      const updates = [];
      const db = {
        get: (table, f) => {
          if (table === "settings") return opts.site === undefined ? null : { value: opts.site };
          if (table === "clients") return f.id === C ? { id: C, comms_token: T } : null;
          return null;
        },
        update: (table, obj, f) => { updates.push({ table, obj, f }); return { error: opts.updErr ? { message: "x" } : null }; },
      };
      return { h: loadV4(db), updates };
    };
    const SITE_ORIGIN = "https://www.nexmoney.co.uk";
    const req = (url, init = {}) => new Request(url, init);
    const body = async (r) => ({ status: r.status, ct: r.headers.get("content-type"), j: await r.json().catch(() => null) });

    let { h, updates } = mk({ site: "https://site.example/" });
    let r = await h(req(`${FN}?c=${C}&t=${T}`));
    ok("C1 · GET (email click) → 302 {site_url}/unsubscribe?c=&t=, nothing written",
      r.status === 302 && r.headers.get("location") === `https://site.example/unsubscribe?c=${C}&t=${T}` && updates.length === 0, `${r.status} ${r.headers.get("location")}`);
    ({ h } = mk({}));
    r = await h(req(`${FN}?c=${C}&t=${T}`));
    ok("C2 · no site_url setting → https://www.nexmoney.co.uk/unsubscribe", r.headers.get("location") === `${SITE_ORIGIN}/unsubscribe?c=${C}&t=${T}`, r.headers.get("location"));

    ({ h, updates } = mk({}));
    let b = await body(await h(req(`${FN}?format=json&c=${C}&t=${T}`)));
    ok("C3 · GET ?format=json, real pair → 200 {ok:true,valid:true}, nothing written", b.status === 200 && /application\/json/.test(b.ct) && JSON.stringify(b.j) === '{"ok":true,"valid":true}' && updates.length === 0, JSON.stringify(b));
    const bad = [];
    for (const qs of [`c=${C}&t=${C}`, `c=${T}&t=${T}`, `c=${C}`, `c=x&t=y`, ""]) bad.push(JSON.stringify((await body(await h(req(`${FN}?format=json&${qs}`)))).j));
    const big = await body(await h(req(`${FN}?format=json&c=${C}&t=${T}`, { headers: { "content-length": "999999" } })));
    ok("C4 · wrong token / unknown id / missing / bad shape / oversized → one identical {ok:true,valid:false}",
      bad.concat(JSON.stringify(big.j)).every((x) => x === '{"ok":true,"valid":false}') && updates.length === 0, JSON.stringify(bad));

    ({ h, updates } = mk({}));
    b = await body(await h(req(FN, { method: "POST", headers: { "content-type": "application/json", origin: SITE_ORIGIN }, body: JSON.stringify({ c: C, t: T }) })));
    ok("C5 · POST JSON {c,t} → {ok:true}, both opt-out flags set on that client",
      JSON.stringify(b.j) === '{"ok":true}' && updates.length === 1 && updates[0].obj.comms_optout === true && updates[0].obj.marketing_opt_out === true && updates[0].f.id === C, JSON.stringify([b, updates]));

    ({ h, updates } = mk({}));
    r = await h(req(`${FN}?c=${C}&t=${T}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
    ok("C6 · RFC 8058 one-click POST (query c/t, no Origin) → 200 and the opt-out", r.status === 200 && updates.length === 1, `${r.status} ${updates.length}`);

    ({ h, updates } = mk({}));
    b = await body(await h(req(FN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ c: C, t: C }) })));
    ok("C7 · POST with a wrong token → {ok:true,valid:false}, nothing written", JSON.stringify(b.j) === '{"ok":true,"valid":false}' && updates.length === 0, JSON.stringify(b));

    ({ h } = mk({ updErr: true }));
    b = await body(await h(req(FN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ c: C, t: T }) })));
    ok("C8 · a failed write answers {ok:false} (the page offers a retry), still 200", b.status === 200 && JSON.stringify(b.j) === '{"ok":false}', JSON.stringify(b));

    ({ h } = mk({}));
    r = await h(req(FN, { method: "OPTIONS", headers: { origin: SITE_ORIGIN } }));
    const r2 = await h(req(FN, { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    ok("C9 · CORS: the site origin is echoed, any other gets the first allowed origin", r.status === 200 && r.headers.get("access-control-allow-origin") === SITE_ORIGIN && r2.headers.get("access-control-allow-origin") === SITE_ORIGIN);
  } catch (e) {
    failures.push("crash C: " + (e && e.stack || e));
    console.log("  ✗ crash C", e);
  }

  console.log(`\nr95_unsub: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((x) => console.log("  ✗ " + x)); process.exit(1); }
})();
