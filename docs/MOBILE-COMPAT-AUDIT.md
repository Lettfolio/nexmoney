# NexMoney — Mobile Compatibility Audit

**Date:** 15 July 2026
**Scope:** All 13 public HTML pages + shared `style.css` (1,441 lines) and `enhance.js`.
**Method:** Full static HTML/CSS/JS audit. A headless 375px render was attempted but not possible in this sandbox (Playwright's browser CDN is blocked by the network allowlist and there is no `sudo`/apt to install Chromium). Findings below are from source analysis and are reliable, but a couple of items (marked *verify on device*) would benefit from a real 360–390px render before/after any fix.

> **This is a review only — no files were changed.**

---

## 1. Overall verdict

The site is **fundamentally mobile-ready and better built than most**. Viewport tags are correct everywhere, images are globally responsive, there are no data tables, the hamburger menu works on every page without depending on `enhance.js`, the hero video is correctly hidden on phones, and almost every grid collapses to a single column at 768px. There is **one clear high-priority bug** (iOS zoom on the main contact form) and a handful of medium/low issues. Nothing here makes the site unusable on a phone; the fixes are small and targeted.

---

## 2. What works (no action needed)

- **Viewport meta** — present and correct (`width=device-width, initial-scale=1.0`) on all 13 pages.
- **Responsive images** — global `img { max-width: 100%; display: block; }` (style.css:26). No image can overflow the viewport.
- **No tables** — nothing wide to reflow anywhere in the site.
- **Mobile navigation** — `.nav-toggle` hamburger is on all 13 pages and toggles `nav.open` via an inline `onclick` (index.html:175), so it works even if `enhance.js` fails to load. At ≤768px the desktop `nav`, `.header-cta` and `.topbar` are hidden and the toggle appears; `nav.open` drops a full-width panel below the header (style.css:575–594).
- **Hero video handling** — `<video autoplay muted loop playsinline preload="metadata" poster="assets/hero-poster.jpg">` (index.html:185). `playsinline` + `muted` are correct for iOS autoplay. Crucially, `.hero-media video { display: none; }` at ≤640px (style.css:1439) means **phones never download/play the 447KB video** — they get the preloaded poster instead. Good performance behaviour.
- **Grid collapsing** — at 768px these all correctly go to one column: services, why, testimonials, contact, about, mortgage, footer, calc-wrapper, form-row, hero-inner; stats-grid → 2-col; process-grid → 2-col (style.css:575–594, 962–964).
- **Calculator inputs** — all `type="number"` (numeric keypad on mobile) and `.calc-input` is `font-size: 16px` (no iOS zoom). Calculators are single-column on mobile.
- **Tap targets** — buttons are ~46px tall (`.btn` padding 14px 28px). Fixed click-to-call FAB (`.fab-call`) collapses to icon-only on mobile — good.
- **Decorative overflow** — the large glow "orbs" (500/350/300/190px pseudo-elements) sit inside `overflow: hidden` parents, so they do **not** create horizontal scroll.

---

## 3. Issues by severity

### 🔴 HIGH

**H1 — Contact form triggers iOS zoom-on-focus (font-size 15px).**
- **Where:** `.form-group input, .form-group select, .form-group textarea { font-size: 15px; }` (style.css:519). Affects the main lead-capture form on **contact.html** and any page using `.form-group` fields.
- **Why it matters:** iOS Safari auto-zooms the page whenever a focused input has a font-size below 16px. On your primary conversion form this causes a jarring zoom/scroll on every field tap. The dark-theme override at style.css:1255 only changes colours, not the size, so it does not fix this.
- **Fix:** change `font-size: 15px` → `16px` on that rule (style.css:519). Zero visual downside on desktop.

### 🟠 MEDIUM

**M1 — `.team-grid` never collapses; stays 3 columns on mobile.**
- **Where:** `.team-grid { grid-template-columns: repeat(3, 1fr); }` (style.css:547) — no override in any media query. Used in the team section on **about.html**.
- **Why it matters:** at ~360px, three columns are ~100px each — cramped names/roles and a likely overflow/awkward wrap. *Verify on device.*
- **Fix:** add `.team-grid { grid-template-columns: 1fr; }` (or `1fr 1fr`) inside the `@media (max-width: 768px)` block.

**M2 — Bento services grid stays 12-column between 641–768px.**
- **Where:** `.services-grid.bento { grid-template-columns: repeat(12, 1fr); }` (style.css:1365) collapses to 1fr only at ≤640px (style.css:1432). Because `.services-grid.bento` has higher specificity than the generic `.services-grid { 1fr }` at 768px, the bento layout stays 12-col in the 641–768px band. Used on **services.html** (and the homepage services section if bento).
- **Why it matters:** large phones in landscape and small tablets (~700px) render a 12-column bento → cramped cards / potential overflow. Portrait phones (≤640px) are fine.
- **Fix:** collapse the bento at 768px as well (add it to the 768 block, or raise its own breakpoint to 768).

**M3 — No `overflow-x` safety net on `html`/`body`.**
- **Where:** no `overflow-x: hidden` / `max-width: 100%` on the root elements.
- **Why it matters:** overflow is currently avoided only because decorative elements happen to sit in `overflow:hidden` parents. It's fragile — any future element that exceeds the viewport will produce a horizontal scroll site-wide with no backstop.
- **Fix:** add `html, body { overflow-x: hidden; }` as a defensive guard (cheap, low-risk).

### 🟡 LOW / polish

**L1 — Mobile nav links are ~34px tall** (`nav a` padding 8px, font 14px; style.css:88–92). Full-width rows are still tappable, but below the 44px comfort target. Bump vertical padding to ~12px in the open menu.

**L2 — `.path-grid` stays 2 columns on mobile** (style.css:592). Two button columns at 360px are tight; confirm labels don't wrap badly. *Verify on device.*

**L3 — Very small decorative text:** `.card-tags span` = 9px and `.card-idx` = 10px in the bento service cards (style.css:1381, 1408). Legible as uppercase micro-labels but below a comfortable minimum; consider 11px.

**L4 — Container side padding stays 24px on mobile** (`.container { padding: 0 24px }`, style.css:~20). Slightly generous on a 360px screen (leaves 312px). Optional: reduce to 16px under 768px for more content width.

**L5 — `contact.html` `propertyValue` is `type="text"`** with a numeric placeholder (contact.html:244). It's a currency field so text is defensible, but adding `inputmode="numeric"` gives a better mobile keyboard.

**L6 — Hamburger has no `aria-expanded` state** (accessibility, not layout). The toggle sets a class but never reflects open/closed to screen readers. Add `aria-expanded` handling if doing an a11y pass.

---

## 4. Suggested fix order

1. **H1** — contact form 15px → 16px (one line; stops iOS zoom on the key form).
2. **M1** — collapse `.team-grid` on mobile (about.html).
3. **M2** — collapse bento grid at 768px (services page).
4. **M3** — add `overflow-x: hidden` safety net.
5. **L1–L6** — polish pass (tap padding, micro-font sizes, `inputmode`, `aria-expanded`).

## 5. Recommended verification

Before/after any fix, render **home, mortgages, calculators, contact, and one SEO landing page** at 360px and 390px on a real device or a desktop browser's device-emulation (DevTools → responsive, iPhone SE 375px + a 360px Android). Pay attention to: contact-form focus behaviour (H1), about.html team row (M1), services bento at ~700px (M2), and any sideways scroll (M3).
