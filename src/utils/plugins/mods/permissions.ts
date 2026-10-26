import type { Tool, ToolUseContext } from '../../../Tool.js'
import type {
  PermissionDecision,
  PermissionResult,
} from '../../../types/permissions.js'
import {
  hasPermissionsToUseToolInner,
  createPermissionRequestMessage,
} from '../../permissions/permissions.js'
import { permissionRuleValueToString } from '../../permissions/permissionRuleParser.js'
import {
  dispatchModEvent,
  hasModEvent,
  type ModDispatchOptions,
} from './manager.js'
import { getModToolContext } from './toolContext.js'

export type ModToolCheckResult = {
  decision: 'allow' | 'ask' | 'deny'
  reason?: string
  rule?: string
  hook?: string
  setting?: string
  decider?: 'host'
  ceiling?: 'allow' | 'ask' | 'deny'
}

export type ModToolPermissionOptions = {
  toolUseID?: string
  hookPermissionResult?: PermissionResult
  baseDecision?: PermissionDecision
  dispatchOptions?: ModDispatchOptions
}

function readOnly(tool: Tool, input: Record<string, unknown>): boolean {
  try {
    return tool.isReadOnly(tool.inputSchema.parse(input)) === true
  } catch {
    return false
  }
}

function describe(
  decision: PermissionDecision,
  ceiling?: ModToolCheckResult['ceiling'],
): ModToolCheckResult {
  const reason = decision.decisionReason
  return {
    decision: decision.behavior,
    ...('message' in decision
      ? { reason: decision.message }
      : reason && 'reason' in reason && reason.reason
        ? { reason: reason.reason }
        : {}),
    ...(reason?.type === 'rule'
      ? { rule: permissionRuleValueToString(reason.rule.ruleValue) }
      : {}),
    ...(reason?.type === 'hook' ? { hook: reason.hookName.split(':')[0] } : {}),
    ...(ceiling ? { ceiling } : {}),
  }
}

async function evaluate(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  options: ModToolPermissionOptions,
): Promise<{ result: ModToolCheckResult; decision: PermissionDecision }> {
  const readonly = readOnly(tool, input)
  let baseline =
    options.baseDecision ??
    (await hasPermissionsToUseToolInner(tool, input, context))
  const hook = options.hookPermissionResult
  let protectedDecision: PermissionDecision | undefined
  if (
    baseline.behavior === 'deny' ||
    (baseline.behavior === 'ask' &&
      (baseline.decisionReason?.type === 'rule' ||
        baseline.decisionReason?.type === 'safetyCheck' ||
        tool.requiresUserInteraction?.()))
  ) {
    protectedDecision = baseline
  }
  if (
    context.getAppState().toolPermissionContext.mode === 'plan' &&
    !readonly
  ) {
    protectedDecision =
      baseline.behavior === 'deny'
        ? baseline
        : {
            behavior: 'ask',
            message:
              'Plan mode requires approval for tools that may change state.',
            decisionReason: { type: 'mode', mode: 'plan' },
          }
  }
  if (hook?.behavior === 'deny') {
    baseline = hook
    protectedDecision = hook
  } else if (hook?.behavior === 'ask') {
    if (baseline.behavior !== 'deny') baseline = hook
    protectedDecision = baseline
  } else if (hook?.behavior === 'allow') {
    // The declarative check above already evaluated the same rules/safety
    // objections as the classic allow path. Do not run tool.checkPermissions
    // twice before dispatching one tool.check event.
    if (
      !protectedDecision &&
      !context.requireCanUseTool &&
      !tool.requiresUserInteraction?.()
    )
      baseline = hook
  }
  if (protectedDecision) baseline = protectedDecision
  const ceiling = protectedDecision?.behavior
  const core = describe(baseline, ceiling)
  const event = {
    tool: tool.name,
    input,
    ...(options.toolUseID ? { tool_use_id: options.toolUseID } : {}),
    ...(readonly ? { isReadOnly: true as const } : {}),
  }
  const result = hasModEvent('tool.check')
    ? ((await dispatchModEvent(
        'tool.check',
        event,
        async () => core,
        context.abortController.signal,
        options.dispatchOptions ?? getModToolContext()?.dispatchOptions,
      )) as ModToolCheckResult)
    : core
  // Policy ceilings are host facts. Mods can tighten them but cannot remove
  // a rule deny/ask, an explicit classic ask/deny, or mandatory interaction.
  if (
    protectedDecision?.behavior === 'deny' ||
    (protectedDecision?.behavior === 'ask' && result.decision === 'allow')
  ) {
    return {
      result: { ...describe(protectedDecision, ceiling) },
      decision: protectedDecision,
    }
  }
  if (protectedDecision?.behavior === 'ask' && result.decision === 'ask') {
    // Retain safety/classifier metadata even when middleware supplies a clearer
    // prompt message. Reclassifying this as a generic hook ask could make a
    // mandatory safety interaction eligible for an automatic approval.
    const decision = result.reason
      ? { ...protectedDecision, message: result.reason }
      : protectedDecision
    return { result: { ...describe(decision, ceiling) }, decision }
  }
  const finalResult = { ...result, ...(ceiling ? { ceiling } : {}) }
  if (
    result.decision === baseline.behavior &&
    (!result.reason || result.reason === core.reason)
  )
    return { result: finalResult, decision: baseline }
  const decisionReason = {
    type: 'hook' as const,
    hookName: 'tool.check',
    reason: result.reason,
  }
  if (result.decision === 'allow')
    return {
      result: finalResult,
      decision: {
        behavior: 'allow',
        updatedInput:
          'updatedInput' in baseline ? (baseline.updatedInput ?? input) : input,
        decisionReason,
      },
    }
  return {
    result: finalResult,
    decision: {
      behavior: result.decision,
      message: result.reason || createPermissionRequestMessage(tool.name),
      decisionReason,
      ...(result.decision === 'ask' && 'updatedInput' in baseline
        ? { updatedInput: baseline.updatedInput }
        : {}),
    },
  }
}

/** Pure query: declarative checks and mod middleware, without classic hooks,
 * settlement/classification, dialogs, execution, or persisted permission updates. */
export async function queryModToolPermission(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  options: ModToolPermissionOptions = {},
): Promise<ModToolCheckResult> {
  return (await evaluate(tool, input, context, options)).result
}

export async function resolveModToolPermissionDecision(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  options: ModToolPermissionOptions = {},
): Promise<PermissionDecision> {
  return (await evaluate(tool, input, context, options)).decision
}
