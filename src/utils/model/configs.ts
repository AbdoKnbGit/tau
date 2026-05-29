import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import { loadOpenCodeApiKeyFromAuthFile } from '../opencodeAuth.js'
import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

/** Anthropic-native provider keys only (used by Claude model configs) */
export type AnthropicProvider = Extract<APIProvider, 'firstParty' | 'bedrock' | 'vertex' | 'foundry'>

/** Model config mapping for Anthropic-native providers */
export type ModelConfig = Record<AnthropicProvider, ModelName>

// ─── Third-Party Provider Tier System ───────────────────────────────
//
// Each third-party provider offers models at different access tiers:
//   free  — no payment required, rate-limited
//   pro   — requires API key with billing, standard limits
//   plus  — premium tier or enterprise, highest limits
//
// The tier is determined by PROVIDER_TIER env var or auto-detected
// from the API key format / account status.
//
// Model IDs are pinned to confirmed-working identifiers as of 2025-Q4.
// Override any model via env vars (e.g. OPENAI_MODEL_OPUS).

export type ProviderTier = 'free' | 'pro' | 'plus'

const GLM_BASE_URL = process.env.GLM_BASE_URL
  ?? process.env.GLM_API_URL
  ?? process.env.BIGMODEL_BASE_URL
  ?? process.env.ZHIPU_BASE_URL
  ?? process.env.ZAI_BASE_URL
  ?? process.env.Z_AI_BASE_URL
  ?? 'https://open.bigmodel.cn/api/paas/v4'

const MOONSHOT_BASE_URL = process.env.MOONSHOT_BASE_URL
  ?? process.env.MOONSHOT_API_BASE_URL
  ?? 'https://api.moonshot.ai/v1'

const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL
  ?? process.env.MINIMAX_API_BASE_URL
  ?? 'https://api.minimax.io/v1'

const MISTRAL_BASE_URL = process.env.MISTRAL_BASE_URL
  ?? process.env.MISTRAL_API_BASE_URL
  ?? 'https://api.mistral.ai/v1'

const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_BASE_URL
  ?? process.env.LM_STUDIO_BASE_URL
  ?? 'http://localhost:1234/v1'

const MODELROUTER_BASE_URL = process.env.MODELROUTER_BASE_URL
  ?? process.env.MODEL_ROUTER_BASE_URL
  ?? process.env.LXG2IT_BASE_URL
  ?? 'https://api.lxg2it.com/v1'

const VERCEL_AI_GATEWAY_BASE_URL = process.env.VERCEL_AI_GATEWAY_BASE_URL
  ?? process.env.AI_GATEWAY_BASE_URL
  ?? 'https://ai-gateway.vercel.sh/v1'

const REQUESTY_BASE_URL = process.env.REQUESTY_BASE_URL
  ?? 'https://router.requesty.ai/v1'

const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL
  ?? process.env.OPENCODE_ZEN_BASE_URL
  ?? 'https://opencode.ai/zen/v1'

const MODELROUTER_DEFAULT_OPUS = 'claude-opus-4-7'
const MODELROUTER_DEFAULT_SONNET = 'claude-sonnet-4-6'
const MODELROUTER_DEFAULT_HAIKU = 'claude-haiku-4-5'

export interface TierModelSet {
  opus: string    // Best reasoning / most capable model
  sonnet: string  // Balanced quality/speed for everyday tasks
  haiku: string   // Fastest / cheapest for simple tasks
}

export interface ProviderModelConfig {
  /** Human-readable provider name */
  displayName: string
  /** Provider API base URL */
  baseUrl: string
  /** Auth header format: 'bearer' for Authorization: Bearer, 'x-api-key' for custom */
  authType: 'bearer' | 'x-api-key'
  /** Env var name for the API key */
  apiKeyEnv: string
  /** Models available at each tier */
  tiers: Record<ProviderTier, TierModelSet>
  /** Which tier to use when none is explicitly set — typically 'pro' for paid keys */
  defaultTier: ProviderTier
  /** Whether the provider supports streaming */
  supportsStreaming: boolean
  /** Whether the provider supports tool/function calling */
  supportsToolCalling: boolean
}

const AGENTROUTER_MODEL_IDS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-opus-4-6',
  'glm-4.5',
  'glm-4.6',
  'glm-5.1',
  'deepseek-r1-0528',
  'deepseek-v3.1',
  'deepseek-v3.2',
])

export function isAgentRouterModelId(model: string): boolean {
  const normalized = model.toLowerCase()
  if (AGENTROUTER_MODEL_IDS.has(normalized)) {
    return true
  }
  const configured = getProviderModelSet('agentrouter')
  return Object.values(configured).some(
    value => value.toLowerCase() === normalized,
  )
}

