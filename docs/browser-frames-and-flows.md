# Browser frames and reusable flows

`observe` lists visible iframe elements with ordinary refs. Enter one with
`{ "action": "frame", "ref": 123 }`. Reads, evaluation, element actions and uploads
then use that document, including cross-origin frames. Enter another iframe ref
to go deeper. `{ "action": "frame" }` returns directly to the top document.

Frame selection belongs to its tab. Navigation invalidates document refs; observe
again before acting. A removed frame fails without falling back to the top page.
Click a field before typing: keyboard input is refused when the selected frame
does not have actual browser focus. Screenshots and PDFs cover the whole tab;
an element screenshot translates its frame-local crop into the tab.

Pointer actions account for iframe borders, nested offsets and axis-aligned
scaling. Covered, detached, rotated or perspective-transformed frame geometry
fails explicitly rather than guessing coordinates.

## Flow parameters

Use the existing `fields` input to replace an exact recorded fill/type value
with a named parameter when saving:

```json
{ "action": "flow", "mode": "save", "name": "search", "fields": { "query": "original search text" } }
```

Replay with new values:

```json
{ "action": "flow", "mode": "run", "name": "search", "fields": { "query": "different search text" } }
```

Saved inputs contain `{{query}}` and parameter names. Whole input values match
exactly; whitespace is preserved. The complete flow and all supplied parameters
are validated before browser work begins. Replay resets to the top document and
then follows any recorded frame entries. Existing ordinary version 1 flows remain
readable.

Sensitive fills and typing are excluded from automatic recordings, and their
steps are marked unreplayable. Saving and loading also reject identifiable
credential literals. Review or re-record old flows that are refused. Runtime
parameter values are not written back to flow files or included in replay traces.
A recording cleared inside a frame must return to the top and record its entry
before it can be replayed. Recordings beyond 300 steps require a shorter recording.

## Validation

```text
bun run src/services/browser/frames.test.ts
bun test src/services/browser/flowParameters.test.ts
bun run src/tools/BrowserTool/BrowserTool.test.ts
bun run src/services/browser/browserFrames.live.test.ts
```

The live check launches an isolated temporary Chrome/Edge profile and local
fixtures. It tests real cross-process frames, native input, uploads, screenshot
pixels and stale refs. No extension or additional browser dependency is required.
The Browser tool's schema and prompt remain static across runtime frame and flow
state; discovered page details appear only in tool results.
