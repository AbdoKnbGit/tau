# Inline images in Tau — handoff

Everything here is **uncommitted, on `master`**. 8 new files, 12 modified,
133 tests passing, typecheck at the repo's 5217-error baseline with zero added.

Feature: `Read` on an image, a notebook with executed figures, or a Bash command
whose stdout is a data URI renders the picture inline in the transcript at real
pixel fidelity, falling back to Unicode block glyphs where that is not possible.

**Read §2 before changing anything.** Twenty-one defects were fixed across several
rounds, and they all produced the *same* two visible symptoms, which is why the
first four attempts fixed the wrong thing. §2 names the invariants that tie them
together — and note that (5) was itself wrong, corrected by (11).

---

## 1. Current state

| | |
|---|---|
| Works | Sixel on Windows Terminal 1.24 — plot axis labels and body text legible |
| Untested by a user | Kitty / Ghostty / WezTerm (`a=d` delete path), iTerm2, macOS |
| Unverified | Whether Windows Terminal carries sixel pixels through a scroll (§5) |
| Confirmed fixed by the user | The ghost / misplaced copy after a resize (§2(10)–(11)); block glyphs after minimise / maximise / zoom out (§2(14)) |
| Known limit, open | An image scrolled fully into history stays on block glyphs. A full reset (`CSI 2J` + `3J`, emitted on every width change) rewrites the transcript as text, and the cursor cannot reach a scrollback row to put the pixels back. §8 has the fix — emitting the payload inline as the frame is written, so the terminal scrolls it like text |

Verify with:

**First stop for any "it renders blurry" report: `npm run graphics-doctor`.**
It prints, for the terminal it is run in, every gate between reading a PNG and
writing a sixel — DA1, cell size, encoder health — and then *draws* a sixel, a
row of quadrant glyphs and a row of half blocks, because a terminal can answer a
capability query and still not render the result. Several rounds here were spent
guessing at things it answers in one line.

```bash
npm run graphics-doctor                      # diagnose a terminal
bun run src/utils/terminalImage.test.ts      # 68
bun run src/utils/terminalGraphics.test.ts   # 35
bun run src/ink/graphicsPlacement.test.ts    # 30
npx tsc --noEmit -p tsconfig.json | grep -c "error TS"   # must stay 5217
node build.mjs
```

5217 is the repo's **pre-existing** error count (measured with these changes
reverted as well as applied). The invariant is that it does
not grow. `tau` is npm-linked to this repo, so `node build.mjs` makes changes
live — **but a running session holds the old bundle and must be restarted.**
Several rounds of "nothing changed" were partly this.

`src/services/tokenEstimation.test.ts` (9 tests) **cannot run in this tree**:
importing that module pulls in the tool registry, and 37 modules in the import
graph do not resolve — an absent `src/tools/TungstenTool/` directory,
uninstalled `@opentelemetry/*` exporters, `@anthropic-ai/sandbox-runtime`,
`*-napi` packages. Pre-existing, and why `tokenEstimation.ts` had no tests. The
production build is unaffected.

---

## 2. The twenty-one defects — and the one thing they had in common

Two visible symptoms, over and over: **a duplicated/offset ghost copy**, and
**the image dropping to blurry block glyphs and never coming back**. Nine
distinct causes produced them. Four separate "fixes" to the erase logic missed
every one.

> **The invariant: every path that stops drawing an image must have a way back.**
>
> When touching this code, the question to ask of any `continue`, early return,
> or withhold is not *"is this correct?"* — they all were — but **"what makes
> this stop being true?"** If the answer is "a promise resolves", "a patch type
> matches", or "the component happens to re-render", it is a latch, and a latch
> here is a permanently broken image.

### (1) Kitty images had no id, so nothing could ever delete them

`encodeKittyGraphics` emitted `a=T,f=100,q=2,C=1,c=…,r=…` with **no `i=` key**.
Per <https://sw.kovidgoyal.net/kitty/graphics-protocol/> the terminal then
assigns its own id and nothing afterwards can refer to that image. Every redraw
stacked another placement, permanently — and no cell repaint reaches it, because
the terminal owns those pixels independently of the text. On
kitty/Ghostty/WezTerm that is an accumulating ghost *and* an unbounded image
store for the session's lifetime.

Fixed: `allocateKittyImageId()` assigns a stable id per encode, seeded randomly
in the low 24 bits — the id namespace is shared with every other program writing
to that terminal, and transmitting with one already in use silently replaces
someone else's image. `encodeKittyDelete()` emits
`\x1b_Ga=d,d=I,i=<id>,q=2\x1b\\`; uppercase `d=I` frees the stored data too,
which is right because the redraw path always retransmits the full payload.

