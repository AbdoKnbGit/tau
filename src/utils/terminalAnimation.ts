import { Buffer } from 'buffer'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fsOperations.js'
import {
  type CellPixelSize,
  encodeITerm2Graphics,
  encodeKittyGraphics,
  encodeSixelGraphics,
  type GraphicsProtocol,
  widenToRgba,
} from './terminalGraphics.js'

/**
 * Animated GIF and WebP on the inline image graphics path.
 *
 * Only pixels animate. The block-glyph render under a graphic stays frame one
 * for good: it is text, and text that changes in a row already in scrollback
 * costs log-update a full terminal reset — once per frame, for as long as the
 * animation runs. So the cells never change, the graphic over them does, and a
 * terminal without a pixel protocol shows the still it always showed.
 *
 * Kitty and sixel get every frame written into the image's placement
 * (`swapGraphicsFrame`). iTerm2 plays a GIF by itself, so it is handed the file
 * once and no frame is ever swapped there.
 *
 * Frames are made at the box's exact pixel size, a chunk of pages at a time.
 * libvips decodes these formats front to back — a single page costs every page
 * before it, measured 12 ms for the first page of a 36-frame clip and 36 ms for
 * its last — while decoding the whole file at once holds every frame in memory.
 * A chunk bounds both.
 */

/** Frames a file may have and still animate. */
const MAX_SOURCE_FRAMES = 1000

/**
 * Pixels a first pass over a file may decode, counting every page a chunk
 * decodes again on its way to its own.
 *
 * libvips starts every chunk from the file's first frame, so a long file costs
 * far more than its pixels. Measured at ~2.4 ns a pixel: a 520-frame 1200×644
 * screen recording decodes in ~5 s with 54-page chunks and ~14 s with 12-page
 * ones. Counting total pixels instead turned that recording away by half a
 * percent while letting through shorter files that cost more.
 */
const MAX_DECODE_PIXELS = 4_000_000_000

/**
 * Frames played. A longer file plays every n-th frame, each held for the frames
 * it stands in for, so it keeps its running time.
 */
export const MAX_ANIMATION_FRAMES = 240

/**
 * Pixels in one animated frame, by protocol.
 *
 * Every frame is encoded and written, and costs bytes in proportion to its
 * pixels and to the colours in it. Sixel is the dear one. Measured on a
 * 1200×644 screen recording: a 770×400 sixel frame is ~650 KB and ~210 ms of
 * encoding, a 560×300 one ~260 KB and ~75 ms; the same 770×400 frame as a
 * Kitty PNG is ~390 KB. Synthetic test images are nearly ten times cheaper
 * than that, which is why these are set from real content.
 */
const MAX_ANIMATED_PIXELS_SIXEL = 160_000
const MAX_ANIMATED_PIXELS_OTHER = 240_000

export function maxAnimatedPixels(protocol: GraphicsProtocol): number {
  return protocol === 'sixel' ? MAX_ANIMATED_PIXELS_SIXEL : MAX_ANIMATED_PIXELS_OTHER
}

/**
 * Encoded frames one animation keeps, in characters of payload. The 520-frame
 * recording above, every third frame at sixel's box, needs ~41 MB of it.
 */
const MAX_FRAME_CACHE_CHARS = 64 * 1024 * 1024

/**
 * Decoded pixels held at once while frames are being made. Large on purpose:
 * every chunk re-decodes the pages before it, so fewer, bigger chunks cut a
 * long file's decoding by more than half. Frames a chunk only passes through
 * are let go as soon as it is decoded.
 */
const CHUNK_BYTES = 64 * 1024 * 1024

/** The largest file read back from disk to animate a read. */
export const MAX_ANIMATION_SOURCE_BYTES = 32 * 1024 * 1024

/**
 * The largest GIF handed to iTerm2 to play. It is a payload like any other —
 * sent again with its rows on a full reset — so it is held to what a still
 * costs at most, not to what a file may be.
 */
const MAX_ITERM2_GIF_BYTES = 6 * 1024 * 1024

/** Disk reads kept for animations, so a resize does not read the file again. */
const SOURCE_CACHE_LIMIT = 3

