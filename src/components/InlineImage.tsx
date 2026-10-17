import { Buffer } from 'buffer'
import * as React from 'react'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useSettings } from '../hooks/useSettings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { DOMElement } from '../ink/dom.js'
import {
  getDrawnGraphicsSequence,
  getGraphicsConstraintGeneration,
  getGraphicsOutputBacklog,
  getPlacementRowLimit,
  requestGraphicsFrame,
  setGraphicsPlacement,
  subscribeGraphicsConstraints,
  subscribeGraphicsDrawn,
  swapGraphicsFrame,
} from '../ink/graphicsPlacement.js'
import { Box, RawAnsi, Text } from '../ink.js'
import type { GraphicsOverlay } from '../utils/terminalGraphics.js'
import {
  allocateKittyImageId,
  getCellPixelSize,
  getGraphicsGeneration,
  hasMeasuredCellSize,
  isCellGeometryStale,
  isLegacyConsoleHost,
  renderGraphicsOverlay,
  resolveGraphicsProtocol,
  subscribeGraphicsCapability,
} from '../utils/terminalGraphics.js'
import {
  type AnimationInfo,
  AnimationFrames,
  AnimationPlayer,
  animatedCellLimit,
  encodeITerm2Animation,
  findAnimation,
  planFrames,
} from '../utils/terminalAnimation.js'
import {
  type InlineImage as RenderedImage,
  maxRowsForViewport,
  renderInlineImage,
} from '../utils/terminalImage.js'
import {
  applyWithBatch,
  beginImageRender,
  createImageRenderToken,
  endImageRender,
} from './inlineImageBatch.js'

/** Distinguishes concurrent placements; only needs to be unique per process. */
let nextPlacementId = 0

/**
 * Left gutter of the transcript response rail, plus a little breathing room, so
 * a full-width image is not clipped by the frame it sits in.
 */
const TRANSCRIPT_GUTTER_COLUMNS = 8

/**
 * How long to wait before looking again when a graphic was withheld.
 *
 * Short enough that the block fallback reads as a flicker during a resize
 * rather than a downgrade, long enough that a drag does not re-encode per
 * frame — and while the reason still holds, a retry costs one cached block
 * render and no encode at all.
 */
const GRAPHICS_RETRY_MS = 120

/**
 * Shown under a block render that an old Windows ConPTY forced. Without it the
 * downgrade is silent, and the fix is outside Tau: the terminal has to ship a
 * ConPTY that passes image data through.
 */
const LEGACY_CONSOLE_HOST_HINT =
  'Blocky preview: an old Windows ConPTY drops image data. Use WezTerm nightly or Windows Terminal 1.22+ for real images.'

/** The mounted image carrying that hint; one in the transcript is enough. */
let legacyHintOwner: string | null = null

type Props = {
  /** Base64-encoded image bytes, as produced by the read tools. */
  base64: string
  /**
   * The summary line this preview accompanies (file size and so on). Rendered
   * on its own when the image cannot be shown, and above it when it can.
   */
  children: React.ReactNode
  maxRows?: number
  /**
   * The file the image was read from, and its size when read, for an animated
   * GIF or WebP whose `base64` may be a still: a read sends the model only its
   * image budget, so a larger file reaches the transcript as one frame. Read
   * again for the screen alone, and only while it is still that size. Two
   * primitives rather than an object, so a parent that rebuilds its JSX on
   * every render does not restart the render below on every one.
   */
  sourcePath?: string
  sourceSize?: number
}

/**
 * Renders an image inline in the transcript, above its summary line.
 *
 * Decoding is asynchronous — the image processor is an optional native module
 * loaded on demand — so the summary alone is what shows on the first paint, and
 * all that shows whenever rendering is unavailable: a terminal without enough
 * color depth, a build without the processor, or a file that fails to decode.
 * There is deliberately no spinner; for a file already on disk the decode lands
 * within a frame or two, and a placeholder would be noisier than the line it
 * would replace.
 */
