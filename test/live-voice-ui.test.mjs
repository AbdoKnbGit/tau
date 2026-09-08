import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { build } from 'esbuild'
import ts from 'typescript'

// Bundle production state machines, with no microphone, auth, network, timers,
// saved settings, or native addon involved in these deterministic tests.
const bundled = await build({
  stdin: {
    contents: ['pushToTalkHold', 'holdKeyGesture', 'recordingIndicator', 'liveAgentTurnTracker']
      .map(name => `export * from ${JSON.stringify(resolve(`src/voice/${name}.ts`))}`).join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const { createPushToTalkHold, createHoldKeyGesture, getRecordingIndicator, createLiveAgentTurnTracker } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

function fakeClock() {
  let now = 0
  let next = 1
  const tasks = new Map()
  return {
    setTimeout(callback, milliseconds) {
      const id = next++
      tasks.set(id, { at: now + milliseconds, callback })
      return id
    },
    clearTimeout(id) { tasks.delete(id) },
    advance(milliseconds) {
      const target = now + milliseconds
      for (;;) {
        const nextTask = [...tasks].filter(([, task]) => task.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!nextTask) break
        now = nextTask[1].at
        tasks.delete(nextTask[0])
        nextTask[1].callback()
      }
      now = target
    },
    pending: () => tasks.size,
  }
}

async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve() }

function holdFixture(begin) {
  const clock = fakeClock()
  const calls = []
  const hold = createPushToTalkHold({
    begin: async () => { calls.push('begin'); await begin?.() },
    end: () => calls.push('end'),
    onError: error => calls.push(error.message),
    clock,
  })
  return { clock, calls, hold }
}

test('hold opens once, repeats keep it open, and 200ms silence releases it', async () => {
  const { clock, calls, hold } = holdFixture()
  hold.press()
  await flush()
  for (let index = 0; index < 20; index++) { clock.advance(60); hold.press() }
  assert.deepEqual(calls, ['begin'])
  assert.equal(hold.isHolding(), true)
  clock.advance(199)
  assert.deepEqual(calls, ['begin'])
  clock.advance(1)
  assert.deepEqual(calls, ['begin', 'end'])
  assert.equal(hold.isHolding(), false)
  assert.equal(clock.pending(), 0)
})

test('release during asynchronous device startup closes a late microphone', async () => {
  let ready
  const { clock, calls, hold } = holdFixture(() => new Promise(resolve => { ready = resolve }))
  hold.press()
  await flush()
  clock.advance(200)
  assert.equal(hold.isHolding(), false)
  assert.deepEqual(calls, ['begin', 'end'])
  hold.press() // Cannot start a second device while the first is pending.
  await flush()
  assert.deepEqual(calls, ['begin', 'end'])
  ready()
  await flush()
  assert.deepEqual(calls, ['begin', 'end', 'end'])
  assert.equal(clock.pending(), 0)
})

test('disabling or unmounting cancels hold and ignores subsequent keys', async () => {
  const { clock, calls, hold } = holdFixture()
  hold.press()
  await flush()
  hold.cancel()
  assert.deepEqual(calls, ['begin', 'end'])
  hold.press()
  await flush()
  hold.dispose()
  hold.press()
  clock.advance(5000)
  assert.deepEqual(calls, ['begin', 'end', 'begin', 'end'])
  assert.equal(clock.pending(), 0)
})

test('modifier activation allows initial OS repeat delay, then uses normal release', async () => {
  const { clock, calls, hold } = holdFixture()
  hold.press(2000)
  await flush()
  clock.advance(900)
  assert.deepEqual(calls, ['begin'])
  hold.press()
  clock.advance(200)
  assert.deepEqual(calls, ['begin', 'end'])
})

test('a synchronous unmount before startup does not open the microphone', async () => {
  const { clock, calls, hold } = holdFixture()
  hold.press()
  hold.dispose()
  await flush()
  assert.ok(!calls.includes('begin'))
  assert.equal(clock.pending(), 0)
})

test('microphone startup errors clean up timers and allow a later retry', async () => {
  let fail = true
  const { clock, calls, hold } = holdFixture(async () => {
    if (fail) throw new Error('Microphone permission denied')
  })
  hold.press()
  await flush()
  assert.equal(hold.isHolding(), false)
  assert.equal(clock.pending(), 0)
  assert.deepEqual(calls, ['begin', 'end', 'Microphone permission denied'])
  fail = false
  hold.press()
  await flush()
  assert.equal(hold.isHolding(), true)
  hold.dispose()
})

function gestureFixture(initialText = '') {
  const clock = fakeClock()
  let text = initialText
  let holding = false
  const activations = []
  const gesture = createHoldKeyGesture({
    clock,
    activate: milliseconds => { activations.push(milliseconds); holding = true },
    isHolding: () => holding,
    stripTrailing(maximum, char, floor = 0) {
      let count = 0
      while (text[text.length - 1 - count] === char) count++
      const remove = Math.max(0, Math.min(maximum, count - floor))
      text = text.slice(0, text.length - remove)
      return count - remove
    },
  })
  return {
    clock, gesture, activations,
    press(repeats = 1, char = ' ') {
      const swallowed = gesture.press(repeats, char)
      if (!swallowed && char !== null) text += char.repeat(repeats)
      return swallowed
    },
    text: () => text,
    release() { holding = false },
  }
}

test('a single Space tap types a space and never records', () => {
  const f = gestureFixture('hello')
  assert.equal(f.press(), false)
  f.clock.advance(1000)
  assert.equal(f.text(), 'hello ')
  assert.deepEqual(f.activations, [])
})

test('a held Space removes only gesture spaces and preserves existing whitespace', () => {
  const f = gestureFixture('hello  ')
  f.press()
  f.clock.advance(500) // Standard OS first-repeat delay.
  for (let i = 0; i < 4; i++) { f.press(); f.clock.advance(50) }
  assert.equal(f.activations.length, 1)
  assert.equal(f.text(), 'hello  ')
  for (let i = 0; i < 8; i++) { assert.equal(f.press(), true); f.clock.advance(50) }
  assert.equal(f.text(), 'hello  ')
  f.release()
  assert.equal(f.press(), false)
  assert.equal(f.text(), 'hello   ')
})

test('batched repeats activate, modifier keys activate immediately, reset drops warmup', () => {
  const batched = gestureFixture('draft ')
  assert.equal(batched.press(5), true)
  assert.equal(batched.text(), 'draft ')
  const modified = gestureFixture()
  assert.equal(modified.press(1, null), true)
  assert.deepEqual(modified.activations, [2000])
  const reset = gestureFixture()
  reset.press()
  reset.press()
  reset.gesture.reset()
  assert.equal(reset.press(), false)
  assert.deepEqual(reset.activations, [])
  assert.equal(reset.clock.pending(), 1)
})

test('REC is red only while confirmed capture is recording', () => {
  assert.equal(getRecordingIndicator('off'), null)
  assert.deepEqual(getRecordingIndicator('recording'), {
    label: '● REC', hint: 'Release Space to send', color: 'error',
  })
  for (const phase of ['connecting', 'ready', 'working', 'speaking', 'error']) {
    assert.ok(getRecordingIndicator(phase))
    assert.notEqual(getRecordingIndicator(phase).label, '● REC')
  }
  assert.match(getRecordingIndicator('ready').hint, /Hold Space/)
  assert.match(getRecordingIndicator('error', 'Account unavailable').hint, /Account unavailable/)
})

function trackerFixture() {
  const calls = []
  const tracker = createLiveAgentTurnTracker({
    progress: (text, id) => calls.push(['progress', id, text]),
    finish: (text, id) => calls.push(['finish', id, text]),
  })
  return { tracker, calls }
}

test('queued voice request ignores the preexisting typed query and starts when executed', () => {
  const { tracker, calls } = trackerFixture()
  const typed = tracker.beginTurn(['existing typed task'])
  tracker.register('voice-1', 'inspect the repo')
  tracker.progress('unrelated answer', typed)
  tracker.finishTurn(typed, 'unrelated final')
  assert.deepEqual(calls, [])
  const voice = tracker.beginTurn(['inspect the repo'])
  assert.deepEqual(voice, ['voice-1'])
  tracker.progress('Inspecting files', voice)
  tracker.progress('Inspecting files', voice)
  tracker.finishTurn(voice, 'Found the cause')
  tracker.finishTurn(voice, 'Found the cause')
  assert.deepEqual(calls, [
    ['progress', 'voice-1', 'Inspecting files'], ['finish', 'voice-1', 'Found the cause'],
  ])
})

test('merged voice requests correlate separately and cancellation cannot complete another turn', () => {
  const { tracker, calls } = trackerFixture()
  tracker.register('a', 'first')
  tracker.register('b', 'second')
  const old = tracker.beginTurn(['first'])
  const current = tracker.beginTurn(['second'])
  tracker.progress('second progress', current)
  tracker.finishTurn(old, 'first interrupted')
  tracker.finishTurn(current, 'second done')
  assert.deepEqual(calls, [
    ['progress', 'b', 'second progress'], ['finish', 'a', 'first interrupted'], ['finish', 'b', 'second done'],
  ])
  tracker.register('c', 'same request')
  tracker.register('d', 'same request')
  assert.deepEqual(tracker.beginTurn(['same request', 'same request']), ['c', 'd'])
})

test('stopping voice clears queued and running requests; stale completion stays silent', () => {
  const { tracker, calls } = trackerFixture()
  tracker.register('a', 'running')
  tracker.register('b', 'queued')
  const ids = tracker.beginTurn(['running'])
  tracker.clear()
  tracker.progress('late progress', ids)
  tracker.finishTurn(ids, 'late final')
  assert.deepEqual(tracker.beginTurn(['queued']), [])
  assert.deepEqual(calls, [])
  tracker.register('c', 'submission failed')
  tracker.discard('c')
  assert.deepEqual(tracker.beginTurn(['submission failed']), [])
})

test('resume loading reset executes without the removed speech setter', () => {
  // Execute the real callback shared by /resume and turn completion. This
  // catches dangling runtime references, including the historical undefined
  // setStreamingSpeechText crash, without mounting the networked REPL.
  const file = ts.createSourceFile('REPL.tsx', readFileSync(resolve('src/screens/REPL.tsx'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let callback
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'resetLoadingState') {
      assert.ok(node.initializer && ts.isCallExpression(node.initializer))
      callback = node.initializer.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(callback && ts.isArrowFunction(callback), 'shared reset callback must exist')
  const values = {}
  const dependencies = {
    responseLengthRef: { current: 42 },
    apiMetricsRef: { current: [{ tokens: 10 }] },
  }
  for (const name of ['setIsExternalLoading', 'setUserInputOnProcessing', 'setStreamingText',
    'setStreamingToolUses', 'setSpinnerMessage', 'setSpinnerColor', 'setSpinnerShimmerColor']) {
    dependencies[name] = value => { values[name] = value }
  }
  for (const name of ['pickNewSpinnerTip', 'endInteractionSpan', 'clearSpeculativeChecks']) {
    dependencies[name] = () => { values[name] = (values[name] || 0) + 1 }
  }
  const source = ts.transpileModule(`(${callback.getText(file)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const reset = new Function(...Object.keys(dependencies), `return ${source}`)(...Object.values(dependencies))
  assert.doesNotThrow(reset)
  assert.equal(values.setIsExternalLoading, false)
  assert.equal(values.setStreamingText, null)
  assert.deepEqual(values.setStreamingToolUses, [])
  assert.equal(dependencies.responseLengthRef.current, 0)
  assert.deepEqual(dependencies.apiMetricsRef.current, [])
  assert.equal(values.clearSpeculativeChecks, 1)
})
