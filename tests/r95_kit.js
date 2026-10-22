#!/usr/bin/env node
/* =============================================================================
   tests/r95_kit.js — R95 · B, the DELEGATION KIT in admin/core.js (R95-CONTRACT "The delegation
   kit"). Markup is injected into a sandbox on the mock page; handlers are window globals that
   record what they received.

     §A  data-act / data-args — args reach the global; "$event" / "$this" substituted; no args → [].
     §B  data-on — change / input / submit / keydown fire only their own [data-act]; click default.
     §C  preventDefault — a[href="#"] click and data-on="submit" are prevented; other clicks are not.
     §D  unknown name — console.error ONCE per name, never throws.
     §E  nesting — the nearest matching [data-act] wins; data-stop is a click barrier that also
         skips later document listeners; a change-act inside a click-act lets clicks through.
     §F  ev.currentTarget and `this` are the [data-act] element; closest() works on it.
     §G  error / toggle (non-bubbling) dispatch on the element itself; actAttr escapes for an attribute.
     §H  admin/app.js carries no inline handler and no javascript: URL.

   Run:  node /root/nx/tests/r95_kit.js
   ========================================================================== */
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

async function ensureServer() {
  const up = await new Promise((res) => {
    const req = http.get(BASE, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
  });
  if (up) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1200));
  return srv;
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-GB", timezoneId: "Europe/London" });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push("pageerror:" + String(e)));
    page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
    page.on("dialog", (d) => d.dismiss());
    await page.goto(`${BASE}?as=p1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });

    const r = await page.evaluate(() => {
      const W = window;
      const log = [];
      W.__kA = function (...a) { log.push({ fn: "A", self: this, args: a }); };
      W.__kB = function (...a) { log.push({ fn: "B", self: this, args: a }); };
      W.__kCT = function (ev) { log.push({ fn: "CT", ct: ev.currentTarget, panel: ev.currentTarget.closest(".k-panel"), self: this }); };
      W.__kThrow = function () { log.push({ fn: "T" }); };
      let docHits = 0;
      document.addEventListener("click", () => { docHits++; });
      const sb = document.createElement("div");
      sb.id = "k-sb";
      sb.innerHTML = `
        <button id="k1" ${W.actAttr("__kA", "c-1", 3, { toMe: true })}>a</button>
        <button id="k2" ${W.actAttr("__kA", "$event", "$this", "x")}>b</button>
        <button id="k3" ${W.actAttr("__kA")}>c</button>
        <select id="k4" data-on="change" ${W.actAttr("__kA", "$this")}><option value="1">1</option><option value="2">2</option></select>
        <input id="k5" data-on="input" ${W.actAttr("__kB", "$this")}>
        <form id="k6" data-on="submit" ${W.actAttr("__kA", "$event")}><button id="k6b" type="submit">s</button></form>
        <a id="k7" href="#" ${W.actAttr("__kA", "link")}>l</a>
        <button id="k8" ${W.actAttr("__kNoSuchFn")}>u</button>
        <div id="k9" ${W.actAttr("__kA", "outer")}><span><button id="k9i" ${W.actAttr("__kB", "inner")}>n</button></span><em id="k9t">t</em></div>
        <div id="k10" ${W.actAttr("__kA", "row")}><span id="k10s" data-stop><i id="k10i">stopped</i></span><button id="k10b" data-stop ${W.actAttr("__kB", "verb")}>v</button></div>
        <div id="k11" ${W.actAttr("__kA", "card")}><select id="k11s" data-on="change" ${W.actAttr("__kB", "$this")}><option>1</option><option>2</option></select></div>
        <div class="k-panel"><h3 id="k12" ${W.actAttr("__kCT", "$event")}><span id="k12s">head</span></h3></div>
        <input id="k13" data-on="keydown" ${W.actAttr("__kB", "$event")}>
        <a id="k14" href="#somewhere" data-prevent ${W.actAttr("__kA", "p")}>p</a>
        <a id="k15" href="#k-nowhere" ${W.actAttr("__kA", "np")}>np</a>
        <details id="k16" data-on="toggle" ${W.actAttr("__kB", "$this")}><summary>s</summary>x</details>
        <img id="k17" alt="" data-on="error" ${W.actAttr("__kB", "img", "$this")}>`;
      document.querySelector("main").appendChild(sb);
      const $ = (s) => sb.querySelector(s);
      const take = () => log.splice(0);
      const click = (s) => { const ev = new MouseEvent("click", { bubbles: true, cancelable: true }); const res = $(s).dispatchEvent(ev); return { prevented: !res }; };
      const out = {};

      click("#k1"); out.a1 = take();
      click("#k2"); out.a2 = take();
      click("#k3"); out.a3 = take();
      out.a1ok = out.a1.length === 1 && JSON.stringify(out.a1[0].args) === JSON.stringify(["c-1", 3, { toMe: true }]);
      out.a2ok = out.a2.length === 1 && out.a2[0].args[0] instanceof MouseEvent && out.a2[0].args[1] === $("#k2") && out.a2[0].args[2] === "x";
      out.a3ok = out.a3.length === 1 && out.a3[0].args.length === 0;
      out.selfOk = out.a1[0] && out.a1[0].self === $("#k1");

      click("#k4"); out.b1 = take().length;          // a click on a change-act does nothing
      $("#k4").value = "2"; $("#k4").dispatchEvent(new Event("change", { bubbles: true })); const b2 = take();
      out.b2ok = b2.length === 1 && b2[0].args[0] === $("#k4") && b2[0].args[0].value === "2";
      $("#k5").value = "q"; $("#k5").dispatchEvent(new Event("input", { bubbles: true })); const b3 = take();
      out.b3ok = b3.length === 1 && b3[0].fn === "B" && b3[0].args[0].value === "q";
      $("#k13").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); const b4 = take();
      out.b4ok = b4.length === 1 && b4[0].args[0].key === "Enter";
      const sev = new Event("submit", { bubbles: true, cancelable: true }); $("#k6").dispatchEvent(sev); const c1 = take();
      out.c1ok = c1.length === 1 && sev.defaultPrevented && c1[0].args[0] === sev;
      out.c2 = click("#k7"); out.c2n = take().length;
      out.c3 = click("#k14"); out.c3n = take().length;
      out.c4 = click("#k15"); out.c4n = take().length;
      out.c5 = click("#k1"); take();

      const errsBefore = W.__errLogLenProbe;
      let threw = false;
      try { click("#k8"); click("#k8"); } catch (e) { threw = true; }
      out.d = { threw, errsBefore };

      click("#k9i"); const e1 = take();
      out.e1ok = e1.length === 1 && e1[0].fn === "B" && e1[0].args[0] === "inner";
      click("#k9t"); const e2 = take();
      out.e2ok = e2.length === 1 && e2[0].args[0] === "outer";
      const d0 = docHits; click("#k10i"); const e3 = take();
      out.e3ok = e3.length === 0 && docHits === d0;
      const d1 = docHits; click("#k10b"); const e4 = take();
      out.e4ok = e4.length === 1 && e4[0].args[0] === "verb" && docHits === d1;
      const d2 = docHits; click("#k10"); take(); out.e5ok = docHits === d2 + 1;   // no barrier → later listeners run
      click("#k11s"); const e6 = take();
      out.e6ok = e6.length === 1 && e6[0].args[0] === "card";
      $("#k11s").selectedIndex = 1; $("#k11s").dispatchEvent(new Event("change", { bubbles: true })); const e7 = take();
      out.e7ok = e7.length === 1 && e7[0].fn === "B";

      click("#k12s"); const f1 = take();
      out.fok = f1.length === 1 && f1[0].ct === $("#k12") && f1[0].panel === sb.querySelector(".k-panel") && f1[0].self === $("#k12");

      out.attr = W.actAttr("f", `a"b'<c>&`, null, 2);
      const probe = document.createElement("div"); probe.innerHTML = `<b ${out.attr}></b>`;
      out.attrBack = JSON.parse(probe.firstChild.getAttribute("data-args"));
      out.attrNoArgs = W.actAttr("g");
      return out;
    });

    ok("A1 · data-args reach the global as JSON values (string, number, object)", r.a1ok);
    ok("A2 · \"$event\" → the event, \"$this\" → the element", r.a2ok);
    ok("A3 · no data-args → called with no arguments", r.a3ok);
    ok("A4 · `this` inside the handler is the [data-act] element", r.selfOk);
    ok("B1 · a click on a data-on=\"change\" element dispatches nothing", r.b1 === 0, String(r.b1));
    ok("B2 · change dispatches with $this (live value)", r.b2ok);
    ok("B3 · input dispatches", r.b3ok);
    ok("B4 · keydown dispatches with $event", r.b4ok);
    ok("C1 · submit dispatches and is preventDefault'ed", r.c1ok);
    ok("C2 · a[href=\"#\"] click is prevented and dispatched", r.c2.prevented && r.c2n === 1, JSON.stringify(r.c2));
    ok("C3 · data-prevent prevents a real-href anchor", r.c3.prevented && r.c3n === 1);
    ok("C4 · a real-href anchor without data-prevent is NOT prevented", !r.c4.prevented && r.c4n === 1);
    ok("C5 · a plain button click is not prevented", !r.c5.prevented);
    const unk = errs.filter((e) => /__kNoSuchFn/.test(e));
    ok("D1 · an unknown name never throws", !r.d.threw);
    ok("D2 · …and logs console.error exactly once per name", unk.length === 1, JSON.stringify(unk));
    ok("E1 · nested [data-act]: the closest wins (inner only)", r.e1ok);
    ok("E2 · a click elsewhere in the outer runs the outer", r.e2ok);
    ok("E3 · data-stop: no outer act and no later document listener", r.e3ok);
    ok("E4 · data-stop on an act: the act runs, later document listeners do not", r.e4ok);
    ok("E5 · without data-stop later document listeners still run", r.e5ok);
    ok("E6 · a click on a change-act inside a click-act reaches the click-act", r.e6ok);
    ok("E7 · a change on that select runs only the change-act", r.e7ok);
    ok("F1 · ev.currentTarget is the [data-act] element and closest() works on it; this === element", r.fok);
    ok("G1 · actAttr escapes for an attribute and round-trips through JSON", JSON.stringify(r.attrBack) === JSON.stringify([`a"b'<c>&`, null, 2]) && !/["'<>]/.test(r.attr.replace(/^data-act="f" data-args="/, "").replace(/"$/, "")), r.attr);
    ok("G2 · actAttr with no args emits data-act only", r.attrNoArgs === 'data-act="g"', r.attrNoArgs);

    /* toggle / error do not bubble — the capture listeners catch them on the element itself. */
    const g = await page.evaluate(async () => {
      const log = [];
      window.__kB = (...a) => log.push(a);
      document.querySelector("#k16").open = true;
      const img = document.querySelector("#k17");
      img.src = "/does-not-exist-r95.png";
      await new Promise((res) => setTimeout(res, 800));
      return { toggled: log.some((a) => a[0] && a[0].id === "k16"), img: log.some((a) => a[0] === "img" && a[1] && a[1].id === "k17") };
    });
    ok("G3 · data-on=\"toggle\" on <details> dispatches", g.toggled);
    ok("G4 · data-on=\"error\" on <img> dispatches", g.img);

    const other = errs.filter((e) => !/__kNoSuchFn|does-not-exist-r95|Failed to load resource|ERR_|favicon|fonts\.g/i.test(e));
    ok("G5 · no other console / page errors", other.length === 0, other.join(" | "));
    await ctx.close();

    const app = fs.readFileSync(path.join(REPO, "admin", "app.js"), "utf8");
    const core = fs.readFileSync(path.join(REPO, "admin", "core.js"), "utf8");
    const inl = app.match(/ on[a-z]+="/g) || [];
    ok("H1 · admin/app.js has no inline on*=\"…\" handler", inl.length === 0, String(inl.length));
    ok("H2 · admin/app.js has no javascript: URL", !/javascript:/.test(app));
    ok("H3 · core.js: the kit is fenced", /\/\* ===== R95 DELEGATION KIT =====/.test(core) && /\/\* ===== END R95 DELEGATION KIT ===== \*\//.test(core));
    ok("H4 · the chip-strip overflow wiring is gone", !/wireChipStripOverflow/.test(app));
  } catch (e) {
    failures.push("HARNESS: " + (e && e.stack || e));
    console.log("  ✗ HARNESS: " + (e && e.stack || e));
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) { /* already gone */ } }
  }
  console.log(`\nR95 KIT: ${pass + failures.length} checks, ${failures.length} failures`);
  if (failures.length) { console.log(failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
})();
