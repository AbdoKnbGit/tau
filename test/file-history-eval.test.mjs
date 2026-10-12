import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fixtureContext, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// File history for writes that come from code (Eval cells): what gets tracked,
// and what the /rewind list says each stretch of the conversation changed.
const tempRoot = realpathSync(tmpdir())
const fixture = mkdtempSync(join(tempRoot, 'tau-file-history-'))
process.env.CLAUDE_CONFIG_DIR = join(fixture, 'config')
process.env.DISABLE_TELEMETRY = '1'
process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING

const r = await loadMcpRuntime({
  paths: ['src/utils/fileHistory.ts', 'src/components/MessageSelector.tsx',
    'src/tools/EvalTool/EvalTool.ts', 'src/utils/forcedProvider.ts', 'src/utils/cwd.ts',
    'src/utils/agentContext.ts', 'src/utils/model/providers.ts'],
  exports: ['createFileHistoryBatch', 'fileHistoryGetDiffStatsBetween', 'fileHistoryMakeSnapshot',
    'MAX_BATCH_BACKUP_BYTES', 'MAX_BATCH_CREATED_FILES', 'turnHasUnpatchedWrites',
    'EvalTool', 'acquireKernel', 'discardKernel', 'resolvePythonInterpreter', 'getCwd',
    'runWithCwdOverride', 'runWithForcedProvider', 'runWithAgentContext', 'getAgentContext',
    'getAPIProvider', 'setActiveProvider'],
})

test.after(async () => {
  await r.disposeToolBridge()
  const resolved = realpathSync(fixture)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'unsafe fixture cleanup path')
  rmSync(resolved, { recursive: true, force: true })
})

/** A file history that starts with one snapshot, as a session does after its first prompt. */
function history(messageId) {
  let state = {
    snapshots: [{ messageId, trackedFileBackups: {}, timestamp: new Date() }],
    trackedFiles: new Set(),
    snapshotSequence: 1,
  }
  return {
    get state() { return state },
    update: updater => { state = updater(state) },
  }
}

