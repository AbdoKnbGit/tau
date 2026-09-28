/**
 * Run: bun run src/utils/abortController.test.ts
 */
import { getEventListeners } from 'node:events'
import { createMovableAbortController } from './abortController.js'

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

async function main(): Promise<void> {
  console.log('movable abort controller:')

  await test('stands in for its parent: an abort on either side reaches the other', () => {
    const turn = new AbortController()
    const agent = createMovableAbortController(turn)
    turn.abort('user-cancel')
    assert(agent.controller.signal.aborted, 'Esc on the turn must stop the agent')
    assert(agent.controller.signal.reason === 'user-cancel', `reason=${agent.controller.signal.reason}`)

    const turn2 = new AbortController()
    const agent2 = createMovableAbortController(turn2)
    agent2.controller.abort('interrupt')
    assert(turn2.signal.aborted, 'an abort inside the agent (Esc on its permission prompt) must stop the turn')
    assert(turn2.signal.reason === 'interrupt', `reason=${turn2.signal.reason}`)
  })

  await test('moved: follows only the new parent, one way', () => {
    const turn = new AbortController()
    const task = new AbortController()
    const agent = createMovableAbortController(turn)
    agent.moveTo(task)
    turn.abort('user-cancel')
    assert(!agent.controller.signal.aborted, 'the main turn must no longer stop a backgrounded agent')

    const turn2 = new AbortController()
    const task2 = new AbortController()
    const agent2 = createMovableAbortController(turn2)
    agent2.moveTo(task2)
    agent2.controller.abort('done')
    assert(!turn2.signal.aborted && !task2.signal.aborted, 'the agent must not abort the turn or its task')

    task.abort('killed')
    assert(agent.controller.signal.aborted, 'killing the task must stop the agent')
    assert(agent.controller.signal.reason === 'killed', `reason=${agent.controller.signal.reason}`)
  })

  await test('already aborted parents abort it at once', () => {
    const turn = new AbortController()
    turn.abort('gone')
    assert(createMovableAbortController(turn).controller.signal.aborted, 'aborted parent at creation')

    const task = new AbortController()
    task.abort('killed')
    const agent = createMovableAbortController(new AbortController())
    agent.moveTo(task)
    assert(agent.controller.signal.aborted, 'moved onto an aborted task')
  })

  await test('dispose cuts every link', () => {
    const turn = new AbortController()
    const agent = createMovableAbortController(turn)
    agent.dispose()
    turn.abort()
    assert(!agent.controller.signal.aborted, 'parent must not reach a disposed controller')
    const turn2 = new AbortController()
    const agent2 = createMovableAbortController(turn2)
    agent2.dispose()
    agent2.controller.abort()
    assert(!turn2.signal.aborted, 'a disposed controller must not reach its parent')
  })

  await test('a targeted foreground stop spares the parent and its other agents', () => {
    const turn = new AbortController()
    const task = new AbortController()
    const siblingTask = new AbortController()
    const agent = createMovableAbortController(turn, task)
    const sibling = createMovableAbortController(turn, siblingTask)
    task.abort('task-stopped')
    assert(agent.controller.signal.reason === 'task-stopped', 'task stop must reach execution')
    assert(!turn.signal.aborted, 'targeted stop must not cancel the turn')
    assert(!sibling.controller.signal.aborted, 'targeted stop must not cancel a sibling')
    turn.abort('Esc')
    assert(sibling.controller.signal.reason === 'Esc', 'Esc must still stop the other agent')
    agent.dispose()
    sibling.dispose()
  })

  await test('an already killed task stops execution without aborting its parent', () => {
    const turn = new AbortController()
    const task = new AbortController()
    task.abort('killed-before-link')
    const agent = createMovableAbortController(turn, task)
    assert(agent.controller.signal.reason === 'killed-before-link', 'must handle registration-time kill')
    assert(!turn.signal.aborted, 'must unlink the parent before forwarding an existing stop')
    agent.dispose()
  })

  await test('permission-prompt Esc still cancels the turn with a task stop link', () => {
    const turn = new AbortController()
    const task = new AbortController()
    const agent = createMovableAbortController(turn, task)
    agent.controller.abort('permission-interrupt')
    assert(turn.signal.reason === 'permission-interrupt', 'agent Esc must still reach the turn')
    agent.dispose()
  })

  await test('move and dispose release task listeners across repeated runs', () => {
    const turn = new AbortController()
    for (let i = 0; i < 50; i++) {
      const task = new AbortController()
      const nextTask = new AbortController()
      const agent = createMovableAbortController(turn, task)
      if (i % 2 === 0) {
        agent.moveTo(nextTask)
        task.abort('old-task')
        assert(!agent.controller.signal.aborted, 'the previous task must be detached after move')
      }
      agent.dispose()
      agent.dispose()
      for (const controller of [turn, task, nextTask, agent.controller]) {
        assert(getEventListeners(controller.signal, 'abort').length === 0, 'listener leaked after dispose')
      }
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