/**
 * Detects the provider tier from env var or falls back to the provider's default.
 *
 * Set PROVIDER_TIER=free|pro|plus to override auto-detection.
 * Provider-specific overrides: OPENAI_TIER, GEMINI_TIER, etc.
 *
 * For OpenRouter specifically, when no override is set, the active main-loop
 * model is sniffed for a `:free` suffix — OpenRouter's free models all carry
 * it, and a user who picked one through `/model` clearly wants subagent
 * spawns to stay in the free pool too. Without this, a free-tier user gets
 * subagents resolved against `defaultTier: 'pro'` (gpt-5.5 etc.), which
 * silently leaves the free credit pool and was the root cause of the
 * "subagents spawn with random models" report — those pro IDs are not all
 * hosted, so OpenRouter routed to whatever it could.
 */
export function getProviderTier(provider: string): ProviderTier {
  // Provider-specific override first
  const providerEnv = process.env[`${provider.toUpperCase()}_TIER`]
  if (providerEnv && isValidTier(providerEnv)) return providerEnv

  // Global override
  const globalTier = process.env.PROVIDER_TIER
  if (globalTier && isValidTier(globalTier)) return globalTier

  // Sticky free-tier inference for OpenRouter based on the user's current
  // main-loop selection. Reads three sources in priority order — the same
  // order getUserSpecifiedModelSetting() uses (session override > env >
  // settings) — so a user who picked a `:free` model via /model at runtime
  // gets free-tier subagents on the very next spawn, not just after
  // restarting with ANTHROPIC_MODEL set.
  //
  // bootstrap/state is safe to import here — it only type-imports model.ts,
  // so no runtime cycle. Settings is read lazily via dynamic require to
  // avoid pulling in the settings module at module-load time (it pulls in
  // file I/O and would slow cold start of every consumer of configs.ts).
  if (provider === 'openrouter') {
    if (looksLikeFreeOpenRouterId(getMainLoopModelOverride())) return 'free'
    if (looksLikeFreeOpenRouterId(process.env.ANTHROPIC_MODEL)) return 'free'
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const settingsMod = require('../settings/settings.js') as { getSettings_DEPRECATED?: () => { model?: unknown } | undefined }
      const settings = settingsMod.getSettings_DEPRECATED?.()
      if (looksLikeFreeOpenRouterId(settings?.model)) return 'free'
    } catch {
      // Settings unavailable (cold-start path) — fall through to default tier.
    }
  }

  if (provider === 'opencode' && !hasOpencodeAccountKey()) {
    return 'free'
  }

  // Auto-detect from provider config default
  return PROVIDER_CONFIGS[provider]?.defaultTier ?? 'pro'
}

function isValidTier(t: string): t is ProviderTier {
  return ['free', 'pro', 'plus'].includes(t)
}

function looksLikeFreeOpenRouterId(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().endsWith(':free')
}

function hasOpencodeAccountKey(): boolean {
  if (process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY) {
    return true
  }
  if (loadOpenCodeApiKeyFromAuthFile()) return true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const keyManager = require('../../services/api/auth/api_key_manager.js') as {
      loadProviderKey?: (provider: string) => string | null
    }
    return !!keyManager.loadProviderKey?.('opencode')
  } catch {
    return false
  }
}

// ─── Provider Configurations (Updated April 2026) ──────────────────
//
// Model selection rationale per provider (latest confirmed model IDs):
//
// OpenAI (April 2026):
//   free  → gpt-5.4-mini (cheapest 5.x, tool calling, 128k context)
//   pro   → gpt-5.5 (frontier coding/research model from Codex catalog)
//   plus  → gpt-5.5 (frontier coding/research model from Codex catalog)
//   Haiku → gpt-5.4-nano (smallest/fastest/cheapest)
//
// Gemini (April 2026):
//   free  → gemini-3-flash-preview (free in AI Studio, fast, tools)
//   pro   → gemini-3.1-pro-preview (latest, 1M context, reasoning-first)
//   plus  → gemini-3.1-pro-preview (same — best available)
//   Haiku → gemini-3.1-flash-lite-preview (cost-efficient, high-volume)
//
// OpenRouter (April 2026):
//   free  → tencent/hy3-preview:free / inclusionai/ling-2.6-1t:free
//   pro   → anthropic/claude-opus-4.7 / openai/gpt-5.5
//   plus  → anthropic/claude-opus-4.7 (best stable Opus on OR)
//
// Groq (April 2026 — all models free with rate limits):
//   free  → deepseek-r1-distill-llama-70b (best reasoning, free)
//   pro   → qwen/qwen3-32b (strong coding, replaced qwq)
//   plus  → openai/gpt-oss-120b (flagship open model on Groq)
//   Haiku → llama-3.3-70b-versatile (proven fast workhorse)
//
// NVIDIA NIM (April 2026):
//   free  → nvidia/nemotron-3-super-120b-a12b (NVIDIA-hosted default)
//   pro   → nvidia/llama-3.1-nemotron-ultra-253b-v1
//   plus  → nvidia/llama-3.1-nemotron-ultra-253b-v1
//   Haiku → nvidia/nemotron-3-nano-30b-a3b

