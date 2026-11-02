import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { cloneFileStateCache } from '../../utils/fileStateCache.js'
import { executePostCompactHooks, executePreCompactHooks } from '../../utils/hooks.js'
import { createCompactBoundaryMessage, isCompactBoundaryMessage } from '../../utils/messages.js'
import { CompactMessageHandles, compactFallbackText } from '../../utils/plugins/mods/compactMessages.js'
import { inToolContext } from '../../utils/plugins/mods/lifecycle.js'
import { dispatchModEvent } from '../../utils/plugins/mods/manager.js'
import { writeToStderr } from '../../utils/process.js'
import { cleanMessagesForLogging, isChainParticipant } from '../../utils/sessionStorage.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { extractDiscoveredToolNames } from '../../utils/toolSearch.js'
import { annotateBoundaryWithPreservedSegment, buildPostCompactMessages, compactConversation, markFullCompactionCommitted, type CompactionResult, type RecompactionInfo } from './compact.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'

/** Stage everything that can be rejected by an automatic compaction hook. */
export async function runModAutoCompact(
  messages: Message[], context: ToolUseContext, cacheSafeParams: CacheSafeParams,
  recompactionInfo: RecompactionInfo, preserveRecentContext: boolean,
): Promise<{ skip: string } | { compactionResult: CompactionResult }> {
  const signal = context.abortController.signal
  const handles = new CompactMessageHandles(), input = handles.expose(messages)
  const snapshot = [...messages]
  const checkConversation = () => {
    if (messages.length !== snapshot.length || messages.some((row, i) => row !== snapshot[i])) throw new Error('Conversation changed during compaction')
  }
  const check = () => {
    signal.throwIfAborted()
    checkConversation()
  }
  const warnings: string[] = []
  const showFallback = () => {
    if (!prepared || !warnings.length) return
    const text = compactFallbackText(warnings)
    if (context.addNotification) {
      context.addNotification({ key: 'mod-compact-fallback', text, priority: 'immediate', color: 'warning' })
    } else if (context.options.isNonInteractiveSession) {
      writeToStderr(text + '\n')
    }
  }
  let preflight: ReturnType<typeof executePreCompactHooks> | undefined
  const preCompact = (instructions?: string) => preflight ??= executePreCompactHooks({ trigger: 'auto', customInstructions: instructions ?? null }, signal)
  let prepared: { result: CompactionResult; view: ReturnType<CompactMessageHandles['expose']>; cache: ToolUseContext['readFileState']; summary?: string; finalizeRecentContext?: (hooks: Message[]) => void; memory: boolean; selected: Message[] } | undefined
  const prepareFull = async (selected: Message[], instructions?: string) => {
    const pre = await preCompact(instructions)
    if (pre.blockedReason) return { skip: pre.blockedReason }
    const cache = cloneFileStateCache(context.readFileState)
    const staged = { ...context, messages: selected, readFileState: cache, loadedNestedMemoryPaths: new Set(context.loadedNestedMemoryPaths) }
    const preparation = { preCompact: pre, deferCommit: true as const, summary: undefined as string | undefined, finalizeRecentContext: undefined as ((hooks: Message[]) => void) | undefined }
    const result = await compactConversation(selected, staged, {
      ...cacheSafeParams, toolUseContext: staged,
      ...(selected !== messages && { forkContextMessages: selected }),
    }, true, instructions, true, recompactionInfo, preserveRecentContext, preparation)
    check()
    prepared = { result, view: handles.expose(buildPostCompactMessages(result)), cache, summary: preparation.summary, finalizeRecentContext: preparation.finalizeRecentContext, memory: false, selected }
    return prepared
  }
  const outcome = await inToolContext(context, undefined, () => dispatchModEvent('session.compact', {
    trigger: 'auto', ...(context.agentId && { agentId: context.agentId }), messages: input.rows,
  }, async event => {
    check()
    const selected = handles.restore(event.messages, input)
    const memory = !event.instructions
      ? await trySessionMemoryCompaction(selected, context.agentId, recompactionInfo.autoCompactThreshold, { deferHooks: true }) : null
    if (memory) prepared = { result: memory, view: handles.expose(buildPostCompactMessages(memory)), cache: context.readFileState, memory: true, selected }
    else {
      const full = await prepareFull(selected, event.instructions)
      if ('skip' in full) return full
    }
    const { result, view } = prepared!
    const usage = result.compactionUsage
    return { messages: view.rows, tokensBefore: result.preCompactTokenCount, tokensAfter: result.truePostCompactTokenCount,
      ...(usage && { usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0 } }) }
  }, signal, { validateInput: event => handles.checkInput(event), validateResult: result => { handles.result(result) }, onWarning: text => warnings.push(text) }))
  check()
  const receipt = handles.result(outcome)
  if ('skip' in receipt) return receipt
  const kept = handles.restore(receipt.messages, prepared?.view ?? input)
  let native = prepared && kept === prepared.view.messages ? prepared : undefined
  if (native?.memory) {
    // Hook side effects wait for acceptance. Recheck the native memory threshold
    // with those contexts included before choosing the paid fallback.
    const memory = await trySessionMemoryCompaction(native.selected, context.agentId, recompactionInfo.autoCompactThreshold)
    check()
    if (memory) { showFallback(); markFullCompactionCommitted(context, messages); return { compactionResult: memory } }
    const full = await prepareFull(native.selected)
    if ('skip' in full) return full
    native = full
  }
  const pre = await preCompact()
  check()
  if (pre.blockedReason) return { skip: pre.blockedReason }
  let result: CompactionResult
  if (native) result = native.result
  else {
    const boundary = createCompactBoundaryMessage('auto', tokenCountWithEstimation(messages), messages.at(-1)?.uuid)
    // A pass-through includes a previous boundary. The new one owns these rows.
    const custom = kept === messages ? kept.filter(row => !isCompactBoundaryMessage(row)) : kept
    const persisted = cleanMessagesForLogging(custom, custom).filter(isChainParticipant)
    result = { boundaryMarker: annotateBoundaryWithPreservedSegment(boundary, boundary.uuid, persisted, true),
      summaryMessages: [], messagesToKeep: custom, attachments: [], hookResults: [] }
    const discovered = extractDiscoveredToolNames(messages)
    if (discovered.size) result.boundaryMarker.compactMetadata.preCompactDiscoveredTools = [...discovered].sort()
  }
  const hooks = await processSessionStartHooks('compact', { model: context.options.mainLoopModel, signal })
  check()
  result.hookResults.push(...hooks)
  native?.finalizeRecentContext?.(result.hookResults)
  if (!native?.memory) {
    const summary = native?.summary ?? handles.expose(buildPostCompactMessages(result)).rows.map(row => row.text).filter(Boolean).join('\n')
    const post = await executePostCompactHooks({ trigger: 'auto', compactSummary: summary }, signal)
    // PostCompact has told its observers, so a cancellation no longer undoes
    // this compaction. Only a changed conversation can still stop it.
    checkConversation()
    result.userDisplayMessage = [pre.userDisplayMessage, post.userDisplayMessage].filter(Boolean).join('\n') || undefined
  }
  if (native) result.truePostCompactTokenCount = roughTokenCountEstimationForMessages(buildPostCompactMessages(result))
  if (native) context.readFileState.load(native.cache.dump())
  else context.readFileState.clear()
  if (!native?.memory) context.loadedNestedMemoryPaths?.clear()
  showFallback()
  markFullCompactionCommitted(context, messages)
  return { compactionResult: result }
}
