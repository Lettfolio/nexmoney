// tests/r97_client.js — R97 · C: the client slice of the red-team fixes (R97-VERIFY.md §3 "C · client").
//
//   §A  C-3 openClient race: open A, then B while A's find_duplicate_clients is held back → the modal,
//       the hash and the stale-write stamp all belong to B; a lone open still paints
//   §B  C-8 fact-find mailto: a hostile client email ("victim@x.com?bcc=…") yields ONE recipient and no
//       header parameter beyond subject/body
//   §C  C-6 vault purge: after db.auth.signOut() the !session path empties #vault-list, VAULT_ROWS and
//       every [data-val]
//   §D  C-5 / C-7 static: the bulk task-close goes through inChunks; the introducer sign-out reloads
//   §Z  no console errors
//
// Expectations are read from the mock at runtime (no hard-coded ids, names or dates).
// Run:  node /root/nx/tests/r97_client.js
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

const DESK = { width: 1440, height: 900 };
async function boot(browser, persona) {
  const ctx = await browser.newContext({ viewport: DESK, locale: "en-GB", timezoneId: "Europe/London" });
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
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const wait = (page, ms) => page.waitForTimeout(ms);

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  const errLog = [];
  try {
    /* ------------------------------------------------------------------ §A */
    console.log("\n— §A · C-3 openClient: a slow first open never repaints over the second (p2)");
    {
      const page = await boot(browser, "p2");
      const r = await page.evaluate(async () => {
        const pick = window.__mock.db.clients.filter((c) => c.first_name && c.last_name).slice(0, 2);
        const ids = pick.map((c) => c.id);
        const names = pick.map((c) => c.first_name + " " + c.last_name);
        const orig = db.rpc.bind(db);
        let n = 0;
        db.rpc = (name, ...a) => {
          const res = orig(name, ...a);
          if (name === "find_duplicate_clients" && n++ === 0) return new Promise((ok) => setTimeout(() => ok(res), 1200));
          return res;
        };
        const pA = window.openClient(ids[0]);
        await new Promise((x) => setTimeout(x, 50));
        const pB = window.openClient(ids[1]);
        await Promise.all([pA, pB]);
        await new Promise((x) => setTimeout(x, 300));
        db.rpc = orig;
        const t = document.querySelector("#modal").textContent;
        const stampB = (window.__mock.db.clients.find((c) => c.id === ids[1]) || {}).updated_at;
        return { ids, names, delayedCalls: n, showsA: t.includes(names[0]), showsB: t.includes(names[1]), hash: location.hash,
          stampIsB: typeof openedClientUpdatedAt === "undefined" ? "n/a" : openedClientUpdatedAt === stampB };
      });
      ok("A0 · the first open's dedupe RPC really was held back (both opens called it)", r.delayedCalls >= 2, JSON.stringify(r));
      ok("A1 · the modal shows B", r.showsB, JSON.stringify(r));
      ok("A2 · …and not A (the stale open returned before its paint)", !r.showsA, JSON.stringify(r));
      eq("A3 · the hash is #client/<B>", r.hash, `#client/${r.ids[1]}`);
      ok("A4 · the stale-write stamp is B's updated_at", r.stampIsB === true, JSON.stringify(r.stampIsB));
      const lone = await page.evaluate(async (id) => {
        if (window.closeModal) window.closeModal();
        await window.openClient(id);
        return { hash: location.hash, open: !!document.querySelector("#modal") && document.querySelector("#modal").textContent.length > 50 };
      }, r.ids[0]);
      ok("A5 · a lone open still paints (the guard lets the newest open through)", lone.open && lone.hash === `#client/${r.ids[0]}`, JSON.stringify(lone));
      errLog.push(["A", realErrs(page)]);
      await page.context().close();
    }

    /* ------------------------------------------------------------------ §B */
    console.log("\n— §B · C-8 fact-find mailto: one recipient, whatever the stored email holds (p4)");
    {
      const page = await boot(browser, "p4");
      const hostile = "victim@x.com?bcc=evil%40attacker.com&cc=evil2@attacker.com";
      const r = await page.evaluate(async (email) => {
        const db = window.__mockDb;
        const { data: cl, error: ce } = await db.from("clients").insert({ first_name: "R97", last_name: "Mailto", email, phone: "07700900123" }).select("id").single();
        if (ce) return { err: "client: " + ce.message };
        const { data: cs, error: se } = await db.from("cases").insert({ client_id: cl.id, case_kind: "purchase", stage: "fact_find", assigned_to: "p4" }).select("id").single();
        if (se) return { err: "case: " + se.message };
        const opened = [];
        const realOpen = window.open;
        window.open = (u) => { opened.push(String(u)); return null; };
        try {
          await window.factFind(cs.id, cl.id);
          await new Promise((x) => setTimeout(x, 400));
          const btn = document.querySelector("#ff-mail");
          if (!btn) return { err: "no #ff-mail" };
          await btn.onclick();
          await new Promise((x) => setTimeout(x, 300));
        } finally { window.open = realOpen; }
        if (window.closeModal) window.closeModal();
        return { opened };
      }, hostile);
      ok("B0 · the fact-find mailto was opened", !r.err && r.opened && r.opened.length === 1, JSON.stringify(r));
      const url = (r.opened || [""])[0];
      const q = url.indexOf("?");
      const to = decodeURIComponent(url.slice("mailto:".length, q < 0 ? undefined : q));
      const keys = q < 0 ? [] : url.slice(q + 1).split("&").map((kv) => kv.split("=")[0].toLowerCase());
      eq("B1 · the only header parameters are subject and body (no bcc/cc/to smuggled in)", keys, ["subject", "body"]);
      eq("B2 · the recipient part decodes to the stored address, verbatim, as ONE address", to, hostile);
      ok("B3 · the @ stays readable in the recipient (mailLink's rule)", url.startsWith("mailto:victim@x.com"), url.slice(0, 60));
      errLog.push(["B", realErrs(page)]);
      await page.context().close();
    }

    /* ------------------------------------------------------------------ §C */
    console.log("\n— §C · C-6 vault purge on sign-out (p4)");
    {
      const page = await boot(browser, "p4");
      await page.evaluate(() => window.nav("vault"));
      await wait(page, 1500);
      const before = await page.evaluate(() => ({ vals: document.querySelectorAll("#vault-list [data-val]").length, rows: VAULT_ROWS.length }));
      ok("C0 · the vault painted masked secrets first", before.vals > 0 && before.rows > 0, JSON.stringify(before));
      await page.evaluate(async () => { await db.auth.signOut(); });
      await wait(page, 800);
      const after = await page.evaluate(() => ({
        login: !document.querySelector("#login-view").classList.contains("hidden"),
        list: document.querySelector("#vault-list").innerHTML, vals: document.querySelectorAll("[data-val]").length, rows: VAULT_ROWS.length,
      }));
      ok("C1 · the login card is up", after.login, JSON.stringify(after));
      eq("C2 · #vault-list, [data-val] and VAULT_ROWS are all empty", [after.list, after.vals, after.rows], ["", 0, 0]);
      errLog.push(["C", realErrs(page)]);
      await page.context().close();
    }

    /* ------------------------------------------------------------------ §D */
    console.log("\n— §D · C-5 / C-7 static");
    {
      const app = fs.readFileSync(path.join(REPO, "admin", "app.js"), "utf8");
      const intro = fs.readFileSync(path.join(REPO, "admin", "introducer.js"), "utf8");
      ok("D1 · C-5: no unchunked .in(\"case_id\", movedIds) is left", !/\.in\("case_id", movedIds\)/.test(app));
      ok("D2 · C-5: the bulk task close runs through inChunks(movedIds, …)", /inChunks\(movedIds, \(sl\) => db\.from\("case_tasks"\)/.test(app));
      const out = (intro.match(/\$\("#logout-btn"\)\.addEventListener\("click", async \(\) => \{([^}]*)\}/) || [])[1] || "";
      ok("D3 · C-7: introducer sign-out awaits signOut then reloads (no DOM left behind)", /await db\.auth\.signOut\(\);\s*location\.reload\(\);/.test(out) && !/showLogin/.test(out), out);
    }

    console.log("\n— §Z · no console errors");
    errLog.forEach(([sec, e]) => ok(`Z · §${sec} raised no console/page errors`, e.length === 0, JSON.stringify(e)));
  } catch (e) {
    ok("suite ran without throwing", false, String(e && e.stack || e));
  } finally {
    await browser.close();
    if (server) try { process.kill(-server.pid); } catch (e) { /* ignore */ }
  }
  console.log("\n================================================================");
  console.log(`r97_client: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
