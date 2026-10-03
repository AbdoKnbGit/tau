/**
 * Tau mascot checks: the art's geometry, the motion rules, and the signals
 * read from the transcript.
 *
 * Run via: bun run src/components/TauMascot/mascot.test.ts
 */

import {
  CLEAR,
  composeRows,
  MASCOT_ROWS,
  mascotPalette,
  type MascotMode,
  type MascotTone,
  type Pose,
  rowWidth,
  SPRITE_H,
  SPRITE_W,
  spriteFor,
} from './art.js'
import {
  activityForTools,
  advance,
  BONK_FRAMES,
  DONE_FRAMES,
  endedCleanly,
  endTurn,
  HEAVY_CONTEXT,
  initialMascotState,
  KNEEL_CONTEXT,
  latestFailureKey,
  MIN_ACT_FRAMES,
  MIN_ROOM,
  MIN_THINK_FRAMES,
  type MascotSignals,
  type MascotState,
  type MessageLike,
  placeOnTrack,
  poseFor,
  toolNamesInProgress,
} from './motion.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(condition: boolean, hint: string): void {
  if (!condition) throw new Error(hint)
}

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(`${hint}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

const SIGNALS: MascotSignals = {
  working: true,
  waiting: false,
  thinking: false,
  activity: undefined,
  failureKey: undefined,
  context: 0,
}

function signals(over: Partial<MascotSignals>): MascotSignals {
  return { ...SIGNALS, ...over }
}

function run(
  state: MascotState,
  frames: number,
  over: Partial<MascotSignals>,
  room = 60,
): MascotState {
  let next = state
  for (let i = 0; i < frames; i++) next = advance(next, signals(over), room)
  return next
}

/** Every pose the motion rules can produce, gathered by playing them through. */
function allPoses(): Pose[] {
  const poses = new Map<string, Pose>()
  const add = (pose: Pose) => poses.set(JSON.stringify(pose), pose)
  const scenes: Partial<MascotSignals>[] = [
    {},
    { thinking: true },
    { activity: 'edit' },
    { activity: 'run' },
    { activity: 'read' },
    { activity: 'think' },
    { context: HEAVY_CONTEXT },
    { context: KNEEL_CONTEXT },
  ]
  for (const over of scenes) {
    let state = initialMascotState(undefined)
    for (let i = 0; i < 48; i++) {
      state = advance(state, signals(over), 40)
      add(poseFor(state, signals(over), true))
    }
  }
  let state = initialMascotState(undefined)
  state = advance(state, signals({ failureKey: 'f1' }), 40)
  for (let i = 0; i < BONK_FRAMES; i++) {
    add(poseFor(state, SIGNALS, true))
    state = advance(state, signals({ failureKey: 'f1' }), 40)
  }
  state = endTurn(initialMascotState(undefined), true)
  for (let i = 0; i < DONE_FRAMES; i++) {
    add(poseFor(state, signals({ working: false }), true))
    state = advance(state, signals({ working: false }), 40)
  }
  for (const waiting of [false, true]) {
    for (const context of [0, KNEEL_CONTEXT]) {
      add(poseFor(state, signals({ working: false, waiting, context }), false))
    }
  }
  return [...poses.values()]
}

const TONES: MascotTone[] = ['dark', 'light']
const MODES: MascotMode[] = ['normal', 'cheap', 'full']
const ALLOWED = new Set([' ', String.fromCodePoint(0x2580), String.fromCodePoint(0x2584)])

console.log('art')

test('every row of every pose fits its track and keeps the band 8 rows tall', () => {
  const palette = mascotPalette('dark', 'normal')
  const poses = allPoses()
  assert(poses.length > 20, `expected a full set of poses, got ${poses.length}`)
  for (const pose of poses) {
    for (const facing of [1, -1] as const) {
      const sprite = spriteFor(pose, facing, palette)
      for (const track of [SPRITE_W, SPRITE_W + 1, 40, 81, 120]) {
        for (let x = 0; x <= track - SPRITE_W; x += Math.max(1, Math.floor((track - SPRITE_W) / 7))) {
          const rows = composeRows(sprite, x, track)
          assertEqual(rows.length, MASCOT_ROWS, 'row count')
          for (const runs of rows) {
            const width = rowWidth(runs)
            assert(width >= 1, 'an empty row would collapse the band')
            assert(width <= track, `row ${width} wider than track ${track}`)
            for (const cell of runs) {
              for (const ch of cell.text) assert(ALLOWED.has(ch), `unexpected glyph ${ch.codePointAt(0)}`)
              const drawn = cell.text.trim().length > 0
              assert(drawn === (cell.fg !== undefined), 'drawn cells carry a color, blank ones none')
            }
          }
        }
      }
    }
  }
})

test('a row never starts past the track, even placed beyond it', () => {
  const sprite = spriteFor(poseFor(initialMascotState(undefined), SIGNALS, true), 1, mascotPalette('dark', 'normal'))
  for (const runs of composeRows(sprite, 500, 40)) {
    assert(rowWidth(runs) <= 40, 'clamped to the track')
  }
})

test('blank cells inherit the background: no color on spaces', () => {
  const sprite = spriteFor(poseFor(initialMascotState(undefined), SIGNALS, false), 1, mascotPalette('light', 'normal'))
  for (const runs of composeRows(sprite, 12, 60)) {
    for (const cell of runs) {
      if (cell.text.trim() === '') {
        assert(cell.fg === undefined && cell.bg === undefined, 'spaces carry no color')
      }
    }
  }
})

/** The τ's pixels as a normalized bitmap. */
function tauShape(sprite: Int32Array, color: number): string {
  let minX = SPRITE_W
  let minY = SPRITE_H
  const cells: [number, number][] = []
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      if (sprite[y * SPRITE_W + x] === color) {
        cells.push([x, y])
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
      }
    }
  }
  return cells.map(([x, y]) => `${x - minX},${y - minY}`).sort().join(' ')
}

test('the upright τ reads the right way round facing either way', () => {
  const palette = mascotPalette('dark', 'normal')
  assert(palette.ray !== palette.glow, 'rays are told apart from the glowing τ')
  for (const pose of allPoses().filter(p => p.tau === 'palm' || p.tau === 'raised')) {
    const color = pose.glow ? palette.glow : palette.tau
    const right = tauShape(spriteFor(pose, 1, palette), color)
    const left = tauShape(spriteFor(pose, -1, palette), color)
    assert(right.length > 0, 'the τ is drawn')
    assertEqual(left, right, `τ mirrored in ${JSON.stringify(pose)}`)
  }
})

test('facing left mirrors the figure', () => {
  const palette = mascotPalette('dark', 'normal')
  const pose = poseFor(initialMascotState(undefined), SIGNALS, false)
  const right = spriteFor(pose, 1, palette)
  const left = spriteFor(pose, -1, palette)
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      const a = right[y * SPRITE_W + x]!
      const b = left[y * SPRITE_W + (SPRITE_W - 1 - x)]!
      if (a === palette.front || a === palette.side || a === palette.back) {
        assertEqual(b, a, `body pixel ${x},${y}`)
      }
    }
  }
})

function luminance(rgb: number): number {
  const r = ((rgb >> 16) & 0xff) / 255
  const g = ((rgb >> 8) & 0xff) / 255
  const b = (rgb & 0xff) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test('the τ stands out from the body and from the background', () => {
  for (const tone of TONES) {
    for (const mode of MODES) {
      const palette = mascotPalette(tone, mode)
      assert(palette.tau !== palette.front && palette.tau !== palette.side, 'τ differs from the body')
      const l = luminance(palette.tau)
      if (tone === 'dark') assert(l > 0.55, `${mode} τ too dim on dark (${l.toFixed(2)})`)
      else assert(l < 0.4, `${mode} τ too pale on light (${l.toFixed(2)})`)
    }
  }
  assert(mascotPalette('dark', 'cheap').tau !== mascotPalette('dark', 'normal').tau, 'cheap mode recolors the τ')
})

test('no palette color is the transparent sentinel', () => {
  for (const tone of TONES) {
    for (const mode of MODES) {
      const { id: _, ...colors } = mascotPalette(tone, mode)
      for (const value of Object.values(colors)) {
        assert(value !== CLEAR && value >= 0 && value <= 0xffffff, 'a real 24-bit color')
      }
    }
  }
})

console.log('motion')

test('walking stays on the track and turns at both ends', () => {
  let state = initialMascotState(undefined)
  let turns = 0
  let facing = state.facing
  for (let i = 0; i < 400; i++) {
    state = advance(state, SIGNALS, 30)
    assert(state.x >= 0 && state.x <= 30, `x ${state.x} off the track`)
    if (state.facing !== facing) {
      turns++
      facing = state.facing
    }
  }
  assert(turns >= 10, `expected many turns, got ${turns}`)
})

test('with no room to walk he stays put', () => {
  const state = run(initialMascotState(undefined), 50, {}, MIN_ROOM - 1)
  assertEqual(state.x, 0, 'x')
})

test('a narrower track pulls him back inside it', () => {
  const state = { ...initialMascotState(undefined), x: 90 }
  assertEqual(placeOnTrack(state, 20).x, 20, 'clamped x')
  assertEqual(advance(state, SIGNALS, 20).x <= 20, true, 'advance clamps too')
})

test('a heavy context halves his pace, a full one stops him', () => {
  const light = run(initialMascotState(undefined), 20, {}, 200)
  const heavy = run(initialMascotState(undefined), 20, { context: HEAVY_CONTEXT }, 200)
  const full = run(initialMascotState(undefined), 20, { context: KNEEL_CONTEXT }, 200)
  assertEqual(light.x, 20, 'one column a frame')
  assertEqual(heavy.x, 10, 'every other frame')
  assertEqual(full.x, 0, 'kneeling')
  assertEqual(poseFor(full, signals({ context: KNEEL_CONTEXT }), true).legs, 'knees', 'kneels')
})

test('running moves two columns a frame', () => {
  const state = run(initialMascotState(undefined), 10, { activity: 'run' }, 200)
  assertEqual(state.x, 20, 'x')
})

test('a tool reaction outlives a quick tool', () => {
  // The tool runs for one frame; the reaction shows for MIN_ACT_FRAMES.
  let state = advance(initialMascotState(undefined), signals({ activity: 'read' }), 60)
  let shown = 0
  while (state.act && shown < 100) {
    shown++
    state = advance(state, SIGNALS, 60)
  }
  assertEqual(shown, MIN_ACT_FRAMES, 'frames shown')
})

test('a new tool replaces the reaction at once', () => {
  let state = run(initialMascotState(undefined), 3, { activity: 'read' })
  state = advance(state, signals({ activity: 'edit' }), 60)
  assertEqual(state.act?.kind, 'edit', 'kind')
  assertEqual(state.act?.frame, 0, 'restarted')
})

test('a short thought still holds the thinking pose', () => {
  let state = advance(initialMascotState(undefined), signals({ thinking: true }), 60)
  let shown = 0
  while (state.think > 0 && shown < 100) {
    shown++
    state = advance(state, SIGNALS, 60)
  }
  assertEqual(shown, MIN_THINK_FRAMES, 'frames shown')
})

test('thinking and tool reactions stand still', () => {
  for (const over of [{ thinking: true }, { activity: 'edit' as const }, { activity: 'read' as const }]) {
    const state = run(initialMascotState(undefined), 20, over, 200)
    assertEqual(state.x, 0, `still for ${JSON.stringify(over)}`)
  }
})

test('each failure is reacted to once, and only while working', () => {
  let state = initialMascotState(undefined)
  state = advance(state, signals({ failureKey: 'a' }), 60)
  assertEqual(state.bonk, 0, 'reacts')
  state = run(state, BONK_FRAMES, { failureKey: 'a' })
  assertEqual(state.bonk, undefined, 'recovers')
  state = advance(state, signals({ failureKey: 'a' }), 60)
  assertEqual(state.bonk, undefined, 'not twice')
  state = advance(state, signals({ failureKey: 'b', working: false }), 60)
  assertEqual(state.bonk, undefined, 'not while idle')
  assertEqual(state.seenFailure, 'b', 'but noted')
})

test('a failure from before he appeared is not reacted to', () => {
  const state = advance(initialMascotState('old'), signals({ failureKey: 'old' }), 60)
  assertEqual(state.bonk, undefined, 'bonk')
})

test('the celebration plays once, then he stands still', () => {
  let state = endTurn(run(initialMascotState(undefined), 5, { activity: 'edit' }), true)
  assertEqual(state.act, undefined, 'reaction dropped')
  state = run(state, DONE_FRAMES, { working: false })
  assertEqual(state.done, undefined, 'over')
  assertEqual(endTurn(state, false).done, undefined, 'no celebration after an error')
})

test('a still band waits, kneels or stands', () => {
  const state = initialMascotState(undefined)
  assertEqual(poseFor(state, signals({ working: false, waiting: true }), false).eyes, 'down', 'looks at the dialog')
  assertEqual(poseFor(state, signals({ working: false, context: 1 }), false).legs, 'knees', 'too heavy to stand')
  assertEqual(poseFor(state, signals({ working: false }), false).tau, 'palm', 'holds the τ up')
})

console.log('signals')

test('tools map to what they look like, the most hands-on winning', () => {
  assertEqual(activityForTools([]), undefined, 'none')
  assertEqual(activityForTools(['Read', 'Grep']), 'read', 'reading')
  assertEqual(activityForTools(['Read', 'Bash']), 'run', 'run beats read')
  assertEqual(activityForTools(['Bash', 'Edit', 'Agent']), 'edit', 'edit beats all')
  assertEqual(activityForTools(['PowerShell']), 'run', 'tau shell')
  assertEqual(activityForTools(['ApplyPatch']), 'edit', 'codex patch')
  assertEqual(activityForTools(['CodebaseRetrieval']), 'read', 'tau search')
  assertEqual(activityForTools(['Agent']), 'think', 'delegating')
  assertEqual(activityForTools(['TodoWrite']), undefined, 'bookkeeping shows nothing')
  assertEqual(activityForTools(['mcp__github__list_issues']), 'read', 'mcp read')
  assertEqual(activityForTools(['mcp__github__create_issue']), 'edit', 'mcp write')
  assertEqual(activityForTools(['mcp__svc__frobnicate']), 'run', 'mcp other')
})

function assistant(blocks: object[], extra: object = {}): MessageLike {
  return { type: 'assistant', message: { content: blocks as never }, ...extra }
}
function user(blocks: object[] | string, extra: object = {}): MessageLike {
  return { type: 'user', message: { content: blocks as never }, ...extra }
}

test('running tool names come from the latest assistant messages', () => {
  const messages = [
    assistant([{ type: 'tool_use', id: 't1', name: 'Read' }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    assistant([{ type: 'text', text: 'next' }]),
    assistant([{ type: 'tool_use', id: 't2', name: 'Bash' }]),
    assistant([{ type: 'tool_use', id: 't3', name: 'Edit' }]),
  ]
  assertEqual(toolNamesInProgress(messages, new Set(['t2', 't3'])).sort().join(), 'Bash,Edit', 'names')
  assertEqual(toolNamesInProgress(messages, new Set()).length, 0, 'none running')
})

const choice = (text: string) => text.startsWith('The user doesn')

test('the latest failure is found, the person\'s own choices are not failures', () => {
  const messages = [
    user([{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'boom' }]),
    user([{ type: 'tool_result', tool_use_id: 'b', is_error: false, content: 'fine' }]),
    user([{ type: 'tool_result', tool_use_id: 'c', is_error: true, content: [{ type: 'text', text: "The user doesn't want to proceed" }] }]),
  ]
  assertEqual(latestFailureKey(messages, choice), 'a', 'skips the rejection')
  messages.push(user([{ type: 'tool_result', tool_use_id: 'd', is_error: true, content: [{ type: 'text', text: 'Exit code 1' }] }]))
  assertEqual(latestFailureKey(messages, choice), 'd', 'newest')
  assertEqual(latestFailureKey([user('plain text')], choice), undefined, 'none')
})

test('a turn ends cleanly only with an answer', () => {
  const answer = assistant([{ type: 'text', text: 'All done.' }])
  assertEqual(endedCleanly([answer]), true, 'answer')
  assertEqual(endedCleanly([answer, { type: 'system' }, user('note', { isMeta: true })]), true, 'trailing notes skipped')
  assertEqual(endedCleanly([assistant([{ type: 'text', text: 'API Error' }], { isApiErrorMessage: true })]), false, 'api error')
  assertEqual(endedCleanly([answer, user([{ type: 'text', text: '[Request interrupted by user]' }])]), false, 'interrupted')
  assertEqual(endedCleanly([assistant([{ type: 'tool_use', id: 'x', name: 'Bash' }])]), false, 'no answer')
  assertEqual(endedCleanly([]), false, 'empty')
})

console.log('golden scenes')

// FNV-1a over every frame's rows, colors included: any pixel change in a
// scripted scene changes its fingerprint. Regenerate on purpose only, after
// looking at the new frames.
function fingerprint(frames: string[]): string {
  let hash = 0x811c9dc5
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++) {
      hash ^= frame.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  return hash.toString(16).padStart(8, '0')
}

function scene(over: Partial<MascotSignals>[], tone: MascotTone, mode: MascotMode = 'normal'): string {
  const palette = mascotPalette(tone, mode)
  let state = initialMascotState(undefined)
  const frames: string[] = []
  for (const step of over) {
    state = advance(state, signals(step), 50)
    const rows = composeRows(spriteFor(poseFor(state, signals(step), true), state.facing, palette), state.x, 78)
    frames.push(JSON.stringify(rows))
  }
  return fingerprint(frames)
}

const repeat = (over: Partial<MascotSignals>, n: number) => Array.from({ length: n }, () => over)
const WORKDAY: Partial<MascotSignals>[] = [
  ...repeat({}, 60),
  ...repeat({ thinking: true }, 12),
  ...repeat({ activity: 'read' }, 14),
  ...repeat({ activity: 'edit' }, 14),
  ...repeat({ activity: 'run' }, 30),
  ...repeat({ failureKey: 'x' }, 16),
  ...repeat({ context: HEAVY_CONTEXT }, 20),
  ...repeat({ context: KNEEL_CONTEXT }, 8),
]

const GOLDEN: Record<string, string> = {
  'workday, dark': '8e1189a3',
  'workday, light': '24f430f5',
  'workday, cheap mode': '939427fd',
}

const SCENES: Record<string, () => string> = {
  'workday, dark': () => scene(WORKDAY, 'dark'),
  'workday, light': () => scene(WORKDAY, 'light'),
  'workday, cheap mode': () => scene(WORKDAY, 'dark', 'cheap'),
}

for (const [name, play] of Object.entries(SCENES)) {
  test(`golden: ${name}`, () => {
    const got = play()
    if (process.env.MASCOT_PRINT_GOLDEN) console.log(`    '${name}': '${got}',`)
    assertEqual(got, GOLDEN[name], 'fingerprint')
  })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
