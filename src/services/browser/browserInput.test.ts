/** Pointer cleanup regressions. Run: bun run src/services/browser/browserInput.test.ts */
import assert from 'node:assert/strict'
import { getBrowserSession } from './browserSession.js'

type MouseEvent = { type: string; buttons?: number; x: number; y: number }
type Harness = {
  client: { isOpen: boolean; send(method: string, params: MouseEvent): Promise<unknown> }
  activeTargetId: string
  getActiveSession(): Promise<string>
  moveMouse(): Promise<{ tx: number; ty: number }>
  frames: { guard(): () => void; point(_target: string, x: number, y: number): Promise<{ x: number; y: number }> }
  realDrag(x1: number, y1: number, x2: number, y2: number, signal?: AbortSignal): Promise<void>
  realClick(x: number, y: number, signal?: AbortSignal, clickCount?: number): Promise<void>
}

function fixture(onMouse: (event: MouseEvent) => void = () => {}) {
  const Session = getBrowserSession().constructor as new () => Harness
  const session = new Session()
  const events: MouseEvent[] = []
  let changed = false
  session.activeTargetId = 'tab'
  session.client = {
    isOpen: true,
    async send(method, params) {
      assert.equal(method, 'Input.dispatchMouseEvent')
      events.push(params)
      onMouse(params)
      return {}
    },
  }
  session.getActiveSession = async () => 'top-session'
  session.moveMouse = async () => ({ tx: 10, ty: 20 })
  session.frames = {
    guard: () => () => { if (changed) throw new Error('frame_unreachable: document changed') },
    point: async (_target, x, y) => ({ x: x + 100, y: y + 200 }),
  }
  return { session, events, change: () => { changed = true } }
}

const drag = fixture(event => { if (event.type === 'mousePressed') drag.change() })
await assert.rejects(() => drag.session.realDrag(1, 2, 30, 40), /frame_unreachable/)
assert.deepEqual(drag.events.map(event => event.type), ['mousePressed', 'mouseReleased'])
assert.equal(drag.events.at(-1)?.buttons, 0)
console.log('  ok frame navigation interrupts a drag and releases the held pointer')

const aborted = new AbortController()
const click = fixture(event => { if (event.type === 'mousePressed') aborted.abort() })
await assert.rejects(() => click.session.realClick(1, 2, aborted.signal, 2))
assert.deepEqual(click.events.map(event => event.type), ['mousePressed', 'mouseReleased'])
assert.equal(click.events.at(-1)?.buttons, 0)
console.log('  ok cancelled clicks release the pointer and never dispatch a second click')
console.log('2 passed, 0 failed')
