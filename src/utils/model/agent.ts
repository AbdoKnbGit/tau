import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES } from './aliases.js'
import { MISTRAL_AGENT_MODEL, resolveMistralAgentModelSpec } from './mistralAgentModel.js'
import {
  pinnedAgentModelOutranksAlias,
  resolveAgentAliasPolicy,
} from './agentAliasFallback.js'
import { resolveAntigravityOpus46AgentModel } from './antigravityAgentModel.js'
import { applyBedrockRegionPrefix, getBedrockRegionPrefix } from './bedrock.js'
import {
  getCanonicalName,
  getMainLoopModel,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'
import {
  getAPIProvider,
  type APIProvider,
  PROVIDER_DISPLAY_NAMES,
} from './providers.js'
import {
  type AgentModelScope,
  describeSubagentModelSetting,
  getCustomSubagentModel,
  getCustomSubagentTarget,
  getGlobalSubagentTarget,
  getSubagentModelEnvOverride,
  getSubagentModelMode,
  isInheritModelSpec,
  isSubagentSettingScoped,
  isTierModelSpec,
  type SubagentModelSetting,
  type SubagentModelTarget,
} from './subagentModel.js'
import {
  getForcedProvider,
  isExplicitProviderOverride,
} from '../forcedProvider.js'
import { getInitialSettings } from '../settings/settings.js'

export const AGENT_MODEL_OPTIONS = [...MODEL_ALIASES, 'inherit'] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]

export type AgentModelOption = {
  value: AgentModelAlias
  label: string
  description: string
}

/**
 * Get the implicit default. Explicit `inherit` remains a separate choice.
 */
export function getDefaultSubagentModel(provider = getAPIProvider()): string {
  return provider === 'mistral' ? MISTRAL_AGENT_MODEL : 'inherit'
}

function readSubagentModelSetting(): SubagentModelSetting {
  return getInitialSettings().subagentModel
}

/**
 * Get the effective model string for an agent.
 *
 * The Sub-agent model setting (subagentModel.ts) decides for built-in agents
 * and agent files that name neither a model nor a provider; in its default
 * Auto mode they resolve exactly as before it existed. An agent file that
 * names its model keeps it: a tier the caller guesses never replaces it, and
 * `inherit` means the main model. CLAUDE_CODE_SUBAGENT_MODEL, a provider
 * pinned by the agent file, and an explicit caller provider (/team-mode, the
 * Agent tool's `provider`) keep every agent on resolveLegacyAgentModel().
 *
 * `scope` says whether the agent is built in; without it the agent is
 * treated as an agent file.
 */
export function getAgentModel(
  definitionModel: string | undefined,
  parentModel: string,
  callerModel?: string,
  permissionMode?: PermissionMode,
  agentProvider?: APIProvider,
  scope?: AgentModelScope,
): string {
  // A blank model is no model: never an empty id on the wire.
  const agentModel = definitionModel?.trim() ? definitionModel : undefined
  const toolSpecifiedModel = callerModel?.trim() ? callerModel : undefined
  const legacy = (
    definition: string | undefined,
    caller: string | undefined,
  ): string =>
    resolveLegacyAgentModel(
      definition,
      parentModel,
      caller,
      permissionMode,
      agentProvider,
    )

  if (
    getSubagentModelEnvOverride() !== undefined ||
    agentProvider !== undefined ||
    isExplicitProviderOverride()
  ) {
    return legacy(agentModel, toolSpecifiedModel)
  }

  const sessionModel = (): string =>
    getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  // A concrete id from the caller (Mistral's model_id, a resumed agent's
  // saved model) is a choice; a tier it passes is only a guess at one.
  const callerChoice =
    toolSpecifiedModel !== undefined && !isTierModelSpec(toolSpecifiedModel)
      ? toolSpecifiedModel
      : undefined
  const resolveCallerChoice = (choice: string): string =>
    isInheritModelSpec(choice) ? sessionModel() : legacy(agentModel, choice)

  if (!isSubagentSettingScoped(agentModel, scope)) {
    if (callerChoice !== undefined) return resolveCallerChoice(callerChoice)
    // Only the fork gets here without a model: it keeps its parent's.
    if (agentModel === undefined || isInheritModelSpec(agentModel)) {
      return sessionModel()
    }
    return legacy(agentModel, undefined)
  }

  const setting = readSubagentModelSetting()
  const mode = getSubagentModelMode(setting)
  if (mode === 'auto') return legacy(agentModel, toolSpecifiedModel)
  if (callerChoice !== undefined) return resolveCallerChoice(callerChoice)
  if (mode === 'inherit') return sessionModel()
  if (mode === 'global') {
    // The id belongs to the global pick's provider, which runAgent pins the
    // agent to, so it is sent as is rather than read by this provider's rules.
    return (
      getGlobalSubagentTarget(setting)?.model ??
      legacy(agentModel, toolSpecifiedModel)
    )
  }
  const customModel = getCustomSubagentModel(setting, getAPIProvider())
  return customModel === undefined
    ? legacy(agentModel, toolSpecifiedModel)
    : legacy(undefined, customModel)
}

