/* ============================================================================
   R94 · C — tests/r94_csp.js

   THE TWO CONTENT-SECURITY-POLICIES IN vercel.json, PROVEN AGAINST THE PAGES.

   R95 note: the §B runtime walk only reports an inline handler that actually FIRES (a
   securitypolicyviolation is raised at execution time, not at parse time), so the static
   count A20 is the real gate against inline handlers; §B proves the strict policy breaks
   nothing that runs.

   §A (static) — vercel.json parses; exactly one CSP on "/(.*)" (site) and one on
        "/admin/:path*", the admin one LATER (Vercel applies every matching headers
        entry in order, so for the same key the later one is what ships); neither
        allows 'unsafe-eval', a bare * or https: for scripts/connections; both pin
        object-src/base-uri/form-action/frame-ancestors; every external script,
        stylesheet, image and fetch origin the source actually names is matched by
        the policy that will serve it (this is what covers the real supabase-js tag,
        which mock.html swaps out).
   §B (runtime) — each page is served with its policy as a real response header
        (minus upgrade-insecure-requests, which would upgrade http://localhost):
        admin/mock.html?as=p1..p4 walking every nav page the way smoke.js does, plus
        a case, a client, the evidence-pack popup (an about:blank window that inherits
        the CSP) and SheetJS (cdn.sheetjs.com routed to node_modules' build, so the
        lazy loader really executes under script-src); admin/introducer.html; and every
        public *.html. Zero `securitypolicyviolation` events and zero console "Content
        Security Policy" messages. Environmental CDN 403s are not violations and are
        not counted. A control probe proves violations ARE caught.
   R95 · D — STRICT: neither script-src allows 'unsafe-inline'. §A also counts every inline
        on*= handler / javascript: URL / inline <script> across admin + site (must be zero, bar
        the site's js-class one-liner, allowed by its pinned sha256) and renders a guide through
        build.js. §B injects its probes as same-origin files (an inline probe would itself be
        blocked) and drives the site's data-act handlers under the strict policy.
   ========================================================================== */
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const path = require("path");

const REPO = "/root/nx";
const PORT = 8099;
const ORIGIN = `http://localhost:${PORT}`;
const SUPA = "https://sclghkmvzpwtmnzbkaoe.supabase.co";
// R95 · D: the ONE inline script the site keeps (it must run before first paint), allowed by hash.
// Changing its bytes changes the hash: update vercel.json's site script-src and this pin together.
const JS_CLASS = "document.documentElement.classList.add('js')";
const JS_CLASS_HASH = "'sha256-Du+OJKJSbdUgz5nrHeWWINvez6XKDDU/tyj/5c2uvwo='";

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- CSP parsing + source matching (enough of CSP3 for these policies) */
function parseCsp(v) {
  const out = {};
  v.split(";").map((s) => s.trim()).filter(Boolean).forEach((d) => {
    const [k, ...src] = d.split(/\s+/);
    out[k.toLowerCase()] = src;
  });
  return out;
}
function sourcesFor(csp, dir) { return csp[dir] || csp["default-src"] || []; }
function matchSource(src, url) {
  const u = new URL(url);
  if (/^[a-z][a-z0-9+.-]*:$/i.test(src)) return u.protocol === src.toLowerCase();
  if (src.startsWith("'")) return false;
  const m = src.match(/^(https?:\/\/)?(\*\.)?([^/:]+)(:\d+)?(\/.*)?$/i);
  if (!m) return false;
  if (m[1] && u.protocol !== m[1].slice(0, -2)) return false;
  const host = m[3].toLowerCase();
  if (m[2] ? !u.hostname.endsWith("." + host) : u.hostname !== host) return false;
  if (m[5]) return m[5].endsWith("/") ? u.pathname.startsWith(m[5]) : u.pathname === m[5];
  return true;
}
const allowed = (csp, dir, url) => sourcesFor(csp, dir).some((s) => matchSource(s, url));

/* ---------- server */
function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await sleep(250);
  return srv;
}

