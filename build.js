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
   reports-money.js, diary.js, import.js, vault.js (R90 · F) and app.js are
   CLASSIC scripts sharing one global scope (see HARNESS.md "R78 · A"). Renaming
   top-level identifiers in one file would break the others; esbuild's --minify-whitespace --minify-syntax
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

   R93 · A — BUILD-TIME CONTENT (full build only; --hash never touches the network):
   after the copy, site_pages + published site_posts are read from Supabase REST with
   the public anon key (taken from admin/app.js's SUPABASE_KEY line, not duplicated
   here), 8 s timeout. site_pages rows override <title>, description, og and twitter tags,
   the first <h1> and add FAQ markup (<!-- nx:faq --> + FAQPage JSON-LD) on the root
   page they name ("" = index.html). Published posts render through guides.template.html
   + marked (raw HTML in Markdown is escaped, then an allow-list pass) into
   dist/guides/<slug>.html and the dist/guides.html index; dist/sitemap.xml gains /guides
   and one <url> per post. FAIL-CLOSED (R93 · fixer): the content read is tried 3 times
   (1 s, 2 s backoff); if it still fails — or rendering fails — the build prints ONE line
   and exits 1, so Vercel keeps the previous deploy live. Building from an empty set
   instead would silently un-publish every guide and 404 indexed URLs.
   NX_CONTENT_OPTIONAL=1 opts out: the repo HTML ships unchanged, dist/sitemap.xml is the
   repo's verbatim, and NO guides pages are written (e.g. before db/r93/01 is applied).
   OFFLINE/TEST HOOK:  NX_CONTENT_FIXTURE=<file.json> node build.js
       reads { "site_pages": [...], "site_posts": [...] } from that file instead of the
       network (tests/r93_data.js uses it).
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
const SKIP_DIRS = new Set(["dist", "node_modules", ".git", ".vercel", ".claude", "tests", "shots", "edge", "db", "adv", "_to_delete", "compliance", "Claude outputs", "docs", "supabase", ".github"]);
const SKIP_FILES = new Set(["build.js", "package.json", "package-lock.json", "smoke.js", "middleware.js", "vercel.json", "deploy.bat", "vercel_out.txt", "_push-log.txt", ".vercelignore", ".gitignore", "admin/mock.html", "admin/mock-supabase.js", "guides.template.html", "eslint.config.js", "jsconfig.json"]);
const SKIP_EXT = new Set([".md", ".pdf", ".docx", ".bat", ".log", ".zip"]);

// Served admin assets that get minified (path → esbuild loader).
const MINIFY = {
  "admin/core.js": "js",
  "admin/reports-money.js": "js",
  "admin/diary.js": "js",          // R90 · F — the third carve: diary.js / import.js / vault.js
  "admin/import.js": "js",
  "admin/vault.js": "js",
  "admin/site.js": "js",           // R93 · F — Website (content + SEO) page
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
    if (/^tsconfig.*\.json$/.test(name)) continue;   // R94 · B2: editor/type-check config, never served
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

/* =============================================================================
   R93 · A — build-time content (see the header). Fail-closed unless NX_CONTENT_OPTIONAL=1.
   ============================================================================= */
const SITE = "https://www.nexmoney.co.uk";
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PAGE_COLS = "slug,title,meta_description,og_title,og_description,og_image,h1,faq,updated_at";
const POST_COLS = "id,slug,title,excerpt,body_md,cover_image,status,published_at,created_at,updated_at";

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// JSON inside <script>: no "</script>", no HTML-significant characters, no JS line separators.
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function ldScript(obj) { return `<script type="application/ld+json">${jsonForScript(obj)}</script>`; }
function nonEmpty(v) { return typeof v === "string" && v.trim() !== ""; }

// R94 · B1: env first (CI / Vercel can supply them), app.js regex as the fallback. Logs the source, never the key.
let credsLogged = false;
function credsSource(src) { if (!credsLogged) { credsLogged = true; console.log("build: Supabase credentials from " + src); } }
function supabaseCreds() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    credsSource("process.env");
    return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };
  }
  const app = fs.readFileSync(path.join(ROOT, "admin", "app.js"), "utf8").split("\n").slice(0, 10).join("\n");
  const url = /SUPABASE_URL\s*=\s*["']([^"']+)["']/.exec(app);
  const key = /SUPABASE_KEY\s*=\s*["']([^"']+)["']/.exec(app);
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_KEY not found in admin/app.js");
  credsSource("admin/app.js");
  return { url: url[1], key: key[1] };
}

