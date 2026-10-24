/**
 * The Sub-agent model setting: /config → Sub-agent model, settings.json
 * `subagentModel`. It decides which model a sub-agent runs on when the agent
 * names none of its own: every built-in agent except the fork, and every
 * agent file without a model or a provider.
 *
 *   - auto (default): the provider's own rules, exactly as before the setting
 *   - custom: `models[<provider>]` on that provider; a provider without an
 *     entry acts as auto, so a model id never reaches a provider that does
 *     not serve it
 *   - inherit: the main model, on every provider
 *
 * Explicit choices stay outside it: CLAUDE_CODE_SUBAGENT_MODEL, an agent
 * file's own model or provider, a concrete model the Agent call names,
 * /team-mode and the Agent call's `provider`. getAgentModel() applies it.
 *
 * Dependency-free so its rules can be tested without the config graph.
 */

import { isModelAlias } from './aliases.js'
import { API_PROVIDERS, type APIProvider } from './providerRegistry.js'

export const SUBAGENT_MODEL_MODES = ['auto', 'custom', 'inherit'] as const
export type SubagentModelMode = (typeof SUBAGENT_MODEL_MODES)[number]

/** As settings.json holds it: hand-edited, so read only through the functions below. */
export type SubagentModelSetting =
  | {
      mode?: string
      /** Model id per provider. */
      models?: Record<string, unknown>
    }
  | undefined

/** How getAgentModel() knows which rules govern an agent. */
export type AgentModelScope = {
  /** Built-in agents follow the setting even when they name a tier. */
  builtIn?: boolean
  agentType?: string
}

// The synthetic fork sends its parent's prompt prefix byte for byte, so it
// keeps its parent's exact model whatever the setting says.
const FORK_AGENT_TYPE = 'fork'

/** A tier alias (`haiku`, `sonnet`, `opus`, ...): a level, not a model. */
export function isTierModelSpec(spec: string): boolean {
  return isModelAlias(spec.trim().toLowerCase())
}

export function isInheritModelSpec(spec: string): boolean {
  return spec.trim().toLowerCase() === 'inherit'
}

/** A model id that can be sent as is: not blank, not a tier, not `inherit`. */
export function isConcreteModelSpec(spec: string | undefined): spec is string {
  if (spec === undefined || spec.trim() === '') return false
  return !isTierModelSpec(spec) && !isInheritModelSpec(spec)
}

export function getSubagentModelMode(
  setting: SubagentModelSetting,
): SubagentModelMode {
  const mode =
    typeof setting?.mode === 'string' ? setting.mode.trim().toLowerCase() : ''
  return mode === 'custom' || mode === 'inherit' ? mode : 'auto'
}

/** The custom model saved for `provider`, when it is one that can be sent. */
export function getCustomSubagentModel(
  setting: SubagentModelSetting,
  provider: APIProvider,
): string | undefined {
  const models = setting?.models
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return undefined
  }
  if (!Object.prototype.hasOwnProperty.call(models, provider)) return undefined
  const model = models[provider]
  return typeof model === 'string' && isConcreteModelSpec(model)
    ? model.trim()
    : undefined
}

/** Providers with a usable custom model, for /config. */
export function getCustomSubagentModelProviders(
  setting: SubagentModelSetting,
): APIProvider[] {
  return API_PROVIDERS.filter(
    provider => getCustomSubagentModel(setting, provider) !== undefined,
  )
}

/**
 * Whether the setting decides this agent's model. An agent file that names
 * a model (`inherit` included) keeps it; a provider-pinned agent is handled
 * before this is asked.
 */
export function isSubagentSettingScoped(
  agentModel: string | undefined,
  scope: AgentModelScope | undefined,
): boolean {
  if (scope?.agentType === FORK_AGENT_TYPE) return false
  return scope?.builtIn === true || agentModel === undefined || agentModel.trim() === ''
}

/** CLAUDE_CODE_SUBAGENT_MODEL predates the setting; while set it keeps the old rules. */
export function getSubagentModelEnvOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env.CLAUDE_CODE_SUBAGENT_MODEL?.trim()
  return value ? value : undefined
}

/** The value /config shows for the setting. */
export function describeSubagentModelSetting(
  setting: SubagentModelSetting,
  provider: APIProvider,
  providerName: string,
  envOverride: string | undefined = getSubagentModelEnvOverride(),
): string {
  if (envOverride !== undefined) return `CLAUDE_CODE_SUBAGENT_MODEL (${envOverride})`
  switch (getSubagentModelMode(setting)) {
    case 'inherit':
      return 'Same as main model'
    case 'custom': {
      const model = getCustomSubagentModel(setting, provider)
      return model ? `Custom: ${model}` : `Custom: none for ${providerName}, using Auto`
    }
    case 'auto':
      return 'Auto'
  }
}
