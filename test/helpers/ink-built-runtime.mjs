import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import React from 'react'
import { LegacyRoot } from 'react-reconciler/constants.js'

// Mounts components from the shipped bundle on the real Ink reconciler and
// feeds them terminal bytes the way App does, with the default key bindings.
// Run `npm run build` first; TAU_TEST_BUNDLE points at another build.

// Modules and bundle-scope names that mounting needs.
const INK_PATHS = [
  'src/utils/exportRenderer.tsx',
  'src/state/AppState.tsx',
  'src/state/store.ts',
  'src/ink/components/StdinContext.ts',
  'src/ink/events/input-event.ts',
  'src/ink/parse-keypress.ts',
]
const INK_EXPORTS = [
  'StdinContext: StdinContext_default', 'EventEmitter', 'InputEvent',
  'parseMultipleKeypresses', 'INITIAL_STATE', 'StaticKeybindingProvider',
  'AppStoreContext', 'createStore', 'getDefaultAppState', 'TerminalSizeContext',
  'TerminalWriteProvider', 'createNode', 'FocusManager', 'reconciler: reconciler_default',
  'StylePool', 'CharPool', 'HyperlinkPool', 'createScreen', 'cellAt', 'Output',
  'renderNodeToOutput', 'resetLayoutShifted',
]

export const KEYS = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', space: ' ' }

let loads = 0

/**
 * Loads the bundle with the CLI entry point disabled, runs the init of each
 * module in `paths` and returns the bundle-scope `exports` (as `name` or
 * `alias: name`) along with what `mount` needs. Settings, cwd and home are
 * read when the modules initialise, so set them up before calling this.
 */
export async function loadBuiltRuntime({ paths = [], exports = [] } = {}) {
  const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const distPath = resolve(repoDir, process.env.TAU_TEST_BUNDLE ?? 'dist/tau.mjs')
  const bundle = readFileSync(distPath, 'utf8')
  const entry = /\nvoid main\d*\(\);\r?\n/
  assert.match(bundle, entry, 'the test must disable the CLI entry point')
  const inits = [...INK_PATHS, ...paths].map(path => {
    const match = bundle.match(
      new RegExp(`var (init_\\w+) = __esm\\(\\{\\s*"${path.replaceAll('.', '\\.')}"\\(\\)`),
    )
    assert.ok(match, `missing built module ${path}`)
    return `${match[1]}();`
  })
  const harnessPath = join(dirname(distPath), `.ink-runtime-${process.pid}-${loads++}.mjs`)
  writeFileSync(harnessPath, bundle.replace(entry, '\n') + `
export function __inkRuntime() {
  ${inits.join(' ')}
  return { ${[...INK_EXPORTS, ...exports].join(', ')} };
}
`)
  try {
    const runtime = (await import(pathToFileURL(harnessPath).href)).__inkRuntime()
    assert.equal(runtime.INITIAL_STATE.mode, 'NORMAL', 'INITIAL_STATE must be the keypress parser state')
    return runtime
  } finally {
    unlinkSync(harnessPath)
  }
}

/**
 * Mounts `element` and returns helpers to press keys (raw terminal bytes),
 * type text, read the screen as text, wait for it to show something, and
 * unmount.
 */
export async function mount(runtime, element, { columns = 80, rows = 24 } = {}) {
  const { reconciler } = runtime
  const h = React.createElement
  const noop = () => {}
  const root = runtime.createNode('ink-root')
  root.focusManager = new runtime.FocusManager(() => false)
  const errors = []
  const onError = error => errors.push(error)
  const container = reconciler.createContainer(root, LegacyRoot, null, false,
    null, 'ink-built-runtime', onError, onError, onError, noop)
  const styles = new runtime.StylePool()
  const chars = new runtime.CharPool()
  const links = new runtime.HyperlinkPool()
  const store = runtime.createStore(runtime.getDefaultAppState())
  const emitter = new runtime.EventEmitter()
  const stdin = {
    stdin: process.stdin, setRawMode: noop, isRawModeSupported: true,
    internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null,
  }
  let keyState = runtime.INITIAL_STATE

  async function settle() {
    reconciler.flushSyncWork()
    await new Promise(setImmediate)
    reconciler.flushSyncWork()
    assert.deepEqual(errors, [], 'rendering must not throw')
  }

  function frame() {
    root.yogaNode.setWidth(columns)
    root.yogaNode.calculateLayout(columns)
    const height = Math.ceil(root.yogaNode.getComputedHeight())
    const screen = runtime.createScreen(columns, Math.max(1, height), styles, chars, links)
    const output = new runtime.Output({ width: columns, height, stylePool: styles, screen })
    runtime.resetLayoutShifted()
    runtime.renderNodeToOutput(root, output, { prevScreen: undefined })
    output.get()
    return Array.from({ length: height }, (_, y) => Array.from({ length: columns },
      (_, x) => runtime.cellAt(screen, x, y).char).join('').trimEnd()).join('\n')
  }

  reconciler.updateContainerSync(
    h(runtime.StdinContext.Provider, { value: stdin },
      h(runtime.TerminalSizeContext.Provider, { value: { columns, rows } },
        h(runtime.TerminalWriteProvider, { value: noop },
          h(runtime.AppStoreContext.Provider, { value: store },
            h(runtime.StaticKeybindingProvider, null, element))))),
    container, null, noop)
  await settle()

  return {
    store,
    frame,
    /** Sends raw terminal input, parsed and dispatched the way App does. */
    async press(bytes) {
      let [keys, next] = runtime.parseMultipleKeypresses(keyState, bytes)
      if (next.incomplete) {
        // A lone Esc waits for more bytes; App flushes it on a timer.
        const [flushed, rest] = runtime.parseMultipleKeypresses(next, null)
        keys = [...keys, ...flushed]
        next = rest
      }
      keyState = next
      for (const key of keys.filter(k => k.kind === 'key')) {
        reconciler.discreteUpdates(() => emitter.emit('input', new runtime.InputEvent(key)))
        await settle()
      }
    },
    async type(text) {
      for (const char of text) await this.press(char)
    },
    /** Lets effects and suspended work finish until the screen matches. */
    async waitFor(pattern, timeout = 10_000) {
      const start = Date.now()
      while (!pattern.test(frame())) {
        assert.ok(Date.now() - start < timeout, `timed out waiting for ${pattern}\n${frame()}`)
        await new Promise(r => setTimeout(r, 20))
        await settle()
      }
    },
    close() {
      reconciler.updateContainerSync(null, container, null, noop)
      reconciler.flushSyncWork()
    },
  }
}
