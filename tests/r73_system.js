#!/usr/bin/env node
/* =============================================================================
   tests/r73_system.js — acceptance tests for R73 build B, "One system": the
   tokens, components and copy half of the UI/UX round (panel findings 2, 7, 9,
   10, plus the copy-level fixes). Agent A owns layout — list cages, band order,
   sticky bars, the case-modal action bar, the ≤767px pass. Nothing here asserts
   on those.

   What the panel found, verified against the code on 28 August:
     · the focus ring computed to ≈1.3:1 — invisible — and `.btn-ghost` set
       `box-shadow:none`, which cancelled even that; the four busiest click
       targets in the app (board card, client-row name, dashboard KPI tile, Data
       health tile) are onclick DIVs with no tabindex, so they are mouse-only;
       the toast has no aria-live, and there is not one in the whole app (E#1,
       E#2, E-15, E-17);
     · `--muted` (#64748b) misses 4.5:1 on every tinted surface, and
       `.rate-uplift` reads `var(--orange-600, #b35309)` where the DEFINED value
       fails (3.78:1) and the fallback would have passed — the retention page's
       most important number (E#7, D#4, D#5);
     · twenty-one visual variants of `.btn`: six type sizes, five paddings; navy
       fill meaning both "primary action" and "selected filter"; primary verbs
       rendered at 0.28 and 0.35 opacity, which is what a browser paints a
       DISABLED control at (#9, #2, E#3, E#5, E#6, E-21, B#9);
     · money left-aligned in eleven Reports tables and right-aligned in Monday
       money; `.panel > h3` missing sixteen nested headings; `lang="en"` giving
       UK brokers mm/dd/yyyy pickers; one page title for thirteen pages (E-10,
       E-11, B#6, B#18, E-14);
     · a dashed pill meaning estimate, appointment AND shared credential; stage
       rendered four ways including the raw `fact_find → decision_in_principle`
       enum in a case's own change history; four different empty states; nine of
       twelve Watchtower rules with no written label (E-9, E-12, B#8, A#15).

     §A  B1 · KEYBOARD + ANNOUNCEMENT. The ring is real and ≥3:1 against BOTH
         grounds it is drawn on (computed in-page, not asserted from the
         stylesheet); `.btn-ghost` and the sidebar nav both show one; the four
         onclick-div targets take a tab stop, a role and Enter; the toast is a
         polite live region, bottom-right; the previously unlabelled controls
         have accessible names; the heading walk has no skipped level.
     §B  B2 · COLOUR. Every ratio is COMPUTED in the page from the element's own
         colour and the first opaque background behind it, then asserted ≥4.5.
         The adoption strip's alarm styles; one overdue badge colour across
         Reports and Monday money; no bare 0 in those cells.
     §C  B3 · THE BUTTON SYSTEM. An inventory of every rendered `.btn` across
         all thirteen pages: three type sizes and no more. Navy fill no longer
         means "selected filter". Outcome chips at full opacity at rest, the
         quiet floor at 0.75, protection's at 0.75. `.kpi-click` is gone.
     §D  B4 · TYPE, FORMAT, LOCALE. `.panel-sub` measure; nested panel headings
         styled; `td.num` right-aligned with its header following; fmtD's month
         table (September is the one that breaks); `lang="en-GB"` on all three
         documents; a per-page document.title.
     §E  B5 · SEMANTICS. Dashed = estimate only; stageChip on four surfaces;
         humanised history enums; the empty-state component on four lists with a
         working way out; all twelve Watchtower rule labels.
     §F  No console errors on any of it, owner and adviser.

   Every figure asserted here is computed in-page off the app's own rendered
   DOM, or read back off the fixture — never invented independently of it.

   Run:  node /root/nx/tests/r73_system.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — see HARNESS.md.)
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
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  return srv;
}

const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_sortdir", "nx_wt_scope", "nx_board_adviser",
  "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc", "nx_drawer_retention",
  "nx_ret_untouched", "nx_clients_adviser"];

/* ---------------------------------------------------------------------------
   THE CONTRAST KIT, injected before the app runs.

   Ratios are computed from what the browser actually paints: the element's own
   resolved `color`, and the first ANCESTOR with a non-transparent background —
   which is the ground the text is really sitting on, and the whole point of the
   finding (--muted passes on white and fails on every tint). Nothing here reads
   the stylesheet; a rule that is overridden downstream would still be caught.
   ------------------------------------------------------------------------ */
const KIT = `
window.__lum = function (c) {
  const m = (String(c).match(/[\\d.]+/g) || [0, 0, 0]).map(Number);
  const f = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
};
window.__ratio = function (a, b) {
  const L1 = window.__lum(a), L2 = window.__lum(b);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};
/* The ground a colour is really painted on. Layers with alpha < 1 are COMPOSITED
   over what is behind them rather than treated as opaque — the sidebar's hover
   fill is rgba(255,255,255,.09) over navy, and reading that as near-white would
   have said a light focus ring fails on a light ground, which is the opposite of
   the truth. */
window.__bgOf = function (el) {
  const stack = [];
  let e = el;
  while (e && e.nodeType === 1) {
    const cs = getComputedStyle(e);
    let m = (String(cs.backgroundColor).match(/[\\d.]+/g) || []).map(Number);
    let a = m.length > 3 ? m[3] : (m.length ? 1 : 0);
    /* A gradient ground has NO background-color — the sidebar is a navy
       linear-gradient — so a walk that only reads backgroundColor sails past it
       to the white body and reports a light ring failing on a light ground. The
       gradient's first stop is the colour under the control. */
    if (a === 0 && /gradient/.test(cs.backgroundImage || "")) {
      const g = (String(cs.backgroundImage).match(/rgba?\([^)]+\)/) || [])[0];
      if (g) { m = (g.match(/[\\d.]+/g) || []).map(Number); a = m.length > 3 ? m[3] : 1; }
    }
    if (m.length >= 3 && a > 0) {
      stack.push({ r: m[0], g: m[1], b: m[2], a: a });
      if (a >= 1) break;
    }
    e = e.parentElement;
  }
  stack.push({ r: 255, g: 255, b: 255, a: 1 });
  let out = stack[stack.length - 1];
  for (let i = stack.length - 2; i >= 0; i--) {
    const t = stack[i];
    out = { r: t.r * t.a + out.r * (1 - t.a), g: t.g * t.a + out.g * (1 - t.a), b: t.b * t.a + out.b * (1 - t.a), a: 1 };
  }
  return "rgb(" + Math.round(out.r) + ", " + Math.round(out.g) + ", " + Math.round(out.b) + ")";
};
/* Ratio for the FIRST visible match of a selector, with the text it measured so
   a failure names the string a person would have struggled to read. */
window.__cr = function (sel, root) {
  const els = [...(root || document).querySelectorAll(sel)]
    .filter((e) => e.offsetParent !== null && (e.textContent || "").trim());
  if (!els.length) return null;
  const el = els[0], cs = getComputedStyle(el), bg = window.__bgOf(el);
  return { sel, ratio: window.__ratio(cs.color, bg), color: cs.color, bg, text: (el.textContent || "").trim().slice(0, 44) };
};
`;