function workDir(name) {
  const dir = join(fixture, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('a cell tracks its edits but leaves big files and bulk output untracked', async () => {
  const dir = workDir('caps')
  const h = history(randomUUID())
  const small = join(dir, 'train.py')
  const big = join(dir, 'model.pt')
  writeFileSync(small, 'print(1)\n')
  writeFileSync(big, Buffer.alloc(r.MAX_BATCH_BACKUP_BYTES + 1))
  const batch = r.createFileHistoryBatch(h.update, h.state.snapshots[0].messageId)
  await batch.backup(small)
  await batch.backup(big)

  const made = Array.from({ length: r.MAX_BATCH_CREATED_FILES + 5 }, (_, i) => join(dir, `sample-${i}.json`))
  for (const path of made) {
    writeFileSync(path, '{}\n')
    await batch.backup(path, { createdFile: true })
  }
  // Before the commit: one new file grew past the limit, one was deleted again.
  writeFileSync(made[0], Buffer.alloc(r.MAX_BATCH_BACKUP_BYTES + 1))
  unlinkSync(made[1])
  await batch.commit()

  const tracked = Object.keys(h.state.snapshots[0].trackedFileBackups)
  assert.equal(tracked.length, 1 + r.MAX_BATCH_CREATED_FILES - 2)
  assert.ok(tracked.some(path => path.endsWith('train.py')))
  for (const gone of [big, made[0], made[1], ...made.slice(r.MAX_BATCH_CREATED_FILES)]) {
    assert.ok(!tracked.some(path => path.endsWith(gone.split(/[\\/]/).at(-1))), `${gone} was tracked`)
  }
  assert.deepEqual([...batch.skipped].sort(), [big, made[0], ...made.slice(r.MAX_BATCH_CREATED_FILES)].sort())
  assert.equal(h.state.trackedFiles.size, tracked.length)
})

test('the rewind list reads what a stretch changed from file history', async () => {
  const dir = workDir('stretch')
  const first = randomUUID()
  const second = randomUUID()
  const h = history(first)
  const edited = join(dir, 'items.py')
  const made = join(dir, 'components.py')
  writeFileSync(edited, 'a\nb\nc\n')

  // Turn 1: a cell edits one file and creates another.
  const batch = r.createFileHistoryBatch(h.update, first)
  await batch.backup(edited)
  writeFileSync(edited, 'a\nB\nc\nd\n')
  writeFileSync(made, 'def card():\n    return 1\n')
  await batch.backup(made, { createdFile: true })
  await batch.commit()
  await r.fileHistoryMakeSnapshot(h.update, second)

  const turn = await r.fileHistoryGetDiffStatsBetween(h.state, first, second)
  assert.deepEqual([...turn.filesChanged].sort(), [made, edited].sort())
  assert.equal(turn.insertions, 2 + 2)
  assert.equal(turn.deletions, 1)

  // Turn 2 has changed nothing yet; then the file changes on disk.
  const idle = await r.fileHistoryGetDiffStatsBetween(h.state, second, undefined)
  assert.deepEqual(idle, { filesChanged: [], insertions: 0, deletions: 0 })
  writeFileSync(edited, 'a\nB\nc\nd\ne\n')
  const live = await r.fileHistoryGetDiffStatsBetween(h.state, second, undefined)
  assert.deepEqual(live, { filesChanged: [edited], insertions: 1, deletions: 0 })

  assert.equal(await r.fileHistoryGetDiffStatsBetween(h.state, first, randomUUID()), undefined)
  assert.equal(await r.fileHistoryGetDiffStatsBetween(h.state, randomUUID(), undefined), undefined)
})

test('a huge rewrite is counted without stalling the rewind list', async () => {
  const dir = workDir('rewrite')
  const first = randomUUID()
  const h = history(first)
  const data = join(dir, 'table.csv')
  const rows = seed => Array.from({ length: 40_000 }, (_, i) => `${i},${seed},${(i * 7919 + seed) % 104729}`).join('\n') + '\n'
  writeFileSync(data, rows(1))
  const batch = r.createFileHistoryBatch(h.update, first)
  await batch.backup(data)
  await batch.commit()
  writeFileSync(data, rows(2))
  const started = Date.now()
  const stats = await r.fileHistoryGetDiffStatsBetween(h.state, first, undefined)
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`)
  assert.deepEqual(stats.filesChanged, [data])
  assert.ok(stats.insertions >= 39_000 && stats.deletions >= 39_000, JSON.stringify(stats))
})

test('only stretches with an Eval or notebook call read file history', () => {
  const [one, two, three] = [randomUUID(), randomUUID(), randomUUID()]
  const user = uuid => ({ type: 'user', uuid, message: { role: 'user', content: 'go' } })
  const call = (name, uuid = randomUUID()) => ({ type: 'assistant', uuid,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: randomUUID(), name, input: {} }] } })
  const messages = [user(one), call('Eval'), user(two), call('Edit'), user(three), call('NotebookEdit')]
  assert.equal(r.turnHasUnpatchedWrites(messages, one, two), true)
  assert.equal(r.turnHasUnpatchedWrites(messages, two, three), false)
  assert.equal(r.turnHasUnpatchedWrites(messages, three, undefined), true)
  assert.equal(r.turnHasUnpatchedWrites(messages, randomUUID(), undefined), false)
})

test('real EvalTool wires aliases and persistent cwd to the owning effective provider', { timeout: 60_000 }, async t => {
  if (!r.resolvePythonInterpreter()) return t.skip('No Python interpreter available')
  const routes = [
    { global: 'gemini', pin: 'openai', model: 'gpt-6-sol', openai: true },
    { global: 'openai', pin: 'gemini', model: 'gpt-5.6-luna', openai: false },
    { global: 'gemini', model: 'gpt-5.6-luna', openai: true },
    { global: 'openai', model: 'gemini-2.5-pro', openai: false },
  ]
  const previousProvider = r.getAPIProvider()
  try {
    for (const [index, route] of routes.entries()) {
      const root = workDir(`provider-${index}`)
      const sub = join(root, 'sub folder ü')
      mkdirSync(sub)
      const agentId = `eval-provider-${index}`
      const messageId = randomUUID()
      const h = history(messageId)
      const read = fixtureTool({ name: 'Read', async call() { return { data: 'fixture contents' } } })
      const context = fixtureContext([read], { agentId, updateFileHistoryState: h.update })
      context.options.mainLoopModel = route.model
      const parent = { type: 'assistant', uuid: messageId, message: { role: 'assistant', content: [] } }
      r.setActiveProvider(route.global)
      let permissionCalls = 0
      const cell = (cwd, code) => r.runWithAgentContext({ agentId, agentType: 'subagent' }, () =>
        r.runWithCwdOverride(cwd, () => {
          const run = () => r.EvalTool.call({ code, timeout: 15 }, context, async (tool, input) => {
            assert.equal(tool.name, 'Read')
            assert.deepEqual(input, { file_path: 'fixture.txt' })
            assert.equal(r.getAPIProvider(), route.pin ?? route.global)
            assert.equal(r.getAgentContext()?.agentId, agentId)
            assert.equal(r.getCwd(), cwd)
            permissionCalls++
            return { behavior: 'allow', updatedInput: input }
          }, parent)
          return route.pin ? r.runWithForcedProvider({ provider: route.pin }, run) : run()
        }),
      )
      try {
        const aliasCode = route.openai
          ? 'assert tool.read_file(file_path="fixture.txt") == "fixture contents"'
          : [
              'assert "read_file (Read)" not in tool.list()',
              'try:',
              '    tool.read_file(file_path="fixture.txt")',
              'except ToolBridgeError as error:',
              '    assert str(error) == "read_file is not a tool in this session. Call tool.list() to see what is available."',
              'else:',
              '    raise AssertionError("OpenAI alias leaked to another provider")',
            ].join('\n')
        const setup = await cell(root, `x = 42\nassert tool.Read(file_path="fixture.txt") == "fixture contents"\n${aliasCode}`)
        assert.equal(setup.data.ok, true, `${JSON.stringify(route)}: ${setup.data.text}`)
        assert.equal(permissionCalls, route.openai ? 2 : 1)
        const next = await cell(sub, 'import os\nprint(globals().get("x", "missing"))\nprint(os.getcwd())')
        assert.equal(next.data.ok, true, next.data.text)
        assert.deepEqual(next.data.text.split(/\r?\n/), [route.openai ? '42' : 'missing', realpathSync(sub)], JSON.stringify(route))
        assert.equal(next.data.kernelRestarted, false)
      } finally {
        for (const cwd of route.openai ? [root] : [root, sub]) {
          const { kernel } = await r.acquireKernel({ agentId, cwd, reset: false, followSessionCwd: route.openai })
          await kernel.shutdown()
          r.discardKernel(agentId, cwd, route.openai)
        }
      }
    }
  } finally {
    r.setActiveProvider(previousProvider)
  }
})
