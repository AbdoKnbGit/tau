/**
 * Animated inline image checks: probing, frame plans, frame making, and the
 * player that swaps frames into a placement.
 *
 * The failures these guard against are quiet ones. A frame from the wrong page
 * plays as a stutter nobody can pin down; a pause with no way out leaves an
 * animation stopped for the session; a frame queued before the last one was
 * taken makes a slow terminal fall further behind with every frame. The files
 * are made here with the image processor itself, so the decoder under test is
 * the one Tau ships.
 *
 * Run via: bun run src/utils/terminalAnimation.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AnimationFrames,
  AnimationPlayer,
  animatedCellLimit,
  decodePixels,
  encodeITerm2Animation,
  encodeSixelFrame,
  findAnimation,
  isAffordable,
  mayBeAnimated,
  maxAnimatedPixels,
  normalizeFrameDelay,
  planFrames,
  probeAnimation,
  setSixelWorkerEnabledForTesting,
} from './terminalAnimation.js'

const { default: sharp } = (await import('sharp')) as unknown as {
  default: (input?: unknown, options?: unknown) => any
}

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(`${hint}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

// --- Fixtures ----------------------------------------------------------------

const W = 64
const H = 32
const SQUARE = 16
const RED = [255, 60, 60]
const GREY = [30, 30, 30]

/** Frame `f` has a red square at x = 4f, so a frame's page is readable off it. */
function framePixels(count: number, transparent = false): Buffer {
  const pixels = Buffer.alloc(W * H * count * 4)
  for (let f = 0; f < count; f++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = ((f * H + y) * W + x) * 4
        const inSquare = x >= f * 4 && x < f * 4 + SQUARE && y >= 8 && y < 8 + SQUARE
        const [r, g, b] = inSquare ? RED : GREY
        pixels[o] = r!
        pixels[o + 1] = g!
        pixels[o + 2] = b!
        pixels[o + 3] = transparent && !inSquare ? 0 : 255
      }
    }
  }
  return pixels
}

async function makeAnimation(
  format: 'gif' | 'webp',
  count = 8,
  { transparent = false, loop = 0, delay = 70 } = {},
): Promise<Buffer> {
  const input = sharp(framePixels(count, transparent), {
    raw: { width: W, height: H * count, channels: 4, pageHeight: H },
  })
  const options = {
    delay: Array.from({ length: count }, (_, i) => (i === 0 ? 0 : delay)),
    loop,
  }
  return format === 'gif'
    ? input.gif(options).toBuffer()
    : input.webp({ ...options, lossless: true }).toBuffer()
}

/** The x of the red square in a Kitty frame payload: which page it came from. */
async function squareAt(sequence: string): Promise<number> {
  const base64 = sequence.slice(sequence.indexOf(';') + 1, sequence.lastIndexOf('\x1b\\'))
  const { data, info } = await sharp(Buffer.from(base64, 'base64'))
    .raw()
    .toBuffer({ resolveWithObject: true })
  const row = 16
  for (let x = 0; x < info.width; x++) {
    const o = (row * info.width + x) * info.channels
    if ((data[o] ?? 0) > 200 && (data[o + 1] ?? 255) < 120) return x
  }
  return -1
}

const KITTY_BOX = {
  protocol: 'kitty' as const,
  columns: 8,
  rows: 2,
  pixelWidth: W,
  pixelHeight: H,
  kittyImageId: 4242,
}
const SIXEL_BOX = { ...KITTY_BOX, protocol: 'sixel' as const, kittyImageId: undefined }

// --- Recognising an animation ---------------------------------------------------

