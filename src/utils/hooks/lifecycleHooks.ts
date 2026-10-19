import { randomUUID, type UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import { getCacheControl } from '../../services/api/claude.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message, HookResultMessage } from '../../types/message.js'
import type { AppState } from '../../state/AppState.js'
import type { UserPromptExpansionHookInput, PreModelSwitchHookInput } from '../../entrypoints/agentSdkTypes.js'
import { createAttachmentMessage } from '../attachments.js'
import { logError } from '../log.js'
import { logForDebugging } from '../debug.js'
import { createBaseHookInput, executeHooks, executeHooksOutsideREPL, type AggregatedHookResult } from '../hooks.js'
import { getCanonicalName, getDefaultMainLoopModel, parseUserSpecifiedModel } from '../model/model.js'
import { getAPIProvider } from '../model/providers.js'
import { COST_TIER_3_15, MODEL_COSTS } from '../modelCost.js'
import { lookupCatalogPrice } from '../modelPricingCatalog.js'
import { getTranscriptPath, saveCustomTitle, saveAgentName } from '../sessionStorage.js'
import { defaultHookTimeoutMs } from './hookPolicy.js'

export async function applyHookSessionTitle(
  title: string,
  context?: Pick<ToolUseContext, 'setAppState'>,
  sessionId = getSessionId(),
): Promise<void> {
  const name = title.trim()
  if (!name) return
  const path = sessionId === getSessionId() ? getTranscriptPath() : undefined
  await saveCustomTitle(sessionId as UUID, name, path)
  await saveAgentName(sessionId as UUID, name, path)
  context?.setAppState(prev => ({
    ...prev,
    standaloneAgentContext: { ...prev.standaloneAgentContext, name },
  }))
}

export function formatBlockedPrompt(message: string, prompt: string, suppressOriginalPrompt = false): string {
  return suppressOriginalPrompt ? message : `${message}\n\nOriginal prompt: ${prompt}`
}

export async function* executeUserPromptExpansionHooks(
  expansion: Pick<UserPromptExpansionHookInput, 'expansion_type' | 'command_name' | 'command_args' | 'command_source' | 'prompt'>,
  context: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  yield* executeHooks({
    hookInput: {
      ...createBaseHookInput(context.getAppState().toolPermissionContext.mode),
      hook_event_name: 'UserPromptExpansion',
      ...expansion,
    },
    toolUseID: randomUUID(),
    signal: context.abortController.signal,
    timeoutMs: defaultHookTimeoutMs('UserPromptExpansion'),
    toolUseContext: context,
    requestPrompt: context.requestPrompt,
  })
}

// Background lifecycle hooks contribute to the next submitted prompt, never
// start a new model turn on their own. Session keys prevent /clear or /resume
// from delivering an old session's hook output into a different conversation.
const directoryMessages = new Map<string, HookResultMessage[]>()
const modelSwitches = new Map<string, { promise: Promise<void>; messages: HookResultMessage[] }>()
const latestConversationMessages = new Map<string, Message[]>()
const modelNotificationVersions = new Map<string, symbol>()

export function rememberLifecycleHookMessages(messages: Message[]): void {
  latestConversationMessages.set(getSessionId(), messages)
}

export function dispatchDirectoryAddedHooks(directory: string, context: ToolUseContext): void {
  const sessionId = getSessionId()
  void executeHooksOutsideREPL({
    getAppState: context.getAppState,
    hookInput: {
      ...createBaseHookInput(context.getAppState().toolPermissionContext.mode),
      hook_event_name: 'DirectoryAdded',
      directory,
      source: 'slash_command',
    },
    timeoutMs: defaultHookTimeoutMs('DirectoryAdded'),
  }).then(results => {
    const contents = results.flatMap(r => r.succeeded && r.systemMessage ? [r.systemMessage] : [])
    const failures = results.filter(r => !r.succeeded)
    for (const result of failures) logForDebugging(`DirectoryAdded hook failed: ${result.output}`)
    const messages = directoryMessages.get(sessionId) ?? []
    if (contents.length > 0) messages.push(createAttachmentMessage({
      type: 'hook_additional_context', content: contents,
      hookName: 'DirectoryAdded', toolUseID: randomUUID(), hookEvent: 'DirectoryAdded',
    }))
    if (failures.length > 0) messages.push(createAttachmentMessage({
      type: 'hook_system_message', content: `${failures.length} DirectoryAdded hook(s) failed. See the debug log for details.`,
      hookName: 'DirectoryAdded', toolUseID: randomUUID(), hookEvent: 'DirectoryAdded',
    }))
    directoryMessages.set(sessionId, messages)
  }).catch(logError)
}

export function resolveHookModel(model: string | null | undefined): string {
  return model ? parseUserSpecifiedModel(model) : getDefaultMainLoopModel()
}

type ModelSwitchContext = Pick<ToolUseContext, 'getAppState' | 'messages'> & Partial<Pick<ToolUseContext, 'requestPrompt'>>

export function modelSwitchContextTokens(messages: readonly Message[]): number {
  const last = messages.findLast(message => message.type === 'assistant')
  if (!last || last.type !== 'assistant') return 0
  const usage = last.message.usage
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}

export type ModelSwitchRequest = {
  fromModel: string
  toModel: string
  requestedModel: string | null
  source: 'command' | 'picker' | 'sdk'
  context: ModelSwitchContext
  allowConfirmation?: boolean
}

function modelSwitchInput(request: ModelSwitchRequest): PreModelSwitchHookInput {
  const contextTokens = modelSwitchContextTokens(request.context.messages)
  const cacheTtl = getCacheControl({ querySource: request.source === 'sdk' ? 'sdk' : 'repl_main_thread' }).ttl ?? '5m'
  const lastResponse = request.context.messages.findLast(message => message.type === 'assistant')
  const lastResponseTime = lastResponse ? Date.parse(lastResponse.timestamp) : NaN
  const costs = MODEL_COSTS[getCanonicalName(request.toModel)] ?? lookupCatalogPrice(getAPIProvider(), request.toModel, contextTokens)
  const writeRate = cacheTtl === '1h' ? (costs ?? COST_TIER_3_15).inputTokens * 2 : (costs ?? COST_TIER_3_15).promptCacheWriteTokens
  return {
    ...createBaseHookInput(request.context.getAppState().toolPermissionContext.mode),
    hook_event_name: 'PreModelSwitch',
    from_model: request.fromModel,
    to_model: request.toModel,
    requested_model: request.requestedModel,
    source: request.source,
    context_tokens: contextTokens,
    prompt_cache_warm: contextTokens > 0 && Number.isFinite(lastResponseTime) && Date.now() - lastResponseTime < (cacheTtl === '1h' ? 3_600_000 : 300_000),
    cache_ttl: cacheTtl,
    estimated_cache_write_usd: contextTokens * writeRate / 1_000_000,
    pricing: costs ? 'catalog' : 'default',
  }
}

export async function checkModelSwitchHooks(request: ModelSwitchRequest): Promise<{ allowed: boolean; reason?: string; messages: HookResultMessage[] }> {
  rememberLifecycleHookMessages(request.context.messages)
  const messages: HookResultMessage[] = []
  if (request.fromModel === request.toModel) return { allowed: true, messages }
  let blocked: string | undefined
  let asks = false
  let askReason: string | undefined
  for await (const result of executeHooks({
    hookInput: modelSwitchInput(request),
    toolUseID: randomUUID(),
    timeoutMs: defaultHookTimeoutMs('PreModelSwitch'),
    requestPrompt: request.context.requestPrompt,
    getAppState: request.context.getAppState,
  })) {
    if (result.message && result.message.type !== 'progress') messages.push(result.message)
    if (result.blockingError) blocked = result.blockingError.blockingError
    if (result.preventContinuation) blocked = result.stopReason || 'Model switch stopped by hook'
    if (result.permissionBehavior === 'deny') blocked = blocked || result.hookPermissionDecisionReason || 'Model switch denied by hook'
    if (result.permissionBehavior === 'ask') {
      asks = true
      askReason ??= result.hookPermissionDecisionReason
    }
  }
  if (blocked) return { allowed: false, reason: blocked, messages }
  if (asks) {
    if (!request.allowConfirmation || !request.context.requestPrompt) {
      return { allowed: false, reason: askReason || 'Model switch requires confirmation through /model in an interactive session', messages }
    }
    const response = await request.context.requestPrompt('PreModelSwitch')({
      prompt: randomUUID(),
      message: askReason || `Switch model to ${request.toModel}?`,
      options: [
        { key: 'cancel', label: 'Keep current model' },
        { key: 'allow', label: 'Switch model' },
      ],
    }).catch(() => undefined)
    if (response?.selected !== 'allow') return { allowed: false, reason: 'Model switch cancelled', messages }
  }
  return { allowed: true, messages }
}

export function dispatchPostModelSwitchHooks(request: Omit<ModelSwitchRequest, 'source'> & { source: ModelSwitchRequest['source'] | 'auto' | 'resume' }): void {
  if (request.fromModel === request.toModel) return
  const sessionId = getSessionId()
  modelNotificationVersions.set(sessionId, Symbol())
  const pending = { promise: Promise.resolve(), messages: [] as HookResultMessage[] }
  modelSwitches.set(sessionId, pending)
  pending.promise = (async () => {
    for await (const result of executeHooks({
      hookInput: { ...modelSwitchInput({ ...request, source: 'command' }), source: request.source, hook_event_name: 'PostModelSwitch' },
      toolUseID: randomUUID(),
      timeoutMs: defaultHookTimeoutMs('PostModelSwitch'),
      getAppState: request.context.getAppState,
    })) {
      if (result.message && result.message.type !== 'progress') pending.messages.push(result.message)
      if (result.additionalContexts?.length) pending.messages.push(createAttachmentMessage({
        type: 'hook_additional_context', content: result.additionalContexts,
        hookName: 'PostModelSwitch', toolUseID: randomUUID(), hookEvent: 'PostModelSwitch',
      }))
    }
  })().catch(logError)
}

/** Covers session model overrides and plan-mode changes without inventing a preflight for automatic changes. */
export function observeModelSwitch(oldState: AppState, newState: AppState): void {
  const previousSetting = oldState.mainLoopModelForSession ?? oldState.mainLoopModel
  const nextSetting = newState.mainLoopModelForSession ?? newState.mainLoopModel
  if (previousSetting === nextSetting) return
  const sessionId = getSessionId()
  const version = Symbol()
  modelNotificationVersions.set(sessionId, version)
  const fromModel = resolveHookModel(previousSetting)
  const toModel = resolveHookModel(nextSetting)
  // Explicit callers dispatch immediately after committing state. Wait one
  // microtask so that their richer source/input wins over this fallback.
  void Promise.resolve().then(() => {
    if (getSessionId() !== sessionId || modelNotificationVersions.get(sessionId) !== version) return
    dispatchPostModelSwitchHooks({
      fromModel, toModel, requestedModel: null, source: 'auto',
      context: { getAppState: () => newState, messages: latestConversationMessages.get(sessionId) ?? [] },
    })
  }).catch(logError)
}

export async function takePendingLifecycleHookMessages(): Promise<HookResultMessage[]> {
  const sessionId = getSessionId()
  const pending = modelSwitches.get(sessionId)
  if (pending) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const completed = await Promise.race([
      pending.promise.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5_000) }),
    ])
    if (timer) clearTimeout(timer)
    // A later switch supersedes all earlier output, even while we awaited it.
    if (completed && modelSwitches.get(sessionId) === pending) modelSwitches.delete(sessionId)
    else if (modelSwitches.get(sessionId) !== pending) pending.messages.length = 0
  }
  const messages = directoryMessages.get(sessionId) ?? []
  directoryMessages.delete(sessionId)
  if (pending && !modelSwitches.has(sessionId)) messages.push(...pending.messages)
  return messages
}

/**
 * Puts back messages a submission took but did not deliver because it did not
 * query. Output from an earlier model switch stays superseded by a later one.
 */
export function restorePendingLifecycleHookMessages(messages: readonly HookResultMessage[]): void {
  if (messages.length === 0) return
  const sessionId = getSessionId()
  const fromModelSwitch = (message: HookResultMessage) =>
    message.type === 'attachment' && message.attachment.hookEvent === 'PostModelSwitch'
  const directory = messages.filter(message => !fromModelSwitch(message))
  const switched = messages.filter(fromModelSwitch)
  if (directory.length > 0) {
    directoryMessages.set(sessionId, [...directory, ...(directoryMessages.get(sessionId) ?? [])])
  }
  if (switched.length > 0 && !modelSwitches.has(sessionId)) {
    modelSwitches.set(sessionId, { promise: Promise.resolve(), messages: switched })
  }
}
