/**
 * OpenAI-Compatible Lane — Entry Point
 *
 * Handles: DeepSeek, GLM, Groq, NIM, Ollama, OpenRouter, and any other
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
  groq?: { apiKey: string; baseUrl?: string }
  mistral?: { apiKey: string; baseUrl?: string }
  nim?: { apiKey: string; baseUrl?: string }
  ollama?: { apiKey?: string; baseUrl?: string }
  openrouter?: { apiKey: string; baseUrl?: string }
  agentrouter?: { apiKey: string; baseUrl?: string }
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

  // Groq is intentionally gated off — the free / on-demand TPM cap
  // (6k–12k per model) is too tight for claudex's tool suite to be
  // useful. Flip GROQ_ENABLED to true to bring it back; the transformer,
  // routing, and tool-filter logic (src/lanes/openai-compat/transformers/groq.ts)
  // are all still wired and ready.
  const GROQ_ENABLED = false
  const groqKey = p.groq?.apiKey ?? process.env.GROQ_API_KEY
  if (GROQ_ENABLED && groqKey) {
    openaiCompatLane.registerProvider(
      'groq', groqKey,
      p.groq?.baseUrl ?? 'https://api.groq.com/openai/v1',
    )
  }

  const mistralKey = p.mistral?.apiKey ?? process.env.MISTRAL_API_KEY
  if (mistralKey) {
    openaiCompatLane.registerProvider(
      'mistral', mistralKey,
      p.mistral?.baseUrl ?? 'https://api.mistral.ai/v1',
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
