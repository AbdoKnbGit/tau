import type { HookResultMessage } from '../../types/message.js'
import type { AppState } from '../../state/AppState.js'
import { errorMessage } from '../errors.js'
import {
  checkModelSwitchHooks,
  dispatchPostModelSwitchHooks,
  resolveHookModel,
  type ModelSwitchRequest,
} from './lifecycleHooks.js'

/** Shared preflight for settings and shortcuts, which cannot show /model's confirmation. */
export async function commitModelSwitch(options: {
  model: string | null
  source: 'command' | 'picker'
  context: ModelSwitchRequest['context']
  commit: () => void
  onMessages?: (messages: HookResultMessage[]) => void
  isActive?: () => boolean
}): Promise<{ allowed: boolean; reason?: string }> {
  const { context } = options
  const current = context.getAppState()
  const previousModel = current.mainLoopModelForSession ?? current.mainLoopModel
  const request: ModelSwitchRequest = {
    fromModel: resolveHookModel(previousModel),
    toModel: resolveHookModel(options.model),
    requestedModel: options.model,
    source: options.source,
    context,
  }
  try {
    const decision = await checkModelSwitchHooks(request)
    if (decision.messages.length) options.onMessages?.(decision.messages)
    if (!decision.allowed) return decision
    const latest = context.getAppState()
    if (options.isActive?.() === false ||
        (latest.mainLoopModelForSession ?? latest.mainLoopModel) !== previousModel) {
      return { allowed: false, reason: 'Model selection changed while its hooks were running. Select the model again.' }
    }
    options.commit()
    dispatchPostModelSwitchHooks(request)
    return { allowed: true }
  } catch (error) {
    return { allowed: false, reason: `Model switch failed: ${errorMessage(error)}` }
  }
}

/** Config cancellation is a requested model change too; denied rollback keeps its model state intact. */
export function restoreModelSnapshot(options: {
  snapshot: Pick<AppState, 'mainLoopModel' | 'mainLoopModelForSession' | 'fastMode' | 'effortValue'>
  context: ModelSwitchRequest['context'] & { setAppState: (update: (state: AppState) => AppState) => void }
  commitSettings: () => void
  onMessages?: (messages: HookResultMessage[]) => void
  isActive?: () => boolean
}): Promise<{ allowed: boolean; reason?: string }> {
  return commitModelSwitch({
    model: options.snapshot.mainLoopModelForSession ?? options.snapshot.mainLoopModel,
    source: 'picker', context: options.context, onMessages: options.onMessages, isActive: options.isActive,
    commit: () => {
      options.commitSettings()
      options.context.setAppState(previous => ({ ...previous, ...options.snapshot }))
    },
  })
}
