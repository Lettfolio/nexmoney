# NexMoney Red Team — Final State (2026-07-16)

Multi-agent red team review: round 1 complete (find → adversarial verify → fix), round 2 find pass complete, then stopped at Daniel's request to ship. All round-1 confirmed issues FIXED and verified (Playwright renders at 360/390/1440px: no horizontal overflow on any page, no JS errors, all JSON-LD valid, vercel.json/JS parse clean).

## Fixed (round 1 + two round-2 quick wins)

- **Mobile clipping (inline grids → responsive classes):** index.html Local Area Coverage (the reported issue — now 1-col on phones, 3-col desktop, all cards visible), services.html both 2-col grids, mortgages.html 4-step process grid, faq.html bottom CTA.
- **Sticky header never stuck sitewide** — pre-existing `overflow-x:hidden` on html/body disabled `position:sticky`; changed to `overflow-x:clip` (keeps overflow protection, restores stickiness). Verified sticking at 390px.
- **Contact form select rendered a tiled chevron pattern** (dark-layer `background:` shorthand reset repeat) — now single chevron, right-aligned.
- **Contact form silent lead loss** — submitForm() showed success even on HTTP/network failure; now checks res.ok, keeps form + shows error on failure.
- **Admin password-reset redirect** pointed at wrong domain (nexmoney.vercel.app); now derived from window.location.origin at runtime.
- **FAQ stamp duty answer outdated** (£425k FTB threshold expired Mar 2025) → current £300k/£500k rules, fixed in visible copy AND FAQPage JSON-LD.
- **Contrast:** primary CTA/white-on-orange addressed, local-area card headings/links darkened, calculators disclaimer, footer legal text bumped; misc.
- **A11y:** calculator inputs got for= labels; skip-link + <main id> on index.html; contact.html heading hierarchy fixed; marquee/testimonial rotation got a 44px pause control (enhance.js); 'Call us free' → 'Call us' (FAB).
- **Security/infra (vercel.json):** HSTS, X-Content-Type-Options, X-Frame-Options/frame-ancestors, Referrer-Policy, Permissions-Policy added; /admin,/portal,/clienthub noindex now matches clean URLs; style.css/enhance.js cache policy; robots.txt no-trailing-slash disallows.
- **Perf:** reveal blur 10px→4px + will-change released after reveal; testimonials.html missing preconnect added.
- **SEO:** mortgages.html title trimmed to 47 chars; remortgage landing FAQPage schema/visible-question mismatch fixed; faq.html nav order aligned.

## Outstanding — round 2 findings, NOT yet verified or fixed (21)

Round 2 was stopped before verification. These are finder reports (some may not survive adversarial verification):

