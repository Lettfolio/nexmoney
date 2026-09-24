/* ============================================================================
   R90 · C — tests/r90_queues.js

   SMS QUEUE ON THE EMAIL MACHINERY + INLINE-STYLE RESIDUE.

   §A (static) — one queueTable(kind)/queueVerbs(kind) pair draws and drives BOTH
        queues; the eight mirror functions are gone; the inline-style ceilings per
        file (the counts R90 · C left) hold; the fenced utility block is ≤ 25 rules,
        has no @media, sits above FOCUS, and every u-* class the markup uses is
        defined there (and every one defined is used).
   §B (p4, runtime) — both queue pages render through the one renderer: the same
        bulk-bar verb ids and skeleton, checkboxes on queued/failed, gutters on
        history; the bar counts and scopes Retry the same way on each; per-row
        Retry writes the row on EACH queue (status queued, address refreshed to the
        client's current one); bulk cancel goes through each queue's own overlay
        and writes the rows; Retry-all on the Failed view re-queues on each; the
        utility classes compute to the values the inline styles had.
   Expectations are computed at runtime from the seeded rows.
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

/* R90 · C — the ceilings. `style="` occurrences per file after the utility pass; the
   remainder are dynamic values (computed widths/colours), openCase's (slice B), the
   print-window evidence pack (no admin.css there), the no-SDK fallback page, and
   multi-property layouts no single utility states, and five class-less <h3>s kept inline
   because `.panel h3:not([class])` styles them (a class would un-style them). Lower is
   fine; higher fails. */
const STYLE_CEILING = { "admin/app.js": 143, "admin/diary.js": 11, "admin/import.js": 9, "admin/vault.js": 0, "admin/reports-money.js": 31, "admin/index.html": 18 };   // R91 · 3d: index.html 19 → 18 (#month-legend's margin became .u-m-12-0-0; ceilings only go DOWN)
const UTIL_MAX_RULES = 25;   // the brief's cap; R90 · C used 24, R91 · 3d added the 25th (.u-m-12-0-0) — the block is full

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  return srv;
}
async function boot(browser, persona) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));
const wait = (page, ms) => page.waitForTimeout(ms);
const goEmails = async (page) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate(() => window.nav("emails"));
  await wait(page, 3000);
};
const toastText = (page) => page.evaluate(() => (document.getElementById("toast") || {}).textContent || "");
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");
const count = (s, needle) => s.split(needle).length - 1;

