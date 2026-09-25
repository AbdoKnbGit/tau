import { createHash } from 'node:crypto'
import type { ProviderMessage } from '../../services/api/providers/base_provider.js'

type FunctionTool = {
  function: { name: string; parameters: Record<string, unknown>; strict?: boolean }
}
type Snapshot = { system: string; tools: Map<string, FunctionTool> }
const snapshots = new Map<string, Snapshot>()

/** One initial prompt per conversation and request purpose, including empty prompts.
 * Rebuilt only at the existing explicit prompt-reset boundary. New conversation
 * messages remain live; helper requests must never seed the main prompt.
 */
export function openRouterContextKey(
  route: string,
  model: string,
  sessionId: string | undefined,
  querySource: string | undefined,
  messages: ProviderMessage[],
): string {
  const lineage = sessionId || createHash('sha256')
    .update(JSON.stringify(messages.find(message => message.role === 'user') ?? null))
    .digest('hex')
  return JSON.stringify([route, model, lineage, querySource ?? ''])
}

export function freezeOpenRouterSystem(key: string, system: string): string {
  let snapshot = snapshots.get(key)
  if (!snapshot) {
    snapshot = { system, tools: new Map() }
    snapshots.set(key, snapshot)
    if (snapshots.size > 256) snapshots.delete(snapshots.keys().next().value!)
  }
  return snapshot.system
}

/** Keep descriptions and ordering stable for unchanged contracts. Availability
 * and actual schema changes remain authoritative (including strict-schema retry).
 * Never restore a removed tool just to retain a cache prefix.
 */
export function freezeOpenRouterTools<T extends FunctionTool>(key: string, tools: T[]): T[] {
  const snapshot = snapshots.get(key)
  if (!snapshot) return tools
  const current = new Map(tools.map(tool => [tool.function.name, tool]))
  for (const [name, saved] of snapshot.tools) {
    const tool = current.get(name)
    if (!tool) snapshot.tools.delete(name)
    else if (JSON.stringify([saved.function.parameters, saved.function.strict]) !==
      JSON.stringify([tool.function.parameters, tool.function.strict])) {
      snapshot.tools.set(name, structuredClone(tool))
    }
  }
  for (const tool of tools) {
    if (!snapshot.tools.has(tool.function.name)) {
      snapshot.tools.set(tool.function.name, structuredClone(tool))
    }
  }
  // Cache-control stamping happens later and must not mutate the snapshot.
  return [...snapshot.tools.values()].map(tool => structuredClone(tool) as T)
}

export function resetOpenRouterContext(): void {
  snapshots.clear()
}
