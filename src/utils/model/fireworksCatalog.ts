/**
 * The Fireworks models Tau's picker lists, and what Fireworks' own model pages
 * state for the rows models.dev does not describe.
 *
 * Fireworks' /v1/models answers with the account's whole registry (hundreds
 * of rows), so the picker keeps this curated list instead. Prices, context
 * windows, image input and thinking options come from models.dev's
 * `fireworks-ai` rows for every serverless model here. Three rows have none
 * there, so their window and image input are taken from their model pages:
 *
 *   auto                Nexus Auto, formerly FireRouter (`firerouter/opus`,
 *                       removed on October 20, 2026). It picks a model for each
 *                       turn and names it in the response, and the turn bills at
 *                       that model's rate (modelCost.ts, pricedModel).
 *   mimo-v2p6-pro-rl    on-demand deployments only: billed by GPU time, not
 *   qwen3p8-flash-next  per token, so they stay unpriced.
 */

export const FIREWORKS_MODEL_PREFIX = 'accounts/fireworks/models/'

/** Nexus Auto's model id. */
export const FIREWORKS_AUTO_MODEL = 'auto'

export interface FireworksModelEntry {
  /** The id without FIREWORKS_MODEL_PREFIX; `auto` is sent as it is. */
  id: string
  name: string
  /** Picker chips: tools, fast, recommended. */
  tags: readonly string[]
  /** False only where the model page says function calling is not supported. */
  toolCalling?: boolean
  /** Window from the model page, for rows models.dev does not describe. */
  contextWindow?: number
  /** Image input from the model page, for rows models.dev does not describe. */
  imageInput?: boolean
}

// Fireworks' `p`-for-decimal ids: glm-5p3 is GLM 5.3. Ordered as Fireworks'
// model library lists them.
export const FIREWORKS_MODELS: readonly FireworksModelEntry[] = [
  { id: FIREWORKS_AUTO_MODEL, name: 'Nexus Auto (FireRouter)', tags: ['tools'], contextWindow: 1_000_000, imageInput: true },
  { id: 'minimax-m3p1-flash', name: 'MiniMax M3.1 Flash', tags: ['tools', 'fast'] },
  { id: 'deepseek-v4p1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', tags: ['tools', 'fast'] },
  { id: 'ember-1', name: 'Ember-1', tags: ['tools'] },
  { id: 'deepseek-v4p1-flash', name: 'DeepSeek V4.1 Flash', tags: ['tools', 'fast'] },
  { id: 'glm-5p3', name: 'GLM 5.3', tags: ['tools'] },
  { id: 'glm-5p3-flash', name: 'GLM 5.3 Flash', tags: ['tools', 'fast'] },
  { id: 'mimo-v2p6-pro-rl', name: 'MiMo V2.6 Pro RL', tags: [], toolCalling: false, contextWindow: 1_000_000, imageInput: true },
  { id: 'qwen3p8-flash-next-nvfp4', name: 'Qwen3.8 Flash Next FP4', tags: ['tools'], contextWindow: 262_144, imageInput: true },
  { id: 'nemotron-lightning-3p5-30b-a3b', name: 'Nemotron 3.5 Lightning 30B A3B', tags: ['tools', 'fast'] },
  { id: 'qwen3p8-max', name: 'Qwen 3.8 Max', tags: ['tools'] },
  { id: 'kimi-k3', name: 'Kimi K3', tags: ['tools', 'recommended'] },
]

/** The id Fireworks takes: a bare model name gains the account prefix. */
export function qualifyFireworksId(id: string): string {
  const trimmed = id.trim()
  if (!trimmed || trimmed === FIREWORKS_AUTO_MODEL || trimmed.includes('/')) return trimmed
  return `${FIREWORKS_MODEL_PREFIX}${trimmed}`
}

/** The listed row for a model id, qualified or bare. */
export function getFireworksModelMeta(model: string): FireworksModelEntry | undefined {
  const id = model.trim().toLowerCase()
  const bare = id.startsWith(FIREWORKS_MODEL_PREFIX) ? id.slice(FIREWORKS_MODEL_PREFIX.length) : id
  return FIREWORKS_MODELS.find(entry => entry.id === bare)
}
