/* ==========================================================================
   R89 · C — SETTINGS AS FIVE TABS, ONE SAVE, ONE SOURCE (R89-DESIGN slice C; panel 05 #4, #5, #12).

   The contract:
     · Owner / Administrator: five tabs (Firm & rules / Automations / Integrations / Team & security /
       Data) through the page-tab kit — #settings/<tab>, the choice persisted per user, the jump-nav
       chips gone. An adviser: no strip at all — My details + Security only, hash #settings.
     · ONE Save: the sticky #settings-save footer, shown for the Owner on the three form tabs and on
       no other; it saves EVERY changed field on EVERY form tab and writes nothing the reader did not
       touch. A tab switch never re-renders the form (an edit on another tab survives it).
     · SINGLE SOURCE: your own phone and sign-off are editable exactly once (My details); your roster
       row shows them read-only with "Edit in My details"; other people stay editable for the Owner.
       adviser_phone / adviser_name / google_review_link are not fields; review_platform_link is, once.
     · Phone 390: the active tab is in view, tabs and Save are 44px, no sideways page scroll.
     · No console errors on any tab for p4 / p1 / p2.
   Expectations are computed at runtime. Run: node tests/r89_settings.js (copy to /tmp and patch
   REPO/PORT for a worktree).
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

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

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const TAB_KEYS = ["firm", "automations", "integrations", "team", "data"];
const FORM_TABS = ["firm", "automations", "integrations"];

async function waitApp(page) {
  await page.waitForFunction(() => document.querySelector("#app-view") && !document.querySelector("#app-view").classList.contains("hidden") && typeof window.nav === "function", null, { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { try { if (window.tourEnd) window.tourEnd(false); } catch (e) { /* not open */ } });
  await page.waitForTimeout(300);
}
async function boot(browser, persona, o) {
  const opts = o || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || DESK, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}${opts.hash || ""}`, { waitUntil: "domcontentloaded" });
  await waitApp(page);
  page.__ctx = ctx;
  return page;
}
async function reloadAt(page, persona, hash) {
  await page.goto(`${BASE}?as=${persona}${hash}`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitApp(page);
}
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));
const go = async (page, id, ms) => { await page.evaluate((p) => window.nav(p), id); await page.waitForTimeout(ms == null ? 1500 : ms); };
const clickTab = async (page, key, ms) => { await page.click(`#settings-tabs-${key}`); await page.waitForTimeout(ms == null ? 500 : ms); };
/* What is on screen in Settings. */
const state = (page) => page.evaluate(() => {
  const vis = (el) => !!el && !el.classList.contains("hidden") && el.offsetParent !== null;
  const root = document.getElementById("page-settings");
  const saveBtns = [...root.querySelectorAll("button")].filter((b) => vis(b) && /^\s*Save\b/.test(b.textContent));
  return {
    page: currentPage, tab: currentPageTab(), hash: location.hash, title: document.title,
    strip: [...document.querySelectorAll("#settings-tabs > .seg-btn")].map((b) => ({ key: b.dataset.tab, label: b.textContent.trim(), pressed: b.getAttribute("aria-pressed") })),
    shownPanels: [...root.querySelectorAll("[data-tabpanel]")].filter((p) => !p.classList.contains("hidden")).map((p) => p.dataset.tabpanel),
    form: vis(document.getElementById("settings-form")),
    footer: vis(document.getElementById("settings-save")),
    saveBtns: saveBtns.map((b) => b.id || b.textContent.trim()),
    visFields: [...document.querySelectorAll("#settings-form [name]")].filter((el) => el.offsetParent !== null || (el.closest(".set-switch-wrap") && el.closest(".set-switch-wrap").offsetParent !== null)).length,
  };
});
const pressed = (strip) => strip.filter((b) => b.pressed === "true").map((b) => b.key);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {
    /* ------------------------------------------------------------------ A. owner, desktop */
    console.log("\nA · Owner (p4) — five tabs, hash, persistence, one Save");
    const p4 = await boot(browser, "p4");
    await p4.evaluate(() => {
      window.__settingsRenders = 0;
      const f = window.renderSettings;
      window.renderSettings = renderSettings = function () { window.__settingsRenders++; return f.apply(this, arguments); };   // eslint-disable-line no-global-assign
    }).catch(() => {});
    await go(p4, "settings", 2500);
    let s = await state(p4);
    eq("A1 · five tabs in order", s.strip.map((b) => b.label), ["Firm & rules", "Automations", "Integrations", "Team & security", "Data"]);
    eq("A2 · a first visit lands on Firm & rules", pressed(s.strip), ["firm"]);
    eq("A3 · …hash #settings/firm", s.hash, "#settings/firm");
    ok("A4 · …the title names the tab", /^Settings › Firm & rules · /.test(s.title), s.title);
    ok("A5 · only the Firm & rules panels are shown", s.shownPanels.length >= 1 && s.shownPanels.every((k) => k === "firm"), JSON.stringify(s.shownPanels));
    const jump = await p4.evaluate(() => ({ bar: !!document.getElementById("settings-jump"), chips: document.querySelectorAll("[data-settings-jump]").length }));
    eq("A6 · the jump-nav chip strip is gone", jump, { bar: false, chips: 0 });

    for (const k of TAB_KEYS) {
      if (k !== "firm") await clickTab(p4, k);
      s = await state(p4);
      const form = FORM_TABS.includes(k);
      ok(`A7 · ${k}: hash #settings/${k}, pressed, only its panels shown`, s.hash === `#settings/${k}` && pressed(s.strip).join() === k && s.shownPanels.every((x) => x === k) && s.shownPanels.length >= 1, JSON.stringify(s));
      if (form) eq(`A8 · ${k}: exactly one visible Save — the sticky footer's`, s.saveBtns, ["save-settings-btn"]);
      else ok(`A8 · ${k}: no settings Save footer`, !s.footer && !s.saveBtns.includes("save-settings-btn"), JSON.stringify(s.saveBtns));
      if (k === "data") eq("A9 · Data: no Save button at all", s.saveBtns, []);
      if (form) ok(`A10 · ${k}: the form shows fields`, s.form && s.visFields > 0, JSON.stringify(s));
      else ok(`A10 · ${k}: the form takes no room`, !s.form, JSON.stringify(s));
    }
    const sticky = await p4.evaluate(() => getComputedStyle(document.getElementById("settings-save")).position);
    eq("A11 · the Save footer is sticky", sticky, "sticky");
    const renders = await p4.evaluate(() => window.__settingsRenders);
    ok("A12 · one render for the visit — opening four more tabs did not re-render the form", renders === 1 || renders === undefined, String(renders));

    /* single source */
    const src = await p4.evaluate(() => {
      const mine = PROFILES.find((p) => p.id === ME.id) || {};
      const editable = (el) => !el.disabled && !el.readOnly && el.type !== "hidden";
      const all = [...document.querySelectorAll("input, textarea")].filter(editable);
      const signoffNorm = (v) => String(v || "").replace(/\s+/g, " ").trim();
      return {
        phone: mine.phone, phoneEditors: all.filter((el) => mine.phone && el.value === mine.phone).map((el) => el.id || el.className || el.name),
        signoffEditors: all.filter((el) => mine.email_signoff && signoffNorm(el.value) === signoffNorm(mine.email_signoff)).map((el) => el.id || el.className || el.name),
        advPhoneField: document.querySelectorAll('[name="adviser_phone"]').length,
        advNameField: document.querySelectorAll('[name="adviser_name"]').length,
        google: document.querySelectorAll('[name="google_review_link"]').length,
        review: document.querySelectorAll('[name="review_platform_link"]').length,
        reviewTab: (document.querySelector('[name="review_platform_link"]') || { closest: () => null }).closest("[data-tabpanel]")?.dataset.tabpanel,
        selfRo: (document.getElementById("team-self-contact") || {}).textContent || "",
        selfEdit: (document.getElementById("team-self-edit") || {}).textContent || "",
        selfInputs: document.querySelectorAll(`#team-roster .team-phone[data-id="${ME.id}"], #team-roster .team-signoff[data-id="${ME.id}"]`).length,
        otherPhones: document.querySelectorAll("#team-roster .team-phone").length,
        rosterRows: document.querySelectorAll("#team-roster .team-row").length,
      };
    });
    ok("A13 · the fixture gives the owner a phone and a sign-off", !!src.phone && src.signoffEditors.length > 0, JSON.stringify(src));
    eq("A14 · your phone is editable in exactly ONE place: My details", src.phoneEditors, ["my-phone"]);
    eq("A15 · your sign-off is editable in exactly ONE place: My details", src.signoffEditors, ["my-signoff"]);
    eq("A16 · adviser_phone / adviser_name are not settings fields", [src.advPhoneField, src.advNameField], [0, 0]);
    eq("A17 · google_review_link is not a field", src.google, 0);
    eq("A18 · review_platform_link is a field exactly once (Automations)", [src.review, src.reviewTab], [1, "automations"]);
    ok("A19 · your roster row shows your phone read-only", src.selfRo.includes(src.phone) && src.selfInputs === 0, JSON.stringify(src));
    eq("A20 · …with the door to My details", src.selfEdit.trim(), "Edit in My details");
    eq("A21 · other people's rows stay editable for the Owner", src.otherPhones, src.rosterRows - 1);

    await clickTab(p4, "team");
    await p4.click("#team-self-edit");
    await p4.waitForTimeout(900);
    const door2 = await p4.evaluate(() => ({ tab: currentPageTab(), focus: document.activeElement && document.activeElement.id, top: Math.round(document.getElementById("my-details-panel").getBoundingClientRect().top) }));
    ok("A22 · “Edit in My details” brings My details into view with the phone box focused", door2.tab === "team" && door2.focus === "my-phone" && door2.top >= -2 && door2.top < 500, JSON.stringify(door2));

    /* persistence + hash */
    await go(p4, "dashboard", 1200);
    await go(p4, "settings", 2000);
    s = await state(p4);
    eq("A24 · coming back to Settings reopens the last tab (Team & security)", [s.tab, s.hash], ["team", "#settings/team"]);
    const stored = await p4.evaluate(() => lsGet(userKey("nx_tab_settings")));
    eq("A25 · …stored per user as nx_tab_settings_<uid>", stored, "team");
    await reloadAt(p4, "p4", "#settings/data");
    s = await state(p4);
    eq("A26 · a cold #settings/data opens Data", [s.page, s.tab, s.hash], ["settings", "data", "#settings/data"]);
    await reloadAt(p4, "p4", "#settings");
    s = await state(p4);
    eq("A27 · a bare #settings opens the stored tab", [s.tab, s.hash], ["data", "#settings/data"]);
    await go(p4, "settings/team", 1500);
    s = await state(p4);
    eq("A28 · nav('settings/team') → #settings/team", [s.tab, s.hash], ["team", "#settings/team"]);

    /* golive rows jump across tabs */
    await clickTab(p4, "firm");
    const gl = await p4.evaluate(async () => {
      const out = {};
      const hit = async (id) => { activatePageTab("settings", "firm"); document.getElementById(id).click(); await new Promise((r) => setTimeout(r, 400)); return currentPageTab(); };
      out.docchase = await hit("golive-docchase");
      out.review = await hit("golive-reviewlink");
      out.targets = await hit("golive-targets");
      out.phone = await hit("golive-phone");
      out.phoneFocus = document.activeElement && document.activeElement.id;
      return out;
    });
    eq("A29 · a go-live row opens the tab that holds its control (doc chase → Firm & rules, review link → Automations, targets / phone → Team)",
      [gl.docchase, gl.review, gl.targets, gl.phone], ["firm", "automations", "team", "team"]);
    ok("A30 · no console errors (p4, all tabs)", realErr(p4).length === 0, realErr(p4).join(" | "));
    await p4.__ctx.close();

    /* ------------------------------------------------------------------ B. one Save, only what changed */
    console.log("\nB · One Save — every tab's changed fields, nothing else");
    const b4 = await boot(browser, "p4");
    await go(b4, "settings/firm", 2500);
    await b4.evaluate(() => {
      window.__ups = [];
      const orig = db.from.bind(db);
      db.from = (t) => {
        const q = orig(t);
        if (t === "settings" && q && typeof q.upsert === "function") { const u = q.upsert.bind(q); q.upsert = (rows, ...a) => { window.__ups.push((rows || []).map((r) => r.key)); return u(rows, ...a); }; }
        return q;
      };
    });
    const newName = "NexMoney R89 " + Date.now().toString().slice(-5);
    await b4.fill('#settings-form [name="company_name"]', newName);
    await b4.evaluate(() => { document.getElementById("set-tab-firm").dataset.r89mark = "1"; });
    await clickTab(b4, "automations");
    const mid = await b4.evaluate(() => ({
      val: document.querySelector('#settings-form [name="company_name"]').value,
      mark: document.getElementById("set-tab-firm") && document.getElementById("set-tab-firm").dataset.r89mark,
      n: (document.getElementById("settings-dirty-n") || {}).textContent,
      footer: !!document.getElementById("settings-save").offsetParent,
    }));
    ok("B1 · switching tab keeps the edit (the form was not re-rendered)", mid.val === newName && mid.mark === "1", JSON.stringify(mid));
    ok("B2 · the footer on the other tab says one change is unsaved", /^1 unsaved change$/.test(mid.n) && mid.footer, JSON.stringify(mid));
    const absentKey = await b4.evaluate(async () => {
      const { data } = await window.__mockDb.from("settings").select("key");
      const have = new Set((data || []).map((r) => r.key));
      const f = [...document.querySelectorAll("#settings-form [name]")].find((el) => !have.has(el.name));
      return f ? f.name : null;
    });
    ok("B3 · the fixture has a form field with no stored row (to prove it is not written)", !!absentKey, String(absentKey));
    await b4.click("#save-settings-btn");
    await b4.waitForTimeout(1500);
    const after = await b4.evaluate(async (k) => {
      const all = (await window.__mockDb.from("settings").select("key,value")).data || [];
      const m = Object.fromEntries(all.map((r) => [r.key, r.value]));
      return { name: m.company_name, absent: Object.prototype.hasOwnProperty.call(m, k), ups: window.__ups, n: (document.getElementById("settings-dirty-n") || {}).textContent, toast: (document.getElementById("toast") || {}).textContent };
    }, absentKey);
    eq("B4 · Save on Automations wrote the Firm & rules field", after.name, newName);
    eq("B5 · …and ONLY that field (one upsert, one key)", after.ups, [["company_name"]]);
    eq("B6 · an untouched field with no row is still not stored", after.absent, false);
    ok("B7 · the footer is clean again and the save said so", after.n === "No unsaved changes" && /Saved/.test(after.toast || ""), JSON.stringify(after));

    await b4.evaluate(() => { window.__ups = []; });
    await b4.click("#save-settings-btn");
    await b4.waitForTimeout(700);
    const none = await b4.evaluate(() => ({ ups: window.__ups, toast: (document.getElementById("toast") || {}).textContent }));
    ok("B8 · Save with nothing changed writes nothing and says so", none.ups.length === 0 && /Nothing to save/.test(none.toast), JSON.stringify(none));

    /* two tabs, one Save */
    const npsBefore = await b4.evaluate(() => document.querySelector('#settings-form [name="nps_enabled"]').value);
    await b4.click('#set-tab-automations .set-switch[data-for="nps_enabled"]');
    await clickTab(b4, "integrations");
    const smsFrom = "R89C" + Date.now().toString().slice(-4);
    await b4.fill('#settings-form [name="sms_from"]', smsFrom);
    await clickTab(b4, "firm");
    await b4.click("#save-settings-btn");
    await b4.waitForTimeout(1500);
    const two = await b4.evaluate(async () => {
      const all = (await window.__mockDb.from("settings").select("key,value")).data || [];
      const m = Object.fromEntries(all.map((r) => [r.key, r.value]));
      return { nps: m.nps_enabled, sms: m.sms_from, ups: window.__ups.map((u) => u.slice().sort()) };
    });
    eq("B9 · a switch on Automations + a box on Integrations, saved from Firm & rules: both land", [two.nps, two.sms], [npsBefore === "on" ? "off" : "on", smsFrom]);
    eq("B10 · …in one write of exactly those two keys", two.ups, [["nps_enabled", "sms_from"]]);
    ok("B11 · no console errors (save flow)", realErr(b4).length === 0, realErr(b4).join(" | "));
    await b4.__ctx.close();

    /* ------------------------------------------------------------------ C. admin */
    console.log("\nC · Administrator (p1) — five tabs, read-only form, no Save");
    const p1 = await boot(browser, "p1");
    await go(p1, "settings", 2500);
    s = await state(p1);
    eq("C1 · five tabs for the Administrator", s.strip.map((b) => b.key), TAB_KEYS);
    const adm = await p1.evaluate(() => ({
      btnHidden: document.getElementById("save-settings-btn").classList.contains("hidden"),
      note: !!document.getElementById("settings-readonly-note") && document.getElementById("settings-readonly-note").offsetParent !== null,
      enabled: [...document.querySelectorAll("#settings-form [name]")].filter((el) => !el.disabled).length,
    }));
    ok("C2 · no Save for the Administrator on any form tab (read-only form)", !s.footer && adm.btnHidden && s.saveBtns.length === 0, JSON.stringify({ s, adm }));
    ok("C3 · the read-only line shows and every control is disabled", adm.note && adm.enabled === 0, JSON.stringify(adm));
    for (const k of TAB_KEYS.slice(1)) { await clickTab(p1, k); }
    s = await state(p1);
    eq("C4 · the Administrator can open Data", s.tab, "data");
    await clickTab(p1, "team");
    await p1.waitForTimeout(1500);
    const admSelf = await p1.evaluate(() => {
      const mine = PROFILES.find((p) => p.id === ME.id) || {};
      return { ro: !!document.getElementById("team-self-contact"), inputs: document.querySelectorAll(`#team-roster input, #team-roster textarea`).length, phone: mine.phone || null };
    });
    ok("C5 · the Administrator's roster edits nobody's contact, and shows their own read-only", admSelf.inputs === 0 && admSelf.ro, JSON.stringify(admSelf));
    ok("C6 · no console errors (p1, all tabs)", realErr(p1).length === 0, realErr(p1).join(" | "));
    await p1.__ctx.close();

    /* ------------------------------------------------------------------ D. adviser */
    console.log("\nD · Adviser (p2) — My details + Security, no strip");
    const p2 = await boot(browser, "p2");
    await go(p2, "settings", 2500);
    s = await state(p2);
    const adv = await p2.evaluate(() => {
      const vis = (id) => { const el = document.getElementById(id); return !!el && !el.classList.contains("hidden") && el.offsetParent !== null; };
      const panels = [...document.querySelectorAll("#page-settings .panel, #page-settings details.settings-details")].filter((p) => p.offsetParent !== null && !p.classList.contains("hidden") && p.id !== "settings-form").map((p) => p.id);
      return { strip: !!document.getElementById("settings-tabs"), panels, fields: document.querySelectorAll("#settings-form [name]").length, myPhone: vis("my-phone"), save: vis("settings-save") };
    });
    eq("D1 · no tab strip for an adviser", adv.strip, false);
    eq("D2 · …and the hash stays #settings", s.hash, "#settings");
    eq("D3 · the adviser's Settings is My details + Security, nothing else", adv.panels, ["my-details-panel", "security-panel"]);
    ok("D4 · no firm form fields and no settings Save", adv.fields === 0 && !adv.save, JSON.stringify(adv));
    ok("D5 · the adviser edits their own phone in My details", adv.myPhone, JSON.stringify(adv));
    const hashTry = await p2.evaluate(async () => { nav("settings/firm"); await new Promise((r) => setTimeout(r, 900)); return { tab: currentPageTab(), hash: location.hash }; });
    eq("D6 · a typed #settings/firm falls back to the adviser's one tab", hashTry, { tab: "team", hash: "#settings" });
    ok("D7 · no console errors (p2)", realErr(p2).length === 0, realErr(p2).join(" | "));
    await p2.__ctx.close();

    /* ------------------------------------------------------------------ E. phone */
    console.log("\nE · Phone 390 (p4) — active tab in view, 44px, no sideways scroll");
    const ph = await boot(browser, "p4", { viewport: PHONE });
    await go(ph, "settings", 2500);
    for (const k of ["data", "team", "firm"]) {
      await clickTab(ph, k, 700);
      const m = await ph.evaluate(() => {
        const strip = document.querySelector("#settings-tabs");
        const b = strip.querySelector('.seg-btn[aria-pressed="true"]');
        const r = b.getBoundingClientRect(), sr = strip.getBoundingClientRect();
        return { key: b.dataset.tab, inView: r.left >= sr.left - 1 && r.right <= sr.right + 1, scrollW: document.documentElement.scrollWidth };
      });
      ok(`E1 · ${k}: the active tab is inside the strip's view`, m.key === k && m.inView, JSON.stringify(m));
      ok(`E2 · ${k}: no sideways page scroll`, m.scrollW <= 391, JSON.stringify(m));
    }
    await reloadAt(ph, "p4", "#settings/data");
    const cold = await ph.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const strip = document.querySelector("#settings-tabs");
      const b = strip.querySelector('.seg-btn[aria-pressed="true"]');
      const r = b.getBoundingClientRect(), sr = strip.getBoundingClientRect();
      res({ key: b.dataset.tab, inView: r.left >= sr.left - 1 && r.right <= sr.right + 1 });
    }))));
    ok("E3 · a cold #settings/data on a phone shows Data in the strip", cold.key === "data" && cold.inView, JSON.stringify(cold));
    await clickTab(ph, "firm", 700);
    const sizes = await ph.evaluate(() => ({
      tabs: [...document.querySelectorAll("#settings-tabs > .seg-btn")].map((b) => Math.round(b.getBoundingClientRect().height)),
      save: Math.round(document.getElementById("save-settings-btn").getBoundingClientRect().height),
      edit: (() => { const b = document.getElementById("team-self-edit"); return b ? b.getBoundingClientRect().height : null; })(),
    }));
    ok("E4 · every tab is ≥44px tall", sizes.tabs.length === 5 && sizes.tabs.every((h) => h >= 44), JSON.stringify(sizes));
    ok("E5 · the Save button is ≥44px tall", sizes.save >= 44, JSON.stringify(sizes));
    await clickTab(ph, "team", 900);
    const editH = await ph.evaluate(() => Math.round(document.getElementById("team-self-edit").getBoundingClientRect().height));
    ok("E6 · “Edit in My details” is ≥44px tall", editH >= 44, String(editH));
    ok("E7 · no console errors (p4 phone)", realErr(ph).length === 0, realErr(ph).join(" | "));
    await ph.__ctx.close();

    /* ------------------------------------------------------------------ F. prose rule on the new lines */
    console.log("\nF · Prose — the lines this slice wrote are one short line each");
    const pr = await boot(browser, "p4");
    await go(pr, "settings/team", 2500);
    const words = await pr.evaluate(() => {
      const w = (el) => (el ? el.textContent.trim().split(/\s+/).filter(Boolean).length : -1);
      return { mydetails: w(document.querySelector("#my-details-panel > .panel-sub")), self: w(document.getElementById("team-self-contact")) };
    });
    ok("F1 · My details keeps one line of ≤25 words", words.mydetails > 0 && words.mydetails <= 25, JSON.stringify(words));
    ok("F2 · the roster's read-only line is short (≤25 words)", words.self > 0 && words.self <= 25, JSON.stringify(words));
    await clickTab(pr, "firm");
    const foot = await pr.evaluate(() => document.querySelector("#settings-save .sdb-msg").textContent.trim().split(/\s+/).length);
    ok("F3 · the Save footer's line is ≤25 words", foot <= 25, String(foot));
    ok("F4 · no console errors", realErr(pr).length === 0, realErr(pr).join(" | "));
    await pr.__ctx.close();
  } catch (e) {
    failures.push("CRASH — " + (e && e.stack || e));
    console.log("CRASH", e);
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (_) { /* already gone */ }
  }
  console.log(`\nR89 SETTINGS: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
})();
