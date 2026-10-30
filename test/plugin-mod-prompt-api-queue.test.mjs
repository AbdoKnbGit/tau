import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, afterEach, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const original = process.cwd(), root = mkdtempSync(join(tmpdir(), 'tau-mod-submit-queue-'))
mkdirSync(join(root, 'config'))
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NODE_ENV: 'test',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(root)
const r = await loadMcpRuntime({
  paths: ['src/utils/plugins/mods/promptQueue.ts', 'src/utils/queueProcessor.ts', 'src/utils/midTurnNotifications.ts'],
  exports: ['enqueueModPrompt', 'getQueuedModPrompt', 'prepareQueuedModPrompt', 'acceptQueuedModPrompt',
    'dropQueuedModPrompt', 'dropModPromptsForOwner', 'dropAllQueuedModPrompts', 'bindQueuedModPrompt',
    'enqueue', 'dequeue', 'getCommandQueue', 'clearCommandQueue',
    'remove', 'removeByFilter', 'isQueuedCommandEditable', 'isQueuedCommandVisible', 'popAllEditable',
    'processQueueIfReady', 'isMidTurnNotification', 'setOriginalCwd', 'runCleanupFunctions'],
})
r.setOriginalCwd(root)
afterEach(() => { r.dropAllQueuedModPrompts(); r.clearCommandQueue() })
after(async () => { await r.runCleanupFunctions(); process.chdir(original); rmSync(root, { recursive: true, force: true, maxRetries: 10 }) })

const caller = (name = 'fixture') => ({ plugin: name, owner: {}, hook: 7 })
const queued = () => r.getCommandQueue().find(command => command.modPrompt)

test('submission arguments reject forged identity and malformed attachment metadata before enqueueing', () => {
  for (const input of [null, [], 'text', {}, { text: 1 }, { text: 'ok', asUser: false },
    ...['origin', 'turnId', 'wait', 'context', 'command', 'isMeta'].map(key => ({ text: 'ok', [key]: 'forged' })),
    { text: 'ok', attachments: {} }, { text: 'ok', attachments: [null] },
    { text: 'ok', attachments: [{ type: 'script' }] },
    { text: 'ok', attachments: [{ type: 'image', id: 'forged' }] },
    { text: 'ok', attachments: [{ type: 'document', filename: 3 }] },
  ]) {
    assert.throws(() => r.enqueueModPrompt(input, caller()), /prompt.submit/)
    assert.equal(r.getCommandQueue().length, 0)
  }
})

test('plugin prompt receipt waits for an accepted turn and keeps immutable provenance', async () => {
  const plugin = caller(), attachments = [{ type: 'document', filename: 'before.txt' }]
  const promise = r.enqueueModPrompt({ text: '/literal @file', attachments, asUser: true }, plugin)
  let settled = false
  void promise.then(() => { settled = true })
  const command = queued(), metadata = r.getQueuedModPrompt(command.uuid)
  assert.equal(command.mode, 'prompt')
  assert.equal(command.skipSlashCommands, true)
  assert.deepEqual(metadata.origin, { kind: 'plugin', name: 'fixture', asUser: true })
  assert.equal(metadata.skip.runtime, plugin.owner)
  assert.equal(metadata.skip.hook, 7)
  attachments[0].filename = 'changed.txt'
  assert.equal(metadata.attachments[0].filename, 'before.txt')
  assert.ok(Object.isFrozen(metadata) && Object.isFrozen(metadata.origin) && Object.isFrozen(metadata.attachments[0]))
  r.dequeue()
  await Promise.resolve()
  assert.equal(settled, false, 'dequeue is not turn acceptance')
  assert.equal(r.acceptQueuedModPrompt(command.uuid), false, 'only prepared prompts can be accepted')
  const context = ['core context']
  r.prepareQueuedModPrompt(command.uuid, { text: 'core rewrite', context, origin: { kind: 'plugin', name: 'forged' } })
  context.push('late context')
  await Promise.resolve()
  assert.equal(settled, false, 'hook completion is not turn acceptance')
  assert.equal(r.acceptQueuedModPrompt(command.uuid), true)
  assert.deepEqual(await promise, { text: 'core rewrite', context: ['core context'], origin: metadata.origin })
  assert.equal(r.getQueuedModPrompt(command.uuid), undefined)
  assert.equal(r.acceptQueuedModPrompt(command.uuid), false)
  assert.equal(r.dropQueuedModPrompt(command.uuid), false)
})

for (const operation of ['remove', 'filter', 'clear']) {
  test(`${operation} discards settle queued submissions without claiming a turn started`, async () => {
    const result = r.enqueueModPrompt({ text: operation }, caller())
    const command = queued()
    if (operation === 'remove') r.remove([command])
    else if (operation === 'filter') r.removeByFilter(value => value.uuid === command.uuid)
    else r.clearCommandQueue()
    assert.deepEqual(await result, { drop: 'the prompt was removed from the queue before it ran' })
    assert.equal(r.getCommandQueue().length, 0)
    assert.equal(r.getQueuedModPrompt(command.uuid), undefined)
  })
}