/** What browsers show a frame for when the file asks for no delay at all. */
const DEFAULT_FRAME_DELAY_MS = 100
/** A frame cannot go out faster than Ink draws them. */
const MIN_FRAME_DELAY_MS = 20
const MAX_FRAME_DELAY_MS = 60_000

/** First retry while the terminal still has frames to take, then doubling. */
const BACKLOG_RETRY_MIN_MS = 16
const BACKLOG_RETRY_MAX_MS = 250

/**
 * How long a player waits for its frame to be drawn before giving its encoded
 * frames back. An animation in scrollback never is again, and one scrolled out
 * of a fullscreen view may not be for a long time; both are made again, lazily,
 * from the first draw that resumes them.
 */
const RELEASE_AFTER_MS = 15_000

export type AnimationInfo = {
  readonly format: 'gif' | 'webp'
  /** Frames in the file. */
  readonly pages: number
  /** One frame, in pixels. */
  readonly width: number
  readonly height: number
  /** How long each frame shows, in milliseconds. */
  readonly delays: readonly number[]
  /** Times the whole animation plays; 0 for forever. */
  readonly loop: number
}

/** The subset of the image processor this module uses; see `terminalImage.ts`. */
type AnimationSharp = {
  metadata(): Promise<{
    format?: string
    width?: number
    height?: number
    pages?: number
    delay?: number[]
    loop?: number
  }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string },
  ): AnimationSharp
  raw(): AnimationSharp
  png(): AnimationSharp
  toBuffer(options?: {
    resolveWithObject?: boolean
  }): Promise<
    | Buffer
    | { data: Buffer; info: { width: number; height: number; channels: number } }
  >
}

type AnimationProcessor = (
  input: Buffer,
  options?: {
    page?: number
    pages?: number
    raw?: { width: number; height: number; channels: number }
  },
) => AnimationSharp

async function processor(): Promise<AnimationProcessor> {
  return (await getImageProcessor()) as unknown as AnimationProcessor
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Whether the bytes start like a GIF or a WebP file.
 *
 * Checked before anything is decoded, so every other image — every PNG plot,
 * every screenshot — costs nothing at all here.
 */
export function mayBeAnimated(data: Buffer): boolean {
  if (data.length < 12) return false
  const gif = data.toString('latin1', 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return true
  return (
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  )
}

/**
 * How long a frame shows, from what the file says.
 *
 * Zero, or anything up to 10 ms, is what encoders write for "as fast as you
 * can", and browsers show it for 100 ms.
 */
export function normalizeFrameDelay(ms: unknown): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 10) {
    return DEFAULT_FRAME_DELAY_MS
  }
  return Math.min(MAX_FRAME_DELAY_MS, Math.max(MIN_FRAME_DELAY_MS, Math.round(ms)))
}

/**
 * The animation in an image, or null when there is none to play.
 *
 * Never throws: an image that cannot be probed is shown as the still it is.
 */
