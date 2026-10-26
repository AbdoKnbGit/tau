import type { Tool, ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import type { CanUseToolFn } from '../../../hooks/useCanUseTool.js'
import type { MessageUpdateLazy } from '../../../services/tools/toolExecution.js'
import { createUserMessage } from '../../messages.js'
import { processToolResultBlock } from '../../toolResultStorage.js'
import {
  dispatchModEvent,
  takeModLogs,
  type ModDispatchOptions,
} from './manager.js'
import {
  getModToolContext,
  withModToolContext,
  applyModContextModifier,
} from './toolContext.js'
import type { ModRecord } from './runtime.js'
import { createAttachmentMessage } from '../../attachments.js'
import { runPostToolUseHooks } from '../../../services/tools/toolHooks.js'

type Entry = {
  answer: ModRecord
  updates: MessageUpdateLazy[]
  input: Record<string, unknown>
}
type Options = {
  tool: Tool
  toolUseID: string
  input: Record<string, unknown>
  context: ToolUseContext
  assistant: AssistantMessage
  canUseTool: CanUseToolFn
  core(
    input: Record<string, unknown>,
    permission: (denied: string | undefined) => void,
    result: (value: unknown) => void,
  ): Promise<MessageUpdateLazy[]>
  dispatchOptions?: ModDispatchOptions
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function resultBlock(updates: MessageUpdateLazy[], id: string): any {
  for (const update of updates) {
    const message = update.message as any
    if (Array.isArray(message.message?.content)) {
      const block = message.message.content.find(
        (item: any) => item.type === 'tool_result' && item.tool_use_id === id,
      )
      if (block) return { block, raw: message.toolUseResult }
    }
  }
}
function textOf(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter(item => item?.type === 'text')
          .map(item => item.text)
          .join('\n')
      : ''
}

/** Keep host messages and context modifiers behind opaque per-call references. */
export async function runModToolCall(
  options: Options,
): Promise<MessageUpdateLazy[]> {
  const { tool, toolUseID, context, assistant, canUseTool } = options
  const retained = new Map<number, Entry>()
  const modifiers: Array<(context: ToolUseContext) => ToolUseContext> = []
  let sequence = 0
  let last: Entry | undefined
  const invokeCore = async (event: ModRecord): Promise<ModRecord> => {
    const ref = ++sequence
    const {
      tool: _name,
      tool_use_id: _id,
      agentId: _agent,
      consent: _consent,
      ...input
    } = event
    let denial: string | undefined
    let raw: unknown,
      receivedRaw = false
    const updates = await options.core(
      input,
      reason => {
        denial = reason
      },
      value => {
        raw = value
        receivedRaw = true
      },
    )
    const found = resultBlock(updates, toolUseID)
    const answer: ModRecord = denial
      ? { deny: denial }
      : {
          ref,
          result: receivedRaw ? raw : (found?.raw ?? null),
          text: textOf(found?.block.content),
          ...(found?.block.is_error ? { isError: true } : {}),
        }
    const entry = { answer, updates, input }
    for (const update of updates)
      if (update.contextModifier)
        modifiers.push(
          applyModContextModifier(
            context,
            update.contextModifier.modifyContext,
          ),
        )
    retained.set(ref, entry)
    last = entry
    return answer
  }
  const validate = (value: ModRecord) => {
    if (!value.deny && !value.isError && tool.outputSchema) {
      const prior =
        typeof value.ref === 'number' ? retained.get(value.ref) : undefined
      if (!prior || !same(prior.answer.result, value.result)) {
        const checked = tool.outputSchema.safeParse(value.result)
        if (!checked.success)
          throw new Error(
            `Invalid ${tool.name} result returned by mod: ${checked.error.message}`,
          )
      }
    }
  }
  let answer = (await withModToolContext(
    {
      ...getModToolContext(),
      toolUseContext: context,
      assistantMessage: assistant,
      canUseTool,
      contextModifiers: modifiers,
    },
    () =>
      dispatchModEvent(
        'tool.call',
        {
          ...options.input,
          tool: tool.name,
          tool_use_id: toolUseID,
          ...(context.agentId ? { agentId: context.agentId } : {}),
        },
        invokeCore,
        context.abortController.signal,
        { ...options.dispatchOptions, validateResult: validate },
      ),
  )) as ModRecord
  const prior =
    typeof answer.ref === 'number' ? retained.get(answer.ref) : undefined
  const managedMessages: MessageUpdateLazy[] = []
  let classifierContext: unknown
  if (!answer.deny && !answer.isError) {
    for await (const hook of runPostToolUseHooks(
      context,
      tool,
      toolUseID,
      assistant.message.id,
      prior?.input ?? last?.input ?? options.input,
      answer.result,
      undefined,
      undefined,
      undefined,
      undefined,
      'managed',
    )) {
      if ('updatedToolOutput' in hook)
        answer = { ...answer, result: hook.updatedToolOutput }
      else if ('updatedMCPToolOutput' in hook)
        answer = { ...answer, result: hook.updatedMCPToolOutput }
      else if ('classifierContext' in hook)
        classifierContext = hook.classifierContext
      else managedMessages.push(hook)
    }
  }
  let updates: MessageUpdateLazy[]
  for (const entry of retained.values())
    if (
      entry !== prior ||
      answer.deny !== undefined ||
      entry.answer.isError !== answer.isError ||
      !same(entry.answer.result, answer.result)
    )
      tool.onResultReplaced?.(entry.input, context)
  if (
    prior &&
    same(prior.answer.result, answer.result) &&
    prior.answer.isError === answer.isError &&
    answer.deny === undefined
  ) {
    updates = [...prior.updates]
  } else if (answer.deny && last && last.answer.deny === answer.deny) {
    updates = [...last.updates]
  } else {
    const originalResult = (prior ?? last)?.updates.find(update =>
      resultBlock([update], toolUseID),
    )?.message
    const block =
      answer.deny || answer.isError
        ? {
            type: 'tool_result' as const,
            tool_use_id: toolUseID,
            is_error: true,
            content:
              answer.deny ??
              answer.text ??
              (typeof answer.result === 'string'
                ? answer.result
                : JSON.stringify(answer.result)),
          }
        : await processToolResultBlock(tool, answer.result, toolUseID)
    const message = createUserMessage({
      content: [
        block,
        ...((prior ?? last)?.updates.flatMap(update => {
          const message = update.message as any
          return resultBlock([update], toolUseID) &&
            Array.isArray(message.message?.content)
            ? message.message.content.filter(
                (item: any) =>
                  !(
                    item.type === 'tool_result' &&
                    item.tool_use_id === toolUseID
                  ),
              )
            : []
        }) ?? []),
      ],
      toolUseResult:
        context.agentId && !context.preserveToolUseResults
          ? undefined
          : (answer.deny ?? answer.result),
      imagePasteIds:
        originalResult?.type === 'user'
          ? originalResult.imagePasteIds
          : undefined,
      mcpMeta:
        originalResult?.type === 'user' ? originalResult.mcpMeta : undefined,
      sourceToolAssistantUUID: assistant.uuid,
    })
    if (originalResult?.type === 'user' && originalResult.hookClassifierContext)
      Object.assign(message, {
        hookClassifierContext: originalResult.hookClassifierContext,
      })
    // Preserve side effects on host context when a mod replaces an executed
    // tool's answer. Only its tool_result is replaced; hook/progress evidence stays.
    updates = (prior?.updates ?? last?.updates ?? []).filter(
      update => !resultBlock([update], toolUseID),
    )
    updates.unshift({ message })
  }
  if (answer.context?.length)
    updates.push({
      message: createUserMessage({
        content: answer.context.join('\n'),
        isMeta: true,
      }),
    })
  updates.push(...managedMessages)
  if (classifierContext) {
    const result = updates.find(update => resultBlock([update], toolUseID))
    if (result)
      result.message = {
        ...result.message,
        hookClassifierContext: classifierContext,
      } as typeof result.message
  }
  // Every completed core action can change host state even when its model
  // output was replaced or a later next() result was selected.
  if (modifiers.length && updates.length) {
    updates = updates.map(({ contextModifier: _modifier, ...update }) => update)
    updates[0] = {
      ...updates[0]!,
      contextModifier: {
        toolUseID,
        modifyContext: current => {
          for (const modifier of modifiers) current = modifier(current)
          return current
        },
      },
    }
  }
  for (const text of takeModLogs())
    updates.push({
      message: createAttachmentMessage({
        type: 'hook_system_message',
        content: text,
        hookName: 'tool.call',
        toolUseID,
        hookEvent: 'PreToolUse',
      }),
    })
  return updates
}
