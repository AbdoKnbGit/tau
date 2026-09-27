import { createHash } from 'node:crypto'
import type { ProviderMessage } from '../../services/api/providers/base_provider.js'

type FunctionTool = {
  function: { name: string; parameters: Record<string, unknown>; strict?: boolean }
}
type Snapshot = { system: string; tools: Map<string, FunctionTool> }
const SNAPSHOT_LIMIT = 256
const snapshots = new Map<string, Snapshot>()
/** Lineage → the conversation most recently seen on it: its snapshot key and
 * a hash of the system prompt it sent. */
const conversations = new Map<string, { key: string; system: string }>()

/** Main thread and agents; everything else is a helper request. */
function isConversationSource(querySource: string | undefined): boolean {
  return !querySource
    || querySource.startsWith('repl_main_thread')
    || querySource === 'sdk'
    || querySource.startsWith('agent:')
}

/** One initial prompt per conversation and request purpose, including empty prompts.
 * Rebuilt only at the existing explicit prompt-reset boundary. New conversation
 * messages remain live; helper requests must never seed the main prompt.
 *
 * A helper request that sends a conversation's own system prompt on that
 * conversation's session is a fork of it (a prompt suggestion, a compaction):
 * it resends the conversation's prefix, so it uses the conversation's
 * snapshot, frozen system prompt and tool order included. Any other helper
 * keeps a snapshot of its own. `system` is the caller's system prompt before
 * freezing.
 */
export function openRouterContextKey(
  route: string,
  model: string,
  sessionId: string | undefined,
  querySource: string | undefined,
  messages: ProviderMessage[],
  system: string,
): string {
  const lineage = sessionId || createHash('sha256')
    .update(JSON.stringify(messages.find(message => message.role === 'user') ?? null))
    .digest('hex')
  const own = JSON.stringify([route, model, lineage, querySource ?? ''])
  const base = JSON.stringify([route, model, lineage])
  const systemHash = createHash('sha256').update(system).digest('hex')
  if (!isConversationSource(querySource)) {
    const conversation = conversations.get(base)
    return conversation?.system === systemHash ? conversation.key : own
  }
  conversations.delete(base)
  conversations.set(base, { key: own, system: systemHash })
  if (conversations.size > SNAPSHOT_LIMIT) conversations.delete(conversations.keys().next().value!)
  return own
}

function touchSnapshot(key: string): Snapshot | undefined {
  const snapshot = snapshots.get(key)
  if (snapshot) {
    // Most recently used last, so eviction drops idle conversations first.
    snapshots.delete(key)
    snapshots.set(key, snapshot)
  }
  return snapshot
}

export function freezeOpenRouterSystem(key: string, system: string): string {
  let snapshot = touchSnapshot(key)
  if (!snapshot) {
    snapshot = { system, tools: new Map() }
    snapshots.set(key, snapshot)
    if (snapshots.size > SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!)
  }
  return snapshot.system
}

/** Keep descriptions and ordering stable for unchanged contracts. Availability
 * and actual schema changes remain authoritative (including strict-schema retry).
 * Never restore a removed tool just to retain a cache prefix, but keep its slot:
 * a request with fewer tools (a fork captured before a server connected, a
 * server that dropped) must not reorder the tools that follow it.
 */
export function freezeOpenRouterTools<T extends FunctionTool>(key: string, tools: T[]): T[] {
  const snapshot = touchSnapshot(key)
  if (!snapshot) return tools
  const present = new Set<string>()
  for (const tool of tools) {
    present.add(tool.function.name)
    const saved = snapshot.tools.get(tool.function.name)
    // Updating an existing key keeps its position in the Map.
    if (!saved || JSON.stringify([saved.function.parameters, saved.function.strict]) !==
      JSON.stringify([tool.function.parameters, tool.function.strict])) {
      snapshot.tools.set(tool.function.name, structuredClone(tool))
    }
  }
  // Cache-control stamping happens later and must not mutate the snapshot.
  return [...snapshot.tools.values()]
    .filter(tool => present.has(tool.function.name))
    .map(tool => structuredClone(tool) as T)
}

export function resetOpenRouterContext(): void {
  snapshots.clear()
  conversations.clear()
}
