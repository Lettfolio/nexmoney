/* R94 · B — ESLint flat config. `npm run lint` must report ZERO problems (CI runs it).
 *
 * THE LOAD-ORDER PROBLEM. The back office is seven CLASSIC scripts sharing one global scope,
 * loaded in ORDER (below). Their shared globals are DERIVED HERE AT LINT TIME by parsing the
 * seven files (top-level function/const/let/var/class + every `window.X =` assignment), so the
 * list cannot go stale. Two local rules enforce what no-undef cannot:
 *   nx/load-order — a reference evaluated at DEFINITION time (top level, or inside a top-level
 *     IIFE; `typeof X` is exempt) to a name that only a LATER script declares; and a top-level
 *     name declared by two scripts (a duplicate const/let kills the second script outright).
 *     GAP: transitive calls are not followed — a top-level call to a same-file function that
 *     itself touches a later global is not caught; neither is a call via a callback that runs
 *     synchronously (e.g. top-level arr.forEach(fn)).
 *   nx/shared-use — marks a top-level name as used when another script, admin/index.html, or
 *     an HTML string in the same file (onclick="fn()") names it, so no-unused-vars reports
 *     only names nobody can reach.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const espree = require("espree");
const globals = require("globals");

const ORDER = ["core.js", "reports-money.js", "diary.js", "import.js", "vault.js", "site.js", "app.js"];
const ADMIN = path.join(__dirname, "admin");
const PARSE = { ecmaVersion: 2022, sourceType: "script", tokens: true, range: false };

function patternNames(p, out) {
  if (!p) return out;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "ObjectPattern") p.properties.forEach((q) => patternNames(q.type === "RestElement" ? q.argument : q.value, out));
  else if (p.type === "ArrayPattern") p.elements.forEach((q) => patternNames(q, out));
  else if (p.type === "RestElement") patternNames(p.argument, out);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
  return out;
}
function walkAst(node, fn) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walkAst(c, fn));
    else if (v && typeof v.type === "string" && k !== "parent") walkAst(v, fn);
  }
}
const WORD = /[A-Za-z_$][\w$]*/g;
function stringWords(tokens, into) {
  for (const t of tokens) if (t.type === "String" || t.type === "Template") for (const w of t.value.match(WORD) || []) into.add(w);
}

// Per script: declared top-level names, window.X names, and every identifier/string word it uses.
const SCRIPTS = ORDER.map((f) => {
  const ast = espree.parse(fs.readFileSync(path.join(ADMIN, f), "utf8"), PARSE);
  const decl = [];
  for (const s of ast.body) {
    if (s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") decl.push(s.id.name);
    else if (s.type === "VariableDeclaration") s.declarations.forEach((d) => patternNames(d.id, decl));
  }
  const win = new Set(), idents = new Set(), strs = new Set();
  walkAst(ast, (n) => {
    if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression" && !n.left.computed &&
        n.left.object.type === "Identifier" && n.left.object.name === "window") win.add(n.left.property.name);
    if (n.type === "Identifier") idents.add(n.name);
  });
  stringWords(ast.tokens, strs);
  return { file: f, decl, defined: new Set([...decl, ...win]), idents, strs };
});
const INDEX_WORDS = new Set(fs.readFileSync(path.join(ADMIN, "index.html"), "utf8").match(WORD) || []);
const ALL_SHARED = {};
SCRIPTS.forEach((s) => s.defined.forEach((n) => { ALL_SHARED[n] = "readonly"; }));
// Writable where some script assigns it bare at top level is irrelevant: these are declarations, and
// reassigning a const is a parse error long before lint.

