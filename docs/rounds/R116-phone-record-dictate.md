# R116 — a record that stays put on a phone, the assistant on a phone, dictation

Reported by Daniel from his iPhone on 17 Nov: an open client "moves left and right", the assistant is "a bit problematic when launching", and a request for speech to text.

## What was wrong
- **Record wider than the screen.** At ≤900px a record has 16px padding, but its sticky top bar and Save bar still pulled out by the ordinary panel's 18px (≤760px) or 28px (761–900px). The record was 2px too wide each side on a phone and 12px on a tablet-width screen, and its scroller allowed sideways travel. Measured before: `scrollWidth` 392 in a 390 screen.
- **iOS zoom on focus.** Every field's text is under 16px, so iOS Safari zooms the page when one takes focus and leaves it zoomed and pannable. The assistant put the cursor in its box as it opened, so it zoomed on launch.
- **Assistant drawer was `100vh` tall**, which on iOS is taller than what is visible: the message box sat under the browser's bar or the keyboard. Its close button was 31×26.

## What changed
- `admin.css` (≤900px block): the record's bars pull out by the record's own 16px; `.record-back` gets `overflow-x: hidden; overscroll-behavior: contain`.
- `boot.js`: on iOS only, the viewport gains `maximum-scale=1, viewport-fit=cover`. Pinch-zoom still works on iOS; other phones keep the plain viewport.
- `app.js`: `chatFit()` sizes the drawer to `visualViewport.height` (`--vvh`) while it is open; on a touch screen opening it no longer focuses the box; `chatClose()`.
- **Dictation:** `#chat-mic` beside Send, shown only where the browser has `SpeechRecognition` / `webkitSpeechRecognition`. `chatDictate()` — en-GB, interim results, appended after what is typed, never sent on its own; stops on Send and on close; a blocked microphone is explained.
- `vercel.json`: `Permissions-Policy` now comes from two rules instead of one — the public site keeps `microphone=()`, `/admin` gets `microphone=(self)`. Nothing else in the policy changed. **This loosens one security header for /admin**, which the feature cannot work without.

## Not verified
- No iPhone has loaded this. The zoom, the drawer height under Safari's bars and the keyboard are reasoned from how iOS behaves and checked only in an emulated phone.
- Real speech recognition is not exercised: the tests use a stand-in recogniser. iOS Safari's recogniser, and whether it is offered at all when the back office is opened from a home-screen icon, are untested.
- The browser, not NexMoney, turns speech into text: audio goes to Apple (Safari) or Google (Chrome).

## Tests
`tests/r116_phone_record_dictate.js` (29). Harness seam unchanged: no button, cursor in the box, no `--vvh`.