await test('only GIF and WebP bytes are looked at at all', async () => {
  assert(mayBeAnimated(Buffer.from('GIF89a......')), 'GIF89a')
  assert(mayBeAnimated(Buffer.from('GIF87a......')), 'GIF87a')
  assert(mayBeAnimated(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8X')), 'WebP')
  assert(!mayBeAnimated(Buffer.from('\x89PNG\r\n\x1a\n....')), 'a PNG costs nothing')
  assert(!mayBeAnimated(Buffer.from('GIF')), 'too short to tell')
})

await test('a frame with no delay shows as browsers show it', () => {
  assertEqual(normalizeFrameDelay(0), 100, 'zero')
  assertEqual(normalizeFrameDelay(10), 100, '10 ms reads as "as fast as you can"')
  assertEqual(normalizeFrameDelay(undefined), 100, 'missing')
  assertEqual(normalizeFrameDelay(Number.NaN), 100, 'not a number')
  assertEqual(normalizeFrameDelay(11), 20, 'faster than a frame can go out')
  assertEqual(normalizeFrameDelay(70), 70, 'an ordinary delay')
  assertEqual(normalizeFrameDelay(1e9), 60_000, 'a runaway delay')
})

await test('an animated GIF and WebP are probed, a still is not', async () => {
  const gif = await probeAnimation(await makeAnimation('gif'))
  assert(gif !== null, 'the GIF animates')
  assertEqual(gif!.format, 'gif', 'format')
  assertEqual(gif!.pages, 8, 'frames')
  assertEqual(gif!.width, W, 'one frame wide')
  assertEqual(gif!.height, H, 'one frame tall, not the whole strip')
  assertEqual(gif!.delays[0], 100, 'the first frame asked for no delay')
  assertEqual(gif!.delays[1], 70, 'the rest asked for 70 ms')
  assertEqual(gif!.loop, 0, 'forever')

  const webp = await probeAnimation(await makeAnimation('webp'))
  assertEqual(webp?.pages, 8, 'the WebP animates too')

  const still = await sharp(framePixels(1), { raw: { width: W, height: H, channels: 4 } })
    .gif()
    .toBuffer()
  assertEqual(await probeAnimation(still), null, 'a one-frame GIF is a still')
  const png = await sharp(framePixels(1), { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toBuffer()
  assertEqual(await probeAnimation(png), null, 'a PNG is a still')
  assertEqual(await probeAnimation(Buffer.from('GIF89a garbage, not an image')), null, 'and garbage does not throw')
})

await test('a finite loop count is read from the file', async () => {
  assertEqual((await probeAnimation(await makeAnimation('gif', 4, { loop: 2 })))?.loop, 2, 'twice')
})

// --- Planning frames ------------------------------------------------------------

await test('a long file plays every n-th frame and keeps its running time', () => {
  const info = {
    format: 'gif' as const,
    pages: 8,
    width: W,
    height: H,
    delays: [100, 70, 70, 70, 70, 70, 70, 70],
    loop: 0,
  }
  const all = planFrames(info)
  assertEqual(all.pages.length, 8, 'under the cap, every frame plays')

  const third = planFrames(info, 3)
  assertEqual(third.pages.join(','), '0,3,6', 'every third page, starting from the first')
  assertEqual(third.delays.join(','), '240,210,140', 'each held for the frames it stands in for')
  const total = (delays: readonly number[]) => delays.reduce((a, b) => a + b, 0)
  assertEqual(total(third.delays), total(info.delays), 'the same running time')
})

await test('an animated box is capped by pixels, and a small one left alone', () => {
  const cell = { width: 10, height: 20 }
  assertEqual(animatedCellLimit(400, 225, cell, 'sixel'), null, 'within the cap: boxed as a still would be')
  for (const protocol of ['sixel', 'kitty'] as const) {
    const limit = animatedCellLimit(1600, 900, cell, protocol)
    assert(limit !== null, `a large one is capped for ${protocol}`)
    assert(
      limit!.columns * cell.width * limit!.rows * cell.height <= maxAnimatedPixels(protocol),
      'to a box within that protocol\'s frame budget',
    )
    const shape = (limit!.columns * cell.width) / (limit!.rows * cell.height)
    assert(Math.abs(shape - 16 / 9) < 0.1, `keeping the image's shape (${shape.toFixed(2)})`)
  }
  assert(maxAnimatedPixels('sixel') < maxAnimatedPixels('kitty'), 'sixel, the dear one, gets the smaller box')
})

await test('what a file costs to decode decides whether it plays, not its pixels', () => {
  // The two screen recordings this was tuned on, and one far past them.
  const tauShow = { pages: 520, width: 1200, height: 644 }
  const terminal = { pages: 641, width: 800, height: 441 }
  const huge = { pages: 1000, width: 1920, height: 1080 }
  for (const protocol of ['sixel', 'kitty'] as const) {
    assert(isAffordable(tauShow, protocol), `a 520-frame 1200x644 recording plays (${protocol})`)
    assert(isAffordable(terminal, protocol), `a 641-frame 800x441 recording plays (${protocol})`)
    assert(!isAffordable(huge, protocol), `a thousand 1080p frames does not (${protocol})`)
  }
  // Re-decoding is what makes long files dear: twice the frames is about
  // three times the work at these sizes, not twice.
  const once = decodePixels({ pages: 300, width: 800, height: 450 }, 'kitty')
  const twice = decodePixels({ pages: 600, width: 800, height: 450 }, 'kitty')
  assert(twice > 2.5 * once, `the cost grows faster than the frame count (${(twice / once).toFixed(1)}x)`)
})

await test('sixel frames from the worker are exactly the main thread\'s', async () => {
  const width = 64
  const height = 32
  const rgba = new Uint8Array(framePixels(1).subarray(0, width * height * 4))
  const fromWorker = await encodeSixelFrame(rgba, width, height)
  setSixelWorkerEnabledForTesting(false)
  try {
    const fromMain = await encodeSixelFrame(rgba, width, height)
    assert(fromWorker !== null && fromWorker.startsWith('\x1bP'), 'the worker encodes a sixel frame')
    assertEqual(fromWorker, fromMain, 'byte for byte what the main thread makes')
  } finally {
    setSixelWorkerEnabledForTesting(true)
  }
})

// --- iTerm2 -----------------------------------------------------------------------

await test('iTerm2 is handed the GIF itself, stretched over the box', async () => {
  const gif = await makeAnimation('gif')
  const info = (await probeAnimation(gif))!
  const sequence = encodeITerm2Animation(gif, info, 8, 2)
  assert(sequence !== null, 'a GIF plays there')
  assert(sequence!.includes('width=8;height=2;preserveAspectRatio=0:'), 'over the box exactly')
  assert(sequence!.includes(gif.toString('base64')), 'the file as it is')

  const webp = await makeAnimation('webp')
  assertEqual(
    encodeITerm2Animation(webp, (await probeAnimation(webp))!, 8, 2),
    null,
    'WebP is left to the still',
  )
  assertEqual(
    encodeITerm2Animation(Buffer.alloc(6 * 1024 * 1024 + 1), info, 8, 2),
    null,
    'a file too large to re-send with its rows stays a still',
  )
})

// --- The file behind a read ---------------------------------------------------

await test('a read carrying a still finds the animated file behind it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tau-animation-'))
  try {
    const gif = await makeAnimation('gif')
    const path = join(dir, 'clip.gif')
    writeFileSync(path, gif)
    const still = await sharp(framePixels(1), { raw: { width: W, height: H, channels: 4 } })
      .png()
      .toBuffer()

    const found = await findAnimation(still, { path, size: gif.length }, 'sixel')
    assertEqual(found?.info.pages, 8, 'played from the file')
    assert(found!.data.equals(gif), 'with the file as it is on disk')

    assertEqual(
      await findAnimation(still, { path, size: gif.length + 1 }, 'sixel'),
      null,
      'a file of another size is not the one that was read',
    )
    assertEqual(
      await findAnimation(still, { path: join(dir, 'gone.gif'), size: gif.length }, 'sixel'),
      null,
      'a missing file leaves the still',
    )
    const own = await findAnimation(gif, { path: join(dir, 'gone.gif'), size: 1 }, 'kitty')
    assertEqual(own?.data, gif, 'bytes that animate themselves need no file at all')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- Making frames ----------------------------------------------------------------

await test('each Kitty frame comes from its own page, under the still\'s id', async () => {
  const gif = await makeAnimation('gif')
  const info = (await probeAnimation(gif))!
  const frames = new AnimationFrames(gif, planFrames(info), KITTY_BOX, 'POSTER')
  assertEqual(await frames.frame(0), 'POSTER', 'frame 0 is the still already drawn')
  for (const index of [1, 2, 5, 7]) {
    const sequence = await frames.frame(index)
    assert(sequence !== null, `frame ${index} is made`)
    assert(sequence!.includes('a=T,f=100') && sequence!.includes('i=4242,'), 'a Kitty payload under the shared id')
    assertEqual(await squareAt(sequence!), index * 4, `frame ${index} shows page ${index}`)
  }
  assertEqual(frames.failure, null, 'nothing failed')
  assert(frames.canLoop(), 'every frame is kept, so looping costs nothing')
})

await test('frames cross chunk boundaries onto the right pages, decimated or not', async () => {
  const gif = await makeAnimation('gif')
  const info = (await probeAnimation(gif))!
  // Three pages of pixels per chunk.
  const chunk = W * H * 4 * 3
  const frames = new AnimationFrames(gif, planFrames(info), KITTY_BOX, 'POSTER', chunk)
  for (const index of [7, 3, 4, 1, 6]) {
    assertEqual(await squareAt((await frames.frame(index))!), index * 4, `frame ${index}, out of order`)
  }

  const plan = planFrames(info, 3)
  const decimated = new AnimationFrames(gif, plan, KITTY_BOX, 'POSTER', chunk)
  assertEqual(await squareAt((await decimated.frame(1))!), 3 * 4, 'played frame 1 is page 3')
  assertEqual(await squareAt((await decimated.frame(2))!), 6 * 4, 'played frame 2 is page 6')
})

await test('a WebP animates through the same path', async () => {
  const webp = await makeAnimation('webp')
  const frames = new AnimationFrames(webp, planFrames((await probeAnimation(webp))!), KITTY_BOX, 'POSTER')
  assertEqual(await squareAt((await frames.frame(5))!), 20, 'frame 5 from page 5')
})

await test('a transparent animation stays still on Kitty, and plays as sixel', async () => {
  // Kitty draws over the text, so the first frame's block render would show
  // through every transparent pixel of every later frame.
  const gif = await makeAnimation('gif', 8, { transparent: true })
  const info = (await probeAnimation(gif))!
  const kitty = new AnimationFrames(gif, planFrames(info), KITTY_BOX, 'POSTER')
  assertEqual(await kitty.frame(1), null, 'no frame for Kitty')
  assert(kitty.failure !== null && /transparency/.test(kitty.failure), 'and it says why')
  assertEqual(await kitty.frame(2), null, 'nor any after it')

  // The sixel encoder paints every pixel, so a frame replaces the one under it.
  const sixel = new AnimationFrames(gif, planFrames(info), SIXEL_BOX, 'POSTER')
  const frame = await sixel.frame(1)
  assert(frame !== null && frame.startsWith('\x1bP') && frame.endsWith('\x1b\\'), 'a sixel frame')
  assertEqual(sixel.failure, null, 'with nothing failed')
})

await test('releasing gives frames back, and they are made again on request', async () => {
  const gif = await makeAnimation('gif')
  const frames = new AnimationFrames(gif, planFrames((await probeAnimation(gif))!), KITTY_BOX, 'POSTER')
  const before = await frames.frame(4)
  frames.release()
  assertEqual(await frames.frame(0), 'POSTER', 'the still survives a release')
  assertEqual(await frames.frame(4), before, 'and a released frame comes back the same')
})

// --- The player ---------------------------------------------------------------------

type Timer = { at: number; fn: () => void; id: number }

function fakeClock() {
  let now = 0
  let nextId = 1
  const timers: Timer[] = []
  return {
    set: (fn: () => void, ms: number) => {
      const id = nextId++
      timers.push({ at: now + ms, fn, id })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clear: (handle: ReturnType<typeof setTimeout>) => {
      const i = timers.findIndex(t => t.id === (handle as unknown as number))
      if (i >= 0) timers.splice(i, 1)
    },
    async advance(ms: number): Promise<void> {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (next === undefined || next.at > end) break
        timers.shift()
        now = next.at
        next.fn()
        await settle()
      }
      now = end
    },
    get pending(): number {
      return timers.length
    },
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function rig(options: {
  count?: number
  loop?: number
  canLoop?: boolean
  backlog?: () => number
  swap?: (sequence: string) => boolean
  frame?: (index: number) => Promise<string | null>
} = {}) {
  const clock = fakeClock()
  let registered = 'P0'
  let onScreen: string | undefined
  const swaps: string[] = []
  let frameRequests = 0
  let releases = 0
  const frames = {
    count: options.count ?? 3,
    failure: null as string | null,
    canLoop: () => options.canLoop ?? true,
    frame: options.frame ?? (async (index: number) => (index === 0 ? 'P0' : `F${index}`)),
  }
  const player = new AnimationPlayer({
    frames,
    delays: [100, 100, 100, 100],
    loop: options.loop ?? 0,
    poster: 'P0',
    swap: sequence => {
      const taken = options.swap?.(sequence) ?? true
      if (taken) {
        registered = sequence
        swaps.push(sequence)
      }
      return taken
    },
    drawn: () => onScreen,
    requestFrame: () => {
      frameRequests++
    },
    backlog: options.backlog ?? (() => 0),
    release: () => {
      releases++
    },
    setTimer: clock.set,
    clearTimer: clock.clear,
  })
  /** A pass draws what the placement holds, and announces it. */
  const draw = async () => {
    onScreen = registered
    player.drawn()
    await settle()
  }
  return {
    clock,
    player,
    frames,
    swaps,
    draw,
    frameRequests: () => frameRequests,
    releases: () => releases,
  }
}

await test('nothing plays until the still is on screen', async () => {
  const r = rig()
  r.player.start()
  await r.clock.advance(1000)
  assertEqual(r.swaps.length, 0, 'an undrawn still is not followed by a frame')
  await r.draw()
  await r.clock.advance(99)
  assertEqual(r.swaps.length, 0, 'the still holds for its delay')
  await r.clock.advance(1)
  assertEqual(r.swaps.join(','), 'F1', 'then the next frame goes in')
  assertEqual(r.frameRequests(), 1, 'and a frame is asked for, not a React render')
})

await test('a frame is followed only once it has been drawn', async () => {
  const r = rig()
  r.player.start()
  await r.draw()
  await r.clock.advance(100)
  await r.clock.advance(5000)
  assertEqual(r.swaps.join(','), 'F1', 'a frame that is never drawn holds the animation, at no cost')
  await r.draw()
  await r.clock.advance(100)
  assertEqual(r.swaps.join(','), 'F1,F2', 'the draw that finally lands is what resumes it')
})

await test('an endless animation wraps to the still and goes on', async () => {
  const r = rig()
  r.player.start()
  for (let i = 0; i < 4; i++) {
    await r.draw()
    await r.clock.advance(100)
  }
  assertEqual(r.swaps.join(','), 'F1,F2,P0,F1', 'round and round')
})

await test('a finite animation plays its loops and rests on the last frame', async () => {
  const r = rig({ loop: 1 })
  r.player.start()
  for (let i = 0; i < 5; i++) {
    await r.draw()
    await r.clock.advance(100)
  }
  assertEqual(r.swaps.join(','), 'F1,F2', 'once through')
  assert(r.player.isStopped, 'then stopped')
  assert(r.releases() > 0, 'with its frames given back')
  assertEqual(r.clock.pending, 0, 'and no timer left behind')
})

await test('an animation past its cache budget plays once instead of re-making every frame', async () => {
  const r = rig({ canLoop: false })
  r.player.start()
  for (let i = 0; i < 5; i++) {
    await r.draw()
    await r.clock.advance(100)
  }
  assertEqual(r.swaps.join(','), 'F1,F2', 'once through')
  assert(r.player.isStopped, 'then it rests')
})

await test('a terminal that has not taken the last frame holds the next one back', async () => {
  let pending = 4096
  const r = rig({ backlog: () => pending })
  r.player.start()
  await r.draw()
  await r.clock.advance(2000)
  assertEqual(r.swaps.length, 0, 'nothing is queued behind bytes still on their way')
  pending = 0
  await r.clock.advance(250)
  assertEqual(r.swaps.join(','), 'F1', 'the frame goes in once the terminal catches up')
})

await test('a placement that is gone, or a frame that cannot be made, stops it', async () => {
  const gone = rig({ swap: () => false })
  gone.player.start()
  await gone.draw()
  await gone.clock.advance(100)
  assert(gone.player.isStopped, 'a refused swap stops the player')
  assertEqual(gone.clock.pending, 0, 'with nothing left scheduled')

  const broken = rig({ frame: async index => (index === 0 ? 'P0' : null) })
  broken.frames.failure = 'broken'
  broken.player.start()
  await broken.draw()
  await broken.clock.advance(100)
  assert(broken.player.isStopped, 'a frame that cannot be made stops it, holding what is on screen')
  assertEqual(broken.swaps.length, 0, 'and nothing was swapped in')
})

await test('a file that ends early loops over the frames it had', async () => {
  const r = rig({ count: 4 })
  r.frames.frame = async index => {
    if (index >= 2) {
      // The decoder stopped at frame 2.
      r.frames.count = 2
      return null
    }
    return index === 0 ? 'P0' : `F${index}`
  }
  r.player.start()
  for (let i = 0; i < 3; i++) {
    await r.draw()
    await r.clock.advance(100)
  }
  assertEqual(r.swaps.join(','), 'F1,P0,F1', 'what played so far is the loop')
  assert(!r.player.isStopped, 'and it keeps going')
})

await test('frames are given back while nothing can be drawn, and made again later', async () => {
  const r = rig()
  r.player.start()
  await r.draw()
  await r.clock.advance(100)
  assertEqual(r.releases(), 0, 'nothing given back while it plays')
  await r.clock.advance(15_000)
  assertEqual(r.releases(), 1, 'a frame undrawn for a while gives the rest back')
  await r.draw()
  await r.clock.advance(100)
  assertEqual(r.swaps.join(','), 'F1,F2', 'and a later draw picks it up again')
})

await test('stopping clears every timer', async () => {
  const r = rig()
  r.player.start()
  await r.draw()
  assert(r.clock.pending > 0, 'a frame is scheduled')
  r.player.stop()
  assertEqual(r.clock.pending, 0, 'nothing left after stop')
  await r.draw()
  await r.clock.advance(1000)
  assertEqual(r.swaps.length, 0, 'and a draw after stop changes nothing')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
