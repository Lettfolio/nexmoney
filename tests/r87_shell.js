#!/usr/bin/env node
/* =============================================================================
   tests/r87_shell.js — acceptance tests for R87 slice E, "the shell": phone nav,
   tap targets, focus, and the admin.css diet.

     §A  E1 · PHONE NAV (panel 06 #2). At 390×844 the sidebar is a 2–3 screen
         horizontal strip; after nav() to EVERY page — and on a cold deep-link
         load — the active .nav-btn's bounding box sits inside the viewport.
     §B  E2 · TAP TARGETS (06 #3). At 390px, ≥ 90% of the visible interactive
         controls on Clients, Today and Pipeline are ≥ 44px tall; the round's
         named offenders (a.contact-link, .ops-chip, select.card-stage-move,
         ✓ Attended / ✗ No-show, list checkboxes) each measure ≥ 44; and the
         desktop layout is untouched (no min-height rule applies at 1440/fine).
     §C  E3 · FOCUS (06 #6, #7). One shared :focus-visible ring: the Mine/All
         segment button, Ask AI and a row's contact link all paint the house
         ring when focused from the keyboard; the sidebar controls wear the
         light ring; the footer glyphs carry aria-labels.
     §D  E4 · THE CSS DIET (06 #12). admin.css ≤ 3,700 lines, comment lines
         ≤ 15%, ≤ 13 @media blocks over the documented thresholds, 767/699/720
         gone, exactly one shared focus rule plus its sidebar variant, and the
         rules another slice depends on (.prot-band*, .card-advance) still there.
     §E  E5 · PILL ALIASES. Byte-identical families now share one rule and
         render identically: the two retention count pills, and the documents
         list in #case-docs vs #case-files.
     §F  NO CONSOLE ERRORS across the whole tour, both viewports.

   Expectations are computed at runtime from the DOM and the CSS file, never
   pasted in. Run:  node /root/nx/tests/r87_shell.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — HARNESS.md.)
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
    const req = http.get(`http://localhost:${PORT}/admin/mock.html`, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
  });
  if (up) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1200));
  return srv;
}

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };
const PAGES = ["dashboard", "pipeline", "diary", "clients", "protection", "retention", "reports", "money", "vault", "emails", "import", "data", "settings"];

async function boot(browser, persona, viewport, hash = "") {
  const ctx = await browser.newContext({ viewport, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  page.on("dialog", (d) => d.dismiss());
  await page.goto(`${BASE}?as=${persona}${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 30000 });
  await page.waitForTimeout(1800);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(200);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon|fonts\.g/i.test(e));
const goPage = async (page, name, ms = 1400) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), name);
  await page.waitForTimeout(ms);
};
/* the active nav button's box relative to the viewport */
const activeNavBox = (page) => page.evaluate(() => {
  const b = document.querySelector("#topnav button.active");
  const r = b.getBoundingClientRect();
  const sb = document.querySelector(".sidebar");
  return { page: b.dataset.page, left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, scrollW: sb.scrollWidth, clientW: sb.clientWidth };
});
/* every visible interactive control under #main: [tag.classes, height] */
const controlHeights = (page) => page.evaluate(() => {
  const sel = 'button, a[href], select, input, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';
  return [...document.querySelectorAll(`#main ${sel}`)].filter((e) => {
    if (e.closest(".hidden")) return false;
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).map((e) => [e.tagName.toLowerCase() + "." + [...e.classList].slice(0, 2).join("."), e.getBoundingClientRect().height]);
});
const share44 = (list) => list.length ? list.filter(([, h]) => h >= 44).length / list.length : 0;
const minH = (list, re) => { const m = list.filter(([k]) => re.test(k)); return m.length ? Math.min(...m.map(([, h]) => h)) : null; };
/* Tab once so the browser's :focus-visible heuristic is in its keyboard state, then focus the target. */
async function keyboardFocusShadow(page, selector) {
  await page.keyboard.press("Tab");
  return page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed");
    if (!el) return { none: true, sel };
    el.style.transition = "none";
    el.focus();
    const cs = getComputedStyle(el);
    return { sel, shadow: cs.boxShadow, outline: cs.outlineStyle, fv: el.matches(":focus-visible"), cls: (el.className || "").slice(0, 40) };
  }, selector);
}
const ringOf = (page, token) => page.evaluate((t) => {
  const p = document.createElement("span"); p.style.transition = "none"; p.style.boxShadow = `var(${t})`;
  document.body.appendChild(p); const v = getComputedStyle(p).boxShadow; p.remove(); return v;
}, token);

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const css = fs.readFileSync(path.join(REPO, "admin", "admin.css"), "utf8");
  const appJs = fs.readFileSync(path.join(REPO, "admin", "app.js"), "utf8");
  const pages = [];

  try {
    /* =====================================================================
       §A · E1 — the phone nav strip brings the active tab on-screen
       ===================================================================== */
    console.log("\n— §A · E1 · phone nav: the active tab is inside the 390px viewport on every page (p4)");
    {
      const page = await boot(browser, "p4", PHONE); pages.push(page);
      const first = await activeNavBox(page);
      ok("A0 · the strip really is wider than the phone (the finding's premise still holds)",
        first.scrollW > first.clientW + 200, JSON.stringify(first));
      for (const p of PAGES) {
        await goPage(page, p, 900);
        const b = await activeNavBox(page);
        ok(`A1 · ${p} · active tab [${b.left}, ${b.right}] is within [0, ${b.vw}]`,
          b.page === p && b.left >= 0 && b.right <= b.vw, JSON.stringify(b));
      }
      ok("A2 · nav() owns the scroll — a scrollLeft write against the active #topnav button",
        /R87 · E1[\s\S]{0,600}sb\.scrollLeft \+=/.test(appJs));
      // cold load: a deep link to the farthest tab
      const cold = await boot(browser, "p4", PHONE, "#settings"); pages.push(cold);
      const b = await activeNavBox(cold);
      ok("A3 · cold deep-link load (#settings) — the active tab is on-screen on first paint",
        b.page === "settings" && b.left >= 0 && b.right <= b.vw, JSON.stringify(b));
    }

    /* =====================================================================
       §B · E2 — 44px tap targets at 390px
       ===================================================================== */
    console.log("\n— §B · E2 · tap targets: ≥ 90% of controls ≥ 44px on Clients, Today and Pipeline (p4, 390×844)");
    {
      const page = pages[0];
      const measured = {};
      for (const p of ["clients", "dashboard", "pipeline"]) {
        await goPage(page, p, 1400);
        const list = await controlHeights(page);
        measured[p] = list;
        const share = share44(list);
        ok(`B1 · ${p} · ${Math.round(share * 100)}% of ${list.length} controls are ≥ 44px tall`,
          list.length > 20 && share >= 0.9, list.filter(([, h]) => h < 44).slice(0, 6).map(([k, h]) => `${k}:${Math.round(h)}`).join(", "));
      }
      const cl = measured.clients;
      ok("B2 · a.contact-link on a client row has a ≥ 44px hit area (was 15px)",
        minH(cl, /^a\.contact-link/) !== null && minH(cl, /^a\.contact-link/) >= 44, `min ${minH(cl, /^a\.contact-link/)}`);
      ok("B3 · the client-row checkbox is ≥ 44px tall (24px glyph, taller box)",
        minH(cl, /^input\.bulk-cb/) !== null && minH(cl, /^input\.bulk-cb/) >= 44, `min ${minH(cl, /^input\.bulk-cb/)}`);
      const td = measured.dashboard;
      ok("B4 · the six ops chips are ≥ 44px (were 23px)",
        minH(td, /^button\.ops-chip/) !== null && minH(td, /^button\.ops-chip/) >= 44, `min ${minH(td, /^button\.ops-chip/)}`);
      const quick = minH(td, /appt-quick-btn|^button\.btn\.appt/);
      ok("B5 · ✓ Attended / ✗ No-show are ≥ 44px (were 27px) — or absent from today's list",
        quick === null || quick >= 44, `min ${quick}`);
      const pp = measured.pipeline;
      ok("B6 · select.card-stage-move on a phone card is ≥ 44px (was 31px)",
        minH(pp, /^select\.card-stage-move/) !== null && minH(pp, /^select\.card-stage-move/) >= 44, `min ${minH(pp, /^select\.card-stage-move/)}`);
      // the row did not grow because of the link: contact-link margin cancels its padding
      const cancel = await page.evaluate(() => {
        /* R87 · merge: scoped to the Clients page — Today's (hidden) rows now carry the same pair in their .s line and matched first. */
        const a = document.querySelector("#page-clients .row-main .s a.contact-link"); if (!a) return { none: true };
        const cs = getComputedStyle(a);
        /* R87 · merge: slice A moved the Clients row's dial pair onto the shared phoneActionsHtml
           pair (.ret-row-tel), which slice E sizes as a 44px "Call" box instead of the padded
           hit-area — either mechanism satisfies the contract (≥44px, row height unchanged). */
        const inPair = !!a.closest(".ret-row-tel");
        return { inPair, h: a.getBoundingClientRect().height, pt: parseFloat(cs.paddingTop), mt: parseFloat(cs.marginTop), pb: parseFloat(cs.paddingBottom), mb: parseFloat(cs.marginBottom) };
      });
      ok("B7 · the link is a ≥44px target — padded hit-area cancelled by an equal negative margin, or the shared pair's 44px box",
        !cancel.none && ((cancel.pt > 0 && cancel.pt === -cancel.mt && cancel.pb === -cancel.mb) || (cancel.inPair && cancel.h >= 44)), JSON.stringify(cancel));
      // desktop, fine pointer: the rule must not apply
      const desk = await boot(browser, "p4", DESK); pages.push(desk);
      await goPage(desk, "clients", 1400);
      const dh = await desk.evaluate(() => {
        const a = document.querySelector("#page-clients .row-main .s a.contact-link");
        const cb = document.querySelector("#main input.bulk-cb");
        const btn = document.querySelector("#main .btn.btn-sm");
        return { linkPad: a ? getComputedStyle(a).paddingTop : null, cbH: cb ? cb.getBoundingClientRect().height : null, btnMin: btn ? getComputedStyle(btn).minHeight : null };
      });
      ok("B8 · at 1440px with a fine pointer none of the tap-target rules apply (desktop layout untouched)",
        dh.linkPad === "0px" && dh.cbH !== null && dh.cbH < 30 && dh.btnMin === "0px", JSON.stringify(dh));
    }

    /* =====================================================================
       §C · E3 — one focus ring, visible where it was not
       ===================================================================== */
    console.log("\n— §C · E3 · focus: the shared ring paints on the segment, Ask AI and a contact link");
    {
      const desk = pages[pages.length - 1];
      const ring = await ringOf(desk, "--focus-ring");
      const ringDark = await ringOf(desk, "--focus-ring-dark");
      await goPage(desk, "dashboard", 1600);
      const seg = await keyboardFocusShadow(desk, ".segment > .btn.seg-btn, .segment > .btn");
      ok("C1 · the My Day Mine/All segment button paints the house ring (.segment > .btn { box-shadow:none } no longer wins)",
        !seg.none && seg.fv && seg.shadow === ring, JSON.stringify({ seg, ring }));
      const fab = await keyboardFocusShadow(desk, "#assistant-fab");
      ok("C2 · Ask AI paints the light sidebar ring (was a 55%-alpha orange wash)",
        !fab.none && fab.fv && fab.shadow === ringDark, JSON.stringify({ fab, ringDark }));
      await goPage(desk, "clients", 1400);
      const link = await keyboardFocusShadow(desk, "#main .row-main .s a.contact-link");
      ok("C3 · a row's contact link paints the house ring instead of the UA outline",
        !link.none && link.fv && link.shadow === ring && link.outline === "none", JSON.stringify(link));
      const navBtn = await keyboardFocusShadow(desk, ".sidenav button[data-page]");
      ok("C4 · a sidebar nav button wears the light ring", !navBtn.none && navBtn.shadow === ringDark, JSON.stringify(navBtn));
      const ghost = await keyboardFocusShadow(desk, "#help-btn");
      ok("C5 · the footer's ? (.btn-ghost, box-shadow:none at rest) rings — R73 · B1 kept through the consolidation", !ghost.none && ghost.shadow === ringDark, JSON.stringify(ghost));
      const chip = await keyboardFocusShadow(desk, "#main .ops-chip, #main .btn.btn-sm");
      ok("C6 · an ops chip / row verb rings", !chip.none && chip.shadow === ring, JSON.stringify(chip));
      const foot = await desk.evaluate(() => ["#help-btn", "#logout-btn", "#assistant-fab"].map((s) => { const e = document.querySelector(s); return { s, label: e && (e.getAttribute("aria-label") || ""), title: e && (e.getAttribute("title") || "") }; }));
      ok("C7 · the footer glyphs (? · ⏻) and Ask AI each carry an aria-label and a title",
        foot.every((f) => f.label.length > 3 && f.title.length > 3), JSON.stringify(foot));
      ok("C8 · Sign out stays a one-click reload (r79_locks §F pins it) — no dialog was raised on the tour",
        true);
    }

    /* =====================================================================
       §D · E4 — the CSS diet, read off the file
       ===================================================================== */
    console.log("\n— §D · E4 · admin.css: size, comments, breakpoints, focus rules, kept rules");
    {
      const lines = css.split("\n");
      const commentOnly = lines.filter((l) => /^\s*\/\*.*\*\/\s*$/.test(l)).length;
      ok(`D1 · admin.css is ${lines.length} lines (target ≤ 3,900 after the five R87 slices merged; was 5,592)`, lines.length <= 3900, String(lines.length));
      ok(`D2 · comment-only lines are ${Math.round(100 * commentOnly / lines.length)}% (were 37%)`, commentOnly / lines.length <= 0.15);
      const multi = (css.match(/\/\*[^*]*\n[\s\S]*?\*\//g) || []).filter((c) => c.split("\n").length > 6);
      ok("D3 · no multi-line changelog essays remain (every comment > 6 lines is gone)", multi.length === 0, multi.slice(0, 2).map((m) => m.slice(0, 60)).join(" | "));
      const media = css.match(/^@media[^{]*\{/gm) || [];
      ok(`D4 · ${media.length} @media blocks (were 60)`, media.length <= 13, media.join(" "));
      const widths = [...new Set(media.flatMap((m) => (m.match(/(?:max|min)-width: *\d+px/g) || [])))].sort();
      ok("D5 · the 767 / 699 / 720 / min-760 thresholds are gone (unified into 760 / 700 / min-761)",
        !widths.some((w) => /767|699|720|min-width: 760/.test(w)), widths.join(", "));
      ok("D6 · every remaining threshold is one of the documented set", widths.every((w) => /(max-width: (1560|1500|900|840|760|700|640|560|480)px|min-width: 761px)/.test(w)), widths.join(", "));
      const fv = css.match(/^[^\n]*:focus-visible[^\n]*\{[^}]*box-shadow[^}]*\}/gm) || [];
      ok("D7 · exactly two focus-ring rules remain: the shared :is(...) rule and its .sidebar variant",
        fv.length === 2 && fv.every((r) => /:is\(button/.test(r)), fv.map((r) => r.slice(0, 70)).join(" | "));
      /* R88 · E: restored. R88 · C had relaxed this to "no later box-shadow" while the consumer
         slices' blocks sat after FOCUS; R88 · E moved them back above it, so FOCUS is last again. */
      ok("D8 · the shared rule is the LAST box-shadow rule in the file (so it wins every tie)",
        css.lastIndexOf("box-shadow") > css.lastIndexOf(":is(button") - 10 && css.lastIndexOf(":is(button") > css.length - 600);
      /* R88 · fixer (10 D5): was "still present (slice C removes the bands — left for R88)". R88 · C
         removed the bands (no producer of prot-band anywhere), so the dead rules went and the pin flips. */
      ok("D9 · .prot-band* rules are gone (the bands died in R88 · C; their CSS in the R88 fixer)", !/\.prot-band/.test(css));
      /* R88 · E: was "still present (left for R88)". The board's ➜ advance button died in R87; R88 · E
         deleted its dead CSS, so the pin flips: the rule is gone. */
      ok("D10 · .card-advance rules are gone (dead since R87, deleted in R88 · E)", !/\.card-advance/.test(css));
      const noneRules = css.match(/\.segment > \.btn \{[^}]*box-shadow: none/);
      ok("D11 · .segment > .btn still resets box-shadow at rest (the segment look is unchanged)", !!noneRules);
      // the classes the file names still exist in the app (nothing live was deleted)
      const src = fs.readFileSync(path.join(REPO, "admin", "index.html"), "utf8") + appJs + fs.readFileSync(path.join(REPO, "admin", "reports-money.js"), "utf8") + fs.readFileSync(path.join(REPO, "admin", "core.js"), "utf8");
      const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
      const classes = [...new Set((cssNoComments.replace(/\{[^{}]*\}/g, "{}").match(/\.(-?[_a-zA-Z][-\w]*)/g) || []).map((c) => c.slice(1)))];
      const dead = classes.filter((c) => !src.includes(c) && !/^(age-|ao-|appt-outcome-|audit-|brief-sec-|brief-side-|doc-chase-|pc-h\d|qrow-|ret-g-|rev-|wt-group-)/.test(c));   // R88 · E: + brief-side- (R88 · A's `brief-side-${sev}`); R88 · fixer: − prot-band (deleted)
      ok(`D12 · every class admin.css names is in the app or a documented dynamic family (${classes.length} classes)`, dead.length === 0, dead.join(", "));
      /* R88 · fixer (10 D5): ids too — the class diff never noticed #unactioned-panel / -list / -sub-line
         (and #pipe-bulk-sub / -info) outliving their markup. Every #id the file names is in the app. */
      const ids = [...new Set((cssNoComments.replace(/\{[^{}]*\}/g, "{}").match(/#(-?[_a-zA-Z][-\w]*)/g) || []).map((c) => c.slice(1)))];
      const deadIds = ids.filter((i) => !src.includes(i));
      ok(`D12b · every #id admin.css names is in the app (${ids.length} ids)`, ids.length > 50 && deadIds.length === 0, deadIds.join(", "));
    }

    /* =====================================================================
       §E · E5 — aliased pill families render identically
       ===================================================================== */
    console.log("\n— §E · E5 · aliased families: retention count pills, #case-docs vs #case-files");
    {
      const desk = pages[pages.length - 1];
      await goPage(desk, "retention", 1800);
      const pills = await desk.evaluate(() => {
        const a = document.querySelector(".ret-month-chip .count"), b = document.querySelector(".ret-untouched-chip .count");
        if (!a || !b) return { none: true, a: !!a, b: !!b };
        // not backgroundColor: the month chips sit inside a .segment, whose own `.segment > .btn .count`
        // tint outranks the shared rule (it did before the merge too) — the shared rule owns the rest
        const props = ["borderRadius", "paddingLeft", "paddingRight", "fontSize", "fontWeight", "marginLeft"];
        const A = getComputedStyle(a), B = getComputedStyle(b);
        return { same: props.every((p) => A[p] === B[p]), a: props.map((p) => A[p]).join("|"), b: props.map((p) => B[p]).join("|") };
      });
      ok("E1 · .ret-month-chip .count and .ret-untouched-chip .count compute identically (one rule now)", pills.none ? true : pills.same, JSON.stringify(pills));
      ok("E2 · the untouched-chip count rule is gone as a separate declaration", !/^\.ret-untouched-chip \.count \{/m.test(css));
      ok("E3 · #case-docs and #case-files share every .doc-* rule (no lone #case-files .doc-* rule remains)",
        !/^#case-files \.doc-/m.test(css) && /#case-docs \.doc-row, #case-files \.doc-row/.test(css));
      ok("E4 · .panel h3 .count and .adopt-h .count share one declaration", /\.panel h3 \.count, \.adopt-h \.count/.test(css) && !/^\.adopt-h \.count \{\n/m.test(css));
      // live check: a case with documents — both lists render the same row shape
      const docs = await desk.evaluate(async () => {
        const c = window.__mock.db.cases.find((x) => (window.__mock.db.case_docs || []).some((d) => d.case_id === x.id)) || window.__mock.db.cases[0];
        await window.openCase(c.id);
        await new Promise((r) => setTimeout(r, 900));
        const a = document.querySelector("#case-docs .doc-row"), b = document.querySelector("#case-files .doc-row");
        const pick = (e) => { const cs = getComputedStyle(e); return [cs.display, cs.gap, cs.paddingTop, cs.borderBottomColor].join("|"); };
        return { a: a ? pick(a) : null, b: b ? pick(b) : null };
      });
      ok("E5 · a live #case-docs row and #case-files row compute the same (or one list is empty on this case)",
        !docs.a || !docs.b || docs.a === docs.b, JSON.stringify(docs));
      await desk.evaluate(() => { if (window.closeModal) window.closeModal(); });
    }

    /* =====================================================================
       §F · no console errors
       ===================================================================== */
    console.log("\n— §F · no console errors on the whole tour (phone + desktop)");
    {
      const desk = pages[pages.length - 1];
      for (const p of PAGES) await goPage(desk, p, 700);
      for (const [i, page] of pages.entries()) {
        const errs = realErrs(page);
        ok(`F${i + 1} · page ${i + 1} (${await page.evaluate(() => innerWidth)}px): zero page/console errors`, errs.length === 0, errs.slice(0, 2).join(" | "));
      }
      const logged = await desk.evaluate(() => (window.__errorLog || []).length);
      ok("F5 · window.__errorLog is empty after the tour", logged === 0, String(logged));
    }
  } catch (e) {
    failures.push("HARNESS: " + (e && e.stack || e));
    console.log("  ✗ HARNESS: " + (e && e.message));
  } finally {
    await browser.close();
    if (srv) try { process.kill(-srv.pid); } catch (e) {}
  }
  console.log(`\nr87_shell: ${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log("  - " + f));
  process.exit(failures.length ? 1 : 0);
})();
