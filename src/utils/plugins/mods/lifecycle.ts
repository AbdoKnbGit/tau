import { randomUUID } from 'node:crypto'
import type { ContentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { ToolUseContext } from '../../../Tool.js'
import type { CanUseToolFn } from '../../../hooks/useCanUseTool.js'
import type { AssistantMessage, Message, RequestStartEvent, StreamEvent, TombstoneMessage, ToolUseSummaryMessage } from '../../../types/message.js'
import { createAssistantMessage, createSystemMessage } from '../../messages.js'
import { logForDebugging } from '../../debug.js'
import { dispatchModEvent, hasModEvent } from './manager.js'
import type { ModRecord, ModTraceEntry } from './runtime.js'
import { withModToolContext } from './toolContext.js'
import { beginModMainTurn, bindModAgentConversation, isModTurnAbort } from './sessionState.js'
import { acceptQueuedModPrompt } from './promptQueue.js'
import { takeModAgentTurnText, takeModTurnText } from './turnText.js'
import type { ModDispatchOptions } from './manager.js'

type TurnMessage = Message | RequestStartEvent | StreamEvent | TombstoneMessage | ToolUseSummaryMessage

/** A plugin's own line in the transcript: drawn dim with a dot in every view
 * (other info rows show only in verbose mode) and never sent to the model. */
export function createModNoticeMessage(text: string) {
  return { ...createSystemMessage(text, 'info'), modNotice: true as const }
}

/** All top-level SDK text is submitted; attachments keep their order and identity. */
export function submittedPromptText(input: string | ContentBlockParam[]): string {
  return typeof input === 'string' ? input : input.filter(block => block.type === 'text').map(block => block.text).join('\n')
}
export function replaceSubmittedPromptText(input: string | ContentBlockParam[], text: string): string | ContentBlockParam[] {
  if (typeof input === 'string') return text
  if (text === submittedPromptText(input)) return input
  const index = input.findLastIndex(block => block.type === 'text')
  if (index < 0) return text ? [...input, { type: 'text', text }] : input
  return input.flatMap<ContentBlockParam>((block, i) => block.type !== 'text' ? [block] : i === index ? [{ ...block, text }] : [])
}

export async function inToolContext<T>(context: ToolUseContext, canUseTool: CanUseToolFn | undefined, action: () => Promise<T>, assistant?: AssistantMessage): Promise<T> {
  const permission = canUseTool ?? (await import('../../permissions/permissions.js')).hasPermissionsToUseTool
  return withModToolContext({
    toolUseContext: context,
    canUseTool: permission,
    assistantMessage: assistant ?? context.messages.findLast(message => message.type === 'assistant') ?? createAssistantMessage({ content: [] }),
  }, action)
}

export async function submitModPrompt(event: ModRecord, context: ToolUseContext, canUseTool?: CanUseToolFn, options?: ModDispatchOptions): Promise<ModRecord> {
  let entered: ModRecord | undefined
  const result = await inToolContext(context, canUseTool, async () => await dispatchModEvent(
    'prompt.submit', event,
    async e => (entered = { text: e.text, ...(e.context !== undefined ? { context: e.context } : {}), ...(e.origin ? { origin: e.origin } : {}) }),
    context.abortController.signal, options,
  ) as ModRecord)
  // Only next() enters a prompt. Context attached to a returned receipt after
  // next() has resolved must not change the already accepted submission.
  return entered ?? (result.drop !== undefined ? result : { drop: 'the prompt was handled without entering the session' })
}

/** The turn each query's model requests belong to, by the abort controller
 * of its tool context and its loop (a sync subagent shares its parent's
 * controller): the turn's id and the next request's index there. */
type TurnSteps = { turnId: string; next: number; context: ToolUseContext; canUseTool: CanUseToolFn }
const turnSteps = new WeakMap<AbortController, Map<string, TurnSteps>>()

/** The next model request of the turn a query runs (turn.step's `turnId`
 * and `index`), or undefined outside a turn the lifecycle observes. */
export function takeModTurnStep(controller: AbortController, agentId?: string):
  { turnId: string; index: number; context: ToolUseContext; canUseTool: CanUseToolFn } | undefined {
  const turn = turnSteps.get(controller)?.get(agentId ?? '')
  if (!turn) return undefined
  return { turnId: turn.turnId, index: turn.next++, context: turn.context, canUseTool: turn.canUseTool }
}

/** Why a turn ended, as turn.complete's `reason` says it. */
type TurnEnd = 'answer' | 'aborted' | 'refusal' | 'error'
/** Query ends an API error decided; each also leaves an API error row. */
const ERROR_ENDS = new Set(['model_error', 'prompt_too_long', 'image_error', 'blocking_limit'])
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const

/**
 * turn.start's `text`: the prompt the turn proceeds with as the prompt
 * pipeline settled it, "" for a turn no prompt started (a continuation, a
 * notification). A subagent's run begins with its Agent call's prompt or,
 * when nobody noted one (a teammate woken by a message), the newest text
 * after its last answer.
 */
function turnStartText(messages: readonly Message[], agentId: string | undefined): string {
  const noted = agentId === undefined ? undefined : takeModAgentTurnText(agentId)
  if (noted !== undefined) return noted
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type === 'assistant') break
    if (message.type !== 'user') continue
    const text = takeModTurnText(message.uuid)
    if (text !== undefined) return text
  }
  if (agentId === undefined) return ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type === 'assistant') break
    if (message.type !== 'user' || message.isMeta) continue
    const text = submittedPromptText(message.message.content as string | ContentBlockParam[])
    if (text) return text
  }
  return ''
}

