#!/usr/bin/env node
/* =============================================================================
   tests/r77_health.js — acceptance tests for R77 build B, "the owner decides"
   (items B1–B4).

   What R77 · B changed, and what each section pins:

     §A  APPOINTMENT OUTCOMES ON REPORTS (B1). appointments.outcome (recorded
         since r12b by the ✓ ✗ ↻ chips on Today and the editor's radios) gets
         its first READER: #report-outcomes-panel in Reports §5 Service &
         quality (owner-only, showMoney — the same gate r42 §B pins for the
         section). Last 90 days of appointments that have already STARTED; the
         FIRST-CLASS number is the unrecorded share ("N% unrecorded — the
         chips on Today record it"), then a per-adviser table, then the
         register of clients with 2+ recorded no-shows. Thin data renders
         honestly (100% unrecorded + a no-show list that says it can only be
         as good as the recording); an empty window renders emptyState, not a
         clean sheet. Chip id rep-nav-apptoutcomes, section-scoped.

     §B  THE BACKUP NAG RUNS THE EXPORT (B2). The Today banner's button
         (#dash-export-run-btn) now calls dashBackupNow(): the OWNER gets
         exportFirmData() DIRECTLY — the same house confirm ("Export the
         firm's data?", #ovl-confirm-ok), the same file, the same
         last_full_export_at stamp, and the banner clears in place when the
         export lands; Cancel stamps nothing and the nag stays. A NON-OWNER
         reaching the function deep-links to Settings' Data & backup section
         (nav + goliveJump('#firm-export-panel')) instead of the page top.
         The banner itself stays owner-only (r13 §A2's contract, untouched).

     §C  THE COMPLETED-FILE AUDIT WATCHLIST (B3). #dh-tile-completedgaps
         ("Completed with file gaps · 6 months"), owner-only, WATCH band on
         the Vulnerable-clients model: context, never counted — not in
         dhReadinessChecks, never in the headline, never amber (the R71
         no-amber-back-book decision). The measure is caseCompleteness at the
         case's pre-completion requirements — the three durable artefacts
         (document checklist, fact find, case papers). The reveal
         (#dh-completedgaps-panel) is a read-only register: case, client,
         what's missing, Open links — NO chase verbs. 6 months by
         completed_at, localDateStr walks.

     §D  INLINE CONTACT FIXES (B4a). The four contact panels (missing email
         #dh-missing-panel, missing phone #dh-phone-panel, invalid email
         #dh-invalid-email-panel, invalid phone #dh-invalid-phone-panel) now
         carry the dhFixCell pattern in a CLIENT-column variant (.dh-fix with
         data-client): one targeted clients.update of the single column,
         validated by the client form's own isValidEmailLike/isValidPhoneLike
         and refused with the client form's own message, verbatim. Saves
         decrement the tile (the "N of M" email/phone tiles come down on BOTH
         numbers), the rollup row and the headline, exactly like the R71 case
         fixes. The invalid panels prefill the broken value.

     §E  THE HEADLINE'S HONEST REASON (B4b). "…to clear before importing"
         (the import is years done) became "…to clear — automations and
         reports read these exact fields", at BOTH render sites: the initial
         paint and dhDecrementHeadline's rewrite.

   Run:  node /root/nx/tests/r77_health.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — see HARNESS.md.)
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

const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_sortdir", "nx_wt_scope", "nx_board_adviser",
  "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc", "nx_drawer_retention", "nx_ret_untouched"];

async function boot(browser, persona, viewport) {
  const page = await (await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } })).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.waitForTimeout(1600);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));

const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 2800 : ms);
};
const txt = (page, sel) => page.$eval(sel, (e) => (e.textContent || "").replace(/\s+/g, " ").trim()).catch(() => null);

let uniq = 0;
const tag = () => `R77${Date.now().toString(36)}${++uniq}`;

/* One client + one case through the mock's own client, so applyInsertDefaults runs exactly as
   production would (r74_numbers' helper, verbatim shape). */
async function mkCase(page, opts) {
  return page.evaluate(async (o) => {
    const db = window.__mockDb;
    const { data: cl, error: ce } = await db.from("clients").insert({
      first_name: o.first, last_name: o.last, email: o.email || `${o.last}@example.com`, phone: "07700900123",
    }).select("id").single();
    if (ce) throw new Error("client insert: " + ce.message);
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "completed" }, o.case || {});
    const { data: cs, error: se } = await db.from("cases").insert(row).select("id").single();
    if (se) throw new Error("case insert: " + se.message);
    return { clientId: cl.id, caseId: cs.id };
  }, opts);
}

