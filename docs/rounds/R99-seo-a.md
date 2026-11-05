# R99 · SEO-A — first moves of the SEO/GEO plan (5 Nov 2026)

Plan: Claude Doc "NexMoney SEO & GEO Growth Plan" (three Opus researchers → Fable verifier → ten moves).
This round ships the on-site half of moves 1, 4, 6 and 7. Base: origin/main d0b0a1a. Branch `r99-seo-a`, two commits.

## What shipped
- **Statutory**: registered office Faulkner House, 31 West Street, Wimborne BH21 1JS on every page (Companies House AD01 29 Jul 2026); Avalon stays as the trading address; privacy + Share the Love T&Cs updated. FRN 610875 links to the firm's own Register entry (`register.fca.org.uk/s/firm?id=001b000000NMjhQAAT`). `llms.txt` attributes 610875 to NexMoney Ltd (Stonebridge is 454811), duplicate AR sentence gone, NAP + company number added.
- **Crawl**: `robots.txt` is one universal group; `/portal` is no longer disallowed so its 301 → `/contact` can be crawled (X-Robots-Tag noindex on `/portal/*` stays). `404.html` added (absolute asset paths).
- **Entity**: hero paragraph on `/` states what NexMoney Ltd is; schema gains `alternateName` ["NexMoney","Next Money","Nexmoney"], `legalName`, Companies House + FRN identifiers, `foundingDate`, `parentOrganization`, and `sameAs` Trustpilot / FCA Register / Companies House / Unbiased (the Facebook/LinkedIn/Instagram URLs were left as they were — Daniel to confirm they exist). A minimal Organization node (same `@id`) now sits in every page's `@graph`, so `Service.provider` resolves on every page. Contact shows the full street address; About has in-body links.
- **Redirects**: `/calculators/rental-income-calc(ulator)` → `/buy-to-let-rent-calculator` (before the `/calculators/:slug+` catch-all); `/mortgages/capital-raising` → `/capital-raising-mortgage`.
- **Pages** (Opus builder): `/capital-raising-mortgage` (~1,290, debt-consolidation warning verbatim), `/buy-to-let-rent-calculator` (~1,060 + working ICR calculator in `js/btl-rent-calculator.js`, data-act pattern, CSP-clean). BTL page: complex buy-to-let H2 + FAQ; FTB page: "Help to Buy has closed" H2 + FAQ; calculators: ids, intros, BTL rent calculator H2 link; services/remortgage/mortgages link to the new pages.
- **Sitemap**: two new URLs (16); `build.js` dates each repo page from `git log -1 --format=%cs` when the clone has >20 commits, else keeps the hand-kept values (a shallow clone would date everything "today").
- **Back office**: `sitePagesConst` 16 (Capital raising, BTL rent calculator rows in Website › Content); eight tags → `r99a`; `r93_content` 14→16; `r95_unsub` robots regex follows the new group shape.

## Verified before the PR
`NX_CONTENT_OPTIONAL=1 node build.js` clean (style.css is already minified by the build — the audit's "minify" item was wrong); every JSON-LD block on the touched pages parses; visible FAQ == FAQPage on the new Q&As; calculator checked by hand (£200k @ 5.5% → £917/mo interest; £1,100 rent = 120%; £1,329 needed at 145%); `eslint .` clean; suites r93_content, r93_seo, r93_data, r95_unsub, r95_kit, r97_docs, r90_carve, r81_platform, r94_csp green (r94's SheetJS cases need cdn.sheetjs.com — sandbox-only).

## Change 5 Nov 23:55
[Daniel] "remove the asu page as we do not wish to sell that" → `/asu-insurance` removed (page, sitemap, page list, llms.txt, services link); `/general-insurance/accident-insurance` keeps its old `/general-insurance/:slug+` → `/services#insurance` redirect. The pre-existing ASU card on `/services` was left as it was (Stonebridge-approved copy) — Daniel to say if it goes too.

## Before merge (Daniel)
- The two new pages and the two new sections are financial promotions → Stonebridge sign-off. Builder's review list: Help to Buy dates (closed Oct 2022, completions 2023); the one illustrative "hypothetical 5%" stress rate on the calculator page; "many lenders allow 10% overpayments" claim; second charge "by introduction"; ICR/PRA descriptions (145% higher-rate, 4+ = portfolio); 
- Confirm FRN 610875 is NexMoney Ltd's and the register-entry URL above opens the firm page.

## After merge
Live-verify eleven hashes + eight `r99a` tags + `__errorLog 0`; curl the three redirects and `/portal`; check `/404`-style URL serves 404.html; request indexing of the three new URLs in Search Console; re-run the seo snapshot.

## Not in this round (plan moves 2, 3, 5, 8, 9, 10)
Google review drive (templates in the Doc), GBP/Apple/Bing/Yelp/Unbiased listings, adviser pages (need bios/photos), Christchurch page, guides cadence, PR. The audit's font self-host item was dropped (PSI already 95). Old out-of-area town URLs: no redirect added — their real slugs need Search Console's 404 report first (a guessed pattern could loop the live FTB page).