export async function probeAnimation(
  data: Buffer,
): Promise<AnimationInfo | null> {
  if (!mayBeAnimated(data)) return null
  try {
    const metadata = await (await processor())(data).metadata()
    const { format, pages, width, height } = metadata
    if (format !== 'gif' && format !== 'webp') return null
    if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 2) {
      return null
    }
    if (!isPositive(width) || !isPositive(height)) return null
    if (pages > MAX_SOURCE_FRAMES) {
      logForDebugging(
        `terminalAnimation: ${pages} frames is more than ${MAX_SOURCE_FRAMES} — ` +
          'showing the first frame',
      )
      return null
    }
    const declared = Array.isArray(metadata.delay) ? metadata.delay : []
    const delays = Array.from({ length: pages }, (_, i) =>
      normalizeFrameDelay(declared[i]),
    )
    const loop =
      typeof metadata.loop === 'number' &&
      Number.isInteger(metadata.loop) &&
      metadata.loop >= 0
        ? metadata.loop
        : 0
    return { format, pages, width, height, delays, loop }
  } catch (error) {
    logForDebugging(
      `terminalAnimation: probe failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}

export type FramePlan = {
  /** The page of the file each frame played comes from; the first is page 0. */
  readonly pages: readonly number[]
  /** How long each frame played shows, in milliseconds. */
  readonly delays: readonly number[]
  readonly loop: number
}

/** The frames to play, every n-th one when the file has more than `maxFrames`. */
export function planFrames(
  info: AnimationInfo,
  maxFrames: number = MAX_ANIMATION_FRAMES,
): FramePlan {
  const step = Math.max(1, Math.ceil(info.pages / Math.max(1, maxFrames)))
  const pages: number[] = []
  const delays: number[] = []
  for (let page = 0; page < info.pages; page += step) {
    pages.push(page)
    let held = 0
    for (let p = page; p < Math.min(info.pages, page + step); p++) {
      held += info.delays[p] ?? DEFAULT_FRAME_DELAY_MS
    }
    delays.push(Math.min(MAX_FRAME_DELAY_MS, held))
  }
  return { pages, delays, loop: info.loop }
}

/**
 * Pixels a first pass decodes, every chunk's re-decoded lead-in included, with
 * frames at `protocol`'s largest box. A smaller box fits more pages in a chunk,
 * so this is the most it can cost.
 */
export function decodePixels(
  info: Pick<AnimationInfo, 'pages' | 'width' | 'height'>,
  protocol: GraphicsProtocol,
  chunkBytes: number = CHUNK_BYTES,
): number {
  const perChunk = Math.max(
    1,
    Math.floor(chunkBytes / (maxAnimatedPixels(protocol) * 4)),
  )
  const chunks = Math.ceil(info.pages / perChunk)
  // Chunk c decodes the c × perChunk pages before it, then its own.
  return (
    info.width * info.height * ((perChunk * chunks * (chunks - 1)) / 2 + info.pages)
  )
}

/** Whether playing `info` stays within {@link MAX_DECODE_PIXELS}. */
export function isAffordable(
  info: Pick<AnimationInfo, 'pages' | 'width' | 'height'>,
  protocol: GraphicsProtocol,
): boolean {
  return decodePixels(info, protocol) <= MAX_DECODE_PIXELS
}

/**
 * The most cells an animated image's box may take, so that one frame stays
 * within {@link maxAnimatedPixels}; null when the image is within it already.
 *
 * Sixel draws pixels one to one, so the cap has to shrink the box itself, not
 * the frames inside it. Every protocol's frames fill the box exactly, which
 * keeps the still drawn first and the frames after it the same size. A small
 * animation is boxed exactly as the same still would be.
 */
export function animatedCellLimit(
  width: number,
  height: number,
  cell: CellPixelSize,
  protocol: GraphicsProtocol,
): { columns: number; rows: number } | null {
  if (!isPositive(width) || !isPositive(height)) return null
  const area = width * height
  const cap = maxAnimatedPixels(protocol)
  if (area <= cap) return null
  const scale = Math.sqrt(cap / area)
  return {
    columns: Math.max(1, Math.floor((width * scale) / cell.width)),
    rows: Math.max(1, Math.floor((height * scale) / cell.height)),
  }
}

/**
 * The payload iTerm2 plays by itself: the GIF, stretched over the box.
 *
 * iTerm2 documents animated GIF support for inline images; WebP is left to the
 * still. Null when the file is too large to be re-sent with its rows.
 */
export function encodeITerm2Animation(
  data: Buffer,
  info: AnimationInfo,
  columns: number,
  rows: number,
): string | null {
  if (info.format !== 'gif' || data.length > MAX_ITERM2_GIF_BYTES) return null
  return encodeITerm2Graphics(data.toString('base64'), columns, rows, false)
}

/** Disk reads made for animations, newest last. */
const sourceCache = new Map<string, Buffer | null>()

/**
 * The animated file behind a read, when the read carries only a still of it.
 *
 * The Read tool sends the model no more than its image budget, so a GIF past a
 * hundred-odd kilobytes reaches the transcript recompressed to one frame. The
 * file is still on disk, and is read again for the screen only — never for the
 * model — when it is exactly the size the read recorded, so that a file
 * rewritten since is not passed off as the one that was read.
 */
export async function readAnimationSource(
  path: string,
  expectedSize: number,
): Promise<Buffer | null> {
  const key = `${expectedSize}|${path}`
  if (sourceCache.has(key)) {
    const known = sourceCache.get(key) ?? null
    sourceCache.delete(key)
    sourceCache.set(key, known)
    return known
  }
  let read: Buffer | null = null
  try {
    const fs = getFsImplementation()
    const stats = await fs.stat(path)
    if (
      stats.isFile() &&
      stats.size === expectedSize &&
      stats.size <= MAX_ANIMATION_SOURCE_BYTES
    ) {
      const bytes = await fs.readFileBytes(path, MAX_ANIMATION_SOURCE_BYTES)
      read = bytes.length === expectedSize ? bytes : null
    }
  } catch {
    // Moved, deleted, unreadable: the still the read carried stands.
    read = null
  }
  sourceCache.set(key, read)
  while (sourceCache.size > SOURCE_CACHE_LIMIT) {
    const oldest = sourceCache.keys().next().value
    if (oldest === undefined) break
    sourceCache.delete(oldest)
  }
  return read
}

/**
 * The animation to play for an image: its own bytes when they are animated,
 * else the file it was read from, when one is known and still the same file —
 * and in either case only one that `protocol` can afford to play.
 */
export async function findAnimation(
  data: Buffer,
  source: { readonly path: string; readonly size: number } | undefined,
  protocol: GraphicsProtocol,
): Promise<{ data: Buffer; info: AnimationInfo } | null> {
  const affordable = (info: AnimationInfo | null): AnimationInfo | null => {
    if (info === null || isAffordable(info, protocol)) return info
    logForDebugging(
      `terminalAnimation: ${info.pages} frames of ${info.width}x${info.height} ` +
        `would decode ${(decodePixels(info, protocol) / 1e9).toFixed(1)}G pixels, ` +
        `past ${MAX_DECODE_PIXELS / 1e9}G — showing the first frame`,
    )
    return null
  }
  const own = await probeAnimation(data)
  if (own !== null) {
    const info = affordable(own)
    return info === null ? null : { data, info }
  }
  // Bytes the size of the file are the file: nothing more to find on disk.
  if (source === undefined || data.length === source.size) return null
  const file = await readAnimationSource(source.path, source.size)
  if (file === null) return null
  const info = affordable(await probeAnimation(file))
  return info === null ? null : { data: file, info }
}

/** The box every frame of an animation is made for. */
export type AnimationBox = {
  readonly protocol: GraphicsProtocol
  readonly columns: number
  readonly rows: number
  readonly pixelWidth: number
  readonly pixelHeight: number
  /** The id the still was drawn under; every Kitty frame reuses it. */
  readonly kittyImageId?: number
}

/**
 * Sixel frames are encoded on a worker thread.
 *
 * The encoder is synchronous JavaScript, and a frame of real content keeps it
 * busy for tens to hundreds of milliseconds. On the main thread every one of
 * those is a stall in typing and in every other frame Tau draws. Where the
 * worker cannot run — the `sixel` package cannot be resolved from here, or the
 * runtime refuses workers — frames are encoded on the main thread instead, one
 * at a time, each followed by a pause as long as it took, so the main thread is
 * never more than half spent on them.
 */
const SIXEL_WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads')
const { image2sixel } = require(workerData.sixel)
parentPort.on('message', ({ id, rgba, width, height }) => {
  try {
    parentPort.postMessage({ id, sequence: image2sixel(rgba, width, height, 256) })
  } catch (error) {
    parentPort.postMessage({ id, error: String((error && error.message) || error) })
  }
})
`

/** How long an idle worker is kept before its thread is given back. */
const SIXEL_WORKER_IDLE_MS = 30_000

/** The longest pause after a main-thread encode before the next may start. */
const MAX_ENCODE_BREATH_MS = 200

/** Named apart from the bundle's own `require`; see `treesitter/parser.ts`. */
const animationRequire = createRequire(import.meta.url)

type SixelWorker = {
  readonly worker: Worker
  /** Each frame in flight; finished with undefined when the worker is lost. */
  readonly jobs: Map<number, (sequence: string | null | undefined) => void>
  idle: TimerHandle | null
}

let sixelWorker: SixelWorker | null = null
/** Set once a worker has failed to start or died: the main thread takes over. */
let sixelWorkerUnavailable = false
let nextSixelJob = 0

function startSixelWorker(): SixelWorker | null {
  if (sixelWorker !== null) return sixelWorker
  if (sixelWorkerUnavailable) return null
  let worker: Worker
  try {
    worker = new Worker(SIXEL_WORKER_SOURCE, {
      eval: true,
      workerData: { sixel: animationRequire.resolve('sixel') },
    })
  } catch (error) {
    sixelWorkerUnavailable = true
    logForDebugging(
      `terminalAnimation: no sixel worker (${
        error instanceof Error ? error.message : String(error)
      }) — encoding frames on the main thread`,
    )
    return null
  }
  // Never a reason to keep the process alive.
  worker.unref()
  const state: SixelWorker = { worker, jobs: new Map(), idle: null }
  const lost = (): void => {
    if (state.idle !== null) clearTimeout(state.idle)
    state.idle = null
    if (sixelWorker === state) sixelWorker = null
    // Frames still in flight are encoded on the main thread instead.
    const unfinished = [...state.jobs.values()]
    state.jobs.clear()
    for (const finish of unfinished) finish(undefined)
  }
  worker.on('message', (message: { id: number; sequence?: unknown; error?: unknown }) => {
    const finish = state.jobs.get(message.id)
    if (finish === undefined) return
    state.jobs.delete(message.id)
    if (message.error !== undefined) {
      logForDebugging(
        `terminalAnimation: the sixel worker could not encode a frame — ${String(message.error)}`,
      )
    }
    finish(typeof message.sequence === 'string' ? message.sequence : null)
    if (state.jobs.size === 0) armWorkerIdle(state)
  })
  worker.on('error', error => {
    sixelWorkerUnavailable = true
    logForDebugging(
      `terminalAnimation: the sixel worker failed (${error.message}) — encoding frames on the main thread`,
    )
    lost()
  })
  worker.on('exit', lost)
  sixelWorker = state
  return state
}

function armWorkerIdle(state: SixelWorker): void {
  if (state.idle !== null) clearTimeout(state.idle)
  state.idle = unrefTimer(() => {
    state.idle = null
    if (state.jobs.size > 0 || sixelWorker !== state) return
    sixelWorker = null
    void state.worker.terminate()
  }, SIXEL_WORKER_IDLE_MS)
}

/** The frame encoded on the worker; undefined when the worker cannot do it. */
function encodeOnWorker(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<string | null | undefined> {
  const state = startSixelWorker()
  if (state === null) return Promise.resolve(undefined)
  if (state.idle !== null) {
    clearTimeout(state.idle)
    state.idle = null
  }
  const id = nextSixelJob++
  return new Promise(resolve => {
    state.jobs.set(id, resolve)
    try {
      // Copied, not transferred: if the worker is lost with this frame in
      // flight, the main thread still has the pixels to encode it from.
      state.worker.postMessage({ id, rgba, width, height })
    } catch {
      state.jobs.delete(id)
      resolve(undefined)
    }
  })
}

/** Main-thread sixel encodes, one at a time across every animation. */
let blockingEncodes: Promise<unknown> = Promise.resolve()

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => {
    unrefTimer(resolve, ms)
  })
}

function encodeOnMainThread(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<string | null> {
  let spent = 0
  const turn = blockingEncodes.then(async () => {
    await yieldToEventLoop()
    const started = Date.now()
    const sequence = await encodeSixelGraphics(rgba, width, height)
    spent = Date.now() - started
    return sequence
  })
  // The next encode waits as long as this one took.
  blockingEncodes = turn.then(
    () => pause(Math.min(spent, MAX_ENCODE_BREATH_MS)),
    () => undefined,
  )
  return turn
}

/** One sixel frame, on the worker when there is one. */
export async function encodeSixelFrame(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<string | null> {
  const encoded = await encodeOnWorker(rgba, width, height)
  return encoded === undefined ? encodeOnMainThread(rgba, width, height) : encoded
}

/**
 * Turn the worker off or back on. Exported for tests, which compare what the
 * two paths produce.
 */
export function setSixelWorkerEnabledForTesting(enabled: boolean): void {
  sixelWorkerUnavailable = !enabled
  const current = sixelWorker
  sixelWorker = null
  if (current !== null) void current.worker.terminate()
}

function hasTransparency(pixels: Buffer, channels: number): boolean {
  if (channels !== 4) return false
  for (let i = 3; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 255) < 255) return true
  }
  return false
}

/**
 * Makes the frames of one animation for one box, and keeps them.
 *
 * Frame 0 is the still the ordinary path already encoded, so the first frame of
 * every loop is exactly what was drawn before anything played.
 */
export class AnimationFrames {
  /** Frames that can be played. Shrinks when the file turns out to end early. */
  count: number
  /** Why the animation cannot go on, once it cannot. */
  failure: string | null = null
  private readonly encoded = new Map<number, string>()
  private encodedChars = 0
  private overBudget = false
  private chunk: { first: number; frames: Buffer[]; channels: number } | null =
    null
  private work: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly data: Buffer,
    private readonly plan: FramePlan,
    private readonly box: AnimationBox,
    private readonly poster: string,
    /** Decoded pixels held at once; smaller only in tests, to cross chunks. */
    private readonly chunkBytes: number = CHUNK_BYTES,
  ) {
    this.count = plan.pages.length
    this.encoded.set(0, poster)
  }

  /**
   * Whether every frame is kept, so playing it again costs nothing. An
   * animation past its cache budget plays through once and then rests: playing
   * it again would mean decoding and encoding every frame on every loop.
   */
  canLoop(): boolean {
    return !this.overBudget
  }

  /** The ready-to-write payload of frame `index`, or null when there is none. */
  frame(index: number): Promise<string | null> {
    const made = this.work.then(() => this.make(index))
    this.work = made.catch(() => undefined)
    return made
  }

  /** Give back what is held. Frames asked for afterwards are made again. */
  release(): void {
    this.encoded.clear()
    this.encoded.set(0, this.poster)
    this.encodedChars = 0
    this.chunk = null
  }

  private async make(index: number): Promise<string | null> {
    if (this.failure !== null || index < 0 || index >= this.count) return null
    const known = this.encoded.get(index)
    if (known !== undefined) return known
    try {
      const pixels = await this.pixels(index)
      if (pixels === null) return null
      if (
        this.box.protocol === 'kitty' &&
        hasTransparency(pixels.data, pixels.channels)
      ) {
        // Kitty draws over the text, so a transparent pixel shows the cell under
        // it — the block render of the first frame. On a still the two agree;
        // on any later frame it would show the first one through.
        return this.fail(
          'frames carry transparency, which Kitty would show the first frame through',
        )
      }
      const sequence = await this.encode(pixels.data, pixels.channels)
      if (sequence === null) return this.fail('a frame could not be encoded')
      if (this.encodedChars + sequence.length <= MAX_FRAME_CACHE_CHARS) {
        this.encoded.set(index, sequence)
        this.encodedChars += sequence.length
      } else if (!this.overBudget) {
        this.overBudget = true
        logForDebugging(
          'terminalAnimation: frames are past the cache budget — playing once',
        )
      }
      return sequence
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  private fail(reason: string): null {
    if (this.failure === null) {
      this.failure = reason
      logForDebugging(`terminalAnimation: ${reason} — holding the frame on screen`)
    }
    this.release()
    return null
  }

  private async pixels(
    index: number,
  ): Promise<{ data: Buffer; channels: number } | null> {
    const held = this.chunk
    if (
      held !== null &&
      index >= held.first &&
      index < held.first + held.frames.length
    ) {
      const frame = held.frames[index - held.first]
      return frame === undefined ? null : { data: frame, channels: held.channels }
    }
    // Let the last chunk go before the next one is decoded beside it.
    this.chunk = null
    const { pixelWidth, pixelHeight } = this.box
    const firstPage = this.plan.pages[index]!
    const pageLimit = Math.max(
      1,
      Math.floor(this.chunkBytes / Math.max(1, pixelWidth * pixelHeight * 4)),
    )
    let last = index
    while (
      last + 1 < this.count &&
      this.plan.pages[last + 1]! - firstPage + 1 <= pageLimit
    ) {
      last++
    }
    const pageCount = this.plan.pages[last]! - firstPage + 1
    let result: Awaited<ReturnType<AnimationSharp['toBuffer']>>
    try {
      result = await (await processor())(this.data, {
        page: firstPage,
        pages: pageCount,
      })
        .resize(pixelWidth, pixelHeight, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true })
    } catch (error) {
      if (index > 1) {
        // A file cut off part way — a recording still being written, a
        // truncated download — plays the frames it does have.
        this.count = index
        logForDebugging(
          `terminalAnimation: decoding stopped at frame ${index} — looping the frames before it`,
        )
        return null
      }
      throw error
    }
    if (!('data' in result)) return this.fail('the decoder returned no pixels')
    const { data, info } = result
    // A processor that ignored the page range, or the size, hands back a shape
    // every frame after this would be wrong in. Stop rather than guess.
    if (
      info.width !== pixelWidth ||
      info.height !== pixelHeight * pageCount ||
      (info.channels !== 3 && info.channels !== 4)
    ) {
      return this.fail(
        `the decoder returned ${info.width}x${info.height}x${info.channels} for ` +
          `${pageCount} frames of ${pixelWidth}x${pixelHeight}`,
      )
    }
    const pageBytes = pixelWidth * pixelHeight * info.channels
    // A decimated chunk decoded pages it does not play. Copied out, the frames
    // it does play keep only themselves alive instead of the whole decode.
    const passesThrough = last - index + 1 < pageCount
    const frames: Buffer[] = []
    for (let i = index; i <= last; i++) {
      const offset = (this.plan.pages[i]! - firstPage) * pageBytes
      const frame = data.subarray(offset, offset + pageBytes)
      frames.push(passesThrough ? Buffer.from(frame) : frame)
    }
    this.chunk = { first: index, frames, channels: info.channels }
    const frame = frames[0]
    return frame === undefined ? null : { data: frame, channels: info.channels }
  }

  private async encode(pixels: Buffer, channels: number): Promise<string | null> {
    const { protocol, columns, rows, pixelWidth, pixelHeight } = this.box
    if (protocol === 'kitty') {
      const png = await (await processor())(pixels, {
        raw: { width: pixelWidth, height: pixelHeight, channels },
      })
        .png()
        .toBuffer()
      if ('data' in png) return null
      return encodeKittyGraphics(
        png.toString('base64'),
        columns,
        rows,
        this.box.kittyImageId,
      )
    }
    if (protocol === 'sixel') {
      const rgba = widenToRgba(pixels, pixelWidth, pixelHeight, channels)
      return rgba === null ? null : encodeSixelFrame(rgba, pixelWidth, pixelHeight)
    }
    return null
  }
}

type TimerHandle = ReturnType<typeof setTimeout>

export type AnimationPlayerOptions = {
  readonly frames: Pick<AnimationFrames, 'count' | 'failure' | 'canLoop' | 'frame'>
  readonly delays: readonly number[]
  readonly loop: number
  /** The payload drawn before anything played: frame 0. */
  readonly poster: string
  /** Put a frame into the placement; false once the placement is gone. */
  readonly swap: (sequence: string) => boolean
  /** The payload the placement has on screen now, if any. */
  readonly drawn: () => string | undefined
  readonly requestFrame: () => void
  /** Bytes written that the terminal has not taken yet. */
  readonly backlog: () => number
  /** Give back the frames held; called while nothing can be drawn. */
  readonly release: () => void
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimer?: (handle: TimerHandle) => void
}

function unrefTimer(fn: () => void, ms: number): TimerHandle {
  const handle = setTimeout(fn, ms)
  // Never a reason to keep the process alive.
  ;(handle as { unref?: () => void }).unref?.()
  return handle
}

/**
 * Plays an animation into one placement.
 *
 * A frame goes in only once the one before it has been on screen for its
 * delay, the terminal has taken everything written so far, and the frame is
 * ready — so the animation never runs ahead of what is drawn, and a slow
 * terminal slows it down instead of piling frames up in memory.
 *
 * Every pause ends on its own. A frame that cannot be drawn — the image in
 * scrollback, scrolled out of a fullscreen view, withheld during a resize, the
 * screen handed to an editor — is simply not drawn, and the draw that finally
 * puts it on screen is what resumes playing. Nothing polls while it waits.
 */
export class AnimationPlayer {
  private index = 0
  private sequence: string
  private onScreen = false
  private advancing = false
  private plays = 0
  private stopped = false
  private timer: TimerHandle | null = null
  private releaseTimer: TimerHandle | null = null
  private backlogWait = BACKLOG_RETRY_MIN_MS
  private prefetched: { index: number; payload: Promise<string | null> } | null =
    null
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void

  constructor(private readonly options: AnimationPlayerOptions) {
    this.sequence = options.poster
    this.setTimer = options.setTimer ?? unrefTimer
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  start(): void {
    this.check()
  }

  /** A pass drew a payload for the placement. */
  drawn(): void {
    if (!this.stopped) this.check()
  }

  stop(): void {
    this.stopped = true
    this.prefetched = null
    if (this.timer !== null) this.clearTimer(this.timer)
    if (this.releaseTimer !== null) this.clearTimer(this.releaseTimer)
    this.timer = null
    this.releaseTimer = null
  }

  /** Whether the player has stopped for good. Exported for tests. */
  get isStopped(): boolean {
    return this.stopped
  }

  /** The frame put in last. Exported for tests. */
  get currentFrame(): number {
    return this.index
  }

  private check(): void {
    if (this.stopped || this.onScreen || this.advancing) return
    if (this.options.drawn() !== this.sequence) {
      this.armRelease()
      return
    }
    this.onScreen = true
    this.cancelRelease()
    const next = this.nextIndex()
    if (next === null) {
      this.finish()
      return
    }
    // Made while this one shows, so its delay is not spent waiting for it.
    this.prefetched = { index: next, payload: this.options.frames.frame(next) }
    this.schedule(this.options.delays[this.index] ?? DEFAULT_FRAME_DELAY_MS)
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.advance()
    }, ms)
  }

  private nextIndex(): number | null {
    const count = this.options.frames.count
    const next = this.index + 1
    if (next < count) return next
    if (count < 2) return null
    if (this.options.loop > 0 && this.plays + 1 >= this.options.loop) return null
    if (!this.options.frames.canLoop()) return null
    return 0
  }

  private payload(index: number): Promise<string | null> {
    const ready = this.prefetched
    this.prefetched = null
    if (ready !== null && ready.index === index) return ready.payload
    return this.options.frames.frame(index)
  }

  private async advance(): Promise<void> {
    if (this.stopped) return
    // Everything written so far is still on its way to the terminal: hold this
    // frame up instead of queueing another behind it.
    if (this.options.backlog() > 0) {
      this.schedule(this.backlogWait)
      this.backlogWait = Math.min(BACKLOG_RETRY_MAX_MS, this.backlogWait * 2)
      return
    }
    this.backlogWait = BACKLOG_RETRY_MIN_MS
    const next = this.nextIndex()
    if (next === null) {
      this.finish()
      return
    }
    this.advancing = true
    let sequence: string | null
    try {
      sequence = await this.payload(next)
    } finally {
      this.advancing = false
    }
    if (this.stopped) return
    if (sequence === null) {
      const frames = this.options.frames
      // The file ended before this frame: what played so far is the loop.
      if (frames.failure === null && next > 0 && next >= frames.count) {
        return this.advance()
      }
      this.stop()
      return
    }
    if (!this.options.swap(sequence)) {
      this.stop()
      return
    }
    if (next === 0) this.plays++
    this.index = next
    this.sequence = sequence
    this.onScreen = false
    this.options.requestFrame()
    this.check()
  }

  /** A finite animation played out: it rests on its last frame. */
  private finish(): void {
    this.stop()
    this.options.release()
  }

  private armRelease(): void {
    if (this.releaseTimer !== null || this.stopped) return
    this.releaseTimer = this.setTimer(() => {
      this.releaseTimer = null
      if (!this.stopped) this.options.release()
    }, RELEASE_AFTER_MS)
  }

  private cancelRelease(): void {
    if (this.releaseTimer === null) return
    this.clearTimer(this.releaseTimer)
    this.releaseTimer = null
  }
}