const nxPlugin = {
  rules: {
    "load-order": {
      meta: { type: "problem", schema: [] },
      create(context) {
        const f = path.basename(context.filename);
        const i = ORDER.indexOf(f);
        if (i < 0) return {};
        const earlierOrSelf = new Set();
        SCRIPTS.slice(0, i + 1).forEach((s) => s.defined.forEach((n) => earlierOrSelf.add(n)));
        const laterOnly = new Map();
        SCRIPTS.slice(i + 1).forEach((s) => s.defined.forEach((n) => { if (!earlierOrSelf.has(n) && !laterOnly.has(n)) laterOnly.set(n, s.file); }));
        const earlierDecl = new Map();
        SCRIPTS.slice(0, i).forEach((s) => s.decl.forEach((n) => earlierDecl.set(n, s.file)));
        const isIife = (fnNode) => fnNode.parent && fnNode.parent.type === "CallExpression" && fnNode.parent.callee === fnNode;
        function definitionTime(scope) {
          for (let sc = scope; sc && sc.type !== "global"; sc = sc.upper) {
            if (sc.type === "function" && !isIife(sc.block)) return false;
            if (sc.type === "class-field-initializer" || sc.type === "class-static-block") return false;
          }
          return true;
        }
        return {
          "Program:exit"(node) {
            const gs = context.sourceCode.getScope(node);
            for (const s of node.body) {
              const names = s.type === "VariableDeclaration" ? s.declarations.flatMap((d) => patternNames(d.id, [])) :
                (s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") ? [s.id.name] : [];
              for (const n of names) if (earlierDecl.has(n)) context.report({ node: s, message: `'${n}' is already declared at top level by ${earlierDecl.get(n)} (shared global scope).` });
            }
            const seen = new Set();
            const visit = (sc) => {
              for (const ref of sc.references) {
                const name = ref.identifier.name;
                if (!laterOnly.has(name) || seen.has(ref.identifier)) continue;
                if (ref.resolved && ref.resolved.defs.length) continue;           // a local shadows it
                const p = ref.identifier.parent;
                if (p && p.type === "UnaryExpression" && p.operator === "typeof") continue;
                if (!definitionTime(ref.from)) continue;
                seen.add(ref.identifier);
                context.report({ node: ref.identifier, message: `'${name}' is defined only in the later script ${laterOnly.get(name)}; ${f} evaluates it at definition time.` });
              }
              sc.childScopes.forEach(visit);
            };
            visit(gs);
          },
        };
      },
    },
    "shared-use": {
      meta: { type: "suggestion", schema: [] },
      create(context) {
        const f = path.basename(context.filename);
        const me = SCRIPTS.find((s) => s.file === f);
        if (!me) return {};
        return {
          Program(node) {
            const used = new Set([...INDEX_WORDS, ...me.strs]);
            SCRIPTS.forEach((s) => { if (s !== me) { s.idents.forEach((n) => used.add(n)); s.strs.forEach((n) => used.add(n)); } });
            for (const n of me.decl) if (used.has(n)) context.sourceCode.markVariableAsUsed(n, node);
          },
        };
      },
    },
  },
};

const CORE_RULES = {
  "no-undef": "error",
  "no-redeclare": "error",
  "no-dupe-keys": "error",
  "no-unreachable": "error",
  "no-unused-vars": ["error", { vars: "all", args: "none", caughtErrors: "none" }],
  "no-implicit-globals": "off",
  eqeqeq: "off",
};

module.exports = [
  { ignores: ["admin/mock-supabase.js", "admin/mock.html", "dist/**", "tests/**", "node_modules/**", "docs/**", "supabase/**", "edge/**"] },
  { files: ["**/*.js"], linterOptions: { reportUnusedDisableDirectives: "error" }, rules: CORE_RULES },
  { files: ["admin/introducer.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.browser, supabase: "readonly" } } },   // R95 · E: the introducer portal's own script, not one of the seven
  // One block per script: its globals are every shared name EXCEPT its own declarations
  // (otherwise no-redeclare reads each declaration as shadowing a configured global).
  ...SCRIPTS.map((s) => {
    const g = { ...globals.browser, ...ALL_SHARED, supabase: "readonly", XLSX: "readonly" };
    s.decl.forEach((n) => { delete g[n]; });
    return { files: ["admin/" + s.file], plugins: { nx: nxPlugin }, languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: g }, rules: { "nx/load-order": "error", "nx/shared-use": "error" } };
  }),
  { files: ["admin/sw.js", "admin/sw-kill.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.serviceworker } } },
  { files: ["enhance.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.browser } } },
  { files: ["build.js", "smoke.js", "eslint.config.js", "db/*.js"], languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: { ...globals.node } } },
  // smoke.js and the drift check drive Playwright: their page.evaluate(() => …) callbacks run IN the page.
  { files: ["smoke.js", "db/check-schema-drift.js"], languageOptions: { globals: { window: "readonly", document: "readonly" } } },
];