/**
 * The pick the Sub-agent model setting makes for this spawn in its Custom and
 * Global modes: the model, the provider it runs on and an effort for the
 * agent alone. Undefined whenever the setting does not decide, by the same
 * rules as getAgentModel(): another mode, CLAUDE_CODE_SUBAGENT_MODEL, an
 * agent pinned by its file or by an explicit caller provider, an agent file
 * with its own model, a concrete model from the caller, or no usable pick.
 */
export function getSubagentSettingTarget(
  definitionModel: string | undefined,
  callerModel: string | undefined,
  agentProvider: APIProvider | undefined,
  scope: AgentModelScope | undefined,
): SubagentModelTarget | undefined {
  const agentModel = definitionModel?.trim() ? definitionModel : undefined
  if (
    getSubagentModelEnvOverride() !== undefined ||
    agentProvider !== undefined ||
    isExplicitProviderOverride() ||
    !isSubagentSettingScoped(agentModel, scope) ||
    (callerModel?.trim() && !isTierModelSpec(callerModel))
  ) {
    return undefined
  }
  const setting = readSubagentModelSetting()
  switch (getSubagentModelMode(setting)) {
    case 'custom':
      return getCustomSubagentTarget(setting, getAPIProvider())
    case 'global':
      return getGlobalSubagentTarget(setting)
    default:
      return undefined
  }
}

/**
 * How agents resolved before the Sub-agent model setting, and how they still
 * resolve in its Auto mode.
 *
 * For Bedrock, if the parent model uses a cross-region inference prefix (e.g., "eu.", "us."),
 * that prefix is inherited by subagents using alias models (e.g., "sonnet", "haiku", "opus").
 * This ensures subagents use the same region as the parent, which is necessary when
 * IAM permissions are scoped to specific cross-region inference profiles.
 */
function resolveLegacyAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: PermissionMode,
  agentProvider?: APIProvider,
): string {
  const envModel = getSubagentModelEnvOverride()
  const runtimeParentModel = (): string =>
    getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })

  if (getAPIProvider() === 'mistral') {
    const spec = resolveMistralAgentModelSpec({
      agentModel,
      toolModel: toolSpecifiedModel,
      defaultModel: getForcedProvider() === undefined ? envModel : undefined,
    })
    return spec === 'inherit' ? runtimeParentModel() : spec
  }

  // Extract Bedrock region prefix from parent model to inherit for subagents.
  // This ensures subagents use the same cross-region inference profile (e.g., "eu.", "us.")
  // as the parent, which is required when IAM permissions only allow specific regions.
  const parentRegionPrefix = getBedrockRegionPrefix(parentModel)

  // Helper to apply parent region prefix for Bedrock models.
  // `originalSpec` is the raw model string before resolution (alias or full ID).
  // If the user explicitly specified a full model ID that already carries its own
  // region prefix (e.g., "eu.anthropic.…"), we preserve it instead of overwriting
  // with the parent's prefix. This prevents silent data-residency violations when
  // an agent config intentionally pins to a different region than the parent.
  const applyParentRegionPrefix = (
    resolvedModel: string,
    originalSpec: string,
  ): string => {
    if (parentRegionPrefix && getAPIProvider() === 'bedrock') {
      if (getBedrockRegionPrefix(originalSpec)) return resolvedModel
      return applyBedrockRegionPrefix(resolvedModel, parentRegionPrefix)
    }
    return resolvedModel
  }

  // A tool-level selection wins over CLAUDE_CODE_SUBAGENT_MODEL and other
  // session-wide defaults. Concrete IDs pass through unchanged; tier aliases
  // are translated by the active provider's agent policy below.
  //
  // The one exception is an agent that pinned its own provider: a tier alias
  // means nothing on that lane, so the agent's concrete model stands instead
  // of being resolved into the session's model or the provider's fixed agent
  // model. See pinnedAgentModelOutranksAlias().
  //
  // `inherit` from the caller is the parent's model, sent as is (it is not a
  // model id). That model belongs to the parent's lane, so a pinned agent
  // keeps its own model instead.
  if (toolSpecifiedModel && isInheritModelSpec(toolSpecifiedModel)) {
    if (agentProvider === undefined) return runtimeParentModel()
  } else if (
    toolSpecifiedModel &&
    !pinnedAgentModelOutranksAlias(toolSpecifiedModel, agentModel, agentProvider)
  ) {
    const policyModel = resolveAgentAliasPolicy(
      toolSpecifiedModel,
      parentModel,
      getAPIProvider(),
    )
    if (policyModel) return policyModel
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      return parentModel
    }
    const model = parseUserSpecifiedModel(toolSpecifiedModel)
    return applyParentRegionPrefix(model, toolSpecifiedModel)
  }

  // CLAUDE_CODE_SUBAGENT_MODEL is a session-wide override for "all subagents
  // use this model". It must NOT fire when a team-mode role pinned the
  // provider for this spawn — the env var would silently replace the role's
  // model with whatever default this var holds, exactly the cross-binding
  // contamination we shipped v0.9.3-v0.9.4 to prevent.
  if (envModel && getForcedProvider() === undefined) {
    if (isInheritModelSpec(envModel)) return runtimeParentModel()
    const policyModel = resolveAgentAliasPolicy(
      envModel,
      parentModel,
      getAPIProvider(),
    )
    if (policyModel) return policyModel
    return parseUserSpecifiedModel(envModel)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    // Antigravity sends model-less subagents to its agent models instead.
    const antigravityModel = resolveAntigravityOpus46AgentModel('inherit', parentModel, getAPIProvider())
    if (antigravityModel && antigravityModel !== parentModel) return antigravityModel
    // Apply runtime model resolution for inherit to get the effective model
    // This ensures agents using 'inherit' get opusplan→Opus resolution in plan mode
    return runtimeParentModel()
  }

  const policyModel = resolveAgentAliasPolicy(
    agentModelWithExp,
    parentModel,
    getAPIProvider(),
  )
  if (policyModel) return policyModel

  if (aliasMatchesParentTier(agentModelWithExp, parentModel)) {
    return parentModel
  }
  const model = parseUserSpecifiedModel(agentModelWithExp)
  return applyParentRegionPrefix(model, agentModelWithExp)
}

