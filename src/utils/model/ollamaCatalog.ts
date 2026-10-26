/**
 * Ollama model catalog — cloud + local detection, capability probing,
 * and first-launch auto-pull.
 *
 * Background:
 * - Ollama hosts "cloud models" identified by a :cloud suffix. They run on
 *   ollama.com infrastructure but are invoked through the same localhost
 *   Ollama runtime, so the CLI workflow is identical once the reference has
 *   been pulled once (the pull just registers the cloud-side alias).
 * - Local models have heterogeneous capabilities. Some support tool-calling,
 *   some do not. Tau issues tool-use requests that break on models
 *   without tool support, so we hide those from the picker.
 * - Some cloud models support `enable_thinking` — a per-request parameter
 *   that toggles reasoning output. The UI exposes this as a toggle, but it
 *   must only be sent to models that understand it (or providers 400).
 *
 * This module owns:
 *   1. CLOUD_MODELS_LIST — curated approved list
 *   2. THINKING_CLOUD_MODELS — subset that supports enable_thinking
 *   3. getOllamaCatalog() — fetches local models, splits into {cloud, local,
 *      toolless}, augments with capability info via /api/show
 *   4. ensureCloudModelsPulled() — idempotent pre-pull used on first launch
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import { recordModelVision } from '../../lanes/shared/vision_capability.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'

const exec = promisify(execFile)

/**
 * Non-fatal debug logger. Cloud-model prime failures and Ollama daemon
 * absence should never surface as errors to the user — but we do want the
 * trail when debugging, so route to logError only when it's a real Error
 * (avoids spamming the error log with "daemon not running" strings).
 */
function debugLog(message: string): void {
  if (process.env.DEBUG || process.env.OLLAMA_DEBUG) {
    // eslint-disable-next-line no-console
    console.error(`[ollamaCatalog] ${message}`)
  }
}

// ─── Approved cloud model list ─────────────────────────────────────
//
// These are the cloud aliases we pre-pull on install / first launch and
// always show in the /models picker under "Cloud". Only `:cloud` aliases
// that actually resolve against the Ollama registry are listed — each
// entry must return success for `ollama pull <id>`.
//
// KEEP IN SYNC with scripts/postinstall.mjs (OLLAMA_CLOUD_MODELS).
export const CLOUD_MODELS_LIST: readonly string[] = [
  'glm-5.1:cloud',
  'glm-5:cloud',
  'glm-4.7:cloud',
  'glm-4.6:cloud',
  'kimi-k2.5:cloud',
  'kimi-k2-thinking:cloud',
  'qwen3.5:cloud',
  'qwen3-coder-next:cloud',
  'minimax-m2.7:cloud',
  'minimax-m2.5:cloud',
  'minimax-m2.1:cloud',
  'minimax-m2:cloud',
  'nemotron-3-super:cloud',
  'deepseek-v3.2:cloud',
  'gemini-3-flash-preview:cloud',
]

// ─── Thinking-mode cloud models ────────────────────────────────────
//
// Models that respect `enable_thinking: true|false` as a request parameter.
// For other models we omit the parameter entirely (sending it anyway trips a
// 400 on some providers).
export const THINKING_CLOUD_MODELS: ReadonlySet<string> = new Set([
  'glm-5.1:cloud',
  'glm-5:cloud',
  'glm-4.7:cloud',
  'glm-4.6:cloud',
  'kimi-k2-thinking:cloud',
  'qwen3.5:cloud',
  'minimax-m2.7:cloud',
  'minimax-m2.5:cloud',
  'deepseek-v3.2:cloud',
])

/** True if the given model accepts the `enable_thinking` parameter. */
export function modelSupportsThinkingToggle(modelId: string): boolean {
  return THINKING_CLOUD_MODELS.has(modelId)
}

// ─── Thinking toggle bridge ────────────────────────────────────────
//
// React owns the "thinking on/off" app state but the provider layer is
// deliberately framework-free. This tiny bridge lets REPL mirror the
// current toggle value here on every change, and lets the provider read
// it at request time without importing any React plumbing.
//
// Default is ON — matches shouldEnableThinkingByDefault() so a user who
// never toggles gets sensible behavior out of the box.