export const PROVIDER_CONFIGS: Record<string, ProviderModelConfig> = {
  openai: {
    displayName: 'OpenAI',
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    authType: 'bearer',
    apiKeyEnv: 'OPENAI_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'gpt-5.4-mini',
        sonnet: 'gpt-5.4-mini',
        haiku:  'gpt-5.4-mini',
      },
      pro: {
        opus:   process.env.OPENAI_MODEL_OPUS   ?? 'gpt-5.5',
        sonnet: process.env.OPENAI_MODEL_SONNET ?? 'gpt-5.5',
        haiku:  process.env.OPENAI_MODEL_HAIKU  ?? 'gpt-5.4-mini',
      },
      plus: {
        opus:   process.env.OPENAI_MODEL_OPUS   ?? 'gpt-5.5',
        sonnet: process.env.OPENAI_MODEL_SONNET ?? 'gpt-5.5',
        haiku:  process.env.OPENAI_MODEL_HAIKU  ?? 'gpt-5.4-mini',
      },
    },
  },

  copilot: {
    displayName: 'GitHub Copilot',
    baseUrl: 'https://api.githubcopilot.com',
    authType: 'bearer',
    apiKeyEnv: 'COPILOT_OAUTH_TOKEN',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus: 'gpt-5-mini',
        sonnet: 'gpt-5-mini',
        haiku: 'gpt-5-mini',
      },
      pro: {
        opus: process.env.COPILOT_MODEL_OPUS ?? 'claude-opus-4.7',
        sonnet: process.env.COPILOT_MODEL_SONNET ?? 'gpt-5-mini',
        haiku: process.env.COPILOT_MODEL_HAIKU ?? 'gpt-5-mini',
      },
      plus: {
        opus: process.env.COPILOT_MODEL_OPUS ?? 'claude-opus-4.7',
        sonnet: process.env.COPILOT_MODEL_SONNET ?? 'gpt-5.4',
        haiku: process.env.COPILOT_MODEL_HAIKU ?? 'gpt-5-mini',
      },
    },
  },

  gemini: {
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authType: 'x-api-key',
    apiKeyEnv: 'GEMINI_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'gemini-3-flash-preview',
        sonnet: 'gemini-3-flash-preview',
        haiku:  'gemini-3.1-flash-lite-preview',
      },
      pro: {
        opus:   process.env.GEMINI_MODEL_OPUS   ?? 'gemini-3.1-pro-preview',
        sonnet: process.env.GEMINI_MODEL_SONNET ?? 'gemini-2.5-pro',
        haiku:  process.env.GEMINI_MODEL_HAIKU  ?? 'gemini-3.1-flash-lite-preview',
      },
      plus: {
        opus:   process.env.GEMINI_MODEL_OPUS   ?? 'gemini-3.1-pro-preview',
        sonnet: process.env.GEMINI_MODEL_SONNET ?? 'gemini-3.1-pro-preview',
        haiku:  process.env.GEMINI_MODEL_HAIKU  ?? 'gemini-2.5-flash-lite',
      },
    },
  },

  openrouter: {
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authType: 'bearer',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        // All three tiers point at confirmed-existing free OpenRouter
        // model IDs (verified against /v1/models pricing.prompt == 0).
        // Subagents pinned to `haiku` (Explore, claudeCodeGuide) used to
        // resolve to `inclusionai/ling-2.6-flash:free`, which OpenRouter
        // doesn't host — the gateway then routed to whatever variant was
        // available, which is the "random model spawn" the user sees.
        // Mapping every tier to a real free model with a consistent ID
        // makes spawn behavior deterministic.
        //
        // Capability ranking (highest → lowest), all 256K+ context:
        //   ling-2.6-1t      — trillion-param flagship; best for opus/sonnet
        //   nemotron-nano    — 30B / 3B-active reasoning model; small + fast
        //   poolside-laguna  — efficient coding-focused agent
        //
        // Override per-tier via OR_MODEL_OPUS / OR_MODEL_SONNET /
        // OR_MODEL_HAIKU.
        opus:   process.env.OR_MODEL_OPUS_FREE   ?? 'inclusionai/ling-2.6-1t:free',
        sonnet: process.env.OR_MODEL_SONNET_FREE ?? 'inclusionai/ling-2.6-1t:free',
        haiku:  process.env.OR_MODEL_HAIKU_FREE  ?? 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      },
      pro: {
        opus:   process.env.OR_MODEL_OPUS   ?? 'anthropic/claude-opus-4.7',
        sonnet: process.env.OR_MODEL_SONNET ?? 'openai/gpt-5.5',
        haiku:  process.env.OR_MODEL_HAIKU  ?? 'openai/gpt-5.4-mini',
      },
      plus: {
        opus:   process.env.OR_MODEL_OPUS   ?? 'anthropic/claude-opus-4.7',
        sonnet: process.env.OR_MODEL_SONNET ?? 'anthropic/claude-sonnet-4-6',
        haiku:  process.env.OR_MODEL_HAIKU  ?? 'google/gemini-3.1-flash-lite-preview',
      },
    },
  },

  // AgentRouter — independent OpenRouter-style gateway. Curated catalog
  // of 8 models (claude-haiku-4-5-20251001, claude-opus-4-6, glm-4.5/4.6/5.1,
  // deepseek-r1-0528 / -v3.1 / -v3.2). The default pro sonnet/haiku slots use
  // Claude Haiku because it is the cheapest Claude Code-compatible target and
  // preserves Anthropic prompt-cache usage through AgentRouter.
  agentrouter: {
    displayName: 'AgentRouter',
    baseUrl: 'https://agentrouter.org/v1',
    authType: 'bearer',
    apiKeyEnv: 'AGENT_ROUTER_TOKEN',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   process.env.AR_MODEL_OPUS   ?? 'glm-4.6',
        sonnet: process.env.AR_MODEL_SONNET ?? 'glm-4.6',
        haiku:  process.env.AR_MODEL_HAIKU  ?? 'glm-4.5',
      },
      pro: {
        opus:   process.env.AR_MODEL_OPUS   ?? 'claude-opus-4-6',
        sonnet: process.env.AR_MODEL_SONNET ?? 'claude-haiku-4-5-20251001',
        haiku:  process.env.AR_MODEL_HAIKU  ?? 'claude-haiku-4-5-20251001',
      },
      plus: {
        opus:   process.env.AR_MODEL_OPUS   ?? 'claude-opus-4-6',
        sonnet: process.env.AR_MODEL_SONNET ?? 'claude-opus-4-6',
        haiku:  process.env.AR_MODEL_HAIKU  ?? 'claude-haiku-4-5-20251001',
      },
    },
  },

  modelrouter: {
    displayName: 'Model Router',
    baseUrl: MODELROUTER_BASE_URL,
    authType: 'bearer',
    apiKeyEnv: 'MODEL_ROUTER_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   process.env.MODELROUTER_MODEL_OPUS_FREE   ?? process.env.LXG2IT_MODEL_OPUS_FREE   ?? MODELROUTER_DEFAULT_OPUS,
        sonnet: process.env.MODELROUTER_MODEL_SONNET_FREE ?? process.env.LXG2IT_MODEL_SONNET_FREE ?? MODELROUTER_DEFAULT_SONNET,
        haiku:  process.env.MODELROUTER_MODEL_HAIKU_FREE  ?? process.env.LXG2IT_MODEL_HAIKU_FREE  ?? MODELROUTER_DEFAULT_HAIKU,
      },
      pro: {
        opus:   process.env.MODELROUTER_MODEL_OPUS   ?? process.env.LXG2IT_MODEL_OPUS   ?? MODELROUTER_DEFAULT_OPUS,
        sonnet: process.env.MODELROUTER_MODEL_SONNET ?? process.env.LXG2IT_MODEL_SONNET ?? MODELROUTER_DEFAULT_SONNET,
        haiku:  process.env.MODELROUTER_MODEL_HAIKU  ?? process.env.LXG2IT_MODEL_HAIKU  ?? MODELROUTER_DEFAULT_HAIKU,
      },
      plus: {
        opus:   process.env.MODELROUTER_MODEL_OPUS   ?? process.env.LXG2IT_MODEL_OPUS   ?? MODELROUTER_DEFAULT_OPUS,
        sonnet: process.env.MODELROUTER_MODEL_SONNET ?? process.env.LXG2IT_MODEL_SONNET ?? MODELROUTER_DEFAULT_SONNET,
        haiku:  process.env.MODELROUTER_MODEL_HAIKU  ?? process.env.LXG2IT_MODEL_HAIKU  ?? MODELROUTER_DEFAULT_HAIKU,
      },
    },
  },

  vercel: {
    displayName: 'Vercel AI Gateway',
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    authType: 'bearer',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   process.env.VERCEL_MODEL_OPUS_FREE   ?? process.env.AI_GATEWAY_MODEL_OPUS_FREE   ?? 'anthropic/claude-sonnet-4-6',
        sonnet: process.env.VERCEL_MODEL_SONNET_FREE ?? process.env.AI_GATEWAY_MODEL_SONNET_FREE ?? 'anthropic/claude-sonnet-4-6',
        haiku:  process.env.VERCEL_MODEL_HAIKU_FREE  ?? process.env.AI_GATEWAY_MODEL_HAIKU_FREE  ?? 'anthropic/claude-haiku-4-5',
      },
      pro: {
        opus:   process.env.VERCEL_MODEL_OPUS   ?? process.env.AI_GATEWAY_MODEL_OPUS   ?? 'anthropic/claude-opus-4-7',
        sonnet: process.env.VERCEL_MODEL_SONNET ?? process.env.AI_GATEWAY_MODEL_SONNET ?? 'anthropic/claude-sonnet-4-6',
        haiku:  process.env.VERCEL_MODEL_HAIKU  ?? process.env.AI_GATEWAY_MODEL_HAIKU  ?? 'anthropic/claude-haiku-4-5',
      },
      plus: {
        opus:   process.env.VERCEL_MODEL_OPUS   ?? process.env.AI_GATEWAY_MODEL_OPUS   ?? 'anthropic/claude-opus-4-7',
        sonnet: process.env.VERCEL_MODEL_SONNET ?? process.env.AI_GATEWAY_MODEL_SONNET ?? 'anthropic/claude-sonnet-4-6',
        haiku:  process.env.VERCEL_MODEL_HAIKU  ?? process.env.AI_GATEWAY_MODEL_HAIKU  ?? 'anthropic/claude-haiku-4-5',
      },
    },
  },

  opencode: {
    displayName: 'OpenCode Zen',
    baseUrl: OPENCODE_BASE_URL,
    authType: 'bearer',
    apiKeyEnv: 'OPENCODE_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   process.env.OPENCODE_MODEL_OPUS_FREE   ?? 'big-pickle',
        sonnet: process.env.OPENCODE_MODEL_SONNET_FREE ?? 'deepseek-v4-flash-free',
        haiku:  process.env.OPENCODE_MODEL_HAIKU_FREE  ?? 'nemotron-3-super-free',
      },
      pro: {
        opus:   process.env.OPENCODE_MODEL_OPUS   ?? 'claude-opus-4-7',
        sonnet: process.env.OPENCODE_MODEL_SONNET ?? 'claude-sonnet-4-6',
        haiku:  process.env.OPENCODE_MODEL_HAIKU  ?? 'claude-haiku-4-5',
      },
      plus: {
        opus:   process.env.OPENCODE_MODEL_OPUS   ?? 'claude-opus-4-7',
        sonnet: process.env.OPENCODE_MODEL_SONNET ?? 'claude-sonnet-4-6',
        haiku:  process.env.OPENCODE_MODEL_HAIKU  ?? 'claude-haiku-4-5',
      },
    },
  },

  requesty: {
    displayName: 'Requesty',
    baseUrl: REQUESTY_BASE_URL,
    authType: 'bearer',
    apiKeyEnv: 'REQUESTY_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   process.env.REQUESTY_MODEL_OPUS_FREE   ?? 'anthropic/claude-sonnet-4-6',
        sonnet: process.env.REQUESTY_MODEL_SONNET_FREE ?? 'anthropic/claude-sonnet-4-6',
        haiku:  process.env.REQUESTY_MODEL_HAIKU_FREE  ?? 'anthropic/claude-haiku-4-5',
      },
      pro: {
        opus:   process.env.REQUESTY_MODEL_OPUS   ?? 'anthropic/claude-opus-4-7',
        sonnet: process.env.REQUESTY_MODEL_SONNET ?? 'anthropic/claude-sonnet-4-6',
        haiku:  process.env.REQUESTY_MODEL_HAIKU  ?? 'anthropic/claude-haiku-4-5',
      },
      plus: {
        opus:   process.env.REQUESTY_MODEL_OPUS   ?? 'anthropic/claude-opus-4-7',
        sonnet: process.env.REQUESTY_MODEL_SONNET ?? 'anthropic/claude-sonnet-4-6',
        haiku:  process.env.REQUESTY_MODEL_HAIKU  ?? 'anthropic/claude-haiku-4-5',
      },
    },
  },

  groq: {
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authType: 'bearer',
    apiKeyEnv: 'GROQ_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'free',  // Groq is free-tier by nature
    tiers: {
      free: {
        opus:   process.env.GROQ_MODEL_OPUS   ?? 'deepseek-r1-distill-llama-70b',
        sonnet: process.env.GROQ_MODEL_SONNET ?? 'llama-3.3-70b-versatile',
        haiku:  process.env.GROQ_MODEL_HAIKU  ?? 'llama-3.3-70b-versatile',
      },
      pro: {
        opus:   process.env.GROQ_MODEL_OPUS   ?? 'qwen/qwen3-32b',
        sonnet: process.env.GROQ_MODEL_SONNET ?? 'deepseek-r1-distill-llama-70b',
        haiku:  process.env.GROQ_MODEL_HAIKU  ?? 'llama-3.3-70b-versatile',
      },
      plus: {
        opus:   process.env.GROQ_MODEL_OPUS   ?? 'openai/gpt-oss-120b',
        sonnet: process.env.GROQ_MODEL_SONNET ?? 'qwen/qwen3-32b',
        haiku:  process.env.GROQ_MODEL_HAIKU  ?? 'deepseek-r1-distill-llama-70b',
      },
    },
  },

  mistral: {
    displayName: 'Mistral',
    baseUrl: MISTRAL_BASE_URL,
    authType: 'bearer',
    apiKeyEnv: 'MISTRAL_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   process.env.MISTRAL_MODEL_OPUS_FREE   ?? 'mistral-small-latest',
        sonnet: process.env.MISTRAL_MODEL_SONNET_FREE ?? 'mistral-small-latest',
        haiku:  process.env.MISTRAL_MODEL_HAIKU_FREE  ?? 'mistral-small-latest',
      },
      pro: {
        opus:   process.env.MISTRAL_MODEL_OPUS   ?? 'mistral-medium-3-5',
        sonnet: process.env.MISTRAL_MODEL_SONNET ?? 'devstral-latest',
        haiku:  process.env.MISTRAL_MODEL_HAIKU  ?? 'mistral-small-latest',
      },
      plus: {
        opus:   process.env.MISTRAL_MODEL_OPUS   ?? 'mistral-medium-3-5',
        sonnet: process.env.MISTRAL_MODEL_SONNET ?? 'devstral-latest',
        haiku:  process.env.MISTRAL_MODEL_HAIKU  ?? 'mistral-small-latest',
      },
    },
  },

  deepseek: {
    displayName: 'DeepSeek',
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    authType: 'bearer',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'deepseek-chat',
        sonnet: 'deepseek-chat',
        haiku:  'deepseek-chat',
      },
      pro: {
        opus:   process.env.DEEPSEEK_MODEL_OPUS   ?? 'deepseek-reasoner',
        sonnet: process.env.DEEPSEEK_MODEL_SONNET ?? 'deepseek-chat',
        haiku:  process.env.DEEPSEEK_MODEL_HAIKU  ?? 'deepseek-chat',
      },
      plus: {
        opus:   process.env.DEEPSEEK_MODEL_OPUS   ?? 'deepseek-reasoner',
        sonnet: process.env.DEEPSEEK_MODEL_SONNET ?? 'deepseek-reasoner',
        haiku:  process.env.DEEPSEEK_MODEL_HAIKU  ?? 'deepseek-chat',
      },
    },
  },

  glm: {
    displayName: 'GLM',
    baseUrl: GLM_BASE_URL,
    authType: 'bearer',
    apiKeyEnv: 'GLM_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   process.env.GLM_MODEL_OPUS_FREE   ?? 'glm-4.7',
        sonnet: process.env.GLM_MODEL_SONNET_FREE ?? 'glm-4.7',
        haiku:  process.env.GLM_MODEL_HAIKU_FREE  ?? 'glm-4.7',
      },
      pro: {
        opus:   process.env.GLM_MODEL_OPUS   ?? 'glm-5.1',
        sonnet: process.env.GLM_MODEL_SONNET ?? 'glm-5-turbo',
        haiku:  process.env.GLM_MODEL_HAIKU  ?? 'glm-4.7',
      },
      plus: {
        opus:   process.env.GLM_MODEL_OPUS   ?? 'glm-5.1',
        sonnet: process.env.GLM_MODEL_SONNET ?? 'glm-5',
        haiku:  process.env.GLM_MODEL_HAIKU  ?? 'glm-4.7',
      },
    },
  },

  moonshot: {
    displayName: 'Moonshot AI',
    baseUrl: MOONSHOT_BASE_URL,
    authType: 'bearer',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'kimi-k2.6',
        sonnet: 'kimi-k2.6',
        haiku:  'kimi-k2-turbo-preview',
      },
      pro: {
        opus:   process.env.MOONSHOT_MODEL_OPUS   ?? 'kimi-k2.6',
        sonnet: process.env.MOONSHOT_MODEL_SONNET ?? 'kimi-k2.6',
        haiku:  process.env.MOONSHOT_MODEL_HAIKU  ?? 'kimi-k2-turbo-preview',
      },
      plus: {
        opus:   process.env.MOONSHOT_MODEL_OPUS   ?? 'kimi-k2.6',
        sonnet: process.env.MOONSHOT_MODEL_SONNET ?? 'kimi-k2.6',
        haiku:  process.env.MOONSHOT_MODEL_HAIKU  ?? 'kimi-k2-turbo-preview',
      },
    },
  },

  minimax: {
    displayName: 'MiniMax AI',
    baseUrl: MINIMAX_BASE_URL,
    authType: 'bearer',
    apiKeyEnv: 'MINIMAX_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'MiniMax-M2.7',
        sonnet: 'MiniMax-M2.7',
        haiku:  'MiniMax-M2.7-highspeed',
      },
      pro: {
        opus:   process.env.MINIMAX_MODEL_OPUS   ?? 'MiniMax-M2.7',
        sonnet: process.env.MINIMAX_MODEL_SONNET ?? 'MiniMax-M2.7',
        haiku:  process.env.MINIMAX_MODEL_HAIKU  ?? 'MiniMax-M2.7-highspeed',
      },
      plus: {
        opus:   process.env.MINIMAX_MODEL_OPUS   ?? 'MiniMax-M2.7',
        sonnet: process.env.MINIMAX_MODEL_SONNET ?? 'MiniMax-M2.7',
        haiku:  process.env.MINIMAX_MODEL_HAIKU  ?? 'MiniMax-M2.7-highspeed',
      },
    },
  },

  lmstudio: {
    displayName: 'LM Studio',
    baseUrl: LMSTUDIO_BASE_URL,
    authType: 'bearer',
    apiKeyEnv: 'LMSTUDIO_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   process.env.LMSTUDIO_MODEL_OPUS   ?? process.env.LMSTUDIO_MODEL ?? 'local-model',
        sonnet: process.env.LMSTUDIO_MODEL_SONNET ?? process.env.LMSTUDIO_MODEL ?? 'local-model',
        haiku:  process.env.LMSTUDIO_MODEL_HAIKU  ?? process.env.LMSTUDIO_MODEL ?? 'local-model',
      },
      pro: {
        opus:   process.env.LMSTUDIO_MODEL_OPUS   ?? process.env.LMSTUDIO_MODEL ?? 'local-model',
        sonnet: process.env.LMSTUDIO_MODEL_SONNET ?? process.env.LMSTUDIO_MODEL ?? 'local-model',
        haiku:  process.env.LMSTUDIO_MODEL_HAIKU  ?? process.env.LMSTUDIO_MODEL ?? 'local-model',
      },
      plus: {
        opus:   process.env.LMSTUDIO_MODEL_OPUS   ?? process.env.LMSTUDIO_MODEL ?? 'local-model',
        sonnet: process.env.LMSTUDIO_MODEL_SONNET ?? process.env.LMSTUDIO_MODEL ?? 'local-model',
        haiku:  process.env.LMSTUDIO_MODEL_HAIKU  ?? process.env.LMSTUDIO_MODEL ?? 'local-model',
      },
    },
  },

  nim: {
    displayName: 'NVIDIA NIM',
    baseUrl: process.env.NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    authType: 'bearer',
    apiKeyEnv: 'NIM_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'nvidia/nemotron-3-super-120b-a12b',
        sonnet: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
        haiku:  'nvidia/nemotron-3-nano-30b-a3b',
      },
      pro: {
        opus:   process.env.NIM_MODEL_OPUS   ?? 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
        sonnet: process.env.NIM_MODEL_SONNET ?? 'nvidia/nemotron-3-super-120b-a12b',
        haiku:  process.env.NIM_MODEL_HAIKU  ?? 'nvidia/nemotron-3-nano-30b-a3b',
      },
      plus: {
        opus:   process.env.NIM_MODEL_OPUS   ?? 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
        sonnet: process.env.NIM_MODEL_SONNET ?? 'nvidia/nemotron-3-super-120b-a12b',
        haiku:  process.env.NIM_MODEL_HAIKU  ?? 'nvidia/nemotron-3-nano-30b-a3b',
      },
    },
  },
}

