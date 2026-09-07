#!/usr/bin/env node
/* =============================================================================
   build.js — R84 · the deploy build for nexmoney-two.vercel.app

   WHAT: copies the site into dist/ and minifies the back-office JS + CSS there.
   The REPO stays readable (comments are the design record); only the SERVED
   bytes shrink. Measured on the R84 tree:
       admin/app.js            2,561 KB → 1,186 KB   (gzip 831 KB → 346 KB)
       admin/reports-money.js    421 KB →   227 KB   (gzip 133 KB →  66 KB)
       admin/admin.css           342 KB →   ~120 KB
   Every sign-in and every reload downloads these, so this roughly halves the
   cold-load transfer. Vercel runs `npm run build` (see vercel.json) and serves
   dist/; the git-push deploy flow is unchanged.

   WHY WHITESPACE+SYNTAX ONLY, NOT IDENTIFIER MINIFICATION: core.js,
   reports-money.js and app.js are three CLASSIC scripts sharing one global
   scope (see HARNESS.md "R78 · A"). Renaming top-level identifiers in one file
   would break the other two; esbuild's --minify-whitespace --minify-syntax
   keeps every name and only strips comments/whitespace and folds constants.
   The window.__nxTag_* / NX_BUILD_TAG string literals survive untouched, so
   the R81 build-tag handshake still works on the served files.

   THE HARNESS IS UNAFFECTED: smoke.js and tests/ serve the REPO tree on 8099
   and compare served bytes to disk — both sides are source, so §A of
   r81_platform still holds in the sandbox. For LIVE verification compare the
   served file's SHA-256 against `node build.js --hash` (prints the expected
   hash of each built admin file without writing dist/).

   USAGE:  node build.js            # writes dist/
           node build.js --hash     # prints sha256 of the built admin files
   ============================================================================= */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const esbuild = require("esbuild");

const ROOT = __dirname;
const OUT = path.join(ROOT, "dist");
const HASH_ONLY = process.argv.includes("--hash");

// Never shipped: the harness, versioned sources that deploy elsewhere, docs, secrets — and
// middleware.js / vercel.json, which Vercel reads from the PROJECT ROOT (a copy in dist/ would
// be served as a static file and expose the gate credential hash).
const SKIP_DIRS = new Set(["dist", "node_modules", ".git", ".vercel", ".claude", "tests", "shots", "edge", "db", "adv", "_to_delete", "compliance", "Claude outputs"]);
const SKIP_FILES = new Set(["build.js", "package.json", "package-lock.json", "smoke.js", "middleware.js", "vercel.json", "deploy.bat", "vercel_out.txt", "_push-log.txt", ".vercelignore", ".gitignore", "admin/mock.html", "admin/mock-supabase.js"]);
const SKIP_EXT = new Set([".md", ".pdf", ".docx", ".bat", ".log", ".zip"]);

// Served admin assets that get minified (path → esbuild loader).
const MINIFY = {
  "admin/core.js": "js",
  "admin/reports-money.js": "js",
  "admin/app.js": "js",
  "admin/admin.css": "css",
  "style.css": "css",
  "enhance.js": "js",
};

function minify(rel, src) {
  const loader = MINIFY[rel];
  const r = esbuild.transformSync(src, {
    loader,
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,          // shared global scope across classic scripts — never rename
    target: "es2020",
    charset: "utf8",
    legalComments: "none",
    logLevel: "error",
  });
  return r.code;
}

function walk(dir, rel = "") {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const r = rel ? rel + "/" + name : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) out.push(...walk(abs, r)); continue; }
    if (SKIP_FILES.has(r) || SKIP_EXT.has(path.extname(name).toLowerCase())) continue;
    if (name.startsWith(".") && name !== ".well-known") continue;
    out.push(r);
  }
  return out;
}

function sha(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

if (HASH_ONLY) {
  for (const rel of Object.keys(MINIFY)) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    console.log(sha(Buffer.from(minify(rel, src), "utf8")) + "  " + rel);
  }
  process.exit(0);
}

fs.rmSync(OUT, { recursive: true, force: true });
let nFiles = 0, before = 0, after = 0;
for (const rel of walk(ROOT)) {
  const src = path.join(ROOT, rel), dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (MINIFY[rel]) {
    const text = fs.readFileSync(src, "utf8");
    const code = minify(rel, text);
    fs.writeFileSync(dst, code);
    before += Buffer.byteLength(text); after += Buffer.byteLength(code);
    console.log(`minified ${rel}: ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB → ${(Buffer.byteLength(code) / 1024).toFixed(0)} KB`);
  } else {
    fs.copyFileSync(src, dst);
  }
  nFiles++;
}
console.log(`build: ${nFiles} files → dist/ · minified ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`);
