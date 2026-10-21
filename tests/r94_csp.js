/* ============================================================================
   R94 · C — tests/r94_csp.js

   THE TWO CONTENT-SECURITY-POLICIES IN vercel.json, PROVEN AGAINST THE PAGES.

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
   ========================================================================== */
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const REPO = "/root/nx";
const PORT = 8099;
const ORIGIN = `http://localhost:${PORT}`;
const SUPA = "https://sclghkmvzpwtmnzbkaoe.supabase.co";

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
  const siteE = cspEntries.find((e) => e.source === "/(.*)");
  const adminE = cspEntries.find((e) => e.source === "/admin/:path*");
  ok("A1 · exactly two CSP entries: site /(.*) and /admin/:path*", cspEntries.length === 2 && !!siteE && !!adminE, JSON.stringify(cspEntries.map((e) => e.source)));
  ok("A2 · the /admin entry comes AFTER the site entry (same key: the later match is what ships)", !!siteE && !!adminE && adminE.i > siteE.i);
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
  ok("A8 · site script-src is 'self' 'unsafe-inline' only (no third-party script on the public site)",
    JSON.stringify(SITE["script-src"]) === JSON.stringify(["'self'", "'unsafe-inline'"]), JSON.stringify(SITE["script-src"]));
  ok("A9 · no realtime: admin connect-src has no wss:// (the code opens no channel)",
    !sourcesFor(ADMIN, "connect-src").some((s) => /^wss:/.test(s)) && !/\.channel\(/.test(["core", "reports-money", "diary", "import", "vault", "site", "app"].map((f) => read(`admin/${f}.js`)).join("\n")));

  // Every external origin the source names must be allowed by the policy that serves it.
  const extScripts = (html) => [...html.matchAll(/<script\b[^>]*\bsrc="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  const extStyles = (html) => [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).filter((t) => /rel="stylesheet"/.test(t))
    .map((t) => (t.match(/href="(https?:\/\/[^"]+)"/) || [])[1]).filter(Boolean);
  const adminHtml = ["admin/index.html", "admin/introducer.html"];
  const adminJs = ["core", "reports-money", "diary", "import", "vault", "site", "app"].map((f) => `admin/${f}.js`);
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
  const siteFns = siteFiles.flatMap((f) => [...read(f).matchAll(/https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1[^"' ]*/g)].map((m) => m[0]));
  ok("A17 · site: every edge-function URL (new-lead, fact-find, docs/feedback FN_BASE) is in connect-src",
    siteFns.length >= 4 && siteFns.every((u) => allowed(SITE, "connect-src", u)), JSON.stringify(siteFns));
  ok("A18 · site: guide cover / Markdown images (any https:// URL an author types) are in img-src",
    allowed(SITE, "img-src", "https://images.example.com/cover.jpg") && allowed(SITE, "font-src", "https://fonts.gstatic.com/s/inter/v1/x.woff2"));

  const evalish = /\beval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\s*\(\s*["'`]/;
  const evalHits = adminJs.concat(["admin/sw.js", "enhance.js"]).filter((f) => evalish.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
  ok("A19 · no eval / new Function / string timers in the shipped JS (script-src has no 'unsafe-eval')", evalHits.length === 0, JSON.stringify(evalHits));

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
      if (inj.length) body = body.replace(/<\/body>/i, inj.map((k) => `<script>${INJECT[k]}</script>`).join("") + "</body>");
      await route.fulfill({ response: resp, body, headers: { ...resp.headers(), "content-security-policy": policy } });
    });
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
