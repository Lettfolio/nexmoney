# R139 — phones get the hero still, not the video (26 Nov 2026)

Item 4 of the performance review. **Daniel, 26 Nov 13:17: "yes to … still image on phones"** — asked as a visible change to the signed-off home page.

**Before:** `assets/hero-loop.mp4` (447 KB) was 88% of the home page's 505 KB and autoplayed on phones.

**Now, at 768px wide and below:**
- `index.html`: the `<source>` carries `media="(min-width: 769px)"`, so a phone never requests the file.
- `style.css`: the video is hidden, `.hero-media` shows `hero-poster.jpg` (the frame the video opens on — the same rule the reduced-motion case already used), and the pause button is hidden.
- Home page on a phone: about 58 KB instead of 505 KB (505 − 447; not re-measured on a real phone).

**Unchanged:** 769px and wider. Reduced-motion behaviour. A phone turned sideways past 768px after loading keeps the still.

**Depends on R137** (PR #53): the page and `style.css` change together, which is only safe now that the build names the stylesheet by its content. This branch is cut from R137's.

**Tests:** `tests/r139_phone_poster.js` (8): no video request at 390 and 768px, still shown full height, no pause button; video requested and shown at 769 and 1366px.