/**
 * Resolves the effective model set for a third-party provider based on
 * the detected or configured tier.
 */
export function getProviderModelSet(provider: string): TierModelSet {
  const config = PROVIDER_CONFIGS[provider]
  if (!config) {
    // Fallback for unknown providers — use a generic OpenAI-compatible default
    return { opus: 'gpt-5.4', sonnet: 'gpt-5.4', haiku: 'gpt-5.4-mini' }
  }
  const tier = getProviderTier(provider)
  const modelSet = config.tiers[tier]
  const currentOpenAIModel = getCurrentOpenAIModelSelection(provider)
  if (!currentOpenAIModel) return modelSet

  return {
    ...modelSet,
    opus: process.env.OPENAI_MODEL_OPUS ?? currentOpenAIModel,
    sonnet: process.env.OPENAI_MODEL_SONNET ?? currentOpenAIModel,
  }
}

function getCurrentOpenAIModelSelection(provider: string): string | null {
  if (provider !== 'openai') return null

  const selected = getMainLoopModelOverride()
  if (selected !== undefined) {
    return looksLikeConcreteOpenAIModelId(selected) ? selected : null
  }

  if (looksLikeConcreteOpenAIModelId(process.env.ANTHROPIC_MODEL)) {
    return process.env.ANTHROPIC_MODEL
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const settingsMod = require('../settings/settings.js') as {
      getSettings_DEPRECATED?: () => { model?: unknown } | undefined
    }
    const settings = settingsMod.getSettings_DEPRECATED?.()
    return looksLikeConcreteOpenAIModelId(settings?.model) ? settings.model : null
  } catch {
    return null
  }
}

