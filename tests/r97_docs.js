/* ============================================================================
   R97 · D — tests/r97_docs.js   (plain Node, no browser)

   THE DOCS / CI SLICE OF THE R97 RED-TEAM FIXES.

   §A edge/ holds ONE source per function — the highest -vN (D-6). Strict: a second
        <name>-v*.ts for any function fails. During R97 the process-emails v21/v22 pair is
        removed by slice E, so this suite is red on the D branch alone and turns green
        once E merges — by design (no exception is carved out for it).
   §B vercel.json installCommand starts with `npm ci` (D-5).
   §C .github/CODEOWNERS covers every production / CI-gate path with a real @owner (D-3).
   §D build.js allow-list (D-4): a scratch copy of the tree is built twice, offline
        (NX_CONTENT_FIXTURE missing + NX_CONTENT_OPTIONAL=1) — clean, then with `x.csv`,
        `Passwords.xlsx` and `admin/keys.env` planted. The planted files are absent from
        dist/ and the file count equals the clean build's (baseline computed, not hard-coded).
   §E db/check-schema-drift.js session_ok rule (D-1): the committed snapshot passes; a copy
        with the R86 `and public.session_ok()` stripped fails, naming the functions.
   §F docs (D-2): README.md and HARNESS.md say a merge applies supabase/migrations/.
   ========================================================================== */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const REPO = "/root/nx";
let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}

/* §A — one source per edge function */
console.log("\n— §A · edge/: highest -vN per function only");
{
  const files = fs.readdirSync(path.join(REPO, "edge"));
  const odd = files.filter((f) => !/^[a-z0-9-]+-v\d+\.ts$/.test(f));
  ok("A1 · every file in edge/ is <name>-v<N>.ts", odd.length === 0, odd.join(", "));
  const by = {};
  files.forEach((f) => { const m = /^([a-z0-9-]+)-v(\d+)\.ts$/.exec(f); if (m) (by[m[1]] = by[m[1]] || []).push(+m[2]); });
  const dup = Object.keys(by).filter((k) => by[k].length > 1).map((k) => `${k}: v${by[k].sort((a, b) => a - b).join(", v")}`);
  ok(`A2 · exactly one source per function (${Object.keys(by).length} functions)`, dup.length === 0, dup.join(" | "));
  ["doc-upload-v5", "fact-find-v4", "new-lead-v4", "nps-capture-v4", "unsubscribe-v2", "unsubscribe-v3"].forEach((f) =>
    ok(`A3 · ${f}.ts is gone`, !files.includes(f + ".ts")));
}

/* §B — npm ci in production */
console.log("\n— §B · vercel.json installCommand");
{
  const v = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8"));
  ok("B1 · installCommand starts with `npm ci`", /^npm ci(\s|$)/.test(v.installCommand || ""), JSON.stringify(v.installCommand));
}