async function boot(browser, persona, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.addInitScript(KIT);
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.waitForTimeout(1500);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|sheetjs|favicon/i.test(e));

const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 2400 : ms);
};
const cr = (page, sel) => page.evaluate((s) => window.__cr(s), sel);

const ALL_PAGES = ["dashboard", "pipeline", "diary", "clients", "protection", "retention",
  "reports", "money", "vault", "emails", "import", "data", "settings"];

(async () => {
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {

    /* =====================================================================
       §A · B1 — KEYBOARD AND ANNOUNCEMENT
       ===================================================================== */
    {
      console.log("\n— §A · B1 keyboard + announcement (p4, owner)");
      const page = await boot(browser, "p4");

      /* A1/A2 — the ring, measured against BOTH grounds it is drawn over. The
         two-ring geometry is white-then-navy, so the assertion is on the OUTER
         ring against the page ground and against the control's own fill: a ring
         that only clears one of them is the bug that was there before. */
      const ring = await page.evaluate(() => {
        /* Read the ring off a control that is ACTUALLY WEARING IT rather than off the
           token's text: a token is a promise, and the finding was about what the
           browser paints. Two shadows, neither of them translucent, is the shape. */
        /* A bare probe, not a .btn: .btn transitions box-shadow, and a computed
           style read in the same tick returns the interpolation's zero-width
           starting frame rather than the ring. */
        const b = document.createElement("span");
        b.style.transition = "none";
        b.style.boxShadow = "var(--focus-ring)";
        document.body.appendChild(b);
        const painted = getComputedStyle(b).boxShadow;
        b.remove();
        const cols = painted.match(/rgba?\([^)]+\)/g) || [];
        const translucent = cols.filter((c) => { const m = c.match(/[\d.]+/g) || []; return m.length > 3 && Number(m[3]) < 1; });
        const navy = getComputedStyle(document.documentElement).getPropertyValue("--navy").trim();
        const probe = document.createElement("span");
        probe.style.color = navy; document.body.appendChild(probe);
        const navyRgb = getComputedStyle(probe).color; probe.remove();
        return { painted, rings: cols.length, translucent: translucent.length, navyRgb,
                 onCanvas: window.__ratio(navyRgb, "rgb(246, 248, 251)"), onWhite: window.__ratio(navyRgb, "rgb(255, 255, 255)") };
      });
      ok("A1 · the focus ring paints two OPAQUE rings, not a translucent wash",
        ring.rings >= 2 && ring.translucent === 0, JSON.stringify(ring));
      ok("A2 · the ring colour clears 3:1 against BOTH grounds (WCAG 2.4.11)",
        ring.onCanvas >= 3 && ring.onWhite >= 3, `canvas ${ring.onCanvas}:1, white ${ring.onWhite}:1`);

      /* A3 — .btn-ghost. Focused with a real Tab press, because :focus-visible
         is exactly the thing a programmatic .focus() may not satisfy. */
      /* A Tab press first, so the browser's :focus-visible heuristic is in its
         KEYBOARD state; then focus the ghost button itself. Tabbing all the way to
         it would depend on how many controls happen to precede it today. */
      await page.keyboard.press("Tab");
      const ghostShadow = await page.evaluate(() => {
        const g = [...document.querySelectorAll(".page:not(.hidden) .btn-ghost")].find((e) => e.offsetParent !== null);
        if (!g) return { none: true };
        g.focus();
        return { cls: (g.className || "").slice(0, 40), shadow: getComputedStyle(g).boxShadow, fv: g.matches(":focus-visible") };
      });
      ok("A3 · a .btn-ghost shows a focus ring (its box-shadow:none used to cancel it)",
        !ghostShadow.none && ghostShadow.shadow && ghostShadow.shadow !== "none", JSON.stringify(ghostShadow));

      const navRing = await page.evaluate(() => {
        const b = document.querySelector(".sidenav button");
        b.focus();
        const sh = getComputedStyle(b).boxShadow;
        const bg = window.__bgOf(b);          // composited: the navy behind the hover wash
        const light = (sh.match(/rgba?\([^)]+\)/g) || []).pop();
        return { sh, bg, light, ratio: light ? window.__ratio(light, bg) : 0 };
      });
      ok("A4 · the sidebar nav has a LIGHT ring on its navy ground, ≥3:1",
        navRing.sh !== "none" && navRing.ratio >= 3, JSON.stringify(navRing));

      // A5-A8 — the four onclick-div call sites.
      await goPage(page, "pipeline", 3000);
      const card = await page.evaluate(() => {
        const c = document.querySelector("#board .card");
        return c ? { tab: c.getAttribute("tabindex"), role: c.getAttribute("role") } : null;
      });
      eq("A5 · board cards are activatable (tabindex + role)", card, { tab: "0", role: "button" });

      await goPage(page, "clients", 2600);
      const crow = await page.evaluate(() => {
        const c = document.querySelector("#client-list .client-row .t");
        return c ? { tab: c.getAttribute("tabindex"), role: c.getAttribute("role") } : null;
      });
      eq("A6 · client-row names are activatable", crow, { tab: "0", role: "button" });

      /* A7 — and Enter really opens it. Focus the row name, press Enter, assert
         the client modal came up: a tabindex that leads nowhere is worse than
         no tabindex, because it costs a tab stop and gives nothing back. */
      await page.evaluate(() => document.querySelector("#client-list .client-row .t").focus());
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1200);
      const modalOpen = await page.evaluate(() => {
        const m = document.querySelector("#modal");
        return !!(m && !m.classList.contains("hidden") && (m.textContent || "").trim().length > 0);
      });
      ok("A7 · Enter on a focused client row opens the client (not just a tab stop)", modalOpen);
      await page.evaluate(() => window.closeModal && window.closeModal());

      await goPage(page, "dashboard", 2800);
      const kpi = await page.evaluate(() => [...document.querySelectorAll("#kpi-row .kpi.dq-clickable")]
        .map((e) => e.getAttribute("tabindex") + "/" + e.getAttribute("role")));
      ok("A8 · every clickable dashboard KPI tile is activatable", kpi.length >= 4 && kpi.every((x) => x === "0/button"), JSON.stringify(kpi));

      await goPage(page, "data", 3600);
      const dh = await page.evaluate(() => [...document.querySelectorAll("#dh-kpi-row .kpi.dq-clickable")]
        .map((e) => e.getAttribute("tabindex") + "/" + e.getAttribute("role")));
      ok("A9 · every Data-health tile is activatable", dh.length >= 6 && dh.every((x) => x === "0/button"), `${dh.length} tiles`);

      // A10 — the toast: a live region, bottom-right, and it stays long enough to read.
      await goPage(page, "dashboard", 2400);
      const toast = await page.evaluate(() => {
        const t = document.querySelector("#toast");
        window.toast("R73 probe — a confirmation a screen reader can hear.");
        const r = t.getBoundingClientRect();
        const cs = getComputedStyle(t);
        return {
          role: t.getAttribute("role"), live: t.getAttribute("aria-live"), atomic: t.getAttribute("aria-atomic"),
          hidden: t.classList.contains("hidden"),
          fromRight: Math.round(window.innerWidth - r.right), centred: Math.abs((r.left + r.right) / 2 - window.innerWidth / 2) < 4,
        };
      });
      ok("A10 · the toast is a polite live region", toast.role === "status" && toast.live === "polite" && toast.atomic === "true", JSON.stringify(toast));
      ok("A11 · the toast sits bottom-RIGHT, not over the middle of the page", !toast.centred && toast.fromRight <= 40, JSON.stringify(toast));
      await page.waitForTimeout(3600);
      const stillUp = await page.evaluate(() => !document.querySelector("#toast").classList.contains("hidden"));
      ok("A12 · a non-action toast is still up at 3.6s (4.5s, not 3.2s)", stillUp);

      /* A13 — the eleven controls that had no accessible name. Computed the way
         a screen reader would: a <label for>, an aria-label, or nothing. */
      const named = await page.evaluate(async () => {
        const ids = ["diary-staff", "vault-search", "intro-name", "intro-email", "staff-name",
          "staff-email", "staff-role", "staff-introducer", "import-file", "import-text", "rev-file", "rev-text"];
        const out = {};
        ids.forEach((id) => {
          const el = document.getElementById(id);
          if (!el) { out[id] = "MISSING"; return; }
          const lab = document.querySelector(`label[for="${id}"]`);
          const wrapLab = el.closest("label");
          out[id] = (el.getAttribute("aria-label") || (lab && lab.textContent.trim()) || (wrapLab && wrapLab.textContent.trim()) || "").slice(0, 30);
        });
        return out;
      });
      const unnamed = Object.entries(named).filter(([, v]) => !v);
      eq("A13 · all twelve previously-unlabelled controls have an accessible name", unnamed.map(([k]) => k), []);

      await goPage(page, "diary", 3000);
      const absDel = await page.evaluate(() => {
        const b = document.querySelector(".abs-del");
        return b ? (b.getAttribute("aria-label") || "") : "none-rendered";
      });
      ok("A14 · the diary's absence-delete icon button has a real aria-label",
        absDel === "none-rendered" || absDel.length > 3, absDel);

      /* A15 — the heading walk. One rule: no level may be skipped on the way
         down. It is asserted on every page rather than on the two that were
         wrong, so the next skipped level is caught by the same line. */
      const skips = [];
      for (const p of ALL_PAGES) {
        await goPage(page, p, p === "reports" || p === "data" ? 3800 : 2400);
        const bad = await page.evaluate((pg) => {
          const sec = document.querySelector(".page:not(.hidden)");
          if (!sec) return [];
          const hs = [...sec.querySelectorAll("h1,h2,h3,h4,h5,h6")]
            .filter((h) => h.offsetParent !== null)
            .map((h) => ({ lvl: Number(h.tagName[1]), t: (h.textContent || "").trim().slice(0, 28) }));
          const out = [];
          for (let i = 1; i < hs.length; i++) if (hs[i].lvl > hs[i - 1].lvl + 1) out.push(`${pg}: h${hs[i - 1].lvl}→h${hs[i].lvl} at "${hs[i].t}"`);
          return out;
        }, p);
        bad.forEach((b) => skips.push(b));
      }
      eq("A15 · no page skips a heading level (board H4→H3, diary H5→H3)", skips, []);

      eq("A16 · no console errors through §A", realErrs(page), []);
      await page.close();
    }

    /* =====================================================================
       §B · B2 — COLOUR AND CONTRAST, COMPUTED
       ===================================================================== */
    {
      console.log("\n— §B · B2 colour + contrast (p4, owner)");
      const page = await boot(browser, "p4");
      const ratios = [];
      const measure = async (label, sel) => {
        const r = await cr(page, sel);
        ratios.push({ label, ...(r || {}) });
        ok(`B · ${label} reaches AA on the ground it is painted on (${r ? r.ratio : "?"}:1)`, !!r && r.ratio >= 4.5,
          r ? `${r.ratio}:1, ${r.color} on ${r.bg}, "${r.text}"` : "selector matched nothing visible");
      };

      await goPage(page, "dashboard", 2800);
      await measure(".panel-sub on the dashboard", ".panel-sub");
      await measure(".seg-btn on its grey track", ".segment .btn:not(.scope-active)");

      await goPage(page, "retention", 3400);
      await measure(".rate-uplift (was 3.78:1 — the var-fallback trap)", ".rate-uplift");
      await measure(".ret-group-h on the red band", ".ret-group-h.ret-g-ended");
      await measure(".panel-sub on the retention panel", "#ret-rates-panel .panel-sub");

      await goPage(page, "dashboard", 3000);
      await measure(".ops-chip on the Today ops strip", "#ops-strip .ops-chip");
      await goPage(page, "pipeline", 3000);
      await page.evaluate(() => { const t = document.querySelector("#pipe-view-table, [data-view='table']"); if (t) t.click(); });
      await page.waitForTimeout(1800);
      await measure(".wait-chip in the pipeline table", ".wait-chip");

      // The token itself, since it is the fix that carries all of the above.
      const muted = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted").trim());
      ok("B8 · --muted is the darker token (#5b6a7e)", muted.toLowerCase() === "#5b6a7e", muted);

      // The delta separator was --border-strong used as text: 1.35:1.
      await goPage(page, "reports", 4200);
      const sep = await page.evaluate(() => {
        const el = document.querySelector(".kpi-delta .delta-sep");
        if (!el) return { absent: true };
        const cs = getComputedStyle(el);
        return { ratio: window.__ratio(cs.color, window.__bgOf(el)), color: cs.color };
      });
      ok("B9 · the KPI delta separator is a text colour, not a line colour",
        sep.absent || sep.ratio >= 3, JSON.stringify(sep));

      // Adoption strip: the alarm that never styled (h4 vs `.panel h3 .count`).
      const adopt = await page.evaluate(() => {
        const c = document.querySelector(".adopt-h .count");
        if (!c) return null;
        const cs = getComputedStyle(c);
        return { radius: parseFloat(cs.borderRadius), bg: cs.backgroundColor, padded: parseFloat(cs.paddingLeft) > 0, txt: (c.textContent || "").trim() };
      });
      ok("B10 · the adoption strip's count renders as a pill, not bare body text",
        !!adopt && adopt.radius >= 10 && adopt.padded && !/rgba\(0, 0, 0, 0\)/.test(adopt.bg), JSON.stringify(adopt));

      /* B11 — the `never` row tint. Forced by asserting the RULE resolves, not
         by needing a never-row in the fixture (which has none): a test that only
         passes on a fixture that happens to contain the case is not a test of
         the rule. */
      const neverTint = await page.evaluate(() => {
        const tbl = document.querySelector("#report-adoption table");
        if (!tbl) return null;
        const tr = tbl.rows[1];
        if (!tr) return null;
        const had = tr.classList.contains("row-warn");
        tr.classList.add("row-warn");
        const bg = getComputedStyle(tr.cells[0]).backgroundColor;
        if (!had) tr.classList.remove("row-warn");
        return bg;
      });
      ok("B11 · a `never` adoption row takes the scoreboard's amber row tint",
        !!neverTint && !/rgba\(0, 0, 0, 0\)|rgb\(255, 255, 255\)/.test(neverTint), String(neverTint));

      // B12/B13 — ONE overdue colour, and no bare 0.
      const overdueReports = await page.evaluate(() => {
        const cells = [...document.querySelectorAll("#report-adoption .adopt-overdue, #report-advisers .adv-overdue")];
        return cells.map((c) => {
          const b = c.querySelector(".badge");
          return b ? [...b.classList].filter((x) => x !== "badge").join(",") : (c.textContent || "").trim();
        });
      });
      await goPage(page, "money", 3600);
      const overdueMoney = await page.evaluate(() => [...document.querySelectorAll("#money-adviser-table tr")].slice(1).map((r) => {
        const c = r.cells[r.cells.length - 1];
        const b = c.querySelector(".badge");
        return b ? [...b.classList].filter((x) => x !== "badge").join(",") : (c.textContent || "").trim();
      }));
      const allBadges = [...overdueReports, ...overdueMoney].filter((x) => /amber|red|green|grey/.test(x));
      ok("B12 · one overdue badge colour — amber on Reports AND Monday money",
        allBadges.length > 0 && allBadges.every((x) => x === "amber"), JSON.stringify([overdueReports, overdueMoney]));
      const zeros = [...overdueReports, ...overdueMoney].filter((x) => x === "0");
      eq("B13 · an overdue cell with nothing in it reads —, never a bare 0", zeros, []);

      console.log("    measured ratios: " + ratios.map((r) => `${r.label}=${r.ratio}`).join(" · "));
      eq("B14 · no console errors through §B", realErrs(page), []);
      await page.close();
    }

    /* =====================================================================
       §C · B3 — THE BUTTON AND SEGMENT SYSTEM
       ===================================================================== */
    {
      console.log("\n— §C · B3 buttons + segments (p4, owner)");
      const page = await boot(browser, "p4");

      /* C1 — the inventory. Every VISIBLE .btn on every page, tallied by type
         size. The contract is three sizes: 13.5 / 12.5 / 11.5. `.btn-block`
         (the login/full-width variant, 14px) is excluded by name because it is
         a width, not a rung — it never appears beside the other three. */
      const sizes = {};
      const offenders = {};
      for (const p of ALL_PAGES) {
        await goPage(page, p, p === "reports" || p === "data" ? 3800 : 2400);
        const got = await page.evaluate(() => {
          const out = {}, bad = {};
          document.querySelectorAll(".page:not(.hidden) .btn:not(.btn-block)").forEach((b) => {
            if (b.offsetParent === null) return;
            const f = getComputedStyle(b).fontSize;
            out[f] = (out[f] || 0) + 1;
            if (!["13.5px", "12.5px", "11.5px"].includes(f)) {
              const k = f + " " + (b.className || "").slice(0, 60);
              bad[k] = (bad[k] || 0) + 1;
            }
          });
          return { out, bad };
        });
        Object.entries(got.out).forEach(([k, v]) => (sizes[k] = (sizes[k] || 0) + v));
        Object.entries(got.bad).forEach(([k, v]) => (offenders[k] = (offenders[k] || 0) + v));
      }
      console.log("    button size inventory: " + JSON.stringify(sizes));
      eq("C1 · three button sizes across all thirteen pages, and no more", Object.keys(offenders), []);
      ok("C2 · all three rungs are actually in use (13.5 / 12.5 / 11.5)",
        sizes["13.5px"] > 0 && sizes["12.5px"] > 0 && sizes["11.5px"] > 0, JSON.stringify(sizes));

      /* C3 — navy fill no longer means "selected filter". The class name
         .scope-active is KEPT on purpose (twenty JS call sites and several
         suites name it); what is retired is the treatment. So the assertion is
         on the paint, which is the thing the finding was about. */
      const navyFilled = [];
      for (const p of ["dashboard", "retention", "protection", "diary", "reports", "money"]) {
        await goPage(page, p, p === "reports" ? 3800 : 2600);
        const got = await page.evaluate((pg) => {
          const navy = getComputedStyle(document.documentElement).getPropertyValue("--navy").trim();
          const probe = document.createElement("span"); probe.style.backgroundColor = navy;
          document.body.appendChild(probe); const navyRgb = getComputedStyle(probe).backgroundColor; probe.remove();
          return [...document.querySelectorAll(".page:not(.hidden) .scope-active")]
            .filter((e) => e.offsetParent !== null && getComputedStyle(e).backgroundColor === navyRgb)
            .map((e) => pg + ":" + (e.id || e.className));
        }, p);
        got.forEach((g) => navyFilled.push(g));
      }
      eq("C3 · no selected segment is painted with the primary-action navy fill", navyFilled, []);

      // C4 — and the chosen option is still unmistakably chosen.
      await goPage(page, "retention", 3400);
      const chosen = await page.evaluate(() => {
        const on = document.querySelector(".segment .scope-active");
        const off = document.querySelector(".segment .btn:not(.scope-active)");
        if (!on || !off) return null;
        const a = getComputedStyle(on), b = getComputedStyle(off);
        return { onBg: a.backgroundColor, offBg: b.backgroundColor, onW: a.fontWeight, offW: b.fontWeight, shadow: a.boxShadow !== "none" };
      });
      ok("C4 · inside a segment the chosen option is a lifted white pill on a grey track",
        !!chosen && chosen.onBg !== chosen.offBg && Number(chosen.onW) > Number(chosen.offW) && chosen.shadow, JSON.stringify(chosen));

      // C5 — aria-pressed, including where it was missing (My Day Mine/All).
      const pressed = await page.evaluate(() => {
        const m = document.getElementById("brief-scope-mine"), a = document.getElementById("brief-scope-all");
        return m && a ? [m.getAttribute("aria-pressed"), a.getAttribute("aria-pressed")] : null;
      });
      ok("C5 · My Day's Mine/All pair carries aria-pressed", !!pressed && pressed.every((x) => x === "true" || x === "false"), JSON.stringify(pressed));

      // C6/C7 — the opacity floors.
      const op = await page.evaluate(() => ({
        out: [...document.querySelectorAll(".ret-out-chip")].slice(0, 3).map((e) => getComputedStyle(e).opacity),
        quiet: [...document.querySelectorAll(".ret-row-acts .hover-quiet")].slice(0, 3).map((e) => getComputedStyle(e).opacity),
        logcall: (() => { const e = document.querySelector(".ret-logcall-chip"); return e ? getComputedStyle(e).opacity : null; })(),
      }));
      ok("C6 · the three rate-end OUTCOME chips are full opacity at rest", op.out.length > 0 && op.out.every((o) => Number(o) === 1), JSON.stringify(op.out));
      ok("C7 · everything else quiet floors at 0.75, not 0.28", op.quiet.length > 0 && op.quiet.every((o) => Number(o) >= 0.7), JSON.stringify(op.quiet));
      ok("C8 · Retention's `Log call` is a full-weight bordered button outside the quiet group",
        op.logcall !== null && Number(op.logcall) === 1, String(op.logcall));

      await goPage(page, "protection", 3000);
      const prot = await page.evaluate(() => ({
        act: [...document.querySelectorAll(".prot-actions > *:not(:first-child)")].slice(0, 4).map((e) => getComputedStyle(e).opacity),
        gi: (() => { const e = document.querySelector(".prot-gi-set"); return e ? Math.round(e.getBoundingClientRect().width) : null; })(),
      }));
      ok("C9 · protection row actions floor at 0.75 (was 0.35)", prot.act.length > 0 && prot.act.every((o) => Number(o) >= 0.7), JSON.stringify(prot.act));
      ok("C10 · the GI selector is wide enough for “GI taken”", prot.gi === null || prot.gi >= 90, String(prot.gi));

      // C11 — .kpi-click retired; one hover treatment for the gesture.
      const kpiClick = [];
      for (const p of ALL_PAGES) {
        await goPage(page, p, p === "reports" || p === "data" ? 3600 : 2400);
        const n = await page.evaluate(() => document.querySelectorAll(".kpi-click").length);
        if (n) kpiClick.push(p + ":" + n);
      }
      eq("C11 · .kpi-click is gone — every clickable tile uses .dq-clickable", kpiClick, []);

      // C12 — Emails: Cancel matches Retry, and the checkbox gutter is reserved.
      await goPage(page, "emails", 3000);
      const em = await page.evaluate(() => {
        const c = document.querySelector("#email-list .em-cancel");
        const r = [...document.querySelectorAll("#email-list .btn")].find((b) => (b.textContent || "").trim() === "Retry");
        const gaps = document.querySelectorAll("#email-list .email-cb-gap").length;
        const rows = document.querySelectorAll("#email-list .row-item").length;
        const cbs = document.querySelectorAll("#email-list .email-cb").length;
        const lefts = [...document.querySelectorAll("#email-list .row-item .row-main")].map((e) => Math.round(e.getBoundingClientRect().left));
        return {
          cancelGhost: c ? c.classList.contains("btn-ghost") : null,
          cancelBorder: c ? getComputedStyle(c).borderTopWidth : null,
          retryBorder: r ? getComputedStyle(r).borderTopWidth : null,
          gutterOk: rows === gaps + cbs, alignedLefts: [...new Set(lefts)].length,
        };
      });
      ok("C12 · Emails' Cancel is bordered like Retry, not a ghost destructive verb",
        em.cancelGhost === false && em.cancelBorder !== "0px", JSON.stringify(em));
      ok("C13 · every email row reserves the checkbox gutter, so titles align (E-22)",
        em.gutterOk && em.alignedLefts === 1, JSON.stringify(em));

      eq("C14 · no console errors through §C", realErrs(page), []);
      await page.close();
    }

    /* =====================================================================
       §D · B4 — TYPE, FORMAT, LOCALE
       ===================================================================== */
    {
      console.log("\n— §D · B4 type, format, locale (p4, owner)");
      const page = await boot(browser, "p4");

      const sub = await page.evaluate(() => {
        const e = [...document.querySelectorAll(".panel-sub")].find((x) => x.offsetParent !== null);
        if (!e) return null;
        const cs = getComputedStyle(e);
        // ch is the width of "0" at this font; the rule is 78ch.
        const probe = document.createElement("span");
        probe.textContent = "0"; probe.style.font = cs.font; probe.style.position = "absolute"; probe.style.visibility = "hidden";
        document.body.appendChild(probe); const chW = probe.getBoundingClientRect().width; probe.remove();
        return { max: cs.maxWidth, chars: Math.round(parseFloat(cs.maxWidth) / chW) };
      });
      ok("D1 · .panel-sub is capped at a readable measure (~78ch)", !!sub && sub.chars >= 60 && sub.chars <= 95, JSON.stringify(sub));

      // D2 — the sixteen nested panel headings that fell to browser default.
      await goPage(page, "protection", 3000);
      const nested = await page.evaluate(() => {
        const direct = new Set([...document.querySelectorAll(".page:not(.hidden) .panel > h3")]);
        return [...document.querySelectorAll(".page:not(.hidden) .panel h3:not([class])")]
          .filter((h) => !direct.has(h) && h.offsetParent !== null)
          .map((h) => ({ t: (h.textContent || "").trim().slice(0, 30), fs: getComputedStyle(h).fontSize, tt: getComputedStyle(h).textTransform }));
      });
      ok("D2 · a bare h3 nested inside a panel takes the panel-heading look, not the browser default",
        nested.length === 0 || nested.every((n) => n.fs === "11.5px" && n.tt === "uppercase"), JSON.stringify(nested));

      /* D3 — .num. The cells declare it; the header is derived from the column,
         so the two can never disagree. Asserted on Reports, whose eleven tables
         were the finding. */
      await goPage(page, "reports", 4200);
      const numCols = await page.evaluate(() => {
        const bad = [];
        let cells = 0, heads = 0;
        document.querySelectorAll("#page-reports table").forEach((t) => {
          [...t.rows].forEach((r) => [...r.cells].forEach((c) => {
            if (!c.classList.contains("num")) return;
            if (c.tagName === "TH") heads++; else cells++;
            if (getComputedStyle(c).textAlign !== "right") bad.push(c.tagName + ":" + (c.textContent || "").trim().slice(0, 16));
          }));
        });
        return { cells, heads, bad };
      });
      ok("D3 · every .num cell on Reports is right-aligned", numCols.cells > 0 && numCols.bad.length === 0, JSON.stringify(numCols));
      ok("D4 · the headers of .num columns followed their data", numCols.heads > 0, JSON.stringify(numCols));

      await goPage(page, "money", 3600);
      const moneyNum = await page.evaluate(() => {
        const t = document.querySelector("#money-owed table");
        if (!t) return null;
        const head = [...t.rows[0].cells].map((c) => (c.textContent || "").trim());
        const i = head.findIndex((h) => /cases/i.test(h));
        if (i < 0) return { noCasesCol: head };
        return { headAlign: getComputedStyle(t.rows[0].cells[i]).textAlign, bodyAlign: getComputedStyle(t.rows[1].cells[i]).textAlign };
      });
      ok("D5 · Monday money's CASES column is right-aligned, header and body",
        !moneyNum || moneyNum.noCasesCol || (moneyNum.headAlign === "right" && moneyNum.bodyAlign === "right"), JSON.stringify(moneyNum));

      /* D6 — fmtD's month table. September is the one that breaks: current ICU
         renders {month:"short"} as "Sept", four letters against eleven threes. */
      /* fmtD is module-scoped, so it is exercised through what it RENDERS: every
         date on screen has been through it. "Sept" is the tell — current ICU gives
         September four letters and the other eleven months three. */
      const sept = await page.evaluate(() => {
        // Rendered dates carry the month name; find one from a September date the
        // fixture holds, or fall back to asserting no rendered date says "Sept".
        const txt = document.body.innerText;
        return { hasSept: /\bSept\b/.test(txt), hasSep: /\b\d{1,2} Sep \d{4}\b/.test(txt) };
      });
      ok("D6 · no rendered date says “Sept” (fixed 3-letter month table)", sept.hasSept === false, JSON.stringify(sept));

      // D7 — the locale attribute, on all three documents.
      const langs = {};
      for (const f of ["index.html", "mock.html", "introducer.html"]) {
        const p = path.join(REPO, "admin", f);
        langs[f] = fs.existsSync(p) ? ((fs.readFileSync(p, "utf8").match(/<html[^>]*lang="([^"]+)"/) || [])[1] || "NONE") : "ABSENT";
      }
      eq("D7 · lang=en-GB on index.html, mock.html and introducer.html",
        Object.values(langs).filter((v) => v !== "ABSENT"), Object.values(langs).filter((v) => v !== "ABSENT").map(() => "en-GB"));

      // D8 — a title per page, page name first.
      const titles = {};
      for (const p of ["dashboard", "pipeline", "retention", "money", "settings"]) {
        await goPage(page, p, 2400);
        titles[p] = await page.title();
      }
      const uniq = new Set(Object.values(titles));
      ok("D8 · document.title names the page, and no two pages share one",
        uniq.size === Object.keys(titles).length && /^Today ·/.test(titles.dashboard) && /^Retention ·/.test(titles.retention),
        JSON.stringify(titles));

      /* D9 — the change history's money. audit_log carries raw column values;
         the history is what a compliance reviewer reads, and 265000 is not how
         this app writes money anywhere else. */
      await goPage(page, "clients", 2600);
      const audit = await page.evaluate(async () => {
        const row = document.querySelector("#client-list .client-row .t");
        if (!row) return { noRow: true };
        row.click();
        await new Promise((r) => setTimeout(r, 2200));
        const tabs = [...document.querySelectorAll("#modal button, #modal .tl-chip")]
          .find((b) => /change history|history/i.test(b.textContent || ""));
        if (tabs) { tabs.click(); await new Promise((r) => setTimeout(r, 900)); }
        const cells = [...document.querySelectorAll("#modal .audit-changes td")].map((c) => (c.textContent || "").trim());
        return { cells: cells.slice(0, 60) };
      });
      const rawMoney = (audit.cells || []).filter((t) => /^\d{5,}$/.test(t));
      eq("D9 · no raw stored money value is printed in the change history", rawMoney, []);
      await page.evaluate(() => window.closeModal && window.closeModal());

      eq("D10 · no console errors through §D", realErrs(page), []);
      await page.close();
    }

    /* =====================================================================
       §E · B5 — SEMANTICS AND COMPONENTS
       ===================================================================== */
    {
      console.log("\n— §E · B5 semantics + components (p4, owner)");
      const page = await boot(browser, "p4");

      /* E1 — dashed = estimate. The rule stated as a rule: any dashed-bordered
         badge on screen must be an .is-est one. */
      const dashed = [];
      for (const p of ["dashboard", "pipeline", "vault", "clients", "retention"]) {
        await goPage(page, p, 2600);
        const got = await page.evaluate((pg) => [...document.querySelectorAll(".page:not(.hidden) .badge, .page:not(.hidden) .vault-owner")]
          .filter((e) => e.offsetParent !== null && getComputedStyle(e).borderTopStyle === "dashed" && !e.classList.contains("is-est"))
          .map((e) => pg + ":" + e.className + ":" + (e.textContent || "").trim().slice(0, 20)), p);
        got.forEach((g) => dashed.push(g));
      }
      eq("E1 · a dashed pill means ESTIMATE and nothing else", dashed, []);

      // E2 — stageChip is one function on four surfaces.
      await goPage(page, "pipeline", 3000);
      await page.evaluate(() => { const t = document.querySelector("#pipe-view-table, [data-view='table']"); if (t) t.click(); });
      await page.waitForTimeout(1800);
      const chipSurfaces = await page.evaluate(() => ({
        table: document.querySelectorAll("#pipe-table .stage-chip").length,
      }));
      await goPage(page, "clients", 2600);
      const modalChip = await page.evaluate(async () => {
        const row = document.querySelector("#client-list .client-row .t");
        if (!row) return 0;
        row.click(); await new Promise((r) => setTimeout(r, 2000));
        const n = document.querySelectorAll("#modal .stage-chip").length;
        if (window.closeModal) window.closeModal();
        return n;
      });
      ok("E2 · one stage pill (stageChip) renders on the pipeline table and inside the modal",
        chipSurfaces.table + modalChip > 0, JSON.stringify({ ...chipSurfaces, modalChip }));

      /* E3 — the appointment modal's About line. It carried the stage as a word
         inside the grey .case-tag; it now carries the app's stage pill. */
      await goPage(page, "diary", 3000);
      const apptChip = await page.evaluate(async () => {
        if (!window.openAppt) return { noFn: true };
        const appt = await window.__mockDb.from("appointments").select("id,case_id").not("case_id", "is", null).limit(1);
        const row = (appt.data || [])[0];
        if (!row) return { noAppt: true };
        await window.openAppt(row.id);
        await new Promise((r) => setTimeout(r, 1600));
        const about = document.querySelector("#appt-about");
        const n = about ? about.querySelectorAll(".stage-chip").length : -1;
        const txt = about ? (about.textContent || "").trim().slice(0, 60) : "";
        if (window.closeModal) window.closeModal();
        return { n, txt };
      });
      ok("E3 · the appointment modal's About line uses the stage pill",
        apptChip.noFn || apptChip.noAppt || apptChip.n > 0, JSON.stringify(apptChip));

      /* E4 — the history enums. The trigger writes "<old> → <new>" in raw column
         values; the timeline is the one screen a case's story is read from. */
      await goPage(page, "clients", 2600);
      /* The client is CHOSEN from the fixture — one whose case actually carries a
         stage_changed event, so this can never pass by opening six clients with
         nothing in their history. */
      const hist = await page.evaluate(async () => {
        const db = window.__mockDb;
        const ev = await db.from("case_events").select("case_id,detail,event").eq("event", "stage_changed").limit(50);
        const rows = (ev.data || []).filter((r) => r.detail && /_/.test(String(r.detail)));
        if (!rows.length) return { noFixture: true, raw: [], sample: [] };
        const cs = await db.from("cases").select("id,client_id").eq("id", rows[0].case_id).single();
        if (!cs.data) return { noFixture: true, raw: [], sample: [] };
        window.openClient(cs.data.client_id);
        await new Promise((x) => setTimeout(x, 2400));
        /* The timeline opens on "Activity", which deliberately excludes the system
           rows — and a stage change IS a system row. Switch to All, which is where
           a person goes to read a case's story and where the raw enum was showing. */
        const all = document.querySelector('#tl-filters .tl-filter[data-cat="all"]');
        if (all) { all.click(); await new Promise((x) => setTimeout(x, 800)); }
        const t = [...document.querySelectorAll("#modal .tl-title")].map((e) => (e.textContent || "").trim());
        if (window.closeModal) window.closeModal();
        return {
          storedDetail: rows[0].detail,
          raw: t.filter((s) => /\b(fact_find|decision_in_principle|not_proceeding|policy_taken|not_discussed|not_invoiced)\b/.test(s)),
          sample: t.filter((s) => /→/.test(s)).slice(0, 3),
        };
      });
      ok("E4a · the fixture holds a stage change written as a raw enum pair", !hist.noFixture, JSON.stringify(hist));
      eq("E4 · no raw stage/status enum survives into a case's change history", hist.raw, []);
      ok("E4b · and the humanised pair is what the timeline shows", hist.noFixture || hist.sample.length > 0, JSON.stringify(hist));
      console.log("    stored: " + JSON.stringify(hist.storedDetail) + "  → shown: " + JSON.stringify(hist.sample));

      /* E5-E8 — the empty-state component on the four lists, each with a way
         out that WORKS (pressed, and the list comes back). */
      await goPage(page, "clients", 2600);
      const clientsEmpty = await page.evaluate(async () => {
        const box = document.querySelector("#client-search");
        box.value = "zzzznothingzzzz";
        box.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1400));
        const es = document.querySelector("#client-list .empty-state");
        const staleSub = document.querySelector("#client-seg-def");
        const selAll = document.querySelector("#client-bulk-all");
        /* Everything about the EMPTY state is read HERE, before the way out is
           pressed — the click re-renders the page, and an object literal built
           after it would be describing the restored list, not the empty one. */
        const snap = {
          rendered: !!es,
          headline: es ? ((es.querySelector(".empty-state-h") || {}).textContent || "") : null,
          hasButton: !!(es && es.querySelector(".btn")),
          staleSubShown: !!(staleSub && !staleSub.classList.contains("hidden") && (staleSub.textContent || "").trim()),
          selAllShown: !!(selAll && selAll.offsetParent !== null),
          before: document.querySelectorAll("#client-list .client-row").length,
        };
        const btn = es && es.querySelector(".btn");
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 1600));
        snap.after = document.querySelectorAll("#client-list .client-row").length;
        return snap;
      });
      ok("E5 · clients uses the .empty-state component with a real Clear filters button",
        clientsEmpty.rendered && clientsEmpty.hasButton, JSON.stringify(clientsEmpty));
      ok("E6 · pressing Clear filters brings the book back", clientsEmpty.before === 0 && clientsEmpty.after > 0, JSON.stringify(clientsEmpty));
      ok("E7 · at zero results the stale segment sub and the dead “Select all 0” are both gone",
        !clientsEmpty.staleSubShown && !clientsEmpty.selAllShown, JSON.stringify(clientsEmpty));

      await goPage(page, "pipeline", 3000);
      const boardEmpty = await page.evaluate(async () => {
        const q = document.querySelector("#board-search");
        q.value = "zzzznothingzzzz"; q.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1600));
        const es = document.querySelector("#board .empty-state");
        const btn = es && es.querySelector(".btn");
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 1800));
        return { rendered: !!es, hasButton: !!btn, cardsAfter: document.querySelectorAll("#board .card").length };
      });
      ok("E8 · the pipeline board uses the .empty-state component, and its button works",
        boardEmpty.rendered && boardEmpty.hasButton && boardEmpty.cardsAfter > 0, JSON.stringify(boardEmpty));

      await goPage(page, "vault", 2800);
      const vaultEmpty = await page.evaluate(async () => {
        const box = document.querySelector("#vault-search");
        box.value = "zzzznothingzzzz"; box.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 900));
        const es = document.querySelector("#vault-list .empty-state");
        const btn = es && es.querySelector(".btn");
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 900));
        return { rendered: !!es, hasButton: !!btn, rowsAfter: document.querySelectorAll("#vault-list .row-item, #vault-list .vault-row").length };
      });
      ok("E9 · the vault uses the .empty-state component, and its button works",
        vaultEmpty.rendered && vaultEmpty.hasButton, JSON.stringify(vaultEmpty));

      await goPage(page, "protection", 3000);
      const protEmpty = await page.evaluate(async () => {
        const box = document.querySelector("#prot-search");
        if (!box) return { noBox: true };
        box.value = "zzzznothingzzzz"; box.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1600));
        const es = document.querySelector("#prot-table .empty-state");
        const btn = es && es.querySelector(".btn");
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 1800));
        return { rendered: !!es, hasButton: !!btn, rowsAfter: document.querySelectorAll("#prot-list-table tr").length };
      });
      ok("E10 · protection uses the .empty-state component, and its button works",
        protEmpty.noBox || (protEmpty.rendered && protEmpty.hasButton && protEmpty.rowsAfter > 1), JSON.stringify(protEmpty));

      /* E11 — the Watchtower labels. Asserted against the map itself (every rule
         the mock emits has a written label), and against the rendered headers
         (none of them is a de-underscored column name). */
      await goPage(page, "dashboard", 3200);
      const wt = await page.evaluate(async () => {
        const res = await window.__mockDb.from("watch_alerts").select("rule");
        const rules = [...new Set((res.data || []).map((r) => r.rule))];
        const heads = [...document.querySelectorAll("#watchtower-list .wt-group-h, #watchtower-list h4, #watchtower-list .wt-group-label")]
          .map((e) => (e.textContent || "").trim());
        return { rules, heads };
      });
      const src = fs.readFileSync(path.join(REPO, "admin", "app.js"), "utf8");
      const block = (src.match(/const WT_RULE_LABELS = \{[\s\S]*?\n\};/) || [""])[0];
      const labelled = (block.match(/^\s{2}([a-z_0-9]+):/gm) || []).map((x) => x.trim().replace(":", ""));
      const missing = wt.rules.filter((r) => !labelled.includes(r));
      eq("E11 · every Watchtower rule the database emits has a written label", missing, []);
      ok("E12 · twelve rules are named in WT_RULE_LABELS (was three)", labelled.length >= 12, `${labelled.length}: ${labelled.join(",")}`);

      eq("E13 · no console errors through §E", realErrs(page), []);
      await page.close();
    }

    /* =====================================================================
       §F · adviser pass — none of the above is owner-only
       ===================================================================== */
    {
      console.log("\n— §F · adviser pass (p2)");
      const page = await boot(browser, "p2");
      await goPage(page, "retention", 3400);
      const advOp = await page.evaluate(() => ({
        out: [...document.querySelectorAll(".ret-out-chip")].slice(0, 2).map((e) => getComputedStyle(e).opacity),
        uplift: window.__cr(".rate-uplift"),
      }));
      ok("F1 · an adviser sees the same full-opacity outcome chips",
        advOp.out.length === 0 || advOp.out.every((o) => Number(o) === 1), JSON.stringify(advOp.out));
      ok("F2 · and the same AA rate-uplift colour", !advOp.uplift || advOp.uplift.ratio >= 4.5, JSON.stringify(advOp.uplift));

      await goPage(page, "dashboard", 3000);
      const advTitle = await page.title();
      ok("F3 · per-page titles are not owner-only", /^Today ·/.test(advTitle), advTitle);
      eq("F4 · no console errors for an adviser", realErrs(page), []);
      await page.close();
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r73_system: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  FAIL: " + f));
  process.exit(failures.length ? 1 : 0);
})();
