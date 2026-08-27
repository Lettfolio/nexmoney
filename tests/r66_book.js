#!/usr/bin/env node
/* =============================================================================
   tests/r66_book.js — acceptance tests for R66 agent A (the client book)

   §A  SEARCH BY POSTCODE AND LENDER (H4) — the Clients search box matches the
       client's own name/email/phone AND any of their cases' property address
       and lender. "BH6" finds the Southbourne landlord, "skipton" finds them,
       "Grand Ave" finds them, another outcode does not. The segment chip counts
       and the bulk bar follow the filtered list. The placeholder says so.

   §B  THE PORTFOLIO STRIP (H5) — a landlord with 2+ distinct properties gets a
       #client-portfolio strip ABOVE the case cards: properties, total lending,
       total value, portfolio LTV, rent/mo, rental cover. Every figure is
       recomputed here independently off window.__mockDb. A property recorded as
       SOLD is excluded and said so; not-proceeding cases never count; a missing
       property value blanks the LTV and says on how many; a single-property
       client gets NO strip; the strip is visible to an adviser (p2) because it
       is CLIENT money, not firm money. Plus: the timeline folds shut on a
       client with 3+ cases and stays open below that.

   §C  LIVE-SIBLING WORDING (L6) — the .cprop-prev summary reads from the folded
       cases' stages: all live → "N other live case(s) on this property";
       all terminal → "N previous case(s) on this property" (R60 wording,
       unchanged); mixed → "1 other live case · 2 previous on this property".

   §D  R60 CONTRACT INTACT — .cl-mini rows are still .row-item with
       .row-main > .t[onclick] and a .cl-prot-chip.

   §E  No console/page errors for p2, p3, p4.

   Run:  node /root/nx/tests/r66_book.js   (expects a static server on 8099;
                                            starts one itself if absent)
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
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }

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

async function boot(browser, persona) {
  const ctx = await browser.newContext();
  // R64 made Clients default to "mine"; every §A count below is about the WHOLE book, so the
  // adviser filter is pinned to Everyone before the app boots rather than clicked afterwards.
  await ctx.addInitScript(() => {
    try {
      ["nx_ret_month", "nx_wt_lastrun"].forEach((k) => localStorage.removeItem(k));
      localStorage.setItem("nx_clients_adviser", "all");
    } catch (e) { /* private mode — the app copes, so must the test */ }
  });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push("pageerror: " + String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console: " + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}
const realErr = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs|favicon/i.test(e));