/** What the API said of the refusal that ended a turn (TurnRefusal). */
function refusalOf(row: AssistantMessage | undefined): { category: string | null; explanation: string | null } {
  const details = (row as { refusal?: { category?: unknown; explanation?: unknown } } | undefined)?.refusal
  return {
    category: typeof details?.category === 'string' ? details.category : null,
    explanation: typeof details?.explanation === 'string' ? details.explanation : null,
  }
}

/**
 * turn.complete's `by`, the engine's: the plugins that rewrote the answer
 * they passed down or wrote the text, in chain order. They head its note.
 */
function completionAuthors(trace: readonly ModTraceEntry[], answer: string): string[] {
  // A link's last run stands; links in the order the chain runs them.
  const links = [...new Map(trace.map(entry => [entry.index, entry])).values()].sort((a, b) => a.index - b.index)
  const answerOf = (entry: ModTraceEntry) => {
    const received = entry.received as ModRecord | undefined
    return typeof received?.answer === 'string' ? received.answer : undefined
  }
  const authors = new Set<number>()
  for (let index = 0; index + 1 < links.length; index++) {
    const own = answerOf(links[index]!), beneath = answerOf(links[index + 1]!)
    if (own !== undefined && beneath !== undefined && own !== beneath) authors.add(links[index]!.index)
  }
  let text = answer
  for (let index = links.length - 1; index >= 0; index--) {
    const link = links[index]!
    const returned = link.returned as ModRecord | undefined
    if (!['returned', 'caught', 'passed'].includes(link.outcome) || typeof returned?.text !== 'string') continue
    if (returned.text !== text) authors.add(link.index)
    text = returned.text
  }
  return [...new Set(links.filter(link => authors.has(link.index) && link.plugin !== 'engine').map(link => link.plugin))]
}

