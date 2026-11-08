import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getSessionId, isSessionPersistenceDisabled } from '../../../bootstrap/state.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { Message } from '../../../types/message.js'
import { getCacheSharingParams } from '../../../commands/compact/compact.js'
import {
  annotateBoundaryWithPreservedSegment, buildPostCompactMessages, compactConversation,
  markFullCompactionCommitted, type CompactionResult,
} from '../../../services/compact/compact.js'
import { runPostCompactCleanup } from '../../../services/compact/postCompactCleanup.js'
import { suppressCompactWarning } from '../../../services/compact/compactWarningState.js'
import { setLastSummarizedMessageId } from '../../../services/SessionMemory/sessionMemoryUtils.js'
import { cloneFileStateCache } from '../../fileStateCache.js'
import { executePostCompactHooks, executePreCompactHooks } from '../../hooks.js'
import { logError } from '../../log.js'
import { createCompactBoundaryMessage, getMessagesAfterCompactBoundary } from '../../messages.js'
import { cleanMessagesForLogging, isChainParticipant, recordTranscript } from '../../sessionStorage.js'
import { processSessionStartHooks } from '../../sessionStart.js'
import { tokenCountWithEstimation } from '../../tokens.js'
import { extractDiscoveredToolNames } from '../../toolSearch.js'
import { isEnvTruthy } from '../../envUtils.js'
import { CompactMessageHandles, compactFallbackText } from './compactMessages.js'
import { dispatchModEvent, hasModEvent, logModCompactionFallback, modChainSeat } from './manager.js'
import { getModMainTurn, getModSessionBinding, isModSessionBusy, reserveModCompaction } from './sessionState.js'
import { getModToolContext, type ModCallFrame } from './toolContext.js'

const argumentsSchema = z.object({ instructions: z.string().optional() }).strict()
type View = ReturnType<CompactMessageHandles['expose']>

function replacement(history: Message[], kept: Message[]): CompactionResult {
  const boundary = createCompactBoundaryMessage('manual', tokenCountWithEstimation(history), history.at(-1)?.uuid)
  const persisted = cleanMessagesForLogging(kept, kept).filter(isChainParticipant)
  return {
    boundaryMarker: annotateBoundaryWithPreservedSegment(boundary, boundary.uuid, persisted, true),
    summaryMessages: [], messagesToKeep: kept, attachments: [], hookResults: [],
  }
}

export async function compactModSession(args: unknown[], signal: AbortSignal, frame: ModCallFrame | undefined, plugin: string) {
  if (args.length > 1) throw new Error('session.compact takes one optional argument object')
  const { instructions } = argumentsSchema.parse(args[0] === undefined ? {} : args[0])
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) throw new Error('Compaction is disabled')
  if (getModMainTurn() || (isModSessionBusy() && frame?.event !== 'command.run')) throw new Error('Cannot compact while a turn is running')
  const binding = getModSessionBinding()
  const bound = getModToolContext()?.toolUseContext
  const context = bound && !bound.agentId ? bound : binding?.getCompactContext?.()
  if (!binding?.setMessages || !context || context.agentId) throw new Error('session.compact requires a writable main session between turns')
  const { receipt } = await runCompactTransaction(context, instructions, signal, 'plugin', frame, plugin)
  return receipt
}

/** Summarization and middleware run against a snapshot. Only the accepted
 * result may replace history, invalidate read anchors, or run completion hooks. */
