# R137 — style.css and enhance.js named by content (26 Nov 2026) — fix for R136

**What went wrong.** R136 (merged 13:06 UTC) removed the Google Fonts `<link>` from every public page and put the replacement `@font-face` rules in `style.css`. Pages are not cached; `style.css` is cached for a day (`max-age=86400, stale-while-revalidate=604800`). So a visitor who already held the old `style.css` got the new page with the old stylesheet: no Google link, no `@font-face` — text in the fallback font (Segoe UI) until their copy expires. Found in the post-merge check at 13:08 UTC: `document.fonts` empty, button widths 239.2 against 246.4, page height 10,962 against 11,189. First-time visitors were never affected. The back office was not affected (its stylesheet revalidates on every load).

**Confirmed the fonts themselves are right.** With the fresh stylesheet swapped into the same page, every one of 60 measured elements and the page height matched the pre-change baseline exactly.

**Fix.** `build.js` ends with `stampAssets()`: every served public page links `style.css?v=<first 8 of its sha256>` and `enhance.js?v=<…>`. The page and the files it was built with now travel together; an unchanged file keeps its name and its cache. Runs last, over the copied pages, the content overrides and the guides. Repo HTML is unchanged — the name is added at build. No tag bump: no back-office file changes.

**Test.** `tests/r137_asset_names.js` (8): no bare link left, every link carries the served file's hash, guide and override pages covered, back office untouched, a changed stylesheet gets a new name.

**Lesson.** A change split across a cached file and an uncached page is two deploys to a returning visitor. Before R137 nothing tied them together. Also: the pre-merge look check was skipped because the preview needed a Vercel login — a check that cannot be run is a reason to find another way to run it, not to move it after the merge.