/**
 * Check if a bare family alias (opus/sonnet/haiku) matches the parent model's
 * tier. When it does, the subagent inherits the parent's exact model string
 * instead of resolving the alias to a provider default.
 *
 * Prevents surprising downgrades: a Vertex user on Opus 4.6 (via /model) who
 * spawns a subagent with `model: opus` should get Opus 4.6, not whatever
 * getDefaultOpusModel() returns for 3P.
 * See https://github.com/anthropics/claude-code/issues/30815.
 *
 * Only bare family aliases match. `opus[1m]`, `best`, `opusplan` fall through
 * since they carry semantics beyond "same tier as parent".
 */
function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  const canonical = getCanonicalName(parentModel)
  switch (alias.toLowerCase()) {
    case 'opus':
      return canonical.includes('opus')
    case 'sonnet':
      return canonical.includes('sonnet')
    case 'haiku':
      return canonical.includes('haiku')
    default:
      return false
  }
}

/**
 * What /agents shows for an agent's model: the rule that decides it, then the
 * model it runs on now (for the current provider and main model). `agent`
 * says whether it is built in; without it the agent is treated as a file.
 */
export function getAgentModelDisplay(
  model: string | undefined,
  provider?: APIProvider,
  agent?: { source?: string; agentType?: string },
): string {
  if (provider) {
    return `${PROVIDER_DISPLAY_NAMES[provider]} / ${model ?? 'inherit from parent'}`
  }
  const scope: AgentModelScope = {
    builtIn: agent?.source === 'built-in',
    agentType: agent?.agentType,
  }
  const rule = describeAgentModelRule(model, scope)
  let runsOn: string | undefined
  try {
    runsOn = getAgentModel(model, getMainLoopModel(), undefined, undefined, undefined, scope)
  } catch {
    // A label must never break /agents.
  }
  return runsOn && runsOn !== rule ? `${rule} → ${runsOn}` : rule
}

function describeAgentModelRule(
  model: string | undefined,
  scope: AgentModelScope,
): string {
  if (getSubagentModelEnvOverride() !== undefined) {
    return 'CLAUDE_CODE_SUBAGENT_MODEL'
  }
  if (isSubagentSettingScoped(model, scope)) {
    const provider = getAPIProvider()
    return `Sub-agent model: ${describeSubagentModelSetting(
      readSubagentModelSetting(),
      provider,
      name => PROVIDER_DISPLAY_NAMES[name],
    )}`
  }
  if (model === undefined || isInheritModelSpec(model)) {
    return 'Inherit from parent'
  }
  return isTierModelSpec(model) ? capitalize(model.trim()) : model.trim()
}

/**
 * Get available model options for agents
 */
export function getAgentModelOptions(): AgentModelOption[] {
  return [
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Balanced performance - best for most agents',
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Most capable for complex reasoning tasks',
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient for simple tasks',
    },
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
}
