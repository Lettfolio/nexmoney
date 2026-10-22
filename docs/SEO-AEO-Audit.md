# NexMoney Website — SEO & AEO Audit
*Reviewed: 15 July 2026 · All 8 public pages, robots.txt, sitemap.xml, vercel.json, assets*

**Overall: strong foundation.** Titles, descriptions, canonicals, breadcrumbs, FAQPage schema, and local-SEO signals are all in place and better than most broker sites. But there are several critical issues that undermine it — mostly URL-strategy conflicts and referenced files that don't exist.

---

## 🔴 Critical — fix before/at launch

### 1. `cleanUrls: true` conflicts with every URL on the site
`vercel.json` has `cleanUrls: true`, which means Vercel serves pages at `/mortgages` and **308-redirects** `/mortgages.html` → `/mortgages`. But every canonical tag, every sitemap entry, every OG URL, every JSON-LD `item`, and all ~56 internal links point to `.html` URLs. Consequences:

- Canonicals point to URLs that redirect — a conflicting signal Google may ignore
- The sitemap contains only redirecting URLs
- Every internal click takes a redirect hop (wasted crawl budget, slower UX)

**Fix (pick one, consistently):**
- **Recommended:** keep `cleanUrls: true` and strip `.html` from all internal hrefs, canonicals, sitemap `<loc>`s, OG URLs, and JSON-LD breadcrumb items → `https://www.nexmoney.co.uk/mortgages`
- Or remove `cleanUrls` and keep `.html` everywhere

### 2. Referenced files that don't exist (sitewide 404s)
| Missing file | Impact |
|---|---|
| `og-image.jpg` | Every social share (Facebook/LinkedIn/WhatsApp/X) renders with a broken image, on all 8 pages |
| `privacy.html` | Linked twice in every footer → 16 dead links; **a privacy policy is legally required (UK GDPR)** and expected of an FCA-regulated firm |
| `cookies.html` | Same — dead footer links sitewide |
| `apple-touch-icon.png` | 404 on iOS bookmark |

Create the OG image (1200×630), write the two legal pages, add the icon.

### 3. AggregateRating schema is unverifiable — rich-result penalty risk
The homepage schema claims `ratingValue 5.0, reviewCount 47`, but no reviews with that count are visible or sourced on the page. Google's guidelines require ratings to be genuine and verifiable, and **self-serving LocalBusiness review stars are no longer shown anyway**. The testimonials ("Sarah K.", "Mark & Jane T.") read as placeholders — if they aren't real client reviews, this is a compliance risk too (FCA financial promotions + CMA fake-reviews rules).

**Fix:** remove `aggregateRating` from the schema, or back it with a live feed of the actual VouchedFor/Google review count. Replace placeholder testimonials with real, attributable ones before launch.

---

## 🟠 High priority

### 4. robots.txt logic bug
Crawlers obey **only the most specific user-agent group**. Because `Googlebot`, `Bingbot`, and `Slurp` each get their own group containing only `Allow: /`, the `Disallow: /admin/`, `/portal/`, `/clienthub/` rules in the `*` group **do not apply to Google or Bing**. `/admin/` is rescued by the `X-Robots-Tag: noindex` header in vercel.json, but `/portal/` and `/clienthub/` have no such protection.

**Fix:** delete the three named user-agent groups entirely (the `*` group already covers them), and add `X-Robots-Tag` headers for `/portal/` and `/clienthub/` in vercel.json if those routes will exist.

### 5. Invalid SearchAction
The WebSite schema declares a `SearchAction` targeting `calculators.html?q={search_term_string}` — that's not a search results page. This is exactly the pattern that gets sitelinks-searchbox markup flagged. **Remove it** (no downside; the searchbox is deprecated anyway).

### 6. Service pages are the biggest missed opportunity
Everything lives on two pages (`mortgages.html`, `services.html`) with anchor links (`#ftb`, `#btl`…). You cannot rank "first time buyer mortgage Bournemouth", "buy-to-let mortgage Dorset", "remortgage Bournemouth" etc. from anchors on one page — each query deserves a dedicated URL with its own title, H1, schema, and FAQ block. This is the single biggest organic-growth lever:

- `/first-time-buyer-mortgages-bournemouth`
- `/remortgage-bournemouth`
- `/buy-to-let-mortgages-dorset`
- (later) location pages for Poole / Christchurch to match the homepage's area sections

### 7. Decorative headings dilute keyword value
H2s are split for visual effect: "Whatever your situation,", "Protect what", "Hassle-free". Crawlers see fragments. Keep the visual treatment but put the full phrase in the heading and style spans within it — e.g. `<h2>Mortgages for whatever your situation</h2>`, `<h2>Protect what matters most</h2>`. Also consider working "mortgage broker/advice" into the homepage H1 ("Your Mortgage, Sorted Right." carries no query intent) — or keep the brand H1 and accept the trade-off since the title tag carries the keyword.