async function loadContent() {
  if (process.env.NX_CONTENT_FIXTURE) {
    const j = JSON.parse(fs.readFileSync(process.env.NX_CONTENT_FIXTURE, "utf8"));
    return { pages: j.site_pages || [], posts: j.site_posts || [], source: "fixture" };
  }
  const { url, key } = supabaseCreds();
  const signal = AbortSignal.timeout(8000);
  const get = async (q) => {
    const r = await fetch(`${url}/rest/v1/${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, signal });
    if (!r.ok) throw new Error(`${q.split("?")[0]} HTTP ${r.status}`);
    return r.json();
  };
  const [pages, posts] = await Promise.all([
    get(`site_pages?select=${PAGE_COLS}`),
    get(`site_posts?select=${POST_COLS}&status=eq.published&order=published_at.desc.nullslast`),
  ]);
  return { pages, posts, source: "supabase" };
}

/* ---------- page overrides */
function setMeta(html, attr, key, value) {
  const tag = `<meta ${attr}="${key}" content="${esc(value)}">`;
  const re = new RegExp(`<meta\\b[^>]*\\b(?:name|property)\\s*=\\s*["']${key.replace(/[.:]/g, "\\$&")}["'][^>]*>`, "i");
  if (re.test(html)) return html.replace(re, () => tag);
  return html.replace(/<\/head>/i, () => `  ${tag}\n</head>`);
}
function faqItems(faq) {
  return (Array.isArray(faq) ? faq : []).filter((x) => x && nonEmpty(x.q) && nonEmpty(x.a)).map((x) => ({ q: x.q.trim(), a: x.a.trim() }));
}
function applyPageRow(html, row) {
  if (nonEmpty(row.title)) html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => `<title>${esc(row.title.trim())}</title>`);
  if (nonEmpty(row.meta_description)) html = setMeta(html, "name", "description", row.meta_description.trim());
  if (nonEmpty(row.og_title)) { html = setMeta(html, "property", "og:title", row.og_title.trim()); html = setMeta(html, "name", "twitter:title", row.og_title.trim()); }
  if (nonEmpty(row.og_description)) { html = setMeta(html, "property", "og:description", row.og_description.trim()); html = setMeta(html, "name", "twitter:description", row.og_description.trim()); }
  if (nonEmpty(row.og_image) && /^https:\/\//i.test(row.og_image.trim())) { html = setMeta(html, "property", "og:image", row.og_image.trim()); html = setMeta(html, "name", "twitter:image", row.og_image.trim()); }
  if (nonEmpty(row.h1)) html = html.replace(/<h1(\b[^>]*)>[\s\S]*?<\/h1>/i, (_, a) => `<h1${a}>${esc(row.h1.trim())}</h1>`);
  const faq = faqItems(row.faq);
  if (faq.length) {
    if (html.includes("<!-- nx:faq -->")) {
      const items = faq.map((x) => `<details class="faq-item"><summary class="faq-question">${esc(x.q)}</summary><p class="faq-answer">${esc(x.a).replace(/\n/g, "<br>")}</p></details>`).join("\n");
      html = html.replace("<!-- nx:faq -->", () => `<section class="faq"><div class="container"><div class="faq-list">\n${items}\n</div></div></section>`);
    }
    // A page that already carries its own FAQPage (faq.html) keeps it: two FAQPage blocks on one URL is a Search Console error.
    if (!/"@type"\s*:\s*"FAQPage"/.test(html)) {
      const ld = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })) };
      html = html.replace(/<\/head>/i, () => `${ldScript(ld)}\n</head>`);
    }
  }
  return html;
}

