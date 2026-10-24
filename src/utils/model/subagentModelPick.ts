/**
 * Turns a model browser selection into a Sub-agent model pick: the model id
 * the provider serves, and an effort for sub-agents alone.
 *
 * /models applies effort to the session, or saves a provider's native effort
 * for that model everywhere. A sub-agent pick can do neither: its effort is
 * the agent's own request-scoped effort, the way an agent file's `effort:`
 * is. That reaches every provider that reads effort from the request
 * (Anthropic, OpenAI), and native-effort providers when the level is a
 * standard one they accept and the model has no effort of its own set in
 * /models, which every request on that model uses. A level that cannot reach
 * the agent is refused with the reason instead of being saved and ignored.
 */

import { parseEffortValue } from '../effortValue.js'
import { getProviderEffort } from './providerEffort.js'
import { resolveProviderModelSelection } from './providerCatalog.js'
import type { APIProvider } from './providers.js'
import type { SubagentModelTarget } from './subagentModel.js'

export type SubagentModelPick =
  | { ok: true; target: SubagentModelTarget }
  | { ok: false; message: string }

export function resolveSubagentModelPick(
  provider: APIProvider,
  selectedModelId: string,
  openaiEffort?: string,
  providerEffort?: string,
): SubagentModelPick {
  // Anthropic lists one row per effort and Cline Pass one per thinking level,
  // both encoded in the id: never an id to send.
  const selection = resolveProviderModelSelection(provider, selectedModelId)
  const model = selection.modelId
  const pick = (effort?: string): SubagentModelPick => {
    const parsed = parseEffortValue(effort)
    return {
      ok: true,
      target: { provider, model, ...(parsed !== undefined && { effort: parsed }) },
    }
  }
  if (selection.effort !== undefined) return pick(selection.effort)
  if (provider === 'openai') return pick(openaiEffort)

  const level = selection.clineEffort ?? providerEffort
  if (level === undefined || level === 'auto' || level === 'default') return pick()
  // The level the model runs on already (what the row opens on) needs no
  // effort of the agent's own.
  const own = getProviderEffort(provider, model)
  if (level === own?.value) return pick()
  if (parseEffortValue(level) === undefined) {
    return {
      ok: false,
      message: `"${level}" can only be set for ${model} everywhere, in /models. For sub-agents pick a level such as low, medium or high, or leave it on auto.`,
    }
  }
  if (own?.explicit && own.value !== undefined && own.value !== level) {
    return {
      ok: false,
      message: `${model} has its own effort set in /models (${own.label}), which every request on it uses. Pick ${own.value} here, or clear it with /effort auto first.`,
    }
  }
  return pick(level)
}