/* Ground truth for §A, computed from the mock's raw rows with the panel's own window rule:
   started already, within the last 90 days (fixture rows sit far from the boundary, so a ms
   window is exact here). */
const apptGroundTruth = (page) => page.evaluate(() => {
  const now = Date.now();
  const since = now - 90 * 86400000;
  const rows = window.__mock.db.appointments.filter((a) => {
    const t = new Date(a.starts_at).getTime();
    return isFinite(t) && t <= now && t >= since;
  });
  const known = (k) => k === "attended" || k === "no_show" || k === "rearranged";
  const byAdv = {};
  rows.forEach((a) => {
    const k = a.staff_id || "";
    byAdv[k] = byAdv[k] || { total: 0, attended: 0, no_show: 0, rearranged: 0, unrecorded: 0 };
    byAdv[k].total++;
    if (known(a.outcome)) byAdv[k][a.outcome]++; else byAdv[k].unrecorded++;
  });
  const byClient = {};
  rows.filter((a) => a.outcome === "no_show").forEach((a) => { if (a.client_id) byClient[a.client_id] = (byClient[a.client_id] || 0) + 1; });
  const total = rows.length;
  const unrecorded = rows.filter((a) => !known(a.outcome)).length;
  return {
    total, unrecorded,
    pct: total ? Math.round((unrecorded / total) * 100) : 0,
    noShows: rows.filter((a) => a.outcome === "no_show").length,
    byAdv,
    repeat: Object.entries(byClient).filter(([, n]) => n >= 2).map(([id, n]) => ({ id, n })),
  };
});

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {

    /* =====================================================================
       §A · B1 — appointment outcomes on Reports (owner), honestly framed
       ===================================================================== */
    {
      console.log("\n— §A · appointment outcomes: per-adviser counts, unrecorded first-class, 2+ no-show register (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      const gt = await apptGroundTruth(page);
      ok("§A0 · fixture sanity — the window holds appointments, some recorded, most-null included",
        gt.total > 0 && gt.unrecorded > 0 && gt.total - gt.unrecorded > 0, JSON.stringify(gt));
      ok("§A0b · fixture sanity — at least one client has 2+ recorded no-shows", gt.repeat.length >= 1, JSON.stringify(gt.repeat));

      await goPage(page, "reports", 3800);
      const panel = await page.evaluate(() => {
        const p = document.getElementById("report-outcomes-panel");
        const kpis = [...document.querySelectorAll("#report-outcomes-headline .kpi")];
        return {
          hidden: p.classList.contains("hidden"),
          basis: (document.getElementById("report-outcomes-basis") || {}).textContent || "",
          firstKpiId: kpis.length ? kpis[0].id : null,
          pct: (document.getElementById("outcomes-unrecorded-pct") || {}).textContent,
          noshowN: (document.getElementById("outcomes-noshow-n") || {}).textContent,
          firstKpiTxt: kpis.length ? kpis[0].textContent : "",
        };
      });
      ok("§A1 · #report-outcomes-panel renders for the owner", !panel.hidden);
      ok("§A2 · the FIRST headline number is the unrecorded share", panel.firstKpiId === "outcomes-unrecorded-kpi", JSON.stringify(panel));
      eq("§A2b · …and it matches the ground truth exactly", panel.pct, gt.pct + "%");
      ok("§A2c · …and it points at the recorder: \"the chips on Today record it\"", /the chips on Today record it/.test(panel.firstKpiTxt), panel.firstKpiTxt);
      eq("§A2d · the no-show KPI matches ground truth", Number(panel.noshowN), gt.noShows);
      ok("§A2e · the basis names the window and the null-means-unrecorded rule",
        /last 90 days/.test(panel.basis) && /null means not recorded/i.test(panel.basis), panel.basis.slice(0, 160));

      /* Per-adviser table vs ground truth, row by row. */
      const advRows = await page.$$eval("#report-outcomes-table tr[data-adviser]", (els) => els.map((r) => ({
        id: r.dataset.adviser,
        cells: [...r.querySelectorAll("td")].map((c) => c.textContent.trim()),
      })));
      ok("§A3 · one table row per adviser with appointments in the window",
        advRows.length === Object.keys(gt.byAdv).length && advRows.length > 1, JSON.stringify(advRows.map((r) => r.id)));
      let rowsRight = true;
      const rowDiffs = [];
      advRows.forEach((r) => {
        const g = gt.byAdv[r.id];
        const want = g ? [g.total, g.attended, g.no_show, g.rearranged] : null;
        const got = r.cells.slice(1, 5).map(Number);
        const unrec = parseInt(r.cells[5], 10);
        if (!g || JSON.stringify(got) !== JSON.stringify(want) || unrec !== g.unrecorded) { rowsRight = false; rowDiffs.push({ id: r.id, got: r.cells, want: g }); }
      });
      ok("§A3b · every adviser row matches the ground truth (total/attended/no-show/rearranged/unrecorded)", rowsRight, JSON.stringify(rowDiffs));

      /* The 2+ no-show register. */
      const listed = await page.$$eval("#report-outcomes-noshow-list .row-item", (els) => els.map((r) => ({
        id: r.dataset.client, s: (r.querySelector(".s") || {}).textContent || "",
        openBtn: !!r.querySelector("button"),
      }))).catch(() => []);
      eq("§A4 · the 2+ no-show register lists exactly the ground-truth clients",
        listed.map((l) => l.id).sort(), gt.repeat.map((r) => r.id).sort());
      ok("§A4b · each row states its recorded no-show count and offers Open, nothing else",
        listed.every((l) => { const g = gt.repeat.find((r) => r.id === l.id); return g && new RegExp(`${g.n}\\b.*no-show`).test(l.s.replace(/\s+/g, " ")) && l.openBtn; }),
        JSON.stringify(listed));

      /* Section plumbing: the panel is §5's, chip section-scoped. */
      await page.click("#reports-nav-quality");
      await page.waitForTimeout(800);
      const chips = await page.$$eval("#rep-nav-chips .seg-btn", (els) => els.map((e) => e.dataset.repJump));
      ok("§A5 · the section-scoped chip strip carries rep-nav-apptoutcomes under Service & quality", chips.includes("apptoutcomes"), JSON.stringify(chips));

      /* THIN data: null every outcome — 100% unrecorded, and the no-show register says why it is
         empty instead of printing a clean sheet. */
      await page.evaluate(() => { window.__mock.db.appointments.forEach((a) => { a.outcome = null; }); });
      await goPage(page, "dashboard", 700);
      await goPage(page, "reports", 3800);
      const thin = await page.evaluate(() => ({
        pct: (document.getElementById("outcomes-unrecorded-pct") || {}).textContent,
        noshow: (document.getElementById("report-outcomes-noshows") || {}).textContent.replace(/\s+/g, " "),
      }));
      eq("§A6 · all-null outcomes render as 100% unrecorded, not as a clean diary", thin.pct, "100%");
      ok("§A6b · the empty no-show register blames the recording, not the clients",
        /No client has 2\+ recorded no-shows/.test(thin.noshow) && /carry no outcome at all/.test(thin.noshow), thin.noshow.slice(0, 220));

      /* EMPTY window: no appointments at all — emptyState, no fake numbers. */
      await page.evaluate(() => { window.__mock.db.appointments.length = 0; });
      await goPage(page, "dashboard", 700);
      await goPage(page, "reports", 3800);
      const empty = await page.evaluate(() => ({
        headline: (document.getElementById("report-outcomes-headline") || {}).innerHTML,
        advTxt: (document.getElementById("report-outcomes-adviser") || {}).textContent.replace(/\s+/g, " "),
        hasEmptyState: !!document.querySelector("#report-outcomes-adviser .empty-state"),
      }));
      ok("§A7 · an empty window renders emptyState — \"an empty diary, not a clean sheet\"",
        empty.hasEmptyState && /empty diary, not a clean sheet/.test(empty.advTxt) && empty.headline === "", JSON.stringify(empty).slice(0, 240));

      eq("§A · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §A8 · an adviser never sees the panel (owner-only, r42 §B's section gate holds)");
      const page = await boot(browser, "p2");
      const errBefore = realErrs(page).length;
      await goPage(page, "reports", 3800);
      const adv = await page.evaluate(() => ({
        hidden: document.getElementById("report-outcomes-panel").classList.contains("hidden"),
        headline: (document.getElementById("report-outcomes-headline") || {}).innerHTML,
        qualityBtn: !!document.getElementById("reports-nav-quality"),
      }));
      ok("§A8a · #report-outcomes-panel is hidden for an adviser", adv.hidden);
      eq("§A8b · …and empty, not merely hidden", adv.headline, "");
      ok("§A8c · Service & quality still has no section button for an adviser (r42 §B, re-affirmed)", !adv.qualityBtn);
      eq("§A8 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §B · B2 — the backup nag runs the export (owner), deep-links (others)
       ===================================================================== */
    {
      console.log("\n— §B · owner: the banner button IS the export — same confirm, stamps the date, clears the nag (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await page.evaluate(async () => { await window.__mockDb.from("settings").upsert([{ key: "last_full_export_at", value: "" }]); });
      await goPage(page, "emails", 900);
      await goPage(page, "dashboard", 2600);
      const ban = await page.evaluate(() => {
        const fold = document.querySelector(".dash-notice-fold");
        if (fold && !fold.open) fold.open = true;
        const n = document.getElementById("dash-export-notice");
        return { state: n && n.dataset.state, txt: n ? n.textContent.replace(/\s+/g, " ").trim() : "", btn: !!document.getElementById("dash-export-run-btn") };
      });
      eq("§B1 · never-exported banner renders", ban.state, "never");
      ok("§B1b · r13's words survive — \"No firm backup has ever been taken\"", /No firm backup has ever been taken/.test(ban.txt), ban.txt);
      ok("§B1c · the button is #dash-export-run-btn, not a bare nav('settings')", ban.btn, ban.txt);

      /* Cancel first: the confirm is exportFirmData's own house overlay, and Cancel writes nothing. */
      await page.evaluate(() => document.getElementById("dash-export-run-btn").click());
      await page.waitForTimeout(600);
      const title1 = await txt(page, "#ovl-confirm-title");
      eq("§B2 · the button raises exportFirmData's OWN confirm, unweakened", title1, "Export the firm's data?");
      const bodyHasWarning = await page.$eval("#ovl-confirm-body", (e) => /unencrypted/i.test(e.textContent)).catch(() => false);
      ok("§B2b · …with the unencrypted-file warning intact", bodyHasWarning);
      await page.click("#ovl-confirm-cancel");
      await page.waitForTimeout(700);
      const afterCancel = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("value").eq("key", "last_full_export_at").single();
        return { stamp: (data && data.value) || "", banner: !!document.getElementById("dash-export-notice") };
      });
      eq("§B3 · Cancel stamps nothing", afterCancel.stamp, "");
      ok("§B3b · …and the nag stays", afterCancel.banner);

      /* OK: the export runs from Today, stamps, and the banner clears in place. */
      await page.evaluate(() => document.getElementById("dash-export-run-btn").click());
      await page.waitForTimeout(600);
      await page.click("#ovl-confirm-ok");
      await page.waitForTimeout(3200);
      const post = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("value").eq("key", "last_full_export_at").single();
        return {
          stamp: (data && data.value) || "",
          bannerGone: !document.getElementById("dash-export-notice"),
          toast: (document.getElementById("toast") || {}).textContent || "",
        };
      });
      ok("§B4 · last_full_export_at is stamped to (about) now", !!post.stamp && Math.abs(Date.now() - new Date(post.stamp).getTime()) < 60000, post.stamp);
      ok("§B4b · the banner clears in front of the person who pressed it", post.bannerGone);
      ok("§B4c · the toast is the export's own summary (\"Exported N rows from N tables\")", /Exported [\d,]+ rows from \d+ tables/.test(post.toast), post.toast);
      eq("§B · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §B5 · non-owner: no banner (r13 §A2 holds), and dashBackupNow deep-links to Data & backup (p1)");
      const page = await boot(browser, "p1");
      const errBefore = realErrs(page).length;
      await goPage(page, "dashboard", 2400);
      ok("§B5a · the backup banner never renders for a non-owner (r13 §A2, unchanged)",
        !(await page.$("#dash-export-notice")));
      await page.evaluate(() => window.dashBackupNow(null));
      await page.waitForTimeout(2000);
      const deep = await page.evaluate(() => ({
        onSettings: !document.getElementById("page-settings").classList.contains("hidden"),
        confirmOpen: !document.getElementById("overlay-backdrop").classList.contains("hidden"),
        panelThere: !!document.getElementById("firm-export-panel"),
      }));
      ok("§B5b · a non-owner lands on Settings, at the Data & backup panel — never in an export confirm",
        deep.onSettings && deep.panelThere && !deep.confirmOpen, JSON.stringify(deep));
      eq("§B5 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §C · B3 — the completed-file audit watchlist (owner-only, not counted)
       ===================================================================== */
    {
      console.log("\n— §C · completed-in-6-months with file gaps: watch band, counted right, headline untouched (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;

      /* Two seeded completions missing every artefact: one INSIDE the 6-month window (counted),
         one 8 months back (outside — completed_at is the boundary, not existence). */
      const t = tag();
      const inWin = await mkCase(page, { first: "R77C", last: "InWindow" + t, case: { completed_at: new Date(Date.now() - 30 * 86400000).toISOString(), lender: "R77CLender" } });
      await mkCase(page, { first: "R77C", last: "OutWindow" + t, case: { completed_at: new Date(Date.now() - 240 * 86400000).toISOString(), lender: "R77CLender" } });

      /* Ground truth from the mock's raw rows, through the app's own localDateStr walk —
         re-implemented here (Europe/London via en-CA, the same YYYY-MM-DD shape) because
         localDateStr is a module const, not a window property. */
      const gt = await page.evaluate(() => {
        const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
        const lds = (x) => fmt.format(x ? new Date(x) : new Date());
        const d = new Date(lds() + "T12:00:00");
        d.setMonth(d.getMonth() - 6);
        const since = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const docs = new Set(window.__mock.db.case_documents.map((r) => r.case_id));
        const ffs = new Set(window.__mock.db.fact_finds.map((r) => r.case_id));
        const files = new Set(window.__mock.db.case_files.map((r) => r.case_id));
        return window.__mock.db.cases.filter((c) => c.stage === "completed" && c.completed_at
          && lds(c.completed_at) >= since
          && !(docs.has(c.id) && ffs.has(c.id) && files.has(c.id))).map((c) => c.id).sort();
      });
      ok("§C0 · fixture sanity — the window holds completed cases with gaps, the seeded in-window one among them",
        gt.length > 0 && gt.includes(inWin.caseId), JSON.stringify({ n: gt.length }));

      await goPage(page, "data", 3600);
      const st = await page.evaluate(() => {
        const tile = document.getElementById("dh-tile-completedgaps");
        let band = null;
        for (let el = tile; el; el = el.previousElementSibling) { if (el.classList && el.classList.contains("dh-band-h")) { band = el.dataset.band; break; } }
        const h = document.getElementById("dh-readiness-headline");
        const rollupTiles = [...document.querySelectorAll("#dh-readiness .dh-readiness-item")].map((it) => ((it.getAttribute("onclick") || "").match(/'(dh-tile-[a-z-]+)'/) || [])[1]);
        const rollupSum = [...document.querySelectorAll("#dh-readiness .dh-readiness-count")].map((e) => Number(e.textContent)).reduce((a, b) => a + b, 0);
        return {
          n: tile ? tile.querySelector(".num").textContent.trim() : null,
          lbl: tile ? tile.querySelector(".lbl").textContent.trim() : null,
          warn: tile ? tile.classList.contains("warn") : null,
          clean: tile ? tile.classList.contains("dh-clean") : null,
          band,
          headlineTotal: h ? Number(h.dataset.total) : null,
          rollupTiles, rollupSum,
        };
      });
      eq("§C1 · the tile exists under the audit's own words", st.lbl, "Completed with file gaps · 6 months ▾");
      eq("§C2 · its count is the ground truth", Number(st.n), gt.length);
      eq("§C3 · it sits in the WATCH band — context, not counted (the Vulnerable-clients model)", st.band, "watch");
      ok("§C3b · never amber, never folded (R71's no-amber-back-book decision holds on a closed file)", st.warn === false && st.clean === false, JSON.stringify(st));
      ok("§C4 · it is NOT a readiness check — no rollup row points at it", !st.rollupTiles.includes("dh-tile-completedgaps"), JSON.stringify(st.rollupTiles));
      eq("§C4b · …and the headline is exactly the sum of the rows that ARE counted", st.headlineTotal, st.rollupSum);

      await page.click("#dh-tile-completedgaps");
      await page.waitForTimeout(700);
      const reg = await page.evaluate(() => {
        const p = document.getElementById("dh-completedgaps-panel");
        return {
          open: !p.classList.contains("hidden"),
          rows: [...p.querySelectorAll(".row-item")].map((r) => ({
            s: (r.querySelector(".s") || {}).textContent.replace(/\s+/g, " ").trim(),
            btns: [...r.querySelectorAll("button")].map((b) => b.textContent.trim()),
          })),
          allBtns: [...p.querySelectorAll("button")].map((b) => b.textContent.trim()).join("|"),
          sub: (p.querySelector(".panel-sub") || {}).textContent.replace(/\s+/g, " "),
        };
      });
      ok("§C5 · the tile reveals the register", reg.open);
      ok("§C5b · every row names what is missing, from the three durable artefacts",
        reg.rows.length > 0 && reg.rows.every((r) => /missing: .*(document checklist|fact find|case papers)/.test(r.s)), JSON.stringify(reg.rows.slice(0, 2)));
      ok("§C5c · every row carries Open links for the case and the client",
        reg.rows.every((r) => r.btns.includes("Open case") && r.btns.includes("Client")), JSON.stringify(reg.rows[0]));
      ok("§C5d · NO chase verbs anywhere on the register — it is read-only",
        !/chase|send|remind|email/i.test(reg.allBtns), reg.allBtns.slice(0, 120));
      ok("§C5e · the copy says what it is: a register to read, not a queue to work",
        /register to read, not a queue to work/.test(reg.sub), reg.sub.slice(0, 160));
      ok("§C5f · rows carry completion dates (newest completions are the audit's first sample)",
        reg.rows.every((r) => /completed \d/.test(r.s)), JSON.stringify(reg.rows[0]));

      eq("§C · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    {
      console.log("\n— §C6 · owner-only: an adviser gets neither tile nor panel (p2)");
      const page = await boot(browser, "p2");
      const errBefore = realErrs(page).length;
      await goPage(page, "data", 3200);
      ok("§C6a · no #dh-tile-completedgaps for an adviser", !(await page.$("#dh-tile-completedgaps")));
      ok("§C6b · no #dh-completedgaps-panel for an adviser", !(await page.$("#dh-completedgaps-panel")));
      const bands = await page.$$eval("#dh-kpi-row .dh-band-h", (els) => els.map((e) => e.dataset.band));
      eq("§C6c · both bands still render for an adviser (r74 §E3's wall, intact)", bands, ["counted", "watch"]);
      eq("§C6 · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §D · B4a — the four contact panels fix inline, with the form's own gate
       ===================================================================== */
    {
      console.log("\n— §D · inline contact fixes: client-column dhFixCell, refusals verbatim, every counter comes down (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      await goPage(page, "data", 3600);

      const present = await page.evaluate(() => ({
        missing: document.querySelectorAll("#dh-missing-panel .dh-fix[data-client]").length,
        phone: document.querySelectorAll("#dh-phone-panel .dh-fix[data-client]").length,
        invEmail: document.querySelectorAll("#dh-invalid-email-panel .dh-fix[data-client]").length,
        invPhone: document.querySelectorAll("#dh-invalid-phone-panel .dh-fix[data-client]").length,
      }));
      ok("§D1 · all four contact panels carry the client-column fix cell", Object.values(present).every((n) => n > 0), JSON.stringify(present));

      /* INVALID EMAIL — refuse with the client form's message, then repair in place. */
      await page.click("#dh-tile-invalid-email");
      await page.waitForTimeout(500);
      const inv = await page.evaluate(() => {
        const w = document.querySelector("#dh-invalid-email-panel .dh-fix[data-client]");
        const row = w.closest(".row-item");
        return { id: w.dataset.client, prefill: w.querySelector(".dh-fix-input").value, shown: (row.querySelector(".s") || {}).textContent.trim() };
      });
      ok("§D2 · the broken value is PREFILLED so the typo is one keystroke from fixed", inv.prefill && inv.prefill === inv.shown, JSON.stringify(inv));
      const before = await page.evaluate(() => ({
        headline: Number(document.getElementById("dh-readiness-headline").dataset.total),
        tile: (document.querySelector("#dh-tile-invalid-email .num") || {}).textContent.trim(),
      }));
      await page.evaluate((id) => {
        const w = document.querySelector(`#dh-invalid-email-panel .dh-fix[data-client="${id}"]`);
        w.querySelector(".dh-fix-input").value = "nope";
        w.querySelector(".dh-fix-save").click();
      }, inv.id);
      await page.waitForTimeout(700);
      const refuse = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("clients").select("email").eq("id", id).single();
        return {
          toast: (document.getElementById("toast") || {}).textContent || "",
          rowStays: !!document.querySelector(`#dh-invalid-email-panel .dh-fix[data-client="${id}"]`),
          db: data && data.email,
        };
      }, inv.id);
      eq("§D3 · a bad value is refused with the client form's OWN message, verbatim", refuse.toast, '"nope" isn\'t a valid email address.');
      ok("§D3b · the row stays and the database is untouched", refuse.rowStays && refuse.db === inv.prefill, JSON.stringify(refuse));
      const goodEmail = `fixed.${tag().toLowerCase()}@example.com`;
      await page.evaluate(({ id, v }) => {
        const w = document.querySelector(`#dh-invalid-email-panel .dh-fix[data-client="${id}"]`);
        w.querySelector(".dh-fix-input").value = v;
        w.querySelector(".dh-fix-save").click();
      }, { id: inv.id, v: goodEmail });
      await page.waitForTimeout(1000);
      const saved = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("clients").select("email").eq("id", id).single();
        return {
          db: data && data.email,
          rowGone: !document.querySelector(`#dh-invalid-email-panel .dh-fix[data-client="${id}"]`),
          headline: Number(document.getElementById("dh-readiness-headline").dataset.total),
          toast: (document.getElementById("toast") || {}).textContent || "",
        };
      }, inv.id);
      eq("§D4 · a valid value writes exactly the one client column", saved.db, goodEmail);
      ok("§D4b · the row leaves the list", saved.rowGone);
      eq("§D4c · the headline comes down by one, exactly like a case-column fix", saved.headline, before.headline - 1);
      ok("§D4d · the toast names the person and the field", /email set to/.test(saved.toast), saved.toast);

      /* INVALID PHONE — the phone message, verbatim. */
      await page.click("#dh-tile-invalid-phone");
      await page.waitForTimeout(500);
      const invP = await page.evaluate(() => {
        const w = document.querySelector("#dh-invalid-phone-panel .dh-fix[data-client]");
        return w ? { id: w.dataset.client } : null;
      });
      if (invP) {
        await page.evaluate((id) => {
          const w = document.querySelector(`#dh-invalid-phone-panel .dh-fix[data-client="${id}"]`);
          w.querySelector(".dh-fix-input").value = "123";
          w.querySelector(".dh-fix-save").click();
        }, invP.id);
        await page.waitForTimeout(700);
        const pToast = await txt(page, "#toast");
        eq("§D5 · a bad phone is refused with the client form's OWN message, verbatim",
          pToast, '"123" isn\'t a valid phone number — UK numbers need 11 digits (e.g. 07700 900123).');
        await page.evaluate((id) => {
          const w = document.querySelector(`#dh-invalid-phone-panel .dh-fix[data-client="${id}"]`);
          w.querySelector(".dh-fix-input").value = "07700 900456";
          w.querySelector(".dh-fix-save").click();
        }, invP.id);
        await page.waitForTimeout(1000);
        const pSaved = await page.evaluate(async (id) => {
          const { data } = await window.__mockDb.from("clients").select("phone").eq("id", id).single();
          return { db: data && data.phone, rowGone: !document.querySelector(`#dh-invalid-phone-panel .dh-fix[data-client="${id}"]`) };
        }, invP.id);
        ok("§D5b · the good number saves and the row leaves", pSaved.db === "07700 900456" && pSaved.rowGone, JSON.stringify(pSaved));
      } else {
        ok("§D5 · (fixture holds no invalid phone — refusal covered on email; save covered below)", true);
      }

      /* MISSING PHONE — the "N of M" tile comes down on BOTH numbers. */
      await page.click("#dh-tile-phone");
      await page.waitForTimeout(500);
      const mp = await page.evaluate(() => {
        const w = document.querySelector("#dh-phone-panel .dh-fix[data-client]");
        const num = (document.querySelector("#dh-tile-phone .num") || {}).textContent.trim();
        return w ? { id: w.dataset.client, tile: num } : null;
      });
      ok("§D6pre · fixture sanity — a client is missing a phone", !!mp, JSON.stringify(mp));
      if (mp) {
        const m = mp.tile.match(/^(\d+) of (\d+)$/);
        ok("§D6a · the tile reads \"N of M\" before the fix (r29 §G's format)", !!m, mp.tile);
        await page.evaluate((id) => {
          const w = document.querySelector(`#dh-phone-panel .dh-fix[data-client="${id}"]`);
          w.querySelector(".dh-fix-input").value = "07700 900789";
          w.querySelector(".dh-fix-save").click();
        }, mp.id);
        await page.waitForTimeout(1000);
        const after = await page.evaluate(async (id) => {
          const { data } = await window.__mockDb.from("clients").select("phone").eq("id", id).single();
          return { tile: (document.querySelector("#dh-tile-phone .num") || {}).textContent.trim(), db: data && data.phone };
        }, mp.id);
        eq("§D6b · the save lands on the client", after.db, "07700 900789");
        eq("§D6c · BOTH numbers of the \"N of M\" tile come down, format kept",
          after.tile, `${Number(m[1]) - 1} of ${Number(m[2]) - 1}`);
      }

      /* MISSING EMAIL — the panel's rows are row-items with the fix cell now. */
      const me = await page.evaluate(() => {
        const w = document.querySelector("#dh-missing-panel .dh-fix[data-client]");
        return w ? { id: w.dataset.client, left: (document.querySelector("#dh-missing-panel h3 .dh-left-n") || {}).textContent } : null;
      });
      ok("§D7pre · fixture sanity — a client with a live case is missing an email", !!me, JSON.stringify(me));
      if (me) {
        ok("§D7a · the panel carries its own \"N left in this list\" counter now (dhSyncPanelLeft)",
          /left in this list/.test(me.left || ""), me.left);
        const goodEmail2 = `added.${tag().toLowerCase()}@example.com`;
        await page.evaluate(({ id, v }) => {
          const w = document.querySelector(`#dh-missing-panel .dh-fix[data-client="${id}"]`);
          w.querySelector(".dh-fix-input").value = v;
          w.querySelector(".dh-fix-save").click();
        }, { id: me.id, v: goodEmail2 });
        await page.waitForTimeout(1000);
        const meAfter = await page.evaluate(async (id) => {
          const { data } = await window.__mockDb.from("clients").select("email").eq("id", id).single();
          return { db: data && data.email, rowGone: !document.querySelector(`#dh-missing-panel .dh-fix[data-client="${id}"]`) };
        }, me.id);
        ok("§D7b · the save lands and the row leaves", meAfter.db === goodEmail2 && meAfter.rowGone, JSON.stringify(meAfter));
      }

      eq("§D · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

    /* =====================================================================
       §E · B4b — the headline's honest reason, at both render sites
       ===================================================================== */
    {
      console.log("\n— §E · the headline reads \"— automations and reports read these exact fields\" at BOTH render sites (p4)");
      const page = await boot(browser, "p4");
      const errBefore = realErrs(page).length;
      /* One guaranteed decrementable row, so the rewrite site can be exercised without emptying
         a whole check. */
      const t = tag();
      await mkCase(page, { first: "R77E", last: "NoLoan" + t, case: { completed_at: new Date(Date.now() - 20 * 86400000).toISOString(), lender: "R77E", mortgage_account_number: "R77E-1", loan_amount: null } });
      await goPage(page, "data", 3600);
      const h1 = await txt(page, "#dh-readiness-headline");
      ok("§E1 · the RENDER site carries the new reason", /to clear — automations and reports read these exact fields\.$/.test(h1 || ""), h1);
      ok("§E1b · \"before importing\" is gone from the page", !/before importing/.test(h1 || ""), h1);
      await page.click("#dh-tile-loan");
      await page.waitForTimeout(700);
      await page.evaluate(() => {
        const w = document.querySelector("#dh-loan-panel .dh-fix[data-case]");
        w.querySelector(".dh-fix-input").value = "185000";
        w.querySelector(".dh-fix-save").click();
      });
      await page.waitForTimeout(1200);
      const h2 = await txt(page, "#dh-readiness-headline");
      ok("§E2 · the DECREMENT site rewrites the same sentence — the two can never drift",
        /to clear — automations and reports read these exact fields\.$/.test(h2 || "") && !/before importing/.test(h2 || ""), h2);
      eq("§E · no console errors", realErrs(page).slice(errBefore), []);
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r77_health: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