/** Observe the complete shared query, rather than individual model requests. */
export async function* withModTurnLifecycle<T>(
  source: AsyncGenerator<TurnMessage, T>,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
): AsyncGenerator<TurnMessage, T> {
  // A cancelled queued submission never acquired a turn. The query source
  // handles its aborted controller without emitting a new lifecycle pair.
  if (context.abortController.signal.aborted) return yield* source
  const turnId = randomUUID()
  let loops = turnSteps.get(context.abortController)
  if (!loops) turnSteps.set(context.abortController, (loops = new Map()))
  loops.set(context.agentId ?? '', { turnId, next: 0, context, canUseTool })
  const endTurn = !context.agentId ? beginModMainTurn(turnId, context.abortController) : undefined
  const agentMessages = context.agentId ? [...context.messages] : undefined
  const endAgent = context.agentId ? bindModAgentConversation(context.agentId, () => agentMessages!) : undefined
  const startedAt = Date.now()
  const requests = new Map<string, AssistantMessage>()
  // Each response's message_start counts and model, so a response with no
  // content of its own (a refusal) still counts.
  const opened = new Map<string, { usage: Record<string, number>; model?: string }>()
  const streamedUsage = new Map<string, Record<string, number>>()
  const responseText = new Map<string, string>()
  let responseId: string | undefined
  let streamingResponseId: string | undefined
  let assistant: AssistantMessage | undefined
  // The turn's last assistant row, an API error's included: what ended it.
  let lastRow: AssistantMessage | undefined
  let done = false
  let threw = false
  let terminal: T
  let completeText = ''
  try {
    if (!context.agentId) {
      for (const message of context.messages)
        if (message.type === 'user') acceptQueuedModPrompt(message.uuid)
    }
    // Every loop's turn starts: the main one's and each subagent's or
    // teammate's run, whose `agentId` is pinned.
    if (hasModEvent('turn.start')) {
      const text = turnStartText(context.messages, context.agentId)
      try {
        await inToolContext(context, canUseTool, () => dispatchModEvent('turn.start',
          { text, turnId, ...(context.agentId ? { agentId: context.agentId } : {}) },
          async e => ({ turnId: e.turnId }), context.abortController.signal))
      } catch (error) {
        // Aborting its own turn is an acknowledged API action. Let the query
        // return its ordinary aborted result instead of surfacing a hook error.
        if (!isModTurnAbort(context.abortController.signal)) throw error
      }
    }
    while (true) {
      let next: IteratorResult<TurnMessage, T>
      try {
        next = await source.next()
      } catch (error) {
        threw = true
        throw error
      }
      if (next.done) { done = true; terminal = next.value; break }
      const message = next.value
      if (agentMessages) {
        if (message.type === 'tombstone') {
          const index = agentMessages.findIndex(item => item.uuid === message.message.uuid)
          if (index >= 0) agentMessages.splice(index, 1)
        } else if (['user', 'assistant', 'attachment', 'system', 'progress'].includes(message.type)) {
          const row = message as Message
          const index = agentMessages.findIndex(item => item.uuid === row.uuid)
          if (index >= 0) agentMessages[index] = row
          else agentMessages.push(row)
        }
      }
      if (message.type === 'stream_request_start') streamingResponseId = undefined
      if (message.type === 'assistant') lastRow = message
      if (message.type === 'assistant' && !message.isApiErrorMessage) {
        assistant = message
        const id = message.message.id || message.uuid
        if (id !== responseId) { responseId = id; responseText.clear() }
        responseText.set(message.uuid, message.message.content.filter((block: ContentBlockParam): block is TextBlockParam => block.type === 'text').map((block: TextBlockParam) => block.text).join('\n'))
        // Native streaming fills final usage after yielding the assistant block.
        // Retain the response, then read its final usage after the stream closes.
        requests.set(id, message)
      }
      if (message.type === 'stream_event' && message.event.type === 'message_start') {
        streamingResponseId = message.event.message.id
        const counts: Record<string, number> = {}
        for (const key of USAGE_KEYS) {
          const count = (message.event.message.usage as Record<string, unknown> | undefined)?.[key]
          if (typeof count === 'number' && Number.isFinite(count) && count > 0) counts[key] = count
        }
        const model = message.event.message.model
        opened.set(message.event.message.id, { usage: counts, ...(typeof model === 'string' && model ? { model } : {}) })
      }
      const usageResponseId = streamingResponseId ?? responseId
      if (message.type === 'stream_event' && message.event.type === 'message_delta' && usageResponseId) {
        const finalUsage = streamedUsage.get(usageResponseId) ?? {}
        for (const key of USAGE_KEYS) {
          const count = message.event.usage[key as keyof typeof message.event.usage]
          if (typeof count === 'number' && Number.isFinite(count) && (count > 0 || key === 'output_tokens')) finalUsage[key] = count
        }
        streamedUsage.set(usageResponseId, finalUsage)
      }
      yield message
    }
  } finally {
    try {
      if (!done) await source.return(undefined as T)
    } finally {
      turnSteps.get(context.abortController)?.delete(context.agentId ?? '')
      endTurn?.()
      if (hasModEvent('turn.complete')) {
        // What the turn cost (TurnUsage): its responses' counts summed and the
        // model of the last that counted; absent when nothing counted.
        let usage: Record<string, number> | undefined
        let model: string | undefined
        for (const id of new Set([...opened.keys(), ...requests.keys()])) {
          const request = requests.get(id), start = opened.get(id), finalUsage = streamedUsage.get(id)
          const reported = request?.message.usage as Record<string, unknown> | undefined
          if (!reported && !finalUsage && !start) continue
          usage ??= { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
          for (const key of USAGE_KEYS) {
            const count = finalUsage?.[key] ?? reported?.[key] ?? start?.usage[key]
            if (typeof count === 'number' && Number.isFinite(count)) usage[key] += count
          }
          const named = request?.message.model
          model = (typeof named === 'string' && named) || start?.model || model
        }
        // Why it ended: interrupted (an abort, or its reader stopped), an error
        // (the query failed, or an API error row ended it), a refusal, or an answer.
        const ended = (terminal! as { reason?: unknown } | undefined)?.reason
        const reason: TurnEnd = context.abortController.signal.aborted || (!done && !threw) ? 'aborted'
          : threw ? 'error'
          : lastRow?.isApiErrorMessage ? (lastRow.apiError === 'refusal' ? 'refusal' : 'error')
          : typeof ended === 'string' && ERROR_ENDS.has(ended) ? 'error'
          : 'answer'
        const answer = [...responseText.values()].filter(Boolean).join('\n')
        const trace: ModTraceEntry[] = []
        try {
          // Completion must run even when the turn's abort signal is already set.
          const result = await inToolContext(context, canUseTool, async () => await dispatchModEvent('turn.complete', {
            answer,
            durationMs: Math.max(0, Date.now() - startedAt),
            isAborted: reason === 'aborted',
            turnId,
            ...(context.agentId ? { agentId: context.agentId } : {}),
            ...(usage ? { usage: { ...usage, model: model ?? context.options.mainLoopModel } } : {}),
            reason,
            ...(reason === 'refusal' ? { refusal: refusalOf(lastRow) } : {}),
          }, async e => ({ text: e.answer, ...(e.usage ? { usage: e.usage } : {}) }), undefined, { collect: trace }) as ModRecord, assistant)
          // The answer is on screen already: a text other than it goes beneath
          // it, headed by the plugins that wrote it.
          if (typeof result.text === 'string' && result.text && result.text !== answer) {
            const by = completionAuthors(trace, answer)
            completeText = by.length ? `${by.join(', ')}: ${result.text}` : result.text
          }
        } catch (error) {
          logForDebugging(`Mod turn.complete failed: ${String(error)}`)
        }
      }
      endAgent?.()
    }
  }
  // Informational messages are presentation only and are excluded from API history.
  if (completeText) yield createModNoticeMessage(completeText)
  return terminal!
}