(async () => {
  /* ------------------------------------------------------------------ A. static */
  console.log("A · vercel.json policies (static)");
  const vj = JSON.parse(read("vercel.json"));
  const cspEntries = vj.headers.map((h, i) => ({ i, source: h.source, v: (h.headers.find((x) => x.key.toLowerCase() === "content-security-policy") || {}).value }))
    .filter((e) => e.v);
  const siteE = cspEntries.find((e) => e.source === "/((?!admin).*)");   // R94 · fixer: the site CSP can never match /admin
  const adminE = cspEntries.find((e) => e.source === "/admin/:path*");
  ok("A1 · exactly two CSP entries: site /((?!admin).*) and /admin/:path*", cspEntries.length === 2 && !!siteE && !!adminE, JSON.stringify(cspEntries.map((e) => e.source)));
  ok("A2 · the /admin entry comes AFTER the site entry (same key: the later match is what ships)", !!siteE && !!adminE && adminE.i > siteE.i);
  ok("A2b · the site CSP source excludes /admin, so only ONE CSP header can reach the back office", !!siteE && /\(\?!admin\)/.test(siteE.source));
  const SITE = parseCsp(siteE.v), ADMIN = parseCsp(adminE.v);
  for (const [name, c] of [["site", SITE], ["admin", ADMIN]]) {
    ok(`A3 · ${name}: default-src 'self'`, JSON.stringify(c["default-src"]) === JSON.stringify(["'self'"]));
    ok(`A4 · ${name}: object-src 'none', base-uri 'self', form-action 'self', frame-ancestors 'none'`,
      c["object-src"]?.join() === "'none'" && c["base-uri"]?.join() === "'self'" && c["form-action"]?.join() === "'self'" && c["frame-ancestors"]?.join() === "'none'");
    ok(`A5 · ${name}: no 'unsafe-eval' anywhere`, !/unsafe-eval/.test(name === "site" ? siteE.v : adminE.v));
    ok(`A6 · ${name}: script-src and connect-src carry no bare *, https: or data:`,
      ["script-src", "connect-src"].every((d) => sourcesFor(c, d).every((s) => !["*", "https:", "http:", "data:", "blob:"].includes(s))),
      JSON.stringify([c["script-src"], c["connect-src"]]));
    ok(`A7 · ${name}: upgrade-insecure-requests set`, "upgrade-insecure-requests" in c);
  }
  ok("A8 · site script-src is exactly 'self' + the js-class one-liner's pinned hash (no third-party script)",
    JSON.stringify(SITE["script-src"]) === JSON.stringify(["'self'", JS_CLASS_HASH]), JSON.stringify(SITE["script-src"]));
  ok("A8b · the pinned hash IS sha256 of the one-liner's bytes",
    JS_CLASS_HASH === `'sha256-${crypto.createHash("sha256").update(JS_CLASS).digest("base64")}'`);
  ok("A8c · STRICT: neither script-src carries 'unsafe-inline' or 'unsafe-hashes'",
    !/unsafe-inline|unsafe-hashes/.test((SITE["script-src"] || []).concat(ADMIN["script-src"] || []).join(" ")), JSON.stringify([SITE["script-src"], ADMIN["script-src"]]));
  ok("A8d · admin script-src is exactly 'self' + the supabase-js and SheetJS paths",
    JSON.stringify(ADMIN["script-src"]) === JSON.stringify(["'self'", "https://cdn.jsdelivr.net/npm/@supabase/", "https://cdn.sheetjs.com/xlsx-0.20.2/"]), JSON.stringify(ADMIN["script-src"]));
  ok("A9 · no realtime: admin connect-src has no wss:// (the code opens no channel)",
    !sourcesFor(ADMIN, "connect-src").some((s) => /^wss:/.test(s)) && !/\.channel\(/.test(["core", "reports-money", "diary", "import", "vault", "site", "app"].map((f) => read(`admin/${f}.js`)).join("\n")));

  // Every external origin the source names must be allowed by the policy that serves it.
  const extScripts = (html) => [...html.matchAll(/<script\b[^>]*\bsrc="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  const extStyles = (html) => [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).filter((t) => /rel="stylesheet"/.test(t))
    .map((t) => (t.match(/href="(https?:\/\/[^"]+)"/) || [])[1]).filter(Boolean);
  const adminHtml = ["admin/index.html", "admin/introducer.html"];
  const adminJs = ["boot", "core", "reports-money", "diary", "import", "vault", "site", "app", "introducer"].map((f) => `admin/${f}.js`);   // R95: + boot.js and introducer.js (its inline script moved out)
  const adminScripts = adminHtml.flatMap((f) => extScripts(read(f)))
    .concat(adminJs.flatMap((f) => [...read(f).matchAll(/\.src\s*=\s*"(https:\/\/[^"]+)"/g)].map((m) => m[1])));
  ok("A10 · admin: every external script (supabase-js tag, SheetJS lazy loader) is in script-src",
    adminScripts.length >= 3 && adminScripts.every((u) => allowed(ADMIN, "script-src", u)), JSON.stringify(adminScripts.filter((u) => !allowed(ADMIN, "script-src", u)).concat([`n=${adminScripts.length}`])));
  const adminStyles = adminHtml.flatMap((f) => extStyles(read(f)));
  ok("A11 · admin: every external stylesheet is in style-src", adminStyles.every((u) => allowed(ADMIN, "style-src", u)), JSON.stringify(adminStyles));
  const favs = adminJs.flatMap((f) => [...read(f).matchAll(/src="(https:\/\/[^"$]+)/g)].map((m) => m[1]));
  ok("A12 · admin: every external <img> source (lender favicons) is in img-src", favs.length >= 1 && favs.every((u) => allowed(ADMIN, "img-src", u)), JSON.stringify(favs));
  ok("A13 · admin: the favicon redirect target (t*.gstatic.com) and MFA QR data: URIs are in img-src",
    allowed(ADMIN, "img-src", "https://t2.gstatic.com/faviconV2?url=x") && sourcesFor(ADMIN, "img-src").includes("data:"));
  const adminSupa = adminHtml.concat(adminJs).flatMap((f) => [...read(f).matchAll(/const SUPABASE_URL = "([^"]+)"/g)].map((m) => m[1]));
  ok("A14 · admin: SUPABASE_URL (REST, auth, storage, functions/v1) is in connect-src",
    adminSupa.length >= 2 && adminSupa.every((u) => allowed(ADMIN, "connect-src", u + "/functions/v1/parse-offer")), JSON.stringify(adminSupa));
  const siteFiles = fs.readdirSync(REPO).filter((f) => f.endsWith(".html"));
  const siteScripts = siteFiles.flatMap((f) => extScripts(read(f)));
  ok("A15 · site: no page loads a third-party script", siteScripts.length === 0, JSON.stringify(siteScripts));
  const siteStyles = siteFiles.flatMap((f) => extStyles(read(f)));
  ok("A16 · site: every external stylesheet (Google Fonts) is in style-src", siteStyles.length > 0 && siteStyles.every((u) => allowed(SITE, "style-src", u)), JSON.stringify(siteStyles.filter((u) => !allowed(SITE, "style-src", u))));
  const sitePageJs = fs.existsSync(path.join(REPO, "js")) ? fs.readdirSync(path.join(REPO, "js")).filter((f) => f.endsWith(".js")).map((f) => `js/${f}`) : [];
  const siteFns = siteFiles.concat(sitePageJs).flatMap((f) => [...read(f).matchAll(/https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1[^"' ]*/g)].map((m) => m[0]));
  ok("A17 · site: every edge-function URL (new-lead, fact-find, docs/feedback FN_BASE) is in connect-src",
    siteFns.length >= 4 && siteFns.every((u) => allowed(SITE, "connect-src", u)), JSON.stringify(siteFns));
  ok("A18 · site: guide cover / Markdown images (any https:// URL an author types) are in img-src",
    allowed(SITE, "img-src", "https://images.example.com/cover.jpg") && allowed(SITE, "font-src", "https://fonts.gstatic.com/s/inter/v1/x.woff2"));
  ok("A18b · admin: Google Fonts woff2 + the preconnect hosts in admin/index.html are in font-src / style-src (sandbox never fetches fonts, so this is static)",
    allowed(ADMIN, "font-src", "https://fonts.gstatic.com/s/inter/v1/x.woff2") && allowed(ADMIN, "style-src", "https://fonts.googleapis.com/css2?family=Inter")
    && (read("admin/index.html").match(/rel="preconnect" href="(https:[^"]+)"/g) || []).every((m) => { const u = m.match(/href="([^"]+)"/)[1]; return allowed(ADMIN, "font-src", u + "/x") || allowed(ADMIN, "style-src", u + "/x"); }));

  const evalish = /\beval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\s*\(\s*["'`]/;
  const evalHits = adminJs.concat(["admin/sw.js", "enhance.js"]).filter((f) => evalish.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
  ok("A19 · no eval / new Function / string timers in the shipped JS (script-src has no 'unsafe-eval')", evalHits.length === 0, JSON.stringify(evalHits));

  /* R95 · D: the inline inventory — under the strict policies every survivor is a dead control. */
  const adminDir = fs.readdirSync(path.join(REPO, "admin"));
  const inlineScope = adminDir.filter((f) => f.endsWith(".js") && f !== "mock-supabase.js").map((f) => `admin/${f}`)
    .concat(adminDir.filter((f) => f.endsWith(".html")).map((f) => `admin/${f}`), siteFiles);   // siteFiles includes unsubscribe.html (slice A) on purpose
  const tally = (re) => inlineScope.map((f) => [f, (read(f).match(re) || []).length]).filter(([, n]) => n);
  const handlers = tally(/\son[a-z]+\s*=/g);   // R95 · fixer F5: any quoting (double, single, none)
  ok("A20 · zero inline on*=\" handlers across admin/*.js (bar the mock), admin/*.html and every root *.html",
    handlers.length === 0, `${handlers.reduce((a, [, n]) => a + n, 0)} left: ${JSON.stringify(handlers)}`);
  const jsUrls = tally(/href=["']javascript:/g);
  ok("A21 · zero javascript: hrefs (blocked by a script-src without 'unsafe-inline')", jsUrls.length === 0, JSON.stringify(jsUrls));
  const inlineScripts = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc=/.test(m[1]) && !/type=["']application\/ld\+json["']/.test(m[1])).map((m) => m[2]);
  const htmlScope = inlineScope.filter((f) => f.endsWith(".html"));
  const badInline = htmlScope.map((f) => [f, inlineScripts(read(f)).filter((b) => b !== JS_CLASS).length]).filter(([, n]) => n);
  ok("A22 · no inline <script> (non-JSON-LD) in admin/*.html or root *.html other than the hashed js-class one-liner", badInline.length === 0, JSON.stringify(badInline));
  const oneLiners = siteFiles.filter((f) => inlineScripts(read(f)).includes(JS_CLASS));
  ok("A23 · the js-class one-liner is byte-identical wherever it appears (so the one hash covers it)", oneLiners.length >= 14, `n=${oneLiners.length}`);

  /* The guide shell is rendered by build.js; prove a RENDERED guide (and the overridden pages) stay clean. */
  const fx = path.join(os.tmpdir(), `r94_csp_fixture_${process.pid}.json`);
  fs.writeFileSync(fx, JSON.stringify({
    site_pages: [{ slug: "mortgages", title: "R95 override | NexMoney", faq: [{ q: "Q?", a: "A <b>x</b>" }] }],
    site_posts: [{ id: "g1", slug: "r95-csp-guide", title: "R95 CSP guide", excerpt: "x", status: "published", published_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
      body_md: "# H\n\n<script>alert(1)</script>\n\n<img src=x onerror=\"alert(1)\">\n\n[bad](javascript:alert(1))" }],
  }));
  const b = spawnSync("node", ["build.js"], { cwd: REPO, encoding: "utf8", env: { ...process.env, NX_CONTENT_FIXTURE: fx } });
  try { fs.unlinkSync(fx); } catch (_) { /* gone */ }
  const distHtml = (d) => fs.readdirSync(path.join(REPO, d)).filter((f) => f.endsWith(".html")).map((f) => path.join(d, f));
  const rendered = b.status === 0 ? distHtml("dist").concat(fs.existsSync(path.join(REPO, "dist/guides")) ? distHtml("dist/guides") : []) : [];
  const dirty = rendered.filter((f) => !f.startsWith("dist/admin")).map((f) => { const h = read(f); return [f, (h.match(/ on[a-z]+="/g) || []).length + inlineScripts(h).filter((x) => x !== JS_CLASS).length]; }).filter(([, n]) => n);
  ok("A24 · build.js (fixture) renders the guide; dist/guides/*.html + every dist/*.html carry no inline handler or non-hashed inline script",
    rendered.includes("dist/guides/r95-csp-guide.html") && dirty.length === 0, b.status !== 0 ? b.stderr.slice(0, 300) : JSON.stringify(dirty));

  /* ------------------------------------------------------------------ B. runtime */
  /* WHY no page.evaluate below: once Playwright evaluates in a page's main world, Chrome lets eval() run
     there for the rest of the page's life (CDP allowUnsafeEvalBlockedByCSP), so a missing 'unsafe-eval'
     would go unseen. Pages are driven by clicks (utility world) and by scripts the route injects, and
     results are read back from attributes on <html>. */
  const strip = (v) => v.split(";").map((s) => s.trim()).filter((s) => s && s !== "upgrade-insecure-requests").join("; ");
  const SITE_HDR = strip(siteE.v), ADMIN_HDR = strip(adminE.v);
  const server = await ensureServer();
  const browser = await chromium.launch();
  const XLSX_LOCAL = path.join(REPO, "node_modules", "xlsx", "dist", "xlsx.full.min.js");

  const SET = "var R=function(k,v){document.documentElement.setAttribute('data-r94-'+k,String(v));};var W=function(ms){return new Promise(function(r){setTimeout(r,ms);});};";
  const INJECT = {
    // the control: one off-policy image and one eval(), from page script
    control: SET + "window.addEventListener('load',function(){var i=new Image();i.src='https://csp-probe.invalid/x.png';" +
      "try{(0,eval)('1');R('eval','allowed');}catch(e){R('eval','blocked');}});",
    // p4 driver: a case, a client, SheetJS, then the evidence pack popup — all as page script
    driver: SET + "window.addEventListener('load',async function(){try{await W(1800);" +
      "var rows=(await window.__mockDb.from('cases').select('id,client_id,lender')).data;" +
      "var c=rows.filter(function(x){return x.lender&&x.client_id;})[0]||rows[0];" +
      "await window.openCase(c.id);await W(1200);if(window.closeModal)window.closeModal();" +
      "await window.openClient(c.client_id);await W(1200);if(window.closeModal)window.closeModal();" +
      "await ensureXlsx();var wb=XLSX.read('a,b\\n1,2',{type:'string'});R('xlsx',XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).length===1?'ok':'bad');" +
      "await buildEvidencePack(c.id);R('drv','done');}catch(e){R('drv','err: '+e.message);}});",
    // site: the page's own edge-function host must be allowed by connect-src (the network failing here is the sandbox)
    connect: SET + "window.addEventListener('load',function(){fetch('" + SUPA + "/functions/v1/new-lead',{method:'OPTIONS'}).catch(function(){}).then(function(){R('fetch','done');});});",
  };

  async function ctxWith(policy) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    // The policy as a real response header on every document this origin serves (popups inherit it).
    await ctx.route(`${ORIGIN}/**`, async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const resp = await route.fetch();
      const inj = (new URL(route.request().url()).searchParams.get("r94") || "").split(",").filter((k) => INJECT[k]);
      let body = await resp.text();
      // R95 · D: as same-origin files — an inline probe would itself be a violation under the strict policy.
      if (inj.length) body = body.replace(/<\/body>/i, inj.map((k) => `<script src="/__r94/${k}.js"></script>`).join("") + "</body>");
      await route.fulfill({ response: resp, body, headers: { ...resp.headers(), "content-security-policy": policy } });
    });
    await ctx.route(`${ORIGIN}/__r94/*.js`, (route) => route.fulfill({ status: 200, contentType: "text/javascript",
      body: INJECT[path.basename(new URL(route.request().url()).pathname, ".js")] || "" }));
    // SheetJS: the sandbox cannot reach cdn.sheetjs.com — serve the same library from node_modules at the real URL.
    if (fs.existsSync(XLSX_LOCAL)) {
      await ctx.route("https://cdn.sheetjs.com/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(XLSX_LOCAL) }));
    }
    await ctx.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        const el = document.documentElement, prev = JSON.parse(el.getAttribute("data-r94-cspv") || "[]");
        prev.push(`${e.effectiveDirective} blocked ${e.blockedURI || "(inline)"} @ ${(e.sourceFile || "").replace(/^https?:\/\/[^/]+/, "")}:${e.lineNumber}`);
        el.setAttribute("data-r94-cspv", JSON.stringify(prev));
      });
    });
    const cspConsole = [];
    ctx.on("page", (page) => {
      page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) cspConsole.push(m.text().slice(0, 220)); });
      page.on("dialog", (d) => d.dismiss().catch(() => { }));
    });
    return { ctx, cspConsole };
  }
  const attr = (page, k) => page.locator("html").getAttribute(`data-r94-${k}`).catch(() => null);
  const violations = async (page) => JSON.parse((await attr(page, "cspv")) || "[]");
  const waitAttr = async (page, k, ms) => { for (let t = 0; t < ms; t += 200) { const v = await attr(page, k); if (v != null) return v; await sleep(200); } return null; };

  const PAGES = ["dashboard", "pipeline", "protection", "diary", "clients", "retention", "import", "reports", "data", "emails", "settings"];
  const ROLE = { p1: "admin", p2: "adviser", p3: "adviser", p4: "owner" };
  try {
    console.log("\nB · admin/mock.html under the /admin policy, p1..p4 (every nav page, the smoke.js walk)");
    for (const p of ["p1", "p2", "p3", "p4"]) {
      const { ctx, cspConsole } = await ctxWith(ADMIN_HDR);
      const page = await ctx.newPage();
      await page.goto(`${ORIGIN}/admin/mock.html?as=${p}`, { waitUntil: "domcontentloaded" });
      let shell = true;
      try { await page.waitForSelector("#app-view:not(.hidden)", { timeout: 10000 }); } catch (_) { shell = false; }
      ok(`B · ${p}: app shell boots under the policy`, shell);
      await sleep(1200);
      if (await page.locator("#nav-firm-group.collapsed").count()) await page.click("#nav-firm-toggle");
      let visited = 0;
      for (const k of PAGES) {
        const gated = ["import", "emails", "data"].includes(k);
        if (gated && ROLE[p] === "adviser") continue;
        if (gated) { await page.click('#topnav button[data-page="operations"]'); await sleep(250); await page.click(`#operations-tabs-${k}`); }
        else await page.click(`#topnav button[data-page="${k}"]`);
        await sleep(900);
        visited++;
      }
      ok(`B · ${p} (${ROLE[p]}): walked ${visited} nav pages`, visited === (ROLE[p] === "adviser" ? 8 : 11));
      const v = await violations(page);
      ok(`B · ${p}: zero CSP violations`, v.length === 0 && cspConsole.length === 0, JSON.stringify(v.concat(cspConsole).slice(0, 6)));
      await ctx.close();
    }

    console.log("\nB · p4: a case, a client, SheetJS and the evidence-pack popup (page-script driver)");
    {
      const { ctx, cspConsole } = await ctxWith(ADMIN_HDR);
      const page = await ctx.newPage();
      const popP = ctx.waitForEvent("page", { timeout: 25000 }).catch(() => null);
      await page.goto(`${ORIGIN}/admin/mock.html?as=p4&r94=driver`, { waitUntil: "domcontentloaded" });
      const drv = await waitAttr(page, "drv", 20000);
      ok("B · p4: the driver opened a case and a client and built the evidence pack", drv === "done", String(drv));
      ok("B · p4: SheetJS lazy-loads from cdn.sheetjs.com and parses under script-src (no 'unsafe-eval')", (await attr(page, "xlsx")) === "ok", String(await attr(page, "xlsx")));
      const pop = await popP;
      let popOk = false;
      if (pop) { await sleep(800); popOk = /Evidence pack/.test(await pop.title().catch(() => "")) && (await pop.locator("button.noprint").count()) === 1; }
      ok("B · p4: the evidence-pack popup renders (an about:blank window: it inherits the admin CSP)", popOk);
      const v = await violations(page);
      ok("B · p4: zero CSP violations (main page, and console of the popup)", v.length === 0 && cspConsole.length === 0, JSON.stringify(v.concat(cspConsole).slice(0, 6)));
      await ctx.close();
    }

    console.log("\nB · control — the harness must SEE a violation when there is one");
    {
      const { ctx, cspConsole } = await ctxWith(ADMIN_HDR);
      const page = await ctx.newPage();
      await page.goto(`${ORIGIN}/admin/mock.html?as=p1&r94=control`, { waitUntil: "load" });
      await waitAttr(page, "eval", 5000); await sleep(600);
      const v = await violations(page);
      ok("B · control: an off-policy image is reported (event + console)", v.some((s) => /^img-src blocked https:\/\/csp-probe/.test(s)) && cspConsole.some((s) => /csp-probe/.test(s)), JSON.stringify(v));
      ok("B · control: eval() from page script is blocked and reported", (await attr(page, "eval")) === "blocked" && v.some((s) => /^script-src blocked eval/.test(s)), JSON.stringify([await attr(page, "eval"), v]));
      await ctx.close();
    }

    console.log("\nB · admin/introducer.html under the /admin policy");
    {
      const { ctx, cspConsole } = await ctxWith(ADMIN_HDR);
      const page = await ctx.newPage();
      await page.goto(`${ORIGIN}/admin/introducer.html`, { waitUntil: "load" }); await sleep(800);
      const v = await violations(page);
      ok("B · introducer.html: zero CSP violations", v.length === 0 && cspConsole.length === 0, JSON.stringify(v.concat(cspConsole).slice(0, 6)));
      await ctx.close();
    }

    console.log("\nB · public site under the site policy (every top-level page)");
    const sitePages = fs.readdirSync(REPO).filter((f) => f.endsWith(".html")).sort();   // guides.template.html is the shell every published guide ships in
    const { ctx, cspConsole } = await ctxWith(SITE_HDR);
    for (const f of sitePages) {
      const page = await ctx.newPage();
      const before = cspConsole.length;
      await page.goto(`${ORIGIN}/${f}?r94=connect`, { waitUntil: "load" });
      const fetched = await waitAttr(page, "fetch", 8000); await sleep(300);
      const v = await violations(page);
      ok(`B · ${f}: zero CSP violations (incl. a fetch to the edge-function host)`, fetched === "done" && v.length === 0 && cspConsole.length === before,
        JSON.stringify([fetched].concat(v, cspConsole.slice(before)).slice(0, 6)));
      await page.close();
    }
    await ctx.close();

    console.log("\nB · site behaviour through the data-act kit, under the strict site policy");
    {
      const { ctx: c2, cspConsole: con2 } = await ctxWith(SITE_HDR);
      let lead = 200;
      await c2.route(`${SUPA}/functions/v1/new-lead`, (r) => r.fulfill({ status: lead, contentType: "application/json", body: "{}" }));
      const pg = await c2.newPage();
      const style = (sel) => pg.locator(sel).first().getAttribute("style");
      await pg.setViewportSize({ width: 390, height: 844 });
      await pg.goto(`${ORIGIN}/index.html`, { waitUntil: "load" });
      await pg.click(".nav-toggle");
      ok("B · nav toggle (navToggle): opens #mainNav and sets aria-expanded", (await pg.locator(".nav-toggle").getAttribute("aria-expanded")) === "true"
        && /\bopen\b/.test(await pg.locator("#mainNav").getAttribute("class")));
      await pg.click(".nav-toggle");
      ok("B · nav toggle: second click closes it", (await pg.locator(".nav-toggle").getAttribute("aria-expanded")) === "false");
      await pg.setViewportSize({ width: 1440, height: 960 });
      await pg.fill("#income1", "100000");
      ok("B · index borrow calc (oninput → data-on=input): £400,000 – £550,000", (await pg.locator("#borrowResult").textContent()).trim() === "£400,000 – £550,000", await pg.locator("#borrowResult").textContent());
      await pg.click('.calc-tab:has-text("Monthly repayments")');
      ok("B · index calc tabs (switchCalc via data-args [\"repay\",\"$this\"])", await pg.locator("#calc-repay").isVisible() && !(await pg.locator("#calc-borrow").isVisible())
        && /\bactive\b/.test(await pg.locator('.calc-tab:has-text("Monthly repayments")').getAttribute("class")));
      await pg.hover('a.btn-outline[href="/faq"]');
      ok("B · index FAQ button hover (hoverStyle mouseover)", /background: rgba\(61, 162, 255, 0\.12\)/.test(await style('a.btn-outline[href="/faq"]')), await style('a.btn-outline[href="/faq"]'));
      await pg.mouse.move(2, 2);
      ok("B · index FAQ button un-hover (hoverStyle mouseout)", /background: transparent/.test(await style('a.btn-outline[href="/faq"]')));

      await pg.goto(`${ORIGIN}/calculators.html`, { waitUntil: "load" });
      await pg.fill("#b_income1", "50000");
      ok("B · calculators borrow calc: £200,000 – £275,000", (await pg.locator("#b_result").textContent()).trim() === "£200,000 – £275,000", await pg.locator("#b_result").textContent());

      await pg.goto(`${ORIGIN}/faq.html`, { waitUntil: "load" });
      await pg.hover('a[href="#borrowing"]');
      ok("B · faq jump-link hover sets the orange border", /border-color: var\(--orange\)/.test(await style('a[href="#borrowing"]')), await style('a[href="#borrowing"]'));
      await pg.mouse.move(2, 2);
      ok("B · faq jump-link un-hover clears it", !/--orange/.test(await style('a[href="#borrowing"]')) && /border(-color)?: (2px solid )?transparent/.test(await style('a[href="#borrowing"]')), await style('a[href="#borrowing"]'));

      const fillContact = async () => {
        await pg.fill("#fname", "R95"); await pg.fill("#lname", "Test"); await pg.fill("#email", "r95@example.com");
        await pg.fill("#phone", "07700900000"); await pg.check("#consent");
      };
      await pg.goto(`${ORIGIN}/contact.html?type=remortgage`, { waitUntil: "load" });
      ok("B · contact ?type= preselects the enquiry type (page script from /js/contact.js)", (await pg.locator("#enquiryType").inputValue()) === "remortgage");
      lead = 500; await fillContact(); await pg.click('#enquiryForm [type="submit"]'); await pg.waitForTimeout(600);
      ok("B · contact submit (data-on=submit) on a failing new-lead shows the error and stays on the page", await pg.locator("#formError").isVisible()
        && pg.url().includes("/contact.html?type=remortgage"));
      lead = 200; await pg.click('#enquiryForm [type="submit"]'); await pg.waitForTimeout(600);
      ok("B · contact submit on 200 shows the success state", await pg.locator("#formSuccess").isVisible() && !(await pg.locator("#enquiryForm").isVisible()));
      const v = await violations(pg);
      ok("B · site behaviour run: zero CSP violations", v.length === 0 && con2.length === 0, JSON.stringify(v.concat(con2).slice(0, 6)));
      await c2.close();
    }
  } catch (e) {
    failures.push("crash: " + (e && e.stack || e));
    console.log("  ✗ crash", e);
  } finally {
    await browser.close();
    if (server) try { process.kill(-server.pid); } catch (_) { /* already gone */ }
  }
  console.log(`\nr94_csp: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
