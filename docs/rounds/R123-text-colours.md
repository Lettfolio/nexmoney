# R123 — near-duplicate text colours folded onto the palette (review X1, second half)

## Measured (owner, 1366×768, twelve pages and a case record)
| | before | after |
|---|---|---|
| distinct text colours on light surfaces | 21 | 11 |
| pairs that were near-duplicates of each other | 6 | 1 (muted / muted-on-tint, deliberate) |
| distinct text colours on dark surfaces | 7 | 4 |

The review's "five" was the aspiration for body text. What is on a light page now: three neutrals (ink `--dark`, body `--text`, `--muted`) plus `--muted-on-tint` for grey chips, one link blue (`--navy`), one red, one green, one amber, the brand orange (two uses) and the Vault's purple owner tag.

## What was folded (28 `color:` declarations in admin.css; no line added)
- Greys `#5b6b7e`, `#66738a` → `var(--muted)`; `#556275` (on `#eef1f5`) → `var(--muted-on-tint)`.
- Reds `#b8352a`, `#b3261e` → `var(--red)`.
- Ambers `#8a6400`, `#9a6200`, `#b35309` → `var(--amber)`.
- Green `#1d7a3a` → `var(--green)`; blue `#1a5fb4` → `var(--navy)`.
- Sidebar `#a8c0dc`, `#9fb6d3` → `#a9bfda`; `#cddcef` → `#d5e2f2`.

Every folded colour still meets 4.5:1 where it lands (lowest: red on the Urgent header tint, 4.76:1). `.rate-uplift` now uses `var(--amber)`: a defined token that passes — R73's trap was a defined token that failed.

Visible effect: the retention uplift figure and "hot" chip move from orange-brown to the same amber as other warnings; otherwise the changes are a shade or two.

`tests/r123_text_colours.js` (10). Stylesheet-only, so both harness modes.
