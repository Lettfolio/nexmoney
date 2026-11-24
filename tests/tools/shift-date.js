/* R133 — run a suite as if today were another day, to catch tests that only pass on some dates.
   The mock seeds its appointments relative to "today", so a test that books or clicks a fixed day or hour can
   land on one of them: r76_case §F (19 Nov 2026), r75_diary B3 (24 Nov), r12a D11 and r12b B5 (26–28 Nov).

     NX_DAYS=3 node -r ./tests/tools/shift-date.js tests/r12a.js      # as if three days from now

   It shifts `new Date()` and `Date.now()` in Node and in every page the suite opens. Timers are not shifted.
   Not part of the battery (tests/run-battery.sh only runs tests/*.js). */
const OFF = (+process.env.NX_DAYS || 0) * 86400000;
const code = `(() => { const OFF=${OFF}; const D = Date; class SD extends D { constructor(...a) { if (a.length === 0) super(D.now() + OFF); else super(...a); } static now() { return D.now() + OFF; } } globalThis.Date = SD; })();`;
(0, eval)(code);
const pw = require("playwright");
const launch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = async (...a) => {
  const b = await launch(...a);
  const nc = b.newContext.bind(b);
  b.newContext = async (...x) => { const c = await nc(...x); await c.addInitScript(code); return c; };
  b.newPage = async (...x) => { const c = await b.newContext(...x); return c.newPage(); };
  return b;
};
