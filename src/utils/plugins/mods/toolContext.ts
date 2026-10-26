import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import type { CanUseToolFn } from '../../../hooks/useCanUseTool.js'
import type { ModRuntime } from './runtime.js'
import type { ModDispatchOptions } from './manager.js'
import { filterCurrentModTools, getModTools } from './tools.js'

export type ModCallFrame = {
  runtime: ModRuntime
  hook: number
  event: string
  plugin?: string
}
export type ModToolContext = {
  toolUseContext: ToolUseContext
  assistantMessage: AssistantMessage
  canUseTool: CanUseToolFn
  frame?: ModCallFrame
  depth?: number
  dispatchOptions?: ModDispatchOptions
  contextModifiers?: Array<(context: ToolUseContext) => ToolUseContext>
}
const storage = new AsyncLocalStorage<ModToolContext>()
export const getModToolContext = () => storage.getStore()

/** Apply callbacks once locally, then propagate only their state changes to
 * the executor's parent context without repeating their side effects. */
export function applyModContextModifier(
  context: ToolUseContext,
  modify: (context: ToolUseContext) => ToolUseContext,
): (context: ToolUseContext) => ToolUseContext {
  const before = new Map(
    Reflect.ownKeys(context).map(key => [key, Reflect.get(context, key)]),
  )
  const updated = modify(context) ?? context
  const keys = new Set([...before.keys(), ...Reflect.ownKeys(updated)])
  const changes = [...keys]
    .filter(
      key =>
        before.has(key) !== Object.hasOwn(updated, key) ||
        !Object.is(before.get(key), Reflect.get(updated, key)),
    )
    .map(key => ({
      key,
      present: Object.hasOwn(updated, key),
      value: Reflect.get(updated, key),
    }))
  for (const change of changes) {
    if (change.present) Reflect.set(context, change.key, change.value)
    else Reflect.deleteProperty(context, change.key)
  }
  return current => {
    if (!changes.length) return current
    const result = { ...current }
    for (const change of changes) {
      if (change.present) Reflect.set(result, change.key, change.value)
      else Reflect.deleteProperty(result, change.key)
    }
    return result
  }
}
/** Keep a live MCP inventory and its connections from the same state snapshot. */
export function readModToolSnapshot(context: ToolUseContext) {
  const snapshot = context.options.refreshMcpContext?.() ?? {
    tools: context.options.refreshTools?.() ?? context.options.tools,
    mcpClients: context.options.mcpClients,
  }
  // A fixed inventory may belong to a restricted agent. Replace its stale
  // registrations by name, without granting registrations outside that scope.
  // Authoritative refresh callbacks already assemble newly available tools.
  const ordinary = new Set(filterCurrentModTools(snapshot.tools))
  const current = new Map(getModTools().map(tool => [tool.name, tool]))
  let changed = false
  const tools = snapshot.tools.flatMap(tool => {
    if (ordinary.has(tool)) return [tool]
    const replacement = current.get(tool.name)
    if (replacement !== tool) changed = true
    return replacement ? [replacement] : []
  })
  return changed ? { ...snapshot, tools } : snapshot
}
export function withModToolContext<T>(
  context: ModToolContext | undefined,
  action: () => T,
): T {
  return context ? storage.run(context, action) : action()
}
