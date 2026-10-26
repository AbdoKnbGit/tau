import { randomUUID } from 'node:crypto'
import { findToolByName, type Tool } from '../../../Tool.js'
import { createAssistantMessage } from '../../messages.js'
import { runToolUse } from '../../../services/tools/toolExecution.js'
import {
  getModToolContext,
  applyModContextModifier,
  readModToolSnapshot,
  withModToolContext,
} from './toolContext.js'
import type { ModDispatchOptions } from './manager.js'
import { queryModToolPermission } from './permissions.js'
import { checkMcpArguments } from '../../../services/mcp/contractValidation.js'
import { filterToolsByDenyRules } from '../../../tools.js'
import { filterCurrentModTools } from './tools.js'
import { getPowerModeFromSettings } from '../../powerMode.js'
import { getInitialSettings } from '../../settings/settings.js'
import type { ModRecord } from './runtime.js'

function validateInput(tool: Tool, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Tool input must be an object')
  const parsed = tool.inputSchema.parse(value)
  if (tool.inputJSONSchema) {
    const checked = checkMcpArguments(tool, parsed)
    if (!checked.ok) throw new Error(checked.message)
  }
  return parsed
}

/** Calls inherit the real invocation's permission host and cancellation scope. */
export async function runModToolAPI(
  method: string,
  argument: unknown,
  signal: AbortSignal,
  plugin: string,
): Promise<unknown> {
  const bound = getModToolContext()
  if (!bound)
    throw new Error(
      `${method} needs an active session command or tool invocation`,
    )
  if (
    !argument ||
    typeof argument !== 'object' ||
    Array.isArray(argument) ||
    typeof (argument as ModRecord).tool !== 'string'
  )
    throw new Error(`${method} requires a tool name`)
  if ((bound.depth ?? 0) >= 16)
    throw new Error('Mod tool calls exceeded the nested call limit')
  signal.throwIfAborted()
  const value = argument as ModRecord
  const snapshot = readModToolSnapshot(bound.toolUseContext)
  const available =
    getPowerModeFromSettings(getInitialSettings()) === 'cheap'
      ? filterCurrentModTools(snapshot.tools)
      : snapshot.tools
  const tools = filterToolsByDenyRules(
    available,
    bound.toolUseContext.getAppState().toolPermissionContext,
  )
  const tool = findToolByName(tools, value.tool)
  if (!tool || !tool.isEnabled())
    throw new Error(`Tool is not available: ${value.tool}`)
  const dispatchOptions: ModDispatchOptions = {
    origin: { plugin, tier: 'user' },
    ...(bound.frame
      ? { skip: { runtime: bound.frame.runtime, hook: bound.frame.hook } }
      : {}),
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const parentSignal = bound.toolUseContext.abortController.signal
  parentSignal.addEventListener('abort', abort, { once: true })
  if (signal.aborted || parentSignal.aborted) abort()
  const context = {
    ...bound.toolUseContext,
    options: { ...bound.toolUseContext.options, ...snapshot, tools },
    abortController: controller,
    preserveToolUseResults: true,
    // API callers consume the data, rather than a reference to an earlier
    // model-visible tool_result. Do not let native Read return a dedup note.
    readResultHidden: true,
  }
  try {
    if (method === 'tool.check') {
      return withModToolContext(
        { ...bound, toolUseContext: context, depth: (bound.depth ?? 0) + 1 },
        () =>
          queryModToolPermission(
            tool,
            validateInput(tool, value.input),
            context,
            { dispatchOptions },
          ),
      )
    }
    const {
      tool: _tool,
      tool_use_id: _id,
      agentId: _agent,
      consent: _consent,
      ...args
    } = value
    const input = validateInput(tool, args)
    const id = 'mod_' + randomUUID()
    const assistant = createAssistantMessage({
      content: [{ type: 'tool_use', id, name: tool.name, input }],
    })
    const updates = await withModToolContext(
      {
        ...bound,
        toolUseContext: context,
        assistantMessage: assistant,
        depth: (bound.depth ?? 0) + 1,
        dispatchOptions,
      },
      async () => {
        const collected = []
        for await (const update of runToolUse(
          { type: 'tool_use', id, name: tool.name, input },
          assistant,
          bound.canUseTool,
          context,
        ))
          collected.push(update)
        return collected
      },
    )
    for (const update of updates) {
      if (update.contextModifier) {
        const patch = applyModContextModifier(
          bound.toolUseContext,
          update.contextModifier.modifyContext,
        )
        bound.contextModifiers?.push(patch)
      }
    }
    for (const update of updates) {
      const message = update.message as any
      if (!Array.isArray(message.message?.content)) continue
      const block = message.message.content.find(
        (item: any) => item.type === 'tool_result' && item.tool_use_id === id,
      )
      if (!block) continue
      const text =
        typeof block.content === 'string'
          ? block.content
          : (block.content ?? [])
              .filter((item: any) => item.type === 'text')
              .map((item: any) => item.text)
              .join('\n')
      return {
        result: message.toolUseResult ?? null,
        text,
        ...(block.is_error ? { isError: true } : {}),
      }
    }
    throw new Error('Tool call produced no result')
  } finally {
    signal.removeEventListener('abort', abort)
    parentSignal.removeEventListener('abort', abort)
  }
}
