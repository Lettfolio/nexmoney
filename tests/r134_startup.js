/* R134 — start-up reads go out together, the role is asked once, a full book read asks for its pages together,
   and Today's 90-day notes read is paged. Every database call is slowed by 40 ms here so "together" can be told
   from "one after another". */
const { chromium } = require("playwright");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " — " + d : "")); } };
const LAG = 40;
const init = (lag) => {
  window.__NEX_SKIP_TOUR = true; window.__log = [];
  let real;
  const slow = (o, label) => new Proxy(o, { get(t, k) {
    const v = t[k];
    if (k === "then") return (res, rej) => { const e = { what: label.what, range: label.range || null, start: performance.now(), end: null }; window.__log.push(e);
      return new Promise((r) => setTimeout(r, lag)).then(() => t.then((x) => { e.end = performance.now(); return x; })).then(res, rej); };
    if (typeof v !== "function") return v;
    return function () { const out = v.apply(t, arguments); const l = k === "range" ? { what: label.what, range: [arguments[0], arguments[1]] } : label;
      return out && typeof out.then === "function" ? slow(out, l) : out; };
  } });
  const wrap = (c) => { const from = c.from.bind(c), rpc = c.rpc.bind(c);
    c.from = (t) => slow(from(t), { what: t }); c.rpc = (n, a) => slow(rpc(n, a), { what: "rpc " + n }); return c; };
  Object.defineProperty(window, "supabase", { configurable: true, get() { return real; }, set(v) {
    if (v && v.createClient && !v.__w) { const cc = v.createClient.bind(v); v.createClient = function () { return wrap(cc.apply(null, arguments)); }; v.__w = 1; } real = v; } });
};
const boot = async (b, as) => { const ctx = await b.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(String(e)));
  await p.addInitScript(init, LAG); await p.goto("http://localhost:8099/admin/mock.html?as=" + as + "&scope=default");
  await p.waitForFunction(() => document.querySelector("#briefing-list .brief-row, #briefing-list .empty"), null, { timeout: 30000 }); await p.waitForTimeout(1200); return p; };
