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
 *   - global: `global`, one provider and model for every main provider
 *
 * A custom or global pick may carry an effort. It applies to the sub-agent
 * alone, as an agent file's `effort:` does, never to the main session.
 *
 * Explicit choices stay outside it: CLAUDE_CODE_SUBAGENT_MODEL, an agent
 * file's own model or provider, a concrete model the Agent call names,
 * /team-mode and the Agent call's `provider`. getAgentModel() and runAgent
 * apply it.
 *
 * Dependency-free so its rules can be tested without the config graph.
 */

import { parseEffortValue, type EffortValue } from '../effortValue.js'
import { isModelAlias } from './aliases.js'
import { API_PROVIDERS, type APIProvider } from './providerRegistry.js'

export const SUBAGENT_MODEL_MODES = ['auto', 'custom', 'inherit', 'global'] as const
export type SubagentModelMode = (typeof SUBAGENT_MODEL_MODES)[number]

/** As settings.json holds it: hand-edited, so read only through the functions below. */
export type SubagentModelSetting =
  | {
      mode?: string
      /** Per provider: a model id, or `{ model, effort }`. */
      models?: Record<string, unknown>
      /** `{ provider, model, effort }`. */
      global?: unknown
    }
  | undefined

/** A model on a provider, with an effort for the sub-agent alone. */
export type SubagentModelTarget = {
  provider: APIProvider
  model: string
  effort?: EffortValue
}

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

export function isAPIProviderName(value: unknown): value is APIProvider {
  return typeof value === 'string' && (API_PROVIDERS as readonly string[]).includes(value)
}

export function getSubagentModelMode(
  setting: SubagentModelSetting,
): SubagentModelMode {
  const mode =
    typeof setting?.mode === 'string' ? setting.mode.trim().toLowerCase() : ''
  return mode === 'custom' || mode === 'inherit' || mode === 'global'
    ? mode
    : 'auto'
}

/** A model id, or `{ model, effort }`; an effort that is not one is dropped. */
function readTarget(
  provider: APIProvider,
  value: unknown,
): SubagentModelTarget | undefined {
  if (typeof value === 'string') {
    return isConcreteModelSpec(value) ? { provider, model: value.trim() } : undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { model, effort } = value as Record<string, unknown>
  if (typeof model !== 'string' || !isConcreteModelSpec(model)) return undefined
  const parsed = parseEffortValue(effort)
  return {
    provider,
    model: model.trim(),
    ...(parsed !== undefined && { effort: parsed }),
  }
}

/** The custom pick saved for `provider`, when its model is one that can be sent. */
export function getCustomSubagentTarget(
  setting: SubagentModelSetting,
  provider: APIProvider,
): SubagentModelTarget | undefined {
  const models = setting?.models
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return undefined
  }
  if (!Object.prototype.hasOwnProperty.call(models, provider)) return undefined
  return readTarget(provider, models[provider])
}

/** The custom model saved for `provider`, when it is one that can be sent. */
export function getCustomSubagentModel(
  setting: SubagentModelSetting,
  provider: APIProvider,
): string | undefined {
  return getCustomSubagentTarget(setting, provider)?.model
}

/** Providers with a usable custom model, for /config. */
export function getCustomSubagentModelProviders(
  setting: SubagentModelSetting,
): APIProvider[] {
  return API_PROVIDERS.filter(
    provider => getCustomSubagentModel(setting, provider) !== undefined,
  )
}

/** The global pick, when it names a known provider and a model that can be sent. */
export function getGlobalSubagentTarget(
  setting: SubagentModelSetting,
): SubagentModelTarget | undefined {
  const value = setting?.global
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const provider = (value as Record<string, unknown>).provider
  const name = typeof provider === 'string' ? provider.trim() : provider
  return isAPIProviderName(name) ? readTarget(name, value) : undefined
}

/** How a pick is saved: just the id, unless it carries an effort. */
export function toSubagentModelEntry(
  target: Pick<SubagentModelTarget, 'model' | 'effort'>,
): string | { model: string; effort: EffortValue } {
  return target.effort === undefined
    ? target.model
    : { model: target.model, effort: target.effort }
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

function describeEffort(target: SubagentModelTarget): string {
  return target.effort === undefined ? '' : ` · ${target.effort}`
}

/** The value /config shows for the setting. */
export function describeSubagentModelSetting(
  setting: SubagentModelSetting,
  provider: APIProvider,
  nameOf: (provider: APIProvider) => string,
  envOverride: string | undefined = getSubagentModelEnvOverride(),
): string {
  if (envOverride !== undefined) return `CLAUDE_CODE_SUBAGENT_MODEL (${envOverride})`
  switch (getSubagentModelMode(setting)) {
    case 'inherit':
      return 'Same as main model'
    case 'custom': {
      const target = getCustomSubagentTarget(setting, provider)
      return target
        ? `Custom: ${target.model}${describeEffort(target)}`
        : `Custom: none for ${nameOf(provider)}, using Auto`
    }
    case 'global': {
      const target = getGlobalSubagentTarget(setting)
      return target
        ? `Global: ${nameOf(target.provider)} / ${target.model}${describeEffort(target)}`
        : 'Global: none set, using Auto'
    }
    case 'auto':
      return 'Auto'
  }
}
