// Run: bun run src/utils/midTurnNotifications.test.ts
import assert from 'node:assert/strict'
import { API_PROVIDERS } from './model/providerRegistry.js'
import { isMidTurnNotification } from './midTurnNotifications.js'
import type { QueuedCommand } from '../types/textInputTypes.js'

const completion: QueuedCommand = {
  mode: 'task-notification', priority: 'later', taskNotificationType: 'local_agent',
  value: '<task-notification>Agent completed</task-notification>',
}
let checks = 0
for (const provider of API_PROVIDERS) {
  const options = { provider, sleepRan: false, isMainThread: true }
  assert.equal(isMidTurnNotification(completion, options), provider === 'openai')
  assert.equal(isMidTurnNotification(completion, { ...options, isMainThread: false }), false)
  assert.equal(isMidTurnNotification({ ...completion, agentId: 'other-agent' as never }, options), false)
  // The XML is insufficient: workflow/remote/custom messages keep their
  // priority, even if their text happens to describe an agent completion.
  assert.equal(isMidTurnNotification({ ...completion, taskNotificationType: undefined }, options), false)
  assert.equal(isMidTurnNotification({ ...completion, mode: 'prompt' }, options), false)
  assert.equal(isMidTurnNotification(completion, { ...options, sleepRan: true }), true)
  for (const priority of ['now', 'next', undefined] as const) {
    assert.equal(isMidTurnNotification({ ...completion, priority }, options), true)
  }
  checks += 9
}
assert.equal(completion.priority, 'later', 'selection must not mutate shared queue priority')
console.log(`${checks + 1} mid-turn notification checks passed`)