let _thinkingToggleState = true

/** Called from React (REPL) whenever `thinkingEnabled` AppState changes. */
export function setOllamaThinkingEnabled(enabled: boolean): void {
  _thinkingToggleState = enabled
}

/** Read by providers when building a request body. */
export function getOllamaThinkingEnabled(): boolean {
  return _thinkingToggleState
}

// ─── Capability-aware ModelInfo ────────────────────────────────────

export type OllamaModelCategory = 'cloud' | 'local'

export interface OllamaModelInfo extends ModelInfo {
  category: OllamaModelCategory
  /** True when the model is already pulled in the local Ollama install. */
  pulled: boolean
  /** True when the model can accept Tau tool definitions. */
  supportsTools: boolean
  /** True when the model supports the thinking/reasoning toggle. */
  supportsThinking: boolean
}

export interface OllamaCatalog {
  cloud: OllamaModelInfo[]
  local: OllamaModelInfo[]
  toolless: OllamaModelInfo[]
}

// Known base families that we trust to support tool-calling properly.
// Tested against the models listed in amelioration.txt and the Ollama
// registry as of early 2026. If a model's name contains any of these
// substrings we consider it tool-capable.
const TOOLS_CAPABLE_NAMES: readonly string[] = [
  'llama3.1',
  'llama3.2',
  'llama3.3',
  'llama4',
  'qwen3',
  'qwen2.5',
  'mistral-large',
  'mistral-small',
  'devstral',
  'command-r',
  'hermes',
  'gpt-oss',
  'granite3',
  'nemotron',
  'glm-4',
  'glm-5',
  'kimi-k2',
  'deepseek-v3',
  'minimax-m2',
  'gemini-3',
  'rnj-1',
  'gemma4',
  'ministral',
]

function inferToolsSupport(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return TOOLS_CAPABLE_NAMES.some(n => lower.includes(n))
}

// ─── Talking to Ollama ─────────────────────────────────────────────

/** Resolve the Ollama base URL from env or config, defaulting to localhost. */
function ollamaBase(): string {
  const env =
    process.env.OLLAMA_HOST ??
    process.env.OLLAMA_BASE_URL ??
    ''
  if (env) {
    // OLLAMA_HOST may be "127.0.0.1:11434" without a scheme
    return /^https?:/i.test(env) ? env.replace(/\/$/, '') : `http://${env}`
  }
  return 'http://localhost:11434'
}

interface ApiTagsResponse {
  models?: Array<{
    name: string
    model?: string
    details?: { family?: string; parameter_size?: string }
  }>
}

/**
 * List models currently pulled in the local Ollama install. Returns an
 * empty array if Ollama isn't running. Never throws — the picker should
 * degrade gracefully when the daemon is offline.
 */
export async function listLocalOllamaModels(): Promise<string[]> {
  try {
    const response = await fetch(`${ollamaBase()}/api/tags`)
    if (!response.ok) return []
    const data = (await response.json()) as ApiTagsResponse
    return (data.models ?? []).map(m => m.name).filter(Boolean)
  } catch (error) {
    debugLog(
      `[OllamaCatalog] listLocalOllamaModels failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return []
  }
}

/**
 * Ask the daemon what each pulled model takes. `/api/show` lists `vision`
 * among a model's capabilities, and remembering it is what lets a request
 * send real pixels. An older daemon omits `capabilities`, which records
 * nothing and leaves the current answer in place.
 */
async function recordOllamaVision(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map(async id => {
    try {
      const response = await fetch(`${ollamaBase()}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: id }),
        signal: AbortSignal.timeout(3_000),
      })
      if (!response.ok) return
      const { capabilities } = (await response.json()) as { capabilities?: unknown }
      if (Array.isArray(capabilities)) {
        recordModelVision('ollama', id, capabilities.includes('vision'))
      }
    } catch {
      // A model the daemon will not describe keeps its current answer.
    }
  }))
}