export function InlineImage({
  base64,
  children,
  maxRows,
  sourcePath,
  sourceSize,
}: Props): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const settings = useSettings()
  // `/config` → "Display images". Off means the summary line stands alone: no
  // decode, no encode, no placement — and any graphic already on screen is
  // taken down, because unmounting the box below unregisters the placement and
  // the renderer erases the pixels it recorded for it on the next frame.
  const imagesEnabled = settings.inlineImagesEnabled !== false
  // `/config` → "Animate images", which only means anything under Display
  // images. Reduced motion stills animations here as it does the spinner. Off,
  // an animated file shows its first frame exactly as any still would: no
  // frames made, nothing swapped, and the full-size box a still gets.
  const animationsEnabled =
    imagesEnabled &&
    settings.inlineImagesAnimated !== false &&
    settings.prefersReducedMotion !== true
  const [image, setImage] = useState<RenderedImage | null>(null)
  const [overlay, setOverlay] = useState<GraphicsOverlay | null>(null)
  // What the overlay is the first frame of, when there is something to play.
  const [animation, setAnimation] = useState<{
    data: Buffer
    info: AnimationInfo
  } | null>(null)
  // Reconciliation, not an edge. Every reason a graphic is withheld is
  // temporary — a resize is in flight, the first geometry probe has not
  // answered, the measurement moved while this was encoding — but each is
  // announced by something that can be dropped: a reply lost in a resize burst,
  // a probe coalesced into one already out, a deadline that lapses with nobody
  // watching the clock. Waiting to be told is what left an image on block
  // glyphs for the rest of the session after a zoom. Instead, when the render
  // that just finished is not the one that should be on screen, come back and
  // look. The condition is self-limiting: it can only hold while the geometry
  // is unsettled, and that has a deadline of its own.
  const [withheld, setWithheld] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // Both dimensions are dependencies: a resize re-renders the image to the new
  // window rather than letting the previous block wrap or clip.
  const maxColumns = Math.max(1, columns - TRANSCRIPT_GUTTER_COLUMNS)
  // Aspect ratio couples the axes, so a row budget that ignores the window
  // silently caps width too. Scale with the viewport unless a caller pins it.
  const rowBudget = maxRows ?? maxRowsForViewport(rows)

  const placementId = useRef<string | null>(null)
  if (placementId.current === null) {
    placementId.current = `inline-image-${nextPlacementId++}`
  }
  // One Kitty id for the life of this image. Re-encoding the same pixels then
  // yields the same payload, which is not mistaken for a different image — a
  // fresh id per encode made every resize or re-measure look like a change.
  const kittyImageId = useRef<number | null>(null)
  if (kittyImageId.current === null) {
    kittyImageId.current = allocateKittyImageId()
  }
  // This image's identity among renders landing together; see inlineImageBatch.
  const renderToken = useRef<number | null>(null)
  if (renderToken.current === null) {
    renderToken.current = createImageRenderToken()
  }
  // Whether the render started by the effect below has yet to land.
  const renderPending = useRef(false)
  // How many rows the renderer found available last time this image was too
  // tall to draw. Without it the component would keep re-encoding the same
  // oversized box, be withheld every frame, and leave the block-glyph fallback
  // standing for good.
  const constraintGeneration = useSyncExternalStore(
    subscribeGraphicsConstraints,
    getGraphicsConstraintGeneration,
    getGraphicsConstraintGeneration,
  )
  const rowLimit = getPlacementRowLimit(placementId.current)
  const effectiveRowBudget =
    rowLimit === undefined ? rowBudget : Math.min(rowBudget, rowLimit)
  const boxRef = useRef<DOMElement | null>(null)
  // The capability probes resolve a round-trip after startup, and cell geometry
  // is re-measured on every resize. Tracking their generation means an image
  // encoded against stale information re-encodes as soon as better arrives,
  // instead of staying wrong for the rest of the session.
  const capabilityGeneration = useSyncExternalStore(
    subscribeGraphicsCapability,
    getGraphicsGeneration,
    getGraphicsGeneration,
  )

  useEffect(() => {
    const token = renderToken.current!
    if (!imagesEnabled) {
      // Clearing the state is what removes the box, and removing the box is
      // what erases the pixels. Doing it here rather than by returning early
      // from render keeps the hook order stable.
      setImage(null)
      setOverlay(null)
      setAnimation(null)
      setWithheld(false)
      return
    }
    // Guards a setState after unmount, and an earlier decode resolving after a
    // later one and overwriting it.
    let active = true
    renderPending.current = true
    // Registered in the effect, never during render: a render React throws away
    // would leave an entry nothing ends, and every image would wait out the cap.
    beginImageRender(token)
    void (async () => {
      try {
        let data: Buffer = Buffer.from(base64, 'base64')

        // Graphics first, because when available it owns the box. The two
        // renderers size images by different rules — blocks stretch to the 1:2
        // cell and count subpixels, graphics use real pixels — so letting the
        // block render choose leaves the graphic smaller than the box it
        // covers, and the blocks show through around its edges as a ragged
        // ASCII border. Deriving the box from the graphic and rendering blocks
        // *into* it keeps the fallback while guaranteeing exact coverage.
        const protocol = resolveGraphicsProtocol()
        const wantsGraphics = protocol !== 'none'
        // Asked and answered before spending anything on an encode that
        // `renderGraphicsOverlay` would refuse anyway — and, unlike its own
        // guard, visible here, so the retry below knows the fallback standing
        // in is temporary.
        const unsettled =
          wantsGraphics && hasMeasuredCellSize() && isCellGeometryStale()

        // Only pixels animate. The block render is text, and text changing in
        // rows already in scrollback costs a full terminal reset every frame,
        // so it stays the first frame; without a protocol nothing is looked
        // for at all, and the still is all there is.
        const animated =
          animationsEnabled && wantsGraphics && !unsettled
            ? await findAnimation(
                data,
                sourcePath !== undefined && sourceSize !== undefined
                  ? { path: sourcePath, size: sourceSize }
                  : undefined,
                protocol,
              )
            : null
        if (!active) return
        // Drawn from the file every later frame comes from, so the still put
        // up first is exactly the animation's first frame.
        if (animated !== null) data = animated.data
        // A frame is encoded and written many times a second, so its box is
        // capped where a still's is not. iTerm2 plays the file itself.
        const frameLimit =
          animated !== null && protocol !== 'iterm2' && hasMeasuredCellSize()
            ? animatedCellLimit(
                animated.info.width,
                animated.info.height,
                getCellPixelSize(),
                protocol,
              )
            : null

        let overlay =
          !wantsGraphics || unsettled
            ? null
            : await renderGraphicsOverlay(
                data,
                frameLimit === null
                  ? maxColumns
                  : Math.min(maxColumns, frameLimit.columns),
                frameLimit === null
                  ? effectiveRowBudget
                  : Math.min(effectiveRowBudget, frameLimit.rows),
                undefined,
                kittyImageId.current!,
              )
        if (!active) return
        if (
          overlay !== null &&
          animated !== null &&
          overlay.protocol === 'iterm2'
        ) {
          const played = encodeITerm2Animation(
            animated.data,
            animated.info,
            overlay.columns,
            overlay.rows,
          )
          if (played !== null) overlay = { ...overlay, sequence: played }
        }
        // Kitty and sixel play by having frames swapped in; see below.
        const playable =
          overlay !== null &&
          animated !== null &&
          (overlay.protocol === 'kitty' || overlay.protocol === 'sixel')

        // With a graphic the box is already chosen, and the blocks have to fill
        // it exactly: they are what shows whenever the overlay is withheld, and
        // any rectangle they leave over is blank screen rather than image.
        const rendered = await renderInlineImage(
          data,
          overlay === null
            ? { maxColumns, maxRows: effectiveRowBudget }
            : {
                maxColumns: overlay.columns,
                maxRows: overlay.rows,
                exact: { columns: overlay.columns, rows: overlay.rows },
              },
        )
        if (!active) return
        // Encoding is asynchronous, so a zoom can land inside it and leave the
        // payload already the wrong size for its box. The renderer withholds a
        // placement whose geometry disagrees with the current cell, which is
        // correct and would otherwise stand until something else happened to
        // announce. One more pass settles it.
        const cell = getCellPixelSize()
        const outdated =
          overlay !== null &&
          (overlay.cellWidth !== cell.width || overlay.cellHeight !== cell.height)
        // Lands together with the other images rendering right now, so a batch
        // of reads, or every image re-encoding after a resize, changes the
        // transcript once instead of once per image.
        applyWithBatch(token, () => {
          if (!active) return
          renderPending.current = false
          setImage(rendered)
          setOverlay(rendered ? overlay : null)
          setAnimation(rendered && playable ? animated : null)
          setWithheld(rendered !== null && (unsettled || outdated))
        })
      } catch {
        // renderInlineImage already swallows decode failures; this only catches
        // a malformed base64 payload. The summary line stands on its own.
        if (!active) return
        renderPending.current = false
        endImageRender(token)
        setImage(null)
        setOverlay(null)
        setAnimation(null)
        setWithheld(false)
      }
    })()
    return () => {
      active = false
      renderPending.current = false
      endImageRender(token)
    }
  }, [
    base64,
    maxColumns,
    effectiveRowBudget,
    capabilityGeneration,
    constraintGeneration,
    attempt,
    imagesEnabled,
    animationsEnabled,
    sourcePath,
    sourceSize,
  ])

  // The other half of the reconciliation above. Terminates by construction:
  // `withheld` can only be true while the cell geometry is unsettled or a
  // payload disagrees with it, and both resolve on their own — the stale mark
  // carries a deadline, and a re-encode against the current cell matches it.
  //
  // It only looks again once nothing is still rendering. A render under way
  // lands by itself, and restarting it throws its encode away: after a resize,
  // every encode slower than the retry interval was restarted over and over,
  // and the images stayed blocky for seconds.
  useEffect(() => {
    if (!withheld || !imagesEnabled) return
    let timer: ReturnType<typeof setTimeout>
    const retry = (): void => {
      if (renderPending.current) {
        timer = setTimeout(retry, GRAPHICS_RETRY_MS)
        return
      }
      setAttempt(n => n + 1)
    }
    timer = setTimeout(retry, GRAPHICS_RETRY_MS)
    return () => clearTimeout(timer)
  }, [withheld, attempt, imagesEnabled])

  // Behind an old Windows ConPTY the block render is all there will ever be.
  // Say why under one image, claimed in an effect so an abandoned render cannot
  // hold the hint, and released on unmount so a later image can take it over.
  const blockedByConsoleHost =
    imagesEnabled && image !== null && overlay === null && isLegacyConsoleHost()
  const [ownsLegacyHint, setOwnsLegacyHint] = useState(false)
  useEffect(() => {
    if (!blockedByConsoleHost) return
    const id = placementId.current!
    if (legacyHintOwner !== null && legacyHintOwner !== id) return
    legacyHintOwner = id
    setOwnsLegacyHint(true)
    return () => {
      if (legacyHintOwner === id) legacyHintOwner = null
      setOwnsLegacyHint(false)
    }
  }, [blockedByConsoleHost])

  // Register the encoded payload for the renderer to draw over the box above.
  useLayoutEffect(() => {
    const id = placementId.current!
    const node = boxRef.current
    if (!overlay || !node) {
      setGraphicsPlacement(id, null)
      return
    }
    // Register during the layout phase. Ink defers its terminal frame to a
    // microtask after layout effects, while passive effects run later. A
    // passive registration can therefore miss the only frame caused by this
    // state update and leave the block fallback visible until some unrelated
    // animation happens to repaint the transcript.
    //
    // Use the geometry captured by the encoder rather than reading it again
    // here. Zoom can land between encode and commit; relabelling an old-sized
    // payload with the new cell size would defeat the placement guard.
    setGraphicsPlacement(id, {
      node,
      sequence: overlay.sequence,
      // The encode every frame of an animation belongs to. For a still it is
      // the payload itself, which is what an identity left unset means anyway.
      identity: overlay.sequence,
      eraseSequence: overlay.eraseSequence,
      rows: overlay.rows,
      columns: overlay.columns,
      cellWidth: overlay.cellWidth,
      cellHeight: overlay.cellHeight,
    })
    return () => {
      setGraphicsPlacement(id, null)
    }
  }, [overlay])

  // Plays an animation into the placement registered above: same box, same
  // cell geometry, same Kitty id, frame after frame. It lives exactly as long
  // as the overlay it is the animation of, so a re-encode — a resize, a new
  // measurement, the setting turned off — always starts over from a still that
  // matches. Nothing here re-renders React per frame: frames are swapped into
  // the placement and Ink is asked for a frame directly.
  //
  // A layout effect, like the registration, and for the same reason: every
  // layout cleanup in a commit runs before any layout setup. A passive one left
  // the old player alive past the new registration, and a re-encode identical
  // to the last carries the same identity, so its next frame was accepted into
  // the new placement — whose player then waited for a still no longer there.
  useLayoutEffect(() => {
    if (!overlay || !animation || !animationsEnabled) return
    if (overlay.protocol !== 'kitty' && overlay.protocol !== 'sixel') return
    const id = placementId.current!
    const identity = overlay.sequence
    const plan = planFrames(animation.info)
    const frames = new AnimationFrames(
      animation.data,
      plan,
      {
        protocol: overlay.protocol,
        columns: overlay.columns,
        rows: overlay.rows,
        pixelWidth: overlay.pixelWidth,
        pixelHeight: overlay.pixelHeight,
        kittyImageId: kittyImageId.current ?? undefined,
      },
      overlay.sequence,
    )
    const player = new AnimationPlayer({
      frames,
      delays: plan.delays,
      loop: plan.loop,
      poster: overlay.sequence,
      swap: sequence =>
        swapGraphicsFrame(id, identity, {
          sequence,
          eraseSequence: overlay.eraseSequence,
        }),
      drawn: () => getDrawnGraphicsSequence(id),
      requestFrame: requestGraphicsFrame,
      backlog: getGraphicsOutputBacklog,
      release: () => frames.release(),
    })
    // Subscribed before starting, so a draw landing in between is not missed;
    // `start` also looks for itself, for one that landed before this ran.
    const unsubscribe = subscribeGraphicsDrawn(id, () => player.drawn())
    player.start()
    return () => {
      unsubscribe()
      player.stop()
      frames.release()
    }
  }, [overlay, animation, animationsEnabled])

  if (!imagesEnabled || !image) return children

  return (
    <Box flexDirection="column">
      {children}
      {/* Sized to the graphic when there is one, so the reserved cells and the
          pixels drawn over them are the same box — no block glyphs peeking out
          along the edges. Without a graphic the block render sizes itself. */}
      <Box
        ref={boxRef}
        width={overlay?.columns}
        height={overlay?.rows}
        flexShrink={0}
      >
        <RawAnsi lines={image.lines} width={image.columns} />
      </Box>
      {ownsLegacyHint && blockedByConsoleHost && (
        <Text dimColor>{LEGACY_CONSOLE_HOST_HINT}</Text>
      )}
    </Box>
  )
}