const log = (p) => p.evaluate(() => window.__log.map((e) => ({ what: e.what, range: e.range, start: Math.round(e.start), end: e.end == null ? null : Math.round(e.end) })));
const first = (l, w) => l.find((e) => e.what === w);
(async () => { const b = await chromium.launch();
  console.log("§A — start-up (owner, real mode)");
  let p = await boot(b, "p4"); let l = await log(p);
  const role = l.filter((e) => e.what === "rpc my_role"), sok = l.filter((e) => e.what === "rpc session_ok");
  ok("A1 · my_role() is asked once at sign-in", role.length === 1, String(role.length));
  ok("A2 · session_ok() is asked once, while my_role() is still out", sok.length === 1 && sok[0].start < role[0].end, JSON.stringify([role[0], sok[0]]));
  const set = first(l, "settings"), prof = l.filter((e) => e.what === "profiles"), abs = first(l, "staff_absences"), act = first(l, "rpc get_staff_activity"), cases = first(l, "cases"), clients = first(l, "clients");
  const startup = [set, prof[0], prof[1], abs, act];
  ok("A3 · nothing is read before the gate has answered", startup.concat([cases, clients]).every((e) => e && e.start >= role[0].end && e.start >= sok[0].end), JSON.stringify(startup));
  const spread = Math.max(...startup.map((e) => e.start)) - Math.min(...startup.map((e) => e.start));
  ok("A4 · settings, team, contact fields, rota and sign-in record are requested together", spread < LAG / 2, spread + "ms apart");
  ok("A5 · the book is requested with them, not after them", cases.start - set.start < LAG / 2 && clients.start - set.start < LAG / 2, (cases.start - set.start) + "ms");
  const dash = first(l, "rpc get_dashboard_counts") || first(l, "rpc get_briefing");
  ok("A6 · the first page's own reads begin one round trip after the start-up reads, not five", dash && dash.start - set.start < LAG * 2.5, dash && (dash.start - set.start) + "ms");
  const st = await p.evaluate(() => ({ heading: document.querySelector("#today-heading").textContent, team: document.querySelectorAll("#board-adviser option").length, full: window.__bookStats().fullLoads, app: !document.querySelector("#app-view").classList.contains("hidden") }));
  ok("A7 · the app is up: heading names the user, the adviser filter is filled", st.app && /^Today — \S+/.test(st.heading) && st.team > 3, JSON.stringify(st));
  ok("A8 · still one full book load", st.full === 1, String(st.full));
  const notes = l.filter((e) => e.what === "case_notes" && e.range), ev = l.filter((e) => e.what === "case_events" && e.range);
  ok("A9 · Today's 90-day notes and events reads are paged", notes.length >= 1 && ev.length >= 1 && notes[0].range[0] === 0 && notes[0].range[1] === 999, JSON.stringify([notes[0], ev[0]]));
  ok("A10 · no page errors, error log empty", p.errs.length === 0 && await p.evaluate(() => (window.__errorLog || []).length === 0), p.errs.join("|"));
  await p.context().close();

  console.log("§B — an adviser and the administrator start the same way");
  for (const as of ["p2", "p1"]) { p = await boot(b, as); l = await log(p);
    const r = l.filter((e) => e.what === "rpc my_role"), s = first(l, "settings"), c = first(l, "cases");
    ok("B · " + as + ": role asked once, book requested with settings, app up", r.length === 1 && c && c.start - s.start < LAG / 2 && await p.evaluate(() => !document.querySelector("#app-view").classList.contains("hidden")) && p.errs.length === 0, JSON.stringify([r.length, s, c]));
    await p.context().close(); }

  console.log("§C — a full book read asks for its pages together (2,300 extra cases)");
  p = await boot(b, "p4");
  const seeded = await p.evaluate(async () => { const cl = (await window.__mockDb.from("clients").select("id").limit(1)).data[0].id; const rows = [];
    for (let i = 0; i < 2300; i++) rows.push({ client_id: cl, stage: "completed", lender: "Seed " + i });
    const r = await window.__mockDb.from("cases").insert(rows).select("id"); if (r.error) throw new Error(r.error.message); return r.data.length; });
  ok("C0 · 2,300 cases seeded", seeded === 2300, String(seeded));
  const total = await p.evaluate(() => window.__mock.counts().cases);
  const full = async () => { await p.evaluate(() => { window.__log.length = 0; window.bustBookCache("delete"); }); const snap = await p.evaluate(async () => { const s = await window.bookLoad(); return { n: s.cases.length, uniq: new Set(s.cases.map((c) => c.id)).size, err: s.error && s.error.message, cap: s.capHit, sorted: s.cases.every((c, i, a) => !i || String(a[i - 1].id) !== String(c.id)) }; });
    const pages = (await log(p)).filter((e) => e.what === "cases" && e.range); return { snap, pages, stored: await p.evaluate(() => localStorage.getItem("nx_book_rows_cases")) }; };
  let f = await full();
  ok("C1 · with no usable count the walk is one page after another, and the count is then stored", f.snap.n === total && f.pages.length === 3 && f.pages[1].start >= f.pages[0].end && f.stored === String(total), JSON.stringify([f.snap, f.pages, f.stored, total]));
  f = await full();
  const tog = f.pages.length === 3 && Math.max(...f.pages.map((e) => e.start)) < Math.min(...f.pages.map((e) => e.end));
  ok("C2 · the next full read sends all three pages before any has answered", tog, JSON.stringify(f.pages));
  ok("C3 · same rows, each once, no error, not capped", f.snap.n === total && f.snap.uniq === total && !f.snap.err && !f.snap.cap, JSON.stringify(f.snap));
  ok("C4 · the ranges are 0–999, 1000–1999, 2000–2999", JSON.stringify(f.pages.map((e) => e.range)) === "[[0,999],[1000,1999],[2000,2999]]", JSON.stringify(f.pages.map((e) => e.range)));
  await p.evaluate(async () => { const cl = (await window.__mockDb.from("clients").select("id").limit(1)).data[0].id; const rows = []; for (let i = 0; i < 1000; i++) rows.push({ client_id: cl, stage: "completed", lender: "More " + i }); await window.__mockDb.from("cases").insert(rows).select("id"); });
  f = await full();
  ok("C5 · the table grew by 1,000: three pages together, then one more, nothing lost", f.snap.n === total + 1000 && f.snap.uniq === total + 1000 && f.pages.length === 4 && f.pages[3].start >= f.pages[2].end, JSON.stringify([f.snap, f.pages.map((e) => e.range)]));
  await p.evaluate(() => localStorage.setItem("nx_book_rows_cases", "9000"));
  f = await full();
  ok("C6 · a stored count that is too high costs empty pages, not rows", f.snap.n === total + 1000 && f.snap.uniq === total + 1000 && f.stored === String(total + 1000), JSON.stringify([f.snap, f.pages.length, f.stored]));
  await p.evaluate(() => localStorage.setItem("nx_book_rows_cases", "not a number"));
  f = await full();
  ok("C7 · a damaged stored count falls back to the plain walk", f.snap.n === total + 1000 && f.pages[1].start >= f.pages[0].end, JSON.stringify(f.pages.map((e) => [e.start, e.end])));
  await p.evaluate(() => { window.__mock.failNextSelect("cases"); });
  f = await full();
  ok("C8 · a failed page is an error, not a short book", !!f.snap.err && f.snap.n === 0, JSON.stringify(f.snap));
  f = await full();
  ok("C9 · and the next read recovers", !f.snap.err && f.snap.n === total + 1000, JSON.stringify(f.snap));
  const capped = await p.evaluate(async () => { window.__setOwnerRowCap(2500); window.__log.length = 0; const s = await window.bookLoad(); const r = { n: s.cases.length, cap: s.capHit }; window.__setOwnerRowCap(5000); return r; });
  ok("C10 · the row cap still stops the read and is still reported", capped.n === 2500 && capped.cap === true, JSON.stringify(capped));
  ok("C11 · no page errors", p.errs.length === 0, p.errs.join("|"));
  await b.close(); console.log("\nR134: " + pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