/* ---------- guides: Markdown → allow-listed HTML */
function safeHref(href, imageOnly) {
  const h = String(href || "").trim();
  if (/^https:\/\//i.test(h)) return h;
  if (!imageOnly && /^mailto:[^\s<>"]+$/i.test(h)) return h;
  if (/^\/(?!\/)/.test(h) || (!imageOnly && /^#/.test(h))) return h;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith("//") && h !== "") return h;   // plain relative
  return null;
}
const ALLOWED_TAGS = { h2: [], h3: [], h4: [], p: [], strong: [], em: [], del: [], a: ["href", "rel"], ul: [], ol: ["start"], li: [], blockquote: [], code: [], pre: [], hr: [], br: [], img: ["src", "alt", "loading"], table: [], thead: [], tbody: [], tr: [], th: [], td: [] };
// Belt to marked's braces: every tag not on the list is dropped (its text stays, already escaped), every attribute not on the list goes.
function allowList(html) {
  return html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g, (m, close, name, rest) => {
    const t = name.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_TAGS, t)) return "";
    if (close) return `</${t}>`;
    const kept = [];
    const re = /([a-zA-Z-]+)\s*=\s*"([^"<>]*)"/g;
    let a;
    while ((a = re.exec(rest))) {
      const k = a[1].toLowerCase();
      if (!ALLOWED_TAGS[t].includes(k)) continue;
      if ((k === "href" || k === "src") && !safeHref(a[2].replace(/&amp;/g, "&"), k === "src")) continue;
      kept.push(`${k}="${a[2]}"`);
    }
    return `<${t}${kept.length ? " " + kept.join(" ") : ""}>`;
  });
}
function makeMarkdown() {
  const { Marked } = require("marked");
  const md = new Marked({ gfm: true, breaks: false, async: false });
  md.use({
    renderer: {
      html({ text }) { return esc(text); },   // no raw HTML from Markdown, ever
      heading({ tokens, depth }) { const d = Math.min(depth + 1, 4); return `<h${d}>${this.parser.parseInline(tokens)}</h${d}>\n`; },   // the page owns the only <h1>
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        const h = safeHref(href, false);
        if (!h) return text;
        return `<a href="${esc(h)}"${/^https:/i.test(h) && !/^https:\/\/(www\.)?nexmoney\.co\.uk/i.test(h) ? ' rel="noopener"' : ""}>${text}</a>`;
      },
      image({ href, text }) {
        const h = safeHref(href, true);
        return h ? `<img src="${esc(h)}" alt="${esc(text)}" loading="lazy">` : esc(text);
      },
    },
  });
  return (src) => allowList(md.parse(String(src || "")));
}

function ymd(ts) { const d = new Date(ts); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
function longDate(ts) {
  const d = new Date(ts);
  return isNaN(d) ? "" : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}
function fillTemplate(tpl, vals, jsonld) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : ""))
    .replace("<!--NX:JSONLD-->", () => jsonld.map(ldScript).join("\n"));
}
const ORG = { "@type": "Organization", name: "NexMoney", url: SITE + "/", logo: { "@type": "ImageObject", url: SITE + "/apple-touch-icon.png" } };

