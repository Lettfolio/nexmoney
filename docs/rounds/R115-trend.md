# R115 — Reports: twelve months under each headline figure (O5)

Daniel, 17 Nov 2026: "proceed".

## What changed
On Reports › This month, the earned figure in the hero and the three Monthly business tiles (Applications
submitted, Submitted £, Completions) each carry a small line of the twelve months ending in the month on
show, captioned "12 months".
- Computed from the same `all` cases and the same helpers as the figure above it (`monthKpiSet`,
  `earnedOnCompletion`), so the last point of the line is always the number printed.
- Hovering shows every month and value ("Dec 25 £1,310 · Jan 26 £0 · …"); a screen reader is given the same
  in words. Choosing another month moves the twelve months with it.
- Reuses `sparklineSvg()` (the adviser scoreboard's). No CSS added. Applies in both harness modes — it only
  adds an element inside each tile.

## Not built, and why
- **N6** (one firm-wide Mine/All switch): each page's default was set on purpose — the owner opens Today on
  Mine, the administrator on All, Retention on All, Clients on Mine. One switch would override those. Needs
  Daniel's say.

## Harness
`tests/r115_trend.js` (8). Tags → r115. admin.css unchanged from R114 (3,946).
