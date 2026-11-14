# R103 — Reports: one earned figure, definitions on hover (review items O1, O2)

Daniel ticked O1/O2 in the UI/UX review on 14 Nov 2026.

## What changed
- **O1 — the month's earned figure is stated once as a figure.** It was shown four times on Reports › This month:
  the hero, a "Completed £" tile, a hero strip, and the target line. Now: the hero carries it, with the
  month-on-month and year-on-year chips that used to sit on the tile. The "Completed £" tile and the hero
  strip (which repeated the three tiles below it) are gone. The target line keeps "X of Y (N%)" as the
  label of its bar and loses the repeated basis sentence.
- **O2 — basis captions become tooltips.** `basisLine()` now renders the fixed definition
  ("earned · all fee types") as an "i" marker with a tooltip plus screen-reader text. Anything after
  " — " that carries data (counts, excluded future-dated amounts) stays visible. The two debtor tiles
  were re-worded so their amounts stay visible. "How these are counted" is unchanged.

## Not changed
No figure, formula or scope. Adviser view unchanged apart from the tooltip treatment on My numbers.

## Tests
`r5_batch6` re-based (three tiles + hero chips; one "(earned · all fee types)"; hero number equals the
old tile's arithmetic; new O2 check). `r74_numbers`, `r73_system`, `r89_reports`, `r87_owner_admin`,
`r87_shell`, `r90_queues`, `r5_batch5`, `r68_mi`, `r81_platform`, `r87_book`, `r88_book_b`, `r72_owner` green locally.
Tags → r103. admin.css 3,948 lines.