test('runtime cancellation settles dequeued prompts and does not cancel another owner', async () => {
  const first = caller('first'), second = caller('second'), signal = new AbortController()
  const result1 = r.enqueueModPrompt({ text: 'first' }, first, signal.signal)
  const command1 = r.dequeue()
  const result2 = r.enqueueModPrompt({ text: 'second' }, second)
  const command2 = queued()
  signal.abort()
  assert.ok((await result1).drop)
  assert.equal(r.getQueuedModPrompt(command1.uuid), undefined)
  assert.ok(r.getQueuedModPrompt(command2.uuid))
  r.dropModPromptsForOwner(first.owner, 'disabled')
  assert.ok(r.getQueuedModPrompt(command2.uuid))
  r.dropModPromptsForOwner(second.owner, 'disabled')
  assert.deepEqual(await result2, { drop: 'disabled' })
  assert.equal(r.getCommandQueue().length, 0)
})

test('already cancelled submissions never enter the queue and accepted turns leave no abort listener work', async () => {
  const controller = new AbortController()
  controller.abort()
  assert.ok((await r.enqueueModPrompt({ text: 'cancelled' }, caller(), controller.signal)).drop)
  assert.equal(r.getCommandQueue().length, 0)
  const live = new AbortController()
  const result = r.enqueueModPrompt({ text: 'accepted' }, caller(), live.signal)
  const command = r.dequeue()
  const processor = new AbortController()
  assert.equal(r.bindQueuedModPrompt(command.uuid, processor), true)
  r.prepareQueuedModPrompt(command.uuid, { text: 'accepted' })
  r.acceptQueuedModPrompt(command.uuid)
  live.abort()
  assert.equal((await result).text, 'accepted')
  assert.equal(processor.signal.aborted, false, 'disposal must not cancel an already accepted turn')
})

test('disposal cancels a dequeued processor while it awaits persistence before turn start', async () => {
  const plugin = caller(), processor = new AbortController()
  const result = r.enqueueModPrompt({ text: 'not yet running' }, plugin)
  const command = r.dequeue()
  assert.equal(r.bindQueuedModPrompt(command.uuid, processor), true)
  r.prepareQueuedModPrompt(command.uuid, { text: 'prepared' })
  r.dropModPromptsForOwner(plugin.owner, 'unloaded')
  assert.equal(processor.signal.aborted, true)
  assert.equal(processor.signal.reason, 'interrupt')
  assert.deepEqual(await result, { drop: 'unloaded' })
})

test('plugin submissions remain visible but cannot be pulled into the composer or any mid-turn drain', async () => {
  const result = r.enqueueModPrompt({ text: 'separate turn' }, caller())
  const command = queued()
  assert.equal(r.isQueuedCommandEditable(command), false)
  assert.equal(r.isQueuedCommandVisible(command), true)
  assert.equal(r.popAllEditable('typed', 5), undefined)
  for (const provider of ['anthropic', 'openai', 'gemini']) {
    for (const priority of ['now', 'next', 'later']) {
      for (const sleepRan of [false, true]) {
        assert.equal(r.isMidTurnNotification({ ...command, priority }, { sleepRan, isMainThread: true, provider }), false)
      }
    }
  }
  r.dropAllQueuedModPrompts('session stopped')
  assert.deepEqual(await result, { drop: 'session stopped' })
})

test('ordinary queued prompts never batch a plugin submission and the plugin reserves its runner synchronously', async () => {
  r.enqueue({ value: 'human first', mode: 'prompt' })
  const result = r.enqueueModPrompt({ text: 'plugin second' }, caller())
  r.enqueue({ value: 'human third', mode: 'prompt' })
  const batches = []
  let reserved = false
  const executeInput = async commands => {
    reserved = true
    batches.push(commands.map(command => command.value))
    for (const command of commands) {
      if (!command.modPrompt) continue
      r.prepareQueuedModPrompt(command.uuid, { text: command.value })
      r.acceptQueuedModPrompt(command.uuid)
    }
  }
  r.processQueueIfReady({ executeInput })
  assert.deepEqual(batches, [['human first']])
  reserved = false
  r.processQueueIfReady({ executeInput })
  assert.equal(reserved, true, 'the runner reserves its query guard before queue processing returns')
  assert.deepEqual(batches[1], ['plugin second'])
  assert.equal((await result).text, 'plugin second')
  r.processQueueIfReady({ executeInput })
  assert.deepEqual(batches[2], ['human third'])
})

for (const failure of ['return', 'reject', 'throw']) {
  test(`input processing ${failure} settles a receipt that never reached turn.start`, async () => {
    const result = r.enqueueModPrompt({ text: 'unaccepted' }, caller())
    r.processQueueIfReady({ executeInput: () => {
      if (failure === 'throw') throw new Error('synchronous processing failure')
      return failure === 'reject' ? Promise.reject(new Error('processing failed')) : Promise.resolve()
    } })
    const receipt = await result
    assert.ok(receipt.drop)
    if (failure !== 'return') assert.match(receipt.drop, /processing fail/)
    assert.equal(r.getCommandQueue().length, 0)
  })
}
