import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { after, test } from 'node:test'
import { build } from 'esbuild'

const root = fs.mkdtempSync(join(tmpdir(), 'tau-plan-editor-'))
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
const require = createRequire(import.meta.url)
const stubs = {
  '../history.js':
    'export const expandPastedTextRefs = x=>x, formatPastedTextRef=()=>"", getPastedTextRefNumLines=()=>0;',
  '../ink/instances.js': 'export default {get:()=>fixture.ink};',
  './editor.js':
    'export const getExternalEditor=()=>fixture.editor, classifyGuiEditor=()=>fixture.gui ? "code" : undefined;',
  './execSyncWrapper.js':
    'export const execSync_DEPRECATED=(...args)=>fixture.execSync(...args);',
  './fsOperations.js': 'export const getFsImplementation=()=>fixture.fs;',
  './ide.js': 'export const toIDEDisplayName=x=>x;',
  './slowOperations.js': 'export const writeFileSync_DEPRECATED=()=>{};',
  './tempfile.js': 'export const generateTempFilePath=()=>"unused";',
}
const built = await build({
  entryPoints: ['src/utils/promptEditor.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  plugins: [
    {
      name: 'editor-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          stubs[args.path]
            ? { path: args.path, namespace: 'fixture' }
            : undefined,
        )
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
        }))
      },
    },
  ],
})
function setup(overrides = {}) {
  const events = []
  const fixture = {
    fs,
    gui: false,
    editor: undefined,
    ink: Object.fromEntries(
      [
        'enterAlternateScreen',
        'exitAlternateScreen',
        'pause',
        'resume',
        'suspendStdin',
        'resumeStdin',
      ].map((name) => [name, () => events.push(name)]),
    ),
    execSync() {
      throw new Error(
        'The asynchronous plan editor must not block the event loop',
      )
    },
    ...overrides,
  }
  const module = { exports: {} }
  Function(
    'require',
    'module',
    'exports',
    'fixture',
    built.outputFiles[0].text,
  )(require, module, module.exports, fixture)
  return { r: module.exports, fixture, events }
}

test('plan editing keeps the event loop alive and restores terminal state', async () => {
  const file = join(root, 'saved plan.md'),
    script = join(root, 'edit.cjs')
  fs.writeFileSync(file, 'before')
  fs.writeFileSync(
    script,
    "setTimeout(()=>{require('node:fs').writeFileSync(process.argv[2],'after')},150)",
  )
  const { r, events } = setup({ editor: `"${process.execPath}" "${script}"` })
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
  }, 10)
  try {
    assert.deepEqual(await r.editFileInEditorAsync(file), { content: 'after' })
    assert.ok(
      ticks > 2,
      'lock heartbeat timers must run while the editor is open',
    )
    assert.deepEqual(events, ['enterAlternateScreen', 'exitAlternateScreen'])
  } finally {
    clearInterval(timer)
  }
})

test('editor failure restores GUI input and reports the existing error shape', async () => {
  const file = join(root, 'failure.md'),
    script = join(root, 'fail.cjs')
  fs.writeFileSync(file, 'unchanged')
  fs.writeFileSync(script, 'process.exit(7)')
  const { r, events } = setup({
    gui: true,
    editor: `"${process.execPath}" "${script}"`,
  })
  const result = await r.editFileInEditorAsync(file)
  assert.equal(result.content, null)
  assert.match(result.error, /exited with code 7/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged')
  assert.deepEqual(events, ['pause', 'suspendStdin', 'resumeStdin', 'resume'])
})

test('the existing synchronous editor API retains its return type and lifecycle', () => {
  const file = join(root, 'sync.md')
  fs.writeFileSync(file, 'sync contents')
  const { r, events } = setup({ editor: 'fixture-editor', execSync() {} })
  const result = r.editFileInEditor(file)
  assert.deepEqual(result, { content: 'sync contents' })
  assert.equal(result instanceof Promise, false)
  assert.deepEqual(events, ['enterAlternateScreen', 'exitAlternateScreen'])
})