/**
 * How many plots one notebook read previews. A notebook of training curves can
 * hold dozens of figures; rendering them all would bury the rest of the
 * transcript.
 */
const MAX_NOTEBOOK_PREVIEWS = 4

/** Shorter than a standalone image read, since several may stack. */
const NOTEBOOK_PREVIEW_ROWS = 24

/**
 * Structural shape of the notebook cell outputs read below.
 *
 * Declared locally and guarded at runtime because `src/types/notebook.js` is
 * absent from this tree — importing the nominal types would not compile, and
 * the payload arrives from a parsed `.ipynb` on disk, so it is untrusted
 * regardless.
 */
type NotebookCellLike = {
  outputs?: ReadonlyArray<
    { image?: { image_data?: unknown } | undefined } | undefined
  >
}

/** Base64 payloads of the first `limit` image outputs across all cells. */
export function collectNotebookImages(
  cells: readonly NotebookCellLike[] | undefined,
  limit: number = MAX_NOTEBOOK_PREVIEWS,
): string[] {
  const found: string[] = []
  for (const cell of cells ?? []) {
    for (const output of cell?.outputs ?? []) {
      const data = output?.image?.image_data
      if (typeof data === 'string' && data.length > 0) {
        found.push(data)
        if (found.length >= limit) return found
      }
    }
  }
  return found
}

/**
 * Renders the figures a notebook's cells already carry, beneath its summary.
 *
 * Jupyter stores executed plot output as a base64 `image/png` bundle inside the
 * `.ipynb` itself, so a matplotlib figure is displayable straight from a read —
 * nothing has to be re-executed or saved to a file first.
 */
export function NotebookImages({
  cells,
  children,
}: {
  cells: readonly NotebookCellLike[] | undefined
  children: React.ReactNode
}): React.ReactNode {
  const imagesEnabled = useSettings().inlineImagesEnabled !== false
  const images = useMemo(() => collectNotebookImages(cells), [cells])
  if (!imagesEnabled || images.length === 0) return children

  return (
    <Box flexDirection="column">
      {children}
      {images.map((base64, index) => (
        <InlineImage
          // Payload length disambiguates distinct figures at the same index
          // across re-renders; the index alone would reuse a stale decode.
          key={`${index}:${base64.length}`}
          base64={base64}
          maxRows={NOTEBOOK_PREVIEW_ROWS}
        >
          {null}
        </InlineImage>
      ))}
    </Box>
  )
}