Carried through `GraphicsPlacement.eraseSequence` and emitted **before** the
cell repaint. It needs no cursor position and no theory about where the pixels
went, so it reaches the two cases the repaint structurally cannot: a payload
that overflowed its box, and a rectangle clipped at the viewport edge.

### (2) Graphics were encoded against a *guessed* cell size

`resolveGraphicsProtocol()` returns `sixel` on the DA1 parameter alone, while
`getCellPixelSize()` falls back to `{7, 14}` when nothing answered `CSI 16 t` or
`CSI 14 t`. Pixels-per-cell is the one number that must be right — the payload
is sized in pixels, the box reserved in cells. Guess low and the graphic is
smaller than its box, leaving block glyphs around the edges (the "good image on
top of an ASCII one" report). Guess high and it spills past the rectangle every
erase is computed from.

Fixed: `renderGraphicsOverlay()` returns `null` unless `hasMeasuredCellSize()`.
A terminal that advertises sixel but will not report geometry gets the block
render, which is exact in cells by construction.

### (3) Zoom drew every image against the previous font size

Zoom changes pixels-per-cell without changing the grid. The re-measure is a
terminal round trip, and frames keep rendering throughout — against the *old*
measurement. An already-encoded payload is a fixed pixel size, so it no longer
matches the box the layout reserves; when the new cell is **smaller**, it
overflows past anything an erase can reach.

Fixed: `markCellGeometryStale()` runs **synchronously** in the resize handler.
While stale, every placement is erased and every draw withheld, and the block
render — measured in cells, so it cannot be wrong about them — stands in.

**Then this became the bug.** The first version gated the lift entirely on the
probe's promise. `TerminalQuerier` is documented *"never times out on its own"* —
a batch settles only when its DA1 sentinel returns, so one reply dropped during
a resize left the promise unsettled and every image on block glyphs for the rest
of the session. Reported as *"sharp at first, then blurry after I resize"*, and
strictly worse than the ghost it prevented. Three independent guarantees now:

- `staleUntil` is a **deadline**, not a flag (`STALE_TIMEOUT_MS = 400`), so it
  lapses with no help from anyone.
- `App.tsx` arms a **watchdog** that calls `clearCellGeometryStale()` regardless
  of the probe, and bumps the capability generation so images re-encode.
- `settle()` runs on both the resolve and reject paths, and releases the
  in-flight latch — which would otherwise have stuck forever and stopped any
  future zoom from being measured. Same trap, one level down.

The query also goes out on the **leading edge**: a drag-resize does not change
the cell size at all, so waiting out the 150 ms debounce dropped every image to
blocks for nothing. `cellGeometryInFlight` keeps a continuous drag to one
outstanding query.

### (4) A resize erased the screen without saying so

`ink.tsx` prepends `ERASE_SCREEN` to the next frame after a resize
(`needsEraseBeforePaint`). `CSI 2 J` drops sixels along with the text (§5), so
every image was wiped — but the invalidation hook only fired for a
**`clearTerminal` patch**, and `ERASE_THEN_HOME_PATCH` has `type: 'stdout'`.
`lastDrawn` still held the old rectangles, the image had not moved, so the
redraw was suppressed as "already on screen" while the terminal had dropped it.

`forceRedraw()` (**ctrl+L**) and `reenterAltScreen()` (SIGCONT, sleep/wake,
returning from an external editor) had the same hole — they write `ERASE_SCREEN`
straight to stdout with no patch at all.

Fixed structurally rather than at three call sites: `repaint()` and
`resetFramesForAltScreen()` both call `invalidateGraphicsPlacements()`.
Resetting the frame buffers *is* the invariant — it means the terminal no longer
matches what was recorded — and all three paths go through one of them.

*Found from a user observation:* "the session goes static after the first turn,
so the aliveness depends on the turn itself." Exactly right — a wiped image only
came back when a later turn happened to repaint those cells. (The wordmark
freezing is unrelated and deliberate: `OffscreenFreeze` returns a cached element
once content scrolls above the viewport, so `useAnimationFrame` stops driving
it. Different mechanism, correct conclusion.)

### (5) The main screen never invalidated at all — **and this fix was wrong**

(4) hooked `resetFramesForAltScreen()`. `handleResize` only calls it **when
`altScreenActive`** — which defaults to `false`. Tau runs in the main screen
unless fullscreen is toggled, so on the mode most sessions are in, a resize reset
nothing. `handleResize` therefore called `invalidateGraphicsPlacements()`
unconditionally, before the mode branch.

That was the right diagnosis and the wrong verb. The main screen needed a
*redraw*; invalidating also **forgets where the pixels are**, and on the main
screen a resize clears nothing. See (11).

### (6) The row-budget floor overrode the cap that makes the box fit

```ts
return Math.max(MIN_IMAGE_ROWS /* 16 */, Math.min(MAX_IMAGE_ROWS, rows * 0.75, rows - 10))
```

The `rows - 10` term exists precisely so the box fits inside the viewport — an
overlay is drawn only when its whole rectangle is addressable. The floor sat
outside it and won. **On any terminal shorter than 26 rows the budget was 16
while only `rows - 10` could be drawn**, so every image was withheld and every
image was blocks. The floor is now clamped to the fit cap.

The existing test asserted `budget <= viewport - 10 || budget === 16` — the
second clause was an escape hatch from the very property being checked, which is
how the bug survived. Unconditional now, down to 12-row viewports.

### (7) A box that did not fit could never recover

Withholding a too-tall overlay is correct — the cursor cannot address a scrolled
-away row, and a payload running past the bottom edge can scroll the window. But
it was **terminal**: the component had no way to learn its box was undrawable,
so it re-encoded the same too-tall image forever.

`graphicsPlacement.ts` now reports the room a clipped box actually had
(`getPlacementRowLimit` / `subscribeGraphicsConstraints`) and `InlineImage`
folds it into its budget, so the image returns one size smaller instead of not
at all. Bounded by construction: **bottom overflow only** (being shorter does
not help an image scrolled off the top), **monotonic** (cannot oscillate against
the layout shift it causes), **floored** at `MIN_PLACEMENT_ROWS = 6`, **cleared
by `invalidateGraphicsPlacements()`** (a limit describes one terminal size and
scroll position), and **notified in a microtask** (it is recorded while Ink is
assembling a frame; waking React synchronously would re-enter rendering).

### (8) Every frame of a streaming response re-sent the whole payload

`samePhysicalRect` compared `y - viewportTop`. While a response streams the
transcript grows, `viewportTop` advances **every frame**, and a logically
stationary image was therefore "moved" — erased and re-sent. For a full-width
screenshot that is 300–600 KB per frame. The terminal cannot absorb that at
frame rate: writes tear and land as partial images.

That is the *"the image keeps moving and the terminal becomes malformed"*
report, and the half-drawn leftovers behind it — including what looked like
stray black rectangles, which were the dark code-panel region of a torn earlier
render.

Fixed: the redraw decision uses `sameLogicalRect`. Pixels belong to buffer cells
(§5 — writing text over a sixel clears it), so the terminal scrolls them with
the text and nothing needs sending. `viewportTop` is still recorded, because the
*erase* has to know which physical rows a rectangle occupied.

### (9) `damage` forced a redraw every frame anyway

With (8) fixed the storm continued, because `!overlaps(target, damage)` was the
other half of the skip condition. `damage` is a **bounding box over everything
written anywhere in the frame** — during a streaming response it spans most of
the screen, so it always overlapped.

The precise question is *"did this frame write text into the image's rectangle,
clearing the pixels there?"* `checksumRect()` answers it directly: the cells
under a graphic are its block-glyph fallback, which changes only on re-encode,
and log-update writes a cell only when its content differs. An unchanged
checksum means those cells were not rewritten, which means the pixels survive.
`damage` is kept as a cheap pre-filter — no overlap is a certain no — and the
checksum confirms. A few thousand cell reads against hundreds of kilobytes
avoided.

### (10) Every emission was anchored to a cursor that was not there

`buildGraphicsSequence` positions draws and erases with **relative** cursor
motion, from a `cursor` argument documented as *"where the terminal cursor sits
once the frame's patches have been written."* `ink.tsx` passed `frame.cursor`
unconditionally.

That holds only when the frame **had** a text diff. The preamble that moves the
physical cursor back from the parked caret to the frame cursor is gated on
`hasDiff`, and the graphics patch is pushed before it. So on any frame where the
text diff is empty *and* a cursor is declared, the cursor was still sitting at
the prompt caret, and every move in the sequence was off by
`frame.cursor − displayCursor` — a few columns right, a few rows up.

One cause, both symptoms. The draw landed over the transcript text above its box;
the erase, using the same origin, repainted the *wrong* rectangle — scribbling
frame text into cells that did not need it while never touching the cells that
actually held the stale pixels, which is why the old copy could never be removed.

It tracked the turn exactly. `BaseTextInput` declares a caret only while the
input is focused, so during a response nothing is parked *and* every frame has a
diff; both branches agreed and the mismatch was invisible. The moment a turn
ended, the input took focus back and every empty-diff frame drew at the offset.
That is the *"the old turn got dead so the image stops"* report, and it is
literally true.

Reachable with no exotic conditions: Windows Terminal emits 2+ SIGWINCH per user
action. `handleResize` early-returns on the duplicate; `App.probeCellGeometry` is
a separate `stdout.on('resize')` listener with no such guard, so it marks the
geometry stale, announces, and `InlineImage` re-renders **identically** — a
commit with zero text patches, and an erase emitted at the wrong origin.

Fixed on both sides. `ink.tsx` computes the anchor rather than assuming it
(`hasDiff ? restingCursor : displayCursor ?? restingCursor`, where
`restingCursor` accounts for alt-screen's park patch), and
`graphicsPlacement.ts` now addresses **columns absolutely** (`CSI n G`), so only
the anchor's *row* is load-bearing at all — which also removes the pending-wrap
hazard in `repaintRect`'s per-row bookkeeping. The debug trace prints
`anchor=<row>`, because the old trace reported the *intended* rectangle and
therefore read correct on every misplaced write. That is part of why nine rounds
missed it.

True absolute addressing is not available here: Ink never learns which physical
row its output began on, and the logical→physical mapping is pinned only through
the cursor. The anchor is the mechanism, so it has to be computed, not assumed.

### (11) A resize forgot where the pixels were before knowing they were gone

`invalidateGraphicsPlacements()` means *"the terminal dropped the pixels, forget
the rectangles"* — `lastDrawn` is the only record of which cells hold stale
pixels. (5) called it on every resize, in both screen modes, **before** the
render.

On the main screen a resize clears nothing by itself. log-update decides
afterwards, and only emits `clearTerminal` when the width changed or the height
shrank; `ink.tsx` already invalidates correctly when the diff carries that patch.
So a resize that did not trigger a full reset — rows grew, width unchanged — threw
away the rectangle while the copy was still on screen, stranding it for the rest
of the session.

Split into two verbs: `invalidateGraphicsPlacements()` (pixels gone — forget) and
`forceGraphicsRedraw()` (pixels still there — redraw *and* erase properly). The
latter bumps an epoch that `DrawnRect` records, so a stale record compares as
"moved" without being discarded. `handleResize` uses it; the clearTerminal path,
`repaint()` and `resetFramesForAltScreen()` still invalidate, and all three are
preceded by an actual `ERASE_SCREEN`.

### (12) An unanswered re-measure re-enabled drawing against a known-stale size

`clearCellGeometryStale()` lifted the mark while keeping the previous
`cellPixelSize`, then announced, so every image re-encoded against it. The
placement then recorded that same wrong number, and the
`placement.cellWidth !== cell.width` guard compares two values that are wrong
together — it can never fire. On a zoom where `CSI 16 t` is dropped, the payload
overflows its box permanently. That was the residual hole in (3)'s trade.

The two errors are not symmetric: a cell guessed too **large** overflows into
cells no erase can reach, while one guessed too **small** merely leaves a ragged
edge of block glyphs and is corrected by the next probe. So the fallback is now a
*lower bound* rather than the last measurement.

The bound is sound rather than a fudge factor. The grid is recorded alongside
each measurement, and only two things produce a new grid: a **zoom**, which holds
the window and scales the cell by the inverse of the grid change, and a **drag**,
which holds the cell. Nothing local can tell them apart, but
`measured × min(1, oldGrid / newGrid)` is below both, so the payload's pixel
extent can never exceed its box. A confirmed reply restores the measurement
exactly, and repeated failures recompute from it rather than compounding.

### (13) An erase could not reach rows the frame had since dropped

`repaintClipped` clamped the erase rectangle to `screen.height` as well as to the
viewport. When the transcript shrinks, the rows an image used to cover fall
outside the frame while still being on screen — no cells to restore, so nothing
was written, so the pixels stayed. `repaintRect` now blanks a row the frame no
longer describes; the caller has already clipped to the viewport, so those rows
are Ink's own.

### (14) Recovery from a resize was a chain of edges, and every link could drop

The ghost was gone; the image still dropped to block glyphs on
minimise/maximise/zoom and **stayed there**. Nothing was drawing it wrong any
more — it was never being re-encoded at all.

Coming back from a resize required an announcement to reach `InlineImage` at a
moment when the geometry was settled. Four independent ways that failed:

1. **The stale deadline lapsed silently.** `staleUntil` is a timestamp;
   `isCellGeometryStale()` simply starts returning false when the clock passes
   it. Withholding a graphic is a decision taken while rendering, and nothing
   re-runs when a deadline expires — so the component was never told. The probe
   reply normally supplied that edge.
2. **The watchdog could not supply it either.** `STALE_TIMEOUT_MS` and
   `CELL_GEOMETRY_WATCHDOG_MS` are both 400 ms, so by the time the watchdog ran
   the mark had already lapsed: `wasStale` was false, `rescaled` was false on an
   unchanged grid, and `clearCellGeometryStale()` announced **nothing**.
3. **A coalesced probe was dropped, not deferred.** `sendCellGeometryQuery()`
   returns early while one is in flight — and both the leading-edge call and the
   150 ms trailing call hit that. A burst (any drag, and minimise/maximise/zoom
   emit several events) put the trailing probe inside the in-flight window, so
   the only measurement taken described a moment mid-resize.
4. **A dropped reply was permanent.** The watchdog released the in-flight latch
   but never re-sent, so one lost DA1 sentinel froze pixels-per-cell — and with
   it every image's size — for the session.

Fixed on all four, plus a fifth that does not depend on any of them:

- `markCellGeometryStale()` now **arms a timer at its own deadline** and
  announces when it lapses. Cancelled by any measurement, and re-armed if a
  later mark pushes the deadline out. This alone guarantees an edge within
  `STALE_TIMEOUT_MS` of every resize.
- `sendCellGeometryQuery()` records a coalesced request and re-sends it from
  `settle()`, so the query that describes where the user actually stopped always
  goes out.
- The watchdog **re-probes** instead of giving up, up to
  `MAX_CELL_GEOMETRY_ATTEMPTS`, and is cancelled on a successful settle so it
  never fires a redundant query.
- `InlineImage` **reconciles instead of waiting to be told**: when the render it
  just produced is not the one that should be on screen — geometry unsettled, or
  a payload encoded against a cell size that has since moved — it comes back and
  looks after `GRAPHICS_RETRY_MS`. Terminating by construction: both conditions
  resolve on their own, and while the reason still holds a retry costs one
  cached block render and no encode.

The deliberate omission is `!hasMeasuredCellSize()`. A terminal that advertises
sixel through DA1 but never answers `CSI 16 t` would make that condition
permanent, and retrying it would spin for the session; the startup probe's
announcement covers the real case.

### (15) Guessing a cell size from the grid ratio was worse than not drawing

(12) replaced the last measurement with `measured × min(1, oldGrid / newGrid)`
when a probe went unanswered, on the reasoning that the ratio bounds the new
cell from below and undershooting only costs a ragged edge.

The bound is sound. The premise was not. It is exact for a zoom and badly wrong
for a drag, and the error is proportional to how much the grid moved — so a
window opened small and then **maximised** scaled the cell down several times
over, clamped at the two-pixel floor. The payload then covered a fraction of the
box the layout had reserved: a small sharp image stranded in a screenful of
blank rows, which is what the user reported as "random space". Undershooting is
not a ragged edge at that magnitude; it is a hole.

Nothing local distinguishes a zoom from a drag, so the fix is to stop guessing.
A measurement is now tagged with the grid it was taken at, and
`isCellGeometryCurrent()` is false the moment the grid no longer matches;
`renderGraphicsOverlay` withholds until a reply confirms the new geometry. Block
glyphs are exact in cells by construction, so they are what stands in — and the
probe retry of (14) is what makes that a flicker rather than a downgrade.

### (16) The block render did not fill the box the graphic had chosen

The other half of the same blank space, and independent of (15). When an overlay
owns the box, `InlineImage` asked for a block render of `overlay.columns ×
overlay.rows` — but as a *maximum*, and the block fit then applied its own
rules: it assumes a cell is exactly twice as tall as it is wide, and clamps to
`DEFAULT_MAX_IMAGE_COLUMNS` (200). Both disagree with an overlay measured in real
pixels and bounded by the viewport, so the blocks landed *inside* the reserved
box and the remainder stayed blank — a strip along the bottom on any cell that
is not 1:2, a strip down the side on a terminal wider than 200 columns, and on a
tall window both at once.

Invisible while the graphic covers the box, and the whole of what is left when
it does not — which is every scrolled-away image, and every image at all while
(15) was withholding them. That is why the screenshots showed a small blurry
image above a screenful of nothing.

`renderInlineImage` now takes an `exact` box and fills it edge to edge, skipping
its own fit. The layout is then identical whether the graphic is drawn or not,
so nothing shifts when one replaces the other.

### (17) The block fallback rendered as question marks on the Windows console

Reported as "blurry" with a screenshot of cmd.exe: the picture was a field of
literal `?` characters on a grid.

`resolveGlyphMode()` returned `'quadrant'` unconditionally. The 2×2 subpixel
grid needs U+2596–U+259F, and **Consolas and Lucida Console — everything conhost
ships — do not have them.** The halves and the full block are there, which is
why only some cells came out as `?`: exactly the ones that needed a quadrant.

This is the fallback, so it is what shows for every non-sixel terminal and every
image the overlay cannot place — the most-seen renderer in the feature, rendering
as punctuation.

Now falls back to half blocks on win32 unless something is known to pick its own
font: `WT_SESSION` (Windows Terminal, also exported into WSL), `MSYSTEM` or
`TERM_PROGRAM=mintty` (Git Bash, MSYS2, Cygwin), `TERM_PROGRAM=vscode`
(xterm.js). Half blocks give up the horizontal subpixel — two per cell instead of
four — but U+2580 is in every monospace font ever shipped, including the console
raster fonts. `TAU_INLINE_IMAGE_GLYPHS=quadrant` forces them back on.

### (18) Withholding on an unconfirmed measurement was a latch

(15) refused to draw while the measurement did not describe the current grid.
That is correct in principle and a latch in practice: a terminal that stops
answering `CSI 16 t` leaves every image on block glyphs with no way back, and
"blurry forever" is the failure the user actually hits.

The asymmetry that settles it: the last measurement is **exactly right** for a
drag or a maximise, because neither touches the font. It is wrong only for a
zoom — and a zoom that went unmeasured is corrected by any later probe. So the
measurement stands, and `isCellGeometryCurrent()` now drives a **slow recheck**
instead of a refusal: while the grid does not match, App re-probes every
`CELL_GEOMETRY_RECHECK_MS`, indefinitely, cancelling itself the moment a reply
lands. Bounded to terminals that have answered at least once — one that never
has is not going to start.

### (19) The zigzag: a screen wipe cleared the row limits

(15)'s top-overflow feedback oscillated and was reverted. The cause was not the
feedback: shrinking an image is a layout change *above* the viewport, which
forces log-update into a full reset, whose `clearTerminal` patch calls
`invalidateGraphicsPlacements()` — which cleared the row limits. So the image
re-encoded at full size, overflowed, shrank, repainted, and started over.

A wipe does not change how much room a box has. Only a resize does. Row limits
now live on a **viewport epoch** started by `forceGraphicsRedraw()` alone;
`invalidateGraphicsPlacements()` drops the drawn rectangles and nothing else.

With the loop broken, the top-overflow report is safe, and it fixes the case
that produced most of the block glyphs:

```ts
if (target.y >= viewportTop && target.y + target.rows > viewportBottom)
```

`viewportBottom` is the transcript end plus one, so a box can never run past it
— that branch is unreachable on the main screen. An image too tall for the
window loses its own **top**. Nothing below it moves when it shrinks, so
removing one row lifts the transcript end by one and drops the box's top by one
relative to the viewport: shrinking to `target.y + target.rows - viewportTop`
lands the top on `viewportTop` exactly. An image genuinely scrolled into history
yields a number below `MIN_PLACEMENT_ROWS`, which `reportRowLimit` declines, so
the two cases separate themselves. One report per placement per epoch keeps a
streaming transcript from ratcheting an image smaller a paragraph at a time.

The row budget's fixed ten-row chrome allowance stops binding below a 40-row
viewport (`rows * 0.75 <= rows - 10` only when `rows >= 40`), which is why this
showed up on zoom in and on any resize that removed rows. `VIEWPORT_CHROME_ROWS`
is deliberately left at 10: the real chrome depends on the response below the
image, so the answer belongs in the feedback loop, not in a bigger guess.

### (20) `sharp` was never declared — the whole feature rode on a transitive dep

Every image path needs `getImageProcessor()`, and it resolves to `sharp`.
`sharp` appeared in **none** of `dependencies`, `optionalDependencies` or
`devDependencies`. It was present only because
`@whiskeysockets/baileys@7.0.0-rc12` — an unrelated WhatsApp library, at a
release candidate — happens to depend on it, and npm happened to hoist it.

So a user updating Tau gets images only for as long as that transitive edge
survives. When it goes, `import('sharp')` throws, and both renderers fail: no
sixel *and* no block glyphs, just the summary line. Nothing in the code says
why, because the failure is swallowed at every level.

Now declared directly at `^0.34.5`, the version that was actually in the tree.
Install size is unchanged — it was already being downloaded.

### (21) Sixel needed one capability the block renderer did not

`renderGraphicsOverlay`'s sixel branch required `ensureAlpha()` on top of the
`raw()` that the block renderer already needs, to fix the stride at four bytes
per pixel. Any pipeline that can do one and not the other therefore rendered
every image as block glyphs, silently.

That is not theoretical. Two copies of the native image library in one process —
easy to produce, and exactly what a duplicated or hoisted `sharp` gives you —
leave libvips' GObject enums registered twice, and `ensureAlpha()` then dies on
`colourspace: parameter space not set` while `raw()` sails through. Reproduced
here, and it is indistinguishable from every other cause of "it just renders
blurry".

The widening is now done in JS (`widenToRgba`, RGB/grey → RGBA). The two
renderers need exactly the same capability, so they succeed and fail together.
Every early return in `renderGraphicsOverlay` also names itself under
`tau --debug` now; they were all silent, which is most of why this took so long
to find.

---

## 3. Architecture

Two layers, deliberately:

- **Block glyphs** — `src/utils/terminalImage.ts`. Unicode quadrants, 2×2
  subpixels per cell, best two-colour split found by brute-forcing all 16
  partitions. Ordinary styled text, so it needs nothing from the renderer.
  Universal fallback, and **exact in cells by construction** — it cannot be
  wrong about geometry, which is why it is what stands in whenever the pixel
  path is uncertain.
- **Terminal graphics** — `src/utils/terminalGraphics.ts` +
  `src/ink/graphicsPlacement.ts`. Real pixels via sixel/Kitty/iTerm2, painted
  *over* layer 1.

Measured on a 3287×2023 dashboard: 338×104 subpixels vs 1400×862 real pixels
(**34×**). Typical matplotlib output (700×400) renders at native resolution.

**The graphic owns the box.** The two layers size images by different rules —
blocks stretch to the 1:2 cell and count subpixels, graphics use real pixels — so
a graphic fitted into a block-derived box is always slightly smaller than it and
the blocks show through as a ragged ASCII border. `renderGraphicsOverlay()`
derives the box; `fitGraphicsToCells()` snaps the pixel extent to exact cell
multiples. Cost: ≤1 cell of aspect rounding, under 5% at realistic sizes.

**Why graphics cannot live in the cell buffer:** `Output.write()` tokenizes SGR
into interned styles and writes grapheme clusters, so a DCS or APC payload would
be shredded. They are written *after* the frame's text patches, cursor moved to
the image origin and put back, each emission bracketed in DECSC/DECRC (`ESC 7` /
`ESC 8`) — protocols do not share cursor semantics, and Windows Terminal
advances the text cursor to the final sixel band, so a relative inverse move is
unknowable and can scroll the viewport.

Detection is runtime, never hardcoded: sixel **only** from DA1 parameter 4
(`TERM` says nothing about it), Kitty from `KITTY_WINDOW_ID`/`TERM`/
`TERM_PROGRAM`, iTerm2 from `TERM_PROGRAM`. tmux/screen excluded outright
(passthrough is per-protocol and unimplemented); VS Code's xterm.js excluded (it
would print the payload as text). `TAU_IMAGE_PROTOCOL` forces one or `off`;
`TAU_INLINE_IMAGE_ROWS` overrides the row budget.

---

## 4. Files

### New

| File | Lines | Role |
|---|---|---|
| `src/utils/terminalImage.ts` | 948 | Block renderer, colour-depth detection, LRU render cache |
| `src/utils/terminalGraphics.ts` | 591 | Protocol selection, cell geometry + staleness, encoders, Kitty ids/delete |
| `src/ink/graphicsPlacement.ts` | 610 | Placement registry, dual erase, redraw decision, row-limit feedback, tracing |
| `src/components/InlineImage.tsx` | 275 | React component; also `NotebookImages` |
| `src/utils/terminalImage.test.ts` | 1010 | 68 tests |
| `src/utils/terminalGraphics.test.ts` | 615 | 35 tests |
| `src/ink/graphicsPlacement.test.ts` | 790 | 30 tests |
| `src/services/tokenEstimation.test.ts` | 164 | 9 tests — cannot run here, see §1 |

### Modified

`src/ink/ink.tsx` (render-loop hook, invalidation on repaint/frame-reset/resize) ·
`src/ink/components/App.tsx` (capability probes, leading-edge geometry query,
watchdog) · `src/ink/parse-keypress.ts` (`pixelSize` response) ·
`src/ink/terminal-querier.ts` (query builders) ·
`src/services/tokenEstimation.ts` (§7) ·
`src/tools/FileReadTool/{UI,FileReadTool,prompt}` ·
`src/tools/BashTool/{BashToolResultMessage,prompt}` · `package.json`
(`sixel@^0.16.0`)

---

## 5. Verified terminal facts — do not re-derive

From `tmp/sixel-erase-test.mjs` and `tmp/graphics-diag.mjs` (gitignored; both
must run in a **plain terminal tab**, not inside Tau — they use raw mode).

- **Writing text over a sixel clears its pixels.** A clean gap was punched
  through a red block by writing spaces. This is load-bearing: it is why erase
  -by-repaint works at all, and why (8) concluded pixels are attached to buffer
  cells and therefore scroll with them.
- **`CSI 2 J` clears sixels.** So invalidating on a screen wipe is correct.
- **Whether a scroll carries pixels with the text is still unknown** — the test
  never forced a real scroll. §2(8) *assumes* it does, reasoning from
  cell-attachment. **If ghosting returns specifically while scrolling, this
  assumption is the first thing to test.**

Dev machine: Windows Terminal 1.24.11911.0, `TERM` unset (Windows sets none
outside MSYS/Cygwin), `WT_SESSION` set (also exported into WSL, where platform
is `linux` — so it must not be platform-guarded), DA1 `[61,4,6,…]`, cell size
10×20 px via `CSI 16 t`.

---

## 6. Debugging

`buildGraphicsSequence()` is instrumented, debug-gated, free when off. Run
`tau --debug`, reproduce, and read the `graphics:` lines:

```
graphics: 1 placement(s) — draw inline-image-0 at 4,20 vt=5 anchor=29 118x30 moved=true
graphics: 1 placement(s) — skip inline-image-0: cell geometry stale, awaiting re-measure
graphics: 1 placement(s) — skip inline-image-0: rows 20-50 outside viewport 5-29
graphics: 1 placement(s) — skip inline-image-0: box 40x20 smaller than payload 118x30
graphics: 2 placement(s) — draw inline-image-0 … | draw inline-image-1 …
```

Each `skip` names which gate fired, which turns a report into one line instead
of a hypothesis. `anchor=` is the row every move in that sequence was measured
from; if it is not the row the frame ended on, the image is being drawn at an
offset and the erase is missing by the same amount (§2(10)). The rest of the
trace reports the *intended* rectangle, so it reads correct either way. **`2 placement(s)` for one image** means two components mounted
— `renderToolResultMessage` has two call sites,
`UserToolSuccessMessage.tsx:65` and `CollapsedReadSearchContent.tsx:116` — and
no erase can fix that.

---

## 7. Separate bug, already fixed: an image read cost 10–40× the context it should

Reported as *"when it's displayed there is a huge context window, 31k"*. Real,
and nothing to do with rendering.

`roughTokenCountEstimationForRawBlock()` is what the context analyzers use
(`utils/contextAnalysis.ts:111`, `utils/analyzeContext.ts:825,856` — these feed
`/context` and the context meter). It checked `isMediaBlock(block)` and
otherwise fell through to `roughTokenCountEstimation(jsonStringify(block))`.

`isMediaBlock` matches a block whose **own** type is `image`/`document`. What
`FileReadTool` returns for a PNG is a `tool_result` whose `content` array
*contains* an image block — so the check missed it and the catch-all stringified
the entire base64 payload at 4 bytes per token. Measured on real files here:

| File | Size | Old estimate | Actual | Ratio |
|---|---|---|---|---|
| `tmp/plot.png` (matplotlib) | 256 KB | 87,370 | 2,000 | 43× |
| `Logo.png` | 2,035 KB | 694,674 | 2,000 | 347× |
| `tau_docs.PNG` | 20 KB | 6,847 | 2,000 | 3.4× |

31k corresponds to a ~91 KB image — an ordinary plot screenshot.

The private `roughTokenCountEstimationForBlock()` in the same file already
recursed into `tool_result` correctly, and is what the compact path uses — which
is why auto-compact behaved while `/context` did not. The public raw-block
variant now delegates to it instead of re-deciding.
`roughTokenCountEstimation()` gained a `typeof` guard, since it is now reachable
from unvalidated transcript blocks where `{type:'text'}` with no `text` would
have thrown.

---

## 8. Known limits and next steps

- **Partly-offscreen images are still withheld**, now with the row-limit
  feedback of §2(7) to recover. An image scrolled off the *top* correctly falls
  back to blocks; nothing can address those rows.
- **Payload size.** A full-window sixel is ~750 KB. §2(9) makes redraws rare,
  but a real move still re-sends everything. Next step: transmit-once placement
  for Kitty (`a=t` then `a=p`), which sixel cannot do. Kitty's **Unicode
  placeholders** (`U=1` + `U+10EEEE` with diacritic-encoded row/column) would go
  further — the image becomes text-cell content and the terminal handles scroll,
  reflow and erase natively, deleting most of `graphicsPlacement.ts`. Only worth
  it once a Kitty-family terminal is actually being targeted.
- **tmux/screen unsupported** — needs per-protocol passthrough wrapping.
- **No live-process capture.** A plot must reach a file, a data URI, or a
  notebook. A figure existing only inside a running process would need a
  persistent Python kernel; judged not worth the crash/staleness risk.
- **`src/tools/REPLTool/REPLTool.ts` does not exist.** REPL mode is dead code
  gated on `USER_TYPE === 'ant'`. It is a JS VM sandbox, **not** a Python REPL —
  do not be misled by the name.
- **The collapse trap.** Image and notebook reads must be excluded from
  `isSearchOrReadCommand` in `FileReadTool.ts`, or they fold into a "read 1
  file" summary and `InlineImage` never mounts. This has regressed once.
