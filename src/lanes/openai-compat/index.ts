/**
 * OpenAI-Compatible Lane — Entry Point
 *
 * Handles: DeepSeek, GLM, Moonshot, Groq, Mistral, NIM, Ollama, LM Studio, OpenRouter, and any other
 * provider that speaks OpenAI Chat Completions format.
 *
 * Each provider is registered with its own API key and base URL.
 * The lane auto-detects which provider config to use based on model name.
 */

export { openaiCompatLane, OpenAICompatLane } from './loop.js'
export { OPENAI_COMPAT_TOOL_REGISTRY, buildOpenAICompatFunctions } from './tools.js'
export { assembleOpenAICompatPrompt } from './prompt.js'

import { openaiCompatLane } from './loop.js'
import { registerLane } from '../dispatcher.js'

/**
 * Initialize the OpenAI-compat lane with all provider configs.
 * Call this once at startup with whatever API keys are available.
 */
export function initOpenAICompatLane(providers?: {
  deepseek?: { apiKey: string; baseUrl?: string }
  glm?: { apiKey: string; baseUrl?: string }
  moonshot?: { apiKey: string; baseUrl?: string }
  minimax?: { apiKey: string; baseUrl?: string }
  groq?: { apiKey: string; baseUrl?: string }
  mistral?: { apiKey: string; baseUrl?: string }
  nim?: { apiKey: string; baseUrl?: string }
  ollama?: { apiKey?: string; baseUrl?: string }
  lmstudio?: { apiKey?: string; baseUrl?: string }
  openrouter?: { apiKey: string; baseUrl?: string }
  agentrouter?: { apiKey: string; baseUrl?: string }
  modelrouter?: { apiKey: string; baseUrl?: string }
  vercel?: { apiKey: string; baseUrl?: string }
  requesty?: { apiKey: string; baseUrl?: string }
  opencode?: { apiKey: string; baseUrl?: string }
  cline?: { apiKey: string; baseUrl?: string }
  iflow?: { apiKey: string; baseUrl?: string }
  kilocode?: { apiKey: string; baseUrl?: string }
  copilot?: { apiKey: string; baseUrl?: string }
}): void {
  const p = providers ?? {}

  const dsKey = p.deepseek?.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (dsKey) {
    openaiCompatLane.registerProvider(
      'deepseek', dsKey,
      p.deepseek?.baseUrl ?? 'https://api.deepseek.com/v1',
    )
  }

  const glmKey = p.glm?.apiKey
    ?? process.env.GLM_API_KEY
    ?? process.env.BIGMODEL_API_KEY
    ?? process.env.ZHIPU_API_KEY
    ?? process.env.ZAI_API_KEY
    ?? process.env.Z_AI_API_KEY
  if (glmKey) {
    openaiCompatLane.registerProvider(
      'glm',
      glmKey,
      p.glm?.baseUrl
        ?? process.env.GLM_BASE_URL
        ?? process.env.GLM_API_URL
        ?? process.env.BIGMODEL_BASE_URL
        ?? process.env.ZHIPU_BASE_URL
        ?? process.env.ZAI_BASE_URL
        ?? process.env.Z_AI_BASE_URL
        ?? 'https://open.bigmodel.cn/api/paas/v4',
    )
  }

  const moonshotKey = p.moonshot?.apiKey ?? process.env.MOONSHOT_API_KEY ?? process.env.MOONSHOTAI_API_KEY
  if (moonshotKey) {
    openaiCompatLane.registerProvider(
      'moonshot',
      moonshotKey,
      p.moonshot?.baseUrl
        ?? process.env.MOONSHOT_BASE_URL
        ?? process.env.MOONSHOT_API_BASE_URL
        ?? 'https://api.moonshot.ai/v1',
    )
  }

  const minimaxKey = p.minimax?.apiKey ?? process.env.MINIMAX_API_KEY
  if (minimaxKey) {
    openaiCompatLane.registerProvider(
      'minimax',
      minimaxKey,
      p.minimax?.baseUrl
        ?? process.env.MINIMAX_BASE_URL
        ?? process.env.MINIMAX_API_BASE_URL
        ?? 'https://api.minimax.io/v1',
    )
  }

  const groqKey = p.groq?.apiKey ?? process.env.GROQ_API_KEY
  if (groqKey) {
    openaiCompatLane.registerProvider(
      'groq', groqKey,
      p.groq?.baseUrl ?? 'https://api.groq.com/openai/v1',
    )
  }

  const mistralKey = p.mistral?.apiKey ?? process.env.MISTRAL_API_KEY
  if (mistralKey) {
    openaiCompatLane.registerProvider(
      'mistral', mistralKey,
      p.mistral?.baseUrl
        ?? process.env.MISTRAL_BASE_URL
        ?? process.env.MISTRAL_API_BASE_URL
        ?? 'https://api.mistral.ai/v1',
    )
  }

  const nimKey = p.nim?.apiKey ?? process.env.NIM_API_KEY
  if (nimKey) {
    openaiCompatLane.registerProvider(
      'nim', nimKey,
      p.nim?.baseUrl ?? 'https://integrate.api.nvidia.com/v1',
    )
  }

  const ollamaUrl = p.ollama?.baseUrl ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434/v1'
  const ollamaKey = normalizeOllamaApiKey(p.ollama?.apiKey ?? process.env.OLLAMA_API_KEY)
  openaiCompatLane.registerProvider('ollama', ollamaKey, ollamaUrl)

  const lmStudioUrl = normalizeLmStudioBaseUrl(
    p.lmstudio?.baseUrl
      ?? process.env.LMSTUDIO_BASE_URL
      ?? process.env.LM_STUDIO_BASE_URL
      ?? 'http://localhost:1234/v1',
  )
  const lmStudioKey = normalizeLmStudioApiKey(
    p.lmstudio?.apiKey ?? process.env.LMSTUDIO_API_KEY,
  )
  openaiCompatLane.registerProvider('lmstudio', lmStudioKey, lmStudioUrl)

  const orKey = p.openrouter?.apiKey ?? process.env.OPENROUTER_API_KEY
  if (orKey) {
    openaiCompatLane.registerProvider(
      'openrouter', orKey,
      p.openrouter?.baseUrl ?? 'https://openrouter.ai/api/v1',
    )
  }

  const agentRouterKey = p.agentrouter?.apiKey ?? process.env.AGENT_ROUTER_TOKEN ?? process.env.AGENTROUTER_API_KEY
  if (agentRouterKey) {
    openaiCompatLane.registerProvider(
      'agentrouter', agentRouterKey,
      p.agentrouter?.baseUrl ?? 'https://agentrouter.org/v1',
    )
  }

  const modelRouterKey = p.modelrouter?.apiKey
    ?? process.env.MODEL_ROUTER_API_KEY
    ?? process.env.MODELROUTER_API_KEY
    ?? process.env.LXG2IT_API_KEY
  if (modelRouterKey) {
    openaiCompatLane.registerProvider(
      'modelrouter', modelRouterKey,
      p.modelrouter?.baseUrl
        ?? process.env.MODELROUTER_BASE_URL
        ?? process.env.MODEL_ROUTER_BASE_URL
        ?? process.env.LXG2IT_BASE_URL
        ?? 'https://api.lxg2it.com/v1',
    )
  }

  const vercelKey = p.vercel?.apiKey
    ?? process.env.AI_GATEWAY_API_KEY
    ?? process.env.VERCEL_AI_GATEWAY_API_KEY
    ?? process.env.VERCEL_OIDC_TOKEN
  if (vercelKey) {
    openaiCompatLane.registerProvider(
      'vercel', vercelKey,
      p.vercel?.baseUrl
        ?? process.env.VERCEL_AI_GATEWAY_BASE_URL
        ?? process.env.AI_GATEWAY_BASE_URL
        ?? 'https://ai-gateway.vercel.sh/v1',
    )
  }

  const requestyKey = p.requesty?.apiKey ?? process.env.REQUESTY_API_KEY
  if (requestyKey) {
    openaiCompatLane.registerProvider(
      'requesty', requestyKey,
      p.requesty?.baseUrl
        ?? process.env.REQUESTY_BASE_URL
        ?? 'https://router.requesty.ai/v1',
    )
  }

  const opencodeKey = p.opencode?.apiKey
    ?? process.env.OPENCODE_API_KEY
    ?? process.env.OPENCODE_ZEN_API_KEY
  if (opencodeKey) {
    openaiCompatLane.registerProvider(
      'opencode', opencodeKey,
      p.opencode?.baseUrl
        ?? process.env.OPENCODE_BASE_URL
        ?? process.env.OPENCODE_ZEN_BASE_URL
        ?? 'https://opencode.ai/zen/v1',
    )
  }

  // Phase 4 OAuth-backed compat providers. Caller (providerShim) passes
  // the OAuth access token as `apiKey`; the transformer turns that into
  // the right header shape (Bearer + provider-specific extras).
  if (p.cline?.apiKey) {
    openaiCompatLane.registerProvider(
      'cline', p.cline.apiKey,
      p.cline.baseUrl ?? 'https://api.cline.bot/v1',
    )
  }
  if (p.iflow?.apiKey) {
    openaiCompatLane.registerProvider(
      'iflow', p.iflow.apiKey,
      p.iflow.baseUrl ?? 'https://apis.iflow.cn/v1',
    )
  }
  if (p.kilocode?.apiKey) {
    openaiCompatLane.registerProvider(
      'kilocode', p.kilocode.apiKey,
      p.kilocode.baseUrl ?? 'https://kilocode.ai/api/openrouter/v1',
    )
  }
  // Copilot's bearer is the *internal* token (Copilot exchanges the GH
  // OAuth user token for it, ~30 min TTL). providerShim re-exchanges via
  // refreshCopilotOAuth before init when the cached one is stale.
  if (p.copilot?.apiKey) {
    openaiCompatLane.registerProvider(
      'copilot', p.copilot.apiKey,
      // Note: no `/v1` suffix — Copilot serves /chat/completions and
      // /models off the bare api.githubcopilot.com host.
      p.copilot.baseUrl ?? 'https://api.githubcopilot.com',
    )
  }

  // Qwen moved to its own lane (`src/lanes/qwen/`) — see Phase 2 of
  // the native-lane plan. Do NOT register qwen here: it would shadow the
  // dedicated lane's native OAuth + Qwen-specific tool registry.

  registerLane(openaiCompatLane)
}

function normalizeOllamaApiKey(apiKey: string | undefined): string {
  const key = apiKey?.trim()
  return key && key !== 'ollama' ? key : ''
}

function normalizeLmStudioApiKey(apiKey: string | undefined): string {
  const key = apiKey?.trim()
  return key || 'lm-studio'
}

function normalizeLmStudioBaseUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  const trimmed = withScheme.replace(/\/+$/, '')
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}