async function search(page, term) {
  await page.evaluate((t) => {
    const box = document.querySelector("#client-search");
    box.value = t;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }, term);
  await page.waitForTimeout(700);   // 250ms debounce + render
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* =====================================================================
     §A · search by postcode and lender
     ===================================================================== */
  console.log("— §A · the Clients search finds a postcode and a lender");
  const pa = await boot(browser, "p1");

  const fxA = await pa.evaluate(async () => {
    const db = window.__mockDb;
    const { data: cl } = await db.from("clients").insert({
      first_name: "Marlene", last_name: "Southbourne66", email: "marlene.s66@example.com", phone: "07700900661",
    }).select("id").single();
    await db.from("cases").insert({
      client_id: cl.id, case_kind: "buy_to_let", stage: "completed", lender: "Skipton",
      property_address: "12 Grand Ave, Southbourne, BH6 3AB", loan_amount: 180000, property_value: 300000,
      rate_end_date: "2027-09-01", completed_at: "2025-09-01", assigned_to: "p2",
    }).select("id").single();
    return { clientId: cl.id };
  });
  ok("fixtures · a Southbourne BH6 client with a Skipton case", !!fxA.clientId, JSON.stringify(fxA));

  const placeholder = await pa.evaluate(() => {
    const b = document.querySelector("#client-search");
    return { ph: b.getAttribute("placeholder") || "", aria: b.getAttribute("aria-label") || "" };
  });
  ok("A0 · the placeholder names every field the box searches",
    /name/i.test(placeholder.ph) && /email/i.test(placeholder.ph) && /phone/i.test(placeholder.ph)
    && /postcode/i.test(placeholder.ph) && /lender/i.test(placeholder.ph), JSON.stringify(placeholder));

  await pa.evaluate(() => window.nav("clients"));
  await pa.waitForTimeout(1400);

  const probe = async (term) => {
    await search(pa, term);
    return pa.evaluate((id) => {
      const rows = [...document.querySelectorAll("#client-list .client-row")];
      const segAll = document.querySelector('#client-segment .seg-btn[data-seg="all"] .seg-count');
      const selAll = document.querySelector("#client-bulk .client-selall label");
      return {
        found: rows.some((r) => r.dataset.client === id),
        rows: rows.length,
        segAll: segAll ? Number(segAll.textContent.trim()) : null,
        selAll: selAll ? selAll.textContent.trim() : "",
      };
    }, fxA.clientId);
  };

  const bh6 = await probe("BH6");
  ok("A1 · \"BH6\" (the outcode alone) finds the client", bh6.found, JSON.stringify(bh6));
  const skipton = await probe("skipton");
  ok("A2 · \"skipton\" (lower-case lender) finds the client", skipton.found, JSON.stringify(skipton));
  const grand = await probe("Grand Ave");
  ok("A3 · \"Grand Ave\" (street) finds the client", grand.found, JSON.stringify(grand));
  const other = await probe("SW1A 2ZZ");
  ok("A4 · a different postcode does NOT find them", !other.found && other.rows === 0, JSON.stringify(other));

  const back = await probe("Southbourne66");
  ok("A5 · the \"All\" chip count equals the rows the search left on screen",
    back.segAll === back.rows && back.rows >= 1, JSON.stringify(back));
  ok("A6 · the bulk bar's \"Select all N shown\" follows the filtered list",
    new RegExp(`Select all ${back.rows} shown`).test(back.selAll), JSON.stringify(back));

  const nameStill = await probe("marlene");
  ok("A7 · name search still works (nothing regressed)", nameStill.found, JSON.stringify(nameStill));
  await search(pa, "");

  /* =====================================================================
     §B · the portfolio strip
     ===================================================================== */
  console.log("\n— §B · the portfolio strip");

  /* The mock DB is per-PAGE (it is an in-memory fixture built at boot), so any page that has to
     see this landlord has to seed him itself. Hence one seeding function, called per page. */
  const seedLandlord = (page) => page.evaluate(async () => {
    const db = window.__mockDb;
    const mkClient = async (first, last) => (await db.from("clients").insert({
      first_name: first, last_name: last, email: `${first}.${last}@example.com`.toLowerCase(), phone: "07700900662",
    }).select("id").single()).data;
    const mkCase = async (clientId, o) => (await db.from("cases").insert(Object.assign({
      client_id: clientId, case_kind: "buy_to_let", lender: "Paragon", assigned_to: "p2",
    }, o)).select("id").single()).data;

    // The landlord: three distinct buildings, one of them sold, plus two cases that must not count.
    const land = await mkClient("Gareth", "Portfolio66");
    const A = "1 Alpha Road, Poole, BH15 1AA";
    const B = "2 Beta Road, Poole, BH15 2BB";
    const C = "3 Gamma Road, Poole, BH15 3CC";
    await mkCase(land.id, { property_address: A, stage: "completed", loan_amount: 200000, property_value: 400000, monthly_rent: 1500, rate_end_date: "2028-03-01", completed_at: "2026-03-01" });
    // …a dead deal on the SAME building: must not be counted, must not become the current case.
    await mkCase(land.id, { property_address: A, stage: "not_proceeding", loan_amount: 999999, property_value: 999999, monthly_rent: 9999 });
    await mkCase(land.id, { property_address: B, stage: "completed", loan_amount: 150000, property_value: 250000, monthly_rent: 1100, rate_end_date: "2028-06-01", completed_at: "2026-06-01" });
    // …an older, untracked completed case on B: the CURRENT one (watched) is what counts.
    await mkCase(land.id, { property_address: B, stage: "completed", loan_amount: 111111, property_value: 111111, monthly_rent: 111, completed_at: "2019-01-01" });
    await mkCase(land.id, { property_address: C, stage: "completed", loan_amount: 90000, property_value: 180000, monthly_rent: 800, property_sold_at: "2026-02-01", completed_at: "2018-01-01" });

    // A single-property client (two cases on ONE building) — no strip, timeline still open.
    const one = await mkClient("Nora", "Onehouse66");
    const D = "4 Delta Road, Poole, BH15 4DD";
    await mkCase(one.id, { property_address: D, stage: "completed", loan_amount: 120000, property_value: 240000, rate_end_date: "2028-01-01", completed_at: "2026-01-01" });
    await mkCase(one.id, { property_address: D, stage: "completed", loan_amount: 100000, property_value: 240000, completed_at: "2018-01-01" });

    return { landId: land.id, oneId: one.id, A, B, C, D };
  });
  const fxB = await seedLandlord(pa);
  ok("fixtures · a 3-property landlord and a 1-property client", !!fxB.landId && !!fxB.oneId, JSON.stringify(fxB).slice(0, 160));

  /* The independent recompute. Reads the raw rows out of the mock DB and applies the R66 rule
     from scratch — group by address, drop not_proceeding, pick the current case (watched beats
     sold beats untracked), drop sold properties — without calling a single app function. */
  const want = await pa.evaluate(async (fx) => {
    const db = window.__mockDb;
    const { data: rows } = await db.from("cases").select("*").eq("client_id", fx.landId);
    const byAddr = {};
    (rows || []).filter((r) => r.stage !== "not_proceeding").forEach((r) => {
      (byAddr[r.property_address] = byAddr[r.property_address] || []).push(r);
    });
    const rank = (r) => (r.property_sold_at ? 2 : r.rate_end_date ? 1 : 3);
    let lending = 0, value = 0, rent = 0, sold = 0, n = 0;
    Object.values(byAddr).forEach((list) => {
      const cur = list.slice().sort((a, b) => rank(a) - rank(b))[0];
      if (cur.property_sold_at) { sold++; return; }
      n++; lending += Number(cur.loan_amount); value += Number(cur.property_value); rent += Number(cur.monthly_rent);
    });
    return {
      n, sold, lending, value, rent,
      ltv: Math.round((lending / value) * 1000) / 10,
      cover: Math.round(((rent * 12) / (lending * 0.055)) * 100),
    };
  }, fxB);
  eq("B0 · the independent recompute is the fixture we intended",
    want, { n: 2, sold: 1, lending: 350000, value: 650000, rent: 2600, ltv: 53.8, cover: 162 });

  const readStrip = (page) => page.evaluate(() => {
    const s = document.querySelector("#client-portfolio");
    if (!s) return { present: false };
    const txt = (sel) => { const e = s.querySelector(sel); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; };
    const cards = document.querySelector("#modal .cl-book, #modal .cprop-group");
    return {
      present: true,
      all: s.textContent.replace(/\s+/g, " ").trim(),
      props: txt(".cpf-props"), lending: txt(".cpf-lending"), value: txt(".cpf-value"),
      ltv: txt(".cpf-ltv"), rent: txt(".cpf-rent"), cover: txt(".cpf-cover"),
      sub: (document.querySelector("#client-portfolio-sub") || {}).textContent || "",
      aboveCards: !!cards && !!(s.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  });

  await pa.evaluate((id) => window.openClient(id), fxB.landId);
  await pa.waitForTimeout(1200);
  const strip = await readStrip(pa);
  ok("B1 · the strip renders on a multi-property client", strip.present, JSON.stringify(strip));
  ok("B2 · …above the case cards", strip.aboveCards, JSON.stringify(strip).slice(0, 200));
  ok("B3 · properties = 2, and it says the sold one was left out",
    /^2 properties/.test(strip.props || "") && /\(excl\. 1 sold\)/.test(strip.props || ""), strip.props);
  ok("B4 · total lending = £350,000 (not-proceeding and the superseded case excluded)",
    (strip.lending || "").includes("£350,000"), strip.lending);
  ok("B5 · total value = £650,000", (strip.value || "").includes("£650,000"), strip.value);
  ok("B6 · portfolio LTV = 53.8%", (strip.ltv || "").includes(want.ltv + "%"), strip.ltv);
  ok("B7 · rent = £2,600/mo", (strip.rent || "").includes("£2,600/mo"), strip.rent);
  ok("B8 · rental cover = 162% (annual rent ÷ lending × 5.5%)", (strip.cover || "").includes(want.cover + "%"), strip.cover);
  const coverTip = await pa.evaluate(() => (document.querySelector("#client-portfolio .cpf-cover") || {}).title || "");
  ok("B9 · the cover tooltip states the 5.5% stress rate", /5\.5%/.test(coverTip), coverTip.slice(0, 140));
  ok("B10 · a .panel-sub line states the basis (current case per property, exclusions, client money)",
    /current case on each property/i.test(strip.sub) && /not proceeding/i.test(strip.sub) && /not firm income/i.test(strip.sub),
    strip.sub.slice(0, 200));
  ok("B11 · the 999,999 not-proceeding case is nowhere in the strip", !/999,999/.test(strip.all), strip.all.slice(0, 200));

  /* Timeline fold — the landlord has 5 cases. */
  const foldMany = await pa.evaluate(() => {
    const d = document.querySelector("#client-timeline-fold");
    const strip2 = document.querySelector("#client-portfolio");
    return {
      present: !!d, open: d ? d.open : null,
      hasList: !!document.querySelector("#tl-list"), hasAdd: !!document.querySelector("#tl-add-btn"),
      hasCaseSel: !!document.querySelector("#tl-case"), hasFilters: !!document.querySelector("#tl-filters"),
      hasAudit: !!document.querySelector("#client-audit"),
      cardsFirst: !!d && !!strip2 && !!(strip2.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  });
  ok("B12 · 5 cases → the timeline is a <details>, closed by default", foldMany.present && foldMany.open === false, JSON.stringify(foldMany));
  ok("B13 · …with every timeline id kept (#tl-list #tl-add-btn #tl-case #tl-filters #client-audit)",
    foldMany.hasList && foldMany.hasAdd && foldMany.hasCaseSel && foldMany.hasFilters && foldMany.hasAudit, JSON.stringify(foldMany));
  ok("B14 · …and the portfolio + cards come FIRST", foldMany.cardsFirst, JSON.stringify(foldMany));
  const opened = await pa.evaluate(async () => {
    document.querySelector("#client-timeline-fold summary").click();
    await new Promise((r) => setTimeout(r, 200));
    const d = document.querySelector("#client-timeline-fold");
    return { open: d.open, rows: document.querySelectorAll("#tl-list .tl-row").length };
  });
  ok("B15 · one click opens it and the rows are all still there", opened.open === true, JSON.stringify(opened));
  await pa.evaluate(() => window.closeModal && window.closeModal());
  await pa.waitForTimeout(300);

  /* Single-property client — no strip, timeline NOT folded (2 cases). */
  await pa.evaluate((id) => window.openClient(id), fxB.oneId);
  await pa.waitForTimeout(1000);
  const one = await pa.evaluate(() => ({
    strip: !!document.querySelector("#client-portfolio"),
    fold: !!document.querySelector("#client-timeline-fold"),
    section: !!document.querySelector(".tl-section"),
  }));
  ok("B16 · a single-property client gets NO strip", one.strip === false, JSON.stringify(one));
  ok("B17 · …and with 2 cases the timeline is NOT folded", one.fold === false && one.section === true, JSON.stringify(one));
  await pa.evaluate(() => window.closeModal && window.closeModal());
  await pa.waitForTimeout(300);

  /* Value-missing degradation. */
  const missing = await pa.evaluate(async (fx) => {
    const db = window.__mockDb;
    await db.from("cases").update({ property_value: null }).eq("client_id", fx.landId).eq("property_address", fx.B).eq("stage", "completed").not("rate_end_date", "is", null);
    await window.openClient(fx.landId);
    await new Promise((r) => setTimeout(r, 1000));
    const s = document.querySelector("#client-portfolio");
    return {
      ltv: s.querySelector(".cpf-ltv").textContent.replace(/\s+/g, " ").trim(),
      miss: (s.querySelector(".cpf-miss") || {}).textContent || "",
      value: s.querySelector(".cpf-value").textContent.replace(/\s+/g, " ").trim(),
      lending: s.querySelector(".cpf-lending").textContent.replace(/\s+/g, " ").trim(),
      sub: (document.querySelector("#client-portfolio-sub") || {}).textContent || "",
    };
  }, fxB);
  ok("B18 · a missing property value blanks the portfolio LTV rather than guessing it",
    /portfolio LTV —/.test(missing.ltv), JSON.stringify(missing));
  ok("B19 · …and says on how many properties the value is missing",
    /value missing on 1/.test(missing.miss), JSON.stringify(missing));
  ok("B20 · …while total lending is still the honest sum", missing.lending.includes("£350,000"), missing.lending);
  ok("B21 · …and the .panel-sub explains why the LTV is blank", /left blank/i.test(missing.sub), missing.sub.slice(0, 220));
  // put it back for the p2 read below
  await pa.evaluate(async (fx) => {
    await window.__mockDb.from("cases").update({ property_value: 250000 })
      .eq("client_id", fx.landId).eq("property_address", fx.B).not("rate_end_date", "is", null);
  }, fxB);
  await pa.evaluate(() => window.closeModal && window.closeModal());

  /* Not money-gated: an adviser sees the same figures. */
  const p2 = await boot(browser, "p2");
  const fxB2 = await seedLandlord(p2);
  await p2.evaluate((id) => window.openClient(id), fxB2.landId);
  await p2.waitForTimeout(1200);
  const stripP2 = await readStrip(p2);
  ok("B22 · the strip is visible to an adviser (p2) — client money, not firm money",
    stripP2.present && (stripP2.lending || "").includes("£350,000"), JSON.stringify(stripP2).slice(0, 220));
  ok("B23 · …with the same LTV and cover", (stripP2.ltv || "").includes("53.8%") && (stripP2.cover || "").includes("162%"),
    JSON.stringify({ ltv: stripP2.ltv, cover: stripP2.cover }));
  await p2.evaluate(() => window.closeModal && window.closeModal());

  /* =====================================================================
     §C · live-sibling wording in the .cprop-prev fold
     ===================================================================== */
  console.log("\n— §C · the fold says whether what it holds is live or previous");
  const fxC = await pa.evaluate(async () => {
    const db = window.__mockDb;
    const mk = async (last, addr, stages) => {
      const { data: cl } = await db.from("clients").insert({
        first_name: "Fold", last_name: last, email: `fold.${last}@example.com`.toLowerCase(),
      }).select("id").single();
      for (const s of stages) {
        await db.from("cases").insert({
          client_id: cl.id, case_kind: "buy_to_let", lender: "Precise", property_address: addr,
          stage: s, loan_amount: 100000, assigned_to: "p2",
          completed_at: s === "completed" ? "2024-01-01" : null,
        });
      }
      return cl.id;
    };
    return {
      live: await mk("TwoLive66", "5 Echo Road, Poole, BH15 5EE", ["application", "offer"]),
      prev: await mk("AllPrev66", "6 Fox Road, Poole, BH15 6FF", ["completed", "completed", "completed"]),
      mixed: await mk("Mixed66", "7 Golf Road, Poole, BH15 7GG", ["application", "offer", "completed", "not_proceeding"]),
    };
  });
  const summaryFor = async (id) => {
    await pa.evaluate((cid) => window.openClient(cid), id);
    await pa.waitForTimeout(1000);
    const s = await pa.evaluate(() => {
      const f = document.querySelector("#modal .cprop-prev");
      const minis = [...document.querySelectorAll("#modal .cl-mini")];
      return {
        summary: f ? f.querySelector("summary").textContent.replace(/\s+/g, " ").trim() : null,
        open: f ? f.open : null,
        minis: minis.length,
        contract: minis.length > 0 && minis.every((m) =>
          m.classList.contains("row-item") && !!m.querySelector(".row-main > .t") &&
          !!(m.querySelector(".row-main > .t") || {}).getAttribute && !!m.querySelector(".row-main > .t").getAttribute("onclick") &&
          !!m.querySelector(".cl-prot-chip")),
      };
    });
    await pa.evaluate(() => window.closeModal && window.closeModal());
    await pa.waitForTimeout(250);
    return s;
  };

  const cLive = await summaryFor(fxC.live);
  eq("C1 · two LIVE cases on one building → \"1 other live case on this property\"",
    cLive.summary, "1 other live case on this property");
  const cPrev = await summaryFor(fxC.prev);
  eq("C2 · all terminal → the R60 wording, unchanged",
    cPrev.summary, "2 previous cases on this property");
  const cMixed = await summaryFor(fxC.mixed);
  eq("C3 · mixed → both halves, counted separately",
    cMixed.summary, "1 other live case · 2 previous on this property");

  /* =====================================================================
     §D · the R60 mini-row DOM contract is untouched
     ===================================================================== */
  console.log("\n— §D · the R60 fold row contract");
  ok("D1 · .cl-mini rows are .row-item with .row-main > .t[onclick] and a .cl-prot-chip (live fold)",
    cLive.contract, JSON.stringify(cLive));
  ok("D2 · …and in the all-previous fold", cPrev.contract, JSON.stringify(cPrev));
  ok("D3 · …and in the mixed fold", cMixed.contract, JSON.stringify(cMixed));
  ok("D4 · every fold is still closed by default",
    cLive.open === false && cPrev.open === false && cMixed.open === false,
    JSON.stringify([cLive.open, cPrev.open, cMixed.open]));

  /* =====================================================================
     §E · no console errors on the three non-admin personas
     ===================================================================== */
  console.log("\n— §E · clean console");
  ok("E1 · p1 (the suite's own long session) is clean", realErr(pa).length === 0, realErr(pa).join(" | ").slice(0, 300));
  ok("E2 · p2 is clean", realErr(p2).length === 0, realErr(p2).join(" | ").slice(0, 300));
  for (const persona of ["p3", "p4"]) {
    const p = await boot(browser, persona);
    const fx = await seedLandlord(p);
    await p.evaluate((id) => window.openClient(id), fx.landId);
    await p.waitForTimeout(1200);
    const s = await readStrip(p);
    await p.evaluate(() => window.closeModal && window.closeModal());
    await p.evaluate(() => window.nav("clients"));
    await p.waitForTimeout(1200);
    await search(p, "BH15");
    ok(`E3 · ${persona} · the strip renders and the postcode search runs with no errors`,
      s.present && realErr(p).length === 0, realErr(p).join(" | ").slice(0, 300) || JSON.stringify(s).slice(0, 120));
    await p.close();
  }

  console.log(`\nR66-book: ${pass} passed, ${failures.length} failed`);
  if (failures.length) failures.forEach((f) => console.log("  FAIL: " + f));
  if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
