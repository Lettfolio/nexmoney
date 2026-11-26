# R136 — fonts and supabase-js served from this site (26 Nov 2026)

Item 5 of the performance review (`claude/performance-review-2026-11.md`). Daniel: "proceed".

**Before:** 17 public pages and the guides template linked a Google Fonts stylesheet (render-blocking, a second and third host); the back office and the introducer portal loaded `supabase.js` from jsDelivr — if jsDelivr could not be reached the back office did not start.

**Now**
- `admin/vendor/supabase-js-2.110.7.js` — the same bytes as the jsDelivr file (its sha384 equals the SRI hash R97 pinned; test A8d2 checks it). Both pages load it from here and keep the `integrity` attribute.
- `assets/fonts/` — Inter and Sora variable woff2 (latin + latin-ext) from `@fontsource-variable/inter` and `/sora` 5.3.0, SIL OFL 1.1, licence texts alongside. `@font-face` in `style.css` (Inter 400–700, Sora 600–800) and on the last line of `admin/admin.css` (Inter 400–800): the weight ranges are exactly the weights the Google requests asked for, so a 900 or a 300 in the sheets lands on the same face as before. `font-display: swap` as before. Each page preloads `inter-latin.woff2`.
- Google Fonts links removed from 18 HTML files and `admin/index.html`; `boot.js` loses the stylesheet swap it existed for.
- `vercel.json`: both policies now have `font-src 'self'` and `style-src 'self' 'unsafe-inline'`; the admin `script-src` is `'self'` plus the SheetJS path. Tighter than before on all three.
- `smoke.js` swaps the self-hosted tag for the mock; `eslint` ignores `admin/vendor/`.
- Tag r134 → r136.

**Tests re-based (same intent, new arrangement):** `r94_csp` A8d/A8e/A10/A16/A18/A18b (+ A8d2), `r82_correct` J1a–c, J1e.

**Not changed:** SheetJS still lazy-loads from its CDN on Import only. Lender favicons still come from Google's favicon service.

**To check on the preview before merge:** text widths against the live site (the faces should be the same design; Google may serve a different build of Inter).
**Upgrading supabase-js later:** replace the file, the two `src` attributes and the hash together.
