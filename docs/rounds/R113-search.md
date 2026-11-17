# R113 — Search: recent records first, next steps on a result (N3, N4)

Daniel, 17 Nov 2026: "proceed".

## What the review asked, and what was already true
N3 asked for the palette to find by lender and postcode. It already does (R6 / R66: `lender`,
`property_address`, postcode with or without the space, abbreviated street forms). Not rebuilt.

## N3 — recent records before typing
The last six cases and clients you opened lead the search box, most recent first, above Actions, with the
newest highlighted — `/` then Enter goes back to where you just were.
- Noted in `pushModalHistory()` when a case or client takes its history entry (`paletteNoteRecent`).
- **Only the kind and the id are kept in the browser** (`localStorage`, key `nx_recent_v1:<user id>`). Names
  are read fresh when the box opens (`loadRecent()`: two reads, by id), so nothing about a client is stored
  on the machine, and a record you can no longer see, or that has been deleted, simply is not listed.

## N4 — next steps on a result
A case row offers **Log call**, **Add task**, **Book**; a client row offers **Call** (a `tel:` link, when
there is a number) and **Book**. Shown on the highlighted row only — recent or typed.
- Each opens the record and presses the button that is already there (`#cs-logcall-btn`, `#act-appt`), or
  puts the cursor in the task box on the Work tab. Book on a client opens a new appointment set to them.
- Keyboard: arrows choose the row, **Tab** walks its actions, **Enter** presses one. Enter on the row itself
  still opens it.
- The pointer highlights the row it moves over (on a real move only, so results repainting under a resting
  pointer do not steal Enter from the top hit).
- On a phone the actions take the line under the name rather than squeezing it.

## Not built
- "Label the page search boxes Filter" (rest of N3): the boxes already say what they search
  ("Search cases…", "Search the vault…"); renaming them is wording for Daniel, not a build.

## Harness
Off under the R102 seam (no Recent group, no row actions, no hover highlight). `tests/r113_search.js` (18).
No CSS added; admin.css 3,949. Tags → r113.
