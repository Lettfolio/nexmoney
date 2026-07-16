# NexMoney Red Team — Final State (2026-07-16, round 2 complete)

Two full fix rounds shipped. Round 1: mobile grids, sticky header, contact form lead-loss, admin reset domain, stamp duty accuracy, security headers, contrast/a11y. Round 2 (this update): skip-links + <main> landmarks rolled out to about/mortgages (and index in r1), homepage mini-calculator fixed (labels, negative-input clamping, 4x-5.5x multiple to match copy), hero video pause/play control (WCAG 2.2.2), calculators page heading levels + aria-live results + all inputs clamped, faq/mortgages titles shortened, 'Refer a Friend' contrast, FTB landing FAQPage schema/visible-text match, services footer Cookie Policy links, calculators topbar segment, /assets/* cache changed to max-age=86400 + stale-while-revalidate (video swap now safe), admin: SheetJS upgraded past CVE-2023-30533/CVE-2024-22363 + supabase-js pinned with SRI integrity hashes, CSV export hardened against formula injection.

Verified pre-ship: all 13 public pages render at 390px with zero horizontal overflow and zero console errors; hero pause button toggles (aria-pressed); mini-calc clamps negatives; all JSON-LD parses; vercel.json/enhance.js/admin JS parse clean.

## Remaining (round 3 was skipped at Daniel's request)

A final confirmation sweep (round 3) was intentionally skipped. Known lower-priority leftovers: some page titles on other landing pages may still exceed 60 chars; heading-level skips may remain on testimonials/faq; skip-links not yet on all 13 pages (index/about/mortgages done); full CSP header intentionally deferred (inline scripts/styles would need refactoring first). Re-run the red team loop any time to sweep these.