function renderGuides(posts, tpl, render) {
  const out = {};
  for (const p of posts) {
    const url = `${SITE}/guides/${p.slug}`;
    const cover = nonEmpty(p.cover_image) && /^https:\/\//i.test(p.cover_image.trim()) ? p.cover_image.trim() : null;
    const excerpt = nonEmpty(p.excerpt) ? p.excerpt.trim() : "";
    const vals = {
      title: esc(p.title), excerpt: esc(excerpt), slug: esc(p.slug), path: esc(`guides/${p.slug}`),
      ogtype: "article", ogimage: esc(cover || `${SITE}/og-image.jpg`),
      published: p.published_at ? `Published ${esc(longDate(p.published_at))}` : "",
      cover: cover ? `<img class="guide-cover" src="${esc(cover)}" alt="${esc(p.title)}">` : "",
      crumbs: `<a href="/guides">Guides</a>\n      <span>/</span>\n      <span>${esc(p.title)}</span>`,
      body: render(p.body_md),
    };
    const article = {
      "@context": "https://schema.org", "@type": "Article", headline: p.title, description: excerpt || undefined,
      datePublished: p.published_at || p.created_at || undefined, dateModified: p.updated_at || p.published_at || undefined,
      image: cover || `${SITE}/og-image.jpg`, author: ORG, publisher: ORG, mainEntityOfPage: { "@type": "WebPage", "@id": url }, url,
    };
    const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name: "Guides", item: `${SITE}/guides` },
      { "@type": "ListItem", position: 3, name: p.title, item: url }] };
    out[`guides/${p.slug}.html`] = fillTemplate(tpl, vals, [article, crumbs]);
  }
  const cards = posts.map((p) => `<a class="guide-card" href="/guides/${esc(p.slug)}"><h2>${esc(p.title)}</h2>${nonEmpty(p.excerpt) ? `<p>${esc(p.excerpt.trim())}</p>` : ""}${p.published_at ? `<span class="guide-meta">${esc(longDate(p.published_at))}</span>` : ""}</a>`);
  const indexVals = {
    title: "Mortgage Guides", excerpt: "Plain-English mortgage guides from NexMoney&#39;s advisers in Bournemouth.", slug: "", path: "guides",
    ogtype: "website", ogimage: esc(`${SITE}/og-image.jpg`), published: "", cover: "",
    crumbs: "<span>Guides</span>",
    body: cards.length ? `<div class="guide-list">\n${cards.join("\n")}\n</div>` : "<p>No guides yet.</p>",
  };
  const collection = { "@context": "https://schema.org", "@type": "CollectionPage", name: "Mortgage Guides", url: `${SITE}/guides`,
    mainEntity: { "@type": "ItemList", itemListElement: posts.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/guides/${p.slug}`, name: p.title })) } };
  out["guides.html"] = fillTemplate(tpl, indexVals, [collection]);
  return out;
}

function sitemapWithGuides(xml, posts) {
  const urls = [];
  const latest = posts.map((p) => ymd(p.updated_at || p.published_at)).filter(Boolean).sort().pop() || new Date().toISOString().slice(0, 10);
  if (!xml.includes(`<loc>${SITE}/guides</loc>`)) urls.push({ loc: `${SITE}/guides`, lastmod: latest });
  for (const p of posts) urls.push({ loc: `${SITE}/guides/${p.slug}`, lastmod: ymd(p.updated_at || p.published_at) || latest });
  const block = urls.map((u) => `  <url>\n    <loc>${esc(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>\n`).join("\n");
  return xml.replace(/<\/urlset>/i, () => `${block}\n</urlset>`);
}

// Pure: content in → { dist-relative path: text } out. Nothing is written until it all succeeded.
function renderContent(content) {
  const files = {};
  let overridden = 0;
  for (const row of content.pages || []) {
    if (!row || typeof row.slug !== "string" || (row.slug !== "" && !SLUG_RE.test(row.slug))) continue;
    const rel = row.slug === "" ? "index.html" : `${row.slug}.html`;
    const abs = path.join(OUT, rel);
    if (!fs.existsSync(abs)) continue;
    const html = files[rel] || fs.readFileSync(abs, "utf8");
    const next = applyPageRow(html, row);
    if (next !== html) { files[rel] = next; overridden++; }
  }
  const posts = (content.posts || []).filter((p) => p && p.status === "published" && typeof p.slug === "string" && SLUG_RE.test(p.slug) && nonEmpty(p.title));
  const tpl = fs.readFileSync(path.join(ROOT, "guides.template.html"), "utf8");
  Object.assign(files, renderGuides(posts, tpl, makeMarkdown()));
  const smPath = path.join(OUT, "sitemap.xml");
  if (fs.existsSync(smPath)) files["sitemap.xml"] = sitemapWithGuides(fs.readFileSync(smPath, "utf8"), posts);
  return { files, overridden, posts: posts.length };
}
function writeFiles(files) {
  for (const [rel, text] of Object.entries(files)) {
    const dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, text);
  }
}

const CONTENT_OPTIONAL = process.env.NX_CONTENT_OPTIONAL === "1";
const CONTENT_TRIES = 3;
const why = (e) => String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 200);
async function loadContentRetry() {
  let last;
  for (let i = 1; i <= CONTENT_TRIES; i++) {
    try { return await loadContent(); } catch (e) { last = e; }
    if (i < CONTENT_TRIES) await new Promise((r) => setTimeout(r, i * 1000));
  }
  throw last;
}
// The repo HTML and repo sitemap.xml are already in dist/ from the copy above; writing nothing leaves them as-is.
function contentFailed(what) {
  if (CONTENT_OPTIONAL) {
    console.log(`content: ${what} — NX_CONTENT_OPTIONAL=1: repo HTML + sitemap shipped unchanged, no guides pages`);
    return;
  }
  console.error(`build: ${what}; failing the build so the previous deploy stays live (set NX_CONTENT_OPTIONAL=1 to build without content)`);
  process.exit(1);
}

(async () => {
  let content;
  try { content = await loadContentRetry(); }
  catch (e) { return contentFailed(`content fetch failed after ${CONTENT_TRIES} tries — ${why(e)}`); }
  let result;
  try { result = renderContent(content); }
  catch (e) { return contentFailed(`content render failed — ${why(e)}`); }
  writeFiles(result.files);
  console.log(`content (${content.source}): ${result.overridden} page override(s), ${result.posts} guide(s)`);
})().catch((e) => contentFailed(`content step failed — ${why(e)}`));