export async function runCompactTransaction(
  context: ToolUseContext, instructions: string | undefined, signal: AbortSignal,
  trigger: 'manual' | 'plugin', frame?: ModCallFrame, plugin?: string,
) {
  const binding = getModSessionBinding()
  const currentHistory = () => binding?.getMessages() ?? context.messages
  const snapshot = [...currentHistory()]
  const history = getMessagesAfterCompactBoundary(snapshot)
  const controller = new AbortController()
  const linked = AbortSignal.any([signal, context.abortController.signal])
  linked.throwIfAborted()
  const release = reserveModCompaction(controller)
  const cancel = () => controller.abort(linked.reason)
  linked.addEventListener('abort', cancel, { once: true })
  const checkConversation = () => {
    const current = currentHistory()
    if (getModSessionBinding() !== binding || current.length !== snapshot.length || current.some((row, i) => row !== snapshot[i])) {
      throw new Error('Conversation changed during compaction')
    }
  }
  const check = () => {
    controller.signal.throwIfAborted()
    checkConversation()
  }

  try {
    const handles = new CompactMessageHandles()
    const input = hasModEvent('session.compact') ? handles.expose(history) : { messages: history, rows: [] }
    let prepared: { result: CompactionResult; view: View; cache: ToolUseContext['readFileState']; summary?: string } | undefined
    let preflight: ReturnType<typeof executePreCompactHooks> | undefined
    const warnings: string[] = []
    const preCompact = (hint?: string) => preflight ??= executePreCompactHooks({
      trigger: 'manual', customInstructions: hint ?? null,
    }, controller.signal)
    const outcome = await dispatchModEvent('session.compact', {
      trigger, messages: input.rows, ...(instructions !== undefined ? { instructions } : {}),
    }, async event => {
      check()
      const pre = await preCompact(event.instructions)
      if (pre.blockedReason) return { skip: pre.blockedReason }
      const selected = handles.restore(event.messages, input)
      const cache = cloneFileStateCache(context.readFileState)
      const staged = {
        ...context, messages: selected, readFileState: cache, abortController: controller,
        loadedNestedMemoryPaths: new Set(context.loadedNestedMemoryPaths),
      }
      const params = await getCacheSharingParams(staged, selected)
      check()
      const preparation: { preCompact: typeof pre; deferCommit: true; summary?: string } = { preCompact: pre, deferCommit: true }
      const result = await compactConversation(selected, staged, params, false, event.instructions, false, undefined, false, preparation)
      check()
      const view = handles.expose(buildPostCompactMessages(result))
      prepared = { result, view, cache, summary: preparation.summary }
      const usage = result.compactionUsage
      return {
        messages: view.rows, tokensBefore: result.preCompactTokenCount, tokensAfter: result.truePostCompactTokenCount,
        ...(usage && { usage: {
          input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        } }),
      }
    }, controller.signal, {
      skip: frame, ...(plugin && { origin: modChainSeat(plugin).origin }),
      validateInput: event => handles.checkInput(event),
      validateResult: result => { handles.result(result) },
      onWarning: text => warnings.push(text),
    })
    check()
    const receipt = handles.result(outcome)
    if ('skip' in receipt) return { receipt }
    // A replacement supplied entirely by a mod must still honor classic policy.
    const pre = await preCompact(instructions)
    check()
    if (pre.blockedReason) return { receipt: { skip: pre.blockedReason } }
    const kept = handles.restore(receipt.messages, prepared?.view ?? input)
    const native = prepared && kept === prepared.view.messages ? prepared : undefined
    // A pass-through can include a previous boundary. The new boundary owns
    // the retained rows and their original attachments.
    const custom = kept === history ? kept.filter(message => message.type !== 'system' || message.subtype !== 'compact_boundary') : kept
    const result = native?.result ?? replacement(history, custom)
    if (prepared && warnings.length) {
      const text = compactFallbackText(warnings)
      context.addNotification?.({ key: 'mod-compact-fallback', text, priority: 'immediate', color: 'warning' })
      result.userDisplayMessage = [result.userDisplayMessage, text].filter(Boolean).join('\n')
      result.modFallbackMessage = text
      if (trigger === 'plugin') logModCompactionFallback(text)
    }
    // Carry discoveries from the entire real history even when hooks summarized
    // a subset. A future provider request must still see those deferred tools.
    const discovered = extractDiscoveredToolNames(history)
    if (discovered.size && result.boundaryMarker.subtype === 'compact_boundary') {
      result.boundaryMarker.compactMetadata.preCompactDiscoveredTools = [...discovered].sort()
    }
    const summary = native?.summary ?? handles.expose(buildPostCompactMessages(result)).rows.map(row => row.text).filter(Boolean).join('\n')
    // /compact hands the replacement to the command pipeline. Finish its
    // asynchronous hooks before changing caches, then return without another
    // await. A cancellation during SessionStart must leave the old history
    // usable. PostCompact has told its observers, so after it only a changed
    // conversation can still stop the replacement.
    if (trigger === 'manual') {
      const hooks = await processSessionStartHooks('compact', { model: context.options.mainLoopModel, signal: controller.signal })
      check()
      result.hookResults.push(...hooks)
      const post = await executePostCompactHooks({ trigger: 'manual', compactSummary: summary }, controller.signal)
      checkConversation()
      result.userDisplayMessage = [result.userDisplayMessage ?? pre.userDisplayMessage, post.userDisplayMessage].filter(Boolean).join('\n') || undefined
    }
    const next = buildPostCompactMessages(result)
    if (trigger === 'plugin') {
      (binding!.commitCompaction ?? binding!.setMessages)!(next)
      // Every compaction path re-keys the rows so stale memoized ones remount.
      context.setConversationId?.(randomUUID())
    }
    if (native) context.readFileState.load(native.cache.dump())
    else context.readFileState.clear()
    context.loadedNestedMemoryPaths?.clear()
    markFullCompactionCommitted(context, history)
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup()
    suppressCompactWarning()
    if (trigger === 'plugin') {
      // The replacement stands from here on, so a cancelled or failed completion
      // step must not report failure. Cancelling only ends the wait for
      // SessionStart: PostCompact runs without the cancelled signal, so its
      // observers hear about every compaction that took effect.
      const sessionId = getSessionId()
      const stillOwner = () => getModSessionBinding() === binding && getSessionId() === sessionId
      // A command that adds no messages would otherwise never save the segment.
      if (!isSessionPersistenceDisabled()) await recordTranscript(next).catch(logError)
      try {
        if (stillOwner()) {
          const hooks = await processSessionStartHooks('compact', { model: context.options.mainLoopModel, signal: controller.signal })
          if (stillOwner() && !controller.signal.aborted) {
            result.hookResults.push(...hooks)
            if (hooks.length) {
              const current = currentHistory()
              if (getMessagesAfterCompactBoundary([...current])[0] === result.boundaryMarker) binding!.setMessages!([...current, ...hooks])
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) logError(error)
      }
      if (stillOwner()) await executePostCompactHooks({ trigger: 'manual', compactSummary: summary }).catch(logError)
    }
    // The validator parses handles separately from rows. Return the original
    // public rows, including text and tool metadata, to the calling plugin.
    return { receipt: { ...receipt, messages: handles.expose(buildPostCompactMessages(result)).rows }, result }
  } finally {
    linked.removeEventListener('abort', cancel)
    controller.abort()
    release()
  }
}
