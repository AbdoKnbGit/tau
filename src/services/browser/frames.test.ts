/** Frame routing lifecycle regressions. Run: bun run src/services/browser/frames.test.ts */
import assert from 'node:assert/strict'
import { FrameRouter } from './frames.js'
import type { CdpClient } from './cdp.js'

type Listener = (params: any, sessionId?: string) => void
type Tree = { frame: { id: string; parentId?: string }; childFrames?: Tree[] }
class FakeCdp {
  listeners = new Map<string, Listener[]>()
  calls: Array<{ method: string; params: any; sessionId?: string }> = []
  trees = new Map<string, Tree>()
  attachments = new Map<string, { sessionId: string; frameId?: string; contextId?: number }>()
  evaluateReply: unknown = { result: { value: true } }
  geometryReply: unknown = { result: { value: { x: 10, y: 20, sx: 1, sy: 1, width: 500, height: 500 } } }
  onSend?: (method: string) => void
  on(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
  emit(name: string, params: unknown, sessionId?: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener(params, sessionId)
  }
  context(sessionId: string, id: number, frameId: string): void {
    this.emit('Runtime.executionContextCreated', { context: { id, auxData: { frameId, isDefault: true } } }, sessionId)
  }
  async send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    this.calls.push({ method, params, sessionId })
    this.onSend?.(method)
    if (method === 'Page.getFrameTree') {
      const frameTree = this.trees.get(sessionId!)
      if (!frameTree) throw new Error('No live frame tree')
      return { frameTree }
    }
    if (method === 'Target.attachToTarget') {
      const attachment = this.attachments.get(params.targetId)
      if (!attachment) throw new Error('No such target')
      this.trees.set(attachment.sessionId, { frame: { id: attachment.frameId ?? params.targetId } })
      return { sessionId: attachment.sessionId }
    }
    if (method === 'Runtime.enable') {
      const attachment = [...this.attachments.entries()].find(([, item]) => item.sessionId === sessionId)
      if (attachment && attachment[1].contextId !== undefined) this.context(sessionId!, attachment[1].contextId, attachment[0])
    }
    if (method === 'Runtime.evaluate') return this.evaluateReply
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 1 }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'frame-owner' } }
    if (method === 'Runtime.callFunctionOn') return this.geometryReply
    return {}
  }
}
function setup() {
  const client = new FakeCdp()
  const router = new FrameRouter(client as unknown as CdpClient)
  router.registerTop('tab-a', 'root-a')
  client.trees.set('root-a', { frame: { id: 'top-a' }, childFrames: [{ frame: { id: 'child-a', parentId: 'top-a' } }] })
  client.context('root-a', 1, 'top-a')
  client.context('root-a', 2, 'child-a')
  return { client, router }
}
let passed = 0
let failed = 0
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`  ok ${name}`) }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`) }
}

await check('frame focus is independent for each tab', async () => {
  const { client, router } = setup()
  router.registerTop('tab-b', 'root-b')
  client.trees.set('root-b', { frame: { id: 'top-b' }, childFrames: [{ frame: { id: 'child-b', parentId: 'top-b' } }] })
  client.context('root-b', 3, 'top-b')
  client.context('root-b', 4, 'child-b')
  await router.enter('tab-a', 'child-a')
  await router.enter('tab-b', 'child-b')
  router.top('tab-a')
  assert.deepEqual(await router.runtime('tab-a', 'root-a'), { sessionId: 'root-a' })
  assert.equal((await router.runtime('tab-b', 'root-b')).frameId, 'child-b')
})
await check('removed focused frames fail instead of falling back to top', async () => {
  const { client, router } = setup()
  await router.enter('tab-a', 'child-a')
  client.emit('Page.frameDetached', { frameId: 'child-a', reason: 'remove' }, 'root-a')
  await assert.rejects(() => router.runtime('tab-a', 'root-a'), /frame_unreachable/)
  assert.equal(router.selected('tab-a'), 'child-a')
  router.top('tab-a')
  assert.deepEqual(await router.runtime('tab-a', 'root-a'), { sessionId: 'root-a' })
})
await check('cleared contexts are unusable until recreated', async () => {
  const { client, router } = setup()
  await router.enter('tab-a', 'child-a')
  client.emit('Runtime.executionContextsCleared', {}, 'root-a')
  await assert.rejects(() => router.runtime('tab-a', 'root-a'), /frame_unreachable/)
  client.context('root-a', 30, 'child-a')
  assert.equal((await router.runtime('tab-a', 'root-a')).contextId, 30)
})
await check('destroyed contexts cannot be reused after replacement', async () => {
  const { client, router } = setup()
  await router.enter('tab-a', 'child-a')
  client.emit('Runtime.executionContextDestroyed', { executionContextId: 2 }, 'root-a')
  client.context('root-a', 31, 'child-a')
  assert.equal((await router.runtime('tab-a', 'root-a')).contextId, 31)
})
await check('only top navigation resets frame focus', async () => {
  const { client, router } = setup()
  await router.enter('tab-a', 'child-a')
  client.emit('Page.frameNavigated', { frame: { id: 'child-a', parentId: 'top-a' } }, 'root-a')
  assert.equal(router.selected('tab-a'), 'child-a')
  client.emit('Page.frameNavigated', { frame: { id: 'top-a' } }, 'root-a')
  assert.equal(router.selected('tab-a'), undefined)
})
await check('attachment identity mismatch detaches and retains prior focus', async () => {
  const { client, router } = setup()
  await router.enter('tab-a', 'child-a')
  client.trees.get('root-a')!.childFrames!.push({ frame: { id: 'wrong-child', parentId: 'top-a' } })
  client.attachments.set('wrong-child', { sessionId: 'wrong-session', frameId: 'different-frame', contextId: 20 })
  await assert.rejects(() => router.enter('tab-a', 'wrong-child'), /frame_unreachable/)
  assert.equal(router.selected('tab-a'), 'child-a')
  assert.ok(client.calls.some(call => call.method === 'Target.detachFromTarget' && call.params.sessionId === 'wrong-session'))
})
await check('OOPIF attachment enables the matching context and shares concurrent attachment', async () => {
  const { client, router } = setup()
  client.trees.get('root-a')!.childFrames!.push({ frame: { id: 'remote', parentId: 'top-a' } })
  client.attachments.set('remote', { sessionId: 'remote-session', contextId: 50 })
  await Promise.all([router.enter('tab-a', 'remote'), router.enter('tab-a', 'remote')])
  assert.equal(client.calls.filter(call => call.method === 'Target.attachToTarget').length, 1)
  assert.equal((await router.runtime('tab-a', 'root-a')).sessionId, 'remote-session')
})
await check('forgetting a tab clears its frame focus and reachable contexts', async () => {
  const { router } = setup()
  await router.enter('tab-a', 'child-a')
  router.forget('tab-a')
  assert.equal(router.selected('tab-a'), undefined)
  await assert.rejects(() => router.enter('tab-a', 'child-a'), /frame_unreachable/)
})
await check('detaching an ancestor invalidates lingering descendant contexts', async () => {
  const { client, router } = setup()
  client.trees.get('root-a')!.childFrames![0]!.childFrames = [{ frame: { id: 'grandchild', parentId: 'child-a' } }]
  client.context('root-a', 8, 'grandchild')
  await router.enter('tab-a', 'grandchild')
  client.emit('Page.frameDetached', { frameId: 'child-a', reason: 'remove' }, 'root-a')
  await assert.rejects(() => router.runtime('tab-a', 'root-a'), /frame_unreachable/)
})
await check('a stale context absent from the current tree cannot be entered', async () => {
  const { client, router } = setup()
  client.context('root-a', 9, 'stale-child')
  await assert.rejects(() => router.enter('tab-a', 'stale-child'), /frame_unreachable/)
  assert.equal(router.selected('tab-a'), undefined)
})
await check('an evaluation exception does not prove a frame reachable', async () => {
  const { client, router } = setup()
  client.evaluateReply = { result: { type: 'object', subtype: 'error' }, exceptionDetails: { text: 'Execution context destroyed' } }
  await assert.rejects(() => router.enter('tab-a', 'child-a'), /frame_unreachable/)
  assert.equal(router.selected('tab-a'), undefined)
})
await check('top navigation during frame proof cannot restore stale focus', async () => {
  const { client, router } = setup()
  let started!: () => void
  const evaluating = new Promise<void>(resolve => { started = resolve })
  let finish!: (value: unknown) => void
  client.evaluateReply = new Promise(resolve => { finish = resolve })
  client.onSend = method => { if (method === 'Runtime.evaluate') started() }
  const entering = router.enter('tab-a', 'child-a')
  await evaluating
  client.emit('Page.frameNavigated', { frame: { id: 'top-a' } }, 'root-a')
  finish({ result: { value: true } })
  await assert.rejects(() => entering, /frame_unreachable/)
  assert.equal(router.selected('tab-a'), undefined)
})
await check('forgetting a tab during frame proof cannot revive its focus', async () => {
  const { client, router } = setup()
  let started!: () => void
  const evaluating = new Promise<void>(resolve => { started = resolve })
  let finish!: (value: unknown) => void
  client.evaluateReply = new Promise(resolve => { finish = resolve })
  client.onSend = method => { if (method === 'Runtime.evaluate') started() }
  const entering = router.enter('tab-a', 'child-a')
  await evaluating
  router.forget('tab-a')
  finish({ result: { value: true } })
  await assert.rejects(() => entering, /frame_unreachable/)
  assert.equal(router.selected('tab-a'), undefined)
})
await check('top navigation during geometry never returns stale input coordinates', async () => {
  const { client, router } = setup()
  await router.enter('tab-a', 'child-a')
  let started!: () => void
  const measuring = new Promise<void>(resolve => { started = resolve })
  let finish!: (value: unknown) => void
  client.geometryReply = new Promise(resolve => { finish = resolve })
  client.onSend = method => { if (method === 'Runtime.callFunctionOn') started() }
  const point = router.point('tab-a', 5, 5)
  await measuring
  client.emit('Page.frameNavigated', { frame: { id: 'top-a' } }, 'root-a')
  finish({ result: { value: { x: 10, y: 20, sx: 1, sy: 1, width: 500, height: 500 } } })
  await assert.rejects(() => point, /frame_unreachable/)
  assert.ok(client.calls.some(call => call.method === 'Runtime.releaseObject'))
})
console.log(`${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