/**
 * Fetch an Ollama catalog split into cloud / local / toolless sections.
 *
 * Cloud models come from the fixed approved list. A cloud model is
 * considered "pulled" when its exact name also appears in /api/tags (Ollama
 * registers a local alias once the user has run `ollama pull <name>`).
 *
 * Local models come from /api/tags minus anything that matches a cloud
 * entry. We then split them by tools support — tool-less models surface as
 * the toolless section (hidden by default but accessible via a warning UI).
 */
export async function getOllamaCatalog(): Promise<OllamaCatalog> {
  const pulled = new Set(await listLocalOllamaModels())
  void recordOllamaVision([...pulled])
  const cloudSet = new Set(CLOUD_MODELS_LIST)

  const cloud: OllamaModelInfo[] = CLOUD_MODELS_LIST.map(id => ({
    id,
    name: id,
    category: 'cloud' as const,
    pulled: pulled.has(id),
    supportsTools: true,
    supportsThinking: THINKING_CLOUD_MODELS.has(id),
  }))

  const local: OllamaModelInfo[] = []
  const toolless: OllamaModelInfo[] = []

  for (const id of pulled) {
    if (cloudSet.has(id)) continue // already in the cloud section
    const supportsTools = inferToolsSupport(id)
    const entry: OllamaModelInfo = {
      id,
      name: id,
      category: 'local',
      pulled: true,
      supportsTools,
      supportsThinking: false,
    }
    if (supportsTools) {
      local.push(entry)
    } else {
      toolless.push(entry)
    }
  }

  // Stable, case-insensitive ordering per section.
  const byName = (a: OllamaModelInfo, b: OllamaModelInfo) =>
    a.id.toLowerCase().localeCompare(b.id.toLowerCase())
  local.sort(byName)
  toolless.sort(byName)

  return { cloud, local, toolless }
}

// ─── First-launch auto-pull ────────────────────────────────────────

/** Config flag that records whether we've already run the auto-pull pass. */
const FIRST_PULL_FLAG = 'ollamaCloudModelsPrimedAt' as const

/**
 * On first launch, pull each model in CLOUD_MODELS_LIST that isn't already
 * present in the local Ollama install. Safe to call on every launch — we
 * record completion in GlobalConfig and short-circuit afterwards.
 *
 * Implementation uses the native `ollama` CLI rather than the HTTP API
 * because `/api/pull` streams progress events that we'd have to consume
 * manually, while `ollama pull` handles progress reporting and exits cleanly
 * when done.
 *
 * All failures are swallowed — a user without Ollama installed should not
 * see an error at startup, and a transient network failure should just
 * retry on the next launch.
 */
export async function ensureCloudModelsPrimed(): Promise<void> {
  const config = getGlobalConfig() as Record<string, unknown>
  if (config[FIRST_PULL_FLAG]) {
    return
  }

  // Check if ollama is even installed before trying anything.
  try {
    await exec('ollama', ['--version'], { timeout: 5000 })
  } catch {
    debugLog(
      '[OllamaCatalog] skipping cloud-model prime — ollama CLI not found',
    )
    return
  }

  const pulled = new Set(await listLocalOllamaModels())
  const missing = CLOUD_MODELS_LIST.filter(id => !pulled.has(id))

  if (missing.length === 0) {
    saveGlobalConfig(current => ({
      ...current,
      [FIRST_PULL_FLAG]: Date.now(),
    }))
    return
  }

  debugLog(
    `[OllamaCatalog] first-launch pulling ${missing.length} cloud models`,
  )

  // Pull sequentially so we don't hammer the registry and so a single
  // failing model doesn't block the rest.
  for (const id of missing) {
    try {
      await exec('ollama', ['pull', id], { timeout: 5 * 60 * 1000 })
      debugLog(`[OllamaCatalog] pulled ${id}`)
    } catch (error) {
      debugLog(
        `[OllamaCatalog] pull failed for ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      // Keep going — partial success is still useful.
    }
  }

  saveGlobalConfig(current => ({
    ...current,
    [FIRST_PULL_FLAG]: Date.now(),
  }))
}
