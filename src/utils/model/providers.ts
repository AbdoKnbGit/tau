import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'

export type APIProvider =
  | 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
  | 'openai' | 'gemini' | 'antigravity'
  | 'openrouter' | 'agentrouter' | 'modelrouter' | 'vercel' | 'requesty' | 'opencode' | 'groq' | 'mistral' | 'nim' | 'deepseek' | 'glm' | 'moonshot' | 'minimax' | 'ollama' | 'lmstudio'
  | 'cline' | 'copilot' | 'cursor' | 'iflow' | 'kilocode' | 'kiro'

const VALID_PROVIDERS: readonly APIProvider[] = [
  'firstParty', 'bedrock', 'vertex', 'foundry',
  'openai', 'gemini', 'antigravity',
  'openrouter', 'agentrouter', 'modelrouter', 'vercel', 'requesty', 'opencode', 'groq', 'mistral', 'nim', 'deepseek', 'glm', 'moonshot', 'minimax', 'ollama', 'lmstudio',
  'cline', 'copilot', 'cursor', 'iflow', 'kilocode', 'kiro',
]

export function isAPIProvider(value: string): value is APIProvider {
  return VALID_PROVIDERS.includes(value as APIProvider)
}

// Session-local snapshot of the active provider.
//
// The previous implementation re-read activeProvider from the shared
// global-config cache on every request. That cache is kept in sync with
// ~/.claude.json by a 1-second fs.watchFile poller (see
// startGlobalConfigFreshnessWatcher in utils/config.ts), so when one
// session ran `/provider nim` the other session (running ollama) saw the
// write within a second and started mis-routing requests — producing
// cross-talk 404s like "ollama API error 404: model 'nim/xxx' not found"
// and vice-versa.
//
// Fix: each process latches the provider it resolves on first call and
// ignores later disk changes made by sibling sessions. Disk persistence
// is preserved (for next-launch default), but in-memory routing for a
// running session is frozen. `NODE_ENV=test` bypasses the cache so the
// test suite can toggle providers freely.
let _sessionActiveProvider: APIProvider | null = null

function _resolveAPIProvider(): APIProvider {
  // 1. Check persistent config first (set by /provider command)
  const configured = getGlobalConfig().activeProvider
  if (configured && VALID_PROVIDERS.includes(configured as APIProvider)) {
    return configured as APIProvider
  }
  // 2. Fall back to environment variables
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK))    return 'bedrock'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX))     return 'vertex'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY))    return 'foundry'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI))     return 'openai'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI))     return 'gemini'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENROUTER)) return 'openrouter'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_AGENTROUTER)) return 'agentrouter'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_MODELROUTER) || isEnvTruthy(process.env.CLAUDE_CODE_USE_MODEL_ROUTER) || isEnvTruthy(process.env.CLAUDE_CODE_USE_LXG2IT)) return 'modelrouter'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERCEL) || isEnvTruthy(process.env.CLAUDE_CODE_USE_VERCEL_AI_GATEWAY)) return 'vercel'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_REQUESTY))    return 'requesty'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENCODE) || isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENCODE_ZEN)) return 'opencode'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GROQ))       return 'groq'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_MISTRAL))    return 'mistral'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_NIM))        return 'nim'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_DEEPSEEK))   return 'deepseek'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GLM))        return 'glm'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_MOONSHOT))   return 'moonshot'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_MINIMAX))    return 'minimax'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OLLAMA))    return 'ollama'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_LMSTUDIO))  return 'lmstudio'
  return 'firstParty'
}

export function getAPIProvider(): APIProvider {
  if (process.env.NODE_ENV === 'test') return _resolveAPIProvider()
  if (_sessionActiveProvider !== null) return _sessionActiveProvider
  _sessionActiveProvider = _resolveAPIProvider()
  return _sessionActiveProvider
}

/**
 * Persist the active provider selection to global config AND update this
 * session's snapshot. Disk write keeps the choice across restarts;
 * snapshot update makes the change visible on the next request in this
 * session without waiting on the config-freshness watcher.
 */
export function setActiveProvider(provider: APIProvider): void {
  _sessionActiveProvider = provider
  saveGlobalConfig(current => ({
    ...current,
    activeProvider: provider,
  }))
}

/**
 * Clear the active provider from config AND from this session's snapshot.
 * Next getAPIProvider() call re-resolves from env vars.
 */
export function clearActiveProvider(): void {
  _sessionActiveProvider = null
  saveGlobalConfig(current => ({
    ...current,
    activeProvider: undefined,
  }))
}

/** User-friendly display names for providers */
export const PROVIDER_DISPLAY_NAMES: Record<APIProvider, string> = {
  firstParty: 'Anthropic',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Azure Foundry',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  antigravity: 'Antigravity',
  openrouter: 'OpenRouter',
  agentrouter: 'AgentRouter',
  modelrouter: 'Model Router',
  vercel: 'Vercel AI Gateway',
  requesty: 'Requesty',
  opencode: 'OpenCode Zen',
  groq: 'Groq',
  mistral: 'Mistral',
  nim: 'NVIDIA NIM',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  moonshot: 'Moonshot AI',
  minimax: 'MiniMax AI',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  cline: 'Cline',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  iflow: 'iFlow',
  kilocode: 'KiloCode',
  kiro: 'Kiro',
}

/** Providers available for user selection in /provider and /login */
// `iflow` is hidden from the user-facing pickers after its CLI shutdown announcement.
// `modelrouter` is also hidden from /login and /models; backend support stays
// intact for compatibility and env-driven use.
// APIProvider union, env detection, auth flow, transformer, and routing are
// all kept intact for compatibility.
export const SELECTABLE_PROVIDERS: readonly APIProvider[] = [
  'firstParty', 'openai', 'gemini', 'antigravity', 'openrouter', 'agentrouter', 'vercel', 'requesty', 'opencode', 'mistral', 'nim', 'deepseek', 'glm', 'moonshot', 'minimax', 'ollama', 'lmstudio',
  'cline', 'copilot', 'cursor', 'kilocode', 'kiro',
]

/** Providers that use OpenAI-compatible chat completions API */
export function isOpenAICompatibleProvider(p: APIProvider): boolean {
  return ['openai', 'openrouter', 'agentrouter', 'modelrouter', 'vercel', 'requesty', 'opencode', 'groq', 'mistral', 'nim', 'deepseek', 'glm', 'moonshot', 'minimax', 'ollama', 'lmstudio',
          'cline', 'copilot', 'iflow', 'kilocode'].includes(p)
}

/** All non-Anthropic third-party LLM providers */
export function isThirdPartyProvider(p: APIProvider): boolean {
  return ['openai', 'gemini', 'antigravity', 'openrouter', 'agentrouter', 'modelrouter', 'vercel', 'requesty', 'opencode', 'groq', 'mistral', 'nim', 'deepseek', 'glm', 'moonshot', 'minimax', 'ollama', 'lmstudio',
          'cline', 'copilot', 'cursor', 'iflow', 'kilocode', 'kiro'].includes(p)
}

/** Original Anthropic-native providers (firstParty + cloud partners) */
export function isAnthropicNativeProvider(p: APIProvider): boolean {
  return ['firstParty', 'bedrock', 'vertex', 'foundry'].includes(p)
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
