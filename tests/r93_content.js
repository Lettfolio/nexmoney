/* ==========================================================================
   R93 · B — WEBSITE › CONTENT (R93-CONTRACT.md "Admin UI — slice B").

     · #website opens the Content tab: one list of the 14 public pages merged with site_pages rows
       (path · title or "— from HTML" · description-length chip · Edited chip).
     · the page editor (openOverlay): live counts, FAQ editing parked (R93 · fixer: a read-only
       "FAQ ×n" chip; Save leaves faq untouched), Save = upsert by slug,
       Cancel with edits asks confirmDiscard and "Keep editing" keeps what was typed.
     · Guides: list, + New guide, slug auto from title + validated, Markdown preview (siteMdToHtml:
       no raw HTML, no javascript: links), Approve / Publish for the owner only, Archive for anyone;
       an admin's approve is refused by the SQL guard and toasts its message.
     · the publish strip: last publish, Publish site disabled until settings.vercel_deploy_hook is
       set, then invokes site-publish and re-reads the strip.
     · Settings › Integrations carries the vercel_deploy_hook field; site.js has no inline style.
   Expectations are computed at runtime from the mock. Run: node tests/r93_content.js (copy to /tmp
   and patch REPO/PORT for a worktree).
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
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + String(detail).slice(0, 400) : ""}`); }
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

async function waitApp(page) {
  await page.waitForFunction(() => document.querySelector("#app-view") && !document.querySelector("#app-view").classList.contains("hidden") && typeof window.nav === "function", null, { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { try { if (window.tourEnd) window.tourEnd(false); } catch (e) { /* not open */ } });
  await page.waitForTimeout(300);
}
async function boot(browser, persona, hash) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}${hash || ""}`, { waitUntil: "domcontentloaded" });
  await waitApp(page);
  return page;
}
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));
const mockRows = (page, t) => page.evaluate((tt) => JSON.parse(JSON.stringify(window.__mock.db[tt])), t);
const toastText = (page) => page.evaluate(() => (document.getElementById("toast") || {}).textContent || "");
const overlayOpen = (page) => page.evaluate(() => !document.getElementById("overlay-backdrop").classList.contains("hidden"));
async function openWebsite(page) {
  await page.evaluate(() => window.nav("site"));
  await page.waitForFunction(() => document.querySelectorAll("#site-pages-list .site-row").length > 0, null, { timeout: 10000 });
  await page.waitForTimeout(200);
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const pages = [];
  try {
    /* ------------------------------------------------------------------ S. static */
    console.log("\nS · Static");
    const siteSrc = fs.readFileSync(path.join(REPO, "admin/site.js"), "utf8");
    const cssSrc = fs.readFileSync(path.join(REPO, "admin/admin.css"), "utf8");
    const appSrc = fs.readFileSync(path.join(REPO, "admin/app.js"), "utf8");
    const fenceB = (siteSrc.match(/\/\* ===== R93 · B CONTENT ===== \*\/([\s\S]*?)\/\* ===== END R93 · B CONTENT ===== \*\//) || [])[1] || "";
    ok("S1 · site.js has no inline style attribute", (siteSrc.match(/style="/g) || []).length === 0);
    const tops = [...fenceB.matchAll(/^(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    ok("S2 · every top-level name in the B fence starts with `site` (loadSiteContent is the foundation's)", tops.length > 10 && tops.every((n) => /^site/.test(n) || n === "loadSiteContent"), tops.filter((n) => !/^site/.test(n)).join());
    ok("S3 · the B CSS fence sits above the R90 utilities block", cssSrc.indexOf("R93 · B CSS") > 0 && cssSrc.indexOf("R93 · B CSS") < cssSrc.indexOf("/* R90 · C utilities"));
    ok("S4 · Settings › Integrations renders the vercel_deploy_hook_secret field", /<input name="vercel_deploy_hook_secret"/.test(appSrc) && !/name="vercel_deploy_hook"/.test(appSrc));
    ok("S6 · site.js asks site_hook_is_set() and never reads the hook setting", siteSrc.includes('db.rpc("site_hook_is_set")') && !/settings\.vercel_deploy_hook/.test(siteSrc));
    ok("S5 · site.js never calls db.from on anything but the three site tables", [...fenceB.matchAll(/db\.from\("([a-z_]+)"\)/g)].every((m) => ["site_pages", "site_posts", "site_publishes"].includes(m[1])));

    /* ------------------------------------------------------------------ A. owner — pages */
    console.log("\nA · Owner (p4) — the page list and editor");
    const p4 = await boot(browser, "p4", "#website");
    pages.push(p4);
    await openWebsite(p4);
    const fx = await mockRows(p4, "site_pages");
    const list = await p4.evaluate(() => [...document.querySelectorAll("#site-pages-list .site-row")].map((r) => ({
      slug: r.dataset.slug, path: r.querySelector(".t").textContent.trim(), fact: (r.querySelector(".row-fact-t") || {}).textContent || "",
      edited: !!r.querySelector(".site-edited"), desc: (r.querySelector(".site-desc-chip") || {}).className || "", descText: (r.querySelector(".site-desc-chip") || {}).textContent || "",
    })));
    const visible = await p4.evaluate(() => { const el = document.getElementById("page-site-content"); return !!el && !el.classList.contains("hidden") && el.offsetParent !== null; });
    ok("A1 · #website shows the Content panel", visible);
    eq("A2 · the list has 14 rows", list.length, 14);
    eq("A3 · rows follow the sitemap order (home first, T&Cs last)", [list[0].path, list[13].path], ["/", "/share-the-love-terms"]);
    const slugOf = (r) => (r.slug === "/" ? "" : r.slug);
    const wantEdited = list.filter((r) => fx.some((x) => x.slug === slugOf(r))).length;
    eq("A4 · an Edited chip on exactly the rows site_pages holds", list.filter((r) => r.edited).length, wantEdited);
    const tone = (n) => (!n ? "red" : n >= 70 && n <= 160 ? "green" : n >= 50 && n <= 180 ? "amber" : "red");
    const toneOk = list.every((r) => {
      const row = fx.find((x) => x.slug === slugOf(r));
      const n = row && row.meta_description ? row.meta_description.trim().length : 0;
      return r.desc.includes(tone(n)) && (n ? r.descText === `Desc ${n}` : r.descText === "Desc —");
    });
    ok("A5 · every description chip reads its length and tone (green 70–160)", toneOk, JSON.stringify(list.map((r) => r.desc + "|" + r.descText)));
    const factOk = list.every((r) => { const row = fx.find((x) => x.slug === slugOf(r)); return row && row.title ? r.fact === row.title : r.fact === "— from HTML"; });
    ok("A6 · title shows the override, else “— from HTML”", factOk, JSON.stringify(list.map((r) => r.fact)));

    await p4.click("#row-sitepg-about .row-main");
    await p4.waitForSelector("#site-page-editor", { timeout: 5000 });
    ok("A7 · clicking a row opens the page editor overlay", await overlayOpen(p4));
    await p4.fill("#sp-title", "About NexMoney — mortgage advisers in Bournemouth");
    const cnt = await p4.evaluate(() => document.querySelector('[data-count="sp-title"]').textContent);
    eq("A8 · the title counter is live", cnt, String("About NexMoney — mortgage advisers in Bournemouth".length));
    const faqUi = await p4.evaluate(() => ({ add: !!document.getElementById("sp-faq-add"), rows: document.querySelectorAll(".site-faq-row").length, chip: !!document.getElementById("sp-faq-chip") }));
    eq("A9 · no FAQ editor (parked) and no chip on a page without FAQ entries", faqUi, { add: false, rows: 0, chip: false });
    await p4.fill("#sp-meta", "x".repeat(120));
    const metaCls = await p4.evaluate(() => document.querySelector('[data-count="sp-meta"]').className);
    ok("A10 · a 120-character description counts green", /green/.test(metaCls), metaCls);
    await p4.click("#sp-save");
    await p4.waitForTimeout(600);
    const about = (await mockRows(p4, "site_pages")).find((r) => r.slug === "about");
    ok("A11 · Save upserts the slug's row (title, description; faq default; updated_by stamped server-side)", about && about.title === "About NexMoney — mortgage advisers in Bournemouth" && about.meta_description.length === 120
      && Array.isArray(about.faq) && about.faq.length === 0 && about.updated_by === "p4", JSON.stringify(about));
    ok("A12 · the overlay closes and the row now shows Edited", !(await overlayOpen(p4)) && (await p4.evaluate(() => !!document.querySelector("#row-sitepg-about .site-edited"))));

    /* Cancel with edits → confirmDiscard; Keep editing keeps the typed text. */
    await p4.click("#row-sitepg-contact .site-edit");
    await p4.waitForSelector("#site-page-editor");
    await p4.fill("#sp-h1", "Talk to us");
    await p4.click("#sp-cancel");
    await p4.waitForSelector("#ovl-confirm-ok", { timeout: 3000 });
    ok("A13 · Cancel with edits asks before discarding", true);
    await p4.click("#ovl-confirm-cancel");
    await p4.waitForSelector("#site-page-editor", { timeout: 3000 });
    eq("A14 · Keep editing reopens the editor with the typed value", await p4.inputValue("#sp-h1"), "Talk to us");
    await p4.click("#sp-cancel");
    await p4.waitForSelector("#ovl-confirm-ok");
    await p4.click("#ovl-confirm-ok");
    await p4.waitForTimeout(300);
    ok("A15 · Discard closes and writes nothing", !(await overlayOpen(p4)) && !(await mockRows(p4, "site_pages")).some((r) => r.slug === "contact"));
    await p4.click("#row-sitepg-faq .site-edit");
    await p4.waitForSelector("#site-page-editor");
    const faqFx = (await mockRows(p4, "site_pages")).find((r) => r.slug === "faq").faq.length;
    eq("A15b · a page with FAQ entries shows one read-only chip “FAQ ×n”", await p4.evaluate(() => (document.getElementById("sp-faq-chip") || {}).textContent), `FAQ ×${faqFx}`);
    await p4.click("#sp-cancel");
    await p4.waitForTimeout(300);
    ok("A16 · Cancel with no edits just closes", !(await overlayOpen(p4)));

    /* ------------------------------------------------------------------ B. owner — guides */
    console.log("\nB · Owner (p4) — guides");
    const posts0 = await mockRows(p4, "site_posts");
    eq("B1 · the guides list has one row per site_posts row", await p4.evaluate(() => document.querySelectorAll("#site-guides-list .site-row").length), posts0.length);
    const md = await p4.evaluate(() => ({
      h: siteMdToHtml("# One\n## Two\n### Three"),
      inl: siteMdToHtml("**b** and *i* and [ok](https://x.co) [m](mailto:a@b.co) [rel](/faq)"),
      bad: siteMdToHtml("<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)>"),
      lists: siteMdToHtml("- a\n- b\n\n1. c\n2. d\n\n> q"),
    }));
    eq("B2 · siteMdToHtml: headings # to ###", md.h, "<h1>One</h1>\n<h2>Two</h2>\n<h3>Three</h3>");
    ok("B3 · bold, italic and https / mailto / relative links", md.inl.includes("<strong>b</strong>") && md.inl.includes("<em>i</em>") && md.inl.includes('href="https://x.co"') && md.inl.includes('href="mailto:a@b.co"') && md.inl.includes('href="/faq"'), md.inl);
    ok("B4 · no raw HTML and no javascript: link", !/<script|<img|href="javascript/i.test(md.bad) && md.bad.includes("&lt;script&gt;"), md.bad);
    eq("B5 · lists and quotes", md.lists, "<ul><li>a</li><li>b</li></ul>\n<ol><li>c</li><li>d</li></ol>\n<blockquote><p>q</p></blockquote>");

    await p4.click("#site-new-guide");
    await p4.waitForSelector("#site-guide-editor");
    ok("B6 · + New guide opens the guide editor (owner sees Approve and Publish, no Archive yet)", await p4.evaluate(() => !!document.getElementById("sg-approve") && !!document.getElementById("sg-publish") && !document.getElementById("sg-archive")));
    await p4.fill("#sg-title", "Buying at Auction: what's different?");
    eq("B7 · the slug follows the title", await p4.inputValue("#sg-slug"), "buying-at-auction-what-s-different");
    await p4.fill("#sg-excerpt", "e".repeat(60));
    eq("B8 · the excerpt counter reads n/200", await p4.evaluate(() => document.querySelector('[data-count="sg-excerpt"]').textContent), "60/200");
    await p4.fill("#sg-body", "## Speed\n\nYou **exchange** on the day.\n\n<script>x</script>");
    await p4.click("#sg-preview-toggle");
    const pv = await p4.evaluate(() => ({ hidden: document.getElementById("sg-preview").hidden, bodyHidden: document.getElementById("sg-body").hidden, h2: !!document.querySelector("#sg-preview h2"), strong: !!document.querySelector("#sg-preview strong"), script: !!document.querySelector("#sg-preview script") }));
    ok("B9 · Preview renders the Markdown in place of the textarea, with no script element", !pv.hidden && pv.bodyHidden && pv.h2 && pv.strong && !pv.script, JSON.stringify(pv));
    await p4.click("#sg-preview-toggle");
    await p4.fill("#sg-slug", "Bad Slug");
    await p4.click("#sg-save");
    await p4.waitForTimeout(300);
    ok("B10 · an invalid slug refuses the save and marks the field", (await overlayOpen(p4)) && (await p4.evaluate(() => document.getElementById("sg-slug").classList.contains("field-invalid"))) && (await mockRows(p4, "site_posts")).length === posts0.length);
    await p4.fill("#sg-slug", "buying-at-auction");
    await p4.click("#sg-save");
    await p4.waitForTimeout(600);
    let g = (await mockRows(p4, "site_posts")).find((r) => r.slug === "buying-at-auction");
    ok("B11 · Save inserts a draft with the slug, excerpt and body", g && g.status === "draft" && g.excerpt.length === 60 && g.body_md.includes("**exchange**") && g.title === "Buying at Auction: what's different?", JSON.stringify(g));
    ok("B12 · the new guide is on the list", await p4.evaluate((id) => !!document.querySelector(`#site-guides-list [data-guide="${id}"]`), g && g.id));
    await p4.click(`#row-sitegd-${g.id} .site-edit`);
    await p4.waitForSelector("#site-guide-editor");
    eq("B13 · an existing guide keeps its slug (no auto-follow)", await (async () => { await p4.fill("#sg-title", "Buying at auction"); return p4.inputValue("#sg-slug"); })(), "buying-at-auction");
    await p4.click("#sg-approve");
    await p4.waitForTimeout(600);
    g = (await mockRows(p4, "site_posts")).find((r) => r.id === g.id);
    ok("B14 · Approve writes approved (and saves the edit); the trigger stamps approved_by", g.status === "approved" && g.approved_by === "p4" && !!g.approved_at && g.title === "Buying at auction", JSON.stringify(g));
    await p4.click(`#row-sitegd-${g.id} .site-edit`);
    await p4.waitForSelector("#site-guide-editor");
    ok("B15 · an approved guide offers Publish and Archive, not Approve", await p4.evaluate(() => !!document.getElementById("sg-publish") && !!document.getElementById("sg-archive") && !document.getElementById("sg-approve")));
    await p4.click("#sg-publish");
    await p4.waitForTimeout(600);
    g = (await mockRows(p4, "site_posts")).find((r) => r.id === g.id);
    ok("B16 · Publish writes published and published_at", g.status === "published" && !!g.published_at, JSON.stringify(g));
    const badge = await p4.evaluate((id) => (document.querySelector(`#row-sitegd-${id} .site-status`) || {}).textContent, g.id);
    eq("B17 · the list row's badge says published", badge, "published");
    await p4.evaluate((id) => window.__mockDb.from("site_posts").update({ body_md: "Owner tweak." }).eq("id", id), g.id);
    const gOwner = (await mockRows(p4, "site_posts")).find((r) => r.id === g.id);
    ok("B18 · an owner edit of a published guide keeps it published (R93 · fixer)", gOwner.status === "published" && gOwner.approved_by === "p4" && !!gOwner.published_at, JSON.stringify(gOwner));

    /* ------------------------------------------------------------------ D. publish strip */
    console.log("\nD · Owner (p4) — publish strip");
    const pubs0 = await mockRows(p4, "site_publishes");
    const latest = pubs0.slice().sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)))[0];
    const strip0 = await p4.evaluate(() => ({ text: document.getElementById("site-pub-last").textContent, btn: (() => { const b = document.getElementById("site-publish-btn"); return b && { disabled: b.disabled, title: b.title }; })() }));
    ok("D1 · the strip names the latest publish's status", strip0.text.includes(latest.status) && strip0.text.startsWith("Last publish"), strip0.text);
    const hook0 = await p4.evaluate(() => String(settings.vercel_deploy_hook_secret || ""));
    ok("D2 · no deploy hook → Publish site disabled with the Settings pointer", hook0 === "" && strip0.btn && strip0.btn.disabled && strip0.btn.title === "Set the Vercel deploy hook in Settings › Integrations", JSON.stringify(strip0.btn));
    await p4.evaluate(async () => {
      await window.__mockDb.from("settings").upsert([{ key: "vercel_deploy_hook_secret", value: "https://api.vercel.com/v1/integrations/deploy/prj_x/abc" }]);
      await loadSettings();
      window.__mockInvokes = [];
      await loadSiteContent({ refresh: true });
    });
    ok("D3 · with a hook the button is enabled", await p4.evaluate(() => !document.getElementById("site-publish-btn").disabled));
    await p4.click("#site-publish-btn");
    await p4.waitForTimeout(900);
    const inv = await p4.evaluate(() => (window.__mockInvokes || []).map((x) => x.name));
    ok("D4 · Publish site invokes site-publish", inv.includes("site-publish"), inv.join());
    const pubs1 = await mockRows(p4, "site_publishes");
    const newest = pubs1.slice().sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)))[0];
    ok("D5 · a site_publishes row was written and the strip re-read it", pubs1.length === pubs0.length + 1 && (await p4.evaluate(() => document.getElementById("site-pub-last").textContent)).includes(newest.status) && (await p4.evaluate(() => document.getElementById("site-pub-last").textContent)).includes("just now"));
    ok("D6 · the result toasts", /Publish sent/.test(await toastText(p4)), await toastText(p4));
    await p4.evaluate(() => window.nav("settings"));
    await p4.waitForTimeout(900);
    ok("D7 · Settings › Integrations shows the hook field with the saved value", await p4.evaluate(() => { const i = document.querySelector('#set-sec-advanced input[name="vercel_deploy_hook_secret"]'); return !!i && /prj_x/.test(i.value); }));

    /* ------------------------------------------------------------------ C. admin */
    console.log("\nC · Administrator (p1)");
    const p1 = await boot(browser, "p1", "#website");
    pages.push(p1);
    await openWebsite(p1);
    eq("C1 · the admin sees the same 14 pages", await p1.evaluate(() => document.querySelectorAll("#site-pages-list .site-row").length), 14);
    const draft = (await mockRows(p1, "site_posts")).find((r) => r.status === "draft");
    await p1.click(`#row-sitegd-${draft.id} .site-edit`);
    await p1.waitForSelector("#site-guide-editor");
    const acts = await p1.evaluate(() => ({ approve: !!document.getElementById("sg-approve"), publish: !!document.getElementById("sg-publish"), archive: !!document.getElementById("sg-archive"), save: document.getElementById("sg-save").textContent }));
    ok("C2 · no Approve / Publish for an admin; Archive is there", !acts.approve && !acts.publish && acts.archive, JSON.stringify(acts));
    eq("C3 · a draft's save reads “Submit for approval”", acts.save, "Submit for approval");
    await p1.click("#sg-cancel");
    await p1.waitForTimeout(200);
    const r1 = await p1.evaluate((id) => siteGuideSetStatus(id, "approved"), draft.id);
    await p1.waitForTimeout(200);
    const after = (await mockRows(p1, "site_posts")).find((r) => r.id === draft.id);
    ok("C4 · an admin's approve is refused by the SQL guard and toasts its message", r1 === false && after.status === "draft" && /Only the owner can approve/.test(await toastText(p1)), await toastText(p1));
    await p1.click(`#row-sitegd-${draft.id} .site-edit`);
    await p1.waitForSelector("#site-guide-editor");
    await p1.click("#sg-archive");
    await p1.waitForTimeout(600);
    eq("C5 · an admin can archive", (await mockRows(p1, "site_posts")).find((r) => r.id === draft.id).status, "archived");
    const pubd = (await mockRows(p1, "site_posts")).find((r) => r.status === "published");
    await p1.evaluate(async () => { await loadSiteContent({ refresh: true }); });
    await p1.click(`#row-sitegd-${pubd.id} .site-edit`);
    await p1.waitForSelector("#site-guide-editor");
    await p1.fill("#sg-body", pubd.body_md + "\n\nAdmin addition.");
    await p1.click("#sg-save");
    await p1.waitForTimeout(600);
    const demoted = (await mockRows(p1, "site_posts")).find((r) => r.id === pubd.id);
    ok("C6 · an admin edit of a published guide demotes it to draft and clears the approval (R93 · fixer)", demoted.status === "draft" && demoted.approved_by === null && demoted.approved_at === null && demoted.published_at === null && /Admin addition/.test(demoted.body_md), JSON.stringify(demoted));

    /* ------------------------------------------------------------------ E. console */
    console.log("\nE · Console");
    pages.forEach((pg, i) => ok(`E${i + 1} · no console errors (${["p4", "p1"][i]})`, realErr(pg).length === 0, realErr(pg).join(" | ")));
  } catch (e) {
    failures.push("CRASH — " + (e && e.stack || e));
    console.log("CRASH", e);
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (_) { /* already gone */ }
  }
  console.log(`\nR93 CONTENT: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
