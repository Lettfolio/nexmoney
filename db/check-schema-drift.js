/* R82 — THE SCHEMA DRIFT CHECK.
 *
 * The problem it solves, named plainly: `admin/mock-supabase.js` is ~7,800 lines
 * hand-modelling a Postgres schema that is NOT versioned in this repo. R81 gave the
 * mock STRICT COLUMN MODE, which makes the mock refuse column names the way production
 * does — but strict mode only knows what the mock's own registry says, and the registry
 * is hand-maintained. If the registry and production disagree, the battery stays green
 * and is wrong. That is the one silent failure mode left in the harness.
 *
 * R81 proved the risk immediately and in the worst direction: it concluded that
 * `sms_queue.body` did not exist, deleted the column from two suites as a "ghost", and
 * left it out of the registry. Production has had an `sms_queue.body` column all along.
 * A registry that is merely self-consistent will happily certify a falsehood.
 *
 * This script compares the mock's registry against a snapshot of production's real
 * `information_schema`, committed beside it as `db/columns.json`. It turns a silent
 * disagreement into a loud one.
 *
 *   node db/check-schema-drift.js            # exits 1 on any drift
 *   node db/check-schema-drift.js --quiet    # exit code only
 *
 * REFRESHING THE SNAPSHOT (quarterly, or after any migration):
 *   Run this against the live database and replace db/columns.json with the result —
 *   `db/columns.sql` holds the exact query.
 *
 * WHAT COUNTS AS DRIFT, and what does not:
 *   · in prod, missing from the registry  -> ERROR. The mock will throw MOCK STRICT on a
 *     legitimate column and a real caller looks like a bug. This is the R81 failure.
 *   · in the registry, not in prod        -> ERROR. The mock permits a column production
 *     would 42703. This is the failure strict mode exists to prevent.
 *   · a table in prod the mock has no model of -> reported as INFO, not an error. The mock
 *     deliberately models only what the app touches; `backup_*` tables are excluded from
 *     the snapshot entirely (they are Daniel's import safety net, due to be dropped, and
 *     are not part of the app's schema contract).
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const REPO = path.resolve(__dirname, "..");
const PORT = 8151;
const QUIET = process.argv.includes("--quiet");
const log = (...a) => { if (!QUIET) console.log(...a); };

(async () => {
  const prod = JSON.parse(fs.readFileSync(path.join(REPO, "db", "columns.json"), "utf8"));

  // Serve the repo and read the registry out of a loaded mock page.
  const http = require("http");
  const serve = http.createServer((req, res) => {
    const p = path.join(REPO, decodeURIComponent(req.url.split("?")[0]));
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("no"); }
      const ext = path.extname(p);
      res.writeHead(200, { "Content-Type":
        ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" :
        ext === ".json" ? "application/json" : "text/html" });
      res.end(buf);
    });
  });
  await new Promise((r) => serve.listen(PORT, r));

  const browser = await chromium.launch();
  let registry;
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/admin/mock.html?as=p4`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mock && typeof window.__mock.columnRegistry === "function", { timeout: 30000 });
    registry = await page.evaluate(() => {
      const reg = window.__mock.columnRegistry();
      const out = {};
      Object.keys(reg).forEach((t) => {
        const v = reg[t];
        out[t] = Array.isArray(v) ? v.slice().sort() : Object.keys(v).sort();
      });
      return out;
    });
  } finally {
    await browser.close();
    serve.close();
  }

  let errors = 0;
  const infos = [];

  Object.keys(prod).sort().forEach((table) => {
    const p = prod[table];
    const m = registry[table];
    if (!m) { infos.push(`  (info) ${table} — in production, not modelled by the mock (${p.length} columns)`); return; }
    const missing = p.filter((c) => !m.includes(c));
    const extra = m.filter((c) => !p.includes(c));
    if (missing.length) {
      errors += missing.length;
      log(`  DRIFT ${table}: in PRODUCTION but NOT in the registry -> ${missing.join(", ")}`);
      log(`        the mock will throw MOCK STRICT on a legitimate column. Register it.`);
    }
    if (extra.length) {
      errors += extra.length;
      log(`  DRIFT ${table}: in the REGISTRY but NOT in production -> ${extra.join(", ")}`);
      log(`        the mock permits a column production would 42703. Remove it, or refresh the snapshot.`);
    }
  });

  Object.keys(registry).sort().forEach((table) => {
    if (!prod[table]) infos.push(`  (info) ${table} — modelled by the mock, absent from the snapshot (view? renamed? dropped?)`);
  });

  log("");
  infos.forEach((i) => log(i));
  log("");
  if (errors) {
    log(`SCHEMA DRIFT: ${errors} column disagreement(s) between the mock registry and production.`);
    log(`Fix the registry, or refresh db/columns.json if production is the thing that changed.`);
    process.exit(1);
  }
  log(`Schema OK — the mock's registry agrees with production on every modelled table.`);
})().catch((e) => { console.error(e); process.exit(2); });