/* §C — CODEOWNERS */
console.log("\n— §C · .github/CODEOWNERS");
{
  const p = path.join(REPO, ".github", "CODEOWNERS");
  const txt = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  ok("C1 · .github/CODEOWNERS exists", !!txt);
  const rules = txt.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((l) => l.split(/\s+/));
  ok("C2 · every rule names at least one @owner and no placeholder", rules.length > 0 && rules.every((r) => r.length > 1 && r.slice(1).every((o) => /^@[A-Za-z0-9][A-Za-z0-9-]*(\/[A-Za-z0-9._-]+)?$/.test(o))),
    JSON.stringify(rules.filter((r) => r.length < 2 || !r.slice(1).every((o) => /^@[A-Za-z0-9]/.test(o)))));
  // A path is covered when a rule's pattern is that path, or a directory pattern it sits under.
  const covers = (pat, target) => {
    const p0 = pat.replace(/^\//, ""), t = target.replace(/^\//, "");
    if (p0.endsWith("/")) return t === p0 || t.startsWith(p0);
    return t === p0;
  };
  ["supabase/migrations/", ".github/", "tests/run-battery.sh", "build.js", "vercel.json", "package.json", "package-lock.json", "edge/"].forEach((t) =>
    ok(`C3 · ${t} has a code owner`, rules.some((r) => r.length > 1 && covers(r[0], t))));
}

/* §D — build.js ships an allow-list only */
console.log("\n— §D · build.js allow-list (fixture build in a scratch copy)");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r97_docs_"));
  try {
    const tracked = execFileSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
    tracked.forEach((f) => {
      const src = path.join(REPO, f);
      if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) return;
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.copyFileSync(src, path.join(tmp, f));
    });
    fs.symlinkSync(fs.realpathSync(path.join(REPO, "node_modules")), path.join(tmp, "node_modules"));
    const env = { ...process.env, NX_CONTENT_FIXTURE: path.join(tmp, "no_such_fixture.json"), NX_CONTENT_OPTIONAL: "1" };
    const list = (d) => { const out = []; (function w(a, r) { for (const n of fs.readdirSync(a)) { const p = path.join(a, n), q = r ? r + "/" + n : n; fs.statSync(p).isDirectory() ? w(p, q) : out.push(q); } })(d, ""); return out.sort(); };

    const b1 = spawnSync("node", ["build.js"], { cwd: tmp, encoding: "utf8", env });
    ok("D1 · clean scratch build exits 0", b1.status === 0, (b1.stderr || "").slice(-300));
    const base = b1.status === 0 ? list(path.join(tmp, "dist")) : [];
    ok("D2 · clean build ships files", base.length > 0, String(base.length));
    const ALLOWED = new Set([".html", ".css", ".js", ".svg", ".png", ".jpg", ".jpeg", ".ico", ".mp4", ".txt", ".xml", ".webmanifest", ".woff2"]);
    const offList = base.filter((f) => !ALLOWED.has(path.extname(f).toLowerCase()));
    ok("D3 · every file in the clean dist/ has an allowed extension", offList.length === 0, offList.join(", "));

    fs.writeFileSync(path.join(tmp, "x.csv"), "name,email\nTest Person,test@example.invalid\n");
    fs.writeFileSync(path.join(tmp, "Passwords.xlsx"), "not really a spreadsheet");
    fs.writeFileSync(path.join(tmp, "admin", "keys.env"), "SOME_KEY=placeholder\n");
    const b2 = spawnSync("node", ["build.js"], { cwd: tmp, encoding: "utf8", env });
    ok("D4 · planted scratch build exits 0", b2.status === 0, (b2.stderr || "").slice(-300));
    const after = b2.status === 0 ? list(path.join(tmp, "dist")) : [];
    ["x.csv", "Passwords.xlsx", "admin/keys.env"].forEach((f) => ok(`D5 · ${f} is NOT in dist/`, b2.status === 0 && !after.includes(f)));
    ok(`D6 · dist/ file count unchanged by the planted files (baseline ${base.length})`, after.length === base.length && after.join("|") === base.join("|"), `${base.length} → ${after.length}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* §E — the session_ok drift rule */
console.log("\n— §E · db/check-schema-drift.js session_ok rule");
{
  const run = (args) => spawnSync("node", [path.join(REPO, "db", "check-schema-drift.js"), "--functions-only", ...args], { encoding: "utf8" });
  const good = run([]);
  ok("E1 · the committed snapshot passes", good.status === 0, (good.stdout + good.stderr).slice(-300));
  const snap = fs.readFileSync(path.join(REPO, "db", "_live_functions_snapshot.sql"), "utf8");
  ok("E2 · the snapshot carries session_ok() bodies (R86 refresh)", (snap.match(/session_ok\(\)/g) || []).length >= 14);
  const tmp = path.join(os.tmpdir(), `r97_snap_${process.pid}.sql`);
  fs.writeFileSync(tmp, snap.replace(/ and public\.session_ok\(\)\) then {2}-- R86/g, ") then"));
  const bad = run(["--snapshot", tmp]);
  fs.rmSync(tmp, { force: true });
  ok("E3 · a snapshot with the guard stripped FAILS, naming the function", bad.status === 1 && /SESSION_OK DRIFT: .*find_duplicate_clients/.test(bad.stderr), `exit ${bad.status} ${bad.stderr.slice(0, 200)}`);
  const named = ((/\(\): ([a-z_, ]+)$/.exec(bad.stderr.split("\n")[0]) || [])[1] || "").split(", ").filter(Boolean);
  ok("E4 · helpers and triggers are not flagged", named.length > 0 && !named.some((n) => /^is_|^session_ok$|^my_role$|^audit_row$/.test(n)), named.join(", "));
}

/* §F — docs say what a merge does */
console.log("\n— §F · README.md / HARNESS.md");
{
  const rd = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  const hn = fs.readFileSync(path.join(REPO, "HARNESS.md"), "utf8");
  const said = /SQL in `supabase\/migrations\/` IS applied to production by the merge/;
  ok("F1 · README.md says a merge applies supabase/migrations/", said.test(rd));
  ok("F2 · HARNESS.md says a merge applies supabase/migrations/", said.test(hn));
  ok("F3 · neither says SQL is not deployed by a merge", !/Edge functions and SQL are not deployed by a merge/.test(rd) && !/Daniel pastes SQL\./.test(hn));
  ok("F4 · deploy.bat is gone", !fs.existsSync(path.join(REPO, "deploy.bat")));
}

console.log(`\nr97_docs: ${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