- **[high] index.html** — Inline color:var(--muted) (#666) body text on dark backgrounds fails AA (2.91-3.43:1) on 9 pages - round-1 fix covered only calculators.html
  - fix: Repeat the calculators.html round-1 fix on the remaining pages: change inline color:var(--muted) to color:var(--dim) for every instance that renders on a dark surface (index 425/712/749, mortgages 153-156/276-291, servic
- **[medium] about.html** — REGRESSION: Skip-to-content link was added only to index.html — the other 12 public pages still have none
  - fix: Add the same skip link immediately after <body> and wrap page content in <main id="main"> on all 12 remaining public pages (the CSS is already in place).
- **[medium] index.html** — REGRESSION: Homepage hero calculator still claims and computes 4.5x-5.5x income while the rest of the site now says 4-4.5x (4x-5.5x on /calculators)
  - fix: Change line 453 to 'Based on 4× – 5.5× income' and line 949 to total * 4, matching calculators.html.
- **[medium] first-time-buyer-mortgages-bournemouth.html** — REGRESSION: FAQPage schema question still does not match the visible question on the first-time-buyer landing page
  - fix: Change the visible summary at line 208 to 'How long does a first-time buyer mortgage take?' (or make the schema name match the on-page wording).
- **[medium] index.html** — Homepage hero calculator inputs have no programmatic labels (same defect fixed on calculators.html)
  - fix: Add for="income1", for="income2", for="loanAmount", for="interestRate", for="loanTerm" to the corresponding labels, as was done on calculators.html.
- **[medium] mortgages.html** — REGRESSION: Skip-to-content link was added only to index.html - still missing on the other 12 public pages
  - fix: Add the same two-line pattern used on index.html to each remaining page: <a class="skip-link" href="#main">Skip to content</a> immediately after <body> (mortgages.html:84, faq.html:193, etc.) and wrap page content in <ma
- **[medium] faq.html** — FAQ 'Areas We Serve' navy strip: orange links are 3.08:1 on navy and distinguishable from adjacent non-link text by colour alone
  - fix: Remove text-decoration:none from the three anchors (letting the sitewide underline rule apply) and lighten the link colour to pass 4.5:1 on #00488c - e.g. #ffb380 (7.0:1) or white with underline; keep font-weight:700.
- **[medium] about.html** — 'Refer a Friend' button on about.html: orange 16px bold text on white is 2.95:1, failing AA
  - fix: Change the inline colour to the same accessible orange used for the index fix: color:#c14d0e (4.84:1 on white), or use the navy #00488c (9.1:1).
- **[medium] index.html** — Hero background video autoplays and loops with no pause mechanism (WCAG 2.2.2)
  - fix: Reuse the exact pattern enhance.js already ships for the marquee: inject a 36px aria-pressed pause/play button over .hero-media that calls video.pause()/video.play(), skipped when prefers-reduced-motion is set (video is 
- **[low] faq.html** — Header navigation order differs on FAQ page: Contact listed before FAQs, opposite of all 12 other pages
  - fix: In faq.html, reorder the nav anchors to match the sitewide order: <a href="/faq" class="active">FAQs</a> before <a href="/contact">Contact</a>.
- **[low] services.html** — Topbar on services, calculators and testimonials pages omits the 'Bournemouth based · National coverage' segment shown on the other 10 pages
  - fix: Add the missing '<span class="topbar-sep">|</span><span>Bournemouth based · National coverage</span>' (matching the markup used on index.html and the other pages) to the .topbar-left block in services.html, calculators.h
- **[low] calculators.html** — REGRESSION: Topbar 'Bournemouth based · National coverage' segment still missing on calculators and testimonials pages
  - fix: Add '<span>|</span><span>Bournemouth based · National coverage</span>' inside .topbar-left on calculators.html (after line 87) and testimonials.html (after line 60), matching services.html.
- **[low] calculators.html** — REGRESSION: Heading level skips remain on calculators (h1 to h3) and FAQ/testimonials (h2 to h4)
  - fix: Promote the four calculator-card h3s to h2 (or add an intervening h2), and either promote the footer column h4s to h3 sitewide or replace them with non-heading markup.
- **[low] index.html** — Homepage borrowing calculator still accepts typed negative income and prints negative borrowing estimates
  - fix: Clamp as on calculators.html: const i1 = Math.max(0, parseFloat(document.getElementById('income1').value) || 0); same for i2 (and loan/rate/term in calcRepay).
- **[low] faq.html** — REGRESSION: 10 of the 11 over-length page titles were left unchanged (62-73 chars, will truncate in SERPs)
  - fix: Trim each title to <=60 chars, e.g. faq.html 'Mortgage FAQs Answered | NexMoney Bournemouth', index.html 'Mortgage Broker Bournemouth | NexMoney', dropping the third pipe segment on the others.
- **[low] index.html** — Homepage hero card still claims 'Call us free' for the chargeable geographic 01202 number — same defect fixed on the FAB in round 1 remains here
  - fix: Change the label at index.html:284 to 'Prefer to talk? Call us' or 'Prefer to talk? Free, no-obligation advice' so the free claim attaches to the advice, not the call — matching the round-1 FAB fix.
- **[low] vercel.json** — New /assets/* rule serves non-fingerprinted hero video and poster with a 1-year immutable cache
  - fix: Either rename assets on change (e.g. hero-loop-v2.mp4) and keep immutable, or align the rule with the site-asset policy used two lines below: 'public, max-age=86400, stale-while-revalidate=604800' for /assets/(.*).
- **[low] calculators.html** — REGRESSION: Heading-level skips fixed only on contact.html - calculators still jumps h1 to h3; faq, testimonials and calculators still jump h2 to h4
  - fix: On calculators.html change the four .full-calc-card h3 headings to h2 (they are direct children of the page h1). For the footer columns, either change the four footer-col h4s to h2 with the existing visual size preserved
- **[low] calculators.html** — Calculator results update silently - no aria-live region, so screen reader users get no feedback after changing inputs (WCAG 4.1.3)
  - fix: Add role="status" (implicit aria-live=polite) to each result value container: the four .calc-output divs on calculators.html and the two .calc-result divs on index.html - no JS changes needed.

Biggest themes in the outstanding list: skip-links + contrast + heading fixes need rolling out to the other 12 pages (round 1 scoped them to one file each); homepage mini-calculator needs the same label/clamp/multiplier fixes applied to calculators.html; hero video needs a WCAG pause control; page titles on 10 pages still >60 chars; FTB landing page schema mismatch; aria-live on calculator results.

## Rejected false positives (do not re-report)

6 'missing asset' findings — sandbox staging artefact, files exist on the real site.