function looksLikeConcreteOpenAIModelId(value: unknown): value is string {
  return typeof value === 'string' && value.toLowerCase().startsWith('gpt-')
}

/**
 * Legacy flat map for backward compat — resolves to current tier's models.
 * Use getProviderModelSet() directly for tier-aware access.
 */
export const PROVIDER_MODEL_MAP: Record<string, TierModelSet> = new Proxy(
  {} as Record<string, TierModelSet>,
  {
    get(_target, prop: string) {
      return getProviderModelSet(prop)
    },
  },
)

// @[MODEL LAUNCH]: Add a new CLAUDE_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

export const CLAUDE_3_7_SONNET_CONFIG = {
  firstParty: 'claude-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  vertex: 'claude-3-7-sonnet@20250219',
  foundry: 'claude-3-7-sonnet',
} as const satisfies ModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  firstParty: 'claude-3-5-sonnet-20241022',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  vertex: 'claude-3-5-sonnet-v2@20241022',
  foundry: 'claude-3-5-sonnet',
} as const satisfies ModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG = {
  firstParty: 'claude-3-5-haiku-20241022',
  bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  vertex: 'claude-3-5-haiku@20241022',
  foundry: 'claude-3-5-haiku',
} as const satisfies ModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG = {
  firstParty: 'claude-haiku-4-5-20251001',
  bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: 'claude-haiku-4-5@20251001',
  foundry: 'claude-haiku-4-5',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_CONFIG = {
  firstParty: 'claude-sonnet-4-20250514',
  bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  vertex: 'claude-sonnet-4@20250514',
  foundry: 'claude-sonnet-4',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_5_CONFIG = {
  firstParty: 'claude-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  vertex: 'claude-sonnet-4-5@20250929',
  foundry: 'claude-sonnet-4-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_CONFIG = {
  firstParty: 'claude-opus-4-20250514',
  bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
  vertex: 'claude-opus-4@20250514',
  foundry: 'claude-opus-4',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_1_CONFIG = {
  firstParty: 'claude-opus-4-1-20250805',
  bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  vertex: 'claude-opus-4-1@20250805',
  foundry: 'claude-opus-4-1',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_5_CONFIG = {
  firstParty: 'claude-opus-4-5-20251101',
  bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  vertex: 'claude-opus-4-5@20251101',
  foundry: 'claude-opus-4-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-6',
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_7_CONFIG = {
  firstParty: 'claude-opus-4-7',
  bedrock: 'us.anthropic.claude-opus-4-7-v1',
  vertex: 'claude-opus-4-7',
  foundry: 'claude-opus-4-7',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_8_CONFIG = {
  firstParty: 'claude-opus-4-8',
  bedrock: 'us.anthropic.claude-opus-4-8-v1',
  vertex: 'claude-opus-4-8',
  foundry: 'claude-opus-4-8',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: 'claude-sonnet-4-6',
  bedrock: 'us.anthropic.claude-sonnet-4-6',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
} as const satisfies ModelConfig

// @[MODEL LAUNCH]: Register the new config here.
export const ALL_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
  opus47: CLAUDE_OPUS_4_7_CONFIG,
  opus48: CLAUDE_OPUS_4_8_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical first-party model IDs, e.g. 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | … */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>
