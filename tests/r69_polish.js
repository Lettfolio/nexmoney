#!/usr/bin/env node
/* =============================================================================
   tests/r69_polish.js — acceptance tests for ROUND 69, agent B ("polish +
   parity"): five things the app was doing to the reader rather than for them.

     §A  B1 · L3 — LENDER FAVICONS. One canonical domain per lender NAME,
         decided by the name rather than by which line of LENDER_DOMAINS a key
         happens to be typed on; one request per domain; and a domain whose
         image has errored once is never requested again this session — later
         paints emit no <img> for it at all, so there is no retry and no
         broken-image flash. loading="lazy" + decoding="async" on every one.

     §B  B2 · L7 — THE PROTECTION ACTIONS COLUMN. Open / Status… / GI… / Task /
         Email were off-screen at 1280 and 1500 (the table wanted 1373px in a
         998px scrollport) and, at 1920, painted over the ADVISER column by the
         sticky-right rule. The two sentence-shaped columns now wrap, the table
         fits from 1280 up, and below that it scrolls inside #prot-scroll —
         never the page body.

     §C  B3 · L8 — REPORTS AT 390. Eighteen tables, twelve of them wider than
         the phone, in panels with overflow:visible under `body{overflow-x:clip}`
         — so the columns past the fold did not exist. Every table on the page
         now sits in a .table-scroll that scrolls itself and fades at the edge,
         re-applied by an observer so a panel that re-renders keeps its box.

     §D  B4 · MOCK PARITY WITH process-emails v18. The empty scoped probe
         {queue_ids: []} answers `pending` = every queued row due NOW
         (scheduled_for <= now, or none), counts nothing that is scheduled for
         later, changes nothing it counted, and the Settings strip says that
         same number in English.

     §E  B5 · L12 — DATA HEALTH: LOAN ABOVE PROPERTY VALUE. A twelfth fault
         tile, #dh-tile-ltv, its drawer, its readiness row, and its zero state —
         built off the cases read the page already makes, not a second one.

   INDEPENDENCE. Nothing here imports app.js's own constants or lists. The
   expected favicon domain for a lender, the fixture's over-100% cases, the
   queued-and-due email count and the number of tables on Reports are all
   derived from window.__mockDb rows or from the DOM, never from the app's own
   idea of them. Where a block needs a row that the fixtures do not contain (an
   email scheduled for tomorrow, a lender name that matches two domain keys) it
   MINTS it on the page under test — mock-supabase.js rebuilds its DB on every
   page load, so nothing here can leak into another suite.

   Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node /root/nx/tests/r69_polish.js
         (expects a static server on 8099; starts one itself if absent)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const SETTLE = 1600;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
    r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}

/* The same defensive localStorage clear + tour skip every recent suite does before depending on a
   default (tests/r41.js's NX_KEYS, extended by R64's nx_ret_month / nx_clients_adviser). */
const NX_KEYS = ["nx_wt_scope", "nx_board_adviser", "nx_clients_adviser", "nx_diary_staff", "nx_views_v1",
  "nx_nav_firm", "nx_import_blurb", "nx_ret_scope", "nx_ret_month", "nx_drawer_watchtower",
  "nx_drawer_unactioned", "nx_drawer_leads", "nx_drawer_todayappts", "nx_drawer_tasks",
  "nx_drawer_rateerc", "nx_drawer_retention", "nx_drawer_revenue"];
const clearNxKeys = (page) => page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);

/* opts.viewport — size the window BEFORE first paint (§B/§C measure layout).
   opts.route    — install a request handler before the first navigation (§A counts favicon
                   requests and decides whether they succeed or fail; nothing else in the
                   harness can, because the sandbox has no route to the real internet). */
async function newPage(browser, persona, opts) {
  const o = opts || {};
  const page = await browser.newPage(o.viewport ? { viewport: o.viewport } : undefined);
  await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  page.__dialogs = [];
  page.on("dialog", async (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); await d.accept(); });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  if (o.route) await o.route(page);
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  await clearNxKeys(page);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs|favicons/i.test(e));
const goto = async (page, pageName, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), pageName);
  await wait(page, ms == null ? 1100 : ms);
};

/* A 1×1 transparent PNG. §A serves this in place of every Google favicon so the images LOAD:
   the sandbox has no internet, so left alone every favicon errors and the DOM under test would
   be the failure case only. The failure case gets its own page, below, where the same route
   aborts instead. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const FAV_GLOB = "**/s2/favicons*";

/* Every distinct non-empty lender string in the book, straight off the rows. */
const bookLenders = (page) => page.evaluate(async () => {
  const { data } = await window.__mockDb.from("cases").select("lender");
  return [...new Set((data || []).map((c) => String(c.lender || "").trim()).filter(Boolean))].sort();
});
/* Every favicon <img> on screen, with the lender name of the cell it sits in (matched against the
   book's own list of names, so this file never has to parse the app's row markup). */
