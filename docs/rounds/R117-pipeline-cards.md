# R117 — pipeline cards: two chips and "+N"; columns that fold (review P2, P5)

## What changed
- **P2 · two chips per card.** `cardFlagsHtml(parts)` (app.js) takes the eight chip slots `boardCardHtml` used to print in a row. With three or more present it prints two and a grey `+N` button; the rest sit in `.flags-rest[hidden]`. Order: who the case is waiting on, then red, then amber, then informational (stable within each). `+N` carries the hidden chips' words in `title` and `aria-label`; pressing it (`cardMoreFlags`, `data-stop` so the case does not open) shows them and reads "Less". Cards with one or two chips are unchanged. The same builder feeds the phone card list in Table view.
- **P5 · a column folds.** A `‹` button in each column heading (`boardFoldCol`) folds the column to a 44px strip showing its name and count; `›` opens it. Stored per person in this browser (`nx_board_fold_v1:<user id>`). `boardApplyFold()` sets the board's `grid-template-columns` only while something is folded. A folded column still takes a dropped card.
- **Not built:** a "compact cards" switch. The Pipeline header already has seven controls, and cutting the chips is what makes a card shorter.

## Harness
Seam mode prints every chip in the old order and has no fold button. `tests/r117_pipeline_cards.js` (20) runs in real mode and compares against a seam page: shown + hidden equals what the card used to print.

## Not verified
Seen only on the mock book. How many real cards carry three or more chips, and whether the two that lead are the right two for the advisers, is for Daniel and the team to say.
