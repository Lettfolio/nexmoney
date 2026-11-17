# R114 — Phone: a bottom bar in place of the scrolling menu strip (N7)

Daniel, 17 Nov 2026: "proceed" (after "next is the phone bottom bar").

## What changed (phone width, ≤760px, real mode only)
- The sideways-scrolling strip is hidden. A bar fixed to the bottom edge carries **Today, Pipeline, Clients,
  Search, More** — five 58px targets, no label cut short. The current page is marked; Today's label carries
  its count ("Today · 13").
- **More** opens the house overlay listing every other destination the signed-in role can reach. The list is
  read from the sidebar's own buttons (`#topnav button[data-page]:not(.hidden)`), so the role gates are the
  sidebar's and the sidebar counts come with them. More is marked when the page is one of those.
- **Search** presses the existing search button.
- The top bar keeps the logo, search, Ask AI, Help and Sign out.

## What had to move out of the bar's way
One CSS variable, `--bar-h` (58px + the phone's safe-area inset; 0 everywhere else):
- `#main` gets that much bottom padding;
- the sticky docks — `.bulk-dock`, `.pipe-bulk-dock`, phone `.bulk-bar`, `.settings-dirty-bar` — and the toast
  use `bottom: var(--bar-h, 0px)` instead of `0` / `24px`.
An open record (z-index 50) covers the bar (40).

## The tour
Its steps point at the strip's buttons. While a tour runs the body class is dropped — strip back, bar away —
and it returns at `tourEnd()`.

## Where it does not apply
Laptop widths (the bar element exists but `display: none`); the harness seam (no bar element at all).

## Limits — said plainly
Checked in an emulated 390×844 viewport only; no real phone has loaded it. The safe-area padding in
particular is untested on a notched device.

## Harness
`tests/r114_phone_bar.js` (18). admin.css: the strip's `::after` hint collapsed to one line to make room —
3,946 lines, still 14 `@media` blocks. Tags → r114.
