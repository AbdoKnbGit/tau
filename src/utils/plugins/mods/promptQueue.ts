import { randomUUID, type UUID } from 'node:crypto'
import {
  enqueue,
  removeByFilter,
  subscribeToDiscardedCommands,
} from '../../messageQueueManager.js'
import type { ModRuntime } from './runtime.js'

export type ModPromptOrigin = Readonly<{ kind: 'plugin'; name: string; asUser?: true }>
export type ModPromptAttachment = Readonly<{
  type: 'image' | 'audio' | 'document'
  mediaType?: string
  filename?: string
}>
export type ModPromptArgs = {
  text: string
  asUser?: true
  attachments?: readonly ModPromptAttachment[]
}
export type ModPromptAccepted = {
  text: string
  context?: readonly string[]
  origin?: ModPromptOrigin
}
export type ModPromptResult = ModPromptAccepted | { drop: string }
export type QueuedModPrompt = Readonly<{
  uuid: UUID
  text: string
  origin: ModPromptOrigin
  attachments?: readonly ModPromptAttachment[]
  skip?: Readonly<{ runtime: ModRuntime; hook: number }>
}>

type PendingPrompt = {
  metadata: QueuedModPrompt
  owner: ModRuntime
  processor?: AbortController
  accepted?: ModPromptAccepted
  settle: (result: ModPromptResult) => void
  removeAbortListener: () => void
}
const pending = new Map<string, PendingPrompt>()
const REMOVED = 'the prompt was removed from the queue before it ran'

function promptArguments(value: unknown): ModPromptArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('prompt.submit requires an object with text')
  const args = value as Record<string, unknown>
  for (const key of Object.keys(args)) {
    if (!['text', 'asUser', 'attachments'].includes(key))
      throw new Error(`prompt.submit does not accept ${key}; submission identity is set by Tau`)
  }
  if (typeof args.text !== 'string') throw new Error('prompt.submit text must be a string')
  if (args.asUser !== undefined && args.asUser !== true) throw new Error('prompt.submit asUser must be true when provided')
  if (args.attachments !== undefined) {
    if (!Array.isArray(args.attachments)) throw new Error('prompt.submit attachments must be an array')
    for (const attachment of args.attachments) {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment))
        throw new Error('prompt.submit attachment must be an object')
      for (const key of Object.keys(attachment)) {
        if (!['type', 'mediaType', 'filename'].includes(key))
          throw new Error(`prompt.submit attachment does not accept ${key}; media handles are set by Tau`)
      }
      if (!['image', 'audio', 'document'].includes(attachment.type))
        throw new Error('prompt.submit attachment type must be image, audio, or document')
      for (const key of ['mediaType', 'filename']) {
        if (attachment[key] !== undefined && typeof attachment[key] !== 'string')
          throw new Error(`prompt.submit attachment ${key} must be a string`)
      }
    }
  }
  return args as ModPromptArgs
}

// Dequeue transfers a command to a runner; only an explicit discard settles it.
subscribeToDiscardedCommands(commands => {
  for (const command of commands) {
    if (command.modPrompt) dropQueuedModPrompt(command.uuid)
  }
})

/** Queue one independent turn. The signal belongs to the mod, not its current hook. */
export function enqueueModPrompt(
  input: unknown,
  caller: { plugin: string; owner: ModRuntime; hook?: number },
  signal?: AbortSignal,
): Promise<ModPromptResult> {
  const args = promptArguments(input)
  if (signal?.aborted) return Promise.resolve({ drop: REMOVED })
  const uuid = randomUUID()
  const origin: ModPromptOrigin = Object.freeze({
    kind: 'plugin', name: caller.plugin,
    ...(args.asUser ? { asUser: true as const } : {}),
  })
  const metadata: QueuedModPrompt = Object.freeze({
    uuid, text: args.text, origin,
    ...(args.attachments ? { attachments: Object.freeze(args.attachments.map(item => Object.freeze({ ...item }))) } : {}),
    ...(caller.hook !== undefined ? { skip: Object.freeze({ runtime: caller.owner, hook: caller.hook }) } : {}),
  })
  return new Promise(resolve => {
    const onAbort = () => { dropQueuedModPrompt(uuid) }
    pending.set(uuid, {
      metadata, owner: caller.owner, settle: resolve,
      removeAbortListener: () => signal?.removeEventListener('abort', onAbort),
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    // Insertion precedes the queue notification: an idle runner may start immediately.
    try {
      enqueue({ uuid, value: args.text, mode: 'prompt', priority: 'next', modPrompt: true, skipSlashCommands: true })
    } catch (error) {
      dropQueuedModPrompt(uuid, `the prompt could not be queued: ${String(error)}`)
    }
  })
}

export function getQueuedModPrompt(uuid: string | undefined): QueuedModPrompt | undefined {
  return uuid === undefined ? undefined : pending.get(uuid)?.metadata
}

/** Keep cancellation effective while the runner awaits input hooks or persistence. */
export function bindQueuedModPrompt(uuid: string | undefined, processor: AbortController): boolean {
  const prompt = uuid === undefined ? undefined : pending.get(uuid)
  if (!prompt) return false
  prompt.processor = processor
  return true
}

/** Store what reached core, before post-next hooks can alter their returned receipt. */
export function prepareQueuedModPrompt(uuid: string | undefined, result: ModPromptAccepted): boolean {
  const prompt = uuid === undefined ? undefined : pending.get(uuid)
  if (!prompt) return false
  prompt.accepted = Object.freeze({
    text: result.text,
    ...(result.context ? { context: Object.freeze([...result.context]) } : {}),
    origin: prompt.metadata.origin,
  })
  return true
}

/** A receipt is accepted only when the main turn actually starts. */
export function acceptQueuedModPrompt(uuid: string | undefined): boolean {
  const prompt = uuid === undefined ? undefined : pending.get(uuid)
  if (!prompt?.accepted) return false
  pending.delete(prompt.metadata.uuid)
  prompt.removeAbortListener()
  prompt.settle(prompt.accepted)
  return true
}

/** Also settles dequeued commands that were dropped during prompt processing. */
export function dropQueuedModPrompt(uuid: string | undefined, reason = REMOVED): boolean {
  const prompt = uuid === undefined ? undefined : pending.get(uuid)
  if (!prompt) return false
  // Delete before removing from the queue: discard observers may call back here.
  pending.delete(prompt.metadata.uuid)
  prompt.removeAbortListener()
  prompt.processor?.abort('interrupt')
  removeByFilter(command => command.modPrompt === true && command.uuid === uuid)
  prompt.settle({ drop: reason })
  return true
}

/** Reload/disable must not leave work owned by a disposed runtime in the queue. */
export function dropModPromptsForOwner(owner: ModRuntime, reason = REMOVED): void {
  for (const [uuid, prompt] of pending) {
    if (prompt.owner === owner) dropQueuedModPrompt(uuid, reason)
  }
}

export function dropAllQueuedModPrompts(reason = REMOVED): void {
  for (const uuid of pending.keys()) dropQueuedModPrompt(uuid, reason)
}