### 8. Performance / Core Web Vitals
- **1.5 MB autoplay hero video** on every homepage visit. `preload="metadata"` + poster is good, but: serve a smaller/AV1 version (aim <800 KB), skip loading it entirely on mobile/`prefers-reduced-motion` (CSS `display:none` doesn't stop the download in all browsers — gate the `<source>` with JS), and `<link rel="preload" as="image" href="assets/hero-poster.jpg" fetchpriority="high">` so the poster is the LCP.
- **`enhance.js` is render-blocking in `<head>`.** The comment says it's intentional (FOUC guard), but only the one-liner `document.documentElement.classList.add('js')` needs to run pre-paint. Inline that, and load the rest with `defer`.
- **Google Fonts CSS is render-blocking.** Consider self-hosting Inter/Sora as woff2 with `font-display: swap`, or at minimum keep the existing preconnects (present ✓).
- Heavy inline styles (local-area section) belong in style.css.

---

## 🟡 Medium

9. **Entity-name inconsistency:** footer says "Nex Money is a trading style of Nexmoney Ltd"; schema says "NexMoney Ltd"; meta author "NexMoney Ltd". Align exactly with the Companies House name and FCA register entry — entity resolution matters for both Google and AI engines. Link the FCA register entry (`register.fca.org.uk` FRN 610875) from the footer — a strong E-E-A-T/trust signal.
10. **`sameAs` social profiles** (facebook/linkedin/instagram `/nexmoney`) — verify these exist and are yours; dead sameAs URLs hurt entity trust. Same for `twitter:site @NexMoney`.
11. **Schema address is thin:** `streetAddress: "Bournemouth"`, `postalCode: "BH1"`. Use the real street address + full postcode (must match your Google Business Profile exactly). If you don't have a GBP listing yet, that's the #1 local-SEO action overall.
12. **Sitemap `lastmod` is stale/inconsistent** (2025-06-10 on most pages, 2026-06-30 on testimonials). Either maintain it honestly or drop the field. `changefreq`/`priority` are ignored by Google — fine to keep or remove.
13. **`meta keywords`** is dead weight (ignored since 2009) — remove.
14. **`geo.position`/`ICBM` meta tags** — obsolete, harmless; the GeoCoordinates schema already covers it.
15. **© 2025** in the footer — it's 2026; make it dynamic or update.
16. **"Helping clients since 2010"** (footer) vs "10+ years" (stats) — 2026 − 2010 = 16 years. Undersell or inconsistency; pick one.

---

## 🤖 AEO (Answer Engine Optimization)

**What's already good:** FAQPage schema with ~17 Q&As mirroring visible `<details>` content; answers lead with the direct answer ("Most lenders will let you borrow between 4 and 4.5 times your annual income…") — exactly the format AI engines quote; clean semantic HTML with real text (no JS-rendered content); FinancialService/LocalBusiness graph with services, areas served, and opening hours.

**Gaps to close:**

17. **Add `llms.txt`** at the root — a short markdown file stating who NexMoney is, what it does, FCA status, area served, and links to key pages. Low effort, increasingly read by AI crawlers.
18. **Decide an AI-crawler policy in robots.txt.** GPTBot, ClaudeBot, PerplexityBot, Google-Extended are all allowed by default (silence = allow). For a lead-gen business you *want* to be citable in AI answers, so make it explicit with `User-agent: GPTBot / Allow: /` etc. — explicitness avoids accidental blocking later.
19. **Link the schema graph across pages.** Service/AboutPage/ContactPage nodes on subpages should reference `"provider": {"@id": "https://www.nexmoney.co.uk/#organization"}` so every page reinforces one entity rather than floating loose nodes.
20. **E-E-A-T for YMYL:** mortgages are "Your Money or Your Life" content — AI engines and Google both weight author/firm credibility heavily. Add named advisors with credentials (CeMAP etc.) and `Person` schema on the About page, and cite authoritative sources (Bank of England base rate, UK Finance) in FAQ answers where relevant.
21. **Answer-first content blocks on service pages:** when you build the dedicated pages (#6), open each with a 40–60 word direct answer to the head query, then expand. That's the snippet/AI-citation format.

---

## Priority order

| # | Action | Effort |
|---|---|---|
| 1 | Resolve cleanUrls vs .html across links/canonicals/sitemap/schema | 1–2 hrs |
| 2 | Create og-image.jpg, privacy.html, cookies.html, apple-touch-icon.png | 2–3 hrs |
| 3 | Remove/substantiate aggregateRating; replace placeholder testimonials | 1 hr |
| 4 | Fix robots.txt groups; remove SearchAction | 15 min |
| 5 | Google Business Profile + full address in schema | 1 hr |
| 6 | Hero video diet + inline JS class + defer enhance.js | 1–2 hrs |
| 7 | llms.txt + explicit AI-crawler allows + schema @id linking | 1 hr |
| 8 | Dedicated service/location landing pages | ongoing, biggest ROI |
| 9 | Copy fixes: headings, entity name, dates, meta keywords | 1 hr |