(async () => {
  /* =====================================================================
     §A · static — one machine, the ceilings, the utility block
     ===================================================================== */
  console.log("\n— §A · static: one queue machine; inline-style ceilings; the utility block");
  const app = read("admin/app.js");
  eq("A1 · queueTable and queueVerbs are each defined exactly once",
    [count(app, "function queueTable(kind)"), count(app, "function queueVerbs(kind)")], [1, 1]);
  ok("A1b · QUEUE_KINDS carries an email and an sms entry (email_queue / sms_queue)",
    /const QUEUE_KINDS = \{\s*email: \{\s*table: "email_queue"/.test(app) && /\n  sms: \{\s*table: "sms_queue"/.test(app));
  const mirrors = ["updateEmailBulkBar", "updateSmsBulkBar", "bulkRetryEmails", "bulkRetrySms", "bulkCancelEmails", "bulkCancelSms",
    "bulkCancelEmailsRun", "bulkCancelSmsRun", "confirmBulkCancelEmails", "confirmBulkCancelSms"];
  eq("A2 · none of the mirrored per-queue functions survives", mirrors.filter((n) => new RegExp(`function ${n}\\(`).test(app)), []);
  ok("A3 · both lists paint their bar, retry-all row and checkboxes from queueTable",
    /\$\("#email-list"\)\.innerHTML = `<div class="panel">` \+ emQ\.bar\(/.test(app) && /\$\("#sms-list"\)\.innerHTML = smsQ\.bar\(/.test(app)
    && /\$\{emQ\.cb\(e\)\}/.test(app) && /\$\{smsQ\.cb\(s\)\}/.test(app) && /emQ\.wire\(\)/.test(app) && /smsQ\.wire\(\)/.test(app));
  ok("A3b · the old global names are one-line shims onto the machine",
    /function retryEmail\(id, silent\) \{ return queueVerbs\("email"\)\.retry\(id, silent\); \}/.test(app)
    && /function retrySms\(id, silent\) \{ return queueVerbs\("sms"\)\.retry\(id, silent\); \}/.test(app)
    && /window\.retryAllFailedEmails = \(\) => queueVerbs\("email"\)\.retryAll\(\);/.test(app)
    && /window\.retryAllFailedSms = \(\) => queueVerbs\("sms"\)\.retryAll\(\);/.test(app));
  const styleCounts = {};
  for (const f of Object.keys(STYLE_CEILING)) {
    styleCounts[f] = count(read(f), 'style="');
    ok(`A4 · ${f}: ${styleCounts[f]} inline style= ≤ the R90 · C ceiling ${STYLE_CEILING[f]}`, styleCounts[f] <= STYLE_CEILING[f]);
  }
  const css = read("admin/admin.css");
  const bStart = css.indexOf("/* R90 · C utilities"), bEnd = css.indexOf("/* end R90 · C utilities */");
  ok("A5 · the fenced R90 · C utilities block exists", bStart > 0 && bEnd > bStart);
  const block = css.slice(bStart, bEnd);
  const rules = [...block.matchAll(/^\.(u-[a-z0-9-]+) \{[^}]*\}/gm)].map((m) => m[1]);
  ok(`A5b · it holds ${rules.length} rules (≤ ${UTIL_MAX_RULES}) and no @media`, rules.length > 0 && rules.length <= UTIL_MAX_RULES && !/@media/.test(block), rules.join(","));
  ok("A5c · it sits above FOCUS, which stays last", css.indexOf("FOCUS (R87 · E3", bEnd) > bEnd);
  const src = ["admin/app.js", "admin/diary.js", "admin/import.js", "admin/vault.js", "admin/reports-money.js", "admin/index.html"].map(read).join("\n");
  const used = new Set([...src.matchAll(/\bu-(?:mt|m|fs|fw)-[0-9-]+\b|\bu-(?:m0|center|muted|red|nowrap|pointer|w-auto|ox-auto|jc-end)\b/g)].map((m) => m[0]));
  eq("A6 · every u-* class the markup uses is defined in the block", [...used].filter((c) => !rules.includes(c)).sort(), []);
  eq("A6b · …and every rule in the block is used", rules.filter((r) => !used.has(r)), []);

  /* =====================================================================
     §B · runtime (p4) — both queue pages through one renderer
     ===================================================================== */
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {
    console.log("\n— §B · p4: both queues render and act through queueTable/queueVerbs");
    const page = await boot(browser, "p4");
    const errBefore = realErrs(page).length;
    eq("B1 · the machine and its shims are live functions",
      await page.evaluate(() => [typeof queueTable, typeof queueVerbs, typeof retryEmail, typeof retrySms, typeof window.retryAllFailedEmails, typeof window.retryAllFailedSms]),
      ["function", "function", "function", "function", "function", "function"]);

    // One client (current email + phone differ from the stale ones on the rows) and a case.
    const stamp = Date.now().toString(36);
    const seed = await page.evaluate(async (st) => {
      const db = window.__mockDb;
      const { data: cl } = await db.from("clients").insert({ first_name: "Queue", last_name: "R90" + st, email: `now.${st}@example.com`, phone: "07700900777" }).select("id").single();
      const { data: cs } = await db.from("cases").insert({ client_id: cl.id, case_kind: "remortgage", stage: "application" }).select("id").single();
      const em = async (status, extra) => (await db.from("email_queue").insert(Object.assign({
        client_id: cl.id, case_id: cs.id, email_type: "docs_request", to_email: `old.${st}@example.com`, subject: "R90 probe", status,
      }, extra || {})).select("id").single()).data.id;
      const sm = async (status, extra) => (await db.from("sms_queue").insert(Object.assign({
        client_id: cl.id, case_id: cs.id, sms_type: "appointment_reminder", body: "r90 probe", to_phone: "07700900111", status,
      }, extra || {})).select("id").single()).data.id;
      return {
        clientId: cl.id, caseId: cs.id,
        eq1: await em("queued"), ef1: await em("failed", { error: "Temporary send failure" }), ef2: await em("failed", { error: "Temporary send failure" }),
        sq1: await sm("queued"), sf1: await sm("failed", { error: "Temporary send failure" }), sf2: await sm("failed", { error: "Temporary send failure" }), ss1: await sm("sent"),
      };
    }, stamp);
    await goEmails(page);

    const bars = await page.evaluate(() => {
      const bar = (p) => {
        const b = document.querySelector(`#${p}-bulk-bar`);
        if (!b) return null;
        return {
          ids: [...b.querySelectorAll("[id]")].map((e) => e.id.replace(p + "-", "X-")),
          skel: [...b.querySelectorAll("*")].map((e) => e.tagName + "." + e.className).join(" "),
          hidden: b.hidden,
        };
      };
      return { email: bar("email"), sms: bar("sms") };
    });
    ok("B2 · both queues carry a bulk bar", !!bars.email && !!bars.sms, JSON.stringify(bars));
    eq("B2b · …with the SAME verb ids (#<queue>-bulk-n / -cancel / -retry / -clear)", bars.email && bars.email.ids, ["X-bulk-n", "X-bulk-cancel", "X-bulk-retry", "X-bulk-clear"]);
    eq("B2c · …and the SMS bar's ids and skeleton are the email bar's, verb for verb",
      bars.sms && [bars.sms.ids, bars.sms.skel], bars.email && [bars.email.ids, bars.email.skel]);
    ok("B2d · both start hidden (nothing selected)", bars.email && bars.sms && bars.email.hidden && bars.sms.hidden);

    const shape = await page.evaluate((s) => {
      const has = (p, id) => !!document.querySelector(`#${p}-list .${p}-cb[data-id="${id}"]`);
      return {
        email: [has("email", s.eq1), has("email", s.ef1)],
        sms: [has("sms", s.sq1), has("sms", s.sf1), has("sms", s.ss1)],
        smsGap: !!document.querySelector("#sms-list .sms-cb-gap"),
        cbLabels: [document.querySelector(`#email-list .email-cb[data-id="${s.ef1}"]`)?.getAttribute("aria-label"), document.querySelector(`#sms-list .sms-cb[data-id="${s.sf1}"]`)?.getAttribute("aria-label")],
      };
    }, seed);
    eq("B3 · checkboxes on queued + failed rows of both queues; none on the sent SMS", [shape.email, shape.sms], [[true, true], [true, true, false]]);
    ok("B3b · the history row keeps the gutter (.sms-cb-gap)", shape.smsGap);
    eq("B3c · each checkbox names its own queue's noun", shape.cbLabels, ["Select this failed email", "Select this failed SMS"]);

    // The bar counts and scopes Retry the same way on each queue.
    const barAfter = {};
    for (const [p, q, f] of [["email", seed.eq1, seed.ef1], ["sms", seed.sq1, seed.sf1]]) {
      await page.check(`#${p}-list .${p}-cb[data-id="${q}"]`);
      await page.check(`#${p}-list .${p}-cb[data-id="${f}"]`);
      barAfter[p] = await page.evaluate((x) => ({
        hidden: document.querySelector(`#${x}-bulk-bar`).hidden,
        n: document.querySelector(`#${x}-bulk-n`).textContent,
        cancel: document.querySelector(`#${x}-bulk-cancel`).textContent.trim(),
        retry: document.querySelector(`#${x}-bulk-retry`).textContent.trim(),
        disabled: document.querySelector(`#${x}-bulk-retry`).disabled,
        title: document.querySelector(`#${x}-bulk-retry`).title,
      }), p);
    }
    const strip = (b) => ({ hidden: b.hidden, n: b.n, cancel: b.cancel, retry: b.retry, disabled: b.disabled });
    eq("B4 · selecting one queued + one failed reads the same on both bars", [strip(barAfter.email), strip(barAfter.sms)],
      [{ hidden: false, n: "2", cancel: "Cancel selected (2)", retry: "Retry failed (1)", disabled: false }, { hidden: false, n: "2", cancel: "Cancel selected (2)", retry: "Retry failed (1)", disabled: false }]);
    ok("B4b · each Retry title explains the failed-only scope in its own noun",
      /applies to emails that have already FAILED/.test(barAfter.email.title) && /applies to SMS that have already FAILED/.test(barAfter.sms.title), JSON.stringify([barAfter.email.title, barAfter.sms.title]));
    // Clear on each.
    await page.click("#email-bulk-clear"); await page.click("#sms-bulk-clear"); await wait(page, 300);
    eq("B4c · Clear empties each selection and hides each bar", await page.evaluate(() => [
      document.querySelector("#email-bulk-bar").hidden, document.querySelector("#sms-bulk-bar").hidden,
      document.querySelectorAll("#email-list .email-cb:checked, #sms-list .sms-cb:checked").length]), [true, true, 0]);

    // Per-row Retry writes the row, on EACH queue (retryEmail / retrySms via the row's own button).
    const rowRetry = async (p, id) => {
      await page.evaluate(({ p, id }) => {
        const row = document.querySelector(`#${p}-list .${p}-cb[data-id="${id}"]`).closest(".row-item");
        [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Retry").click();
      }, { p, id });
      await wait(page, 1800);
    };
    await rowRetry("email", seed.ef1);
    await rowRetry("sms", seed.sf1);
    const written = await page.evaluate(async (s) => {
      const db = window.__mockDb;
      const e = (await db.from("email_queue").select("status,sent_at,to_email").eq("id", s.ef1).single()).data;
      const m = (await db.from("sms_queue").select("status,sent_at,to_phone").eq("id", s.sf1).single()).data;
      return { e, m };
    }, seed);
    eq("B5 · per-row Retry on the EMAIL queue re-queues the row to the client's current address",
      written.e, { status: "queued", sent_at: null, to_email: `now.${stamp}@example.com` });
    eq("B5b · per-row Retry on the SMS queue re-queues the row to the client's current number",
      { status: written.m.status, sent: !!written.m.sent_at, to_phone: written.m.to_phone }, { status: "queued", sent: false, to_phone: "07700900777" });
    ok("B5c · the SMS toast is the SMS wording", /SMS re-queued to 07700900777/.test(await toastText(page)), await toastText(page));

    // Bulk cancel through each queue's own overlay.
    const overlays = {};
    for (const [p, ovl, id] of [["email", "emcancel", seed.eq1], ["sms", "smscancel", seed.sq1]]) {
      await goEmails(page);
      await page.check(`#${p}-list .${p}-cb[data-id="${id}"]`);
      page.__dialogs.length = 0;
      await page.click(`#${p}-bulk-cancel`);
      await wait(page, 700);
      overlays[p] = await page.evaluate((o) => ({
        ok: !!document.querySelector(`#${o}-ok`), cancel: !!document.querySelector(`#${o}-cancel`),
        head: (document.querySelector("#overlay-modal h3") || {}).textContent || "",
        body: (document.querySelector("#overlay-modal") || {}).textContent || "",
      }), ovl);
      overlays[p].dialogs = page.__dialogs.length;
      await page.click(`#${ovl}-ok`);
      await wait(page, 2200);
      overlays[p].toast = await toastText(page);
    }
    eq("B6 · each queue's bulk cancel opens its own house overlay (#emcancel-* / #smscancel-*), no native dialog",
      [overlays.email.ok && overlays.email.cancel, overlays.sms.ok && overlays.sms.cancel, overlays.email.dialogs, overlays.sms.dialogs], [true, true, 0, 0]);
    eq("B6b · …headed in each queue's noun", [overlays.email.head.trim(), overlays.sms.head.trim()], ["Cancel 1 email", "Cancel 1 SMS"]);
    ok("B6c · …naming each queue's own run (8am / 8:05am SMS run)",
      /8am run or by “Run automation now”/.test(overlays.email.body) && /8:05am SMS run or by “Send SMS now”/.test(overlays.sms.body));
    const cancelled = await page.evaluate(async (s) => {
      const db = window.__mockDb;
      return [(await db.from("email_queue").select("status").eq("id", s.eq1).single()).data.status,
        (await db.from("sms_queue").select("status").eq("id", s.sq1).single()).data.status];
    }, seed);
    eq("B7 · the confirmed bulk cancel wrote each row cancelled", cancelled, ["cancelled", "cancelled"]);
    ok("B7b · each toast tallies in its own noun", /^1 email cancelled/.test(overlays.email.toast) && /^1 SMS cancelled/.test(overlays.sms.toast), JSON.stringify([overlays.email.toast, overlays.sms.toast]));

    // Retry-all on the Failed view, on each queue.
    await page.evaluate(() => { emailStatusFilter = "failed"; smsStatusFilter = "failed"; return loadEmails(); });
    await wait(page, 1800);
    const ra = await page.evaluate(() => {
      const btn = (p) => [...document.querySelectorAll(`#${p}-list .row-item > button`)].find((b) => /^Retry all failed/.test(b.textContent));
      const e = btn("email"), m = btn("sms");
      return {
        email: e && { onclick: e.getAttribute("onclick"), jc: getComputedStyle(e.parentElement).justifyContent, cls: e.parentElement.className, style: e.parentElement.getAttribute("style") },
        sms: m && { onclick: m.getAttribute("onclick"), jc: getComputedStyle(m.parentElement).justifyContent, cls: m.parentElement.className, style: m.parentElement.getAttribute("style") },
      };
    });
    eq("B8 · both Failed views offer Retry-all, right-aligned by the utility class (no inline style)",
      ra, { email: { onclick: "retryAllFailedEmails()", jc: "flex-end", cls: "row-item u-jc-end", style: null }, sms: { onclick: "retryAllFailedSms()", jc: "flex-end", cls: "row-item u-jc-end", style: null } });
    await page.evaluate(() => window.retryAllFailedSms()); await wait(page, 2000);
    await page.evaluate(() => window.retryAllFailedEmails()); await wait(page, 2000);
    const afterAll = await page.evaluate(async (s) => {
      const db = window.__mockDb;
      return [(await db.from("email_queue").select("status").eq("id", s.ef2).single()).data.status,
        (await db.from("sms_queue").select("status").eq("id", s.sf2).single()).data.status];
    }, seed);
    eq("B9 · Retry-all re-queued the remaining failed row on each queue", afterAll, ["queued", "queued"]);

    // The utilities compute to what the inline values did.
    const util = await page.evaluate(() => {
      const probe = (cls, prop) => { const d = document.createElement("div"); d.className = cls; d.style.cssText = ""; document.body.appendChild(d); const v = getComputedStyle(d)[prop]; d.remove(); return v; };
      return [probe("u-mt-10", "marginTop"), probe("u-m-12-0-4", "marginBottom"), probe("u-fs-14", "fontSize"), probe("u-fw-600", "fontWeight"), probe("u-nowrap", "whiteSpace"), probe("u-ox-auto", "overflowX"), probe("u-center", "textAlign")];
    });
    eq("B10 · the utility classes compute to the values the inline styles carried", util, ["10px", "4px", "14px", "600", "nowrap", "auto", "center"]);
    const lbl = await page.evaluate(() => {
      // a converted element that a more specific house rule also styles: the utility must still win, as the inline style did
      const l = document.createElement("label"); l.className = "u-mt-10"; const m = document.querySelector(".modal") || document.body; m.appendChild(l);
      const v = getComputedStyle(l).marginTop; l.remove(); return v;
    });
    eq("B10b · …and still win against a house rule on the same element (inline precedence kept)", lbl, "10px");

    eq("B11 · no console errors", realErrs(page).slice(errBefore), []);
    await page.close();
  } catch (e) {
    failures.push("crash: " + (e && e.stack || e));
    console.log("  ✗ crash", e);
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(`\nr90_queues: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
