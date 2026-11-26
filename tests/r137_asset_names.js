/* R137 — every served public page links style.css and enhance.js by a name that carries their content, so a page
   and the stylesheet it was built with cannot be separated by a day-long cache (what R136 ran into). Offline:
   the build runs against a content fixture, so a content override and a guide page are covered too. */
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { spawnSync } = require("child_process");
const REPO = "/root/nx";
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " — " + d : "")); } };
const sha8 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 8);
const FIXTURE = { site_pages: [{ slug: "mortgages", title: "R137 Override | NexMoney", meta_description: "R137", og_title: null, og_description: null, og_image: null, h1: "R137", faq: [], updated_at: "2026-11-01T00:00:00Z" }],
  site_posts: [{ id: "a1", slug: "r137-guide", title: "R137 guide", excerpt: "x", body_md: "# H\n\ntext", cover_image: null, status: "published", published_at: "2026-11-01T00:00:00Z", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" }] };
const fx = path.join(os.tmpdir(), `r137_fixture_${process.pid}.json`);
fs.writeFileSync(fx, JSON.stringify(FIXTURE));
const b = spawnSync("node", ["build.js"], { cwd: REPO, encoding: "utf8", env: { ...process.env, NX_CONTENT_FIXTURE: fx } });
ok("A1 · build exits 0 and says how many links it named", b.status === 0 && /build: \d+ style\.css \/ enhance\.js link\(s\) on \d+ page\(s\) named by content/.test(b.stdout), (b.stderr || "") + b.stdout.split("\n").slice(-3).join(" | "));
const dist = path.join(REPO, "dist");
const css = sha8(path.join(dist, "style.css")), js = sha8(path.join(dist, "enhance.js"));
const pages = []; const visit = (d) => fs.readdirSync(d).forEach((n) => { const a = path.join(d, n); if (fs.statSync(a).isDirectory()) { if (!(d === dist && n === "admin")) visit(a); } else if (n.endsWith(".html")) pages.push(a); }); visit(dist);
const refs = pages.map((p) => ({ p: path.relative(dist, p), html: fs.readFileSync(p, "utf8") })).map((x) => ({ p: x.p, all: x.html.match(/\b(?:href|src)="\/?(?:style\.css|enhance\.js)[^"]*"/g) || [] }));
const using = refs.filter((r) => r.all.length);
ok("A2 · the public pages that use the stylesheet are all there (17 or more, incl. the guide and the overridden page)", using.length >= 17 && using.some((r) => /guides[\\/]r137-guide\.html$/.test(r.p)) && using.some((r) => r.p === "mortgages.html"), using.length + " pages: " + using.map((r) => r.p).join(", ").slice(0, 300));
const bare = using.filter((r) => r.all.some((t) => /(style\.css|enhance\.js)"$/.test(t)));
ok("A3 · no page links either file by its bare name", bare.length === 0, bare.map((r) => r.p).join(", "));
const wrong = using.filter((r) => r.all.some((t) => !(t.endsWith(`style.css?v=${css}"`) || t.endsWith(`enhance.js?v=${js}"`))));
ok("A4 · every link carries the first 8 of the SERVED file's sha256", wrong.length === 0, JSON.stringify(wrong.slice(0, 2)));
const admin = fs.readFileSync(path.join(dist, "admin/index.html"), "utf8");
ok("A5 · the back office is untouched (its files revalidate on every load)", !/\?v=/.test(admin.match(/<link rel="stylesheet"[^>]*>/)[0]) && fs.readFileSync(path.join(REPO, "admin/index.html"), "utf8") === admin);
const v = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8"));
const rule = v.headers.find((h) => /style\\\.css\|enhance\\\.js/.test(h.source));
ok("A6 · the day-long cache rule still names both files (a query string does not change the path it matches)", !!rule && /max-age=86400/.test(rule.headers[0].value), rule && rule.source);
ok("A7 · the repo's own pages are unchanged — the name is added at build", fs.readdirSync(REPO).filter((f) => f.endsWith(".html")).every((f) => !/(style\.css|enhance\.js)\?v=/.test(fs.readFileSync(path.join(REPO, f), "utf8"))));
/* A changed stylesheet gets a new name: build a copy of the repo with one byte added to style.css. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r137_"));
for (const n of fs.readdirSync(REPO)) { if (["dist", "node_modules", ".git", "tests", "shots", "db", "edge", "docs", "supabase", ".github"].includes(n)) continue; fs.cpSync(path.join(REPO, n), path.join(tmp, n), { recursive: true }); }
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"));
fs.appendFileSync(path.join(tmp, "style.css"), "\n.r137-probe { color: red; }\n");
const b2 = spawnSync("node", ["build.js"], { cwd: tmp, encoding: "utf8", env: { ...process.env, NX_CONTENT_FIXTURE: fx } });
const css2 = b2.status === 0 ? sha8(path.join(tmp, "dist/style.css")) : null, home2 = b2.status === 0 ? fs.readFileSync(path.join(tmp, "dist/index.html"), "utf8") : "";
ok("A8 · change the stylesheet and its name changes; enhance.js, unchanged, keeps its name", !!css2 && css2 !== css && home2.includes(`style.css?v=${css2}"`) && home2.includes(`enhance.js?v=${js}"`), (b2.stderr || "").slice(0, 200) + " " + css + " → " + css2);
fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(fx, { force: true });
console.log("\nR137: " + pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
