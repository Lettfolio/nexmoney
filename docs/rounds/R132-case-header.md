# R132 — a shorter case header on a phone

Daniel chose "Both" on 24 Nov 2026. Real mode, ≤760px.

On an open case's summary card the adviser / loan / LTV strip and the **empty** objective prompt are hidden. One round "⋯" button in the card's top corner shows them again (`phoneCase()`, `.cs-more`); it adds no line of its own. Opened once, they stay open for the session.

- A written objective is never hidden.
- The objective can only be edited from this card, so the button is also the way back to its prompt.

Fixture: the tabs start 88–130px higher (512 → 424, 570 → 440).

Tests: `tests/r132_case_header.js` (13).