const favImgs = (page, names) => page.evaluate((ns) => {
  return [...document.querySelectorAll("img.lfav")].map((im) => {
    const txt = (im.parentElement ? im.parentElement.textContent : "") || "";
    const hits = ns.filter((n) => txt.includes(n)).sort((a, b) => b.length - a.length);
    return { src: im.getAttribute("src"), dom: im.dataset.dom || "", name: hits[0] || "", lazy: im.getAttribute("loading"), dec: im.getAttribute("decoding") };
  });
}, names);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore" });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();

  try {
    /* =======================================================================
       §A · B1/L3 — lender favicons
       ======================================================================= */
    {
      console.log("\n— §A1 · one canonical domain per lender name (p4, favicons served)");
      const reqs = [];
      const page = await newPage(browser, "p4", {
        route: async (p) => p.route(FAV_GLOB, (route) => {
          reqs.push(route.request().url());
          route.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX });
        }),
      });

      const names = await bookLenders(page);
      ok("A1a · the book holds several distinct lender names to resolve", names.length >= 8, JSON.stringify(names));

      /* Resolution is a pure function of the NAME: ask twice, ask in a different order, get the
         same answer. This is the property the memo has to preserve, and the one a per-paint
         re-derivation would break. */
      const resolved = await page.evaluate((ns) => {
        const once = {};
        ns.forEach((n) => { once[n] = window.lenderDomain(n); });
        const again = {};
        [...ns].reverse().forEach((n) => { again[n] = window.lenderDomain(n); });
        return { once, again, stable: ns.every((n) => once[n] === again[n]) };
      }, names);
      ok("A1b · every lender name resolves to exactly one domain, and to the same one on the second ask",
        resolved.stable, JSON.stringify(resolved.once));
      const domCounts = {};
      names.forEach((n) => { const d = resolved.once[n]; if (d) domCounts[n] = d; });
      ok("A1c · each name's domain is a single non-empty string (no name yields two)",
        Object.values(domCounts).every((d) => typeof d === "string" && d.length > 3 && d.indexOf(",") < 0),
        JSON.stringify(domCounts));
      eq("A1d · Halifax resolves to halifax.co.uk", await page.evaluate(() => window.lenderDomain("Halifax")), "halifax.co.uk");
      eq("A1e · …and so does the same lender written differently", await page.evaluate(() => window.lenderDomain("  HALIFAX  ")), "halifax.co.uk");

      /* The order-independence claim, stated as behaviour. This name contains BOTH "yorkshire"
         (at 0) and "accord" (at 38); "accord" is typed twelve lines higher in LENDER_DOMAINS, so
         the old first-key-wins helper answered accordmortgages.com — an answer about this file's
         line order, not about the lender. Earliest-match-in-the-name answers ybs.co.uk. */
      eq("A2a · a name containing two table keys resolves by position in the NAME, not by key order",
        await page.evaluate(() => window.lenderDomain("Yorkshire Building Society trading as Accord")), "ybs.co.uk");
      eq("A2b · …and the same two keys the other way round give the other domain",
        await page.evaluate(() => window.lenderDomain("Accord (part of Yorkshire Building Society)")), "accordmortgages.com");
      eq("A2c · a lender with no entry in the table gets no icon at all",
        await page.evaluate(() => window.lenderIcon("Bank of Neverwhere")), "");
      eq("A2d · …and neither does a blank lender", await page.evaluate(() => window.lenderIcon("")), "");

      console.log("\n— §A2 · the rendered pages: one src per lender, one request per domain");
      await goto(page, "pipeline", 1800);
      const pipeImgs = await favImgs(page, names);
      await goto(page, "clients", 1800);
      const cliImgs = await favImgs(page, names);
      const allImgs = pipeImgs.concat(cliImgs);
      ok("A3a · both pages painted lender favicons", allImgs.length >= 4, `${pipeImgs.length} + ${cliImgs.length}`);

      const byName = {};
      allImgs.filter((i) => i.name).forEach((i) => { (byName[i.name] = byName[i.name] || new Set()).add(i.src); });
      const twoSrcs = Object.keys(byName).filter((n) => byName[n].size > 1);
      eq("A3b · no lender name shows two different favicon srcs", twoSrcs, []);
      ok("A3c · every painted src matches what lenderDomain() says for that lender",
        allImgs.filter((i) => i.name).every((i) => i.src.includes("domain=" + resolved.once[i.name] + "&")),
        JSON.stringify(allImgs.filter((i) => i.name && !i.src.includes("domain=" + resolved.once[i.name] + "&")).slice(0, 3)));
      ok("A3d · every favicon is lazy and decoded off the critical path",
        allImgs.length > 0 && allImgs.every((i) => i.lazy === "lazy" && i.dec === "async"),
        JSON.stringify(allImgs.slice(0, 2)));

      const perDomain = {};
      reqs.forEach((u) => { const m = /domain=([^&]+)/.exec(u); if (m) perDomain[m[1]] = (perDomain[m[1]] || 0) + 1; });
      const repeated = Object.keys(perDomain).filter((d) => perDomain[d] > 1);
      eq("A4 · no domain was fetched more than once across both pages", repeated, []);
      eq("A4b · …including halifax, which the audit saw fetched twice", perDomain["halifax.co.uk"] || 0, 1);

      /* The failure mechanism, driven by hand rather than by the sandbox's lack of internet, and
         done HERE because on this page every favicon has loaded — nothing is dead yet, so there
         are two live lenders to compare. A still-live img that receives an 'error' event takes its
         own domain out of circulation and leaves every other lender alone. The dead-domain memory
         is a module-scope const, deliberately not on window (nothing in the shipped app may poke
         at it), so it is asserted through what the page renders next. LAST in this block: it kills
         one domain for the rest of this page's life. */
      const byHand = await page.evaluate((ns) => {
        const live = ns.filter((n) => window.lenderIcon(n) !== "");
        if (live.length < 2) return { skip: true, live: live.length };
        const host = document.createElement("div");
        host.innerHTML = window.lenderIcon(live[0]);
        document.body.appendChild(host);
        const im = host.querySelector("img.lfav");
        const dom = im.dataset.dom;
        im.dispatchEvent(new Event("error"));
        const other = live.find((n) => window.lenderDomain(n) !== dom);
        const out = {
          dom, removed: !host.querySelector("img.lfav"),
          next: window.lenderIcon(live[0]),
          other: other ? window.lenderIcon(other) : "",
        };
        host.remove();
        return out;
      }, names);
      ok("A5a · an 'error' on a favicon removes that element from the row", byHand.removed, JSON.stringify(byHand));
      eq("A5b · …and the next paint renders nothing at all for it", byHand.next, "");
      ok("A5c · …while every OTHER lender is untouched", /img class="lfav"/.test(byHand.other), JSON.stringify(byHand.other));
      eq("A5d · no console errors while painting favicons", realErr(page), []);
      await page.close();
    }

    {
      console.log("\n— §A3 · a favicon that fails is never asked for again (p4, favicons aborted)");
      const reqs = [];
      /* The abort is DELAYED, so the paint can be measured before and after the failures land:
         that difference is exactly "the failed images were removed from their rows". */
      const page = await newPage(browser, "p4", {
        route: async (p) => p.route(FAV_GLOB, async (route) => {
          reqs.push(route.request().url());
          await new Promise((r) => setTimeout(r, 1500));
          try { await route.abort(); } catch (e) { /* page closed mid-flight */ }
        }),
      });
      const names = await bookLenders(page);
      await goto(page, "pipeline", 700);

      /* Snapshot the paint BEFORE any of the aborts land. `loading="lazy"` is real, so the browser
         only ever asks for the rows near the top: reqs.length is the number of images that will
         fail, not the number on the page. */
      const before = await page.evaluate(() => document.querySelectorAll("#page-pipeline img.lfav").length);
      const attempted = reqs.length;
      ok("A6a · the first paint asked for the favicons it could see", attempted > 0, String(attempted));
      ok("A6b · …and painted the rows they belong to", before > 0, JSON.stringify({ before, attempted }));

      /* Let the request flow settle (lazy images enter the viewport as the page finishes laying
         out) before looking again. */
      let seen = -1;
      for (let i = 0; i < 8 && seen !== reqs.length; i++) { seen = reqs.length; await wait(page, 900); }
      await wait(page, 2000);   // the last aborts land
      const afterFail = await page.evaluate(() => ({
        left: document.querySelectorAll("#page-pipeline img.lfav").length,
        hidden: [...document.querySelectorAll("img.lfav")].filter((im) => im.style.display === "none" || getComputedStyle(im).display === "none").length,
      }));
      ok("A6c · the failed images are gone from their rows", afterFail.left < before, JSON.stringify({ before, afterFail }));
      eq("A6d · …REMOVED, not merely hidden — a hidden <img> is still a fetched <img>", afterFail.hidden, 0);

      /* The domains that just died, and the lenders that live on them. */
      const reqDomains = [...new Set(reqs.map((u) => (/domain=([^&]+)/.exec(u) || [])[1]).filter(Boolean))];
      const deadNames = await page.evaluate(({ doms, ns }) => ns
        .filter((n) => doms.includes(window.lenderDomain(n)))
        .map((n) => ({ n, icon: window.lenderIcon(n) })), { doms: reqDomains, ns: names });
      ok("A7a · lenderIcon() returns nothing for any lender on a domain that failed",
        deadNames.length > 0 && deadNames.every((x) => x.icon === ""), JSON.stringify(deadNames.slice(0, 3)));

      /* The point of the round: a REPAINT of the same rows must not ask again. */
      const countPer = (list) => list.reduce((o, u) => {
        const d = (/domain=([^&]+)/.exec(u) || [])[1];
        if (d) o[d] = (o[d] || 0) + 1;
        return o;
      }, {});
      const perBefore = countPer(reqs);
      const repaint = await page.evaluate(async (doms) => {
        await window.loadPipeline();
        await new Promise((r) => setTimeout(r, 400));
        return {
          dead: doms.reduce((n, d) => n + document.querySelectorAll(`#page-pipeline img.lfav[data-dom="${d}"]`).length, 0),
          any: document.querySelectorAll("#page-pipeline img.lfav").length,
        };
      }, reqDomains);
      await wait(page, 1200);
      eq("A7b · a repaint emits no <img> at all for a domain that failed", repaint.dead, 0);
      const perAfter = countPer(reqs);
      const retried = reqDomains.filter((d) => (perAfter[d] || 0) > (perBefore[d] || 0));
      eq("A7c · …so not one further request is made for any of them", retried, []);
      eq("A9 · no console errors on the failure path", realErr(page), []);
      await page.close();
    }

    /* =======================================================================
       §B · B2/L7 — the Protection Actions column
       ======================================================================= */
    {
      console.log("\n— §B · Protection actions are on screen from 1280 up (p4, All)");
      const page = await newPage(browser, "p4", { viewport: { width: 1500, height: 900 } });
      await goto(page, "protection", 2000);

      const rowsOnScreen = await page.evaluate(() => document.querySelectorAll("#prot-list-table tr.prot-row").length);
      ok("B0 · the protection table has rows to measure", rowsOnScreen >= 5, String(rowsOnScreen));

      const measure = () => page.evaluate(() => {
        const sc = document.querySelector("#prot-scroll");
        if (!sc) return null;
        const box = sc.getBoundingClientRect();
        const outside = [];
        document.querySelectorAll("#prot-list-table tr.prot-row td.prot-actions").forEach((td, i) => {
          td.querySelectorAll("button, select").forEach((b) => {
            const r = b.getBoundingClientRect();
            if (r.right > box.right + 0.5 || r.left < box.left - 0.5) {
              outside.push({ i, t: (b.textContent || "").trim().slice(0, 10), l: Math.round(r.left), r: Math.round(r.right) });
            }
          });
        });
        const controls = document.querySelectorAll("#prot-list-table tr.prot-row td.prot-actions button, #prot-list-table tr.prot-row td.prot-actions select").length;
        return {
          w: innerWidth, controls, outside: outside.slice(0, 3), nOutside: outside.length,
          needsScroll: sc.scrollWidth > sc.clientWidth + 1,
          overflowX: getComputedStyle(sc).overflowX,
          docSW: document.documentElement.scrollWidth,
          actionsSticky: getComputedStyle(document.querySelector("#prot-list-table td.stick-col-right")).position,
        };
      });

      for (const w of [1280, 1500, 1920]) {
        await page.setViewportSize({ width: w, height: 900 });
        await wait(page, 600);
        const m = await measure();
        ok(`B1·${w} · every action control sits inside #prot-scroll`, m && m.nOutside === 0, JSON.stringify(m));
        ok(`B2·${w} · …with the table fitting, so nothing has to be scrolled to reach it`, m && !m.needsScroll, JSON.stringify(m && { sw: m.needsScroll }));
        ok(`B3·${w} · the page body never scrolls sideways`, m && m.docSW <= w, JSON.stringify(m && m.docSW));
        ok(`B4·${w} · the Actions cell is no longer sticky, so it cannot paint over another column`, m && m.actionsSticky === "static", JSON.stringify(m && m.actionsSticky));
        ok(`B5·${w} · every row really was measured (5 controls or 4 where GI does not apply)`, m && m.controls >= rowsOnScreen * 4, JSON.stringify(m && m.controls));
      }

      /* Below 1280 the deal is different and stated in the role card: the table scrolls INSIDE its
         own container, and the page still does not. */
      for (const w of [1024, 390]) {
        await page.setViewportSize({ width: w, height: 844 });
        await wait(page, 600);
        const m = await measure();
        /* R73 · A4: below 768px this table is not a table any more. R73 propagated the R65 · L9
           mobile-card treatment to Protection & GI — an 877px table inside a 364px box meant
           reading the list one column at a time — so at 390px the rows render as stacked cards,
           #prot-scroll has nothing left to scroll sideways, and its overflow-x is `visible` on
           purpose (an overflow-x box also promotes overflow-y to auto, which is how a card list
           ends up inside a second vertical scrollbar). The 1024 deal is unchanged: still a table,
           still scrolling inside its own container.
           NOT WEAKENED — the question B6/B8 exist to answer is "can every action control be
           reached without the page scrolling sideways", and at 390 the answer is now stronger:
           there is nothing to scroll at all and every control is already inside the box. */
        if (w >= 768) {
          ok(`B6·${w} · the table scrolls inside #prot-scroll`, m && m.overflowX === "auto", JSON.stringify(m && m.overflowX));
        } else {
          ok(`B6·${w} · R73 — the table is a CARD LIST here, so there is no sideways scroller`,
            m && m.overflowX === "visible" && !m.needsScroll, JSON.stringify(m && { ox: m.overflowX, needs: m.needsScroll }));
        }
        ok(`B7·${w} · the page body still does not scroll sideways`, m && m.docSW <= w, JSON.stringify(m && m.docSW));
        const reach = await page.evaluate(() => {
          const sc = document.querySelector("#prot-scroll");
          sc.scrollLeft = sc.scrollWidth;
          const box = sc.getBoundingClientRect();
          const btns = [...document.querySelectorAll("#prot-list-table tr.prot-row td.prot-actions button")];
          const last = btns[btns.length - 1].getBoundingClientRect();
          return { inside: last.right <= box.right + 0.5 && last.left >= box.left - 0.5, scrolled: sc.scrollLeft > 0 };
        });
        ok(`B8·${w} · …and every action button is reachable inside the box`,
          reach.inside && (reach.scrolled || w >= 1024 || w < 768), JSON.stringify(reach));
      }
      eq("B9 · no console errors on Protection", realErr(page), []);
      await page.close();
    }

    /* =======================================================================
       §C · B3/L8 — Reports at 390
       ======================================================================= */
    {
      console.log("\n— §C · Reports on a phone (p4, 390×844)");
      const page = await newPage(browser, "p4", { viewport: { width: 390, height: 844 } });
      await goto(page, "reports", 3000);

      const c = await page.evaluate(() => {
        const pg = document.querySelector("#page-reports");
        const tables = [...pg.querySelectorAll("table")];
        const unwrapped = tables.filter((t) => !t.parentElement || !t.parentElement.classList.contains("table-scroll"));
        const boxes = [...pg.querySelectorAll(".table-scroll")];
        const bad = boxes.filter((b) => getComputedStyle(b).overflowX !== "auto");
        const overflowing = boxes.filter((b) => b.scrollWidth > b.clientWidth + 1);
        return {
          tables: tables.length, unwrapped: unwrapped.length, boxes: boxes.length,
          badOverflow: bad.length, overflowing: overflowing.length,
          fade: boxes.length ? /gradient/.test(getComputedStyle(boxes[0]).backgroundImage) : false,
          docSW: document.documentElement.scrollWidth, iw: innerWidth,
          bodySW: document.body.scrollWidth,
        };
      });
      ok("C1a · Reports really is table-heavy on a phone", c.tables >= 12, JSON.stringify(c));
      eq("C1b · every table on the page sits inside a .table-scroll", c.unwrapped, 0);
      eq("C2 · every one of those boxes actually scrolls horizontally", c.badOverflow, 0);
      ok("C3 · several of them are wider than the phone, which is why the box exists", c.overflowing >= 5, JSON.stringify(c.overflowing));
      ok("C4 · the box carries the right-edge fade that says there is more", c.fade, JSON.stringify(c.fade));
      ok("C5 · the page itself does not scroll sideways", c.docSW <= c.iw && c.bodySW <= c.iw, JSON.stringify(c));

      /* The role card's own acceptance test: the scoreboard's LAST column is reachable. */
      const board = await page.evaluate(() => {
        const box = document.querySelector("#report-mi-scoreboard .table-scroll");
        if (!box) return null;
        const cells = [...box.querySelectorAll("tr")[0].children];
        const last = cells[cells.length - 1];
        const before = last.getBoundingClientRect().right - box.getBoundingClientRect().right;
        box.scrollLeft = box.scrollWidth;
        const after = last.getBoundingClientRect().right - box.getBoundingClientRect().right;
        return { label: last.textContent.trim(), before: Math.round(before), after: Math.round(after), scrolled: box.scrollLeft > 0 };
      });
      ok("C6a · the MI scoreboard's last column starts off-screen inside its box", board && board.before > 0, JSON.stringify(board));
      ok("C6b · …and scrolling the box brings it fully into view", board && board.after <= 1 && board.scrolled, JSON.stringify(board));

      /* KPI tiles two-up on a phone — asserted at both ends of the "under 480px" range. */
      for (const w of [390, 479]) {
        await page.setViewportSize({ width: w, height: 844 });
        await wait(page, 500);
        const cols = await page.evaluate(() => [...document.querySelectorAll("#page-reports .kpi-row")]
          .filter((r) => r.offsetParent !== null && r.children.length > 1)
          .map((r) => getComputedStyle(r).gridTemplateColumns.split(" ").length));
        ok(`C7·${w} · every KPI row on Reports stacks exactly 2-up`, cols.length > 0 && cols.every((n) => n === 2), JSON.stringify(cols));
      }

      /* A panel that re-renders itself must not lose its box — this is why the wrapping is an
         observer and not eighteen template strings. Simulated by doing what those renderers do:
         blowing away a panel's innerHTML and putting a bare table back. */
      const rewrapped = await page.evaluate(async () => {
        const host = document.querySelector("#report-mi-scoreboard");
        host.innerHTML = '<table class="imp-table" id="r69-retest"><tr><th>A</th><th>B</th></tr></table>';
        const immediate = !!document.querySelector("#r69-retest").closest(".table-scroll");
        await new Promise((r) => setTimeout(r, 200));
        const t = document.querySelector("#r69-retest");
        return { immediate, wrapped: !!(t && t.parentElement.classList.contains("table-scroll")) };
      });
      ok("C8 · a panel that re-renders gets its scroll box back automatically", rewrapped.wrapped, JSON.stringify(rewrapped));
      eq("C9 · no console errors on Reports", realErr(page), []);
      await page.close();
    }

    /* =======================================================================
       §D · B4 — mock parity with process-emails v18
       ======================================================================= */
    {
      console.log("\n— §D · the safe probe counts what is due now (p4)");
      const page = await newPage(browser, "p4");

      const probe = () => page.evaluate(async () => {
        const { data } = await window.__mockDb.functions.invoke("process-emails", { body: { queue_ids: [] } });
        return data;
      });
      const dueNow = () => page.evaluate(async () => {
        const { data } = await window.__mockDb.from("email_queue").select("id,status,scheduled_for");
        const now = new Date().toISOString();
        return {
          due: (data || []).filter((e) => e.status === "queued" && (!e.scheduled_for || e.scheduled_for <= now)).length,
          queued: (data || []).filter((e) => e.status === "queued").length,
          total: (data || []).length,
        };
      });

      const base = await dueNow();
      const p0 = await probe();
      eq("D1 · an empty scoped probe answers `pending` = the rows queued and due now", p0.pending, base.due);
      ok("D1b · …and it is a real count off the fixtures, not a hardcoded zero", base.due > 0, JSON.stringify(base));
      ok("D2 · the probe says whether the hold is on", p0.held === true, JSON.stringify(p0));
      ok("D3 · …and names the missing server key in the warning", /RESEND_API_KEY/.test(p0.warning || ""), JSON.stringify(p0));

      /* A row scheduled for TOMORROW is queued but not due: v18 does not count it. */
      const seeded = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: any } = await db.from("email_queue").select("*").limit(1);
        const tpl = (any || [])[0] || {};
        const mk = (when) => ({
          case_id: tpl.case_id || null, client_id: tpl.client_id || null,
          to_email: "r69probe@example.com", email_type: tpl.email_type, subject: "R69 probe row",
          /* R81 — was `body:`, a ghost column this suite invented: email_queue's
             text column is `body_html` (R66 · M8), and strict column mode now
             refuses the typo the way production's 42703 always would have. */
          body_html: "R69 probe row", status: "queued", scheduled_for: when,
        });
        const future = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
        const past = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
        const a = await db.from("email_queue").insert(mk(future)).select("id").single();
        const b = await db.from("email_queue").insert(mk(past)).select("id").single();
        return { futureId: a.data.id, pastId: b.data.id };
      });
      const p1 = await probe();
      eq("D4 · a queued row scheduled for tomorrow is NOT counted; one dated yesterday is", p1.pending, base.due + 1);

      /* …and a row that is not queued at all never counts, whatever its date. */
      await page.evaluate(async (id) => { await window.__mockDb.from("email_queue").update({ status: "sent" }).eq("id", id); }, seeded.pastId);
      const p2 = await probe();
      eq("D5 · a row that has already been sent stops counting", p2.pending, base.due);

      /* The whole point of a probe: it changes nothing it looked at. */
      const after = await dueNow();
      eq("D6 · probing four times left the queue exactly as it was", { q: after.queued, t: after.total }, { q: base.queued + 1, t: base.total + 2 });
      const lastRun = await page.evaluate(() => (window.__mock.lastEmailRun ? window.__mock.lastEmailRun() : null));
      ok("D7 · …and never wrote a last-run record", lastRun == null, JSON.stringify(lastRun));

      /* The Settings strip is the one screen that reads this number: it must say it in English. */
      await goto(page, "settings", 2000);
      const strip = await page.evaluate(() => {
        const el = document.querySelector("#email-sending-status");
        const line = document.querySelector("#email-sending-line");
        return { text: (el || {}).textContent || "", state: line ? line.dataset.state : null };
      });
      const expect = await probe();
      eq("D8 · the Settings strip is in the no-key state", strip.state, "no_key");
      /* R74 · A3 (panel D-25): "queued" became "held". Mail that cannot leave was called "queued"
         here, "queued" on the Emails page and "stuck" on Data health — three words for one state,
         which is how a deliberate hold reads as a fault. One word now, on all four surfaces. The
         count, the plural and the verb agreement this line exists to check are unchanged. */
      ok("D8b · …and its copy names the probe's own count, plural, with a verb that agrees",
        strip.text.includes(`${expect.pending} emails are held and will wait`),
        JSON.stringify({ n: expect.pending, text: strip.text.slice(0, 220) }));

      /* A NON-EMPTY scope is not a probe — it counts (and acts on) its own ids, nothing else.
         Last in this block, because it is the one call here that writes. */
      const scoped = await page.evaluate(async () => {
        const db = window.__mockDb;
        const { data: rows } = await db.from("email_queue").select("id,to_email").eq("status", "queued").limit(1);
        const id = rows[0].id;
        const { data } = await db.functions.invoke("process-emails", { body: { queue_ids: [id] } });
        const { data: after } = await db.from("email_queue").select("id,status").eq("status", "queued");
        return { res: data, id, stillQueued: after.length };
      });
      /* R79: the scoped path honours the hold like prod v18/v19 now (r79_send §F pins the shape) —
         under the seeded hold a NON-EMPTY scope answers {held, pending-for-its-own-ids} and
         touches NOTHING. The old pin (sent+failed === 1 with the hold ON) was exactly the
         mock-only gap R79 · A5 closed. */
      eq("D9 · a scoped run under the hold sends nothing and counts only its own ids",
        [scoped.res.held === true, scoped.res.pending], [true, 1]);
      ok("D9b · …and leaves every other queued row alone", scoped.stillQueued === (await dueNow()).queued, JSON.stringify(scoped));
      eq("D10 · no console errors around the probe", realErr(page), []);
      await page.close();
    }

    /* =======================================================================
       §E · B5/L12 — Data health: loan above property value
       ======================================================================= */
    {
      console.log("\n— §E · the Loan-above-value tile (p4)");
      const page = await newPage(browser, "p4");

      /* The expected count, derived from the rows rather than from the app. */
      const expected = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,stage,loan_amount,property_value");
        return (data || [])
          .filter((c) => c.stage !== "not_proceeding" && c.loan_amount != null && c.property_value != null
            && Number(c.property_value) > 0 && Number(c.loan_amount) > Number(c.property_value))
          .map((c) => c.id).sort();
      });
      ok("E0 · the fixtures contain the over-100% cases this tile exists for", expected.length >= 1, JSON.stringify(expected));
      ok("E0b · …including ca015, the 127% one", expected.includes("ca015"), JSON.stringify(expected));

      /* THE READ BUDGET. The role card is explicit: reuse the cases read the page already makes,
         do NOT add a second one. Checked by recording the SELECT LIST of every cases read the app
         issues while Data health loads (window.db is the very client app.js holds) — the new
         column must ride the existing data-health select, and must not appear in a read of its
         own. */
      await page.evaluate(() => {
        window.__r69sel = [];
        const origFrom = window.db.from.bind(window.db);
        window.db.from = (t) => {
          const b = origFrom(t);
          if (t === "cases" && typeof b.select === "function") {
            const origSel = b.select.bind(b);
            b.select = (...a) => { window.__r69sel.push(String(a[0] == null ? "*" : a[0])); return origSel(...a); };
          }
          return b;
        };
      });
      await goto(page, "data", 3000);
      const sels = await page.evaluate(() => window.__r69sel || []);
      const withValue = sels.filter((s) => s.includes("property_value"));
      eq("E1a · exactly one cases read on this page asks for property_value", withValue.length, 1);
      ok("E1b · …and it is the data-health read that was already being made, not a second one",
        withValue[0] && withValue[0].includes("rate_end_date") && withValue[0].includes("clients!client_id"),
        JSON.stringify(withValue));

      const tile = await page.evaluate(() => {
        const t = document.querySelector("#dh-tile-ltv");
        if (!t) return null;
        return {
          n: t.querySelector(".num").textContent.trim(),
          lbl: t.querySelector(".lbl").textContent.trim(),
          warn: t.classList.contains("warn"),
          clean: t.classList.contains("dh-clean"),
          title: t.getAttribute("title") || "",
          hiddenPanel: document.querySelector("#dh-ltv-panel").classList.contains("hidden"),
        };
      });
      ok("E2a · the tile exists", !!tile, JSON.stringify(tile));
      eq("E2b · …counting exactly the fixture's over-value cases", tile.n, String(expected.length));
      eq("E2c · …under the words the role card asked for", tile.lbl, "Loan above property value ▾");
      ok("E2d · …coloured as a fault while it is not zero", tile.warn && !tile.clean, JSON.stringify(tile));
      ok("E2e · …and saying in plain English what it is and what to do", /typo/i.test(tile.title) && /loan/i.test(tile.title), tile.title);
      ok("E3a · its drawer starts closed", tile.hiddenPanel);

      await page.click("#dh-tile-ltv");
      await wait(page, 600);
      const drawer = await page.evaluate(() => {
        const p = document.querySelector("#dh-ltv-panel");
        return {
          open: !p.classList.contains("hidden"),
          rows: [...p.querySelectorAll(".row-item")].length,
          text: p.textContent.replace(/\s+/g, " "),
          sub: (p.querySelector(".panel-sub") || {}).textContent || "",
        };
      });
      ok("E3b · clicking opens it", drawer.open, JSON.stringify(drawer.open));
      eq("E3c · …listing one row per offending case", drawer.rows, expected.length);
      ok("E3d · …naming ca015's numbers and its LTV", /£235,000/.test(drawer.text) && /£185,000/.test(drawer.text) && /127%/.test(drawer.text), drawer.text.slice(0, 300));
      ok("E3e · …and explaining itself in words on the panel", /loan amount/i.test(drawer.sub) && /property value/i.test(drawer.sub), drawer.sub.slice(0, 200));

      const readiness = await page.evaluate(() => [...document.querySelectorAll("#dh-readiness .dh-readiness-item")]
        .map((el) => ({
          label: (el.querySelector(".dh-readiness-label") || {}).textContent.trim(),
          count: Number((el.querySelector(".dh-readiness-count") || {}).textContent.trim()),
          tile: ((el.getAttribute("onclick") || "").match(/getElementById\('([^']+)'\)/) || [])[1] || null,
        })));
      const row = readiness.find((r) => r.tile === "dh-tile-ltv");
      ok("E4a · the readiness rollup lists it too", !!row, JSON.stringify(readiness.map((r) => r.tile)));
      eq("E4b · …with the same count as the tile", row && row.count, expected.length);
      eq("E4c · …under the same label", row && row.label, "Loan above property value");

      /* And the zero state: fix the value in the mock, reload the page, the fault is gone. */
      await page.evaluate(async (ids) => {
        for (const id of ids) {
          const { data } = await window.__mockDb.from("cases").select("loan_amount").eq("id", id).single();
          await window.__mockDb.from("cases").update({ property_value: Number(data.loan_amount) * 2 }).eq("id", id);
        }
      }, expected);
      await page.evaluate(() => window.loadDataHealth());
      await wait(page, 2500);
      const fixed = await page.evaluate(() => {
        const t = document.querySelector("#dh-tile-ltv");
        const p = document.querySelector("#dh-ltv-panel");
        return {
          n: t.querySelector(".num").textContent.trim(),
          clean: t.classList.contains("dh-clean"),
          warn: t.classList.contains("warn"),
          empty: !!p.querySelector(".empty"),
          listed: [...document.querySelectorAll("#dh-readiness .dh-readiness-item")]
            .some((el) => /getElementById\('dh-tile-ltv'\)/.test(el.getAttribute("onclick") || "")),
        };
      });
      eq("E5a · fixing the values takes the count to 0", fixed.n, "0");
      ok("E5b · …folds the tile away with the other clean checks", fixed.clean && !fixed.warn, JSON.stringify(fixed));
      ok("E5c · …turns the drawer into its own good-news line", fixed.empty, JSON.stringify(fixed));
      ok("E5d · …and drops it out of the readiness rollup", !fixed.listed, JSON.stringify(fixed));
      eq("E6 · no console errors on Data health", realErr(page), []);
      await page.close();
    }

    /* =======================================================================
       §F · the other personas see none of this break
       ======================================================================= */
    {
      console.log("\n— §F · every persona this round touches, clean");
      for (const persona of ["p1", "p2", "p3"]) {
        const page = await newPage(browser, persona, { viewport: { width: 1280, height: 900 } });
        await goto(page, "protection", 1800);
        await goto(page, "reports", 2500);
        await goto(page, "pipeline", 1500);
        const wrapped = await page.evaluate(() => {
          const pg = document.querySelector("#page-reports");
          const t = [...pg.querySelectorAll("table")];
          return { n: t.length, unwrapped: t.filter((x) => !x.parentElement.classList.contains("table-scroll")).length };
        });
        eq(`F1·${persona} · every Reports table is boxed for this persona too`, wrapped.unwrapped, 0);
        eq(`F2·${persona} · no console or page errors`, realErr(page), []);
        await page.close();
      }
    }

  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log("\n================================================================");
  console.log(`r69_polish: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  FAIL: " + f)); process.exit(1); }
})();
